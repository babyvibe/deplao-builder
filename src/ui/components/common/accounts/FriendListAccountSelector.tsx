import React from 'react';
import AccountSelectorDropdown, { AccountOption } from './AccountSelectorDropdown';import { HomeIcon, MailIcon, SearchIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';


export type FriendTab = 'search' | 'friends' | 'groups' | 'requests';

interface Props {
  /** Current tab */
  tab: FriendTab;
  onTabChange: (tab: FriendTab) => void;
  /** Number of friends to show on the tab */
  friendsCount?: number;
  /** Number of groups to show on the tab */
  groupsCount?: number;
  /** Number of friend requests received, shown as a badge */
  requestsCount?: number;

  /** Merged inbox mode: show / hide the account picker */
  mergedInboxMode?: boolean;
  accounts: AccountOption[];
  activeAccountId: string | null;
  onSelectAccount: (id: string) => void;
}

const TABS: { key: FriendTab; label: string; icon: React.ReactNode }[] = [
  { key: 'search',   label: tr('Tìm kiếm'), icon: <SearchIcon className="w-4 h-4" /> },
  { key: 'friends',  label: tr('Bạn bè'),   icon: <UsersIcon className="w-4 h-4" /> },
  { key: 'groups',   label: tr('Nhóm'),     icon: <HomeIcon className="w-4 h-4" /> },
  { key: 'requests', label: tr('Lời mời'),  icon: <MailIcon className="w-4 h-4" /> },
];

/** Header of FriendList: 3 tabs on the left, account selector on the right (same as CRM) */
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
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border flex-shrink-0 bg-card">
      {/* ── Tabs (left) ── */}
      <div className="flex bg-card rounded-lg p-0.5 gap-0.5">
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
                ${isActive ? 'bg-blue-600 text-white shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
            >
              <span>{icon}</span>
              <span>{label}</span>
              {badge != null && badge > 0 && (
                <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[11px] font-bold rounded-full
                  ${isActive
                    ? 'bg-white/20 text-white'
                    : key === 'requests'
                      ? 'bg-red-500 text-white'
                      : 'bg-accent text-foreground/80'
                  }`}>
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      {/* ── Account selector (right): only shown in mergedInboxMode ── */}
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
