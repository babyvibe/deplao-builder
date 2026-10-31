import React, { useState, useEffect, useMemo, useRef } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { AccountInfo } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '../../common/ConfirmDialog';
import AccountSelectorDropdown, { AccountOption } from '../../common/accounts/AccountSelectorDropdown';
import AccountMultiDropdown from '../../common/accounts/AccountMultiDropdown';
import { QuickMessage, LocalMediaFile, fetchZaloQuickMessages, invalidateZaloQuickMessageCache } from '../../chat/composer/QuickMessageManager';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { CHANNEL, isZalo } from '@/lib/channels/channelHelper';
import {
  QMConflictMode, QMMediaFile, findSharedCopies, formatAccountNames, groupSharedCopies, mediaFileName,
  pickOwnMediaCopy, planQuickMessageSave, qmContentSignature, rowsByOwnerForKeyword, summarizeQuickMessageResult,
} from '@/lib/chat/composer/quickMessageAccounts';
import PhoneDisplay from '@/components/common/inputs/PhoneDisplay';
import { AlertIcon, ChartIcon, ClipboardListIcon, CloudIcon, HardDriveIcon, ImageIcon, InboxIcon, LightningIcon, PluginIcon, PlusIcon, RefreshIcon, UsersIcon } from '@/components/common/icons';


// ─── Types ────────────────────────────────────────────────────────────────────
type QuickMsgSource = 'local' | 'zalo';

export interface LocalQMItem extends QuickMessage {
  owner_zalo_id: string;
  is_active?: number;
  sort_order?: number;
}

// ─── DB mapping helper ────────────────────────────────────────────────────────
export function mapDbRowToLocalQMItem(r: any): LocalQMItem {
  let mediaObj: any = null;
  let localFiles: LocalMediaFile[] | undefined;
  if (r.media_json) {
    try {
      const m = typeof r.media_json === 'string' ? JSON.parse(r.media_json) : r.media_json;
      if (m?.localFiles?.length) localFiles = m.localFiles;
      else mediaObj = m;
    } catch {}
  }
  if (!mediaObj && !localFiles) {
    if (r._localMedia?.length) localFiles = r._localMedia;
    else if (r.media) mediaObj = r.media;
  }
  return {
    id: r.id,
    owner_zalo_id: r.owner_zalo_id ?? r.zaloId ?? '',
    keyword: r.keyword ?? '',
    message: r.message ?? { title: r.title ?? '' },
    media: mediaObj,
    _local: true,
    _localMedia: localFiles,
    is_active: r.is_active ?? 1,
    sort_order: r.sort_order ?? 0,
    createdAt: r.createdAt ?? r.created_at,
    updatedAt: r.updatedAt ?? r.updated_at,
  };
}

// ─── Shared mini-components ───────────────────────────────────────────────────
function EmptyState({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="text-center py-14">
      <p className="text-3xl mb-2 justify-items-center">{icon}</p>
      <p className="text-muted-foreground text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-xs mt-1">{subtitle}</p>
    </div>
  );
}

function ModalWrapper({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      {children}
    </div>
  );
}

function MediaThumbs({ item }: { item: QuickMessage }) {
  const localFiles = item._localMedia;
  const zaloThumb = item.media?.items?.[0];
  if (!localFiles?.length && !zaloThumb) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {zaloThumb && (
        <img src={zaloThumb.thumbUrl || zaloThumb.normalUrl} alt=""
          className="w-10 h-10 rounded-lg object-cover border border-input" />
      )}
      {localFiles?.slice(0, 4).map((f, fi) => (
        <div key={fi} className="relative w-10 h-10 rounded-lg overflow-hidden border border-input flex-shrink-0 bg-muted">
          {f.type === 'image'
            ? <img src={toLocalMediaUrl(f.path)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center bg-card">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white" className="opacity-70"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </div>
          }
          {fi === 3 && localFiles.length > 4 && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-[11px] font-bold">
              +{localFiles.length - 4}
            </div>
          )}
        </div>
      ))}
      {localFiles?.filter(f => f.type === 'image').length ? (
        <span className="self-center text-[11px] text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded flex items-center gap-0.5"><ImageIcon className="w-4 h-4 inline" /> {localFiles.filter(f => f.type === 'image').length} ảnh
        </span>
      ) : null}
      {localFiles?.filter(f => f.type === 'video').length ? (
        <span className="self-center text-[11px] text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded flex items-center gap-0.5">
          ▶ {localFiles.filter(f => f.type === 'video').length} video
        </span>
      ) : null}
    </div>
  );
}

// ─── LocalMsgRow ──────────────────────────────────────────────────────────────
function LocalMsgRow({
  item, accountName, accountPhone, accountAvatarUrl,
  showAccountBadge, sharedCount, sharedNames,
  onEdit, onDelete, onToggleActive, isDragging
}: {
  item: LocalQMItem;
  accountName: string; accountPhone: string; accountAvatarUrl?: string;
  showAccountBadge: boolean;
  /** Accounts holding this same quick message (same keyword + content), this one included. */
  sharedCount: number; sharedNames: string;
  onEdit: () => void; onDelete: () => void; onToggleActive: () => void;
  isDragging?: boolean;
}) {
  const isActive = (item.is_active ?? 1) === 1;
  return (
    <div className={`bg-card border rounded-xl p-3 hover:border-input transition-colors ${isDragging ? 'opacity-40' : ''} ${isActive ? 'border-border/80' : 'border-border/30 opacity-60'}`}>
      <div className="flex items-start gap-3">
        {/* Drag handle */}
        <div className="pt-2 shrink-0 cursor-grab text-muted-foreground hover:text-muted-foreground select-none" title="Kéo để sắp xếp">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
            <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
            <circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>
          </svg>
        </div>
        <div className="pt-0.5 shrink-0">
          <span className="bg-card text-blue-300 text-[11px] font-mono px-1.5 py-0.5 rounded border border-border whitespace-nowrap">
            /{item.keyword}
          </span>
          {(item.sort_order ?? 0) > 0 && (
            <span className="block mt-1 text-center text-[9px] text-muted-foreground font-mono">#{item.sort_order}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground whitespace-pre-wrap line-clamp-2">{item.message?.title || ''}</p>
          <MediaThumbs item={item} />
          {sharedCount > 1 && (
            <p className="mt-1.5 flex items-center gap-1 w-fit text-[11px] text-muted-foreground" title={sharedNames}>
              <UsersIcon className="w-3.5 h-3.5 shrink-0" /> Dùng chung {sharedCount} tài khoản
            </p>
          )}
        </div>
        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onToggleActive} title={isActive ? 'Tắt' : 'Bật'}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${isActive ? 'text-green-400 hover:bg-green-500/10' : 'text-muted-foreground hover:bg-muted hover:text-muted-foreground'}`}>
            {isActive
              ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/></svg>
              : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/></svg>
            }
          </button>
          <button onClick={onEdit} title="Sửa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button onClick={onDelete} title="Xóa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </div>
      {/* Account badge - only show when 2+ accounts are in filter */}
      {showAccountBadge && (
        <div className="mt-2 pl-[calc(theme(spacing.10)+theme(spacing.3))] flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 bg-card rounded-full px-2 py-0.5 border border-border/50">
            {accountAvatarUrl ? (
              <img src={accountAvatarUrl} alt="" className="w-3.5 h-3.5 rounded-full object-cover shrink-0 border border-input" />
            ) : (
              <div className="w-3 h-3 bg-blue-600 rounded-full flex items-center justify-center text-[7px] text-white font-bold uppercase shrink-0">
                {(accountName || '?').charAt(0)}
              </div>
            )}
            <span className="text-[11px] text-muted-foreground truncate max-w-[140px]">{accountName}</span>
            <PhoneDisplay phone={accountPhone} className="text-xs text-muted-foreground" />
          </div>
        </div>
      )}
    </div>
  );
}

function ZaloMsgRow({ item, onEdit, onDelete }: { item: QuickMessage; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="bg-card border border-blue-900/30 rounded-xl p-3 hover:border-blue-700/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="pt-0.5 shrink-0">
          <span className="bg-blue-900/30 text-blue-300 text-[11px] font-mono px-1.5 py-0.5 rounded border border-blue-800/50 whitespace-nowrap">
            /{item.keyword || '?'}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground whitespace-pre-wrap line-clamp-2">{item.message?.title || '<Không có nội dung>'}</p>
          <MediaThumbs item={item} />
          <span className="text-[11px] text-blue-500/80 mt-1 flex items-center gap-1"><CloudIcon className="w-4 h-4 inline" /> Lưu trên Zalo</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onEdit} title="Sửa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button onClick={onDelete} title="Xóa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal: Local Quick Message ───────────────────────────────────────────────
// Multi-account like LabelModal (AccountMultiDropdown). Labels share ONE row (`page_ids`);
// local quick messages are one row per account, so the rules live in planQuickMessageSave()
// (@/lib/chat/composer/quickMessageAccounts): the same keyword + content on several accounts is one shared
// item, a deselected sharing account loses it, an account that already uses the keyword with
// other content is a conflict resolved once (overwrite / skip).
interface LocalMsgSaveData {
  keyword: string;
  title: string;
  localMediaFiles: LocalMediaFile[];
  /** Paths that came with the opened item (already stored) — only new picks get uploaded. */
  existingMediaPaths: string[];
  /** Zalo-style media of an item synced from Zalo, kept while no local file is attached. */
  zaloMedia: QuickMessage['media'];
  selected: string[];
  /** Edit mode: keyword of the opened item + the accounts that shared it when the dialog opened. */
  original: { keyword: string; members: string[] } | null;
  conflictMode: QMConflictMode;
}

function LocalMsgModal({
  initialData, accounts, filterAccounts, items, nameOf, onClose, onSave,
}: {
  initialData: LocalQMItem | null;
  accounts: AccountInfo[];
  filterAccounts: string[];
  /** Local rows of every account: who shares the item, who already uses the keyword. */
  items: LocalQMItem[];
  nameOf: (zaloId: string) => string;
  onClose: () => void;
  onSave: (data: LocalMsgSaveData) => Promise<void>;
}) {
  const isEdit = !!initialData;
  const [keyword, setKeyword] = useState(initialData?.keyword ?? '');
  const [title, setTitle] = useState(initialData?.message?.title ?? '');
  const [localMediaFiles, setLocalMediaFiles] = useState<LocalMediaFile[]>(initialData?._localMedia || []);
  const [zaloMedia, setZaloMedia] = useState<QuickMessage['media']>(initialData?.media?.items?.length ? initialData.media : null);
  const [conflictMode, setConflictMode] = useState<QMConflictMode>('skip');
  const [saving, setSaving] = useState(false);

  // Like a label's page_ids: the accounts sharing the opened item, captured when the dialog opens.
  const [original] = useState(() => {
    if (!initialData) return null;
    const known = new Set(accounts.map(a => a.zalo_id));
    const members = findSharedCopies(items, initialData).map(r => r.owner_zalo_id).filter(id => known.has(id));
    return { keyword: initialData.keyword, members };
  });
  // Create: the filtered accounts, else every account (same default as LabelModal).
  const [selected, setSelected] = useState<string[]>(() => {
    if (original) return original.members;
    const known = new Set(accounts.map(a => a.zalo_id));
    const fromFilter = filterAccounts.filter(id => known.has(id));
    return fromFilter.length > 0 ? fromFilter : accounts.map(a => a.zalo_id);
  });

  const kw = keyword.trim();
  const keptZaloMedia = localMediaFiles.length ? null : zaloMedia;
  const signature = qmContentSignature(title, localMediaFiles, keptZaloMedia);
  const plan = useMemo(
    () => planQuickMessageSave({ items, keyword: kw, signature, selected, original, conflictMode }),
    [items, kw, signature, selected, original, conflictMode],
  );
  const removedIds = plan.actions.filter(a => a.kind === 'remove').map(a => a.zaloId);
  const conflictIds = plan.conflicts.map(r => r.owner_zalo_id);
  const upsertCount = plan.actions.filter(a => a.upsert).length;
  // Other accounts already using the keyword, left as they are — every account that has it is listed.
  const knownIds = new Set(accounts.map(a => a.zalo_id));
  const listedIds = new Set([...selected, ...removedIds]);
  const untouchedIds = Array.from(rowsByOwnerForKeyword(items, kw).keys()).filter(id => knownIds.has(id) && !listedIds.has(id));
  const zaloThumb = keptZaloMedia?.items?.[0];

  const handlePickImages = async () => {
    const r = await ipc.file?.openDialog({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }], multiSelect: true,
    });
    if (r?.canceled || !r?.filePaths?.length) return;
    setLocalMediaFiles(prev => {
      const ex = new Set(prev.map(f => f.path));
      return [...prev, ...r.filePaths.filter((p: string) => !ex.has(p)).map((p: string) => ({ path: p, type: 'image' as const }))];
    });
  };

  const handlePickVideos = async () => {
    const r = await ipc.file?.openDialog({
      filters: [{ name: 'Videos', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v', '3gp'] }], multiSelect: true,
    });
    if (r?.canceled || !r?.filePaths?.length) return;
    setLocalMediaFiles(prev => {
      const ex = new Set(prev.map(f => f.path));
      return [...prev, ...r.filePaths.filter((p: string) => !ex.has(p)).map((p: string) => ({ path: p, type: 'video' as const }))];
    });
  };

  const valid = !!kw && !!title.trim() && selected.length > 0 && plan.actions.length > 0 && !saving;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await onSave({
        keyword: kw, title: title.trim(), localMediaFiles,
        existingMediaPaths: (initialData?._localMedia || []).map(f => f.path),
        zaloMedia: keptZaloMedia, selected, original, conflictMode,
      });
    } finally {
      setSaving(false);
    }
  };

  const close = saving ? () => {} : onClose;

  return (
    <ModalWrapper onClose={close}>
      <div className="bg-card rounded-xl w-full max-w-md border border-border shadow-2xl flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex justify-between items-center shrink-0">
          <h3 className="text-foreground font-medium">{isEdit ? 'Sửa tin nhắn nhanh' : 'Thêm tin nhắn nhanh'}</h3>
          <button onClick={close} disabled={saving} className="text-muted-foreground hover:text-foreground disabled:opacity-40">✕</button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Keyword */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Phím tắt (Keyword)</label>
            <div className="relative">
              <span className="absolute left-3 top-2 text-muted-foreground text-sm">/</span>
              <input type="text" value={keyword}
                onChange={e => setKeyword(e.target.value.replace(/\s/g, '').slice(0, 20))}
                placeholder="ten_phim_tat"
                className="w-full bg-muted text-foreground text-sm rounded-lg pl-6 pr-3 py-2 border border-input focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          {/* Content */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Nội dung tin nhắn</label>
            <textarea value={title} onChange={e => setTitle(e.target.value)} rows={4}
              placeholder="Nhập nội dung tin nhắn nhanh..."
              className="w-full bg-muted text-foreground text-sm rounded-lg px-3 py-2 border border-input focus:border-blue-500 outline-none resize-none"
            />
          </div>

          {/* Media */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted-foreground font-medium">
                Media đính kèm <span className="text-muted-foreground">({localMediaFiles.length + (zaloThumb ? 1 : 0)} file)</span>
              </label>
              {(localMediaFiles.length > 0 || zaloThumb) && (
                <button onClick={() => { setLocalMediaFiles([]); setZaloMedia(null); }} className="text-[11px] text-destructive hover:text-destructive/80">Xóa tất cả</button>
              )}
            </div>
            {(localMediaFiles.length > 0 || zaloThumb) && (
              <div className="flex flex-wrap gap-2 mb-2">
                {zaloThumb && (
                  /* Image of an item synced from Zalo: kept on save until removed or replaced by local files */
                  <div className="relative group w-16 h-16 shrink-0" title="Ảnh đồng bộ từ Zalo">
                    <img src={zaloThumb.thumbUrl || zaloThumb.normalUrl} alt="" className="w-full h-full rounded-xl object-cover border border-input"/>
                    <span className="absolute bottom-0.5 left-0.5 text-[8px] bg-black/70 text-white px-1 rounded z-10">Zalo</span>
                    <button onClick={() => setZaloMedia(null)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center text-xs font-bold shadow z-20 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                  </div>
                )}
                {localMediaFiles.map(f => (
                  <div key={f.path} className="relative group w-16 h-16 shrink-0">
                    {f.type === 'image'
                      ? <img src={toLocalMediaUrl(f.path)} alt="" className="w-full h-full rounded-xl object-cover border border-input"/>
                      : <div className="w-full h-full rounded-xl border border-input bg-muted flex flex-col items-center justify-center gap-1 relative overflow-hidden">
                          <video src={toLocalMediaUrl(f.path)} className="absolute inset-0 w-full h-full object-cover opacity-50" muted/>
                          <div className="relative z-10 w-7 h-7 bg-black/60 rounded-full flex items-center justify-center">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                          </div>
                        </div>
                    }
                    <span className="absolute bottom-0.5 left-0.5 text-[8px] bg-black/70 text-white px-1 rounded z-10">
                      {f.type === 'video' ? '▶' : '🖼'}
                    </span>
                    <button onClick={() => setLocalMediaFiles(p => p.filter(x => x.path !== f.path))}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-white text-xs font-bold shadow z-20 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={handlePickImages}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-muted hover:bg-accent border border-input rounded-lg text-xs text-foreground/80 hover:text-foreground transition-colors">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                </svg>
                Thêm ảnh
              </button>
              <button onClick={handlePickVideos}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-muted hover:bg-accent border border-input rounded-lg text-xs text-foreground/80 hover:text-foreground transition-colors">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
                Thêm video
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">Ảnh/video sẽ được gửi kèm khi chọn tin nhắn nhanh này.</p>
          </div>

          {/* Tài khoản áp dụng */}
          <div className="border-t border-border/50 pt-4">
            <label className="block text-xs text-muted-foreground mb-2 font-medium">Tài khoản áp dụng</label>
            {accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Chưa có tài khoản nào</p>
            ) : (
              <>
                <AccountMultiDropdown
                  accounts={accounts}
                  selectedIds={selected}
                  onChange={setSelected}
                  dropPosition="up"
                  fullWidth
                  placeholder="Chọn tài khoản áp dụng..."
                />
                {selected.length === 0 && (
                  <p className="text-[11px] text-destructive mt-1.5"><AlertIcon className="w-4 h-4 inline" /> Chọn ít nhất 1 tài khoản.</p>
                )}
                {original && original.members.length > 1 && (
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    <UsersIcon className="w-3.5 h-3.5 inline" /> Đang dùng chung cho {original.members.length} tài khoản: {formatAccountNames(original.members, nameOf)}.
                  </p>
                )}
                {removedIds.length > 0 && (
                  <p className="text-[11px] text-warning mt-1.5">
                    <AlertIcon className="w-4 h-4 inline" /> Sẽ gỡ /{original?.keyword} khỏi {formatAccountNames(removedIds, nameOf)} (đã bỏ chọn).
                  </p>
                )}
                {conflictIds.length > 0 && (
                  <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 space-y-2">
                    <p className="text-[11px] text-warning">
                      <AlertIcon className="w-4 h-4 inline" /> {formatAccountNames(conflictIds, nameOf)} đã có /{kw} với nội dung khác.
                    </p>
                    <div className="flex gap-1.5">
                      {([
                        { id: 'skip' as const, label: 'Bỏ qua, giữ bản cũ' },
                        { id: 'overwrite' as const, label: 'Ghi đè bằng bản này' },
                      ]).map(opt => (
                        <button key={opt.id} type="button" aria-pressed={conflictMode === opt.id} onClick={() => setConflictMode(opt.id)}
                          className={`flex-1 px-2.5 py-1.5 rounded-md border text-xs font-medium transition-colors ${conflictMode === opt.id
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-input text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                        >{opt.label}</button>
                      ))}
                    </div>
                    {plan.actions.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">Không còn tài khoản nào để lưu: chọn "Ghi đè" hoặc thêm tài khoản khác.</p>
                    )}
                  </div>
                )}
                {untouchedIds.length > 0 && (
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Cũng có /{kw} ở {formatAccountNames(untouchedIds, nameOf)}: không thay đổi.
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground mt-1.5 italic">* Tin nhắn nhanh được lưu riêng cho từng tài khoản được chọn.</p>
              </>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2 shrink-0">
          <button onClick={close} disabled={saving} className="px-4 py-2 text-muted-foreground hover:text-foreground text-sm disabled:opacity-40">Hủy</button>
          <button onClick={handleSave} disabled={!valid}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2">
            {saving && <span className="w-3.5 h-3.5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />}
            {saving ? 'Đang lưu...' : isEdit ? 'Lưu thay đổi' : (upsertCount > 1 ? `Lưu (${upsertCount} tài khoản)` : 'Lưu')}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Modal: Zalo Quick Message ────────────────────────────────────────────────
function ZaloMsgModal({ initialData, accountName, onClose, onSave }: {
  initialData: QuickMessage | null; accountName: string;
  onClose: () => void;
  onSave: (data: { keyword: string; title: string; mediaPath?: string; itemId?: number }) => void;
}) {
  const isEdit = !!initialData;
  const [keyword, setKeyword] = useState(initialData?.keyword ?? '');
  const [title, setTitle] = useState(initialData?.message?.title ?? '');
  const [mediaPath, setMediaPath] = useState<string | undefined>(undefined);
  const [mediaPreview, setMediaPreview] = useState<string | undefined>(
    initialData?.media?.items?.[0]?.thumbUrl || initialData?.media?.items?.[0]?.normalUrl
  );
  const valid = keyword.trim() && title.trim();

  const handlePickImage = async () => {
    const r = await ipc.file?.openDialog({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }], multiSelect: false,
    });
    if (r?.canceled || !r?.filePaths?.length) return;
    const fp: string = r.filePaths[0];
    setMediaPath(fp);
    setMediaPreview(toLocalMediaUrl(fp));
  };

  return (
    <ModalWrapper onClose={onClose}>
      <div className="bg-card rounded-xl w-full max-w-md border border-border shadow-2xl flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex justify-between items-center shrink-0">
          <h3 className="text-foreground font-medium">{isEdit ? 'Sửa trên Zalo' : 'Thêm lên Zalo'}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-2 bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-800/30">
            <span className="text-blue-400"><CloudIcon className="w-4 h-4" /></span>
            <p className="text-xs text-blue-300">Tài khoản: <strong>{accountName}</strong></p>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Phím tắt (Keyword)</label>
            <div className="relative">
              <span className="absolute left-3 top-2 text-muted-foreground text-sm">/</span>
              <input type="text" value={keyword}
                onChange={e => setKeyword(e.target.value.replace(/\s/g, '').slice(0, 20))}
                placeholder="ten_phim_tat"
                className="w-full bg-muted text-foreground text-sm rounded-lg pl-6 pr-3 py-2 border border-input focus:border-blue-500 outline-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Nội dung tin nhắn</label>
            <textarea value={title} onChange={e => setTitle(e.target.value)} rows={4} placeholder="Nhập nội dung..."
              className="w-full bg-muted text-foreground text-sm rounded-lg px-3 py-2 border border-input focus:border-blue-500 outline-none resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5 font-medium">Ảnh đính kèm (tuỳ chọn)</label>
            {mediaPreview ? (
              <div className="relative inline-block">
                <img src={mediaPreview} alt="preview" className="w-24 h-24 rounded-xl object-cover border border-input"/>
                <button onClick={() => { setMediaPath(undefined); setMediaPreview(undefined); }}
                  className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white text-xs font-bold shadow">✕</button>
              </div>
            ) : (
              <button onClick={handlePickImage}
                className="flex items-center gap-2 px-3 py-2 bg-muted hover:bg-accent border border-input rounded-xl text-sm text-foreground/80 hover:text-foreground transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                </svg>
                Thêm ảnh
              </button>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-muted-foreground hover:text-foreground text-sm">Hủy</button>
          <button
            onClick={() => onSave({ keyword: keyword.trim(), title: title.trim(), mediaPath, itemId: isEdit ? initialData!.id : undefined })}
            disabled={!valid}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg disabled:opacity-40"
          >{isEdit ? 'Cập nhật' : 'Thêm lên Zalo'}</button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Modal: Clone A → B ───────────────────────────────────────────────────────
function CloneMsgModal({ accounts, onClose, onSave }: {
  accounts: AccountInfo[]; onClose: () => void;
  onSave: (source: string, target: string, mode: 'add' | 'replace') => void;
}) {
  const [source, setSource] = useState(accounts[0]?.zalo_id ?? '');
  const [target, setTarget] = useState(accounts.length > 1 ? accounts[1].zalo_id : '');
  const [mode, setMode] = useState<'add' | 'replace'>('add');

  const sourceOptions: AccountOption[] = accounts.map(a => ({ id: a.zalo_id, name: a.full_name || a.zalo_id, phone: a.phone, avatarUrl: a.avatar_url }));
  const targetOptions: AccountOption[] = accounts.filter(a => a.zalo_id !== source).map(a => ({ id: a.zalo_id, name: a.full_name || a.zalo_id, phone: a.phone, avatarUrl: a.avatar_url }));

  useEffect(() => {
    if (target === source) {
      const next = accounts.find(a => a.zalo_id !== source);
      setTarget(next?.zalo_id ?? '');
    }
  }, [source]);

  const valid = source && target && source !== target;

  return (
    <ModalWrapper onClose={onClose}>
      <div className="bg-card rounded-xl w-full max-w-sm border border-border shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex justify-between items-center">
          <h3 className="text-foreground font-medium">Sao chép tin nhắn nhanh</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2 border border-input"><ClipboardListIcon className="w-4 h-4 inline" /> Sao chép tin nhắn nhanh Local từ tài khoản nguồn sang đích.
          </p>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5">Từ tài khoản (Nguồn)</label>
            <AccountSelectorDropdown position="up-left" fullWidth options={sourceOptions} activeId={source} onSelect={setSource} placeholder="Chọn tài khoản nguồn..." />
          </div>
          <div className="flex justify-center text-xl text-muted-foreground">⬇️</div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1.5">Sang tài khoản (Đích)</label>
            {targetOptions.length === 0
              ? <p className="text-xs text-muted-foreground italic px-2">Không có tài khoản đích khả dụng</p>
              : <AccountSelectorDropdown position="up-left" fullWidth options={targetOptions} activeId={target} onSelect={setTarget} placeholder="Chọn tài khoản đích..." />
            }
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-2 font-medium">Chế độ sao chép</label>
            <div className="space-y-2">
              <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${mode === 'add' ? 'border-blue-500 bg-blue-500/10' : 'border-input hover:border-border-strong'}`}>
                <input type="radio" name="clone-mode" value="add" checked={mode === 'add'} onChange={() => setMode('add')} className="mt-0.5 accent-blue-500" />
                <div>
                  <p className="text-sm font-semibold text-foreground">➕ Thêm mới</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Chỉ thêm keyword chưa có ở đích. Không ghi đè.</p>
                </div>
              </label>
              <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${mode === 'replace' ? 'border-red-500 bg-red-500/10' : 'border-input hover:border-border-strong'}`}>
                <input type="radio" name="clone-mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} className="mt-0.5 accent-red-500" />
                <div>
                  <p className="text-sm font-semibold text-red-300"><RefreshIcon className="w-4 h-4 inline" /> Thay thế (Ghi đè)</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Trùng keyword sẽ bị ghi đè bởi bản từ nguồn.</p>
                </div>
              </label>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-muted-foreground hover:text-foreground text-sm">Hủy</button>
          <button onClick={() => onSave(source, target, mode)} disabled={!valid}
            className={`px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-40 ${mode === 'replace' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}
          >{mode === 'replace' ? <><RefreshIcon className="w-4 h-4 inline" /> Thay thế</> : <><PlusIcon className="w-4 h-4 inline" /> Thêm mới</>}</button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Modal: Sync Zalo → Local ─────────────────────────────────────────────────
function SyncModal({ accountName, zaloCount, onClose, onSave }: {
  accountName: string; zaloCount: number; onClose: () => void; onSave: (mode: 'replace' | 'merge') => void;
}) {
  return (
    <ModalWrapper onClose={onClose}>
      <div className="bg-card rounded-xl w-full max-w-sm border border-border shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex justify-between items-center">
          <h3 className="text-foreground font-medium">Đồng bộ Zalo → Local</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-blue-900/20 rounded-lg px-3 py-2.5 border border-blue-800/30 space-y-0.5">
            <p className="text-xs text-blue-300"><CloudIcon className="w-4 h-4 inline" /> Tài khoản: <strong>{accountName}</strong></p>
            <p className="text-xs text-blue-300"><ChartIcon className="w-4 h-4 inline" /> Số tin nhắn sẽ đồng bộ: <strong>{zaloCount}</strong></p>
          </div>
          <p className="text-xs text-muted-foreground font-medium pt-1">Chọn chế độ đồng bộ:</p>
          <button onClick={() => onSave('merge')}
            className="w-full bg-muted hover:bg-accent border border-input rounded-xl p-3.5 text-left transition-colors">
            <p className="text-sm font-semibold text-foreground">➕ Thêm vào (Merge)</p>
            <p className="text-xs text-muted-foreground mt-0.5">Chỉ thêm keyword mới chưa có trong Local. Không ghi đè.</p>
          </button>
          <button onClick={() => onSave('replace')}
            className="w-full bg-muted hover:bg-red-900/30 border border-input hover:border-red-700/50 rounded-xl p-3.5 text-left transition-colors">
            <p className="text-sm font-semibold text-red-300"><RefreshIcon className="w-4 h-4 inline" /> Thay thế hoàn toàn (Replace)</p>
            <p className="text-xs text-muted-foreground mt-0.5">Xóa toàn bộ Local của tài khoản này và thay bằng dữ liệu từ Zalo.</p>
          </button>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-muted-foreground hover:text-foreground text-sm">Hủy</button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Modal: Delete a quick message shared by several accounts ────────────────
// A label is deleted for every account at once (one row). A shared local quick message is one
// row per account, so let the user pick: only the clicked account, or every account sharing it.
function DeleteSharedModal({ item, copies, nameOf, onClose, onDelete }: {
  item: LocalQMItem; copies: LocalQMItem[];
  nameOf: (zaloId: string) => string;
  onClose: () => void; onDelete: (rows: LocalQMItem[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (rows: LocalQMItem[]) => {
    setBusy(true);
    try { await onDelete(rows); } finally { setBusy(false); }
  };
  const close = busy ? () => {} : onClose;
  return (
    <ModalWrapper onClose={close}>
      <div className="bg-card rounded-xl w-full max-w-sm border border-border shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex justify-between items-center">
          <h3 className="text-foreground font-medium">Xóa tin nhắn nhanh /{item.keyword}?</h3>
          <button onClick={close} disabled={busy} className="text-muted-foreground hover:text-foreground disabled:opacity-40">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-muted-foreground bg-muted rounded-lg px-3 py-2.5 border border-input">
            <UsersIcon className="w-4 h-4 inline" /> Đang dùng chung cho <strong className="text-foreground">{copies.length} tài khoản</strong>: {formatAccountNames(copies.map(c => c.owner_zalo_id), nameOf, 5)}.
          </p>
          <button onClick={() => run([item])} disabled={busy}
            className="w-full bg-muted hover:bg-accent border border-input rounded-xl p-3.5 text-left transition-colors disabled:opacity-50">
            <p className="text-sm font-semibold text-foreground">Chỉ xóa ở {nameOf(item.owner_zalo_id)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Các tài khoản khác vẫn giữ /{item.keyword}.</p>
          </button>
          <button onClick={() => run(copies)} disabled={busy}
            className="w-full bg-muted hover:bg-destructive/10 border border-input hover:border-destructive/40 rounded-xl p-3.5 text-left transition-colors disabled:opacity-50">
            <p className="text-sm font-semibold text-destructive">Xóa ở cả {copies.length} tài khoản</p>
            <p className="text-xs text-muted-foreground mt-0.5">Hành động này không thể hoàn tác.</p>
          </button>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end">
          <button onClick={close} disabled={busy} className="px-4 py-2 text-muted-foreground hover:text-foreground text-sm disabled:opacity-40">Hủy</button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Help Modal ───────────────────────────────────────────────────────────────
function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-card rounded-xl border border-border p-6 max-w-lg w-full mx-4 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-muted-foreground hover:text-foreground">✕</button>
        <h3 className="text-lg font-bold text-foreground mb-4"><LightningIcon className="w-4 h-4 inline" /> Hướng dẫn - Tin nhắn nhanh</h3>

        {/* Comparison table */}
        <div className="grid grid-cols-2 gap-3 mb-5 text-xs">
          {/* Local */}
          <div className="bg-blue-950/40 border border-blue-800/40 rounded-xl p-3.5">
            <p className="font-bold text-blue-400 mb-2.5 flex items-center gap-1.5"><HardDriveIcon className="w-4 h-4 inline" /> Local <span className="text-[11px] font-normal text-blue-500/70 bg-blue-900/30 px-1.5 py-0.5 rounded">Khuyến nghị</span></p>
            <ul className="space-y-1.5 text-foreground/80">
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span><strong className="text-foreground">Không giới hạn</strong> số lượng tin nhắn tạo ra</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Đính kèm <strong className="text-foreground">nhiều ảnh + video</strong> cùng lúc</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Dùng chung cho nhiều tài khoản</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Sắp xếp thứ tự, bật/tắt từng mục</span></li>
              <li className="flex items-start gap-1.5"><span className="text-yellow-500 mt-0.5 shrink-0">−</span><span className="text-muted-foreground">Không đồng bộ điện thoại Zalo</span></li>
            </ul>
          </div>
          {/* Zalo */}
          <div className="bg-muted border border-border/60 rounded-xl p-3.5">
            <p className="font-bold text-muted-foreground mb-2.5 flex items-center gap-1.5"><CloudIcon className="w-4 h-4 inline" /> Zalo</p>
            <ul className="space-y-1.5 text-muted-foreground">
              <li className="flex items-start gap-1.5"><span className="text-red-400 mt-0.5 shrink-0">✗</span><span><strong className="text-red-300">Chỉ 1 tin nhắn nhanh</strong> - Zalo giới hạn rất ít</span></li>
              <li className="flex items-start gap-1.5"><span className="text-red-400 mt-0.5 shrink-0">✗</span><span>Chỉ đính kèm <strong className="text-red-300">1 ảnh</strong>, không hỗ trợ video</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span className="text-muted-foreground">Đồng bộ trên điện thoại Zalo</span></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-border pt-4 space-y-1.5 text-xs text-muted-foreground">
          <p className="text-foreground/80 font-semibold mb-2"><ClipboardListIcon className="w-4 h-4 inline" /> Các tính năng</p>
          <p><HardDriveIcon className="w-4 h-4 inline" /> <strong className="text-foreground/80">Local:</strong> Tạo/sửa/xóa, đính kèm ảnh+video, áp dụng cho nhiều tài khoản cùng lúc.</p>
          <p><UsersIcon className="w-4 h-4 inline" /> <strong className="text-foreground/80">Dùng chung:</strong> Cùng phím tắt và nội dung ở nhiều tài khoản được sửa/xóa một lần; bỏ chọn tài khoản khi sửa sẽ gỡ tin nhắn khỏi tài khoản đó.</p>
          <p><CloudIcon className="w-4 h-4 inline" /> <strong className="text-foreground/80">Zalo:</strong> Xem & quản lý trực tiếp trên server Zalo. Cần tài khoản kết nối.</p>
          <p><InboxIcon className="w-4 h-4 inline" /> <strong className="text-foreground/80">Đồng bộ về Local:</strong> Kéo tin nhắn Zalo về Local (Merge hoặc Replace).</p>
          <p><ClipboardListIcon className="w-4 h-4 inline" /> <strong className="text-foreground/80">Sao chép:</strong> Copy tin nhắn Local từ tài khoản A sang B.</p>
          <p>↕️ <strong className="text-foreground/80">Kéo thả:</strong> Kéo icon ⠿ để sắp xếp thứ tự hiển thị.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
interface Props {
  accounts: AccountInfo[];
  filterAccounts: string[];
  searchText: string;
}

export default function QuickMessageSettings({ accounts, filterAccounts, searchText }: Props) {
  const showNotification = useAppStore(s => s.showNotification);
  const [source, setSource] = useState<QuickMsgSource>('local');
  const [showHelp, setShowHelp] = useState(false);

  // Remote quick messages exist only for Zalo. A standalone Telegram/Facebook
  // settings context must stay on Local instead of loading Zalo data.
  const hideZaloTab = filterAccounts.length > 0 && filterAccounts.every(id => {
    const acc = accounts.find(a => a.zalo_id === id);
    return !isZalo(acc?.channel);
  });
  const effectiveSource: QuickMsgSource = hideZaloTab ? 'local' : source;

  useEffect(() => {
    if (hideZaloTab && source !== 'local') setSource('local');
  }, [hideZaloTab, source]);

  // ─── State ──────────────────────────────────────────────────────────────
  const [localMessages, setLocalMessages] = useState<LocalQMItem[]>([]);
  const [zaloMessages, setZaloMessages] = useState<QuickMessage[]>([]);
  const [zaloLoading, setZaloLoading] = useState(false);

  // Modals
  const [localMsgModal, setLocalMsgModal] = useState<{ open: boolean; data: LocalQMItem | null }>({ open: false, data: null });
  const [zaloMsgModal, setZaloMsgModal] = useState<{ open: boolean; data: QuickMessage | null }>({ open: false, data: null });
  const [cloneMsgModal, setCloneMsgModal] = useState(false);
  const [syncModal, setSyncModal] = useState(false);
  const [deleteSharedModal, setDeleteSharedModal] = useState<{ item: LocalQMItem; copies: LocalQMItem[] } | null>(null);

  // Drag & drop
  const qmDragFromRef = useRef<number | null>(null);
  const qmDragOverRef = useRef<number | null>(null);
  const [qmDragging, setQMDragging] = useState<number | null>(null);
  const [qmDragOver, setQMDragOver] = useState<number | null>(null);

  // For zalo operations, use the single selected account (if exactly 1)
  const activeZaloId = filterAccounts.length === 1 ? filterAccounts[0] : null;
  const selectedAccount = accounts.find(a => a.zalo_id === activeZaloId);
  const isConnected = selectedAccount?.isConnected ?? false;

  // Show account badge when 0 or 2+ accounts are in the filter
  const showAccountBadge = filterAccounts.length !== 1;

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const buildAuth = (zaloId: string) => {
    const acc = accounts.find(a => a.zalo_id === zaloId);
    if (!acc) return null;
    return buildZaloAuth(acc);
  };

  const getAccountName = (zaloId: string) => {
    if (!zaloId) return 'Unknown';
    const acc = accounts.find(a => a.zalo_id === zaloId);
    return acc ? (acc.full_name || acc.zalo_id || zaloId) : zaloId;
  };

  const getAccountPhone = (zaloId: string) => accounts.find(a => a.zalo_id === zaloId)?.phone || '';
  const getAccountAvatar = (zaloId: string) => accounts.find(a => a.zalo_id === zaloId)?.avatar_url;

  // ─── Fetch ────────────────────────────────────────────────────────────────
  const fetchLocalMessages = async () => {
    try {
      const res = await DataAccessor.getAllLocalQuickMessages();
      if (res?.success) setLocalMessages((res.items || []).map(mapDbRowToLocalQMItem));
    } catch (err) { console.error(err); }
  };

  const fetchZaloMsgs = async (zaloId: string) => {
    const auth = buildAuth(zaloId);
    if (!auth) return;
    setZaloLoading(true);
    setZaloMessages([]);
    try {
      const data = await fetchZaloQuickMessages(auth, zaloId, true);
      setZaloMessages(data);
    } catch (err: any) {
      showNotification(err?.message || 'Không thể tải từ Zalo', 'error');
    } finally {
      setZaloLoading(false);
    }
  };

  useEffect(() => { fetchLocalMessages(); }, []);

  useEffect(() => {
    if (effectiveSource === CHANNEL.ZALO && activeZaloId && isConnected) {
      fetchZaloMsgs(activeZaloId);
    } else if (effectiveSource === CHANNEL.ZALO) {
      setZaloMessages([]);
    }
  }, [source, activeZaloId]);

  // ─── Filtered ────────────────────────────────────────────────────────────
  const filteredLocalMessages = useMemo(() => {
    const q = searchText.toLowerCase();
    return localMessages
      .filter(m => {
        if (filterAccounts.length > 0 && !filterAccounts.includes(m.owner_zalo_id)) return false;
        const text = (m.message?.title || '').toLowerCase();
        return !q || m.keyword.toLowerCase().includes(q) || text.includes(q);
      })
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.keyword || '').localeCompare(b.keyword || ''));
  }, [localMessages, filterAccounts, searchText]);

  const filteredZaloMessages = useMemo(() => {
    const q = searchText.toLowerCase();
    return zaloMessages.filter(m => {
      const text = String(m.message?.title || '').toLowerCase();
      return !q || String(m.keyword || '').toLowerCase().includes(q) || text.includes(q);
    });
  }, [zaloMessages, searchText]);

  // Row id → every known account's copy of the same quick message (same keyword + content):
  // the quick-message counterpart of a label's page_ids.
  const sharedById = useMemo(() => {
    const known = new Set(accounts.map(a => a.zalo_id));
    const byId = new Map<number, LocalQMItem[]>();
    for (const group of groupSharedCopies(localMessages.filter(m => known.has(m.owner_zalo_id))).values()) {
      for (const row of group) byId.set(row.id, group);
    }
    return byId;
  }, [localMessages, accounts]);
  const sharedCopiesOf = (item: LocalQMItem) => sharedById.get(item.id) ?? [item];

  // ─── Local Quick Msg Actions ──────────────────────────────────────────────
  const deleteLocalRows = async (keyword: string, rows: LocalQMItem[]) => {
    const removed: string[] = [];
    const failed: Array<{ zaloId: string; error?: string }> = [];
    for (const row of rows) {
      try {
        const res: any = await DataAccessor.deleteLocalQuickMessage({ zaloId: row.owner_zalo_id, id: row.id });
        if (!res?.success) throw new Error(res?.error || 'Xóa thất bại');
        removed.push(row.owner_zalo_id);
      } catch (err: any) {
        failed.push({ zaloId: row.owner_zalo_id, error: err?.message });
      }
    }
    setDeleteSharedModal(null);
    fetchLocalMessages();
    const summary = summarizeQuickMessageResult({ keyword, removed, failed, mode: 'delete' }, getAccountName);
    showNotification(summary.message, summary.type);
  };

  const handleDeleteLocalMsg = async (item: LocalQMItem) => {
    const copies = sharedCopiesOf(item);
    if (copies.length > 1) {
      setDeleteSharedModal({ item, copies });
      return;
    }
    const ok = await showConfirm({ title: 'Xóa tin nhắn nhanh?', message: 'Hành động này không thể hoàn tác.', variant: 'danger' });
    if (!ok) return;
    await deleteLocalRows(item.keyword, [item]);
  };

  const handleSaveLocalMsg = async (data: LocalMsgSaveData) => {
    const { keyword, title } = data;
    if (!keyword || !title) return;

    // Plan against fresh rows: the chat composer, another window or an employee may have
    // changed quick messages since this list was loaded.
    let rows = localMessages;
    try {
      const res = await DataAccessor.getAllLocalQuickMessages();
      if (res?.success && Array.isArray(res.items)) rows = res.items.map(mapDbRowToLocalQMItem);
    } catch { /* keep the loaded list */ }

    const plan = planQuickMessageSave({
      items: rows, keyword,
      signature: qmContentSignature(title, data.localMediaFiles, data.zaloMedia),
      selected: data.selected, original: data.original, conflictMode: data.conflictMode,
    });
    if (plan.actions.length === 0) {
      showNotification(summarizeQuickMessageResult({ keyword, skipped: plan.skipped }, getAccountName).message, 'warning');
      return;
    }

    // Media for one account. Files already stored with the opened item keep their path (an
    // account sharing it keeps its own copy). New files go through uploadMediaFile per account:
    // standalone/boss returns the path unchanged; employee mode uploads a copy into THAT account's
    // media folder on the boss, so its auto-delete / account removal cannot break the others.
    const existingPaths = new Set(data.existingMediaPaths);
    const mediaFor = async (zaloId: string, ownMedia?: QMMediaFile[]) => {
      if (!data.localMediaFiles.length) return data.zaloMedia || undefined;
      const files: LocalMediaFile[] = [];
      for (const f of data.localMediaFiles) {
        if (existingPaths.has(f.path)) {
          files.push(pickOwnMediaCopy(f, ownMedia));
          continue;
        }
        const up = await DataAccessor.uploadMediaFile(f.path, zaloId);
        if (!up.success || !up.bossPath) {
          throw new Error(`Không tải được ${mediaFileName(f.path)}${up.error ? `: ${up.error}` : ''}`);
        }
        files.push({ ...f, path: up.bossPath });
      }
      return { localFiles: files };
    };

    const saved: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ zaloId: string; error?: string }> = [];
    for (const action of plan.actions) {
      try {
        if (action.upsert) {
          const media = await mediaFor(action.zaloId, action.ownMedia);
          const res: any = await DataAccessor.upsertLocalQuickMessage({ zaloId: action.zaloId, item: { keyword, title, media } });
          if (!res?.success) throw new Error(res?.error || 'Lưu thất bại');
          const newId: number | undefined = res.id ?? res.data?.id;
          if (action.carry && newId) {
            // Renamed copy = new row: keep it disabled / at its position like the old row.
            try {
              if (action.carry.isActive !== 1) await DataAccessor.setLocalQMActive({ id: newId, isActive: action.carry.isActive });
              if (action.carry.sortOrder) await DataAccessor.setLocalQMOrder({ id: newId, order: action.carry.sortOrder });
            } catch { /* cosmetic, the message itself is saved */ }
          }
        }
        if (action.deleteRowId !== undefined) {
          const res: any = await DataAccessor.deleteLocalQuickMessage({ zaloId: action.zaloId, id: action.deleteRowId });
          if (!res?.success) throw new Error(res?.error || 'Không gỡ được bản cũ');
        }
        (action.upsert ? saved : removed).push(action.zaloId);
      } catch (err: any) {
        failed.push({ zaloId: action.zaloId, error: err?.message || String(err) });
      }
    }

    fetchLocalMessages();
    const summary = summarizeQuickMessageResult({ keyword, saved, removed, skipped: plan.skipped, failed }, getAccountName);
    showNotification(summary.message, summary.type);
    // Nothing went through → keep the dialog (and what was typed) so the user can retry.
    if (saved.length || removed.length) setLocalMsgModal({ open: false, data: null });
  };

  const handleToggleQMActive = async (item: LocalQMItem) => {
    const newVal = (item.is_active ?? 1) === 1 ? 0 : 1;
    await DataAccessor.setLocalQMActive({ id: item.id, isActive: newVal });
    fetchLocalMessages();
  };

  const handleCloneLocalMessages = async (sourceId: string, targetId: string, mode: 'add' | 'replace') => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (mode === 'replace') {
      const res = await DataAccessor.cloneLocalQuickMessages({ sourceZaloId: sourceId, targetZaloId: targetId });
      if (res?.success) {
        fetchLocalMessages(); setCloneMsgModal(false);
        showNotification(`Đã sao chép ${(res as any).count ?? ''} tin nhắn nhanh (thay thế)`);
      } else { showNotification(res?.error || 'Sao chép thất bại', 'error'); }
    } else {
      const sourceItems = localMessages.filter(m => m.owner_zalo_id === sourceId);
      const targetKeywords = new Set(localMessages.filter(m => m.owner_zalo_id === targetId).map(m => m.keyword));
      let count = 0;
      for (const msg of sourceItems) {
        if (!targetKeywords.has(msg.keyword)) {
          const mediaObj = msg._localMedia?.length ? { localFiles: msg._localMedia } : (msg.media || undefined);
          await DataAccessor.upsertLocalQuickMessage({ zaloId: targetId, item: { keyword: msg.keyword, title: msg.message?.title || '', media: mediaObj } });
          count++;
        }
      }
      fetchLocalMessages(); setCloneMsgModal(false);
      showNotification(`Đã thêm ${count} tin nhắn nhanh mới`);
    }
  };

  const handleSyncZaloToLocal = async (mode: 'replace' | 'merge') => {
    if (!activeZaloId || !zaloMessages.length) return;
    const items = zaloMessages.map(m => ({
      keyword: m.keyword || '',
      title: String(m.message?.title || ''),
      media: m.media || undefined,
    })).filter(m => m.keyword && m.title);
    if (mode === 'replace') {
      await DataAccessor.bulkReplaceLocalQuickMessages({ zaloId: activeZaloId, items });
    } else {
      const existing = new Set(localMessages.filter(m => m.owner_zalo_id === activeZaloId).map(m => m.keyword));
      for (const item of items) {
        if (!existing.has(item.keyword)) await DataAccessor.upsertLocalQuickMessage({ zaloId: activeZaloId, item });
      }
    }
    invalidateZaloQuickMessageCache(activeZaloId);
    fetchLocalMessages(); setSyncModal(false);
    showNotification(`Đã đồng bộ ${items.length} tin nhắn về Local (${mode === 'replace' ? 'thay thế' : 'thêm mới'})`);
  };

  // ─── Zalo Quick Msg Actions ───────────────────────────────────────────────
  const handleDeleteZaloMsg = async (item: QuickMessage) => {
    if (!activeZaloId) return;
    const ok = await showConfirm({ title: 'Xóa tin nhắn nhanh trên Zalo?', message: 'Sẽ xóa trực tiếp trên Zalo.', variant: 'danger' });
    if (!ok) return;
    const auth = buildAuth(activeZaloId);
    if (!auth) return;
    const res = await ipc.zalo?.removeQuickMessage({ auth, itemIds: [item.id] });
    if (res?.success) {
      invalidateZaloQuickMessageCache(activeZaloId);
      fetchZaloMsgs(activeZaloId); showNotification('Đã xóa trên Zalo');
    } else { showNotification(res?.error || 'Xóa thất bại', 'error'); }
  };

  const handleSaveZaloMsg = async (data: { keyword: string; title: string; mediaPath?: string; itemId?: number }) => {
    if (!data.keyword || !data.title || !activeZaloId) return;
    const auth = buildAuth(activeZaloId);
    if (!auth) return;
    const res = data.itemId !== undefined
      ? await ipc.zalo?.updateQuickMessage({ auth, keyword: data.keyword, title: data.title, mediaPath: data.mediaPath, itemId: data.itemId })
      : await ipc.zalo?.addQuickMessage({ auth, keyword: data.keyword, title: data.title, mediaPath: data.mediaPath });
    if (res?.success) {
      invalidateZaloQuickMessageCache(activeZaloId);
      fetchZaloMsgs(activeZaloId);
      setZaloMsgModal({ open: false, data: null });
      showNotification(data.itemId !== undefined ? 'Đã cập nhật trên Zalo' : 'Đã thêm lên Zalo');
    } else { showNotification(res?.error || 'Thao tác thất bại', 'error'); }
  };

  // ─── Drag Reorder ─────────────────────────────────────────────────────────
  const handleQMReorder = async (items: LocalQMItem[]) => {
    const from = qmDragFromRef.current;
    const over = qmDragOverRef.current;
    qmDragFromRef.current = null; qmDragOverRef.current = null;
    setQMDragging(null); setQMDragOver(null);
    if (from === null || over === null || from === over) return;
    const reordered = [...items];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(over, 0, moved);
    for (let i = 0; i < reordered.length; i++) {
      await DataAccessor.setLocalQMOrder({ id: reordered[i].id, order: i + 1 });
    }
    fetchLocalMessages();
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Sub-tabs + Actions header */}
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
        <div className="flex bg-muted rounded-lg p-1 gap-1">
          {([
            { id: 'local' as const, label: 'Local' },
            ...(!hideZaloTab ? [{ id: 'zalo' as const, label: 'Zalo' }] : []),
          ] as const).map(src => (
            <button key={src.id} onClick={() => setSource(src.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap
                ${effectiveSource === src.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >{src.label}</button>
          ))}
        </div>
        {/* Help button - right next to tabs */}
        <button onClick={() => setShowHelp(true)} title="Hướng dẫn sử dụng"
          className="p-1.5 hover:bg-muted rounded-full text-muted-foreground hover:text-primary transition-colors">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>
        {/* Action buttons */}
        <div className="ml-auto flex items-center gap-2">
          {effectiveSource === 'local' && (<>
            <button onClick={() => setCloneMsgModal(true)}
              className="bg-card hover:bg-muted text-foreground/80 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 border border-input"><ClipboardListIcon className="w-4 h-4 inline" /> Sao chép
            </button>
            <button onClick={() => setLocalMsgModal({ open: true, data: null })}
              className="bg-primary hover:bg-primary-hover text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm mới
            </button>
          </>)}
          {effectiveSource === CHANNEL.ZALO && activeZaloId && (<>
            {zaloMessages.length > 0 && (
              <button onClick={() => setSyncModal(true)}
                className="bg-card hover:bg-muted text-foreground/80 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 border border-input"><InboxIcon className="w-4 h-4 inline" /> Đồng bộ về Local
              </button>
            )}
            <button onClick={() => setZaloMsgModal({ open: true, data: null })} disabled={!isConnected}
              className="bg-primary hover:bg-primary-hover text-primary-foreground text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title={isConnected ? undefined : 'Tài khoản chưa kết nối'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm lên Zalo
            </button>
          </>)}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {/* Local Quick Msgs */}
        {effectiveSource === 'local' && (
          filteredLocalMessages.length === 0
            ? <EmptyState icon={<LightningIcon className="w-4 h-4" />} title="Chưa có tin nhắn nhanh" subtitle='Nhấn "Thêm mới" để tạo tin nhắn nhanh đầu tiên.' />
            : filteredLocalMessages.map((item, idx) => (
              <div key={item.id} draggable
                onDragStart={() => { qmDragFromRef.current = idx; qmDragOverRef.current = idx; setQMDragging(idx); }}
                onDragEnter={() => { qmDragOverRef.current = idx; setQMDragOver(idx); }}
                onDragOver={e => e.preventDefault()}
                onDragEnd={() => handleQMReorder(filteredLocalMessages)}
                className={qmDragOver === idx && qmDragging !== idx ? 'ring-2 ring-primary/50 rounded-xl' : ''}
              >
                <LocalMsgRow item={item}
                  accountName={getAccountName(item.owner_zalo_id)}
                  accountPhone={getAccountPhone(item.owner_zalo_id)}
                  accountAvatarUrl={getAccountAvatar(item.owner_zalo_id)}
                  showAccountBadge={showAccountBadge}
                  sharedCount={sharedCopiesOf(item).length}
                  sharedNames={formatAccountNames(sharedCopiesOf(item).map(c => c.owner_zalo_id), getAccountName, 10)}
                  onEdit={() => setLocalMsgModal({ open: true, data: item })}
                  onDelete={() => handleDeleteLocalMsg(item)}
                  onToggleActive={() => handleToggleQMActive(item)}
                  isDragging={qmDragging === idx}
                />
              </div>
            ))
        )}

        {/* Zalo Quick Msgs */}
        {effectiveSource === CHANNEL.ZALO && (<>
          {!activeZaloId && (
            <EmptyState icon={<CloudIcon className="w-4 h-4" />} title="Chọn đúng 1 tài khoản" subtitle="Vui lòng chọn chính xác 1 tài khoản để xem tin nhắn nhanh trên Zalo." />
          )}
          {activeZaloId && !isConnected && (
            <EmptyState icon={<PluginIcon className="w-4 h-4" />} title="Tài khoản chưa kết nối" subtitle="Vui lòng kết nối tài khoản để quản lý tin nhắn nhanh trên Zalo." />
          )}
          {activeZaloId && isConnected && zaloLoading && (
            <div className="text-center py-14">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"/>
              <p className="text-muted-foreground text-sm">Đang tải từ Zalo...</p>
            </div>
          )}
          {activeZaloId && isConnected && !zaloLoading && filteredZaloMessages.length === 0 &&
            <EmptyState icon={<CloudIcon className="w-4 h-4" />} title="Chưa có tin nhắn nhanh trên Zalo" subtitle='Nhấn "Thêm lên Zalo" để tạo.' />
          }
          {activeZaloId && isConnected && !zaloLoading && filteredZaloMessages.map((item, idx) => (
            <ZaloMsgRow key={item.id ?? idx} item={item}
              onEdit={() => setZaloMsgModal({ open: true, data: item })}
              onDelete={() => handleDeleteZaloMsg(item)}
            />
          ))}
        </>)}
      </div>

      {/* Modals */}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {localMsgModal.open && (
        <LocalMsgModal
          initialData={localMsgModal.data}
          accounts={accounts}
          filterAccounts={filterAccounts}
          items={localMessages}
          nameOf={getAccountName}
          onClose={() => setLocalMsgModal({ open: false, data: null })}
          onSave={handleSaveLocalMsg}
        />
      )}
      {deleteSharedModal && (
        <DeleteSharedModal
          item={deleteSharedModal.item}
          copies={deleteSharedModal.copies}
          nameOf={getAccountName}
          onClose={() => setDeleteSharedModal(null)}
          onDelete={rows => deleteLocalRows(deleteSharedModal.item.keyword, rows)}
        />
      )}
      {zaloMsgModal.open && activeZaloId && (
        <ZaloMsgModal initialData={zaloMsgModal.data} accountName={getAccountName(activeZaloId)}
          onClose={() => setZaloMsgModal({ open: false, data: null })} onSave={handleSaveZaloMsg} />
      )}
      {cloneMsgModal && (
        <CloneMsgModal accounts={accounts} onClose={() => setCloneMsgModal(false)} onSave={handleCloneLocalMessages} />
      )}
      {syncModal && activeZaloId && (
        <SyncModal accountName={getAccountName(activeZaloId)} zaloCount={zaloMessages.length}
          onClose={() => setSyncModal(false)} onSave={handleSyncZaloToLocal} />
      )}
    </div>
  );
}

