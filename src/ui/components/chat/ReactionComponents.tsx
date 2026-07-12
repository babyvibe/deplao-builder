import React from 'react';
import { zaloCodeToEmoji } from '@/lib/chat/emojiUtils';

/** Parse reactions từ msg.reactions -> { emoji: count } (dùng cho hiển thị bubble) */
function parseReactions(raw: any): Record<string, number> {
  if (!raw) return {};
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object') return {};

  const toEmoji = (k: string) => zaloCodeToEmoji(k);

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
function parseReactionsFull(raw: any): { total: number; emoji: Record<string, { total: number; users: Record<string, number> }> } {
  const empty = { total: 0, emoji: {} };
  if (!raw) return empty;
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return empty; }
  }
  if (!parsed || typeof parsed !== 'object') return empty;

  const convertKey = (k: string) => zaloCodeToEmoji(k);

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
    return { total: parsed.total || 0, emoji: converted };
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
  return result;
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
    <div ref={menuRef} style={style} className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl py-2 px-2">
      <p className="text-xs text-gray-400 px-2 mb-1.5">Thả cảm xúc</p>
      <div className="flex items-center gap-1 flex-wrap max-w-[220px]">
        {REACTION_EMOJIS.map(emoji => (
          <button
            key={emoji}
            onClick={() => onReact(msg, emoji)}
            className={`text-xl p-1 rounded-lg hover:bg-gray-700 transition-colors hover:scale-125 ${myEmoji === emoji ? 'bg-gray-700 ring-1 ring-blue-400' : ''}`}
            title={emoji}
          >
            {emoji}
          </button>
        ))}
        {/* X button to cancel current reaction */}
        {myEmoji && (
          <button
            onClick={() => onCancel(msg)}
            className="text-sm px-2 py-1 rounded-lg bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white transition-colors ml-1"
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

function ReactionPopup({ msg, initialEmoji, contacts, groupMembers, currentUserId, onClose }: {
  msg: any; initialEmoji: string;
  contacts: any[]; groupMembers?: any[]; currentUserId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState(initialEmoji || 'all');
  const data = parseReactionsFull(msg.reactions);
  const totalAll = data.total;

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
    const m = groupMembers?.find(m => m.userId === uid);
    if (m?.displayName) return m.displayName;
    return uid;
  };
  const getAvatar = (uid: string) => {
    const c = contacts.find(c => c.contact_id === uid);
    if (c?.avatar_url) return c.avatar_url;
    const m = groupMembers?.find(m => m.userId === uid);
    return m?.avatar || '';
  };
  const users = getUsersForTab();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-800 rounded-2xl w-96 max-h-[70vh] flex flex-col shadow-2xl border border-gray-700" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-semibold text-white">Biểu cảm</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-700">✕</button>
        </div>
        {/* Tabs */}
        <div className="flex border-b border-gray-700 overflow-x-auto scrollbar-hide">
          <button
            onClick={() => setTab('all')}
            className={`flex items-center gap-1 px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors ${tab === 'all' ? 'text-white border-blue-500' : 'text-gray-400 border-transparent hover:text-gray-200'}`}
          >
            Tất cả <span className="bg-gray-700 px-1.5 py-0.5 rounded-full text-gray-300">{totalAll}</span>
          </button>
          {Object.entries(data.emoji).map(([emo, emoData]) => (
            <button
              key={emo}
              onClick={() => setTab(emo)}
              className={`flex items-center gap-1 px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors ${tab === emo ? 'text-white border-blue-500' : 'text-gray-400 border-transparent hover:text-gray-200'}`}
            >
              {emo} <span className="bg-gray-700 px-1.5 py-0.5 rounded-full text-gray-300">{emoData.total}</span>
            </button>
          ))}
        </div>
        {/* User list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[100px]">
          {users.map(({ uid, emojis, total }) => (
            <div key={uid} className="flex items-center gap-3 py-1">
              {getAvatar(uid) ? (
                <img src={getAvatar(uid)} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                  {(getName(uid) || 'U').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{getName(uid)}</p>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {Object.entries(emojis).map(([emo, cnt]) => (
                  <span key={emo} className="text-base">
                    {emo}{(cnt as number) > 1 && <span className="text-xs text-gray-400">{cnt as number}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {users.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-6">Chưa có ai thả cảm xúc này</p>
          )}
        </div>
      </div>
    </div>
  );
}

export { ReactionContextMenu, ReactionPopup, parseReactions, parseReactionsFull };
