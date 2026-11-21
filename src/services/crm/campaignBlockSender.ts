/**
 * Sends one block of campaign content (text + images + videos + files) to one recipient, following the campaign's
 * image option (order of text / images, merge images + text into 1 message): see shared/crm/campaignSendPlan.
 * Default (text first, no merge) keeps the old send method:
 *   Zalo: text message (markup + @all) → 500 ms → one send of all images → videos → files;
 *   Telegram: text message → each image one by one → videos → files.
 */
import * as fs from 'fs';
import * as path from 'path';
import imageSize from 'image-size';
import Logger from '../../utils/Logger';
import { parseMarkup } from './message-markup';
import * as TelegramUser from '../telegram/TelegramUserListener';
import * as TelegramBot from '../telegram/bot/TelegramBotChannelService';
import FacebookSendService from '../facebook/send/FacebookSendService';
import {
  COMBINE_FALLBACK_LABEL,
  planBlockSend,
  type CampaignSendOptions,
} from '../../shared/crm/campaignSendPlan';
import { tr } from '../../shared/i18n';

export interface CampaignContentBlock {
  text: string;
  images: string[];
  /** Videos sent after the text/images part (one message per file). */
  videos?: string[];
  /** Documents / arbitrary files sent after the videos (one message per file). */
  files?: string[];
  tagAll?: boolean;
  tagAllText?: string;
}

export interface CampaignSendTarget {
  /** 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot' */
  channel: string;
  accountId: string;
  threadId: string;
  /** Thread type: 0 = user, 1 = group (Zalo and Facebook). */
  threadType: number;
  /** zca-js API of the Zalo connection (Zalo only). */
  zaloApi?: any;
  options: CampaignSendOptions;
}

/** Pause between two sends of the same block on Zalo (as before: text → 500 ms → images). */
const ZALO_STEP_GAP_MS = 500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type TelegramResult = { success: boolean; error?: string };

function ensureTelegram<T extends TelegramResult>(result: T, fallbackError: string): T {
  if (!result?.success) throw new Error(result?.error || fallbackError);
  return result;
}

/**
 * Send one Facebook attachment through the same route the chat screen uses (FacebookSendService):
 * 1:1 → E2EE bridge, group → upload + REST. `typeChat` comes from the campaign contact row, never from the
 * numeric id shape (Facebook users and groups are both all digits).
 */
async function sendFacebookAttachment(
  accountId: string,
  threadId: string,
  typeChat: 'user' | null,
  filePath: string,
  kind: 'image' | 'video' | 'file',
  body: string,
): Promise<any> {
  const result = await FacebookSendService.sendAttachment({
    accountId,
    threadId,
    filePath,
    body: body || undefined,
    typeChat,
    fileType: kind,
  });
  if (!result?.success) {
    const fallback = kind === 'image' ? tr('Facebook không gửi được ảnh')
      : kind === 'video' ? tr('Facebook không gửi được video')
      : tr('Facebook không gửi được tệp');
    throw new Error(result?.error || fallback);
  }
  return result;
}

/**
 * Zalo attachments read from disk (same shape the queue always sent).
 * `kind` only changes the optional metadata: images keep width/height, videos and files are sent with the size only
 * because Zalo's video metadata needs a real dimension probe (ffprobe) the campaign send does not run.
 */
function readZaloAttachments(paths: string[], kind: 'image' | 'video' | 'file' = 'image'): any[] {
  return paths.map(filePath => {
    try {
      const buffer = fs.readFileSync(filePath);
      const baseName = path.basename(filePath);
      const ext = path.extname(baseName) || (kind === 'video' ? '.mp4' : '.bin');
      const safeFilename = (path.extname(baseName) ? baseName : `${baseName}${ext}`) as `${string}.${string}`;
      let width = 0;
      let height = 0;
      if (kind === 'image') {
        try { const dim = imageSize(buffer); width = dim.width ?? 0; height = dim.height ?? 0; } catch { /* metadata optional */ }
      }
      return { data: buffer, filename: safeFilename, metadata: { totalSize: buffer.length, width, height } };
    } catch (readErr: any) {
      const label = kind === 'image' ? tr('Không đọc được ảnh: {{filePath}} - {{message}}', { filePath, message: readErr.message })
        : kind === 'video' ? tr('Không đọc được video: {{filePath}} - {{message}}', { filePath, message: readErr.message })
        : tr('Không đọc được tệp: {{filePath}} - {{message}}', { filePath, message: readErr.message });
      Logger.error(`[CRMQueue] ${kind} read failed: ${filePath} → ${readErr.message}`);
      throw new Error(label);
    }
  });
}

/** Zalo text payload: "@all " prefix + mention in groups when the block asks for it. */
function zaloTextContent(block: CampaignContentBlock, cleanText: string, styles: any[], threadType: number): any {
  const content: any = { msg: cleanText };
  let finalStyles = styles;
  // Tag-all only makes sense in a group (threadType 1); a normal user (0) skips it.
  if (threadType === 1 && block.tagAll) {
    const label = '@' + ((block.tagAllText || 'all').trim() || 'all');
    const prefix = label + ' ';
    content.msg = prefix + cleanText;
    // uid "-1" = mention the whole group; len must cover exactly the label text (spaces already deducted)
    content.mentions = [{ pos: 0, uid: '-1', len: label.length }];
    finalStyles = styles.map(s => ({ ...s, start: s.start + prefix.length }));
  }
  if (finalStyles.length) content.styles = finalStyles;
  return content;
}

/** Sends one block; returns the platform responses (for the send log). Throws on failure. */
export async function sendCampaignBlock(
  block: CampaignContentBlock,
  substitutedText: string,
  target: CampaignSendTarget,
): Promise<any[]> {
  const { channel, accountId, threadId, threadType } = target;
  // CRM markup is a Zalo-only transport feature. Telegram must receive exactly what the user
  // composed (including literal square-bracket text) and never run through the Zalo parser.
  const { text: cleanText, styles } = channel === 'zalo'
    ? parseMarkup(substitutedText)
    : { text: substitutedText, styles: [] as any[] };
  const images = (block.images || []).filter(Boolean);
  const videos = (block.videos || []).filter(Boolean);
  const files = (block.files || []).filter(Boolean);
  const plan = planBlockSend({ text: cleanText, images, videos, files, channel, options: target.options });
  if (plan.fallback) {
    Logger.log(`[CRMQueue] Gộp ảnh + chữ không áp dụng (${plan.fallback}: ${COMBINE_FALLBACK_LABEL[plan.fallback]}) → ${threadId}`);
  }
  const responses: any[] = [];

  if (channel === 'telegram_user' || channel === 'telegram_bot') {
    // Telegram senders live in the main process and return a normalized result. Markup / @all
    // are Zalo-specific, so they are intentionally stripped rather than rendered.
    const isUser = channel === 'telegram_user';
    for (const step of plan.steps) {
      if (step.kind === 'text') {
        const resp = isUser
          ? await TelegramUser.sendMessage(accountId, threadId, cleanText)
          : await TelegramBot.sendMessage(accountId, threadId, cleanText);
        responses.push(ensureTelegram(resp, tr('Telegram không gửi được tin nhắn')));
      } else if (step.kind === 'images') {
        if (step.images.length > 1) {
          // ONE album instead of a message per photo (Telegram groups up to 10 media per album; the senders chunk longer lists)
          const resp = isUser
            ? await TelegramUser.sendAlbum(accountId, threadId, step.images)
            : await TelegramBot.sendPhotoAlbum(accountId, threadId, step.images);
          responses.push(ensureTelegram(resp, tr('Telegram không gửi được album ảnh')));
        } else {
          for (const filePath of step.images) {
            const resp = isUser
              ? await TelegramUser.sendFile(accountId, threadId, filePath, undefined, 'image')
              : await TelegramBot.sendPhoto(accountId, threadId, filePath);
            responses.push(ensureTelegram(resp, tr('Telegram không gửi được ảnh')));
          }
        }
      } else if (step.kind === 'videos') {
        for (const filePath of step.videos) {
          const resp = isUser
            ? await TelegramUser.sendFile(accountId, threadId, filePath, undefined, 'video')
            : await TelegramBot.sendVideo(accountId, threadId, filePath);
          responses.push(ensureTelegram(resp, tr('Telegram không gửi được video')));
        }
      } else if (step.kind === 'files') {
        for (const filePath of step.files) {
          // 'file' makes the MTProto sender force a document instead of letting Telegram guess a preview type
          const resp = isUser
            ? await TelegramUser.sendFile(accountId, threadId, filePath, undefined, 'file')
            : await TelegramBot.sendDocument(accountId, threadId, filePath);
          responses.push(ensureTelegram(resp, tr('Telegram không gửi được tệp')));
        }
      } else {
        // Image + text = 1 message: the text is the caption of the image (several images → album, caption on the first image).
        const resp = isUser
          ? await TelegramUser.sendAlbum(accountId, threadId, step.images, cleanText)
          : await TelegramBot.sendPhotoAlbum(accountId, threadId, step.images, cleanText);
        responses.push(ensureTelegram(resp, tr('Telegram không gửi được ảnh kèm chữ')));
      }
    }
    return responses;
  }

  if (channel === 'facebook') {
    // Facebook: text and each attachment are separate sends (one send carries at most one uploaded file here),
    // so "gộp ảnh + chữ" puts the text as the body of the single image. No @all, no markup: the Facebook
    // composer has neither, so the text goes as typed (the same rule as Telegram).
    const typeChat: 'user' | null = threadType === 1 ? null : 'user';
    for (const step of plan.steps) {
      if (step.kind === 'text') {
        const resp = await FacebookSendService.sendTextMessage({ accountId, threadId, body: cleanText, typeChat });
        if (!resp?.success) throw new Error(resp?.error || tr('Facebook không gửi được tin nhắn'));
        responses.push(resp);
      } else if (step.kind === 'images') {
        for (const filePath of step.images) responses.push(await sendFacebookAttachment(accountId, threadId, typeChat, filePath, 'image', ''));
      } else if (step.kind === 'videos') {
        for (const filePath of step.videos) responses.push(await sendFacebookAttachment(accountId, threadId, typeChat, filePath, 'video', ''));
      } else if (step.kind === 'files') {
        for (const filePath of step.files) responses.push(await sendFacebookAttachment(accountId, threadId, typeChat, filePath, 'file', ''));
      } else {
        // Image + text = 1 message: the text is the body of the first image; any further image goes plain.
        responses.push(await sendFacebookAttachment(accountId, threadId, typeChat, step.images[0], 'image', cleanText));
        for (const filePath of step.images.slice(1)) {
          responses.push(await sendFacebookAttachment(accountId, threadId, typeChat, filePath, 'image', ''));
        }
      }
    }
    return responses;
  }

  const api = target.zaloApi;
  if (!api) throw new Error(tr('Zalo chưa kết nối'));
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    if (step.kind === 'images' || index > 0) await sleep(ZALO_STEP_GAP_MS);
    if (step.kind === 'text') {
      responses.push(await api.sendMessage(zaloTextContent(block, cleanText, styles, threadType), threadId, threadType));
    } else if (step.kind === 'images') {
      responses.push(await api.sendMessage({ msg: '', attachments: readZaloAttachments(step.images) }, threadId, threadType));
    } else if (step.kind === 'videos') {
      // No caption: Zalo only shows a description on photos, so the video goes alone.
      responses.push(await api.sendMessage({ msg: '', attachments: readZaloAttachments(step.videos, 'video') }, threadId, threadType));
    } else if (step.kind === 'files') {
      responses.push(await api.sendMessage({ msg: '', attachments: readZaloAttachments(step.files, 'file') }, threadId, threadType));
    } else {
      // Image + text = 1 message: the text becomes the image description. Zalo does not apply formatting (bold, colour…) to descriptions,
      // so only plain text is sent; @all still works (mention on a single image in a group).
      const caption = zaloTextContent(block, cleanText, [], threadType);
      responses.push(await api.sendMessage({ ...caption, attachments: readZaloAttachments(step.images) }, threadId, threadType));
    }
  }
  return responses;
}
