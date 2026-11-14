/**
 * A plugin button on the composer toolbar (contributes.composerButtons).
 *  - target 'backend': calls the backend's commands[id] with the conversation context; if the result has
 *    insertText → insert it into the composer, toast → show a notification.
 *  - target 'ui': opens the plugin panel (if any) and sends 'command' into the iframe.
 */
import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { usePluginStore } from '@/store/plugins/pluginStore';
import { PluginIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';

export default function PluginComposerButtons({ accountId, threadId }: { accountId: string | null; threadId: string | null }) {
  const buttons = usePluginStore(s => s.contributions.composerButtons);
  const panels = usePluginStore(s => s.contributions.chatPanels);
  const setPanel = useAppStore(s => s.setActivePluginPanel);
  const showNotification = useAppStore(s => s.showNotification);
  const [busy, setBusy] = useState<string | null>(null);

  if (!buttons.length || !accountId || !threadId) return null;

  const run = async (b: typeof buttons[number]) => {
    const context = { accountId, threadId };
    if (b.target === 'ui') {
      const panel = panels.find(p => p.pluginId === b.pluginId);
      if (panel) setPanel({ pluginId: panel.pluginId, panelId: panel.id });
      // Wait for the panel to mount before sending the command.
      setTimeout(() => window.dispatchEvent(new CustomEvent('plugins:command', { detail: { pluginId: b.pluginId, command: { id: b.id, context } } })), 150);
      return;
    }
    const key = `${b.pluginId}::${b.id}`;
    setBusy(key);
    try {
      const res = await ipc.plugins?.command(b.pluginId, b.id, context);
      if (!res?.success) {
        showNotification(res?.error || tr('Ứng dụng báo lỗi'), 'error');
        return;
      }
      const out = res.result;
      if (out && typeof out.insertText === 'string' && out.insertText) {
        window.dispatchEvent(new CustomEvent('composer:insertText', { detail: { text: out.insertText.slice(0, 5000) } }));
      }
      if (out && typeof out.toast === 'string' && out.toast) showNotification(out.toast.slice(0, 300), 'info');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {buttons.map(b => {
        const key = `${b.pluginId}::${b.id}`;
        return (
          <button
            key={key}
            type="button"
            title={`${b.title} (${b.pluginName})`}
            disabled={busy === key}
            onClick={() => run(b)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
          >
            {b.icon && b.icon.length <= 2 ? <span className="text-sm leading-none">{b.icon}</span> : <PluginIcon className="w-4 h-4" />}
          </button>
        );
      })}
    </>
  );
}
