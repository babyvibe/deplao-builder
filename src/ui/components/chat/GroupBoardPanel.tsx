import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { PinnedMsg, PinnedNote } from './PinnedMessages';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { PollDetailView as SharedPollDetailView } from './PollView';

// ─── Types ─────────────────────────────────────────────────────────────────

interface BoardItem {
  type: 'pin' | 'note' | 'poll';
  id: string;
  pin?: PinnedMsg;
  note?: PinnedNote;
  poll?: {
    msgId: string;
    pollId: string;
    question: string;
    senderName: string;
    timestamp: number;
    content: string;
  };
  sortKey: number;
}

type Tab = 'all' | 'pin' | 'note' | 'poll';

// ─── Props ──────────────────────────────────────────────────────────────────

interface Props {
  zaloId: string;
  threadId: string;
  groupName?: string;
  groupAvatar?: string;
  onBack: () => void;
  onCreateNote?: () => void;
  onNoteClick?: (note: PinnedNote) => void;
  onScrollToMsg?: (msgId: string) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return isToday ? `Hôm nay lúc ${hm}` : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ` lúc ${hm}`;
}

function parsePoll(msg: any): BoardItem['poll'] | null {
  try {
    const c = JSON.parse(msg.content || '{}');
    const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
    const pollId = String(params.pollId || '');
    const question = params.question || c.title || '';
    if (!pollId) return null;
    return {
      msgId: msg.msg_id,
      pollId,
      question,
      senderName: msg.sender_name || '',
      timestamp: msg.timestamp || 0,
      content: msg.content,
    };
  } catch {
    return null;
  }
}

function renderPinPreview(pin: PinnedMsg): string {
  if (pin.preview_image) return '[Hình ảnh]';
  const t = pin.msg_type || '';
  if (t === 'photo' || t === 'image') return '[Hình ảnh]';
  if (t.includes('video')) return '[Video]';
  if (t.includes('file') || t === 'share.file') return '[File]';
  if (t === 'sticker') return '[Sticker]';
  try {
    const p = JSON.parse(pin.content || '{}');
    if (p?.msg) return String(p.msg);
    if (p?.title) return String(p.title);
  } catch {}
  return pin.content?.slice(0, 100) || '[Tin nhắn]';
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function GroupBoardPanel({
  zaloId,
  threadId,
  onBack,
  onCreateNote,
  onNoteClick,
  onScrollToMsg,
}: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [pins, setPins] = useState<PinnedMsg[]>([]);
  const [notes, setNotes] = useState<PinnedNote[]>([]);
  const [polls, setPolls] = useState<NonNullable<BoardItem['poll']>[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!zaloId || !threadId) return;
    setLoading(true);
    try {
      const [pinsRes, pollsRes] = await Promise.all([
        ipc.db?.getPinnedMessages({ zaloId, threadId }),
        ipc.db?.getMessagesByType({ zaloId, threadId, msgType: 'group.poll', limit: 100 }),
      ]);

      if (pinsRes?.success) {
        const allPins: any[] = pinsRes.pins || [];
        setPins(allPins.filter((p: any) => p.msg_type !== 'note'));
        setNotes(allPins.filter((p: any) => p.msg_type === 'note').map((p: any) => {
          try {
            const c = JSON.parse(p.content || '{}');
            return { topicId: c.topicId || p.msg_id.replace('note_', ''), title: c.title || p.preview_text || '', creatorId: c.creatorId || p.sender_id || '', creatorName: p.sender_name || '', createTime: c.createTime || p.timestamp || 0, editTime: c.editTime || p.timestamp || 0 } as PinnedNote;
          } catch { return null; }
        }).filter(Boolean) as PinnedNote[]);
      }

      if (pollsRes?.success) {
        const seen = new Set<string>();
        setPolls((pollsRes.messages || []).map((m: any) => parsePoll(m)).filter(Boolean).filter((p: any) => {
          if (seen.has(p!.pollId)) return false;
          seen.add(p!.pollId);
          return true;
        }) as NonNullable<BoardItem['poll']>[]);
      }
    } finally {
      setLoading(false);
    }
  }, [zaloId, threadId]);

  useEffect(() => { load(); }, [load]);

  // Listen for real-time note pin events
  useEffect(() => {
    if (!zaloId || !threadId) return;
    const unsub = ipc.on?.('event:groupEvent', (data: any) => {
      const evThreadId = data?.groupId || data?.threadId;
      if (evThreadId !== threadId) return;
      if (data?.eventType === 'new_pin_topic' && data?.notePin?.topicId) {
        const note: PinnedNote = {
          topicId: String(data.notePin.topicId),
          title: data.notePin.title || '',
          creatorId: String(data.notePin.creatorId || ''),
          createTime: data.notePin.createTime || Date.now(),
          editTime: data.notePin.editTime || Date.now(),
        };
        setNotes(prev => [note, ...prev.filter(n => n.topicId !== note.topicId)]);
      }
      if (data?.eventType === 'unpin_topic' && data?.notePin?.topicId) {
        setNotes(prev => prev.filter(n => n.topicId !== String(data.notePin.topicId)));
      }
    });
    return () => unsub?.();
  }, [zaloId, threadId]);

  // Listen for poll vote events → reload polls list
  useEffect(() => {
    if (!zaloId || !threadId) return;
    const unsub = ipc.on?.('event:pollVote', (data: any) => {
      if (data?.zaloId !== zaloId || data?.threadId !== threadId) return;
      load();
    });
    return () => unsub?.();
  }, [zaloId, threadId, load]);

  const pinItems: BoardItem[] = pins.map(p => ({ type: 'pin', id: `pin_${p.msg_id}`, pin: p, sortKey: p.pinned_at || p.timestamp }));
  const noteItems: BoardItem[] = notes.map(n => ({ type: 'note', id: `note_${n.topicId}`, note: n, sortKey: n.createTime }));
  const pollItems: BoardItem[] = polls.map(p => ({ type: 'poll', id: `poll_${p.pollId}`, poll: p, sortKey: p.timestamp }));
  const counts = { all: pinItems.length + noteItems.length + pollItems.length, pin: pinItems.length, note: noteItems.length, poll: pollItems.length };
  const displayed = tab === 'all' ? [...pinItems, ...noteItems, ...pollItems].sort((a, b) => b.sortKey - a.sortKey) : tab === 'pin' ? pinItems : tab === 'note' ? noteItems : pollItems;

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-700 bg-gray-800 flex-shrink-0">
        <button
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors flex-shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span className="flex-1 font-semibold text-white text-base">Bảng tin nhóm</span>
        <button
          onClick={onCreateNote}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          title="Tạo ghi chú"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700 bg-gray-800 flex-shrink-0">
        {(['all', 'pin', 'note', 'poll'] as Tab[]).map(key => {
          const label = key === 'all' ? 'Tất cả' : key === 'pin' ? 'Tin ghim' : key === 'note' ? 'Ghi chú' : 'Bình chọn';
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                tab === key
                  ? 'text-blue-400 border-blue-500'
                  : 'text-gray-500 border-transparent hover:text-gray-300'
              }`}
            >
              {label}
              {counts[key] > 0 && (
                <span className={`ml-1 text-[11px] ${tab === key ? 'text-blue-400' : 'text-gray-600'}`}>
                  ({counts[key]})
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        ) : displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-500 gap-2">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="opacity-30">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="9" y1="9" x2="15" y2="9"/>
              <line x1="9" y1="13" x2="13" y2="13"/>
            </svg>
            <p className="text-sm">Chưa có nội dung</p>
          </div>
        ) : (
          <div className="p-3 space-y-3">
            {displayed.map(item => (
              <BoardCard
                key={item.id}
                item={item}
                onNoteClick={onNoteClick}
                onScrollToMsg={onScrollToMsg}
                zaloId={zaloId}
                threadId={threadId}
                onUnpin={(msgId) => setPins(prev => prev.filter(p => p.msg_id !== msgId))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── BoardCard ────────────────────────────────────────────────────────────────

function BoardCard({ item, onNoteClick, onScrollToMsg, zaloId, threadId }: {
  item: BoardItem;
  onNoteClick?: (note: PinnedNote) => void;
  onScrollToMsg?: (msgId: string) => void;
  zaloId: string;
  threadId: string;
  onUnpin?: (msgId: string) => void;
}) {
  if (item.type === 'poll' && item.poll) {
    return <PollBoardCard poll={item.poll} zaloId={zaloId} threadId={threadId} />;
  }

  if (item.type === 'note' && item.note) {
    const note = item.note;
    return (
      <div
        className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden cursor-pointer hover:border-gray-600 transition-colors"
        onClick={() => onNoteClick?.(note)}
      >
        <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
          {note.creatorName ? (
            <div className="w-9 h-9 rounded-full bg-gray-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
              {(note.creatorName || 'U').charAt(0).toUpperCase()}
            </div>
          ) : (
            <div className="w-9 h-9 rounded-full bg-orange-500/20 flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-100 truncate">{note.creatorName || 'Thành viên'}</p>
            <div className="flex items-center gap-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <span className="text-[11px] text-orange-400 font-medium">Ghi chú</span>
            </div>
          </div>
        </div>
        <div className="px-4 pb-2">
          <p className="text-sm text-gray-100 font-medium leading-snug whitespace-pre-wrap line-clamp-3">{note.title}</p>
        </div>
        <div className="flex items-center justify-between px-4 pb-3 pt-1">
          <span className="text-xs text-gray-500">{formatTime(note.createTime)}</span>
          <button
            onClick={e => { e.stopPropagation(); onNoteClick?.(note); }}
            className="text-xs text-blue-400 hover:text-blue-300 font-semibold transition-colors"
          >
            Xem ghi chú
          </button>
        </div>
      </div>
    );
  }

  if (item.type === 'pin' && item.pin) {
    const pin = item.pin;
    const previewText = pin.preview_text?.trim() || renderPinPreview(pin);
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden hover:border-gray-600 transition-colors">
        <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
          <div className="w-9 h-9 rounded-full bg-blue-500/15 flex items-center justify-center flex-shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-100 truncate">{pin.sender_name || 'Thành viên'}</p>
            <div className="flex items-center gap-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
              <span className="text-[11px] text-blue-400 font-medium">Tin nhắn</span>
            </div>
          </div>
        </div>
        {pin.preview_image ? (
          <div className="px-4 pb-2">
            <img
              src={pin.preview_image}
              alt=""
              className="max-w-[160px] h-24 object-cover rounded-xl"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        ) : (
          <div className="px-4 pb-2">
            <p className="text-sm text-gray-200 leading-snug line-clamp-3">{previewText}</p>
          </div>
        )}
        <div className="flex items-center justify-between px-4 pb-3 pt-1">
          <span className="text-xs text-gray-500">{formatTime(pin.timestamp)}</span>
          <button
            onClick={() => onScrollToMsg?.(pin.msg_id)}
            className="text-xs text-blue-400 hover:text-blue-300 font-semibold transition-colors"
          >
            Xem tin nhắn
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ─── PollBoardCard ─────────────────────────────────────────────────────────

function PollBoardCard({ poll, zaloId, threadId }: { poll: NonNullable<BoardItem['poll']>; zaloId: string; threadId: string }) {
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const contacts = useChatStore(s => s.contacts[zaloId] || []);
  const groupMembers: any[] = useAppStore(s => s.groupInfoCache?.[zaloId]?.[threadId]?.members || []);

  // Merge contacts + group members → đủ thông tin voter
  const allContacts = React.useMemo(() => {
    const map = new Map<string, any>();
    contacts.forEach((c: any) => map.set(String(c.contact_id), c));
    groupMembers.forEach((m: any) => {
      const id = String(m.userId || m.uid || '');
      if (!id) return;
      const existing = map.get(id) || {};
      map.set(id, {
        ...existing,
        contact_id: id,
        display_name: existing.display_name || m.displayName || m.name || '',
        avatar_url: existing.avatar_url || m.avatar || m.avatarUrl || '',
      });
    });
    return Array.from(map.values());
  }, [contacts, groupMembers]);

  const getAuth = async () => {
    const accRes = await ipc.login?.getAccounts();
    const acc = accRes?.accounts?.find((a: any) => a.zalo_id === zaloId) || accRes?.accounts?.[0];
    if (!acc) throw new Error('No account');
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  const creatorContact = detail ? allContacts.find((c: any) => String(c.contact_id) === String(detail.creator || '')) : null;
  const creatorName: string = creatorContact?.alias || creatorContact?.display_name || poll.senderName || '';

  const loadDetail = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const auth = await getAuth();
      const res = await ipc.zalo?.getPollDetail({ auth, pollId: poll.pollId });
      if (res?.success && res.response) setDetail(res.response);
    } finally {
      setLoading(false);
    }
  };

  const handleExpand = () => { const next = !expanded; setExpanded(next); if (next && !detail) loadDetail(); };

  const totalVotes: number = detail?.num_vote || 0;
  const allowMulti: boolean = !!detail?.allow_multi_choices;
  const isAnon: boolean = !!detail?.is_anonymous;
  const isClosed: boolean = !!detail?.closed;
  const isExpired: boolean = (detail?.expired_time || 0) > 0 && (detail?.expired_time * 1000) < Date.now();

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden hover:border-gray-600 transition-colors">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
        <div className="w-9 h-9 rounded-full bg-green-500/15 flex items-center justify-center flex-shrink-0">
          {creatorName
            ? <span className="text-sm font-bold text-green-400">{creatorName.charAt(0).toUpperCase()}</span>
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="8" y1="9" x2="16" y2="9"/>
                <line x1="8" y1="13" x2="13" y2="13"/>
                <line x1="8" y1="17" x2="11" y2="17"/>
              </svg>
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-100 truncate">{creatorName || 'Thành viên'}</p>
          <div className="flex items-center gap-1">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="8" y1="9" x2="16" y2="9"/>
            </svg>
            <span className="text-[11px] text-green-400 font-medium">Bình chọn</span>
            {isAnon && <span className="text-[11px] text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded ml-1">Ẩn danh</span>}
            {(isClosed || isExpired) && (
              <span className="text-[11px] text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded ml-1">
                {isClosed ? 'Đã khoá' : 'Hết hạn'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Question */}
      <div className="px-4 pb-2">
        <p className="text-sm font-bold text-gray-100">{poll.question}</p>
        {allowMulti && <p className="text-xs text-gray-500 mt-0.5">Chọn nhiều phương án</p>}
        {totalVotes > 0 && <p className="text-xs text-blue-400 font-semibold mt-0.5">{totalVotes} lượt bình chọn</p>}
      </div>

      {/* Expanded detail — shared component */}
      {expanded && (
        loading && !detail ? (
          <div className="flex justify-center py-3 px-4">
            <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
        ) : detail ? (
          <SharedPollDetailView
            detail={detail}
            activeAccountId={zaloId}
            pollId={poll.pollId}
            getAuth={getAuth}
            onRefresh={loadDetail}
            theme="dark"
            contacts={allContacts}
            showLockButton={true}
            showAddOption={true}
          />
        ) : (
          <p className="text-xs text-gray-500 py-2 text-center px-4">Không có dữ liệu</p>
        )
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 pb-3 pt-1">
        <span className="text-xs text-gray-500">{formatTime(poll.timestamp)}</span>
        <button
          onClick={handleExpand}
          className="text-xs text-blue-400 hover:text-blue-300 font-semibold transition-colors flex items-center gap-1"
        >
          {loading && expanded ? (
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points={expanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}/>
            </svg>
          )}
          {expanded ? 'Thu gọn' : 'Xem bình chọn'}
        </button>
      </div>
    </div>
  );
}

export type { BoardItem };

