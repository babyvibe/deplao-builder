/**
 * How one CRM campaign block (text + images) is sent to one recipient — shared by the queue
 * (`services/crm/campaignBlockSender`) and the campaign screens, so the preview shows exactly
 * what will be sent. Options live in the template JSON next to `mode` / `blocks`:
 * `{ mode, blocks, order?: 'text_first' | 'images_first', combine?: boolean }`.
 *
 * Defaults (`text_first`, no combine) keep the historical behaviour: text message, then images.
 */

export type CampaignSendOrder = 'text_first' | 'images_first';

export interface CampaignSendOptions {
  /** Which part goes first when text and images are sent as separate messages. */
  order: CampaignSendOrder;
  /** Send the images with the text as their caption (one message) when the channel allows it. */
  combine: boolean;
}

export const DEFAULT_CAMPAIGN_SEND_OPTIONS: CampaignSendOptions = { order: 'text_first', combine: false };

/** Telegram caption limit (Bot API + MTProto, non-premium). */
export const TELEGRAM_CAPTION_LIMIT = 1024;

/** Zalo shows a caption ("mô tả") only on a single jpg / png / webp photo. */
const ZALO_CAPTION_IMAGE = /\.(jpe?g|png|webp)$/i;

export type CampaignSendStep =
  | { kind: 'text' }
  /** Images without text: one batch on Zalo (album), one message per image on Telegram (as before). */
  | { kind: 'images'; images: string[] }
  /** Images + text as caption: one message (Telegram: an album when several images). */
  | { kind: 'captioned'; images: string[] };

/** Why "combine" fell back to separate messages. */
export type CombineFallback = 'zalo_multi_image' | 'zalo_not_photo' | 'caption_too_long';

export interface BlockSendPlan {
  steps: CampaignSendStep[];
  fallback: CombineFallback | null;
}

export function readCampaignSendOptions(parsed: unknown): CampaignSendOptions {
  const value = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return {
    order: value.order === 'images_first' ? 'images_first' : 'text_first',
    combine: value.combine === true,
  };
}

function isTelegramChannel(channel: string): boolean {
  return channel === 'telegram_user' || channel === 'telegram_bot';
}

/**
 * @param text text that will be sent (after `{name}` substitution and Zalo markup removal)
 */
export function planBlockSend(input: {
  text: string;
  images: readonly string[];
  channel: string;
  options: CampaignSendOptions;
}): BlockSendPlan {
  const hasText = input.text.trim().length > 0;
  const images = input.images.filter(Boolean);
  if (!hasText && images.length === 0) return { steps: [], fallback: null };
  if (images.length === 0) return { steps: [{ kind: 'text' }], fallback: null };
  if (!hasText) return { steps: [{ kind: 'images', images }], fallback: null };

  let fallback: CombineFallback | null = null;
  if (input.options.combine) {
    if (isTelegramChannel(input.channel)) {
      if (input.text.length <= TELEGRAM_CAPTION_LIMIT) return { steps: [{ kind: 'captioned', images }], fallback: null };
      fallback = 'caption_too_long';
    } else if (images.length === 1 && ZALO_CAPTION_IMAGE.test(images[0])) {
      return { steps: [{ kind: 'captioned', images }], fallback: null };
    } else {
      fallback = images.length > 1 ? 'zalo_multi_image' : 'zalo_not_photo';
    }
  }

  const steps: CampaignSendStep[] = input.options.order === 'images_first'
    ? [{ kind: 'images', images }, { kind: 'text' }]
    : [{ kind: 'text' }, { kind: 'images', images }];
  return { steps, fallback };
}

export const COMBINE_FALLBACK_LABEL: Record<CombineFallback, string> = {
  zalo_multi_image: 'Zalo chỉ gắn chữ vào 1 ảnh — nhiều ảnh sẽ gửi chữ riêng',
  zalo_not_photo: 'Zalo chỉ gắn chữ vào ảnh jpg / png / webp',
  caption_too_long: `Chữ dài hơn ${TELEGRAM_CAPTION_LIMIT} ký tự — Telegram không cho làm chú thích ảnh`,
};
