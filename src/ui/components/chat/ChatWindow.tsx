import { Spinner } from '@/components/common/PageLoading';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import MediaViewer, { MediaViewerImage } from './MediaViewer';
import MessageContextMenu from './MessageContextMenu';
import PinnedBar, { buildPinFromMsg, usePinnedData } from './PinnedMessages';
import ChatHistoryList from './ChatHistoryList';
import SharedMessageContent from './SharedMessageContent';
import * as channelIpc from '../../lib/channelIpc';
import { getCapability, type Channel } from '@/../configs/channelConfig';
import { ManagePanel } from './GroupInfoPanel';
import { UserProfilePopup } from '../common/UserProfilePopup';
import { RecalledBubble, BankCardBubble } from './MessageBubbles';
import FBVideoThumb from './FBVideoThumb';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useEmployeeStore } from '@/store/employeeStore';
import { ChatIcon } from '@/components/common/icons';
import { handleAvatarError } from '@/lib/avatarRetry';
import { EMOJI_TO_REACTION } from '@/lib/chat/emojiUtils';
import { parseContent, parseQuoteMsg, extractQuoteImage, extractMediaUrl, formatMsgTime, extractMsgText } from '@/lib/chat/messageParser';
import { isCardType, isEcardType, isFileType, isStickerType, isRtfMsg, isMediaType, isVideoType, isBankCardType } from '@/lib/chat/messageTypeUtils';
import { NoteViewModal } from './NoteViewModal';
import ForwardMessageModal from './ForwardMessageModal';
import PollBubble from './PollBubble';
import FriendRequestBar from './FriendRequestBar';
import { ReactionContextMenu, ReactionPopup, parseReactions, parseReactionsFull } from './ReactionComponents';
import {
  EmployeeAvatar, FileBubble, MediaBubble, VideoBubble, VoiceBubble,
  QuotedStickerPreview, StickerGroupBubble, getGroupLayoutId, MediaGroupBubble,
  SingleImageInGroup, StickerBubble, MsgActionBtn, EcardBubble, CardBubble,
  LinkBubble, CallBubble, ContactCardBubble, applyRtfStyles, TextWithMentions,
  RtfBubble, ActionRow,
} from './ChatWindowBubbles';

export default function ChatWindow() {
  const { messages, activeThreadId, prependMessages, setMessages, contacts, setReplyTo, removeMessage, typingUsers, seenInfo, updateContact, messagesLoading } = useChatStore();
  const { activeAccountId, getActiveAccount } = useAccountStore();
  const { showNotification, groupInfoCache, searchHighlightQuery } = useAppStore();

  const activeContact = React.useMemo(() => {
    if (!activeAccountId || !activeThreadId) return undefined;
    return (contacts[activeAccountId] || []).find(c => c.contact_id === activeThreadId);
  }, [activeAccountId, activeThreadId, contacts]);
  const channelCap = React.useMemo(() =>
    getCapability((activeContact?.channel || 'zalo') as Channel),
  [activeContact]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const pinnedBarWrapperRef = useRef<HTMLDivElement>(null);
  const prevPinnedBarHeightRef = useRef(0);
  const prevLastMsgIdRef = useRef<string>('');
  const savedScrollHeightRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);
  const isInitialThreadLoadRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  // nearBottomRef: cập nhật realtime từ scroll event (không gây re-render)
  // dùng cho ResizeObserver + realtime scroll — tránh stale closure
  const nearBottomRef = useRef(true);

  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Facebook API cursor pagination (tạm thời vô hiệu hóa do API lỗi 500)
  const fbCursorRef = useRef<string | null>(null);
  const fbHasMoreRef = useRef(false);
  const fbProbeDoneRef = useRef(true);
  const [viewerState, setViewerState] = useState<{ images: MediaViewerImage[]; index: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; msg: any; isSent: boolean; isGroupAdmin?: boolean } | null>(null);
  const [forwardMsgs, setForwardMsgs] = useState<any[] | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  const [reactionPopup, setReactionPopup] = useState<{ msg: any; activeEmoji: string } | null>(null);
  const [reactionContextMenu, setReactionContextMenu] = useState<{ x: number; y: number; msg: any; myEmoji: string | null } | null>(null);
  const [atTop, setAtTop] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  // Track which group member info requests have been made (avoid duplicate IPC calls)
  const requestedMemberInfoRef = useRef<Set<string>>(new Set());

  // Track khi đang xem tin nhắn cũ (do click vào ghim / quote / search) - cần nút "Về tin mới nhất"
  const [isViewingHistory, setIsViewingHistory] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [reactionPickerMsgId, setReactionPickerMsgId] = useState<string | null>(null);
  const [userProfilePopup, setUserProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  // Track Facebook avatars that failed to load in message bubbles (per sender)
  const [failedMsgAvatars, setFailedMsgAvatars] = useState<Set<string>>(new Set());
  const avatarRefreshAttempted = useRef<Set<string>>(new Set());
  const [manageGroupOpen, setManageGroupOpen] = useState(false);
  const [noteModal, setNoteModal] = useState<{ topicId?: string; title?: string; creatorName?: string; createTime?: number } | null>(null);
  // Drag-and-drop state (forward to MessageInput)
  const dragCounterRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  // Track which recalled messages the user has chosen to reveal original content
  const [revealedRecallIds, setRevealedRecallIds] = useState<Set<string>>(new Set());
  // Track which edited messages the user has chosen to view edit history
  const [revealedEditIds, setRevealedEditIds] = useState<Set<string>>(new Set());
  // ── Drag-to-select: giữ chuột kéo qua nhiều tin nhắn → auto chọn ───────────
  const dragSelectRef = useRef<{
    startMsgId: string | null;
    startIdx: number;
    hasActivated: boolean;
  }>({ startMsgId: null, startIdx: -1, hasActivated: false });
  const clickSuppressUntilRef = useRef(0);
  const msgsRef = useRef<any[]>([]);

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
  const [messagesReady, setMessagesReady] = useState(false);
  // Track initial loading for PageLoading display
  const [initialLoading, setInitialLoading] = useState(true);
  // loadingSpinner: spinner trung tâm khi chuyển thread, chỉ done sau khi scroll hoàn tất
  const [loadingSpinner, setLoadingSpinner] = useState(false);
  // Track threadId đã scroll - tránh race condition giữa useLayoutEffect vs useEffect
  const lastScrolledThreadRef = useRef<string | null>(null);

  const threadKey = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}` : '';
  const msgs = threadKey ? (messages[threadKey] || []) : [];
  msgsRef.current = msgs;

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

  // Check if current user is group owner or deputy - can recall any member's message
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
  // Cũng gom các ảnh Facebook từ cùng người gửi trong 30 giây vào 1 bubble
  const { groupedFirstMsgs, groupedSkipIds } = React.useMemo(() => {
    const byLayout: Record<string, any[]> = {};
    msgs.forEach((msg) => {
      const layoutId = getGroupLayoutId(msg);
      if (!layoutId) return;
      const key = `${msg.sender_id}_${layoutId}`;
      if (!byLayout[key]) byLayout[key] = [];
      byLayout[key].push(msg);
    });

    // ── Facebook: gom ảnh từ cùng người gửi trong 30 giây ────────────────
    const FB_GROUP_WINDOW_MS = 30000;
    let fbCurrentGroup: any[] = [];
    const fbGroups: any[][] = [];

    const commitFbGroup = () => {
      if (fbCurrentGroup.length >= 2) fbGroups.push([...fbCurrentGroup]);
      fbCurrentGroup = [];
    };

    for (const msg of msgs) {
      // Bỏ qua nếu đã nằm trong group Zalo layout
      const existingLayoutId = getGroupLayoutId(msg);
      if (existingLayoutId) { commitFbGroup(); continue; }
      // Chỉ gom media message Facebook
      const isFbMedia = msg.channel === 'facebook' && isMediaType(msg.msg_type, msg.content);
      if (!isFbMedia) { commitFbGroup(); continue; }

      if (fbCurrentGroup.length === 0) {
        fbCurrentGroup = [msg];
      } else {
        const last = fbCurrentGroup[fbCurrentGroup.length - 1];
        const sameSender = msg.sender_id === last.sender_id;
        const withinWindow = Math.abs(msg.timestamp - last.timestamp) <= FB_GROUP_WINDOW_MS;
        if (sameSender && withinWindow) {
          fbCurrentGroup.push(msg);
        } else {
          commitFbGroup();
          fbCurrentGroup = [msg];
        }
      }
    }
    commitFbGroup();

    // ── Build output: Zalo layout groups + Facebook time groups ──────────
    const groupedFirstMsgs: Record<string, any[]> = {};
    const groupedSkipIds = new Set<string>();

    // Zalo layout groups (existing logic)
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

    // Facebook time-based groups (messages đã có thứ tự sẵn)
    for (const group of fbGroups) {
      groupedFirstMsgs[group[0].msg_id] = group;
      for (let i = 1; i < group.length; i++) groupedSkipIds.add(group[i].msg_id);
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
      const isVoice = mt === 'chat.voice' || mt === 'audio';
      const isGroupMedia = !isPoll && !isVideo && !isVoice && !!groupedFirstMsgs[msg.msg_id];
      const isMedia = !isCard && !isEcard && !isSticker && !isGroupMedia && !isRtf && !isPoll && !isVideo && !isVoice && isMediaType(mt, mc);
      const isFile = !isCard && !isEcard && !isSticker && !isMedia && !isRtf && !isPoll && !isVideo && !isVoice && isFileType(mt, mc);

      // Parse content 1 lần
      const content = (isMedia || isFile || isCard || isEcard || isSticker || isGroupMedia || isRtf || isPoll || isVideo || isVoice)
        ? ''
        : parseContent(mc, mt);

      cache.set(msg.msg_id, {
        isCard, isEcard, isSticker, isRtf, isPoll, isVideo, isVoice,
        isGroupMedia, isMedia, isFile, content
      });
    });

    return cache;
  }, [msgs, groupedFirstMsgs]);

  // Reset khi đổi thread — DÙNG useLayoutEffect (chạy trước paint) để tránh
  // "double flash": nếu dùng useEffect, first render vẫn giữ threadReady=true
  // → messages container hiện ra với empty state (spinner) trước khi reset.
  // useLayoutEffect đảm bảo reset state trước khi browser paint frame đầu tiên.
  useLayoutEffect(() => {
    setHasMore(true);
    setLoadError(false);
    setAtTop(false);
    setAtBottom(true);
    setIsViewingHistory(false);
    prevLastMsgIdRef.current = '';      // reset để luôn trigger scroll khi load messages
    shouldRestoreScrollRef.current = false;
    isInitialThreadLoadRef.current = true;
    // Reset thread ready gate - ẩn UI cho đến khi data load xong
    setThreadReady(false);
    setMessagesReady(false);
    setInitialLoading(true);
    initialScrollDoneRef.current = false;
    lastScrolledThreadRef.current = null;
    prevPinnedBarHeightRef.current = 0;
    // Reset selection mode when switching threads
    setIsSelecting(false);
    setSelectedMsgIds(new Set());
    // Reset Facebook API cursor khi đổi thread (tạm thời vô hiệu hóa)
    fbCursorRef.current = null;
    fbHasMoreRef.current = false;
    fbProbeDoneRef.current = true;
	    setLoadingSpinner(true);
  }, [activeAccountId, activeThreadId]);

  // ─── Thread ready gate (đơn giản): set true ngay khi pinsReady = true ───────
  // pinsReady reset về false mỗi khi thread đổi (trong usePinnedData hook),
  // rồi fire true sau khi IPC getPinnedMessages hoàn thành (~50-100ms).
  // Không dùng dataReady trung gian nữa - tránh bug RAF bị cancel khi re-render.
  useEffect(() => {
    if (!activeThreadId) {
      setMessagesReady(false);
      return;
    }
    if (msgs.length > 0 || !messagesLoading) {
      setMessagesReady(true);
    }
  }, [activeThreadId, threadKey, msgs.length, messagesLoading]);

  useEffect(() => {
    if (!activeThreadId) return;
    setThreadReady(pinsReady && messagesReady);
    // setInitialLoading(false); // chờ messages load
  }, [pinsReady, messagesReady, activeThreadId]);

  // ─── Safety fallback: nếu loading quá 3s mà vẫn chưa ready → force hiển thị ───
  useEffect(() => {
    if (!activeThreadId) return;
    const fallback = setTimeout(() => {
      if (!useChatStore.getState().messagesLoading) {
        setMessagesReady(true);
        setThreadReady(true);
        setInitialLoading(false);
      }
    }, 5000);
    return () => clearTimeout(fallback);
  }, [activeThreadId]);

  // ─── Clear initial loading khi messages thực sự có data ────────────────
  useEffect(() => {
    if (threadReady && messagesReady && initialLoading) {
      setInitialLoading(false);
    }
  }, [threadReady, messagesReady, initialLoading]);

  // ─── Scroll đồng bộ cho cached threads (trước khi browser paint) ──────
  // Khi threadReady = true VÀ messages đã có sẵn trong store (cached),
  // scroll ngay trong useLayoutEffect để browser paint frame đầu tiên
  // với messages ở đáy, không bị giật từ trên nhảy xuống.
  useLayoutEffect(() => {
    if (!threadReady || !messagesReady || !activeThreadId || !threadKey) return;
    if (!msgs.length) return;
    // Chỉ cho thread đã từng scroll (cached) hoặc thread mới nhưng messages đã sẵn
    if (lastScrolledThreadRef.current === threadKey) return;
    if (initialScrollDoneRef.current) return;

    const el = messagesContainerRef.current;
    if (!el) return;

    // Scroll đồng bộ - browser sẽ paint với vị trí này ngay
    el.scrollTop = el.scrollHeight;
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    setAtTop(false);
    setAtBottom(true);
    initialScrollDoneRef.current = true;
    lastScrolledThreadRef.current = threadKey;
    setLoadingSpinner(false);
  }, [threadReady, messagesReady, activeThreadId, threadKey, msgs.length]);

  // ─── Drag-to-select: pointer move/up (document level) ──────────────────────
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragSelectRef.current;
      if (!drag.startMsgId) return;

      // Tìm message element dưới cursor
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      let currentMsgId: string | null = null;
      for (const el of elements) {
        const msgEl = (el as HTMLElement).closest?.('[id^="msg-"]') as HTMLElement;
        if (msgEl) {
          currentMsgId = msgEl.id.replace('msg-', '');
          break;
        }
      }
      if (!currentMsgId) return;

      const currentMsgs = msgsRef.current;
      const startIdx = currentMsgs.findIndex((m: any) => m.msg_id === drag.startMsgId);
      const endIdx = currentMsgs.findIndex((m: any) => m.msg_id === currentMsgId);
      if (startIdx === -1 || endIdx === -1) return;

      // Nếu chưa activate và đã kéo sang message khác → activate selection mode
      if (!drag.hasActivated) {
        if (currentMsgId === drag.startMsgId) return; // Chưa rời khỏi message gốc
        drag.hasActivated = true;
        setIsSelecting(true);
        // Cancel text selection
        document.getSelection()?.removeAllRanges();
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
      }

      // Select tất cả messages trong range [startIdx, endIdx]
      const minIdx = Math.min(startIdx, endIdx);
      const maxIdx = Math.max(startIdx, endIdx);
      const rangeIds = new Set(
        currentMsgs.slice(minIdx, maxIdx + 1).map((m: any) => m.msg_id)
      );
      // Merge với selection hiện tại (accumulate khi kéo nhiều lần)
      setSelectedMsgIds(prev => {
        if (prev.size === 0) return rangeIds;
        const next = new Set(prev);
        for (const id of rangeIds) next.add(id);
        return next;
      });
    };

    const handlePointerUp = () => {
      const drag = dragSelectRef.current;
      if (!drag.startMsgId) return;

      if (drag.hasActivated) {
        // Giữ selection mode active, suppress click tiếp theo
        clickSuppressUntilRef.current = Date.now() + 150;
        // Restore user-select
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
      }

      drag.startMsgId = null;
      drag.startIdx = -1;
      drag.hasActivated = false;
    };

    document.addEventListener('pointermove', handlePointerMove, { capture: true });
    document.addEventListener('pointerup', handlePointerUp, { capture: true });

    return () => {
      document.removeEventListener('pointermove', handlePointerMove, { capture: true });
      document.removeEventListener('pointerup', handlePointerUp, { capture: true });
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    };
  }, []);

  // ─── ESC to exit selection mode ─────────────────────────────────────────
  useEffect(() => {
    if (!isSelecting) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsSelecting(false);
        setSelectedMsgIds(new Set());
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
      }
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isSelecting]);

  useLayoutEffect(() => {
    if (!threadReady) return;
    const scroller = messagesContainerRef.current;
    const currentHeight = pinnedBarWrapperRef.current?.offsetHeight || 0;
    const prevHeight = prevPinnedBarHeightRef.current;
    if (!initialScrollDoneRef.current) {
      prevPinnedBarHeightRef.current = currentHeight;
      return;
    }
    if (scroller && currentHeight !== prevHeight) {
      if (nearBottomRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        scroller.scrollTop += (currentHeight - prevHeight);
      }
    }
    prevPinnedBarHeightRef.current = currentHeight;
  }, [threadReady, activeThreadId, pins.length, pinnedNotes.length]);

  // ─── Scroll to bottom SAU KHI threadReady = true ──
  // Dùng double-RAF để đảm bảo messages đã render + layout paint trước khi scroll.
  // KHÔNG dùng setTimeout guess-timings nữa — ResizeObserver (effect riêng) tự động
  // re-scroll nếu user ở bottom khi async media load xong gây layout shift.
  //
  // ⚠️ Race condition guard: nếu realtime message đến trong lúc chờ batch load,
  // effect sẽ fire với 1 tin và lock thread prematurely → batch đầy đủ sau đó
  // không được scroll (lastScrolledThreadRef đã set). Fix: chỉ lock khi có ≥3
  // messages thực (không tính temp_), batch đầy đủ (50 tin) sẽ trigger lock thật.
  useEffect(() => {
    if (!threadReady || !messagesReady || !activeThreadId || !threadKey) return;
    if (!msgs.length) return;
    if (lastScrolledThreadRef.current === threadKey) return;

    // Lock thread chỉ khi có đủ messages thực (≥3), tránh realtime lẻ lock sớm
    const realCount = msgs.filter(m => !String(m.msg_id).startsWith('temp_')).length;
    if (realCount < 3 && messagesLoading) return;

    // 200ms settling time: đợi layout ổn định + late-loading conversations render
    // trước khi scroll, tránh scroll sai đáy do content chưa kịp render
    let cancelled = false;
    const settlingTimer = setTimeout(() => {
      if (cancelled) return;
      // RAF 1: scroll xuống đáy
      requestAnimationFrame(() => {
        if (cancelled) return;
        const el = messagesContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        // RAF 2: confirm scroll + lock flags
        requestAnimationFrame(() => {
          if (cancelled) return;
          const el2 = messagesContainerRef.current;
          if (el2) {
            el2.scrollTop = el2.scrollHeight;
            setAtTop(false);
            setAtBottom(true);
          }
          bottomRef.current?.scrollIntoView({ behavior: 'instant' });
          initialScrollDoneRef.current = true;
          lastScrolledThreadRef.current = threadKey;
          // RAF 3: tắt overlay SAU KHI browser đã paint vị trí scroll
          // Tránh giật: overlay tồn tại xuyên suốt quá trình scroll → user không thấy content nhảy
          requestAnimationFrame(() => {
            if (cancelled) return;
            setLoadingSpinner(false);
          });
        });
      });
    }, 10);
    return () => {
      cancelled = true;
      clearTimeout(settlingTimer);
    };
  }, [threadReady, messagesReady, activeThreadId, threadKey, msgs.length, messagesLoading]);

  // ─── Loading spinner fallback cho empty/cached thread ──
  // Khi initialScrollDoneRef da duoc set (cached) hoac msgs.length === 0 (empty),
  // initial scroll effect khong fire → khong goi setLoadingSpinner(false).
  // Fallback: khi threadReady && loadingSpinner, kiem tra neu khong can scroll → tat spinner.
  useEffect(() => {
    if (!loadingSpinner || !threadReady) return;
    const isCached = lastScrolledThreadRef.current === threadKey;
    if (msgs.length === 0 || isCached) {
      setLoadingSpinner(false);
    }
  }, [loadingSpinner, threadReady, msgs.length, threadKey]);


  // ─── ResizeObserver: auto-scroll khi content resize mà user đang ở bottom ──
  // Giải quyết layout shift từ ảnh/video load async, pin bar thay đổi, sticker load, v.v.
  // Chỉ scroll nếu user đang ở gần bottom (nearBottomRef), không giật khi user đang đọc lịch sử.
  // Debounce bằng rAF để gom nhiều resize events thành 1 lần scroll, tránh jank.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || !threadReady) return;
    let rafId = 0;
    let prevScrollHeight = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!nearBottomRef.current) return;
        const newHeight = el.scrollHeight;
        if (newHeight === prevScrollHeight) return; // không thay đổi → skip
        prevScrollHeight = newHeight;
        el.scrollTop = newHeight;
      });
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (rafId) cancelAnimationFrame(rafId); };
  }, [activeThreadId, threadReady]);

  // ─── Lazy scan: quét ảnh lỗi trong conversation khi mở thread ────────────────
  // Chạy 1 lần per thread, sau khi threadReady. Background, không block UI.
  const scannedThreadsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!threadReady || !activeAccountId || !activeThreadId || !msgs.length) return;
    const scanKey = `${activeAccountId}_${activeThreadId}`;
    if (scannedThreadsRef.current.has(scanKey)) return;
    scannedThreadsRef.current.add(scanKey);

    // Collect messages with local_paths that are image types
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'avif'];
    const items: Array<{ zaloId: string; msgId: string; threadId: string; localPath: string; remoteUrl?: string }> = [];
    for (const msg of msgs) {
      try {
        const lp: Record<string, string> = typeof msg.local_paths === 'string'
          ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        const localFilePath = lp.main || lp.hd || '';
        if (!localFilePath) continue;
        const ext = localFilePath.split('.').pop()?.toLowerCase() || '';
        if (!imageExts.includes(ext)) continue;

        // Extract remoteUrl for repair
        let remoteUrl = '';
        try {
          const parsed = JSON.parse(msg.content || '{}');
          const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
          remoteUrl = params.hd || params.rawUrl || parsed.href || parsed.thumb || '';
        } catch {}

        items.push({
          zaloId: activeAccountId,
          msgId: String(msg.msg_id),
          threadId: activeThreadId,
          localPath: localFilePath,
          remoteUrl,
        });
      } catch {}
    }

    if (!items.length) return;

    // Validate in main process, then repair corrupted ones
    ipc.file?.validateLocalImages(items).then((res) => {
      if (!res?.success || !res.corrupted?.length) return;
      console.log(`[ChatWindow] Found ${res.corrupted.length} corrupted images in thread ${activeThreadId}, repairing...`);
      for (const item of res.corrupted) {
        ipc.file?.repairImage({
          zaloId: item.zaloId,
          msgId: item.msgId,
          threadId: item.threadId,
          remoteUrl: item.remoteUrl,
        }).catch(() => {});
      }
    }).catch(() => {});
  }, [threadReady, activeAccountId, activeThreadId, msgs]);

  // ─── Media cache preloader (employee mode) ─────────────────────
  // Khi mo hoi thoai, download background cac file media ve cache local
  // de lan sau xem khong can load tu Boss. Preload ca anh, video, file.
  const preloadScannedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || !threadReady) return;
    const key = `${activeAccountId}_${activeThreadId}`;
    if (preloadScannedRef.current.has(key)) return;
    preloadScannedRef.current.add(key);

    // Chi chay o employee mode
    const isEmployee = useEmployeeStore.getState().mode === 'employee';
    if (!isEmployee) return;

    // Helper: extract Boss URLs tu local_paths cua 1 message
    const extractBossUrls = (msg: any): string[] => {
      const urls: string[] = [];
      try {
        const lp = typeof msg.local_paths === 'string'
          ? JSON.parse(msg.local_paths || '{}')
          : (msg.local_paths || {});
        // Image: lp.main, lp.hd, lp.thumb
        // Video: lp.file, lp.video, lp.thumb (thumb nho)
        // File:  lp.file, lp.main
        const candidates = [lp.main, lp.hd, lp.thumb, lp.file, lp.video];
        for (const val of candidates) {
          if (!val || val === 'undefined') continue;
          const bossUrl = toLocalMediaUrl(val);
          if (bossUrl && !bossUrl.startsWith('local-media://') && !bossUrl.startsWith('file://') && bossUrl.startsWith('http')) {
            urls.push(bossUrl);
          }
        }
      } catch {}
      return urls;
    };

    // Chay async, khong block UI
    (async () => {
      try {
        // ── Lay media messages (anh + video) ──
        const mediaR = await DataAccessor.getMediaMessages({
          zaloId: activeAccountId!,
          threadId: activeThreadId,
          limit: 50,
          offset: 0,
        });
        const mediaMsgs = mediaR?.messages || [];

        // ── Lay file messages ──
        const fileR = await DataAccessor.getFileMessages({
          zaloId: activeAccountId!,
          threadId: activeThreadId,
          limit: 50,
          offset: 0,
        });
        const fileMsgs = fileR?.messages || [];

        // Build danh sach Boss URLs de preload
        const bossUrls: string[] = [];
        for (const msg of mediaMsgs) {
          bossUrls.push(...extractBossUrls(msg));
        }
        for (const msg of fileMsgs) {
          bossUrls.push(...extractBossUrls(msg));
        }

        // Dedup URLs (tranh preload cung 1 file 2 lan)
        const uniqueUrls = [...new Set(bossUrls.filter(Boolean))];

        if (uniqueUrls.length > 0) {
          console.log(`[MediaCache] Preloading ${uniqueUrls.length} files (${mediaMsgs.length} media, ${fileMsgs.length} files) for thread ${activeThreadId}`);
          ipc.file?.preloadMediaBatch(uniqueUrls).catch(() => {});
        }
      } catch (err) {
        console.warn('[MediaCache] Preload error:', err);
      }
    })();
  }, [activeAccountId, activeThreadId, threadReady]);

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
    DataAccessor.getGroupMembers({ zaloId: accountId, groupId })
      .then(async (res: any) => {
        if (res?.members?.length) {
          // DB có members → dùng luôn
          buildAndSetGroupInfo(res.members);
        } else {
          // DB không có members → fallback gọi API getGroupInfo
          try {
            const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
            if (!acc || (acc.channel || 'zalo') !== 'zalo') return;
            const auth = buildZaloAuth(acc, accountId);
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
              DataAccessor.saveGroupMembers({ zaloId: accountId, groupId, members: rawMembers }).catch(() => {});
            }
            // Cập nhật tên/avatar nhóm nếu có
            if (name) {
              DataAccessor.updateContactProfile({ zaloId: accountId, contactId: groupId, displayName: name, avatarUrl: avatar, phone: '' }).catch(() => {});
              useChatStore.getState().updateContact(accountId, { contact_id: groupId, display_name: name, avatar_url: avatar });
            }

            buildAndSetGroupInfo(rawMembers, name, avatar, creatorId, adminList);
          } catch {}
        }
      })
      .catch(() => {});
  }, [activeThreadId, activeAccountId]);

  // ─── Fetch thông tin thành viên nhóm chưa biết - xử lý messages đã có ─────
  // Khi messages load từ DB hoặc nhóm có thành viên mới chưa có tên/avatar,
  // tự động gọi getUserInfo để enrich thông tin cho các sender_id lạ.
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    const contactList = useChatStore.getState().contacts[activeAccountId] || [];
    const isGroup = contactList.find(c => c.contact_id === activeThreadId)?.contact_type === 'group' ||
                    contactList.find(c => c.contact_id === activeThreadId)?.contact_type === '1';
    if (!isGroup) return;

    const unknownSenders = new Set<string>();
    for (const msg of msgs) {
      if (msg.is_sent === 1 || !msg.sender_id) continue;
      const senderKey = `${activeAccountId}__${msg.sender_id}__${activeThreadId}`;
      if (requestedMemberInfoRef.current.has(senderKey)) continue;

      const ct = getContact(msg.sender_id);
      if (ct?.display_name && ct.display_name !== msg.sender_id && !/^\d+$/.test(ct.display_name)) {
        continue; // đã có tên trong contacts → skip
      }
      const gm = getGroupMember(msg.sender_id);
      if (gm?.displayName && gm.displayName !== msg.sender_id && !/^\d+$/.test(gm.displayName)) {
        continue; // đã có tên trong group cache → skip
      }

      unknownSenders.add(msg.sender_id);
    }

    if (unknownSenders.size === 0) return;

    for (const senderId of unknownSenders) {
      const senderKey = `${activeAccountId}__${senderId}__${activeThreadId}`;
      requestedMemberInfoRef.current.add(senderKey);

      // Fetch member info via IPC - tương tự fetchGroupMemberInfo trong useZaloEvents
      const load = async () => {
        try {
          const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
          if (!acc || (acc.channel || 'zalo') !== 'zalo') return;
          const auth = buildZaloAuth(acc, activeAccountId);
          const res = await ipc.zalo?.getUserInfo({ auth, userId: senderId });
          if (!res?.success || !res.response) return;
          const profile = res.response.changed_profiles?.[senderId];
          if (!profile) return;

          const displayName = profile.displayName || profile.zaloName || '';
          const avatar = profile.avatar || '';
          if (!displayName && !avatar) return;

          // Update contact store
          if (displayName || avatar) {
            useChatStore.getState().updateContact(activeAccountId!, {
              contact_id: senderId,
              ...(displayName ? { display_name: displayName } : {}),
              ...(avatar ? { avatar_url: avatar } : {}),
            });
          }

          // Update groupInfoCache
          if (activeThreadId && (displayName || avatar)) {
            const cache = useAppStore.getState().groupInfoCache?.[activeAccountId!]?.[activeThreadId];
            if (cache?.members) {
              const members = [...cache.members];
              const idx = members.findIndex(m => m.userId === senderId);
              if (idx >= 0) {
                members[idx] = { ...members[idx], ...(displayName ? { displayName } : {}), ...(avatar ? { avatar } : {}) };
              } else {
                members.push({ userId: senderId, displayName: displayName || senderId, avatar: avatar || '', role: 0 });
              }
              useAppStore.getState().setGroupInfo(activeAccountId!, activeThreadId, { ...cache, members, fetchedAt: Date.now() });
            }
          }

          // Save to DB
          await DataAccessor.saveGroupMembers({
            zaloId: activeAccountId, groupId: activeThreadId,
            members: [{ memberId: senderId, displayName: displayName || senderId, avatar: avatar || '', role: 0 }],
          }).catch(() => {});
          DataAccessor.updateContactProfile({
            zaloId: activeAccountId, contactId: senderId,
            displayName: displayName || senderId, avatarUrl: avatar, phone: '',
          }).catch(() => {});
        } catch {}
      };
      load();
    }
  }, [activeAccountId, activeThreadId, msgs, groupInfoCache]);

  // Scroll event: track top/bottom position + nearBottomRef (dùng cho ResizeObserver)
  // Tối ưu: dùng rAF throttle + chỉ setState khi giá trị thay đổi để tránh re-render liên tục
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    let rafId = 0;
    let lastAtTop = false;
    let lastAtBottom = true;
    const onScroll = () => {
      if (rafId) return; // throttle bằng rAF
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const { scrollTop, scrollHeight, clientHeight } = el;
        nearBottomRef.current = scrollHeight - scrollTop - clientHeight < 150;
        const newAtTop = scrollTop < 60;
        const newAtBottom = scrollHeight - scrollTop - clientHeight < 60;
        if (newAtTop !== lastAtTop) { lastAtTop = newAtTop; setAtTop(newAtTop); }
        if (newAtBottom !== lastAtBottom) { lastAtBottom = newAtBottom; setAtBottom(newAtBottom); }
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (rafId) cancelAnimationFrame(rafId); };
  }, [activeThreadId]);

  // ─── Auto-load tin nhắn cũ khi scroll lên đầu ───────────────────────────
  const autoLoadFiredRef = useRef(false);  // true = đã auto-load, chờ user rời top mới reset
  const loadMoreFnRef = useRef<() => void>(() => {});
  useEffect(() => {
    loadMoreFnRef.current = handleLoadMore;
  });
  // Reset khi user rời khỏi vùng top → cho phép auto-load lại lần sau
  useEffect(() => {
    if (!atTop) autoLoadFiredRef.current = false;
  }, [atTop]);
  useEffect(() => {
    if (!initialScrollDoneRef.current || initialLoading || !atTop || !hasMore || loadingMore || !activeThreadId) return;
    // Đã auto-load rồi mà user chưa scroll xuống khỏi top → không load tiếp
    if (autoLoadFiredRef.current) return;
    // Delay nhẹ tránh trigger liên tục khi scroll
    const timer = setTimeout(() => {
      if (hasMore && !loadingMore && atTop) {
        autoLoadFiredRef.current = true;
        loadMoreFnRef.current();
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atTop, hasMore, loadingMore]);

  // ─── Scroll to bottom khi AI suggestions bar xuất hiện/biến mất ──────────
  // Khi thanh gợi ý AI thay đổi, input area đổi chiều cao → tin nhắn bị che.
  // Nếu user đang ở cuối trang → tự động scroll xuống để bù offset.
  // Dùng nearBottomRef (không gây re-render) thay vì atBottom state
  useEffect(() => {
    const handler = () => {
      if (nearBottomRef.current) {
        requestAnimationFrame(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'instant' });
        });
      }
    };
    window.addEventListener('ai:suggestionsBarChanged', handler);
    return () => window.removeEventListener('ai:suggestionsBarChanged', handler);
  }, []);

  // Scroll to bottom khi LibraryPickerModal gửi xong
  useEffect(() => {
    const handler = () => {
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    window.addEventListener('chat:scrollToBottom', handler);
    return () => window.removeEventListener('chat:scrollToBottom', handler);
  }, []);

  // Scroll to bottom chỉ khi có tin nhắn MỚI (tin cuối thay đổi), không scroll khi prepend tin cũ
  // Initial load scroll được xử lý bởi threadReady gate - effect này chỉ handle tin nhắn realtime
  // Dùng nearBottomRef (ref, không gây re-render) thay vì atBottom state để tránh stale closure
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
        // Riêng Facebook: không dùng heuristic này vì local có thể chưa có message nào
        const isFb = activeContact?.channel === 'facebook';
        if (isInitial) {
          const realCount = msgs.filter(m => !m.msg_id.startsWith('temp_')).length;
          if (realCount < 50) setHasMore(false);
          // SKIP scroll ở đây - threadReady gate sẽ xử lý scroll initial
          return;
        }
        // Tin nhắn mới (realtime) - dùng nearBottomRef (cập nhật realtime từ scroll event)
        // thay vì atBottom state (có thể bị stale trong closure do batching)
        const isOutgoing =
          lastMsg?.is_sent === 1 ||
          (activeAccountId ? String(lastMsg?.sender_id || '') === String(activeAccountId) : false) ||
          String(lastMsg?.msg_id || '').startsWith('temp_');
        if (isOutgoing || nearBottomRef.current) {
          // Dùng scrollTop trực tiếp thay vì scrollIntoView('smooth')
          // → instant, không animation delay, mượt hơn cho realtime messages
          const el = messagesContainerRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }
      }
    }
  }, [msgs, activeAccountId, activeContact?.channel]);

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
    if ((acc.channel || 'zalo') !== 'zalo') return buildZaloAuth(acc, activeAccountId);
    return buildZaloAuth(acc, activeAccountId);
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
      // Step 1: Try REST (employee) hoặc local DB (boss/standalone)
      const isEmployee = useEmployeeStore.getState().mode === 'employee';
      let res: any;
      if (isEmployee) {
        const DataAccessor = (await import('../../lib/data/DataAccessor')).default;

        const restResult = await DataAccessor.getMessages({
          zaloId: activeAccountId,
          threadId: activeThreadId,
          limit: 30,
          before,
        });
        res = { messages: restResult?.items || [] };
      } else {
        res = await DataAccessor.getMessages({
          zaloId: activeAccountId,
          threadId: activeThreadId,
          limit: 30,
          before,
        });
      }
      if (res?.messages?.length > 0) {
        // Build a lookup map of msg_id → content+type for all loaded messages
        // (used to populate reply quote_data with actual original message content)
        const msgLookup = new Map<string, { content: string; type: string }>();
        for (const m of res.messages) {
          msgLookup.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
        }
        // Convert reply_to_id → quote_data for Facebook messages so reply previews render
        const missingLookup: Array<{ msgId: string; replyToId: string }> = [];
        const mapped = res.messages.map((m: any) => {
          if (m.reply_to_id && !m.quote_data) {
            const orig = msgLookup.get(m.reply_to_id);
            if (orig) {
              return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
            }
            missingLookup.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
            return m;
          }
          return m;
        });
        prependMessages(activeAccountId, activeThreadId, [...mapped].reverse());
        // Async fixup: query DB for original messages not in the loaded batch
        const storeKey = `${activeAccountId}_${activeThreadId}`;
        if (missingLookup.length > 0 && activeAccountId && activeThreadId) {
          (async () => {
            for (const item of missingLookup) {
              try {
                const dbRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, msgId: item.replyToId });
                const origMsg = dbRes?.message;
                if (origMsg?.msg_type || origMsg?.content) {
                  const store = useChatStore.getState();
                  const msgs = (store.messages[storeKey] || []).slice();
                  const idx = msgs.findIndex((m2: any) => m2.msg_id === item.msgId);
                  if (idx >= 0 && !msgs[idx].quote_data) {
                    msgs[idx] = {
                      ...msgs[idx],
                      quote_data: JSON.stringify({
                        msgId: item.replyToId,
                        msg: origMsg.content || '',
                        senderId: '',
                        msgType: origMsg.msg_type || 'text',
                      }),
                    };
                    store.setMessages(activeAccountId!, activeThreadId, msgs);
                  }
                }
              } catch {}
            }
          })();
        }
        if (res.messages.length < 30) setHasMore(false);
        return;
      }

      // Step 2: (Temporarily disabled) Facebook API fallback - fetchThreadMessages đang lỗi 500
      // Step 3: Không có thêm tin nhắn
      setHasMore(false);
      shouldRestoreScrollRef.current = false;
    } catch {
      shouldRestoreScrollRef.current = false;
      setLoadError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  /** Probe Facebook API sau initial load để xác định có tin cũ hơn không (TẠM THỜI VÔ HIỆU HÓA do API lỗi 500) */
  const probeFbOlderMessages = React.useCallback(async (_accountId: string, _threadId: string) => {
    // API đang lỗi 500 → bỏ qua, không còn tin cũ hơn
    setHasMore(false);
    fbHasMoreRef.current = false;
  }, []);

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
      // Đánh dấu thu hồi thay vì xóa - hiển thị "Tin nhắn đã thu hồi"
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id }).catch(() => {});
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
      // Đánh dấu đã xoá trong DB (recalled) thay vì xoá hẳn - nhất quán với thu hồi
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id }).catch(() => {});
      }
      showNotification('Đã xóa tin nhắn', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleDeleteFromDb = async (msg: any) => {
    if (!activeAccountId) return;
    try {
      await DataAccessor.deleteMessages({ zaloId: activeAccountId, msgIds: [msg.msg_id] });
      removeMessage(activeAccountId, msg.thread_id, msg.msg_id);
      showNotification('Đã xóa vĩnh viễn tin nhắn khỏi app', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleReact = async (msg: any, emoji: string) => {
    try {
      const contactList = contacts[activeAccountId || ''] || [];
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || 'zalo';

      // Optimistic update: show reaction immediately in UI
      const accId = activeAccountId || '';
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, emoji);

      if (ch === 'facebook') {
        await channelIpc.addReaction('facebook', {
          accountId: accId,
          messageId: msg.msg_id,
          emoji,
          threadId: msg.thread_id,
          action: 'add',
        });
      } else {
        const auth = getAuth();
        if (!auth) return;
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
    try {
      const contactList = contacts[activeAccountId || ''] || [];
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || 'zalo';

      // Optimistic update: remove reaction immediately in UI
      const accId = activeAccountId || '';
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, '');

      if (ch === 'facebook') {
        await channelIpc.addReaction('facebook', {
          accountId: accId,
          messageId: msg.msg_id,
          emoji: '',
          threadId: msg.thread_id,
          action: 'remove',
        });
      } else {
        const auth = getAuth();
        if (!auth) return;
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
    setForwardMsgs([msg]);
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
      // Không dùng sender_id (UID dài) làm tên - fallback về 'Người dùng'
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
        // Zalo API chỉ hỗ trợ 3 tin ghim - ghim thành công trong ứng dụng nhưng không đồng bộ lên API
        showNotification('Đã ghim (chỉ áp dụng trong app - Zalo giới hạn 3 tin ghim)', 'success');
      } else {
        showNotification('Đã ghim tin nhắn', 'success');
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

    // 2. Message not in DOM - fetch its info to get timestamp, then load messages around it
    if (!activeAccountId || !activeThreadId) return;
    try {
      const msgRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, msgId });
      const targetMsg = msgRes?.message;
      if (!targetMsg?.timestamp) return;

      const aroundRes = await DataAccessor.getMessagesAround({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        msgId: String(targetMsg.msg_id || targetMsg.timestamp),
        limit: 200,
      });
      const aroundMsgs = aroundRes?.messages;
      if (!aroundMsgs?.length) return;

      // Build reply lookup map for reply_to_id → quote_data
      const msgLookup2 = new Map<string, { content: string; type: string }>();
      for (const m of aroundMsgs) msgLookup2.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
      const missingLookup2: Array<{ msgId: string; replyToId: string }> = [];
      const mappedAround = aroundMsgs.map((m: any) => {
        if (m.reply_to_id && !m.quote_data) {
          const orig = msgLookup2.get(m.reply_to_id);
          if (orig) {
            return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
          }
          missingLookup2.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
          return m;
        }
        return m;
      });

      // Replace current messages with the "around" set
      setMessages(activeAccountId, activeThreadId, mappedAround);
      // Async fixup: query DB for original messages not in the loaded batch
      if (missingLookup2.length > 0 && activeAccountId && activeThreadId) {
        (async () => {
          for (const item of missingLookup2) {
            try {
              const dbRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, msgId: item.replyToId });
              const origMsg = dbRes?.message;
              if (origMsg?.msg_type || origMsg?.content) {
                const store = useChatStore.getState();
                const key = `${activeAccountId}_${activeThreadId}`;
                const msgs = (store.messages[key] || []).slice();
                const idx = msgs.findIndex((m2: any) => m2.msg_id === item.msgId);
                if (idx >= 0 && !msgs[idx].quote_data) {
                  msgs[idx] = {
                    ...msgs[idx],
                    quote_data: JSON.stringify({
                      msgId: item.replyToId,
                      msg: origMsg.content || '',
                      senderId: '',
                      msgType: origMsg.msg_type || 'text',
                    }),
                  };
                  store.setMessages(activeAccountId!, activeThreadId, msgs);
                }
              }
            } catch {}
          }
        })();
      }
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

  // Tải lại tin nhắn mới nhất và cuộn xuống cuối - dùng khi đang xem tin nhắn cũ (isViewingHistory)
  const handleReturnToLatest = async () => {
    if (!activeAccountId || !activeThreadId || loadingLatest) return;
    setLoadingLatest(true);
    try {
      const res = await DataAccessor.getMessages({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        limit: 50,
        offset: 0,
      });
      if (res?.messages?.length) {
        // Build reply lookup map for reply_to_id → quote_data
        const msgLookup3 = new Map<string, { content: string; type: string }>();
        for (const m of res.messages) msgLookup3.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
        const missingLookup3 = [];
        const mappedLatest = res.messages.map((m: any) => {
          if (m.reply_to_id && !m.quote_data) {
            const orig = msgLookup3.get(m.reply_to_id);
            if (orig) {
              return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
            }
            missingLookup3.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
            return m;
          }
          return m;
        });
        const sorted = [...mappedLatest].reverse();
        setMessages(activeAccountId, activeThreadId, sorted);
        setHasMore(res.messages.length >= 50);
        // Async fixup: query DB for original messages not in the loaded batch
        if (missingLookup3.length > 0 && activeAccountId && activeThreadId) {
          (async () => {
            for (const item of missingLookup3) {
              try {
                const dbRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, msgId: item.replyToId });
                const origMsg = dbRes?.message;
                if (origMsg?.msg_type || origMsg?.content) {
                  const store = useChatStore.getState();
                  const mkey = activeAccountId + '_' + activeThreadId;
                  const msgs = (store.messages[mkey] || []).slice();
                  const idx = msgs.findIndex((m2) => m2.msg_id === item.msgId);
                  if (idx >= 0 && !msgs[idx].quote_data) {
                    msgs[idx] = {
                      ...msgs[idx],
                      quote_data: JSON.stringify({
                        msgId: item.replyToId,
                        msg: origMsg.content || '',
                        senderId: '',
                        msgType: origMsg.msg_type || 'text',
                      }),
                    };
                    store.setMessages(activeAccountId, activeThreadId, msgs);
                  }
                }
              } catch {}
            }
          })();
        }
      }
      setIsViewingHistory(false);
      // Scroll to bottom sau khi render
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
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
      fallbackSrc: remoteUrl || undefined,  // Zalo CDN làm fallback
      localPath,
      defaultName,
      msgId: msg?.msg_id ? String(msg.msg_id) : undefined,
      threadId: msg?.thread_id ? String(msg.thread_id) : undefined,
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
        const r = await DataAccessor.getMediaMessages({
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
          if (!prev) return null; // User đã đóng viewer trong khi load — không mở lại
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

  // ── Drag-and-drop handlers (forward to MessageInput) ────────────────
  // MUST be placed BEFORE early returns to maintain React hooks order
  const handleDragEnter = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    if (!activeThreadId) return;

    // Dispatch custom event cho MessageInput xử lý
    window.dispatchEvent(new CustomEvent('chat:dragDropFiles', {
      detail: { files },
    }));
  }, [activeThreadId]);

  if (!activeThreadId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="mb-4 opacity-30">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <p className="text-sm">Chọn một hội thoại để bắt đầu</p>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-gray-900/70 backdrop-blur-sm border-2 border-dashed border-blue-500 pointer-events-none"
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="flex flex-col items-center gap-2 text-center px-4">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <p className="text-blue-400 font-medium text-sm">Thả file / ảnh để gửi</p>
            <p className="text-gray-400 text-xs">Hỗ trợ ảnh, video, file</p>
          </div>
        </div>
      )}

      {/* ── Pinned messages + notes bar - chỉ hiện khi ready ── */}
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
              <Spinner size={4} />
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

      {/* Messages container - luôn render khi có thread active, skeleton hiển thị bên trong khi loading */}
      {/* Giúp tránh "double flash" do container mount/unmount khi chuyển thread */}
      {activeAccountId && activeThreadId && (
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto [overflow-anchor:auto] relative" style={{ willChange: 'scroll-position' }}>
                {loadingSpinner && <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900 pointer-events-none"><div className="flex flex-col items-center gap-3"><div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin"></div><p className="text-sm text-gray-400">Đang tải...</p></div></div>}
        <div className="p-4 space-y-1.5">
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
                  <Spinner size={3} />
                  <span>Đang tải...</span>
                </>
              ) : loadError ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  <span>Lỗi - Thử lại</span>
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


        {/* Empty state - no messages yet */}
        {msgs.length === 0 && !initialLoading && !messagesLoading && (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 opacity-60">
            <div className="text-3xl mb-3"><ChatIcon className="w-4 h-4" /></div>
            <p className="text-gray-400 text-sm font-medium">Chưa có tin nhắn nào</p>
            <p className="text-gray-400 text-xs mt-1 max-w-xs">
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

            // Build inline content - avatar + tên trước mỗi member
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
                      <span className="w-4 h-4 rounded-full bg-purple-600 inline-flex items-center justify-center text-white flex-shrink-0" style={{fontSize:'0.5rem'}}>
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

          // Contact/display info - needed for recalled bubble too
          const contact = !isSent ? getContact(msg.sender_id) : null;
          const groupMember = (!isSent && !contact) ? getGroupMember(msg.sender_id) : null;
          const avatarUrl = toLocalMediaUrl(contact?.avatar_url || groupMember?.avatar || '');
          const displayName = contact?.alias || contact?.display_name || groupMember?.displayName || msg.sender_id;

          const isRecalled = msg.is_recalled === 1 || msg.status === 'recalled' || msg.msg_type === 'recalled';

          // ── Recalled message - dùng RecalledBubble chung với MessageBubbles ─
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
                    <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded-full">{formatMsgTime(msg.timestamp)}</span>
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
                          {avatarUrl && !failedMsgAvatars.has(msg.sender_id) ? (
                            <img src={avatarUrl} alt={displayName} className="w-7 h-7 rounded-full object-cover"
                              onError={() => {
                                setFailedMsgAvatars(prev => new Set(prev).add(msg.sender_id));
                                if (activeAccountId && !avatarRefreshAttempted.current.has(msg.sender_id)) {
                                  avatarRefreshAttempted.current.add(msg.sender_id);
                                  const contact = getContact(msg.sender_id);
                                  handleAvatarError({ ownerId: activeAccountId, contactId: msg.sender_id, channel: contact?.channel || 'zalo' })
                                    .then(newUrl => {
                                      if (newUrl) {
                                        updateContact(activeAccountId!, { contact_id: msg.sender_id, avatar_url: newUrl });
                                        setFailedMsgAvatars(prev => { const n = new Set(prev); n.delete(msg.sender_id); return n; });
                                      }
                                    }).catch(() => {});
                                }
                              }} />
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
          const isVoiceMsg = cached?.isVoice ?? (msg.msg_type === 'chat.voice' || msg.msg_type === 'audio');
          const isBankCardMsg = isBankCardType(msg.msg_type, msg.content);
          const isLocationMsg = msg.msg_type === 'chat.location.new';
          const isGroupMedia = cached?.isGroupMedia ?? (!isPollMsg && !isVideoMsg && !isVoiceMsg && !!groupedFirstMsgs[msg.msg_id]);
          const groupMediaMsgs = isGroupMedia ? groupedFirstMsgs[msg.msg_id] : null;
          const isMediaMsg = cached?.isMedia ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isGroupMedia && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && !isLocationMsg && isMediaType(msg.msg_type, msg.content));
          const isFileMsg = cached?.isFile ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isMediaMsg && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && !isLocationMsg && isFileType(msg.msg_type, msg.content));
          const content = cached?.content ?? (isMediaMsg || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isGroupMedia || isRtf || isPollMsg || isVideoMsg || isVoiceMsg || isBankCardMsg || isLocationMsg ? '' : parseContent(msg.content, msg.msg_type));

          // Sticker nhóm: nhiều sticker liền nhau từ cùng người gửi trong 30 phút
          const isGroupedStickerFirst = isStickerMsg && !!groupedStickerFirstMsgs[msg.msg_id];
          const groupStickerMsgs = isGroupedStickerFirst ? groupedStickerFirstMsgs[msg.msg_id] : null;


          // Reactions: parse new PHP-like format or legacy format
          const reactionCounts = parseReactions(msg.reactions);
          const hasReactions = Object.keys(reactionCounts).length > 0;

          // Selection state for this message
          const isMsgSelected = isSelecting && selectedMsgIds.has(msg.msg_id);
          const isGroupedFirst = !!groupedFirstMsgs[msg.msg_id];

          // Toggle selection for this message (and all images in group if applicable)
          const toggleMsgSelect = () => {
            if (!isSelecting) return;
            setSelectedMsgIds(prev => {
              const next = new Set(prev);
              if (isGroupedFirst) {
                // Select/deselect ALL images in the media group
                const allIds = groupedFirstMsgs[msg.msg_id].map((m: any) => m.msg_id);
                const allSelected = allIds.every((id: string) => next.has(id));
                if (allSelected) { allIds.forEach((id: string) => next.delete(id)); }
                else { allIds.forEach((id: string) => next.add(id)); }
              } else {
                if (next.has(msg.msg_id)) next.delete(msg.msg_id);
                else next.add(msg.msg_id);
              }
              return next;
            });
          };

          return (
            <div key={msg.msg_id + idx} id={`msg-${msg.msg_id}`}
              className={`flex flex-col mb-0.5 rounded-lg transition-colors ${isEcardMsg ? 'items-center' : isSent ? 'items-end' : 'items-start'} group/msg${isMsgSelected ? ' bg-blue-500/10 ring-1 ring-blue-500/40 rounded-lg' : ''}${isSelecting && !isEcardMsg ? ' cursor-pointer' : ''}`}
              onClick={isSelecting && !isEcardMsg ? (e) => {
                // Skip click nếu vừa kết thúc drag-select (tránh toggle ngay sau drag)
                if (Date.now() < clickSuppressUntilRef.current) return;
                e.stopPropagation(); toggleMsgSelect();
              } : undefined}
              onPointerDown={!isEcardMsg ? (e) => {
                // Không intercept pointerdown trên interactive elements
                const target = e.target as HTMLElement;
                if (target.closest('a, button, img, video, audio, [role="button"], input, textarea, select')) return;
                dragSelectRef.current = {
                  startMsgId: msg.msg_id,
                  startIdx: idx,
                  hasActivated: false,
                };
              } : undefined}
            >
              {showTime && (
                <div className="flex justify-center w-full my-2">
                  <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded-full">
                    {formatMsgTime(msg.timestamp)}
                  </span>
                </div>
              )}

              {/* Outer row: bubble + action buttons */}
              <div className={`flex items-end gap-1 ${isEcardMsg ? 'w-full justify-center' : isSent ? 'flex-row-reverse' : 'flex-row'}`} style={{ maxWidth: '100%' }}>
                {/* Selection checkbox - visible when in selection mode */}
                {isSelecting && !isEcardMsg && (
                  <div className="w-5 h-5 flex-shrink-0 self-center mb-1">
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isMsgSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-500 bg-transparent'}`}>
                      {isMsgSelected && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                      )}
                    </div>
                  </div>
                )}
                {/* Bubble area */}
                <div
                  className={`flex items-end gap-2 min-w-0 ${isEcardMsg ? 'w-full' : isSent ? 'flex-row-reverse' : 'flex-row'}`}
                  onContextMenu={(e) => {
                    if (isSelecting) { e.preventDefault(); return; } // Suppress context menu in selection mode
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
                          {avatarUrl && !failedMsgAvatars.has(msg.sender_id) ? (
                            <img src={avatarUrl} alt={displayName} className="w-7 h-7 rounded-full object-cover"
                              onError={() => {
                                setFailedMsgAvatars(prev => new Set(prev).add(msg.sender_id));
                                if (activeAccountId && !avatarRefreshAttempted.current.has(msg.sender_id)) {
                                  avatarRefreshAttempted.current.add(msg.sender_id);
                                  const contact = getContact(msg.sender_id);
                                  handleAvatarError({ ownerId: activeAccountId, contactId: msg.sender_id, channel: contact?.channel || 'zalo' })
                                    .then(newUrl => {
                                      if (newUrl) {
                                        updateContact(activeAccountId!, { contact_id: msg.sender_id, avatar_url: newUrl });
                                        setFailedMsgAvatars(prev => { const n = new Set(prev); n.delete(msg.sender_id); return n; });
                                      }
                                    }).catch(() => {});
                                }
                              }} />
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

                  {/* Employee avatar on right side - every message with handled_by_employee */}
                  {isSent && !isEcardMsg && (() => {
                    const empId = msg.handled_by_employee;
                    if (!empId) return null;
                    const empStore = useEmployeeStore.getState();
                    const emp = empStore.employees.find((e: any) => e.employee_id === empId);
                    const empName = emp?.display_name || empStore.employeeNameMap[empId] || 'NV';
                    const rawAvatar = emp?.avatar_url || empStore.employeeAvatarMap[empId] || '';
                    // Convert local path → Boss REST URL nếu cần (employee mode)
                    const empAvatar = rawAvatar && !rawAvatar.startsWith('http')
                      ? toLocalMediaUrl(rawAvatar)
                      : rawAvatar;
                    return <EmployeeAvatar key={empId} name={empName} avatarUrl={empAvatar} />;
                  })()}

                  <div className={`flex flex-col ${isEcardMsg ? 'w-full items-center' : isSent ? 'items-end' : 'items-start'} relative min-w-0${hasReactions && !isGroupedStickerFirst ? ' mb-3' : ''}`}>
                    {/* Sender name in group chats */}
                    {!isSent && !isEcardMsg && msg.thread_type === 1 && showTime && displayName && displayName !== msg.sender_id && (
                      <p className="text-xs text-gray-400 mb-0.5 px-1 truncate max-w-full">{displayName}</p>
                    )}
                    <div className={`rounded-2xl text-sm break-words min-w-0 overflow-hidden ${
                      isMediaMsg || isGroupMedia || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isBankCardMsg ? '' : isSent
                        ? 'px-3 py-2 bg-blue-400/40 text-white border border-blue-200 dark:border-blue-600/50 rounded-br-sm'
                        : 'px-3 py-2 bg-gray-700 text-gray-200 border border-gray-200 dark:border-gray-600 rounded-bl-sm'
                    } ${msg.send_status === 'pending' ? 'opacity-60' : msg.send_status === 'sending' ? 'opacity-80' : ''}`}>
                    {/* Quote preview - supports both pre-built quote_data and reply_to_id fallback */}
                    {(msg.quote_data || msg.reply_to_id) && (() => {
                      // Build quote object from quote_data or fallback to reply_to_id + msgs lookup
                      let q: any;
                      if (msg.quote_data) {
                        try { q = JSON.parse(msg.quote_data); } catch { q = {}; }
                      } else {
                        // Fallback: look up original message from msgs by reply_to_id
                        const origFromMsgs = msgs.find(m => m.msg_id === msg.reply_to_id);
                        q = {
                          msgId: msg.reply_to_id,
                          msg: origFromMsgs?.content || '',
                          senderId: '',
                          msgType: origFromMsgs?.msg_type || 'text',
                        };
                      }

                      try {
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
                            // Dùng msg_type thật từ tin nhắn gốc nếu quote_data đang fallback sai
                            if (origMsg.msg_type && origMsg.msg_type !== 'text') {
                              q.msgType = origMsg.msg_type;
                            }
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
                              quoteDisplayText = '[Link]';
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
                            className={`border-l-2 ${isSent ? 'border-blue-200 bg-blue-200/30' : 'border-gray-400 bg-gray-600/50'} rounded pl-2 pr-1 py-1 mb-1 text-xs cursor-pointer hover:opacity-100 overflow-hidden min-w-0 max-w-full`}
                            onClick={() => q.msgId && handleScrollToMsg(String(q.msgId))}
                          >
                            {q.fromD && <p className={`font-semibold truncate ${isSent ? 'text-white' : 'text-gray-200'}`}>{q.fromD}</p>}
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
                              className="line-clamp-2 break-words whitespace-pre-wrap mt-1 mb-1"
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
                      isLocation={isLocationMsg}
                      renderGroupMedia={() => <MediaGroupBubble msgs={groupMediaMsgs!} onView={openViewer} isSelecting={isSelecting} selectedMsgIds={selectedMsgIds} onToggleSelect={(id) => {
                        setSelectedMsgIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
                      }} />}
                      renderPoll={() => (
                        <PollBubble msg={msg} isSent={isSent} activeAccountId={activeAccountId || ''} threadId={activeThreadId || ''} />
                      )}
                      renderVideo={() => {
                        // Facebook video: auto-capture thumbnail + click → system player
                        let videoPath = '';
                        try {
                          const lp = typeof msg.local_paths === 'string'
                            ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
                          videoPath = lp.file || lp.video || lp.main || '';
                          // Facebook group videos store path as att_0, att_1, etc.
                          if (!videoPath) {
                            const attKey = Object.keys(lp).find(k => k.startsWith('att_'));
                            if (attKey) videoPath = lp[attKey];
                          }
                        } catch {}
                        if (!videoPath && msg.channel === 'facebook') {
                          try {
                            const atts = JSON.parse(msg.attachments || '[]');
                            if (atts[0]?.localPath) videoPath = atts[0].localPath;
                          } catch {}
                        }
                        return <FBVideoThumb videoPath={videoPath} />;
                      }}
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
                        <>
                          <TextWithMentions text={content} allContacts={contactList} groupMembersList={groupMembers}
                            highlight={searchHighlightQuery}
                            onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
                          {msg.is_edited === 1 && (
                            <>
                              <span className="ml-1 text-[10px] opacity-60 select-none font-normal">
                                (đã chỉnh sửa)
                              </span>
                              {(() => {
                                try {
                                  const parsed = JSON.parse(msg.edit_history || '[]');
                                  if (!Array.isArray(parsed) || parsed.length === 0) return null;
                                  return (
                                    <button
                                      onClick={() => setRevealedEditIds(prev => {
                                        const next = new Set(prev);
                                        if (next.has(msg.msg_id)) next.delete(msg.msg_id);
                                        else next.add(msg.msg_id);
                                        return next;
                                      })}
                                      className="ml-1 text-[10px] font-medium text-blue-300/70 hover:text-blue-300 transition-colors underline underline-offset-2 select-none pointer-events-auto"
                                    >
                                      {revealedEditIds.has(msg.msg_id) ? 'Ẩn' : 'Xem nội dung cũ'}
                                    </button>
                                  );
                                } catch { return null; }
                              })()}
                            </>
                          )}
                          {revealedEditIds.has(msg.msg_id) && (() => {
                            try {
                              const parsed = JSON.parse(msg.edit_history || '[]');
                              if (!Array.isArray(parsed) || parsed.length === 0) return null;
                              return (
                                <div className="w-full mt-1 space-y-1">
                                  {parsed.map((entry: any, i: number) => (
                                    <div
                                      key={i}
                                      className={`px-3 py-1.5 rounded-lg text-xs opacity-60 ${isSent ? 'bg-blue-700/30 mr-8' : 'bg-gray-600/30 ml-8'}`}
                                    >
                                      <div className="text-[10px] opacity-50 mb-0.5">
                                        {new Date(entry.editedAt).toLocaleString('vi-VN')}
                                      </div>
                                      <div className="break-words whitespace-pre-wrap italic">
                                        {parseContent(entry.oldBody || '') || '(Không có nội dung)'}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              );
                            } catch { return null; }
                          })()}
                        </>
                      )}
                    />
                  </div>


                  {/* Single reaction button - position absolute at bottom corner (side matching bubble alignment) */}
                  {channelCap.supportsReaction && !isEcardMsg && !isGroupedStickerFirst && (() => {
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
                        className={`absolute -bottom-3 z-2 transition-opacity duration-100${!hasReactions ? ' opacity-0 group-hover/msg:opacity-100' : ''}${isSent ? ' right-0' : ' left-0'}`}
                        onMouseEnter={() => setReactionPickerMsgId(msg.msg_id)}
                        onMouseLeave={() => setReactionPickerMsgId(null)}
                      >
                        {/* Emoji picker - appears above on hover, always opens toward center */}
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

                  {/* ── Send status indicator (optimistic messages) ──── */}
                  {isSent && msg.send_status && msg.send_status !== 'received' && (
                    <div className="flex items-center gap-1 mt-0.5 px-1">
                      {msg.send_status === 'pending' && (
                        <span title="Đang chờ gửi">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-gray-400 opacity-60">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                          </svg>
                        </span>
                      )}
                      {msg.send_status === 'sending' && (
                        <span title="Đang gửi...">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400 animate-spin">
                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                          </svg>
                        </span>
                      )}
                      {msg.send_status === 'sent' && (
                        <span title="Đã gửi">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-gray-400">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        </span>
                      )}
                      {(msg.send_status === 'failed' || msg.send_status === 'timeout') && (
                        <div className="flex items-center gap-1">
                          <span title={msg.send_status === 'timeout' ? 'Gửi timeout (60s)' : 'Gửi thất bại'}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-red-400">
                              <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                            </svg>
                          </span>
                          {msg.media_type === 'text' || msg.media_type === 'link' || !msg.media_type ? (
                            <button
                              onClick={() => {
                                // Retry text: xóa msg cũ, gửi lại
                                removeMessage(activeAccountId!, activeThreadId, msg.msg_id);
                                const retryTempId = `retry_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
                                const isFb = msg.channel === 'facebook';
                                useChatStore.getState().addMessage(activeAccountId!, activeThreadId, {
                                  msg_id: retryTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
                                  thread_type: msg.thread_type, sender_id: activeAccountId!, content: msg.content,
                                  msg_type: msg.msg_type, timestamp: Date.now(), is_sent: 1, status: 'sending',
                                  send_status: 'pending', temp_id: retryTempId, media_type: 'text',
                                  ...(msg.quote_data ? { quote_data: msg.quote_data } : {}),
                                });
                                import('@/lib/MessageQueue').then(({ messageQueue, extractMsgIdFromResponse }) => {
                                  const auth = (() => {
                                    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
                                    return acc ? { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent, accountId: activeAccountId } : null;
                                  })();
                                  if (!auth) return;
                                  messageQueue.enqueue({
                                    tempId: retryTempId, zaloId: activeAccountId!, threadId: activeThreadId,
                                    threadType: msg.thread_type, channel: isFb ? 'facebook' : 'zalo',
                                    sendFn: async () => {
                                      try {
                                        if (isFb) {
                                          const r = await ipc.fb?.sendMessage({ accountId: activeAccountId!, threadId: activeThreadId, body: msg.content });
                                          return { success: !!r?.success, msgId: (r as any)?.messageId, error: r?.error };
                                        } else {
                                          const res = await ipc.zalo?.sendMessage({ auth, threadId: activeThreadId, type: msg.thread_type, message: msg.content });
                                          return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
                                        }
                                      } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
                                    },
                                  });
                                });
                              }}
                              className="text-[10px] text-red-400 hover:text-red-300 underline"
                            >Gửi lại</button>
                          ) : (
                            <span className="text-[10px] text-gray-500 italic">Không thể gửi lại media</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  </div>{/* end flex flex-col (bubble content column) */}
                </div>{/* end bubble area (flex items-end gap-2) */}

                {/* Hover action buttons - visible on msg hover, outside bubble */}
                {!isEcardMsg && !isGroupedStickerFirst && !isSelecting && (
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
      </div>
      )}

      {/* Selection action bar */}
      {isSelecting && (
        <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-t border-blue-500/40 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => { setIsSelecting(false); setSelectedMsgIds(new Set()); }}
              className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <span className="text-sm text-blue-400 font-medium">Đã chọn {selectedMsgIds.size} tin nhắn</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => {
              // Copy selected text messages
              const selectedMsgs = msgs.filter(m => selectedMsgIds.has(m.msg_id));
              const texts = selectedMsgs.map(m => extractMsgText(m)).filter(t => t && t !== '[Tin nhắn]');
              if (texts.length > 0) {
                navigator.clipboard.writeText(texts.join('\n'));
                showNotification(`Đã sao chép ${texts.length} tin nhắn`, 'success');
              } else {
                showNotification('Không có tin nhắn văn bản nào được chọn', 'info');
              }
            }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-gray-700 text-gray-300 hover:text-white text-xs transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              Sao chép
            </button>
            {channelCap.supportsForward && (
              <button onClick={() => {
                const selectedMsgs = msgs.filter(m => selectedMsgIds.has(m.msg_id));
                if (selectedMsgs.length > 0) {
                  setForwardMsgs(selectedMsgs);
                  setIsSelecting(false);
                  setSelectedMsgIds(new Set());
                }
              }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>
                Chuyển tiếp
              </button>
            )}
          </div>
        </div>
      )}

      {/* Typing indicator - hiển thị phía trên input, không chồng lên nội dung */}
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
              <div className="w-4 h-4 rounded-full bg-gray-600 flex items-center justify-center text-white flex-shrink-0 opacity-80" style={{ fontSize: '0.5625rem' }}>
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
            <span className="text-[11px] text-gray-400 mr-0.5">Đã xem</span>
            <div className="flex items-center -space-x-1">
              {shown.map((u) => (
                <div key={u.userId} title={u.name} className="w-4 h-4 rounded-full ring-1 ring-gray-800 overflow-hidden flex-shrink-0">
                  {u.avatar ? (
                    <img src={u.avatar} alt={u.name} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <div className="w-full h-full bg-blue-500 flex items-center justify-center text-white" style={{ fontSize: '0.4375rem', fontWeight: 700 }}>
                      {(u.name).charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
              ))}
              {extra > 0 && (
                <div className="w-4 h-4 rounded-full ring-1 ring-gray-800 bg-gray-600 flex items-center justify-center text-white" style={{ fontSize: '0.4375rem' }}>
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
          channelCap={channelCap}
          onClose={() => setContextMenu(null)}
          onReply={(m) => setReplyTo(m)}
          onForward={(m) => { setForwardMsgs([m]); }}
          onSelectMessages={(m) => { setIsSelecting(true); setSelectedMsgIds(new Set([m.msg_id])); }}
          onUndo={handleUndo}
          onDelete={handleDelete}
          onDeleteFromDb={handleDeleteFromDb}
          onReact={handleReact}
          onPin={handlePin}
          showNotification={showNotification}
        />
      )}

      {/* Forward message modal */}
      {channelCap.supportsForward && forwardMsgs && (
        <ForwardMessageModal
          messages={forwardMsgs}
          contacts={contactList}
          onClose={() => setForwardMsgs(null)}
          onForward={(messages, targets, composeText) => {
            const auth = getAuth();
            if (!auth) return;
            setForwardMsgs(null);
            // Detect channel from forwarded message
            const forwardContact = contacts[activeAccountId || '']?.find((c: any) =>
              messages[0] ? c.contact_id === messages[0].thread_id : false);
            const forwardChannel = messages[0]?.channel || forwardContact?.channel || 'zalo';
            // Chạy lần lượt ở background, không block UI
            (async () => {
              const total = messages.length * targets.length;
              let counter = 0;
              let failCount = 0;
              for (const msg of messages) {
                for (const target of targets) {
                  counter++;
                  try {
                    await sendOneForward(auth, msg, target, composeText, forwardChannel, activeAccountId);
                  } catch (e: any) {
                    failCount++;
                  }
                  if (total > 1) {
                    showNotification(`Đang chuyển tiếp ${counter}/${total}...`, 'info');
                  }
                }
              }
              if (failCount === 0) {
                showNotification('Đã chuyển tiếp xong', 'success');
              } else {
                showNotification(`Đã chuyển tiếp xong (${failCount} lỗi)`, 'error');
              }
            })();
          }}
        />
      )}

      {/* Reaction context menu (right-click on reaction pill) */}
      {channelCap.supportsReaction && reactionContextMenu && (
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
      {channelCap.supportsReaction && reactionPopup && (
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

      {/* Manage group modal - mở từ nút "Quản lý nhóm" trong EcardBubble */}
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

      {/* Note view modal - mở khi click vào ghi chú đã ghim */}
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




// extractMsgText: imported from @/lib/chat/messageParser

/** Gửi 1 tin nhắn đến 1 target - dùng trong forward loop */
async function sendOneForward(
  auth: any, msg: any, target: { threadId: string; threadType: number }, composeText: string,
  channel?: string, accountId?: string,
) {
  const msgType = msg.msg_type || '';
  const content = msg.content || '';
  const isVideo = msgType === 'chat.video.msg';
  const isFile = !isVideo && isFileType(msgType, content);
  const isImage = !isVideo && !isFile && isMediaType(msgType, content);
  let localPath = '';
  try {
    const raw = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    if (raw && typeof raw === 'object') {
      localPath = raw.file || raw.video || raw.main || raw.hd || Object.values(raw).find(v => typeof v === 'string' && v) as string || '';
    }
  } catch {}

  if (channel === 'facebook' && accountId) {
    if ((isFile || isVideo || isImage) && localPath) {
      await channelIpc.sendAttachment('facebook', { accountId, threadId: target.threadId, filePath: localPath, threadType: target.threadType });
    } else if ((isFile || isVideo || isImage) && !localPath && msg.msg_id) {
      // Media không có file local → gửi native forward
      await ipc.fb?.forwardMessage({ accountId, messageId: String(msg.msg_id), targetThreadId: target.threadId, isGroup: target.threadType === 1 });
    } else {
      const text = composeText || extractMsgText(msg);
      await channelIpc.sendMessage('facebook', { accountId, threadId: target.threadId, body: text, threadType: target.threadType });
    }
    if (composeText && (isFile || isVideo || isImage) && localPath) {
      await channelIpc.sendMessage('facebook', { accountId, threadId: target.threadId, body: composeText, threadType: target.threadType });
    }
    return;
  }

  // Zalo path (existing)
  if ((isFile || isVideo || isImage) && localPath) {
    // Có file local → gửi lại như tin mới
    if (isFile || isVideo) {
      await ipc.zalo?.sendFile({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType });
    } else {
      await ipc.zalo?.sendImage({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType, message: '' });
    }
  } else if ((isFile || isVideo || isImage) && !localPath && msg.msg_id) {
    // Media nhưng không có file local → dùng native forward API (Zalo tự chuyển tiếp nội dung)
    await ipc.zalo?.forwardMessage({
      auth,
      payload: {
        message: composeText || '',
        reference: {
          id: String(msg.msg_id),
          ts: msg.timestamp || Date.now(),
          logSrcType: 0,
          fwLvl: 0,
        },
      },
      threadIds: [target.threadId],
      type: target.threadType,
    });
  } else {
    const text = composeText || extractMsgText(msg);
    await ipc.zalo?.sendMessage({ auth, message: text, threadId: target.threadId, type: target.threadType });
  }
  if (composeText && (isFile || isVideo || isImage) && localPath) {
    await ipc.zalo?.sendMessage({ auth, message: composeText, threadId: target.threadId, type: target.threadType });
  }
}

// FriendRequestBar extracted to ./FriendRequestBar.tsx
