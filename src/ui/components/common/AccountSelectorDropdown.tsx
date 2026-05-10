import React, { useState, useEffect, useRef } from 'react';
import PhoneDisplay from "@/components/common/PhoneDisplay";

export interface AccountOption {
  id: string;
  name?: string;
  phone?: string;
  avatarUrl?: string;
}

interface Props {
  options: AccountOption[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Placeholder khi chưa chọn tài khoản */
  placeholder?: string;
  /**
   * Vị trí dropdown:
   * - 'down-right' (mặc định): mở xuống, căn phải
   * - 'up-left': mở lên, căn trái — dùng trong modal để tránh tràn màn hình
   */
  position?: 'down-right' | 'up-left';
  /** Trigger button chiếm toàn bộ chiều ngang */
  fullWidth?: boolean;
}

function Avatar({ option, size = 'sm' }: { option: AccountOption; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-5 h-5 text-[9px]' : 'w-7 h-7 text-xs';
  const initial = (option.name || option.id || '?').charAt(0).toUpperCase();
  return option.avatarUrl ? (
    <img src={option.avatarUrl} alt="" className={`${dim} rounded-full object-cover flex-shrink-0`} />
  ) : (
    <div className={`${dim} rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold flex-shrink-0`}>
      {initial}
    </div>
  );
}

/**
 * Dropdown chọn tài khoản dùng chung.
 * Hiển thị: Tên · SĐT · ID
 */
export default function AccountSelectorDropdown({ options, activeId, onSelect, placeholder = 'Chọn tài khoản', position = 'down-right', fullWidth = false }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const active = options.find(o => o.id === activeId);

  if (options.length === 0) return null;

  const panelPos = position === 'up-left'
    ? 'absolute bottom-full left-0 mb-1.5'
    : 'absolute top-full right-0 mt-1.5';

  return (
    <div ref={ref} className={`relative ${fullWidth ? 'w-full' : ''}`}>
      {/* Trigger */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-600 hover:border-gray-500 bg-gray-800 text-xs text-white transition-colors ${fullWidth ? 'w-full' : ''}`}
      >
        {active ? (
          <Avatar option={active} size="sm" />
        ) : (
          <div className="w-5 h-5 rounded-full bg-gray-600 flex-shrink-0" />
        )}
        <span className={`truncate ${fullWidth ? 'flex-1 text-left' : 'max-w-[120px]'}`}>{active?.name || active?.id || placeholder}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className={`${panelPos} bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 min-w-[230px] ${fullWidth ? 'w-full' : ''} overflow-hidden`}>
          <div className="px-3 pt-2.5 pb-1">
            <p className="text-[9px] uppercase tracking-widest text-gray-500 font-semibold">Tài khoản</p>
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            {options.map(opt => {
              const isActive = opt.id === activeId;
              return (
                <button
                  key={opt.id}
                  onClick={() => { onSelect(opt.id); setOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-700 transition-colors text-left
                    ${isActive ? 'bg-blue-500/10' : ''}`}
                >
                  <Avatar option={opt} size="md" />
                  <div className="flex-1 min-w-0">
                    {/* Tên */}
                    <p className="text-xs font-semibold text-white truncate leading-tight">
                      {opt.name || opt.id}
                    </p>
                    {/* SĐT · ID */}
                    <p className="text-[11px] text-gray-500 truncate mt-0.5">
                      <PhoneDisplay phone={opt.phone} className="text-xs text-blue-400" />
                    </p>
                  </div>
                  {isActive && (
                    <span className="text-blue-400 text-sm flex-shrink-0">✓</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
