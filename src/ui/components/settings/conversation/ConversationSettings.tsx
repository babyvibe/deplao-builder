/**
 * Cài đặt → Hội thoại: tin nhắn nhanh và nhãn hội thoại, lọc theo tài khoản + tìm kiếm. Trang cao đúng khung, danh sách
 * cuộn bên trong thẻ.
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
    <SettingsPage title="Hội thoại" description="Tin nhắn nhanh (gõ / để chèn khi chat) và nhãn phân loại hội thoại." width="full" fill>
      {/* Mục + lọc tài khoản + tìm */}
      <div className="mb-3 flex flex-shrink-0 flex-wrap items-center gap-2">
        <SegmentedControl
          label="Mục"
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'quick_msg', label: 'Tin nhắn nhanh' },
            { value: 'labels', label: 'Nhãn' },
          ]}
        />
        <div className="flex-1" />
        <AccountMultiDropdown
          accounts={accounts}
          selectedIds={filterAccounts}
          onChange={setFilterAccounts}
          placeholder="Lọc tài khoản..."
        />
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Tìm kiếm..."
            aria-label="Tìm kiếm"
            className="h-9 w-48 pl-8"
          />
        </div>
      </div>

      {/* Nội dung: thẻ cao hết phần còn lại, danh sách cuộn bên trong */}
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
