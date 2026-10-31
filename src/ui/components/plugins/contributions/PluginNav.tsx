/**
 * PluginNav — nút "Plugin" ở thanh điều hướng: mở trang lưới plugin (PluginHub).
 * Luôn hiện (kể cả chưa cài plugin nào) để người dùng biết chỗ cài.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { PluginIcon } from '@/components/common/icons';

export default function PluginNav() {
  const isActive = useAppStore(s => s.view === 'plugin');
  const openPluginHub = useAppStore(s => s.openPluginHub);
  if (!ipc.plugins) return null;
  return (
    <button
      type="button"
      title="Ứng dụng, API & Webhook"
      onClick={openPluginHub}
      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
        isActive ? 'bg-sidebar-active text-sidebar-active-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-hover hover:text-sidebar-foreground'
      }`}
    >
      <PluginIcon className="w-[18px] h-[18px]" />
    </button>
  );
}
