/**
 * Tin mẫu Facebook (Page / bot: generic, button, media, thẻ sản phẩm, xin đồng ý nhận "Ưu đãi và thông báo"…).
 * Facebook gửi dạng XMA (LightSpeed, qua Go bridge) hoặc `extensible_attachment.story_attachment` (MQTT / GraphQL).
 * Trước đây cả 3 đường đều bỏ phần chữ + nút → lưu tin `text` rỗng (bong bóng chỉ còn giờ).
 *
 * Mô hình chung cho main + renderer: chuẩn hoá về `FbTemplate` (lưu trong cột `attachments`, msg_type `fb.template`),
 * sinh chữ thay thế cho nội dung / xem trước / tìm kiếm, phân loại nút (mở link / gọi điện / postback).
 * Thuần — test ở src/__tests__/facebookTemplate.test.ts.
 */

export const FB_TEMPLATE_MSG_TYPE = 'fb.template';

/** url: mở link · phone: số điện thoại · postback: nút của Page / bot (gửi lại tên nút cho Page) */
export type FbTemplateButtonKind = 'url' | 'phone' | 'postback';

export interface FbTemplateButton {
  title: string;
  kind: FbTemplateButtonKind;
  url?: string;
  phone?: string;
  /** Loại CTA gốc của Facebook (xma_web_url…), giữ để chẩn đoán. */
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
  /** Tên miền / nguồn (link chia sẻ). */
  source?: string;
  imageUrl?: string;
  /** Bấm vào thẻ mở link này. */
  url?: string;
  buttons?: FbTemplateButton[];
  /** Carousel (generic template nhiều thẻ). */
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

/** l.php?u=… (link qua Facebook) → link thật; đường dẫn Facebook tương đối → tuyệt đối. */
export function unwrapFacebookRedirect(raw: unknown): string {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  const redirect = url.match(/^(?:https?:\/\/(?:[a-z0-9-]+\.)*facebook\.com)?\/l\.php\?(.*)$/i);
  if (redirect) {
    try {
      const target = new URLSearchParams(redirect[1]).get('u');
      if (target) return target;
    } catch { /* giữ nguyên */ }
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

/** Phân loại một nút: có link web → mở link; tel:/loại "phone|call" → số điện thoại; còn lại → postback. */
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
  for (const key of ['header', 'title', 'subtitle', 'body', 'footer', 'source', 'imageUrl', 'url'] as const) {
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

/** Thẻ từ Go bridge (Attachment type "template"; "link" cũng đọc được: fileName = tiêu đề, description = mô tả). */
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
    buttons: buttonsOf(story.action_links, (raw: any) => classifyFbButton({
      title: raw?.title, type: raw?.__typename ?? raw?.type, url: raw?.url,
    })),
    items,
  });
}

/** Thẻ đã lưu trong cột `attachments` (sau khi qua các hàm trên) — kiểm tra lại từng trường. */
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

/** Thẻ đầu tiên trong cột `attachments` của tin (JSON hoặc mảng). */
export function fbTemplateFromAttachments(raw: unknown): FbTemplate | null {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw || '[]'); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const found = list.find((a: any) => a && typeof a === 'object' && a.type === 'template');
  return found ? normalizeStoredTemplate(found) : null;
}

/** Chữ thay thế của thẻ: nội dung tin, xem trước trong danh sách, tìm kiếm. Không bao giờ rỗng nếu thẻ có gì đó. */
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

/** Một dòng cho danh sách hội thoại (Facebook hiện "Tiêu đề - Mô tả"). */
export function fbTemplatePreview(t: FbTemplate | null | undefined): string {
  return fbTemplateText(t).split('\n').slice(0, 2).join(' - ');
}

/** Có nút postback (chỉ bấm chính xác được trên Messenger) → hiện thêm "Mở trên Messenger". */
export function fbTemplateHasPostback(t: FbTemplate | null | undefined): boolean {
  if (!t) return false;
  return !!(t.buttons?.some(b => b.kind === 'postback') || t.items?.some(i => i.buttons?.some(b => b.kind === 'postback')));
}

/** Tin bridge không đọc được nội dung (E2EE xem một lần, thanh toán…): chữ thay thế thay vì bong bóng rỗng. */
export function fbUnsupportedText(kind: unknown): string {
  switch (String(kind || '')) {
    case 'view_once': return '[Ảnh / video xem một lần — mở trên Messenger để xem]';
    case 'payment': return '[Giao dịch thanh toán — mở trên Messenger để xem]';
    case 'live_location': return '[Đang chia sẻ vị trí trực tiếp]';
    case 'contact': return '[Danh thiếp — mở trên Messenger để xem]';
    case 'group_invite': return '[Lời mời tham gia nhóm — mở trên Messenger để xem]';
    case 'poll': return '[Bình chọn — mở trên Messenger để xem]';
    case 'note_reply': return '[Trả lời ghi chú]';
    default: return '[Tin nhắn chưa hỗ trợ — mở trên Messenger để xem]';
  }
}

/** Mở hội thoại trên Messenger web (nút postback / tin chưa hỗ trợ cần thao tác chính xác). */
export function messengerThreadUrl(threadId: string | number | null | undefined): string {
  const id = String(threadId ?? '').replace(/@.*$/, '').trim();
  return /^\d+$/.test(id) ? `https://www.facebook.com/messages/t/${id}` : 'https://www.facebook.com/messages';
}
