/**
 * QuickChatModal - Popup soạn tin nhắn nhanh
 * Luôn hiển thị trang chi tiết (không có trang danh sách riêng).
 * Tính năng: tìm người nhận inline, chọn tài khoản gửi (avatar+tên+SĐT), lịch sử chat, tin nhắn nhanh.
 *
 * Mọi kênh (Zalo, Telegram, Facebook): gửi qua quickChatSend + MessageQueue như ô soạn tin của khung chat; tin của hội
 * thoại đọc từ bộ nhớ chung nên tin mới về hiện ngay trong popup. Trước đây chỉ gọi ipc.zalo: tài khoản kênh khác gửi lỗi
 * im lặng, popup không thấy tin trả lời.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore, QuickChatTarget } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { getMessageCacheKey, useChatStore, MessageItem } from '@/store/chat/chatStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { MessageCircleIcon } from '@/components/common/icons';
import DataAccessor from '@/lib/data/DataAccessor';;
import { liveReadSync } from '@/lib/chat/read/liveReadSync';
import { messageQueue, generateTempId, type SendResult } from '@/lib/chat/send/MessageQueue';
import { openConversation } from '@/lib/chat/conversations/openConversation';
import {
  fetchQuickChatHistory, recipientLookupKind, sendQuickFile, sendQuickImages, sendQuickText, sendQuickVideo, type QuickSendTarget,
} from '@/lib/chat/send/quickChatSend';
import { queueBadgeRefresh } from '@/lib/notifications/badgeUtils';
import { getCapability, getChannelLabel } from '../../../../configs/channels/channelConfig';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { fetchQuickMessages, QuickMessage, LocalMediaFile } from '../composer/QuickMessageManager';
import { formatPhone } from '@/lib/contacts/phoneUtils';
import ChatHistoryList from '../messages/ChatHistoryList';
import SharedMessageContent from '../messages/SharedMessageContent';
import { EMOJI_CATEGORIES, QUICK_EMOJIS } from '@/lib/chat/messages/emojiUtils';
import { CHANNEL, isZalo } from '@/lib/channels/channelHelper';
import PeerInitials from '@/components/common/avatars/PeerInitials';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff === 0) return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'Hôm qua';
  if (diff < 7) return d.toLocaleDateString('vi-VN', { weekday: 'short' });
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

// ── Sử dụng MessageBubble chung thay vì duplicate code ────────────────────────
// Đã chuyển sang sử dụng MessageBubble component từ MessageBubbles.tsx
// để tránh phải sửa 2 chỗ khi có thay đổi

// ── Removed: MsgBubble function (đã thay bằng MessageBubble component chung) ──
// function MsgBubble() { ... }  → xóa 280+ dòng duplicate code

// ── Placeholder for removed code (Contact card
// ── Removed: MsgBubble function (đã thay bằng MessageBubble component chung) ──
// function MsgBubble() { ... }  → xóa 280+ dòng duplicate code

// ── Account Selector ──────────────────────────────────────────────────────────
function AccountSelector({ accounts, selectedId, onSelect }: {
  accounts: any[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sel = accounts.find(a => a.zalo_id === selectedId);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const info = (a: any) => ({
    name: a.display_name || a.full_name || a.zalo_id,
    // Tài khoản mọi kênh: ghi rõ kênh (cùng một tên có thể có cả Zalo lẫn Telegram)
    sub: [getChannelLabel((a.channel || CHANNEL.ZALO) as any), a.phone || a.zalo_id].filter(Boolean).join(' · '),
  });

  // Single account → just show label, no dropdown
  if (accounts.length <= 1 && sel) {
    const { name, sub } = info(sel);
    return (
      <div className="flex items-center gap-1.5 min-w-0 max-w-[160px] flex-shrink-0">
        {sel.avatar_url
          ? <img src={sel.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0"/>
          : <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{name.charAt(0)}</div>}
        <span className="text-xs text-muted-foreground truncate">{name}{sub && sub !== name ? ` · ${sub}` : ''}</span>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-colors max-w-[175px] ${open ? 'border-blue-500 bg-muted' : 'border-input hover:border-border-strong bg-card'}`}
        title="Chọn tài khoản gửi">
        {sel ? (
          <>
            {sel.avatar_url
              ? <img src={sel.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0"/>
              : <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{info(sel).name.charAt(0)}</div>}
            <span className="text-foreground/80 truncate max-w-[100px]">{info(sel).name}</span>
          </>
        ) : <span className="text-muted-foreground">Chọn TK</span>}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
          className={`flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 bg-card border border-input rounded-xl shadow-2xl z-[200] min-w-[220px] py-1 overflow-hidden">
          <p className="text-[11px] text-muted-foreground px-3 pt-2 pb-1.5 font-semibold uppercase tracking-wide">Gửi từ tài khoản</p>
          {accounts.map(a => {
            const { name, sub } = info(a);
            return (
              <button key={a.zalo_id} onClick={() => { onSelect(a.zalo_id); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted transition-colors text-left ${selectedId === a.zalo_id ? 'bg-muted/50' : ''}`}>
                <div className="relative flex-shrink-0">
                  {a.avatar_url
                    ? <img src={a.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover"/>
                    : <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold">{name.charAt(0)}</div>}
                  <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-border ${a.isConnected ? 'bg-green-400' : 'bg-accent'}`}/>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground font-medium truncate">{name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{sub}</p>
                </div>
                {selectedId === a.zalo_id && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400 flex-shrink-0">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Quick Messages Picker ─────────────────────────────────────────────────────
function QuickMsgPicker({ getAuth, accountId, channel, onSelect, onClose }: {
  getAuth: () => any; accountId: string; channel: string; onSelect: (item: QuickMessage) => void; onClose: () => void;
}) {
  const [items, setItems] = useState<QuickMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [onClose]);

  useEffect(() => {
    // Như ô soạn tin: kênh chỉ có tin nhắn nhanh trên máy (Telegram, Facebook) luôn đọc bản trên máy
    const localOnly = getCapability((channel || CHANNEL.ZALO) as any)?.quickMessageSyncMode === 'local';
    const mode = localOnly ? 'local' : ((localStorage.getItem(`qm_mode_${accountId}`) as 'zalo'|'local') || CHANNEL.ZALO);
    const auth = getAuth();
    if (!auth && mode !== 'local') { setLoading(false); return; }
    fetchQuickMessages(auth, accountId, mode).then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, [accountId, channel]);

  const filtered = filter.trim()
    ? items.filter(i => i.keyword.toLowerCase().includes(filter.toLowerCase()) || i.message.title.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => {
        const fl = filter.toLowerCase().trim();
        const aKw = a.keyword.toLowerCase();
        const bKw = b.keyword.toLowerCase();
        // Priority: keyword starts with filter > keyword contains filter > title contains filter
        const aStarts = aKw.startsWith(fl) ? 0 : 1;
        const bStarts = bKw.startsWith(fl) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        const aKwInc = aKw.includes(fl) ? 0 : 1;
        const bKwInc = bKw.includes(fl) ? 0 : 1;
        if (aKwInc !== bKwInc) return aKwInc - bKwInc;
        return 0;
      })
    : items;

  return (
    <div ref={ref}
      className="absolute bottom-full left-0 mb-2 bg-card border border-input rounded-xl shadow-2xl z-[200] w-72 flex flex-col overflow-hidden"
      style={{ maxHeight: '16.25rem' }}
      onClick={e => e.stopPropagation()}>
      <div className="px-3 pt-2.5 pb-2 border-b border-border flex-shrink-0">
        <p className="text-[11px] text-yellow-400 font-semibold uppercase tracking-wide mb-1.5 flex items-center gap-1">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Tin nhắn nhanh
        </p>
        <input autoFocus value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Tìm theo từ khoá..." onKeyDown={e => { if(e.key==='Escape') onClose(); }}
          className="w-full bg-muted border border-input rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500"/>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading && <div className="flex justify-center py-5"><div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/></div>}
        {!loading && filtered.length === 0 && <p className="text-xs text-muted-foreground text-center py-5">Không có tin nhắn nhanh</p>}
        {filtered.map(item => {
          const hasLocalMedia = item._localMedia && item._localMedia.length > 0;
          const imgCount = hasLocalMedia ? item._localMedia!.filter(f => f.type === 'image').length : (item.media?.items?.length ?? 0);
          const vidCount = hasLocalMedia ? item._localMedia!.filter(f => f.type === 'video').length : 0;
          return (
            <button key={item.id} onClick={() => { onSelect(item); onClose(); }}
              className="w-full flex flex-col px-3 py-2 hover:bg-muted text-left transition-colors gap-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-blue-400 font-mono bg-blue-500/10 px-1.5 py-0.5 rounded flex-shrink-0">/{item.keyword}</span>
                {imgCount > 0 && <span className="text-[11px] text-muted-foreground">🖼 {imgCount} ảnh</span>}
                {vidCount > 0 && <span className="text-[11px] text-muted-foreground">🎬 {vidCount} video</span>}
              </div>
              <p className="text-xs text-foreground/80 line-clamp-2 leading-snug">{item.message.title}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Recipient Typeahead Row ───────────────────────────────────────────────────
const EMPTY_RESULTS: any[] = [];

function RecipientRow({ zaloId, channel, contacts, accounts, onSelect }: {
  zaloId: string | null; channel: string; contacts: any[]; accounts: any[]; onSelect: (c: any) => void;
}) {
  const [query, setQuery] = useState('');
  const [dbResults, setDbResults] = useState<any[]>([]);
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 60); }, []);

  // Liên hệ đã nạp trong máy: hiện ngay khi gõ
  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EMPTY_RESULTS;
    return contacts.filter(c => {
      const n = (c.alias||c.display_name||'').toLowerCase();
      const p = (c.phone||'').toLowerCase();
      return n.includes(q) || p.includes(q) || c.contact_id.includes(q);
    }).slice(0, 20);
  }, [query, contacts]);

  // DB + nền tảng: chỉ theo chữ đang gõ (danh bạ đổi liên tục lúc tin về không làm hoãn mãi lần tìm)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setDbResults([]); setLookupResult(null); setSearching(false); return; }

    let cancelled = false;
    const timer = setTimeout(() => {
      if (!zaloId) return;
      // Mọi liên hệ của tài khoản trong DB, gõ không dấu cũng ra (danh sách hội thoại chỉ nạp vài trang đầu)
      DataAccessor.searchContactsForPicker({ zaloId, search: trimmed, type: 'all', limit: 20 }).then((res) => {
        if (cancelled || !res?.success) return;
        setDbResults(res.items.map((item) => ({
          contact_id: item.id, display_name: item.name, avatar_url: item.avatar || '', phone: item.phone || '',
          contact_type: item.type,
        })));
      }).catch(() => {});
      // Tìm trên nền tảng: Zalo theo số điện thoại, Telegram theo @username
      const kind = recipientLookupKind(channel, trimmed);
      if (!kind) { setLookupResult(null); setSearching(false); return; }
      setSearching(true);
      const lookup = kind === 'zalo_phone'
        ? (async () => {
          const acc = accounts.find(a => a.zalo_id === zaloId);
          if (!acc) return null;
          const res: any = await ipc.zalo?.findUser({ auth: buildZaloAuth(acc, zaloId), phone: trimmed });
          const p = res?.response?.info || res?.response;
          return p?.userId
            ? { contact_id: p.userId, display_name: p.displayName||p.zaloName||trimmed, avatar_url: p.avatar||'', phone: trimmed, contact_type: 'user' }
            : null;
        })()
        : (async () => {
          const res: any = await ipc.telegramUser?.resolveUsername({ accountId: zaloId, username: trimmed });
          const peer = res?.success ? res.peer : null;
          return peer?.peerId
            ? {
              contact_id: String(peer.peerId), display_name: peer.displayName || trimmed, avatar_url: '', phone: peer.phone || '',
              contact_type: peer.peerType === 'user' ? 'user' : 'group',
            }
            : null;
        })();
      lookup
        .then((found) => { if (!cancelled) setLookupResult(found); })
        .catch(() => { if (!cancelled) setLookupResult(null); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, zaloId, channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const seen = new Set<string>();
  const all = [...(lookupResult ? [lookupResult] : []), ...results, ...dbResults]
    .filter((c) => {
      const id = String(c?.contact_id || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 25);

  return (
    <div className="relative border-b border-border bg-card flex-shrink-0">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-xs text-muted-foreground font-semibold flex-shrink-0">Đến:</span>
        <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder={isZalo(channel) ? 'Nhập tên, số điện thoại, UID…' : channel === CHANNEL.TELEGRAM_USER ? 'Nhập tên, @username, ID…' : 'Nhập tên, ID…'}
          className="flex-1 bg-transparent text-sm text-foreground placeholder-subtle-foreground focus:outline-none min-w-0"/>
        {searching && <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0"/>}
        {query && <button onClick={() => setQuery('')} className="text-muted-foreground hover:text-foreground/80 flex-shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>}
      </div>
      {all.length > 0 && (
        <div className="absolute top-full left-0 right-0 bg-card border-x border-b border-input rounded-b-xl shadow-2xl z-[200] max-h-52 overflow-y-auto">
          {all.map(c => (
            <button key={c.contact_id} onClick={() => { onSelect(c); setQuery(''); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted text-left transition-colors">
              {c.avatar_url
                ? <img src={c.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0"/>
                : <PeerInitials id={c.contact_id} name={c.alias || c.display_name} className="w-8 h-8 text-xs" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{c.alias||c.display_name||c.contact_id}</p>
                <p className="text-[11px] text-muted-foreground truncate">{c.contact_type==='group'?'Nhóm':(c.phone||c.contact_id)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main QuickChatModal ───────────────────────────────────────────────────────
const EMPTY_LIST: any[] = [];
/** Số tin mới nhất đọc khi mở một hội thoại trong popup. */
const QUICK_CHAT_PAGE = 40;
/** Popup chỉ vẽ ngần này tin mới nhất (khung chat có thể đã tải nhiều hơn cho cùng hội thoại). */
const QUICK_CHAT_SHOWN = 80;

export default function QuickChatModal() {
  // Selector từng phần: popup luôn gắn trong App, không vẽ lại theo mọi thay đổi của store
  const quickChatOpen = useAppStore((s) => s.quickChatOpen);
  const quickChatTarget = useAppStore((s) => s.quickChatTarget);
  const quickChatZaloId = useAppStore((s) => s.quickChatZaloId);
  const closeQuickChat = useAppStore((s) => s.closeQuickChat);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const addMessage = useChatStore((s) => s.addMessage);
  const markReplied = useChatStore((s) => s.markReplied);

  // ── Resolved zaloId (selected account) ──────────────────────────────────
  const [selectedZaloId, setSelectedZaloId] = useState<string | null>(null);

  // ── Target contact ───────────────────────────────────────────────────────
  const [target, setTarget] = useState<QuickChatTarget | null>(null);

  // ── Messages: bộ nhớ chung của hội thoại → tin mới về, tin đang gửi, tin thật thay tin tạm đều hiện như khung chat ──
  const threadKey = target && selectedZaloId ? getMessageCacheKey(selectedZaloId, target.userId) : '';
  const threadMsgs: MessageItem[] = useChatStore((s) => (threadKey ? s.messages[threadKey] : undefined)) ?? EMPTY_LIST;
  const localMsgs = threadMsgs.length > QUICK_CHAT_SHOWN ? threadMsgs.slice(-QUICK_CHAT_SHOWN) : threadMsgs;
  const [msgsLoading, setMsgsLoading] = useState(false);
  const allContacts: any[] = useChatStore((s) => (selectedZaloId ? s.contacts[selectedZaloId] : undefined)) ?? EMPTY_LIST;
  const channel = String(accounts.find(a => a.zalo_id === selectedZaloId)?.channel || CHANNEL.ZALO);

  // ── Composer state ───────────────────────────────────────────────────────
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showQM, setShowQM] = useState(false);
  const [clipImgs, setClipImgs] = useState<Array<{ id: string; dataUrl: string; blob: Blob }>>([]);
  const [pendingQMMedia, setPendingQMMedia] = useState<{ imagePaths: string[]; videoPaths: string[] } | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const editorRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const justSentRef = useRef(false);

  // ── Init when modal opens ────────────────────────────────────────────────
  useEffect(() => {
    if (!quickChatOpen) return;

    // Resolve account
    const zid = quickChatZaloId || activeAccountId;
    setSelectedZaloId(zid);

    // Resolve target
    setTarget(quickChatTarget ?? null);
    setText(''); setClipImgs([]); setPendingQMMedia(null); setShowEmoji(false); setShowQM(false);
    if (quickChatTarget && zid) loadMessages(zid, quickChatTarget.userId, quickChatTarget.threadType);
    // Mở lại với người nhận khác (nút "Nhắn tin" của hồ sơ khi popup đang mở) cũng khởi tạo lại
  }, [quickChatOpen, quickChatTarget, quickChatZaloId]);

  // ── Load messages for selected thread ───────────────────────────────────
  const loadMessages = useCallback(async (zaloId: string, threadId: string, threadType: number) => {
    const accountChannel = String(useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId)?.channel || CHANNEL.ZALO);
    const key = getMessageCacheKey(zaloId, threadId);
    setMsgsLoading(true);
    try {
      const res: any = await DataAccessor.getMessages({ zaloId, threadId, limit: QUICK_CHAT_PAGE, offset: 0 });
      let rows: any[] = res?.messages || res?.items || [];
      // Máy chưa có tin (người vừa mở từ hồ sơ, tìm theo @username): lịch sử từ Telegram / Facebook như khung chat
      if (!rows.length && !(useChatStore.getState().messages[key] || []).length) {
        rows = await fetchQuickChatHistory(zaloId, threadId, accountChannel, QUICK_CHAT_PAGE);
      }
      // Gộp vào bộ nhớ, không thay: khung chat có thể đang mở hội thoại này với nhiều tin hơn
      if (rows.length) useChatStore.getState().prependMessages(zaloId, threadId, [...rows].reverse());
      // Mở hội thoại = đã đọc, như bấm trong danh sách (Zalo "đã xem", Telegram / Facebook đã đọc)
      useChatStore.getState().clearUnread(zaloId, threadId);
      DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
      queueBadgeRefresh((count) => ipc.app?.setBadge(count));
      void liveReadSync.syncOpenedThread({ accountId: zaloId, threadId, threadType: threadType === 1 ? 1 : 0 }, rows);
    } catch { /* không đọc được thì để trống: gửi tin đầu tiên vẫn được */ } finally { setMsgsLoading(false); }
  }, []);

  // ── Hội thoại đang hiện trong popup: tin mới của nó coi như đang xem (useZaloEvents, liveReadSync) ───────────────
  useEffect(() => {
    const setThread = useAppStore.getState().setQuickChatThread;
    if (quickChatOpen && target && selectedZaloId) {
      setThread({ zaloId: selectedZaloId, threadId: target.userId, threadType: target.threadType });
    } else {
      setThread(null);
    }
  }, [quickChatOpen, target, selectedZaloId]);
  useEffect(() => () => useAppStore.getState().setQuickChatThread(null), []);

  // ── Scroll to bottom when messages change ────────────────────────────────
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'instant' }); }, [localMsgs.length]);

  // ── Auto-focus editor when target is set ─────────────────────────────────
  useEffect(() => {
    if (target && editorRef.current) {
      setTimeout(() => editorRef.current?.focus(), 100);
    }
  }, [target]);

  // ── Paste images ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!quickChatOpen) return;
    const h = (e: ClipboardEvent) => {
      if (!target) return;
      const imgs = Array.from(e.clipboardData?.items||[]).filter(i=>i.type.startsWith('image/'));
      if (!imgs.length) return;
      e.preventDefault();
      imgs.forEach(item => {
        const blob = item.getAsFile(); if (!blob) return;
        const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const reader = new FileReader();
        reader.onload = ev => setClipImgs(p => [...p, { id, dataUrl: ev.target?.result as string, blob }]);
        reader.readAsDataURL(blob);
      });
    };
    window.addEventListener('paste', h);
    return () => window.removeEventListener('paste', h);
  }, [quickChatOpen, target]);

  // ── Close emoji on outside click ──────────────────────────────────────────
  useEffect(() => {
    if (!showEmoji) return;
    const h = (e: MouseEvent) => { if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) setShowEmoji(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showEmoji]);

  // ── ESC ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!quickChatOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeQuickChat(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [quickChatOpen, closeQuickChat]);

  const getPlainText = (el: HTMLElement): string => {
    let r = '';
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) { r += n.textContent||''; return; }
      if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = (n as HTMLElement).tagName.toLowerCase();
        if (tag === 'br') { r += '\n'; return; }
        n.childNodes.forEach(walk);
        if ((tag==='div'||tag==='p') && r && !r.endsWith('\n')) r += '\n';
      }
    };
    el.childNodes.forEach(walk);
    return r.replace(/\n$/,'');
  };

  const getAuth = () => {
    const acc = accounts.find(a => a.zalo_id === selectedZaloId);
    return acc ? buildZaloAuth(acc, selectedZaloId) : null;
  };

  const insertText = (txt: string) => {
    const el = editorRef.current; if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(txt);
      range.insertNode(node); range.setStartAfter(node); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    } else { el.textContent = (el.textContent||'') + txt; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ── Send message ─────────────────────────────────────────────────────────
  /** Người nhận + tài khoản gửi cho quickChatSend (Zalo kèm cookie của tài khoản). */
  const sendTargetOf = (): QuickSendTarget | null => {
    if (!target || !selectedZaloId) return null;
    return {
      accountId: selectedZaloId, channel, threadId: target.userId, threadType: target.threadType,
      auth: isZalo(channel) ? getAuth() : undefined,
    };
  };

  /**
   * Như ô soạn tin của khung chat: tin tạm `temp_…` hiện ngay (cả trong khung chat), MessageQueue gửi + thử lại, báo lỗi
   * trên bong bóng, tin thật về thì thay tin tạm. Trước đây tin tạm `qc_…` không bao giờ được thay → hiện 2 lần.
   */
  const enqueueSend = (sendTo: QuickSendTarget, temp: Partial<MessageItem>, send: () => Promise<SendResult>, imageCount = 0) => {
    const tempId = generateTempId();
    addMessage(sendTo.accountId, sendTo.threadId, {
      msg_id: tempId, temp_id: tempId, owner_zalo_id: sendTo.accountId, thread_id: sendTo.threadId,
      thread_type: sendTo.threadType, sender_id: sendTo.accountId, content: '', msg_type: 'text',
      timestamp: Date.now(), is_sent: 1, status: 'sending', send_status: 'pending', channel: sendTo.channel as any,
      ...temp,
    } as MessageItem);
    messageQueue.enqueue({
      tempId, zaloId: sendTo.accountId, threadId: sendTo.threadId, threadType: sendTo.threadType,
      channel: sendTo.channel as any, sendFn: send,
      onSuccess: () => {
        markReplied(sendTo.accountId, sendTo.threadId);
        // Ảnh: giữ ảnh tạm tới khi ảnh thật về
        if (imageCount > 0) {
          messageQueue.registerImageBatch(tempId, sendTo.accountId, sendTo.threadId, imageCount,
            () => useChatStore.getState().removeMessage(sendTo.accountId, sendTo.threadId, tempId));
        }
      },
    });
  };

  const enqueueImages = (sendTo: QuickSendTarget, paths: string[]) => {
    if (!paths.length) return;
    enqueueSend(sendTo, {
      msg_type: 'image', media_type: 'image', send_status: 'sending',
      attachments: JSON.stringify(paths.map(fp => ({ type: 'image', localPath: fp }))),
      local_paths: JSON.stringify(Object.fromEntries(paths.map((fp, i) => [`img${i}`, fp]))),
    } as Partial<MessageItem>, () => sendQuickImages(sendTo, paths), paths.length);
  };

  const enqueueFile = (sendTo: QuickSendTarget, filePath: string) => {
    const name = filePath.split(/[\\/]/).pop() || 'Tệp';
    enqueueSend(sendTo, {
      content: `📎 ${name}`, msg_type: 'file', media_type: 'file',
      attachments: JSON.stringify([{ type: 'file', localPath: filePath, name }]),
    } as Partial<MessageItem>, () => sendQuickFile(sendTo, filePath));
  };

  const handleSend = async () => {
    const sendTo = sendTargetOf();
    if (!sendTo || sending) return;
    const msgText = editorRef.current ? getPlainText(editorRef.current).replace(/\u200B/g,'').trim() : text.trim();
    if (!msgText && !clipImgs.length && !pendingQMMedia) return;
    setSending(true);
    justSentRef.current = true;
    // Delay clear to let IME compositionEnd finalize on macOS
    setTimeout(() => {
      if (editorRef.current) editorRef.current.innerHTML = '';
      setText('');
      setTimeout(() => { justSentRef.current = false; }, 50);
    }, 0);
    try {
      // ── Media của tin nhắn nhanh (ảnh + video) ────
      if (pendingQMMedia) {
        const { imagePaths, videoPaths } = pendingQMMedia;
        setPendingQMMedia(null);
        enqueueImages(sendTo, imagePaths);
        for (const videoPath of videoPaths) {
          enqueueSend(sendTo, {
            content: '🎬 Video', msg_type: 'video', media_type: 'video', local_paths: JSON.stringify({ main: videoPath }),
          } as Partial<MessageItem>, () => sendQuickVideo(sendTo, videoPath));
        }
      }

      // ── Ảnh dán từ clipboard ─────────────────────────────────────────
      if (clipImgs.length) {
        const images = clipImgs;
        setClipImgs([]);
        const paths: string[] = [];
        for (const img of images) {
          const ext = img.blob.type.split('/')[1]||'png';
          const r = await ipc.file?.saveTempBlob({ base64: img.dataUrl, ext });
          if (r?.success && r.filePath) paths.push(r.filePath);
        }
        enqueueImages(sendTo, paths);
      }

      if (msgText) {
        enqueueSend(sendTo, { content: msgText, msg_type: 'text', media_type: 'text' } as Partial<MessageItem>,
          () => sendQuickText(sendTo, msgText));
      }
    } catch (e) { console.error('[QuickChat]', e); }
    finally { setSending(false); setTimeout(() => editorRef.current?.focus(), 40); }
  };

  // ── Mở hội thoại đầy đủ: như bấm trong danh sách hội thoại (đổi tài khoản, tải tin, đã đọc) ──────────────────
  const handleGoToConversation = () => {
    if (!target || !selectedZaloId) return;
    const request = {
      accountId: selectedZaloId, threadId: target.userId, threadType: (target.threadType === 1 ? 1 : 0) as 0 | 1,
      info: { display_name: target.displayName || undefined, avatar_url: target.avatarUrl || undefined },
    };
    closeQuickChat();
    openConversation(request);
  };

  if (!quickChatOpen) return null;

  const selfId = selectedZaloId;
  /** Đổi tài khoản gửi: cùng kênh thì giữ người nhận (gửi từ tài khoản khác), khác kênh thì mã người nhận vô nghĩa. */
  const switchAccount = (id: string) => {
    const nextChannel = String(accounts.find(a => a.zalo_id === id)?.channel || CHANNEL.ZALO);
    setSelectedZaloId(id);
    if (!target) return;
    if (nextChannel !== channel) { setTarget(null); return; }
    void loadMessages(id, target.userId, target.threadType);
  };

  const getSenderName = (sid: string) => {
    if (sid === selfId) return '';
    const c = allContacts.find(x => x.contact_id === sid);
    if (c) return c.alias||c.display_name||sid;
    if (target?.threadType === 1 && selectedZaloId) {
      const g = useAppStore.getState().groupInfoCache?.[selectedZaloId]?.[target.userId];
      const m = g?.members?.find((x: any) => x.userId === sid);
      if (m) return m.displayName||sid;
    }
    return sid;
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={closeQuickChat}>
      <div
        className="bg-popover border border-border rounded-2xl shadow-2xl flex flex-col overflow-visible"
        style={{ width: '38.75rem', height: '42.5rem', maxWidth: '95vw', maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border flex-shrink-0 rounded-t-2xl bg-card">
          {/* Chat icon */}
          <div className="w-7 h-7 rounded-lg bg-blue-600 text-white flex items-center justify-center flex-shrink-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>

          {/* Target info OR title */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {target ? (
              <>
                {target.avatarUrl
                  ? <img src={target.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0"/>
                  : <PeerInitials id={target.userId} name={target.displayName} className="w-7 h-7 text-[10px]" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate leading-tight">{target.displayName}</p>
                  {(() => {
                    const phone = target.phone || allContacts.find(c => c.contact_id === target.userId)?.phone || '';
                    return phone ? <p className="text-[11px] text-muted-foreground leading-none truncate mt-0.5">{formatPhone(phone)}</p> : null;
                  })()}
                </div>
                <button onClick={() => setTarget(null)}
                  className="text-[11px] text-muted-foreground hover:text-foreground/80 px-1.5 py-0.5 rounded hover:bg-muted transition-colors flex-shrink-0 whitespace-nowrap">
                  đổi
                </button>
              </>
            ) : (
              <span className="text-sm font-semibold text-foreground/80">Nhắn tin nhanh</span>
            )}
          </div>

          {/* Account selector */}
          <AccountSelector accounts={accounts} selectedId={selectedZaloId} onSelect={switchAccount} />

          {/* Go to full conversation */}
          {target && (
            <button onClick={handleGoToConversation} title="Mở hội thoại đầy đủ"
              className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-blue-400 hover:bg-muted transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
          )}

          {/* Close */}
          <button onClick={closeQuickChat}
            className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Đóng (Esc)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── Recipient row (no target) ──────────────────────────────── */}
        {!target && (
          <RecipientRow zaloId={selectedZaloId} channel={channel} contacts={allContacts} accounts={accounts} onSelect={async c => {
            const t: QuickChatTarget = { userId: c.contact_id, displayName: c.alias||c.display_name||c.contact_id, avatarUrl: c.avatar_url||'', threadType: c.contact_type==='group'?1:0, phone: c.phone||'' };
            setTarget(t);
            if (selectedZaloId) await loadMessages(selectedZaloId, t.userId, t.threadType);
            setTimeout(() => editorRef.current?.focus(), 80);
          }}/>
        )}

        {/* ── Messages area ────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {msgsLoading && localMsgs.length === 0 && <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/></div>}

          {!target && !msgsLoading && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mb-2 opacity-20">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <p className="text-sm">Nhập người nhận ở trên để bắt đầu</p>
            </div>
          )}

          {target && !msgsLoading && localMsgs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <MessageCircleIcon className="w-8 h-8 mb-2 opacity-40" />
              <p className="text-sm">Chưa có tin nhắn</p>
              <p className="text-xs mt-1 text-muted-foreground">Gửi tin nhắn đầu tiên cho {target.displayName}</p>
            </div>
          )}

          <ChatHistoryList
            items={localMsgs}
            bottomRef={bottomRef}
            renderItem={(msg, idx) => {
              // Facebook: mã tài khoản trong app khác mã người gửi → dựa vào is_sent
              const isSelf = msg.is_sent === 1 || msg.sender_id === selfId;
              const showTime = idx === 0 || (msg.timestamp - localMsgs[idx - 1].timestamp > 5 * 60 * 1000);
              return (
                <div key={msg.msg_id}>
                  {showTime && <div className="text-center text-[11px] text-muted-foreground py-1">{fmtTime(msg.timestamp)}</div>}
                  <SharedMessageContent
                    msg={msg}
                    isSelf={isSelf}
                    senderName={!isSelf && target?.threadType === 1 ? getSenderName(msg.sender_id) : undefined}
                  />
                </div>
              );
            }}
          />
        </div>

        {/* ── Pending QM media preview ─────────────────────────────── */}
        {pendingQMMedia && (pendingQMMedia.imagePaths.length > 0 || pendingQMMedia.videoPaths.length > 0) && (
          <div className="flex gap-2 px-3 py-1.5 border-t border-border bg-yellow-500/5 flex-shrink-0 flex-wrap items-center">
            <span className="text-[11px] text-yellow-400 flex-shrink-0 flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Kèm:
            </span>
            {pendingQMMedia.imagePaths.map((fp, i) => (
              <div key={`qm_img_${i}`} className="relative">
                <img src={toLocalMediaUrl(fp)} alt="" className="w-11 h-11 object-cover rounded-lg border border-yellow-600/40"/>
              </div>
            ))}
            {pendingQMMedia.videoPaths.map((fp, i) => (
              <div key={`qm_vid_${i}`} className="relative w-11 h-11 bg-muted rounded-lg border border-yellow-600/40 flex items-center justify-center flex-shrink-0">
                <span className="text-lg">🎬</span>
              </div>
            ))}
            <button onClick={() => setPendingQMMedia(null)}
              className="ml-auto text-[11px] text-muted-foreground hover:text-red-400 transition-colors px-1">✕</button>
          </div>
        )}

        {/* ── Clipboard image previews ──────────────────────────────── */}
        {clipImgs.length > 0 && (
          <div className="flex gap-2 px-3 py-1.5 border-t border-border bg-card/40 flex-shrink-0 flex-wrap">
            {clipImgs.map(img => (
              <div key={img.id} className="relative">
                <img src={img.dataUrl} alt="" className="w-11 h-11 object-cover rounded-lg border border-input"/>
                <button onClick={() => setClipImgs(p => p.filter(i => i.id !== img.id))}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-white text-[9px] hover:bg-red-400">✕</button>
              </div>
            ))}
          </div>
        )}

        {/* ── Composer ─────────────────────────────────────────────────── */}
        <div className="border-t border-border bg-card flex-shrink-0 rounded-b-2xl">
          {/* Action toolbar row */}
          {target && (
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
              <div className="flex items-center gap-1">
                {/* Image */}
                <button onClick={async () => {
                  const sendTo = sendTargetOf(); if (!sendTo) return;
                  const r = await ipc.file?.openDialog({ filters:[{name:'Images',extensions:['jpg','jpeg','png','gif','webp']}], multiSelect:true });
                  if (r?.canceled||!r?.filePaths?.length) return;
                  enqueueImages(sendTo, r.filePaths as string[]);
                }} title="Gửi ảnh"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                </button>
                {/* File */}
                <button onClick={async () => {
                  const sendTo = sendTargetOf(); if (!sendTo) return;
                  const r = await ipc.file?.openDialog({ filters:[{name:'All Files',extensions:['*']}] });
                  if (r?.canceled||!r?.filePaths?.length) return;
                  enqueueFile(sendTo, String(r.filePaths[0]));
                }} title="Gửi file"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                {/* Quick messages ⚡ */}
                <div className="relative">
                  <button onClick={() => setShowQM(v=>!v)}
                    title="Tin nhắn nhanh"
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showQM?'bg-yellow-500/20 text-yellow-400':'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                    </svg>
                  </button>
                  {showQM && selectedZaloId && (
                    <QuickMsgPicker
                      getAuth={getAuth} accountId={selectedZaloId} channel={channel}
                      onSelect={item => {
                        // Luôn đưa text vào editor để có thể sửa trước khi gửi
                        if (item.message.title) {
                          insertText(item.message.title);
                        }
                        // Lưu media (nếu có) để gửi khi user bấm nút Gửi
                        const localMedia: LocalMediaFile[] = item._localMedia || [];
                        const imgPaths = localMedia.filter(f => f.type === 'image').map(f => f.path);
                        const vidPaths = localMedia.filter(f => f.type === 'video').map(f => f.path);
                        if (imgPaths.length > 0 || vidPaths.length > 0) {
                          setPendingQMMedia({ imagePaths: imgPaths, videoPaths: vidPaths });
                        }
                        setTimeout(() => editorRef.current?.focus(), 0);
                      }}
                      onClose={() => setShowQM(false)}
                    />
                  )}
                </div>
                {/* Emoji */}
                <div className="relative" ref={emojiRef}>
                  <button onMouseDown={e => { e.preventDefault(); setShowEmoji(v=>!v); }}
                    title="Emoji"
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-lg transition-colors ${showEmoji?'bg-blue-600':'hover:bg-muted'}`}>😊</button>
                  {showEmoji && (
                    <div className="absolute bottom-10 left-0 bg-card border border-input rounded-2xl shadow-2xl z-50 w-72 overflow-hidden">
                      <div className="max-h-64 overflow-y-auto p-2 space-y-2.5">
                        {Object.entries(EMOJI_CATEGORIES).map(([category, emojis]) => (
                          <div key={category}>
                            <p className="text-[10px] text-muted-foreground font-medium mb-1 px-1">{category}</p>
                            <div className="grid grid-cols-8 gap-0.5">
                              {emojis.map((em, idx) => (
                                <button key={`${category}-${em}-${idx}`} onMouseDown={e => { e.preventDefault(); insertText(em); setShowEmoji(false); }}
                                  className="text-lg hover:bg-muted rounded-lg p-0.5 transition-colors aspect-square flex items-center justify-center hover:scale-110">{em}</button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Text input row */}
          <div className="flex items-end gap-2 px-3 py-2.5">
            {/* Editor */}
            <div className="flex-1 relative min-w-0">
              <div ref={editorRef}
                contentEditable={!!target}
                suppressContentEditableWarning
                onInput={e => { if (!justSentRef.current) setText(getPlainText(e.currentTarget).replace(/\u200B/g,'')); }}
                onKeyDown={e => { if(e.key==='Enter'&&!e.shiftKey){ if(e.nativeEvent.isComposing||isComposingRef.current) return; e.preventDefault(); handleSend(); } }}
                onCompositionStart={() => { isComposingRef.current = true; }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                  if (justSentRef.current && editorRef.current) {
                    editorRef.current.innerHTML = '';
                    setText('');
                  }
                }}
                data-placeholder={target ? 'Nhập tin nhắn… (Enter gửi)' : 'Chọn người nhận trước…'}
                className={`min-h-[40px] max-h-[120px] overflow-y-auto bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-blue-500 transition-colors leading-relaxed empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none ${!target?'opacity-40 cursor-not-allowed':''}`}
              />
            </div>

            {/* Send / Like */}
            {text.trim() || clipImgs.length > 0 || pendingQMMedia ? (
              <button onClick={handleSend} disabled={sending||!target} title="Gửi (Enter)"
                className="w-9 h-9 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center text-white transition-colors flex-shrink-0">
                {sending
                  ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"/>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>}
              </button>
            ) : (
              <button disabled={!target} title="Gửi 👍"
                onClick={() => {
                  const sendTo = sendTargetOf(); if (!sendTo) return;
                  enqueueSend(sendTo, { content: '👍', msg_type: 'text', media_type: 'text' } as Partial<MessageItem>,
                    () => sendQuickText(sendTo, '👍'));
                }}
                className="w-9 h-9 rounded-lg hover:bg-muted flex items-center justify-center text-blue-400 hover:text-blue-300 disabled:opacity-30 transition-colors text-xl flex-shrink-0">👍</button>
            )}
          </div>

          <div className="text-[11px] text-muted-foreground px-3 py-1">
            Shift+Enter xuống dòng · Ctrl + Shift + N mở tính năng nhanh
          </div>
        </div>
      </div>
    </div>
  );
}
