/**
 * zaloZinstant.ts: Zalo Official Account "zinstant" messages (msgType `chat.webcontent` / `chat.webcontent.v2`): news posts,
 * ZNS notifications, promotions. Zalo PC draws them from the HTML template at `data_url`; the app builds the card from the data already in the message:
 *   - chat.webcontent: params.customMsg.msg (preview text) + params.item.bundle_data.post (image, title, description, post link).
 *   - chat.webcontent.v2: zinstant_msg.customMsg + zinstant_data.data: gzip-compressed + base64 JSON ({ item, bundle_data:
 *     { sections: slider / title / p / cta } }); the renderer decompresses it, then `applyZinstantData`.
 * The bank account card (action `zinstant.bankcard`) is NOT covered here (BankCardBubble).
 */

import { tr } from '../i18n';

export interface ZinstantButton { text: string; url?: string; primary?: boolean }

export interface ZinstantCard {
  /** The OA's preview text (customMsg), shown when the card has no title / content. */
  text: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  /** Link opened when the image / title is clicked. */
  url?: string;
  paragraphs: string[];
  buttons: ZinstantButton[];
  /** v2: card data still compressed (gzip + base64). */
  packedData?: string;
}

const parseJson = (value: unknown): any => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
  try { return JSON.parse(text); } catch { return value; }
};

const httpUrl = (value: unknown): string | undefined => {
  const url = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\//i.test(url) ? url : undefined;
};

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function customText(customMsg: any): string {
  const msg = parseJson(customMsg?.msg);
  if (typeof msg === 'string') return msg.trim();
  return clean(msg?.vi) || clean(msg?.en);
}

/** Strips the template's simple HTML tags (<span class="param">…</span>) and decodes a few common entities. */
export function stripZinstantHtml(text: string): string {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** An OA zinstant message (not counting the bank card). */
export function isZinstantMsgType(msgType: string | null | undefined, content?: unknown): boolean {
  if (msgType === 'chat.webcontent.v2') return true;
  if (msgType !== 'chat.webcontent') return false;
  const parsed = parseJson(content);
  return !(parsed && typeof parsed === 'object' && parsed.action === 'zinstant.bankcard');
}

function applyBundle(card: ZinstantCard, rawBundle: unknown): void {
  const bundle = parseJson(rawBundle);
  if (!bundle || typeof bundle !== 'object') return;

  const post = parseJson(bundle.post);
  if (post && typeof post === 'object') {
    card.title = card.title || clean(post.title) || undefined;
    card.description = card.description || clean(post.description) || undefined;
    card.imageUrl = card.imageUrl || httpUrl(post.thumbnail);
    card.url = card.url || httpUrl(post.url);
    if (card.url && !card.buttons.some((button) => button.url === card.url)) {
      card.buttons.push({ text: tr('Xem chi tiết'), url: card.url, primary: true });
    }
  }

  for (const section of Array.isArray(bundle.sections) ? bundle.sections : []) {
    if (!section || typeof section !== 'object') continue;
    const slides = section.slider?.items;
    if (Array.isArray(slides) && !card.imageUrl) {
      const first = slides.find((slide: any) => httpUrl(slide?.image));
      if (first) {
        card.imageUrl = httpUrl(first.image);
        card.url = card.url || httpUrl(first.click?.data_detail?.url) || httpUrl(first.click?.data);
      }
    }
    if (typeof section.title === 'string' && !card.title) card.title = stripZinstantHtml(section.title) || undefined;
    if (typeof section.p === 'string') {
      const paragraph = stripZinstantHtml(section.p);
      if (paragraph) card.paragraphs.push(paragraph);
    }
    if (Array.isArray(section.cta)) {
      for (const button of section.cta) {
        const text = clean(button?.text);
        if (!text) continue;
        card.buttons.push({
          text,
          url: httpUrl(button?.data_detail?.url) || httpUrl(button?.data),
          primary: /primary/i.test(String(button?.type || '')),
        });
      }
    }
  }
}

/** Builds the card from the message's content (JSON string or object). `null` if it is not an OA zinstant message. */
export function parseZinstantCard(content: unknown, msgType: string | null | undefined): ZinstantCard | null {
  if (!isZinstantMsgType(msgType, content)) return null;
  const parsed = parseJson(content);
  if (!parsed || typeof parsed !== 'object') return null;
  const card: ZinstantCard = { text: '', paragraphs: [], buttons: [] };

  if (msgType === 'chat.webcontent.v2') {
    card.text = customText(parseJson(parsed.zinstant_msg)?.customMsg);
    const data = parseJson(parseJson(parsed.zinstant_data)?.data);
    if (typeof data === 'string' && data.trim()) card.packedData = data.trim();
    else if (data && typeof data === 'object') applyZinstantData(card, data);
    return card;
  }

  const params = parseJson(parsed.params);
  card.text = customText(params?.customMsg) || clean(parsed.title) || clean(parsed.description);
  applyBundle(card, params?.item?.bundle_data ?? params?.pcItem?.bundle_data);
  return card;
}

/** Attaches the decompressed data of chat.webcontent.v2 ({ item, bundle_data }) to the card (edits it in place, returns the card). */
export function applyZinstantData(card: ZinstantCard, data: any): ZinstantCard {
  applyBundle(card, data?.bundle_data ?? data);
  card.packedData = undefined;
  return card;
}

/** Preview text (conversation list, quotes, notifications). '' if it is not an OA zinstant message. */
export function zinstantPreviewText(content: unknown, msgType: string | null | undefined): string {
  const card = parseZinstantCard(content, msgType);
  if (!card) return '';
  const line = (card.title || card.text || card.description || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
  return line ? `📢 ${line}` : tr('📢 Tin từ Official Account');
}
