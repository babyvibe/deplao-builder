/**
 * Handles JSON-RPC from the plugin iframe (renderer side). deplao.ui.* runs right inside the app;
 * events.subscribe is grouped through pluginEvents; every other function is passed to main (plugins:invoke)
 * - where the scope/permission is checked and the shared IPC is called.
 */
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';
import { tr } from '../../../../shared/i18n';

export class BridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: any) {
    super(message);
  }
}

export interface UiBridgeEnv {
  pluginId: string;
  permissions: string[];
  pageIds: string[];
  kind: 'page' | 'panel';
  getContext: () => any;
  getTheme: () => { mode: string; vars: Record<string, string> };
  invokeMain: (method: string, params: any) => Promise<any>;
  setEventTypes: (types: string[]) => Promise<void>;
  actions: {
    openConversation: (accountId: string, threadId: string) => void;
    insertComposerText: (text: string) => void;
    toast: (message: string, kind: 'info' | 'success' | 'warning' | 'error') => void;
    navigate: (pageId: string) => void;
    openExternal: (url: string) => void;
  };
}

function need(env: UiBridgeEnv, perm: string): void {
  if (!env.permissions.includes(perm)) throw new BridgeError('FORBIDDEN_SCOPE', tr('Plugin cần quyền "{{perm}}"', { perm }), 403);
}

function str(v: any, max: number, name: string): string {
  if (typeof v !== 'string' || !v || v.length > max) throw new BridgeError('VALIDATION_ERROR', tr('{{name}} phải là chuỗi 1–{{max}} ký tự', { name, max }));
  return v;
}

export async function handleUiRequest(env: UiBridgeEnv, method: string, params: any): Promise<any> {
  const p = params && typeof params === 'object' ? params : {};
  switch (method) {
    case 'ui.ready': {
      let settings: any = {};
      try { settings = await env.invokeMain('settings.get', {}); } catch { /* plugin has no settings yet */ }
      return { pluginId: env.pluginId, kind: env.kind, context: env.getContext() ?? null, theme: env.getTheme(), settings };
    }
    case 'ui.openConversation':
      need(env, 'chat:read');
      env.actions.openConversation(str(p.accountId, 200, 'accountId'), str(p.threadId, 200, 'threadId'));
      return { ok: true };
    case 'ui.insertComposerText':
      need(env, 'ui:composer');
      env.actions.insertComposerText(str(p.text, 5000, 'text'));
      return { ok: true };
    case 'ui.toast': {
      const kind = ['info', 'success', 'warning', 'error'].includes(p.kind) ? p.kind : 'info';
      env.actions.toast(str(p.message, 300, 'message'), kind);
      return { ok: true };
    }
    case 'ui.navigate': {
      const pageId = str(p.pageId, 40, 'pageId');
      if (!env.pageIds.includes(pageId)) throw new BridgeError('NOT_FOUND', tr('Plugin không có trang "{{pageId}}"', { pageId }), 404);
      env.actions.navigate(pageId);
      return { ok: true };
    }
    case 'ui.openExternal': {
      const url = str(p.url, 2000, 'url');
      if (!/^https?:\/\//i.test(url)) throw new BridgeError('VALIDATION_ERROR', tr('Chỉ mở được liên kết http/https'));
      env.actions.openExternal(url);
      return { ok: true };
    }
    case 'events.subscribe': {
      const types = Array.isArray(p.types) ? p.types.map(String).filter((t: string) => t && t.length <= 100).slice(0, 50) : [];
      await env.setEventTypes(types);
      return { ok: true };
    }
    default:
      if (method.startsWith('ui.')) throw new BridgeError('NOT_FOUND', tr('Không có hàm "{{method}}"', { method }), 404);
      return env.invokeMain(method, p);
  }
}

/** Calls main; on error → BridgeError keeps the API error code. */
export function mainInvoker(pluginId: string) {
  return async (method: string, params: any): Promise<any> => {
    const res = await ipc.plugins?.invoke(pluginId, method, params);
    if (!res) throw new BridgeError('NOT_IMPLEMENTED', tr('Bản app chưa hỗ trợ plugin'), 501);
    if (!res.success) throw new BridgeError(res.code || 'ERROR', res.error || tr('Lỗi'), res.status || 400, res.details);
    return res.result;
  };
}

/** The app's real UI actions. */
export function appActions(pluginId: string): UiBridgeEnv['actions'] {
  return {
    openConversation: (accountId, threadId) => {
      const accounts = useAccountStore.getState();
      if (!accounts.accounts.some(a => a.zalo_id === accountId)) throw new BridgeError('NOT_FOUND', tr('Không có tài khoản này trên máy'), 404);
      if (accounts.activeAccountId !== accountId) accounts.setActiveAccount(accountId);
      const contact = (useChatStore.getState().contacts[accountId] || []).find(c => c.contact_id === threadId);
      useAppStore.getState().setView('chat');
      useChatStore.getState().setActiveThread(threadId, contact?.contact_type === 'group' ? 1 : 0);
    },
    insertComposerText: text => {
      window.dispatchEvent(new CustomEvent('composer:insertText', { detail: { text } }));
    },
    toast: (message, kind) => useAppStore.getState().showNotification(message, kind),
    navigate: pageId => useAppStore.getState().openPluginPage(pluginId, pageId),
    openExternal: url => ipc.shell?.openExternal(url),
  };
}
