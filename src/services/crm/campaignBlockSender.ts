/**
 * Gửi một khối nội dung chiến dịch (chữ + ảnh) tới một người nhận, theo tuỳ chọn ảnh của chiến
 * dịch (thứ tự chữ / ảnh, gộp ảnh + chữ thành 1 tin) — xem shared/campaignSendPlan.
 * Mặc định (chữ trước, không gộp) giữ nguyên cách gửi cũ:
 *   Zalo: tin chữ (markup + @all) → 500 ms → một lần gửi tất cả ảnh;
 *   Telegram: tin chữ → từng ảnh một.
 */
import * as fs from 'fs';
import * as path from 'path';
import imageSize from 'image-size';
import Logger from '../../utils/Logger';
import { parseMarkup } from './message-markup';
import * as TelegramUser from '../telegram/TelegramUserListener';
import * as TelegramBot from '../telegram/TelegramBotChannelService';
import {
  COMBINE_FALLBACK_LABEL,
  planBlockSend,
  type CampaignSendOptions,
} from '../../shared/campaignSendPlan';

export interface CampaignContentBlock {
  text: string;
  images: string[];
  tagAll?: boolean;
  tagAllText?: string;
}

export interface CampaignSendTarget {
  /** 'zalo' | 'telegram_user' | 'telegram_bot' */
  channel: string;
  accountId: string;
  threadId: string;
  /** Zalo thread type: 0 = user, 1 = group. */
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

/** Zalo attachments read from disk (same shape the queue always sent). */
function readZaloAttachments(images: string[]): any[] {
  return images.map(filePath => {
    try {
      const buffer = fs.readFileSync(filePath);
      const baseName = path.basename(filePath);
      const ext = path.extname(baseName) || '.jpg';
      const safeFilename = (path.extname(baseName) ? baseName : `${baseName}${ext}`) as `${string}.${string}`;
      let width = 0;
      let height = 0;
      try { const dim = imageSize(buffer); width = dim.width ?? 0; height = dim.height ?? 0; } catch { /* metadata optional */ }
      return { data: buffer, filename: safeFilename, metadata: { totalSize: buffer.length, width, height } };
    } catch (readErr: any) {
      Logger.error(`[CRMQueue] Image read failed: ${filePath} → ${readErr.message}`);
      throw new Error(`Không đọc được ảnh: ${filePath} - ${readErr.message}`);
    }
  });
}

/** Zalo text payload: "@all " prefix + mention in groups when the block asks for it. */
function zaloTextContent(block: CampaignContentBlock, cleanText: string, styles: any[], threadType: number): any {
  const content: any = { msg: cleanText };
  let finalStyles = styles;
  // Tag-all chỉ có nghĩa trong nhóm (threadType 1); user thường (0) bỏ qua.
  if (threadType === 1 && block.tagAll) {
    const label = '@' + ((block.tagAllText || 'all').trim() || 'all');
    const prefix = label + ' ';
    content.msg = prefix + cleanText;
    // uid "-1" = mention toàn nhóm; len phải bao đúng đoạn label (đã trừ dấu cách)
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
  const plan = planBlockSend({ text: cleanText, images, channel, options: target.options });
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
        responses.push(ensureTelegram(resp, 'Telegram không gửi được tin nhắn'));
      } else if (step.kind === 'images') {
        for (const filePath of step.images) {
          const resp = isUser
            ? await TelegramUser.sendFile(accountId, threadId, filePath, undefined, 'image')
            : await TelegramBot.sendPhoto(accountId, threadId, filePath);
          responses.push(ensureTelegram(resp, 'Telegram không gửi được ảnh'));
        }
      } else {
        // Ảnh + chữ = 1 tin: chú thích của ảnh (nhiều ảnh → album, chú thích ở ảnh đầu).
        const resp = isUser
          ? await TelegramUser.sendAlbum(accountId, threadId, step.images, cleanText)
          : await TelegramBot.sendPhotoAlbum(accountId, threadId, step.images, cleanText);
        responses.push(ensureTelegram(resp, 'Telegram không gửi được ảnh kèm chữ'));
      }
    }
    return responses;
  }

  const api = target.zaloApi;
  if (!api) throw new Error('Zalo chưa kết nối');
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    if (step.kind === 'images' || index > 0) await sleep(ZALO_STEP_GAP_MS);
    if (step.kind === 'text') {
      responses.push(await api.sendMessage(zaloTextContent(block, cleanText, styles, threadType), threadId, threadType));
    } else if (step.kind === 'images') {
      responses.push(await api.sendMessage({ msg: '', attachments: readZaloAttachments(step.images) }, threadId, threadType));
    } else {
      // Ảnh + chữ = 1 tin: chữ thành mô tả của ảnh. Zalo không áp định dạng (đậm, màu…) cho mô tả,
      // nên chỉ gửi chữ sạch; @all vẫn hoạt động (mention trên ảnh đơn trong nhóm).
      const caption = zaloTextContent(block, cleanText, [], threadType);
      responses.push(await api.sendMessage({ ...caption, attachments: readZaloAttachments(step.images) }, threadId, threadType));
    }
  }
  return responses;
}
