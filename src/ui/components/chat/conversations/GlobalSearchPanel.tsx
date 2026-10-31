import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc'
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { Button } from '@/components/ui';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { useAppStore } from '@/store/app/appStore';
import GroupAvatar from '../../common/avatars/GroupAvatar';
import AddFriendModal from '../../common/profile/AddFriendModal';
import { channelSupports } from '@/../configs/channels/channelConfig';
import { CHANNEL, isFacebook, isTelegram } from '@/lib/channels/channelHelper';
import { Spinner } from '@/components/common/PageLoading';
import { ChatIcon, CloseIcon} from '@/components/common/icons';
import { lookupZaloUserByPhone } from '@/lib/chat/zalo/zaloPhoneLookup';
import { useHiddenLockedPredicate } from '@/hooks/zalo/useZaloHidden';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import {
  buildSearchIndex, contactSearchFields, filterSearchIndex, foldForSearch, friendSearchFields, matchesSearch,
  MESSAGE_SEARCH_DEBOUNCE_MS, MESSAGE_SEARCH_MIN_LENGTH,
} from '@/lib/chat/conversations/conversationSearch';

// ─── Vietnamese-aware normalization for fuzzy matching ────────────────────────
function normalizeStr(s: string): string {
  return s
    .normalize('NFC')          // unify Unicode representations
    .toLowerCase()
    .replace(/[\u200b-\u200f\uFEFF]/g, '') // strip zero-width chars
    .replace(/\s+/g, ' ')      // normalize all whitespace variants (NBSP U+00A0, etc.) to regular space
    .trim();
}

// So khớp liên hệ / bạn bè (bỏ dấu, cả đ → d, khoá tính sẵn): lib/chat/conversations/conversationSearch.

function isPhoneNumber(s: string): boolean {
  return /^(\+84|0)\d{8,10}$/.test(s.trim().replace(/\s/g, ''));
}

/** Detect Telegram @username pattern: must start with @ followed by valid username (5-32 chars, alphanumeric + underscore) */
function isTelegramUsername(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed.startsWith('@')) return false;
  const username = trimmed.slice(1);
  return /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username);
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
          return `Link: ${url.hostname}`;
        } catch { }
      }
      return 'Link: ';
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
    if (p?.title && (par?.fileSize || par?.fileExt || par?.fileUrl || p?.normalUrl)) return `File: ${p.title}`;
    if (p?.href || p?.thumb || par?.rawUrl || par?.hd) return '[Hình ảnh]';
    // Location check: has latitude/longitude in params
    if (par?.latitude || par?.longitude) return p?.description ? `📍 ${p.description}` : '📍 [Vị trí]';
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
  const [avatarFailed, setAvatarFailed] = useState(false);
  const name = contact.alias || contact.display_name || contact.contact_id;
  const isGroup = contact.contact_type === 'group';
  const zaloId = contact.owner_zalo_id;
  const groupInfo = isGroup && zaloId && groupInfoCache?.[zaloId]?.[contact.contact_id];

  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/60 transition-colors text-left group">
      <div className="flex-shrink-0">
        {isGroup ? (
          <GroupAvatar
            avatarUrl={contact.avatar_url}
            groupInfo={groupInfo}
            name={name}
            id={contact.contact_id}
            size="search"
          />
        ) : (
          contact.avatar_url && !avatarFailed
            ? <img src={contact.avatar_url} alt={name} className="w-11 h-11 rounded-full object-cover" onError={() => {
                setAvatarFailed(true);
                const ownerId = contact.owner_zalo_id;
                if (ownerId && isFacebook(contact.channel)) {
                  ipc.fb.refreshContactAvatar({ accountId: ownerId, userId: contact.contact_id })
                    .then(res => { if (res.success && res.avatarUrl) setAvatarFailed(false); })
                    .catch(() => {});
                } else if (ownerId && isTelegram(contact.channel)) {
                  // Telegram: avatar comes from MTProto, no retry needed
                } else if (ownerId && /^\d+$/.test(ownerId)) {
                  ipc.fb.refreshContactAvatar({ accountId: ownerId, userId: contact.contact_id })
                    .then(res => { if (res.success && res.avatarUrl) setAvatarFailed(false); })
                    .catch(() => {});
                }
              }} />
            : <PeerInitials id={contact.contact_id} name={name} className="w-11 h-11 text-sm" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">{highlightText(name, query)}</p>
        {isGroup && <p className="text-xs text-muted-foreground mt-0.5">Nhóm</p>}
        {contact._isFriendOnly && <p className="text-xs text-green-500 mt-0.5">Bạn bè</p>}
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity"><polyline points="9 18 15 12 9 6"/></svg>
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
  const [avatarFailed, setAvatarFailed] = useState(false);
  const contact = contacts.find(c => c.contact_id === msg.thread_id);
  const convName = contact?.alias || contact?.display_name || msg.thread_id || 'Hội thoại';
  const preview = parsePreview(msg.content);
  const isGroup = contact?.contact_type === 'group';
  const zaloId = msg.owner_zalo_id;
  const groupInfo = isGroup && zaloId && groupInfoCache?.[zaloId]?.[msg.thread_id];

  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/60 transition-colors text-left">
      {isGroup ? (
        <GroupAvatar
          avatarUrl={contact?.avatar_url}
          groupInfo={groupInfo}
          name={convName}
          id={msg.thread_id}
          size="search"
        />
      ) : (
        contact?.avatar_url && !avatarFailed
          ? <img src={contact.avatar_url} alt={convName} className="w-11 h-11 rounded-full object-cover flex-shrink-0" onError={() => {
              setAvatarFailed(true);
              const ownerId = msg.owner_zalo_id;
              if (ownerId) {
                ipc.fb.refreshContactAvatar({ accountId: ownerId, userId: msg.thread_id })
                  .then(res => { if (res.success && res.avatarUrl) setAvatarFailed(false); })
                  .catch(() => {});
              }
            }} />
          : <PeerInitials id={msg.thread_id} name={convName} className="w-11 h-11 text-sm" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-foreground font-medium truncate">{convName}</p>
          <span className="text-xs text-muted-foreground flex-shrink-0">{formatTime(msg.timestamp)}</span>
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          {!!msg.is_sent && <span className="text-muted-foreground">Bạn: </span>}
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
    <div className="mx-3 my-2 p-3 bg-card rounded-xl border border-border text-xs text-muted-foreground flex items-center gap-2">
      <Spinner size={4} />
      Đang tìm kiếm SĐT...
    </div>
  );
  if (!result) return null;
  if (result._notFound) return (
    <div className="mx-3 my-2 p-3 bg-card rounded-xl border border-border text-xs text-muted-foreground">
      Không tìm thấy người dùng hoặc người dùng đã chặn tìm kiếm với người lạ
    </div>
  );
  const name = result.display_name || result.zalo_name || result.uid;
  return (
    <div className="mx-3 my-2 p-3 bg-card rounded-xl border border-border flex items-center gap-3">
      {result.avatar
        ? <img src={result.avatar} alt={name} className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
        : <PeerInitials id={result.uid} name={name} fallback="U" className="w-10 h-10 text-sm" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate font-medium">{name}</p>
        {result.isBlocked === 1 ? <p className="text-xs text-red-400"><CloseIcon className="w-4 h-4 inline" /> Đã chặn</p>
          : result.isFr === 1 ? <p className="text-xs text-green-400">✓ Bạn bè</p>
          : result._sentRequest ? <p className="text-xs text-yellow-400">✓ Đã gửi lời mời</p>
          : <p className="text-xs text-muted-foreground">Chưa kết bạn</p>}
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {result.isBlocked !== 1 && result.isFr !== 1 && !result._sentRequest && (
          <button onClick={onAddFriend} className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-2.5 py-1 rounded-lg transition-colors">+ Kết bạn</button>
        )}
        <button onClick={onOpen} className="bg-muted hover:bg-accent text-foreground text-xs px-2.5 py-1 rounded-lg transition-colors"><ChatIcon className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

// ─── UsernameResultCard ───────────────────────────────────────────────────────
function UsernameResultCard({ result, searching, onOpen }: {
  result: any | null; searching: boolean;
  onOpen: () => void;
}) {
  if (searching) return (
    <div className="mx-3 my-2 p-3 bg-card rounded-xl border border-border text-xs text-muted-foreground flex items-center gap-2">
      <Spinner size={4} />
      Đang tìm @{typeof result === 'string' ? result : '...'}...
    </div>
  );
  if (!result) return null;
  if (result._notFound) return (
    <div className="mx-3 my-2 p-3 bg-card rounded-xl border border-border text-xs text-muted-foreground">
      Không tìm thấy người dùng @{result._query || '...'}
    </div>
  );
  const name = result.displayName || result.username || result.id;
  return (
    <div className="mx-3 my-2 p-3 bg-card rounded-xl border border-cyan-500/30 flex items-center gap-3">
      {result.avatar
        ? <img src={result.avatar} alt={name} className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
        : <PeerInitials id={result.id} name={name} fallback="U" className="w-10 h-10 text-sm" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate font-medium">{name}</p>
        {result.username && <p className="text-xs text-cyan-400">@{result.username}</p>}
        {result.id && <p className="text-[11px] text-subtle-foreground">ID: {result.id}</p>}
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        <button onClick={onOpen} className="bg-cyan-600 hover:bg-cyan-700 text-white-important text-xs px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1">
          <ChatIcon className="w-3.5 h-3.5" /> Nhắn tin
        </button>
      </div>
    </div>
  );
}

// ─── Types & constants ────────────────────────────────────────────────────────
type SearchTab = 'all' | 'contacts' | 'messages';
/** Gõ @username: chờ ngừng gõ chừng này rồi mới hỏi Telegram (resolveUsername bị giới hạn chặt). */
const TELEGRAM_USERNAME_DEBOUNCE_MS = 600;
const ALL_CONTACT_LIMIT = 10;
const ALL_MESSAGE_LIMIT = 20;
const PAGE_SIZE = 20;

/** Kết quả tìm liên hệ phía BOSS (chế độ nhân viên) + tài khoản / từ khoá của nó. */
interface ServerContactResults { accountId: string; query: string; items: any[] }
const NO_SERVER_CONTACTS: ServerContactResults = { accountId: '', query: '', items: [] };

/** Liên hệ khớp từ khoá (bí danh, tên, SĐT, ID) — cùng điều kiện lọc danh sách hội thoại trong bộ nhớ. */
/** Liên hệ có khớp từ khoá đã bỏ dấu (foldForSearch) không — cùng quy tắc với danh sách đã tính sẵn khoá. */
function contactMatchesQuery(c: any, needle: string): boolean {
  return matchesSearch(contactSearchFields(c), needle);
}

/** Báo lỗi tải gọn ngay trong kết quả (chế độ nhân viên: mất kết nối BOSS) — không trông như "Không tìm thấy". */
function LoadFailedRow({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span>{text}</span>
      <Button variant="link" size="sm" className="text-xs" onClick={() => onRetry()}>Thử lại</Button>
    </div>
  );
}

export interface GlobalSearchPanelProps {
  query: string;
  activeAccountId: string | null;
  contacts: any[];
  allAccounts: any[];
  mergedInboxMode: boolean;
  mergedInboxAccounts: string[];
  groupInfoCache?: { [zaloId: string]: { [groupId: string]: any } };
  onSelectConversation: (contactId: string, threadType: number, overrideZaloId?: string, userInfo?: { display_name: string; avatar_url: string; channel?: string }) => void;
  onSelectMessage: (msg: any) => void;
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function GlobalSearchPanel({
  query, activeAccountId, contacts, allAccounts, mergedInboxMode, mergedInboxAccounts,
  groupInfoCache: groupInfoCacheProp, onSelectConversation, onSelectMessage,
}: GlobalSearchPanelProps) {
  // Danh sách hội thoại không còn theo dõi cả cache ảnh nhóm → bảng tìm kiếm (chỉ khi đang mở) tự đọc
  const storeGroupInfoCache = useAppStore(s => s.groupInfoCache);
  const groupInfoCache = groupInfoCacheProp ?? storeGroupInfoCache;
  const [tab, setTab] = useState<SearchTab>('all');
  const [rawMsgResults, setMsgResults] = useState<any[]>([]);
  // Hội thoại ẩn bằng PIN của Zalo (ZL-03) khi tài khoản đang khoá: không lộ trong kết quả tìm
  const isHiddenLocked = useHiddenLockedPredicate();
  const msgResults = useMemo(
    () => rawMsgResults.filter((m: any) => !isHiddenLocked(String(m.owner_zalo_id || activeAccountId || ''), String(m.thread_id || ''))),
    [rawMsgResults, isHiddenLocked, activeAccountId],
  );
  const [searching, setSearching] = useState(false);
  const [contactsPage, setContactsPage] = useState(1);
  const [messagesPage, setMessagesPage] = useState(1);

  // Phone search state
  const [phoneResult, setPhoneResult] = useState<any>(null);
  const [phoneSearching, setPhoneSearching] = useState(false);
  const [phonePendingAccounts, setPhonePendingAccounts] = useState(false); // merged mode: need to pick account

  // Telegram username search state
  const [usernameResult, setUsernameResult] = useState<any>(null);
  const [usernameSearching, setUsernameSearching] = useState(false);
  const [usernamePendingAccounts, setUsernamePendingAccounts] = useState(false);

  // Server-side contact search for employee mode (boss API has full DB). Lỗi → giữ kết quả cũ (lọc theo từ khoá
  // hiện tại), đánh dấu lỗi để hiện "Thử lại".
  const isEmployeeMode = useEmployeeStore(s => s.mode === 'employee');
  const [serverContacts, setServerContacts] = useState<ServerContactResults>(NO_SERVER_CONTACTS);
  const [serverSearchFailed, setServerSearchFailed] = useState(false);
  const contactSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverSearchSeqRef = useRef(0);

  // Add friend modal state
  const [addFriendModal, setAddFriendModal] = useState<{ userId: string; displayName: string; avatar: string } | null>(null);
  const [sendingFriendReq, setSendingFriendReq] = useState(false);

  // Friends list from DB (includes friends without conversations) — theo tài khoản: lần đọc lỗi (chế độ nhân viên)
  // giữ danh sách cũ của đúng tài khoản đó thay vì thành rỗng
  const [friendsByAccount, setFriendsByAccount] = useState<Record<string, any[]>>({});
  const [friendsFailed, setFriendsFailed] = useState<Record<string, boolean>>({});
  const friendAccountIds = useMemo(
    () => (mergedInboxMode && mergedInboxAccounts.length > 0 ? mergedInboxAccounts : (activeAccountId ? [activeAccountId] : [])),
    [mergedInboxMode, mergedInboxAccounts, activeAccountId],
  );
  const friendsList = useMemo(
    () => friendAccountIds.flatMap(id => friendsByAccount[id] || []),
    [friendAccountIds, friendsByAccount],
  );
  const friendsLoadFailed = friendAccountIds.some(id => friendsFailed[id]);

  // Tin nhắn: lỗi tìm ≠ "không có tin nào" (giữ kết quả cũ của cùng từ khoá, hiện "Thử lại")
  const [msgSearchFailed, setMsgSearchFailed] = useState(false);
  const msgSearchSeqRef = useRef(0);
  const msgResultsKeyRef = useRef(''); // tài khoản + từ khoá của msgResults đang hiện

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load friends list from DB ────────────────────────────────────────────────
  const loadFriends = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const results = await Promise.all(ids.map(async zaloId => {
      const res: any = await DataAccessor.getFriends({ zaloId }).catch(() => null);
      return { zaloId, res, failed: !res || isReadFailure(res) };
    }));
    const failedOnes = results.filter(r => r.failed);
    if (failedOnes.length) {
      console.warn('[GlobalSearchPanel] Không tải được danh sách bạn bè:', failedOnes.map(r => `${r.zaloId}: ${readFailureMessage(r.res) || 'lỗi không rõ'}`).join('; '));
    }
    setFriendsByAccount(prev => {
      let next = prev;
      for (const { zaloId, res, failed } of results) {
        if (failed || !Array.isArray(res?.friends)) continue; // lỗi → giữ danh sách cũ của tài khoản này
        if (next === prev) next = { ...prev };
        next[zaloId] = res.friends.map((f: any) => ({ ...f, _ownerZaloId: zaloId }));
      }
      return next;
    });
    setFriendsFailed(prev => {
      let next = prev;
      for (const { zaloId, failed } of results) {
        if (!!prev[zaloId] === failed) continue;
        if (next === prev) next = { ...prev };
        next[zaloId] = failed;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void loadFriends(friendAccountIds);
  }, [friendAccountIds, loadFriends]);

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

  // ── Server-side contact search for employee mode ─────────────────────────────
  // In employee mode, contacts are loaded paginated — local filter misses contacts
  // not yet loaded. Use boss API to search the full DB.
  const runServerContactSearch = useCallback(async (accountId: string, q: string) => {
    const seq = ++serverSearchSeqRef.current;
    const res: any = await DataAccessor.searchConversations(accountId, q).catch(() => null);
    if (seq !== serverSearchSeqRef.current) return; // từ khoá / tài khoản đã đổi trong lúc chờ
    if (!res || isReadFailure(res)) {
      if (res) console.warn('[GlobalSearchPanel] Không tìm được liên hệ phía BOSS:', readFailureMessage(res));
      setServerSearchFailed(true); // giữ kết quả cũ (contactResults lọc lại theo từ khoá hiện tại)
      return;
    }
    setServerContacts({ accountId, query: q, items: Array.isArray(res.items) ? res.items : [] });
    setServerSearchFailed(false);
  }, []);

  useEffect(() => {
    if (contactSearchTimerRef.current) clearTimeout(contactSearchTimerRef.current);
    if (!isEmployeeMode || !query.trim() || !activeAccountId) {
      serverSearchSeqRef.current += 1; // bỏ lần tìm đang chạy
      setServerContacts(NO_SERVER_CONTACTS);
      setServerSearchFailed(false);
      return;
    }
    const accountId = activeAccountId;
    const q = query.trim();
    contactSearchTimerRef.current = setTimeout(() => { void runServerContactSearch(accountId, q); }, 300);
    return () => { if (contactSearchTimerRef.current) clearTimeout(contactSearchTimerRef.current); };
  }, [query, activeAccountId, isEmployeeMode, runServerContactSearch]);

  // ── Contact filtering with Vietnamese normalization ──────────────────────────
  // Khoá tìm kiếm (đã bỏ dấu, cả đ → d) của từng hội thoại / bạn bè tính MỘT lần khi danh sách đổi; mỗi lần gõ chỉ
  // còn includes trên khoá (trước: chuẩn hoá Unicode lại tên + từ khoá cho từng trường của từng liên hệ, mỗi phím).
  // Lọc theo từ khoá "hoãn" (useDeferredValue): ô nhập luôn mượt, danh sách lớn (gộp trang) lọc lại khi rảnh.
  const deferredQuery = useDeferredValue(query);

  // Build a set of contact IDs already in conversations for quick lookup
  const contactIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      set.add(c.contact_id);
    }
    return set;
  }, [contacts]);

  // Tên gợi nhớ và tên đầy đủ là hai trường riêng: "Em yêu" vẫn khớp khi tên gợi nhớ chỉ là "Em"
  const contactIndex = useMemo(() => buildSearchIndex(contacts, contactSearchFields), [contacts]);
  // Bạn bè chưa có hội thoại (đã có thì nằm trong contactIndex)
  const friendIndex = useMemo(
    () => buildSearchIndex(friendsList.filter(f => !contactIdSet.has(f.userId)), friendSearchFields),
    [friendsList, contactIdSet],
  );

  const contactResults = useMemo(() => {
    const needle = foldForSearch(deferredQuery);
    if (!needle) return [];
    // 1. Filter from existing contacts (conversations)
    const fromContacts = filterSearchIndex(contactIndex, needle);

    // 2. Filter from friends list (those NOT already in contacts/conversations)
    const fromFriends = filterSearchIndex(friendIndex, needle)
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

    // 3. Merge server-side results (employee mode) — dedupe by contact_id.
    // Kết quả của từ khoá trước (lần tìm mới đang chờ / vừa lỗi) chỉ giữ những liên hệ vẫn khớp từ khoá hiện tại.
    const seenIds = new Set([...fromContacts.map(c => c.contact_id), ...fromFriends.map(c => c.contact_id)]);
    const serverItems = serverContacts.accountId !== (activeAccountId || '')
      ? []
      : serverContacts.query === deferredQuery.trim()
        ? serverContacts.items
        : serverContacts.items.filter(c => contactMatchesQuery(c, needle));
    const fromServer = serverItems
      .filter(c => c.contact_id && !seenIds.has(c.contact_id))
      .map(c => ({ ...c, _isServerResult: true }));

    return [...fromContacts, ...fromFriends, ...fromServer]
      .filter((c: any) => !isHiddenLocked(String(c.owner_zalo_id || activeAccountId || ''), String(c.contact_id || '')));
  }, [contactIndex, friendIndex, deferredQuery, activeAccountId, serverContacts, isHiddenLocked]);

  // ── Message search (debounced) ───────────────────────────────────────────────
  const runMessageSearch = useCallback(async (accountId: string, q: string) => {
    const seq = ++msgSearchSeqRef.current;
    const key = `${accountId}\u0001${q}`;
    setSearching(true);
    let res: any = null;
    try {
      res = await DataAccessor.searchMessages({ zaloId: accountId, query: q });
    } catch (err) {
      console.warn('[GlobalSearchPanel] message search failed:', err);
    }
    if (seq !== msgSearchSeqRef.current) return; // từ khoá đã đổi: lần tìm mới lo cờ searching
    if (!res || isReadFailure(res)) {
      if (res) console.warn('[GlobalSearchPanel] Không tìm được tin nhắn:', readFailureMessage(res));
      // Lỗi ≠ "không có tin nào": giữ kết quả cũ của cùng từ khoá (thử lại / kết nối lại), khác từ khoá → trống
      if (msgResultsKeyRef.current !== key) {
        msgResultsKeyRef.current = '';
        setMsgResults([]);
      }
      setMsgSearchFailed(true);
    } else {
      const allResults = res?.results || [];
      // Filter to only show searchable messages (text and image+text)
      setMsgResults(allResults.filter((msg: any) => isSearchableMessage(msg.content)));
      msgResultsKeyRef.current = key;
      setMsgSearchFailed(false);
    }
    setSearching(false);
  }, []);

  // Từ khoá quá ngắn (1 chữ cái): chỉ lọc danh bạ, không tìm tin nhắn (khớp gần như mọi tin, chỉ tốn DB)
  const msgQueryTooShort = query.trim().length > 0 && query.trim().length < MESSAGE_SEARCH_MIN_LENGTH;

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const isPhone = isPhoneNumber(query);
    const q = query.trim();
    if (!q || !activeAccountId || isPhone || q.length < MESSAGE_SEARCH_MIN_LENGTH) {
      msgSearchSeqRef.current += 1; // bỏ lần tìm đang chạy
      msgResultsKeyRef.current = '';
      setMsgResults([]); setSearching(false); setMsgSearchFailed(false); return;
    }
    setSearching(true);
    const accountId = activeAccountId;
    timerRef.current = setTimeout(() => { void runMessageSearch(accountId, q); }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, activeAccountId, runMessageSearch]);

  /** Thử lại những nguồn vừa lỗi (bạn bè, tìm liên hệ phía BOSS, tìm tin nhắn) — nút "Thử lại", kết nối lại. */
  const retryFailedSources = (opts: { allFriends?: boolean } = {}) => {
    const tasks: Promise<unknown>[] = [];
    const friendIds = opts.allFriends ? friendAccountIds : friendAccountIds.filter(id => friendsFailed[id]);
    if (friendIds.length) tasks.push(loadFriends(friendIds));
    const q = query.trim();
    if (q && activeAccountId) {
      if (serverSearchFailed && isEmployeeMode) tasks.push(runServerContactSearch(activeAccountId, q));
      if (msgSearchFailed && !isPhoneNumber(query)) tasks.push(runMessageSearch(activeAccountId, q));
    }
    return Promise.allSettled(tasks);
  };

  // Chế độ nhân viên: kết nối BOSS phục hồi → tải lại bạn bè của các tài khoản đang tìm, chạy lại phần tìm vừa lỗi
  useEmployeeResync(() => retryFailedSources({ allFriends: true }));

  // ── Phone number search ──────────────────────────────────────────────────────
  const doPhoneSearch = async (acc: any, phone: string) => {
    if (!channelSupports(acc.channel || CHANNEL.ZALO, 'supportsFriendRequest')) {
      setPhoneResult({ _notFound: true }); setPhoneSearching(false); return;
    }
    setPhoneSearching(true); setPhoneResult(null); setPhonePendingAccounts(false);
    try {
      // Dùng chung lần tìm với ô tìm kiếm của danh sách hội thoại (cùng số) — không gọi findUser của Zalo 2 lần
      setPhoneResult(await lookupZaloUserByPhone(acc, phone));
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

  // ── Telegram username search ─────────────────────────────────────────────────
  // Mỗi lần tìm mang số thứ tự: kết quả của từ khoá cũ về muộn không ghi đè kết quả mới (trước đây hiện nhầm người).
  const usernameSeqRef = useRef(0);
  const doUsernameSearch = async (acc: any, rawQuery: string) => {
    const username = rawQuery.trim().replace(/^@/, '');
    if (!username) return;
    const seq = ++usernameSeqRef.current;
    setUsernameSearching(true);
    setUsernameResult(null);
    setUsernamePendingAccounts(false);
    try {
      const res = await ipc.telegramUser?.resolveUsername({ accountId: acc.zalo_id, username });
      if (seq !== usernameSeqRef.current) return;
      if (res?.success && res.peer) {
        const peer = res.peer;
        const userId = String(peer.peerId || '');
        // Try to get avatar from getUserProfile
        let avatar = '';
        try {
          const profileRes = await ipc.telegramUser?.getUserProfile({ accountId: acc.zalo_id, userId });
          if (profileRes?.success && (profileRes.profile?.avatarUrl || profileRes.profile?.avatar)) {
            avatar = profileRes.profile.avatarUrl || profileRes.profile.avatar;
          }
        } catch {}
        if (seq !== usernameSeqRef.current) return;
        setUsernameResult({
          id: userId,
          displayName: peer.displayName || peer.username || username,
          username: peer.username || username,
          phone: peer.phone || '',
          avatar,
          _searchAccountId: acc.zalo_id,
        });
      } else {
        setUsernameResult({ _notFound: true, _query: username });
      }
    } catch {
      if (seq === usernameSeqRef.current) setUsernameResult({ _notFound: true, _query: username });
    } finally {
      if (seq === usernameSeqRef.current) setUsernameSearching(false);
    }
  };

  useEffect(() => {
    if (!isTelegramUsername(query) || !query.trim()) {
      usernameSeqRef.current += 1; // bỏ lần tìm đang chạy
      setUsernameResult(null);
      setUsernameSearching(false);
      setUsernamePendingAccounts(false);
      return;
    }
    // Only search Telegram accounts
    const telegramAccounts = (mergedInboxMode ? mergedInboxAccounts : [activeAccountId])
      .map(id => allAccounts.find(a => a.zalo_id === id))
      .filter(a => a && isTelegram(a.channel));
    if (telegramAccounts.length === 0) {
      setUsernameResult({ _notFound: true, _query: query.replace(/^@/, '') });
      return;
    }
    if (telegramAccounts.length > 1) {
      setUsernamePendingAccounts(true);
      setUsernameResult(null);
      return;
    }
    // Chờ ngừng gõ: trước đây mỗi phím sau "@abcde" là một lần resolveUsername + getUserProfile lên Telegram
    // (Telegram giới hạn resolveUsername rất chặt → dễ FLOOD_WAIT).
    usernameSeqRef.current += 1;
    setUsernameSearching(true);
    setUsernameResult(null);
    const acc = telegramAccounts[0];
    const timer = setTimeout(() => { void doUsernameSearch(acc, query); }, TELEGRAM_USERNAME_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeAccountId]);

  // ── Derived display data ─────────────────────────────────────────────────────
  const isPhone = isPhoneNumber(query);
  const isUsername = isTelegramUsername(query);
  const showContactsSection = (tab === 'all' || tab === 'contacts') && contactResults.length > 0 && !isPhone && !isUsername;
  const showMessagesSection = (tab === 'all' || tab === 'messages') && msgResults.length > 0 && !isPhone && !isUsername;
  // Nguồn tìm vừa đọc lỗi (chế độ nhân viên: mất kết nối BOSS) → "Không tải được — Thử lại" thay vì "Không tìm thấy"
  const contactSourcesFailed = friendsLoadFailed || serverSearchFailed;
  const anySearchFailed = contactSourcesFailed || msgSearchFailed;
  const failedSearchText = msgSearchFailed && contactSourcesFailed
    ? 'Không tải được kết quả tìm kiếm'
    : msgSearchFailed ? 'Không tải được kết quả tin nhắn' : 'Không tải được đầy đủ danh bạ';
  const retrySearch = () => { void retryFailedSources(); };
  const isEmpty = !searching && !isPhone && !isUsername && !phoneSearching && !usernameSearching && query.trim()
    && contactResults.length === 0 && msgResults.length === 0 && !anySearchFailed;

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

  const handleOpenUsername = (result: any) => {
    const overrideZaloId = result._searchAccountId || undefined;
    const userInfo = {
      display_name: result.displayName || result.username || result.id,
      avatar_url: result.avatar || '',
      channel: 'telegram_user',
    };
    onSelectConversation(String(result.id), 0, overrideZaloId, userInfo);
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
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Tab bar */}
      <div className="flex border-b border-border flex-shrink-0 bg-card/80">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-2.5 text-xs font-medium border-b-2 transition-colors ${tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-muted-foreground hover:text-foreground/80'}`}>
            {t.label}
            {t.key === 'contacts' && contactResults.length > 0 && (
              <span className="ml-1 text-muted-foreground text-[11px]">({contactResults.length})</span>
            )}
            {t.key === 'messages' && msgResults.length > 0 && (
              <span className="ml-1 text-muted-foreground text-[11px]">({msgResults.length >= 50 ? '50+' : msgResults.length})</span>
            )}
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">

        {/* Searching spinner */}
        {(searching || phoneSearching) && (
          <div className="flex justify-center items-center py-8 text-muted-foreground">
            <Spinner size={5} className="mr-2" />
            <span className="text-sm">Đang tìm kiếm...</span>
          </div>
        )}

        {/* ── Phone number: account picker (merged mode) ── */}
        {isPhone && !phoneSearching && phonePendingAccounts && !phoneResult && (
          <div className="px-3 py-3">
            <p className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              Chọn trang để tìm <span className="text-foreground font-medium">{query}</span>:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {mergedInboxAccounts.map(zaloId => {
                const acc = allAccounts.find(a => a.zalo_id === zaloId);
                if (!acc) return null;
                return (
                  <button key={zaloId}
                    onClick={() => doPhoneSearch(acc, query)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted hover:bg-accent text-xs text-foreground transition-colors">
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
            onAddFriend={() => {
              if (phoneResult && !phoneResult._notFound) {
                setAddFriendModal({
                  userId: phoneResult.uid,
                  displayName: phoneResult.display_name || phoneResult.zalo_name || phoneResult.uid,
                  avatar: phoneResult.avatar || '',
                });
              }
            }}
          />
        )}

        {/* ── Telegram username: account picker (merged mode) ── */}
        {isUsername && !usernameSearching && usernamePendingAccounts && !usernameResult && (
          <div className="px-3 py-3">
            <p className="text-xs text-yellow-400 mb-2 flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              Chọn tài khoản Telegram để tìm <span className="text-foreground font-medium">{query}</span>:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {mergedInboxAccounts
                .map(id => allAccounts.find(a => a.zalo_id === id))
                .filter(a => a && isTelegram(a.channel))
                .map(acc => acc!)  // TypeScript narrowing
                .map(acc => (
                  <button key={acc.zalo_id}
                    onClick={() => doUsernameSearch(acc, query)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted hover:bg-accent text-xs text-foreground transition-colors">
                    {acc.avatar_url
                      ? <img src={acc.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                      : <div className="w-5 h-5 rounded-full bg-cyan-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}</div>}
                    <span className="truncate max-w-[90px]">{acc.full_name || acc.zalo_id}</span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* ── Username result card ── */}
        {isUsername && !usernamePendingAccounts && (usernameSearching || usernameResult) && (
          <UsernameResultCard
            result={usernameResult}
            searching={usernameSearching}
            onOpen={() => usernameResult && !usernameResult._notFound && handleOpenUsername(usernameResult)}
          />
        )}

        {/* ── TAB: Tất cả ── */}
        {tab === 'all' && !searching && !isPhone && !isUsername && (
          <>
            {query.trim() && anySearchFailed && <LoadFailedRow text={failedSearchText} onRetry={retrySearch} />}
            {/* Contacts section */}
            {showContactsSection && (
              <>
                <div className="px-3 pt-3 pb-1.5 flex items-center justify-between">
                  <span className="text-xs text-foreground/80 font-semibold">Liên hệ ({contactResults.length})</span>
                </div>
                {contactsForAll.map(c => (
                  <ContactResultItem key={c.contact_id + (c.owner_zalo_id || '')} contact={c} query={query} groupInfoCache={groupInfoCache}
                    onClick={() => handleOpenContact(c)} />
                ))}
                {contactResults.length > ALL_CONTACT_LIMIT && (
                  <button
                    onClick={() => setTab('contacts')}
                    className="w-full py-2.5 text-sm text-foreground/80 bg-muted/30 hover:bg-muted/60 transition-colors text-center border-t border-border/40">
                    Xem tất cả {contactResults.length} liên hệ
                  </button>
                )}
                {showMessagesSection && <div className="border-t border-border/50 mt-1" />}
              </>
            )}

            {/* Messages section */}
            {showMessagesSection && (
              <>
                <div className="px-3 pt-3 pb-1.5 flex items-center justify-between">
                  <span className="text-xs text-foreground/80 font-semibold">
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
                    className="w-full py-2.5 text-sm text-foreground/80 bg-muted/30 hover:bg-muted/60 transition-colors text-center border-t border-border/40">
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
            {query.trim() && contactSourcesFailed && (
              <LoadFailedRow text="Không tải được đầy đủ danh bạ" onRetry={retrySearch} />
            )}
            {contactResults.length === 0 && !searching && query.trim() && !contactSourcesFailed && (
              <div className="flex flex-col items-center py-16 text-muted-foreground">
                <p className="text-sm">Không tìm thấy liên hệ nào</p>
              </div>
            )}
            {contactsForTab.map(c => (
              <ContactResultItem key={c.contact_id + (c.owner_zalo_id || '')} contact={c} query={query} groupInfoCache={groupInfoCache}
                onClick={() => handleOpenContact(c)} />
            ))}
            {contactResults.length > contactsPage * PAGE_SIZE && (
              <button onClick={() => setContactsPage(p => p + 1)}
                className="w-full py-3 text-sm text-blue-400 hover:text-blue-300 bg-muted/20 hover:bg-muted/40 transition-colors text-center border-t border-border/40">
                Tải thêm ({contactResults.length - contactsPage * PAGE_SIZE} còn lại)
              </button>
            )}
          </>
        )}

        {/* ── TAB: Tin nhắn (paginated) ── */}
        {tab === 'messages' && !isPhone && (
          <>
            {searching && (
              <div className="flex justify-center py-8 text-muted-foreground">
                <Spinner size={5} />
              </div>
            )}
            {!searching && query.trim() && msgSearchFailed && (
              <LoadFailedRow text="Không tải được kết quả tin nhắn" onRetry={retrySearch} />
            )}
            {!searching && msgResults.length === 0 && query.trim() && !msgSearchFailed && (
              <div className="flex flex-col items-center py-16 text-muted-foreground">
                <p className="text-sm">{msgQueryTooShort ? 'Gõ thêm để tìm trong tin nhắn' : 'Không tìm thấy tin nhắn nào'}</p>
              </div>
            )}
            {msgsForTab.map((msg, i) => (
              <MessageResultItem key={msg.msg_id + i} msg={msg} query={query} contacts={contacts} groupInfoCache={groupInfoCache}
                onClick={() => onSelectMessage(msg)} />
            ))}
            {msgResults.length > messagesPage * PAGE_SIZE && (
              <button onClick={() => setMessagesPage(p => p + 1)}
                className="w-full py-3 text-sm text-blue-400 hover:text-blue-300 bg-muted/20 hover:bg-muted/40 transition-colors text-center border-t border-border/40">
                Tải thêm ({msgResults.length - messagesPage * PAGE_SIZE} còn lại)
              </button>
            )}
          </>
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-30">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p className="text-sm">Không tìm thấy kết quả</p>
            <p className="text-xs mt-1 opacity-60">"{query}"</p>
          </div>
        )}

        {/* Initial state */}
        {!query.trim() && !searching && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p className="text-sm">Nhập từ khoá để tìm kiếm</p>
          </div>
        )}
      </div>

      {/* Add-friend compose modal */}
      {addFriendModal && (
        <AddFriendModal
          displayName={addFriendModal.displayName}
          avatar={addFriendModal.avatar}
          sending={sendingFriendReq}
          onConfirm={async (msg) => {
            const targetZaloId = phoneResult?._searchZaloId || activeAccountId;
            const acc = allAccounts.find(a => a.zalo_id === targetZaloId);
            if (!acc) return;
            setSendingFriendReq(true);
            try {
              await ipc.zalo?.sendFriendRequest({
                auth: buildZaloAuth(acc, targetZaloId),
                userId: addFriendModal.userId,
                msg,
              });
              setPhoneResult((p: any) => p?.uid === addFriendModal.userId ? { ...p, _sentRequest: true } : p);
              setAddFriendModal(null);
            } catch (err: any) {
              alert('Gửi lời mời thất bại: ' + (err?.message || err));
            } finally {
              setSendingFriendReq(false);
            }
          }}
          onClose={() => !sendingFriendReq && setAddFriendModal(null)}
        />
      )}
    </div>
  );
}

