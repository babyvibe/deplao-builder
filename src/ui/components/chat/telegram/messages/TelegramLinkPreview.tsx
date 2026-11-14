import React from 'react';
import { openChatLink } from '@/lib/chat/links/chatLinks';
import { requestTelegramPreviewRefresh } from '@/lib/chat/telegram/telegramPreviewRefresh';

/**
 * When shown: if the stored record is still missing card info (only the site name, or a video link without a card), ask Telegram to fill it in,
 * batched; see lib/chat/telegram/telegramPreviewRefresh. Draws nothing.
 */
export function TelegramPreviewRefresh({ msg }: { msg: any }) {
  const attachments = typeof msg?.attachments === 'string' ? msg.attachments : JSON.stringify(msg?.attachments || []);
  React.useEffect(() => {
    requestTelegramPreviewRefresh(msg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg?.msg_id, msg?.thread_id, msg?.content, attachments]);
  return null;
}

/**
 * Telegram link preview card (MessageMediaWebPage), like the Telegram app: colored bar on the left, site name, title, description,
 * the site's image / video inside the card. Data is in the media attachment with `source: 'webpage'` (link message with image / video) or an
 * attachment `webpage` (link-only message), see telegramMediaMeta.ts in main.
 */
export interface TelegramWebpageMeta {
  url: string;
  siteName: string;
  title: string;
  description: string;
}

export function getTelegramWebpageMeta(msg: any): TelegramWebpageMeta | null {
  let attachments: any[] = [];
  try {
    const parsed = typeof msg?.attachments === 'string' ? JSON.parse(msg.attachments || '[]') : (msg?.attachments || []);
    attachments = Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
  const item = attachments.find((attachment) => attachment?.source === 'webpage')
    || attachments.find((attachment) => attachment?.type === 'webpage');
  if (!item) return null;
  const meta: TelegramWebpageMeta = {
    url: String(item.page_url || (item.type === 'webpage' ? item.url : '') || ''),
    siteName: String(item.site_name || '').trim(),
    title: String(item.title || '').trim(),
    description: String(item.description || '').trim(),
  };
  return meta.siteName || meta.title || meta.description ? meta : null;
}

export function TelegramLinkPreviewCard({ meta, hideTitle = false, children, className = '' }: {
  meta: TelegramWebpageMeta;
  /** Link-only message whose stored content is the page title → do not repeat the title in the card. */
  hideTitle?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  const open = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (!meta.url) return;
    event.stopPropagation();
    openChatLink(meta.url);
  };
  const showTitle = !!meta.title && !hideTitle;
  return (
    <div className={`flex min-w-0 overflow-hidden rounded-lg bg-primary/10 ${className}`}>
      <div className="w-[3px] flex-shrink-0 bg-primary" aria-hidden />
      <div className="min-w-0 flex-1 py-1.5 pl-2 pr-2">
        {(meta.siteName || showTitle || meta.description) && (
          <div
            role={meta.url ? 'link' : undefined}
            tabIndex={meta.url ? 0 : undefined}
            onClick={open}
            onKeyDown={(event) => { if (event.key === 'Enter') open(event); }}
            title={meta.url || undefined}
            className={`text-[13px] leading-snug break-words ${meta.url ? 'cursor-pointer' : ''}`}
          >
            {meta.siteName && <div className="truncate font-semibold text-primary">{meta.siteName}</div>}
            {showTitle && <div className="line-clamp-2 font-semibold text-foreground">{meta.title}</div>}
            {meta.description && <div className="line-clamp-6 whitespace-pre-line text-foreground/85">{meta.description}</div>}
          </div>
        )}
        {children && <div className="mt-1.5 overflow-hidden rounded-md">{children}</div>}
      </div>
    </div>
  );
}
