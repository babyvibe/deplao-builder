import React, { useState, useEffect } from 'react';
import { useAccountStore } from '@/store/accountStore';
import AccountMultiDropdown from '../common/AccountMultiDropdown';
import QuickMessageSettings from './conversation/QuickMessageSettings';
import LabelSettings from './conversation/LabelSettings';

// ─── Types ────────────────────────────────────────────────────────────────────
type MainTab = 'quick_msg' | 'labels';

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ConversationSettings() {
  const [activeTab, setActiveTab] = useState<MainTab>('quick_msg');
  const [filterAccounts, setFilterAccounts] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');

  const { accounts, activeAccountId } = useAccountStore();

  // Auto-select first account on mount if none is active in sidebar
  useEffect(() => {
    if (accounts.length === 0) return;
    if (filterAccounts.length > 0) return;
    const initial = activeAccountId || accounts[0]?.zalo_id;
    if (initial) setFilterAccounts([initial]);
  }, [accounts]);

  return (
    <div className="flex flex-col h-full relative bg-gray-900">

      {/* Top header: tabs + search + account filter */}
      <div className="border-b border-gray-800 bg-gray-900 px-4 flex items-center gap-3 flex-wrap shrink-0">
        {/* Main tabs — pill style */}
        <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5 my-2">
          {([
            { id: 'quick_msg' as const, label: '⚡ Tin nhắn nhanh' },
            { id: 'labels'    as const, label: '🏷️ Quản lý nhãn' },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
              }`}
            >{tab.label}</button>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Multi-select account filter */}
        <div className="py-2">
          <AccountMultiDropdown
              accounts={accounts}
              selectedIds={filterAccounts}
              onChange={setFilterAccounts}
              placeholder="Lọc tài khoản..."
          />
        </div>

        {/* Search */}
        <div className="relative py-2">
          <input
            type="text"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Tìm kiếm..."
            className="bg-gray-800 border border-gray-700 text-sm rounded-lg pl-8 pr-3 py-1.5 focus:border-blue-500 outline-none w-44 text-gray-200 placeholder-gray-500"
          />
          <svg className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col min-h-0">
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
    </div>
  );
}
