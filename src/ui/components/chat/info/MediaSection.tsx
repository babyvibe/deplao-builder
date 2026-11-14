/**
 * MediaSection - component shared by ConversationInfo (user) and GroupInfoPanel (group)
 *
 * Preview mode (inside the info panel):
 *   - Images/Videos: 3×2 grid, up to 6 images; if at or above the threshold → "Xem tất cả" (View all) button
 *   - Files / Links: list, up to 3 items; if at or above the threshold → "Xem tất cả" (View all) button
 *
 * Detail mode (replaces the whole panel, like MembersPanel):
 *   - Pagination of 50 items per page; scrolling to the end loads the next page automatically
 *
 * Employee mode (Boss connection lost): a failed page load does NOT end the list, and does not skip pages (offset counts the
 * rows received so far). Shows "Không tải được - Thử lại" (Failed to load, retry) (retries with backoff / when scrolled to the end / on reconnect);
 * the preview keeps the tiles already shown. The image viewer opens through the paged collection (MediaGalleryViewer), as in the chat frame.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useShallow } from 'zustand/react/shallow';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import DataAccessor, {
  nextConversationPaging, retryDelayMs, type ConversationPage, type ConversationPaging,
} from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import ipc from '@/lib/ipc';
import { openChatLink } from '@/lib/chat/links/chatLinks';
import { Spinner } from '@/components/common/PageLoading';
import { Button } from '@/components/ui';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { ensureMediaLocal } from '@/lib/media/employeeMediaSync';
import type { MediaViewerImage } from '../media/MediaViewer';
import MediaGalleryViewer, { type MediaGalleryViewerHandle } from '../media/MediaGalleryViewer';
import { sortGalleryChronologically } from '@/lib/chat/media/mediaGallery';
import { appendMediaPanelRows, prependMediaPanelRows, toMediaPanelPage } from '@/lib/chat/chatLoadFailures';
import { ChartIcon, EditIcon, FileTextIcon } from '@/components/common/icons';
import { getFirstAttachment, getFileMetadata, getRemoteMediaUrl, getLocalMediaPath, getVideoRemoteUrl } from '@/lib/media/mediaResolver';
import { isFacebook, isTelegram as isTelegramCh } from '@/lib/channels/channelHelper';
import { tr, appLocale } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';


const PAGE_SIZE = 50;
const PREVIEW_IMAGE = 6;
const PREVIEW_LIST  = 3;

/** Detail panel before the first page: offset 0, "may have more" (a failed page keeps these flags). */
const INITIAL_PANEL_PAGING: ConversationPaging = { nextOffset: 0, hasMore: true, exhausted: false, failures: 0, failedPage: null };
/** Right after a failed load, scrolling to the end only retries after this long (the "Thử lại" (Retry) button retries at once; backoff retries too). */
const SCROLL_RETRY_COOLDOWN_MS = 2_000;

// ─── Helper utils ─────────────────────────────────────────────────────────────

/** Extract CDN URL from FB-style attachments column — now uses MediaResolver */
function extractFBAttachment(msg: any): { url: string; name: string; type: string } | null {
  const att = getFirstAttachment(msg);
  if (!att) return null;
  const url = att.url || att.href || '';
  return url ? { url, name: att.name || '', type: att.type || msg.msg_type || 'file' } : null;
}

function extractImgUrl(msg: any): string {
  // FB: use CDN URL directly from attachments column
  const fb = extractFBAttachment(msg);
  if (fb && ['image', 'photo', 'video', 'sticker', 'animated_image'].includes(fb.type)) {
    return fb.url;
  }
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    if (msg.msg_type === 'chat.video.msg') {
      const t = lp.thumb || '';
      if (t && t !== 'undefined') return toLocalMediaUrl(t);
      try { return JSON.parse(msg.content || '{}').thumb || ''; } catch { return ''; }
    }
    const p = lp.main || lp.hd || lp.thumb || '';
    if (p && p !== 'undefined') return toLocalMediaUrl(p);
  } catch {}
  try {
    const c = JSON.parse(msg.content || '{}');
    return c.params?.hd || c.params?.rawUrl || c.href || c.thumb || '';
  } catch { return ''; }
}

function extractLocalFilePath(msg: any): string {
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    return lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
  } catch { return ''; }
}

function extractVideoFilePath(msg: any): string {
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    return lp.file || lp.video || '';
  } catch { return ''; }
}

function extractVideoRemoteUrl(msg: any): string {
  try { return JSON.parse(msg.content || '{}').href || ''; } catch { return ''; }
}

/**
 * Build a list of MediaViewerImage from non-video messages for the in-app viewer.
 * The panel lists media newest-first; the viewer shows them like Zalo: oldest → newest (newest last).
 */
function buildViewerImages(msgs: any[]): MediaViewerImage[] {
  return sortGalleryChronologically(buildViewerImagesNewestFirst(msgs).reverse());
}

function buildViewerImagesNewestFirst(msgs: any[]): MediaViewerImage[] {
  return msgs
    .filter(msg => msg.msg_type !== 'chat.video.msg' && msg.msg_type !== 'video')
    .map(msg => {
      // FB: use CDN URL directly
      const fb = extractFBAttachment(msg);
      if (fb && ['image', 'photo', 'sticker', 'animated_image'].includes(fb.type)) {
        return { src: fb.url, displaySrc: fb.url, defaultName: fb.name || `image_${msg?.msg_id || Date.now()}.jpg`, msgId: msg?.msg_id ? String(msg.msg_id) : undefined, threadId: msg?.thread_id ? String(msg.thread_id) : undefined, timestamp: Number(msg?.timestamp) || undefined };
      }
      const displaySrc = extractImgUrl(msg); // local-media:// or remote URL
      const localPath = extractLocalFilePath(msg);
      let remoteSrc = '';
      try {
        const c = JSON.parse(msg.content || '{}');
        const params = typeof c.params === 'string' ? JSON.parse(c.params || '{}') : (c.params || {});
        remoteSrc = params.hd || params.rawUrl || c.href || '';
      } catch {}
      const src = remoteSrc || displaySrc;
      const ds = displaySrc || remoteSrc;
      return {
        src,
        displaySrc: ds,
        fallbackSrc: remoteSrc || undefined,  // Zalo CDN as fallback
        localPath,
        defaultName: localPath ? localPath.replace(/.*[/\\]/, '') : `image_${msg?.msg_id || Date.now()}.jpg`,
        msgId: msg?.msg_id ? String(msg.msg_id) : undefined,
        threadId: msg?.thread_id ? String(msg.thread_id) : undefined,
        timestamp: Number(msg?.timestamp) || undefined,
      };
    })
    .filter(img => img.src || img.displaySrc);
}

/** DB row → gallery tile (null = video / cannot be displayed). Module-level function: a stable reference for buildEntry. */
function buildViewerEntry(msg: any): MediaViewerImage | null {
  return buildViewerImagesNewestFirst([msg])[0] ?? null;
}

/** One page of the tab (offset, newest → oldest). */
function fetchMediaPanelPage(t: Tab, params: { zaloId: string; threadId: string; limit: number; offset: number }): Promise<any> {
  if (t === 'image') return DataAccessor.getMediaMessages(params);
  if (t === 'file') return DataAccessor.getFileMessages(params);
  return DataAccessor.getLinks(params);
}

export function getFileIcon(ext: string): string {
  const e = (ext || '').toLowerCase();
  if (['pdf'].includes(e)) return 'PDF:';
  if (['doc', 'docx'].includes(e)) return 'Document:';
  if (['xls', 'xlsx', 'csv'].includes(e)) return 'Sheet:';
  if (['ppt', 'pptx'].includes(e)) return 'Slide:';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return 'Archive:';
  if (['mp4', 'avi', 'mov', 'mkv'].includes(e)) return 'Video:';
  if (['mp3', 'wav', 'ogg'].includes(e)) return 'Audio:';
  return 'File:';
}

export function formatFileSize(bytes: string | number): string {
  const n = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (!n || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Tab = 'image' | 'file' | 'link';
const TAB_LABELS: Record<Tab, string> = { image: tr('Ảnh/Video'), file: 'File', link: 'Link' };

export type { Tab as MediaTab };
export { MediaDetailPanel };

// ─── Main exported component ──────────────────────────────────────────────────
export default function MediaSection({ threadId, onOpenDetail }: {
  threadId: string;
  onOpenDetail?: (tab: Tab) => void;
}) {
  const { activeAccountId } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId,
  })));
  const [tab, setTab] = useState<Tab>('image');
  const [detailTab, setDetailTab] = useState<Tab | null>(null);
  const galleryRef = useRef<MediaGalleryViewerHandle>(null);

  const [previewImages, setPreviewImages] = useState<any[]>([]);
  const [previewFiles,  setPreviewFiles]  = useState<any[]>([]);
  const [previewLinks,  setPreviewLinks]  = useState<any[]>([]);
  // Tab waiting for its preview to load (the spinner only shows on that tab; the newest load of the new tab can cancel it)
  const [previewLoadingTab, setPreviewLoadingTab] = useState<Tab | null>(null);
  // Tab whose latest preview load failed (employee mode: Boss connection lost): keep the tiles already shown + "Thử lại" (Retry)
  const [previewFailed, setPreviewFailed] = useState<Partial<Record<Tab, boolean>>>({});
  // Conversation shown + the latest load of each tab: drop late replies for an older conversation / load
  const previewOwnerRef = useRef('');
  previewOwnerRef.current = `${activeAccountId || ''}:${threadId}`;
  const previewSeqRef = useRef<Record<Tab, number>>({ image: 0, file: 0, link: 0 });

  // Reset when the thread changes
  useEffect(() => {
    setDetailTab(null);
    setPreviewImages([]);
    setPreviewFiles([]);
    setPreviewLinks([]);
    setPreviewFailed({});
    setPreviewLoadingTab(null);
  }, [threadId, activeAccountId]);

  /**
   * Load the preview for tab `t`. On error → KEEP the tiles already there (do not replace them with "Chưa có …" (None yet)), mark the error so "Thử lại" (Retry) shows.
   * `silent`: background reload (Boss connection restored): do not replace the grid with a spinner.
   */
  const loadPreview = useCallback(async (t: Tab, opts: { silent?: boolean } = {}) => {
    if (!activeAccountId || !threadId) return;
    const owner = `${activeAccountId}:${threadId}`;
    const seq = ++previewSeqRef.current[t];
    if (!opts.silent) setPreviewLoadingTab(t);
    const limit = (t === 'image' ? PREVIEW_IMAGE : PREVIEW_LIST) + 1;
    let res: any = null;
    try {
      res = await fetchMediaPanelPage(t, { zaloId: activeAccountId, threadId, limit, offset: 0 });
    } catch (err) {
      console.warn('[MediaSection] preview load failed:', err);
    }
    if (previewOwnerRef.current !== owner || previewSeqRef.current[t] !== seq) return; // conversation changed / a newer load exists
    const page = toMediaPanelPage(t, res, limit);
    if (page.success) {
      if (t === 'image') setPreviewImages(page.items);
      else if (t === 'file') setPreviewFiles(page.items);
      else setPreviewLinks(page.items);
    }
    setPreviewFailed(prev => (!!prev[t] === !page.success ? prev : { ...prev, [t]: !page.success }));
    setPreviewLoadingTab(cur => (cur === t ? null : cur));
  }, [activeAccountId, threadId]);

  // Load the preview when the tab changes
  useEffect(() => {
    if (!activeAccountId || !threadId || detailTab !== null) return;
    loadPreview(tab);
  }, [tab, threadId, activeAccountId, detailTab]);

  // Employee mode: Boss connection restored → refresh the preview of the open tab (in the background, keeping the grid on screen)
  useEmployeeResync(() => {
    if (detailTab !== null || !activeAccountId || !threadId) return;
    return loadPreview(tab, { silent: true });
  });

  const retryPreview = useCallback(() => { void loadPreview(tab); }, [loadPreview, tab]);

  // ── Detail view takes over the whole panel ──────────────────────────────────────
  if (detailTab !== null && !onOpenDetail) {
    return (
      <MediaDetailPanel
        threadId={threadId}
        activeAccountId={activeAccountId!}
        tab={detailTab}
        onBack={() => {
          setDetailTab(null);
          loadPreview(tab);
        }}
      />
    );
  }

  // ── Preview (inside the normal info panel) ─────────────────────────────────────
  // Filter out ghost rows (no displayable URL and no action target) before
  // slicing so they don't silently consume grid slots or skew hasMore.
  const displayableImages = previewImages.filter(msg => {
    const isVid = msg.msg_type === 'chat.video.msg' || msg.msg_type === 'video';
    const url = extractImgUrl(msg);
    const fbAtt = extractFBAttachment(msg);
    const localFile = isVid ? extractVideoFilePath(msg) : extractLocalFilePath(msg);
    const remoteVid = isVid ? (fbAtt?.url || extractVideoRemoteUrl(msg)) : '';
    return url || localFile || (isVid && remoteVid) || fbAtt?.url;
  });
  const images       = displayableImages.slice(0, PREVIEW_IMAGE);
  const hasMoreImages = displayableImages.length > PREVIEW_IMAGE;
  const files        = previewFiles.slice(0, PREVIEW_LIST);
  const hasMoreFiles  = previewFiles.length > PREVIEW_LIST;
  const links        = previewLinks.slice(0, PREVIEW_LIST);
  const hasMoreLinks  = previewLinks.length > PREVIEW_LIST;
  const previewFailedNow = !!previewFailed[tab];

  // Build viewer images list (non-video only) from current preview batch
  const previewViewerImages = buildViewerImages(images);

  const openDetail = (t: Tab) => {
    if (onOpenDetail) {
      onOpenDetail(t);
    } else {
      setDetailTab(t);
    }
  };

  return (
    <div className="border-t border-border">
      {/* Tab bar */}
      <div className="flex border-b border-border">
        {(['image', 'file', 'link'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              tab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-muted-foreground hover:text-foreground/80'
            }`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="p-2">
        {previewLoadingTab === tab ? (
          <div className="flex justify-center py-6">
            <Spinner size={4} />
          </div>
        ) : tab === 'image' ? (
          images.length === 0
            ? (previewFailedNow ? <LoadFailedRow onRetry={retryPreview} /> : <EmptyState label={tr('ảnh/video')} />)
            : <>
                <div className="grid grid-cols-3 gap-1">
                  {images.map((msg, i) => {
                    const isVid = msg.msg_type === 'chat.video.msg';
                    if (isVid) return <ImageThumb key={i} msg={msg} />;
                    // Compute viewer index within non-video images
                    const viewerIdx = previewViewerImages.findIndex(vi => {
                      const ds = extractImgUrl(msg);
                      return vi.displaySrc === ds || vi.src === ds;
                    });
                    return (
                      <ImageThumb key={i} msg={msg}
                        onClickImage={() => galleryRef.current?.open(previewViewerImages, viewerIdx >= 0 ? viewerIdx : 0)}
                      />
                    );
                  })}
                </div>
                {previewFailedNow && <LoadFailedRow text={tr('Không tải được ảnh/video mới nhất')} onRetry={retryPreview} />}
                {hasMoreImages && <ViewAllBtn onClick={() => openDetail('image')} />}
              </>
        ) : tab === 'file' ? (
          files.length === 0
            ? (previewFailedNow ? <LoadFailedRow onRetry={retryPreview} /> : <EmptyState label={tr('file đính kèm')} />)
            : <>
                <div className="space-y-0.5">
                  {files.map((msg, i) => <FileRow key={i} msg={msg} />)}
                </div>
                {previewFailedNow && <LoadFailedRow text={tr('Không tải được file mới nhất')} onRetry={retryPreview} />}
                {hasMoreFiles && <ViewAllBtn onClick={() => openDetail('file')} />}
              </>
        ) : (
          links.length === 0
            ? (previewFailedNow ? <LoadFailedRow onRetry={retryPreview} /> : <EmptyState label={tr('link')} />)
            : <>
                <div className="space-y-0.5">
                  {links.map((link, i) => <LinkRow key={i} link={link} />)}
                </div>
                {previewFailedNow && <LoadFailedRow text={tr('Không tải được link mới nhất')} onRetry={retryPreview} />}
                {hasMoreLinks && <ViewAllBtn onClick={() => openDetail('link')} />}
              </>
        )}
      </div>

      {/* In-app image viewer: a paged collection like the chat frame (load older / newer images around the one clicked) */}
      <MediaGalleryViewer
        ref={galleryRef}
        accountId={activeAccountId}
        threadId={threadId}
        buildEntry={buildViewerEntry}
      />
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ label }: { label: string }) {
  return <p className="text-xs text-muted-foreground text-center py-6">{trx('Chưa có {{label}}', { label })}</p>;
}

// ─── Load error (employee mode: Boss connection lost) ─────────────────────────────
/** Compact notice right in the list + "Thử lại" (Retry): a network error must not look like "Chưa có …" (None yet). */
function LoadFailedRow({ text = tr('Không tải được'), onRetry }: { text?: string; onRetry: () => void }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span>{text}</span>
      <Button variant="link" size="sm" className="text-xs" onClick={() => onRetry()}>{tr('Thử lại')}</Button>
    </div>
  );
}

// ─── "Xem tất cả" (View all) button ──────────────────────────────────────────────────────
function ViewAllBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full mt-2 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-muted hover:bg-accent text-foreground/80 text-xs font-medium transition-colors">
      {tr('Xem tất cả')}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );
}

// ─── Date grouping helpers (Zalo style) ──────────────────────────────────────
const MONTH_VI = [
  tr('Tháng 1'),tr('Tháng 2'),tr('Tháng 3'),tr('Tháng 4'),tr('Tháng 5'),tr('Tháng 6'),
  tr('Tháng 7'),tr('Tháng 8'),tr('Tháng 9'),tr('Tháng 10'),tr('Tháng 11'),tr('Tháng 12'),
];

function getDateGroupLabel(timestamp: number): string {
  const d   = new Date(timestamp);
  const now = new Date();
  const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const itemDay   = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (itemDay.getTime() === today.getTime())     return tr('Hôm nay');
  if (itemDay.getTime() === yesterday.getTime()) return tr('Hôm qua');
  if (d.getFullYear() === now.getFullYear())     return MONTH_VI[d.getMonth()];
  return `${MONTH_VI[d.getMonth()]}, ${d.getFullYear()}`;
}

function groupByDateLabel(items: any[]): Array<{ label: string; items: any[] }> {
  const groups: Array<{ label: string; items: any[] }> = [];
  const seen = new Map<string, number>();
  for (const item of items) {
    const label = getDateGroupLabel(item.timestamp ?? 0);
    if (seen.has(label)) {
      groups[seen.get(label)!].items.push(item);
    } else {
      seen.set(label, groups.length);
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}

// ─── Detail panel: replaces the whole panel (like MembersPanel) ──────────────
function MediaDetailPanel({ threadId, activeAccountId, tab, onBack }: {
  threadId: string;
  activeAccountId: string;
  tab: Tab;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>(tab);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // Paging counts rows RECEIVED (offset), not pages attempted: a failed page keeps the offset + hasMore so it retries
  // that same page (before, a failed page set hasMore false and the list stopped for good; or the next page skipped over the failed one).
  const [paging, setPaging] = useState<ConversationPaging>(INITIAL_PANEL_PAGING);
  const hasMore = paging.hasMore;
  const galleryRef = useRef<MediaGalleryViewerHandle>(null);
  const pagingRef  = useRef<ConversationPaging>(INITIAL_PANEL_PAGING);
  const itemsRef   = useRef<any[]>(items);
  itemsRef.current = items;
  const activeTabRef = useRef<Tab>(activeTab);
  activeTabRef.current = activeTab;
  const loadingRef = useRef(false);
  const generationRef = useRef(0); // tab / conversation changed → drop the response of the previous load
  const lastFailureAtRef = useRef(0);
  const bottomRef  = useRef<HTMLDivElement>(null);

  const applyPaging = useCallback((next: ConversationPaging) => {
    pagingRef.current = next;
    setPaging(next);
  }, []);

  /**
   * First page ('first': replaces the list) or next page ('more': offset = rows received so far).
   * On error → keep the list + hasMore, count the error: backoff / scroll to the end / "Thử lại" (Retry) / reconnect retries that same page.
   */
  const loadPage = useCallback(async (t: Tab, kind: ConversationPage) => {
    if (!activeAccountId || !threadId || loadingRef.current) return;
    const generation = generationRef.current;
    const offset = kind === 'first' ? 0 : pagingRef.current.nextOffset;
    loadingRef.current = true;
    setLoading(true);
    let res: any = null;
    try {
      res = await fetchMediaPanelPage(t, { zaloId: activeAccountId, threadId, limit: PAGE_SIZE, offset });
    } catch (err) {
      console.warn('[MediaSection] page load failed:', err);
    }
    if (generation !== generationRef.current) return; // tab / conversation changed: the new load is holding the loading flag
    loadingRef.current = false;
    setLoading(false);
    const page = toMediaPanelPage(t, res, PAGE_SIZE);
    if (page.success) {
      setItems(prev => (kind === 'first' ? page.items : appendMediaPanelRows(t, prev, page.items)));
    } else {
      lastFailureAtRef.current = Date.now();
      console.warn(`[MediaSection] Không tải được ${TAB_LABELS[t]} (offset ${offset}): ${page.error || 'không rõ lỗi'}`);
    }
    applyPaging(nextConversationPaging(pagingRef.current, page, kind));
  }, [activeAccountId, threadId, applyPaging]);

  /** Connection restored, list still fine: add new media (received while disconnected) to the top, keep what is loaded + the scroll position. */
  const refreshNewest = useCallback(async (t: Tab) => {
    if (!activeAccountId || !threadId || loadingRef.current) return;
    const generation = generationRef.current;
    loadingRef.current = true;
    let res: any = null;
    try {
      res = await fetchMediaPanelPage(t, { zaloId: activeAccountId, threadId, limit: PAGE_SIZE, offset: 0 });
    } catch (err) {
      console.warn('[MediaSection] refresh failed:', err);
    }
    if (generation !== generationRef.current) return;
    loadingRef.current = false;
    const page = toMediaPanelPage(t, res, PAGE_SIZE);
    if (!page.success) return; // on error: keep the list unchanged
    const merged = prependMediaPanelRows(t, itemsRef.current, page.items, PAGE_SIZE);
    if (merged.gap) {
      // Everything on the page is new → can skip rows between this page and the old list: restart from the page just received
      setItems(page.items);
      applyPaging(nextConversationPaging(INITIAL_PANEL_PAGING, page, 'first'));
      return;
    }
    if (merged.added === 0) return;
    setItems(merged.items);
    applyPaging({ ...pagingRef.current, nextOffset: pagingRef.current.nextOffset + merged.added });
  }, [activeAccountId, threadId, applyPaging]);

  // Reload from the start when the tab / conversation changes
  useEffect(() => {
    generationRef.current += 1;
    loadingRef.current = false;
    lastFailureAtRef.current = 0;
    setItems([]);
    setLoading(false);
    applyPaging(INITIAL_PANEL_PAGING);
    void loadPage(activeTab, 'first');
  }, [activeTab, activeAccountId, threadId]);

  /** Retry the page that just failed ("Thử lại" (Retry) button, backoff, reconnect). Empty list → reload the first page. */
  const retryFailedPage = useCallback((): Promise<void> => {
    const kind: ConversationPage = pagingRef.current.failedPage === 'first' || itemsRef.current.length === 0 ? 'first' : 'more';
    return loadPage(activeTabRef.current, kind);
  }, [loadPage]);

  // Auto-retry the failed page: 2 s → 4 → 8 → 16 → 30 s (5 times); after that wait for scroll / "Thử lại" (Retry) / reconnect
  useEffect(() => {
    if (paging.failures === 0) return;
    const delay = retryDelayMs(paging.failures);
    if (delay == null) return;
    const timer = setTimeout(() => { void retryFailedPage(); }, delay);
    return () => clearTimeout(timer);
  }, [paging.failures, retryFailedPage]);

  // Employee mode: Boss connection restored → retry the failed page / reload an empty list, or add new media to the top
  useEmployeeResync(() => {
    if (pagingRef.current.failedPage || itemsRef.current.length === 0) return retryFailedPage();
    return refreshNewest(activeTabRef.current);
  });

  // Infinite scroll sentinel (also retries a failed page; right after a failure it waits ≥ 2 s so back-and-forth scrolling does not fire requests nonstop)
  useEffect(() => {
    const el = bottomRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting || loadingRef.current) return;
      const p = pagingRef.current;
      if (!p.hasMore) return;
      if (p.failures > 0 && Date.now() - lastFailureAtRef.current < SCROLL_RETRY_COOLDOWN_MS) return;
      void loadPage(activeTabRef.current, p.failedPage === 'first' ? 'first' : 'more');
    }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadPage, activeTab]);

  const firstLoadFailed = items.length === 0 && paging.failures > 0;

  return (
    <div className="w-72 h-full flex-shrink-0 bg-card border-l border-border flex flex-col overflow-hidden">
      {/* Header, same as MembersPanel */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
        <button onClick={onBack}
          className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span className="text-sm font-semibold text-foreground flex-1 text-center pr-6">{TAB_LABELS[activeTab]}</span>
      </div>

      {/* Sub-tab bar */}
      <div className="flex border-b border-border flex-shrink-0">
        {(['image', 'file', 'link'] as Tab[]).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              activeTab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-muted-foreground hover:text-foreground/80'
            }`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Count label */}
      <div className="px-4 py-2 flex-shrink-0">
        <span className="text-xs text-muted-foreground font-medium">
          {loading && items.length === 0
            ? tr('Đang tải...')
            : firstLoadFailed
              ? tr('Không tải được')
            : activeTab === 'image'
              ? tr('{{count}} ảnh/video{{v1}}', { count: items.length, v1: hasMore ? '+' : '' })
              : `${items.length} ${TAB_LABELS[activeTab].toLowerCase()}${hasMore ? '+' : ''}`
          }
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Image grid - grouped by date */}
        {activeTab === 'image' && (() => {
          const displayableItems = items.filter(msg => {
            const isVid = msg.msg_type === 'chat.video.msg' || msg.msg_type === 'video';
            const url = extractImgUrl(msg);
            const fbAtt = extractFBAttachment(msg);
            const localFile = isVid ? extractVideoFilePath(msg) : extractLocalFilePath(msg);
            const remoteVid = isVid ? (fbAtt?.url || extractVideoRemoteUrl(msg)) : '';
            return url || localFile || (isVid && remoteVid) || fbAtt?.url;
          });
          // Build flat viewer image list from all non-video items for navigation
          const allViewerImages = buildViewerImages(displayableItems);
          return (
            <div className="px-2 pb-2">
              {displayableItems.length === 0 && !loading ? (
                firstLoadFailed
                  ? <LoadFailedRow onRetry={retryFailedPage} />
                  : <p className="text-xs text-muted-foreground text-center py-8">{tr('Chưa có ảnh/video')}</p>
              ) : (
                groupByDateLabel(displayableItems).map(group => (
                  <div key={group.label} className="mb-3">
                    {/* Date header */}
                    <div className="flex items-center gap-2 py-1.5 sticky top-0 bg-card z-10">
                      <span className="text-[11px] font-semibold text-muted-foreground whitespace-nowrap">
                        {group.label}
                      </span>
                      <div className="flex-1 h-px bg-muted" />
                    </div>
                    {/* Grid for this date group */}
                    <div className="grid grid-cols-3 gap-1">
                      {group.items.map((msg, i) => {
                        const isVid = msg.msg_type === 'chat.video.msg';
                        if (isVid) return <ImageThumb key={i} msg={msg} />;
                        const ds = extractImgUrl(msg);
                        const viewerIdx = allViewerImages.findIndex(vi => vi.displaySrc === ds || vi.src === ds);
                        return (
                          <ImageThumb key={i} msg={msg}
                            onClickImage={() => galleryRef.current?.open(allViewerImages, viewerIdx >= 0 ? viewerIdx : 0)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          );
        })()}

        {/* File list */}
        {activeTab === 'file' && (
          items.length === 0 && !loading
            ? (firstLoadFailed
                ? <LoadFailedRow onRetry={retryFailedPage} />
                : <p className="text-xs text-muted-foreground text-center py-8">{tr('Chưa có file đính kèm')}</p>)
            : items.map((msg, i) => <FileRow key={i} msg={msg} />)
        )}

        {/* Link list */}
        {activeTab === 'link' && (
          items.length === 0 && !loading
            ? (firstLoadFailed
                ? <LoadFailedRow onRetry={retryFailedPage} />
                : <p className="text-xs text-muted-foreground text-center py-8">{tr('Chưa có link')}</p>)
            : items.map((link, i) => <LinkRow key={i} link={link} />)
        )}

        {/* Sentinel + loading indicator */}
        <div ref={bottomRef} className="h-2" />
        {loading && (
          <div className="flex justify-center py-4">
            <Spinner size={4} />
          </div>
        )}
        {/* Next page failed to load: keep the list + hasMore, show a compact notice (below the sentinel, so it appears without moving the sentinel) */}
        {!loading && paging.failures > 0 && items.length > 0 && (
          <LoadFailedRow text={tr('Không tải được thêm')} onRetry={retryFailedPage} />
        )}
        {!hasMore && items.length > 0 && (
          <p className="text-[11px] text-muted-foreground text-center py-3">{tr('Đã hiển thị tất cả')}</p>
        )}
      </div>

      {/* In-app image viewer: paged collection like the chat frame */}
      <MediaGalleryViewer
        ref={galleryRef}
        accountId={activeAccountId}
        threadId={threadId}
        buildEntry={buildViewerEntry}
      />
    </div>
  );
}

// ─── Image thumbnail cell ─────────────────────────────────────────────────────
function ImageThumb({ msg, onClickImage }: { msg: any; onClickImage?: () => void }) {
  const isFB = isFacebook(msg.channel);
  const isVideo = msg.msg_type === 'chat.video.msg' || msg.msg_type === 'video';
  const url = extractImgUrl(msg);
  const localFilePath = isVideo ? extractVideoFilePath(msg) : extractLocalFilePath(msg);
  const remoteVideoUrl = isVideo ? (isFB ? (getRemoteMediaUrl(msg) || extractFBAttachment(msg)?.url || '') : extractVideoRemoteUrl(msg)) : '';

  // For FB videos, CDN URL is the remote video URL
  const fbAtt = isFB ? extractFBAttachment(msg) : null;

  const handleClick = async () => {
    if (isVideo) {
      const mode = useEmployeeStore.getState().mode;
      if (mode === 'employee') {
        // Employee: download the video from the Boss → local cache → open
        if (localFilePath) {
          const bossUrl = toLocalMediaUrl(localFilePath);
          if (bossUrl) {
            const { localPath } = await ensureMediaLocal(bossUrl, 'video');
            if (localPath) {
              await ipc.file?.openPath(localPath);
              return;
            }
          }
        }
        // Fallback: try remote CDN URL
        if (remoteVideoUrl) { ipc.shell?.openExternal(remoteVideoUrl); return; }
        if (fbAtt?.url) { ipc.shell?.openExternal(fbAtt.url); return; }
        return;
      }
      // Boss/standalone
      if (localFilePath) {
        ipc.file?.openPath(localFilePath);
      } else if (remoteVideoUrl) ipc.shell?.openExternal(remoteVideoUrl);
      else if (fbAtt?.url) ipc.shell?.openExternal(fbAtt.url);
    } else if (onClickImage) {
      onClickImage();
    } else {
      const mode = useEmployeeStore.getState().mode;
      if (mode === 'employee' && localFilePath) {
        // Employee: download the image first → open
        const bossUrl = toLocalMediaUrl(localFilePath);
        if (bossUrl) {
          const { localPath } = await ensureMediaLocal(bossUrl, 'image');
          if (localPath) {
            await ipc.file?.openPath(localPath);
            return;
          }
        }
      }
      if (localFilePath) ipc.file?.openPath(localFilePath);
      else if (url) ipc.shell?.openExternal(url);
    }
  };

  // Return null if there is nothing to display AND nothing to open
  if (!url && !localFilePath && (!isVideo || (!remoteVideoUrl && !fbAtt?.url))) return null;

  return (
    <div className="relative group/img cursor-pointer" onClick={handleClick}>
      {url ? (
        <img src={url} alt=""
          className="w-full aspect-square object-cover rounded hover:opacity-80 transition-opacity bg-card"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      ) : (
        <div className="w-full aspect-square rounded bg-card hover:bg-muted transition-colors" />
      )}
      {isVideo && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-8 h-8 bg-black/60 rounded-full flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
        </div>
      )}
      {/* FB: download button (open CDN URL) */}
      {isFB && url && (
        <button
          onClick={e => { e.stopPropagation(); ipc.shell?.openExternal(url); }}
          title={tr('Tải về')}
          className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 rounded flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      )}
      {/* Zalo: folder button for local files */}
      {!isFB && localFilePath && (
        <button
          onClick={async e => {
            e.stopPropagation();
            const mode = useEmployeeStore.getState().mode;
            if (mode === 'employee') {
              // Employee: download first → show in folder
              const bossUrl = toLocalMediaUrl(localFilePath);
              if (bossUrl) {
                const { localPath } = await ensureMediaLocal(bossUrl, isVideo ? 'video' : 'image');
                if (localPath) { ipc.file?.showItemInFolder(localPath); return; }
              }
            }
            ipc.file?.showItemInFolder(localFilePath);
          }}
          title={tr('Mở thư mục')}
          className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 rounded flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── File row ─────────────────────────────────────────────────────────────────
function FileRow({ msg }: { msg: any }) {
  const isFB = isFacebook(msg.channel);
  const isTelegram = isTelegramCh(msg.channel);
  const isNonZalo = isFB || isTelegram;
  let title = 'File', sizeStr = '', ext = '', localPath = '', href = '';

  if (isNonZalo) {
    // FB/Telegram: extract from attachments via MediaResolver
    const meta = getFileMetadata(msg);
    title = meta.title || msg.content || 'File';
    href  = meta.href || '';
    ext   = meta.ext || title.split('.').pop() || '';
    if (meta.fileSize) sizeStr = formatFileSize(meta.fileSize);
    localPath = getLocalMediaPath(msg, 'file');
  } else {
    try {
      const p = JSON.parse(msg.content || '{}');
      title = p.title || 'File';
      href  = p.href  || '';
      const params = typeof p.params === 'string' ? JSON.parse(p.params || '{}') : (p.params || {});
      sizeStr = params.fileSize ? formatFileSize(params.fileSize) : '';
      ext = params.fileExt || title.split('.').pop() || '';
    } catch {}
    try {
      const lp = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      localPath = lp.file || lp.main || '';
    } catch {}
  }

  const dateStr = new Date(msg.timestamp).toLocaleDateString(appLocale(), { day: '2-digit', month: '2-digit', year: '2-digit' });

  return (
    <div className="flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors group/file">
      <button
        onClick={async () => {
          const mode = useEmployeeStore.getState().mode;
          if (mode === 'employee' && localPath) {
            // Employee: download the file from the Boss → local → open
            const bossUrl = toLocalMediaUrl(localPath);
            if (bossUrl) {
              const { localPath: cachedPath } = await ensureMediaLocal(bossUrl, 'file');
              if (cachedPath) { await ipc.file?.openPath(cachedPath); return; }
            }
          }
          if (localPath) ipc.file?.openPath(localPath);
          else if (href) ipc.shell?.openExternal(href);
        }}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
      >
        <span className="text-xl flex-shrink-0">{getFileIcon(ext)}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground truncate font-medium">{title}</p>
          <p className="text-[11px] text-muted-foreground">{sizeStr && `${sizeStr} · `}{dateStr}</p>
        </div>
      </button>
      {/* FB: download button pointing to CDN */}
      {isFB && href && (
        <button
          onClick={() => ipc.shell?.openExternal(href)}
          title={tr('Tải về')}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent opacity-0 group-hover/file:opacity-100 transition-all flex-shrink-0"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      )}
      {/* Zalo: open folder button */}
      {!isFB && localPath && (
        <button
          onClick={async () => {
            const mode = useEmployeeStore.getState().mode;
            if (mode === 'employee') {
              const bossUrl = toLocalMediaUrl(localPath);
              if (bossUrl) {
                const { localPath: cachedPath } = await ensureMediaLocal(bossUrl, 'file');
                if (cachedPath) { ipc.file?.showItemInFolder(cachedPath); return; }
              }
            }
            ipc.file?.showItemInFolder(localPath);
          }}
          title={tr('Mở thư mục')}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent opacity-0 group-hover/file:opacity-100 transition-all flex-shrink-0"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── Link row ────────��────────────────────────────────────────────────────────
function LinkRow({ link }: { link: any }) {
  const dateStr = new Date(link.timestamp).toLocaleDateString(appLocale(), { day: '2-digit', month: '2-digit', year: '2-digit' });
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 hover:bg-muted transition-colors group/link cursor-pointer"
      onClick={() => link.url && openChatLink(link.url)}
      title={link.url}
    >
      {/* Thumbnail */}
      <div className="w-9 h-9 rounded-lg flex-shrink-0 overflow-hidden bg-muted flex items-center justify-center border border-input/50">
        {link.thumb_url ? (
          <img src={link.thumb_url} alt="" className="w-full h-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
          </svg>
        )}
      </div>
      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate font-medium">{link.title || link.url}</p>
        <p className="text-[11px] text-muted-foreground truncate">{link.domain || link.url}</p>
        <p className="text-[11px] text-muted-foreground">{dateStr}</p>
      </div>
      {/* External icon */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        className="flex-shrink-0 text-muted-foreground group-hover/link:text-muted-foreground transition-colors">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </div>
  );
}
