/**
 * Mini App và nút đăng nhập của bot Telegram phía renderer: trạng thái mở (TelegramMiniAppHost đặt 1 lần ở App).
 * Bấm nút / link mở chúng ở lib/chat/links/chatLinks (như client Telegram: Mini App mở trong app, Mini App tự biết
 * người dùng qua initData; nút đăng nhập hỏi rồi mở link đã đăng nhập bằng trình duyệt của máy).
 */
import React from 'react';

/** inline: nút trong tin · menu: nút menu bot · main: app chính · app: Mini App theo tên (t.me/<bot>/<app>). */
export type MiniAppKind = 'inline' | 'menu' | 'main' | 'app';

export interface MiniAppRequest {
  key: number;
  accountId: string;
  botId: string;
  /** Hội thoại nơi mở (tin của bot trong nhóm → nhóm); mặc định chat với bot. */
  peerId: string;
  kind: MiniAppKind;
  /** Link của nút / menu (inline, menu); app chính không cần. */
  url?: string;
  /** Tên ngắn của Mini App (kind app). */
  appName?: string;
  startParam?: string;
  /** Tên bot: đầu khung Mini App và lời hỏi quyền. */
  botName?: string;
}

export interface UrlAuthRequest {
  key: number;
  accountId: string;
  peerId: string;
  msgId: number;
  buttonId: number;
  /** Link gốc của nút: mở khi không đăng nhập. */
  url: string;
}

interface State {
  miniApp: MiniAppRequest | null;
  urlAuth: UrlAuthRequest | null;
}

let state: State = { miniApp: null, urlAuth: null };
let seq = 0;
const listeners = new Set<() => void>();

function update(patch: Partial<State>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function openTelegramMiniApp(request: Omit<MiniAppRequest, 'key'>): void {
  update({ miniApp: { ...request, key: ++seq } });
}

export function closeTelegramMiniApp(): void {
  update({ miniApp: null });
}

export function useTelegramMiniAppRequest(): MiniAppRequest | null {
  return React.useSyncExternalStore(subscribe, () => state.miniApp, () => state.miniApp);
}

export function openTelegramUrlAuth(request: Omit<UrlAuthRequest, 'key'>): void {
  update({ urlAuth: { ...request, key: ++seq } });
}

export function closeTelegramUrlAuth(): void {
  update({ urlAuth: null });
}

export function useTelegramUrlAuthRequest(): UrlAuthRequest | null {
  return React.useSyncExternalStore(subscribe, () => state.urlAuth, () => state.urlAuth);
}
