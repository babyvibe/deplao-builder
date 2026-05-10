import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { callApi, extractApiError } from '@/utils/apiError';
import { showConfirm } from '../common/ConfirmDialog';
import { toLocalMediaUrl } from '@/lib/localMedia';

// ─── Types ────────────────────────────────────────────────────────────────────
export type LocalMediaFile = {
  path: string;
  type: 'image' | 'video';
};

export type QuickMessage = {
  id: number;
  keyword: string;
  type?: number;
  createdTime?: number;
  lastModified?: number;
  message: { title: string; params?: string | null };
  media: {
    items: {
      type: number; photoId: number; title: string;
      width: number; height: number; previewThumb: string;
      rawUrl: string; thumbUrl: string; normalUrl: string; hdUrl: string;
    }[];
  } | null;
  // local-only fields
  _local?: boolean;
  _localMedia?: LocalMediaFile[];   // local file paths for images/videos
  createdAt?: number;
  updatedAt?: number;
};

export type QuickMessageMode = 'zalo' | 'local';

// ─── Zalo API cache (1h TTL) ──────────────────────────────────────────────────
const CACHE_TTL = 60 * 60 * 1000;
const zaloCache: Record<string, { data: QuickMessage[]; ts: number }> = {};

export async function fetchZaloQuickMessages(auth: any, accountId: string, force = false): Promise<QuickMessage[]> {
  const now = Date.now();
  if (!force && zaloCache[accountId] && now - zaloCache[accountId].ts < CACHE_TTL) {
    return zaloCache[accountId].data;
  }
  const res = await ipc.zalo?.getQuickMessageList({ auth });
  if (res?.success) {
    const items: QuickMessage[] = res.response?.items || [];
    zaloCache[accountId] = { data: items, ts: now };
    return items;
  }
  const errMsg = extractApiError(res, 'Không thể lấy danh sách tin nhắn nhanh từ Zalo');
  if (zaloCache[accountId]?.data?.length) {
    console.warn('[QuickMessage] Dùng cache cũ:', errMsg);
    return zaloCache[accountId].data;
  }
  throw new Error(errMsg);
}

export function invalidateZaloQuickMessageCache(accountId: string) {
  delete zaloCache[accountId];
}

// ─── Local DB helpers ─────────────────────────────────────────────────────────
async function fetchLocalQuickMessages(zaloId: string): Promise<QuickMessage[]> {
  const res = await ipc.db?.getLocalQuickMessages({ zaloId });
  if (!res?.success) return [];
  return (res.items || []).map((r: any) => {
    const mediaObj = r.media || null;
    const localFiles: LocalMediaFile[] | undefined =
      mediaObj?.localFiles?.length ? mediaObj.localFiles : undefined;
    return {
      id: r.id,
      keyword: r.keyword,
      message: { title: r.title },
      // keep Zalo-style media if present (synced items), null otherwise for local-created
      media: localFiles ? null : mediaObj,
      _local: true,
      _localMedia: localFiles,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

// ─── Unified fetch (mode-aware) ───────────────────────────────────────────────
export async function fetchQuickMessages(auth: any, accountId: string, mode: QuickMessageMode, force = false): Promise<QuickMessage[]> {
  if (mode === 'local') return fetchLocalQuickMessages(accountId);
  return fetchZaloQuickMessages(auth, accountId, force);
}

// ─── Mode persistence (localStorage per accountId) ───────────────────────────
function getStoredMode(accountId: string): QuickMessageMode {
  try { return (localStorage.getItem(`qm_mode_${accountId}`) as QuickMessageMode) || 'local'; } catch { return 'local'; }
}
function setStoredMode(accountId: string, mode: QuickMessageMode) {
  try { localStorage.setItem(`qm_mode_${accountId}`, mode); } catch {}
}

// ─── Edit/Create Dialog ───────────────────────────────────────────────────────
function QuickMessageDialog({
  initial,
  onClose,
  onSave,
  mode,
}: {
  initial?: QuickMessage;
  onClose: () => void;
  onSave: (keyword: string, title: string, mediaPath?: string, localMediaFiles?: LocalMediaFile[]) => Promise<void>;
  mode: QuickMessageMode;
}) {
  const [keyword, setKeyword] = useState(initial?.keyword || '');
  const [title, setTitle] = useState(initial?.message?.title || '');
  // Zalo mode: single image path
  const [mediaPath, setMediaPath] = useState<string | undefined>(undefined);
  const [mediaPreview, setMediaPreview] = useState<string | undefined>(
    initial?.media?.items?.[0]?.thumbUrl || initial?.media?.items?.[0]?.normalUrl || undefined
  );
  // Local mode: multiple media files
  const [localMediaFiles, setLocalMediaFiles] = useState<LocalMediaFile[]>(
    initial?._localMedia || []
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { showNotification } = useAppStore();

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  // ── Zalo mode: single image ────────────────────────────────────────────────
  const handlePickImage = async () => {
    const result = await ipc.file?.openDialog({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
      multiSelect: false,
    });
    if (result?.canceled || !result?.filePaths?.length) return;
    const fp: string = result.filePaths[0];
    setMediaPath(fp);
    setMediaPreview(toLocalMediaUrl(fp));
  };
  const handleRemoveImage = () => { setMediaPath(undefined); setMediaPreview(undefined); };

  // ── Local mode: multiple images ────────────────────────────────────────────
  const handlePickLocalImages = async () => {
    const result = await ipc.file?.openDialog({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
      multiSelect: true,
    });
    if (result?.canceled || !result?.filePaths?.length) return;
    const newFiles: LocalMediaFile[] = result.filePaths.map((p: string) => ({ path: p, type: 'image' as const }));
    setLocalMediaFiles(prev => {
      // deduplicate by path
      const existing = new Set(prev.map(f => f.path));
      return [...prev, ...newFiles.filter(f => !existing.has(f.path))];
    });
  };

  // ── Local mode: multiple videos ────────────────────────────────────────────
  const handlePickLocalVideos = async () => {
    const result = await ipc.file?.openDialog({
      filters: [{ name: 'Videos', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v', '3gp'] }],
      multiSelect: true,
    });
    if (result?.canceled || !result?.filePaths?.length) return;
    const newFiles: LocalMediaFile[] = result.filePaths.map((p: string) => ({ path: p, type: 'video' as const }));
    setLocalMediaFiles(prev => {
      const existing = new Set(prev.map(f => f.path));
      return [...prev, ...newFiles.filter(f => !existing.has(f.path))];
    });
  };

  const handleRemoveLocalMedia = (path: string) => {
    setLocalMediaFiles(prev => prev.filter(f => f.path !== path));
  };

  const handleSave = async () => {
    if (!keyword.trim() || !title.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(keyword.trim(), title.trim(), mediaPath, localMediaFiles.length > 0 ? localMediaFiles : undefined);
      onClose();
    } catch (e: any) {
      const msg = extractApiError(e, e?.message || 'Lưu thất bại');
      setSaveError(msg);
      showNotification(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={overlayRef} onClick={handleOverlayClick} data-qm-overlay
      className="fixed inset-0 bg-black/60 flex items-center justify-center"
      style={{ zIndex: 10000 }}>
      <div className="bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col" style={{ maxHeight: '90vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-shrink-0">
          <h2 className="text-white font-semibold text-base">
            {initial ? 'Chỉnh sửa tin nhắn nhanh' : 'Tạo tin nhắn nhanh'}
          </h2>
          <button onClick={onClose}
            className="text-gray-400 hover:text-white w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-700 transition-colors text-lg">✕</button>
        </div>
        {/* Body */}
        <div className="px-6 py-5 flex flex-col gap-4 overflow-y-auto flex-1">
          {/* Keyword */}
          <div className="flex items-center gap-3 bg-gray-700 rounded-xl px-4 py-3 border border-gray-600 focus-within:border-blue-500 transition-colors">
            <div className="w-8 h-8 bg-gray-600 rounded-lg flex items-center justify-center text-gray-300 font-bold text-sm flex-shrink-0">/</div>
            <input autoFocus type="text" value={keyword}
              onChange={e => setKeyword(e.target.value.replace(/\s/g, '').slice(0, 20))}
              placeholder="ten_phim_tat"
              className="flex-1 bg-transparent text-white placeholder-gray-400 text-sm focus:outline-none" />
            <span className="text-xs text-gray-400 flex-shrink-0">{keyword.length}/20</span>
          </div>
          {/* Title */}
          <textarea value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Nội dung tin nhắn nhanh..." rows={4}
            className="w-full bg-gray-700 border border-gray-600 focus:border-blue-500 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-400 resize-none focus:outline-none transition-colors" />

          {/* ── Zalo mode: single image ── */}
          {mode === 'zalo' && (
            mediaPreview ? (
              <div className="relative inline-block">
                <img src={mediaPreview} alt="preview" className="w-24 h-24 rounded-xl object-cover border border-gray-600" />
                <button onClick={handleRemoveImage}
                  className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-white text-xs font-bold shadow transition-colors">✕</button>
              </div>
            ) : (
              <button onClick={handlePickImage}
                className="self-start flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-xl text-sm text-gray-300 hover:text-white transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                </svg>
                Thêm ảnh
              </button>
            )
          )}

          {/* ── Local mode: multiple images + videos ── */}
          {mode === 'local' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 font-medium">Media đính kèm</span>
                <span className="text-xs text-gray-500">({localMediaFiles.length} file)</span>
              </div>
              {/* Previews grid */}
              {localMediaFiles.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {localMediaFiles.map(f => {
                    const fileUrl = toLocalMediaUrl(f.path);
                    return (
                      <div key={f.path} className="relative group flex-shrink-0">
                        {f.type === 'image' ? (
                          <img src={fileUrl} alt=""
                            className="w-20 h-20 rounded-xl object-cover border border-gray-600" />
                        ) : (
                          <div className="w-20 h-20 rounded-xl border border-gray-600 bg-gray-700 flex flex-col items-center justify-center gap-1 overflow-hidden relative">
                            <video src={fileUrl} className="absolute inset-0 w-full h-full object-cover opacity-60" muted />
                            <div className="relative z-10 w-8 h-8 bg-black/60 rounded-full flex items-center justify-center">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                                <polygon points="5 3 19 12 5 21 5 3"/>
                              </svg>
                            </div>
                          </div>
                        )}
                        {/* Type badge */}
                        <span className="absolute bottom-1 left-1 text-[9px] bg-black/70 text-white px-1 py-0.5 rounded font-medium z-10">
                          {f.type === 'video' ? '▶ Video' : '🖼 Ảnh'}
                        </span>
                        {/* Remove button */}
                        <button
                          onClick={() => handleRemoveLocalMedia(f.path)}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-white text-xs font-bold shadow transition-colors z-20 opacity-0 group-hover:opacity-100">✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Pick buttons */}
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={handlePickLocalImages}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-xs text-gray-300 hover:text-white transition-colors">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                  </svg>
                  Thêm ảnh
                </button>
                <button onClick={handlePickLocalVideos}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-xs text-gray-300 hover:text-white transition-colors">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                  </svg>
                  Thêm video
                </button>
                {localMediaFiles.length > 0 && (
                  <button onClick={() => setLocalMediaFiles([])}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/40 hover:bg-red-900/60 border border-red-700/40 rounded-lg text-xs text-red-400 hover:text-red-300 transition-colors ml-auto">
                    Xóa tất cả
                  </button>
                )}
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Khi chọn tin nhắn nhanh này, ảnh/video sẽ được gửi tự động kèm theo nội dung.
                <br/>
                Thứ tự: Ảnh/video sẽ được gửi trước text
              </p>
            </div>
          )}
        </div>
        {/* Footer */}
        <div className="flex flex-col gap-2 px-6 py-4 border-t border-gray-700 flex-shrink-0">
          {saveError && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-700/40 rounded-lg px-3 py-2 leading-relaxed">
              ⚠ {saveError}
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            <button onClick={onClose}
              className="px-5 py-2 rounded-xl text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-700 transition-colors">Hủy</button>
            <button onClick={handleSave} disabled={saving || !keyword.trim() || !title.trim()}
              className="px-6 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-2">
              {saving && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              Lưu
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sync Options Dropdown ────────────────────────────────────────────────────
function SyncDropdown({ onSync, syncing, anchorRef }: {
  onSync: (mode: 'replace' | 'merge') => void;
  syncing: boolean;
  anchorRef: React.RefObject<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <div className="relative flex items-center" ref={dropRef}>
      <button
        ref={anchorRef}
        disabled={syncing}
        onClick={() => setOpen(p => !p)}
        title="Đồng bộ từ Zalo về Local"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 border border-gray-600/60 transition-colors disabled:opacity-50"
      >
        {syncing
          ? <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
          : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/>
            </svg>
        }
        Đồng bộ
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && !syncing && (
        <div className="absolute top-full left-0 mb-1.5 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl overflow-hidden min-w-[200px]"
          style={{ zIndex: 10001 }}>
          <div className="px-3 py-2 border-b border-gray-700">
            <p className="text-xs text-gray-400 font-medium">Đồng bộ từ Zalo → Local</p>
          </div>
          <button
            onClick={() => { setOpen(false); onSync('replace'); }}
            className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-gray-700 transition-colors text-left"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-orange-400 mt-0.5 flex-shrink-0">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
            <div>
              <p className="text-xs text-white font-medium">Thay thế</p>
              <p className="text-[11px] text-gray-400 leading-snug">Xóa local cũ, dùng dữ liệu Zalo</p>
            </div>
          </button>
          <button
            onClick={() => { setOpen(false); onSync('merge'); }}
            className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-gray-700 transition-colors text-left"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400 mt-0.5 flex-shrink-0">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <div>
              <p className="text-xs text-white font-medium">Thêm vào</p>
              <p className="text-[11px] text-gray-400 leading-snug">Giữ local, bổ sung từ Zalo</p>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Management Panel (small floating popup) ─────────────────────────────────
export function QuickMessageManagerPanel({ onClose, onSelect }: { onClose: () => void; onSelect?: (item: QuickMessage) => void }) {
  const { activeAccountId, getActiveAccount } = useAccountStore();
  const { showNotification } = useAppStore();

  const isFacebookChannel = getActiveAccount()?.channel === 'facebook';
  const [mode, setMode] = useState<QuickMessageMode>(() => isFacebookChannel ? 'local' : getStoredMode(activeAccountId || ''));
  const [items, setItems] = useState<QuickMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<QuickMessage | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const syncBtnRef = useRef<HTMLButtonElement>(null);

  // ── Slide-up animation on mount (CSS transition) ──────────────────────────
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  }, []);

  // Close on outside click — only when clicking truly outside both panel AND dialog
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (panelRef.current && panelRef.current.contains(target)) return;
      if (target.closest?.('[data-qm-overlay]')) return;
      onClose();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 200);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handler); };
  }, [onClose]);

  const getAuth = useCallback(() => {
    const account = getActiveAccount();
    if (!account) return null;
    return { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
  }, [getActiveAccount]);

  const load = useCallback(async (force = false) => {
    if (!activeAccountId) return;
    const auth = getAuth();
    if (!auth) return;
    setLoading(true);
    try {
      const data = await fetchQuickMessages(auth, activeAccountId, mode, force);
      setItems(data);
    } catch (e: any) {
      showNotification(extractApiError(e, 'Lỗi tải tin nhắn nhanh'), 'error');
    } finally {
      setLoading(false);
    }
  }, [activeAccountId, getAuth, mode, showNotification]);

  useEffect(() => { load(); }, [load]);

  const switchMode = (m: QuickMessageMode) => {
    setMode(m);
    if (activeAccountId) setStoredMode(activeAccountId, m);
  };

  const handleSync = async (syncMode: 'replace' | 'merge') => {
    if (!activeAccountId) return;
    const auth = getAuth();
    if (!auth) return;
    setSyncing(true);
    try {
      const zaloItems = await fetchZaloQuickMessages(auth, activeAccountId, true);
      if (zaloItems.length === 0) {
        showNotification('Không có tin nhắn nhanh nào trên Zalo để đồng bộ', 'warning');
        return;
      }
      const mapped = zaloItems.map(i => ({ keyword: i.keyword, title: i.message.title, media: i.media || undefined }));
      if (syncMode === 'replace') {
        await ipc.db?.bulkReplaceLocalQuickMessages({ zaloId: activeAccountId, items: mapped });
        showNotification(`Đã thay thế bằng ${zaloItems.length} tin nhắn từ Zalo!`, 'success');
      } else {
        // merge: upsert từng item, giữ local không bị xóa
        for (const item of mapped) {
          await ipc.db?.upsertLocalQuickMessage({ zaloId: activeAccountId, item });
        }
        showNotification(`Đã thêm ${zaloItems.length} tin nhắn từ Zalo vào Local!`, 'success');
      }
      // Switch to local tab to show result
      switchMode('local');
    } catch (e: any) {
      showNotification(extractApiError(e, 'Lỗi đồng bộ'), 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleCreate = async (keyword: string, title: string, mediaPath?: string, localMediaFiles?: LocalMediaFile[]) => {
    const auth = getAuth();
    if (!auth || !activeAccountId) return;
    if (mode === 'zalo') {
      await callApi(
        () => ipc.zalo?.addQuickMessage({ auth, keyword, title, mediaPath }),
        'Tạo tin nhắn nhanh thất bại'
      );
      invalidateZaloQuickMessageCache(activeAccountId);
      await load(true);
      showNotification('Đã tạo tin nhắn nhanh!', 'success');
    } else {
      const mediaObj = localMediaFiles && localMediaFiles.length > 0
        ? { localFiles: localMediaFiles }
        : undefined;
      await callApi(
        () => ipc.db?.upsertLocalQuickMessage({ zaloId: activeAccountId, item: { keyword, title, media: mediaObj } }),
        'Tạo tin nhắn nhanh local thất bại'
      );
      await load(true);
      showNotification('Đã tạo tin nhắn nhanh local!', 'success');
    }
  };

  const handleUpdate = async (keyword: string, title: string, mediaPath?: string, localMediaFiles?: LocalMediaFile[]) => {
    if (!editItem || !activeAccountId) return;
    const auth = getAuth();
    if (!auth) return;
    if (mode === 'zalo') {
      await callApi(
        () => ipc.zalo?.updateQuickMessage({ auth, keyword, title, mediaPath, itemId: editItem.id }),
        'Cập nhật tin nhắn nhanh thất bại'
      );
      invalidateZaloQuickMessageCache(activeAccountId);
      await load(true);
      showNotification('Đã cập nhật!', 'success');
    } else {
      const mediaObj = localMediaFiles && localMediaFiles.length > 0
        ? { localFiles: localMediaFiles }
        : undefined;
      await callApi(
        () => ipc.db?.upsertLocalQuickMessage({ zaloId: activeAccountId, item: { keyword, title, media: mediaObj } }),
        'Cập nhật tin nhắn nhanh local thất bại'
      );
      await load(true);
      showNotification('Đã cập nhật tin nhắn nhanh local!', 'success');
    }
  };

  const handleDelete = async (item: QuickMessage) => {
    if (!activeAccountId) return;
    const ok = await showConfirm({
      title: `Xóa tin nhắn nhanh "/${item.keyword}"?`,
      message: 'Hành động này không thể hoàn tác.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      if (mode === 'zalo') {
        const auth = getAuth();
        if (!auth) return;
        await callApi(
          () => ipc.zalo?.removeQuickMessage({ auth, itemIds: [item.id] }),
          'Xóa tin nhắn nhanh thất bại'
        );
        invalidateZaloQuickMessageCache(activeAccountId);
      } else {
        await callApi(
          () => ipc.db?.deleteLocalQuickMessage({ zaloId: activeAccountId, id: item.id }),
          'Xóa tin nhắn nhanh local thất bại'
        );
      }
      await load(true);
      showNotification('Đã xóa!', 'success');
    } catch (e: any) {
      showNotification(extractApiError(e, 'Xóa thất bại'), 'error');
    }
  };

  return (
    <>
      {/* Floating popup — absolute, anchored to the relative wrapper in toolbar */}
      <div
        ref={panelRef}
        data-qm-panel
        className="fixed w-[360px] max-h-[520px] bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-[9999]"
        style={{
          left: '50%',
          bottom: '80px',
          opacity: visible ? 1 : 0,
          transform: visible
            ? 'translateX(-50%) translateY(0px)'
            : 'translateX(-50%) translateY(10px)',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
          <span className="text-sm font-semibold text-white">Tin nhắn nhanh</span>
          <div className="flex items-center gap-2">
            {/* Mode toggle — hide Zalo tab for Facebook channel */}
            {!isFacebookChannel && (
            <div className="flex items-center gap-0.5 p-0.5 bg-gray-700 rounded-lg">
              <button
                onClick={() => switchMode('local')}
                title="Local (không bị chặn)"
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${mode === 'local' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                </svg>
                Local
              </button>
              <button
                onClick={() => switchMode('zalo')}
                title="Zalo API"
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${mode === 'zalo' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Zalo
              </button>
            </div>
            )}
            <button onClick={onClose}
              className="text-gray-400 hover:text-white w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-700 transition-colors text-sm">✕</button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700/60 flex-shrink-0 bg-gray-800/80">
          <div className="flex items-center gap-2">
            {/* Sync button — only on Zalo tab, not for Facebook channel */}
            {mode === 'zalo' && !isFacebookChannel && (
              <SyncDropdown onSync={handleSync} syncing={syncing} anchorRef={syncBtnRef} />
            )}
            <button onClick={() => load(true)} disabled={loading} title="Làm mới"
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors disabled:opacity-40">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'animate-spin' : ''}>
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
            </button>
          </div>
          <button
            onClick={() => { setEditItem(undefined); setShowDialog(true); }}
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 font-semibold transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Tạo mới
          </button>
        </div>

        {/* Items list */}
        <div className="overflow-y-auto flex-1">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-gray-500 text-xs gap-2 px-4 text-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-600">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
              </svg>
              Chưa có tin nhắn nhanh nào.
              {mode === 'local' && !isFacebookChannel && (
                <span className="text-gray-600">
                  Chuyển sang tab <strong className="text-gray-400">Zalo</strong> và nhấn <strong className="text-gray-400">Đồng bộ</strong> để import
                </span>
              )}
            </div>
          ) : (
            <div className="divide-y divide-gray-700/50">
              {items.map(item => (
                <div
                  key={item.id}
                  onClick={() => { onSelect?.(item); onClose(); }}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-gray-700/50 group transition-colors cursor-pointer"
                >
                  <div className="flex-1 min-w-0">
                    <span className="inline-block bg-gray-700 text-white text-xs font-semibold px-2 py-0.5 rounded-md mb-1.5">/{item.keyword}</span>
                    {/* Zalo-style media thumbnail */}
                    {item.media?.items?.[0] && (
                      <img src={item.media.items[0].thumbUrl || item.media.items[0].normalUrl}
                        alt="" className="w-14 h-14 rounded-lg object-cover border border-gray-600 mb-1.5 block" />
                    )}
                    {/* Local media thumbnails */}
                    {item._localMedia && item._localMedia.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {item._localMedia.slice(0, 4).map((f, fi) => {
                          const fileUrl = toLocalMediaUrl(f.path);
                          return (
                            <div key={fi} className="relative w-12 h-12 rounded-lg overflow-hidden border border-gray-600 flex-shrink-0 bg-gray-700">
                              {f.type === 'image'
                                ? <img src={fileUrl} alt="" className="w-full h-full object-cover" />
                                : <div className="w-full h-full flex items-center justify-center">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="white" className="opacity-80">
                                      <polygon points="5 3 19 12 5 21 5 3"/>
                                    </svg>
                                  </div>
                              }
                              {fi === 3 && item._localMedia!.length > 4 && (
                                <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-[11px] font-bold">
                                  +{item._localMedia!.length - 4}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-sm text-gray-300 leading-relaxed line-clamp-2">{item.message.title}</p>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditItem(item); setShowDialog(true); }}
                      title="Chỉnh sửa"
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(item); }}
                      title="Xóa"
                      className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-400 hover:bg-gray-700 transition-colors">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                        <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Mode hint footer */}
        <div className={`px-4 py-2.5 border-t border-gray-700/60 flex-shrink-0 text-xs ${mode === 'local' ? 'text-green-400/70' : 'text-yellow-400/70'}`}>
          {isFacebookChannel
            ? '✓ Local — tin nhắn nhanh cho kênh Facebook'
            : mode === 'local'
            ? '✓ Local — không bị Zalo chặn số lượng tin nhắn nhanh'
            : '⚠ Zalo API — có thể bị giới hạn nếu bạn không dùng gói trả phí của Zalo'}
        </div>
      </div>

      {/* Edit/Create Dialog */}
      {showDialog && (
        <QuickMessageDialog
          initial={editItem}
          mode={mode}
          onClose={() => { setShowDialog(false); setEditItem(undefined); }}
          onSave={editItem ? handleUpdate : handleCreate}
        />
      )}
    </>
  );
}

// ─── Quick Message Dropdown (shown when typing "/" at start of input) ─────────
export function QuickMessageDropdown({
  items,
  filter,
  selectedIdx,
  onSelect,
  onManage,
}: {
  items: QuickMessage[];
  filter: string;
  selectedIdx: number;
  onSelect: (item: QuickMessage) => void;
  onManage: () => void;
}) {
  const filtered = filter
    ? items.filter(i =>
        i.keyword.toLowerCase().startsWith(filter.toLowerCase()) ||
        i.keyword.toLowerCase().includes(filter.toLowerCase()) ||
        i.message.title.toLowerCase().includes(filter.toLowerCase())
      )
    : items;


  return (
    <div className="bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl overflow-hidden"
      style={{ maxHeight: '320px', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
        <span className="text-xs font-semibold text-white">Tin nhắn nhanh ({filtered.length})</span>
        <button onMouseDown={e => { e.preventDefault(); onManage(); }}
          className="text-xs text-blue-400 hover:text-blue-300 font-semibold transition-colors">Quản lý</button>
      </div>

      {/* Items */}
      <div className="overflow-y-auto flex-1">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-4">Không tìm thấy tin nhắn nhanh</p>
        ) : (
          filtered.map((item, idx) => (
            <button key={item.id} onMouseDown={e => { e.preventDefault(); onSelect(item); }}
              className={`w-full text-left px-4 py-3 transition-colors border-b border-gray-700/40 last:border-0 ${idx === selectedIdx ? 'bg-gray-700' : 'hover:bg-gray-700/60'}`}>
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <span className="inline-block bg-gray-700 text-white text-xs font-semibold px-2 py-0.5 rounded-md mb-1">/{item.keyword}</span>
                  <p className="text-sm text-gray-300 truncate leading-snug">{item.message.title}</p>
                  {/* Local media badge */}
                  {item._localMedia && item._localMedia.length > 0 && (
                    <div className="flex items-center gap-1 mt-1">
                      {item._localMedia.filter(f => f.type === 'image').length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                          </svg>
                          {item._localMedia.filter(f => f.type === 'image').length} ảnh
                        </span>
                      )}
                      {item._localMedia.filter(f => f.type === 'video').length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                          </svg>
                          {item._localMedia.filter(f => f.type === 'video').length} video
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {/* Zalo media thumb */}
                {item.media?.items?.[0] && (
                  <img src={item.media.items[0].thumbUrl || item.media.items[0].normalUrl}
                    alt="" className="w-10 h-10 rounded-lg object-cover border border-gray-600 flex-shrink-0" />
                )}
                {/* Local media first thumb */}
                {!item.media?.items?.[0] && item._localMedia?.[0]?.type === 'image' && (
                  <img src={toLocalMediaUrl(item._localMedia[0].path)}
                    alt="" className="w-10 h-10 rounded-lg object-cover border border-gray-600 flex-shrink-0" />
                )}
                {!item.media?.items?.[0] && item._localMedia?.[0]?.type === 'video' && (
                  <div className="w-10 h-10 rounded-lg border border-gray-600 bg-gray-700 flex items-center justify-center flex-shrink-0">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="white" className="opacity-80">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </div>
                )}
              </div>
            </button>
          ))
        )}
      </div>

      {/* Hint */}
      <div className="px-4 py-2 border-t border-gray-700 flex-shrink-0 bg-gray-800/80">
        <p className="text-xs text-gray-500">
          Gợi ý: Nhập <kbd className="bg-gray-700 text-gray-300 text-xs px-1.5 py-0.5 rounded">/</kbd> ở đầu ô chat để hiển thị danh sách tin nhắn nhanh.
        </p>
      </div>
    </div>
  );
}
