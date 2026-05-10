/**
 * MediaSection — component dùng chung cho ConversationInfo (user) và GroupInfoPanel (nhóm)
 *
 * Chế độ preview (nằm trong panel info):
 *   - Ảnh/Video: grid 3×2, tối đa 6 ảnh, nếu ≥ ngưỡng → nút "Xem tất cả"
 *   - File / Link: list, tối đa 3 item, nếu ≥ ngưỡng → nút "Xem tất cả"
 *
 * Chế độ detail (thay thế toàn bộ panel — giống MembersPanel):
 *   - Pagination 50 item/trang, scroll đến cuối → tự load trang tiếp
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAccountStore } from '@/store/accountStore';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import MediaViewer, { MediaViewerImage } from './MediaViewer';

const PAGE_SIZE = 50;
const PREVIEW_IMAGE = 6;
const PREVIEW_LIST  = 3;

// ─── Helper utils ─────────────────────────────────────────────────────────────

/** Extract CDN URL from FB-style attachments column */
function extractFBAttachment(msg: any): { url: string; name: string; type: string } | null {
  if (msg.channel !== 'facebook') return null;
  try {
    const atts = JSON.parse(msg.attachments || '[]');
    if (!atts.length) return null;
    const a = atts[0];
    const url = a.url || a.href || a.preview_url || '';
    return url ? { url, name: a.name || '', type: a.type || msg.msg_type || 'file' } : null;
  } catch { return null; }
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

/** Build a list of MediaViewerImage from non-video messages for the in-app viewer */
function buildViewerImages(msgs: any[]): MediaViewerImage[] {
  return msgs
    .filter(msg => msg.msg_type !== 'chat.video.msg' && msg.msg_type !== 'video')
    .map(msg => {
      // FB: use CDN URL directly
      const fb = extractFBAttachment(msg);
      if (fb && ['image', 'photo', 'sticker', 'animated_image'].includes(fb.type)) {
        return { src: fb.url, displaySrc: fb.url, defaultName: fb.name || `image_${msg?.msg_id || Date.now()}.jpg` };
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
        localPath,
        defaultName: localPath ? localPath.replace(/.*[/\\]/, '') : `image_${msg?.msg_id || Date.now()}.jpg`,
      };
    })
    .filter(img => img.src || img.displaySrc);
}

export function getFileIcon(ext: string): string {
  const e = (ext || '').toLowerCase();
  if (['pdf'].includes(e)) return '📄';
  if (['doc', 'docx'].includes(e)) return '📝';
  if (['xls', 'xlsx', 'csv'].includes(e)) return '📊';
  if (['ppt', 'pptx'].includes(e)) return '📑';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return '🗜️';
  if (['mp4', 'avi', 'mov', 'mkv'].includes(e)) return '🎬';
  if (['mp3', 'wav', 'ogg'].includes(e)) return '🎵';
  return '📂';
}

export function formatFileSize(bytes: string | number): string {
  const n = typeof bytes === 'string' ? parseInt(bytes) : bytes;
  if (!n || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Tab = 'image' | 'file' | 'link';
const TAB_LABELS: Record<Tab, string> = { image: 'Ảnh/Video', file: 'File', link: 'Link' };

export type { Tab as MediaTab };
export { MediaDetailPanel };

// ─── Main exported component ──────────────────────────────────────────────────
export default function MediaSection({ threadId, onOpenDetail }: {
  threadId: string;
  onOpenDetail?: (tab: Tab) => void;
}) {
  const { activeAccountId } = useAccountStore();
  const [tab, setTab] = useState<Tab>('image');
  const [detailTab, setDetailTab] = useState<Tab | null>(null);
  const [viewerState, setViewerState] = useState<{ images: MediaViewerImage[]; index: number } | null>(null);

  const [previewImages, setPreviewImages] = useState<any[]>([]);
  const [previewFiles,  setPreviewFiles]  = useState<any[]>([]);
  const [previewLinks,  setPreviewLinks]  = useState<any[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Reset khi đổi thread
  useEffect(() => {
    setDetailTab(null);
    setPreviewImages([]);
    setPreviewFiles([]);
    setPreviewLinks([]);
  }, [threadId, activeAccountId]);

  // Load preview khi đổi tab
  useEffect(() => {
    if (!activeAccountId || !threadId || detailTab !== null) return;
    loadPreview(tab);
  }, [tab, threadId, activeAccountId, detailTab]);

  const loadPreview = async (t: Tab) => {
    if (!activeAccountId) return;
    setPreviewLoading(true);
    try {
      if (t === 'image') {
        const r = await ipc.db?.getMediaMessages({ zaloId: activeAccountId, threadId, limit: PREVIEW_IMAGE + 1, offset: 0 });
        setPreviewImages(r?.messages || []);
      } else if (t === 'file') {
        const r = await ipc.db?.getFileMessages({ zaloId: activeAccountId, threadId, limit: PREVIEW_LIST + 1, offset: 0 });
        setPreviewFiles(r?.messages || []);
      } else {
        const r = await ipc.db?.getLinks({ zaloId: activeAccountId, threadId, limit: PREVIEW_LIST + 1, offset: 0 });
        setPreviewLinks(r?.links || []);
      }
    } catch {}
    setPreviewLoading(false);
  };

  // ── Detail view chiếm toàn panel ──────────────────────────────────────────
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

  // ── Preview (nằm trong panel info bình thường) ─────────────────────────────
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
    <div className="border-t border-gray-700">
      {/* Tab bar */}
      <div className="flex border-b border-gray-700">
        {(['image', 'file', 'link'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              tab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="p-2">
        {previewLoading ? (
          <div className="flex justify-center py-6">
            <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        ) : tab === 'image' ? (
          images.length === 0
            ? <EmptyState label="ảnh/video" />
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
                        onClickImage={() => setViewerState({ images: previewViewerImages, index: viewerIdx >= 0 ? viewerIdx : 0 })}
                      />
                    );
                  })}
                </div>
                {hasMoreImages && <ViewAllBtn onClick={() => openDetail('image')} />}
              </>
        ) : tab === 'file' ? (
          files.length === 0
            ? <EmptyState label="file đính kèm" />
            : <>
                <div className="space-y-0.5">
                  {files.map((msg, i) => <FileRow key={i} msg={msg} />)}
                </div>
                {hasMoreFiles && <ViewAllBtn onClick={() => openDetail('file')} />}
              </>
        ) : (
          links.length === 0
            ? <EmptyState label="link" />
            : <>
                <div className="space-y-0.5">
                  {links.map((link, i) => <LinkRow key={i} link={link} />)}
                </div>
                {hasMoreLinks && <ViewAllBtn onClick={() => openDetail('link')} />}
              </>
        )}
      </div>

      {/* In-app image viewer */}
      {viewerState && (
        <MediaViewer
          images={viewerState.images}
          initialIndex={viewerState.index}
          zaloId={activeAccountId || undefined}
          onClose={() => setViewerState(null)}
        />
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ label }: { label: string }) {
  return <p className="text-xs text-gray-500 text-center py-6">Chưa có {label}</p>;
}

// ─── "Xem tất cả" button ──────────────────────────────────────────────────────
function ViewAllBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full mt-2 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium transition-colors">
      Xem tất cả
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );
}

// ─── Date grouping helpers (Zalo style) ──────────────────────────────────────
const MONTH_VI = [
  'Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
  'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12',
];

function getDateGroupLabel(timestamp: number): string {
  const d   = new Date(timestamp);
  const now = new Date();
  const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const itemDay   = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (itemDay.getTime() === today.getTime())     return 'Hôm nay';
  if (itemDay.getTime() === yesterday.getTime()) return 'Hôm qua';
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

// ─── Detail panel — thay thế toàn bộ panel (giống MembersPanel) ──────────────
function MediaDetailPanel({ threadId, activeAccountId, tab, onBack }: {
  threadId: string;
  activeAccountId: string;
  tab: Tab;
  onBack: () => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>(tab);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [viewerState, setViewerState] = useState<{ images: MediaViewerImage[]; index: number } | null>(null);
  const pageRef    = useRef(0);
  const loadingRef = useRef(false);
  const bottomRef  = useRef<HTMLDivElement>(null);

  const loadPage = useCallback(async (t: Tab, pageNum: number) => {
    if (!activeAccountId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const offset = pageNum * PAGE_SIZE;
    try {
      let newItems: any[] = [];
      if (t === 'image') {
        const r = await ipc.db?.getMediaMessages({ zaloId: activeAccountId, threadId, limit: PAGE_SIZE, offset });
        newItems = r?.messages || [];
      } else if (t === 'file') {
        const r = await ipc.db?.getFileMessages({ zaloId: activeAccountId, threadId, limit: PAGE_SIZE, offset });
        newItems = r?.messages || [];
      } else {
        const r = await ipc.db?.getLinks({ zaloId: activeAccountId, threadId, limit: PAGE_SIZE, offset });
        newItems = r?.links || [];
      }
      setItems(prev => pageNum === 0 ? newItems : [...prev, ...newItems]);
      setHasMore(newItems.length === PAGE_SIZE);
    } catch {}
    loadingRef.current = false;
    setLoading(false);
  }, [activeAccountId, threadId]);

  // Load lại từ đầu khi đổi tab
  useEffect(() => {
    pageRef.current = 0;
    loadingRef.current = false;
    setItems([]);
    setHasMore(true);
    loadPage(activeTab, 0);
  }, [activeTab, activeAccountId, threadId]);

  // Infinite scroll — sentinel
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loadingRef.current) {
        const next = pageRef.current + 1;
        pageRef.current = next;
        loadPage(activeTab, next);
      }
    }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadPage, activeTab]);

  return (
    <div className="w-72 h-full flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-hidden">
      {/* Header — giống MembersPanel */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-700">
        <button onClick={onBack}
          className="p-1 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span className="text-sm font-semibold text-white flex-1 text-center pr-6">{TAB_LABELS[activeTab]}</span>
      </div>

      {/* Sub-tab bar */}
      <div className="flex border-b border-gray-700 flex-shrink-0">
        {(['image', 'file', 'link'] as Tab[]).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              activeTab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Count label */}
      <div className="px-4 py-2 flex-shrink-0">
        <span className="text-xs text-gray-400 font-medium">
          {loading && items.length === 0
            ? 'Đang tải...'
            : activeTab === 'image'
              ? `${items.length} ảnh/video${hasMore ? '+' : ''}`
              : `${items.length} ${TAB_LABELS[activeTab].toLowerCase()}${hasMore ? '+' : ''}`
          }
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Image grid — grouped by date */}
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
                <p className="text-xs text-gray-500 text-center py-8">Chưa có ảnh/video</p>
              ) : (
                groupByDateLabel(displayableItems).map(group => (
                  <div key={group.label} className="mb-3">
                    {/* Date header */}
                    <div className="flex items-center gap-2 py-1.5 sticky top-0 bg-gray-800 z-10">
                      <span className="text-[11px] font-semibold text-gray-400 whitespace-nowrap">
                        {group.label}
                      </span>
                      <div className="flex-1 h-px bg-gray-700" />
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
                            onClickImage={() => setViewerState({ images: allViewerImages, index: viewerIdx >= 0 ? viewerIdx : 0 })}
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
            ? <p className="text-xs text-gray-500 text-center py-8">Chưa có file đính kèm</p>
            : items.map((msg, i) => <FileRow key={i} msg={msg} />)
        )}

        {/* Link list */}
        {activeTab === 'link' && (
          items.length === 0 && !loading
            ? <p className="text-xs text-gray-500 text-center py-8">Chưa có link</p>
            : items.map((link, i) => <LinkRow key={i} link={link} />)
        )}

        {/* Sentinel + loading indicator */}
        <div ref={bottomRef} className="h-2" />
        {loading && (
          <div className="flex justify-center py-4">
            <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        )}
        {!hasMore && items.length > 0 && (
          <p className="text-[11px] text-gray-600 text-center py-3">Đã hiển thị tất cả</p>
        )}
      </div>

      {/* In-app image viewer */}
      {viewerState && (
        <MediaViewer
          images={viewerState.images}
          initialIndex={viewerState.index}
          zaloId={activeAccountId || undefined}
          onClose={() => setViewerState(null)}
        />
      )}
    </div>
  );
}

// ─── Image thumbnail cell ─────────────────────────────────────────────────────
function ImageThumb({ msg, onClickImage }: { msg: any; onClickImage?: () => void }) {
  const isFB = msg.channel === 'facebook';
  const isVideo = msg.msg_type === 'chat.video.msg' || msg.msg_type === 'video';
  const url = extractImgUrl(msg);
  const localFilePath = isVideo ? extractVideoFilePath(msg) : extractLocalFilePath(msg);
  const remoteVideoUrl = isVideo ? (isFB ? (extractFBAttachment(msg)?.url || '') : extractVideoRemoteUrl(msg)) : '';

  // For FB videos, CDN URL is the remote video URL
  const fbAtt = isFB ? extractFBAttachment(msg) : null;

  const handleClick = () => {
    if (isVideo) {
      if (localFilePath) ipc.file?.openPath(localFilePath);
      else if (remoteVideoUrl) ipc.shell?.openExternal(remoteVideoUrl);
      else if (fbAtt?.url) ipc.shell?.openExternal(fbAtt.url);
    } else if (onClickImage) {
      onClickImage();
    } else {
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
          className="w-full aspect-square object-cover rounded hover:opacity-80 transition-opacity bg-gray-900"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      ) : (
        <div className="w-full aspect-square rounded bg-gray-900 hover:bg-gray-700 transition-colors" />
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
          title="Tải về"
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
          onClick={e => { e.stopPropagation(); ipc.file?.showItemInFolder(localFilePath); }}
          title="Mở thư mục"
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
  const isFB = msg.channel === 'facebook';
  let title = 'File', sizeStr = '', ext = '', localPath = '', href = '';

  if (isFB) {
    // FB: extract from attachments column
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      const a = atts[0] || {};
      title = a.name || msg.content || 'File';
      href  = a.url || a.href || '';
      ext   = title.split('.').pop() || '';
      if (a.size) sizeStr = formatFileSize(a.size);
    } catch {}
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

  const dateStr = new Date(msg.timestamp).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });

  return (
    <div className="flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors group/file">
      <button
        onClick={() => { if (localPath) ipc.file?.openPath(localPath); else if (href) ipc.shell?.openExternal(href); }}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
      >
        <span className="text-xl flex-shrink-0">{getFileIcon(ext)}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 truncate font-medium">{title}</p>
          <p className="text-[11px] text-gray-500">{sizeStr && `${sizeStr} · `}{dateStr}</p>
        </div>
      </button>
      {/* FB: download button pointing to CDN */}
      {isFB && href && (
        <button
          onClick={() => ipc.shell?.openExternal(href)}
          title="Tải về"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-600 opacity-0 group-hover/file:opacity-100 transition-all flex-shrink-0"
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
          onClick={() => ipc.file?.showItemInFolder(localPath)}
          title="Mở thư mục"
          className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-600 opacity-0 group-hover/file:opacity-100 transition-all flex-shrink-0"
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
  const dateStr = new Date(link.timestamp).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-700 transition-colors group/link cursor-pointer"
      onClick={() => link.url && ipc.shell?.openExternal(link.url)}
      title={link.url}
    >
      {/* Thumbnail */}
      <div className="w-9 h-9 rounded-lg flex-shrink-0 overflow-hidden bg-gray-700 flex items-center justify-center border border-gray-600/50">
        {link.thumb_url ? (
          <img src={link.thumb_url} alt="" className="w-full h-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-500">
            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
          </svg>
        )}
      </div>
      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200 truncate font-medium">{link.title || link.url}</p>
        <p className="text-[11px] text-gray-500 truncate">{link.domain || link.url}</p>
        <p className="text-[11px] text-gray-600">{dateStr}</p>
      </div>
      {/* External icon */}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        className="flex-shrink-0 text-gray-600 group-hover/link:text-gray-400 transition-colors">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </div>
  );
}
