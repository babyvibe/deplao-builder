/**
 * Mini Apps and the login buttons of Telegram bots on the renderer side: open state (TelegramMiniAppHost is set once in App).
 * Tapping a button / link opens them through lib/chat/links/chatLinks (as the Telegram client does: the Mini App opens in the app, the Mini App knows
 * the user through initData; the login button asks first, then opens the logged-in link in the machine's browser).
 */
import React from 'react';

/** inline: a button in a message · menu: the bot's menu button · main: the main app · app: a Mini App by name (t.me/<bot>/<app>). */
export type MiniAppKind = 'inline' | 'menu' | 'main' | 'app';

export interface MiniAppRequest {
  key: number;
  accountId: string;
  botId: string;
  /** Conversation where it opens (a bot's message in a group → the group); by default the chat with the bot. */
  peerId: string;
  kind: MiniAppKind;
  /** Link of the button / menu (inline, menu); the main app does not need one. */
  url?: string;
  /** Short name of the Mini App (kind app). */
  appName?: string;
  startParam?: string;
  /** Bot name: the top of the Mini App frame and the permission prompt. */
  botName?: string;
}

export interface UrlAuthRequest {
  key: number;
  accountId: string;
  peerId: string;
  msgId: number;
  buttonId: number;
  /** Original link of the button: opened when not logged in. */
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
