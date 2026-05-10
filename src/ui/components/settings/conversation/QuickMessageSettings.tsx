import React, { useState, useEffect, useMemo, useRef } from 'react';
import ipc from '@/lib/ipc';
import { AccountInfo } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../../common/ConfirmDialog';
import AccountSelectorDropdown, { AccountOption } from '../../common/AccountSelectorDropdown';
import { QuickMessage, LocalMediaFile, fetchZaloQuickMessages, invalidateZaloQuickMessageCache } from '../../chat/QuickMessageManager';
import { toLocalMediaUrl } from '@/lib/localMedia';
import PhoneDisplay from '@/components/common/PhoneDisplay';

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
function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="text-center py-14">
      <p className="text-3xl mb-2">{icon}</p>
      <p className="text-gray-400 text-sm font-medium">{title}</p>
      <p className="text-gray-600 text-xs mt-1">{subtitle}</p>
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
          className="w-10 h-10 rounded-lg object-cover border border-gray-600" />
      )}
      {localFiles?.slice(0, 4).map((f, fi) => (
        <div key={fi} className="relative w-10 h-10 rounded-lg overflow-hidden border border-gray-600 flex-shrink-0 bg-gray-700">
          {f.type === 'image'
            ? <img src={toLocalMediaUrl(f.path)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center bg-gray-800">
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
        <span className="self-center text-[11px] text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded flex items-center gap-0.5">
          🖼 {localFiles.filter(f => f.type === 'image').length} ảnh
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
  showAccountBadge,
  onEdit, onDelete, onToggleActive, isDragging
}: {
  item: LocalQMItem;
  accountName: string; accountPhone: string; accountAvatarUrl?: string;
  showAccountBadge: boolean;
  onEdit: () => void; onDelete: () => void; onToggleActive: () => void;
  isDragging?: boolean;
}) {
  const isActive = (item.is_active ?? 1) === 1;
  return (
    <div className={`bg-gray-900 border rounded-xl p-3 hover:border-gray-600 transition-colors ${isDragging ? 'opacity-40' : ''} ${isActive ? 'border-gray-700/80' : 'border-gray-700/30 opacity-60'}`}>
      <div className="flex items-start gap-3">
        {/* Drag handle */}
        <div className="pt-2 shrink-0 cursor-grab text-gray-600 hover:text-gray-400 select-none" title="Kéo để sắp xếp">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
            <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
            <circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>
          </svg>
        </div>
        <div className="pt-0.5 shrink-0">
          <span className="bg-gray-800 text-blue-300 text-[11px] font-mono px-1.5 py-0.5 rounded border border-gray-700 whitespace-nowrap">
            /{item.keyword}
          </span>
          {(item.sort_order ?? 0) > 0 && (
            <span className="block mt-1 text-center text-[9px] text-gray-600 font-mono">#{item.sort_order}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 whitespace-pre-wrap line-clamp-2">{item.message?.title || ''}</p>
          <MediaThumbs item={item} />
        </div>
        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onToggleActive} title={isActive ? 'Tắt' : 'Bật'}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${isActive ? 'text-green-400 hover:bg-green-500/10' : 'text-gray-600 hover:bg-gray-700 hover:text-gray-400'}`}>
            {isActive
              ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/></svg>
              : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/></svg>
            }
          </button>
          <button onClick={onEdit} title="Sửa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button onClick={onDelete} title="Xóa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </div>
      {/* Account badge — only show when 2+ accounts are in filter */}
      {showAccountBadge && (
        <div className="mt-2 pl-[calc(theme(spacing.10)+theme(spacing.3))] flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 bg-gray-800 rounded-full px-2 py-0.5 border border-gray-700/50">
            {accountAvatarUrl ? (
              <img src={accountAvatarUrl} alt="" className="w-3.5 h-3.5 rounded-full object-cover shrink-0 border border-gray-600" />
            ) : (
              <div className="w-3 h-3 bg-blue-600 rounded-full flex items-center justify-center text-[7px] text-white font-bold uppercase shrink-0">
                {(accountName || '?').charAt(0)}
              </div>
            )}
            <span className="text-[11px] text-gray-400 truncate max-w-[140px]">{accountName}</span>
            <PhoneDisplay phone={accountPhone} className="text-xs text-gray-500" />
          </div>
        </div>
      )}
    </div>
  );
}

function ZaloMsgRow({ item, onEdit, onDelete }: { item: QuickMessage; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="bg-gray-900 border border-blue-900/30 rounded-xl p-3 hover:border-blue-700/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="pt-0.5 shrink-0">
          <span className="bg-blue-900/30 text-blue-300 text-[11px] font-mono px-1.5 py-0.5 rounded border border-blue-800/50 whitespace-nowrap">
            /{item.keyword || '?'}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 whitespace-pre-wrap line-clamp-2">{item.message?.title || '<Không có nội dung>'}</p>
          <MediaThumbs item={item} />
          <span className="text-[11px] text-blue-500/80 mt-1 flex items-center gap-1">☁️ Lưu trên Zalo</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button onClick={onEdit} title="Sửa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button onClick={onDelete} title="Xóa"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
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
function LocalMsgModal({
  initialData, accounts, filterAccounts, onClose, onSave,
}: {
  initialData: LocalQMItem | null;
  accounts: AccountInfo[];
  filterAccounts: string[];
  onClose: () => void;
  onSave: (data: {
    keyword: string; title: string; target_zalo_ids: string[]; owner_zalo_id?: string;
    original_id?: number; original_owner_zalo_id?: string; localMediaFiles?: LocalMediaFile[];
  }) => void;
}) {
  const isEdit = !!initialData;
  const [keyword, setKeyword] = useState(initialData?.keyword ?? '');
  const [title, setTitle] = useState(initialData?.message?.title ?? '');
  const [localMediaFiles, setLocalMediaFiles] = useState<LocalMediaFile[]>(initialData?._localMedia || []);

  // Edit mode: single account select
  const [editAccountId, setEditAccountId] = useState<string>(
    initialData?.owner_zalo_id || accounts[0]?.zalo_id || ''
  );

  // Add mode: multi-select checkboxes — pre-select filterAccounts or all
  const defaultSelected = !isEdit
    ? (filterAccounts.length > 0 ? filterAccounts : accounts.map(a => a.zalo_id))
    : [];
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set(defaultSelected));

  const toggleAccount = (id: string) => {
    const s = new Set(selectedAccountIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedAccountIds(s);
  };

  const editAccountOptions: AccountOption[] = accounts.map(a => ({
    id: a.zalo_id, name: a.full_name || a.zalo_id, phone: a.phone, avatarUrl: a.avatar_url,
  }));

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

  const valid = keyword.trim() && title.trim() && (isEdit ? !!editAccountId : selectedAccountIds.size > 0);

  const handleSave = () => {
    if (!valid) return;
    if (isEdit) {
      onSave({
        keyword: keyword.trim(), title: title.trim(),
        target_zalo_ids: [],
        owner_zalo_id: editAccountId,
        original_id: initialData!.id,
        original_owner_zalo_id: initialData!.owner_zalo_id,
        localMediaFiles: localMediaFiles.length > 0 ? localMediaFiles : undefined,
      });
    } else {
      onSave({
        keyword: keyword.trim(), title: title.trim(),
        target_zalo_ids: Array.from(selectedAccountIds),
        localMediaFiles: localMediaFiles.length > 0 ? localMediaFiles : undefined,
      });
    }
  };

  return (
    <ModalWrapper onClose={onClose}>
      <div className="bg-gray-800 rounded-xl w-full max-w-md border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-700 flex justify-between items-center shrink-0">
          <h3 className="text-white font-medium">{isEdit ? 'Sửa tin nhắn nhanh' : 'Thêm tin nhắn nhanh'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Keyword */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Phím tắt (Keyword)</label>
            <div className="relative">
              <span className="absolute left-3 top-2 text-gray-400 text-sm">/</span>
              <input type="text" value={keyword}
                onChange={e => setKeyword(e.target.value.replace(/\s/g, '').slice(0, 20))}
                placeholder="ten_phim_tat"
                className="w-full bg-gray-700 text-white text-sm rounded-lg pl-6 pr-3 py-2 border border-gray-600 focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          {/* Content */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Nội dung tin nhắn</label>
            <textarea value={title} onChange={e => setTitle(e.target.value)} rows={4}
              placeholder="Nhập nội dung tin nhắn nhanh..."
              className="w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600 focus:border-blue-500 outline-none resize-none"
            />
          </div>

          {/* Media */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400 font-medium">
                Media đính kèm <span className="text-gray-600">({localMediaFiles.length} file)</span>
              </label>
              {localMediaFiles.length > 0 && (
                <button onClick={() => setLocalMediaFiles([])} className="text-[11px] text-red-400 hover:text-red-300">Xóa tất cả</button>
              )}
            </div>
            {localMediaFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {localMediaFiles.map(f => (
                  <div key={f.path} className="relative group w-16 h-16 shrink-0">
                    {f.type === 'image'
                      ? <img src={toLocalMediaUrl(f.path)} alt="" className="w-full h-full rounded-xl object-cover border border-gray-600"/>
                      : <div className="w-full h-full rounded-xl border border-gray-600 bg-gray-700 flex flex-col items-center justify-center gap-1 relative overflow-hidden">
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
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-xs text-gray-300 hover:text-white transition-colors">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                </svg>
                Thêm ảnh
              </button>
              <button onClick={handlePickVideos}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-xs text-gray-300 hover:text-white transition-colors">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
                Thêm video
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-1.5">Ảnh/video sẽ được gửi kèm khi chọn tin nhắn nhanh này.</p>
          </div>

          {/* Tài khoản áp dụng */}
          <div className="border-t border-gray-700/50 pt-4">
            <label className="block text-xs text-gray-400 mb-2 font-medium">Tài khoản áp dụng</label>
            {accounts.length === 0 ? (
              <p className="text-xs text-gray-500 italic">Chưa có tài khoản nào</p>
            ) : isEdit ? (
              /* Edit mode: single account selector */
              <>
                <AccountSelectorDropdown
                  options={editAccountOptions}
                  activeId={editAccountId}
                  onSelect={setEditAccountId}
                  placeholder="Chọn tài khoản..."
                  position="up-left"
                  fullWidth
                />
                {editAccountId !== initialData!.owner_zalo_id && (
                  <p className="text-[11px] text-yellow-400/80 mt-1.5">
                    ⚠️ Tin nhắn sẽ được chuyển sang tài khoản mới.
                  </p>
                )}
              </>
            ) : (
              /* Add mode: multi-select checkboxes */
              <>
                <div className="max-h-40 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-700/50 bg-gray-900/50">
                  {accounts.map(acc => (
                    <label key={acc.zalo_id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-700/50 cursor-pointer">
                      <input type="checkbox"
                        checked={selectedAccountIds.has(acc.zalo_id)}
                        onChange={() => toggleAccount(acc.zalo_id)}
                        className="w-4 h-4 rounded bg-gray-600 border-gray-500 text-blue-600 focus:ring-blue-500 accent-blue-500"
                      />
                      {acc.avatar_url ? (
                        <img src={acc.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                          {(acc.full_name || acc.zalo_id || '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-200 truncate">{acc.full_name || acc.zalo_id}</p>
                        {acc.phone && <p className="text-[11px] text-gray-500">{acc.phone}</p>}
                      </div>
                    </label>
                  ))}
                </div>
                {selectedAccountIds.size > 0 && (
                  <p className="text-[11px] text-blue-400/80 mt-1.5">
                    ✅ Sẽ thêm cho {selectedAccountIds.size} tài khoản đã chọn.
                  </p>
                )}
                {selectedAccountIds.size === 0 && (
                  <p className="text-[11px] text-red-400/80 mt-1.5">
                    ⚠️ Chọn ít nhất 1 tài khoản.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-700 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
          <button onClick={handleSave} disabled={!valid}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
            {isEdit ? 'Lưu thay đổi' : (selectedAccountIds.size > 1 ? `Lưu (${selectedAccountIds.size} tài khoản)` : 'Lưu')}
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
      <div className="bg-gray-800 rounded-xl w-full max-w-md border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-700 flex justify-between items-center shrink-0">
          <h3 className="text-white font-medium">{isEdit ? 'Sửa trên Zalo' : 'Thêm lên Zalo'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-2 bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-800/30">
            <span className="text-blue-400 text-sm">☁️</span>
            <p className="text-xs text-blue-300">Tài khoản: <strong>{accountName}</strong></p>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Phím tắt (Keyword)</label>
            <div className="relative">
              <span className="absolute left-3 top-2 text-gray-400 text-sm">/</span>
              <input type="text" value={keyword}
                onChange={e => setKeyword(e.target.value.replace(/\s/g, '').slice(0, 20))}
                placeholder="ten_phim_tat"
                className="w-full bg-gray-700 text-white text-sm rounded-lg pl-6 pr-3 py-2 border border-gray-600 focus:border-blue-500 outline-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Nội dung tin nhắn</label>
            <textarea value={title} onChange={e => setTitle(e.target.value)} rows={4} placeholder="Nhập nội dung..."
              className="w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600 focus:border-blue-500 outline-none resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Ảnh đính kèm (tuỳ chọn)</label>
            {mediaPreview ? (
              <div className="relative inline-block">
                <img src={mediaPreview} alt="preview" className="w-24 h-24 rounded-xl object-cover border border-gray-600"/>
                <button onClick={() => { setMediaPath(undefined); setMediaPreview(undefined); }}
                  className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white text-xs font-bold shadow">✕</button>
              </div>
            ) : (
              <button onClick={handlePickImage}
                className="flex items-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-xl text-sm text-gray-300 hover:text-white transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                </svg>
                Thêm ảnh
              </button>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-700 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
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
      <div className="bg-gray-800 rounded-xl w-full max-w-sm border border-gray-700 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-700 flex justify-between items-center">
          <h3 className="text-white font-medium">Sao chép tin nhắn nhanh</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-400 bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600">
            📋 Sao chép tin nhắn nhanh Local từ tài khoản nguồn sang đích.
          </p>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Từ tài khoản (Nguồn)</label>
            <AccountSelectorDropdown position="up-left" fullWidth options={sourceOptions} activeId={source} onSelect={setSource} placeholder="Chọn tài khoản nguồn..." />
          </div>
          <div className="flex justify-center text-xl text-gray-600">⬇️</div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Sang tài khoản (Đích)</label>
            {targetOptions.length === 0
              ? <p className="text-xs text-gray-500 italic px-2">Không có tài khoản đích khả dụng</p>
              : <AccountSelectorDropdown position="up-left" fullWidth options={targetOptions} activeId={target} onSelect={setTarget} placeholder="Chọn tài khoản đích..." />
            }
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-2 font-medium">Chế độ sao chép</label>
            <div className="space-y-2">
              <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${mode === 'add' ? 'border-blue-500 bg-blue-500/10' : 'border-gray-600 hover:border-gray-500'}`}>
                <input type="radio" name="clone-mode" value="add" checked={mode === 'add'} onChange={() => setMode('add')} className="mt-0.5 accent-blue-500" />
                <div>
                  <p className="text-sm font-semibold text-gray-200">➕ Thêm mới</p>
                  <p className="text-xs text-gray-400 mt-0.5">Chỉ thêm keyword chưa có ở đích. Không ghi đè.</p>
                </div>
              </label>
              <label className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${mode === 'replace' ? 'border-red-500 bg-red-500/10' : 'border-gray-600 hover:border-gray-500'}`}>
                <input type="radio" name="clone-mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} className="mt-0.5 accent-red-500" />
                <div>
                  <p className="text-sm font-semibold text-red-300">🔄 Thay thế (Ghi đè)</p>
                  <p className="text-xs text-gray-400 mt-0.5">Trùng keyword sẽ bị ghi đè bởi bản từ nguồn.</p>
                </div>
              </label>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
          <button onClick={() => onSave(source, target, mode)} disabled={!valid}
            className={`px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-40 ${mode === 'replace' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}
          >{mode === 'replace' ? '🔄 Thay thế' : '➕ Thêm mới'}</button>
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
      <div className="bg-gray-800 rounded-xl w-full max-w-sm border border-gray-700 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-700 flex justify-between items-center">
          <h3 className="text-white font-medium">Đồng bộ Zalo → Local</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-blue-900/20 rounded-lg px-3 py-2.5 border border-blue-800/30 space-y-0.5">
            <p className="text-xs text-blue-300">☁️ Tài khoản: <strong>{accountName}</strong></p>
            <p className="text-xs text-blue-300">📊 Số tin nhắn sẽ đồng bộ: <strong>{zaloCount}</strong></p>
          </div>
          <p className="text-xs text-gray-400 font-medium pt-1">Chọn chế độ đồng bộ:</p>
          <button onClick={() => onSave('merge')}
            className="w-full bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-xl p-3.5 text-left transition-colors">
            <p className="text-sm font-semibold text-gray-200">➕ Thêm vào (Merge)</p>
            <p className="text-xs text-gray-400 mt-0.5">Chỉ thêm keyword mới chưa có trong Local. Không ghi đè.</p>
          </button>
          <button onClick={() => onSave('replace')}
            className="w-full bg-gray-700 hover:bg-red-900/30 border border-gray-600 hover:border-red-700/50 rounded-xl p-3.5 text-left transition-colors">
            <p className="text-sm font-semibold text-red-300">🔄 Thay thế hoàn toàn (Replace)</p>
            <p className="text-xs text-gray-400 mt-0.5">Xóa toàn bộ Local của tài khoản này và thay bằng dữ liệu từ Zalo.</p>
          </button>
        </div>
        <div className="px-5 py-3 border-t border-gray-700 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Help Modal ───────────────────────────────────────────────────────────────
function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 max-w-lg w-full mx-4 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">✕</button>
        <h3 className="text-lg font-bold text-white mb-4">⚡ Hướng dẫn — Tin nhắn nhanh</h3>

        {/* Comparison table */}
        <div className="grid grid-cols-2 gap-3 mb-5 text-xs">
          {/* Local */}
          <div className="bg-blue-950/40 border border-blue-800/40 rounded-xl p-3.5">
            <p className="font-bold text-blue-400 mb-2.5 flex items-center gap-1.5">💾 Local <span className="text-[11px] font-normal text-blue-500/70 bg-blue-900/30 px-1.5 py-0.5 rounded">Khuyến nghị</span></p>
            <ul className="space-y-1.5 text-gray-300">
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span><strong className="text-white">Không giới hạn</strong> số lượng tin nhắn tạo ra</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Đính kèm <strong className="text-white">nhiều ảnh + video</strong> cùng lúc</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Dùng chung cho nhiều tài khoản</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Sắp xếp thứ tự, bật/tắt từng mục</span></li>
              <li className="flex items-start gap-1.5"><span className="text-yellow-500 mt-0.5 shrink-0">−</span><span className="text-gray-500">Không đồng bộ điện thoại Zalo</span></li>
            </ul>
          </div>
          {/* Zalo */}
          <div className="bg-gray-900/60 border border-gray-700/60 rounded-xl p-3.5">
            <p className="font-bold text-gray-400 mb-2.5 flex items-center gap-1.5">☁️ Zalo</p>
            <ul className="space-y-1.5 text-gray-400">
              <li className="flex items-start gap-1.5"><span className="text-red-400 mt-0.5 shrink-0">✗</span><span><strong className="text-red-300">Chỉ 1 tin nhắn nhanh</strong> — Zalo giới hạn rất ít</span></li>
              <li className="flex items-start gap-1.5"><span className="text-red-400 mt-0.5 shrink-0">✗</span><span>Chỉ đính kèm <strong className="text-red-300">1 ảnh</strong>, không hỗ trợ video</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span className="text-gray-400">Đồng bộ trên điện thoại Zalo</span></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-700 pt-4 space-y-1.5 text-xs text-gray-400">
          <p className="text-gray-300 font-semibold mb-2">📋 Các tính năng</p>
          <p>💾 <strong className="text-gray-300">Local:</strong> Tạo/sửa/xóa, đính kèm ảnh+video, tạo cho nhiều tài khoản cùng lúc.</p>
          <p>☁️ <strong className="text-gray-300">Zalo:</strong> Xem & quản lý trực tiếp trên server Zalo. Cần tài khoản kết nối.</p>
          <p>📥 <strong className="text-gray-300">Đồng bộ về Local:</strong> Kéo tin nhắn Zalo về Local (Merge hoặc Replace).</p>
          <p>📋 <strong className="text-gray-300">Sao chép:</strong> Copy tin nhắn Local từ tài khoản A sang B.</p>
          <p>↕️ <strong className="text-gray-300">Kéo thả:</strong> Kéo icon ⠿ để sắp xếp thứ tự hiển thị.</p>
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
  const { showNotification } = useAppStore();
  const [source, setSource] = useState<QuickMsgSource>('local');
  const [showHelp, setShowHelp] = useState(false);

  // If all selected accounts are Facebook → hide Zalo tab, force Local
  const allFB = filterAccounts.length > 0 && filterAccounts.every(id => {
    const acc = accounts.find(a => a.zalo_id === id);
    return (acc?.channel || 'zalo') === 'facebook';
  });
  const effectiveSource: QuickMsgSource = allFB ? 'local' : source;

  // ─── State ──────────────────────────────────────────────────────────────
  const [localMessages, setLocalMessages] = useState<LocalQMItem[]>([]);
  const [zaloMessages, setZaloMessages] = useState<QuickMessage[]>([]);
  const [zaloLoading, setZaloLoading] = useState(false);

  // Modals
  const [localMsgModal, setLocalMsgModal] = useState<{ open: boolean; data: LocalQMItem | null }>({ open: false, data: null });
  const [zaloMsgModal, setZaloMsgModal] = useState<{ open: boolean; data: QuickMessage | null }>({ open: false, data: null });
  const [cloneMsgModal, setCloneMsgModal] = useState(false);
  const [syncModal, setSyncModal] = useState(false);

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
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
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
      const res = await ipc.db?.getAllLocalQuickMessages();
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
    if (effectiveSource === 'zalo' && activeZaloId && isConnected) {
      fetchZaloMsgs(activeZaloId);
    } else if (effectiveSource === 'zalo') {
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

  // ─── Local Quick Msg Actions ──────────────────────────────────────────────
  const handleDeleteLocalMsg = async (item: LocalQMItem) => {
    const ok = await showConfirm({ title: 'Xóa tin nhắn nhanh?', message: 'Hành động này không thể hoàn tác.', variant: 'danger' });
    if (!ok) return;
    await ipc.db?.deleteLocalQuickMessage({ zaloId: item.owner_zalo_id, id: item.id });
    fetchLocalMessages();
    showNotification('Đã xóa tin nhắn nhanh');
  };

  const handleSaveLocalMsg = async (data: {
    keyword: string; title: string; target_zalo_ids: string[]; owner_zalo_id?: string;
    original_id?: number; original_owner_zalo_id?: string; localMediaFiles?: LocalMediaFile[];
  }) => {
    if (!data.keyword || !data.title) return;
    if (data.original_id !== undefined && data.original_owner_zalo_id) {
      await ipc.db?.deleteLocalQuickMessage({ zaloId: data.original_owner_zalo_id, id: data.original_id });
    }
    const targets = data.owner_zalo_id ? [data.owner_zalo_id] : (data.target_zalo_ids || []);
    if (!targets.length) return;
    const mediaObj = data.localMediaFiles?.length ? { localFiles: data.localMediaFiles } : undefined;
    for (const zId of targets) {
      await ipc.db?.upsertLocalQuickMessage({ zaloId: zId, item: { keyword: data.keyword, title: data.title, media: mediaObj } });
    }
    setLocalMsgModal({ open: false, data: null });
    fetchLocalMessages();
    showNotification(targets.length > 1 ? `Đã lưu cho ${targets.length} tài khoản` : 'Đã lưu tin nhắn nhanh');
  };

  const handleToggleQMActive = async (item: LocalQMItem) => {
    const newVal = (item.is_active ?? 1) === 1 ? 0 : 1;
    await ipc.db?.setLocalQMActive({ id: item.id, isActive: newVal });
    fetchLocalMessages();
  };

  const handleCloneLocalMessages = async (sourceId: string, targetId: string, mode: 'add' | 'replace') => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    if (mode === 'replace') {
      const res = await ipc.db?.cloneLocalQuickMessages({ sourceZaloId: sourceId, targetZaloId: targetId });
      if (res?.success) {
        fetchLocalMessages(); setCloneMsgModal(false);
        showNotification(`Đã sao chép ${res.count ?? ''} tin nhắn nhanh (thay thế)`);
      } else { showNotification(res?.error || 'Sao chép thất bại', 'error'); }
    } else {
      const sourceItems = localMessages.filter(m => m.owner_zalo_id === sourceId);
      const targetKeywords = new Set(localMessages.filter(m => m.owner_zalo_id === targetId).map(m => m.keyword));
      let count = 0;
      for (const msg of sourceItems) {
        if (!targetKeywords.has(msg.keyword)) {
          const mediaObj = msg._localMedia?.length ? { localFiles: msg._localMedia } : (msg.media || undefined);
          await ipc.db?.upsertLocalQuickMessage({ zaloId: targetId, item: { keyword: msg.keyword, title: msg.message?.title || '', media: mediaObj } });
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
      await ipc.db?.bulkReplaceLocalQuickMessages({ zaloId: activeZaloId, items });
    } else {
      const existing = new Set(localMessages.filter(m => m.owner_zalo_id === activeZaloId).map(m => m.keyword));
      for (const item of items) {
        if (!existing.has(item.keyword)) await ipc.db?.upsertLocalQuickMessage({ zaloId: activeZaloId, item });
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
      await ipc.db?.setLocalQMOrder({ id: reordered[i].id, order: i + 1 });
    }
    fetchLocalMessages();
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Sub-tabs + Actions header */}
      <div className="bg-gray-800/30 px-4 py-2 border-b border-gray-800 flex items-center gap-2">
        <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
          {([
            { id: 'local' as const, label: '💾 Local' },
            ...(!allFB ? [{ id: 'zalo' as const, label: '☁️ Zalo' }] : []),
          ] as const).map(src => (
            <button key={src.id} onClick={() => setSource(src.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap
                ${effectiveSource === src.id ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'}`}
            >{src.label}</button>
          ))}
        </div>
        {/* Help button — right next to tabs */}
        <button onClick={() => setShowHelp(true)} title="Hướng dẫn sử dụng"
          className="p-1.5 hover:bg-gray-700 rounded-full text-gray-500 hover:text-blue-400 transition-colors">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>
        {/* Action buttons */}
        <div className="ml-auto flex items-center gap-2">
          {effectiveSource === 'local' && (<>
            <button onClick={() => setCloneMsgModal(true)}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 border border-gray-600">
              📋 Sao chép
            </button>
            <button onClick={() => setLocalMsgModal({ open: true, data: null })}
              className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm mới
            </button>
          </>)}
          {effectiveSource === 'zalo' && activeZaloId && (<>
            {zaloMessages.length > 0 && (
              <button onClick={() => setSyncModal(true)}
                className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 border border-gray-600">
                📥 Đồng bộ về Local
              </button>
            )}
            <button onClick={() => setZaloMsgModal({ open: true, data: null })} disabled={!isConnected}
              className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
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
            ? <EmptyState icon="⚡" title="Chưa có tin nhắn nhanh" subtitle='Nhấn "Thêm mới" để tạo tin nhắn nhanh đầu tiên.' />
            : filteredLocalMessages.map((item, idx) => (
              <div key={item.id} draggable
                onDragStart={() => { qmDragFromRef.current = idx; qmDragOverRef.current = idx; setQMDragging(idx); }}
                onDragEnter={() => { qmDragOverRef.current = idx; setQMDragOver(idx); }}
                onDragOver={e => e.preventDefault()}
                onDragEnd={() => handleQMReorder(filteredLocalMessages)}
                className={qmDragOver === idx && qmDragging !== idx ? 'ring-2 ring-blue-400/60 rounded-xl' : ''}
              >
                <LocalMsgRow item={item}
                  accountName={getAccountName(item.owner_zalo_id)}
                  accountPhone={getAccountPhone(item.owner_zalo_id)}
                  accountAvatarUrl={getAccountAvatar(item.owner_zalo_id)}
                  showAccountBadge={showAccountBadge}
                  onEdit={() => setLocalMsgModal({ open: true, data: item })}
                  onDelete={() => handleDeleteLocalMsg(item)}
                  onToggleActive={() => handleToggleQMActive(item)}
                  isDragging={qmDragging === idx}
                />
              </div>
            ))
        )}

        {/* Zalo Quick Msgs */}
        {effectiveSource === 'zalo' && (<>
          {!activeZaloId && (
            <EmptyState icon="☁️" title="Chọn đúng 1 tài khoản" subtitle="Vui lòng chọn chính xác 1 tài khoản để xem tin nhắn nhanh trên Zalo." />
          )}
          {activeZaloId && !isConnected && (
            <EmptyState icon="🔌" title="Tài khoản chưa kết nối" subtitle="Vui lòng kết nối tài khoản để quản lý tin nhắn nhanh trên Zalo." />
          )}
          {activeZaloId && isConnected && zaloLoading && (
            <div className="text-center py-14">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"/>
              <p className="text-gray-500 text-sm">Đang tải từ Zalo...</p>
            </div>
          )}
          {activeZaloId && isConnected && !zaloLoading && filteredZaloMessages.length === 0 &&
            <EmptyState icon="☁️" title="Chưa có tin nhắn nhanh trên Zalo" subtitle='Nhấn "Thêm lên Zalo" để tạo.' />
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
          onClose={() => setLocalMsgModal({ open: false, data: null })}
          onSave={handleSaveLocalMsg}
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

