/**
 * Tin "định dạng phong phú" của Telegram (rich message, layer 23x): nội dung là các khối như Instant View — tiêu đề nhiều
 * cấp, đoạn văn, danh sách (cả ô đánh dấu), trích dẫn, bảng, công thức, hàng nút… — trong `message.richMessage`, còn phần
 * chữ `message` để trống. Layer cũ nhận các tin này thành `messageMediaUnsupported` rỗng ("Loại tin nhắn Telegram chưa
 * được hỗ trợ").
 *
 * Deplao hiển thị / tìm kiếm / xem trước tin Telegram dạng chữ → chuyển các khối thành chữ thường: mỗi khối một đoạn
 * (cách nhau một dòng trống), danh sách có "•" / "1." / "☐ ☑", trích dẫn có "│ ", bảng nối ô bằng " | ", nút "[…]",
 * link giữ địa chỉ khi chữ hiện khác địa chỉ. Ảnh / video / tệp trong khối chỉ còn nhãn + chú thích.
 */

export interface RichMessageText {
  text: string;
  /** Telegram chỉ gửi một phần (tin dài) — lấy đủ bằng messages.getRichMessage. */
  part: boolean;
}

const MAX_DEPTH = 40;

function cls(node: any): string {
  return String(node?.className || '');
}

/** RichText (textPlain / textBold / textConcat / textUrl …) → chữ thường. */
export function richTextToPlain(node: any, depth = 0): string {
  if (node == null || depth > MAX_DEPTH) return '';
  if (typeof node === 'string') return node;
  switch (cls(node)) {
    case 'TextEmpty':
      return '';
    case 'TextPlain':
      return String(node.text ?? '');
    case 'TextConcat':
      return (node.texts || []).map((part: any) => richTextToPlain(part, depth + 1)).join('');
    case 'TextUrl': {
      const label = richTextToPlain(node.text, depth + 1);
      const url = String(node.url || '');
      return url && !label.includes(url) ? (label ? `${label} (${url})` : url) : label;
    }
    case 'TextEmail': {
      const label = richTextToPlain(node.text, depth + 1);
      return label || String(node.email || '');
    }
    case 'TextPhone': {
      const label = richTextToPlain(node.text, depth + 1);
      return label || String(node.phone || '');
    }
    case 'TextMath':
      return String(node.source || '');
    case 'TextCustomEmoji':
      return String(node.alt || '');
    case 'TextImage':
      return '';
    case 'TextButton': {
      const label = richTextToPlain(node.text, depth + 1);
      return label ? `[${label}]` : '';
    }
    default:
      // textBold / Italic / Underline / Strike / Fixed / Sub / Superscript / Marked / Spoiler / Mention / Hashtag /
      // BotCommand / Cashtag / Auto* / BankCard / TonAddress / MentionName / Anchor / Date / Diff (chữ hiện = text mới)
      if (node.text !== undefined) return richTextToPlain(node.text, depth + 1);
      return '';
  }
}

function captionLines(caption: any, depth: number): string[] {
  if (!caption) return [];
  const text = richTextToPlain(caption.text ?? caption, depth + 1).trim();
  const credit = caption.credit ? richTextToPlain(caption.credit, depth + 1).trim() : '';
  return [text, credit ? `— ${credit}` : ''].filter(Boolean);
}

function prefixLines(lines: string[], prefix: string): string[] {
  return lines.map(line => `${prefix}${line}`);
}

function listItemLines(item: any, marker: string, depth: number): string[] {
  const box = item?.checkbox ? (item.checked ? '☑ ' : '☐ ') : '';
  const head = `${marker}${box}`;
  if (Array.isArray(item?.blocks)) {
    const inner = blocksToLines(item.blocks, depth + 1);
    if (!inner.length) return [head.trimEnd()];
    return [`${head}${inner[0]}`, ...prefixLines(inner.slice(1), ' '.repeat(head.length))];
  }
  const text = richTextToPlain(item?.text, depth + 1);
  const lines = text.split('\n');
  return [`${head}${lines[0]}`, ...prefixLines(lines.slice(1), ' '.repeat(head.length))];
}

function blockLines(block: any, depth: number): string[] {
  if (!block || depth > MAX_DEPTH) return [];
  const text = (value: any) => richTextToPlain(value, depth + 1);
  switch (cls(block)) {
    case 'PageBlockUnsupported':
    case 'PageBlockAnchor':
      return [];
    case 'PageBlockTitle':
    case 'PageBlockSubtitle':
    case 'PageBlockHeader':
    case 'PageBlockSubheader':
    case 'PageBlockKicker':
    case 'PageBlockHeading1':
    case 'PageBlockHeading2':
    case 'PageBlockHeading3':
    case 'PageBlockHeading4':
    case 'PageBlockHeading5':
    case 'PageBlockHeading6':
    case 'PageBlockParagraph':
    case 'PageBlockPreformatted':
    case 'PageBlockFooter':
      return text(block.text).split('\n');
    case 'PageBlockThinking':
      return prefixLines(text(block.text).split('\n'), '💭 ');
    case 'PageBlockMath':
      return String(block.source || '').split('\n');
    case 'PageBlockDivider':
      return ['──────────'];
    case 'PageBlockAuthorDate': {
      const author = text(block.author).trim();
      const date = Number(block.publishedDate || 0);
      const day = date > 0 ? new Date(date * 1000).toLocaleDateString('vi-VN') : '';
      return [[author, day].filter(Boolean).join(' · ')].filter(Boolean);
    }
    case 'PageBlockList':
      return (block.items || []).flatMap((item: any) => listItemLines(item, '• ', depth));
    case 'PageBlockOrderedList': {
      const items: any[] = block.items || [];
      const start = Number(block.start) || 1;
      return items.flatMap((item: any, index: number) => {
        const number = item?.num || String(block.reversed ? start + items.length - 1 - index : start + index);
        return listItemLines(item, `${number}. `, depth);
      });
    }
    case 'PageBlockBlockquote':
    case 'PageBlockPullquote':
    case 'PageBlockBlockquoteBlocks': {
      const body = cls(block) === 'PageBlockBlockquoteBlocks'
        ? blocksToLines(block.blocks || [], depth + 1)
        : text(block.text).split('\n');
      const caption = text(block.caption).trim();
      return [...prefixLines(body, '│ '), ...(caption ? [`│ — ${caption}`] : [])].map(line => line.trimEnd());
    }
    case 'PageBlockPhoto':
      return ['🖼 Ảnh', ...captionLines(block.caption, depth)];
    case 'PageBlockVideo':
      return ['🎬 Video', ...captionLines(block.caption, depth)];
    case 'PageBlockAudio':
      return ['🎵 Âm thanh', ...captionLines(block.caption, depth)];
    case 'PageBlockDocument':
      return ['📄 Tệp', ...captionLines(block.caption, depth)];
    case 'PageBlockMap':
    case 'InputPageBlockMap':
      return ['📍 Bản đồ', ...captionLines(block.caption, depth)];
    case 'PageBlockEmbed':
      return [block.url ? `🔗 ${block.url}` : '🔗 Nội dung nhúng', ...captionLines(block.caption, depth)];
    case 'PageBlockEmbedPost':
      return [
        [block.author, block.url].filter(Boolean).join(' · '),
        ...blocksToLines(block.blocks || [], depth + 1),
        ...captionLines(block.caption, depth),
      ].filter(Boolean);
    case 'PageBlockCollage':
    case 'PageBlockSlideshow':
      return [...blocksToLines(block.items || [], depth + 1), ...captionLines(block.caption, depth)];
    case 'PageBlockCover':
      return blockLines(block.cover, depth + 1);
    case 'PageBlockChannel':
      return block.channel?.title ? [`📢 ${block.channel.title}`] : [];
    case 'PageBlockTable': {
      const title = text(block.title).trim();
      const rows = (block.rows || []).map((row: any) => (row?.cells || [])
        .map((cell: any) => text(cell?.text).replace(/\s*\n\s*/g, ' ').trim())
        .join(' | '));
      return [title, ...rows].filter(Boolean);
    }
    case 'PageBlockDetails':
      return [`▸ ${text(block.title).trim()}`, ...prefixLines(blocksToLines(block.blocks || [], depth + 1), '  ')];
    case 'PageBlockRelatedArticles':
      return [
        text(block.title).trim(),
        ...(block.articles || []).map((article: any) => `• ${article?.title || article?.url || ''}`.trimEnd()),
      ].filter(line => line && line !== '•');
    case 'PageBlockButtonRow': {
      const buttons = (block.buttons || []).map((button: any) => text(button?.text).trim()).filter(Boolean);
      return buttons.length ? [buttons.map((label: string) => `[${label}]`).join('  ')] : [];
    }
    default:
      // Khối mới hơn schema này: lấy chữ nếu có
      if (block.text !== undefined) return text(block.text).split('\n');
      if (Array.isArray(block.blocks)) return blocksToLines(block.blocks, depth + 1);
      return [];
  }
}

/** Danh sách khối → các dòng; giữa hai khối có nội dung là một dòng trống. */
function blocksToLines(blocks: any[], depth: number): string[] {
  const out: string[] = [];
  for (const block of blocks || []) {
    const lines = blockLines(block, depth);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) continue;
    if (out.length) out.push('');
    out.push(...lines);
  }
  return out;
}

/** `message.richMessage` → chữ thường để lưu / hiển thị như tin chữ. null = không phải tin định dạng phong phú. */
export function richMessageToText(rich: any): RichMessageText | null {
  if (!rich || cls(rich) !== 'RichMessage' || !Array.isArray(rich.blocks)) return null;
  const text = blocksToLines(rich.blocks, 0)
    .map(line => line.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, part: !!rich.part };
}

// ─── Khối có cấu trúc để vẽ như Telegram (ảnh thật, tiêu đề, danh sách, bảng…) ───────────────────────────────

/** Một khối của tin định dạng phong phú — dạng gọn, lưu trong attachment `rich_message` (JSON). */
export type RichBlock =
  | { t: 'h1' | 'h2' | 'h3' | 'p' | 'kicker' | 'footer' | 'meta' | 'thinking'; text: string }
  | { t: 'code' | 'math'; text: string }
  | { t: 'divider' }
  | { t: 'list'; items: Array<{ marker: string; check?: 0 | 1; text: string }> }
  | { t: 'quote'; text: string; caption?: string }
  | { t: 'photo'; id: string; w?: number; h?: number; caption?: string }
  | { t: 'video' | 'audio' | 'file'; id: string; w?: number; h?: number; size?: number; duration?: number; name?: string; caption?: string }
  | { t: 'table'; title?: string; rows: string[][] }
  | { t: 'buttons'; labels: string[] }
  | { t: 'embed'; url?: string; caption?: string };

export interface RichMediaRef {
  id: string;
  kind: 'photo' | 'video' | 'audio' | 'file';
}

function idString(value: unknown): string {
  if (value == null) return '';
  const text = String((value as any)?.toString?.() ?? value);
  return text === '0' ? '' : text;
}

function photoSize(photo: any): { w?: number; h?: number } {
  const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
  let best: any = null;
  for (const size of sizes) {
    const w = Number(size?.w || 0);
    const h = Number(size?.h || 0);
    // photoSize / photoSizeProgressive / photoCachedSize đều có w, h — lấy cỡ lớn nhất
    if (w > 0 && h > 0 && (!best || w * h > best.w * best.h)) best = { w, h };
  }
  return best ? { w: best.w, h: best.h } : {};
}

function documentInfo(document: any): { kind: 'video' | 'audio' | 'file'; w?: number; h?: number; size?: number; duration?: number; name?: string } {
  const attributes: any[] = Array.isArray(document?.attributes) ? document.attributes : [];
  const video = attributes.find(attribute => cls(attribute) === 'DocumentAttributeVideo');
  const audio = attributes.find(attribute => cls(attribute) === 'DocumentAttributeAudio');
  const fileName = attributes.find(attribute => cls(attribute) === 'DocumentAttributeFilename')?.fileName;
  const size = Number(document?.size?.toString?.() ?? document?.size ?? 0) || undefined;
  if (video || String(document?.mimeType || '').startsWith('video/')) {
    return { kind: 'video', w: Number(video?.w) || undefined, h: Number(video?.h) || undefined, size, duration: Number(video?.duration) || undefined, name: fileName };
  }
  if (audio || String(document?.mimeType || '').startsWith('audio/')) {
    return { kind: 'audio', size, duration: Number(audio?.duration) || undefined, name: fileName };
  }
  return { kind: 'file', size, name: fileName };
}

function captionText(caption: any, depth: number): string | undefined {
  if (!caption) return undefined;
  const text = richTextToPlain(caption?.text !== undefined && cls(caption) === 'PageCaption' ? caption.text : caption, depth + 1).trim();
  const credit = cls(caption) === 'PageCaption' ? richTextToPlain(caption.credit, depth + 1).trim() : '';
  const joined = [text, credit ? `— ${credit}` : ''].filter(Boolean).join(' ');
  return joined || undefined;
}

function toBlocks(blocks: any[], rich: any, depth: number, out: RichBlock[]): void {
  if (depth > MAX_DEPTH) return;
  const photos = new Map<string, any>((rich?.photos || []).map((photo: any) => [idString(photo?.id), photo]));
  const documents = new Map<string, any>((rich?.documents || []).map((document: any) => [idString(document?.id), document]));
  const text = (value: any) => richTextToPlain(value, depth + 1).trim();
  for (const block of blocks || []) {
    switch (cls(block)) {
      case 'PageBlockUnsupported':
      case 'PageBlockAnchor':
        break;
      case 'PageBlockTitle':
      case 'PageBlockHeader':
      case 'PageBlockHeading1':
        if (text(block.text)) out.push({ t: 'h1', text: text(block.text) });
        break;
      case 'PageBlockSubtitle':
      case 'PageBlockSubheader':
      case 'PageBlockHeading2':
        if (text(block.text)) out.push({ t: 'h2', text: text(block.text) });
        break;
      case 'PageBlockHeading3':
      case 'PageBlockHeading4':
      case 'PageBlockHeading5':
      case 'PageBlockHeading6':
        if (text(block.text)) out.push({ t: 'h3', text: text(block.text) });
        break;
      case 'PageBlockKicker':
        if (text(block.text)) out.push({ t: 'kicker', text: text(block.text) });
        break;
      case 'PageBlockParagraph':
        if (text(block.text)) out.push({ t: 'p', text: richTextToPlain(block.text, depth + 1) });
        break;
      case 'PageBlockFooter':
        if (text(block.text)) out.push({ t: 'footer', text: text(block.text) });
        break;
      case 'PageBlockThinking':
        if (text(block.text)) out.push({ t: 'thinking', text: text(block.text) });
        break;
      case 'PageBlockPreformatted':
        out.push({ t: 'code', text: richTextToPlain(block.text, depth + 1) });
        break;
      case 'PageBlockMath':
        out.push({ t: 'math', text: String(block.source || '') });
        break;
      case 'PageBlockDivider':
        out.push({ t: 'divider' });
        break;
      case 'PageBlockAuthorDate': {
        const date = Number(block.publishedDate || 0);
        const line = [text(block.author), date > 0 ? new Date(date * 1000).toLocaleDateString('vi-VN') : ''].filter(Boolean).join(' · ');
        if (line) out.push({ t: 'meta', text: line });
        break;
      }
      case 'PageBlockList':
      case 'PageBlockOrderedList': {
        const ordered = cls(block) === 'PageBlockOrderedList';
        const items: any[] = block.items || [];
        const start = Number(block.start) || 1;
        out.push({
          t: 'list',
          items: items.map((item: any, index: number) => ({
            marker: ordered ? `${item?.num || (block.reversed ? start + items.length - 1 - index : start + index)}.` : '•',
            ...(item?.checkbox ? { check: (item.checked ? 1 : 0) as 0 | 1 } : {}),
            text: Array.isArray(item?.blocks) ? blocksToLines(item.blocks, depth + 1).join('\n') : richTextToPlain(item?.text, depth + 1),
          })),
        });
        break;
      }
      case 'PageBlockBlockquote':
      case 'PageBlockPullquote':
      case 'PageBlockBlockquoteBlocks': {
        const body = cls(block) === 'PageBlockBlockquoteBlocks'
          ? blocksToLines(block.blocks || [], depth + 1).join('\n')
          : richTextToPlain(block.text, depth + 1);
        const caption = text(block.caption);
        out.push({ t: 'quote', text: body, ...(caption ? { caption } : {}) });
        break;
      }
      case 'PageBlockPhoto': {
        const id = idString(block.photoId);
        out.push({ t: 'photo', id, ...photoSize(photos.get(id)), ...(captionText(block.caption, depth) ? { caption: captionText(block.caption, depth) } : {}) });
        break;
      }
      case 'PageBlockVideo':
      case 'PageBlockAudio':
      case 'PageBlockDocument': {
        const id = idString(block.videoId ?? block.audioId ?? block.documentId);
        const info = documentInfo(documents.get(id));
        const kind = cls(block) === 'PageBlockVideo' ? 'video' : cls(block) === 'PageBlockAudio' ? 'audio' : info.kind;
        const caption = captionText(block.caption, depth);
        out.push({ t: kind, id, w: info.w, h: info.h, size: info.size, duration: info.duration, name: info.name, ...(caption ? { caption } : {}) });
        break;
      }
      case 'PageBlockCover':
        toBlocks([block.cover], rich, depth + 1, out);
        break;
      case 'PageBlockCollage':
      case 'PageBlockSlideshow': {
        toBlocks(block.items || [], rich, depth + 1, out);
        const caption = captionText(block.caption, depth);
        if (caption) out.push({ t: 'footer', text: caption });
        break;
      }
      case 'PageBlockDetails':
        if (text(block.title)) out.push({ t: 'h3', text: text(block.title) });
        toBlocks(block.blocks || [], rich, depth + 1, out);
        break;
      case 'PageBlockTable': {
        const rows = (block.rows || []).map((row: any) => (row?.cells || []).map((cell: any) => text(cell?.text).replace(/\s*\n\s*/g, ' ')));
        out.push({ t: 'table', ...(text(block.title) ? { title: text(block.title) } : {}), rows });
        break;
      }
      case 'PageBlockButtonRow': {
        const labels = (block.buttons || []).map((button: any) => text(button?.text)).filter(Boolean);
        if (labels.length) out.push({ t: 'buttons', labels });
        break;
      }
      case 'PageBlockEmbed':
      case 'PageBlockEmbedPost': {
        const caption = captionText(block.caption, depth);
        out.push({ t: 'embed', ...(block.url ? { url: String(block.url) } : {}), ...(caption ? { caption } : {}) });
        if (cls(block) === 'PageBlockEmbedPost') toBlocks(block.blocks || [], rich, depth + 1, out);
        break;
      }
      case 'PageBlockChannel':
        if (block.channel?.title) out.push({ t: 'p', text: `📢 ${block.channel.title}` });
        break;
      case 'PageBlockMap':
      case 'InputPageBlockMap': {
        const caption = captionText(block.caption, depth);
        out.push({ t: 'p', text: caption ? `📍 ${caption}` : '📍 Bản đồ' });
        break;
      }
      case 'PageBlockRelatedArticles': {
        const title = text(block.title);
        if (title) out.push({ t: 'h3', text: title });
        const items = (block.articles || []).map((article: any) => ({ marker: '•', text: String(article?.title || article?.url || '') })).filter((item: any) => item.text);
        if (items.length) out.push({ t: 'list', items });
        break;
      }
      default:
        if (block?.text !== undefined && text(block.text)) out.push({ t: 'p', text: richTextToPlain(block.text, depth + 1) });
        else if (Array.isArray(block?.blocks)) toBlocks(block.blocks, rich, depth + 1, out);
    }
  }
}

/** `message.richMessage` → khối để vẽ (null = không phải tin định dạng phong phú). */
export function richMessageToBlocks(rich: any): RichBlock[] | null {
  if (!rich || cls(rich) !== 'RichMessage' || !Array.isArray(rich.blocks)) return null;
  const out: RichBlock[] = [];
  toBlocks(rich.blocks, rich, 0, out);
  return out;
}

/** Ảnh / video / tệp các khối dùng (id trong richMessage.photos / documents). */
export function richMediaRefs(blocks: RichBlock[] | null | undefined): RichMediaRef[] {
  const refs: RichMediaRef[] = [];
  const seen = new Set<string>();
  for (const block of blocks || []) {
    if ((block.t === 'photo' || block.t === 'video' || block.t === 'audio' || block.t === 'file') && block.id && !seen.has(block.id)) {
      seen.add(block.id);
      refs.push({ id: block.id, kind: block.t });
    }
  }
  return refs;
}

/** Danh sách việc cần làm (messageMediaToDo) → chữ: tiêu đề + "☐ / ☑ việc". */
export function todoListToText(media: any): { title: string; text: string; items: Array<{ id: number; text: string; done: boolean }> } {
  const todo = media?.todo || {};
  const done = new Set<number>((media?.completions || []).map((completion: any) => Number(completion?.id)));
  const title = String(todo?.title?.text ?? todo?.title ?? '').trim();
  const items = (todo?.list || []).map((item: any) => ({
    id: Number(item?.id),
    text: String(item?.title?.text ?? item?.title ?? '').trim(),
    done: done.has(Number(item?.id)),
  }));
  const text = [title || 'Danh sách việc cần làm', ...items.map((item: { text: string; done: boolean }) => `${item.done ? '☑' : '☐'} ${item.text}`)]
    .join('\n');
  return { title, text, items };
}
