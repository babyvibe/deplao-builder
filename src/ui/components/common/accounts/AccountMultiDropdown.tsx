/**
 * AccountMultiDropdown - dropdown chọn nhiều tài khoản với checkbox.
 * Dùng chung cho: header filter (ConversationSettings, Báo cáo) + modal (LabelModal, LocalMsgModal).
 */
import React, { useState, useEffect, useRef } from 'react';
import { AccountInfo } from '@/store/accounts/accountStore';

interface Props {
  accounts: AccountInfo[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Hiện ở dưới (mặc định) hay trên */
  dropPosition?: 'down' | 'up';
  /** chiếm toàn chiều ngang container */
  fullWidth?: boolean;
  /** text placeholder khi chưa chọn gì */
  placeholder?: string;
  /** Nhãn dòng chọn tất cả (mặc định "Chọn tất cả") */
  selectAllLabel?: string;
  /** Số tài khoản tối thiểu phải giữ (mặc định 0 = được bỏ hết); bỏ chọn dưới mức này bị bỏ qua */
  minSelected?: number;
  /** Nút "Chỉ chọn" khi rê chuột lên một dòng: chọn đúng tài khoản đó */
  showOnlyAction?: boolean;
}

function AvatarThumb({ acc, size = 'sm' }: { acc: AccountInfo; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-5 h-5 text-[7px]' : 'w-7 h-7 text-xs';
  const initial = (acc.full_name || acc.zalo_id || '?').charAt(0).toUpperCase();
  return acc.avatar_url ? (
    <img src={acc.avatar_url} alt="" className={`${dim} rounded-full object-cover border border-input shrink-0`} />
  ) : (
    <div className={`${dim} rounded-full bg-gradient-to-br from-blue-500 to-purple-600 border border-border flex items-center justify-center text-white font-bold shrink-0`}>
      {initial}
    </div>
  );
}

export default function AccountMultiDropdown({
  accounts,
  selectedIds,
  onChange,
  dropPosition = 'down',
  fullWidth = false,
  placeholder = 'Chọn tài khoản...',
  selectAllLabel = 'Chọn tất cả',
  minSelected = 0,
  showOnlyAction = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggleOne = (id: string) => {
    const s = new Set(selectedIds);
    if (s.has(id)) {
      if (s.size <= minSelected) return; // giữ tối thiểu minSelected tài khoản
      s.delete(id);
    } else {
      s.add(id);
    }
    onChange(Array.from(s));
  };

  const allChecked = accounts.length > 0 && accounts.every(a => selectedIds.includes(a.zalo_id));
  const someChecked = !allChecked && accounts.some(a => selectedIds.includes(a.zalo_id));

  const toggleAll = () => {
    if (allChecked) {
      if (minSelected > 0) return; // không bỏ hết được: thu hẹp bằng từng dòng hoặc "Chỉ chọn"
      onChange([]);
    } else {
      onChange(accounts.map(a => a.zalo_id));
    }
  };

  // Trigger label
  const labelText =
    selectedIds.length === 0
      ? placeholder
      : selectedIds.length === accounts.length
        ? 'Tất cả tài khoản'
        : selectedIds.length === 1
          ? (accounts.find(a => a.zalo_id === selectedIds[0])?.full_name || selectedIds[0])
          : `${selectedIds.length} tài khoản`;

  if (accounts.length === 0) return null;

  const panelClass = dropPosition === 'up'
    ? 'absolute bottom-full left-0 mb-1.5'
    : 'absolute top-full left-0 mt-1.5';

  return (
    <div ref={ref} className={`relative ${fullWidth ? 'w-full' : ''}`}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border border-input hover:border-border-strong bg-card text-xs text-foreground transition-colors ${fullWidth ? 'w-full' : 'min-w-[160px]'}`}
      >
        {/* Avatar stack */}
        <div className="flex -space-x-1 shrink-0">
          {selectedIds.slice(0, 3).map(id => {
            const acc = accounts.find(a => a.zalo_id === id);
            if (!acc) return null;
            return <AvatarThumb key={id} acc={acc} size="sm" />;
          })}
          {selectedIds.length === 0 && (
            <div className="w-5 h-5 rounded-full border border-dashed border-border-strong bg-muted flex items-center justify-center shrink-0">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground">
                <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
            </div>
          )}
        </div>
        <span className={`truncate ${fullWidth ? 'flex-1 text-left' : 'max-w-[130px]'} ${selectedIds.length === 0 ? 'text-muted-foreground' : 'text-foreground'}`}>
          {labelText}
        </span>
        <span className="flex-1"></span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-muted-foreground flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className={`${panelClass} bg-card border border-border rounded-xl shadow-2xl z-[60] overflow-hidden ${fullWidth ? 'w-full' : 'w-[260px]'}`}>
          {/* Select All row */}
          <button
            type="button"
            onClick={toggleAll}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 border-b border-border/60 hover:bg-muted transition-colors text-left ${allChecked ? 'bg-blue-500/10' : ''}`}
          >
            {/* Custom checkbox */}
            <span className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
              allChecked
                ? 'bg-blue-600 border-blue-600'
                : someChecked
                  ? 'bg-blue-600/40 border-blue-500'
                  : 'border-border-strong bg-muted'
            }`}>
              {allChecked && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
              )}
              {someChecked && (
                <span className="w-2 h-0.5 bg-white rounded-full block"/>
              )}
            </span>
            <span className="text-xs font-semibold text-foreground">{selectAllLabel}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{selectedIds.length}/{accounts.length}</span>
          </button>

          {/* Account rows */}
          <div className="max-h-[220px] overflow-y-auto">
            {accounts.map(acc => {
              const checked = selectedIds.includes(acc.zalo_id);
              const locked = checked && selectedIds.length <= minSelected;
              return (
                <div key={acc.zalo_id} className="relative group">
                  <button
                    type="button"
                    onClick={() => toggleOne(acc.zalo_id)}
                    title={locked ? `Cần chọn ít nhất ${minSelected} tài khoản` : undefined}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted transition-colors text-left ${checked ? 'bg-blue-500/10' : ''}`}
                  >
                    {/* Custom checkbox */}
                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'border-border-strong bg-muted'}`}>
                      {checked && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                      )}
                    </span>
                    <AvatarThumb acc={acc} size="md" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate leading-tight">{acc.full_name || acc.zalo_id}</p>
                      {acc.phone && <p className="text-[11px] text-muted-foreground truncate">{acc.phone}</p>}
                    </div>
                  </button>
                  {showOnlyAction && !(checked && selectedIds.length === 1) && (
                    <button
                      type="button"
                      onClick={() => onChange([acc.zalo_id])}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-primary opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      Chỉ chọn
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

