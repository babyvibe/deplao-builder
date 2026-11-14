/**
 * Settings → Conversations: quick messages and conversation labels, filtered by account + search. The page is exactly the height of the frame, the list
 * scrolls inside the card.
 */
import React, { useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accounts/accountStore';
import AccountMultiDropdown from '../../common/accounts/AccountMultiDropdown';
import QuickMessageSettings from './QuickMessageSettings';
import LabelSettings from './LabelSettings';
import { SearchIcon } from '@/components/common/icons';
import { Input } from '@/components/ui';
import { SegmentedControl, SettingsPage } from '../settingsUi';
import { tr } from '../../../../shared/i18n';


// ─── Types ────────────────────────────────────────────────────────────────────
type MainTab = 'quick_msg' | 'labels';

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ConversationSettings() {
  const [activeTab, setActiveTab] = useState<MainTab>('quick_msg');
  const [filterAccounts, setFilterAccounts] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');

  const { accounts, activeAccountId } = useAccountStore(useShallow(s => ({ accounts: s.accounts, activeAccountId: s.activeAccountId })));

  // Auto-select first account on mount if none is active in sidebar
  useEffect(() => {
    if (accounts.length === 0) return;
    if (filterAccounts.length > 0) return;
    const initial = activeAccountId || accounts[0]?.zalo_id;
    if (initial) setFilterAccounts([initial]);
  }, [accounts]);

  return (
    <SettingsPage title={tr('Hội thoại')} description={tr('Tin nhắn nhanh (gõ / để chèn khi chat) và nhãn phân loại hội thoại.')} width="full" fill>
      {/* Items + account filter + search */}
      <div className="mb-3 flex flex-shrink-0 flex-wrap items-center gap-2">
        <SegmentedControl
          label={tr('Mục')}
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'quick_msg', label: tr('Tin nhắn nhanh') },
            { value: 'labels', label: tr('Nhãn') },
          ]}
        />
        <div className="flex-1" />
        <AccountMultiDropdown
          accounts={accounts}
          selectedIds={filterAccounts}
          onChange={setFilterAccounts}
          placeholder={tr('Lọc tài khoản...')}
        />
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder={tr('Tìm kiếm...')}
            aria-label={tr('Tìm kiếm')}
            className="h-9 w-48 pl-8"
          />
        </div>
      </div>

      {/* Content: the card takes the rest of the height, the list scrolls inside */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-card">
        {activeTab === 'quick_msg' && (
          <QuickMessageSettings
            accounts={accounts}
            filterAccounts={filterAccounts}
            searchText={searchText}
          />
        )}
        {activeTab === 'labels' && (
          <LabelSettings
            accounts={accounts}
            filterAccounts={filterAccounts}
            searchText={searchText}
          />
        )}
      </div>
    </SettingsPage>
  );
}
