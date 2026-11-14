/**
 * PluginNav - the "Plugin" button in the navigation bar: opens the plugin grid page (PluginHub).
 * Always shown (even with no plugin installed) so users know where to install one.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { PluginIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';

export default function PluginNav() {
  const isActive = useAppStore(s => s.view === 'plugin');
  const openPluginHub = useAppStore(s => s.openPluginHub);
  if (!ipc.plugins) return null;
  return (
    <button
      type="button"
      title={tr('Ứng dụng, API & Webhook')}
      onClick={openPluginHub}
      className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
        isActive ? 'bg-sidebar-active text-sidebar-active-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-hover hover:text-sidebar-foreground'
      }`}
    >
      <PluginIcon className="w-[18px] h-[18px]" />
    </button>
  );
}
