/**
 * Tin định dạng phong phú Telegram (layer 23x, message.richMessage) vẽ như Telegram: tiêu đề đậm, đoạn, danh sách / ô
 * đánh dấu, trích dẫn, bảng, mã, nút — và ẢNH / VIDEO THẬT trong tin (trước đây chỉ là nhãn "🖼 Ảnh").
 *
 * Khối do main dựng sẵn (attachments `rich_message`, services/telegram/messages/telegramRichMessage.ts → RichBlock). Ảnh tải tự
 * động ở main (local_paths["rich_<id>"]); thiếu (mở lại app, tin cũ) → xin tải một lần. Video / âm thanh / tệp: bấm mới
 * tải (telegramUser:downloadRichMedia với mediaId), tải xong phát / mở tại chỗ.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import type { MediaViewerImage } from '../../media/MediaViewer';
import { TextWithMentions } from '../../messages/ChatWindowBubbles';

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

type MediaBlock = Extract<RichBlock, { id: string }>;

function parseJson(value: unknown): any {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value || 'null');
  } catch {
    return null;
  }
}

/** Khối của tin định dạng phong phú (null = tin thường). */
export function getRichMessageBlocks(msg: any): RichBlock[] | null {
  const attachments = parseJson(msg?.attachments);
  if (!Array.isArray(attachments)) return null;
  const rich = attachments.find((item: any) => item?.type === 'rich_message');
  return Array.isArray(rich?.blocks) && rich.blocks.length ? (rich.blocks as RichBlock[]) : null;
}

function localPathsOf(msg: any): Record<string, string> {
  const parsed = parseJson(msg?.local_paths);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function formatBytes(bytes?: number): string {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds?: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function aspectOf(block: { w?: number; h?: number }): string {
  const w = Number(block.w) || 0;
  const h = Number(block.h) || 0;
  // Ảnh quá dọc không cao vô hạn (như Telegram), chưa biết kích thước → 4:3
  return w > 0 && h > 0 ? String(Math.max(w / h, 0.6)) : String(4 / 3);
}

export interface TelegramRichMessageBodyProps {
  msg: any;
  /** Mở trình xem ảnh với mọi ảnh của tin, đứng ở ảnh được bấm. */
  onOpenImages?: (images: MediaViewerImage[], index: number) => void;
  highlight?: string;
  allContacts?: any[];
  groupMembersList?: any[];
}

export default function TelegramRichMessageBody({ msg, onOpenImages, highlight, allContacts, groupMembersList }: TelegramRichMessageBodyProps) {
  const blocks = React.useMemo(() => getRichMessageBlocks(msg), [msg?.attachments]);
  const localPaths = React.useMemo(() => localPathsOf(msg), [msg?.local_paths]);
  const [overridePaths, setOverridePaths] = React.useState<Record<string, string>>({});
  const paths = React.useMemo(() => ({ ...localPaths, ...overridePaths }), [localPaths, overridePaths]);
  const [busy, setBusy] = React.useState<Record<string, boolean>>({});
  const [failed, setFailed] = React.useState<Record<string, boolean>>({});
  const [playing, setPlaying] = React.useState<Record<string, boolean>>({});
  const askedPhotosRef = React.useRef(false);

  const accountId = String(msg?.owner_zalo_id || '');
  const chatId = String(msg?.thread_id || '');
  const messageId = String(msg?.msg_id || '');
  const canDownload = msg?.channel === 'telegram_user' && !!accountId && !!chatId && /^\d+$/.test(messageId);

  const photos = React.useMemo(
    () => (blocks || []).filter((block): block is Extract<RichBlock, { t: 'photo' }> => block.t === 'photo' && !!block.id),
    [blocks],
  );
  const missingPhotos = photos.some((photo) => !paths[`rich_${photo.id}`]);

  // Ảnh chưa có file (mở lại app, tin cũ / tin vừa sửa): xin main tải một lần cho cả tin
  React.useEffect(() => {
    if (!canDownload || !missingPhotos || askedPhotosRef.current) return;
    askedPhotosRef.current = true;
    void ipc.telegramUser?.downloadRichMedia?.({ accountId, chatId, messageId })
      .then((result) => {
        if (result?.success && result.localPaths) setOverridePaths((previous) => ({ ...previous, ...result.localPaths }));
      })
      .catch(() => {});
  }, [canDownload, missingPhotos, accountId, chatId, messageId]);

  const download = React.useCallback(async (block: MediaBlock): Promise<string> => {
    const key = `rich_${block.id}`;
    if (paths[key]) return paths[key];
    if (!canDownload || busy[block.id]) return '';
    setBusy((previous) => ({ ...previous, [block.id]: true }));
    setFailed((previous) => ({ ...previous, [block.id]: false }));
    try {
      const result = await ipc.telegramUser?.downloadRichMedia?.({ accountId, chatId, messageId, mediaId: block.id });
      const path = result?.success ? result.localPaths?.[key] || '' : '';
      if (path) setOverridePaths((previous) => ({ ...previous, ...(result?.localPaths || {}), [key]: path }));
      else setFailed((previous) => ({ ...previous, [block.id]: true }));
      return path;
    } catch {
      setFailed((previous) => ({ ...previous, [block.id]: true }));
      return '';
    } finally {
      setBusy((previous) => ({ ...previous, [block.id]: false }));
    }
  }, [paths, canDownload, busy, accountId, chatId, messageId]);

  if (!blocks) return null;

  const text = (value: string, className: string) => (
    <div className={className}>
      <TextWithMentions text={value} channel={msg?.channel} allContacts={allContacts} groupMembersList={groupMembersList} highlight={highlight} />
    </div>
  );

  const openPhoto = (photoId: string) => {
    if (!onOpenImages) return;
    const images: MediaViewerImage[] = [];
    let index = 0;
    for (const photo of photos) {
      const path = paths[`rich_${photo.id}`];
      if (!path) continue;
      if (photo.id === photoId) index = images.length;
      const url = toLocalMediaUrl(path);
      images.push({ src: url, displaySrc: url, localPath: path, msgId: messageId, threadId: chatId, timestamp: Number(msg?.timestamp) || undefined });
    }
    if (images.length) onOpenImages(images, index);
  };

  const caption = (value?: string) => (value ? <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">{value}</div> : null);

  const renderBlock = (block: RichBlock): React.ReactNode => {
    switch (block.t) {
      case 'h1':
        return text(block.text, 'text-[17px] font-bold leading-snug');
      case 'h2':
        return text(block.text, 'text-[15px] font-semibold leading-snug');
      case 'h3':
        return text(block.text, 'text-sm font-semibold');
      case 'kicker':
        return <div className="text-[11px] font-semibold uppercase tracking-wide text-primary">{block.text}</div>;
      case 'p':
        return text(block.text, 'text-sm whitespace-pre-wrap break-words');
      case 'footer':
      case 'meta':
        return <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{block.text}</div>;
      case 'thinking':
        return <div className="border-l-2 border-foreground/20 pl-2 text-xs italic text-muted-foreground whitespace-pre-wrap break-words">{block.text}</div>;
      case 'code':
      case 'math':
        return (
          <pre className={`overflow-x-auto rounded bg-foreground/[0.06] px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-words${block.t === 'math' ? ' italic' : ''}`}>
            {block.text}
          </pre>
        );
      case 'divider':
        return <hr className="border-foreground/10" />;
      case 'list':
        return (
          <div className="space-y-0.5 text-sm">
            {block.items.map((item, itemIndex) => (
              <div key={itemIndex} className="flex gap-1.5">
                <span className={`shrink-0 select-none ${item.check !== undefined ? '' : 'min-w-[1rem] text-right text-muted-foreground'}`}>
                  {item.check === 1 ? '☑' : item.check === 0 ? '☐' : item.marker}
                </span>
                <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words${item.check === 1 ? ' text-muted-foreground line-through' : ''}`}>
                  <TextWithMentions text={item.text} channel={msg?.channel} allContacts={allContacts} groupMembersList={groupMembersList} highlight={highlight} />
                </span>
              </div>
            ))}
          </div>
        );
      case 'quote':
        return (
          <div className="border-l-[3px] border-primary/60 bg-primary/[0.06] rounded-r px-2 py-1 text-sm">
            <div className="whitespace-pre-wrap break-words italic">{block.text}</div>
            {block.caption && <div className="mt-0.5 text-xs text-muted-foreground">— {block.caption}</div>}
          </div>
        );
      case 'photo': {
        const path = paths[`rich_${block.id}`];
        return (
          <div>
            <div className="relative w-full overflow-hidden rounded-md bg-foreground/[0.06]" style={{ aspectRatio: aspectOf(block) }}>
              {path ? (
                <img src={toLocalMediaUrl(path)} alt="" decoding="async" loading="lazy"
                  className="h-full w-full cursor-pointer object-cover" onClick={() => openPhoto(block.id)} />
              ) : (
                <button type="button" disabled={!canDownload || !!busy[block.id]} onClick={() => void download(block)}
                  className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                  {busy[block.id] ? 'Đang tải ảnh…' : failed[block.id] ? 'Không tải được ảnh — bấm để thử lại' : 'Đang tải ảnh…'}
                </button>
              )}
            </div>
            {caption(block.caption)}
          </div>
        );
      }
      case 'video': {
        const path = paths[`rich_${block.id}`];
        const meta = [formatDuration(block.duration), formatBytes(block.size)].filter(Boolean).join(' · ');
        return (
          <div>
            <div className="relative w-full overflow-hidden rounded-md bg-black" style={{ aspectRatio: aspectOf(block) }}>
              {path && playing[block.id] ? (
                <video src={toLocalMediaUrl(path)} controls autoPlay playsInline className="h-full w-full object-contain" />
              ) : (
                <button type="button" disabled={!!busy[block.id]}
                  onClick={async () => {
                    const local = path || (await download(block));
                    if (local) setPlaying((previous) => ({ ...previous, [block.id]: true }));
                  }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white-important">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60">
                    {busy[block.id] ? (
                      <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><polygon points="6 4 20 12 6 20 6 4" /></svg>
                    )}
                  </span>
                  <span className="rounded bg-black/55 px-1.5 py-0.5 text-[11px]">
                    {failed[block.id] ? 'Không tải được video — bấm để thử lại' : busy[block.id] ? 'Đang tải video…' : meta || 'Video'}
                  </span>
                </button>
              )}
            </div>
            {caption(block.caption)}
          </div>
        );
      }
      case 'audio':
      case 'file': {
        const path = paths[`rich_${block.id}`];
        const label = block.name || (block.t === 'audio' ? 'Âm thanh' : 'Tệp');
        if (path && block.t === 'audio') {
          return (
            <div>
              <audio src={toLocalMediaUrl(path)} controls className="w-full" />
              {caption(block.caption)}
            </div>
          );
        }
        return (
          <div>
            <button type="button" disabled={!!busy[block.id]}
              onClick={async () => {
                const local = path || (await download(block));
                if (local && block.t === 'file') void ipc.file?.openPath(local);
              }}
              className="flex w-full items-center gap-2 rounded-md bg-foreground/[0.05] px-2 py-1.5 text-left hover:bg-foreground/[0.08]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                {block.t === 'audio' ? '♪' : '📄'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{label}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {failed[block.id] ? 'Không tải được — bấm để thử lại' : busy[block.id] ? 'Đang tải…' : [formatBytes(block.size), path ? 'Bấm để mở' : 'Bấm để tải'].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
            {caption(block.caption)}
          </div>
        );
      }
      case 'table':
        return (
          <div className="overflow-x-auto">
            {block.title && <div className="mb-1 text-xs font-semibold">{block.title}</div>}
            <table className="w-full border-collapse text-xs">
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className={rowIndex === 0 ? 'font-semibold' : undefined}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="border border-foreground/15 px-1.5 py-1 align-top">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'buttons':
        return (
          <div className="flex flex-wrap gap-1">
            {block.labels.map((label, labelIndex) => (
              <span key={labelIndex} className="rounded-md bg-foreground/[0.08] px-2 py-1 text-xs font-medium">{label}</span>
            ))}
          </div>
        );
      case 'embed':
        return (
          <div className="rounded-md border border-foreground/10 px-2 py-1.5 text-xs">
            {block.url ? (
              <button type="button" className="break-all text-left text-primary hover:underline" onClick={() => window.open(block.url, '_blank')}>
                {block.url}
              </button>
            ) : <span className="text-muted-foreground">Nội dung nhúng</span>}
            {caption(block.caption)}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {blocks.map((block, index) => (
        <React.Fragment key={index}>{renderBlock(block)}</React.Fragment>
      ))}
    </div>
  );
}
