import DateInputVN from '@/components/common/DateInputVN';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import MediaViewer, { MediaViewerImage } from './MediaViewer';
import MessageContextMenu from './MessageContextMenu';
import PinnedBar, { buildPinFromMsg, usePinnedData, PinnedNote } from './PinnedMessages';
import ChatHistoryList from './ChatHistoryList';
import SharedMessageContent from './SharedMessageContent';
import * as channelIpc from '../../lib/channelIpc';
import { ManagePanel } from './GroupInfoPanel';
import                           { UserProfilePopup } from '../common/UserProfilePopup';
import { RecalledBubble, BankCardBubble } from './MessageBubbles';
import GroupAvatar from '../common/GroupAvatar';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { formatPhone } from '@/utils/phoneUtils';
import { PollDetailView as SharedPollDetailView } from './PollView';
import { useEmployeeStore } from '@/store/employeeStore';

const EMOJI_TO_REACTION: Record<string, string> = {
  '❤️': 'HEART', '👍': 'LIKE', '😄': 'HAHA', '😮': 'WOW', '😢': 'CRY', '😡': 'ANGRY',
  '😘': 'KISS', '😂': 'TEARS_OF_JOY', '💩': 'SHIT', '🌹': 'ROSE', '💔': 'BROKEN_HEART',
  '👎': 'DISLIKE', '😍': 'LOVE', '👌': 'OK', '✌️': 'PEACE', '🙏': 'PRAY',
  '😉': 'WINK', '😕': 'CONFUSED', '😁': 'BIG_SMILE', '👊': 'PUNCH', '👋': 'BYE',
  '🫶': 'LOVE_YOU', '😭': 'VERY_SAD', '😎': 'COOL', '🎂': 'BIRTHDAY',
};

// Zalo text reaction codes → Unicode emoji (dùng để convert khi display)
const ZALO_CODE_TO_EMOJI: Record<string, string> = {
  '/-heart':   '❤️',  '/-strong':  '👍',  ':>':       '😄',  ':o':       '😮',
  ':-((': '😢',  ':-h': '😡',  ':-*': '😘',  ":')": '😂',
  '/-shit': '💩',  '/-rose': '🌹',  '/-break': '💔',  '/-weak': '👎',
  ';xx': '😍',  ';-/': '😕',  ';-)': '😉',  '/-fade': '😶',
  '/-li': '☀️',  '/-bd': '🎂',  '/-bome': '💣',  '/-ok': '👌',
  '/-v': '✌️',  '/-thanks': '🤝',  '/-punch': '👊',  '/-share': '🔗',
  '_()_': '🙏',  '/-no': '🙅',  '/-bad': '👎',  '/-loveu': '🫶',
  '--b': '😞',  ':((': '😭',  'x-)': '😎',  '8-)': '🤓',
  ';-d': '😁',  'b-)': '😎',  ':--|': '😐',  'p-(': '😔',
  ':-bye': '👋',  '|-)': '😴',  ':wipe': '😅',  ':-dig': '🤔',
  '&-(': '😰',  ':handclap': '👏',  '>-|': '😠',  ';-x': '🤫',
  ':-o': '😲',  ';-s': '😳',  ';-a': '😨',  ':-<': '😢',
  ':))': '😂',  '$-)': '🤑',  '/-beer': '🍺',
  // Common text emoticons
  ':-)': '🙂',  ':)': '🙂',  ':-(': '😞',  ':(': '😞',
  ':-D': '😁',  ':D': '😁',  ':P': '😛',  ':p': '😛',
  ':-P': '😛',  ':O': '😲',  '>:(': '😠',  ":'(": '😢',
};

// Chuyển đổi Zalo reaction code → Unicode emoji (dùng cho display)
function zaloCodeToEmoji(code: string): string {
  return ZALO_CODE_TO_EMOJI[code] ?? code;
}

// Thay thế tất cả Zalo codes trong text bằng Unicode emoji
function convertZaloEmojis(text: string): string {
  if (!text) return text;
  const direct = ZALO_CODE_TO_EMOJI[text];
  if (direct) return direct;
  const sorted = Object.keys(ZALO_CODE_TO_EMOJI).sort((a, b) => b.length - a.length);
  let result = text;
  for (const code of sorted) {
    if (result.includes(code)) {
      result = result.split(code).join(ZALO_CODE_TO_EMOJI[code]);
    }
  }
  return result;
}

export default function ChatWindow() {
  const { messages, activeThreadId, prependMessages, setMessages, contacts, setReplyTo, removeMessage, typingUsers, seenInfo } = useChatStore();
  const { activeAccountId, getActiveAccount } = useAccountStore();
  const { showNotification, groupInfoCache, searchHighlightQuery } = useAppStore();

  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const pinnedBarWrapperRef = useRef<HTMLDivElement>(null);
  const prevPinnedBarHeightRef = useRef(0);
  const prevLastMsgIdRef = useRef<string>('');
  const savedScrollHeightRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);
  const isInitialThreadLoadRef = useRef(true);

  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [viewerState, setViewerState] = useState<{ images: MediaViewerImage[]; index: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; msg: any; isSent: boolean; isGroupAdmin?: boolean } | null>(null);
  const [forwardMsg, setForwardMsg] = useState<any | null>(null);
  const [reactionPopup, setReactionPopup] = useState<{ msg: any; activeEmoji: string } | null>(null);
  const [reactionContextMenu, setReactionContextMenu] = useState<{ x: number; y: number; msg: any; myEmoji: string | null } | null>(null);
  const [atTop, setAtTop] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  // Track khi đang xem tin nhắn cũ (do click vào ghim / quote / search) — cần nút "Về tin mới nhất"
  const [isViewingHistory, setIsViewingHistory] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [reactionPickerMsgId, setReactionPickerMsgId] = useState<string | null>(null);
  const [userProfilePopup, setUserProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [manageGroupOpen, setManageGroupOpen] = useState(false);
  const [noteModal, setNoteModal] = useState<{ topicId?: string; title?: string; creatorName?: string; createTime?: number } | null>(null);
  // Track which recalled messages the user has chosen to reveal original content
  const [revealedRecallIds, setRevealedRecallIds] = useState<Set<string>>(new Set());

  // Listen for groupinfo events from GroupBoardPanel / GroupInfoPanel
  useEffect(() => {
    const handleCreateNote = () => setNoteModal({});
    const handleViewNote = (e: Event) => {
      const note = (e as CustomEvent).detail;
      if (note) setNoteModal({ topicId: note.topicId, title: note.title, creatorName: note.creatorName, createTime: note.createTime });
    };
    window.addEventListener('groupinfo:createNote', handleCreateNote);
    window.addEventListener('groupinfo:viewNote', handleViewNote);
    return () => {
      window.removeEventListener('groupinfo:createNote', handleCreateNote);
      window.removeEventListener('groupinfo:viewNote', handleViewNote);
    };
  }, []);

  // OPTIMIZATION: Typing indicator - chỉ tick khi có typing trong thread hiện tại
  const [typingNow, setTypingNow] = useState(0);

  // Trigger khi typingUsers thay đổi - chỉ setState nếu có typing trong thread hiện tại
  useEffect(() => {
    const prefix = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}_` : '';
    if (!prefix) return;
    const hasTyping = Object.keys(typingUsers).some(k => k.startsWith(prefix));
    if (hasTyping) setTypingNow(Date.now());
  }, [typingUsers, activeAccountId, activeThreadId]);

  // Interval chỉ chạy khi typingNow > 0 (có người đang typing)
  useEffect(() => {
    if (!typingNow) return; // SKIP nếu không có typing

    const id = setInterval(() => {
      const prefix = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}_` : '';
      if (!prefix) return;
      const store = useChatStore.getState();
      const hasTyping = Object.keys(store.typingUsers).some(k => k.startsWith(prefix));
      if (hasTyping) setTypingNow(Date.now());
      else setTypingNow(0); // Dừng interval khi không còn typing
    }, 500);

    return () => clearInterval(id);
  }, [activeAccountId, activeThreadId, typingNow]);

  // ─── Pinned messages + notes (OPTIMIZED: 1 IPC call thay vì 2) ──────────────
  const { pins, setPins, pinnedNotes, setPinnedNotes, ready: pinsReady } = usePinnedData(activeAccountId, activeThreadId);

  // ─── Thread ready gate: chỉ hiển thị UI khi messages + pins đều đã load ──
  const [threadReady, setThreadReady] = useState(false);
  // Track threadId đã scroll — tránh race condition giữa useLayoutEffect vs useEffect
  const lastScrolledThreadRef = useRef<string | null>(null);

  const threadKey = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}` : '';
  const msgs = threadKey ? (messages[threadKey] || []) : [];

  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];

  // OPTIMIZATION: Contact lookup O(1) với Map
  const contactMap = React.useMemo(() => {
    const map = new Map<string, any>();
    contactList.forEach(c => map.set(c.contact_id, c));
    return map;
  }, [contactList]);
  const getContact = (senderId: string) => contactMap.get(senderId);

  // Cache group members for current thread
  const groupMembers: any[] = (activeAccountId && activeThreadId)
    ? (groupInfoCache?.[activeAccountId]?.[activeThreadId]?.members || [])
    : [];

  // OPTIMIZATION: Group member lookup O(1) với Map
  const groupMemberMap = React.useMemo(() => {
    const map = new Map<string, any>();
    groupMembers.forEach(m => map.set(m.userId, m));
    return map;
  }, [groupMembers]);
  const getGroupMember = (senderId: string) => groupMemberMap.get(senderId);

  // Check if current user is group owner or deputy — can recall any member's message
  const isGroupAdmin = React.useMemo(() => {
    if (!activeAccountId || !activeThreadId) return false;
    const cache = groupInfoCache?.[activeAccountId]?.[activeThreadId];
    if (!cache) return false;
    const me = cache.members?.find((m: any) => m.userId === activeAccountId);
    if (me && me.role >= 1) return true; // role 1=owner, 2=deputy
    if (cache.creatorId === activeAccountId) return true;
    if (cache.adminIds?.includes(activeAccountId)) return true;
    return false;
  }, [groupInfoCache, activeAccountId, activeThreadId]);

  // ─── Group image messages với cùng groupLayoutId thành 1 bubble ───────────
  const { groupedFirstMsgs, groupedSkipIds } = React.useMemo(() => {
    const byLayout: Record<string, any[]> = {};
    msgs.forEach((msg) => {
      const layoutId = getGroupLayoutId(msg);
      if (!layoutId) return;
      const key = `${msg.sender_id}_${layoutId}`;
      if (!byLayout[key]) byLayout[key] = [];
      byLayout[key].push(msg);
    });
    const groupedFirstMsgs: Record<string, any[]> = {};
    const groupedSkipIds = new Set<string>();
    for (const group of Object.values(byLayout)) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => {
        try {
          const pa = JSON.parse(a.content || '{}');
          const ppa = typeof pa.params === 'string' ? JSON.parse(pa.params) : (pa.params || {});
          const pb = JSON.parse(b.content || '{}');
          const ppb = typeof pb.params === 'string' ? JSON.parse(pb.params) : (pb.params || {});
          return (ppa.id_in_group || 0) - (ppb.id_in_group || 0);
        } catch { return 0; }
      });
      groupedFirstMsgs[sorted[0].msg_id] = sorted;
      for (let i = 1; i < sorted.length; i++) groupedSkipIds.add(sorted[i].msg_id);
    }
    return { groupedFirstMsgs, groupedSkipIds };
  }, [msgs]);

  // DEDUP poll messages: nhiều event vote cùng pollId → chỉ hiện 1 bubble (mới nhất)
  const pollSkipIds = React.useMemo(() => {
    const skip = new Set<string>();
    const latest = new Map<string, { msgId: string; ts: number }>();
    msgs.forEach(msg => {
      if (msg.msg_type !== 'group.poll') return;
      try {
        const c = JSON.parse(msg.content || '{}');
        const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
        const pollId = String(params.pollId || '');
        if (!pollId) return;
        const prev = latest.get(pollId);
        if (!prev || msg.timestamp >= prev.ts) {
          if (prev) skip.add(prev.msgId);
          latest.set(pollId, { msgId: msg.msg_id, ts: msg.timestamp });
        } else {
          skip.add(msg.msg_id);
        }
      } catch {}
    });
    return skip;
  }, [msgs]);

  // ─── Group consecutive stickers từ cùng người gửi trong 30 phút ────────────
  const { groupedStickerFirstMsgs, groupedStickerSkipIds } = React.useMemo(() => {
    const STICKER_GROUP_WINDOW_MS = 30 * 60 * 1000;
    const firstMsgs: Record<string, any[]> = {};
    const skipIds = new Set<string>();
    let currentGroup: any[] = [];

    const commitGroup = () => {
      if (currentGroup.length >= 2) {
        firstMsgs[currentGroup[0].msg_id] = [...currentGroup];
        for (let j = 1; j < currentGroup.length; j++) skipIds.add(currentGroup[j].msg_id);
      }
      currentGroup = [];
    };

    for (const msg of msgs) {
      if (groupedSkipIds.has(msg.msg_id)) continue;
      if (pollSkipIds.has(msg.msg_id)) continue;
      // Thu hồi / hệ thống phá vỡ nhóm sticker
      if (msg.is_recalled === 1 || msg.status === 'recalled' || msg.msg_type === 'recalled' || msg.msg_type === 'system') {
        commitGroup(); continue;
      }
      if (msg.msg_type !== 'chat.sticker') { commitGroup(); continue; }
      // Đây là sticker
      if (currentGroup.length === 0) {
        currentGroup = [msg];
      } else {
        const last = currentGroup[currentGroup.length - 1];
        const sameSender = msg.sender_id === last.sender_id;
        const withinWindow = Math.abs(msg.timestamp - last.timestamp) <= STICKER_GROUP_WINDOW_MS;
        if (sameSender && withinWindow) {
          currentGroup.push(msg);
        } else {
          commitGroup();
          currentGroup = [msg];
        }
      }
    }
    commitGroup();
    return { groupedStickerFirstMsgs: firstMsgs, groupedStickerSkipIds: skipIds };
  }, [msgs, groupedSkipIds, pollSkipIds]);

  // OPTIMIZATION: Message Type Cache - Parse JSON 1 lần cho tất cả messages
  // Tránh re-parse trong mỗi lần render, giảm ~85% JSON.parse() calls
  const msgTypeCache = React.useMemo(() => {
    const cache = new Map<string, {
      isCard: boolean;
      isEcard: boolean;
      isSticker: boolean;
      isRtf: boolean;
      isPoll: boolean;
      isVideo: boolean;
      isVoice: boolean;
      isGroupMedia: boolean;
      isMedia: boolean;
      isFile: boolean;
      content: string;
    }>();

    msgs.forEach((msg) => {
      const mt = msg.msg_type || '';
      const mc = msg.content || '';

      // Sử dụng các helper functions có sẵn
      const isCard = isCardType(mt, mc);
      const isEcard = isEcardType(mt);
      const isSticker = isStickerType(mt);
      const isRtf = isRtfMsg(mt, mc);
      const isPoll = mt === 'group.poll';
      const isVideo = isVideoType(mt);
      const isVoice = mt === 'chat.voice';
      const isGroupMedia = !isPoll && !isVideo && !isVoice && !!groupedFirstMsgs[msg.msg_id];
      const isMedia = !isCard && !isEcard && !isSticker && !isGroupMedia && !isRtf && !isPoll && !isVideo && !isVoice && isMediaType(mt, mc);
      const isFile = !isCard && !isEcard && !isSticker && !isMedia && !isRtf && !isPoll && !isVideo && !isVoice && isFileType(mt, mc);

      // Parse content 1 lần
      const content = (isMedia || isFile || isCard || isEcard || isSticker || isGroupMedia || isRtf || isPoll || isVideo || isVoice)
        ? ''
        : parseContent(mc);

      cache.set(msg.msg_id, {
        isCard, isEcard, isSticker, isRtf, isPoll, isVideo, isVoice,
        isGroupMedia, isMedia, isFile, content
      });
    });

    return cache;
  }, [msgs, groupedFirstMsgs]);

  // Reset khi đổi thread
  useEffect(() => {
    setHasMore(true);
    setLoadError(false);
    setAtTop(false);
    setAtBottom(true);
    setIsViewingHistory(false);
    prevLastMsgIdRef.current = '';      // reset để luôn trigger scroll khi load messages
    shouldRestoreScrollRef.current = false;
    isInitialThreadLoadRef.current = true;
    // Reset thread ready gate — ẩn UI cho đến khi data load xong
    setThreadReady(false);
    prevPinnedBarHeightRef.current = 0;
  }, [activeThreadId]);

  // ─── Thread ready gate (đơn giản): set true ngay khi pinsReady = true ───────
  // pinsReady reset về false mỗi khi thread đổi (trong usePinnedData hook),
  // rồi fire true sau khi IPC getPinnedMessages hoàn thành (~50-100ms).
  // Không dùng dataReady trung gian nữa — tránh bug RAF bị cancel khi re-render.
  useEffect(() => {
    if (!pinsReady || !activeThreadId) return;
    setThreadReady(true);
  }, [pinsReady, activeThreadId]);

  // ─── Safety fallback: nếu loading quá 3s mà vẫn chưa ready → force hiển thị ───
  useEffect(() => {
    if (!activeThreadId) return;
    const fallback = setTimeout(() => setThreadReady(true), 3000);
    return () => clearTimeout(fallback);
  }, [activeThreadId]);

  useLayoutEffect(() => {
    if (!threadReady) return;
    const scroller = messagesContainerRef.current;
    const currentHeight = pinnedBarWrapperRef.current?.offsetHeight || 0;
    const prevHeight = prevPinnedBarHeightRef.current;
    if (scroller && currentHeight !== prevHeight) {
      scroller.scrollTop += (currentHeight - prevHeight);
    }
    prevPinnedBarHeightRef.current = currentHeight;
  }, [threadReady, activeThreadId, pins.length, pinnedNotes.length]);

  // ─── Scroll to bottom SAU KHI threadReady = true (1 lần duy nhất per thread) ──
  // Dùng useEffect (không phải useLayoutEffect) + double-RAF để đảm bảo
  // messages đã được render + DOM đã được paint trước khi scroll.
  useEffect(() => {
    if (!threadReady || !activeThreadId) return;
    if (!msgs.length) return; // Chưa có tin nhắn → chưa cần scroll
    if (lastScrolledThreadRef.current === activeThreadId) return; // Đã scroll cho thread này rồi
    lastScrolledThreadRef.current = activeThreadId;

    // Double-RAF: frame 1 = messages render, frame 2 = layout hoàn chỉnh → scroll
    requestAnimationFrame(() => {
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        const el2 = messagesContainerRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight;
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      });
    });
  }, [threadReady, activeThreadId, msgs.length]);

  // OPTIMIZATION: Load group members với cache TTL - chỉ reload nếu cache cũ hơn 5 phút
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;

    // Detect group từ contact list
    const contactList = useChatStore.getState().contacts[activeAccountId] || [];
    const contact = contactList.find(c => c.contact_id === activeThreadId);
    const isGroup = contact?.contact_type === 'group' || contact?.contact_type === '1';
    if (!isGroup) return;

    // Check cache còn mới (< 5 phút) và có members → skip load
    const existingCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
    const CACHE_TTL = 5 * 60 * 1000; // 5 phút
    if (existingCache?.members?.length > 0 &&
        existingCache.fetchedAt &&
        Date.now() - existingCache.fetchedAt < CACHE_TTL) {
      return; // Cache còn mới → SKIP load, giảm ~80% IPC calls
    }

    const { setGroupInfo } = useAppStore.getState();

    const groupId = activeThreadId;
    const accountId = activeAccountId;

    const buildAndSetGroupInfo = (members: any[], name?: string, avatar?: string, creatorId?: string, adminIds?: string[]) => {
      const c = useChatStore.getState().contacts[accountId]?.find(x => x.contact_id === groupId);
      setGroupInfo(accountId, groupId, {
        groupId,
        name: name || c?.display_name || groupId,
        avatar: avatar || c?.avatar_url || '',
        memberCount: members.length,
        members: members.map((m: any) => ({
          userId: m.member_id || m.memberId || m.userId,
          displayName: m.display_name || m.displayName || '',
          avatar: m.avatar || '',
          role: m.role ?? 0,
        })),
        creatorId: creatorId || '',
        adminIds: adminIds || [],
        settings: undefined,
        fetchedAt: Date.now(),
      });
    };

    // 1. Tải từ DB trước
    ipc.db?.getGroupMembers({ zaloId: accountId, groupId })
      .then(async (res: any) => {
        if (res?.members?.length) {
          // DB có members → dùng luôn
          buildAndSetGroupInfo(res.members);
        } else {
          // DB không có members → fallback gọi API getGroupInfo
          try {
            const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
            if (!acc || (acc.channel || 'zalo') !== 'zalo') return;
            const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
            const infoRes = await ipc.zalo?.getGroupInfo({ auth, groupId });
            const info = infoRes?.response?.gridInfoMap?.[groupId] || infoRes?.response;
            if (!info) return;

            const name: string = info.name || info.groupName || '';
            const avatar: string = info.avt || info.fullAvt || info.avatar || '';
            const creatorId: string = String(info.creatorId || info.creator || '');
            const adminList: string[] = (info.adminIds || info.admins || []).map(String);

            // Build members list từ memVerList hoặc memIdList
            // memVerList có thể là array of strings "uid_version" hoặc array of objects {id, ...}
            const parseMemVerList = (list: any[]): string[] => {
              if (!list || !Array.isArray(list)) return [];
              return list.map((entry: any) => {
                if (typeof entry === 'string') return entry.replace(/_\d+$/, '');
                return String(entry.id || entry.uid || entry.userId || '');
              }).filter(uid => uid && uid !== 'undefined');
            };

            const memberIds: string[] = (info.memberIds?.length > 0)
              ? info.memberIds.map(String).filter(Boolean)
              : (info.memVerList?.length > 0)
                ? parseMemVerList(info.memVerList)
                : (info.memIdList || []).map(String).filter(Boolean);

            const rawMembers = memberIds.map((uid: string) => ({
              memberId: uid,
              displayName: '',
              avatar: '',
              role: uid === creatorId ? 1 : adminList.includes(uid) ? 2 : 0,
            }));

            // Lưu vào DB
            if (rawMembers.length) {
              ipc.db?.saveGroupMembers({ zaloId: accountId, groupId, members: rawMembers }).catch(() => {});
            }
            // Cập nhật tên/avatar nhóm nếu có
            if (name) {
              ipc.db?.updateContactProfile({ zaloId: accountId, contactId: groupId, displayName: name, avatarUrl: avatar, phone: '' }).catch(() => {});
              useChatStore.getState().updateContact(accountId, { contact_id: groupId, display_name: name, avatar_url: avatar });
            }

            buildAndSetGroupInfo(rawMembers, name, avatar, creatorId, adminList);
          } catch {}
        }
      })
      .catch(() => {});
  }, [activeThreadId, activeAccountId]);

  // Scroll event: track top/bottom position
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setAtTop(scrollTop < 60);
      setAtBottom(scrollHeight - scrollTop - clientHeight < 60);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [activeThreadId]);

  // ─── Scroll to bottom khi AI suggestions bar xuất hiện/biến mất ──────────
  // Khi thanh gợi ý AI thay đổi, input area đổi chiều cao → tin nhắn bị che.
  // Nếu user đang ở cuối trang → tự động scroll xuống để bù offset.
  useEffect(() => {
    const handler = () => {
      if (atBottom) {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'instant' });
        });
      }
    };
    window.addEventListener('ai:suggestionsBarChanged', handler);
    return () => window.removeEventListener('ai:suggestionsBarChanged', handler);
  }, [atBottom]);

  // Scroll to bottom chỉ khi có tin nhắn MỚI (tin cuối thay đổi), không scroll khi prepend tin cũ
  // Initial load scroll được xử lý bởi threadReady gate — effect này chỉ handle tin nhắn realtime
  useEffect(() => {
    if (!msgs.length) return;
    const lastMsg = msgs[msgs.length - 1];
    const lastMsgId = lastMsg.msg_id;
    if (lastMsgId !== prevLastMsgIdRef.current) {
      prevLastMsgIdRef.current = lastMsgId;
      if (!shouldRestoreScrollRef.current) {
        const isInitial = isInitialThreadLoadRef.current;
        isInitialThreadLoadRef.current = false;
        // Initial load: nếu < 50 tin thực thì không còn tin cũ hơn
        if (isInitial) {
          const realCount = msgs.filter(m => !m.msg_id.startsWith('temp_')).length;
          if (realCount < 50) setHasMore(false);
          // SKIP scroll ở đây — threadReady gate sẽ xử lý scroll initial
          return;
        }
        // Tin nhắn mới (realtime) — luôn cuộn khi chính mình gửi, còn tin đến thì giữ rule atBottom.
        const isOutgoing =
          lastMsg?.is_sent === 1 ||
          (activeAccountId ? String(lastMsg?.sender_id || '') === String(activeAccountId) : false) ||
          String(lastMsg?.msg_id || '').startsWith('temp_');
        if (isOutgoing || atBottom) {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
      }
    }
  }, [msgs, atBottom, activeAccountId]);

  // Sau khi prepend tin cũ: khôi phục vị trí scroll để không bị nhảy lên đầu
  useLayoutEffect(() => {
    if (shouldRestoreScrollRef.current && messagesContainerRef.current) {
      const delta = messagesContainerRef.current.scrollHeight - savedScrollHeightRef.current;
      messagesContainerRef.current.scrollTop = delta > 0 ? delta : 0;
      shouldRestoreScrollRef.current = false;
    }
  }, [msgs.length]);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    if ((acc.channel || 'zalo') !== 'zalo') return { cookies: '', imei: '', userAgent: '' };
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  // Tải thêm tin nhắn cũ dùng timestamp cursor (tránh lỗi offset khi có tin real-time)
  const handleLoadMore = async () => {
    if (!activeAccountId || !activeThreadId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    setLoadError(false);

    // Lấy timestamp của tin nhắn CŨ nhất đang hiển thị (bỏ qua temp)
    const oldest = msgs.find(m => !m.msg_id.startsWith('temp_'));
    const before = oldest?.timestamp;
    if (!before) {
      // Không có tin nhắn thực → không có thêm gì để tải
      setHasMore(false);
      setLoadingMore(false);
      return;
    }

    // Lưu scrollHeight trước khi prepend để khôi phục vị trí
    savedScrollHeightRef.current = messagesContainerRef.current?.scrollHeight || 0;
    shouldRestoreScrollRef.current = true;

    try {
      const res = await ipc.db?.getMessages({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        limit: 30,
        before,
      });
      if (res?.messages?.length > 0) {
        prependMessages(activeAccountId, activeThreadId, [...res.messages].reverse());
        // Nếu trả về ít hơn limit thì không còn nữa
        if (res.messages.length < 30) setHasMore(false);
      } else {
        setHasMore(false);
        shouldRestoreScrollRef.current = false;
      }
    } catch {
      shouldRestoreScrollRef.current = false;
      setLoadError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleUndo = async (msg: any) => {
    const auth = getAuth();
    if (!auth) return;
    try {
      // Detect channel from the message or contact
      const contactList = contacts[activeAccountId || ''] || [];
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || 'zalo';

      if (ch === 'facebook') {
        await channelIpc.unsendMessage('facebook', {
          accountId: activeAccountId || '',
          messageId: msg.msg_id,
          threadId: msg.thread_id,
        });
      } else {
      const isMsgSent = !!msg.is_sent;
      const messagePayload = JSON.stringify({
        data: {
          msgId: msg.msg_id,
          cliMsgId: msg.cli_msg_id || msg.msg_id,
          // Include uidFrom when admin is recalling another member's message
          ...(!isMsgSent && msg.sender_id ? { uidFrom: msg.sender_id } : {}),
        },
        threadId: msg.thread_id,
        type: msg.thread_type,
      });
      await ipc.zalo?.undoMessage({ auth, message: messagePayload });
      }
      // Đánh dấu thu hồi thay vì xóa — hiển thị "Tin nhắn đã thu hồi"
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        ipc.db?.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id }).catch(() => {});
      }
      showNotification('Đã thu hồi tin nhắn', 'success');
    } catch (e: any) {
      showNotification('Thu hồi thất bại: ' + e.message, 'error');
    }
  };

  const handleDelete = async (msg: any) => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const messagePayload = JSON.stringify({
        data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id, uidFrom: msg.sender_id },
        threadId: msg.thread_id,
        type: msg.thread_type,
      });
      await ipc.zalo?.deleteMessage({ auth, message: messagePayload, onlyMe: true });
      // Đánh dấu đã xoá trong DB (recalled) thay vì xoá hẳn — nhất quán với thu hồi
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        ipc.db?.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id }).catch(() => {});
      }
      showNotification('Đã xóa tin nhắn', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleDeleteFromDb = async (msg: any) => {
    if (!activeAccountId) return;
    try {
      await ipc.db?.deleteMessages({ zaloId: activeAccountId, msgIds: [msg.msg_id] });
      removeMessage(activeAccountId, msg.thread_id, msg.msg_id);
      showNotification('Đã xóa vĩnh viễn tin nhắn khỏi app', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleReact = async (msg: any, emoji: string) => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const contactList = contacts[activeAccountId || ''] || [];
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || 'zalo';

      if (ch === 'facebook') {
        await channelIpc.addReaction('facebook', {
          accountId: activeAccountId || '',
          messageId: msg.msg_id,
          emoji,
          threadId: msg.thread_id,
          action: 'add',
        });
      } else {
        const reactionKey = EMOJI_TO_REACTION[emoji] || 'HEART';
        const messagePayload = JSON.stringify({
          data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id },
          threadId: msg.thread_id,
          type: msg.thread_type,
        });
        await ipc.zalo?.addReaction({ auth, reactionType: reactionKey, message: messagePayload });
      }
    } catch {}
  };

  // Huỷ reaction: gửi Reactions.NONE = "" để xoá
  const handleCancelReaction = async (msg: any) => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const contactList = contacts[activeAccountId || ''] || [];
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || 'zalo';

      if (ch === 'facebook') {
        await channelIpc.addReaction('facebook', {
          accountId: activeAccountId || '',
          messageId: msg.msg_id,
          emoji: '',
          threadId: msg.thread_id,
          action: 'remove',
        });
      } else {
        const messagePayload = JSON.stringify({
          data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id },
          threadId: msg.thread_id,
          type: msg.thread_type,
        });
        await ipc.zalo?.addReaction({ auth, reactionType: 'NONE', message: messagePayload });
      }
    } catch {}
  };

  const handleForward = (msg: any) => {
    setForwardMsg(msg);
  };

  const handlePin = async (msg: any) => {
    if (!activeAccountId || !activeThreadId) return;
    // Lấy tên người gửi
    // Nếu là tin của mình (is_sent=1), dùng tên account đang đăng nhập
    let senderName = '';
    if (msg.is_sent) {
      const activeAccount = getActiveAccount();
      senderName = activeAccount?.full_name || 'Tôi';
    } else {
      const contact = getContact(msg.sender_id);
      const groupMember = getGroupMember(msg.sender_id);
      // Không dùng sender_id (UID dài) làm tên — fallback về 'Người dùng'
      senderName = contact?.alias || contact?.display_name || groupMember?.displayName || 'Người dùng';
    }
    const pin = buildPinFromMsg(msg, senderName);

    // Kiểm tra giới hạn ghim trước khi lưu
    const alreadyPinned = pins.some(p => p.msg_id === msg.msg_id);
    const overLimit = !alreadyPinned && pins.length >= 3;

    try {
      await ipc.db?.pinMessage({ zaloId: activeAccountId, threadId: activeThreadId, pin });
      // Reload pins
      const res = await ipc.db?.getPinnedMessages({ zaloId: activeAccountId, threadId: activeThreadId });
      if (res?.success) setPins(res.pins || []);
      if (overLimit) {
        // Zalo API chỉ hỗ trợ 3 tin ghim — ghim thành công trong ứng dụng nhưng không đồng bộ lên API
        showNotification('📌 Ghim thành công (chỉ áp dụng trong app — Zalo giới hạn 3 tin ghim)', 'success');
      } else {
        showNotification('📌 Đã ghim tin nhắn', 'success');
      }
    } catch (e: any) {
      showNotification('Ghim thất bại: ' + e.message, 'error');
    }
  };

  /** Lấy đường dẫn local của ảnh/file từ msg.local_paths */
  const getLocalPath = (msg: any): string => {
    try {
      const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      return lp.file || lp.main || lp.hd || (Object.values(lp).find((v) => typeof v === 'string' && v) as string) || '';
    } catch { return ''; }
  };

  /** Mở thư mục chứa file/ảnh đã tải về */
  const handleOpenFolder = (msg: any) => {
    const localPath = getLocalPath(msg);
    if (!localPath) return;
    const parentDir = localPath.replace(/[/\\][^/\\]+$/, '');
    ipc.file?.openPath(parentDir);
  };

  // Cuộn đến tin nhắn gốc khi click vào quote / pinned / search result
  // Nếu tin nhắn không có trong DOM (nằm ở trang cũ), load messages xung quanh nó
  const handleScrollToMsg = async (msgId: string) => {
    if (!msgId) return;

    // Helper: highlight + scroll to element
    const scrollAndHighlight = (el: HTMLElement) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all');
      setTimeout(() => el.classList.remove('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all'), 2000);
    };

    // 1. Check if already in DOM
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      scrollAndHighlight(el);
      return;
    }

    // 2. Message not in DOM — fetch its info to get timestamp, then load messages around it
    if (!activeAccountId || !activeThreadId) return;
    try {
      const msgRes = await ipc.db?.getMessageById({ zaloId: activeAccountId, msgId });
      const targetMsg = msgRes?.message;
      if (!targetMsg?.timestamp) return;

      const aroundRes = await ipc.db?.getMessagesAround({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        timestamp: targetMsg.timestamp,
        limit: 200,
      });
      const aroundMsgs = aroundRes?.messages;
      if (!aroundMsgs?.length) return;

      // Replace current messages with the "around" set
      setMessages(activeAccountId, activeThreadId, aroundMsgs);
      setHasMore(true); // Có thể còn tin cũ hơn phía trên
      setIsViewingHistory(true); // Đánh dấu đang xem tin cũ → hiện nút "Về tin mới nhất"

      // Wait for React to render new messages, then scroll
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      const el2 = document.getElementById(`msg-${msgId}`);
      if (el2) {
        scrollAndHighlight(el2);
      }
    } catch (err) {
      console.error('[handleScrollToMsg] Failed to load messages around target:', err);
    }
  };

  // Tải lại tin nhắn mới nhất và cuộn xuống cuối — dùng khi đang xem tin nhắn cũ (isViewingHistory)
  const handleReturnToLatest = async () => {
    if (!activeAccountId || !activeThreadId || loadingLatest) return;
    setLoadingLatest(true);
    try {
      const res = await ipc.db?.getMessages({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        limit: 50,
        offset: 0,
      });
      if (res?.messages?.length) {
        const sorted = [...res.messages].reverse();
        setMessages(activeAccountId, activeThreadId, sorted);
        setHasMore(res.messages.length >= 50);
      }
      setIsViewingHistory(false);
      // Scroll to bottom sau khi render
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      console.error('[handleReturnToLatest]', e);
    } finally {
      setLoadingLatest(false);
    }
  };

  const buildImageEntry = React.useCallback((msg: any): MediaViewerImage | null => {
    const mt = msg?.msg_type || '';
    const mc = msg?.content || '';
    if (!isMediaType(mt, mc) || isVideoType(mt)) return null;

    let localUrl = '';
    let remoteUrl = '';
    let localPath = '';
    try {
      const lp: Record<string, string> = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}')
        : (msg.local_paths || {});
      const lf = lp.main || lp.hd || lp.thumb || (Object.values(lp)[0] as string) || '';
      if (lf) {
        localPath = lf;
        localUrl = toLocalMediaUrl(lf);
      }
    } catch {}
    try {
      const p = JSON.parse(msg.content || '{}');
      const params = typeof p.params === 'string' ? JSON.parse(p.params || '{}') : (p.params || {});
      remoteUrl = params.hd || params.rawUrl || p.href || p.thumb || '';
    } catch {}
    if (!remoteUrl && !localUrl) return null;
    const defaultName = localPath
      ? localPath.replace(/.*[/\\]/, '')
      : `image_${msg?.msg_id || Date.now()}.jpg`;
    return {
      src: remoteUrl || localUrl,
      displaySrc: localUrl || remoteUrl,
      localPath,
      defaultName,
    };
  }, []);

  const dedupeViewerImages = React.useCallback((images: MediaViewerImage[]): MediaViewerImage[] => {
    const seen = new Set<string>();
    const out: MediaViewerImage[] = [];
    for (const img of images) {
      const key = `${img.src || ''}__${img.displaySrc || ''}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(img);
    }
    return out;
  }, []);

  const buildImagesFromCurrentThread = React.useCallback((): MediaViewerImage[] => {
    const allImages: MediaViewerImage[] = [];
    for (const msg of msgs) {
      if (groupedSkipIds.has(msg.msg_id)) continue;
      const groupBatch = groupedFirstMsgs[msg.msg_id];
      if (groupBatch?.length) {
        for (const gm of groupBatch) {
          const entry = buildImageEntry(gm);
          if (entry) allImages.push(entry);
        }
        continue;
      }
      const entry = buildImageEntry(msg);
      if (entry) allImages.push(entry);
    }
    return dedupeViewerImages(allImages);
  }, [msgs, groupedFirstMsgs, groupedSkipIds, buildImageEntry, dedupeViewerImages]);

  const findViewerIndex = React.useCallback((images: MediaViewerImage[], clickedUrl: string): number => {
    const normalizeUrl = (u?: string) => {
      if (!u) return '';
      return u
        .replace(/^local-media:\/\//, 'local-media:///')
        .replace(/\\/g, '/')
        .split('?')[0]
        .trim();
    };

    const exactIdx = images.findIndex(img => img.src === clickedUrl || img.displaySrc === clickedUrl);
    if (exactIdx >= 0) return exactIdx;

    const normalizedClicked = normalizeUrl(clickedUrl);
    return images.findIndex(img => {
      return normalizeUrl(img.src) === normalizedClicked || normalizeUrl(img.displaySrc) === normalizedClicked;
    });
  }, []);

  /** Mở viewer ảnh với bộ sưu tập đầy đủ từ DB (giống panel ảnh/video), fallback nhanh từ messages hiện có */
  const openViewer = React.useCallback(async (clickedUrl: string) => {
    const initialImages = buildImagesFromCurrentThread();
    if (initialImages.length > 0) {
      const initialIdx = findViewerIndex(initialImages, clickedUrl);
      setViewerState({ images: initialImages, index: initialIdx >= 0 ? initialIdx : 0 });
    } else {
      setViewerState({ images: [{ src: clickedUrl }], index: 0 });
    }

    if (!activeAccountId || !activeThreadId) return;
    const PAGE_SIZE = 200;
    const MAX_PAGES = 100;
    const fullImages: MediaViewerImage[] = [];

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await ipc.db?.getMediaMessages({
          zaloId: activeAccountId,
          threadId: activeThreadId,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        const batch = r?.messages || [];
        if (!batch.length) break;
        for (const msg of batch) {
          const entry = buildImageEntry(msg);
          if (entry) fullImages.push(entry);
        }
        if (batch.length < PAGE_SIZE) break;
      }
      const mergedImages = dedupeViewerImages(fullImages);
      if (mergedImages.length > 0) {
        setViewerState(prev => {
          const clickedIdx = findViewerIndex(mergedImages, clickedUrl);
          if (clickedIdx >= 0) {
            return { images: mergedImages, index: clickedIdx };
          }
          const prevCurrent = prev?.images?.[prev.index || 0];
          const prevUrl = prevCurrent?.displaySrc || prevCurrent?.src || '';
          const prevIdx = prevUrl ? findViewerIndex(mergedImages, prevUrl) : -1;
          return { images: mergedImages, index: prevIdx >= 0 ? prevIdx : 0 };
        });
      }
    } catch (err) {
      console.error('[openViewer] Failed to load full media gallery:', err);
    }
  }, [activeAccountId, activeThreadId, buildImagesFromCurrentThread, buildImageEntry, dedupeViewerImages, findViewerIndex]);

  if (!activeThreadId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mb-4 opacity-30">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <p className="text-sm">Chọn một hội thoại để bắt đầu</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* ── Loading skeleton — hiển thị khi data chưa sẵn sàng ── */}
      {!threadReady && (
        <div className="flex-1 flex flex-col p-4 space-y-3 animate-pulse">
          {/* Skeleton bubbles */}
          <div className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3 w-20 bg-gray-700 rounded" />
              <div className="h-10 w-52 bg-gray-700 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2 self-end flex-row-reverse">
            <div className="space-y-1.5 items-end flex flex-col">
              <div className="h-10 w-40 bg-blue-900/40 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3 w-16 bg-gray-700 rounded" />
              <div className="h-8 w-64 bg-gray-700 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2 self-end flex-row-reverse">
            <div className="space-y-1.5 items-end flex flex-col">
              <div className="h-12 w-48 bg-blue-900/40 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3 w-24 bg-gray-700 rounded" />
              <div className="h-8 w-36 bg-gray-700 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2 self-end flex-row-reverse">
            <div className="space-y-1.5 items-end flex flex-col">
              <div className="h-10 w-56 bg-blue-900/40 rounded-2xl" />
            </div>
          </div>
          {/* 3 hàng skeleton bổ sung */}
          <div className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3 w-18 bg-gray-700 rounded" />
              <div className="h-9 w-44 bg-gray-700 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2 self-end flex-row-reverse">
            <div className="space-y-1.5 items-end flex flex-col">
              <div className="h-8 w-60 bg-blue-900/40 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3 w-14 bg-gray-700 rounded" />
              <div className="h-11 w-48 bg-gray-700 rounded-2xl" />
            </div>
          </div>
        </div>
      )}

      {/* ── Pinned messages + notes bar — chỉ hiện khi ready ── */}
      {threadReady && activeAccountId && activeThreadId && (
        <div ref={pinnedBarWrapperRef}>
          {(pins.length > 0 || pinnedNotes.length > 0) && (
            <PinnedBar
              zaloId={activeAccountId}
              threadId={activeThreadId}
              pins={pins}
              onPinsChange={setPins}
              onScrollToMsg={handleScrollToMsg}
              pinnedNotes={pinnedNotes}
              onNoteClick={(note) => setNoteModal({ topicId: note.topicId, title: note.title, creatorName: note.creatorName, createTime: note.createTime })}
            />
          )}
        </div>
      )}

      {/* ── Friend request bar (chỉ hiện khi chat 1-1 với người chưa là bạn bè) ── */}
      {threadReady && activeAccountId && activeThreadId && (() => {
        const contact = contactMap.get(activeThreadId);
        const isGroup = contact?.contact_type === 'group' || contact?.contact_type === '1';
        if (isGroup) return null;
        return (
          <FriendRequestBar
            zaloId={activeAccountId}
            userId={activeThreadId}
            contact={contact}
            getAuth={getAuth}
            onReady={() => {
              // Khi FriendRequestBar xuất hiện (async check xong) → thanh bar chiếm thêm chiều cao
              // → cần scroll xuống bottom để không bị đẩy lên
              requestAnimationFrame(() => {
                const el = messagesContainerRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              });
            }}
          />
        );
      })()}

      {/* ── Floating button: cuộn xuống / về tin nhắn mới nhất ── */}
      {threadReady && !atBottom && (
        <div className="absolute bottom-4 right-4 z-20 pointer-events-none">
          <button
            onClick={isViewingHistory ? handleReturnToLatest : () => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
            disabled={loadingLatest}
            className={`pointer-events-auto flex items-center gap-1.5 px-3 py-3 rounded-full shadow-lg text-sm font-medium transition-all disabled:opacity-60 ${
              isViewingHistory
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-gray-700/80 hover:bg-gray-600 text-gray-200'
            }`}
          >
            {loadingLatest ? (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : isViewingHistory ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span>Về tin nhắn mới nhất</span>
              </>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Messages — chỉ render khi threadReady */}
      {threadReady && (
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-1.5">
        {/* Load More Button - Hiển thị trên tin nhắn đầu tiên (cũ nhất) */}
        {msgs.length > 0 && (hasMore || loadError) && (
          <div className="flex justify-center py-3 mb-2">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className={`text-xs px-4 py-2 rounded-full shadow-md transition-all disabled:opacity-50 flex items-center gap-2 ${
                loadError
                  ? 'bg-red-800 text-red-200 hover:bg-red-700'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600 hover:scale-105'
              }`}
            >
              {loadingMore ? (
                <>
                  <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <span>Đang tải...</span>
                </>
              ) : loadError ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  <span>Lỗi — Thử lại</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="18 15 12 9 6 15"/>
                  </svg>
                  <span>Tải tin nhắn cũ hơn</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Empty state — no messages yet */}
        {msgs.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 opacity-60">
            <div className="text-3xl mb-3">💬</div>
            <p className="text-gray-400 text-sm font-medium">Chưa có tin nhắn nào</p>
            <p className="text-gray-500 text-xs mt-1 max-w-xs">
              Tin nhắn chỉ hiển thị từ lúc kết nối. Hãy gửi tin nhắn mới để bắt đầu.
            </p>
          </div>
        )}

        <ChatHistoryList items={msgs} bottomRef={bottomRef} renderItem={(msg, idx) => {
          // Skip non-first images in a group layout batch
          if (groupedSkipIds.has(msg.msg_id)) return null;
          if (pollSkipIds.has(msg.msg_id)) return null;
          if (groupedStickerSkipIds.has(msg.msg_id)) return null;

          const isSent = !!msg.is_sent;
          const prevMsg = idx > 0 ? msgs[idx - 1] : null;
          // nextMsg: skip over non-first group images to find actual next visible msg
          let nextMsg = idx < msgs.length - 1 ? msgs[idx + 1] : null;
          if (nextMsg && groupedSkipIds.has(nextMsg.msg_id)) {
            // Find the first non-skipped message after this group
            const groupMsgsForThis = groupedFirstMsgs[msg.msg_id];
            if (groupMsgsForThis) {
              const lastInGroup = groupMsgsForThis[groupMsgsForThis.length - 1];
              const lastInGroupIdx = msgs.findIndex(m => m.msg_id === lastInGroup.msg_id);
              nextMsg = lastInGroupIdx >= 0 && lastInGroupIdx + 1 < msgs.length ? msgs[lastInGroupIdx + 1] : null;
            }
          }
          if (nextMsg && groupedStickerSkipIds.has(nextMsg.msg_id)) {
            const stickerGroupForThis = groupedStickerFirstMsgs[msg.msg_id];
            if (stickerGroupForThis) {
              const lastInGroup = stickerGroupForThis[stickerGroupForThis.length - 1];
              const lastInGroupIdx = msgs.findIndex(m => m.msg_id === lastInGroup.msg_id);
              nextMsg = lastInGroupIdx >= 0 && lastInGroupIdx + 1 < msgs.length ? msgs[lastInGroupIdx + 1] : null;
            }
          }

          // ── System / group-event notification ─────────────────────────
          if (msg.msg_type === 'system') {
            // Parse updateMembers từ attachments nếu có
            let sysMembers: Array<{id: string; dName: string; avatar: string}> = [];
            try {
              const att = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : (msg.attachments || []);
              if (Array.isArray(att) && att.length > 0 && att[0]?.id) sysMembers = att;
            } catch {}

            // Build inline content — avatar + tên trước mỗi member
            const renderSysContent = () => {
              if (!sysMembers.length) return <>{msg.content}</>;
              let remaining = msg.content as string;
              const parts: React.ReactNode[] = [];
              sysMembers.forEach((m, mi) => {
                const name = m.dName;
                if (!name) return;
                const nameIdx = remaining.indexOf(name);
                if (nameIdx === -1) return;
                // Text trước tên
                if (nameIdx > 0) parts.push(<span key={`pre-${mi}`}>{remaining.slice(0, nameIdx)}</span>);
                // Avatar nhỏ + tên clickable inline
                parts.push(
                  <button
                    key={m.id}
                    onClick={(e) => setUserProfilePopup({ userId: m.id, x: e.clientX, y: e.clientY })}
                    className="inline-flex items-center gap-1 align-middle font-medium text-gray-200 hover:text-white hover:underline transition-colors"
                  >
                    {m.avatar ? (
                      <img src={m.avatar} alt={name} className="w-4 h-4 rounded-full object-cover inline-block flex-shrink-0" onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                    ) : (
                      <span className="w-4 h-4 rounded-full bg-purple-600 inline-flex items-center justify-center text-white flex-shrink-0" style={{fontSize:'8px'}}>
                        {(name || '?').charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span>{name}</span>
                  </button>
                );
                remaining = remaining.slice(nameIdx + name.length);
              });
              if (remaining) parts.push(<span key="tail">{remaining}</span>);
              return <>{parts}</>;
            };

            return (
              <div key={msg.msg_id + idx} className="flex justify-center my-2 px-4">
                <span className="text-xs text-gray-400 bg-gray-700/60 px-3 py-1.5 rounded-full text-center max-w-sm leading-relaxed inline-flex items-center flex-wrap gap-x-0.5 justify-center">
                  {renderSysContent()}
                </span>
              </div>
            );
          }

          const showTime = !prevMsg ||
            (msg.timestamp - prevMsg.timestamp > 30 * 60 * 1000) ||
            prevMsg.sender_id !== msg.sender_id;

          const isLastInRun = !nextMsg || nextMsg.sender_id !== msg.sender_id;

          // Contact/display info — needed for recalled bubble too
          const contact = !isSent ? getContact(msg.sender_id) : null;
          const groupMember = (!isSent && !contact) ? getGroupMember(msg.sender_id) : null;
          const avatarUrl = contact?.avatar_url || groupMember?.avatar || '';
          const displayName = contact?.alias || contact?.display_name || groupMember?.displayName || msg.sender_id;

          const isRecalled = msg.is_recalled === 1 || msg.status === 'recalled' || msg.msg_type === 'recalled';

          // ── Recalled message — dùng RecalledBubble chung với MessageBubbles ─
          if (isRecalled) {
            const isRevealed = revealedRecallIds.has(msg.msg_id);
            const toggleReveal = () => setRevealedRecallIds(prev => {
              const next = new Set(prev);
              if (next.has(msg.msg_id)) next.delete(msg.msg_id);
              else next.add(msg.msg_id);
              return next;
            });

            return (
              <div key={msg.msg_id + idx} id={`msg-${msg.msg_id}`} className={`flex flex-col mb-0.5 ${isSent ? 'items-end' : 'items-start'}`}>
                {showTime && (
                  <div className="flex justify-center w-full my-2">
                    <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">{formatMsgTime(msg.timestamp)}</span>
                  </div>
                )}
                <div className={`flex items-end gap-2 ${isSent ? 'flex-row-reverse' : 'flex-row'}`}>
                  {!isSent && (
                    <div className="w-7 h-7 flex-shrink-0 self-end mb-1">
                      {isLastInRun ? (
                        <button
                          className="w-7 h-7 rounded-full overflow-hidden focus:outline-none hover:ring-2 hover:ring-blue-400 transition-all"
                          title={`Xem thông tin: ${displayName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setUserProfilePopup({ userId: msg.sender_id, x: e.clientX, y: e.clientY });
                          }}
                        >
                          {avatarUrl ? (
                            <img src={avatarUrl} alt={displayName} className="w-7 h-7 rounded-full object-cover" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-white text-xs font-bold">{(displayName || 'U').charAt(0).toUpperCase()}</div>
                          )}
                        </button>
                      ) : <div className="w-7 h-7" />}
                    </div>
                  )}
                  <RecalledBubble
                    msg={msg}
                    isSelf={isSent}
                    displayName={displayName}
                    isRevealed={isRevealed}
                    onToggleReveal={toggleReveal}
                  />
                </div>
              </div>
            );
          }

          // OPTIMIZATION: Dùng cache thay vì parse lại type cho mỗi message
          const cached = msgTypeCache.get(msg.msg_id);
          const isCardMsg = cached?.isCard ?? isCardType(msg.msg_type, msg.content);
          const isEcardMsg = cached?.isEcard ?? isEcardType(msg.msg_type);
          const isStickerMsg = cached?.isSticker ?? isStickerType(msg.msg_type);
          const isRtf = cached?.isRtf ?? isRtfMsg(msg.msg_type, msg.content);
          const isPollMsg = cached?.isPoll ?? (msg.msg_type === 'group.poll');
          const isVideoMsg = cached?.isVideo ?? isVideoType(msg.msg_type);
          const isVoiceMsg = cached?.isVoice ?? (msg.msg_type === 'chat.voice');
          const isBankCardMsg = isBankCardType(msg.msg_type, msg.content);
          const isGroupMedia = cached?.isGroupMedia ?? (!isPollMsg && !isVideoMsg && !isVoiceMsg && !!groupedFirstMsgs[msg.msg_id]);
          const groupMediaMsgs = isGroupMedia ? groupedFirstMsgs[msg.msg_id] : null;
          const isMediaMsg = cached?.isMedia ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isGroupMedia && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && isMediaType(msg.msg_type, msg.content));
          const isFileMsg = cached?.isFile ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isMediaMsg && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && isFileType(msg.msg_type, msg.content));
          const content = cached?.content ?? (isMediaMsg || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isGroupMedia || isRtf || isPollMsg || isVideoMsg || isVoiceMsg || isBankCardMsg ? '' : parseContent(msg.content));

          // Sticker nhóm: nhiều sticker liền nhau từ cùng người gửi trong 30 phút
          const isGroupedStickerFirst = isStickerMsg && !!groupedStickerFirstMsgs[msg.msg_id];
          const groupStickerMsgs = isGroupedStickerFirst ? groupedStickerFirstMsgs[msg.msg_id] : null;


          // Reactions: parse new PHP-like format or legacy format
          const reactionCounts = parseReactions(msg.reactions);
          const hasReactions = Object.keys(reactionCounts).length > 0;

          return (
            <div key={msg.msg_id + idx} id={`msg-${msg.msg_id}`} className={`flex flex-col mb-0.5 rounded-lg ${isEcardMsg ? 'items-center' : isSent ? 'items-end' : 'items-start'} group/msg`}>
              {showTime && (
                <div className="flex justify-center w-full my-2">
                  <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
                    {formatMsgTime(msg.timestamp)}
                  </span>
                </div>
              )}

              {/* Outer row: bubble + action buttons */}
              <div className={`flex items-end gap-1 ${isEcardMsg ? 'w-full justify-center' : isSent ? 'flex-row-reverse' : 'flex-row'}`} style={{ maxWidth: '100%' }}>
                {/* Bubble area */}
                <div
                  className={`flex items-end gap-2 min-w-0 ${isEcardMsg ? 'w-full' : isSent ? 'flex-row-reverse' : 'flex-row'}`}
                  onContextMenu={(e) => {
                    if (isEcardMsg) return;
                    if (isGroupedStickerFirst) return; // Mỗi sticker trong nhóm tự xử lý context menu
                    // Nếu người dùng đang chọn text → để browser xử lý (copy tự nhiên)
                    const sel = window.getSelection();
                    if (sel && sel.toString().length > 0) return;
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, msg, isSent, isGroupAdmin });
                  }}
                >
                  {!isSent && !isEcardMsg && (
                    <div className="w-7 h-7 flex-shrink-0 self-end mb-1">
                      {isLastInRun ? (
                        <button
                          className="w-7 h-7 rounded-full overflow-hidden focus:outline-none hover:ring-2 hover:ring-blue-400 transition-all"
                          title={`Xem thông tin: ${displayName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setUserProfilePopup({ userId: msg.sender_id, x: e.clientX, y: e.clientY });
                          }}
                        >
                          {avatarUrl ? (
                            <img src={avatarUrl} alt={displayName} className="w-7 h-7 rounded-full object-cover" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold">
                              {(displayName || 'U').charAt(0).toUpperCase()}
                            </div>
                          )}
                        </button>
                      ) : (
                        <div className="w-7 h-7" />
                      )}
                    </div>
                  )}

                  {/* Employee avatar on right side — every message with handled_by_employee */}
                  {isSent && !isEcardMsg && (() => {
                    const empId = msg.handled_by_employee;
                    if (!empId) return null;
                    const empStore = useEmployeeStore.getState();
                    const emp = empStore.employees.find((e: any) => e.employee_id === empId);
                    const empName = emp?.display_name || empStore.employeeNameMap[empId] || 'NV';
                    const empAvatar = emp?.avatar_url || empStore.employeeAvatarMap[empId] || '';
                    return (
                      <div className="w-6 h-6 flex-shrink-0 self-end mb-0.5" title={`Gửi bởi: ${empName}`}>
                        {empAvatar ? (
                          <img src={empAvatar} alt={empName} className="w-6 h-6 rounded-full object-cover ring-1 ring-purple-500/40" />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-purple-600/30 flex items-center justify-center text-purple-300 text-[10px] font-bold ring-1 ring-purple-500/40">
                            {(empName || 'N').charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div className={`flex flex-col ${isEcardMsg ? 'w-full items-center' : isSent ? 'items-end' : 'items-start'} relative min-w-0${hasReactions && !isGroupedStickerFirst ? ' mb-3' : ''}`}>
                    {/* Sender name in group chats */}
                    {!isSent && !isEcardMsg && msg.thread_type === 1 && showTime && displayName && displayName !== msg.sender_id && (
                      <p className="text-xs text-gray-400 mb-0.5 px-1 truncate max-w-full">{displayName}</p>
                    )}
                    <div className={`rounded-2xl text-sm break-words min-w-0 overflow-hidden ${
                      isMediaMsg || isGroupMedia || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isBankCardMsg ? '' : isSent
                        ? 'px-3 py-2 bg-blue-600 text-white rounded-br-sm'
                        : 'px-3 py-2 bg-gray-700 text-gray-200 rounded-bl-sm'
                    }`}>
                    {/* Quote preview */}
                    {msg.quote_data && (() => {
                      try {
                        const q = JSON.parse(msg.quote_data);

                        //  Ưu tiên imageUrl đã lưu, sau đó extract từ msg/attach
                        const quotedImgUrl = q.imageUrl || extractQuoteImage(q.msg, q.attach, q.msgType);
                        // Nếu vẫn không có URL, tìm trong danh sách tin nhắn theo msgId
                        let lookupImgUrl = '';
                        // Khi q.msg rỗng (ví dụ Zalo gửi TQuote với msg="" cho chat.recommended/cliMsgType=38)
                        // → tìm tin nhắn gốc để lấy content hiển thị
                        let lookupContent = '';
                        // Content của sticker gốc (để QuotedStickerPreview tải ảnh)
                        let quotedStickerContent = '';
                        const isQuotedSticker = q.msgType === 'chat.sticker';

                        if (q.msgId) {
                          const origMsg = msgs.find(m => m.msg_id === String(q.msgId));
                          if (origMsg) {
                            if (!quotedImgUrl && isMediaType(origMsg.msg_type, origMsg.content)) {
                              lookupImgUrl = extractMediaUrl(origMsg);
                            }
                            // Lấy content từ tin nhắn gốc nếu q.msg rỗng
                            if (!q.msg && origMsg.content) {
                              lookupContent = origMsg.content;
                            }
                            // Lấy content sticker từ tin gốc (kể cả nếu trong groupedStickerSkipIds)
                            if (isQuotedSticker && origMsg.content) {
                              quotedStickerContent = origMsg.content;
                            }
                          }
                        }
                        // Fallback sticker content từ q.attach hoặc q.msg
                        if (isQuotedSticker && !quotedStickerContent) {
                          quotedStickerContent = typeof q.attach === 'string'
                            ? q.attach
                            : (q.attach ? JSON.stringify(q.attach) : (q.msg || ''));
                        }
                        const finalImgUrl = quotedImgUrl || lookupImgUrl;
                        // Dùng lookupContent để parse quote nếu q.msg rỗng
                        const effectiveMsgForQuote = q.msg || lookupContent;

                        // Luôn tính quoteDisplayText (dùng làm fallback khi ảnh không tải được)
                        let quoteDisplayText = '';
                        {
                          const parsedText = parseQuoteMsg(effectiveMsgForQuote, q.msgType);
                          if (parsedText) {
                            quoteDisplayText = parsedText;
                          } else {
                            // Fallback dựa trên msgType nếu có
                            if (q.msgType === 'photo' || q.msgType === 'image' || q.msgType === 'chat.photo') {
                              quoteDisplayText = '[Hình ảnh]';
                            } else if (q.msgType === 'chat.video.msg') {
                              quoteDisplayText = '[Video]';
                            } else if (q.msgType === 'chat.sticker') {
                              quoteDisplayText = '[Sticker]';
                            } else if (q.msgType === 'chat.recommended' || q.msgType === 'chat.link') {
                              quoteDisplayText = '🔗 [Link]';
                            } else if (['share.file', 'share.link', 'file'].includes(q.msgType)) {
                              quoteDisplayText = '[File/Link]';
                            } else if (q.msgType === 'chat.todo') {
                              quoteDisplayText = '[Todo]';
                            } else if (q.msgType === 'chat.poll') {
                              quoteDisplayText = '[Bình chọn]';
                            } else if (q.msgType === 'chat.webcontent') {
                              quoteDisplayText = '🏦 [Tài khoản ngân hàng]';
                            } else {
                              quoteDisplayText = '[Tin nhắn]';
                            }
                          }
                        }
                        
                        return (
                          <div
                            className={`border-l-2 ${isSent ? 'border-blue-300 bg-blue-500/20' : 'border-gray-400 bg-gray-600/50'} rounded pl-2 pr-1 py-1 mb-1 text-xs opacity-90 cursor-pointer hover:opacity-100 overflow-hidden min-w-0 max-w-full`}
                            onClick={() => q.msgId && handleScrollToMsg(String(q.msgId))}
                          >
                            {q.fromD && <p className={`font-semibold truncate ${isSent ? 'text-blue-100' : 'text-gray-200'}`}>{q.fromD}</p>}
                            {isQuotedSticker ? (
                              <QuotedStickerPreview content={quotedStickerContent} />
                            ) : finalImgUrl ? (
                              <img
                                src={finalImgUrl}
                                alt="ảnh trích dẫn"
                                className="max-w-[120px] max-h-[80px] rounded object-cover mt-1"
                                onError={(e) => {
                                  const imgEl = e.target as HTMLImageElement;
                                  imgEl.style.display = 'none';
                                  // Hiện fallback text khi ảnh không tải được
                                  const next = imgEl.nextElementSibling as HTMLElement | null;
                                  if (next) next.style.display = '';
                                }}
                              />
                            ) : null}
                            <p
                              className="opacity-80 line-clamp-2 break-words whitespace-pre-wrap"
                              style={(finalImgUrl || isQuotedSticker) ? { display: 'none' } : undefined}
                            >
                              {quoteDisplayText}
                            </p>
                          </div>
                        );
                      } catch { return null; }
                    })()}

                    <SharedMessageContent
                      msg={msg}
                      isSelf={isSent}
                      senderName={!isSent ? displayName : undefined}
                      onManage={() => setManageGroupOpen(true)}
                      onView={openViewer}
                      onOpenProfile={(userId, e) => setUserProfilePopup({ userId, x: e.clientX, y: e.clientY })}
                      isGroupMedia={isGroupMedia}
                      isPoll={isPollMsg}
                      isVideo={isVideoMsg}
                      isVoice={isVoiceMsg}
                      isFile={isFileMsg}
                      isMedia={isMediaMsg}
                      isCard={isCardMsg}
                      isEcard={isEcardMsg}
                      isSticker={isStickerMsg}
                      isRtf={isRtf}
                      isBankCard={isBankCardMsg}
                      renderGroupMedia={() => <MediaGroupBubble msgs={groupMediaMsgs!} onView={openViewer} />}
                      renderPoll={() => (
                        <PollBubble msg={msg} isSent={isSent} activeAccountId={activeAccountId || ''} threadId={activeThreadId || ''} />
                      )}
                      renderVideo={() => <VideoBubble msg={msg} isSent={isSent} />}
                      renderVoice={() => <VoiceBubble msg={msg} isSent={isSent} />}
                      renderFile={() => <FileBubble msg={msg} isSent={isSent} />}
                      renderMedia={() => (
                        <MediaBubble msg={msg} onView={openViewer} isSent={isSent}
                          allContacts={contactList} groupMembersList={groupMembers}
                          onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
                      )}
                      renderCard={() => (
                        <CardBubble
                          msg={msg}
                          isSent={isSent}
                          onOpenProfile={(userId, e) => setUserProfilePopup({ userId, x: e.clientX, y: e.clientY })}
                        />
                      )}
                      renderBankCard={() => <BankCardBubble msg={msg} />}
                      renderEcard={() => <EcardBubble msg={msg} onManage={() => setManageGroupOpen(true)} />}
                      renderSticker={() => isGroupedStickerFirst
                        ? <StickerGroupBubble
                            msgs={groupStickerMsgs!}
                            onContextMenu={(e, stickerMsg) => {
                              e.preventDefault();
                              setContextMenu({ x: e.clientX, y: e.clientY, msg: stickerMsg, isSent, isGroupAdmin });
                            }}
                          />
                        : <StickerBubble msg={msg} />
                      }
                      renderRtf={() => (
                        <RtfBubble msg={msg} allContacts={contactList} groupMembersList={groupMembers}
                          onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
                      )}
                      renderText={() => (
                        <TextWithMentions text={content} allContacts={contactList} groupMembersList={groupMembers}
                          highlight={searchHighlightQuery}
                          onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
                      )}
                    />
                  </div>


                  {/* Single reaction button — position absolute at bottom corner (side matching bubble alignment) */}
                  {!isEcardMsg && !isGroupedStickerFirst && (() => {
                    const rFull = parseReactionsFull(msg.reactions);
                    const myEmoji = activeAccountId
                      ? (Object.entries(rFull.emoji || {}).find(([, d]) => (d as any).users?.[activeAccountId] > 0)?.[0] || null)
                      : null;
                    const totalReactions = hasReactions ? Object.values(reactionCounts).reduce((a, b) => a + b, 0) : 0;
                    const sortedEmojis = hasReactions
                      ? Object.entries(reactionCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e)
                      : [];
                    return (
                      <div
                        className={`absolute -bottom-3 z-10 transition-opacity duration-100${!hasReactions ? ' opacity-0 group-hover/msg:opacity-100' : ''}${isSent ? ' right-0' : ' left-0'}`}
                        onMouseEnter={() => setReactionPickerMsgId(msg.msg_id)}
                        onMouseLeave={() => setReactionPickerMsgId(null)}
                      >
                        {/* Emoji picker — appears above on hover, always opens toward center */}
                        {reactionPickerMsgId === msg.msg_id && (
                          <div className={`absolute bottom-full flex flex-col bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl z-30 p-1.5${isSent ? ' right-0' : ' left-0'}`}>
                            <div className="flex items-center gap-0.5">
                              {(['❤️', '😄', '😮', '😢', '😡', '👍'] as const).map((e) => (
                                <button key={e}
                                  onClick={() => { handleReact(msg, e); setReactionPickerMsgId(null); }}
                                  className={`text-xl p-1 rounded-lg hover:bg-gray-700 hover:scale-125 transition-all ${myEmoji === e ? 'bg-gray-700 ring-1 ring-blue-400' : ''}`}
                                  title={e}>{e}</button>
                              ))}
                            </div>
                            {myEmoji && (
                              <button
                                onClick={() => { handleCancelReaction(msg); setReactionPickerMsgId(null); }}
                                className="mt-1.5 w-full text-xs py-1 px-2 rounded-full bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white transition-colors text-center"
                              >✕ Huỷ reaction</button>
                            )}
                          </div>
                        )}
                        {/* Button: reaction badge when reacted, 👍 when not */}
                        {hasReactions ? (
                          <button
                            onClick={() => setReactionPopup({ msg, activeEmoji: 'all' })}
                            className="flex items-center gap-0.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-full px-1.5 py-0.5 text-xs shadow-sm select-none transition-colors"
                          >
                            {sortedEmojis.map(e => <span key={e}>{e}</span>)}
                            {totalReactions > 1 && <span className="text-gray-300 ml-0.5 text-[11px]">{totalReactions}</span>}
                          </button>
                        ) : (
                          <button
                            className="w-6 h-6 bg-gray-800 hover:bg-gray-700 border border-gray-600 rounded-full flex items-center justify-center text-sm shadow-sm transition-colors"
                            title="Thả cảm xúc"
                          >👍</button>
                        )}
                      </div>
                    );
                  })()}
                  </div>{/* end flex flex-col (bubble content column) */}
                </div>{/* end bubble area (flex items-end gap-2) */}

                {/* Hover action buttons — visible on msg hover, outside bubble */}
                {!isEcardMsg && !isGroupedStickerFirst && (
                <div className="flex items-center gap-0.5 self-end mb-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100 flex-shrink-0 flex-nowrap">
                  {/* Reply */}
                  <MsgActionBtn title="Trả lời" onClick={() => setReplyTo(msg)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
                    </svg>
                  </MsgActionBtn>
                  {/* Forward */}
                  {/*<MsgActionBtn title="Chuyển tiếp" onClick={() => handleForward(msg)}>*/}
                  {/*  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">*/}
                  {/*    <polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>*/}
                  {/*  </svg>*/}
                  {/*</MsgActionBtn>*/}
                  {/* More */}
                  <MsgActionBtn title="Thêm" onClick={(e) => { (e as React.MouseEvent).stopPropagation(); setContextMenu({ x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY, msg, isSent, isGroupAdmin }); }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
                    </svg>
                  </MsgActionBtn>
                </div>
                )}
              </div>{/* end outer row */}

            </div>
          );
        }} />
      </div>
      )}

      {/* Typing indicator — hiển thị phía trên input, không chồng lên nội dung */}
      {threadReady && activeAccountId && activeThreadId && typingNow > 0 && (() => {
        const prefix = `${activeAccountId}_${activeThreadId}_`;
        const nowTs = Date.now();
        const typingEntries = Object.entries(typingUsers).filter(
          ([k, ts]) => k.startsWith(prefix) && nowTs - ts < 5000
        );
        if (!typingEntries.length) return null;

        const groupCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
        const contactList = contacts[activeAccountId] || [];

        const resolveName = (uid: string): string => {
          const c = contactList.find(x => x.contact_id === uid);
          if (c?.alias) return c.alias;
          if (c?.display_name && c.display_name !== uid) return c.display_name;
          const m = groupCache?.members?.find((x: any) => x.userId === uid);
          if (m?.displayName) return m.displayName;
          return uid;
        };

        const typingUids = typingEntries.map(([k]) => k.replace(prefix, ''));
        const names = typingUids.map(resolveName);
        const nameText = names.length === 1
          ? `${names[0]} đang nhập...`
          : names.length === 2
            ? `${names[0]}, ${names[1]} đang nhập...`
            : `${names[0]}, ${names[1]} và ${names.length - 2} người khác đang nhập...`;

        const firstUid = typingUids[0];
        const firstContact = contactList.find(c => c.contact_id === firstUid);
        const firstAvatar = firstContact?.avatar_url || '';
        const firstInitial = (resolveName(firstUid) || '?').charAt(0).toUpperCase();

        return (
          <div className="flex items-center gap-1.5 px-4 py-1.5 flex-shrink-0 pointer-events-none">
            {firstAvatar ? (
              <img src={firstAvatar} className="w-4 h-4 rounded-full object-cover flex-shrink-0 opacity-80" alt="" />
            ) : (
              <div className="w-4 h-4 rounded-full bg-gray-600 flex items-center justify-center text-white flex-shrink-0 opacity-80" style={{ fontSize: '9px' }}>
                {firstInitial}
              </div>
            )}
            <div className="flex items-center gap-1.5 bg-gray-800/90 backdrop-blur-sm border border-gray-700/60 rounded-full px-2.5 py-1 shadow-md">
              <div className="flex items-center gap-0.5">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-[11px] text-gray-400 italic leading-none">{nameText}</span>
            </div>
          </div>
        );
      })()}

      {/* Seen indicator for sent messages */}
      {threadReady && activeAccountId && activeThreadId && (() => {
        const key = `${activeAccountId}_${activeThreadId}`;
        const seen = seenInfo[key];
        if (!seen || !seen.seenUids?.length) return null;

        // Lấy thông tin người đã seen
        const groupCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
        const allContacts = contacts[activeAccountId] || [];

        interface SeenUser { userId: string; name: string; avatar: string; }
        const seenUsers: SeenUser[] = seen.seenUids.map((uid: string) => {
          // Thử tìm trong group members
          const member = groupCache?.members?.find((m: any) => m.userId === uid);
          if (member) return { userId: uid, name: member.displayName || uid, avatar: member.avatar || '' };
          // Thử tìm trong contacts list
          const contact = allContacts.find(c => c.contact_id === uid);
          if (contact) return { userId: uid, name: contact.alias || contact.display_name || uid, avatar: contact.avatar_url || '' };
          return { userId: uid, name: uid, avatar: '' };
        });

        const MAX_SHOW = 5;
        const shown = seenUsers.slice(0, MAX_SHOW);
        const extra = seenUsers.length - MAX_SHOW;

        return (
          <div className="px-4 pb-2 flex justify-end items-center gap-1.5">
            <span className="text-[11px] text-gray-500 mr-0.5">Đã xem</span>
            <div className="flex items-center -space-x-1">
              {shown.map((u) => (
                <div key={u.userId} title={u.name} className="w-4 h-4 rounded-full ring-1 ring-gray-800 overflow-hidden flex-shrink-0">
                  {u.avatar ? (
                    <img src={u.avatar} alt={u.name} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <div className="w-full h-full bg-blue-500 flex items-center justify-center text-white" style={{ fontSize: '7px', fontWeight: 700 }}>
                      {(u.name).charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
              ))}
              {extra > 0 && (
                <div className="w-4 h-4 rounded-full ring-1 ring-gray-800 bg-gray-600 flex items-center justify-center text-white" style={{ fontSize: '7px' }}>
                  +{extra}
                </div>
              )}
            </div>
          </div>
        );
      })()}


      {viewerState && (
        <MediaViewer
          images={viewerState.images}
          initialIndex={viewerState.index}
          zaloId={activeAccountId || undefined}
          onClose={() => setViewerState(null)}
        />
      )}

      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          msg={contextMenu.msg}
          isSent={contextMenu.isSent}
          isGroupAdmin={contextMenu.isGroupAdmin}
          onClose={() => setContextMenu(null)}
          onReply={(m) => setReplyTo(m)}
          onForward={(m) => { setForwardMsg(m); }}
          onUndo={handleUndo}
          onDelete={handleDelete}
          onDeleteFromDb={handleDeleteFromDb}
          onReact={handleReact}
          onPin={handlePin}
          showNotification={showNotification}
        />
      )}

      {/* Forward message modal */}
      {forwardMsg && (
        <ForwardMessageModal
          msg={forwardMsg}
          contacts={contactList}
          onClose={() => setForwardMsg(null)}
          onForward={async (threadId, threadType) => {
            const auth = getAuth();
            if (!auth) return;
            const msgType = forwardMsg.msg_type || '';
            const content = forwardMsg.content || '';
            const msgIsFile = isFileType(msgType, content);
            const msgIsImage = !msgIsFile && isMediaType(msgType, content);
            try {
              if (msgIsFile) {
                // Forward file: need local copy
                let localPath = '';
                try {
                  const lp = typeof forwardMsg.local_paths === 'string' ? JSON.parse(forwardMsg.local_paths || '{}') : (forwardMsg.local_paths || {});
                  localPath = lp.file || lp.main || '';
                } catch {}
                if (!localPath) {
                  showNotification('File chưa tải về — không thể chuyển tiếp', 'error');
                  return;
                }
                await ipc.zalo?.sendFile({ auth, filePath: localPath, threadId, type: threadType });
              } else if (msgIsImage) {
                // Forward image: need local copy
                let localPath = '';
                try {
                  const lp = typeof forwardMsg.local_paths === 'string' ? JSON.parse(forwardMsg.local_paths || '{}') : (forwardMsg.local_paths || {});
                  localPath = lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
                } catch {}
                if (!localPath) {
                  showNotification('Ảnh chưa tải về — không thể chuyển tiếp', 'error');
                  return;
                }
                await ipc.zalo?.sendImage({ auth, filePath: localPath, threadId, type: threadType, message: '' });
              } else {
                // Text message: use forwardMessage API
                let textContent = content;
                try {
                  const parsed = JSON.parse(content);
                  if (typeof parsed === 'string') textContent = parsed;
                  else if (parsed?.msg && typeof parsed.msg === 'string') textContent = parsed.msg;
                  else if (parsed?.message && typeof parsed.message === 'string') textContent = parsed.message;
                  else if (parsed?.content && typeof parsed.content === 'string') textContent = parsed.content;
                } catch {}
                const messagePayload = JSON.stringify({ data: { content: textContent } });
                await ipc.zalo?.forwardMessage({ auth, message: messagePayload, threadIds: [threadId], type: threadType });
              }
              showNotification('Đã chuyển tiếp tin nhắn', 'success');
            } catch (e: any) {
              showNotification('Chuyển tiếp thất bại: ' + e.message, 'error');
            }
            setForwardMsg(null);
          }}
        />
      )}

      {/* Reaction context menu (right-click on reaction pill) */}
      {reactionContextMenu && (
        <ReactionContextMenu
          x={reactionContextMenu.x}
          y={reactionContextMenu.y}
          msg={reactionContextMenu.msg}
          myEmoji={reactionContextMenu.myEmoji}
          onClose={() => setReactionContextMenu(null)}
          onReact={(msg, emoji) => { handleReact(msg, emoji); setReactionContextMenu(null); }}
          onCancel={(msg) => { handleCancelReaction(msg); setReactionContextMenu(null); }}
        />
      )}

      {/* Reaction popup: xem ai thả cảm xúc */}
      {reactionPopup && (
        <ReactionPopup
          msg={reactionPopup.msg}
          initialEmoji={reactionPopup.activeEmoji}
          contacts={contactList}
          groupMembers={groupMembers}
          currentUserId={activeAccountId || ''}
          onClose={() => setReactionPopup(null)}
        />
      )}

      {/* User profile popup */}
      {userProfilePopup && (
        <UserProfilePopup
          userId={userProfilePopup.userId}
          anchorX={userProfilePopup.x}
          anchorY={userProfilePopup.y}
          contacts={contactList}
          activeAccountId={activeAccountId || ''}
          activeThreadId={activeThreadId}
          onClose={() => setUserProfilePopup(null)}
        />
      )}

      {/* Manage group modal — mở từ nút "Quản lý nhóm" trong EcardBubble */}
      {manageGroupOpen && activeThreadId && activeAccountId && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setManageGroupOpen(false); }}
        >
          <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-[380px] max-h-[80vh] flex flex-col overflow-hidden">
            <ManagePanel
              groupInfo={(groupInfoCache[activeAccountId] || {})[activeThreadId] || null}
              groupId={activeThreadId}
              onBack={() => setManageGroupOpen(false)}
              myAccountId={activeAccountId}
              asModal
            />
          </div>
        </div>
      )}

      {/* Note view modal — mở khi click vào ghi chú đã ghim */}
      {noteModal && activeThreadId && activeAccountId && (
        <NoteViewModal
          topicId={noteModal.topicId}
          initialTitle={noteModal.title || ''}
          groupId={activeThreadId}
          creatorName={noteModal.creatorName}
          createTime={noteModal.createTime}
          isGroup={!!contactMap.get(activeThreadId) && (contactMap.get(activeThreadId)?.contact_type === 'group' || contactMap.get(activeThreadId)?.contact_type === '1')}
          activeAccountId={activeAccountId}
          onClose={() => setNoteModal(null)}
          onNotePinned={(note) => {
            // Save to DB so it persists across restarts
            ipc.db?.pinMessage({
              zaloId: activeAccountId,
              threadId: activeThreadId,
              pin: {
                msgId: `note_${note.topicId}`,
                msgType: 'note',
                content: JSON.stringify({ topicId: note.topicId, title: note.title, creatorId: note.creatorId, createTime: note.createTime }),
                previewText: note.title,
                previewImage: '',
                senderId: note.creatorId || '',
                senderName: note.creatorName || '',
                timestamp: note.createTime || Date.now(),
              },
            }).catch(() => {});
            setPinnedNotes(prev => {
              const filtered = prev.filter(n => n.topicId !== note.topicId);
              return [note, ...filtered];
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────


/** PollBubble — hiển thị tin nhắn group.poll */
function PollBubble({ msg, isSent, activeAccountId, threadId }: { msg: any; isSent: boolean; activeAccountId: string; threadId: string }) {
  const [pollDetail, setPollDetail] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const contacts = useChatStore(s => s.contacts[activeAccountId] || []);
  const { showNotification, groupInfoCache } = useAppStore();
  const rawGroupMembers: any[] = groupInfoCache?.[activeAccountId]?.[threadId]?.members || [];
  // Merge contacts + group members → đủ thông tin voter (tên + avatar)
  const allContacts = React.useMemo(() => {
    const map = new Map<string, any>();
    contacts.forEach((c: any) => map.set(String(c.contact_id), c));
    rawGroupMembers.forEach((m: any) => {
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
  }, [contacts, rawGroupMembers]);

  let pollId = '';
  let question = '';
  let voterName = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    pollId = String(params.pollId || '');
    question = params.question || parsed.title || '';
    voterName = params.dName || '';
  } catch {}

  const getAuth = async () => {
    const accRes = await ipc.login?.getAccounts();
    const acc = accRes?.accounts?.find((a: any) => a.zalo_id === activeAccountId) || accRes?.accounts?.[0];
    if (!acc) throw new Error('No account');
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  const loadDetail = async () => {
    if (!pollId || loading) return;
    setLoading(true);
    try {
      const auth = await getAuth();
      const res = await ipc.zalo?.getPollDetail({ auth, pollId });
      if (res?.success && res.response) setPollDetail(res.response);
    } catch {} finally { setLoading(false); }
  };

  React.useEffect(() => {
    if (expanded && !pollDetail && pollId) loadDetail();
  }, [expanded]);

  return (
    <div className={`rounded-2xl overflow-hidden min-w-[260px] max-w-sm ${isSent ? 'bg-blue-600' : 'bg-gray-700'}`}>
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isSent ? 'bg-blue-500' : 'bg-[#2a2f42]'}`}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={isSent ? 'text-blue-100' : 'text-purple-400'}>
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/><line x1="8" y1="17" x2="11" y2="17"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-[11px] font-bold uppercase tracking-widest mb-0.5 ${isSent ? 'text-blue-200' : 'text-purple-400'}`}>BÌNH CHỌN</p>
          <p className={`text-sm font-semibold leading-tight ${isSent ? 'text-white' : 'text-gray-100'}`}>{question || 'Cuộc bình chọn'}</p>
        </div>
      </div>

      {/* Voter info */}
      {voterName && (
        <div className={`px-3 pb-2 text-xs ${isSent ? 'text-blue-200' : 'text-gray-400'}`}>
          {voterName} đã bình chọn
        </div>
      )}

      {/* Expand/collapse toggle */}
      <button
        onClick={() => setExpanded(v => !v)}
        className={`w-full px-3 py-2 text-xs font-semibold flex items-center justify-between border-t transition-colors ${
          isSent ? 'border-blue-500 text-blue-100 hover:bg-blue-700' : 'border-gray-600 text-gray-300 hover:bg-gray-600'
        }`}
      >
        <span>{expanded ? 'Thu gọn' : 'Xem bình chọn'}</span>
        {loading
          ? <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
          : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points={expanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}/>
            </svg>
        }
      </button>

      {/* Poll detail — dùng shared component */}
      {expanded && pollDetail && (
        <SharedPollDetailView
          detail={pollDetail}
          activeAccountId={activeAccountId}
          pollId={pollId}
          getAuth={getAuth}
          onRefresh={loadDetail}
          theme={isSent ? 'blue' : 'dark'}
          contacts={allContacts}
          showLockButton={true}
          showAddOption={true}
          onNotify={(m, t) => showNotification(m, t)}
        />
      )}
      {expanded && !loading && !pollDetail && (
        <p className={`px-3 py-2 text-xs ${isSent ? 'text-blue-200' : 'text-gray-500'}`}>Không thể tải chi tiết</p>
      )}
    </div>
  );
}


/** CreatePollDialog — tạo cuộc bình chọn mới trong nhóm */
export function CreatePollDialog({ groupId, activeAccountId, onClose }: {
  groupId: string; activeAccountId: string; onClose: () => void;
}) {
  const [question, setQuestion] = React.useState('');
  const [options, setOptions] = React.useState(['', '']);
  const [expiredTime, setExpiredTime] = React.useState('');
  const [allowMulti, setAllowMulti] = React.useState(true);
  const [allowAdd, setAllowAdd] = React.useState(true);
  const [hidePreview, setHidePreview] = React.useState(false);
  const [isAnon, setIsAnon] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const { showNotification } = useAppStore();

  const setOption = (i: number, val: string) => setOptions(prev => prev.map((o, idx) => idx === i ? val : o));
  const addOption = () => { if (options.length < 20) setOptions(prev => [...prev, '']); };
  const removeOption = (i: number) => { if (options.length > 2) setOptions(prev => prev.filter((_, idx) => idx !== i)); };

  const handleCreate = async () => {
    const q = question.trim();
    const opts = options.map(o => o.trim()).filter(Boolean);
    if (!q) { showNotification('Vui lòng nhập câu hỏi bình chọn', 'error'); return; }
    if (opts.length < 2) { showNotification('Cần ít nhất 2 lựa chọn', 'error'); return; }
    setCreating(true);
    try {
      const accRes = await ipc.login?.getAccounts();
      const acc = accRes?.accounts?.find((a: any) => a.zalo_id === activeAccountId) || accRes?.accounts?.[0];
      if (!acc) throw new Error('No account');
      const expMs = expiredTime ? new Date(expiredTime).getTime() : 0;
      const res = await ipc.zalo?.createPoll({
        auth: { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent },
        options: {
          question: q,
          options: opts,
          expiredTime: expMs,
          allowMultiChoices: allowMulti,
          allowAddNewOption: allowAdd,
          hideVotePreview: hidePreview,
          isAnonymous: isAnon,
        },
        groupId,
      });
      if (res?.success) {
        showNotification('Đã tạo bình chọn', 'success');
        onClose();
      } else {
        showNotification('Tạo bình chọn thất bại: ' + (res?.error || 'Lỗi không xác định'), 'error');
      }
    } catch (e: any) {
      showNotification('Lỗi: ' + e.message, 'error');
    } finally { setCreating(false); }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#1e2535] rounded-2xl shadow-2xl border border-gray-700 w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-shrink-0">
          <h2 className="text-white font-bold text-lg">Tạo bình chọn</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: question + options */}
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-300 font-medium mb-1.5 block">Chủ đề bình chọn</label>
                <textarea
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  maxLength={200}
                  placeholder="Đặt câu hỏi bình chọn"
                  rows={3}
                  className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                />
                <p className="text-right text-xs text-gray-500 mt-0.5">{question.length}/200</p>
              </div>

              <div>
                <label className="text-sm text-gray-300 font-medium mb-1.5 block">Các lựa chọn</label>
                <div className="space-y-2">
                  {options.map((opt, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={opt}
                        onChange={e => setOption(i, e.target.value)}
                        placeholder={`Lựa chọn ${i + 1}`}
                        className="flex-1 bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                      />
                      {options.length > 2 && (
                        <button onClick={() => removeOption(i)}
                          className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-red-400 transition-colors">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {options.length < 20 && (
                  <button onClick={addOption}
                    className="mt-2 flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Thêm lựa chọn
                  </button>
                )}
              </div>
            </div>

            {/* Right: settings */}
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-300 font-medium mb-1.5 block">Thời hạn bình chọn</label>
                <div className="relative">
                  <DateInputVN
                    type="datetime-local"
                    value={expiredTime}
                    onChange={e => setExpiredTime(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    placeholder="Không thời hạn"
                    className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                  {expiredTime && (
                    <button onClick={() => setExpiredTime('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  )}
                </div>
                {!expiredTime && <p className="text-xs text-gray-500 mt-1">Không giới hạn thời gian</p>}
              </div>

              <div>
                <p className="text-sm text-gray-300 font-medium mb-2">Thiết lập nâng cao</p>
                <div className="space-y-2.5">
                  <PollToggle label="Chọn nhiều phương án" checked={allowMulti} onChange={setAllowMulti} />
                  <PollToggle label="Có thể thêm phương án" checked={allowAdd} onChange={setAllowAdd} />
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-300 font-medium mb-2">Bình chọn ẩn danh</p>
                <div className="space-y-2.5">
                  <PollToggle label="Ẩn kết quả khi chưa bình chọn" checked={hidePreview} onChange={setHidePreview} />
                  <PollToggle label="Ẩn người bình chọn" checked={isAnon} onChange={setIsAnon} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-700 flex-shrink-0">
          <button onClick={onClose}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-gray-300 hover:bg-gray-700 transition-colors">
            Huỷ
          </button>
          <button onClick={handleCreate} disabled={creating || !question.trim() || options.filter(o => o.trim()).length < 2}
            className="px-5 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            {creating && <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
            Tạo bình chọn
          </button>
        </div>
      </div>
    </div>
  );
}

function PollToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between cursor-pointer select-none">
      <span className="text-sm text-gray-300">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-blue-600' : 'bg-gray-600'}`}
      >
        <span className={`absolute top-0.5 left-0 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}

/** Parse reactions thành { emojiChar: count } - hỗ trợ cả format mới (PHP-like) và cũ */
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

/** Trích xuất URL ảnh từ một object bất kỳ */
function extractUrlFromObj(obj: any): string {
  if (!obj || typeof obj !== 'object') return '';
  let p: any = obj.params;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  return (p?.hd || p?.rawUrl || p?.normalUrl)
    || obj.normalUrl || obj.hdUrl || obj.hd
    || obj.href || obj.thumb || obj.url || obj.src
    || '';
}

/** Trích xuất URL ảnh từ nội dung quote - CHỈ với ảnh thực sự, không phải link/file */
function extractQuoteImage(msg: any, attach?: any, msgType?: string): string {
  // Helper để kiểm tra xem có phải ảnh không
  const isImageContent = (obj: any): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    // Nếu có title + href nhưng KHÔNG có params.hd/rawUrl => đây là link/file, không phải ảnh
    if (obj.title && obj.href) {
      let paramsObj = obj.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (!hasImageParams) return false; // Link/file, không phải ảnh
    }
    // Có params.hd/rawUrl hoặc thumb => ảnh
    let paramsObj = obj.params;
    if (typeof paramsObj === 'string') {
      try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
    }
    return !!(paramsObj?.hd || paramsObj?.rawUrl || obj.thumb || obj.href);
  };

  if (msg && typeof msg === 'object') {
    if (isImageContent(msg)) {
      const url = extractUrlFromObj(msg);
      if (url) return url;
    }
    if (Array.isArray(msg) && msg.length > 0) {
      if (isImageContent(msg[0])) {
        const u = extractUrlFromObj(msg[0]);
        if (u) return u;
      }
    }
  }
  if (msg && typeof msg === 'string' && msg !== '' && msg !== 'null') {
    try {
      const parsed = JSON.parse(msg);
      if (typeof parsed === 'object') {
        if (isImageContent(parsed)) {
          const url = extractUrlFromObj(parsed);
          if (url) return url;
        }
        if (Array.isArray(parsed) && parsed.length > 0 && isImageContent(parsed[0])) {
          return extractUrlFromObj(parsed[0]);
        }
      }
    } catch {}
  }
  if (attach) {
    try {
      const parsed = typeof attach === 'string' ? JSON.parse(attach) : attach;
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (item && typeof item === 'object' && isImageContent(item)) {
        const url = extractUrlFromObj(item);
        if (url) return url;
        if (item.data && isImageContent(item.data)) return extractUrlFromObj(item.data);
      }
    } catch {}
  }
  return '';
}

/** Trích xuất URL ảnh từ tin nhắn (dùng khi lookup quote image) */
function extractMediaUrl(msg: any): string {
  try {
    const parsed = JSON.parse(msg.content || '{}');
    if (parsed && typeof parsed === 'object') {
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      return paramsObj?.hd || paramsObj?.rawUrl || parsed.href || parsed.thumb || '';
    }
  } catch {}
  try {
    const attachments = JSON.parse(msg.attachments || '[]');
    return attachments[0]?.url || attachments[0]?.href || attachments[0]?.thumb || '';
  } catch {}
  return '';
}

/** Hiển thị nội dung tin nhắn trích dẫn - ưu tiên msgType từ DB, sau đó phân tích cấu trúc msg */
function parseQuoteMsg(msg: string, msgType?: string): string {
  if (!msg || msg === 'null') {
    // msg rỗng nhưng msgType cho biết loại → trả về fallback ngay
    if (msgType === 'chat.recommended' || msgType === 'chat.link') return '🔗 [Link]';
    if (msgType === 'share.file' || msgType === 'file') return '📎 [File]';
    if (msgType === 'share.link') return '🔗 [Link]';
    if (msgType === 'chat.photo' || msgType === 'photo' || msgType === 'image') return '[Hình ảnh]';
    if (msgType === 'chat.video.msg') return '[Video]';
    if (msgType === 'chat.voice') return '🎤 [Ghi âm]';
    if (msgType === 'chat.sticker') return '[Sticker]';
    if (msgType === 'chat.poll') return '[Bình chọn]';
    if (msgType === 'chat.webcontent') return '🏦 [Tài khoản ngân hàng]';
    return '';
  }
  
  // Nếu có msgType từ DB → sử dụng để xác định loại trước
  if (msgType) {
    // Với các loại đặc biệt, kiểm tra msgType trước khi parse msg
    if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') {
      return '[Hình ảnh]';
    }
    if (msgType === 'chat.video.msg') {
      return '[Video]';
    }
    if (msgType === 'chat.voice') {
      return '🎤 [Ghi âm]';
    }
    if (msgType === 'chat.sticker') {
      return '[Sticker]';
    }
    if (msgType === 'chat.poll') {
      return '[Bình chọn]';
    }
    if (msgType === 'chat.webcontent') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.action === 'zinstant.bankcard') return '🏦 [Tài khoản ngân hàng]';
      } catch {}
    }
    // chat.recommended / chat.link = link chia sẻ, parse msg để lấy title
    if (msgType === 'chat.recommended' || msgType === 'chat.link') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object') {
          let paramsObj = parsed.params;
          if (typeof paramsObj === 'string') { try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; } }
          const title = parsed.title || paramsObj?.mediaTitle || parsed.description;
          if (title) return `🔗 ${title}`;
        }
      } catch {}
      return '🔗 [Link]';
    }
    // Với share.file và share.link → cần parse msg để lấy title
    if (msgType === 'share.file' || msgType === 'share.link' || msgType === 'file') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object' && parsed.title) {
          return `📎 ${parsed.title}`;
        }
      } catch {}
      return msgType === 'share.link' ? '[Link]' : '[File]';
    }
  }
  
  // Thử parse JSON để lấy text hoặc phân tích cấu trúc
  try {
    const parsed = JSON.parse(msg);
    
    // Nếu parse ra string thuần túy → đây là text message
    if (typeof parsed === 'string') return parsed;
    
    if (parsed && typeof parsed === 'object') {
      // Parse params nếu có
      let paramsObj = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      
      // 1. Kiểm tra text message trước (msg/content field)
      if (parsed.msg && typeof parsed.msg === 'string') return String(parsed.msg);
      if (parsed.content && typeof parsed.content === 'string') return String(parsed.content);
      
      // 2. Kiểm tra LINK với action="recommened.link"
      if (parsed.action === 'recommened.link' || parsed.action === 'recommended.link') {
        // Ưu tiên title gốc (có thể chứa text người dùng), fallback sang mediaTitle
        const mediaTitle = parsed.title || paramsObj?.mediaTitle;
        if (mediaTitle) {
          return `🔗 ${mediaTitle}`;
        }
        return '🔗 [Link]';
      }
      
      // 3. Kiểm tra FILE/LINK thông thường: có title + href
      if (parsed.title && parsed.href) {
        // Có params.fileSize/fileExt → file
        if (paramsObj?.fileSize || paramsObj?.fileExt) {
          return `📎 ${parsed.title}`;
        }
        // Có params.hd/rawUrl → ảnh (bọc trong link format)
        const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
        if (!hasImageParams) {
          // Link thuần túy - ưu tiên title gốc để không mất text do user nhập
          const displayTitle = parsed.title || paramsObj?.mediaTitle;
          return `🔗 ${displayTitle}`;
        }
        // Có image params → rơi vào case ảnh bên dưới
      }
      
      // 4. Kiểm tra HÌNH ẢNH: có params.hd/rawUrl hoặc thumb
      const hasImageData = !!(paramsObj?.hd || paramsObj?.rawUrl || parsed.thumb || (parsed.href && !parsed.title));
      if (hasImageData) {
        return '[Hình ảnh]';
      }
    }
    return '';
  } catch {
    // Không phải JSON → text thuần túy
    return msg;
  }
}

/** Kiểm tra tin nhắn danh thiếp (chat.recommended) */
function isCardType(msgType: string, content: string): boolean {
  if (['chat.recommended', 'chat.recommend'].includes(msgType)) return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.action && String(parsed.action).includes('recommened')) return true;
  } catch {}
  return false;
}

/** Kiểm tra tin nhắn ecard (thông báo hệ thống dạng thẻ, vd: trở thành phó nhóm) */
function isEcardType(msgType: string): boolean {
  return msgType === 'chat.ecard';
}

/** Kiểm tra tin nhắn có phải file đính kèm không (không phải ảnh, không phải card) */
function isFileType(msgType: string, content: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (['share.file', 'share.link', 'file'].includes(msgType)) return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.title && parsed.href &&
        !parsed.params?.rawUrl && !parsed.params?.hd) return true;
  } catch {}
  return false;
}

/** Kiểm tra tin nhắn là sticker */
function isStickerType(msgType: string): boolean {
  return msgType === 'chat.sticker';
}

/** Kiểm tra tin nhắn webchat với action=rtf (tin nhắn có định dạng rich text) */
function isRtfMsg(msgType: string, content: string): boolean {
  if (msgType !== 'webchat') return false;
  try {
    const parsed = JSON.parse(content);
    return parsed?.action === 'rtf';
  } catch {}
  return false;
}

/** Kiểm tra tin nhắn có phải media (ảnh) không — loại trừ file và card */
function isMediaType(msgType: string, content: string): boolean {
  if (isCardType(msgType, content)) return false;
  if (isBankCardType(msgType, content)) return false;
  if (['share.file', 'share.link', 'file'].includes(msgType)) return false;
  if (msgType === 'chat.video.msg') return false; // video được xử lý riêng
  if (msgType === 'chat.voice') return false; // voice được xử lý riêng
  if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') return true;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      // params có thể là string JSON hoặc object
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      const hasHdOrRaw = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (parsed.title && parsed.href && !hasHdOrRaw) return false;
      return !!(parsed.href || parsed.thumb || paramsObj?.rawUrl || paramsObj?.hd);
    }
  } catch {}
  return false;
}

/** Kiểm tra tin nhắn video */
function isVideoType(msgType: string): boolean {
  return msgType === 'chat.video.msg';
}

/** Kiểm tra tin nhắn thẻ ngân hàng (chat.webcontent + zinstant.bankcard) */
function isBankCardType(msgType: string, content: string): boolean {
  // Ưu tiên check msgType trước
  if (msgType === 'chat.webcontent' || msgType === 'webchat') {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  // Fallback: kiểm tra content bất kể msgType (phòng trường hợp Zalo đổi msgType)
  if (content && content.includes('zinstant.bankcard')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed?.action === 'zinstant.bankcard') return true;
    } catch {}
  }
  return false;
}

/** FileBubble — hiển thị tin nhắn file đính kèm (share.file) */
function FileBubble({ msg, isSent }: { msg: any; isSent: boolean }) {
  const [opening, setOpening] = React.useState(false);

  let fileTitle = '';
  let fileHref = '';
  let fileSize = '';
  let fileExt = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params || '{}') : (parsed.params || {});
    fileTitle = parsed.title || 'File';
    fileHref = parsed.href || '';
    fileSize = params.fileSize || '';
    fileExt = (params.fileExt || fileTitle.split('.').pop() || '').toLowerCase();
  } catch {}

  // Facebook: extract metadata from attachments column
  if (msg.channel === 'facebook' && (!fileTitle || fileTitle === 'File')) {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      if (atts.length > 0) {
        const a = atts[0];
        if (a.name) fileTitle = a.name;
        if (a.url && !fileHref) fileHref = a.url;
        if (a.fileSize != null && !fileSize) fileSize = String(a.fileSize);
        if (!fileExt && fileTitle) fileExt = fileTitle.split('.').pop()?.toLowerCase() || '';
      }
    } catch {}
    // Fallback: extract name from body text like "📎 filename.ext"
    if (!fileTitle && msg.content) {
      const m = msg.content.match(/📎\s*(.+)/);
      if (m) {
        fileTitle = m[1].trim();
        if (!fileExt) fileExt = fileTitle.split('.').pop()?.toLowerCase() || '';
      }
    }
  }

  let localFilePath = '';
  try {
    const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    localFilePath = lp.file || lp.main || '';
  } catch {}

  // Facebook: also check localPath inside attachments (temp sending state)
  if (msg.channel === 'facebook' && !localFilePath) {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      if (atts.length > 0 && atts[0].localPath) localFilePath = atts[0].localPath;
    } catch {}
  }

  const handleOpen = async () => {
    if (opening) return;
    setOpening(true);
    try {
      if (localFilePath) await ipc.file?.openPath(localFilePath);
      else if (fileHref) ipc.shell?.openExternal(fileHref);
    } catch {} finally { setOpening(false); }
  };

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!localFilePath) return;
    const parentDir = localFilePath.replace(/[/\\][^/\\]+$/, '');
    try { await ipc.file?.openPath(parentDir); } catch {}
  };

  const formatFileSize = (bytes: string | number): string => {
    const n = typeof bytes === 'string' ? parseInt(bytes) : bytes;
    if (!n || isNaN(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  const getFileIconAndColor = (ext: string): { icon: string; bg: string; text: string } => {
    const e = ext.toLowerCase();
    if (['pdf'].includes(e)) return { icon: 'PDF', bg: 'bg-red-600', text: 'text-white' };
    if (['doc', 'docx'].includes(e)) return { icon: 'DOC', bg: 'bg-blue-500', text: 'text-white' };
    if (['xls', 'xlsx', 'csv'].includes(e)) return { icon: 'XLS', bg: 'bg-green-600', text: 'text-white' };
    if (['ppt', 'pptx'].includes(e)) return { icon: 'PPT', bg: 'bg-orange-500', text: 'text-white' };
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return { icon: 'ZIP', bg: 'bg-yellow-600', text: 'text-white' };
    if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(e)) return { icon: 'VID', bg: 'bg-purple-600', text: 'text-white' };
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e)) return { icon: 'AUD', bg: 'bg-pink-600', text: 'text-white' };
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(e)) return { icon: 'IMG', bg: 'bg-teal-600', text: 'text-white' };
    if (['txt', 'log'].includes(e)) return { icon: 'TXT', bg: 'bg-gray-500', text: 'text-white' };
    return { icon: e.toUpperCase().slice(0, 3) || '...', bg: 'bg-gray-500', text: 'text-white' };
  };

  const sizeText = formatFileSize(fileSize);
  const hasLocal = !!localFilePath;
  const canOpen = hasLocal || !!fileHref;
  const { icon, bg, text } = getFileIconAndColor(fileExt);

  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-2xl min-w-[200px] max-w-xs ${
      isSent ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'
    }`}>
      {/* Colored file type icon box */}
      <button
        onClick={handleOpen}
        disabled={opening || !canOpen}
        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 font-bold text-[11px] ${bg} ${text} ${canOpen ? 'hover:opacity-80 cursor-pointer' : 'cursor-default opacity-60'} transition-opacity`}
        title={canOpen ? 'Nhấn để mở' : ''}
      >
        {icon}
      </button>

      {/* File info */}
      <button
        onClick={handleOpen}
        disabled={opening || !canOpen}
        className="flex-1 min-w-0 text-left"
        title={canOpen ? 'Nhấn để mở' : ''}
      >
        <p className="text-sm font-medium truncate">{fileTitle}</p>
        <p className={`text-xs mt-0.5 flex items-center gap-1 ${isSent ? 'text-white-important' : 'text-gray-400'}`}>
          {sizeText && <span>{sizeText}</span>}
          {sizeText && hasLocal && <span>•</span>}
          {opening ? <span>Đang mở...</span>
            : hasLocal ? <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg><span>Đã có trên máy</span></>
            : fileHref ? <span>Nhấn để tải</span>
            : (msg.channel === 'facebook' && isSent) ? <span>✓ Đã gửi</span>
            : <span>Đang tải về...</span>}
        </p>
      </button>

      {/* Action buttons: folder + download */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {hasLocal && (
          <button onClick={handleOpenFolder} title="Mở thư mục"
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
              isSent ? 'text-white-important hover:text-white hover:bg-blue-500' : 'text-gray-400 hover:text-white hover:bg-gray-600'
            }`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          </button>
        )}
        <button onClick={handleOpen} disabled={opening || !canOpen} title={hasLocal ? 'Mở file' : 'Tải xuống'}
          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 ${
            isSent ? 'text-white-important hover:text-white hover:bg-blue-500' : 'text-white-important hover:text-white hover:bg-gray-600'
          }`}>
          {hasLocal
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          }
        </button>
      </div>
    </div>
  );
}

/** Hiển thị bubble ảnh dùng React state — tự retry khi local_paths được cập nhật sau khi tải xong */
function MediaBubble({ msg, onView, isSent, allContacts, groupMembersList, onMentionClick }: {
  msg: any;
  onView: (src: string) => void;
  isSent?: boolean;
  allContacts?: any[];
  groupMembersList?: any[];
  onMentionClick?: (userId: string, e: React.MouseEvent) => void;
}) {
  // 'local'  = ưu tiên localUrl trước (mặc định — ảnh Zalo CDN xóa sau 14 ngày)
  // 'remote' = fallback sang remoteUrl khi local chưa tải xong hoặc không tồn tại
  const [imgSrc, setImgSrc] = React.useState<'local' | 'remote'>('local');
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
  React.useEffect(() => {
    setLoadFailed(false);
    setImgSrc('local');
  }, [localPathsStr]);

  // Parse local URL
  let localUrl = '';
  let localFilePath = '';
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}')
      : (msg.local_paths || {});
    localFilePath = lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
    if (localFilePath) {
      localUrl = toLocalMediaUrl(localFilePath);
    }
  } catch {}

  // FB: use localPath from attachments for immediate preview
  let fbLocalUrls: string[] = [];
  if (msg.channel === 'facebook') {
    try {
      const atts = JSON.parse(msg.attachments || '[]');
      fbLocalUrls = atts.map((a: any) => a.localPath ? toLocalMediaUrl(a.localPath) : (a.url || '')).filter(Boolean);
      if (!localUrl && fbLocalUrls.length > 0) localUrl = fbLocalUrls[0];
    } catch {}
  }

  // Parse remote URL + caption
  let remoteUrl = '';
  let caption = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    if (parsed && typeof parsed === 'object') {
      let paramsObj: any = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }
      remoteUrl = paramsObj?.hd || paramsObj?.rawUrl || parsed.href || parsed.thumb || '';
      if (parsed.title && typeof parsed.title === 'string') {
        const t = parsed.title.trim();
        if (t && !t.startsWith('http')) caption = t;
      }
    }
  } catch {}
  if (!remoteUrl) {
    try {
      const attachments = JSON.parse(msg.attachments || '[]');
      remoteUrl = attachments[0]?.url || attachments[0]?.href || attachments[0]?.thumb || '';
    } catch {}
  }

  // Local-first: ưu tiên file local đã lưu; fallback remote khi local lỗi
  const displayUrl = imgSrc === 'remote' ? (remoteUrl || localUrl) : (localUrl || remoteUrl);
  const viewUrl = remoteUrl || displayUrl;

  // alt="" → Chromium không hiện broken-image icon khi local chưa tải xong
  const handleImgError = () => {
    if (imgSrc === 'local' && remoteUrl && remoteUrl !== displayUrl) {
      setImgSrc('remote'); // Local lỗi (chưa tải) → fallback Zalo CDN
    } else {
      setLoadFailed(true);
    }
  };

  const handleShowInFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (localFilePath) await ipc.file?.showItemInFolder(localFilePath);
  };

  const handleSaveAs = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (saving) return;
    setSaving(true);
    try {
      const defaultName = localFilePath
        ? localFilePath.replace(/.*[/\\]/, '')
        : `img_${msg.msg_id || Date.now()}.jpg`;
      await ipc.file?.saveAs({
        localPath: localFilePath || undefined,
        remoteUrl: remoteUrl || undefined,
        defaultName,
      });
    } finally { setSaving(false); }
  };

  if (loadFailed) {
    return <span className="text-xs opacity-60">[Không tải được ảnh]</span>;
  }

  // Multi-image grid (FB batch send temp)
  if (fbLocalUrls.length > 1) {
    const cols = fbLocalUrls.length <= 2 ? 2 : fbLocalUrls.length <= 4 ? 2 : 3;
    return (
      <div className="grid gap-1 rounded-xl overflow-hidden" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, maxWidth: 260 }}>
        {fbLocalUrls.map((src, i) => (
          <img key={i} src={src} alt="" onClick={() => onView(src)}
            className="w-full aspect-square object-cover cursor-pointer hover:opacity-90 transition-opacity bg-gray-700/30" />
        ))}
      </div>
    );
  }

  if (!displayUrl) {
    return <span className="text-xs opacity-60">[Hình ảnh]</span>;
  }

  const imgNode = (
    <div className="relative group/media">
      <img
        src={displayUrl}
        alt=""
        className={`max-w-xs h-64 cursor-pointer hover:opacity-90 transition-opacity bg-gray-700/30 object-contain w-full${caption ? ' rounded-t-xl' : ' rounded-xl'}`}
        onClick={() => onView(viewUrl)}
        onError={handleImgError}
      />
      {/* Viền mờ overlay — hiển thị rõ ở cả giao diện sáng lẫn tối */}
      <div className={`absolute inset-0 pointer-events-none ring-1 ring-inset ring-black/[0.12]${caption ? ' rounded-t-xl' : ' rounded-xl'}`} />
      {/* Hover action buttons */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/media:opacity-100 transition-opacity">
        {localFilePath && (
          <button onClick={handleShowInFolder} title="Mở trong thư mục"
            className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white transition-colors backdrop-blur-sm">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          </button>
        )}
        <button onClick={handleSaveAs} disabled={saving} title="Lưu về máy"
          className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white transition-colors backdrop-blur-sm disabled:opacity-40">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      </div>
    </div>
  );

  if (!caption) return imgNode;

  // With caption: wrap in bubble with bg matching sent/received style
  return (
    <div className={`flex flex-col rounded-2xl overflow-hidden ring-1 ring-black/[0.12]${isSent ? ' rounded-br-sm' : ' rounded-bl-sm'}`}>
      {imgNode}
      <div className={`px-3 py-2 text-sm break-words${isSent ? ' bg-blue-600 text-white' : ' bg-gray-700 text-gray-200'}`}>
        <TextWithMentions
          text={caption}
          allContacts={allContacts}
          groupMembersList={groupMembersList}
          onMentionClick={onMentionClick}
        />
      </div>
    </div>
  );
}

/** VideoBubble — hiển thị tin nhắn video với thumbnail và nút play */
function VideoBubble({ msg, isSent }: { msg: any; isSent: boolean }) {
  const [saving, setSaving] = React.useState(false);
  // local-first thumbnail; fallback remote khi local chưa tải hoặc lỗi
  const [thumbSrcMode, setThumbSrcMode] = React.useState<'local' | 'remote'>('local');

  const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
  React.useEffect(() => { setThumbSrcMode('local'); }, [localPathsStr]);

  // Parse local paths
  let thumbLocalPath = '';
  let videoLocalPath = '';
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    thumbLocalPath = lp.thumb || lp.main || '';
    videoLocalPath = lp.file || lp.video || '';
  } catch {}

  // Parse remote URLs từ content
  let remoteThumb = '';
  let remoteVideo = '';
  let duration = 0;
  let width = 0;
  let height = 0;
  try {
    const parsed = JSON.parse(msg.content || '{}');
    remoteThumb = parsed.thumb || '';
    remoteVideo = parsed.href || '';
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    duration = params.duration ? Math.round(params.duration / 1000) : 0;
    width = params.video_width || 0;
    height = params.video_height || 0;
  } catch {}

  const localThumbUrl = thumbLocalPath ? toLocalMediaUrl(thumbLocalPath) : '';
  // Local-first: ưu tiên local; fallback remote khi local lỗi (file chưa tải xong)
  const thumbUrl = thumbSrcMode === 'remote'
    ? (remoteThumb || localThumbUrl)
    : (localThumbUrl || remoteThumb);

  const handlePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Mở video local trước, nếu không có thì mở remote
    if (videoLocalPath) {
      await ipc.file?.openPath(videoLocalPath);
    } else if (remoteVideo) {
      ipc.shell?.openExternal(remoteVideo);
    }
  };

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoLocalPath) {
      const parentDir = videoLocalPath.replace(/[/\\][^/\\]+$/, '');
      await ipc.file?.openPath(parentDir);
    }
  };

  const handleSaveAs = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (saving) return;
    setSaving(true);
    try {
      const defaultName = videoLocalPath
        ? videoLocalPath.replace(/.*[/\\]/, '')
        : `video_${msg.msg_id || Date.now()}.mp4`;
      await ipc.file?.saveAs({
        localPath: videoLocalPath || undefined,
        remoteUrl: remoteVideo || undefined,
        defaultName,
      });
    } finally { setSaving(false); }
  };

  const formatDuration = (s: number) => {
    if (!s) return '';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const isHD = width >= 720 || height >= 720;
  const aspectRatio = width && height ? width / height : 16 / 9;
  const displayHeight = Math.min(200, Math.round(280 / aspectRatio));

  return (
    <div
      className="relative group/video cursor-pointer rounded-xl overflow-hidden bg-black ring-1 ring-black/[0.12]"
      style={{ width: 280, height: displayHeight || 160 }}
      onClick={handlePlay}
    >
      {/* Thumbnail */}
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => {
            if (thumbSrcMode === 'local' && remoteThumb && remoteThumb !== thumbUrl) {
              setThumbSrcMode('remote'); // Local lỗi → thử remote Zalo CDN
            } else {
              (e.target as HTMLImageElement).style.display = 'none'; // Cả hai lỗi → ẩn
            }
          }}
        />
      ) : (
        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-600">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </div>
      )}

      {/* Overlay gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50" />

      {/* Play button ở giữa */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-14 h-14 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center group-hover/video:bg-black/80 transition-colors shadow-lg">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </div>
      </div>

      {/* Duration + HD badge — bottom left */}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
        {duration > 0 && (
          <span className="text-[11px] text-white font-medium bg-black/50 px-1.5 py-0.5 rounded">
            {formatDuration(duration)}
          </span>
        )}
        {isHD && (
          <span className="text-[11px] text-white font-bold bg-blue-600/70 px-1.5 py-0.5 rounded">HD</span>
        )}
        {!videoLocalPath && (
          <span className="text-[11px] text-yellow-300 bg-black/50 px-1.5 py-0.5 rounded">Đang tải...</span>
        )}
      </div>

      {/* Action buttons — top right, on hover */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/video:opacity-100 transition-opacity">
        {videoLocalPath && (
          <button onClick={handleOpenFolder} title="Mở thư mục"
            className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          </button>
        )}
        <button onClick={handleSaveAs} disabled={saving} title="Lưu về máy"
          className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white transition-colors disabled:opacity-40">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

/** VoiceBubble — hiển thị tin nhắn ghi âm (chat.voice) */
function VoiceBubble({ msg, isSent }: { msg: any; isSent: boolean }) {
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const animRef = React.useRef<number>(0);

  // Parse voice URL + duration from Zalo message content (memo to avoid re-parse)
  const { voiceUrl, paramsDurationSec, localPath } = React.useMemo(() => {
    let _voiceUrl = '';
    let _paramsDur = 0;
    try {
      const parsed = JSON.parse(msg.content || '{}');
      _voiceUrl = parsed.href || '';
      const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params || '{}') : (parsed.params || {});
      if (!_voiceUrl) {
        _voiceUrl = params.m4a || params.url || '';
      }
      // Zalo lưu duration dạng ms (vd: 5000 = 5s) hoặc giây
      const rawDur = Number(params.duration || params.dur || 0);
      _paramsDur = rawDur > 300 ? rawDur / 1000 : rawDur;
    } catch {}

    let _localPath = '';
    try {
      const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      _localPath = lp.file || lp.voice || lp.main || '';
    } catch {}

    return { voiceUrl: _voiceUrl, paramsDurationSec: _paramsDur, localPath: _localPath };
  }, [msg.content, msg.local_paths]);

  // Sync duration from params khi chưa có audio metadata
  React.useEffect(() => {
    if (paramsDurationSec > 0 && duration === 0) {
      setDuration(paramsDurationSec);
    }
  }, [paramsDurationSec]);

  const audioSrc = localPath ? toLocalMediaUrl(localPath) : voiceUrl;

  const formatDur = (s: number) => {
    if (!s || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const tick = React.useCallback(() => {
    const audio = audioRef.current;
    if (audio && isPlaying) {
      const ct = audio.currentTime;
      const dur = audio.duration || duration || 1;
      setCurrentTime(ct);
      setProgress(ct / dur);
      animRef.current = requestAnimationFrame(tick);
    }
  }, [isPlaying, duration]);

  React.useEffect(() => {
    if (isPlaying) {
      animRef.current = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(animRef.current);
  }, [isPlaying, tick]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
    setProgress(pct);
    setCurrentTime(audio.currentTime);
  };

  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-2xl min-w-[200px] max-w-[280px] ${
      isSent ? 'bg-blue-600' : 'bg-gray-700'
    }`}>
      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const audioDur = (e.target as HTMLAudioElement).duration;
          if (audioDur && isFinite(audioDur)) setDuration(audioDur);
        }}
        onEnded={() => { setIsPlaying(false); setProgress(0); setCurrentTime(0); }}
      />

      {/* Play/Pause button */}
      <button onClick={togglePlay} className="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center flex-shrink-0 transition-colors">
        {isPlaying ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
            <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        )}
      </button>

      {/* Waveform / progress */}
      <div className="flex-1 flex flex-col gap-1">
        <div className="relative h-6 flex items-center cursor-pointer" onClick={handleSeek}>
          <div className="flex items-center gap-[2px] w-full h-full">
            {Array.from({ length: 24 }, (_, i) => {
              const h = [3, 5, 8, 4, 10, 6, 12, 5, 9, 4, 11, 7, 6, 10, 5, 8, 4, 12, 6, 9, 5, 7, 4, 6][i] || 5;
              const filled = i / 24 < progress;
              return (
                <div
                  key={i}
                  className={`rounded-full transition-colors duration-100 ${filled ? 'bg-white' : 'bg-white/30'}`}
                  style={{ width: 2, height: h * 1.5, minHeight: 3 }}
                />
              );
            })}
          </div>
        </div>
        <span className="text-[10px] text-white/70 font-mono tabular-nums leading-none">
          {isPlaying ? formatDur(currentTime) : formatDur(duration)}
        </span>
      </div>

      {/* Mic icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/50 flex-shrink-0">
        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
        <path d="M19 10v2a7 7 0 01-14 0v-2"/>
      </svg>
    </div>
  );
}

/** Preview sticker nhỏ dùng trong khung trích dẫn (quote) — tải URL từ DB cache hoặc API */
function QuotedStickerPreview({ content }: { content: string }) {
  const [stickerUrl, setStickerUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    // Try direct URL from content first (params.staticIcon / params.icon)
    try {
      const c = JSON.parse(content || '{}');
      const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
      const directUrl = params?.staticIcon || params?.icon || c?.stickerUrl || c?.icon || '';
      if (directUrl) { setStickerUrl(directUrl); return; }
    } catch {}

    const load = async () => {
      let stickerId: number | null = null;
      try {
        const parsed = JSON.parse(content || '{}');
        stickerId = parsed?.id ?? parsed?.sticker_id ?? null;
      } catch {}
      if (!stickerId) return;

      // DB cache lookup
      try {
        const res = await ipc.db?.getStickerById({ stickerId });
        if (res?.sticker?.stickerUrl && !res.sticker._unsupported) {
          if (!cancelled) setStickerUrl(res.sticker.stickerUrl);
          return;
        }
      } catch {}

      // Fallback: fetch from API
      try {
        const accountsRes = await ipc.login?.getAccounts();
        const accounts: any[] = accountsRes?.accounts || [];
        const active = accounts.find((a: any) => a.is_active) || accounts[0];
        if (!active) return;
        const auth = { cookies: active.cookies, imei: active.imei, userAgent: active.user_agent };
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: [stickerId] });
        const stickers: any[] = detailRes?.response || [];
        if (stickers.length && stickers[0]?.stickerUrl) {
          if (!cancelled) setStickerUrl(stickers[0].stickerUrl);
          ipc.db?.saveStickers({ stickers }).catch(() => {});
        }
      } catch {}
    };
    load();
    return () => { cancelled = true; };
  }, [content]);

  if (!stickerUrl) {
    return (
      <div className="w-12 h-12 rounded-lg bg-gray-700/50 flex items-center justify-center animate-pulse flex-shrink-0">
        <span className="text-lg">🎭</span>
      </div>
    );
  }
  return <img src={stickerUrl} alt="sticker" className="w-12 h-12 object-contain rounded-lg flex-shrink-0" />;
}

/** Hiển thị nhiều sticker liền nhau từ cùng người gửi trong 30 phút — mỗi sticker có thể right-click riêng */
function StickerGroupBubble({
  msgs: groupMsgs,
  onContextMenu,
}: {
  msgs: any[];
  onContextMenu: (e: React.MouseEvent, msg: any) => void;
}) {
  // w-28 = 112px × 3 + gap-1.5 (6px) × 2 = 348px → maxWidth 22rem = 352px đủ để hiện 3/dòng
  return (
    <div className="flex flex-wrap gap-1.5" style={{ maxWidth: '22rem' }}>
      {groupMsgs.map((stickerMsg) => (
        <div
          key={stickerMsg.msg_id}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu(e, stickerMsg);
          }}
          className="cursor-default select-none"
        >
          <StickerBubble msg={stickerMsg} />
        </div>
      ))}
    </div>
  );
}

/** Trích xuất groupLayoutId từ tin nhắn ảnh gửi theo nhóm (is_group_layout=1) */
function getGroupLayoutId(msg: any): string | null {  if (!isMediaType(msg.msg_type, msg.content)) return null;
  try {
    const parsed = JSON.parse(msg.content || '{}');
    const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    if (params.is_group_layout && params.group_layout_id) return String(params.group_layout_id);
  } catch {}
  return null;
}

/** Hiển thị nhóm ảnh gửi cùng 1 batch — tối đa 4 ảnh/hàng, chiều cao cố định */
function MediaGroupBubble({ msgs: groupMsgs, onView }: { msgs: any[]; onView: (src: string) => void }) {
  const sorted = React.useMemo(() => {
    return [...groupMsgs].sort((a, b) => {
      try {
        const pa = JSON.parse(a.content || '{}');
        const ppa = typeof pa.params === 'string' ? JSON.parse(pa.params) : (pa.params || {});
        const pb = JSON.parse(b.content || '{}');
        const ppb = typeof pb.params === 'string' ? JSON.parse(pb.params) : (pb.params || {});
        return (ppa.id_in_group || 0) - (ppb.id_in_group || 0);
      } catch { return 0; }
    });
  }, [groupMsgs]);

  // Chia thành hàng, mỗi hàng tối đa 4 ảnh
  const rows: any[][] = [];
  for (let i = 0; i < sorted.length; i += 4) rows.push(sorted.slice(i, i + 4));

  return (
    <div className="flex flex-col gap-0.5 overflow-hidden rounded-xl max-w-xs ring-1 ring-black/[0.12]">
      {rows.map((row, ri) => (
        <div key={ri} className="flex gap-0.5">
          {row.map((m) => (
            <SingleImageInGroup key={m.msg_id} msg={m} onView={onView} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Ảnh đơn bên trong MediaGroupBubble — chiều cao cố định h-40 */
function SingleImageInGroup({ msg, onView }: { msg: any; onView: (src: string) => void }) {
  // Local-first; fallback remote khi local lỗi (chưa tải xong)
  const [imgSrc, setImgSrc] = React.useState<'local' | 'remote'>('local');
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
  React.useEffect(() => { setLoadFailed(false); setImgSrc('local'); }, [localPathsStr]);

  let localUrl = '';
  let localFilePath = '';
  try {
    const lp: Record<string, string> = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    localFilePath = lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
    if (localFilePath) localUrl = toLocalMediaUrl(localFilePath);
  } catch {}

  let remoteUrl = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    if (parsed && typeof parsed === 'object') {
      const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
      remoteUrl = params.hd || params.rawUrl || parsed.href || parsed.thumb || '';
    }
  } catch {}

  // Local-first; fallback remote khi local lỗi
  const displayUrl = imgSrc === 'remote' ? (remoteUrl || localUrl) : (localUrl || remoteUrl);
  const viewUrl = remoteUrl || displayUrl;

  const handleImgError = () => {
    if (imgSrc === 'local' && remoteUrl && remoteUrl !== displayUrl) setImgSrc('remote');
    else setLoadFailed(true);
  };

  const handleSaveAs = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (saving) return;
    setSaving(true);
    try {
      const defaultName = localFilePath
        ? localFilePath.replace(/.*[/\\]/, '')
        : `img_${msg.msg_id || Date.now()}.jpg`;
      await ipc.file?.saveAs({ localPath: localFilePath || undefined, remoteUrl: remoteUrl || undefined, defaultName });
    } finally { setSaving(false); }
  };

  if (loadFailed || !displayUrl) {
    return <div className="h-40 flex-1 min-w-0 bg-gray-700/50 flex items-center justify-center text-xs text-gray-500 select-none">[Ảnh]</div>;
  }
  return (
    <div className="relative flex-1 min-w-0 group/singleimg">
      <img
        src={displayUrl}
        alt=""
        className="h-40 w-full object-cover cursor-pointer hover:opacity-90 transition-opacity bg-gray-700/30"
        onClick={() => onView(viewUrl)}
        onError={handleImgError}
      />
      {/* Viền overlay — hiển thị ở cả giao diện sáng lẫn tối */}
      <div className="absolute inset-0 pointer-events-none ring-1 ring-inset ring-black/[0.12]" />
      {/* Hover action buttons */}
      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover/singleimg:opacity-100 transition-opacity">
        {localFilePath && (
          <button onClick={(e) => { e.stopPropagation(); ipc.file?.showItemInFolder(localFilePath); }}
            title="Mở trong thư mục"
            className="w-6 h-6 bg-black/60 hover:bg-black/80 rounded-md flex items-center justify-center text-white transition-colors">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
          </button>
        )}
        <button onClick={handleSaveAs} disabled={saving} title="Lưu về máy"
          className="w-6 h-6 bg-black/60 hover:bg-black/80 rounded-md flex items-center justify-center text-white transition-colors disabled:opacity-40">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

/** StickerBubble — hiển thị sticker với lazy load từ DB cache hoặc API */
function StickerBubble({ msg }: { msg: any }) {
  const [stickerUrl, setStickerUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [unsupported, setUnsupported] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let stickerId: number | null = null;
      try {
        const parsed = JSON.parse(msg.content || '{}');
        stickerId = parsed?.id ?? parsed?.sticker_id ?? null;
      } catch {}
      if (!stickerId) { setFailed(true); return; }

      // 1. Check DB cache first (includes unsupported flag)
      try {
        const res = await ipc.db?.getStickerById({ stickerId });
        if (res?.sticker) {
          if (res.sticker._unsupported) {
            if (!cancelled) setUnsupported(true);
            return;
          }
          if (res.sticker.stickerUrl) {
            if (!cancelled) setStickerUrl(res.sticker.stickerUrl);
            return;
          }
        }
      } catch {}

      // 2. Fetch from API using the active account session
      try {
        const accountsRes = await ipc.login?.getAccounts();
        const accounts: any[] = accountsRes?.accounts || [];
        const active = accounts.find((a: any) => a.is_active) || accounts[0];
        if (!active) { setFailed(true); return; }
        const auth = { cookies: active.cookies, imei: active.imei, userAgent: active.user_agent };
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: [stickerId] });
        if (!detailRes?.success) {
          // API call failed (e.g. disconnected) — mark unsupported
          ipc.db?.markStickerUnsupported({ stickerId }).catch(() => {});
          if (!cancelled) setUnsupported(true);
          return;
        }
        const stickers: any[] = detailRes?.response || [];
        if (stickers.length && stickers[0]?.stickerUrl) {
          if (!cancelled) setStickerUrl(stickers[0].stickerUrl);
          // Cache to DB
          ipc.db?.saveStickers({ stickers }).catch(() => {});
        } else {
          // Empty result — mark unsupported
          ipc.db?.markStickerUnsupported({ stickerId }).catch(() => {});
          if (!cancelled) setUnsupported(true);
        }
      } catch {
        ipc.db?.markStickerUnsupported({ stickerId: stickerId! }).catch(() => {});
        if (!cancelled) setUnsupported(true);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [msg.content]);

  if (unsupported) {
    return (
      <div className="w-28 h-28 rounded-xl bg-gray-700/30 border border-gray-600/30 flex flex-col items-center justify-center gap-1">
        <span className="text-2xl opacity-40">🎭</span>
        <span className="text-[10px] text-gray-500 text-center px-1 leading-tight">Sticker chưa hỗ trợ</span>
      </div>
    );
  }

  if (failed) return <span className="text-xs text-gray-400 px-2 py-1">[Sticker]</span>;

  if (!stickerUrl) {
    return (
      <div className="w-28 h-28 rounded-xl bg-gray-700/50 flex items-center justify-center animate-pulse">
        <span className="text-2xl">🎭</span>
      </div>
    );
  }

  return (
    <img
      src={stickerUrl}
      alt="sticker"
      className="w-28 h-28 object-contain rounded-xl"
      onError={() => setFailed(true)}
    />
  );
}

function parseContent(content: string): string {
  if (!content || content === 'null') return '';
  try {
    const parsed = JSON.parse(content);
    if (parsed === null || parsed === undefined) return '';
    if (typeof parsed === 'string') return convertZaloEmojis(parsed);
    if (typeof parsed !== 'object') return convertZaloEmojis(String(parsed));
    if (parsed?.action === 'zinstant.bankcard') return '🏦 [Tài khoản ngân hàng]';
    if (parsed?.content && typeof parsed.content === 'string') return convertZaloEmojis(parsed.content);
    if (parsed?.msg && typeof parsed.msg === 'string') return convertZaloEmojis(parsed.msg);
    if (parsed?.message && typeof parsed.message === 'string') return convertZaloEmojis(parsed.message);
    if (parsed?.href || parsed?.thumb || parsed?.params) return '[Đính kèm]';
    if (parsed?.title) return parsed.title;
    return JSON.stringify(parsed);
  } catch {
    return convertZaloEmojis(content) || '';
  }
}

function formatMsgTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
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

  // New format: has .emoji with user counts — convert Zalo codes to emoji
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

  // Old format: { userId: emojiChar } — convert Zalo codes to emoji
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
            <p className="text-xs text-gray-500 text-center py-6">Chưa có ai thả cảm xúc này</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MsgActionBtn ────────────────────────────────────────────────────────────
function MsgActionBtn({ title, onClick, children }: {
  title: string;
  onClick: ((e: React.MouseEvent) => void) | (() => void);
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick as React.MouseEventHandler}
      className="w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-gray-600 transition-colors flex-shrink-0"
    >
      {children}
    </button>
  );
}

// ─── CardBubble — dispatches to LinkBubble, CallBubble or ContactCardBubble ───
// ─── EcardBubble — thông báo hệ thống dạng thẻ (vd: trở thành phó nhóm, nhắc hẹn) ─────
function EcardBubble({ msg, onManage }: { msg: any; onManage?: () => void }) {
  let parsed: any = {};
  try { parsed = JSON.parse(msg.content || '{}'); } catch {}

  const title: string = parsed.title || '';
  const description: string = parsed.description || '';
  const imageHref: string = parsed.href || '';
  let params: any = {};
  try { params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {}); } catch {}

  // ── Detect reminder card (action.open.reminder) ──
  const isReminderCard = (params.actions || []).some(
    (a: any) => a.actionId === 'action.open.reminder'
  );

  if (isReminderCard) {
    // Parse reminder details from action data
    let reminderData: any = {};
    const reminderAction = (params.actions || []).find((a: any) => a.actionId === 'action.open.reminder');
    try {
      if (reminderAction?.data) {
        const outerData = typeof reminderAction.data === 'string' ? JSON.parse(reminderAction.data) : reminderAction.data;
        if (outerData?.data) {
          reminderData = typeof outerData.data === 'string' ? JSON.parse(outerData.data) : outerData.data;
        }
      }
    } catch {}

    const startTime = Number(reminderData.startTime || 0);
    const repeat: number = Number(reminderData.repeat ?? 0);
    const repeatText = repeat === 1 ? 'Nhắc theo ngày' : repeat === 2 ? 'Nhắc theo tuần' : repeat === 3 ? 'Nhắc theo tháng' : '';
    const emoji = reminderData.emoji || '⏰';

    const formatReminderDateFull = (ts: number) => {
      if (!ts) return description || '';
      const d = new Date(ts);
      const pad = (n: number) => n.toString().padStart(2, '0');
      const weekDays = ['Chủ Nhật','Thứ Hai','Thứ Ba','Thứ Tư','Thứ Năm','Thứ Sáu','Thứ Bảy'];
      const months = ['tháng 1','tháng 2','tháng 3','tháng 4','tháng 5','tháng 6','tháng 7','tháng 8','tháng 9','tháng 10','tháng 11','tháng 12'];
      return `${weekDays[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} lúc ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const formatDayNum = (ts: number) => ts ? new Date(ts).getDate() : '';
    const formatMonth = (ts: number) => {
      if (!ts) return '';
      const d = new Date(ts);
      const months = ['THÁNG 1','THÁNG 2','THÁNG 3','THÁNG 4','THÁNG 5','THÁNG 6','THÁNG 7','THÁNG 8','THÁNG 9','THÁNG 10','THÁNG 11','THÁNG 12'];
      return months[d.getMonth()];
    };
    const formatWeekDay = (ts: number) => {
      if (!ts) return '';
      const days = ['CHỦ NHẬT','THỨ HAI','THỨ BA','THỨ TƯ','THỨ NĂM','THỨ SÁU','THỨ BẢY'];
      return days[new Date(ts).getDay()];
    };

    // Extract reminder title from params.notifyTxt or card title
    const reminderTitle = (params.notifyTxt || title || '').replace(/^[⏰📅🔔⭐📌💡🎯🎉]\s*/, '');

    return (
      <div className="flex justify-center w-full my-1">
        <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden max-w-[300px] w-full shadow-lg">
          {/* Reminder card body */}
          <div className="flex gap-3 p-4">
            {/* Calendar icon */}
            {startTime > 0 && (
              <div className="flex-shrink-0 w-14 rounded-xl overflow-hidden border border-gray-600 bg-gray-750 flex flex-col items-center">
                <div className="w-full bg-blue-600 py-0.5 text-center text-white text-[11px] font-bold tracking-wide">
                  {formatWeekDay(startTime)}
                </div>
                <div className="flex-1 flex flex-col items-center justify-center py-1">
                  <span className="text-white text-2xl font-bold leading-none">{formatDayNum(startTime)}</span>
                  <span className="text-gray-400 text-[11px] mt-0.5">{formatMonth(startTime)}</span>
                </div>
              </div>
            )}
            {/* Info */}
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm truncate">{emoji} {reminderTitle}</p>
              {/* Time */}
              <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <span>{startTime ? formatReminderDateFull(startTime) : description}</span>
              </div>
              {/* Repeat */}
              {repeatText && (
                <div className="flex items-center gap-1 mt-0.5 text-xs text-orange-400">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/>
                    <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>
                  </svg>
                  <span>{repeatText}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Standard ecard (group events etc.) ──
  const actions: any[] = (params.actions || []).filter(
    (a: any) => a.actionId === 'action.group.open.admintool'
  );

  return (
    <div className="flex justify-center w-full my-1">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden max-w-[280px] w-full shadow-lg">
        {/* Ảnh header */}
        {imageHref && (
          <div className="w-full h-28 overflow-hidden bg-gray-700">
            <img
              src={imageHref}
              alt={title}
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        )}
        {/* Nội dung */}
        <div className="px-4 py-3 space-y-1">
          {title && (
            <p className="text-white font-semibold text-sm leading-snug">{title}</p>
          )}
          {description && (
            <p className="text-gray-400 text-xs leading-relaxed">{description}</p>
          )}
        </div>
        {/* Actions — chỉ nút Quản lý nhóm */}
        {actions.length > 0 && onManage && (
          <div className="border-t border-gray-700">
            {actions.map((a: any, i: number) => (
              <button
                key={i}
                onClick={onManage}
                className="w-full px-4 py-2.5 text-sm text-blue-400 hover:bg-gray-700 hover:text-blue-300 transition-colors font-medium text-center"
              >
                {a.name || 'Quản lý nhóm'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CardBubble({ msg, isSent, onOpenProfile }: { msg: any; isSent: boolean; onOpenProfile?: (userId: string, e: React.MouseEvent) => void }) {
  let parsed: any = {};
  try { parsed = JSON.parse(msg.content || '{}'); } catch {}
  const action = String(parsed.action || '');
  if (action === 'recommened.link') return <LinkBubble parsed={parsed} isSent={isSent} />;
  // recommened.calltime = cuộc gọi có thời gian, recommened.misscall = cuộc gọi nhỡ
  if (action === 'recommened.calltime' || action === 'recommened.misscall') return <CallBubble parsed={parsed} isSent={isSent} />;
  return <ContactCardBubble parsed={parsed} isSent={isSent} onOpenProfile={onOpenProfile} />;
}

// ─── LinkBubble — hiển thị tin nhắn link preview như Zalo ────────────────────
function LinkBubble({ parsed, isSent }: { parsed: any; isSent: boolean }) {
  const href = String(parsed.href || parsed.title || '');
  const params = (() => { try { const p = parsed.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
  const rawTitle = String(parsed.title || '').trim();
  const mediaTitle = String(params.mediaTitle || '').trim();
  const domain = String(params.src || '').trim();
  const description = String(parsed.description || '').trim();
  const thumb = String(parsed.thumb || '');

  // chat.recommended có thể chứa "text + url" trong title.
  // Ưu tiên tách phần text user nhập để hiển thị đúng ý nghĩa tin nhắn.
  const stripKnownLinks = (txt: string): string => {
    let out = txt;
    if (href) out = out.split(href).join(' ');
    if (mediaTitle) out = out.split(mediaTitle).join(' ');
    out = out.replace(/https?:\/\/\S+/gi, ' ');
    return out.replace(/\s+/g, ' ').trim();
  };

  const userCaption = stripKnownLinks(rawTitle);
  const displayTitle = userCaption || rawTitle || mediaTitle || href;
  const primaryUrl = (href || mediaTitle || description).trim();
  const urlLine = primaryUrl && primaryUrl !== displayTitle ? primaryUrl : '';
  const derivedDomain = (() => {
    if (domain) return domain;
    if (!primaryUrl) return '';
    try { return new URL(primaryUrl).hostname || ''; } catch { return ''; }
  })();

  // Shorten description if too long
  const descriptionIsDuplicate =
    !!description &&
    (description === href || description === mediaTitle || description === displayTitle);
  const displayDesc = descriptionIsDuplicate ? '' : description;
  const shortDesc = displayDesc.length > 100 ? displayDesc.substring(0, 100) + '...' : displayDesc;
  const previewTitle = mediaTitle && mediaTitle !== displayTitle ? mediaTitle : (derivedDomain || href);

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl min-w-[260px] max-w-sm text-left shadow-lg ${isSent ? 'bg-gray-750' : 'bg-gray-800'} border ${isSent ? 'border-gray-700' : 'border-gray-700'}`}
    >
      {/* Message content: text + link — hiển thị bình thường, không bấm mở link */}
      <div className="px-3 py-2.5 space-y-1.5 select-text cursor-text">
        {displayTitle && (
          <p className="text-sm text-white leading-snug">
            {displayTitle}
          </p>
        )}

        {urlLine && (
          <p className="text-xs text-blue-500 leading-relaxed line-clamp-2 break-all">
            {urlLine}
          </p>
        )}
        
        {/* Description */}
        {shortDesc && (
          <p className="text-xs text-gray-400 leading-relaxed line-clamp-2">
            {shortDesc}
          </p>
        )}
      </div>

      {/* Preview section — CHỈ bấm vào đây mới mở link */}
      <button
        onClick={() => href && ipc.shell?.openExternal(href)}
        className="mx-2 mb-2 border border-gray-700/80 rounded-xl overflow-hidden bg-gray-900/60 text-left cursor-pointer hover:opacity-90 active:scale-[0.98] transition-all"
        title={href}
      >
        {thumb && (
          <div className="w-full h-36 overflow-hidden bg-gray-900 flex-shrink-0">
            <img
              src={thumb}
              alt={previewTitle}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                (e.target as HTMLImageElement).parentElement!.style.display = 'none';
              }}
            />
          </div>
        )}
        <div className="px-2.5 py-2 space-y-1">
          {previewTitle && (
            <p className="text-xs text-white leading-snug line-clamp-2">{previewTitle}</p>
          )}
          {derivedDomain && (
            <p className="text-[11px] text-gray-500 truncate">{derivedDomain}</p>
          )}
        </div>
      </button>
    </div>
  );
}

// ─── CallBubble — hiển thị tin nhắn cuộc gọi ─────────────────────────────────
function CallBubble({ parsed, isSent }: { parsed: any; isSent: boolean }) {
  const params = (() => { try { const p = parsed.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
  const duration: number = params.duration || 0;
  const reason: number = params.reason || 0;
  const isCaller: boolean = params.isCaller === 1;
  const isVideo: boolean = params.calltype === 1;
  const callTypeLabel = isVideo ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
  const action = String(parsed.action || '');
  const isMissed = action === 'recommened.misscall';

  let statusLabel = 'Cuộc gọi nhỡ';
  let statusRed = true;
  if (!isMissed && duration > 0) {
    const m = Math.floor(duration / 60), s = duration % 60;
    statusLabel = `Đã kết thúc · ${m > 0 ? `${m}p ` : ''}${s}s`;
    statusRed = false;
  } else if (!isMissed && duration === 0) {
    // calltime nhưng duration=0 → cuộc gọi rất ngắn / vừa kết thúc
    statusLabel = 'Đã kết thúc';
    statusRed = false;
  } else if (reason === 4 && isCaller) {
    statusLabel = 'Bạn đã hủy'; statusRed = false;
  } else if (reason === 2) {
    statusLabel = isCaller ? 'Đã từ chối' : 'Bạn đã từ chối';
  }

  return (
    <div className={`flex flex-col px-3 py-2.5 rounded-2xl min-w-[200px] max-w-xs ${isSent ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${isSent ? 'bg-blue-500' : 'bg-gray-600'}`}>
          {isVideo ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.63 19.79 19.79 0 01.01 1a2 2 0 012-2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${statusRed ? 'text-red-400' : isSent ? 'text-white' : 'text-gray-200'}`}>{statusLabel}</p>
          <p className={`text-xs mt-0.5 ${isSent ? 'text-blue-200' : 'text-gray-400'}`}>{callTypeLabel}</p>
        </div>
      </div>
    </div>
  );
}

// ─── ContactCardBubble — hiển thị danh thiếp Zalo ────────────────────────────
function ContactCardBubble({ parsed, isSent, onOpenProfile }: { parsed: any; isSent: boolean; onOpenProfile?: (userId: string, e: React.MouseEvent) => void }) {
  const title = parsed.title || '';
  const thumbUrl = parsed.thumb || '';
  const desc = typeof parsed.description === 'string'
    ? (() => { try { return JSON.parse(parsed.description); } catch { return {}; } })()
    : (parsed.description || {});
  let phone = formatPhone(String(desc.phone || ''));
  const qrCodeUrl = String(desc.qrCodeUrl || '');
  const { contacts } = useChatStore();
  const { activeAccountId } = useAccountStore();
  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];

  const directUid = String(
    desc.uid ||
    desc.userId ||
    desc.id ||
    parsed.userId ||
    parsed.uid ||
    parsed.id ||
    ''
  ).trim();
  const paramsUid = typeof parsed.params === 'string' ? parsed.params.trim() : '';
  const gUid = String(desc.gUid || parsed.gUid || '').trim();

  const normalizePhoneDigits = (v: string): string => String(v || '').replace(/\D/g, '');
  const targetPhoneDigits = normalizePhoneDigits(String(desc.phone || ''));

  const byDirectId = directUid
    ? contactList.find(c => String(c.contact_id || '') === directUid)
    : undefined;
  const byParamsId = paramsUid && paramsUid !== '0'
    ? contactList.find(c => String(c.contact_id || '') === paramsUid)
    : undefined;
  const byPhone = targetPhoneDigits
    ? contactList.find(c => {
        const cp = normalizePhoneDigits(String(c.phone || ''));
        if (!cp) return false;
        return cp === targetPhoneDigits || cp.endsWith(targetPhoneDigits) || targetPhoneDigits.endsWith(cp);
      })
    : undefined;

  const resolvedUserId = String(
    byDirectId?.contact_id ||
    byParamsId?.contact_id ||
    byPhone?.contact_id ||
    directUid ||
    (paramsUid && paramsUid !== '0' ? paramsUid : '') ||
    gUid ||
    ''
  ).trim();

  const handleOpenCardChat = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resolvedUserId) return;
    const activeZaloId = useAccountStore.getState().activeAccountId || undefined;
    useAppStore.getState().openQuickChat({
      zaloId: activeZaloId,
      target: {
        userId: resolvedUserId,
        displayName: title || resolvedUserId,
        avatarUrl: thumbUrl || undefined,
        threadType: 0,
        phone: phone || undefined,
      },
    });
  };

  const handleOpenProfile = (e: React.MouseEvent) => {
    if (!resolvedUserId || !onOpenProfile) return;
    onOpenProfile(resolvedUserId, e);
  };

  return (
    <div
      className={`rounded-2xl max-w-[340px] overflow-hidden ${isSent ? 'bg-blue-600/70 text-white' : 'bg-gray-700 text-gray-200'} ${resolvedUserId ? 'cursor-pointer hover:opacity-95 transition-opacity' : ''}`}
      onClick={handleOpenProfile}
    >
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <div className="w-14 h-14 rounded-full overflow-hidden flex-shrink-0 bg-gray-600">
          {thumbUrl ? (
            <img src={thumbUrl} alt={title} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white text-xl font-bold">{(title || 'U').charAt(0).toUpperCase()}</div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold truncate">{title || 'Danh thiếp'}</p>
          {phone && <p className={`text-sm mt-1 ${isSent ? 'text-blue-100' : 'text-gray-300'}`}>{phone}</p>}
          <p className={`text-xs mt-1 ${isSent ? 'text-blue-200' : 'text-gray-500'}`}>Danh thiếp Zalo</p>
        </div>
        {qrCodeUrl && (
          <div className="w-12 h-12 flex-shrink-0">
            <img src={qrCodeUrl} alt="QR" className="w-full h-full object-contain rounded" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
      </div>

      {resolvedUserId && (
        <div className={`px-4 pb-3.5 ${isSent ? 'bg-blue-700/40' : 'bg-gray-800/50'} border-t ${isSent ? 'border-blue-400/25' : 'border-gray-600/70'}`}>
          <button
            onClick={handleOpenCardChat}
            className={`mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
              isSent
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
            title="Gửi tin nhắn"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Gửi tin nhắn
          </button>
        </div>
      )}
    </div>
  );
}

// ─── BankCardBubble — imported from MessageBubbles (shared component) ────────

// ─── RtfBubble — webchat + action=rtf (rich text formatting) ────────────────
// Zalo TextStyle: b=bold, i=italic, u=underline, s=strikethrough
// Colors: c_db342e=red, c_f27806=orange, c_f7b503=yellow, c_15a85f=green
// Size: f_13=small, f_18=big
// List: lst_1=unordered, lst_2=ordered, ind_X=indent

const RTF_COLOR_MAP: Record<string, string> = {
  'c_db342e': '#db342e',
  'c_f27806': '#f27806',
  'c_f7b503': '#f7b503',
  'c_15a85f': '#15a85f',
};

interface RtfStyle {
  start: number;
  len: number;
  st: string;
  indentSize?: number;
}

interface RtfMention {
  pos: number;
  len: number;
  uid: string;
}

function applyRtfStyles(text: string, styles: RtfStyle[], mentions?: RtfMention[], onMentionClick?: (uid: string, e: React.MouseEvent) => void): React.ReactNode {
  if (!text) return null;

  // Build character-level style map
  type CharStyle = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; small?: boolean; big?: boolean; mentionUid?: string };
  const charStyles: CharStyle[] = Array.from({ length: text.length }, () => ({}));

  // Apply RTF styles (st can be comma-separated like "b,c_db342e")
  for (const style of (styles || [])) {
    const { start, len } = style;
    const parts = String(style.st || '').split(',').map(s => s.trim()).filter(Boolean);
    for (let i = start; i < Math.min(start + len, text.length); i++) {
      const cs = charStyles[i];
      for (const st of parts) {
        if (st === 'b') cs.bold = true;
        else if (st === 'i') cs.italic = true;
        else if (st === 'u') cs.underline = true;
        else if (st === 's') cs.strike = true;
        else if (st === 'f_13') cs.small = true;
        else if (st === 'f_18') cs.big = true;
        else if (st in RTF_COLOR_MAP) cs.color = RTF_COLOR_MAP[st];
      }
    }
  }

  // Apply mention highlights with uid tracking
  for (const mention of (mentions || [])) {
    for (let i = mention.pos; i < Math.min(mention.pos + mention.len, text.length); i++) {
      charStyles[i].mentionUid = mention.uid || 'unknown';
    }
  }

  // Merge consecutive chars with same style into spans
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const cs = charStyles[i];
    let j = i + 1;
    while (j < text.length && JSON.stringify(charStyles[j]) === JSON.stringify(cs)) j++;
    const chunk = convertZaloEmojis(text.slice(i, j));
    const inlineStyle: React.CSSProperties = {};
    const cls: string[] = [];
    if (cs.bold) cls.push('font-bold');
    if (cs.italic) cls.push('italic');
    if (cs.underline) cls.push('underline');
    if (cs.strike) cls.push('line-through');
    if (cs.small) cls.push('text-xs');
    if (cs.big) cls.push('text-base font-medium');
    if (cs.mentionUid) {
      cls.push('font-semibold');
      if (onMentionClick && cs.mentionUid !== 'unknown') cls.push('cursor-pointer hover:underline');
      inlineStyle.color = '#60a5fa';
    } else if (cs.color) {
      inlineStyle.color = cs.color;
    }
    const uid = cs.mentionUid;
    nodes.push(
      <span
        key={i}
        className={cls.join(' ')}
        style={Object.keys(inlineStyle).length ? inlineStyle : undefined}
        onClick={uid && uid !== 'unknown' && onMentionClick ? (e) => { e.stopPropagation(); onMentionClick(uid, e); } : undefined}
      >{chunk}</span>
    );
    i = j;
  }

  return <span className="whitespace-pre-wrap select-text">{nodes}</span>;
}

/** Render normal text, highlighting @mentions in blue, with optional click-to-profile */
function TextWithMentions({
  text,
  allContacts,
  groupMembersList,
  onMentionClick,
  highlight,
}: {
  text: string;
  allContacts?: any[];
  groupMembersList?: any[];
  onMentionClick?: (userId: string, e: React.MouseEvent) => void;
  highlight?: string;
}) {
  if (!text) return null;
  const converted = convertZaloEmojis(text);

  // Helper: wrap text segment with search highlight marks
  const applyHighlight = (str: string, key: string | number): React.ReactNode => {
    if (!highlight || !highlight.trim()) return <span key={key}>{str}</span>;
    const q = highlight.toLowerCase();
    const lower = str.toLowerCase();
    const parts: React.ReactNode[] = [];
    let last = 0;
    let hi = lower.indexOf(q, 0);
    while (hi !== -1) {
      if (hi > last) parts.push(<span key={`${key}_t${hi}`}>{str.slice(last, hi)}</span>);
      parts.push(
        <mark key={`${key}_h${hi}`} className="bg-yellow-400/40 text-yellow-200 rounded-sm px-0.5">
          {str.slice(hi, hi + highlight.length)}
        </mark>
      );
      last = hi + highlight.length;
      hi = lower.indexOf(q, last);
    }
    if (last < str.length) parts.push(<span key={`${key}_e${last}`}>{str.slice(last)}</span>);
    return parts.length ? <React.Fragment key={key}>{parts}</React.Fragment> : <span key={key}>{str}</span>;
  };

  // Match @Name: greedy - capture everything after @ until a newline or double-space
  // We try to find the longest matching display name from contacts/members
  const allPeople = [...(allContacts || []), ...(groupMembersList || [])];

  // Build segments by scanning for @ then greedily matching known display names
  const segments: React.ReactNode[] = [];
  let i = 0;
  while (i < converted.length) {
    const atIdx = converted.indexOf('@', i);
    if (atIdx === -1) {
      segments.push(applyHighlight(converted.slice(i), i));
      break;
    }
    // Text before @
    if (atIdx > i) segments.push(applyHighlight(converted.slice(i, atIdx), i));

    // Try to match a known display name after @
    let matched = false;
    if (allPeople.length > 0) {
      // Sort longest name first for greedy match
      const sorted = [...allPeople].sort((a, b) => {
        const na = (a.display_name || a.displayName || '').length;
        const nb = (b.display_name || b.displayName || '').length;
        return nb - na;
      });
      for (const person of sorted) {
        const name = person.display_name || person.displayName || '';
        if (!name) continue;
        const expected = '@' + name;
        if (converted.startsWith(expected, atIdx)) {
          const uid = person.contact_id || person.userId || '';
          const mentionText = expected;
          segments.push(
            <span
              key={atIdx}
              className={`font-semibold${uid && onMentionClick ? ' cursor-pointer hover:underline' : ''}`}
              style={{ color: '#8dc1ff' }}
              onClick={uid && onMentionClick ? (e) => { e.stopPropagation(); onMentionClick(uid, e); } : undefined}
            >{mentionText}</span>
          );
          i = atIdx + mentionText.length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      // No name match — grab @word (stop at whitespace)
      const restStr = converted.slice(atIdx + 1);
      const spaceIdx = restStr.search(/[\s,!?;:\n]/);
      const end = spaceIdx === -1 ? converted.length : atIdx + 1 + spaceIdx;
      const mentionText = converted.slice(atIdx, end);
      segments.push(
        <span key={atIdx} className="font-semibold" style={{ color: '#79b4fd' }}>{mentionText}</span>
      );
      i = end;
    }
  }

  if (segments.length === 0) return <span className="whitespace-pre-wrap select-text">{converted}</span>;
  return <span className="whitespace-pre-wrap select-text">{segments}</span>;
}

function RtfBubble({
  msg,
  allContacts,
  groupMembersList,
  onMentionClick,
}: {
  msg: any;
  allContacts?: any[];
  groupMembersList?: any[];
  onMentionClick?: (userId: string, e: React.MouseEvent) => void;
}) {
  let title = '';
  let styles: RtfStyle[] = [];
  let mentions: RtfMention[] = [];

  try {
    const parsed = JSON.parse(msg.content || '{}');
    title = parsed.title || '';
    const paramsRaw = parsed.params;
    const params = typeof paramsRaw === 'string' ? JSON.parse(paramsRaw) : (paramsRaw || {});
    styles = params.styles || [];
    mentions = params.mentions || [];
  } catch {}

  if (!title) return <span className="text-xs opacity-60">[Tin nhắn định dạng]</span>;

  return (
    <span>{applyRtfStyles(title, styles, mentions, onMentionClick)}</span>
  );
}

export function ActionRow({ icon, label, onClick, textColor = 'text-gray-300' }: {
  icon: React.ReactNode; label: string; onClick: () => void; textColor?: string;
}) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700/50 transition-colors text-left ${textColor}`}>
      <span className="flex-shrink-0 text-gray-400">{icon}</span>
      <span className="text-sm">{label}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto text-gray-600 flex-shrink-0">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );
}


function ForwardMessageModal({ msg, contacts, onClose, onForward }: {
  msg: any;
  contacts: any[];
  onClose: () => void;
  onForward: (threadId: string, threadType: number) => Promise<void>;
}) {
  const { labels: allLabels, groupInfoCache } = useAppStore();
  const { activeAccountId } = useAccountStore();
  const labels = activeAccountId ? (allLabels[activeAccountId] || []) : [];

  const [search, setSearch] = React.useState('');
  const [tab, setTab] = React.useState<'recent' | 'friends' | 'groups' | 'categories'>('recent');
  const [selectedLabelId, setSelectedLabelId] = React.useState<number | null>(null);
  const [forwarding, setForwarding] = React.useState<string | null>(null);
  const [labelSource, setLabelSource] = React.useState<'local' | 'zalo'>('local');

  // ── Local labels ──────────────────────────────────────────────────────────
  const [localLabels, setLocalLabels] = React.useState<{ id: number; name: string; color: string; text_color?: string; emoji?: string }[]>([]);
  const [localLabelThreadMap, setLocalLabelThreadMap] = React.useState<Record<string, number[]>>({});

  React.useEffect(() => {
    if (!activeAccountId) return;
    (async () => {
      try {
        const [labelsRes, threadsRes] = await Promise.all([
          ipc.db?.getLocalLabels({ zaloId: activeAccountId }),
          ipc.db?.getLocalLabelThreads({ zaloId: activeAccountId }),
        ]);
        const raw = (labelsRes?.labels || [])
          .filter((l: any) => (l?.is_active ?? 1) === 1)
          .sort((a: any, b: any) => {
            const sa = Number(a?.sort_order ?? 0);
            const sb = Number(b?.sort_order ?? 0);
            if (sa !== sb) return sa - sb;
            return String(a?.name || '').localeCompare(String(b?.name || ''));
          });
        setLocalLabels(raw);
        const map: Record<string, number[]> = {};
        (threadsRes?.threads || []).forEach((row: any) => {
          const tid = String(row.thread_id || '');
          if (!tid) return;
          if (!map[tid]) map[tid] = [];
          map[tid].push(Number(row.label_id));
        });
        setLocalLabelThreadMap(map);
      } catch {}
    })();
  }, [activeAccountId]);

  // Build a reverse map: localLabelId -> Set<threadId>
  const localLabelToThreads = React.useMemo(() => {
    const m: Record<number, Set<string>> = {};
    for (const [tid, lids] of Object.entries(localLabelThreadMap)) {
      for (const lid of lids) {
        if (!m[lid]) m[lid] = new Set();
        m[lid].add(tid);
      }
    }
    return m;
  }, [localLabelThreadMap]);

  const activeLabelsForPills = labelSource === 'local' ? localLabels : labels;

  const getFiltered = () => {
    let list = contacts;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => (c.display_name || c.contact_id || '').toLowerCase().includes(q));
    }
    switch (tab) {
      case 'recent':
        return [...list].sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
      case 'friends':
        return list.filter(c => c.contact_type !== 'group').sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
      case 'groups':
        return list.filter(c => c.contact_type === 'group').sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
      case 'categories': {
        if (labelSource === 'local') {
          if (selectedLabelId !== null) {
            const threadSet = localLabelToThreads[selectedLabelId] || new Set();
            return list.filter(c => threadSet.has(c.contact_id));
          }
          // All local-labeled threads
          const allLabeledIds = new Set(Object.keys(localLabelThreadMap));
          return [...list].filter(c => allLabeledIds.has(c.contact_id)).sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
        } else {
          const targetLabel = selectedLabelId !== null ? labels.find(l => l.id === selectedLabelId) : null;
          if (targetLabel) return list.filter(c => targetLabel.conversations.includes(c.contact_id));
          const labeledIds = new Set(labels.flatMap(l => l.conversations));
          return [...list].filter(c => labeledIds.has(c.contact_id)).sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
        }
      }
      default: return list;
    }
  };

  const filtered = getFiltered();

  const handleSelect = async (contact: any) => {
    if (forwarding) return;
    setForwarding(contact.contact_id);
    try { await onForward(contact.contact_id, contact.contact_type === 'group' ? 1 : 0); }
    finally { setForwarding(null); }
  };

  const previewText = (() => {
    try {
      const c = msg.content;
      if (!c || c === 'null') return '[Tin nhắn]';
      const parsed = JSON.parse(c);
      if (typeof parsed === 'string') return parsed;
      if (parsed?.title) return `📂 ${parsed.title}`;
      if (parsed?.href || parsed?.thumb) return '[Hình ảnh]';
      if (parsed?.msg) return String(parsed.msg);
      return '[Tin nhắn]';
    } catch { return msg.content || '[Tin nhắn]'; }
  })();

  const TABS: { key: 'recent' | 'friends' | 'groups' | 'categories'; label: string; icon: React.ReactNode }[] = [
    { key: 'recent', label: 'Gần nhất', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
    { key: 'friends', label: 'Bạn bè', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
    { key: 'groups', label: 'Nhóm', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> },
    { key: 'categories', label: 'Nhãn', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> },
  ];

  // Helper to get contact labels for display in categories tab
  const getContactLabelBadges = (contactId: string) => {
    if (labelSource === 'local') {
      const lids = localLabelThreadMap[contactId] || [];
      if (!lids.length) return null;
      const matched = lids.map(lid => localLabels.find(l => l.id === lid)).filter(Boolean) as typeof localLabels;
      if (!matched.length) return null;
      return (
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          {matched.map(l => (
            <span key={l.id} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: (l.color || '#3b82f6') + '30', color: l.color || '#3b82f6', border: `1px solid ${l.color || '#3b82f6'}60` }}>
              {l.emoji ? `${l.emoji} ` : ''}{l.name}
            </span>
          ))}
        </div>
      );
    } else {
      const clabels = labels.filter(l => l.conversations.includes(contactId));
      if (!clabels.length) return null;
      return (
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          {clabels.map(l => (
            <span key={l.id} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: (l.color || '#3b82f6') + '30', color: l.color || '#3b82f6', border: `1px solid ${l.color || '#3b82f6'}60` }}>
              {l.emoji} {l.text}
            </span>
          ))}
        </div>
      );
    }
  };

  const grpCache = activeAccountId ? (groupInfoCache[activeAccountId] || {}) : {};

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-800 rounded-2xl shadow-2xl w-[420px] max-h-[85vh] flex flex-col border border-gray-700 overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div>
            <h2 className="text-white font-semibold text-base">Chuyển tiếp tin nhắn</h2>
            <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[300px]">{previewText}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-700 flex-shrink-0">
          {TABS.map(t => (
            <button key={t.key}
              onClick={() => { setTab(t.key); setSelectedLabelId(null); }}
              className={`flex-1 flex items-center justify-center gap-1 py-2.5 text-xs transition-colors border-b-2 ${tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Label source tabs + filter pills — only for categories tab */}
        {tab === 'categories' && (
          <div className="border-b border-gray-700 flex-shrink-0">
            {/* Local / Zalo sub-tabs */}
            <div className="flex items-center gap-1 px-3 pt-2 pb-1">
              <button
                onClick={() => { setLabelSource('local'); setSelectedLabelId(null); }}
                className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${labelSource === 'local' ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'}`}
              >💾 Local</button>
              <button
                onClick={() => { setLabelSource('zalo'); setSelectedLabelId(null); }}
                className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${labelSource === 'zalo' ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'}`}
              >☁️ Zalo</button>
            </div>

            {/* Label pills */}
            {activeLabelsForPills.length > 0 && (
              <div className="px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto">
                <button
                  onClick={() => setSelectedLabelId(null)}
                  className={`flex-shrink-0 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === null ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500'}`}
                >Tất cả</button>
                {labelSource === 'local'
                  ? localLabels.map(l => (
                    <button key={l.id}
                      onClick={() => setSelectedLabelId(selectedLabelId === l.id ? null : l.id)}
                      className={`flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === l.id ? 'text-white' : 'text-gray-300 hover:border-gray-400'}`}
                      style={{ borderColor: selectedLabelId === l.id ? (l.color || '#3b82f6') : '#4b5563', backgroundColor: selectedLabelId === l.id ? (l.color || '#3b82f6') + '40' : 'transparent' }}
                    >
                      {l.emoji && <span>{l.emoji}</span>}
                      <span>{l.name}</span>
                    </button>
                  ))
                  : labels.map(l => (
                    <button key={l.id}
                      onClick={() => setSelectedLabelId(selectedLabelId === l.id ? null : l.id)}
                      className={`flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === l.id ? 'text-white' : 'text-gray-300 hover:border-gray-400'}`}
                      style={{ borderColor: selectedLabelId === l.id ? (l.color || '#3b82f6') : '#4b5563', backgroundColor: selectedLabelId === l.id ? (l.color || '#3b82f6') + '40' : 'transparent' }}
                    >
                      {l.emoji && <span>{l.emoji}</span>}
                      <span>{l.text}</span>
                    </button>
                  ))
                }
              </div>
            )}
          </div>
        )}

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
              placeholder="Tìm hội thoại..."
              className="w-full bg-gray-700 border border-gray-600 rounded-full pl-9 pr-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Contact list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-40"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <p className="text-sm">Không tìm thấy</p>
            </div>
          ) : filtered.map(c => (
            <button
              key={c.contact_id}
              onClick={() => handleSelect(c)}
              disabled={!!forwarding}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700 transition-colors text-left disabled:opacity-60"
            >
              {c.contact_type === 'group' ? (
                <GroupAvatar
                  avatarUrl={c.avatar_url}
                  groupInfo={grpCache[c.contact_id]}
                  name={c.display_name || c.contact_id}
                  size="md"
                />
              ) : c.avatar_url ? (
                <img src={c.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 bg-blue-600">
                  {(c.display_name || 'U').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 truncate">{c.display_name || c.contact_id}</p>
                {c.contact_type === 'group'
                  ? <p className="text-xs text-gray-500">Nhóm</p>
                  : c.last_message_time
                    ? <p className="text-xs text-gray-500">{formatMsgTime(c.last_message_time)}</p>
                    : null}
                {tab === 'categories' && getContactLabelBadges(c.contact_id)}
              </div>
              {forwarding === c.contact_id && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin text-blue-400 flex-shrink-0"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── NoteViewModal ────────────────────────────────────────────────────────────
export function NoteViewModal({ topicId, initialTitle, groupId, onClose, onNotePinned, creatorName, createTime, isGroup: isGroupProp, activeAccountId: activeAccountIdProp }: {
  topicId?: string;
  initialTitle: string;
  groupId: string;
  onClose: () => void;
  onNotePinned?: (note: PinnedNote) => void;
  creatorName?: string;
  createTime?: number;
  isGroup?: boolean;
  activeAccountId?: string;
}) {
  // Tab: 'zalo' only available for group conversations
  const showZaloTab = !!isGroupProp;
  const [activeTab, setActiveTab] = React.useState<'zalo' | 'local'>(showZaloTab ? 'zalo' : 'local');

  // ── Local notes state ──
  const [localNotes, setLocalNotes] = React.useState<any[]>([]);
  const [localNoteLoading, setLocalNoteLoading] = React.useState(false);
  const [newNoteText, setNewNoteText] = React.useState('');
  const [editNoteId, setEditNoteId] = React.useState<number | null>(null);
  const [editNoteText, setEditNoteText] = React.useState('');
  const [savingLocal, setSavingLocal] = React.useState(false);
  const zaloId = activeAccountIdProp || useAccountStore.getState().activeAccountId || '';

  // Load local notes when tab = 'local'
  React.useEffect(() => {
    if (activeTab !== 'local' || !zaloId || !groupId) return;
    setLocalNoteLoading(true);
    ipc.crm?.getNotes({ zaloId, contactId: groupId })
      .then((res: any) => setLocalNotes(res?.notes || []))
      .catch(() => {})
      .finally(() => setLocalNoteLoading(false));
  }, [activeTab, zaloId, groupId]);

  const handleAddLocalNote = async () => {
    if (!newNoteText.trim() || !zaloId) return;
    setSavingLocal(true);
    try {
      const res = await ipc.crm?.saveNote({ zaloId, note: { contact_id: groupId, content: newNoteText.trim() } });
      if (res?.success) {
        setNewNoteText('');
        const reload = await ipc.crm?.getNotes({ zaloId, contactId: groupId });
        setLocalNotes(reload?.notes || []);
        showNotification('Đã thêm ghi chú', 'success');
      }
    } catch {} finally { setSavingLocal(false); }
  };

  const handleEditLocalNote = async (note: any) => {
    if (!editNoteText.trim() || !zaloId) return;
    setSavingLocal(true);
    try {
      await ipc.crm?.saveNote({ zaloId, note: { id: note.id, contact_id: groupId, content: editNoteText.trim() } });
      setEditNoteId(null);
      const reload = await ipc.crm?.getNotes({ zaloId, contactId: groupId });
      setLocalNotes(reload?.notes || []);
      showNotification('Đã cập nhật ghi chú', 'success');
    } catch {} finally { setSavingLocal(false); }
  };

  const handleDeleteLocalNote = async (noteId: number) => {
    if (!zaloId) return;
    await ipc.crm?.deleteNote({ zaloId, noteId });
    setLocalNotes(prev => prev.filter((n: any) => n.id !== noteId));
    showNotification('Đã xóa ghi chú', 'success');
  };

  // 'view' mode when opening an existing note, 'edit' mode when creating or editing
  const [mode, setMode] = React.useState<'view' | 'edit'>(topicId ? 'view' : 'edit');
  const [title, setTitle] = React.useState(initialTitle);
  const [pinAct, setPinAct] = React.useState(!!topicId);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const { showNotification } = useAppStore();
  const { getActiveAccount } = useAccountStore();
  const isEdit = !!topicId;

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  const handleSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) { setError('Tiêu đề không được để trống'); return; }
    const auth = getAuth();
    if (!auth) return;
    setSaving(true);
    setError('');
    try {
      let res: any;
      if (isEdit && topicId) {
        res = await ipc.zalo?.editNote({ auth, groupId, topicId, title: trimmed, pinAct });
      } else {
        res = await ipc.zalo?.createNote({ auth, groupId, title: trimmed, pinAct });
      }
      if (res?.success === false) {
        setError(res.error || 'Thao tác thất bại');
        return;
      }
      if (pinAct && onNotePinned) {
        const noteId = res?.response?.id || res?.response?.topicId || topicId || String(Date.now());
        onNotePinned({
          topicId: String(noteId),
          title: trimmed,
          creatorId: '',
          createTime: Date.now(),
          editTime: Date.now(),
        });
      }
      showNotification(isEdit ? 'Đã cập nhật ghi chú' : 'Đã tạo ghi chú', 'success');
      onClose();
    } catch (e: any) {
      setError(e.message || 'Lỗi không xác định');
    } finally {
      setSaving(false);
    }
  };

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // ── Format create time ──
  const formatNoteTime = (ts?: number): string => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    return isToday ? `${hm} Hôm nay` : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ` ${hm}`;
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 flex-shrink-0">
          <span className="font-semibold text-white text-base">Ghi chú</span>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-gray-700">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Tabs: only show if group has Zalo notes */}
        {showZaloTab && (
          <div className="flex border-b border-gray-700 flex-shrink-0 px-4 pt-2 gap-1">
            <button onClick={() => setActiveTab('zalo')}
              className={`px-4 py-1.5 rounded-t-lg text-sm font-medium transition-colors ${activeTab === 'zalo' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'}`}>
              ☁️ Zalo
            </button>
            <button onClick={() => setActiveTab('local')}
              className={`px-4 py-1.5 rounded-t-lg text-sm font-medium transition-colors ${activeTab === 'local' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'}`}>
              💾 Local
            </button>
          </div>
        )}

        {/* ── Zalo tab ── */}
        {activeTab === 'zalo' && (
          <>
            {mode === 'view' ? (
              <>
                <div className="px-5 py-5 min-h-[120px] overflow-y-auto">
                  {(creatorName || createTime) && (
                    <p className="text-xs text-gray-400 text-center mb-4">
                      {creatorName ? `Tạo bởi ${creatorName}` : 'Ghi chú'}
                      {createTime ? ` - ${formatNoteTime(createTime)}` : ''}
                    </p>
                  )}
                  <p className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap">{title || <span className="text-gray-500 italic">Không có nội dung</span>}</p>
                </div>
                <div className="flex items-center gap-3 px-5 pb-5 pt-2 border-t border-gray-700/50 flex-shrink-0">
                  <button onClick={() => { navigator.clipboard.writeText(title).catch(() => {}); showNotification('Đã sao chép', 'success'); }}
                    className="w-10 h-10 rounded-xl bg-gray-700 hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors flex-shrink-0" title="Sao chép">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/>
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                  </button>
                  <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-200 font-medium transition-colors">Đóng</button>
                  <button onClick={() => setMode('edit')} className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm text-white font-semibold transition-colors">Chỉnh sửa</button>
                </div>
              </>
            ) : (
              <>
                <div className="px-5 py-4 space-y-4 overflow-y-auto">
                  <div>
                    <label className="text-xs text-gray-400 font-medium block mb-1.5">Nội dung ghi chú</label>
                    <textarea autoFocus value={title} onChange={e => { setTitle(e.target.value); setError(''); }}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave(); }}
                      placeholder="Nhập nội dung ghi chú..." rows={4}
                      className="w-full bg-gray-700 border border-gray-600 focus:border-blue-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none resize-none transition-colors" />
                    {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
                  </div>
                  <div className="flex items-center justify-between py-2 px-3 bg-gray-700/50 rounded-xl">
                    <div>
                      <p className="text-sm text-gray-200 font-medium">Ghim ghi chú</p>
                      <p className="text-xs text-gray-500">Hiển thị ở đầu hội thoại</p>
                    </div>
                    <button type="button" onClick={() => setPinAct(v => !v)}
                      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${pinAct ? 'bg-blue-500' : 'bg-gray-600'}`}>
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${pinAct ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                </div>
                <div className="flex gap-3 px-5 pb-5 pt-1 flex-shrink-0">
                  <button onClick={() => isEdit ? setMode('view') : onClose()} className="flex-1 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition-colors">Huỷ</button>
                  <button onClick={handleSave} disabled={saving || !title.trim()}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-semibold transition-colors flex items-center justify-center gap-2">
                    {saving && <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
                    {isEdit ? 'Lưu thay đổi' : 'Tạo ghi chú'}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {/* ── Local tab ── */}
        {activeTab === 'local' && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {localNoteLoading ? (
                <div className="flex items-center justify-center py-6">
                  <svg className="animate-spin w-5 h-5 text-green-400" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                </div>
              ) : localNotes.length === 0 ? (
                <p className="text-xs text-gray-500 text-center py-4">Chưa có ghi chú local nào</p>
              ) : localNotes.map((note: any) => (
                <div key={note.id} className="bg-gray-700/50 border border-gray-600/50 rounded-xl p-3 group">
                  {editNoteId === note.id ? (
                    <div className="space-y-2">
                      <textarea autoFocus value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={3}
                        className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none" />
                      <div className="flex gap-2">
                        <button onClick={() => setEditNoteId(null)} className="flex-1 py-1.5 rounded-lg bg-gray-600 text-xs text-gray-300 hover:bg-gray-500 transition-colors">Huỷ</button>
                        <button onClick={() => handleEditLocalNote(note)} disabled={savingLocal} className="flex-1 py-1.5 rounded-lg bg-blue-600 text-xs text-white hover:bg-blue-500 disabled:opacity-50 transition-colors">Lưu</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{note.content}</p>
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[11px] text-gray-500">{formatNoteTime(note.updated_at)}</span>
                        <div className="opacity-0 group-hover:opacity-100 flex gap-3 transition-opacity">
                          <button onClick={() => { setEditNoteId(note.id); setEditNoteText(note.content); }} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">Sửa</button>
                          <button onClick={() => handleDeleteLocalNote(note.id)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Xóa</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="px-4 pb-4 pt-2 border-t border-gray-700/50 flex-shrink-0 space-y-2">
              <textarea value={newNoteText} onChange={e => setNewNoteText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleAddLocalNote(); }}
                placeholder="Thêm ghi chú local... (Ctrl+Enter để lưu)" rows={2}
                className="w-full bg-gray-700 border border-gray-600 focus:border-green-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none resize-none transition-colors" />
              <button onClick={handleAddLocalNote} disabled={savingLocal || !newNoteText.trim()}
                className="w-full py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-50 text-sm text-white font-semibold transition-colors">
                Lưu ghi chú
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── FriendRequestBar ─────────────────────────────────────────────────────────
// Hiển thị thanh kết bạn phía dưới pinned bar khi chat với người chưa là bạn

type FriendStatus =
  | 'loading'
  | 'friend'           // đã là bạn bè
  | 'stranger'         // chưa kết bạn
  | 'sent'             // đã gửi yêu cầu, đang chờ đối phương chấp nhận
  | 'received';        // đối phương đã gửi yêu cầu đến mình

function FriendRequestBar({ zaloId, userId, contact, getAuth, onReady }: {
  zaloId: string;
  userId: string;
  contact: any;
  getAuth: () => { cookies: string; imei: string; userAgent: string } | null;
  onReady?: () => void;
}) {
  const [status, setStatus] = React.useState<FriendStatus>('loading');
  const [sendPopupOpen, setSendPopupOpen] = React.useState(false);
  const [sendMsg, setSendMsg] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const { showNotification } = useAppStore();

  // Khi status thoát khỏi 'loading' → thông báo parent để scroll to bottom
  React.useEffect(() => {
    if (status !== 'loading') {
      onReady?.();
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check friendship + request status
  React.useEffect(() => {
    // Skip for non-Zalo channels (FB doesn't have friend requests)
    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
    if (acc && (acc.channel || 'zalo') !== 'zalo') {
      setStatus('friend'); // FB contacts are always "accessible"
      return;
    }

    // Fast sync check: contact already has is_friend flag from Zalo sync
    // Kiểm tra cả is_friend (số) và isFr (flag bổ sung trong store)
    if (contact?.is_friend === 1 || contact?.isFr === 1) {
      setStatus('friend');
      return;
    }

    let cancelled = false;
    const check = async () => {
      try {
        // 1. Check DB (friends table)
        const friendRes = await ipc.db?.isFriend({ zaloId, userId });
        if (cancelled) return;
        if (friendRes?.isFriend) { setStatus('friend'); return; }

        // 2. Confirm via Zalo API (authoritative source)
        // zca-js getFriendRequestStatus trả về: { is_friend, is_requested, is_requesting }
        // is_friend=1 → bạn bè
        // is_requested=1 → mình đã gửi yêu cầu (đang chờ đối phương chấp nhận)
        // is_requesting=1 → đối phương đã gửi yêu cầu đến mình
        const auth = getAuth();
        if (!auth) { setStatus('stranger'); return; }
        const res = await ipc.zalo?.getFriendRequestStatus({ auth, userId });
        if (cancelled) return;

        const resp = res?.response ?? res;
        if (resp?.is_friend === 1) setStatus('friend');
        else if (resp?.is_requested === 1) setStatus('sent');
        else if (resp?.is_requesting === 1) setStatus('received');
        else setStatus('stranger');
      } catch {
        if (!cancelled) setStatus('stranger');
      }
    };
    check();
    return () => { cancelled = true; };
  }, [zaloId, userId, contact?.is_friend, contact?.isFr]);

  // Realtime: đồng bộ trạng thái kết bạn ngay khi có event từ listener
  React.useEffect(() => {
    const unsubAccepted = ipc.on?.('event:friendAccepted', (data: any) => {
      if (data?.zaloId === zaloId && data?.userId === userId) {
        setStatus('friend');
      }
    });

    const unsubSent = ipc.on?.('event:friendRequestSent', (data: any) => {
      const sentUserId = data?.requester?.userId || '';
      if (data?.zaloId === zaloId && sentUserId === userId) {
        setStatus('sent');
      }
    });

    const unsubRemoved = ipc.on?.('event:friendRequestRemoved', (data: any) => {
      if (data?.zaloId === zaloId && data?.userId === userId) {
        setStatus('stranger');
      }
    });

    return () => {
      unsubAccepted?.();
      unsubSent?.();
      unsubRemoved?.();
    };
  }, [zaloId, userId]);

  const handleSendRequest = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.sendFriendRequest({ auth, userId, msg: sendMsg.trim() });
      setStatus('sent');
      setSendPopupOpen(false);
      showNotification('Đã gửi yêu cầu kết bạn', 'success');
    } catch (e: any) {
      showNotification('Gửi yêu cầu thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  const handleAccept = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.acceptFriendRequest({ auth, userId });
      setStatus('friend');
      showNotification('Đã chấp nhận kết bạn', 'success');
      // Update local DB — also remove from friend_requests
      ipc.db?.addFriend({ zaloId, friend: { userId, displayName: contact?.display_name || contact?.alias || '', avatar: contact?.avatar_url || contact?.avatar || '' } }).catch(() => {});
      ipc.db?.removeFriendRequest({ zaloId, userId, direction: 'received' }).catch(() => {});
    } catch (e: any) {
      showNotification('Thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  const handleReject = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.rejectFriendRequest({ auth, userId });
      setStatus('stranger');
      showNotification('Đã từ chối yêu cầu kết bạn', 'success');
    } catch (e: any) {
      showNotification('Từ chối thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  const handleUndo = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.undoFriendRequest({ auth, userId });
      setStatus('stranger');
      showNotification('Đã huỷ yêu cầu kết bạn', 'success');
    } catch (e: any) {
      showNotification('Huỷ thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  // Đã là bạn bè → không hiện
  if (status === 'loading' || status === 'friend') return null;

  const displayName = contact?.alias || contact?.display_name || userId;

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-800/80 border-b border-gray-700/60 flex-shrink-0">
        {/* Icon */}
        <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
            <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="22" y1="11" x2="16" y2="11"/>
          </svg>
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          {status === 'stranger' && (
            <span className="text-sm text-gray-300">
              Gửi yêu cầu kết bạn tới <span className="font-medium text-white">{displayName}</span>
            </span>
          )}
          {status === 'sent' && (
            <span className="text-sm text-gray-400">
              Đã gửi yêu cầu kết bạn tới <span className="font-medium text-gray-300">{displayName}</span> — đang chờ chấp nhận
            </span>
          )}
          {status === 'received' && (
            <span className="text-sm text-gray-300">
              <span className="font-medium text-white">{displayName}</span> đã gửi cho bạn yêu cầu kết bạn
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {status === 'stranger' && (
            <button
              onClick={() => setSendPopupOpen(true)}
              disabled={sending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Kết bạn
            </button>
          )}
          {status === 'sent' && (
            <button
              onClick={handleUndo}
              disabled={sending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {sending
                ? <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              }
              Huỷ yêu cầu
            </button>
          )}
          {status === 'received' && (
            <>
              <button
                onClick={handleReject}
                disabled={sending}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                Từ chối
              </button>
              <button
                onClick={handleAccept}
                disabled={sending}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
              >
                {sending
                  ? <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                }
                Chấp nhận
              </button>
            </>
          )}
        </div>
      </div>

      {/* Send friend request popup */}
      {sendPopupOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setSendPopupOpen(false)}
        >
          <div
            className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-sm mx-4 flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <div className="flex items-center gap-3">
                {contact?.avatar_url ? (
                  <img src={contact.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold">
                    {(displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <p className="font-semibold text-white text-sm">{displayName}</p>
                  <p className="text-xs text-gray-400">Gửi yêu cầu kết bạn</p>
                </div>
              </div>
              <button onClick={() => setSendPopupOpen(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="text-xs text-gray-400 font-medium block mb-1.5">Lời nhắn kèm theo (tùy chọn)</label>
                <textarea
                  autoFocus
                  value={sendMsg}
                  onChange={e => setSendMsg(e.target.value)}
                  maxLength={150}
                  placeholder="Xin chào, tôi muốn kết bạn với bạn!"
                  rows={3}
                  className="w-full bg-gray-700 border border-gray-600 focus:border-blue-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none resize-none transition-colors"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSendRequest(); }}
                />
                <p className="text-right text-[11px] text-gray-500 mt-0.5">{sendMsg.length}/150</p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-3 px-5 pb-5 pt-1">
              <button onClick={() => setSendPopupOpen(false)}
                className="flex-1 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition-colors">
                Huỷ
              </button>
              <button
                onClick={handleSendRequest}
                disabled={sending}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {sending && <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
                Gửi yêu cầu
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


