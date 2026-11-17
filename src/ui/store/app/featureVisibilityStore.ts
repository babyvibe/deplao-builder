import { create } from 'zustand';
import { CHANNELS_ONLY } from '../../../shared/channelMode';

export type FeatureVisibilityKey =
  | 'dashboard'
  | 'chat'
  | 'crm'
  | 'workflow'
  | 'integration'
  | 'analytics'
  | 'erp'
  | 'plugins'
  | 'settings';

const STORAGE_KEY = 'deplao:sidebar-feature-visibility';

const DEFAULT_VISIBILITY: Record<FeatureVisibilityKey, boolean> = {
  dashboard: true,
  chat: true,
  crm: true,
  workflow: true,
  integration: true,
  analytics: true,
  erp: true,
  plugins: true,
  settings: true,
};

function loadVisibility(): Record<FeatureVisibilityKey, boolean> {
  if (CHANNELS_ONLY) return {dashboard: false, chat: true, crm: false, workflow: false,
    integration: false, analytics: false, erp: false, plugins: true, settings: true};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VISIBILITY };
    const parsed = JSON.parse(raw) as Partial<Record<FeatureVisibilityKey, boolean>>;
    // Dashboard and Chat are core navigation and are intentionally not toggleable.
    return { ...DEFAULT_VISIBILITY, ...parsed, dashboard: true, chat: true };
  } catch {
    return { ...DEFAULT_VISIBILITY };
  }
}

function persistVisibility(value: Record<FeatureVisibilityKey, boolean>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}

interface FeatureVisibilityStore {
  enabled: Record<FeatureVisibilityKey, boolean>;
  setEnabled: (feature: FeatureVisibilityKey, enabled: boolean) => void;
  toggle: (feature: FeatureVisibilityKey) => void;
  reset: () => void;
}

export const useFeatureVisibilityStore = create<FeatureVisibilityStore>((set) => ({
  enabled: loadVisibility(),
  setEnabled: (feature, enabled) => set((state) => {
    if (CHANNELS_ONLY) return state;
    if (feature === 'dashboard' || feature === 'chat') return state;
    const next = { ...state.enabled, [feature]: enabled };
    persistVisibility(next);
    return { enabled: next };
  }),
  toggle: (feature) => set((state) => {
    if (CHANNELS_ONLY) return state;
    if (feature === 'dashboard' || feature === 'chat') return state;
    const next = { ...state.enabled, [feature]: !state.enabled[feature] };
    persistVisibility(next);
    return { enabled: next };
  }),
  reset: () => {
    const next = loadVisibility();
    persistVisibility(next);
    set({ enabled: next });
  },
}));
