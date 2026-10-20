/**
 * Contact / group picker of the workflow settings panel.
 *
 * - Context aware: only accounts of the field's channel (cross-channel field → its own channel,
 *   else the workflow channel); when the workflow runs for specific accounts only those are
 *   offered; the type (người dùng / nhóm) follows the field.
 * - Large address books: the main process searches (accent-insensitive), filters and pages
 *   (`db.searchContactsForPicker`); the list loads 50 rows at a time while scrolling.
 * - Selected ids show real names (looked up by id), raw ids can still be typed in.
 */
import React from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import { useAccountStore, AccountInfo } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { toLocalMediaUrl } from '@/lib/localMedia';
import GroupAvatar from '@/components/common/GroupAvatar';
import { CloseIcon, PlusIcon, SearchIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import { CHANNEL_NAME, ChannelMark, NodeChannel } from './nodeVisuals';

type ContactType = 'user' | 'group' | 'all';

export interface PickerItem {
  id: string;
  name: string;
  originalName?: string;
  avatar?: string;
  phone?: string;
  type: 'user' | 'group';
  isFriend: boolean;
  lastActivity: number;
}

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 220;
const EMPTY_COUNTS = { all: 0, user: 0, group: 0 };

const accountChannel = (account: AccountInfo): string => account.channel || 'zalo';
const accountName = (account: AccountInfo): string => account.full_name || account.display_name || account.username || account.zalo_id;
const isTemplate = (value: string) => value.includes('{{');

/** Accounts the picker may read from, preferred (workflow) accounts first. */
export function resolvePickerAccounts(accounts: AccountInfo[], opts: {
  channel?: string;
  accountId?: string;
  preferredAccountIds?: string[];
}): { list: AccountInfo[]; restricted: boolean } {
  const byChannel = opts.channel ? accounts.filter(account => accountChannel(account) === opts.channel) : accounts;
  if (opts.accountId) {
    const fixed = byChannel.filter(account => account.zalo_id === opts.accountId);
    return { list: fixed.length ? fixed : byChannel, restricted: fixed.length > 0 };
  }
  const preferred = (opts.preferredAccountIds || []).filter(Boolean);
  if (preferred.length) {
    const inWorkflow = byChannel.filter(account => preferred.includes(account.zalo_id));
    if (inWorkflow.length) return { list: inWorkflow, restricted: true };
  }
  return { list: byChannel, restricted: false };
}

function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'vừa xong';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} phút trước`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} giờ trước`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} ngày trước`;
  return new Date(ms).toLocaleDateString('vi-VN');
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function ContactAvatar({ item, accountId }: { item: Pick<PickerItem, 'id' | 'name' | 'avatar' | 'type'>; accountId: string }) {
  const groupInfo = useAppStore(s => (item.type === 'group' ? s.groupInfoCache?.[accountId]?.[item.id] : undefined));
  const [failed, setFailed] = React.useState(false);
  if (item.type === 'group') {
    return <GroupAvatar avatarUrl={item.avatar} groupInfo={groupInfo} name={item.name} id={item.id} size="sm" />;
  }
  const src = item.avatar && !failed ? toLocalMediaUrl(item.avatar) : '';
  return src ? (
    <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}
      className="w-9 h-9 rounded-full object-cover flex-shrink-0 bg-[var(--wf-sub)]" />
  ) : (
    <span className="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-bold"
      style={{ background: 'color-mix(in srgb, var(--wf-focus) 14%, var(--wf-card))', color: 'var(--wf-focus)' }}>
      {(item.name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function ContactPickerModal({
  open, onClose, contactType, contactMode, channel, accountId, preferredAccountIds, value, onChange, knownItems,
}: {
  open: boolean;
  onClose: () => void;
  contactType: ContactType;
  contactMode: 'single' | 'multi';
  channel?: string;
  accountId?: string;
  preferredAccountIds?: string[];
  value: string[];
  onChange: (ids: string[]) => void;
  /** Names already resolved by the field (selected chips). */
  knownItems: Record<string, PickerItem>;
}) {
  const accounts = useAccountStore(s => s.accounts);
  const { list: candidates, restricted } = React.useMemo(
    () => resolvePickerAccounts(accounts, { channel, accountId, preferredAccountIds }),
    [accounts, channel, accountId, preferredAccountIds],
  );
  const [selectedAccountId, setSelectedAccountId] = React.useState('');
  const [query, setQuery] = React.useState('');
  const search = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const [tab, setTab] = React.useState<ContactType>(contactType);
  const [items, setItems] = React.useState<PickerItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [counts, setCounts] = React.useState(EMPTY_COUNTS);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState('');
  const [manualId, setManualId] = React.useState('');
  const [seen, setSeen] = React.useState<Record<string, PickerItem>>({});
  const requestRef = React.useRef(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const effectiveType: ContactType = contactType === 'all' ? tab : contactType;
  const channelName = channel ? CHANNEL_NAME[channel as NodeChannel] || channel : '';
  const selectedAccount = candidates.find(account => account.zalo_id === selectedAccountId);

  // Reset on open; keep the chosen account while it stays a candidate
  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setTab(contactType);
    setManualId('');
    setTimeout(() => searchRef.current?.focus(), 30);
  }, [open, contactType]);

  React.useEffect(() => {
    if (!open) return;
    if (!candidates.some(account => account.zalo_id === selectedAccountId)) {
      setSelectedAccountId(candidates[0]?.zalo_id || '');
    }
  }, [open, candidates, selectedAccountId]);

  const fetchPage = React.useCallback(async (offset: number) => {
    if (!selectedAccountId) return null;
    // DataAccessor: chế độ nhân viên tìm trong danh bạ Boss (IPC trả stub rỗng → ô chọn liên hệ trống)
    const res = await DataAccessor.searchContactsForPicker({
      zaloId: selectedAccountId, search, type: effectiveType, limit: PAGE_SIZE, offset,
    });
    if (!res) return { items: [], total: 0, counts: EMPTY_COUNTS, error: 'Không đọc được danh bạ' };
    return { items: res.items || [], total: res.total || 0, counts: res.counts || EMPTY_COUNTS, error: res.success === false ? (res.error || 'Không đọc được danh bạ') : '' };
  }, [selectedAccountId, search, effectiveType]);

  // First page whenever the account / search / type changes
  React.useEffect(() => {
    if (!open || !selectedAccountId) { setItems([]); setTotal(0); setCounts(EMPTY_COUNTS); return; }
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    fetchPage(0).then(page => {
      if (requestId !== requestRef.current || !page) return;
      setItems(page.items);
      setTotal(page.total);
      setCounts(page.counts);
      setError(page.error);
      listRef.current?.scrollTo({ top: 0 });
    }).catch(err => {
      if (requestId === requestRef.current) setError(err?.message || 'Không đọc được danh bạ');
    }).finally(() => {
      if (requestId === requestRef.current) setLoading(false);
    });
  }, [open, selectedAccountId, fetchPage]);

  const loadMore = React.useCallback(() => {
    if (loading || loadingMore || items.length >= total) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    fetchPage(items.length).then(page => {
      if (requestId !== requestRef.current || !page) return;
      setItems(prev => {
        const known = new Set(prev.map(item => item.id));
        return [...prev, ...page.items.filter(item => !known.has(item.id))];
      });
      setTotal(page.total);
    }).finally(() => setLoadingMore(false));
  }, [loading, loadingMore, items.length, total, fetchPage]);

  // Infinite scroll: load the next page when the sentinel gets close
  React.useEffect(() => {
    const root = listRef.current;
    const target = sentinelRef.current;
    if (!open || !root || !target) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMore();
    }, { root, rootMargin: '0px 0px 320px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [open, loadMore, items.length]);

  // Remember names of everything shown, for the "Đã chọn" chips
  React.useEffect(() => {
    if (!items.length) return;
    setSeen(prev => {
      const next = { ...prev };
      for (const item of items) next[item.id] = item;
      return next;
    });
  }, [items]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const isSelected = (id: string) => value.includes(id);
  const toggle = (id: string) => {
    if (contactMode === 'multi') {
      onChange(isSelected(id) ? value.filter(x => x !== id) : [...value, id]);
    } else {
      onChange([id]);
      onClose();
    }
  };
  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    setManualId('');
    if (contactMode === 'multi') {
      if (!isSelected(id)) onChange([...value, id]);
    } else {
      onChange([id]);
      onClose();
    }
  };

  const title = contactType === 'group' ? 'Chọn nhóm' : contactType === 'user' ? 'Chọn người nhận' : 'Chọn hội thoại / nhóm';
  const tabs: Array<{ id: ContactType; label: string; icon: React.ReactNode; count: number }> = [
    { id: 'all', label: 'Tất cả', icon: null, count: counts.all },
    { id: 'user', label: 'Cá nhân', icon: <UserIcon className="w-3.5 h-3.5" />, count: counts.user },
    { id: 'group', label: 'Nhóm', icon: <UsersIcon className="w-3.5 h-3.5" />, count: counts.group },
  ];
  const selectedChips = contactMode === 'multi' ? value : [];
  const chipName = (id: string) => (isTemplate(id) ? id : (seen[id] || knownItems[id])?.name || id);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm pointer-events-none" />
      <div className="relative wf-panel border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 'min(46rem, 96vw)', height: 'min(42rem, 88vh)' }}>
        {/* Header */}
        <div className="wf-panel__header flex items-center gap-3 px-5 py-3.5">
          <span className="relative inline-flex w-10 h-10 items-center justify-center rounded-xl flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--wf-focus) 12%, var(--wf-card))', color: 'var(--wf-focus)' }}>
            {contactType === 'group' ? <UsersIcon className="w-5 h-5" /> : <UserIcon className="w-5 h-5" />}
            {channel && ['zalo', 'facebook', 'telegram_user', 'telegram_bot'].includes(channel) && (
              <ChannelMark channel={channel as NodeChannel} />
            )}
          </span>
          <div className="flex-1 min-w-0">
            <p className="wf-panel__title truncate">{title}</p>
            <p className="wf-panel__desc truncate">
              {channelName ? `Danh bạ ${channelName}` : 'Danh bạ'}
              {selectedAccount ? ` · ${accountName(selectedAccount)}` : ''}
              {restricted && !accountId ? ' · theo tài khoản của workflow' : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="wf-icon-btn" title="Đóng (Esc)"><CloseIcon className="w-4 h-4" /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Accounts (only when there is a choice) */}
          {candidates.length > 1 && (
            <div className="w-52 flex-shrink-0 border-r border-[color:var(--wf-panel-border)] flex flex-col min-h-0">
              <p className="px-4 pt-3 pb-2 wf-section-title">Tài khoản</p>
              <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
                {candidates.map(account => {
                  const active = account.zalo_id === selectedAccountId;
                  return (
                    <button key={account.zalo_id} type="button" onClick={() => setSelectedAccountId(account.zalo_id)}
                      className="wf-choice !gap-2.5 !px-2.5 !py-2" data-active={String(active)}>
                      {account.avatar_url ? (
                        <img src={toLocalMediaUrl(account.avatar_url)} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <span className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold"
                          style={{ background: 'color-mix(in srgb, var(--wf-focus) 14%, var(--wf-card))', color: 'var(--wf-focus)' }}>
                          {accountName(account).charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="wf-choice__title block truncate !text-xs">{accountName(account)}</span>
                        {account.phone && <span className="wf-choice__meta block truncate">{account.phone}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* List */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-4 pt-3 pb-2.5 space-y-2.5 border-b border-[color:var(--wf-panel-border)]">
              <div className="relative">
                <SearchIcon className="w-4 h-4 wf-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Tìm theo tên, biệt danh, SĐT hoặc ID (không cần dấu)…"
                  className="wf-input !pl-9" />
              </div>
              {contactType === 'all' && (
                <div className="wf-seg w-full" role="tablist">
                  {tabs.map(t => (
                    <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                      className="wf-seg__btn flex-1 !h-7" data-active={String(tab === t.id)}>
                      {t.icon}<span>{t.label}</span>
                      <span className="text-[10.5px] font-semibold wf-faint tabular-nums">{t.count.toLocaleString('vi-VN')}</span>
                    </button>
                  ))}
                </div>
              )}
              {selectedChips.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="pt-1 text-[11px] font-semibold wf-muted flex-shrink-0">Đã chọn {selectedChips.length}:</span>
                  <div className="flex-1 min-w-0 flex flex-wrap gap-1 max-h-[3.75rem] overflow-y-auto">
                    {selectedChips.map(id => (
                      <span key={id} className="wf-chip max-w-[12rem]" title={id}>
                        <span className="truncate">{chipName(id)}</span>
                        <button type="button" onClick={() => onChange(value.filter(x => x !== id))}
                          className="flex-shrink-0 opacity-60 hover:opacity-100" title="Bỏ chọn">
                          <CloseIcon className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <button type="button" onClick={() => onChange([])} className="wf-btn wf-btn--sm wf-btn--ghost wf-btn--danger flex-shrink-0">Bỏ chọn</button>
                </div>
              )}
            </div>

            <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2">
              {!candidates.length ? (
                <div className="wf-empty mt-6">
                  <p className="text-sm font-semibold wf-text">Chưa có tài khoản {channelName || ''} nào</p>
                  <p className="wf-help !mt-0">Thêm tài khoản rồi mở lại, hoặc nhập ID thủ công bên dưới.</p>
                </div>
              ) : error ? (
                <div className="wf-callout mt-2" data-tone="warn"><span>{error}</span></div>
              ) : loading && !items.length ? (
                <div className="space-y-1.5 pt-1">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="flex items-center gap-3 px-2 py-2">
                      <span className="w-9 h-9 rounded-full bg-[var(--wf-sub)] animate-pulse" />
                      <span className="flex-1 space-y-1.5">
                        <span className="block h-3 w-1/2 rounded bg-[var(--wf-sub)] animate-pulse" />
                        <span className="block h-2.5 w-1/3 rounded bg-[var(--wf-sub)] animate-pulse" />
                      </span>
                    </div>
                  ))}
                </div>
              ) : !items.length ? (
                <div className="wf-empty mt-6">
                  <p className="text-sm font-semibold wf-text">{search ? `Không tìm thấy "${search}"` : 'Chưa có dữ liệu danh bạ'}</p>
                  <p className="wf-help !mt-0">
                    {search ? 'Thử tên khác, SĐT hoặc nhập ID thủ công bên dưới.' : 'Mở tài khoản này trong ứng dụng để đồng bộ danh bạ, hoặc nhập ID thủ công.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {items.map(item => {
                    const selected = isSelected(item.id);
                    return (
                      <button key={item.id} type="button" onClick={() => toggle(item.id)}
                        className="wf-picker-row" data-active={String(selected)}>
                        {contactMode === 'multi' && (
                          <span className="wf-check" data-on={String(selected)} aria-hidden="true" />
                        )}
                        <ContactAvatar item={item} accountId={selectedAccountId} />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-[13px] font-semibold wf-text">{item.name}</span>
                          <span className="flex items-center gap-1.5 min-w-0 text-[11px] wf-muted">
                            <span className="wf-badge !h-4 flex-shrink-0" data-tone={item.type === 'group' ? 'orange' : item.isFriend ? 'green' : 'gray'}>
                              {item.type === 'group' ? 'NHÓM' : item.isFriend ? 'BẠN BÈ' : 'CÁ NHÂN'}
                            </span>
                            {item.originalName && <span className="truncate">{item.originalName}</span>}
                            <span className="truncate font-mono text-[10.5px] wf-faint">ID {item.id}</span>
                          </span>
                        </span>
                        {item.lastActivity > 0 && <span className="text-[10.5px] wf-faint flex-shrink-0">{relativeTime(item.lastActivity)}</span>}
                      </button>
                    );
                  })}
                  <div ref={sentinelRef} className="h-px" />
                  {loadingMore && <p className="py-2 text-center text-[11px] wf-faint">Đang tải thêm…</p>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="wf-panel__footer flex items-center gap-2 px-5 py-3">
          <span className="text-xs wf-muted tabular-nums">
            {total.toLocaleString('vi-VN')} kết quả{items.length < total ? ` · đang hiện ${items.length.toLocaleString('vi-VN')}` : ''}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <input value={manualId} onChange={e => setManualId(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
              placeholder="Nhập ID thủ công" className="wf-input wf-input--sm !w-40" />
            <button type="button" onClick={addManual} disabled={!manualId.trim()} className="wf-btn wf-btn--sm">
              <PlusIcon className="w-3.5 h-3.5" /> Thêm
            </button>
            <button type="button" onClick={onClose} className={`wf-btn ${contactMode === 'multi' ? 'wf-btn--primary' : ''}`}>
              {contactMode === 'multi' ? `Xong${value.length ? ` (${value.length})` : ''}` : 'Đóng'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Field ────────────────────────────────────────────────────────────────────

export function ContactPickerField({
  value, onChange, contactType, contactMode = 'single', channel, accountId, preferredAccountIds, placeholder, templateVars,
}: {
  value: string;
  onChange: (v: string) => void;
  contactType: ContactType;
  contactMode?: 'single' | 'multi';
  channel?: string;
  accountId?: string;
  /** Accounts the workflow runs for (same channel only). */
  preferredAccountIds?: string[];
  placeholder?: string;
  /** Variable suggestions already filtered by what the workflow's trigger provides. */
  templateVars?: string[];
}) {
  const accounts = useAccountStore(s => s.accounts);
  const [showModal, setShowModal] = React.useState(false);
  const [known, setKnown] = React.useState<Record<string, PickerItem>>({});

  // Giá trị: string đơn hoặc JSON array
  const selectedIds: string[] = React.useMemo(() => {
    if (!value) return [];
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : [value]; }
    catch { return [value]; }
  }, [value]);

  const handleChange = (ids: string[]) => {
    if (contactMode === 'multi') onChange(ids.length > 0 ? JSON.stringify(ids) : '');
    else onChange(ids[0] || '');
  };

  // Names for the selected ids (looked up in the candidate accounts' contacts)
  const candidateKey = React.useMemo(() => {
    const { list } = resolvePickerAccounts(accounts, { channel, accountId, preferredAccountIds });
    return list.slice(0, 8).map(account => account.zalo_id).join(',');
  }, [accounts, channel, accountId, preferredAccountIds]);
  const missingKey = selectedIds.filter(id => !isTemplate(id) && !known[id]).join(',');
  React.useEffect(() => {
    const missing = missingKey ? missingKey.split(',') : [];
    const accountIds = candidateKey ? candidateKey.split(',') : [];
    if (!missing.length || !accountIds.length) return;
    let cancelled = false;
    (async () => {
      const found: Record<string, PickerItem> = {};
      let remaining = missing;
      for (const zaloId of accountIds) {
        let res: { items?: PickerItem[] } | undefined;
        try { res = await DataAccessor.searchContactsForPicker({ zaloId, ids: remaining }); } catch { res = undefined; }
        for (const item of res?.items || []) found[item.id] = item;
        remaining = remaining.filter(id => !found[id]);
        if (!remaining.length) break;
      }
      if (!cancelled && Object.keys(found).length) setKnown(prev => ({ ...prev, ...found }));
    })();
    return () => { cancelled = true; };
  }, [missingKey, candidateKey]);

  return (
    <div className="wf-card wf-card--plain overflow-hidden">
      <div className="flex items-center gap-2 p-2">
        <div className="flex-1 flex flex-wrap gap-1 min-h-[30px] min-w-0 items-center">
          {selectedIds.length > 0 ? (
            selectedIds.map(id => {
              const item = known[id];
              return (
                <span key={id} className={`wf-chip max-w-full${isTemplate(id) ? ' font-mono' : ''}`} title={item ? `${item.name} · ID ${id}` : id}>
                  {item && <span className="flex-shrink-0">{item.type === 'group' ? <UsersIcon className="w-3 h-3" /> : <UserIcon className="w-3 h-3" />}</span>}
                  <span className="min-w-0 truncate">{item?.name || id}</span>
                  <button type="button" onClick={() => handleChange(selectedIds.filter(x => x !== id))}
                    className="-mr-0.5 flex-shrink-0 opacity-60 transition-opacity hover:opacity-100" title="Bỏ chọn">
                    <CloseIcon className="w-3 h-3" />
                  </button>
                </span>
              );
            })
          ) : (
            <span className="px-1 text-xs wf-faint">{placeholder || 'Nhập ID hoặc chọn từ danh bạ'}</span>
          )}
        </div>
        <button type="button" onClick={() => setShowModal(true)} className="wf-btn wf-btn--sm flex-shrink-0">
          <UsersIcon className="w-3.5 h-3.5" /> Chọn
        </button>
      </div>

      {templateVars && templateVars.length > 0 && (
        <div className="px-3 py-2 border-t border-[color:var(--wf-card-border)]">
          <div className="mb-1.5 text-[10.5px] font-medium wf-muted">Hoặc dùng biến:</div>
          <div className="flex flex-wrap gap-1">
            {templateVars.map(v => (
              <button key={v} type="button" onClick={() => handleChange([`{{ ${v} }}`])}
                className="wf-chip font-mono" data-active={String(selectedIds.includes(`{{ ${v} }}`))}>
                {`{{ ${v} }}`}
              </button>
            ))}
          </div>
        </div>
      )}

      <ContactPickerModal
        open={showModal}
        onClose={() => setShowModal(false)}
        contactType={contactType}
        contactMode={contactMode}
        channel={channel}
        accountId={accountId}
        preferredAccountIds={preferredAccountIds}
        value={selectedIds}
        onChange={handleChange}
        knownItems={known}
      />
    </div>
  );
}
