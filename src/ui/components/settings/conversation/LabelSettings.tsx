import React, { useState, useEffect, useMemo, useRef } from 'react';
import ipc from '@/lib/ipc';
import { AccountInfo } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../../common/ConfirmDialog';
import AccountSelectorDropdown, { AccountOption } from '../../common/AccountSelectorDropdown';
import AccountMultiDropdown from '../../common/AccountMultiDropdown';
import { syncZaloLabelsToLocalDB } from '@/lib/labelUtils';
import { LabelEmojiPicker, KeyboardShortcutInput } from '../../common/LabelEmojiPicker';

// ─── Types ────────────────────────────────────────────────────────────────────
type LabelSource = 'local' | 'zalo';

export interface LocalLabel {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
  page_ids?: string;
  is_active?: number;
  sort_order?: number;
  shortcut?: string; // Phím tắt để gắn/gỡ nhanh (VD: "Ctrl + M")
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

// ─── LabelRow ─────────────────────────────────────────────────────────────────
function LabelRow({
  item, getAccountName, getAccountPhone, getAccountAvatar,
  onEdit, onDelete, onToggleActive, isDragging,
}: {
  item: LocalLabel;
  getAccountName: (id: string) => string;
  getAccountPhone: (id: string) => string;
  getAccountAvatar: (id: string) => string | undefined;
  onEdit: () => void; onDelete: () => void; onToggleActive: () => void;
  isDragging?: boolean;
}) {
  const pageIds = (item.page_ids || '').split(',').filter(Boolean);
  const isActive = (item.is_active ?? 1) === 1;
  return (
    <div className={`bg-gray-900 border rounded-xl p-3 hover:border-gray-600 transition-colors ${isDragging ? 'opacity-40' : ''} ${isActive ? 'border-gray-700/80' : 'border-gray-700/30 opacity-60'}`}>
      <div className="flex items-center gap-3">
        {/* Drag handle */}
        <div className="cursor-grab text-gray-600 hover:text-gray-400 select-none shrink-0" title="Kéo để sắp xếp">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/>
            <circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/>
            <circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/>
          </svg>
        </div>
        {/* Label preview */}
        <div className="px-2.5 py-1.5 rounded-xl flex items-center gap-1.5 shadow shrink-0 min-w-0 max-w-[180px] text-gray-200"
          style={{ backgroundColor: item.color }}>
          <span className="text-sm leading-none shrink-0">{item.emoji || ''}</span>
          <span className="font-semibold text-xs truncate" style={{ color: item.text_color || '#fff' }}>{item.name}</span>
        </div>
        {/* Shortcut badge */}
        {item.shortcut && (
          <span className="px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-[10px] text-gray-400 font-mono shrink-0" title="Phím tắt">
            ⌨ {item.shortcut}
          </span>
        )}
        {(item.sort_order ?? 0) > 0 && (
          <span className="text-[9px] text-gray-600 font-mono bg-gray-800 px-1 rounded shrink-0">#{item.sort_order}</span>
        )}
        <div className="flex-1 min-w-0" />
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
      {/* Account badges */}
      <div className="mt-2 pl-5 flex flex-wrap gap-1.5">
        {pageIds.length > 0 ? pageIds.map(pid => {
          const name = getAccountName(pid);
          const phone = getAccountPhone(pid);
          const avatar = getAccountAvatar(pid);
          return (
            <div key={pid} className="flex items-center gap-1.5 bg-gray-800 rounded-full px-2 py-0.5 border border-gray-700/50">
              {avatar ? (
                <img src={avatar} alt="" className="w-3.5 h-3.5 rounded-full object-cover shrink-0" />
              ) : (
                <div className="w-3 h-3 bg-blue-600 rounded-full flex items-center justify-center text-[7px] text-white font-bold uppercase shrink-0">
                  {(name || '?').charAt(0)}
                </div>
              )}
              <span className="text-[11px] text-gray-400 truncate max-w-[140px]">{name}</span>
              {phone && <span className="text-[11px] text-gray-500">· {phone}</span>}
            </div>
          );
        }) : <span className="text-[11px] text-gray-600 italic">Chưa gắn tài khoản nào</span>}
      </div>
    </div>
  );
}

// ─── Zalo Labels Section ──────────────────────────────────────────────────────
function ZaloLabelsSection({
  activeZaloId, isConnected, loading, labels, onRefresh, onSyncToLocal, onEdit, onDeleteItem, onSaveItem,
}: {
  activeZaloId: string | null; isConnected: boolean; loading: boolean; labels: any[];
  onRefresh: () => void;
  onSyncToLocal?: () => void;
  onEdit?: () => void;
  onDeleteItem?: (label: any) => void;
  onSaveItem?: (label: any, newData: any) => void;
}) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ text: '', color: '#3b82f6', emoji: '🏷️' });

  const startEdit = (idx: number, label: any) => {
    setEditingIdx(idx);
    setEditForm({ text: label.text || label.name || '', color: label.color || '#3b82f6', emoji: label.emoji || label.icon || '🏷️' });
  };

  const handleSaveEdit = (label: any) => {
    onSaveItem?.(label, { text: editForm.text, name: editForm.text, color: editForm.color, emoji: editForm.emoji, icon: editForm.emoji });
    setEditingIdx(null);
  };

  if (!activeZaloId) return <EmptyState icon="☁️" title="Chọn đúng 1 tài khoản" subtitle="Vui lòng chọn chính xác 1 tài khoản để xem nhãn trên Zalo." />;
  if (!isConnected) return <EmptyState icon="🔌" title="Tài khoản chưa kết nối" subtitle="Vui lòng kết nối tài khoản để xem nhãn Zalo." />;
  if (loading) return (
    <div className="text-center py-14">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"/>
      <p className="text-gray-500 text-sm">Đang tải nhãn từ Zalo...</p>
    </div>
  );
  if (!labels.length) return (
    <div className="text-center py-14">
      <p className="text-3xl mb-2">🏷️</p>
      <p className="text-gray-400 text-sm font-medium">Chưa có nhãn trên Zalo</p>
      <button onClick={onRefresh} className="mt-3 text-xs text-blue-400 hover:text-blue-300 underline">Tải lại</button>
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pb-1">
        <span className="text-xs text-gray-500">{labels.length} nhãn trên Zalo</span>
        <div className="flex-1"/>
        {onSyncToLocal && (
          <button onClick={onSyncToLocal}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300 hover:text-white transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/>
              <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>
            </svg>
            Đồng bộ về Local
          </button>
        )}
        {onEdit && (
          <button onClick={onEdit}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs text-white transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Chỉnh sửa nhãn Zalo
          </button>
        )}
      </div>
      {labels.map((label: any, idx: number) => (
        <div key={label.id ?? idx} className={`bg-gray-900 border rounded-xl p-3 transition-colors ${editingIdx === idx ? 'border-blue-600/50' : 'border-blue-900/30 hover:border-blue-700/40'}`}>
          {editingIdx === idx ? (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <input type="text" value={editForm.text} onChange={e => setEditForm(f => ({ ...f, text: e.target.value }))}
                  placeholder="Tên nhãn..." autoFocus
                  className="flex-1 bg-gray-700 text-white text-sm rounded-lg px-3 py-1.5 border border-gray-600 focus:border-blue-500 outline-none" />
                <input type="text" value={editForm.emoji} onChange={e => setEditForm(f => ({ ...f, emoji: e.target.value }))}
                  className="w-12 bg-gray-700 text-white text-sm rounded-lg px-2 py-1.5 border border-gray-600 focus:border-blue-500 outline-none text-center text-base" maxLength={2} title="Emoji" />
                <input type="color" value={editForm.color} onChange={e => setEditForm(f => ({ ...f, color: e.target.value }))}
                  className="h-8 w-10 rounded cursor-pointer bg-transparent border border-gray-600" title="Màu nhãn" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-500">Xem trước:</span>
                <div className="px-2 py-1 rounded-lg flex items-center gap-1 text-xs" style={{ backgroundColor: editForm.color }}>
                  <span>{editForm.emoji || '🏷️'}</span>
                  <span className="font-semibold text-white">{editForm.text || 'Nhãn'}</span>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditingIdx(null)} className="px-3 py-1 text-xs text-gray-400 hover:text-white">Hủy</button>
                <button onClick={() => handleSaveEdit(label)} disabled={!editForm.text.trim()}
                  className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40">Lưu</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="px-2.5 py-1.5 rounded-xl flex items-center gap-1.5 shadow shrink-0 text-gray-200"
                style={{ backgroundColor: label.color || '#3b82f6' }}>
                <span className="text-sm leading-none">{label.emoji || label.icon || '🏷️'}</span>
                <span className="font-semibold text-xs text-white max-w-[120px] truncate">
                  {label.text || label.name || label.title || `Nhãn #${label.id}`}
                </span>
              </div>
              <div className="flex-1 min-w-0" />
              <div className="flex items-center gap-0.5 shrink-0">
                {onSaveItem && (
                  <button onClick={() => startEdit(idx, label)} title="Sửa"
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                )}
                {onDeleteItem && (
                  <button onClick={() => onDeleteItem(label)} title="Xóa"
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                      <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Modal: Label ─────────────────────────────────────────────────────────────
function LabelModal({ initialData, accounts, filterAccounts, onClose, onSave }: {
  initialData: LocalLabel | null;
  accounts: AccountInfo[];
  filterAccounts: string[];
  onClose: () => void;
  onSave: (data: Partial<LocalLabel>) => void;
}) {
  const [form, setForm] = useState<Partial<LocalLabel>>(
    initialData 
      ? { ...initialData, shortcut: initialData.shortcut || '' }
      : { name: '', color: '#3b82f6', text_color: '#ffffff', emoji: '🏷️', is_active: 1, sort_order: 0, shortcut: '' }
  );
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  
  const defaultPages = initialData
    ? (initialData.page_ids ?? '').split(',').filter(Boolean)
    : (filterAccounts.length > 0 ? filterAccounts : accounts.map(a => a.zalo_id));
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set(defaultPages));

  useEffect(() => {
    setForm(prev => ({ ...prev, page_ids: Array.from(selectedPages).join(',') }));
  }, [selectedPages]);

  const togglePage = (id: string) => {
    const s = new Set(selectedPages);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedPages(s);
  };
  const valid = form.name && form.color && selectedPages.size > 0;

  return (
    <ModalWrapper onClose={onClose}>
      <div className="bg-gray-800 rounded-xl w-full max-w-md border border-gray-700 shadow-2xl flex flex-col max-h-[90vh]" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-700 flex justify-between items-center shrink-0">
          <h3 className="text-white font-medium">{initialData ? 'Sửa nhãn' : 'Thêm nhãn mới'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Preview */}
          <div className="flex justify-center py-2">
            <div className="px-4 py-2 rounded-xl flex items-center gap-2 shadow-lg" style={{ backgroundColor: form.color }}>
              <span className="text-lg">{form.emoji}</span>
              <span className="font-semibold text-sm" style={{ color: form.text_color }}>{form.name || 'Tên nhãn Demo'}</span>
              {form.shortcut && (
                <span className="ml-1 px-1.5 py-0.5 bg-black/20 rounded text-[10px] text-white/70 font-mono">
                  {form.shortcut}
                </span>
              )}
            </div>
          </div>
          
          {/* Name & Emoji */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Tên nhãn</label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} maxLength={20}
                className="w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600 focus:border-blue-500 outline-none" />
            </div>
            <div className="relative">
              <label className="block text-xs text-gray-400 mb-1.5">Emoji</label>
              <button
                ref={emojiButtonRef}
                type="button"
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                className={`w-full bg-gray-700 text-white text-lg rounded-lg px-3 py-1.5 border transition-colors flex items-center justify-center gap-2 ${
                  showEmojiPicker ? 'border-blue-500' : 'border-gray-600 hover:border-gray-500'
                }`}
              >
                <span>{form.emoji || '🏷️'}</span>
                <span className="text-xs text-gray-400">▼</span>
              </button>
              {showEmojiPicker && (
                <div className="absolute top-full right-0 mt-1 z-50">
                  <LabelEmojiPicker
                    value={form.emoji || '🏷️'}
                    onChange={(emoji) => {
                      setForm({ ...form, emoji });
                      setShowEmojiPicker(false);
                    }}
                    onClose={() => setShowEmojiPicker(false)}
                  />
                </div>
              )}
            </div>
          </div>
          
          {/* Colors */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Màu nền</label>
              <div className="flex gap-2">
                <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} className="h-9 w-12 rounded cursor-pointer bg-transparent border border-gray-600"/>
                <input type="text" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} className="flex-1 bg-gray-700 text-gray-300 text-xs rounded-lg px-2 py-2 border border-gray-600 font-mono"/>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Màu chữ</label>
              <div className="flex gap-2">
                <input type="color" value={form.text_color ?? '#ffffff'} onChange={e => setForm({ ...form, text_color: e.target.value })} className="h-9 w-12 rounded cursor-pointer bg-transparent border border-gray-600"/>
                <input type="text" value={form.text_color} onChange={e => setForm({ ...form, text_color: e.target.value })} className="flex-1 bg-gray-700 text-gray-300 text-xs rounded-lg px-2 py-2 border border-gray-600 font-mono"/>
              </div>
            </div>
          </div>
          
          {/* Quick color presets */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Màu nhanh</label>
            <div className="flex gap-1.5 flex-wrap">
              {[
                { bg: '#ef4444', text: '#ffffff' }, // Red
                { bg: '#f97316', text: '#ffffff' }, // Orange
                { bg: '#eab308', text: '#000000' }, // Yellow
                { bg: '#22c55e', text: '#ffffff' }, // Green
                { bg: '#06b6d4', text: '#ffffff' }, // Cyan
                { bg: '#3b82f6', text: '#ffffff' }, // Blue
                { bg: '#8b5cf6', text: '#ffffff' }, // Purple
                { bg: '#ec4899', text: '#ffffff' }, // Pink
                { bg: '#6b7280', text: '#ffffff' }, // Gray
                { bg: '#1f2937', text: '#ffffff' }, // Dark
              ].map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setForm({ ...form, color: preset.bg, text_color: preset.text })}
                  className={`w-7 h-7 rounded-lg border-2 transition-transform hover:scale-110 ${
                    form.color === preset.bg ? 'border-white ring-2 ring-blue-500' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: preset.bg }}
                />
              ))}
            </div>
          </div>
          
          {/* Sort order & Status */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Thứ tự hiển thị</label>
              <input type="number" min={0} max={9999} value={form.sort_order ?? 0}
                onChange={e => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
                className="w-full bg-gray-700 text-white text-sm rounded-lg px-3 py-2 border border-gray-600 focus:border-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Trạng thái</label>
              <button
                onClick={() => setForm({ ...form, is_active: (form.is_active ?? 1) === 1 ? 0 : 1 })}
                className={`w-full py-2 rounded-lg border text-sm font-medium transition-colors
                  ${(form.is_active ?? 1) === 1 ? 'border-green-600 bg-green-900/30 text-green-400 hover:bg-green-900/50' : 'border-gray-600 bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
              >{(form.is_active ?? 1) === 1 ? '✅ Hoạt động' : '⭕ Tắt'}</button>
            </div>
          </div>
          
          {/* Keyboard Shortcut */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              Phím tắt gắn/gỡ nhanh
              <span className="text-gray-500 ml-1">(tùy chọn)</span>
            </label>
            <KeyboardShortcutInput
              value={form.shortcut || ''}
              onChange={(shortcut) => setForm({ ...form, shortcut })}
              placeholder="VD: Ctrl + M, Shift + 1, Alt + L..."
            />
            <p className="text-[11px] text-gray-500 mt-1.5 italic">
              * Khi đang xem hội thoại, nhấn phím tắt để gắn/gỡ nhãn này nhanh chóng.
            </p>
          </div>
          
          {/* Tài khoản áp dụng */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-2">Tài khoản sử dụng nhãn này</label>
            <AccountMultiDropdown
              accounts={accounts}
              selectedIds={Array.from(selectedPages)}
              onChange={(ids) => setSelectedPages(new Set(ids))}
              dropPosition="up"
              fullWidth
              placeholder="Chọn tài khoản áp dụng..."
            />
            {selectedPages.size === 0 && (
              <p className="text-[11px] text-red-400/80 mt-1.5">⚠️ Chọn ít nhất 1 tài khoản.</p>
            )}
            <p className="text-[11px] text-gray-500 mt-1.5 italic">* Nhãn sẽ hiện trong menu phân loại của các tài khoản được chọn.</p>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-700 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
          <button onClick={() => onSave(form)} disabled={!valid}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
            Lưu nhãn
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Modal: Zalo Labels Sync ──────────────────────────────────────────────────
function ZaloLabelsSyncModal({ zaloCount, accountName, onClose, onSave }: {
  zaloCount: number; accountName: string;
  onClose: () => void; onSave: (mode: 'replace' | 'merge') => void;
}) {
  return (
    <ModalWrapper onClose={onClose}>
      <div className="bg-gray-800 rounded-xl w-full max-w-sm border border-gray-700 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-700 flex justify-between items-center">
          <h3 className="text-white font-medium">Đồng bộ nhãn Zalo → Local</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-blue-900/20 rounded-lg px-3 py-2.5 border border-blue-800/30 space-y-0.5">
            <p className="text-xs text-blue-300">☁️ Tài khoản: <strong>{accountName}</strong></p>
            <p className="text-xs text-blue-300">🏷️ Số nhãn sẽ đồng bộ: <strong>{zaloCount}</strong></p>
          </div>
          <p className="text-xs text-gray-400 font-medium pt-1">Chọn chế độ đồng bộ:</p>
          <button onClick={() => onSave('merge')}
            className="w-full bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-xl p-3.5 text-left transition-colors">
            <p className="text-sm font-semibold text-gray-200">➕ Thêm vào (Merge)</p>
            <p className="text-xs text-gray-400 mt-0.5">Chỉ thêm nhãn mới chưa có trong Local. Không ghi đè.</p>
          </button>
          <button onClick={() => onSave('replace')}
            className="w-full bg-gray-700 hover:bg-red-900/30 border border-gray-600 hover:border-red-700/50 rounded-xl p-3.5 text-left transition-colors">
            <p className="text-sm font-semibold text-red-300">🔄 Thay thế hoàn toàn (Replace)</p>
            <p className="text-xs text-gray-400 mt-0.5">Xóa toàn bộ Nhãn Local của tài khoản và thay bằng nhãn từ Zalo.</p>
          </button>
        </div>
        <div className="px-5 py-3 border-t border-gray-700 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Modal: Zalo Labels Edit ──────────────────────────────────────────────────
function ZaloLabelsEditModal({ zaloId, accountName, initialLabels, buildAuth, onClose, onSaved }: {
  zaloId: string; accountName: string; initialLabels: any[];
  buildAuth: (zaloId: string) => { cookies: any; imei: any; userAgent: any } | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [labels, setLabels] = useState<any[]>(initialLabels.map(l => ({ ...l })));
  const [version, setVersion] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newLabel, setNewLabel] = useState({ name: '', color: '#3b82f6', icon: '🏷️' });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const auth = buildAuth(zaloId);
    if (!auth) return;
    ipc.zalo?.getLabels({ auth }).then(res => {
      if (res?.success) {
        const raw = res.response;
        const ver: number = raw?.version ?? raw?.ver ?? raw?.v ?? 0;
        setVersion(ver);
      }
    }).catch(() => {});
  }, []);

  const handleDeleteLabel = (idx: number) => {
    setLabels(prev => prev.filter((_, i) => i !== idx));
    if (editIdx === idx) setEditIdx(null);
  };

  const handleFieldChange = (idx: number, field: string, value: string) => {
    setLabels(prev => prev.map((l, i) => i !== idx ? l : { ...l, [field]: value }));
  };

  const handleAddNew = () => {
    if (!newLabel.name.trim()) return;
    setLabels(prev => [...prev, { id: -(Date.now()), text: newLabel.name.trim(), color: newLabel.color, emoji: newLabel.icon, icon: newLabel.icon, conversations: [] }]);
    setNewLabel({ name: '', color: '#3b82f6', icon: '🏷️' });
    setAddingNew(false);
  };

  const handleSave = async () => {
    const auth = buildAuth(zaloId);
    if (!auth) return;
    setSaving(true); setSaveError(null);
    try {
      const labelData = labels.map(l => ({ ...l, id: (l.id ?? 0) < 0 ? undefined : l.id }));
      const res = await ipc.zalo?.updateLabels({ auth, labelData, version });
      if (res?.success) { onSaved(); }
      else { setSaveError(res?.error || 'Cập nhật nhãn Zalo thất bại'); }
    } catch (err: any) {
      setSaveError(err?.message || 'Lỗi không xác định');
    } finally { setSaving(false); }
  };

  return (
    <ModalWrapper onClose={onClose}>
      <div className="bg-gray-800 rounded-xl w-full max-w-lg border border-gray-700 shadow-2xl flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-700 flex justify-between items-center shrink-0">
          <h3 className="text-white font-medium">✏️ Chỉnh sửa nhãn Zalo</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="px-5 py-2.5 border-b border-gray-700/50 bg-blue-900/10 shrink-0">
          <p className="text-xs text-blue-300 flex items-center gap-1.5">
            <span>☁️</span> Tài khoản: <strong>{accountName}</strong>
            <span className="ml-auto text-[11px] text-gray-600 font-mono">ver {version}</span>
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
          {labels.length === 0 && !addingNew && (
            <div className="text-center py-8 text-gray-500 text-sm">Chưa có nhãn nào. Nhấn "Thêm nhãn mới" để tạo.</div>
          )}
          {labels.map((label, idx) => (
            <div key={idx} className={`bg-gray-900 border rounded-xl p-3 transition-colors ${editIdx === idx ? 'border-blue-600/50' : 'border-gray-700/80'}`}>
              {editIdx === idx ? (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <input type="text" value={label.text || label.name || ''}
                      onChange={e => { handleFieldChange(idx, 'text', e.target.value); handleFieldChange(idx, 'name', e.target.value); }}
                      placeholder="Tên nhãn..." autoFocus
                      className="flex-1 bg-gray-700 text-white text-sm rounded-lg px-3 py-1.5 border border-gray-600 focus:border-blue-500 outline-none" />
                    <input type="text" value={label.emoji || label.icon || '🏷️'}
                      onChange={e => { handleFieldChange(idx, 'emoji', e.target.value); handleFieldChange(idx, 'icon', e.target.value); }}
                      className="w-12 bg-gray-700 text-white text-sm rounded-lg px-2 py-1.5 border border-gray-600 focus:border-blue-500 outline-none text-center text-base" maxLength={2} title="Emoji" />
                    <input type="color" value={label.color || '#3b82f6'}
                      onChange={e => handleFieldChange(idx, 'color', e.target.value)}
                      className="h-8 w-10 rounded cursor-pointer bg-transparent border border-gray-600" title="Màu nhãn" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-500">Xem trước:</span>
                    <div className="px-2 py-1 rounded-lg flex items-center gap-1 text-xs" style={{ backgroundColor: label.color || '#3b82f6' }}>
                      <span>{label.emoji || label.icon || '🏷️'}</span>
                      <span className="font-semibold text-white">{label.text || label.name || 'Nhãn'}</span>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditIdx(null)} className="px-3 py-1 text-xs text-gray-400 hover:text-white">Xong</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="px-2.5 py-1.5 rounded-xl flex items-center gap-1.5 shadow shrink-0 text-gray-200" style={{ backgroundColor: label.color || '#3b82f6' }}>
                    <span className="text-sm leading-none">{label.emoji || label.icon || '🏷️'}</span>
                    <span className="font-semibold text-xs text-white max-w-[120px] truncate">
                      {label.text || label.name || label.title || `Nhãn #${label.id}`}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0" />
                  <button onClick={() => setEditIdx(idx)} title="Sửa"
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                  <button onClick={() => handleDeleteLabel(idx)} title="Xóa"
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                      <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))}
          {addingNew ? (
            <div className="bg-gray-900 border border-blue-600/40 rounded-xl p-3 space-y-2.5">
              <p className="text-xs text-blue-400 font-medium flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Nhãn mới
              </p>
              <div className="flex items-center gap-2">
                <input type="text" value={newLabel.name}
                  onChange={e => setNewLabel(p => ({ ...p, name: e.target.value }))}
                  placeholder="Tên nhãn..." autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleAddNew()}
                  className="flex-1 bg-gray-700 text-white text-sm rounded-lg px-3 py-1.5 border border-gray-600 focus:border-blue-500 outline-none" />
                <input type="text" value={newLabel.icon}
                  onChange={e => setNewLabel(p => ({ ...p, icon: e.target.value }))}
                  className="w-12 bg-gray-700 text-white text-sm rounded-lg px-2 py-1.5 border border-gray-600 focus:border-blue-500 outline-none text-center text-base" maxLength={2} title="Emoji" />
                <input type="color" value={newLabel.color}
                  onChange={e => setNewLabel(p => ({ ...p, color: e.target.value }))}
                  className="h-8 w-10 rounded cursor-pointer bg-transparent border border-gray-600" title="Màu nhãn" />
              </div>
              {newLabel.name && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-500">Xem trước:</span>
                  <div className="px-2 py-1 rounded-lg flex items-center gap-1 text-xs" style={{ backgroundColor: newLabel.color }}>
                    <span>{newLabel.icon}</span>
                    <span className="font-semibold text-white">{newLabel.name}</span>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button onClick={() => { setAddingNew(false); setNewLabel({ name: '', color: '#3b82f6', icon: '🏷️' }); }}
                  className="px-3 py-1 text-xs text-gray-400 hover:text-white">Hủy</button>
                <button onClick={handleAddNew} disabled={!newLabel.name.trim()}
                  className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40">Thêm</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAddingNew(true)}
              className="w-full py-2.5 border-2 border-dashed border-gray-700 hover:border-blue-600/50 text-gray-500 hover:text-blue-400 rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm nhãn mới
            </button>
          )}
        </div>
        {saveError && (
          <div className="mx-5 mb-2 px-3 py-2 bg-red-950 border border-red-800 rounded-lg text-xs text-red-300 shrink-0">❌ {saveError}</div>
        )}
        <div className="px-5 py-3 border-t border-gray-700 flex justify-between items-center shrink-0">
          <span className="text-[11px] text-gray-600">{labels.length} nhãn</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg disabled:opacity-40 flex items-center gap-2">
              {saving && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {saving ? 'Đang lưu...' : 'Lưu lên Zalo'}
            </button>
          </div>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Modal: Clone Labels A → B ────────────────────────────────────────────────
function CloneLabelsModal({ accounts, onClose, onSave }: {
  accounts: AccountInfo[]; onClose: () => void;
  onSave: (source: string, target: string) => void;
}) {
  const [source, setSource] = useState(accounts[0]?.zalo_id ?? '');
  const [target, setTarget] = useState(accounts.length > 1 ? accounts[1].zalo_id : '');
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
          <h3 className="text-white font-medium">Sao chép nhãn</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-400 bg-gray-700/50 rounded-lg px-3 py-2 border border-gray-600">
            📋 Sao chép toàn bộ Nhãn Local từ tài khoản nguồn sang tài khoản đích.
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
          <div className="bg-yellow-900/20 border border-yellow-800/30 rounded-lg px-3 py-2">
            <p className="text-xs text-yellow-400/90">⚠️ Nhãn hiện có ở tài khoản đích sẽ bị <strong>ghi đè hoàn toàn</strong>.</p>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Hủy</button>
          <button onClick={() => onSave(source, target)} disabled={!valid}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
            📋 Sao chép nhãn
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ─── Help Modal ───────────────────────────────────────────────────────────────
function LabelHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 max-w-lg w-full mx-4 shadow-2xl relative" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">✕</button>
        <h3 className="text-lg font-bold text-white mb-4">🏷️ Hướng dẫn — Quản lý nhãn</h3>

        {/* Comparison table */}
        <div className="grid grid-cols-2 gap-3 mb-5 text-xs">
          {/* Local */}
          <div className="bg-blue-950/40 border border-blue-800/40 rounded-xl p-3.5">
            <p className="font-bold text-blue-400 mb-2.5 flex items-center gap-1.5">💾 Local <span className="text-[11px] font-normal text-blue-500/70 bg-blue-900/30 px-1.5 py-0.5 rounded">Khuyến nghị</span></p>
            <ul className="space-y-1.5 text-gray-300">
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span><strong className="text-white">Không giới hạn</strong> số lượng nhãn tạo ra</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span><strong className="text-white">Không giới hạn</strong> số nhãn gắn vào 1 hội thoại</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Dùng chung cho nhiều tài khoản</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span>Tuỳ chỉnh màu sắc, emoji, thứ tự</span></li>
              <li className="flex items-start gap-1.5"><span className="text-yellow-500 mt-0.5 shrink-0">−</span><span className="text-gray-500">Không đồng bộ điện thoại Zalo</span></li>
            </ul>
          </div>
          {/* Zalo */}
          <div className="bg-gray-900/60 border border-gray-700/60 rounded-xl p-3.5">
            <p className="font-bold text-gray-400 mb-2.5">☁️ Zalo</p>
            <ul className="space-y-1.5 text-gray-400">
              <li className="flex items-start gap-1.5"><span className="text-red-400 mt-0.5 shrink-0">✗</span><span><strong className="text-red-300">Chỉ gắn được 1 nhãn</strong> vào 1 hội thoại</span></li>
              <li className="flex items-start gap-1.5"><span className="text-red-400 mt-0.5 shrink-0">✗</span><span>Số lượng nhãn tạo ra bị giới hạn</span></li>
              <li className="flex items-start gap-1.5"><span className="text-green-400 mt-0.5 shrink-0">✓</span><span className="text-gray-400">Đồng bộ trên điện thoại Zalo</span></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-700 pt-4 space-y-1.5 text-xs text-gray-400">
          <p className="text-gray-300 font-semibold mb-2">📋 Các tính năng</p>
          <p>💾 <strong className="text-gray-300">Local:</strong> Tạo/sửa/xóa nhãn, gắn nhiều nhãn vào 1 hội thoại, dùng chung nhiều tài khoản.</p>
          <p>☁️ <strong className="text-gray-300">Zalo:</strong> Xem & quản lý nhãn trực tiếp trên server Zalo. Cần tài khoản kết nối.</p>
          <p>📥 <strong className="text-gray-300">Đồng bộ về Local:</strong> Kéo nhãn Zalo về Local (Merge hoặc Replace).</p>
          <p>📋 <strong className="text-gray-300">Sao chép:</strong> Copy toàn bộ Nhãn Local từ tài khoản A sang B.</p>
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

export default function LabelSettings({ accounts, filterAccounts, searchText }: Props) {
  const { showNotification } = useAppStore();
  const [labelSource, setLabelSource] = useState<LabelSource>('local');

  // If all selected accounts are Facebook → hide Zalo tab, force Local
  const allFB = filterAccounts.length > 0 && filterAccounts.every(id => {
    const acc = accounts.find(a => a.zalo_id === id);
    return (acc?.channel || 'zalo') === 'facebook';
  });
  const effectiveLabelSource: LabelSource = allFB ? 'local' : labelSource;

  const [localLabels, setLocalLabels] = useState<LocalLabel[]>([]);
  const [zaloLabels, setZaloLabels] = useState<any[]>([]);
  const [zaloLabelsLoading, setZaloLabelsLoading] = useState(false);

  // Modals
  const [labelModal, setLabelModal] = useState<{ open: boolean; data: LocalLabel | null }>({ open: false, data: null });
  const [zaloLabelsEditModal, setZaloLabelsEditModal] = useState(false);
  const [zaloLabelsSyncModal, setZaloLabelsSyncModal] = useState(false);
  const [cloneLabelModal, setCloneLabelModal] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Drag & drop
  const labelDragFromRef = useRef<number | null>(null);
  const labelDragOverRef = useRef<number | null>(null);
  const [labelDragging, setLabelDragging] = useState<number | null>(null);
  const [labelDragOver, setLabelDragOver] = useState<number | null>(null);

  // For zalo operations: only when exactly 1 account is selected
  const activeZaloId = filterAccounts.length === 1 ? filterAccounts[0] : null;
  const selectedAccount = accounts.find(a => a.zalo_id === activeZaloId);
  const isConnected = selectedAccount?.isConnected ?? false;

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
  const fetchLocalLabels = async () => {
    try {
      const res = await ipc.db?.getLocalLabels({});
      if (res?.success) setLocalLabels(res.labels || []);
    } catch (err) { console.error(err); }
  };

  const fetchZaloLabels = async (zaloId: string) => {
    const auth = buildAuth(zaloId);
    if (!auth) return;
    setZaloLabelsLoading(true); setZaloLabels([]);
    try {
      const res = await ipc.zalo?.getLabels({ auth });
      if (res?.success) {
        const raw = res.response;
        const arr = Array.isArray(raw?.labelData) ? raw.labelData : Array.isArray(raw) ? raw : [];
        setZaloLabels(arr);
      } else {
        showNotification(res?.error || 'Không thể tải nhãn từ Zalo', 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không thể tải nhãn từ Zalo', 'error');
    } finally { setZaloLabelsLoading(false); }
  };

  useEffect(() => { fetchLocalLabels(); }, []);

  useEffect(() => {
    if (effectiveLabelSource === 'zalo' && activeZaloId && isConnected) {
      fetchZaloLabels(activeZaloId);
    } else if (effectiveLabelSource === 'zalo') {
      setZaloLabels([]);
    }
  }, [labelSource, activeZaloId]);

  // ─── Filtered ─────────────────────────────────────────────────────────────
  const filteredLabels = useMemo(() => {
    const q = searchText.toLowerCase();
    return localLabels
      .filter(l => {
        if (filterAccounts.length > 0) {
          const pageIds = (l.page_ids || '').split(',').filter(Boolean);
          if (!filterAccounts.some(id => pageIds.includes(id))) return false;
        }
        return !q || l.name.toLowerCase().includes(q);
      })
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
  }, [localLabels, filterAccounts, searchText]);

  // ─── Label Actions ────────────────────────────────────────────────────────
  const handleDeleteLabel = async (id: number) => {
    const ok = await showConfirm({ title: 'Xóa nhãn?', message: 'Nhãn sẽ bị gỡ khỏi tất cả hội thoại.', variant: 'danger' });
    if (!ok) return;
    await ipc.db?.deleteLocalLabel({ id });
    fetchLocalLabels(); showNotification('Đã xóa nhãn');
  };

  const handleSaveLabel = async (data: Partial<LocalLabel>) => {
    if (!data.name || !data.color) return;
    await (ipc.db?.upsertLocalLabel as any)({
      label: {
        id: data.id, name: data.name, color: data.color,
        textColor: data.text_color, emoji: data.emoji || '',
        pageIds: data.page_ids || '',
        isActive: data.is_active ?? 1,
        sortOrder: data.sort_order ?? 0,
        shortcut: data.shortcut || '',
      },
    });
    setLabelModal({ open: false, data: null });
    fetchLocalLabels(); showNotification('Đã lưu nhãn');
  };

  const handleToggleLabelActive = async (item: LocalLabel) => {
    const newVal = (item.is_active ?? 1) === 1 ? 0 : 1;
    await ipc.db?.setLocalLabelActive({ id: item.id, isActive: newVal });
    fetchLocalLabels();
  };

  const handleDeleteZaloLabel = async (label: any) => {
    if (!activeZaloId) return;
    const ok = await showConfirm({ title: 'Xóa nhãn Zalo?', message: 'Nhãn sẽ bị xóa trực tiếp trên Zalo.', variant: 'danger' });
    if (!ok) return;
    const auth = buildAuth(activeZaloId);
    if (!auth) return;
    try {
      const vRes = await ipc.zalo?.getLabels({ auth });
      const raw = vRes?.response;
      const ver: number = raw?.version ?? raw?.ver ?? raw?.v ?? 0;
      const updatedLabels = zaloLabels.filter(l => l.id !== label.id);
      const res = await ipc.zalo?.updateLabels({ auth, labelData: updatedLabels, version: ver });
      if (res?.success) { fetchZaloLabels(activeZaloId); showNotification('Đã xóa nhãn Zalo'); }
      else showNotification(res?.error || 'Xóa thất bại', 'error');
    } catch (err: any) { showNotification(err?.message || 'Xóa thất bại', 'error'); }
  };

  const handleSaveZaloLabel = async (label: any, newData: any) => {
    if (!activeZaloId) return;
    const auth = buildAuth(activeZaloId);
    if (!auth) return;
    try {
      const vRes = await ipc.zalo?.getLabels({ auth });
      const raw = vRes?.response;
      const ver: number = raw?.version ?? raw?.ver ?? raw?.v ?? 0;
      const updatedLabels = zaloLabels.map(l => l.id === label.id ? { ...l, ...newData } : l);
      const res = await ipc.zalo?.updateLabels({ auth, labelData: updatedLabels, version: ver });
      if (res?.success) { fetchZaloLabels(activeZaloId); showNotification('Đã cập nhật nhãn Zalo'); }
      else showNotification(res?.error || 'Cập nhật thất bại', 'error');
    } catch (err: any) { showNotification(err?.message || 'Cập nhật thất bại', 'error'); }
  };

  const handleSyncZaloLabelsToLocal = async (mode: 'replace' | 'merge') => {
    if (!zaloLabels.length || !activeZaloId) return;
    const count = await syncZaloLabelsToLocalDB({
      zaloLabels,
      activeZaloId,
      mode,
      existingLocalLabels: localLabels,
    });
    fetchLocalLabels();
    showNotification(`Đã đồng bộ ${count} nhãn từ Zalo về Local`);
  };

  const handleCloneLocalLabels = async (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const res = await ipc.db?.cloneLocalLabels({ sourceZaloId: sourceId, targetZaloId: targetId });
    if (res?.success) {
      fetchLocalLabels(); setCloneLabelModal(false);
      showNotification(`Đã sao chép ${res.count ?? ''} nhãn`);
    } else { showNotification(res?.error || 'Sao chép thất bại', 'error'); }
  };

  // ─── Drag Reorder ─────────────────────────────────────────────────────────
  const handleLabelReorder = async (items: LocalLabel[]) => {
    const from = labelDragFromRef.current;
    const over = labelDragOverRef.current;
    labelDragFromRef.current = null; labelDragOverRef.current = null;
    setLabelDragging(null); setLabelDragOver(null);
    if (from === null || over === null || from === over) return;
    const reordered = [...items];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(over, 0, moved);
    for (let i = 0; i < reordered.length; i++) {
      await ipc.db?.setLocalLabelOrder({ id: reordered[i].id, order: i + 1 });
    }
    fetchLocalLabels();
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Sub-tabs + Actions — pill style giống trang bạn bè */}
      <div className="bg-gray-800/30 px-4 py-2 border-b border-gray-800 flex items-center gap-2">
        <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
          {([
            { id: 'local' as const, label: '💾 Local' },
            ...(!allFB ? [{ id: 'zalo' as const, label: '☁️ Zalo' }] : []),
          ] as const).map(src => (
            <button key={src.id} onClick={() => setLabelSource(src.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap
                ${effectiveLabelSource === src.id ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'}`}
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
        <div className="ml-auto pb-2 flex items-center gap-2">
          {effectiveLabelSource === 'local' && (<>
            <button onClick={() => setCloneLabelModal(true)}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 border border-gray-600">
              📋 Sao chép
            </button>
            <button onClick={() => setLabelModal({ open: true, data: null })}
              className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Thêm nhãn
            </button>
          </>)}
          {effectiveLabelSource === 'zalo' && activeZaloId && isConnected && (
            <button onClick={() => fetchZaloLabels(activeZaloId)}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 border border-gray-600">
              🔄 Tải lại
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {/* Local Labels */}
        {effectiveLabelSource === 'local' && (
          filteredLabels.length === 0
            ? <EmptyState icon="🏷️" title="Chưa có nhãn" subtitle='Nhấn "Thêm nhãn" để tạo nhãn phân loại hội thoại.' />
            : filteredLabels.map((item, idx) => (
              <div key={item.id} draggable
                onDragStart={() => { labelDragFromRef.current = idx; labelDragOverRef.current = idx; setLabelDragging(idx); }}
                onDragEnter={() => { labelDragOverRef.current = idx; setLabelDragOver(idx); }}
                onDragOver={e => e.preventDefault()}
                onDragEnd={() => handleLabelReorder(filteredLabels)}
                className={labelDragOver === idx && labelDragging !== idx ? 'ring-2 ring-blue-400/60 rounded-xl' : ''}
              >
                <LabelRow item={item} getAccountName={getAccountName} getAccountPhone={getAccountPhone} getAccountAvatar={getAccountAvatar}
                  onEdit={() => setLabelModal({ open: true, data: item })}
                  onDelete={() => handleDeleteLabel(item.id)}
                  onToggleActive={() => handleToggleLabelActive(item)}
                  isDragging={labelDragging === idx}
                />
              </div>
            ))
        )}

        {/* Zalo Labels */}
        {effectiveLabelSource === 'zalo' && (
          <ZaloLabelsSection
            activeZaloId={activeZaloId}
            isConnected={isConnected}
            loading={zaloLabelsLoading}
            labels={zaloLabels}
            onRefresh={() => activeZaloId && fetchZaloLabels(activeZaloId)}
            onSyncToLocal={zaloLabels.length > 0 ? () => setZaloLabelsSyncModal(true) : undefined}
            onEdit={zaloLabels.length > 0 ? () => setZaloLabelsEditModal(true) : undefined}
            onDeleteItem={activeZaloId && isConnected ? handleDeleteZaloLabel : undefined}
            onSaveItem={activeZaloId && isConnected ? handleSaveZaloLabel : undefined}
          />
        )}
      </div>

      {/* Modals */}
      {showHelp && <LabelHelpModal onClose={() => setShowHelp(false)} />}
      {labelModal.open && (
        <LabelModal
          initialData={labelModal.data}
          accounts={accounts}
          filterAccounts={filterAccounts}
          onClose={() => setLabelModal({ open: false, data: null })}
          onSave={handleSaveLabel}
        />
      )}
      {cloneLabelModal && (
        <CloneLabelsModal accounts={accounts} onClose={() => setCloneLabelModal(false)} onSave={handleCloneLocalLabels} />
      )}
      {zaloLabelsEditModal && activeZaloId && (
        <ZaloLabelsEditModal
          zaloId={activeZaloId} accountName={getAccountName(activeZaloId)}
          initialLabels={zaloLabels} buildAuth={buildAuth}
          onClose={() => setZaloLabelsEditModal(false)}
          onSaved={() => { setZaloLabelsEditModal(false); fetchZaloLabels(activeZaloId); showNotification('Đã cập nhật nhãn Zalo'); }}
        />
      )}
      {zaloLabelsSyncModal && activeZaloId && (
        <ZaloLabelsSyncModal
          zaloCount={zaloLabels.length}
          accountName={getAccountName(activeZaloId)}
          onClose={() => setZaloLabelsSyncModal(false)}
          onSave={(mode) => { setZaloLabelsSyncModal(false); handleSyncZaloLabelsToLocal(mode); }}
        />
      )}
    </div>
  );
}

