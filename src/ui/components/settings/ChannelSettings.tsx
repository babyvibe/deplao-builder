import React, { useState } from 'react';
import ApiSettings from './api/ApiSettings';
import ApiWebhooksPanel from './api/ApiWebhooksPanel';
import AccountSettings from './accounts/AccountSettings';
import ProxySettings from './proxy/ProxySettings';

/** One operator screen; no plugin marketplace, CRM, workflow or AI initialization. */
export default function ChannelSettings() {
  const [tab, setTab] = useState('api');
  const tabs = {api: 'API & key', webhooks: 'Webhook', accounts: 'Tài khoản', proxy: 'Proxy kênh'};
  return <section className="flex-1 h-full overflow-auto p-5">
    <h1 className="text-xl font-semibold mb-4">Quản lý kết nối đa kênh</h1>
    <nav className="flex gap-3 mb-5">
      {Object.entries(tabs).map(([id, label]) => <button key={id} className="px-3 py-2 rounded border"
        aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      <a href="/operations" className="px-3 py-2">Hàng đợi gửi</a>
    </nav>
    {tab === 'api' && <ApiSettings />}
    {tab === 'webhooks' && <ApiWebhooksPanel />}
    {tab === 'accounts' && <AccountSettings />}
    {tab === 'proxy' && <ProxySettings />}
  </section>;
}
