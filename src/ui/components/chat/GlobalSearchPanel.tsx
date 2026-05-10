import React, { useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import GroupAvatar from '../common/GroupAvatar';

// ─── Vietnamese-aware normalization for fuzzy matching ────────────────────────
function normalizeStr(s: string): string {
  return s
    .normalize('NFC')          // unify Unicode representations
    .toLowerCase()
    .replace(/[\u200b-\u200f\uFEFF]/g, '') // strip zero-width chars
    .replace(/\s+/g, ' ')      // normalize all whitespace variants (NBSP U+00A0, etc.) to regular space
    .trim();
}

// Build a stripped version (no combining diacritics) for fallback matching
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function matchQuery(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const h = normalizeStr(haystack);
  const n = normalizeStr(needle);
  if (h.includes(n)) return true;
  // Fallback: strip diacritics (e.g. "em yeu" matches "Em yêu")
  return stripDiacritics(h).includes(stripDiacritics(n));
}

function isPhoneNumber(s: string): boolean {
  return /^(\+84|0)\d{8,10}$/.test(s.trim().replace(/\s/g, ''));
}

// ─── Highlight matching text ──────────────────────────────────────────────────
export function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim() || !text) return <>{text}</>;
  const nText = normalizeStr(text);
  const nQuery = normalizeStr(query);
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = nText.indexOf(nQuery, 0);
  while (i !== -1) {
    if (i > last) parts.push(<span key={`t${i}`}>{text.slice(last, i)}</span>);
    parts.push(
      <span key={`h${i}`} className="text-blue-400 font-semibold">
        {text.slice(i, i + query.length)}
      </span>
    );
    last = i + query.length;
    i = nText.indexOf(nQuery, last);
  }
  if (last < text.length) parts.push(<span key={'e' + last}>{text.slice(last)}</span>);
  return parts.length ? <>{parts}</> : <>{text}</>;
}

// ─── Parse message preview ────────────────────────────────────────────────────
function parsePreview(content: string): string {
  if (!content) return '[Tin nhắn]';
  
  try {
    const p = JSON.parse(content);
    
    if (typeof p === 'string') return p;
    
    // Check for link preview FIRST (recommened.link) - show only media title like Zalo
    const action = String(p?.action || '');
    if (action === 'recommened.link') {
      const par = (() => { try { return typeof p?.params === 'string' ? JSON.parse(p.params) : (p?.params || {}); } catch { return {}; } })();
      const mediaTitle = par.mediaTitle || par.src || '';
      if (mediaTitle) {
        return mediaTitle;
      }
      // Fallback to hostname
      const href = p?.href || p?.title || '';
      if (href && href.includes('://')) {
        try {
          const url = new URL(href);
          return `🔗 ${url.hostname}`;
        } catch { }
      }
      return '🔗 Link';
    }
    
    // Filter out "0", "null", empty strings from content/msg
    const contentText = (typeof p?.content === 'string' ? p.content : null);
    const msgText = (typeof p?.msg === 'string' ? p.msg : null);
    
    if (contentText && contentText.trim() && contentText !== '0' && contentText !== 'null') {
      return contentText;
    }
    if (msgText && msgText.trim() && msgText !== '0' && msgText !== 'null') {
      return msgText;
    }
    
    const par = (() => { try { return typeof p?.params === 'string' ? JSON.parse(p.params) : (p?.params || {}); } catch { return {}; } })();
    if (p?.title && (par?.fileSize || par?.fileExt || par?.fileUrl || p?.normalUrl)) return `📂 ${p.title}`;
    if (p?.href || p?.thumb || par?.rawUrl || par?.hd) return '[Hình ảnh]';
    if (p?.title) return p.title;
    return '[Đính kèm]';
  } catch { 
    return content; 
  }
}

// Check if message should be included in search results (only text and image+text)
function isSearchableMessage(content: string): boolean {
  if (!content) return false;
  
  // Plain text messages: always searchable
  if (!content.startsWith('{')) return true;
  
  try {
    const p = JSON.parse(content);
    const action = String(p?.action || '');
    
    // Exclude system messages (reminders, calls, etc.)
    if (action && action !== 'recommened.link') return false;
    
    // Check for meaningful text content
    const contentText = (typeof p?.content === 'string' ? p.content : null);
    const msgText = (typeof p?.msg === 'string' ? p.msg : null);
    
    // Has text content that's not "0" or "null"
    if (contentText && contentText.trim() && contentText !== '0' && contentText !== 'null') return true;
    if (msgText && msgText.trim() && msgText !== '0' && msgText !== 'null') return true;
    
    // Link preview with media title
    if (action === 'recommened.link') {
      const par = (() => { try { return typeof p?.params === 'string' ? JSON.parse(p.params) : (p?.params || {}); } catch { return {}; } })();
      if (par.mediaTitle || par.src) return true;
    }
    
    // Image/attachment without text: NOT searchable
    return false;
  } catch {
    // Not JSON, treat as plain text
    return true;
  }
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit' });
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ─── ContactResultItem ────────────────────────────────────────────────────────
function ContactResultItem({ contact, query, onClick, groupInfoCache }: { 
  contact: any; 
  query: string; 
  onClick: () => void;
  groupInfoCache?: { [zaloId: string]: { [groupId: string]: any } };
}) {
  const name = contact.alias || contact.display_name || contact.contact_id;
  const isGroup = contact.contact_type === 'group';
  const zaloId = contact.owner_zalo_id;
  const groupInfo = isGroup && zaloId && groupInfoCache?.[zaloId]?.[contact.contact_id];
  
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-700/60 transition-colors text-left group">
      <div className="flex-shrink-0">
        {isGroup ? (
          <GroupAvatar
            avatarUrl={contact.avatar_url}
            groupInfo={groupInfo}
            name={name}
            size="search"
          />
        ) : (
          contact.avatar_url
            ? <img src={contact.avatar_url} alt={name} className="w-11 h-11 rounded-full object-cover" />
            : <div className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-sm bg-blue-600">{(name || '?').charAt(0).toUpperCase()}</div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-100 truncate">{highlightText(name, query)}</p>
        {isGroup && <p className="text-xs text-gray-500 mt-0.5">Nhóm</p>}
        {contact._isFriendOnly && <p className="text-xs text-green-500 mt-0.5">Bạn bè</p>}
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-600 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  );
}

// ─── MessageResultItem ────────────────────────────────────────────────────────
function MessageResultItem({ msg, query, contacts, onClick, groupInfoCache }: { 
  msg: any; 
  query: string; 
  contacts: any[]; 
  onClick: () => void;
  groupInfoCache?: { [zaloId: string]: { [groupId: string]: any } };
}) {
  const contact = contacts.find(c => c.contact_id === msg.thread_id);
  const convName = contact?.alias || contact?.display_name || msg.thread_id || 'Hội thoại';
  const preview = parsePreview(msg.content);
  const isGroup = contact?.contact_type === 'group';
  const zaloId = msg.owner_zalo_id;
  const groupInfo = isGroup && zaloId && groupInfoCache?.[zaloId]?.[msg.thread_id];
  
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-700/60 transition-colors text-left">
      {isGroup ? (
        <GroupAvatar
          avatarUrl={contact?.avatar_url}
          groupInfo={groupInfo}
          name={convName}
          size="search"
        />
      ) : (
        contact?.avatar_url
          ? <img src={contact.avatar_url} alt={convName} className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
          : <div className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 text-sm bg-blue-600">{(convName || '?').charAt(0).toUpperCase()}</div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-100 font-medium truncate">{convName}</p>
          <span className="text-xs text-gray-500 flex-shrink-0">{formatTime(msg.timestamp)}</span>
        </div>
        <p className="text-xs text-gray-400 truncate mt-0.5">
          {!!msg.is_sent && <span className="text-gray-500">Bạn: </span>}
          {highlightText(preview, query)}
        </p>
      </div>
    </button>
  );
}

// ─── PhoneResultCard ──────────────────────────────────────────────────────────
function PhoneResultCard({ result, searching, onOpen, onAddFriend }: {
  result: any | null; searching: boolean;
  onOpen: () => void; onAddFriend: () => void;
}) {
  if (searching) return (
    <div className="mx-3 my-2 p-3 bg-gray-800 rounded-xl border border-gray-700 text-xs text-gray-400 flex items-center gap-2">
      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
      Đang tìm kiếm SĐT...
    </div>
  );
  if (!result) return null;
  if (result._notFound) return (
    <div className="mx-3 my-2 p-3 bg-gray-800 rounded-xl border border-gray-700 text-xs text-gray-500">
      Không tìm thấy người dùng hoặc người dùng đã chặn tìm kiếm với người lạ
    </div>
  );
  const name = result.display_name || result.zalo_name || result.uid;
  return (
    <div className="mx-3 my-2 p-3 bg-gray-800 rounded-xl border border-gray-700 flex items-center gap-3">
      {result.avatar
        ? <img src={result.avatar} alt={name} className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
        : <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold flex-shrink-0">{(name || 'U').charAt(0).toUpperCase()}</div>}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-100 truncate font-medium">{name}</p>
        {result.isBlocked === 1 ? <p className="text-xs text-red-400">🚫 Đã chặn</p>
          : result.isFr === 1 ? <p className="text-xs text-green-400">✓ Bạn bè</p>
          : result._sentRequest ? <p className="text-xs text-yellow-400">✓ Đã gửi lời mời</p>
          : <p className="text-xs text-gray-400">Chưa kết bạn</p>}
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {result.isBlocked !== 1 && result.isFr !== 1 && !result._sentRequest && (
          <button onClick={onAddFriend} className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-2.5 py-1 rounded-lg transition-colors">+ Kết bạn</button>
        )}
        <button onClick={onOpen} className="bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs px-2.5 py-1 rounded-lg transition-colors">💬</button>
      </div>
    </div>
  );
}

// ─── Types & constants ────────────────────────────────────────────────────────
type SearchTab = 'all' | 'contacts' | 'messages';
const ALL_CONTACT_LIMIT = 10;
const ALL_MESSAGE_LIMIT = 20;
const PAGE_SIZE = 20;

export interface GlobalSearchPanelProps {
  query: string;
  activeAccountId: string | null;
  contacts: any[];
  allAccounts: any[];
  mergedInboxMode: boolean;
  mergedInboxAccounts: string[];
  groupInfoCache?: { [zaloId: string]: { [groupId: string]: any } };
  onSelectConversation: (contactId: string, threadType: number, overrideZaloId?: string, userInfo?: { display_name: string; avatar_url: string }) => void;
  onSelectMessage: (msg: any) => void;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function GlobalSearchPanel({
  query, activeAccountId, contacts, allAccounts, mergedInboxMode, mergedInboxAccounts,
  groupInfoCache, onSelectConversation, onSelectMessage,
}: GlobalSearchPanelProps) {
  const [tab, setTab] = useState<SearchTab>('all');
  const [msgResults, setMsgResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [contactsPage, setContactsPage] = useState(1);
  const [messagesPage, setMessagesPage] = useState(1);

  // Phone search state
  const [phoneResult, setPhoneResult] = useState<any>(null);
  const [phoneSearching, setPhoneSearching] = useState(false);
  const [phonePendingAccounts, setPhonePendingAccounts] = useState(false); // merged mode: need to pick account

  // Friends list from DB (includes friends without conversations)
  const [friendsList, setFriendsList] = useState<any[]>([]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load friends list from DB ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const loadFriends = async () => {
      try {
        if (mergedInboxMode && mergedInboxAccounts.length > 0) {
          // Merged mode: load friends from all accounts
          const allFriends: any[] = [];
          for (const zaloId of mergedInboxAccounts) {
            const res = await ipc.db?.getFriends({ zaloId });
            if (res?.friends) {
              allFriends.push(...res.friends.map((f: any) => ({ ...f, _ownerZaloId: zaloId })));
            }
          }
          if (!cancelled) setFriendsList(allFriends);
        } else if (activeAccountId) {
          const res = await ipc.db?.getFriends({ zaloId: activeAccountId });
          if (!cancelled && res?.friends) {
            setFriendsList(res.friends.map((f: any) => ({ ...f, _ownerZaloId: activeAccountId })));
          }
        }
      } catch {
        // ignore
      }
    };
    loadFriends();
    return () => { cancelled = true; };
  }, [activeAccountId, mergedInboxMode, mergedInboxAccounts]);

  // Reset pagination + phone when query or tab changes
  useEffect(() => {
    setContactsPage(1);
    setMessagesPage(1);
    setPhoneResult(null);
    setPhonePendingAccounts(false);
  }, [query]);

  useEffect(() => {
    setContactsPage(1);
    setMessagesPage(1);
  }, [tab]);

  // ── Contact filtering with Vietnamese normalization ──────────────────────────
  // Build a set of contact IDs already in conversations for quick lookup
  const contactIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      set.add(c.contact_id);
    }
    return set;
  }, [contacts]);

  const contactResults = useMemo(() => {
    if (!query.trim()) return [];
    // 1. Filter from existing contacts (conversations)
    const fromContacts = contacts.filter(c => {
      // Search both alias AND display_name independently so full display name
      // (e.g. "Em yêu") still matches even when alias is shorter (e.g. "Em")
      const alias = c.alias || '';
      const displayName = c.display_name || '';
      const phone = c.phone || '';
      return matchQuery(alias, query) || matchQuery(displayName, query) || matchQuery(phone, query) || matchQuery(c.contact_id || '', query);
    });

    // 2. Filter from friends list (those NOT already in contacts/conversations)
    const fromFriends = friendsList
      .filter(f => {
        if (contactIdSet.has(f.userId)) return false; // already in conversations
        const name = f.displayName || '';
        const phone = f.phoneNumber || '';
        return matchQuery(name, query) || matchQuery(phone, query) || matchQuery(f.userId || '', query);
      })
      .map(f => ({
        // Transform friend to ContactItem-like shape for display
        contact_id: f.userId,
        display_name: f.displayName || f.userId,
        avatar_url: f.avatar || '',
        phone: f.phoneNumber || '',
        contact_type: 'user',
        owner_zalo_id: f._ownerZaloId || activeAccountId || '',
        is_friend: 1,
        unread_count: 0,
        _isFriendOnly: true, // flag to indicate this is from friends table, no conversation yet
      }));

    return [...fromContacts, ...fromFriends];
  }, [contacts, friendsList, contactIdSet, query, activeAccountId]);

  // ── Message search (debounced) ───────────────────────────────────────────────
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const isPhone = isPhoneNumber(query);
    if (!query.trim() || !activeAccountId || isPhone) {
      setMsgResults([]); setSearching(false); return;
    }
    setSearching(true);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await ipc.db?.searchMessages({ zaloId: activeAccountId, query: query.trim() });
        const allResults = res?.results || [];
        // Filter to only show searchable messages (text and image+text)
        const filtered = allResults.filter((msg: any) => isSearchableMessage(msg.content));
        setMsgResults(filtered);
      } catch { setMsgResults([]); }
      finally { setSearching(false); }
    }, 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, activeAccountId]);

  // ── Phone number search ──────────────────────────────────────────────────────
  const doPhoneSearch = async (acc: any, phone: string) => {
    setPhoneSearching(true); setPhoneResult(null); setPhonePendingAccounts(false);
    try {
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      const res = await ipc.zalo?.findUser({ auth, phone: phone.trim() });
      const user = res?.response;
      if (user?.uid) {
        try {
          const infoRes = await ipc.zalo?.getUserInfo({ auth, userId: user.uid });
          const profile = infoRes?.response?.changed_profiles?.[user.uid];
          setPhoneResult(profile
            ? { ...user, isFr: profile.isFr ?? 0, isBlocked: profile.isBlocked ?? 0, _searchZaloId: acc.zalo_id }
            : { ...user, _searchZaloId: acc.zalo_id });
        } catch { setPhoneResult({ ...user, _searchZaloId: acc.zalo_id }); }
      } else {
        setPhoneResult({ _notFound: true });
      }
    } catch {} finally { setPhoneSearching(false); }
  };

  useEffect(() => {
    if (!isPhoneNumber(query) || !query.trim()) return;
    if (mergedInboxMode && mergedInboxAccounts.length > 1) {
      setPhonePendingAccounts(true); setPhoneResult(null); return;
    }
    const accId = mergedInboxMode ? (mergedInboxAccounts[0] ?? activeAccountId) : activeAccountId;
    const acc = allAccounts.find(a => a.zalo_id === accId);
    if (acc) doPhoneSearch(acc, query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeAccountId]);

  // ── Derived display data ─────────────────────────────────────────────────────
  const isPhone = isPhoneNumber(query);
  const showContactsSection = (tab === 'all' || tab === 'contacts') && contactResults.length > 0 && !isPhone;
  const showMessagesSection = (tab === 'all' || tab === 'messages') && msgResults.length > 0 && !isPhone;
  const isEmpty = !searching && !isPhone && !phoneSearching && query.trim()
    && contactResults.length === 0 && msgResults.length === 0;

  // Paginated slices
  const contactsForAll = contactResults.slice(0, ALL_CONTACT_LIMIT);
  const msgsForAll = msgResults.slice(0, ALL_MESSAGE_LIMIT);
  const contactsForTab = contactResults.slice(0, contactsPage * PAGE_SIZE);
  const msgsForTab = msgResults.slice(0, messagesPage * PAGE_SIZE);

  const TABS: { key: SearchTab; label: string }[] = [
    { key: 'all', label: 'Tất cả' },
    { key: 'contacts', label: 'Liên hệ' },
    { key: 'messages', label: 'Tin nhắn' },
  ];

  const handleOpenPhone = (result: any) => {
    const overrideZaloId = result._searchZaloId || undefined;
    const userInfo = {
      display_name: result.display_name || result.zalo_name || result.uid,
      avatar_url: result.avatar || '',
    };
    onSelectConversation(result.uid, 0, overrideZaloId, userInfo);
  };

  /** Mở hội thoại từ kết quả tìm kiếm liên hệ (bao gồm bạn bè chưa có hội thoại) */
  const handleOpenContact = (c: any) => {
    const threadType = c.contact_type === 'group' ? 1 : 0;
    if (c._isFriendOnly) {
      // Friend without conversation → pass userInfo to create contact in store
      const overrideZaloId = (mergedInboxMode && c.owner_zalo_id !== activeAccountId) ? c.owner_zalo_id : undefined;
      const userInfo = {
        display_name: c.display_name || c.contact_id,
        avatar_url: c.avatar_url || '',
      };
      onSelectConversation(c.contact_id, threadType, overrideZaloId, userInfo);
    } else {
      onSelectConversation(c.contact_id, threadType);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* Tab bar */}
      <div className="flex border-b border-gray-700 flex-shrink-0 bg-gray-800/80">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t.label}
            {t.key === 'contacts' && contactResults.length > 0 && (
              <span className="ml-1 text-gray-600 text-[11px]">({contactResults.length})</span>
            )}
            {t.key === 'messages' && msgResults.length > 0 && (
              <span className="ml-1 text-gray-600 text-[11px]">({msgResults.length >= 50 ? '50+' : msgResults.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">

        {/* Searching spinner */}
        {(searching || phoneSearching) && (
          <div className="flex justify-center items-center py-8 text-gray-500">
            <svg className="animate-spin w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <span className="text-sm">Đang tìm kiếm...</span>
          </div>
        )}

        {/* ── Phone number: account picker (merged mode) ── */}
        {isPhone && !phoneSearching && phonePendingAccounts && !phoneResult && (
          <div className="px-3 py-3">
            <p className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              Chọn trang để tìm <span className="text-white font-medium">{query}</span>:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {mergedInboxAccounts.map(zaloId => {
                const acc = allAccounts.find(a => a.zalo_id === zaloId);
                if (!acc) return null;
                return (
                  <button key={zaloId}
                    onClick={() => doPhoneSearch(acc, query)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors">
                    {acc.avatar_url
                      ? <img src={acc.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                      : <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{(acc.full_name || zaloId).charAt(0).toUpperCase()}</div>}
                    <span className="truncate max-w-[90px]">{acc.full_name || acc.phone || zaloId}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Phone result card ── */}
        {isPhone && !phonePendingAccounts && (phoneSearching || phoneResult) && (
          <PhoneResultCard
            result={phoneResult}
            searching={phoneSearching}
            onOpen={() => phoneResult && handleOpenPhone(phoneResult)}
            onAddFriend={() => {/* handled externally if needed */}}
          />
        )}

        {/* ── TAB: Tất cả ── */}
        {tab === 'all' && !searching && !isPhone && (
          <>
            {/* Contacts section */}
            {showContactsSection && (
              <>
                <div className="px-3 pt-3 pb-1.5 flex items-center justify-between">
                  <span className="text-xs text-gray-300 font-semibold">Liên hệ ({contactResults.length})</span>
                </div>
                {contactsForAll.map(c => (
                  <ContactResultItem key={c.contact_id + (c.owner_zalo_id || '')} contact={c} query={query} groupInfoCache={groupInfoCache}
                    onClick={() => handleOpenContact(c)} />
                ))}
                {contactResults.length > ALL_CONTACT_LIMIT && (
                  <button
                    onClick={() => setTab('contacts')}
                    className="w-full py-2.5 text-sm text-gray-300 bg-gray-700/30 hover:bg-gray-700/60 transition-colors text-center border-t border-gray-700/40">
                    Xem tất cả {contactResults.length} liên hệ
                  </button>
                )}
                {showMessagesSection && <div className="border-t border-gray-700/50 mt-1" />}
              </>
            )}

            {/* Messages section */}
            {showMessagesSection && (
              <>
                <div className="px-3 pt-3 pb-1.5 flex items-center justify-between">
                  <span className="text-xs text-gray-300 font-semibold">
                    Tin nhắn ({msgResults.length >= 50 ? '50+' : msgResults.length})
                  </span>
                </div>
                {msgsForAll.map((msg, i) => (
                  <MessageResultItem key={msg.msg_id + i} msg={msg} query={query} contacts={contacts} groupInfoCache={groupInfoCache}
                    onClick={() => onSelectMessage(msg)} />
                ))}
                {msgResults.length > ALL_MESSAGE_LIMIT && (
                  <button
                    onClick={() => setTab('messages')}
                    className="w-full py-2.5 text-sm text-gray-300 bg-gray-700/30 hover:bg-gray-700/60 transition-colors text-center border-t border-gray-700/40">
                    Xem tất cả tin nhắn
                  </button>
                )}
              </>
            )}
          </>
        )}

        {/* ── TAB: Liên hệ (paginated) ── */}
        {tab === 'contacts' && !isPhone && (
          <>
            {contactResults.length === 0 && !searching && query.trim() && (
              <div className="flex flex-col items-center py-16 text-gray-500">
                <p className="text-sm">Không tìm thấy liên hệ nào</p>
              </div>
            )}
            {contactsForTab.map(c => (
              <ContactResultItem key={c.contact_id + (c.owner_zalo_id || '')} contact={c} query={query} groupInfoCache={groupInfoCache}
                onClick={() => handleOpenContact(c)} />
            ))}
            {contactResults.length > contactsPage * PAGE_SIZE && (
              <button onClick={() => setContactsPage(p => p + 1)}
                className="w-full py-3 text-sm text-blue-400 hover:text-blue-300 bg-gray-700/20 hover:bg-gray-700/40 transition-colors text-center border-t border-gray-700/40">
                Tải thêm ({contactResults.length - contactsPage * PAGE_SIZE} còn lại)
              </button>
            )}
          </>
        )}

        {/* ── TAB: Tin nhắn (paginated) ── */}
        {tab === 'messages' && !isPhone && (
          <>
            {searching && (
              <div className="flex justify-center py-8 text-gray-500">
                <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              </div>
            )}
            {!searching && msgResults.length === 0 && query.trim() && (
              <div className="flex flex-col items-center py-16 text-gray-500">
                <p className="text-sm">Không tìm thấy tin nhắn nào</p>
              </div>
            )}
            {msgsForTab.map((msg, i) => (
              <MessageResultItem key={msg.msg_id + i} msg={msg} query={query} contacts={contacts} groupInfoCache={groupInfoCache}
                onClick={() => onSelectMessage(msg)} />
            ))}
            {msgResults.length > messagesPage * PAGE_SIZE && (
              <button onClick={() => setMessagesPage(p => p + 1)}
                className="w-full py-3 text-sm text-blue-400 hover:text-blue-300 bg-gray-700/20 hover:bg-gray-700/40 transition-colors text-center border-t border-gray-700/40">
                Tải thêm ({msgResults.length - messagesPage * PAGE_SIZE} còn lại)
              </button>
            )}
          </>
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-30">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p className="text-sm">Không tìm thấy kết quả</p>
            <p className="text-xs mt-1 opacity-60">"{query}"</p>
          </div>
        )}

        {/* Initial state */}
        {!query.trim() && !searching && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-600">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p className="text-sm">Nhập từ khoá để tìm kiếm</p>
          </div>
        )}
      </div>
    </div>
  );
}

