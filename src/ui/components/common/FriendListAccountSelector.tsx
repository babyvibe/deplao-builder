import React from 'react';
import AccountSelectorDropdown, { AccountOption } from './AccountSelectorDropdown';

export type FriendTab = 'search' | 'friends' | 'groups' | 'requests';

interface Props {
  /** Tab hiện tại */
  tab: FriendTab;
  onTabChange: (tab: FriendTab) => void;
  /** Số bạn bè để hiển thị trên tab */
  friendsCount?: number;
  /** Số nhóm để hiển thị trên tab */
  groupsCount?: number;
  /** Số lời mời nhận được để hiển thị badge */
  requestsCount?: number;

  /** Chế độ gộp trang — ẩn/hiện phần chọn tài khoản */
  mergedInboxMode?: boolean;
  accounts: AccountOption[];
  activeAccountId: string | null;
  onSelectAccount: (id: string) => void;
}

const TABS: { key: FriendTab; label: string; icon: string }[] = [
  { key: 'search',   label: 'Tìm kiếm', icon: '🔍' },
  { key: 'friends',  label: 'Bạn bè',   icon: '👥' },
  { key: 'groups',   label: 'Nhóm',     icon: '🏠' },
  { key: 'requests', label: 'Lời mời',  icon: '✉️' },
];

/** Header của FriendList — 3 tab bên trái, account selector bên phải (giống CRM) */
export default function FriendListAccountSelector({
  tab,
  onTabChange,
  friendsCount,
  groupsCount,
  requestsCount,
  accounts,
  activeAccountId,
  onSelectAccount,
}: Props) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-700 flex-shrink-0 bg-gray-850">
      {/* ── Tabs (trái) ── */}
      <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
        {TABS.map(({ key, label, icon }) => {
          const isActive = tab === key;
          const badge = key === 'friends' && friendsCount
            ? friendsCount
            : key === 'groups' && groupsCount
              ? groupsCount
              : key === 'requests' && requestsCount
                ? requestsCount
                : null;
          return (
            <button
              key={key}
              onClick={() => onTabChange(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap
                ${isActive ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'}`}
            >
              <span>{icon}</span>
              <span>{label}</span>
              {badge != null && badge > 0 && (
                <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[11px] font-bold rounded-full
                  ${isActive
                    ? 'bg-white/20 text-white'
                    : key === 'requests'
                      ? 'bg-red-500 text-white'
                      : 'bg-gray-600 text-gray-300'
                  }`}>
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* ── Account selector (phải) — chỉ hiện khi mergedInboxMode ── */}
      {accounts.length > 0 && (
        <AccountSelectorDropdown
          options={accounts}
          activeId={activeAccountId}
          onSelect={onSelectAccount}
        />
      )}
    </div>
  );
}
