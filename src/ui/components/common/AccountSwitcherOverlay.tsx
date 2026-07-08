import React from 'react';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { PhoneIcon } from './icons';

/**
 * AccountSwitcherOverlay - Ctrl+Tab quick account switcher
 *
 * Hiển thị danh sách tài khoản dạng horizontal cards ở giữa màn hình.
 * Giống Windows Alt+Tab: giữ Ctrl + Tab để navigate, thả Ctrl để chọn.
 * Index 0 = "Tất cả tài khoản" (virtual), indices 1..N = accounts[0..N-1].
 */
export default function AccountSwitcherOverlay() {
  const { accountSwitcherOpen, accountSwitcherIndex, mergedInboxMode } = useAppStore();
  const { accounts } = useAccountStore();
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';

  if (!accountSwitcherOpen || accounts.length === 0) return null;

  // Normal mode: trực tiếp accounts[]. Merged mode: ["Tất cả", ...accounts]
  const totalItems = mergedInboxMode ? accounts.length + 1 : accounts.length;

  /** Lấy account thực tế theo virtual index (null nếu là "Tất cả" ở merged mode) */
  const getAcc = (vi: number) => mergedInboxMode ? accounts[vi - 1] ?? null : accounts[vi] ?? null;

  const renderCard = (virtualIdx: number) => {
    const sel = virtualIdx === accountSwitcherIndex;
    if (virtualIdx === 0 && mergedInboxMode) {
      // "Tất cả tài khoản" virtual card (merged mode only)
      return (
        <div
          key="__all__"
          className={`flex flex-col items-center gap-2 p-4 rounded-2xl transition-all duration-150 min-w-[160px] ${
            sel
              ? isLight
                ? 'bg-white/90 border-2 border-blue-500 shadow-xl shadow-blue-500/20 scale-105'
                : 'bg-gray-700/90 border-2 border-blue-500 shadow-xl shadow-blue-500/20 scale-105'
              : isLight
                ? 'bg-white/60 border border-gray-300/50 opacity-60 hover:opacity-80'
                : 'bg-gray-800/60 border border-gray-600/50 opacity-60 hover:opacity-80'
          }`}
        >
          {/* All-accounts icon */}
          <div className="w-14 h-14 rounded-full flex items-center justify-center bg-gradient-to-br from-blue-400 to-purple-500">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>

          {/* Title */}
          <p className={`text-sm font-semibold text-center truncate w-full max-w-[140px] ${
            isLight ? 'text-gray-800' : 'text-white'
          }`}>
            Tất cả tài khoản
          </p>

          {/* Hint */}
          <p className={`text-[10px] text-center truncate w-full max-w-[140px] ${
            isLight ? 'text-gray-400' : 'text-gray-400'
          }`}>
            {mergedInboxMode ? 'Hiện tất cả hội thoại' : `${accounts.length} tài khoản`}
          </p>

          {/* Empty spacing to align with account cards */}
          <div className="h-[14px]" />
        </div>
      );
    }

    // Account card (virtualIdx = 1..N → accounts[0..N-1])
    const acc = getAcc(virtualIdx);
    if (!acc) return null;

    const channel = (acc.channel || 'zalo') as string;
    const channelLabel = channel === 'zalo' ? 'Zalo' : 'Facebook';
    const channelColor = channel === 'zalo' ? '#0068FF' : '#1877F2';

    const cardBg = sel
      ? isLight
        ? 'bg-white/90 border-2 border-blue-500 shadow-xl shadow-blue-500/20 scale-105'
        : 'bg-gray-700/90 border-2 border-blue-500 shadow-xl shadow-blue-500/20 scale-105'
      : isLight
        ? 'bg-white/60 border border-gray-300/50 opacity-60 hover:opacity-80'
        : 'bg-gray-800/60 border border-gray-600/50 opacity-60 hover:opacity-80';

    return (
      <div
        key={acc.zalo_id}
        className={`flex flex-col items-center gap-2 p-4 rounded-2xl transition-all duration-150 min-w-[160px] ${cardBg}`}
      >
        {/* Avatar */}
        <div className="relative">
          {acc.avatar_url ? (
            <img
              src={toLocalMediaUrl(acc.avatar_url)}
              alt={acc.full_name}
              className="w-14 h-14 rounded-full object-cover"
            />
          ) : (
            <div className="w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-bold bg-blue-600">
              {(acc.full_name || 'A').charAt(0).toUpperCase()}
            </div>
          )}
          {/* Channel badge */}
          <span
            className="absolute -bottom-1 -right-1 text-[9px] px-1.5 py-0.5 rounded-full font-semibold border leading-none"
            style={{ backgroundColor: channelColor, color: '#fff', borderColor: isLight ? '#e5e7eb' : '#1f2937' }}
          >
            {channelLabel}
          </span>
        </div>

        {/* Name */}
        <p className={`text-sm font-semibold text-center truncate w-full max-w-[140px] ${
          isLight ? 'text-gray-800' : 'text-white'
        }`}>
          {acc.full_name}
        </p>

        {/* UID */}
        <p className={`text-[10px] font-mono truncate w-full max-w-[140px] text-center ${
          isLight ? 'text-gray-400' : 'text-gray-400'
        }`}>
          ID: {acc.zalo_id}
        </p>

        {/* Phone */}
        {acc.phone && (
          <p className={`text-[10px] truncate w-full max-w-[140px] text-center ${
            isLight ? 'text-gray-400' : 'text-gray-400'
          }`}>
            <PhoneIcon className="w-3 h-3 inline" /> {acc.phone}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className={`fixed inset-0 z-[9999] flex items-center justify-center ${
      isLight ? 'bg-white/60 backdrop-blur-sm' : 'bg-black/50 backdrop-blur-sm'
    }`}>
      <div className="flex items-center gap-4 px-6 py-8 overflow-x-auto max-w-[90vw]" style={{ scrollbarWidth: 'none' }}>
        {Array.from({ length: totalItems }, (_, i) => renderCard(i))}
      </div>
    </div>
  );
}
