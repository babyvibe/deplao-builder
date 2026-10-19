import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/useEmployeeResync';
import { Button } from '@/components/ui';
import { RefreshIcon } from '@/components/common/icons';
import GroupAvatar from '../common/GroupAvatar';
import ChannelBadge from '../common/ChannelBadge';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { formatMsgTime } from '@/lib/chat/messageParser';
import { CHANNEL, isZalo, isTelegram, isFacebook } from '@/lib/channelHelper';

const PAGE_SIZE = 50;
/** Ngay sau một lần tải lỗi, cuộn tới cuối chỉ thử lại sau chừng này (nút "Thử lại" thử ngay). */
const SCROLL_RETRY_COOLDOWN_MS = 2_000;

type TabKey = 'recent' | 'friends' | 'groups' | 'categories';

type ForwardLocalLabel = { id: number; name: string; color: string; text_color?: string; emoji?: string };
const NO_LOCAL_LABELS: ForwardLocalLabel[] = [];
const NO_LABEL_THREADS: Record<string, number[]> = {};

/** Báo lỗi tải gọn ngay trong danh sách (chế độ nhân viên: mất kết nối BOSS) — không trông như "Không tìm thấy". */
function LoadFailedRow({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-3 py-3 text-xs text-muted-foreground">
      <span>{text}</span>
      <Button variant="link" size="sm" className="text-xs" onClick={() => onRetry()}>Thử lại</Button>
    </div>
  );
}

interface ContactItem {
  contact_id: string;
  display_name: string;
  avatar_url: string;
  contact_type: string;
  last_message_time: number;
  channel?: string;
  alias?: string;
  phone?: string;
  is_friend?: number;
  _accountId?: string;
}

export default function ForwardMessageModal({ messages, onClose, onForward }: {
  messages: any[];
  onClose: () => void;
  onForward: (messages: any[], targets: Array<{ threadId: string; threadType: number; accountId: string }>, composeText: string) => void;
}) {
  // Selector: modal không render lại với mọi thay đổi khác của store (tin nhắn, thông báo…)
  const { labels: allLabels, groupInfoCache } = useAppStore(useShallow(s => ({
    labels: s.labels, groupInfoCache: s.groupInfoCache,
  })));
  const { accounts, activeAccountId } = useAccountStore(useShallow(s => ({
    accounts: s.accounts, activeAccountId: s.activeAccountId,
  })));

  // One sender account owns the destination list. Default to the account of
  // the open conversation; changing it reloads only that account's contacts.
  const [selectedAccountId, setSelectedAccountId] = useState(activeAccountId || '');
  const [showAccountDropdown, setShowAccountDropdown] = useState(false);
  const accountDropdownRef = useRef<HTMLDivElement>(null);

  // ── Tab + search ──
  const [tab, setTab] = useState<TabKey>('recent');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [composeText, setComposeText] = useState('');

  // ── Pagination state ──
  const [contacts, setContacts] = useState<ContactItem[]>([]);
  // Trang cuối đã tải THÀNH CÔNG (trang lỗi không tiến → cuộn / "Thử lại" tải lại đúng trang đó)
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  // Trang vừa tải lỗi (chế độ nhân viên: mất kết nối BOSS) — giữ danh sách đang có, hiện "Thử lại"
  const [contactsFailedPage, setContactsFailedPage] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const lastFailureAtRef = useRef(0);

  // ── Local labels (theo tài khoản gửi; lần đọc lỗi giữ nhãn đang có của đúng tài khoản đó) ──
  const [localLabelsByAccount, setLocalLabelsByAccount] = useState<Record<string, ForwardLocalLabel[]>>({});
  const [labelThreadsByAccount, setLabelThreadsByAccount] = useState<Record<string, Record<string, number[]>>>({});
  const [localLabelsFailed, setLocalLabelsFailed] = useState<Record<string, boolean>>({});
  const [selectedLabelId, setSelectedLabelId] = useState<number | null>(null);
  const [labelSource, setLabelSource] = useState<'local' | 'zalo'>('local');

  const primaryAccountId = selectedAccountId;
  const localLabels = localLabelsByAccount[primaryAccountId] || NO_LOCAL_LABELS;
  const localLabelThreadMap = labelThreadsByAccount[primaryAccountId] || NO_LABEL_THREADS;
  const localLabelsFailedNow = !!localLabelsFailed[primaryAccountId];
  const selectedAccount = accounts.find(a => a.zalo_id === primaryAccountId);
  const isSelectedAccountZalo = isZalo(selectedAccount?.channel);
  const labels = primaryAccountId ? (allLabels[primaryAccountId] || []) : [];
  // For non-Zalo accounts, force label source to local (Zalo labels don't apply)
  const effectiveLabelSource = isSelectedAccountZalo ? labelSource : 'local';

  // ── Load contacts from the selected sender account ──
  // Lỗi đọc (chế độ nhân viên) → GIỮ danh sách + hasMore, không tiến trang; hiện "Thử lại" (không thành "Không tìm thấy")
  const loadContacts = useCallback(async (accountId: string, pageNum: number, searchQuery?: string, generation = loadGenerationRef.current) => {
    if (!accountId) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    let failed = false;
    try {
      const sortMap: Record<TabKey, { sortBy: string; sortDir: string }> = {
        recent: { sortBy: 'last_message', sortDir: 'desc' },
        friends: { sortBy: 'last_message', sortDir: 'desc' },
        groups: { sortBy: 'last_message', sortDir: 'desc' },
        categories: { sortBy: 'name', sortDir: 'asc' },
      };
      // "Bạn bè" tab: show all non-group contacts (includes Telegram 1-1, non-friend contacts)
      const contactTypeMap: Record<TabKey, string> = {
        recent: 'all', friends: 'all', groups: 'group', categories: 'all',
      };
      const { sortBy, sortDir } = sortMap[tab] || sortMap.recent;
      const account = accounts.find(a => a.zalo_id === accountId);
      const res = await DataAccessor.getCRMContacts({
        zaloId: accountId,
        opts: {
          search: searchQuery?.trim() || undefined,
          sortBy: sortBy as any,
          sortDir: sortDir as any,
          contactType: contactTypeMap[tab] as any,
          limit: searchQuery ? 100 : PAGE_SIZE,
          offset: searchQuery ? 0 : pageNum * PAGE_SIZE,
        },
      });
      if (generation !== loadGenerationRef.current) return;
      if (isReadFailure(res)) {
        failed = true;
        console.warn(`[ForwardMessageModal] Không tải được danh sách (trang ${pageNum}): ${readFailureMessage(res)}`);
        return;
      }
      const allItems: ContactItem[] = (res?.contacts || []).map((c: any) => ({
        ...c,
        avatar_url: c.avatar_url || c.avatar || '',
        display_name: c.display_name || c.name || c.full_name || '',
        channel: c.channel || account?.channel,
        _accountId: accountId,
      }));
      if (pageNum === 0) {
        setContacts(allItems);
      } else {
        setContacts(prev => [...prev, ...allItems]);
      }
      setPage(pageNum);
      const total = Number(res?.total ?? allItems.length);
      setHasMore(!searchQuery && (pageNum + 1) * PAGE_SIZE < total);
      setTotalCount(total);
    } catch (err) {
      if (generation === loadGenerationRef.current) {
        failed = true;
        console.warn('[ForwardMessageModal] load contacts failed:', err);
      }
    }
    finally {
      if (generation === loadGenerationRef.current) {
        if (failed) lastFailureAtRef.current = Date.now();
        setContactsFailedPage(failed ? pageNum : null);
        setLoading(false);
        loadingRef.current = false;
      }
    }
  }, [accounts, tab]);

  // The selector can mount before the account store has finished loading.
  useEffect(() => {
    const hasSelected = accounts.some(a => a.zalo_id === selectedAccountId);
    if (!hasSelected) {
      const fallback = accounts.some(a => a.zalo_id === activeAccountId)
        ? activeAccountId || ''
        : accounts[0]?.zalo_id || '';
      setSelectedAccountId(fallback);
    }
  }, [accounts, activeAccountId, selectedAccountId]);

  // Reset + load when accounts or tab changes
  useEffect(() => {
    if (!selectedAccountId) return;
    loadGenerationRef.current += 1;
    loadingRef.current = false;
    const generation = loadGenerationRef.current;
    setPage(0); setContacts([]); setHasMore(true); setTotalCount(0); setContactsFailedPage(null);
    setSelected(new Set());
    void loadContacts(selectedAccountId, 0, search || undefined, generation);
  }, [selectedAccountId, tab, loadContacts]);

  // ── Search with debounce ──
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = (q: string) => {
    setSearch(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      if (!selectedAccountId) return;
      loadGenerationRef.current += 1;
      loadingRef.current = false;
      const generation = loadGenerationRef.current;
      setPage(0); setContacts([]); setHasMore(true); setTotalCount(0); setContactsFailedPage(null);
      void loadContacts(selectedAccountId, 0, q || undefined, generation);
    }, 300);
  };

  /** Trang tiếp theo (sau trang cuối đã tải thành công) — cũng là "thử lại" khi trang đó vừa lỗi. */
  const loadNextPage = () => {
    if (!selectedAccountId || loadingRef.current || !hasMore || search.trim()) return;
    void loadContacts(selectedAccountId, page + 1);
  };

  /** Thử lại lần tải danh sách vừa lỗi (nút "Thử lại", kết nối BOSS phục hồi). */
  const retryContacts = (): Promise<void> | void => {
    if (!selectedAccountId) return;
    if (contactsFailedPage !== null && contactsFailedPage > 0) {
      if (loadingRef.current) return;
      return loadContacts(selectedAccountId, contactsFailedPage);
    }
    // Trang đầu (danh sách trống): tải lại từ đầu với từ khoá đang có
    loadGenerationRef.current += 1;
    loadingRef.current = false;
    const generation = loadGenerationRef.current;
    return loadContacts(selectedAccountId, 0, search || undefined, generation);
  };

  // ── Infinite scroll ──
  const handleScroll = () => {
    const el = listRef.current;
    if (!el || loadingRef.current || !hasMore || search.trim()) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      // Ngay sau một lần lỗi: cuộn qua lại không bắn yêu cầu liên tục (nút "Thử lại" thử ngay)
      if (contactsFailedPage !== null && Date.now() - lastFailureAtRef.current < SCROLL_RETRY_COOLDOWN_MS) return;
      loadNextPage();
    }
  };

  // ── Load local labels from primary account ──
  // Lỗi đọc → giữ nhãn / gán nhãn đang có của đúng tài khoản đó (không thay bằng rỗng), hiện "Thử lại" trên hàng nhãn
  const loadLocalLabels = useCallback(async (accountId: string) => {
    const [labelsRes, threadsRes] = await Promise.all([
      DataAccessor.getLocalLabels({ zaloId: accountId }).catch(() => null),
      DataAccessor.getLocalLabelThreads({ zaloId: accountId }).catch(() => null),
    ]);
    const labelsOk = !!labelsRes && !isReadFailure(labelsRes);
    const threadsOk = !!threadsRes && !isReadFailure(threadsRes);
    if (labelsOk) {
      const raw = (labelsRes?.labels || [])
        .filter((l: any) => (l?.is_active ?? 1) === 1)
        .sort((a: any, b: any) => (a?.sort_order ?? 0) - (b?.sort_order ?? 0));
      setLocalLabelsByAccount(prev => ({ ...prev, [accountId]: raw }));
    }
    if (threadsOk) {
      const map: Record<string, number[]> = {};
      (threadsRes?.threads || []).forEach((row: any) => {
        const tid = String(row.thread_id || '');
        if (tid) { if (!map[tid]) map[tid] = []; map[tid].push(Number(row.label_id)); }
      });
      setLabelThreadsByAccount(prev => ({ ...prev, [accountId]: map }));
    }
    const failed = !labelsOk || !threadsOk;
    if (failed) console.warn('[ForwardMessageModal] Không tải được Nhãn Local:', readFailureMessage(labelsOk ? threadsRes : labelsRes) || 'lỗi không rõ');
    setLocalLabelsFailed(prev => (!!prev[accountId] === failed ? prev : { ...prev, [accountId]: failed }));
  }, []);

  useEffect(() => {
    if (!primaryAccountId) return;
    void loadLocalLabels(primaryAccountId);
  }, [primaryAccountId, loadLocalLabels]);

  // Chế độ nhân viên: kết nối BOSS phục hồi → tải lại Nhãn Local + danh sách nếu lần tải trước lỗi / còn trống
  useEmployeeResync(() => {
    const tasks: Array<Promise<unknown> | void> = [];
    if (primaryAccountId) tasks.push(loadLocalLabels(primaryAccountId));
    if (contactsFailedPage !== null || contacts.length === 0) tasks.push(retryContacts());
    return Promise.allSettled(tasks);
  });

  // ── Filter contacts ──
  const filtered = useMemo(() => {
    let list = contacts;
    if (tab === 'friends') list = list.filter(c => c.contact_type !== 'group');
    if (tab === 'groups') list = list.filter(c => c.contact_type === 'group');
    if (tab === 'categories' && selectedLabelId !== null) {
      if (effectiveLabelSource === 'local') {
        const threadSet = new Set(Object.keys(localLabelThreadMap).filter(tid =>
          (localLabelThreadMap[tid] || []).includes(selectedLabelId)
        ));
        list = list.filter(c => threadSet.has(c.contact_id));
      } else {
        const targetLabel = labels.find(l => l.id === selectedLabelId);
        if (targetLabel) list = list.filter(c => targetLabel.conversations?.includes(c.contact_id));
      }
    }
    return list;
  }, [contacts, tab, selectedLabelId, effectiveLabelSource, localLabelThreadMap, labels]);

  // ── Selection ──
  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  // ── Forward ──
  const handleForward = () => {
    const targets = filtered
      .filter(c => selected.has(c.contact_id))
      .map(c => ({
        threadId: c.contact_id,
        threadType: c.contact_type === 'group' ? 1 : 0,
        accountId: c._accountId || selectedAccountId,
      }));
    if (targets.length === 0) return;
    onForward(messages, targets, composeText);
  };

  // ── Preview text ──
  const msgCount = messages.length;
  const previewText = msgCount === 1
    ? (() => { try { const c = messages[0].content; if (!c || c === 'null') return '[Tin nhắn]'; const p = JSON.parse(c); if (typeof p === 'string') return p; if (p?.title) return `File: ${p.title}`; if (p?.href || p?.thumb) return '[Hình ảnh]'; if (p?.msg) return String(p.msg); return '[Tin nhắn]'; } catch { return messages[0].content || '[Tin nhắn]'; } })()
    : `[${msgCount} tin nhắn]`;

  const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'recent', label: 'Gần nhất', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
    { key: 'friends', label: 'Bạn bè', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
    { key: 'groups', label: 'Nhóm', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> },
    { key: 'categories', label: 'Nhãn', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> },
  ];

  const grpCache = useMemo(() => groupInfoCache[selectedAccountId] || {}, [selectedAccountId, groupInfoCache]);

  // Close account dropdown on outside click
  useEffect(() => {
    if (!showAccountDropdown) return;
    const handler = (e: MouseEvent) => {
      if (accountDropdownRef.current && !accountDropdownRef.current.contains(e.target as Node)) {
        setShowAccountDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAccountDropdown]);

  const accountName = (account: any) => account?.full_name || account?.display_name || account?.username || account?.zalo_id || '';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl w-[480px] max-h-[85vh] flex flex-col border border-border overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-foreground font-semibold text-base">Chuyển tiếp {msgCount > 1 ? `${msgCount} tin nhắn` : 'tin nhắn'}</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[350px]">{previewText}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Compose text */}
        <div className="px-4 py-2.5 border-b border-border flex-shrink-0">
          <textarea
            value={composeText}
            onChange={e => setComposeText(e.target.value)}
            placeholder="Nhập nội dung kèm..."
            rows={2}
            className="w-full bg-muted border border-input rounded-lg px-3 py-2 text-sm text-foreground placeholder-subtle-foreground resize-none focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Sender account selector */}
        {accounts.length > 0 && (
          <div className="px-4 py-2 border-b border-border flex-shrink-0 relative" ref={accountDropdownRef}>
            <p className="text-[11px] text-muted-foreground mb-1.5 font-medium">Tài khoản gửi:</p>
            {/* Trigger */}
            <button
              onClick={() => setShowAccountDropdown(!showAccountDropdown)}
              className="w-full flex items-center gap-2 px-3 py-2 bg-muted border border-input rounded-lg text-sm text-left hover:border-border-strong transition-colors">
              {!selectedAccount ? (
                <span className="text-subtle-foreground">Chọn tài khoản...</span>
              ) : (
                <span className="text-foreground truncate">{accountName(selectedAccount)}</span>
              )}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`ml-auto flex-shrink-0 text-muted-foreground transition-transform ${showAccountDropdown ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            {/* Dropdown */}
            {showAccountDropdown && (
              <div className="absolute left-4 right-4 top-full mt-1 bg-muted border border-input rounded-xl shadow-2xl z-50 overflow-hidden max-h-[240px] overflow-y-auto">
                {accounts.map(acc => {
                  const isChecked = selectedAccountId === acc.zalo_id;
                  return (
                    <button key={acc.zalo_id}
                      onClick={() => { setSelectedAccountId(acc.zalo_id); setShowAccountDropdown(false); }}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 transition-colors ${isChecked ? 'bg-blue-500/10' : 'hover:bg-accent'}`}>
                      {/* Avatar - matching sidebar AccountPanel style */}
                      <div className="relative flex-shrink-0">
                        <div className="w-9 h-9 rounded-full overflow-hidden ring-1 ring-foreground/10">
                          {acc.avatar_url ? (
                            <img src={acc.avatar_url} alt="" className="w-full h-full object-cover"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          ) : (
                            <div className="w-full h-full bg-blue-600 flex items-center justify-center text-white font-bold text-xs">
                              {accountName(acc).charAt(0).toUpperCase()}
                            </div>
                          )}
                        </div>
                        {/* Channel badge - positioned like sidebar */}
                        <div className="absolute -top-1 -left-1 z-10 pointer-events-none scale-75">
                          <ChannelBadge channel={(acc.channel as any) || CHANNEL.ZALO} size="sm" />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <span className="text-xs text-foreground truncate block">{accountName(acc)}</span>
                        <span className="text-[10px] text-muted-foreground truncate block">{acc.zalo_id}</span>
                        <span className="text-[10px] text-blue-300 truncate block">{acc.phone}</span>
                      </div>
                      {isChecked && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" className="flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-border flex-shrink-0">
          {TABS.map(t => (
            <button key={t.key}
              onClick={() => { setTab(t.key); setSelectedLabelId(null); }}
              className={`flex-1 flex items-center justify-center gap-1 py-2.5 text-xs transition-colors border-b-2 ${tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-muted-foreground hover:text-foreground/80'}`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Label filter pills (categories tab) */}
        {tab === 'categories' && (
          <div className="border-b border-border flex-shrink-0">
            {/* Only show Local/Zalo sub-tabs for Zalo accounts */}
            {isSelectedAccountZalo && (
              <div className="flex items-center gap-1 px-3 pt-2 pb-1">
                <button onClick={() => { setLabelSource('local'); setSelectedLabelId(null); }}
                  className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${labelSource === 'local' ? 'bg-blue-600 border-blue-500 text-white' : 'border-input text-muted-foreground hover:border-border-strong'}`}>
                  Local</button>
                <button onClick={() => { setLabelSource('zalo'); setSelectedLabelId(null); }}
                  className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${labelSource === 'zalo' ? 'bg-blue-600 border-blue-500 text-white' : 'border-input text-muted-foreground hover:border-border-strong'}`}>
                  Zalo</button>
              </div>
            )}
            <div className="px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto">
              <button onClick={() => setSelectedLabelId(null)}
                className={`flex-shrink-0 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === null ? 'bg-blue-600 border-blue-500 text-white' : 'border-input text-muted-foreground hover:border-border-strong'}`}>
                Tất cả</button>
              {(effectiveLabelSource === 'local' ? localLabels : labels).map(l => (
                <button key={l.id}
                  onClick={() => setSelectedLabelId(selectedLabelId === l.id ? null : l.id)}
                  className={`flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === l.id ? 'text-foreground' : 'text-foreground/80 hover:border-border-strong'}`}
                  style={{ borderColor: selectedLabelId === l.id ? (l.color || '#3b82f6') : '#4b5563', backgroundColor: selectedLabelId === l.id ? (l.color || '#3b82f6') + '40' : 'transparent' }}>
                  {l.emoji && <span>{l.emoji}</span>}
                  <span>{effectiveLabelSource === 'local' ? l.name : (l as any).text}</span>
                </button>
              ))}
              {/* Nhãn Local đọc lỗi (chế độ nhân viên): thử lại gọn ngay trên hàng nhãn thay vì trông như không có nhãn */}
              {effectiveLabelSource === 'local' && localLabelsFailedNow && (
                <button
                  type="button"
                  onClick={() => { if (primaryAccountId) void loadLocalLabels(primaryAccountId); }}
                  className="flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-input text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
                  title="Không tải được Nhãn Local — bấm để thử lại"
                >
                  <RefreshIcon className="w-3 h-3" />
                  <span>{localLabels.length === 0 ? 'Không tải được nhãn · Thử lại' : 'Thử lại'}</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-border flex-shrink-0">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              value={search}
              onChange={e => handleSearch(e.target.value)}
              autoFocus
              placeholder="Tìm theo tên, SĐT, ID..."
              className="w-full bg-muted border border-input rounded-full pl-9 pr-3 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Contact list */}
        <div ref={listRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
          {loading && contacts.length === 0 && (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
              <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              Đang tải...
            </div>
          )}
          {!loading && filtered.length === 0 && (
            contacts.length === 0 && contactsFailedPage === 0 ? (
              // Lần tải đầu lỗi (chế độ nhân viên: mất kết nối BOSS) ≠ "Không tìm thấy"
              <div className="py-9">
                <LoadFailedRow text="Không tải được danh sách liên hệ" onRetry={() => { void retryContacts(); }} />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-40"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <p className="text-sm">Không tìm thấy</p>
              </div>
            )
          )}
          {filtered.map(c => {
            const isSelected = selected.has(c.contact_id);
            return (
              <button key={c.contact_id}
                onClick={() => toggleSelect(c.contact_id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left ${isSelected ? 'bg-blue-600/20' : 'hover:bg-muted'}`}>
                <div className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-border-strong'}`}>
                  {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                </div>
                {c.contact_type === 'group' ? (
                  <GroupAvatar avatarUrl={c.avatar_url} groupInfo={grpCache[c.contact_id]} name={c.display_name || c.contact_id} size="md" />
                ) : c.avatar_url ? (
                  <img src={toLocalMediaUrl(c.avatar_url, c._accountId)} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                    onError={e => {
                      const img = e.target as HTMLImageElement;
                      if (!img.src.includes('avatar.zadn.vn')) {
                        img.src = c.avatar_url.replace(/avatar\.zadn\.vn\/.*$/, 'avatar.zadn.vn/avatar_120x120_default.png');
                      } else {
                        img.style.display = 'none';
                      }
                    }} />
                ) : (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 bg-blue-600">
                    {(c.display_name || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{c.alias || c.display_name || c.contact_id}</p>
                  {c.contact_type === 'group'
                    ? <p className="text-xs text-muted-foreground">Nhóm</p>
                    : c.last_message_time
                      ? <p className="text-xs text-muted-foreground">{formatMsgTime(c.last_message_time)}</p>
                      : null}
                </div>
              </button>
            );
          })}
          {/* Load more indicator */}
          {loading && contacts.length > 0 && (
            <div className="flex items-center justify-center py-3 text-muted-foreground text-xs gap-2">
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              Đang tải thêm...
            </div>
          )}
          {!loading && contactsFailedPage !== null && contactsFailedPage > 0 && contacts.length > 0 ? (
            // Trang tiếp theo lỗi: giữ danh sách, thử lại đúng trang đó
            <LoadFailedRow text="Không tải được thêm" onRetry={() => { void retryContacts(); }} />
          ) : !loading && hasMore && !search.trim() && contacts.length > 0 && (
            <button onClick={loadNextPage}
              className="w-full py-3 text-xs text-blue-400 hover:text-blue-300 hover:bg-muted/50 transition-colors">
              Xem thêm ({contacts.length}/{totalCount})
            </button>
          )}
        </div>

        {/* Footer */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border flex-shrink-0">
            <button onClick={() => setSelected(new Set())} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              Bỏ chọn tất cả
            </button>
            <button onClick={handleForward}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">
              Chuyển tiếp ({selected.size})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
