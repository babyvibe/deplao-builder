import React from 'react';
import { zaloCodeToEmoji } from '@/lib/chat/emojiUtils';
import { getTelegramPostMeta } from '@/lib/mediaResolver';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useAccountStore } from '@/store/accountStore';
import { mergeZaloReactionAliases } from '../../../shared/zaloReactions';

/** Tin Zalo (bản ghi cũ không có channel). */
const isZaloChannel = (channel?: string) => !channel || channel === 'zalo';

/** Parse reactions từ msg.reactions -> { emoji: count } (dùng cho hiển thị bubble) */
function reactionKey(value: string, channel?: string): string {
  return channel === 'telegram_user' ? value : zaloCodeToEmoji(value);
}

// Normalize common emoji variants to ensure proper color rendering
const EMOJI_NORMALIZE: Record<string, string> = {
  '❤': '❤️', '❤︎': '❤️',
  '👍': '👍️', '👍︎': '👍️',
  '👎': '👎️', '👎︎': '👎️',
  '🔥': '🔥️', '🔥︎': '🔥️',
  '👏': '👏️', '👏︎': '👏️',
  '😁': '😁️', '😁︎': '😁️',
  '😢': '😢️', '😢︎': '😢️',
  '😮': '😮️', '😮︎': '😮️',
  '🥰': '🥰️', '🥰︎': '🥰️',
  '🤔': '🤔️', '🤔︎': '🤔️',
  '🤯': '🤯️', '🤯︎': '🤯️',
  '🎉': '🎉️', '🎉︎': '🎉️',
  '😡': '😡️', '😡︎': '😡️',
  '😂': '😂️', '😂︎': '😂️',
  '😍': '😍️', '😍︎': '😍️',
};

// Chuỗi reaction chuẩn của Telegram không có U+FE0F ("☃", "✍", "🕊", "🤷‍♂"…): các ký tự mặc định kiểu chữ này hiện đen
// trắng / tách rời nếu thiếu → thêm U+FE0F CHỈ khi hiển thị (so sánh, gửi vẫn dùng chuỗi chuẩn).
const TEXT_DEFAULT_EMOJI = /([\u2764\u2603\u270D\u2642\u2640\u263A\u2639]|\uD83D\uDD4A)(?!\uFE0F)/g;

function displayReactionEmoji(value: string): string {
  if (value.startsWith('tg_custom:')) return '✨';
  return EMOJI_NORMALIZE[value] || value.replace(TEXT_DEFAULT_EMOJI, '$1\uFE0F');
}

function parseReactions(raw: any, channel?: string): Record<string, number> {
  if (!raw) return {};
  if (isZaloChannel(channel)) {
    const counts: Record<string, number> = {};
    for (const [key, data] of Object.entries(parseReactionsFull(raw, channel).emoji)) {
      if (data.total > 0) counts[key] = data.total;
    }
    return counts;
  }
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object') return {};

  const toEmoji = (k: string) => reactionKey(k, channel);

  // Format mới: { total, lastReact, emoji: { emojiChar: { total, users } } }
  if (parsed.emoji && typeof parsed.emoji === 'object') {
    const counts: Record<string, number> = {};
    for (const [emojiChar, data] of Object.entries(parsed.emoji as any)) {
      if (data && typeof data === 'object' && (data as any).total > 0) {
        const key = toEmoji(emojiChar);
        counts[key] = (counts[key] || 0) + (data as any).total;
      }
    }
    return counts;
  }

  // Format cũ: { userId: emojiChar }
  const counts: Record<string, number> = {};
  for (const val of Object.values(parsed)) {
    if (val && typeof val === 'string') {
      const key = toEmoji(val);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

/** Parse reactions ra full ReactionData (có users) để check current user và hiển thị popup */
function parseReactionsFull(raw: any, channel?: string): { total: number; emoji: Record<string, { total: number; users: Record<string, number> }> } {
  const empty = { total: 0, emoji: {} };
  if (!raw) return empty;
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return empty; }
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  const convertKey = (k: string) => reactionKey(k, channel);

  // New format: has .emoji with user counts - convert Zalo codes to emoji
  if (parsed.emoji && typeof parsed.emoji === 'object') {
    const converted: Record<string, { total: number; users: Record<string, number> }> = {};
    for (const [code, data] of Object.entries(parsed.emoji as any)) {
      const key = convertKey(code);
      if (!converted[key]) converted[key] = { total: 0, users: {} };
      converted[key].total += (data as any).total || 0;
      for (const [uid, cnt] of Object.entries((data as any).users || {})) {
        converted[key].users[uid] = ((converted[key].users[uid] || 0)) + (cnt as number);
      }
    }
    const result = { total: parsed.total || 0, emoji: converted };
    // Zalo: "haha" từng lưu 2 kiểu (😄 lúc thả, 😆 từ echo) → gộp, cùng người lấy số lớn hơn
    return isZaloChannel(channel) ? mergeZaloReactionAliases(result) : result;
  }

  // Old format: { userId: emojiChar } - convert Zalo codes to emoji
  const result = { total: 0, emoji: {} as Record<string, { total: number; users: Record<string, number> }> };
  for (const [uid, emo] of Object.entries(parsed as Record<string, string>)) {
    if (!emo || typeof emo !== 'string') continue;
    const key = convertKey(emo);
    if (!result.emoji[key]) result.emoji[key] = { total: 0, users: {} };
    result.emoji[key].total++;
    result.emoji[key].users[uid] = (result.emoji[key].users[uid] || 0) + 1;
    result.total++;
  }
  return isZaloChannel(channel) ? mergeZaloReactionAliases(result) : result;
}

// ─── Reaction Context Menu ────────────────────────────────────────────────────
// Right-click on a reaction pill: pick emoji to react or X to cancel current reaction

const REACTION_EMOJIS = ['❤️', '👍', '😄', '😮', '😢', '😡', '😘', '😂', '💩', '🌹', '💔', '👎', '😍', '👌', '✌️', '🙏', '😉', '👋', '🫶', '😭'];

function ReactionContextMenu({ x, y, msg, myEmoji, onClose, onReact, onCancel }: {
  x: number; y: number; msg: any; myEmoji: string | null;
  onClose: () => void;
  onReact: (msg: any, emoji: string) => void;
  onCancel: (msg: any) => void;
}) {
  const menuRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const handler = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose(); };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', keyHandler); };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 240),
    top: Math.min(y, window.innerHeight - 100),
    zIndex: 9999,
  };

  return (
    <div ref={menuRef} style={style} className="bg-card border border-input rounded-xl shadow-2xl py-2 px-2">
      <p className="text-xs text-muted-foreground px-2 mb-1.5">Thả cảm xúc</p>
      <div className="flex items-center gap-1 flex-wrap max-w-[220px]">
        {REACTION_EMOJIS.map(emoji => (
          <button
            key={emoji}
            onClick={() => onReact(msg, emoji)}
            className={`text-xl p-1 rounded-lg hover:bg-muted transition-colors hover:scale-125 ${myEmoji === emoji ? 'bg-muted ring-1 ring-blue-400' : ''}`}
            title={emoji}
          >
            {emoji}
          </button>
        ))}
        {/* X button to cancel current reaction */}
        {myEmoji && (
          <button
            onClick={() => onCancel(msg)}
            className="text-sm px-2 py-1 rounded-lg bg-muted hover:bg-red-700 text-foreground/80 hover:text-white transition-colors ml-1"
            title="Huỷ reaction của bạn"
          >
            ✕ Huỷ
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Reaction Popup ──────────────────────────────────────────────────────────

function ReactionPopup({ msg, initialEmoji, contacts, groupMembers, currentUserId, onClose, ownerZaloId }: {
  msg: any; initialEmoji: string;
  contacts: any[]; groupMembers?: any[]; currentUserId: string;
  onClose: () => void;
  ownerZaloId?: string;
}) {
  const [tab, setTab] = React.useState(initialEmoji || 'all');
  const [fetchedData, setFetchedData] = React.useState<ReturnType<typeof parseReactionsFull> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const ownAvatar = useAccountStore((s) => s.accounts.find((account) => account.zalo_id === currentUserId)?.avatar_url || '');
  const [brokenAvatars, setBrokenAvatars] = React.useState<Set<string>>(() => new Set());
  // Kênh phát tin Telegram: không ai xem được người thả cảm xúc (Telegram ẩn để bảo vệ người theo dõi, kể cả với quản
  // trị viên — API trả BROADCAST_FORBIDDEN), chỉ có số lượng từng biểu cảm.
  const channelPost = msg.channel === 'telegram_user' && !!getTelegramPostMeta(msg);
  const [anonymous, setAnonymous] = React.useState(channelPost);
  const baseData = parseReactionsFull(msg.reactions, msg.channel);
  const data = fetchedData || baseData;
  const totalAll = data.total;

  // Fetch full reaction list từ Telegram API khi popup mở
  React.useEffect(() => {
    if (!ownerZaloId || msg.channel !== 'telegram_user' || channelPost) return;
    const threadId = msg.thread_id || msg.owner_zalo_id;
    if (!threadId) return;
    setLoading(true);
    const ipc = (window as any).electronAPI?.telegramUser;
    ipc?.getMessageReactions({
      accountId: ownerZaloId,
      chatId: threadId,
      messageId: msg.msg_id,
    }).then((res: any) => {
      if (res?.anonymous) { setAnonymous(true); return; }
      if (!res?.success || !res.reactions?.length) return;
      // REPLACE (not merge) with API results to avoid double-counting
      const replaced: ReturnType<typeof parseReactionsFull> = { total: 0, emoji: {} };
      for (const r of res.reactions) {
        const emoji = r.emoji;
        if (!emoji) continue;
        if (!replaced.emoji[emoji]) {
          replaced.emoji[emoji] = { total: 0, users: {} };
        }
        replaced.emoji[emoji].total += 1;
        if (r.userId) {
          replaced.emoji[emoji].users[r.userId] = (replaced.emoji[emoji].users[r.userId] || 0) + 1;
        }
      }
      // Calculate total
      replaced.total = Object.values(replaced.emoji).reduce((s, e) => s + e.total, 0);
      setFetchedData(replaced);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [ownerZaloId, msg.msg_id, msg.channel]);

  const getUsersForTab = (): { uid: string; emojis: Record<string, number>; total: number }[] => {
    if (tab === 'all') {
      const userMap: Record<string, { emojis: Record<string, number>; total: number }> = {};
      for (const [emo, emoData] of Object.entries(data.emoji)) {
        for (const [uid, count] of Object.entries(emoData.users)) {
          if (!userMap[uid]) userMap[uid] = { emojis: {}, total: 0 };
          userMap[uid].emojis[emo] = count;
          userMap[uid].total += count;
        }
      }
      return Object.entries(userMap).map(([uid, info]) => ({ uid, ...info }))
        .sort((a, b) => b.total - a.total);
    }
    const emoData = data.emoji[tab];
    if (!emoData) return [];
    return Object.entries(emoData.users)
      .sort(([, a], [, b]) => b - a)
      .map(([uid, count]) => ({ uid, emojis: { [tab]: count }, total: count }));
  };

  const getName = (uid: string) => {
    if (uid === currentUserId) return 'Bạn';
    const c = contacts.find(c => c.contact_id === uid);
    if (c?.alias || c?.display_name) return c.alias || c.display_name;
    // Fallback: look up in group members list
    const m = groupMembers?.find(m => (m.userId || m.id) === uid);
    if (m?.displayName || m?.firstName) return m.displayName || [m.firstName, m.lastName].filter(Boolean).join(' ');
    return uid;
  };
  const getAvatar = (uid: string) => {
    // Chính mình: ảnh của tài khoản — dòng danh bạ "tự chat" của Zalo hay giữ URL ảnh cũ đã hỏng
    if (uid === currentUserId && ownAvatar) return toLocalMediaUrl(ownAvatar);
    const c = contacts.find(c => c.contact_id === uid);
    if (c?.avatar_url) return toLocalMediaUrl(c.avatar_url);
    const m = groupMembers?.find(m => (m.userId || m.id) === uid);
    return m?.avatar ? toLocalMediaUrl(m.avatar) : '';
  };
  const users = getUsersForTab();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-card rounded-2xl w-96 max-h-[70vh] flex flex-col shadow-2xl border border-border" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Biểu cảm</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground w-6 h-6 flex items-center justify-center rounded-full hover:bg-muted">✕</button>
        </div>
        {/* Tabs */}
        <div className="flex border-b border-border overflow-x-auto scrollbar-hide">
          <button
            onClick={() => setTab('all')}
            className={`flex items-center gap-1 px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors ${tab === 'all' ? 'text-foreground border-blue-500' : 'text-muted-foreground border-transparent hover:text-foreground'}`}
          >
            Tất cả <span className="bg-muted px-1.5 py-0.5 rounded-full text-foreground/80">{totalAll}</span>
          </button>
          {Object.entries(data.emoji).map(([emo, emoData]) => (
            <button
              key={emo}
              onClick={() => setTab(emo)}
              className={`flex items-center gap-1 px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors ${tab === emo ? 'text-foreground border-blue-500' : 'text-muted-foreground border-transparent hover:text-foreground'}`}
            >
              {displayReactionEmoji(emo)} <span className="bg-muted px-1.5 py-0.5 rounded-full text-foreground/80">{emoData.total}</span>
            </button>
          ))}
        </div>
        {/* User list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[100px]">
          {users.map(({ uid, emojis, total }) => (
            <div key={uid} className="flex items-center gap-3 py-1">
              {getAvatar(uid) && !brokenAvatars.has(uid) ? (
                <img src={getAvatar(uid)} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0"
                  onError={() => setBrokenAvatars((prev) => new Set(prev).add(uid))} />
              ) : (
                <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                  {(getName(uid) || 'U').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{getName(uid)}</p>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {Object.entries(emojis).map(([emo, cnt]) => (
                  <span key={emo} className="text-base">
                    {displayReactionEmoji(emo)}{(cnt as number) > 1 && <span className="text-xs text-muted-foreground">{cnt as number}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {users.length === 0 && (anonymous && totalAll > 0 ? (
            <div className="px-3 py-5 text-center">
              <p className="text-sm text-foreground">
                {tab === 'all'
                  ? `${totalAll.toLocaleString('vi-VN')} lượt thả cảm xúc`
                  : <>{displayReactionEmoji(tab)} {(data.emoji[tab]?.total || 0).toLocaleString('vi-VN')} lượt</>}
              </p>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                Kênh Telegram ẩn danh người thả cảm xúc — Telegram chỉ cho xem số lượng, kể cả với quản trị viên kênh.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-6">
              {loading ? 'Đang tải...' : 'Chưa có ai thả cảm xúc này'}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

export { ReactionContextMenu, ReactionPopup, parseReactions, parseReactionsFull, displayReactionEmoji };
