import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore, LabelData } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { Button } from '@/components/ui';
import { RefreshIcon } from '@/components/common/icons';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { CHANNEL, isZalo } from '@/lib/channels/channelHelper';
import { getAdapter } from '@/lib/channels/adapters/registry';

// Cache TTL: 12 hour
const FRIENDS_CACHE_TTL = 12 * 60 * 60 * 1000;

// ─── Module-level session cache (survives modal open/close, resets on app restart) ───
const _sessionFriendsCache = new Map<string, { friends: any[]; fetchedAt: number }>();

/** Báo lỗi tải gọn ngay trong danh sách (chế độ nhân viên: mất kết nối BOSS) — không trông như "Không tìm thấy". */
function LoadFailedRow({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-4 py-6 text-xs text-muted-foreground">
      <span>{text}</span>
      <Button variant="link" size="sm" className="text-xs" onClick={() => onRetry()}>Thử lại</Button>
    </div>
  );
}

/** Shared hook: load friends from session cache → DB cache → API. `accountId`: tài khoản khác tài khoản đang mở. */
function useFriends(accountId?: string | null) {
  // Chọn kèm accounts để vẫn cập nhật khi tài khoản đổi
  const { accounts, storeActiveAccountId } = useAccountStore(useShallow(s => ({
    accounts: s.accounts, storeActiveAccountId: s.activeAccountId,
  })));
  const activeAccountId = accountId || storeActiveAccountId;
  const getActiveAccount = () => accounts.find(a => a.zalo_id === activeAccountId);
  const [friends, setFriends] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Đọc danh sách bạn bè lỗi (chế độ nhân viên: mất kết nối BOSS) và API cũng không trả gì → "Không tải được — Thử lại"
  // thay vì "Không có bạn bè nào"
  const [loadFailed, setLoadFailed] = useState(false);

  const acc = getActiveAccount();
  const auth = acc ? buildZaloAuth(acc, activeAccountId) : null;

  const fetchFromApiRef = useRef<((force?: boolean) => Promise<boolean>) | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const loadSeqRef = useRef(0);

  // Keep fetchFromApi up-to-date without causing effect re-runs. true = got a list.
  fetchFromApiRef.current = async (force = false) => {
    if (!isZalo(acc?.channel) || !auth || !activeAccountId) return false;
    setRefreshing(true);
    try {
      const res = await ipc.zalo?.getFriends(auth);
      const list: any[] = Array.isArray(res?.response) ? res.response : [];
      if (list.length > 0) {
        await DataAccessor.saveFriends({ zaloId: activeAccountId, friends: list });
        _sessionFriendsCache.set(activeAccountId, { friends: list, fetchedAt: Date.now() });
        setFriends(list);
        setLoadFailed(false);
        return true;
      }
    } catch {} finally { setRefreshing(false); }
    return false;
  };

  // Lần tải mới nhất (mở modal, "Thử lại", kết nối lại); lần tải cũ hơn / sau khi đổi tài khoản bị bỏ
  loadRef.current = async () => {
    if (!isZalo(acc?.channel)) {
      setFriends([]);
      setLoading(false);
      setRefreshing(false);
      setLoadFailed(false);
      return;
    }
    if (!auth || !activeAccountId) return;
    const accountId = activeAccountId;
    const seq = ++loadSeqRef.current;
    const stale = () => seq !== loadSeqRef.current;

    // 1. Check session cache first (instant, no IPC)
    const session = _sessionFriendsCache.get(accountId);
    if (session?.friends?.length) {
      setFriends(session.friends);
      setLoading(false);
      setLoadFailed(false);
      // Background refresh if stale
      if (Date.now() - session.fetchedAt > FRIENDS_CACHE_TTL) {
        fetchFromApiRef.current?.();
      }
      return;
    }

    setLoading(true);
    try {
      // 2. Load from DB cache
      const cached = await DataAccessor.getFriends({ zaloId: accountId });
      if (stale()) return;
      const readFailed = isReadFailure(cached);
      if (readFailed) console.warn('[GroupModals] Không tải được danh sách bạn bè:', readFailureMessage(cached));

      if (!readFailed && cached?.friends?.length) {
        const mapped = cached.friends.map((f: any) => ({
          userId: f.userId,
          alias: f.alias || '',
          displayName: f.displayName,
          zaloName: f.displayName,
          avatar: f.avatar,
          phoneNumber: f.phoneNumber,
        }));
        setFriends(mapped);
        setLoading(false);
        setLoadFailed(false);
        // Update session cache
        _sessionFriendsCache.set(accountId, { friends: mapped, fetchedAt: cached.lastFetched || 0 });
        // Background refresh if stale
        if (Date.now() - (cached.lastFetched || 0) > FRIENDS_CACHE_TTL) {
          fetchFromApiRef.current?.();
        }
      } else {
        // 3. No cache (or the cache read failed) → fetch from API
        const got = await fetchFromApiRef.current?.();
        if (stale()) return;
        setLoading(false);
        if (readFailed && !got) setLoadFailed(true);
      }
    } catch {
      if (!stale()) {
        setLoading(false);
        setLoadFailed(true);
      }
    }
  };

  useEffect(() => {
    void loadRef.current();
    return () => { loadSeqRef.current += 1; }; // đóng modal / đổi tài khoản: bỏ lần tải đang chạy
  }, [activeAccountId]);

  // Chế độ nhân viên: kết nối BOSS phục hồi → tải lại nếu lần trước lỗi / chưa có bạn bè nào
  useEmployeeResync(() => (loadFailed || friends.length === 0 ? loadRef.current() : undefined));

  const refresh = () => {
    // Force refresh: clear session cache for current account then fetch
    if (activeAccountId) _sessionFriendsCache.delete(activeAccountId);
    fetchFromApiRef.current?.();
  };

  const retry = useCallback(() => { void loadRef.current(); }, []);

  return { friends, loading, refreshing, refresh, loadFailed, retry };
}

type FilterLocalLabel = { id: number; name: string; color: string; emoji: string };
const NO_FILTER_LABELS: FilterLocalLabel[] = [];
const NO_LABEL_THREADS: Map<number, string[]> = new Map();

/**
 * Nhãn Local + hội thoại đã gắn của tài khoản (bộ lọc trong Tạo nhóm / Gửi danh thiếp). Lần đọc lỗi (chế độ nhân viên)
 * giữ nhãn / gán nhãn đang có của đúng tài khoản (không thay bằng rỗng), `failed` → hiện "Thử lại" trên bộ lọc.
 */
function useLocalLabelFilter(accountId: string | null) {
  const [state, setState] = useState<{
    accountId: string | null; labels: FilterLocalLabel[]; threadMap: Map<number, string[]>; failed: boolean;
  }>({ accountId: null, labels: NO_FILTER_LABELS, threadMap: NO_LABEL_THREADS, failed: false });

  const load = useCallback(async () => {
    if (!accountId) return;
    const [labelsRes, threadsRes] = await Promise.all([
      DataAccessor.getLocalLabels({ zaloId: accountId }).catch(() => null),
      DataAccessor.getLocalLabelThreads({ zaloId: accountId }).catch(() => null),
    ]);
    const labelsOk = !!labelsRes && !isReadFailure(labelsRes);
    const threadsOk = !!threadsRes && !isReadFailure(threadsRes);
    if (!labelsOk || !threadsOk) {
      console.warn('[GroupModals] Không tải được Nhãn Local:', readFailureMessage(labelsOk ? threadsRes : labelsRes) || 'lỗi không rõ');
    }
    let labels: FilterLocalLabel[] | null = null;
    if (labelsOk) {
      const rawLabels: any[] = (labelsRes?.labels || []).filter((l: any) => l.isActive !== 0);
      labels = rawLabels.map((l: any) => ({ id: l.id, name: l.name, color: l.color, emoji: l.emoji || '' }));
    }
    let threadMap: Map<number, string[]> | null = null;
    if (threadsOk) {
      const threads: { label_id: number; thread_id: string }[] = threadsRes?.threads || [];
      threadMap = new Map<number, string[]>();
      for (const t of threads) {
        if (!threadMap.has(t.label_id)) threadMap.set(t.label_id, []);
        threadMap.get(t.label_id)!.push(t.thread_id);
      }
    }
    setState(prev => {
      const same = prev.accountId === accountId;
      return {
        accountId,
        labels: labels ?? (same ? prev.labels : NO_FILTER_LABELS),
        threadMap: threadMap ?? (same ? prev.threadMap : NO_LABEL_THREADS),
        failed: !labels || !threadMap,
      };
    });
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);
  // Chế độ nhân viên: kết nối BOSS phục hồi → tải lại
  useEmployeeResync(load);

  const current = state.accountId === accountId;
  return {
    localLabelList: current ? state.labels : NO_FILTER_LABELS,
    localLabelThreadMap: current ? state.threadMap : NO_LABEL_THREADS,
    localLabelsFailed: current && state.failed,
    reloadLocalLabels: load,
  };
}

// ─── LabelTabsFilter - 2 tabs Local/Zalo, chọn nhiều ────────────────────────
function LabelTabsFilter({
  zaloLabels,
  localLabels,
  value,
  onChange,
  localFailed = false,
  onRetryLocal,
}: {
  zaloLabels: LabelData[];
  localLabels: { id: number; name: string; color: string; emoji: string }[];
  value: Set<string>;
  onChange: (keys: Set<string>) => void;
  /** Lần tải Nhãn Local gần nhất lỗi (chế độ nhân viên) → tab Local hiện "Thử lại" thay vì "Không có nhãn". */
  localFailed?: boolean;
  onRetryLocal?: () => void;
}) {
  const [tab, setTab] = React.useState<'local' | 'zalo'>(
      'local'
  );

  const toggleKey = (key: string) => {
    const next = new Set(value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  // Đọc lỗi: vẫn hiện tab Local (kèm "Thử lại") dù chưa có nhãn nào
  const hasLocal = localLabels.length > 0 || localFailed;
  const hasZalo = zaloLabels.length > 0;
  const showLocalRetry = tab === 'local' && localFailed && !!onRetryLocal;
  const selectedCount = value.size;
  const selectedLocalCount = [...value].filter(k => k.startsWith('l:')).length;
  const selectedZaloCount = [...value].filter(k => k.startsWith('z:')).length;

  const currentLabels: Array<{ key: string; label: string; color: string; emoji: string }> =
    tab === 'local'
      ? localLabels.map(l => ({ key: `l:${l.id}`, label: l.name, color: l.color, emoji: l.emoji }))
      : zaloLabels.map(l => ({ key: `z:${l.id}`, label: l.text, color: l.color, emoji: l.emoji || '' }));

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border/60 px-4">
        {hasLocal && (
          <button
            onClick={() => setTab('local')}
            className={`relative flex items-center gap-1.5 py-2 pr-4 text-xs font-medium transition-colors ${
              tab === 'local' ? 'text-purple-400' : 'text-muted-foreground hover:text-foreground/80'
            }`}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="text-purple-400 flex-shrink-0">
              <circle cx="12" cy="12" r="10"/>
            </svg>
            Nhãn Local
            {selectedLocalCount > 0 && (
              <span className="ml-1 bg-purple-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {selectedLocalCount}
              </span>
            )}
            {tab === 'local' && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-400 rounded-t" />}
          </button>
        )}
        {hasZalo && (
          <button
            onClick={() => setTab('zalo')}
            className={`relative flex items-center gap-1.5 py-2 pr-4 text-xs font-medium transition-colors ${
              tab === CHANNEL.ZALO ? 'text-blue-400' : 'text-muted-foreground hover:text-foreground/80'
            }`}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="text-blue-400 flex-shrink-0">
              <circle cx="12" cy="12" r="10"/>
            </svg>
            Nhãn Zalo
            {selectedZaloCount > 0 && (
              <span className="ml-1 bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {selectedZaloCount}
              </span>
            )}
            {tab === CHANNEL.ZALO && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400 rounded-t" />}
          </button>
        )}
        {selectedCount > 0 && (
          <button onClick={clearAll} className="ml-auto text-[11px] text-muted-foreground hover:text-red-400 transition-colors py-2">
            Xóa bộ lọc ({selectedCount})
          </button>
        )}
      </div>

      {/* Label chips */}
      <div className="flex gap-1.5 px-4 py-2.5 max-h-[80px] overflow-y-auto">
        {currentLabels.length === 0 ? (
          showLocalRetry ? null : <span className="text-xs text-muted-foreground py-1">Không có nhãn</span>
        ) : currentLabels.map(({ key, label, color, emoji }) => {
          const active = value.has(key);
          return (
            <button
              key={key}
              onClick={() => toggleKey(key)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                active ? 'text-foreground ring-2 ring-offset-1 ring-offset-background ring-foreground/30' : 'bg-muted text-foreground/80 hover:bg-accent'
              }`}
              style={active ? { backgroundColor: color || (tab === 'local' ? '#9333ea' : '#2563eb') } : {}}
            >
              {emoji ? (
                <span className="text-sm leading-none">{emoji}</span>
              ) : color ? (
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              ) : null}
              {label}
              {active && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
            </button>
          );
        })}
        {showLocalRetry && (
          <button
            type="button"
            onClick={() => onRetryLocal?.()}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs whitespace-nowrap border border-input text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
            title="Không tải được Nhãn Local — bấm để thử lại"
          >
            <RefreshIcon className="w-3 h-3" />
            {localLabels.length === 0 ? 'Không tải được nhãn · Thử lại' : 'Thử lại'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── CreateGroupModal ────────────────────────────────────────────────────────
export function CreateGroupModal({ onClose, onCreated, preSelected, accountId }: {
  onClose: () => void;
  onCreated?: (groupId: string, name: string) => void;
  preSelected?: string[];
  /** Tạo bằng tài khoản Zalo này thay vì tài khoản đang mở (thao tác nhanh, chế độ gộp trang). */
  accountId?: string;
}) {
  // Selector: modal không render lại với mọi tin nhắn / đang gõ của các hội thoại khác
  const { accounts, storeActiveAccountId } = useAccountStore(useShallow(s => ({
    accounts: s.accounts, storeActiveAccountId: s.activeAccountId,
  })));
  const activeAccountId = accountId || storeActiveAccountId;
  const getActiveAccount = () => accounts.find(a => a.zalo_id === activeAccountId);
  const showAccountName = !!accountId && accountId !== storeActiveAccountId;
  const { showNotification, labels: allLabels } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, labels: s.labels,
  })));
  const contacts = useChatStore(s => s.contacts);

  const zaloLabels: LabelData[] = activeAccountId ? (allLabels[activeAccountId] || []) : [];
  const accountContacts = activeAccountId ? (contacts[activeAccountId] || []) : [];

  const [groupName, setGroupName] = useState('');
  const [search, setSearch] = useState('');
  // selectedLabelKeys: Set of "z:ID" or "l:ID" - cho chọn nhiều
  const [selectedLabelKeys, setSelectedLabelKeys] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set(preSelected || []));
  const [creating, setCreating] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarPath, setAvatarPath] = useState<string>('');

  // Local labels + their thread assignments (lỗi đọc giữ dữ liệu cũ, "Thử lại", tải lại khi kết nối BOSS phục hồi)
  const { localLabelList, localLabelThreadMap, localLabelsFailed, reloadLocalLabels } = useLocalLabelFilter(activeAccountId);

  const groupNameRef = useRef<HTMLInputElement>(null);

  const { friends, loading, refreshing, refresh, loadFailed: friendsFailed, retry: retryFriends } = useFriends(activeAccountId);
  const acc = getActiveAccount();
  const auth = acc ? buildZaloAuth(acc, activeAccountId) : null;

  useEffect(() => { groupNameRef.current?.focus(); }, []);

  const toggleSelect = (id: string) =>
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  // Electron mới bỏ File.path (ảnh chọn qua input bị bỏ qua khi tạo nhóm) → hộp chọn file của máy trả đường dẫn thật
  const pickAvatar = async () => {
    const res: any = await ipc.file?.openDialog({ filters: [{ name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    const path = res?.filePaths?.[0];
    if (!path) return;
    setAvatarPath(path);
    setAvatarPreview(toLocalMediaUrl(path));
  };

  const matchFilter = (name: string, phone: string, id: string) => {
    const q = search.toLowerCase();
    if (q && !name.toLowerCase().includes(q) && !phone.includes(q) && !id.includes(q)) return false;
    if (selectedLabelKeys.size > 0) {
      let inAny = false;
      for (const key of selectedLabelKeys) {
        if (key.startsWith('z:')) {
          const labelId = parseInt(key.slice(2));
          const lbl = zaloLabels.find(l => l.id === labelId);
          if (lbl && lbl.conversations.includes(id)) { inAny = true; break; }
        } else if (key.startsWith('l:')) {
          const labelId = parseInt(key.slice(2));
          const threads = localLabelThreadMap.get(labelId) || [];
          if (threads.includes(id)) { inAny = true; break; }
        }
      }
      if (!inAny) return false;
    }
    return true;
  };

  const filteredFriends = friends.filter(f =>
    matchFilter(f?.alias || f.displayName || f.zaloName || f.userId || '', f.phoneNumber || '', f.userId || '')
  );

  const recentContacts = accountContacts
    .filter(c => c.contact_type !== 'group' && matchFilter(c.alias || c.display_name || c.contact_id, c.phone || '', c.contact_id))
    .slice(0, 8);

  const recentIds = new Set(recentContacts.map(c => c.contact_id));
  const byLetter: Record<string, any[]> = {};
  filteredFriends.forEach(f => {
    if (recentIds.has(f.userId)) return;
    const l = (f?.alias || f.displayName || f.zaloName || 'Z').charAt(0).toUpperCase();
    if (!byLetter[l]) byLetter[l] = [];
    byLetter[l].push(f);
  });

  const handleCreate = async () => {
    if (!auth || !groupName.trim() || selected.size < 1) return;
    setCreating(true);
    try {
      const res = await ipc.zalo?.createGroup({
        auth,
        name: groupName.trim(),
        members: [...selected],
        avatarPath: avatarPath || undefined,
      });
      if (res?.success) {
        showNotification('Đã tạo nhóm!', 'success');
        onCreated?.(String(res.response?.groupId || ''), groupName.trim());
        onClose();
      } else {
        showNotification('Lỗi tạo nhóm: ' + (res?.error || 'Không xác định'), 'error');
      }
    } catch (e: any) { showNotification('Lỗi: ' + e.message, 'error'); }
    finally { setCreating(false); }
  };

  // Nhãn Local đọc lỗi vẫn hiện bộ lọc (tab Local kèm "Thử lại")
  const hasAnyLabels = zaloLabels.length > 0 || localLabelList.length > 0 || localLabelsFailed;
  const friendsLoadFailed = friendsFailed && friends.length === 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl w-[480px] max-h-[88vh] flex flex-col border border-border overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-foreground font-semibold text-base">Tạo nhóm</h2>
            {showAccountName && (
              <p className="truncate text-xs text-muted-foreground">
                Bằng tài khoản {getActiveAccount()?.full_name || getActiveAccount()?.display_name || activeAccountId}
              </p>
            )}
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Group name + avatar row */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border flex-shrink-0">
          <button
            type="button"
            onClick={() => void pickAvatar()}
            className="w-11 h-11 rounded-full bg-muted flex items-center justify-center flex-shrink-0 cursor-pointer hover:bg-accent transition-colors overflow-hidden relative"
            title="Thêm ảnh nhóm"
          >
            {avatarPreview ? (
              <img src={avatarPreview} alt="" className="w-full h-full object-cover" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground">
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>
              </svg>
            )}
          </button>
          <input ref={groupNameRef} value={groupName} onChange={e => setGroupName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="Nhập tên nhóm..."
            className="flex-1 bg-transparent border-b border-input pb-1 text-foreground text-sm focus:outline-none focus:border-blue-500 placeholder-subtle-foreground" />
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-border flex-shrink-0">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Nhập tên, số điện thoại, hoặc danh sách số điện thoại"
              className="w-full bg-muted border border-input rounded-full pl-9 pr-3 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
          </div>
        </div>

        {/* Label filter - 2 tabs: Local (default) / Zalo, chọn nhiều */}
        {hasAnyLabels && (
          <div className="border-b border-border flex-shrink-0">
            <LabelTabsFilter
              zaloLabels={zaloLabels}
              localLabels={localLabelList}
              value={selectedLabelKeys}
              onChange={setSelectedLabelKeys}
              localFailed={localLabelsFailed}
              onRetryLocal={reloadLocalLabels}
            />
          </div>
        )}

        {/* Contact list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <p className="text-center text-muted-foreground text-sm py-10">Đang tải danh sách bạn bè...</p>
          ) : (
            <>
              {/* Refresh bar */}
              <div className="flex items-center justify-between px-4 pt-2 pb-1">
                <span className="text-xs text-muted-foreground">{refreshing ? 'Đang cập nhật...' : friendsLoadFailed ? 'Chưa tải được bạn bè' : `${friends.length} bạn bè`}</span>
                <button onClick={refresh} disabled={refreshing}
                  className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 flex items-center gap-1">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    className={refreshing ? 'animate-spin' : ''}>
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                  Làm mới
                </button>
              </div>
              {recentContacts.length > 0 && (
                <div>
                  <p className="px-4 py-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">Trò chuyện gần đây</p>
                  {recentContacts.map(c => (
                    <PersonRow key={c.contact_id} id={c.contact_id} name={c.alias || c.display_name || c.contact_id}
                      avatar={c.avatar_url} subtitle={c.phone || undefined}
                      selected={selected.has(c.contact_id)} onToggle={() => toggleSelect(c.contact_id)} />
                  ))}
                </div>
              )}
              {Object.keys(byLetter).sort().map(letter => (
                <div key={letter}>
                  <p className="px-4 py-1.5 text-xs text-muted-foreground font-medium">{letter}</p>
                  {byLetter[letter].map(f => (
                    <PersonRow key={f.userId} id={f.userId}
                      name={f?.alias || f.displayName || f.zaloName || f.userId} avatar={f.avatar}
                      subtitle={f.phoneNumber || undefined}
                      selected={selected.has(f.userId)} onToggle={() => toggleSelect(f.userId)} />
                  ))}
                </div>
              ))}
              {/* Danh sách bạn bè đọc lỗi (chế độ nhân viên) ≠ "Không tìm thấy" */}
              {friendsLoadFailed && <LoadFailedRow text="Không tải được danh sách bạn bè" onRetry={retryFriends} />}
              {!friendsLoadFailed && filteredFriends.length === 0 && recentContacts.length === 0 && (
                <p className="text-center text-muted-foreground text-sm py-10">Không tìm thấy</p>
              )}
            </>
          )}
        </div>

        {/* Selected count */}
        {selected.size > 0 && (
          <div className="flex-shrink-0 px-5 py-2 border-t border-border text-xs text-muted-foreground">
            Đã chọn <span className="text-blue-400 font-semibold">{selected.size}</span> thành viên
          </div>
        )}

        {/* Footer */}
        <div className="flex-shrink-0 flex gap-3 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-input text-sm text-foreground/80 hover:bg-muted transition-colors">Hủy</button>
          <button onClick={handleCreate} disabled={!groupName.trim() || selected.size < 1 || creating}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {creating ? 'Đang tạo...' : 'Tạo nhóm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── InviteToGroupModal ──────────────────────────────────────────────────────
export function InviteToGroupModal({ contactId, contactName, onClose }: {
  contactId: string;
  contactName?: string;
  onClose: () => void;
}) {
  const { getActiveAccount, activeAccountId } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, activeAccountId: s.activeAccountId, accounts: s.accounts,
  })));
  const { showNotification, labels: allLabels } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, labels: s.labels,
  })));
  const contacts = useChatStore(s => s.contacts);

  const labels: LabelData[] = activeAccountId ? (allLabels[activeAccountId] || []) : [];
  const accountContacts = activeAccountId ? (contacts[activeAccountId] || []) : [];

  const [search, setSearch] = useState('');
  const [selectedLabel, setSelectedLabel] = useState<number | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState(false);

  const acc = getActiveAccount();
  const auth = acc ? buildZaloAuth(acc, activeAccountId) : null;

  const groups = accountContacts.filter(c => c.contact_type === 'group').filter(g => {
    const name = (g.display_name || '').toLowerCase();
    const q = search.toLowerCase();
    if (q && !name.includes(q)) return false;
    if (selectedLabel !== null) {
      const lbl = labels.find(l => l.id === selectedLabel);
      if (lbl && !lbl.conversations.includes(g.contact_id)) return false;
    }
    return true;
  });

  const toggleGroup = (id: string) =>
    setSelectedGroups(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const handleInvite = async () => {
    if (!auth || selectedGroups.size === 0) return;
    setInviting(true);
    let success = 0, failed = 0;
    for (const groupId of selectedGroups) {
      try {
        const res = await ipc.zalo?.addUserToGroup({ auth, userId: contactId, groupId });
        if (res?.success) success++; else failed++;
      } catch { failed++; }
    }
    setInviting(false);
    if (success > 0) showNotification(`Đã mời vào ${success} nhóm`, 'success');
    if (failed > 0) showNotification(`Lỗi: ${failed} nhóm không thêm được`, 'error');
    if (success > 0) onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl w-[480px] max-h-[88vh] flex flex-col border border-border overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-foreground font-semibold text-base">Mời tham gia nhóm</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="px-4 py-2.5 border-b border-border">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Tìm nhóm theo tên"
              className="w-full border border-input bg-muted rounded-full pl-9 pr-3 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
          </div>
        </div>
        {labels.length > 0 && (
          <div className="flex-shrink-0 flex gap-1.5 px-4 py-2 overflow-x-auto border-b border-border scrollbar-hide" style={{ minHeight: '3.375rem', maxHeight: '3.375rem' }}>
            <LabelChip label="Tất cả" active={selectedLabel === null} onClick={() => setSelectedLabel(null)} />
            {labels.map(l => (
              <LabelChip key={l.id} label={l.text} active={selectedLabel === l.id}
                onClick={() => setSelectedLabel(p => p === l.id ? null : l.id)} color={l.color} emoji={l.emoji} />
            ))}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <p className="px-4 py-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">Nhóm</p>
          {groups.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-10">{search ? 'Không tìm thấy nhóm' : 'Bạn chưa có nhóm nào'}</p>
          ) : groups.map(g => (
            <PersonRow key={g.contact_id} id={g.contact_id} name={g.display_name || g.contact_id}
              avatar={g.avatar_url} selected={selectedGroups.has(g.contact_id)}
              onToggle={() => toggleGroup(g.contact_id)} isGroup />
          ))}
        </div>
        <div className="flex gap-3 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-input text-sm text-foreground/80 hover:bg-muted transition-colors">Hủy</button>
          <button onClick={handleInvite} disabled={selectedGroups.size === 0 || inviting}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {inviting ? 'Đang mời...' : `Mời${selectedGroups.size > 0 ? ` (${selectedGroups.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SendCardModal ───────────────────────────────────────────────────────────
export function SendCardModal({ threadId, threadType, onClose }: {
  threadId: string;
  threadType: number;
  onClose: () => void;
}) {
  // Selector: modal không render lại với mọi tin nhắn / đang gõ của các hội thoại khác
  const { getActiveAccount, activeAccountId } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, activeAccountId: s.activeAccountId, accounts: s.accounts,
  })));
  const { showNotification, labels: allLabels } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, labels: s.labels,
  })));
  const contacts = useChatStore(s => s.contacts);

  const labels: LabelData[] = activeAccountId ? (allLabels[activeAccountId] || []) : [];
  const accountContacts = activeAccountId ? (contacts[activeAccountId] || []) : [];
  const [search, setSearch] = useState('');
  const [selectedLabelKeys, setSelectedLabelKeys] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  // Local labels (same pattern as CreateGroupModal): lỗi đọc giữ dữ liệu cũ, "Thử lại", tải lại khi kết nối phục hồi
  const { localLabelList, localLabelThreadMap, localLabelsFailed, reloadLocalLabels } = useLocalLabelFilter(activeAccountId);

  const { friends, loading, refreshing, refresh, loadFailed: friendsFailed, retry: retryFriends } = useFriends();
  const acc = getActiveAccount();
  const auth = acc ? buildZaloAuth(acc, activeAccountId) : null;

  const matchFilter = (name: string, phone: string, id: string) => {
    const q = search.toLowerCase();
    if (q && !name.toLowerCase().includes(q) && !phone.includes(q) && !id.includes(q)) return false;
    if (selectedLabelKeys.size > 0) {
      let inAny = false;
      for (const key of selectedLabelKeys) {
        if (key.startsWith('z:')) {
          const labelId = parseInt(key.slice(2));
          const lbl = labels.find(l => l.id === labelId);
          if (lbl && lbl.conversations.includes(id)) { inAny = true; break; }
        } else if (key.startsWith('l:')) {
          const labelId = parseInt(key.slice(2));
          const threads = localLabelThreadMap.get(labelId) || [];
          if (threads.includes(id)) { inAny = true; break; }
        }
      }
      if (!inAny) return false;
    }
    return true;
  };

  const filteredFriends = friends.filter(f =>
    matchFilter(f?.alias || f.displayName || f.zaloName || f.userId || '', f.phoneNumber || '', f.userId || '')
  );

  const recentContacts = accountContacts
    .filter(c => c.contact_type !== 'group' && matchFilter(c.alias || c.display_name || c.contact_id, c.phone || '', c.contact_id))
    .slice(0, 8);

  const recentIds = new Set(recentContacts.map(c => c.contact_id));

  const byLetter: Record<string, any[]> = {};
  filteredFriends.forEach(f => {
    if (recentIds.has(f.userId)) return;
    const l = (f?.alias || f.displayName || f.zaloName || 'Z').charAt(0).toUpperCase();
    if (!byLetter[l]) byLetter[l] = [];
    byLetter[l].push(f);
  });

  const toggleSelect = (id: string) =>
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const handleSend = async () => {
    if (!auth || selected.size === 0) return;
    setSending(true);
    let success = 0, failed = 0;
    for (const userId of selected) {
      try {
        const friend = friends.find(f => f.userId === userId);
        const res = await ipc.zalo?.sendCard({
          auth,
          options: { userId, phoneNumber: friend?.phoneNumber || undefined },
          threadId,
          type: threadType,
        });
        if (res?.success) success++; else failed++;
      } catch { failed++; }
    }
    setSending(false);
    if (success > 0) showNotification(`Đã gửi ${success} danh thiếp`, 'success');
    if (failed > 0) showNotification(`Lỗi: ${failed} danh thiếp không gửi được`, 'error');
    if (success > 0) onClose();
  };

  // Nhãn Local đọc lỗi vẫn hiện bộ lọc (tab Local kèm "Thử lại")
  const hasAnyLabels = labels.length > 0 || localLabelList.length > 0 || localLabelsFailed;
  const friendsLoadFailed = friendsFailed && friends.length === 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl w-[480px] max-h-[88vh] flex flex-col border border-border overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-foreground font-semibold text-base">Gửi danh thiếp</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Chọn liên hệ để gửi danh thiếp</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-border">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              autoFocus
              placeholder="Tìm danh thiếp theo tên"
              className="w-full bg-muted border border-input rounded-full pl-9 pr-3 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
          </div>
        </div>

        {/* Label filter - Local/Zalo like CreateGroupModal */}
        {hasAnyLabels && (
          <div className="border-b border-border flex-shrink-0">
            <LabelTabsFilter
              zaloLabels={labels}
              localLabels={localLabelList}
              value={selectedLabelKeys}
              onChange={setSelectedLabelKeys}
              localFailed={localLabelsFailed}
              onRetryLocal={reloadLocalLabels}
            />
          </div>
        )}

        {/* Friends list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <p className="text-center text-muted-foreground text-sm py-10">Đang tải danh sách bạn bè...</p>
          ) : (
            <>
              {/* Refresh bar */}
              <div className="flex items-center justify-between px-4 pt-2 pb-1">
                <span className="text-xs text-muted-foreground">{refreshing ? 'Đang cập nhật...' : friendsLoadFailed ? 'Chưa tải được bạn bè' : `${friends.length} liên hệ`}</span>
                <button onClick={refresh} disabled={refreshing}
                  className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 flex items-center gap-1">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    className={refreshing ? 'animate-spin' : ''}>
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                  Làm mới
                </button>
              </div>
              {recentContacts.length > 0 && (
                <div>
                  <p className="px-4 py-2 text-xs text-muted-foreground font-medium uppercase tracking-wide">Trò chuyện gần đây</p>
                  {recentContacts.map(c => (
                    <PersonRow key={c.contact_id} id={c.contact_id}
                      name={c.alias || c.display_name || c.contact_id}
                      avatar={c.avatar_url}
                      subtitle={c.phone || undefined}
                      selected={selected.has(c.contact_id)}
                      onToggle={() => toggleSelect(c.contact_id)} />
                  ))}
                </div>
              )}
              {Object.keys(byLetter).sort().map(letter => (
                <div key={letter}>
                  <p className="px-4 py-1.5 text-xs text-muted-foreground font-medium">{letter}</p>
                  {byLetter[letter].map(f => (
                    <PersonRow key={f.userId} id={f.userId}
                      name={f?.alias || f.displayName || f.zaloName || f.userId}
                      avatar={f.avatar}
                      subtitle={f.phoneNumber || undefined}
                      selected={selected.has(f.userId)}
                      onToggle={() => toggleSelect(f.userId)} />
                  ))}
                </div>
              ))}
              {/* Danh sách bạn bè đọc lỗi (chế độ nhân viên) ≠ "Không tìm thấy" */}
              {friendsLoadFailed && <LoadFailedRow text="Không tải được danh sách bạn bè" onRetry={retryFriends} />}
              {!friendsLoadFailed && filteredFriends.length === 0 && recentContacts.length === 0 && (
                <p className="text-center text-muted-foreground text-sm py-10">Không tìm thấy</p>
              )}
            </>
          )}
        </div>

        {/* Selected count */}
        {selected.size > 0 && (
          <div className="px-5 py-2 border-t border-border text-xs text-muted-foreground">
            Đã chọn <span className="text-blue-400 font-semibold">{selected.size}</span> danh thiếp
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-input text-sm text-foreground/80 hover:bg-muted transition-colors">Hủy</button>
          <button onClick={handleSend} disabled={selected.size === 0 || sending}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {sending ? 'Đang gửi...' : `Gửi danh thiếp${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AddMemberToGroupModal ────────────────────────────────────────────────────
export function AddMemberToGroupModal({ groupId, groupName, existingMemberIds = [], channel, onClose, onAdded }: {
  groupId: string;
  groupName: string;
  existingMemberIds?: string[];
  channel?: string;
  onClose: () => void;
  onAdded?: () => void;
}) {
  // Selector: modal không render lại với mọi tin nhắn / đang gõ của các hội thoại khác
  const { getActiveAccount, activeAccountId } = useAccountStore(useShallow(s => ({
    getActiveAccount: s.getActiveAccount, activeAccountId: s.activeAccountId, accounts: s.accounts,
  })));
  const showNotification = useAppStore(s => s.showNotification);
  const contacts = useChatStore(s => s.contacts);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const { friends, loading, refreshing, refresh, loadFailed: friendsFailed, retry: retryFriends } = useFriends();
  const acc = getActiveAccount();
  const auth = acc ? buildZaloAuth(acc) : null;
  const activeChannel = channel || acc?.channel || CHANNEL.ZALO;
  // Zalo: ứng viên = bạn bè; đọc lỗi (chế độ nhân viên) và chưa có ai → "Không tải được — Thử lại"
  const friendsLoadFailed = isZalo(activeChannel) && friendsFailed && friends.length === 0;
  const telegramCandidates = (activeAccountId ? (contacts[activeAccountId] || []) : [])
    .filter(contact => contact.contact_type !== 'group')
    .map(contact => ({
      userId: contact.contact_id,
      displayName: contact.alias || contact.display_name || contact.contact_id,
      zaloName: contact.display_name || '',
      avatar: contact.avatar_url || '',
      phoneNumber: contact.phone || '',
    }));
  const candidates = isZalo(activeChannel) ? friends : telegramCandidates;

  const toggleSelect = (id: string) =>
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const filteredFriends = candidates.filter(f => {
    if (existingMemberIds.includes(f.userId)) return false;
    const q = search.toLowerCase();
    if (!q) return true;
    return (f.displayName || f.zaloName || '').toLowerCase().includes(q) ||
      (f.phoneNumber || '').includes(q) || (f.userId || '').includes(q);
  });

  const byLetter: Record<string, any[]> = {};
  filteredFriends.forEach(f => {
    const l = (f.displayName || f.zaloName || 'Z').charAt(0).toUpperCase();
    if (!byLetter[l]) byLetter[l] = [];
    byLetter[l].push(f);
  });

  const handleAdd = async () => {
    if (selected.size === 0 || !activeAccountId) return;
    if (isZalo(activeChannel) && !auth) return;
    setAdding(true);
    let success = 0, failed = 0;
    for (const userId of selected) {
      try {
        const res = isZalo(activeChannel)
          ? await ipc.zalo?.addUserToGroup({ auth, userId, groupId })
          : await (getAdapter(activeChannel as any) as any).addMember({ accountId: activeAccountId, threadId: groupId, userId });
        if (res?.success) success++; else failed++;
      } catch { failed++; }
    }
    setAdding(false);
    if (success > 0) showNotification(`Đã thêm ${success} thành viên vào nhóm`, 'success');
    if (failed > 0) showNotification(`Lỗi: ${failed} người không thêm được`, 'error');
    if (success > 0) { onAdded?.(); onClose(); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl w-[480px] max-h-[88vh] flex flex-col border border-border overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-foreground font-semibold text-base">Thêm thành viên</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[320px]">{groupName}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-border">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              autoFocus
              placeholder="Tìm bạn bè để thêm vào nhóm..."
              className="w-full bg-muted border border-input rounded-full pl-9 pr-3 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
          </div>
        </div>

        {/* Friends list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-center text-muted-foreground text-sm py-10">Đang tải danh sách bạn bè...</p>
          ) : (
            <>
              <div className="flex items-center justify-between px-4 pt-2 pb-1">
                <span className="text-xs text-muted-foreground">
                  {refreshing ? 'Đang cập nhật...' : friendsLoadFailed ? 'Chưa tải được bạn bè' : `${filteredFriends.length} bạn bè có thể thêm`}
                </span>
                <button onClick={refresh} disabled={refreshing}
                  className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 flex items-center gap-1">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    className={refreshing ? 'animate-spin' : ''}>
                    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                  Làm mới
                </button>
              </div>
              {Object.keys(byLetter).sort().map(letter => (
                <div key={letter}>
                  <p className="px-4 py-1.5 text-xs text-muted-foreground font-medium">{letter}</p>
                  {byLetter[letter].map(f => (
                    <PersonRow key={f.userId} id={f.userId}
                      name={f.displayName || f.zaloName || f.userId}
                      avatar={f.avatar}
                      subtitle={f.phoneNumber || undefined}
                      selected={selected.has(f.userId)}
                      onToggle={() => toggleSelect(f.userId)} />
                  ))}
                </div>
              ))}
              {/* Danh sách bạn bè đọc lỗi (chế độ nhân viên) ≠ "Không có bạn bè nào" */}
              {friendsLoadFailed && <LoadFailedRow text="Không tải được danh sách bạn bè" onRetry={retryFriends} />}
              {!friendsLoadFailed && filteredFriends.length === 0 && (
                <p className="text-center text-muted-foreground text-sm py-10">
                  {search ? 'Không tìm thấy bạn bè phù hợp' : existingMemberIds.length > 0 ? 'Tất cả bạn bè đã là thành viên nhóm' : 'Không có bạn bè nào'}
                </p>
              )}
            </>
          )}
        </div>

        {/* Selected count */}
        {selected.size > 0 && (
          <div className="px-5 py-2 border-t border-border text-xs text-muted-foreground">
            Đã chọn <span className="text-blue-400 font-semibold">{selected.size}</span> người
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 border-t border-border">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-input text-sm text-foreground/80 hover:bg-muted transition-colors">
            Hủy
          </button>
          <button onClick={handleAdd} disabled={selected.size === 0 || adding}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-sm text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {adding ? 'Đang thêm...' : `Thêm${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared components ───────────────────────────────────────────────────────
function PersonRow({ id, name, avatar, selected, onToggle, isGroup, subtitle }: {
  id: string; name: string; avatar?: string; selected: boolean; onToggle: () => void; isGroup?: boolean; subtitle?: string;
}) {
  return (
    <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted transition-colors text-left">
      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${selected ? 'bg-blue-600 border-blue-600' : 'border-border-strong hover:border-border-strong'}`}>
        {selected && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
      </div>
      {avatar ? (
        <img src={avatar} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
      ) : (
        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 ${isGroup ? 'bg-purple-600' : 'bg-blue-600'}`}>
          {(name || 'U').charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">{name}</p>
        {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
      </div>
    </button>
  );
}


// ─── LabelSelectFilter - dropdown filter by label ────────────────────────────
function LabelSelectFilter({ zaloLabels, localLabels, value, onChange }: {
  zaloLabels: LabelData[];
  localLabels: { id: number; name: string; color: string; emoji: string }[];
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Resolve display for current value
  const getDisplay = (): { label: string; color?: string; emoji?: string } => {
    if (!value) return { label: 'Tất cả nhãn' };
    if (value.startsWith('z:')) {
      const id = parseInt(value.slice(2));
      const lbl = zaloLabels.find(l => l.id === id);
      return lbl ? { label: lbl.text, color: lbl.color, emoji: lbl.emoji } : { label: 'Nhãn Zalo' };
    }
    if (value.startsWith('l:')) {
      const id = parseInt(value.slice(2));
      const lbl = localLabels.find(l => l.id === id);
      return lbl ? { label: lbl.name, color: lbl.color, emoji: lbl.emoji } : { label: 'Nhãn Local' };
    }
    return { label: 'Tất cả nhãn' };
  };

  const current = getDisplay();

  return (
    <div ref={ref} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted border border-input rounded-lg text-sm text-foreground hover:bg-accent transition-colors text-left"
      >
        {current.color && (
          <span className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-foreground/20" style={{ backgroundColor: current.color }} />
        )}
        {current.emoji && !current.color && <span className="text-sm leading-none">{current.emoji}</span>}
        {!current.color && !current.emoji && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>
          </svg>
        )}
        <span className="flex-1 truncate">{current.label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Dropdown menu */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-input rounded-xl shadow-xl z-50 overflow-hidden max-h-64 overflow-y-auto">
          {/* All */}
          <button
            onClick={() => { onChange(null); setOpen(false); }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left ${!value ? 'bg-muted/60 text-foreground' : 'text-foreground/80'}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
            Tất cả nhãn
          </button>

          {/* Zalo labels group */}
          {zaloLabels.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-t border-border/60 mt-0.5 flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-blue-400"><circle cx="12" cy="12" r="10"/></svg>
                Nhãn Zalo
              </div>
              {zaloLabels.map(l => {
                const key = `z:${l.id}`;
                const active = value === key;
                return (
                  <button key={key} onClick={() => { onChange(active ? null : key); setOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left ${active ? 'bg-muted/60 text-foreground' : 'text-foreground/80'}`}>
                    <span className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-foreground/20" style={{ backgroundColor: l.color || '#6b7280' }} />
                    {l.emoji && <span className="text-sm leading-none">{l.emoji}</span>}
                    <span className="truncate">{l.text}</span>
                    {active && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto text-blue-400 flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>}
                  </button>
                );
              })}
            </>
          )}

          {/* Local labels group */}
          {localLabels.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-t border-border/60 mt-0.5 flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-purple-400"><circle cx="12" cy="12" r="10"/></svg>
                Nhãn Local
              </div>
              {localLabels.map(l => {
                const key = `l:${l.id}`;
                const active = value === key;
                return (
                  <button key={key} onClick={() => { onChange(active ? null : key); setOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted transition-colors text-left ${active ? 'bg-muted/60 text-foreground' : 'text-foreground/80'}`}>
                    <span className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-foreground/20" style={{ backgroundColor: l.color || '#9333ea' }} />
                    {l.emoji && <span className="text-sm leading-none">{l.emoji}</span>}
                    <span className="truncate">{l.name}</span>
                    {active && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto text-blue-400 flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared components ───────────────────────────────────────────────────────
function LabelChip({ label, active, onClick, color, emoji }: {
  label: string; active: boolean; onClick: () => void; color?: string; emoji?: string;
}) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors ${active ? 'text-foreground' : 'bg-muted text-foreground/80 hover:bg-accent'}`}
      style={active ? { backgroundColor: color || '#2563eb' } : {}}>
      {emoji && <span>{emoji}</span>}
      {label}
    </button>
  );
}
