/**
 * Facebook template messages (Page / bot: generic, button, media, product cards, asking consent to receive "Ưu đãi và thông báo" (Offers and notifications)…).
 * Facebook sends them as XMA (LightSpeed, via the Go bridge) or as `extensible_attachment.story_attachment` (MQTT / GraphQL).
 * Previously all 3 paths dropped the text + buttons → the message was saved with empty `text` (the bubble only showed the time).
 *
 * Shared model for main + renderer: normalizes to `FbTemplate` (stored in the `attachments` column, msg_type `fb.template`),
 * builds fallback text for content / preview / search, and classifies buttons (open link / call / postback).
 * Pure functions: test in src/__tests__/facebook/facebookTemplate.test.ts.
 */

import { tr } from '../i18n';

export const FB_TEMPLATE_MSG_TYPE = 'fb.template';

/** url: open link · phone: phone number · postback: button of the Page / bot (sends the button title back to the Page) */
export type FbTemplateButtonKind = 'url' | 'phone' | 'postback';

export interface FbTemplateButton {
  title: string;
  kind: FbTemplateButtonKind;
  url?: string;
  phone?: string;
  /** Facebook's original CTA type (xma_web_url…), kept for diagnosis. */
  rawType?: string;
}

export interface FbTemplateItem {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  url?: string;
  buttons?: FbTemplateButton[];
}

export interface FbTemplate {
  type: 'template';
  header?: string;
  title?: string;
  subtitle?: string;
  body?: string;
  footer?: string;
  /** Domain / source (shared link). */
  source?: string;
  imageUrl?: string;
  /** Tapping the card opens this link. */
  url?: string;
  /** Shared reel / video: the playable file (the card shows a play button). */
  videoUrl?: string;
  buttons?: FbTemplateButton[];
  /** Carousel (generic template with several cards). */
  items?: FbTemplateItem[];
}

const MAX_TEXT = 2000;
const MAX_BUTTONS = 6;
const MAX_ITEMS = 10;

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).replace(/\r\n?/g, '\n').trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

/** l.php?u=… (link through Facebook) → real link; relative Facebook paths → absolute. */
export function unwrapFacebookRedirect(raw: unknown): string {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  const redirect = url.match(/^(?:https?:\/\/(?:[a-z0-9-]+\.)*facebook\.com)?\/l\.php\?(.*)$/i);
  if (redirect) {
    try {
      const target = new URLSearchParams(redirect[1]).get('u');
      if (target) return target;
    } catch { /* keep as is */ }
  }
  if (url.startsWith('/') && !url.startsWith('//')) return `https://www.facebook.com${url}`;
  return url;
}

function webUrl(raw: unknown): string | undefined {
  const url = unwrapFacebookRedirect(raw);
  return /^https?:\/\//i.test(url) ? url : undefined;
}

function phoneOf(raw: unknown): string | undefined {
  const value = String(raw ?? '').trim();
  const tel = value.match(/^tel:(.+)$/i);
  const candidate = (tel ? tel[1] : value).replace(/[^\d+]/g, '');
  return candidate.replace(/\D/g, '').length >= 6 ? candidate : undefined;
}

/** Classify a button: has a web link → open link; tel: / type "phone|call" → phone number; otherwise → postback. */
export function classifyFbButton(input: {
  title?: unknown; type?: unknown; url?: unknown; nativeUrl?: unknown;
} | null | undefined): FbTemplateButton | null {
  const title = clean(input?.title);
  if (!title) return null;
  const rawType = clean(input?.type);
  const telSource = [input?.url, input?.nativeUrl].find(v => /^tel:/i.test(String(v ?? '').trim()));
  if (telSource || /phone|call/i.test(rawType || '')) {
    const phone = phoneOf(telSource ?? input?.nativeUrl ?? input?.url);
    if (phone) return { title, kind: 'phone', phone, ...(rawType ? { rawType } : {}) };
  }
  const url = webUrl(input?.url) || webUrl(input?.nativeUrl);
  if (url) return { title, kind: 'url', url, ...(rawType ? { rawType } : {}) };
  return { title, kind: 'postback', ...(rawType ? { rawType } : {}) };
}

function buttonsOf(list: unknown, map: (raw: any) => FbTemplateButton | null): FbTemplateButton[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: FbTemplateButton[] = [];
  for (const raw of list) {
    const button = map(raw);
    if (button && !out.some(b => b.title === button.title && b.kind === button.kind)) out.push(button);
    if (out.length >= MAX_BUTTONS) break;
  }
  return out.length ? out : undefined;
}

function compactItem(item: FbTemplateItem): FbTemplateItem | null {
  const out: FbTemplateItem = {};
  if (item.title) out.title = item.title;
  if (item.subtitle) out.subtitle = item.subtitle;
  if (item.imageUrl) out.imageUrl = item.imageUrl;
  if (item.url) out.url = item.url;
  if (item.buttons?.length) out.buttons = item.buttons;
  return Object.keys(out).length ? out : null;
}

function compactTemplate(t: FbTemplate): FbTemplate | null {
  const out: FbTemplate = { type: 'template' };
  for (const key of ['header', 'title', 'subtitle', 'body', 'footer', 'source', 'imageUrl', 'url', 'videoUrl'] as const) {
    if (t[key]) out[key] = t[key];
  }
  if (t.buttons?.length) out.buttons = t.buttons.slice(0, MAX_BUTTONS);
  const items = (t.items || []).map(compactItem).filter((i): i is FbTemplateItem => !!i).slice(0, MAX_ITEMS);
  if (items.length) out.items = items;
  return Object.keys(out).length > 1 ? out : null;
}

const bridgeButton = (raw: any) => classifyFbButton({
  title: raw?.title, type: raw?.type, url: raw?.url, nativeUrl: raw?.nativeUrl,
});

/** Card from the Go bridge (Attachment type "template"; "link" is also read: fileName = title, description = description). */
export function templateFromBridgeAttachment(att: any): FbTemplate | null {
  if (!att || typeof att !== 'object') return null;
  return compactTemplate({
    type: 'template',
    header: clean(att.header),
    title: clean(att.title ?? att.fileName),
    subtitle: clean(att.subtitle ?? att.description),
    body: clean(att.body),
    footer: clean(att.footer),
    source: clean(att.sourceText ?? att.source),
    imageUrl: webUrl(att.imageUrl) || webUrl(att.previewUrl),
    url: webUrl(att.url),
    videoUrl: webUrl(att.playableUrl ?? att.videoUrl),
    buttons: buttonsOf(att.buttons, bridgeButton),
    items: Array.isArray(att.items) ? att.items.map((item: any) => ({
      title: clean(item?.title),
      subtitle: clean(item?.subtitle),
      imageUrl: webUrl(item?.imageUrl),
      url: webUrl(item?.url),
      buttons: buttonsOf(item?.buttons, bridgeButton),
    })) : undefined,
  });
}

/**
 * MQTT `mercury.extensible_attachment` / GraphQL `extensible_attachment`: `{ story_attachment: { title_with_entities,
 * description, source, media.image, url, action_links[], subattachments[] } }`.
 */
export function templateFromStoryAttachment(ext: any): FbTemplate | null {
  const story = ext?.story_attachment ?? ext;
  if (!story || typeof story !== 'object') return null;
  const media = story.media || {};
  const items = Array.isArray(story.subattachments)
    ? story.subattachments
      .map((sub: any) => templateFromStoryAttachment(sub))
      .filter((sub: FbTemplate | null): sub is FbTemplate => !!sub)
      .map((sub: FbTemplate) => ({ title: sub.title, subtitle: sub.subtitle, imageUrl: sub.imageUrl, url: sub.url, buttons: sub.buttons }))
    : undefined;
  return compactTemplate({
    type: 'template',
    title: clean(story.title_with_entities?.text ?? story.title),
    subtitle: clean(story.description?.text ?? (typeof story.description === 'string' ? story.description : undefined)),
    source: clean(story.source?.text),
    imageUrl: webUrl(media.image?.uri) || webUrl(media.animated_image?.uri) || webUrl(media.preview_image?.uri),
    url: webUrl(story.url),
    videoUrl: webUrl(media.playable_url),
    buttons: buttonsOf(story.action_links, (raw: any) => classifyFbButton({
      title: raw?.title, type: raw?.__typename ?? raw?.type, url: raw?.url,
    })),
    items,
  });
}

/** Card as stored in the `attachments` column (after the functions above) - check each field again. */
export function normalizeStoredTemplate(raw: any): FbTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const storedButton = (b: any): FbTemplateButton | null => {
    const title = clean(b?.title);
    if (!title) return null;
    if (b?.kind === 'url' && webUrl(b.url)) return { title, kind: 'url', url: webUrl(b.url) };
    if (b?.kind === 'phone' && phoneOf(b.phone)) return { title, kind: 'phone', phone: phoneOf(b.phone) };
    return { title, kind: 'postback' };
  };
  return compactTemplate({
    type: 'template',
    header: clean(raw.header),
    title: clean(raw.title),
    subtitle: clean(raw.subtitle),
    body: clean(raw.body),
    footer: clean(raw.footer),
    source: clean(raw.source),
    imageUrl: webUrl(raw.imageUrl),
    url: webUrl(raw.url),
    videoUrl: webUrl(raw.videoUrl),
    buttons: buttonsOf(raw.buttons, storedButton),
    items: Array.isArray(raw.items) ? raw.items.map((item: any) => ({
      title: clean(item?.title),
      subtitle: clean(item?.subtitle),
      imageUrl: webUrl(item?.imageUrl),
      url: webUrl(item?.url),
      buttons: buttonsOf(item?.buttons, storedButton),
    })) : undefined,
  });
}

/** First card in the message's `attachments` column (JSON or array). */
export function fbTemplateFromAttachments(raw: unknown): FbTemplate | null {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw || '[]'); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const found = list.find((a: any) => a && typeof a === 'object' && a.type === 'template');
  return found ? normalizeStoredTemplate(found) : null;
}

/** Fallback text for the card: message content, preview in the list, search. Never empty if the card has anything. */
export function fbTemplateText(t: FbTemplate | null | undefined): string {
  if (!t) return '';
  const lines: string[] = [];
  const push = (value?: string) => {
    const text = clean(value);
    if (text && !lines.includes(text)) lines.push(text);
  };
  push(t.header);
  push(t.title);
  push(t.subtitle);
  push(t.body);
  push(t.footer);
  if (!lines.length && t.items?.length) {
    push(t.items[0].title);
    push(t.items[0].subtitle);
  }
  if (!lines.length && t.buttons?.length) push(t.buttons.map(b => b.title).join(' · '));
  if (!lines.length) push(t.source);
  if (!lines.length) push(t.url);
  return lines.join('\n');
}

/** One line for the conversation list (Facebook shows "Tiêu đề - Mô tả" (Title - Description)). */
export function fbTemplatePreview(t: FbTemplate | null | undefined): string {
  return fbTemplateText(t).split('\n').slice(0, 2).join(' - ');
}

/** Has a postback button (can only be tapped correctly on Messenger) → also shows "Mở trên Messenger" (Open on Messenger). */
export function fbTemplateHasPostback(t: FbTemplate | null | undefined): boolean {
  if (!t) return false;
  return !!(t.buttons?.some(b => b.kind === 'postback') || t.items?.some(i => i.buttons?.some(b => b.kind === 'postback')));
}

/** Buttons + child cards (with the child card's buttons) + link + image. A card with text only = 0. */
export function fbTemplateRichness(t: FbTemplate | null | undefined): number {
  if (!t) return 0;
  const items = t.items || [];
  const itemButtons = items.reduce((sum, item) => sum + (item.buttons?.length || 0), 0);
  return (t.buttons?.length || 0) + items.length + itemButtons + (t.url ? 1 : 0) + (t.imageUrl ? 1 : 0) + (t.videoUrl ? 1 : 0);
}

const UNAVAILABLE_TITLE = /^(file đính kèm không hiển thị|attachment unavailable)$/i;
const UNAVAILABLE_SUBTITLE = /^(file đính kèm này có thể đã bị gỡ|this attachment may have been removed)/i;

/**
 * Replacement card "File đính kèm không hiển thị" (Attachment Unavailable): Facebook sends this version to the old MQTT channel when that channel
 * cannot draw the message type (e.g. a message with a Page button). The LightSpeed bridge usually receives all the real cards of the same message.
 */
export function isFbUnavailableTemplate(t: FbTemplate | null | undefined): boolean {
  if (!t || fbTemplateRichness(t) > 0) return false;
  return UNAVAILABLE_TITLE.test((t.title || '').trim()) || UNAVAILABLE_SUBTITLE.test((t.subtitle || '').trim());
}

/**
 * MQTT and the bridge both receive the same message; whichever writes first wins: a later copy replaces the saved one when the saved one is the replacement card
 * "File đính kèm không hiển thị" or text only, and the later copy has buttons / child cards / a link / an image. Never replace a complete
 * copy with a poorer one.
 */
export function shouldUpgradeFbTemplate(stored: FbTemplate | null | undefined, incoming: FbTemplate | null | undefined): boolean {
  if (!incoming || isFbUnavailableTemplate(incoming)) return false;
  if (!stored || isFbUnavailableTemplate(stored)) return true;
  return fbTemplateRichness(stored) === 0 && fbTemplateRichness(incoming) > 0;
}

/**
 * A Page "text + button" message (button template, e.g. "Hãy chọn dịch vụ…" + "Tư vấn sản phẩm"): the bridge sends the text as the message
 * content and the button as a card with no text. Merge the message text into the card so the card draws the full text + button, and preview / search include the text.
 * A card that already has its own text keeps it.
 */
export function withTemplateText(t: FbTemplate | null, text: unknown): FbTemplate | null {
  if (!t) return t;
  const body = clean(text);
  if (!body || t.header || t.title || t.subtitle || t.body || t.footer) return t;
  return { ...t, body };
}

/** Bridge message whose content cannot be read (E2EE view-once, payments…): fallback text instead of an empty bubble. */
export function fbUnsupportedText(kind: unknown): string {
  switch (String(kind || '')) {
    case 'view_once': return tr('[Ảnh / video xem một lần — mở trên Messenger để xem]');
    case 'payment': return tr('[Giao dịch thanh toán — mở trên Messenger để xem]');
    case 'live_location': return tr('[Đang chia sẻ vị trí trực tiếp]');
    case 'contact': return tr('[Danh thiếp — mở trên Messenger để xem]');
    case 'group_invite': return tr('[Lời mời tham gia nhóm — mở trên Messenger để xem]');
    case 'poll': return tr('[Bình chọn — mở trên Messenger để xem]');
    case 'note_reply': return tr('[Trả lời ghi chú]');
    case 'undecryptable': return tr('[Chưa giải mã được tin này, đang chờ người gửi gửi lại]');
    case 'bump': return tr('Đã nhắc lại tin nhắn này');
    default: return tr('[Tin nhắn chưa hỗ trợ — mở trên Messenger để xem]');
  }
}

/** Open the conversation on Messenger web (for postback buttons / unsupported messages that need an exact action). */
export function messengerThreadUrl(threadId: string | number | null | undefined): string {
  const id = String(threadId ?? '').replace(/@.*$/, '').trim();
  return /^\d+$/.test(id) ? `https://www.facebook.com/messages/t/${id}` : 'https://www.facebook.com/messages';
}

/**
 * Attachment entry marking an encrypted message saved before it could be decrypted: the sender's re-send (same id)
 * replaces the row (DatabaseService.saveFBMessage).
 */
export const FB_UNDECRYPTABLE_ATTACHMENT = 'fb_undecryptable';
