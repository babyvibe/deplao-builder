/**
 * PluginFrame — iframe của UI plugin + cầu postMessage (JSON-RPC 2.0).
 *
 * An toàn:
 *  - sandbox không có allow-popups / allow-top-navigation / allow-modals; origin iframe là
 *    deplao-plugin://<id> (khác app) nên không chạm được DOM, store hay electronAPI;
 *  - chỉ nhận message có event.source là đúng iframe này VÀ origin đúng plugin;
 *  - pluginId lấy từ prop (iframe nào gửi), không tin giá trị trong message.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PluginUiContribution } from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import { pluginTheme } from './pluginTheme';
import { removeFrame, setFrameEventTypes } from './pluginEvents';
import { appActions, handleUiRequest, mainInvoker, UiBridgeEnv } from './pluginBridgeCore';

interface Props {
  contribution: PluginUiContribution;
  kind: 'page' | 'panel';
  /** Ngữ cảnh hội thoại đang mở (panel chat). */
  context?: any;
  className?: string;
}

export default function PluginFrame({ contribution, kind, context, className }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const keyRef = useRef(Symbol(contribution.pluginId));
  const theme = useAppStore(s => s.theme);
  const pages = usePluginStore(s => s.contributions.pages);
  const contextRef = useRef(context);
  contextRef.current = context;
  const themeRef = useRef(pluginTheme(theme));
  themeRef.current = pluginTheme(theme);
  const pageIds = useMemo(() => pages.filter(p => p.pluginId === contribution.pluginId).map(p => p.id), [pages, contribution.pluginId]);
  const pageIdsRef = useRef(pageIds);
  pageIdsRef.current = pageIds;

  const { pluginId, origin } = contribution;
  const permsRef = useRef(contribution.permissions);
  permsRef.current = contribution.permissions;
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const post = useCallback((msg: any) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    // Custom scheme: origin không dùng làm targetOrigin được ổn định → '*' (main chặn iframe điều hướng sang origin khác).
    win.postMessage(msg, /^https?:/i.test(origin) ? origin : '*');
  }, [origin]);

  useEffect(() => {
    const key = keyRef.current;
    const env: UiBridgeEnv = {
      pluginId,
      permissions: [],
      pageIds: [],
      kind: kindRef.current,
      getContext: () => contextRef.current,
      getTheme: () => themeRef.current,
      invokeMain: mainInvoker(pluginId),
      setEventTypes: types => setFrameEventTypes(pluginId, key, types, ev => post({ jsonrpc: '2.0', method: 'event', params: ev })),
      actions: appActions(pluginId),
    };
    const onMessage = async (ev: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || ev.source !== win) return;
      if (String(ev.origin).toLowerCase() !== origin.toLowerCase()) return;
      const m = ev.data;
      if (!m || m.jsonrpc !== '2.0' || m.id === undefined || typeof m.method !== 'string') return;
      env.pageIds = pageIdsRef.current;
      env.permissions = permsRef.current;
      env.kind = kindRef.current;
      try {
        const result = await handleUiRequest(env, m.method, m.params);
        post({ jsonrpc: '2.0', id: m.id, result: result === undefined ? null : result });
      } catch (err: any) {
        post({ jsonrpc: '2.0', id: m.id, error: { code: err?.code || 'ERROR', message: err?.message || String(err), data: { status: err?.status, details: err?.details } } });
      }
    };
    const onSettings = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.pluginId === pluginId) post({ jsonrpc: '2.0', method: 'settings.changed', params: detail.values });
    };
    const onCommand = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.pluginId === pluginId) post({ jsonrpc: '2.0', method: 'command', params: detail.command });
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('plugins:settingsChanged', onSettings);
    window.addEventListener('plugins:command', onCommand);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('plugins:settingsChanged', onSettings);
      window.removeEventListener('plugins:command', onCommand);
    };
  }, [pluginId, origin, post]);

  // Huỷ đăng ký sự kiện chỉ khi khung bị gỡ (không phải mỗi lần danh sách plugin tải lại).
  useEffect(() => {
    const key = keyRef.current;
    return () => removeFrame(pluginId, key);
  }, [pluginId]);

  useEffect(() => {
    post({ jsonrpc: '2.0', method: 'theme.changed', params: pluginTheme(theme) });
  }, [theme, post]);

  const contextKey = kind === 'panel' ? JSON.stringify(context ?? null) : '';
  useEffect(() => {
    if (kind === 'panel') post({ jsonrpc: '2.0', method: 'context.changed', params: contextRef.current ?? null });
  }, [kind, contextKey, post]);

  // Micro chỉ cho ứng dụng đã được duyệt quyền ui:microphone (khung khác origin bị chặn nếu thiếu allow).
  const allow = contribution.permissions?.includes('ui:microphone') ? 'microphone' : undefined;

  return (
    <iframe
      ref={iframeRef}
      src={contribution.url}
      title={`${contribution.pluginName} — ${contribution.title}`}
      sandbox="allow-scripts allow-forms allow-same-origin"
      allow={allow}
      className={className || 'w-full h-full border-0 bg-transparent'}
    />
  );
}
