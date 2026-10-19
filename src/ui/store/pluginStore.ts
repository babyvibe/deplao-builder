/**
 * pluginStore — điểm mở rộng UI của plugin đang bật (trang sidebar, panel chat, nút soạn tin).
 * Tải khi mở app và mỗi khi main báo 'plugins:changed'. Dùng selector khi đọc.
 */
import { create } from 'zustand';
import ipc, { PluginContributions, PluginInfo } from '@/lib/ipc';

export const EMPTY_CONTRIBUTIONS: PluginContributions = { pages: [], chatPanels: [], composerButtons: [] };

export const EMPTY_PLUGINS: PluginInfo[] = [];

interface PluginStore {
  contributions: PluginContributions;
  /** Mọi plugin đã cài ở workspace này (kể cả đang tắt) — cho trang Plugin. */
  plugins: PluginInfo[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const usePluginStore = create<PluginStore>((set) => ({
  contributions: EMPTY_CONTRIBUTIONS,
  plugins: EMPTY_PLUGINS,
  loaded: false,
  load: async () => {
    try {
      const res = await ipc.plugins?.list();
      if (res?.success) {
        set({ contributions: res.contributions || EMPTY_CONTRIBUTIONS, plugins: res.plugins || EMPTY_PLUGINS, loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },
}));

let wired = false;

/** Gọi một lần ở App: tải contribution và nghe thay đổi. */
export function initPluginStore(): () => void {
  if (wired || !ipc.plugins) return () => undefined;
  wired = true;
  void usePluginStore.getState().load();
  const off = ipc.on?.('plugins:changed', () => { void usePluginStore.getState().load(); });
  return () => {
    wired = false;
    off?.();
  };
}
