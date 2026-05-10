/**
 * QuickChatModal — Popup soạn tin nhắn nhanh
 * Luôn hiển thị trang chi tiết (không có trang danh sách riêng).
 * Tính năng: tìm người nhận inline, chọn tài khoản gửi (avatar+tên+SĐT), lịch sử chat, tin nhắn nhanh.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore, QuickChatTarget } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useChatStore, MessageItem } from '@/store/chatStore';
import ipc from '@/lib/ipc';
import { sendSeenForThread } from '@/lib/sendSeenHelper';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { fetchQuickMessages, QuickMessage, LocalMediaFile } from './QuickMessageManager';
import { formatPhone } from '@/utils/phoneUtils';
import ChatHistoryList from './ChatHistoryList';
import SharedMessageContent from './SharedMessageContent';

// ── Constants ────────────────────────────────────────────────────────────────
const EMOJI_CATEGORIES = {
  'Phổ biến': ['😊', '😂', '❤️', '👍', '😮', '😢', '😡', '🔥', '👋', '🙏', '✌️', '😍', '😎', '🥰', '😜', '🤩', '😭', '🤗', '😇', '🤔', '😤', '🥳', '💪', '✅', '🎉', '💯', '🚀', '⭐', '🌈', '💙'],
  'Cảm xúc': ['😀', '😃', '😄', '😁', '😆', '🥹', '😅', '🤣', '🥲', '☺️', '😋', '😛', '😝', '🤑', '🤭', '🤫', '🤐', '🤨', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '🙂', '😌', '😔', '😪', '🤤', '😴'],
  'Trái tim': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '❤️‍🔥', '❤️‍🩹', '💑', '💏', '🫂', '💋', '🫶', '🤲', '🙌', '👏', '🤝'],
  'Tay & Cử chỉ': ['👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '💪', '🦾', '🙏', '✍️', '🤳', '💅', '🤌', '👌', '🫰'],
  'Biểu tượng': ['✨', '⚡', '🌟', '💫', '💥', '💢', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️', '🗯️', '💭', '💤', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🔶', '🔷', '🔸', '🔹', '▶️', '⏩'],
};
const QUICK_EMOJIS = Object.values(EMOJI_CATEGORIES).flat();

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
    sub: a.phone || a.zalo_id,
  });

  // Single account → just show label, no dropdown
  if (accounts.length <= 1 && sel) {
    const { name, sub } = info(sel);
    return (
      <div className="flex items-center gap-1.5 min-w-0 max-w-[160px] flex-shrink-0">
        {sel.avatar_url
          ? <img src={sel.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0"/>
          : <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{name.charAt(0)}</div>}
        <span className="text-xs text-gray-400 truncate">{name}{sub && sub !== name ? ` · ${sub}` : ''}</span>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-colors max-w-[175px] ${open ? 'border-blue-500 bg-gray-700' : 'border-gray-600 hover:border-gray-500 bg-gray-800'}`}
        title="Chọn tài khoản gửi">
        {sel ? (
          <>
            {sel.avatar_url
              ? <img src={sel.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0"/>
              : <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{info(sel).name.charAt(0)}</div>}
            <span className="text-gray-300 truncate max-w-[100px]">{info(sel).name}</span>
          </>
        ) : <span className="text-gray-500">Chọn TK</span>}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
          className={`flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-[200] min-w-[220px] py-1 overflow-hidden">
          <p className="text-[11px] text-gray-500 px-3 pt-2 pb-1.5 font-semibold uppercase tracking-wide">Gửi từ tài khoản</p>
          {accounts.map(a => {
            const { name, sub } = info(a);
            return (
              <button key={a.zalo_id} onClick={() => { onSelect(a.zalo_id); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-700 transition-colors text-left ${selectedId === a.zalo_id ? 'bg-gray-700/50' : ''}`}>
                <div className="relative flex-shrink-0">
                  {a.avatar_url
                    ? <img src={a.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover"/>
                    : <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold">{name.charAt(0)}</div>}
                  <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-gray-800 ${a.isConnected ? 'bg-green-400' : 'bg-gray-500'}`}/>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 font-medium truncate">{name}</p>
                  <p className="text-[11px] text-gray-500 truncate">{sub}</p>
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
function QuickMsgPicker({ getAuth, accountId, onSelect, onClose }: {
  getAuth: () => any; accountId: string; onSelect: (item: QuickMessage) => void; onClose: () => void;
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
    const auth = getAuth();
    if (!auth) { setLoading(false); return; }
    const mode = (localStorage.getItem(`qm_mode_${accountId}`) as 'zalo'|'local') || 'zalo';
    fetchQuickMessages(auth, accountId, mode).then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  }, [accountId]);

  const filtered = filter.trim()
    ? items.filter(i => i.keyword.toLowerCase().includes(filter.toLowerCase()) || i.message.title.toLowerCase().includes(filter.toLowerCase()))
    : items;

  return (
    <div ref={ref}
      className="absolute bottom-full left-0 mb-2 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-[200] w-72 flex flex-col overflow-hidden"
      style={{ maxHeight: 260 }}
      onClick={e => e.stopPropagation()}>
      <div className="px-3 pt-2.5 pb-2 border-b border-gray-700 flex-shrink-0">
        <p className="text-[11px] text-yellow-400 font-semibold uppercase tracking-wide mb-1.5 flex items-center gap-1">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Tin nhắn nhanh
        </p>
        <input autoFocus value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Tìm theo từ khoá..." onKeyDown={e => { if(e.key==='Escape') onClose(); }}
          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"/>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading && <div className="flex justify-center py-5"><div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/></div>}
        {!loading && filtered.length === 0 && <p className="text-xs text-gray-500 text-center py-5">Không có tin nhắn nhanh</p>}
        {filtered.map(item => {
          const hasLocalMedia = item._localMedia && item._localMedia.length > 0;
          const imgCount = hasLocalMedia ? item._localMedia!.filter(f => f.type === 'image').length : (item.media?.items?.length ?? 0);
          const vidCount = hasLocalMedia ? item._localMedia!.filter(f => f.type === 'video').length : 0;
          return (
            <button key={item.id} onClick={() => { onSelect(item); onClose(); }}
              className="w-full flex flex-col px-3 py-2 hover:bg-gray-700 text-left transition-colors gap-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-blue-400 font-mono bg-blue-500/10 px-1.5 py-0.5 rounded flex-shrink-0">/{item.keyword}</span>
                {imgCount > 0 && <span className="text-[11px] text-gray-400">🖼 {imgCount} ảnh</span>}
                {vidCount > 0 && <span className="text-[11px] text-gray-400">🎬 {vidCount} video</span>}
              </div>
              <p className="text-xs text-gray-300 line-clamp-2 leading-snug">{item.message.title}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Recipient Typeahead Row ───────────────────────────────────────────────────
function RecipientRow({ zaloId, contacts, accounts, onSelect }: {
  zaloId: string | null; contacts: any[]; accounts: any[]; onSelect: (c: any) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [phoneResult, setPhoneResult] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 60); }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); setPhoneResult(null); return; }
    const q = query.toLowerCase();
    setResults(contacts.filter(c => {
      const n = (c.alias||c.display_name||'').toLowerCase();
      const p = (c.phone||'').toLowerCase();
      return n.includes(q) || p.includes(q) || c.contact_id.includes(q);
    }).slice(0, 20));

    if (/^(\+84|0)\d{8,10}$/.test(query.trim().replace(/\s/g,''))) {
      const acc = accounts.find(a => a.zalo_id === zaloId);
      if (!acc) return;
      setSearching(true);
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
      ipc.zalo?.findUser({ auth, phone: query.trim() }).then((res: any) => {
        const p = res?.response?.info || res?.response;
        if (p?.userId) setPhoneResult({ contact_id: p.userId, display_name: p.displayName||p.zaloName||query.trim(), avatar_url: p.avatar||'', phone: query.trim(), contact_type: 'user', unread_count: 0 });
      }).catch(()=>{}).finally(()=>setSearching(false));
    } else { setPhoneResult(null); }
  }, [query, contacts, zaloId]);

  const all = [
    ...(phoneResult && !results.find(c => c.contact_id === phoneResult.contact_id) ? [phoneResult] : []),
    ...results,
  ];

  return (
    <div className="relative border-b border-gray-700 bg-gray-900 flex-shrink-0">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-xs text-gray-500 font-semibold flex-shrink-0">Đến:</span>
        <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Nhập tên, số điện thoại, UID…"
          className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none min-w-0"/>
        {searching && <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0"/>}
        {query && <button onClick={() => setQuery('')} className="text-gray-500 hover:text-gray-300 flex-shrink-0">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>}
      </div>
      {all.length > 0 && (
        <div className="absolute top-full left-0 right-0 bg-gray-800 border-x border-b border-gray-600 rounded-b-xl shadow-2xl z-[200] max-h-52 overflow-y-auto">
          {all.map(c => (
            <button key={c.contact_id} onClick={() => { onSelect(c); setQuery(''); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-700 text-left transition-colors">
              {c.avatar_url
                ? <img src={c.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0"/>
                : <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${c.contact_type==='group'?'bg-purple-600':'bg-blue-600'}`}>{(c.alias||c.display_name||'?').charAt(0).toUpperCase()}</div>}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-100 truncate">{c.alias||c.display_name||c.contact_id}</p>
                <p className="text-[11px] text-gray-500 truncate">{c.contact_type==='group'?'Nhóm':(c.phone||c.contact_id)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main QuickChatModal ───────────────────────────────────────────────────────
export default function QuickChatModal() {
  const { quickChatOpen, quickChatTarget, quickChatZaloId, closeQuickChat } = useAppStore();
  const { accounts, activeAccountId } = useAccountStore();
  const { contacts, addMessage, markReplied } = useChatStore();

  // ── Resolved zaloId (selected account) ──────────────────────────────────
  const [selectedZaloId, setSelectedZaloId] = useState<string | null>(null);

  // ── Target contact ───────────────────────────────────────────────────────
  const [target, setTarget] = useState<QuickChatTarget | null>(null);

  // ── Messages state ───────────────────────────────────────────────────────
  const [localMsgs, setLocalMsgs] = useState<MessageItem[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);

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
    setLocalMsgs([]); setText(''); setClipImgs([]); setPendingQMMedia(null); setShowEmoji(false); setShowQM(false);
    if (quickChatTarget && zid) loadMessages(zid, quickChatTarget.userId);
  }, [quickChatOpen]);

  // ── Load messages for selected thread ───────────────────────────────────
  const loadMessages = useCallback(async (zaloId: string, threadId: string) => {
    setMsgsLoading(true);
    try {
      const res = await ipc.db?.getMessages({ zaloId, threadId, limit: 40, offset: 0 });
      setLocalMsgs([...(res?.messages || [])].reverse());
    } catch { setLocalMsgs([]); } finally { setMsgsLoading(false); }
  }, []);

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
    return acc ? { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent } : null;
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
  const handleSend = async () => {
    const auth = getAuth();
    if (!auth || !target || !selectedZaloId || sending) return;
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
      // ── Handle pending QM media (images + videos từ tin nhắn nhanh) ────
      if (pendingQMMedia) {
        const { imagePaths, videoPaths } = pendingQMMedia;

        if (imagePaths.length > 0) {
          const tempImgMsgs: MessageItem[] = imagePaths.map((fp, i) => ({
            msg_id: `qc_qm_img_${Date.now()}_${i}`,
            owner_zalo_id: selectedZaloId!,
            thread_id: target.userId,
            thread_type: target.threadType,
            sender_id: selectedZaloId!,
            content: JSON.stringify({ href: toLocalMediaUrl(fp) }),
            msg_type: 'photo',
            timestamp: Date.now() + i,
            is_sent: 1,
            status: 'sending',
            local_paths: JSON.stringify(Object.fromEntries(imagePaths.map((p, i) => [`img_${i}`, p]))),
          }));
          setLocalMsgs(p => [...p, ...tempImgMsgs]);
          await ipc.zalo?.sendImages({ auth, threadId: target.userId, type: target.threadType, filePaths: imagePaths });
        }

        for (let vi = 0; vi < videoPaths.length; vi++) {
          const vp = videoPaths[vi];
          try {
            setLocalMsgs(p => [...p, {
              msg_id: `qc_qm_vid_${Date.now()}_${vi}`,
              owner_zalo_id: selectedZaloId!,
              thread_id: target.userId,
              thread_type: target.threadType,
              sender_id: selectedZaloId!,
              content: JSON.stringify({ href: toLocalMediaUrl(vp) }),
              msg_type: 'chat.video.msg',
              timestamp: Date.now(),
              is_sent: 1,
              status: 'sending',
              local_paths: JSON.stringify({ main: vp }),
            }]);
            const metaRes = await ipc.file?.getVideoMeta?.({ filePath: vp });
            const duration: number = metaRes?.duration || 0;
            const width: number = metaRes?.width || 0;
            const height: number = metaRes?.height || 0;
            let thumbPath: string = metaRes?.thumbPath || '';
            if (!thumbPath) {
              const thumbRes = await ipc.file?.saveTempBlob?.({ base64: '', ext: 'jpg' });
              thumbPath = thumbRes?.filePath || '';
            }
            let thumbUrl = '';
            if (thumbPath) {
              const uploadThumb = await ipc.zalo?.uploadVideoThumb?.({ auth, thumbPath, threadId: target.userId, type: target.threadType });
              thumbUrl = uploadThumb?.response?.normalUrl || uploadThumb?.response?.hdUrl || '';
            }
            const uploadRes = await ipc.zalo?.uploadVideoFile?.({ auth, videoPath: vp, threadId: target.userId, type: target.threadType });
            const videoUrl: string = uploadRes?.response?.fileUrl || '';
            if (videoUrl) {
              await ipc.zalo?.sendVideo({
                auth,
                options: { videoUrl, thumbnailUrl: thumbUrl || videoUrl, duration: duration ? duration * 1000 : undefined, width: width || undefined, height: height || undefined },
                threadId: target.userId,
                type: target.threadType,
              });
            }
          } catch (e: any) { console.error('[QuickChat] send video failed', e); }
        }

        setPendingQMMedia(null);
      }

      // ── Handle clipboard images ─────────────────────────────────────────
      if (clipImgs.length) {
        const paths: string[] = [];
        const tempImgMsgs: MessageItem[] = clipImgs.map((img, i) => ({
          msg_id: `qc_img_${Date.now()}_${i}`,
          owner_zalo_id: selectedZaloId!,
          thread_id: target.userId,
          thread_type: target.threadType,
          sender_id: selectedZaloId!,
          content: JSON.stringify({ href: img.dataUrl }),
          msg_type: 'photo',
          timestamp: Date.now() + i,
          is_sent: 1,
          status: 'sending',
        }));
        setLocalMsgs(p => [...p, ...tempImgMsgs]);
        for (const img of clipImgs) {
          const ext = img.blob.type.split('/')[1]||'png';
          const r = await ipc.file?.saveTempBlob({ base64: img.dataUrl, ext });
          if (r?.success && r.filePath) paths.push(r.filePath);
        }
        if (paths.length) await ipc.zalo?.sendImages({ auth, threadId: target.userId, type: target.threadType, filePaths: paths });
        setClipImgs([]);
      }

      if (msgText) {
        const temp: MessageItem = {
          msg_id: `qc_${Date.now()}`, owner_zalo_id: selectedZaloId, thread_id: target.userId,
          thread_type: target.threadType, sender_id: selectedZaloId, content: msgText,
          msg_type: 'text', timestamp: Date.now(), is_sent: 1, status: 'sending',
        };
        setLocalMsgs(p => [...p, temp]);
        addMessage(selectedZaloId, target.userId, temp);
        markReplied(selectedZaloId, target.userId);
        await ipc.zalo?.sendMessage({ auth, threadId: target.userId, type: target.threadType, message: msgText });
      }
    } catch (e) { console.error('[QuickChat]', e); }
    finally { setSending(false); setTimeout(() => editorRef.current?.focus(), 40); }
  };

  // ── Go to full conversation (fixed) ──────────────────────────────────────
  const handleGoToConversation = () => {
    if (!target || !selectedZaloId) return;
    const zid = selectedZaloId;
    const tid = target.userId;
    const ttype = target.threadType;
    closeQuickChat();
    // All Zustand calls are synchronous; defer thread switch by 1 tick so React
    // re-renders after account switch before we try to display the thread.
    const { setActiveAccount } = useAccountStore.getState();
    const { setView } = useAppStore.getState();
    setActiveAccount(zid);
    setView('chat');
    setTimeout(() => {
      const { setActiveThread, setMessages: storeSet, clearUnread } = useChatStore.getState();
      setActiveThread(tid, ttype);
      clearUnread(zid, tid);
      ipc.db?.markAsRead({ zaloId: zid, contactId: tid }).catch(() => {});
      sendSeenForThread(zid, tid, ttype);
      ipc.db?.getMessages({ zaloId: zid, threadId: tid, limit: 50, offset: 0 }).then((res: any) => {
        const msgs: MessageItem[] = res?.messages || [];
        if (msgs.length) storeSet(zid, tid, [...msgs].reverse());
      }).catch(() => {});
    }, 16);
  };

  if (!quickChatOpen) return null;

  const allContacts = selectedZaloId ? (contacts[selectedZaloId]||[]) : [];
  const selfId = selectedZaloId;

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
        className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl flex flex-col overflow-visible"
        style={{ width: 620, height: 680, maxWidth: '95vw', maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-700 flex-shrink-0 rounded-t-2xl bg-gray-900/95">
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
                  : <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-xs flex-shrink-0 ${target.threadType===1?'bg-purple-600':'bg-blue-600'}`}>{target.displayName.charAt(0).toUpperCase()}</div>}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-100 truncate leading-tight">{target.displayName}</p>
                  {(() => {
                    const phone = target.phone || allContacts.find(c => c.contact_id === target.userId)?.phone || '';
                    return phone ? <p className="text-[11px] text-gray-500 leading-none truncate mt-0.5">{formatPhone(phone)}</p> : null;
                  })()}
                </div>
                <button onClick={() => { setTarget(null); setLocalMsgs([]); }}
                  className="text-[11px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded hover:bg-gray-700 transition-colors flex-shrink-0 whitespace-nowrap">
                  đổi
                </button>
              </>
            ) : (
              <span className="text-sm font-semibold text-gray-300">Nhắn tin nhanh</span>
            )}
          </div>

          {/* Account selector */}
          <AccountSelector accounts={accounts} selectedId={selectedZaloId} onSelect={id => { setSelectedZaloId(id); if (target) loadMessages(id, target.userId); }} />

          {/* Go to full conversation */}
          {target && (
            <button onClick={handleGoToConversation} title="Mở hội thoại đầy đủ"
              className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-gray-700 transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
          )}

          {/* Close */}
          <button onClick={closeQuickChat}
            className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            title="Đóng (Esc)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── Recipient row (no target) ──────────────────────────────── */}
        {!target && (
          <RecipientRow zaloId={selectedZaloId} contacts={allContacts} accounts={accounts} onSelect={async c => {
            const t: QuickChatTarget = { userId: c.contact_id, displayName: c.alias||c.display_name||c.contact_id, avatarUrl: c.avatar_url||'', threadType: c.contact_type==='group'?1:0, phone: c.phone||'' };
            setTarget(t);
            if (selectedZaloId) await loadMessages(selectedZaloId, t.userId);
            setTimeout(() => editorRef.current?.focus(), 80);
          }}/>
        )}

        {/* ── Messages area ────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {msgsLoading && <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/></div>}

          {!target && !msgsLoading && (
            <div className="flex flex-col items-center justify-center h-full text-gray-600">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mb-2 opacity-20">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <p className="text-sm">Nhập người nhận ở trên để bắt đầu</p>
            </div>
          )}

          {target && !msgsLoading && localMsgs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <div className="text-3xl mb-2">💬</div>
              <p className="text-sm">Chưa có tin nhắn</p>
              <p className="text-xs mt-1 text-gray-600">Gửi tin nhắn đầu tiên cho {target.displayName}</p>
            </div>
          )}

          <ChatHistoryList
            items={localMsgs}
            bottomRef={bottomRef}
            renderItem={(msg, idx) => {
              const isSelf = msg.sender_id === selfId;
              const showTime = idx === 0 || (msg.timestamp - localMsgs[idx - 1].timestamp > 5 * 60 * 1000);
              return (
                <div key={msg.msg_id}>
                  {showTime && <div className="text-center text-[11px] text-gray-600 py-1">{fmtTime(msg.timestamp)}</div>}
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
          <div className="flex gap-2 px-3 py-1.5 border-t border-gray-700 bg-yellow-500/5 flex-shrink-0 flex-wrap items-center">
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
              <div key={`qm_vid_${i}`} className="relative w-11 h-11 bg-gray-700 rounded-lg border border-yellow-600/40 flex items-center justify-center flex-shrink-0">
                <span className="text-lg">🎬</span>
              </div>
            ))}
            <button onClick={() => setPendingQMMedia(null)}
              className="ml-auto text-[11px] text-gray-500 hover:text-red-400 transition-colors px-1">✕</button>
          </div>
        )}

        {/* ── Clipboard image previews ──────────────────────────────── */}
        {clipImgs.length > 0 && (
          <div className="flex gap-2 px-3 py-1.5 border-t border-gray-700 bg-gray-800/40 flex-shrink-0 flex-wrap">
            {clipImgs.map(img => (
              <div key={img.id} className="relative">
                <img src={img.dataUrl} alt="" className="w-11 h-11 object-cover rounded-lg border border-gray-600"/>
                <button onClick={() => setClipImgs(p => p.filter(i => i.id !== img.id))}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-white text-[9px] hover:bg-red-400">✕</button>
              </div>
            ))}
          </div>
        )}

        {/* ── Composer ─────────────────────────────────────────────────── */}
        <div className="border-t border-gray-700 bg-gray-900 flex-shrink-0 rounded-b-2xl">
          {/* Action toolbar row */}
          {target && (
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50">
              <div className="flex items-center gap-1">
                {/* Image */}
                <button onClick={async () => {
                  const auth = getAuth(); if (!auth||!selectedZaloId) return;
                  const r = await ipc.file?.openDialog({ filters:[{name:'Images',extensions:['jpg','jpeg','png','gif','webp']}], multiSelect:true });
                  if (r?.canceled||!r?.filePaths?.length) return;
                  setSending(true);
                  // Add temp image bubbles using local-media:// URLs for preview
                  const tempImgMsgs: MessageItem[] = (r.filePaths as string[]).map((fp: string, i: number) => ({
                    msg_id: `qc_img_fp_${Date.now()}_${i}`,
                    owner_zalo_id: selectedZaloId!,
                    thread_id: target.userId,
                    thread_type: target.threadType,
                    sender_id: selectedZaloId!,
                    content: JSON.stringify({ href: toLocalMediaUrl(fp) }),
                    msg_type: 'photo',
                    timestamp: Date.now() + i,
                    is_sent: 1,
                    status: 'sending',
                  }));
                  setLocalMsgs(p => [...p, ...tempImgMsgs]);
                  try { await ipc.zalo?.sendImages({ auth, threadId: target.userId, type: target.threadType, filePaths: r.filePaths }); } catch{}
                  setSending(false);
                }} title="Gửi ảnh"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                </button>
                {/* File */}
                <button onClick={async () => {
                  const auth = getAuth(); if (!auth) return;
                  const r = await ipc.file?.openDialog({ filters:[{name:'All Files',extensions:['*']}] });
                  if (r?.canceled||!r?.filePaths?.length) return;
                  setSending(true);
                  try { await ipc.zalo?.sendFile({ auth, threadId: target.userId, type: target.threadType, filePath: r.filePaths[0] }); } catch{}
                  setSending(false);
                }} title="Gửi file"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                {/* Quick messages ⚡ */}
                <div className="relative">
                  <button onClick={() => setShowQM(v=>!v)}
                    title="Tin nhắn nhanh"
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${showQM?'bg-yellow-500/20 text-yellow-400':'text-gray-400 hover:text-white hover:bg-gray-700'}`}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                    </svg>
                  </button>
                  {showQM && selectedZaloId && (
                    <QuickMsgPicker
                      getAuth={getAuth} accountId={selectedZaloId}
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
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-lg transition-colors ${showEmoji?'bg-blue-600':'hover:bg-gray-700'}`}>😊</button>
                  {showEmoji && (
                    <div className="absolute bottom-10 left-0 bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl z-50 w-72 overflow-hidden">
                      <div className="max-h-64 overflow-y-auto p-2 space-y-2.5">
                        {Object.entries(EMOJI_CATEGORIES).map(([category, emojis]) => (
                          <div key={category}>
                            <p className="text-[10px] text-gray-500 font-medium mb-1 px-1">{category}</p>
                            <div className="grid grid-cols-8 gap-0.5">
                              {emojis.map((em, idx) => (
                                <button key={`${category}-${em}-${idx}`} onMouseDown={e => { e.preventDefault(); insertText(em); setShowEmoji(false); }}
                                  className="text-lg hover:bg-gray-700 rounded-lg p-0.5 transition-colors aspect-square flex items-center justify-center hover:scale-110">{em}</button>
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
                className={`min-h-[40px] max-h-[120px] overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors leading-relaxed empty:before:content-[attr(data-placeholder)] empty:before:text-gray-500 empty:before:pointer-events-none ${!target?'opacity-40 cursor-not-allowed':''}`}
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
                onClick={async () => {
                  const auth = getAuth(); if(!auth||!target||!selectedZaloId) return;
                  await ipc.zalo?.sendMessage({ auth, threadId:target.userId, type:target.threadType, message:'👍' }).catch(()=>{});
                  const m: MessageItem = { msg_id:`qc_like_${Date.now()}`, owner_zalo_id:selectedZaloId, thread_id:target.userId, thread_type:target.threadType, sender_id:selectedZaloId, content:'👍', msg_type:'text', timestamp:Date.now(), is_sent:1, status:'sent' };
                  setLocalMsgs(p=>[...p,m]); addMessage(selectedZaloId,target.userId,m);
                }}
                className="w-9 h-9 rounded-lg hover:bg-gray-700 flex items-center justify-center text-blue-400 hover:text-blue-300 disabled:opacity-30 transition-colors text-xl flex-shrink-0">👍</button>
            )}
          </div>

          <div className="text-[11px] text-gray-600 px-3 py-1">
            Shift+Enter xuống dòng · Ctrl + Shift + N mở tính năng nhanh
          </div>
        </div>
      </div>
    </div>
  );
}
