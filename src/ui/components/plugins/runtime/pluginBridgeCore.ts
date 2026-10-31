/**
 * Xử lý JSON-RPC từ iframe plugin (phía renderer). deplao.ui.* chạy ngay trong app;
 * events.subscribe gom qua pluginEvents; mọi hàm khác chuyển sang main (plugins:invoke)
 * — nơi kiểm tra scope/quyền và gọi IPC chung.
 */
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useChatStore } from '@/store/chat/chatStore';

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
  if (!env.permissions.includes(perm)) throw new BridgeError('FORBIDDEN_SCOPE', `Plugin cần quyền "${perm}"`, 403);
}

function str(v: any, max: number, name: string): string {
  if (typeof v !== 'string' || !v || v.length > max) throw new BridgeError('VALIDATION_ERROR', `${name} phải là chuỗi 1–${max} ký tự`);
  return v;
}

export async function handleUiRequest(env: UiBridgeEnv, method: string, params: any): Promise<any> {
  const p = params && typeof params === 'object' ? params : {};
  switch (method) {
    case 'ui.ready': {
      let settings: any = {};
      try { settings = await env.invokeMain('settings.get', {}); } catch { /* plugin chưa có cài đặt */ }
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
      if (!env.pageIds.includes(pageId)) throw new BridgeError('NOT_FOUND', `Plugin không có trang "${pageId}"`, 404);
      env.actions.navigate(pageId);
      return { ok: true };
    }
    case 'ui.openExternal': {
      const url = str(p.url, 2000, 'url');
      if (!/^https?:\/\//i.test(url)) throw new BridgeError('VALIDATION_ERROR', 'Chỉ mở được liên kết http/https');
      env.actions.openExternal(url);
      return { ok: true };
    }
    case 'events.subscribe': {
      const types = Array.isArray(p.types) ? p.types.map(String).filter((t: string) => t && t.length <= 100).slice(0, 50) : [];
      await env.setEventTypes(types);
      return { ok: true };
    }
    default:
      if (method.startsWith('ui.')) throw new BridgeError('NOT_FOUND', `Không có hàm "${method}"`, 404);
      return env.invokeMain(method, p);
  }
}

/** Gọi main; lỗi → BridgeError giữ mã lỗi API. */
export function mainInvoker(pluginId: string) {
  return async (method: string, params: any): Promise<any> => {
    const res = await ipc.plugins?.invoke(pluginId, method, params);
    if (!res) throw new BridgeError('NOT_IMPLEMENTED', 'Bản app chưa hỗ trợ plugin', 501);
    if (!res.success) throw new BridgeError(res.code || 'ERROR', res.error || 'Lỗi', res.status || 400, res.details);
    return res.result;
  };
}

/** Hành động UI thật của app. */
export function appActions(pluginId: string): UiBridgeEnv['actions'] {
  return {
    openConversation: (accountId, threadId) => {
      const accounts = useAccountStore.getState();
      if (!accounts.accounts.some(a => a.zalo_id === accountId)) throw new BridgeError('NOT_FOUND', 'Không có tài khoản này trên máy', 404);
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
