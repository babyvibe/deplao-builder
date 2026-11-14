/**
 * pluginStore: UI extension points of the enabled plugins (sidebar pages, chat panels, composer buttons).
 * Loaded when the app opens and each time main reports 'plugins:changed'. Use selectors when reading.
 */
import { create } from 'zustand';
import ipc, { PluginContributions, PluginInfo } from '@/lib/ipc';

export const EMPTY_CONTRIBUTIONS: PluginContributions = { pages: [], chatPanels: [], composerButtons: [] };

export const EMPTY_PLUGINS: PluginInfo[] = [];

interface PluginStore {
  contributions: PluginContributions;
  /** All plugins installed in this workspace (including disabled ones), for the Plugin page. */
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

/** Called once in App: loads the contributions and listens for changes. */
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
