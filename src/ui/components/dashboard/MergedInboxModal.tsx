import React, { useState } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';

interface Props {
  onClose: () => void;
}

export default function MergedInboxModal({ onClose }: Props) {
  const { accounts } = useAccountStore();
  const { enterMergedInbox, mergedInboxMode, mergedInboxAccounts } = useAppStore();

  // Pre-select currently merged accounts if already in merged mode
  const [selected, setSelected] = useState<string[]>(
    mergedInboxMode ? mergedInboxAccounts : accounts.map(a => a.zalo_id)
  );

  const toggle = (zaloId: string) => {
    setSelected(prev =>
      prev.includes(zaloId) ? prev.filter(id => id !== zaloId) : [...prev, zaloId]
    );
  };

  const handleEnter = () => {
    if (selected.length < 2) return;
    enterMergedInbox(selected);
    onClose();
  };

  const allSelected = accounts.length > 0 && selected.length === accounts.length;
  const toggleAll = () => {
    setSelected(allSelected ? [] : accounts.map(a => a.zalo_id));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-700 rounded-2xl w-[420px] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-600/40 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 00-3-3.87"/>
                <path d="M16 3.13a4 4 0 010 7.75"/>
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Chế độ Gộp tài khoản</h2>
              <p className="text-xs text-gray-400 mt-0.5">Xem tất cả hội thoại từ nhiều tài khoản trong 1 nơi</p>
            </div>
            <button onClick={onClose} className="ml-auto text-gray-500 hover:text-gray-300 transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Account list */}
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-400 font-medium">Chọn tài khoản ({selected.length}/{accounts.length})</span>
            <button onClick={toggleAll} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
              {allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
            </button>
          </div>

          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {accounts.map(acc => {
              const isSelected = selected.includes(acc.zalo_id);
              return (
                <label
                  key={acc.zalo_id}
                  className={`flex items-center gap-3 p-2.5 rounded-xl cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-600/15 border border-blue-600/40' : 'bg-gray-750 border border-transparent hover:bg-gray-700'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(acc.zalo_id)}
                    className="w-4 h-4 rounded accent-blue-500 flex-shrink-0"
                  />
                  <div className="relative flex-shrink-0">
                    {acc.avatar_url
                      ? <img src={acc.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
                      : <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
                          {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                        </div>
                    }
                    {/* Online indicator */}
                    {acc.isConnected && (
                      <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-gray-800" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-200 truncate">{acc.full_name || acc.zalo_id}</p>
                    <p className="text-[11px] text-gray-500 truncate">
                      {acc.phone || acc.zalo_id}
                      {acc.is_business ? ' • 💼 Business' : ''}
                    </p>
                  </div>
                  {/* Connected status */}
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                    acc.isConnected ? 'bg-green-900/50 text-green-400' : 'bg-gray-700 text-gray-500'
                  }`}>
                    {acc.isConnected ? 'Online' : 'Offline'}
                  </span>
                </label>
              );
            })}
          </div>

          {selected.length < 2 && (
            <p className="text-xs text-yellow-500 mt-2 flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              Chọn ít nhất 2 tài khoản để gộp
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-sm rounded-xl bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors font-medium"
          >
            Huỷ
          </button>
          <button
            onClick={handleEnter}
            disabled={selected.length < 2}
            className="flex-1 px-4 py-2.5 text-sm rounded-xl bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium flex items-center justify-center gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87"/>
              <path d="M16 3.13a4 4 0 010 7.75"/>
            </svg>
            Vào chế độ gộp ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}

