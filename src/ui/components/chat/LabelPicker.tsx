import React from 'react';
import { LabelData } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';

interface LabelPickerProps {
  labels: LabelData[];
  activeThreadId: string;
  isGroup?: boolean;
  onToggleLabel: (label: LabelData) => void;
  onEditLabels?: () => void;
  onSync?: () => void;
  syncingLabels?: boolean;
  className?: string;
}

/**
 * Component chung cho Label Picker - hiển thị và toggle labels
 * Dùng chung cho: ConversationList filter, Context menu, ChatHeader
 */
export default function LabelPicker({
  labels,
  activeThreadId,
  isGroup = false,
  onToggleLabel,
  onEditLabels,
  onSync,
  syncingLabels = false,
  className = '',
}: LabelPickerProps) {
  // Check if thread has this label
  const hasLabel = (label: LabelData): boolean => {
    const prefixedId = isGroup ? `g${activeThreadId}` : activeThreadId;
    return label.conversations?.includes(activeThreadId) || label.conversations?.includes(prefixedId);
  };

  return (
    <div className={`py-1 ${className}`}>
      {/* Header với nút Chỉnh sửa và Cập nhật — luôn hiện nếu có prop */}
      {(onEditLabels || onSync) && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
          {onEditLabels && (
            <button
              onClick={onEditLabels}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
              title="Chỉnh sửa nhãn"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              <span>Chỉnh sửa</span>
            </button>
          )}

          {onSync && (
            <button
              onClick={onSync}
              disabled={syncingLabels}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              title="Đồng bộ nhãn từ Zalo"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className={syncingLabels ? 'animate-spin' : ''}>
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
              <span>{syncingLabels ? 'Đang tải...' : 'Cập nhật'}</span>
            </button>
          )}
        </div>
      )}

      {/* Empty state */}
      {labels.length === 0 && (
        <div className="px-3 py-3 text-xs text-gray-500">
          {syncingLabels ? 'Đang tải nhãn...' : 'Chưa có nhãn'}
        </div>
      )}

      {/* Danh sách labels */}
      {labels.length > 0 && (
        <div className="max-h-64 overflow-y-auto">
          {labels.map((label) => {
            const active = hasLabel(label);
            return (
              <button
                key={label.id}
                onClick={() => onToggleLabel(label)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left transition-colors"
                title={active ? `Gỡ nhãn "${label.text}"` : `Gán nhãn "${label.text}"`}
              >
                {/* Color dot */}
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: label.color || '#3b82f6' }}
                />
                {/* Emoji */}
                {label.emoji && <span className="flex-shrink-0">{label.emoji}</span>}
                {/* Label text */}
                <span className="flex-1 truncate">{label.text}</span>
                {/* Checkmark if active */}
                {active && <span className="text-blue-400 flex-shrink-0">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Component hiển thị labels đang active (dạng pills)
 * Dùng cho ChatHeader để hiển thị labels của conversation
 */
export function ActiveLabels({
  labels,
  activeThreadId,
  isGroup = false,
  maxDisplay = 3,
  onClickPill,
  className = '',
}: {
  labels: LabelData[];
  activeThreadId: string;
  isGroup?: boolean;
  maxDisplay?: number;
  onClickPill?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  const prefixedId = isGroup ? `g${activeThreadId}` : activeThreadId;
  const activeLabels = labels.filter((l) =>
    l.conversations?.includes(activeThreadId) || l.conversations?.includes(prefixedId)
  );

  if (activeLabels.length === 0) {
    return (
      <button
        onClick={onClickPill}
        className={`flex items-center gap-0.5 text-xs text-gray-400 hover:text-gray-200 transition-colors ${className}`}
        title="Gán nhãn"
      >
        <span className="mr-1">Nhãn Zalo</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-1">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
          <line x1="7" y1="7" x2="7.01" y2="7"/>
        </svg>
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-1 flex-wrap ${className}`}>
      {activeLabels.slice(0, maxDisplay).map((l) => (
        <button
          key={l.id}
          onClick={onClickPill}
          title={`${l.text} — nhấn để đổi nhãn Zalo`}
          className="inline-flex items-center gap-0.5 text-white text-[11px] px-1.5 py-1 rounded-full leading-none hover:opacity-80 transition-opacity cursor-pointer"
          style={{ backgroundColor: l.color || '#3b82f6', color: '#fff' }}
        >
          {l.emoji && <span>{l.emoji}</span>}
          <span>{l.text}</span>
        </button>
      ))}
      {activeLabels.length > maxDisplay && (
        <button
          onClick={onClickPill}
          className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          +{activeLabels.length - maxDisplay}
        </button>
      )}
    </div>
  );
}

/**
 * Modal chỉnh sửa danh sách nhãn (tên, màu, emoji)
 * Dùng chung cho ConversationList và ChatHeader
 */
export function EditLabelsModal({ labels, labelsVersion, onClose, onSave, overrideZaloId }: {
  labels: LabelData[];
  labelsVersion: number;
  onClose: () => void;
  onSave: (labels: LabelData[], version: number) => void;
  overrideZaloId?: string;
}) {
  const [editedLabels, setEditedLabels] = React.useState<LabelData[]>([...labels]);
  const [saving, setSaving] = React.useState(false);
  const { activeAccountId } = useAccountStore();
  const { showNotification } = useAppStore();

  const handleSave = async () => {
    const zId = overrideZaloId || activeAccountId;
    if (!zId) return;
    setSaving(true);
    try {
      const accObj = overrideZaloId
        ? useAccountStore.getState().accounts.find(a => a.zalo_id === overrideZaloId)
        : useAccountStore.getState().getActiveAccount();
      if (!accObj) throw new Error('No account');
      const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
      const res = await ipc.zalo?.updateLabels({ auth, labelData: editedLabels, version: labelsVersion });
      if (res?.success && res.response) {
        onSave(res.response.labelData, res.response.version);
        showNotification('Đã lưu thay đổi', 'success');
        onClose();
      } else {
        throw new Error(res?.error || 'Update failed');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Lỗi khi lưu nhãn', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateLabel = (index: number, field: keyof LabelData, value: any) => {
    const newLabels = [...editedLabels];
    (newLabels[index] as any)[field] = value;
    setEditedLabels(newLabels);
  };

  const handleDeleteLabel = (index: number) => {
    setEditedLabels(editedLabels.filter((_, i) => i !== index));
  };

  const handleAddLabel = () => {
    const maxId = Math.max(0, ...editedLabels.map(l => l.id));
    const newLabel: LabelData = {
      id: maxId + 1,
      text: 'Nhãn mới',
      conversations: [],
      color: '#3b82f6',
      emoji: '🏷️',
    };
    setEditedLabels([...editedLabels, newLabel]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">Chỉnh sửa thẻ phân loại</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {editedLabels.length === 0 ? (
            <div className="text-center text-gray-500 py-8">
              <p>Chưa có nhãn nào</p>
              <button onClick={handleAddLabel} className="mt-4 text-blue-400 hover:text-blue-300">+ Thêm nhãn đầu tiên</button>
            </div>
          ) : (
            <div className="space-y-3">
              {editedLabels.map((label, index) => (
                <div key={label.id} className="flex items-center gap-3 p-3 bg-gray-700/50 rounded-lg">
                  <input type="color" value={label.color || '#3b82f6'} onChange={e => handleUpdateLabel(index, 'color', e.target.value)} className="w-10 h-10 rounded cursor-pointer" title="Chọn màu" />
                  <input type="text" value={label.emoji || ''} onChange={e => handleUpdateLabel(index, 'emoji', e.target.value)} placeholder="🏷️" maxLength={2} className="w-12 h-10 bg-gray-800 border border-gray-600 rounded text-center text-lg" title="Emoji" />
                  <input type="text" value={label.text} onChange={e => handleUpdateLabel(index, 'text', e.target.value)} placeholder="Tên nhãn" className="flex-1 h-10 px-3 bg-gray-800 border border-gray-600 rounded text-sm text-white placeholder-gray-500" />
                  <span className="text-xs text-gray-400 whitespace-nowrap">{label.conversations.length} hội thoại</span>
                  <button onClick={() => handleDeleteLabel(index)} className="w-10 h-10 flex items-center justify-center text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition-colors" title="Xóa nhãn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-700">
          <button onClick={handleAddLabel} className="flex items-center gap-2 px-4 py-2 text-sm text-blue-400 hover:text-blue-300 hover:bg-blue-900/20 rounded-lg transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
            <span>Thêm nhãn</span>
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors">Hủy</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
              {saving && <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
              <span>{saving ? 'Đang lưu...' : 'Lưu'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
