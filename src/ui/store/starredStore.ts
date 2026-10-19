/**
 * starredStore - "Tin đánh dấu": which messages are starred, per account (key = threadId|msgId).
 *
 * Loaded once per account (DataAccessor → local DB, or Boss REST in employee mode). `version`
 * bumps on every change so the "Tin đánh dấu" panel knows when to reload its list.
 * Components read it with selectors only (see deplao UI perf rules).
 */
import { create } from 'zustand';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { StarredSnapshot, starKey } from '@/lib/chat/starredMessages';

interface StarredState {
  /** zaloId → keys `${threadId}|${msgId}` */
  keys: Record<string, Set<string>>;
  version: number;
  load: (zaloId: string, force?: boolean) => Promise<void>;
  isStarred: (zaloId: string, threadId: string, msgId: string) => boolean;
  setStarred: (params: { zaloId: string; threadId: string; msgId: string; starred: boolean; snapshot?: StarredSnapshot }) => Promise<boolean>;
  /** Apply a change made elsewhere (DB event, other window). */
  applyChange: (zaloId: string, threadId: string, msgId: string, starred: boolean) => void;
  /** Chế độ nhân viên — kết nối BOSS phục hồi (employee:resync): đọc lại các tài khoản đã nạp, báo panel tải lại. */
  reloadLoaded: () => Promise<void>;
}

const loading = new Map<string, Promise<void>>();

export const useStarredStore = create<StarredState>((set, get) => ({
  keys: {},
  version: 0,

  load: (zaloId, force = false) => {
    if (!zaloId) return Promise.resolve();
    if (!force && get().keys[zaloId]) return Promise.resolve();
    const running = loading.get(zaloId);
    if (running) return running;
    const task = (async () => {
      try {
        const res = await DataAccessor.getStarredMessageKeys({ zaloId });
        // Lỗi đọc (nhân viên mất kết nối BOSS) ≠ "không có tin đánh dấu": giữ tập đang có
        if (isReadFailure(res)) return;
        const rows = Array.isArray(res?.keys) ? res.keys : [];
        const keys = new Set(rows.map(row => starKey(String(row.thread_id), String(row.msg_id))));
        set(state => ({ keys: { ...state.keys, [zaloId]: keys } }));
      } catch {
        // keep the previous set; the next account switch retries
      } finally {
        loading.delete(zaloId);
      }
    })();
    loading.set(zaloId, task);
    return task;
  },

  isStarred: (zaloId, threadId, msgId) => !!get().keys[zaloId]?.has(starKey(threadId, msgId)),

  setStarred: async ({ zaloId, threadId, msgId, starred, snapshot }) => {
    try {
      const res: any = await DataAccessor.setMessageStarred({ zaloId, threadId, msgId, starred, snapshot });
      if (!res || res.success === false) return false;
      get().applyChange(zaloId, threadId, msgId, starred);
      return true;
    } catch {
      return false;
    }
  },

  applyChange: (zaloId, threadId, msgId, starred) => {
    // Account never loaded: apply now, then read the full list (a partial set must not stick)
    if (!get().keys[zaloId]) queueMicrotask(() => { void get().load(zaloId, true); });
    set(state => {
      const current = state.keys[zaloId];
      const key = starKey(threadId, msgId);
      if (current && current.has(key) === starred) return state;
      const next = new Set(current || []);
      if (starred) next.add(key);
      else next.delete(key);
      return { keys: { ...state.keys, [zaloId]: next }, version: state.version + 1 };
    });
  },

  reloadLoaded: async () => {
    const ids = Object.keys(get().keys);
    if (ids.length === 0) return;
    await Promise.allSettled(ids.map((id) => get().load(id, true)));
    set((state) => ({ version: state.version + 1 }));
  },
}));
