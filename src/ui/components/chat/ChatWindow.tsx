import { Spinner } from '@/components/common/PageLoading';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MESSAGE_LOAD_LIMIT, MESSAGE_LOAD_MORE_LIMIT, MESSAGE_AROUND_LIMIT, GROUP_MEMBER_LIMIT, LOAD_MORE_TIMEOUT_MS, LOAD_OLDER_PREFETCH_PX, GROUP_INFO_CACHE_TTL_MS } from '@/lib/chat/constants';
import { readDropPayload } from '@/lib/chat/dropFiles';
import { getMessageCacheKey, useChatStore, type ContactItem, type MessageItem } from '@/store/chatStore';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import type { MediaViewerImage } from './MediaViewer';
import MediaGalleryViewer, { type MediaGalleryViewerHandle } from './MediaGalleryViewer';
import { buildStarredSnapshot, starKey } from '@/lib/chat/starredMessages';
import { useStarredStore } from '@/store/starredStore';
import { isMyDocumentsThread, myDocumentsThreadId } from '@/lib/chat/myDocuments';
import { groupRankLabel, peerColorIndex, telegramRankLabel } from '@/lib/chat/peerStyle';
import PeerInitials from '@/components/common/PeerInitials';
import { useTelegramGroupAdmins } from '@/lib/chat/telegramGroupAdmins';
import MessageContextMenu from './MessageContextMenu';
import { BubbleTime, MessageStatusContext, MessageTtlContext, StatusTicks, TtlExpiredNote, TtlMark, formatBubbleTime, formatFullDateTime, inlineTimeSpacerClass } from './MessageTime';
import { inferredPeerReadTs, mergePeerReceipts, outgoingMessageStatus } from '@/lib/chat/messageStatus';
import PinnedBar, { buildPinFromMsg, usePinnedData } from './PinnedMessages';
import ChatHistoryList from './ChatHistoryList';
import SharedMessageContent from './SharedMessageContent';
import FacebookTemplateCard, { FacebookEmptyMessage } from './FacebookTemplateCard';
import ZaloOaCard from './ZaloOaCard';
import { isZinstantMsgType } from '../../../shared/zaloZinstant';
import { FB_TEMPLATE_MSG_TYPE } from '../../../shared/facebookTemplate';

/** Cột attachments có đính kèm thật (không phải '', '[]', 'null'). */
function hasStoredAttachments(raw: unknown): boolean {
  if (!raw) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  const text = String(raw).trim();
  return !!text && text !== '[]' && text !== 'null' && text !== '{}';
}
import TelegramWebViewModal from './TelegramWebViewModal';
import VideoPlayer from './VideoPlayer';
import * as channelIpc from '../../lib/channelIpc';
import { getCapability, getChannelLabel, type Channel } from '@/../configs/channelConfig';
import { useQuickErpAccess } from '@/hooks/erp/useQuickErpAccess';
import { QuickEventDialog, QuickNoteDialog } from './quick/QuickErpDialogs';
import ScheduleChip from './ScheduleChip';
import { eventDraftFromMessages, noteDraftFromMessages, type ErpSourceMessage } from '@/lib/chat/messageToErp';
import { CHANNEL, isNonZalo, isZalo, isFacebook, isTelegram as isTelegramCh, isTelegramForumGeneral, isTelegramUser } from '@/lib/channelHelper';
import { ManagePanel } from './GroupInfoPanel';
import { UserProfilePopup } from '../common/UserProfilePopup';
import { RecalledBubble, BankCardBubble } from './MessageBubbles';
import { getLocalMediaPath, getTelegramForwardMeta, getTelegramPostMeta } from '@/lib/mediaResolver';
import { canQueryTelegramReadReceipts } from '@/lib/chat/readReceipts';
import { getAdapter } from '@/lib/adapters/registry';
import FBVideoThumb from './FBVideoThumb';
import { ZaloRemoteVideoThumb } from './ZaloMediaExpiry';
import { toZaloJpgUrl } from '../../../utils/zaloImageUrl';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { markLocalReaction } from '@/lib/chat/localReactionRegistry';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useEmployeeStore } from '@/store/employeeStore';
import { CalendarIcon, ChatIcon, FileTextIcon } from '@/components/common/icons';
import { handleAvatarError } from '@/lib/avatarRetry';
import { EMOJI_TO_REACTION } from '@/lib/chat/emojiUtils';
import { parseContent, parseQuoteMsg, getQuotedMediaCaption, extractQuoteImage, extractMediaUrl, formatMsgTime, formatDaySeparator, extractMsgText, getMentionRanges } from '@/lib/chat/messageParser';
import { isCardType, isEcardType, isFileType, isStickerType, isRtfMsg, isMediaType, isVideoType, isVoiceType, isBankCardType } from '@/lib/chat/messageTypeUtils';
import {
  getForwardBlockReason, getForwardCaption, getForwardPlan, getZaloCardInfo, getZaloLinkInfo, getZaloRichText,
  getZaloStickerId, getZaloVideoInfo, getZaloVoiceUrl, type ForwardKind,
} from '@/lib/chat/forwardSupport';
import { NoteViewModal } from './NoteViewModal';
import ForwardMessageModal from './ForwardMessageModal';
import PollBubble from './PollBubble';
import TelegramPollBubble from './TelegramPollBubble';
import FriendRequestBar from './FriendRequestBar';
import { ReactionContextMenu, ReactionPopup, parseReactions, parseReactionsFull } from './ReactionComponents';
import { MessageReactionCorner, useReactionHoverPicker } from './MessageReactionCorner';
import { getReactionChoices, sameReaction, useTelegramChatReactions } from '@/lib/chat/reactionChoices';
import {
  EmployeeAvatar, FileBubble, MediaBubble, VoiceBubble,
  QuotedStickerPreview, StickerGroupBubble, getGroupLayoutId, MediaGroupBubble,
  StickerBubble, MsgActionBtn, EcardBubble, CardBubble, TextWithMentions, RtfBubble, BubbleEmbedContext, TelegramForwardHeader,
  TelegramVideoPending, getTelegramVideoMedia,
} from './ChatWindowBubbles';
import { getTelegramWebpageMeta, TelegramLinkPreviewCard, TelegramPreviewRefresh } from './TelegramLinkPreview';
import { setInlineAutoplaySuspended } from '@/lib/media/inlineAutoplay';
import StickyDayPill from './StickyDayPill';
import { getDayStartIds } from '@/lib/chat/daySeparators';
import { TelegramStickerSetHost } from './stickers/TelegramStickerSetDialog';
import { openStickerSetOfMessage } from '@/lib/chat/telegramStickerStore';
import { TELEGRAM_POST_MAX_WIDTH, TELEGRAM_POST_WIDTH, TelegramPostLayoutContext, pickTelegramPostStats } from './telegramPostLayout';
import { TelegramPostCommentsBar, TelegramPostFooter, TelegramPostReactions } from './telegram/TelegramPostParts';
import TelegramRichMessageBody, { getRichMessageBlocks } from './telegram/TelegramRichMessageBody';
import { useTelegramPostStats } from '@/hooks/useTelegramPostStats';

/** Video Telegram tự phát không tiếng trong khung chat: chỉ file nhỏ (= nhóm tự tải), như Telegram. */
const TELEGRAM_INLINE_AUTOPLAY_MAX_BYTES = 10 * 1024 * 1024;

/** Giá trị rỗng ổn định cho selector (không tạo mảng mới mỗi lần render → memo phía sau không chạy lại) */
const EMPTY_MESSAGES: MessageItem[] = [];
const EMPTY_CONTACTS: ContactItem[] = [];
const EMPTY_MEMBERS: any[] = [];
/** Telegram group / channel open: re-read reactions of the newest messages this often (Telegram: 15-30 s). */
const TG_REACTION_POLL_MS = 20_000;
const TG_REACTION_POLL_BATCH = 50;

/** Reaction của tin (chuỗi JSON hoặc object { emoji: { [e]: { users } } }) có người dùng này không */
function reactionsIncludeUser(raw: unknown, userId: string): boolean {
  if (!raw || !userId) return false;
  let parsed: any = raw;
  if (typeof raw === 'string') {
    if (!raw.includes(userId)) return false;
    try { parsed = JSON.parse(raw); } catch { return false; }
  }
  const emoji = parsed?.emoji;
  if (!emoji || typeof emoji !== 'object') return false;
  return Object.values(emoji).some((entry: any) => !!entry?.users && Object.prototype.hasOwnProperty.call(entry.users, userId));
}

/** Chuỗi đại diện những người đang gõ trong 1 hội thoại — selector trả chuỗi nên so theo giá trị. */
function typingSignature(typingUsers: Record<string, number>, prefix: string): string {
  if (!prefix) return '';
  let signature = '';
  for (const key in typingUsers) {
    if (key.startsWith(prefix)) signature += `${key}=${typingUsers[key]};`;
  }
  return signature;
}

export default function ChatWindow() {
  // Chỉ subscribe đúng phần store của hội thoại đang mở. `useChatStore()` không selector làm cả cửa sổ (mọi hàng
  // tin) render lại với MỌI thay đổi: tin mới / đang gõ / đã xem ở hội thoại hay tài khoản khác → cuộn bị giật.
  const { activeAccountId, getActiveAccount, accounts: allAccounts } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, getActiveAccount: s.getActiveAccount, accounts: s.accounts,
  })));
  const {
    activeThreadId, prependMessages, setMessages, setReplyTo, editingMsg, setEditingMsg, removeMessage, updateContact,
    messagesLoading, activeTopicId, activeForumTopicId, activeTopicTitle,
  } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, prependMessages: s.prependMessages, setMessages: s.setMessages,
    setReplyTo: s.setReplyTo, editingMsg: s.editingMsg, setEditingMsg: s.setEditingMsg, removeMessage: s.removeMessage,
    updateContact: s.updateContact, messagesLoading: s.messagesLoading, activeTopicId: s.activeTopicId,
    activeForumTopicId: s.activeForumTopicId, activeTopicTitle: s.activeTopicTitle,
  })));
  const threadKey = activeAccountId && activeThreadId
    ? getMessageCacheKey(activeAccountId, activeThreadId, activeTopicId)
    : '';
  const msgs = useChatStore(s => (threadKey ? s.messages[threadKey] : undefined)) ?? EMPTY_MESSAGES;
  const contactList = useChatStore(s => (activeAccountId ? s.contacts[activeAccountId] : undefined)) ?? EMPTY_CONTACTS;
  const typingPrefix = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}_` : '';
  const threadTypingKey = useChatStore(s => typingSignature(s.typingUsers, typingPrefix));
  const threadSeen = useChatStore(s => (activeAccountId && activeThreadId ? s.seenInfo[`${activeAccountId}_${activeThreadId}`] : undefined));
  const { showNotification, searchHighlightQuery } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, searchHighlightQuery: s.searchHighlightQuery,
  })));
  const threadGroupInfo = useAppStore(s => (
    activeAccountId && activeThreadId ? s.groupInfoCache?.[activeAccountId]?.[activeThreadId] : undefined
  ));

  const activeContact = React.useMemo(() => {
    if (!activeAccountId || !activeThreadId) return undefined;
    return contactList.find(c => c.contact_id === activeThreadId);
  }, [activeAccountId, activeThreadId, contactList]);
  const channelCap = React.useMemo(() =>
    getCapability((activeContact?.channel || CHANNEL.ZALO) as Channel),
  [activeContact]);
  // Mốc người kia đã nhận / đã xem tin mình gửi (cột của hội thoại + event:receipt realtime) → dấu ✓ / ✓✓ cạnh giờ
  const liveReceipt = useChatStore(s => (activeAccountId && activeThreadId ? s.peerReceipts[`${activeAccountId}_${activeThreadId}`] : undefined));
  // Người kia nhắn sau tin mình gửi ⇒ đã xem các tin trước đó (Zalo / Facebook không phải lúc nào cũng báo "đã xem")
  const inferredReadTs = React.useMemo(() => inferredPeerReadTs(msgs, activeContact?.channel), [msgs, activeContact?.channel]);
  const threadReceipt = React.useMemo(() => mergePeerReceipts(
    activeContact ? { deliveredTs: activeContact.peer_delivered_ts, readTs: activeContact.peer_read_ts, readMaxId: activeContact.peer_read_max_id } : null,
    liveReceipt,
    inferredReadTs ? { readTs: inferredReadTs } : null,
  ), [activeContact?.peer_delivered_ts, activeContact?.peer_read_ts, activeContact?.peer_read_max_id, liveReceipt, inferredReadTs]);
  // Nhóm Telegram: chức vụ (chức vụ tự đặt / Quản trị viên / Chủ nhóm) ở góc phải tên người gửi, như Telegram
  const telegramGroupAdmins = useTelegramGroupAdmins(
    activeAccountId, activeThreadId,
    isTelegramUser(activeContact?.channel) && activeContact?.contact_type === 'group',
  );
  // Kênh Telegram: lượt xem / số bình luận của bài làm mới khi mở kênh + mỗi 60 s (như Telegram); hồ sơ người bình luận
  // gần đây cho thanh bình luận
  const postReplierPeers = useTelegramPostStats(activeAccountId, activeThreadId, activeContact?.channel, msgs);

  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // Phần nội dung bên trong khung cuộn: ResizeObserver theo dõi phần này để bám đáy khi ảnh/video tải xong
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const pinnedBarWrapperRef = useRef<HTMLDivElement>(null);
  const prevPinnedBarHeightRef = useRef(0);
  const prevLastMsgIdRef = useRef<string>('');
  const savedScrollHeightRef = useRef(0);
  const savedScrollTopRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);
  const isInitialThreadLoadRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  // nearBottomRef: cập nhật realtime từ scroll event (không gây re-render)
  // dùng cho ResizeObserver + realtime scroll — tránh stale closure
  const nearBottomRef = useRef(true);
  // Debounced scroll-to-bottom: gom nhiều request thành 1 lần scroll
  const scrollRafRef = useRef(0);
  const scrollToBottom = useCallback((reason?: string) => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = messagesContainerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
      nearBottomRef.current = true;
    });
  }, []);

  // Chỉ để hiện spinner (bật trễ khi trang tải lâu); chặn tải trùng dùng loadingMoreRef
  const [loadingMore, setLoadingMore] = useState(false);
  // "Có thể còn tin cũ hơn" — false khi lần tải đã chắc chắn hết
  const [hasMore, setHasMore] = useState(true);
  // Đã biết CHẮC còn tin cũ hơn (trang vừa tải trả dư 1 dòng) → mới hiện nút "Tải tin nhắn cũ hơn"
  const [olderKnown, setOlderKnown] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Mỗi lần tải tin cũ / đổi hội thoại tăng 1 — kết quả về muộn của lần tải cũ bị bỏ qua
  const loadSeqRef = useRef(0);
  // Đang cuộn mượt tới một tin (ghim / trích dẫn / tìm kiếm): chèn trang cũ lên trên lúc này làm lệch đích
  const suppressLoadOlderUntilRef = useRef(0);
  // Facebook API cursor pagination (tạm thời vô hiệu hóa do API lỗi 500)
  const fbCursorRef = useRef<string | null>(null);
  const fbHasMoreRef = useRef(false);
  const fbProbeDoneRef = useRef(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; msg: any; mediaMsg?: any; isSent: boolean; isGroupAdmin?: boolean; recalled?: boolean } | null>(null);
  const [forwardMsgs, setForwardMsgs] = useState<any[] | null>(null);
  // Quản lý công việc: "Thêm vào lịch" / "Lưu vào ghi chú" từ tin (chuột phải một tin, hoặc chọn nhiều tin)
  const [erpDraft, setErpDraft] = useState<{ kind: 'event' | 'note'; msgs: any[] } | null>(null);
  const erpAccess = useQuickErpAccess();
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
  // Thanh chọn cảm xúc: giữ chuột 300 ms trên nút mới mở (lia ngang qua không tự bật), bấm thì mở ngay, rời thì đóng sau
  // 250 ms — dùng chung với phần bình luận bài đăng kênh (MessageReactionCorner)
  const {
    openId: reactionPickerMsgId, open: openReactionPicker, arm: armReactionPicker,
    scheduleClose: scheduleCloseReactionPicker, close: closeReactionPicker,
  } = useReactionHoverPicker();
  // Telegram: reaction dùng được trong hội thoại đang mở (tải khi mở thanh chọn / menu chuột phải)
  const telegramReactions = useTelegramChatReactions(activeAccountId, activeThreadId, activeContact?.channel === 'telegram_user');
  const [userProfilePopup, setUserProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  // Track Facebook avatars that failed to load in message bubbles (per sender)
  const [failedMsgAvatars, setFailedMsgAvatars] = useState<Set<string>>(new Set());
  const avatarRefreshAttempted = useRef<Set<string>>(new Set());
  const quoteRepairAttemptedRef = useRef<Set<string>>(new Set());
  const emptyMessageRepairAttemptedRef = useRef<Set<string>>(new Set());
  const [manageGroupOpen, setManageGroupOpen] = useState(false);
  const [noteModal, setNoteModal] = useState<{ topicId?: string; title?: string; creatorName?: string; createTime?: number } | null>(null);
  // Telegram WebView modal
  const [webviewModal, setWebviewModal] = useState<{ botId: string; url: string; title?: string } | null>(null);
  // Video player modal
  const [videoPlayerState, setVideoPlayerState] = useState<{
    localPath?: string;
    remoteUrl?: string;
    thumbUrl?: string;
    width?: number;
    height?: number;
    duration?: number;
    msgId?: string;
    threadId?: string;
  } | null>(null);
  // Menu chuột phải của tin Telegram → tải danh sách reaction của hội thoại (1 lần / 10 phút)
  useEffect(() => {
    if (contextMenu?.msg?.channel === 'telegram_user') telegramReactions.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu?.msg?.msg_id]);
  // Đang xem video toàn màn hình (có tiếng) → dừng video tự phát trong khung chat
  useEffect(() => {
    setInlineAutoplaySuspended(!!videoPlayerState);
    return () => setInlineAutoplaySuspended(false);
  }, [videoPlayerState]);
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

  // Trigger khi người đang gõ trong thread hiện tại thay đổi
  useEffect(() => {
    if (threadTypingKey) setTypingNow(Date.now());
  }, [threadTypingKey]);

  // Interval chỉ chạy khi typingNow > 0 (có người đang typing)
  useEffect(() => {
    if (!typingNow) return; // SKIP nếu không có typing

    const id = setInterval(() => {
      const prefix = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}_` : '';
      if (!prefix) return;
      const store = useChatStore.getState();
      // Chỉ tính người gõ trong 5s gần nhất (như indicator). Đếm cả key cũ thì interval không bao giờ dừng
      // → cả cửa sổ chat render lại mỗi 500ms mãi khi có người gõ rồi không gửi.
      const nowTs = Date.now();
      const hasTyping = Object.entries(store.typingUsers).some(([k, ts]) => k.startsWith(prefix) && nowTs - ts < 5000);
      if (hasTyping) setTypingNow(nowTs);
      else setTypingNow(0); // Dừng interval khi không còn typing
    }, 500);

    return () => clearInterval(id);
  }, [activeAccountId, activeThreadId, typingNow]);

  // ─── Pinned messages + notes (OPTIMIZED: 1 IPC call thay vì 2) ──────────────
  const { pins, setPins, pinnedNotes, setPinnedNotes, ready: pinsReady } = usePinnedData(activeAccountId, activeThreadId, activeContact?.channel);

  // ─── Thread ready gate: chỉ hiển thị UI khi messages + pins đều đã load ──
  const [threadReady, setThreadReady] = useState(false);
  const [messagesReady, setMessagesReady] = useState(false);
  // Track initial loading for PageLoading display
  const [initialLoading, setInitialLoading] = useState(true);
  // loadingSpinner: spinner trung tâm khi chuyển thread, chỉ done sau khi scroll hoàn tất
  const [loadingSpinner, setLoadingSpinner] = useState(false);
  // Track threadId đã scroll - tránh race condition giữa useLayoutEffect vs useEffect
  const lastScrolledThreadRef = useRef<string | null>(null);

  // ─── Telegram Forum: load topic messages when activeTopicId changes ─────────
  // Pattern: DB-first (instant) → API background sync (slow)
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || !activeTopicId) return;
    const channel = activeContact?.channel || CHANNEL.ZALO;
    if (channel !== 'telegram_user') return;
    const isGeneralTopic = isTelegramForumGeneral(activeTopicId);

    let cancelled = false;

    (async () => {
      // 1. Load from DB first — instant, no network
      try {
        const dbRes = await DataAccessor.getMessages({
          zaloId: activeAccountId,
          threadId: activeThreadId,
          limit: 50,
          offset: 0,
          topicId: activeTopicId,
        });
        if (cancelled) return;
        const dbMessages = dbRes?.messages || dbRes?.items || [];
        if (dbMessages.length > 0) {
          setMessages(activeAccountId, activeThreadId, [...dbMessages].reverse(), activeTopicId);
        }
      } catch {}
      // Don't set messagesLoading=false yet — API sync below

      // General is the normal supergroup timeline, not a reply thread.
      if (isGeneralTopic) {
        if (!cancelled) useChatStore.getState().setMessagesLoading(false);
        return;
      }

      // 2. Fetch from API in background — updates with fresh data
      try {
        const { getAdapter } = await import('@/lib/adapters/registry');
        const adapter = getAdapter('telegram_user');
        const res = await (adapter as any).getForumTopicMessages?.({
          accountId: activeAccountId,
          threadId: activeThreadId,
          topicId: activeTopicId,
          limit: 50,
        });
        if (cancelled) return;
        if (!res?.success || !Array.isArray(res.messages)) {
          useChatStore.getState().setMessagesLoading(false);
          return;
        }

        const mapped = res.messages.map((m: any) => ({
          msg_id: String(m.id),
          owner_zalo_id: activeAccountId,
          thread_id: activeThreadId,
          thread_type: 1,
          sender_id: m.senderId || '',
          content: m.text || (m.msgType === 'sticker' ? '🎨 Sticker' : m.media ? `[${m.media.type}]` : ''),
          msg_type: m.msgType || (m.media?.type === 'MessageMediaPhoto' ? 'photo' : m.media?.type === 'MessageMediaDocument' ? 'file' : 'text'),
          timestamp: (m.date || 0) * 1000,
          is_sent: m.isOut ? 1 : 0,
          attachments: JSON.stringify(m.attachments || []),
          ...(m.localPaths && Object.keys(m.localPaths).length > 0
            ? { local_paths: JSON.stringify(m.localPaths) }
            : {}),
          status: 'received',
          channel: 'telegram_user',
          reply_to_id: m.replyToId || null,
          quote_data: m.quoteData || null,
          topic_id: m.topicRootMessageId || activeTopicId,
          _senderName: m.senderName || '',
        }));

        if (!cancelled && mapped.length > 0) {
          setMessages(activeAccountId, activeThreadId, mapped, activeTopicId);
        }
      } catch (err: any) {
        console.error('[ChatWindow] API topic messages failed:', err.message);
      } finally {
        if (!cancelled) useChatStore.getState().setMessagesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeAccountId, activeThreadId, activeTopicId, activeContact?.channel]);

  msgsRef.current = msgs;

  useEffect(() => {
    quoteRepairAttemptedRef.current.clear();
    emptyMessageRepairAttemptedRef.current.clear();
  }, [activeAccountId, activeThreadId]);

  // Legacy Telegram rows can lack quote_data because the original message was
  // outside the synced page. Forum routing also used to be stored as a quote
  // when reply_to_id was only the topic root. Repair visible rows in one batch
  // and keep safe identifiers in the console for field diagnosis.
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    const repair = ipc.telegramUser?.repairMessageQuotes;
    if (!repair) return;

    const needsQuoteRepair = (message: any): boolean => {
      if (!message?.reply_to_id) return false;
      if (!message.quote_data) return true;
      try {
        const quote = JSON.parse(message.quote_data);
        const quoteType = String(quote?.msgType || 'text');
        const quoteAttach = typeof quote?.attach === 'string' ? quote.attach.trim() : quote?.attach;
        const hasAttachment = !!quoteAttach && quoteAttach !== '[]' && quoteAttach !== '{}';
        if (['photo', 'image', 'chat.photo'].includes(quoteType)) {
          return !quote?.imageUrl && !quote?.imageLocalPath;
        }
        return !String(quote?.msg || '').trim() &&
          (quoteType === 'text' || quoteType === 'chat.text') &&
          !quote?.imageUrl && !hasAttachment;
      } catch {
        return true;
      }
    };

    const batch: Array<{ messageId: string; replyToId: string }> = [];
    for (const message of msgs) {
      if (!needsQuoteRepair(message)) continue;
      const key = `${activeAccountId}:${activeThreadId}:${message.msg_id}:${message.reply_to_id}`;
      if (quoteRepairAttemptedRef.current.has(key)) continue;
      quoteRepairAttemptedRef.current.add(key);
      batch.push({ messageId: String(message.msg_id), replyToId: String(message.reply_to_id) });
      if (batch.length >= 100) break;
    }
    if (batch.length === 0) return;

    void repair({ accountId: activeAccountId, chatId: activeThreadId, items: batch })
      .then(response => {
        const results = response?.results || [];
        console.info('[TelegramQuoteRepair]', {
          accountId: activeAccountId,
          threadId: activeThreadId,
          requested: batch.length,
          repaired: results.filter(item => item.status === 'repaired').length,
          topicRouting: results.filter(item => item.status === 'topic_routing').length,
          deferred: results.filter(item => item.status === 'deferred').map(item => ({
            messageId: item.messageId,
            replyToId: item.replyToId,
          })),
          notFound: results.filter(item => item.status === 'not_found').map(item => ({
            messageId: item.messageId,
            replyToId: item.replyToId,
          })),
        });
        if (results.length === 0) return;
        const resultMap = new Map(results.map(item => [item.messageId, item]));
        const store = useChatStore.getState();
        const current = store.messages[threadKey] || [];
        let changed = false;
        const repairedMessages = current.map(message => {
          const result = resultMap.get(String(message.msg_id));
          if (!result) return message;
          if (result.status === 'topic_routing') {
            changed = true;
            return { ...message, reply_to_id: null };
          }
          if (result.status === 'repaired' && result.quoteData) {
            changed = true;
            return { ...message, quote_data: result.quoteData };
          }
          return message;
        });
        if (changed) store.setMessages(activeAccountId, activeThreadId, repairedMessages, activeTopicId);
      })
      .catch(error => {
        console.warn('[TelegramQuoteRepair] failed', {
          accountId: activeAccountId,
          threadId: activeThreadId,
          messageIds: batch.map(item => item.messageId),
          error: error?.message || String(error),
        });
      });
  }, [activeAccountId, activeThreadId, activeTopicId, activeContact?.channel, msgs, threadKey]);

  // Legacy normalizers stored unknown Telegram MessageMedia classes as an
  // empty text row. Re-fetch exact visible IDs, persist the real class/type,
  // and log safe identifiers so unsupported cases are diagnosable.
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    const candidates = msgs.filter(message => {
      // Tin lưu thành "chưa hỗ trợ" khi app còn dùng API layer cũ (tin định dạng phong phú, checklist…): lấy lại theo id
      if (message.msg_type === 'telegram.unsupported') return true;
      if (String(message.content || '').trim() || message.msg_type !== 'text') return false;
      try {
        const attachments = JSON.parse(message.attachments || '[]');
        return !Array.isArray(attachments) || attachments.length === 0;
      } catch {
        return true;
      }
    }).filter(message => {
      const key = `${activeAccountId}:${activeThreadId}:${message.msg_id}`;
      if (emptyMessageRepairAttemptedRef.current.has(key)) return false;
      emptyMessageRepairAttemptedRef.current.add(key);
      return /^\d+$/.test(String(message.msg_id));
    }).slice(0, 100);
    if (!candidates.length) return;

    const messageIds = candidates.map(message => String(message.msg_id));
    console.warn('[TelegramEmptyMessage] REPAIR_REQUESTED', {
      accountId: activeAccountId, threadId: activeThreadId, messageIds,
    });
    ipc.telegramUser?.repairEmptyMessages({ accountId: activeAccountId, chatId: activeThreadId, messageIds })
      .then(response => {
        if (!response?.success) throw new Error(response?.error || 'repair failed');
        const results = response.results || [];
        console.info('[TelegramEmptyMessage] REPAIR_COMPLETED', {
          accountId: activeAccountId, threadId: activeThreadId,
          results: results.map(result => ({
            messageId: result.messageId, resolved: result.resolved,
            msgType: result.msgType, mediaClass: result.mediaClass,
          })),
        });
        const byId = new Map(results.filter(result => result.resolved).map(result => [result.messageId, result]));
        if (!byId.size) return;
        const current = useChatStore.getState().messages[threadKey] || [];
        const repaired = current.map(message => {
          const result = byId.get(String(message.msg_id));
          return result ? {
            ...message, content: result.content, msg_type: result.msgType,
            attachments: JSON.stringify(result.attachments || []),
          } : message;
        });
        useChatStore.getState().setMessages(activeAccountId, activeThreadId, repaired, activeTopicId);
      })
      .catch(error => console.warn('[TelegramEmptyMessage] REPAIR_FAILED', {
        accountId: activeAccountId, threadId: activeThreadId, messageIds,
        error: error?.message || String(error),
      }));
  }, [activeAccountId, activeThreadId, activeTopicId, activeContact?.channel, msgs, threadKey]);

  // Telegram: lấy lại reaction chính thức (GetMessagesReactions) cho các tin có reaction của chính mình khi mở hội
  // thoại. Sửa dần dữ liệu bị cộng dồn sai trước đây — reaction của bài kênh trùng ID bị ghi nhầm sang tin ở hội thoại
  // khác (luôn kèm reaction của mình) — và đồng bộ reaction mình đổi trên thiết bị khác. Mỗi tin 1 lần / phiên.
  const refreshedTgReactionsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!threadReady || !activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    const refresh = ipc.telegramUser?.refreshReactions;
    if (!refresh) return;
    const messageIds: string[] = [];
    for (const message of msgs) {
      const key = `${activeAccountId}:${activeThreadId}:${message.msg_id}`;
      if (refreshedTgReactionsRef.current.has(key) || !reactionsIncludeUser(message.reactions, activeAccountId)) continue;
      refreshedTgReactionsRef.current.add(key);
      messageIds.push(String(message.msg_id));
      if (messageIds.length >= 100) break;
    }
    if (!messageIds.length) return;
    refresh({ accountId: activeAccountId, chatId: activeThreadId, messageIds }).catch(() => {});
  }, [threadReady, activeAccountId, activeThreadId, activeContact?.channel, msgs]);

  // Telegram nhóm / kênh: Telegram chỉ đẩy reaction cho TÁC GIẢ tin; reaction trên tin của người khác phải tự hỏi lại
  // (khuyến nghị của Telegram: poll messages.getMessagesReactions cho tin đang hiển thị mỗi 15-30 giây). Chỉ hội thoại
  // đang mở + cửa sổ đang hiện; main chỉ ghi DB / phát sự kiện khi reaction thực sự đổi. Chat riêng không cần: đổi
  // reaction tới qua UpdateEditMessage.
  const tgReactionPollMsgsRef = useRef(msgs);
  tgReactionPollMsgsRef.current = msgs;
  useEffect(() => {
    if (!threadReady || !activeAccountId || !activeThreadId || activeContact?.channel !== 'telegram_user') return;
    if (!activeThreadId.startsWith('-')) return;
    const refresh = ipc.telegramUser?.refreshReactions;
    if (!refresh) return;
    const poll = () => {
      if (document.hidden) return;
      const messageIds = tgReactionPollMsgsRef.current
        .filter(message => /^\d+$/.test(String(message.msg_id)) && message.is_recalled !== 1 && message.msg_type !== 'system')
        .slice(-TG_REACTION_POLL_BATCH)
        .map(message => String(message.msg_id));
      if (messageIds.length) refresh({ accountId: activeAccountId, chatId: activeThreadId, messageIds }).catch(() => {});
    };
    const first = window.setTimeout(poll, 1500);
    const timer = window.setInterval(poll, TG_REACTION_POLL_MS);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [threadReady, activeAccountId, activeThreadId, activeContact?.channel]);

  // OPTIMIZATION: Contact lookup O(1) với Map
  const contactMap = React.useMemo(() => {
    const map = new Map<string, any>();
    contactList.forEach(c => map.set(c.contact_id, c));
    return map;
  }, [contactList]);
  const getContact = (senderId: string) => contactMap.get(senderId);

  // Cache group members for current thread
  const groupMembers: any[] = threadGroupInfo?.members || EMPTY_MEMBERS;

  // OPTIMIZATION: Group member lookup O(1) với Map
  const groupMemberMap = React.useMemo(() => {
    const map = new Map<string, any>();
    groupMembers.forEach(m => map.set(String(m.userId), m));
    return map;
  }, [groupMembers]);
  const getGroupMember = (senderId: string) => groupMemberMap.get(String(senderId));

  /** Tin → nguồn cho lịch / ghi chú Quản lý công việc (tên người gửi như đang hiện trong khung chat). */
  const erpSourceOf = (m: any): ErpSourceMessage => {
    const mine = m.is_sent === 1 || m.is_sent === true || String(m.sender_id) === String(activeAccountId);
    let sender = 'Bạn';
    if (!mine) {
      const contact = getContact(m.sender_id);
      const member = getGroupMember(m.sender_id);
      const isGroupThread = activeContact?.contact_type === 'group';
      sender = contact?.alias || member?.displayName || contact?.display_name
        || (!isGroupThread ? (activeContact?.alias || activeContact?.display_name) : '') || 'Thành viên';
    }
    return { text: extractMsgText(m), sender, timestamp: Number(m.timestamp) || Date.now() };
  };

  // Check if current user is group owner or deputy - can recall any member's message
  const isGroupAdmin = React.useMemo(() => {
    if (!activeAccountId || !activeThreadId) return false;
    const cache = threadGroupInfo;
    if (!cache) return false;
    const me = cache.members?.find((m: any) => m.userId === activeAccountId);
    if (me && me.role >= 1) return true; // role 1=owner, 2=deputy
    if (cache.creatorId === activeAccountId) return true;
    if (cache.adminIds?.includes(activeAccountId)) return true;
    return false;
  }, [threadGroupInfo, activeAccountId, activeThreadId]);

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
      const isFbMedia = isFacebook(msg.channel) && isMediaType(msg.msg_type, msg.content, msg.attachments);
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

  // Mốc ngày 1 lần / ngày (như Telegram): tin HIỂN THỊ đầu tiên của mỗi ngày lịch. Trước đây mốc "13:38 Hôm nay" lặp
  // ở mỗi lần đổi người gửi / cách 30 phút trong khi giờ từng tin đã có trong bubble.
  const dayStartIds = React.useMemo(
    () => getDayStartIds(msgs, (id) => groupedSkipIds.has(id) || pollSkipIds.has(id) || groupedStickerSkipIds.has(id)),
    [msgs, groupedSkipIds, pollSkipIds, groupedStickerSkipIds],
  );
  const renderDaySeparator = (timestamp: number) => {
    const label = formatDaySeparator(timestamp);
    return (
      <div className="flex justify-center w-full my-2" data-day-label={label}>
        <span className="text-[11px] text-white bg-black/20 dark:bg-white/15 px-2.5 py-0.5 rounded-full">{label}</span>
      </div>
    );
  };

  // Tra tin theo msg_id (giữ phần tử ĐẦU như find/findIndex): hàng có trích dẫn / cuối album trước đây quét cả
  // danh sách ở mỗi lần render → O(n²) khi hội thoại dài
  const msgIndexById = React.useMemo(() => {
    const index = new Map<unknown, number>();
    msgs.forEach((m, i) => { if (!index.has(m.msg_id)) index.set(m.msg_id, i); });
    return index;
  }, [msgs]);
  const findMsgById = (id: unknown) => {
    const i = msgIndexById.get(id);
    return i === undefined ? undefined : msgs[i];
  };

  // Tên người gửi tin được trích dẫn. Zalo gửi sẵn `fromD`; quote Telegram cũ / tin tự gửi trả lời và Facebook thì không
  // → tra theo senderId (hoặc người gửi tin gốc trong trang): liên hệ → thành viên nhóm; tin của mình → tên tài khoản.
  const resolveQuoteAuthor = (q: any): string => {
    const stored = String(q?.fromD || '').trim();
    if (stored) return stored;
    const orig = q?.msgId ? findMsgById(String(q.msgId)) : undefined;
    const senderId = String(q?.senderId || q?.uidFrom || orig?.sender_id || '');
    if ((senderId && senderId === activeAccountId) || (!senderId && orig?.is_sent)) {
      return String(allAccounts.find((a) => a.zalo_id === activeAccountId)?.full_name || '');
    }
    if (!senderId) return '';
    const contact = getContact(senderId) as any;
    const contactName = String(contact?.alias || contact?.display_name || '');
    const name = (contactName && contactName !== senderId ? contactName : '') || String(getGroupMember(senderId)?.displayName || '');
    return name !== senderId ? name : '';
  };

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
      isZinstant: boolean;
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
      const isPoll = mt === 'group.poll' || mt === 'telegram.poll' || (mt === 'poll' && isTelegramCh(msg.channel));
      // Bot Telegram: GIF (animation, mp4) phát như video; `voice` là tin ghi âm
      const isVideo = isVideoType(mt) || mt === 'gif';
      const isVoice = isVoiceType(mt);
      const isGroupMedia = !isPoll && !isVoice && !!groupedFirstMsgs[msg.msg_id];
      // Bản tin / thông báo của Official Account (zinstant) — thẻ riêng, không đoán thành ảnh / file
      const isZinstant = isZinstantMsgType(mt, mc);
      const isMedia = !isCard && !isEcard && !isSticker && !isGroupMedia && !isRtf && !isPoll && !isVideo && !isVoice && !isZinstant && isMediaType(mt, mc, msg.attachments);
      const isFile = !isCard && !isEcard && !isSticker && !isMedia && !isRtf && !isPoll && !isVideo && !isVoice && !isZinstant && isFileType(mt, mc, msg.attachments);

      // Parse content 1 lần
      const content = (isMedia || isFile || isCard || isEcard || isSticker || isGroupMedia || isRtf || isPoll || isVideo || isVoice || isZinstant)
        ? ''
        : parseContent(mc, mt, msg.channel);

      cache.set(msg.msg_id, {
        isCard, isEcard, isSticker, isRtf, isPoll, isVideo, isVoice,
        isGroupMedia, isMedia, isFile, isZinstant, content
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
    setOlderKnown(false);
    setLoadError(false);
    // Lần tải tin cũ của hội thoại trước (nếu còn đang chạy) không được chặn / ghi đè hội thoại này
    loadSeqRef.current++;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setAtTop(false);
    initialScrollDoneRef.current = false;
    setInitialScrollDone(false);
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
    setInitialScrollDone(false);
    lastScrolledThreadRef.current = null;
    prevPinnedBarHeightRef.current = 0;
    nearBottomRef.current = true; // hội thoại mới mở ở đáy (giá trị cũ có thể là của hội thoại trước)
    // Reset selection mode when switching threads
    setIsSelecting(false);
    setSelectedMsgIds(new Set());
    // Thanh chọn reaction của hội thoại trước: tin đó bị gỡ khỏi DOM nên không có mouseleave → đóng + huỷ hẹn giờ
    // (kẻo bật lên trên lớp "Đang tải..." hoặc quay lại hội thoại cũ vẫn thấy thanh mở)
    closeReactionPicker();
    // Reset Facebook API cursor khi đổi thread (tạm thời vô hiệu hóa)
    fbCursorRef.current = null;
    fbHasMoreRef.current = false;
    fbProbeDoneRef.current = true;
	    setLoadingSpinner(true);
  }, [activeAccountId, activeThreadId]);

  // ─── Thread ready gate: set true khi messages đã có data trong store ────────
  useEffect(() => {
    if (!activeThreadId) {
      setMessagesReady(false);
      return;
    }
    // Require msgs.length > 0 OR loading finished (empty conversation)
    if (msgs.length > 0) {
      setMessagesReady(true);
    } else if (!messagesLoading) {
      // Empty conversation or loading finished with no messages
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

  // ─── Single scroll-to-bottom effect for initial thread load ────────────────
  // Consolidates: useLayoutEffect cached + useEffect settling + double-RAF
  // into one reliable mechanism using stable-height detection.
  useEffect(() => {
    if (!threadReady || !messagesReady || !activeThreadId || !threadKey) return;
    if (!msgs.length) return;
    if (lastScrolledThreadRef.current === threadKey) return;

    // Wait for at least 1 real message to avoid premature lock from realtime
    const realCount = msgs.filter(m => !String(m.msg_id).startsWith('temp_')).length;
    if (realCount < 1 && messagesLoading) return;

    let cancelled = false;

    // Stable-height detection: wait until scrollHeight stops changing
    // (meaning all messages have been rendered by React)
    const waitForStable = () => {
      const el = messagesContainerRef.current;
      if (!el || cancelled) return;
      const h1 = el.scrollHeight;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const h2 = messagesContainerRef.current?.scrollHeight || 0;
        if (h2 !== h1) {
          // Height still changing → wait another frame
          requestAnimationFrame(() => {
            if (cancelled) return;
            scrollToBottom('initial-stable');
            lockScroll();
          });
        } else {
          // Height stable → scroll now
          scrollToBottom('initial');
          lockScroll();
        }
      });
    };

    const lockScroll = () => {
      if (cancelled) return;
      initialScrollDoneRef.current = true;
      setInitialScrollDone(true);
      lastScrolledThreadRef.current = threadKey;
      setAtTop(false);
      setAtBottom(true);
      // Hide spinner after scroll has been painted
      requestAnimationFrame(() => {
        if (!cancelled) setLoadingSpinner(false);
      });
    };

    // Small delay to let React render the initial batch
    const timer = setTimeout(waitForStable, 16);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [threadReady, messagesReady, activeThreadId, threadKey, msgs.length, messagesLoading, scrollToBottom]);

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
        scrollToBottom('pinned-bar');
      } else {
        scroller.scrollTop += (currentHeight - prevHeight);
      }
    }
    prevPinnedBarHeightRef.current = currentHeight;
  }, [threadReady, activeThreadId, pins.length, pinnedNotes.length, scrollToBottom]);

  // (Scroll-to-bottom consolidated into single effect above)

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
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || !threadReady) return;
    // Kéo về đáy NGAY trong callback (chạy sau layout, trước khi vẽ) thay vì đợi frame sau → không thấy khung
    // bị đẩy rồi mới giật về. So khoảng cách tới đáy chứ không so scrollHeight: khi khung cuộn thấp đi (thanh
    // ghim / "Đã xem" / "đang nhập" hiện ra muộn, ô soạn tin cao lên) scrollHeight không đổi nhưng đáy bị che.
    const ro = new ResizeObserver(() => {
      if (!nearBottomRef.current) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    // Khung cuộn cao cố định nên chỉ observe khung thì không biết khi nội dung cao lên (ảnh / video tải xong
    // sau khi đã cuộn xuống đáy) → theo dõi cả phần nội dung để vẫn bám đáy.
    if (messagesContentRef.current) ro.observe(messagesContentRef.current);
    return () => ro.disconnect();
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
          remoteUrl = toZaloJpgUrl(params.hd || params.rawUrl || parsed.href || parsed.thumb || '');
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
    const CACHE_TTL = GROUP_INFO_CACHE_TTL_MS;
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
      // Telegram's GetParticipants(Recent) is only a partial page for large
      // groups. Never replace exact/history senders already present in the
      // cache with that page, otherwise their name/avatar regresses to UID.
      const current = useAppStore.getState().groupInfoCache?.[accountId]?.[groupId];
      const membersById = new Map<string, any>();
      for (const member of current?.members || []) {
        if (member?.userId != null) membersById.set(String(member.userId), member);
      }
      for (const m of members) {
        const userId = String(m.member_id || m.memberId || m.userId || '');
        if (!userId) continue;
        const previous = membersById.get(userId);
        membersById.set(userId, {
          ...previous,
          userId,
          displayName: m.display_name || m.displayName || previous?.displayName || '',
          avatar: m.avatar || previous?.avatar || '',
          role: m.role ?? previous?.role ?? 0,
          status: m.status || previous?.status || '',
          statusText: m.statusText || previous?.statusText || '',
          lastSeenAt: m.lastSeenAt ?? previous?.lastSeenAt,
          onlineUntil: m.onlineUntil ?? previous?.onlineUntil,
        });
      }
      const mergedMembers = Array.from(membersById.values());
      setGroupInfo(accountId, groupId, {
        groupId,
        name: name || current?.name || c?.display_name || groupId,
        avatar: avatar || current?.avatar || c?.avatar_url || '',
        memberCount: Math.max(Number(current?.memberCount || 0), mergedMembers.length),
        members: mergedMembers,
        creatorId: creatorId || current?.creatorId || '',
        adminIds: adminIds || current?.adminIds || [],
        settings: current?.settings,
        fetchedAt: Date.now(),
      });
    };

    // 1. Tải từ DB trước
    DataAccessor.getGroupMembers({ zaloId: accountId, groupId })
      .then(async (res: any) => {
        if (res?.members?.length) {
          // DB có members → dùng luôn
          buildAndSetGroupInfo(res.members);
          const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
          const needsTelegramHydration = isTelegramCh(acc?.channel)
            && res.members.some((member: any) =>
              !member?.avatar
              || !member?.display_name
              || String(member.display_name) === String(member.member_id)
            );
          if (needsTelegramHydration) {
            const adapter = getAdapter('telegram_user') as any;
            const memberRes = await adapter.getGroupMembers({ accountId, threadId: groupId, limit: GROUP_MEMBER_LIMIT });
            if (memberRes?.success) {
              const hydratedMembers = (memberRes.members || [])
                .map((member: any) => ({
                  memberId: String(member.id || member.userId || ''),
                  displayName: [member.firstName, member.lastName].filter(Boolean).join(' ')
                    || member.username || member.displayName || '',
                  avatar: member.avatar || '',
                  role: Number(member.role || 0),
                  status: member.status || '', statusText: member.statusText || '',
                  lastSeenAt: member.lastSeenAt, onlineUntil: member.onlineUntil,
                }))
                .filter((member: any) => member.memberId);
              if (hydratedMembers.length) {
                await DataAccessor.saveGroupMembers({ zaloId: accountId, groupId, members: hydratedMembers });
                buildAndSetGroupInfo(hydratedMembers);
              }
            }
          }
        } else {
          // DB không có members → fallback gọi API getGroupInfo
          try {
            const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
            if (!acc) return;

            if (isTelegramCh(acc.channel)) {
              const adapter = getAdapter('telegram_user') as any;
              const memberRes = await adapter.getGroupMembers({ accountId, threadId: groupId, limit: GROUP_MEMBER_LIMIT });
              if (!memberRes?.success) return;

              const rawMembers = (memberRes.members || [])
                .map((member: any) => {
                  const memberId = String(member.id || member.userId || '');
                  const displayName = [member.firstName, member.lastName].filter(Boolean).join(' ')
                    || member.username
                    || member.displayName
                    || '';
                  return {
                    memberId,
                    displayName,
                    avatar: member.avatar || '',
                    role: Number(member.role || 0),
                    status: member.status || '', statusText: member.statusText || '',
                    lastSeenAt: member.lastSeenAt, onlineUntil: member.onlineUntil,
                  };
                })
                .filter((member: any) => member.memberId);

              if (rawMembers.length) {
                DataAccessor.saveGroupMembers({ zaloId: accountId, groupId, members: rawMembers }).catch(() => {});
              }
              buildAndSetGroupInfo(rawMembers);
              return;
            }

            if (isNonZalo(acc.channel)) return;
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
              // Quy ước Zalo trong DB: 2 = trưởng nhóm, 1 = phó nhóm (shared/groupMemberRoles) — trước đây lưu ngược
              role: uid === creatorId ? 2 : adminList.includes(uid) ? 1 : 0,
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
    const threadContact = contactList.find(c => c.contact_id === activeThreadId);
    const isGroup = threadContact?.contact_type === 'group'
      || String(threadContact?.contact_type) === '1'
      || msgs.some(message => Number(message.thread_type) === 1);
    if (!isGroup) return;

    const unknownSenders = new Set<string>();
    for (const msg of msgs) {
      if (msg.is_sent === 1 || !msg.sender_id) continue;
      const senderId = String(msg.sender_id);
      const senderKey = `${activeAccountId}__${senderId}__${activeThreadId}`;

      const ct = getContact(senderId);
      if (ct?.display_name && ct.display_name !== senderId && !/^-?\d+$/.test(ct.display_name) && ct.avatar_url) {
        continue; // contacts already has both identity and avatar
      }
      const gm = getGroupMember(senderId);
      if (gm?.displayName && gm.displayName !== senderId && !/^-?\d+$/.test(gm.displayName) && gm.avatar) {
        continue; // group cache already has both identity and avatar
      }
      if (requestedMemberInfoRef.current.has(senderKey)) continue;

      unknownSenders.add(senderId);
    }

    if (unknownSenders.size === 0) return;

    // Telegram: batch fetch group members to resolve names
    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    if (acc && isTelegramCh(acc.channel)) {
      // Mark before awaiting. Updating groupInfoCache reruns this effect; doing
      // it afterwards used to launch many identical getGroupMembers requests.
      for (const senderId of unknownSenders) {
        requestedMemberInfoRef.current.add(`${activeAccountId}__${senderId}__${activeThreadId}`);
      }
      const senderMessageIds = msgs
        .filter(message => unknownSenders.has(String(message.sender_id)) && /^\d+$/.test(String(message.msg_id)))
        .map(message => String(message.msg_id));
      const senderIds = Array.from(unknownSenders);
      (async () => {
        const resolvedSenderIds = new Set<string>();
        const resolvedAvatarIds = new Set<string>();
        try {
          console.log('[TG_MEMBER_HYDRATE_REQUEST]', {
            accountId: activeAccountId, threadId: activeThreadId,
            senderIds, messageIds: senderMessageIds,
          });
          const res = await ipc.telegramUser?.hydrateMessageSenders({
            accountId: activeAccountId,
            chatId: activeThreadId,
            messageIds: senderMessageIds,
            senderIds,
          });
          console.log('[TG_MEMBER_HYDRATE_RESULT]', {
            accountId: activeAccountId, threadId: activeThreadId,
            requestedSenderIds: senderIds,
            resolvedSenderIds: (res?.members || []).map((member: any) => String(member.id || member.userId || '')),
            success: !!res?.success, error: res?.error || '',
          });
          if (res?.success && res.members) {
            let resolved = 0;
            const currentCache = useAppStore.getState().groupInfoCache?.[activeAccountId!]?.[activeThreadId!];
            const membersById = new Map((currentCache?.members || []).map(member => [String(member.userId), member]));
            for (const m of res.members) {
              const mId = String(m.id || '');
              const mName = [m.firstName, m.lastName].filter(Boolean).join(' ') || m.username || '';
              if (mId && mName) {
                resolvedSenderIds.add(mId);
                const previous = membersById.get(mId);
                if (m.avatar || previous?.avatar) resolvedAvatarIds.add(mId);
                membersById.set(mId, {
                  ...previous,
                  userId: mId, displayName: mName, avatar: m.avatar || previous?.avatar || '',
                  role: Number(m.role ?? previous?.role ?? 0), status: m.status || '',
                  statusText: m.statusText || '', lastSeenAt: m.lastSeenAt,
                  onlineUntil: m.onlineUntil,
                });
                resolved++;
              }
            }
            console.log(`[ChatWindow] Resolved ${resolved}/${res.members.length} Telegram sender names`);
            // Save to groupInfoCache so getGroupMember() works
            if (resolved > 0) {
              useAppStore.getState().setGroupInfo(activeAccountId!, activeThreadId!, {
                ...currentCache,
                name: currentCache?.name || activeContact?.display_name || '',
                avatar: currentCache?.avatar || activeContact?.avatar_url || '',
                members: Array.from(membersById.values()),
                fetchedAt: Date.now(),
                groupId: activeThreadId!,
                memberCount: currentCache?.memberCount || membersById.size,
              });
            }
            // Force re-render
            useChatStore.setState({ messagesLoading: false });
          }
        } catch (err: any) {
          console.error(`[ChatWindow] Telegram getGroupMembers error:`, err.message);
        } finally {
          for (const senderId of unknownSenders) {
            const retryKey = `${activeAccountId}__${senderId}__${activeThreadId}`;
            if (!resolvedSenderIds.has(senderId)) requestedMemberInfoRef.current.delete(retryKey);
            else setTimeout(() => requestedMemberInfoRef.current.delete(retryKey), resolvedAvatarIds.has(senderId) ? 5 * 60_000 : 60_000);
          }
        }
      })();
      return;
    }

    // Zalo: fetch individual user info
    for (const senderId of unknownSenders) {
      const senderKey = `${activeAccountId}__${senderId}__${activeThreadId}`;
      requestedMemberInfoRef.current.add(senderKey);

      // Fetch member info via IPC - tương tự fetchGroupMemberInfo trong useZaloEvents
      const load = async () => {
        try {
          const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
          if (!acc || isNonZalo(acc.channel)) return;
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
  }, [activeAccountId, activeThreadId, msgs, threadGroupInfo]);

  // Scroll event: track top/bottom position + nearBottomRef (dùng cho ResizeObserver)
  // Tối ưu: dùng rAF throttle + chỉ setState khi giá trị thay đổi để tránh re-render liên tục
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    let rafId = 0;
    let lastAtTop = false;
    let lastAtBottom = true;
    let lastScrollTop = el.scrollTop;
    const onScroll = () => {
      if (rafId) return; // throttle bằng rAF
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const { scrollTop, scrollHeight, clientHeight } = el;
        // Chỉ cuộn LÊN (người dùng / nhảy tới tin cũ) mới rời đáy. Nội dung cao lên cũng sinh scroll event (neo
        // cuộn) hoặc đẩy đáy ra xa mà scrollTop không giảm — nếu tính lại ở đây thì ResizeObserver thấy "không ở
        // đáy" và để hội thoại bị đẩy lên luôn.
        if (scrollHeight - scrollTop - clientHeight < 150) nearBottomRef.current = true;
        else if (scrollTop < lastScrollTop) nearBottomRef.current = false;
        lastScrollTop = scrollTop;
        const newAtTop = scrollTop < 60;
        const newAtBottom = scrollHeight - scrollTop - clientHeight < 60;
        if (newAtTop !== lastAtTop) { lastAtTop = newAtTop; setAtTop(newAtTop); }
        if (newAtBottom !== lastAtBottom) { lastAtBottom = newAtBottom; setAtBottom(newAtBottom); }
        maybeLoadOlder();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); if (rafId) cancelAnimationFrame(rafId); };
  }, [activeThreadId]);

  // ─── Tự tải tin cũ khi cuộn tới gần đỉnh ──────────────────────────────────
  // Theo vị trí cuộn (scroll event, sau lần cuộn xuống đáy đầu tiên, sau mỗi trang) thay vì
  // IntersectionObserver trên hàng đầu tiên: tin hệ thống / tin thu hồi render nhánh riêng không gắn ref nên
  // không bao giờ tự tải; observer cũng chỉ báo khi trạng thái giao nhau ĐỔI → đang ở vùng đỉnh thì không
  // tải tiếp.
  const loadMoreFnRef = useRef<() => void>(() => {});
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  useEffect(() => { loadMoreFnRef.current = handleLoadMore; });
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
  const maybeLoadOlder = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el || !initialScrollDoneRef.current || !hasMoreRef.current || loadingMoreRef.current) return;
    if (Date.now() < suppressLoadOlderUntilRef.current) return;
    if (el.scrollTop <= LOAD_OLDER_PREFETCH_PX) loadMoreFnRef.current();
  }, []);
  // Hội thoại ngắn (chưa cuộn được) hoặc đáy vẫn nằm trong vùng tải trước ngay sau khi mở
  useEffect(() => {
    if (!initialScrollDone) return;
    const raf = requestAnimationFrame(maybeLoadOlder);
    return () => cancelAnimationFrame(raf);
  }, [initialScrollDone, activeThreadId, maybeLoadOlder]);

  // ─── Scroll to bottom khi AI suggestions bar xuất hiện/biến mất ──────────
  useEffect(() => {
    const handler = () => {
      if (nearBottomRef.current) scrollToBottom('ai-suggestions');
    };
    window.addEventListener('ai:suggestionsBarChanged', handler);
    return () => window.removeEventListener('ai:suggestionsBarChanged', handler);
  }, [scrollToBottom]);

  // Scroll to bottom khi LibraryPickerModal gửi xong
  useEffect(() => {
    const handler = () => scrollToBottom('library-sent');
    window.addEventListener('chat:scrollToBottom', handler);
    return () => window.removeEventListener('chat:scrollToBottom', handler);
  }, [scrollToBottom]);

  // Scroll to bottom chỉ khi có tin nhắn MỚI (tin cuối thay đổi), không scroll khi prepend tin cũ
  // Initial load scroll được xử lý bởi consolidated scroll effect
  useEffect(() => {
    if (!msgs.length) return;
    const lastMsg = msgs[msgs.length - 1];
    const lastMsgId = lastMsg.msg_id;
    if (lastMsgId !== prevLastMsgIdRef.current) {
      prevLastMsgIdRef.current = lastMsgId;
      if (!shouldRestoreScrollRef.current) {
        const isInitial = isInitialThreadLoadRef.current;
        isInitialThreadLoadRef.current = false;
        if (isInitial) {
          // Cuộn lần đầu do effect gộp phía trên lo; còn tin cũ hay không thì lần tải trang (maybeLoadOlder)
          // xác định — dò bằng 1 truy vấn riêng ở đây vô dụng vì DB trả cả tin cùng mốc (timestamp <= before).
          return;
        }
        // Realtime messages
        const isOutgoing =
          lastMsg?.is_sent === 1 ||
          (activeAccountId ? String(lastMsg?.sender_id || '') === String(activeAccountId) : false) ||
          String(lastMsg?.msg_id || '').startsWith('temp_');
        if (isOutgoing || nearBottomRef.current) {
          scrollToBottom('realtime');
        }
      }
    }
  }, [msgs, activeAccountId, activeContact?.channel, scrollToBottom]);

  // Sau khi prepend tin cũ: khôi phục vị trí scroll để không bị nhảy lên đầu
  // useLayoutEffect chạy ĐỒNG BỘ sau DOM update nhưng TRƯỚC khi paint → không bao giờ nhảy
  useLayoutEffect(() => {
    if (!shouldRestoreScrollRef.current || !messagesContainerRef.current) return;
    shouldRestoreScrollRef.current = false;
    const el = messagesContainerRef.current;
    const savedHeight = savedScrollHeightRef.current;
    if (savedHeight > 0) {
      const delta = el.scrollHeight - savedHeight;
      if (delta > 0) {
        // Vị trí lúc chèn + phần mới phía trên: đúng cả khi đang cách đỉnh (tải trước) và khi trình duyệt
        // đã tự neo cuộn ([overflow-anchor:auto]) — đặt `delta` tuyệt đối sẽ nhảy về gần đỉnh.
        const target = savedScrollTopRef.current + delta;
        // Neo cuộn thường đã đặt đúng chỗ: gán lại scrollTop lúc người dùng đang cuộn (chuột / touchpad) sẽ
        // cắt quán tính cuộn → cảm giác giật mỗi lần sang trang. Chỉ sửa khi thực sự lệch.
        if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      }
    }
  }, [msgs.length]);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    if (isNonZalo(acc.channel)) return buildZaloAuth(acc, activeAccountId);
    return buildZaloAuth(acc, activeAccountId);
  };

  // Chụp vị trí cuộn NGAY trước khi chèn tin cũ lên đầu — không chụp trước lúc query DB: trong lúc chờ,
  // người dùng vẫn cuộn / có tin mới nên vị trí khôi phục sẽ sai.
  const snapshotScrollForPrepend = () => {
    const el = messagesContainerRef.current;
    savedScrollHeightRef.current = el?.scrollHeight || 0;
    savedScrollTopRef.current = el?.scrollTop || 0;
    shouldRestoreScrollRef.current = true;
  };

  // Một trang tin cũ hơn `before` từ DB (chủ: IPC, nhân viên: REST), mới → cũ. DB trả `timestamp <= before`
  // nên các tin cùng mốc đã hiển thị quay lại — xin thêm đúng số đó + 1 dòng: dòng dư cho biết còn tin cũ hơn,
  // khỏi truy vấn dò lần nữa.
  const fetchOlderPage = async (accountId: string, threadId: string, topicId: string | null, before: number, loaded: any[]) => {
    const loadedIds = new Set(loaded.map(m => String(m.msg_id)));
    const sameTs = loaded.filter(m => m.timestamp === before).length;
    const res: any = await DataAccessor.getMessages({
      zaloId: accountId,
      threadId,
      limit: MESSAGE_LOAD_MORE_LIMIT + sameTs + 1,
      before,
      topicId: topicId || undefined,
    });
    // Lỗi đọc (employee: mất kết nối BOSS) ≠ "hết tin cũ": để handleLoadMore hiện "Lỗi - Thử lại", giữ hasMore
    if (isReadFailure(res)) throw new Error(readFailureMessage(res));
    const rows: any[] = res?.messages || res?.items || [];
    const fresh = rows.filter(m => !loadedIds.has(String(m.msg_id)));
    return { page: fresh.slice(0, MESSAGE_LOAD_MORE_LIMIT), more: fresh.length > MESSAGE_LOAD_MORE_LIMIT };
  };

  // reply_to_id → quote_data từ chính trang vừa tải (Facebook…); tin gốc nằm ngoài trang thì bổ sung sau
  const mapReplyQuotes = (rows: any[]) => {
    const lookup = new Map<string, { content: string; type: string }>();
    for (const m of rows) lookup.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
    const missing: Array<{ msgId: string; replyToId: string }> = [];
    const mapped = rows.map((m: any) => {
      if (m.channel === 'telegram_user' || !m.reply_to_id || m.quote_data) return m;
      const orig = lookup.get(m.reply_to_id);
      if (orig) {
        return { ...m, quote_data: JSON.stringify({ msgId: m.reply_to_id, msg: orig.content || '', senderId: '', msgType: orig.type || 'text' }) };
      }
      missing.push({ msgId: m.msg_id, replyToId: m.reply_to_id });
      return m;
    });
    return { mapped, missing };
  };

  // Tin gốc của trích dẫn nằm ngoài trang: 1 truy vấn gộp + 1 lần cập nhật store. Trước đây mỗi tin 1 truy vấn
  // + 1 lần setMessages → cả danh sách re-render nhiều lần ngay sau mỗi trang.
  const fixupMissingQuotes = async (
    accountId: string,
    threadId: string,
    topicId: string | null,
    missing: Array<{ msgId: string; replyToId: string }>,
  ) => {
    try {
      const replyIds = [...new Set(missing.map(item => item.replyToId))];
      const found = new Map<string, any>();
      const batch: any = await DataAccessor.getMessagesByIds({ zaloId: accountId, msgIds: replyIds });
      for (const m of batch?.messages || []) found.set(String(m.msg_id), m);
      // getMessagesByIds chỉ khớp msg_id; getMessageById còn khớp cli_msg_id (trích dẫn Zalo có msgId "0")
      for (const id of replyIds) {
        if (found.has(id)) continue;
        const one: any = await DataAccessor.getMessageById({ zaloId: accountId, threadId, msgId: id });
        if (one?.message) found.set(id, one.message);
      }
      const store = useChatStore.getState();
      const list = store.messages[getMessageCacheKey(accountId, threadId, topicId)];
      if (!list) return;
      const replyOf = new Map(missing.map(item => [item.msgId, item.replyToId]));
      let changed = false;
      const updated = list.map((m: any) => {
        const replyToId = replyOf.get(m.msg_id);
        if (!replyToId || m.quote_data) return m;
        const orig = found.get(replyToId);
        if (!orig?.msg_type && !orig?.content) return m;
        changed = true;
        return {
          ...m,
          quote_data: JSON.stringify({ msgId: replyToId, msg: orig.content || '', senderId: '', msgType: orig.msg_type || 'text' }),
        };
      });
      if (changed) store.setMessages(accountId, threadId, updated, topicId);
    } catch {}
  };

  // Tải thêm tin nhắn cũ dùng timestamp cursor (tránh lỗi offset khi có tin real-time)
  const handleLoadMore = async () => {
    // Double-guard: check refs to prevent race conditions
    if (!activeAccountId || !activeThreadId || loadingMoreRef.current || !hasMoreRef.current) return;
    const accountId = activeAccountId;
    const threadId = activeThreadId;
    const topicId = activeTopicId;
    // Re-read msgs from store to get the freshest oldest message (MIN timestamp, mảng có thể chưa sắp xếp)
    const loaded = (useChatStore.getState().messages[getMessageCacheKey(accountId, threadId, topicId)] || [])
      .filter(m => !m.msg_id.startsWith('temp_'));
    // Store chưa có tin (lần tải đầu đang chạy) → để lần tải đầu xử lý, không kết luận là hết tin
    if (loaded.length === 0) return;
    let oldest: any = null;
    for (const m of loaded) {
      if ((m.timestamp || 0) > 0 && (!oldest || m.timestamp < oldest.timestamp)) oldest = m;
    }
    if (!oldest) {
      // Không có timestamp hợp lệ → không có mốc để tải tiếp
      hasMoreRef.current = false;
      setHasMore(false);
      return;
    }
    const before: number = oldest.timestamp;

    const seq = ++loadSeqRef.current;
    loadingMoreRef.current = true;
    if (loadError) setLoadError(false);
    // Spinner chỉ hiện khi tải lâu: trang từ DB thường xong trong vài chục ms; bật state ngay thì cả danh sách
    // re-render thêm một lần mỗi trang (giật khi đang cuộn).
    const spinnerTimer = setTimeout(() => {
      if (loadSeqRef.current === seq) setLoadingMore(true);
    }, 250);
    // Safety: reset loadingMore if it's been stuck for > 10 seconds
    const safetyTimer = setTimeout(() => {
      if (loadSeqRef.current === seq && loadingMoreRef.current) {
        console.warn('[LOADMORE] Safety reset: loadingMore stuck for >10s');
        loadSeqRef.current++;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }, LOAD_MORE_TIMEOUT_MS);

    try {
      // `confirmed`: DB trả dư dòng → chắc chắn còn tin cũ (mới hiện nút). `maybe`: có thể còn (tiếp tục tự tải).
      let { page, more: confirmed } = await fetchOlderPage(accountId, threadId, topicId, before, loaded);
      let maybe = confirmed;

      if (getActiveAccount()?.channel === 'telegram_user') {
        if (page.length === 0) {
          // DB đã hết → xin Telegram lịch sử cũ hơn (được lưu vào DB) rồi đọc lại DB
          const tgRes: any = await ipc.telegramUser?.getMessages({
            accountId,
            chatId: threadId,
            offsetId: Number(oldest.msg_id),
            limit: MESSAGE_LOAD_LIMIT,
            topicRootMessageId: topicId || undefined,
          });
          // Lỗi (mất kết nối, FLOOD_WAIT…) → "Lỗi - Thử lại", giữ hasMore để còn thử lại
          if (!tgRes?.success) throw new Error(tgRes?.error || 'Telegram getMessages failed');
          const fetched = tgRes.messages?.length || 0;
          if (fetched > 0) ({ page, more: confirmed } = await fetchOlderPage(accountId, threadId, topicId, before, loaded));
          // Telegram trả đủ trang → có thể còn; trả thiếu / rỗng → đã tới đầu lịch sử
          maybe = confirmed || fetched >= MESSAGE_LOAD_LIMIT;
        } else {
          // DB còn ít hơn một trang không có nghĩa Telegram đã hết tin — lần sau hỏi server
          maybe = true;
        }
      } else if (isFacebook(getActiveAccount()?.channel)) {
        if (page.length === 0) {
          // DB đã hết → một trang tin cũ hơn qua bridge (LightSpeed FetchMessagesTask, lưu DB) rồi đọc lại DB
          const fbRes: any = await ipc.fb?.fetchOlderMessages({
            accountId,
            threadId,
            beforeTimestampMs: before,
            beforeMessageId: String(oldest.msg_id || ''),
          });
          if (fbRes?.success) {
            if ((fbRes.stored || 0) > 0) ({ page, more: confirmed } = await fetchOlderPage(accountId, threadId, topicId, before, loaded));
            maybe = confirmed || !!fbRes.hasMoreBefore;
          } else if (['E2EE', 'BRIDGE_OLD', 'BRIDGE_DOWN', 'NOT_CONNECTED', 'BUSY', 'COOLDOWN', 'RISK', 'CANCELLED'].includes(fbRes?.code)) {
            // Mã hoá đầu cuối / bridge cũ / bridge đang kết nối lại / đang tải nhiều (nhịp người dùng thật) / Facebook có
            // dấu hiệu hạn chế: dừng, không báo lỗi mỗi lần mở hội thoại (mở / cuộn lại sau sẽ thử lại)
            if (fbRes?.code === 'RISK') useAppStore.getState().showNotification(fbRes.error || 'Facebook có dấu hiệu hạn chế — tạm dừng tải tin cũ', 'warning');
            maybe = false;
          } else {
            // Facebook chậm trả lời → "Lỗi - Thử lại", giữ hasMore
            throw new Error(fbRes?.error || 'Facebook fetchOlderMessages failed');
          }
        } else {
          // DB còn ít hơn một trang không có nghĩa Facebook đã hết tin — lần sau hỏi server
          maybe = true;
        }
      }
      if (loadSeqRef.current !== seq) return; // đã đổi hội thoại / lần tải này đã bị bỏ

      const { mapped, missing } = mapReplyQuotes(page);
      const nextHasMore = mapped.length > 0 && maybe;
      // Một lần render cho cả trang mới lẫn trạng thái (trước đây 2–3 lần re-render toàn bộ danh sách / trang)
      flushSync(() => {
        if (mapped.length > 0) {
          snapshotScrollForPrepend();
          prependMessages(accountId, threadId, [...mapped].reverse(), topicId);
        }
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        setOlderKnown(mapped.length > 0 && confirmed);
        setLoadingMore(false);
      });
      // Trùng hết (store đã có) → không có render nào dùng mốc chụp: bỏ, kẻo lần đổi số tin sau khôi phục sai
      shouldRestoreScrollRef.current = false;
      if (mapped.length > 0) {
        if (missing.length > 0) void fixupMissingQuotes(accountId, threadId, topicId, missing);
        // Trang vừa tải chưa đẩy đỉnh ra khỏi vùng tải trước (trang ngắn / không cuộn) → tải tiếp
        requestAnimationFrame(maybeLoadOlder);
      }
    } catch {
      if (loadSeqRef.current === seq) {
        setLoadError(true);
        // Không tự thử lại ở mỗi lần cuộn (Telegram FLOOD_WAIT…) — nút "Thử lại" vẫn bấm được ngay
        suppressLoadOlderUntilRef.current = Date.now() + 15_000;
      }
    } finally {
      clearTimeout(spinnerTimer);
      clearTimeout(safetyTimer);
      if (loadSeqRef.current === seq) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
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
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      if (isNonZalo(ch)) {
        await channelIpc.unsendMessage(ch, {
          accountId: activeAccountId || '',
          messageId: msg.msg_id,
          threadId: msg.thread_id,
        });
      } else if (isZalo(ch)) {
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
      const undoRes: any = await ipc.zalo?.undoMessage({ auth, message: messagePayload });
      // IPC trả { success: false } (không ném) khi Zalo / Boss từ chối — không được đánh dấu "đã thu hồi" giả
      if (undoRes?.success === false) throw new Error(undoRes.error || 'Zalo từ chối');
      }
      // Đánh dấu thu hồi thay vì xóa - hiển thị "Tin nhắn đã thu hồi"
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id, threadId: msg.thread_id }).catch(() => {});
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
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;
      if (isNonZalo(ch)) {
        await (channelIpc as any).unsendMessage(ch, { accountId: activeAccountId || '', messageId: msg.msg_id, threadId: msg.thread_id });
      } else {
      const messagePayload = JSON.stringify({
        data: { msgId: msg.msg_id, cliMsgId: msg.cli_msg_id || msg.msg_id, uidFrom: msg.sender_id },
        threadId: msg.thread_id,
        type: msg.thread_type,
      });
      const deleteRes: any = await ipc.zalo?.deleteMessage({ auth, message: messagePayload, onlyMe: true });
      if (deleteRes?.success === false) throw new Error(deleteRes.error || 'Zalo từ chối');
      }
      // Đánh dấu đã xoá trong DB (recalled) thay vì xoá hẳn - nhất quán với thu hồi
      if (activeAccountId) {
        useChatStore.getState().recallMessage(activeAccountId, msg.msg_id, msg.thread_id);
        DataAccessor.markMessageRecalled?.({ zaloId: activeAccountId, msgId: msg.msg_id, threadId: msg.thread_id }).catch(() => {});
      }
      showNotification('Đã xóa tin nhắn', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleDeleteFromDb = async (msg: any) => {
    if (!activeAccountId) return;
    try {
      await DataAccessor.deleteMessages({ zaloId: activeAccountId, msgIds: [msg.msg_id], threadId: msg.thread_id });
      removeMessage(activeAccountId, msg.thread_id, msg.msg_id);
      showNotification('Đã xóa vĩnh viễn tin nhắn khỏi app', 'success');
    } catch (e: any) {
      showNotification('Xóa thất bại: ' + e.message, 'error');
    }
  };

  const handleReact = async (msg: any, emoji: string) => {
    try {
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      // Optimistic update: show reaction immediately in UI
      const accId = activeAccountId || '';
      // Telegram: SendReaction THAY reaction của mình (mỗi người 1) và số đếm là tổng hợp do Telegram trả — main
      // process lưu số chính thức từ kết quả gửi. Không cộng dồn vào DB kiểu Zalo (trước đây cộng nhầm vào tin
      // trùng ID ở hội thoại khác → "1 đống icon").
      const isTelegramUserMsg = ch === 'telegram_user';
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, emoji, isTelegramUserMsg ? 'set' : 'accumulate');

      if (!isTelegramUserMsg) {
        // Persist reaction to DB immediately (so it survives conversation switch); echo Zalo của lần bấm này bỏ qua
        markLocalReaction(accId, msg.msg_id, emoji);
        DataAccessor.updateReaction?.({ zaloId: accId, msgId: msg.msg_id, threadId: msg.thread_id, userId: accId, emoji }).catch(() => {});
      }

      if (isNonZalo(ch)) {
        await channelIpc.addReaction(ch, {
          accountId: accId,
          messageId: msg.msg_id,
          emoji,
          threadId: msg.thread_id,
          action: 'add',
        });
      } else if (isZalo(ch)) {
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
      const contact = contactList.find(c => c.contact_id === msg.thread_id);
      const ch = msg.channel || contact?.channel || CHANNEL.ZALO;

      // Optimistic update: remove reaction immediately in UI
      const accId = activeAccountId || '';
      useChatStore.getState().updateMessageReaction(accId, msg.thread_id, msg.msg_id, accId, '');
      // Lưu luôn việc gỡ (trước đây không lưu → mở lại hội thoại reaction hiện lại). Gỡ lặp lại với echo Zalo vô hại.
      // Telegram: main process lưu số chính thức từ kết quả gửi.
      if (ch !== 'telegram_user') {
        DataAccessor.updateReaction?.({ zaloId: accId, msgId: msg.msg_id, threadId: msg.thread_id, userId: accId, emoji: '' }).catch(() => {});
      }

      if (isNonZalo(ch)) {
        await channelIpc.addReaction(ch, {
          accountId: accId,
          messageId: msg.msg_id,
          emoji: '',
          threadId: msg.thread_id,
          action: 'remove',
        });
      } else if (isZalo(ch)) {
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

  // Album ảnh (nhiều tin ảnh cùng groupLayoutId, hiển thị 1 bubble) → chuyển tiếp cả album, không chỉ ảnh đầu
  const handleForward = (msg: any) => {
    setForwardMsgs(groupedFirstMsgs[msg.msg_id] || [msg]);
  };

  /**
   * Gửi các tin tới từng người nhận (chuyển tiếp / Lưu vào My Documents): album gộp 1 lần, còn lại từng tin;
   * nội dung soạn kèm (nếu có) là 1 tin mới sau cùng. Chạy nền, không block UI.
   */
  const runForward = (
    messages: any[],
    targets: Array<{ threadId: string; threadType: number; accountId: string }>,
    composeText: string,
    labels: { progress: (done: number, total: number) => string; done: string } = {
      progress: (done, total) => `Đang chuyển tiếp ${done}/${total}...`,
      done: 'Đã chuyển tiếp xong',
    },
  ) => {
    const units = groupForwardAlbums(messages, groupedFirstMsgs);
    // Chạy lần lượt ở background, không block UI
    (async () => {
      const total = messages.length * targets.length;
      let counter = 0;
      let failCount = 0;
      let firstFailure = '';
      const companionText = composeText.trim();
      for (const target of targets) {
        let forwardedAny = false;
        // Get auth + channel from target account once per recipient.
        const targetAccount = allAccounts.find(a => a.zalo_id === target.accountId);
        if (!targetAccount) {
          failCount += messages.length;
          firstFailure ||= 'Không tìm thấy tài khoản gửi';
          continue;
        }
        const targetChannel = targetAccount.channel || CHANNEL.ZALO;
        const targetAuth = isNonZalo(targetChannel)
          ? { cookies: '', imei: '', userAgent: '' }
          : buildZaloAuth(targetAccount);

        for (const unit of units) {
          // Album toàn ảnh (tải về nếu chưa có) → gửi gộp 1 lần để người nhận cũng thấy album.
          const albumPaths = await prepareForwardAlbum(unit, targetChannel);
          if (albumPaths) {
            let albumDone = true;
            try {
              await sendForwardAlbum(
                targetAuth,
                unit,
                albumPaths,
                { threadId: target.threadId, threadType: target.threadType },
                targetChannel,
                target.accountId,
              );
              forwardedAny = true;
            } catch (e: any) {
              if (FORWARD_ALBUM_PRECHECK_ERROR_RE.test(e?.message || '')) {
                // Lỗi kiểm tra file trước khi upload → chưa gửi gì → gửi từng ảnh bên dưới
                albumDone = false;
                console.warn(`[Forward] Album first=${unit[0].msg_id} → gửi từng ảnh:`, e.message);
              } else {
                // Lỗi lúc gửi: không gửi lại từng ảnh (có thể đã gửi một phần → trùng)
                failCount += unit.length;
                firstFailure ||= e?.message || 'Không rõ lỗi';
                console.warn(`[Forward] Failed album first=${unit[0].msg_id} (${unit.length} ảnh) target=${target.threadId}:`, e.message);
              }
            }
            if (albumDone) {
              counter += unit.length;
              if (total > 1) {
                showNotification(labels.progress(counter, total), 'info');
              }
              continue;
            }
          }

          for (const msg of unit) {
            counter++;
            try {
              await sendOneForward(
                targetAuth,
                msg,
                { threadId: target.threadId, threadType: target.threadType },
                targetChannel,
                target.accountId,
                activeAccountId || undefined,
              );
              forwardedAny = true;
            } catch (e: any) {
              failCount++;
              firstFailure ||= e?.message || 'Không rõ lỗi';
              console.warn(`[Forward] Failed msg=${msg.msg_id} target=${target.threadId}:`, e.message);
            }
            if (total > 1) {
              showNotification(labels.progress(counter, total), 'info');
            }
          }
        }

        // Nội dung người dùng soạn trong popup luôn là một tin mới, sau
        // toàn bộ các tin được forward tới người nhận này. Nó không được
        // phép thay thế text/caption của tin nguồn.
        if (forwardedAny && companionText) {
          try {
            await sendForwardText(targetAuth, targetChannel, target.accountId, {
              threadId: target.threadId,
              threadType: target.threadType,
            }, companionText);
          } catch (e: any) {
            failCount++;
            firstFailure ||= e?.message || 'Không rõ lỗi';
            console.warn(`[Forward] Failed companion target=${target.threadId}:`, e.message);
          }
        }
      }
      if (failCount === 0) {
        showNotification(labels.done, 'success');
      } else {
        showNotification(`${labels.done} (${failCount} lỗi): ${firstFailure}`, 'error');
      }
    })();
  };

  // Zalo: "Lưu vào My Documents" = gửi bản sao tin vào hội thoại My Documents CÓ SẴN của Zalo (ID = send2me_id của
  // phiên đăng nhập — không phải hội thoại với UID của chính mình)
  const handleSaveToMyDocuments = async (target: any) => {
    if (!activeAccountId || !target) return;
    const myDocsId = myDocumentsThreadId(allAccounts.find(a => a.zalo_id === activeAccountId));
    if (!myDocsId) {
      showNotification('Chưa xác định được hội thoại My Documents của tài khoản này — hãy kết nối lại tài khoản Zalo rồi thử lại', 'error');
      return;
    }
    // Ảnh trong album được bấm chuột phải → chỉ ảnh đó; còn lại cả album / tin
    const messages = contextMenu?.mediaMsg ? [target] : (groupedFirstMsgs[target.msg_id] || [target]);
    runForward(messages, [{ accountId: activeAccountId, threadId: myDocsId, threadType: 0 }], '', {
      progress: (done, total) => `Đang lưu vào My Documents ${done}/${total}...`,
      done: 'Đã lưu vào My Documents',
    });
  };

  // ─── Tin đánh dấu (như Zalo) ──────────────────────────────────────────────
  useEffect(() => {
    if (activeAccountId) void useStarredStore.getState().load(activeAccountId);
  }, [activeAccountId]);

  const contextStarTarget = contextMenu ? (contextMenu.mediaMsg || contextMenu.msg) : null;
  const contextTargetStarred = useStarredStore(s => !!(
    contextStarTarget && activeAccountId && activeThreadId
    && s.keys[activeAccountId]?.has(starKey(activeThreadId, String(contextStarTarget.msg_id)))
  ));

  /** Tên + ảnh người gửi như hàng tin nhắn đang hiển thị (lưu kèm đánh dấu). */
  const resolveStarSender = (m: any): { name: string; avatar: string } => {
    // Tin của chính tài khoản → tên + ảnh của tài khoản, kể cả khi thiếu is_sent (sender = tài khoản / Facebook id).
    // Không lấy contact "chính mình": Zalo có 1 dòng contact cho chính tài khoản, ảnh có thể là URL cũ đã hỏng.
    const account = allAccounts.find(a => a.zalo_id === activeAccountId);
    const senderId = String(m?.sender_id || '');
    if (Number(m?.is_sent) === 1 || (!!senderId && (senderId === activeAccountId || senderId === String(account?.facebook_id || '')))) {
      return { name: account?.full_name || account?.display_name || 'Bạn', avatar: account?.avatar_url || '' };
    }
    const contact = getContact(m?.sender_id);
    const member = getGroupMember(m?.sender_id);
    const contactName = contact?.alias || contact?.display_name || '';
    const name = (contactName && contactName !== m?.sender_id ? contactName : '') || member?.displayName || contactName || String(m?.sender_id || '');
    return { name, avatar: contact?.avatar_url || member?.avatar || '' };
  };

  const handleToggleStar = async (target: any) => {
    if (!activeAccountId || !activeThreadId || !target?.msg_id) return;
    const store = useStarredStore.getState();
    const msgId = String(target.msg_id);
    const starred = !store.isStarred(activeAccountId, activeThreadId, msgId);
    const sender = resolveStarSender(target);
    const ok = await store.setStarred({
      zaloId: activeAccountId,
      threadId: activeThreadId,
      msgId,
      starred,
      snapshot: starred ? buildStarredSnapshot(target, {
        senderName: sender.name,
        senderAvatar: sender.avatar,
        threadName: activeContact?.alias || activeContact?.display_name || '',
        threadAvatar: activeContact?.avatar_url || '',
        channel: activeContact?.channel || CHANNEL.ZALO,
      }) : undefined,
    });
    if (ok) showNotification(starred ? 'Đã đánh dấu tin nhắn - xem ở menu ⋮ → Tin đánh dấu' : 'Đã bỏ đánh dấu tin nhắn', 'success');
    else showNotification('Không lưu được đánh dấu tin nhắn', 'error');
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
      const contactName = contact?.alias || contact?.display_name || '';
      senderName = (contactName && contactName !== msg.sender_id ? contactName : '')
        || groupMember?.displayName
        || contactName
        || 'Người dùng';
    }
    const pin = buildPinFromMsg(msg, senderName);

    const ch = msg.channel || activeContact?.channel || CHANNEL.ZALO;
    // The three-message limit is a Zalo server constraint. Telegram's API
    // supports multiple pinned messages in a chat, so never downgrade a
    // Telegram pin to local-only based on the Zalo rule.
    const alreadyPinned = pins.some(p => p.msg_id === msg.msg_id);
    const overLimit = isZalo(ch) && !alreadyPinned && pins.length >= 3;

    try {
      // Server-side pin for Telegram
      if (ch === 'telegram_user') {
        const res = await ipc.telegramUser?.pinMessage({ accountId: activeAccountId, chatId: activeThreadId, messageId: String(msg.msg_id) });
        if (!res?.success) {
          showNotification('Ghim trên Telegram thất bại: ' + (res?.error || 'Unknown'), 'error');
          return;
        }
      }

      const pinRes: any = await ipc.db?.pinMessage({ zaloId: activeAccountId, threadId: activeThreadId, pin });
      // Nhân viên: ghim chờ Boss xác nhận — Boss từ chối / mất kết nối thì báo lỗi (trước đây luôn "Đã ghim")
      if (pinRes?.success === false) {
        showNotification('Ghim thất bại: ' + (pinRes.error || 'lỗi không xác định'), 'error');
        return;
      }
      // Reload pins
      // Đọc qua DataAccessor: chế độ nhân viên lấy từ Boss (IPC trả stub rỗng → danh sách ghim bị xoá trắng sau khi ghim)
      const res = await DataAccessor.getPinnedMessages({ zaloId: activeAccountId, threadId: activeThreadId });
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

  // ID (msg_id + cli_msg_id) của mọi tin một hàng hiển thị → data-msg-ids. Album ảnh / nhóm sticker chỉ có
  // tin đầu mang id="msg-…"; quote có thể chỉ biết cliMsgId.
  const getRowMsgIds = (msg: any): string =>
    (groupedFirstMsgs[msg.msg_id] || groupedStickerFirstMsgs[msg.msg_id] || [msg])
      .flatMap((m: any) => [m.msg_id, m.cli_msg_id])
      .filter((id: any) => id && String(id) !== '0')
      .join(' ');

  // Cuộn đến tin nhắn gốc khi click vào quote / pinned / search result
  // Nếu tin nhắn không có trong DOM (nằm ở trang cũ), load messages xung quanh nó
  // altMsgId: cliMsgId của quote — Zalo để msgId (globalMsgId) = "0" khi trích dẫn tin chưa có ID chính thức
  // (hay gặp với ảnh trong album), lúc đó chỉ tìm được theo cliMsgId.
  const handleScrollToMsg = async (msgId: string, altMsgId?: string) => {
    const ids = [msgId, altMsgId].map(id => String(id || '')).filter(id => id && id !== '0');
    if (ids.length === 0) return;

    // Helper: highlight + scroll to element
    const scrollAndHighlight = (el: HTMLElement) => {
      nearBottomRef.current = false; // rời đáy: ResizeObserver không được kéo về đáy giữa lúc cuộn tới tin
      suppressLoadOlderUntilRef.current = Date.now() + 1500;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all');
      setTimeout(() => el.classList.remove('ring-2', 'ring-yellow-400', 'ring-opacity-75', 'transition-all'), 2000);
    };

    // Hàng đang hiển thị tin: id="msg-…", hoặc data-msg-ids (cliMsgId, ảnh trong album, sticker trong nhóm)
    const findMsgElement = (id: string): HTMLElement | null =>
      document.getElementById(`msg-${id}`)
      || document.querySelector<HTMLElement>(`[data-msg-ids~="${CSS.escape(id)}"]`);

    // 1. Check if already in DOM
    for (const id of ids) {
      const el = findMsgElement(id);
      if (el) {
        scrollAndHighlight(el);
        return;
      }
    }

    // 2. Message not in DOM - fetch its info to get timestamp, then load messages around it
    if (!activeAccountId || !activeThreadId) return;
    try {
      let targetMsg: any;
      for (const id of ids) {
        const msgRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, threadId: activeThreadId, msgId: id });
        if (msgRes?.message?.timestamp) {
          targetMsg = msgRes.message;
          break;
        }
      }
      if (!targetMsg?.timestamp && isTelegramCh(activeContact?.channel)) {
        showNotification('Đang tải tin nhắn từ Telegram...', 'info');
        const ensured = await ipc.telegramUser?.ensureMessageAvailable({
          accountId: activeAccountId,
          chatId: activeThreadId,
          messageId: ids[0],
        });
        if (!ensured?.success) {
          const err = ensured?.error || '';
          if (err.includes('CHANNEL_PRIVATE') || err.includes('USER_BANNED_IN_CHANNEL')) {
            showNotification('Kênh này không cho phép tải tin nhắn', 'info');
          } else {
            showNotification(err || 'Không tải được tin nhắn đã ghim', 'error');
          }
          return;
        }
        targetMsg = ensured.message;
      }
      if (!targetMsg?.timestamp) {
        showNotification('Không tìm thấy tin nhắn trong hội thoại này', 'error');
        return;
      }
      // A Zalo quote can identify a media message by globalMsgId while the
      // persisted/DOM record uses a different cli_msg_id.  After resolving
      // the row, always use its canonical msg_id for the element we render.
      const targetDomMessageId = String((targetMsg as any).msg_id || ids[0]);

      const aroundRes = await DataAccessor.getMessagesAround({
        zaloId: activeAccountId,
        threadId: activeThreadId,
        timestamp: Number(targetMsg.timestamp),
        limit: MESSAGE_AROUND_LIMIT,
      });
      const aroundMsgs = aroundRes?.messages;
      if (!aroundMsgs?.length) return;

      // Build reply lookup map for reply_to_id → quote_data
      const msgLookup2 = new Map<string, { content: string; type: string }>();
      for (const m of aroundMsgs) msgLookup2.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
      const missingLookup2: Array<{ msgId: string; replyToId: string }> = [];
      const mappedAround = aroundMsgs.map((m: any) => {
        if (m.channel !== 'telegram_user' && m.reply_to_id && !m.quote_data) {
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
      nearBottomRef.current = false; // danh sách mới không phải tin mới nhất → không bám đáy
      suppressLoadOlderUntilRef.current = Date.now() + 1500;
      setMessages(activeAccountId, activeThreadId, mappedAround, activeTopicId);
      // Async fixup: query DB for original messages not in the loaded batch
      if (missingLookup2.length > 0 && activeAccountId && activeThreadId) {
        (async () => {
          for (const item of missingLookup2) {
            try {
              const dbRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, threadId: activeThreadId, msgId: item.replyToId });
              const origMsg = dbRes?.message;
              if (origMsg?.msg_type || origMsg?.content) {
                const store = useChatStore.getState();
                const key = getMessageCacheKey(activeAccountId, activeThreadId, activeTopicId);
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
                  store.setMessages(activeAccountId!, activeThreadId, msgs, activeTopicId);
                }
              }
            } catch {}
          }
        })();
      }
      setHasMore(true); // Có thể còn tin cũ hơn phía trên
      setOlderKnown(false); // chưa biết chắc → không hiện nút, cuộn lên gần đỉnh sẽ tự tải
      setIsViewingHistory(true); // Đánh dấu đang xem tin cũ → hiện nút "Về tin mới nhất"

      // Wait for React to render new messages, then scroll
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      const el2 = findMsgElement(targetDomMessageId);
      if (el2) {
        scrollAndHighlight(el2);
      }
    } catch (err) {
      console.error('[handleScrollToMsg] Failed to load messages around target:', err);
    }
  };

  // Nhảy tới tin của hội thoại KHÁC (Tin đánh dấu): hội thoại đang được mở → nhảy khi đã tải xong
  const pendingJumpRef = useRef<{ accountId: string; threadId: string; messageId: string; at: number } | null>(null);
  useEffect(() => {
    const handleJumpRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId?: string; threadId?: string; messageId?: string }>).detail;
      if (!detail?.messageId) return;
      if (detail.accountId !== activeAccountId || detail.threadId !== activeThreadId || !threadReady) {
        pendingJumpRef.current = {
          accountId: String(detail.accountId || ''), threadId: String(detail.threadId || ''),
          messageId: String(detail.messageId), at: Date.now(),
        };
        return;
      }
      void handleScrollToMsg(detail.messageId);
    };
    window.addEventListener('chat:jumpToMessage', handleJumpRequest);
    return () => window.removeEventListener('chat:jumpToMessage', handleJumpRequest);
  });
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || !threadReady || !initialScrollDone || messagesLoading) return;
    if (pending.accountId !== activeAccountId || pending.threadId !== activeThreadId) return;
    pendingJumpRef.current = null;
    if (Date.now() - pending.at > 20_000) return;
    const timer = setTimeout(() => { void handleScrollToMsg(pending.messageId); }, 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadReady, initialScrollDone, messagesLoading, activeAccountId, activeThreadId]);

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
        topicId: activeTopicId || undefined,
      });
      if (res?.messages?.length) {
        // Build reply lookup map for reply_to_id → quote_data
        const msgLookup3 = new Map<string, { content: string; type: string }>();
        for (const m of res.messages) msgLookup3.set(m.msg_id, { content: m.content || '', type: m.msg_type || 'text' });
        const missingLookup3 = [];
        const mappedLatest = res.messages.map((m: any) => {
          if (m.channel !== 'telegram_user' && m.reply_to_id && !m.quote_data) {
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
        setMessages(activeAccountId, activeThreadId, sorted, activeTopicId);
        setHasMore(res.messages.length >= 50);
        setOlderKnown(false);
        // Async fixup: query DB for original messages not in the loaded batch
        if (missingLookup3.length > 0 && activeAccountId && activeThreadId) {
          (async () => {
            for (const item of missingLookup3) {
              try {
                const dbRes = await DataAccessor.getMessageById({ zaloId: activeAccountId, threadId: activeThreadId, msgId: item.replyToId });
                const origMsg = dbRes?.message;
                if (origMsg?.msg_type || origMsg?.content) {
                  const store = useChatStore.getState();
                  const mkey = getMessageCacheKey(activeAccountId, activeThreadId, activeTopicId);
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
                    store.setMessages(activeAccountId, activeThreadId, msgs, activeTopicId);
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
    if (!isMediaType(mt, mc, msg?.attachments) || isVideoType(mt)) return null;

    let localUrl = '';
    let remoteUrl = '';
    let localPath = '';
    try {
      const lp: Record<string, string> = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}')
        : (msg.local_paths || {});
      const lf = lp.main || lp.hd || lp.thumb || (Object.values(lp)[0] as string) || '';
      // File JPEG XL (tải trước khi đổi sang bản JPG) không hiển thị được → bỏ qua
      if (lf && !/\.jxl$/i.test(lf)) {
        localPath = lf;
        localUrl = toLocalMediaUrl(lf);
      }
    } catch {}
    try {
      const p = JSON.parse(msg.content || '{}');
      const params = typeof p.params === 'string' ? JSON.parse(p.params || '{}') : (p.params || {});
      remoteUrl = toZaloJpgUrl(params.hd || params.rawUrl || p.href || p.thumb || '');
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
      timestamp: Number(msg?.timestamp) || undefined,
    };
  }, []);

  /**
   * Bộ sưu tập của trình xem ảnh, phân trang như tin nhắn (kiểu Telegram/Zalo): mở ngay với ảnh đang có trong
   * hội thoại, tải ảnh quanh ảnh được bấm theo cursor (timestamp, msg_id), thêm trang khi cuộn gần đầu/cuối dải
   * hoặc ←/→ quá ảnh đầu/cuối đã tải. State nằm trong MediaGalleryViewer → tải trang không render lại ChatWindow.
   */
  const mediaGalleryRef = React.useRef<MediaGalleryViewerHandle>(null);
  const openViewer = React.useCallback((clickedUrl: string) => {
    mediaGalleryRef.current?.openFromMessages(msgsRef.current, clickedUrl);
  }, []);
  /** Ảnh trong tin định dạng phong phú Telegram: trình xem với các ảnh của tin đó */
  const openImageList = React.useCallback((items: MediaViewerImage[], index: number) => {
    mediaGalleryRef.current?.open(items, index);
  }, []);

  /** Mở video player inline từ 1 tin nhắn video */
  const openVideoPlayer = React.useCallback((msg: any) => {
    let localPath = '';
    let remoteUrl = '';
    let thumbUrl = '';
    let width = 0;
    let height = 0;
    let duration = 0;

    // Parse local paths
    try {
      const lp: Record<string, string> = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      localPath = lp.file || lp.video || lp.main || '';
      if (!localPath) {
        const attKey = Object.keys(lp).find(k => k.startsWith('att_'));
        if (attKey) localPath = lp[attKey];
      }
      thumbUrl = lp.thumb || '';
    } catch {}

    // Facebook fallback for localPath
    if (!localPath && isFacebook(msg.channel)) {
      localPath = getLocalMediaPath(msg, 'video') || getLocalMediaPath(msg) || '';
    }

    // Parse remote URLs from content
    try {
      const parsed = JSON.parse(msg.content || '{}');
      remoteUrl = parsed.href || '';
      thumbUrl = thumbUrl || parsed.thumb || '';
      const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
      width = params.video_width || 0;
      height = params.video_height || 0;
      duration = params.duration ? Math.round(params.duration / 1000) : 0;
    } catch {}

    if (!localPath && !remoteUrl) return;

    setVideoPlayerState({
      localPath: localPath || undefined,
      remoteUrl: remoteUrl || undefined,
      thumbUrl: thumbUrl || undefined,
      width: width || undefined,
      height: height || undefined,
      duration: duration || undefined,
      msgId: String(msg.msg_id || ''),
      threadId: activeThreadId || undefined,
    });
  }, [activeThreadId]);

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

    if (!activeThreadId) return;
    // Đọc ngay trong sự kiện (sau đó dữ liệu kéo bị khoá): file thật, hoặc link ảnh khi kéo từ trang web / app khác.
    // MessageInput xử lý (tải ảnh từ link, phân loại ảnh / video / file, gửi qua hàng đợi)
    window.dispatchEvent(new CustomEvent('chat:dragDropFiles', { detail: readDropPayload(e.dataTransfer) }));
  }, [activeThreadId]);

  if (!activeThreadId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
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
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm border-2 border-dashed border-blue-500 pointer-events-none"
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
            <p className="text-muted-foreground text-xs">Hỗ trợ ảnh, video, file</p>
          </div>
        </div>
      )}

      {/* ── Telegram Forum topic bar — shows active topic with back-to-topics ── */}
      {activeTopicId && activeTopicTitle && activeContact?.channel === 'telegram_user' && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-card/80 border-b border-border/50 text-xs">
          <button
            onClick={() => {
              // Return to topic list: clear activeTopicId → ConversationList shows ForumTopicsPanel
              useChatStore.setState({
                activeTopicId: null,
                activeForumTopicId: null,
                activeTopicTitle: null,
              });
            }}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Quay lại danh sách chủ đề"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>{activeForumTopicId ? 'Chủ đề' : 'Bài đăng'}</span>
          </button>
          <span className="text-subtle-foreground">/</span>
          <span className="text-foreground font-medium truncate">{activeTopicTitle}</span>
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
              channel={activeContact?.channel}
            />
          )}
        </div>
      )}

      {/* ── Friend request bar (chỉ hiện khi chat 1-1 với người chưa là bạn bè) ── */}
      {threadReady && activeAccountId && activeThreadId && (() => {
        const contact = contactMap.get(activeThreadId);
        const isGroup = contact?.contact_type === 'group' || contact?.contact_type === '1';
        if (isGroup) return null;
        // My Documents của Zalo không phải một người → không mời kết bạn
        if (isMyDocumentsThread(allAccounts.find(a => a.zalo_id === activeAccountId), activeThreadId, contact?.avatar_url)) return null;
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
      {/* z-30: trên chip reaction của tin (absolute z-20, nằm SAU nút trong DOM nên trước đây đè lên nút); dưới bảng chọn
          reaction và lớp "Đang tải..." (z-30, sau trong DOM), lớp thả file (z-40), hộp thoại (z-50). Nền card + viền +
          bóng nổi rõ trên nền hội thoại cả 2 theme (bg-muted/80 cũ gần trùng màu nền sáng #eceef3). */}
      {threadReady && !atBottom && (
        <div className="absolute bottom-4 right-4 z-30 pointer-events-none">
          <button
            onClick={isViewingHistory ? handleReturnToLatest : () => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
            disabled={loadingLatest}
            title={isViewingHistory ? 'Về tin nhắn mới nhất' : 'Cuộn xuống tin mới nhất'}
            aria-label={isViewingHistory ? 'Về tin nhắn mới nhất' : 'Cuộn xuống tin mới nhất'}
            className={`pointer-events-auto flex items-center justify-center rounded-full transition-[color,background-color,box-shadow,transform] duration-150 active:scale-95 disabled:opacity-60 ${
              isViewingHistory
                ? 'h-9 gap-1.5 pl-3 pr-3.5 bg-primary hover:bg-primary-hover text-primary-foreground text-[13px] font-medium shadow-[0_6px_16px_-4px_rgba(31,107,242,0.55),0_1px_3px_rgba(15,31,61,0.15)] dark:shadow-[0_6px_18px_-4px_rgba(0,0,0,0.65),0_1px_3px_rgba(0,0,0,0.5)]'
                : 'w-10 h-10 bg-card dark:bg-muted text-muted-foreground border border-border hover:text-primary hover:-translate-y-px shadow-[0_6px_16px_-6px_rgba(15,31,61,0.28),0_1px_3px_rgba(15,31,61,0.10)] hover:shadow-[0_10px_22px_-8px_rgba(15,31,61,0.32),0_2px_4px_rgba(15,31,61,0.10)] dark:shadow-[0_6px_18px_-6px_rgba(0,0,0,0.7),0_1px_3px_rgba(0,0,0,0.45)] dark:hover:shadow-[0_10px_24px_-8px_rgba(0,0,0,0.75),0_2px_4px_rgba(0,0,0,0.45)]'
            }`}
          >
            {loadingLatest ? (
              <Spinner size={4} />
            ) : isViewingHistory ? (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="4" x2="12" y2="18"/>
                  <polyline points="6 12 12 18 18 12"/>
                </svg>
                <span>Về tin nhắn mới nhất</span>
              </>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9.5 12 15.5 18 9.5"/>
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Messages container - luôn render khi có thread active, skeleton hiển thị bên trong khi loading */}
      {/* Giúp tránh "double flash" do container mount/unmount khi chuyển thread */}
      {activeAccountId && activeThreadId && (
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto [overflow-anchor:auto] relative" style={{ willChange: 'scroll-position' }}>
        <StickyDayPill containerRef={messagesContainerRef} />
        {/* Lớp "Đang tải..." khi mở hội thoại: z-30 — trên chip reaction / nút 👍 (z-20), nhãn ngày dính (z-20) và nút cuộn
            xuống (z-30, trước trong DOM); dưới popup ô soạn tin (z-30, sau trong DOM), lớp thả file (z-40), hộp thoại (z-50).
            Không xuyên chuột: rê / bấm không trúng tin đang ẩn bên dưới (thanh chọn reaction z-30 không mở được khi đang tải).
            Vòng xoay chỉ hiện khi tải lâu hơn ~300 ms (chat-loading-reveal): tin trong máy mở gần như tức thì → không nháy
            "Đang tải..." mỗi lần chuyển hội thoại; lớp nền vẫn che ngay để không thấy danh sách trước khi cuộn xuống đáy. */}
        {loadingSpinner && <div className="absolute inset-0 z-30 flex items-center justify-center bg-background"><div className="chat-loading-reveal flex flex-col items-center gap-3"><div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin"></div><p className="text-sm text-muted-foreground">Đang tải...</p></div></div>}
        <div ref={messagesContentRef} className="p-4 space-y-1.5">
        {/* Load More Button - Hiển thị trên tin nhắn đầu tiên (cũ nhất). Chỉ khi đang tải lâu, lỗi, hoặc đã biết
            chắc còn tin cũ — "có thể còn" (mặc định khi mở) không hiện: cuộn gần đỉnh sẽ tự tải. */}
        {msgs.length > 0 && (loadError || loadingMore || (hasMore && olderKnown)) && (
          <div className="flex justify-center py-3 mb-2">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className={`text-xs px-4 py-2 rounded-full shadow-md transition-all disabled:opacity-50 flex items-center gap-2 ${
                loadError
                  ? 'bg-red-800 text-red-200 hover:bg-red-700'
                  : 'bg-muted text-foreground hover:bg-accent hover:scale-105'
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
            <p className="text-muted-foreground text-sm font-medium">Chưa có tin nhắn nào</p>
            <p className="text-muted-foreground text-xs mt-1 max-w-xs">
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
          const daySeparator = dayStartIds.has(msg.msg_id) ? renderDaySeparator(Number(msg.timestamp) || 0) : null;
          // nextMsg: skip over non-first group images to find actual next visible msg
          let nextMsg = idx < msgs.length - 1 ? msgs[idx + 1] : null;
          if (nextMsg && groupedSkipIds.has(nextMsg.msg_id)) {
            // Find the first non-skipped message after this group
            const groupMsgsForThis = groupedFirstMsgs[msg.msg_id];
            if (groupMsgsForThis) {
              const lastInGroup = groupMsgsForThis[groupMsgsForThis.length - 1];
              const lastInGroupIdx = msgIndexById.get(lastInGroup.msg_id) ?? -1;
              nextMsg = lastInGroupIdx >= 0 && lastInGroupIdx + 1 < msgs.length ? msgs[lastInGroupIdx + 1] : null;
            }
          }
          if (nextMsg && groupedStickerSkipIds.has(nextMsg.msg_id)) {
            const stickerGroupForThis = groupedStickerFirstMsgs[msg.msg_id];
            if (stickerGroupForThis) {
              const lastInGroup = stickerGroupForThis[stickerGroupForThis.length - 1];
              const lastInGroupIdx = msgIndexById.get(lastInGroup.msg_id) ?? -1;
              nextMsg = lastInGroupIdx >= 0 && lastInGroupIdx + 1 < msgs.length ? msgs[lastInGroupIdx + 1] : null;
            }
          }

          // ── System / group-event notification ─────────────────────────
          // Older Telegram history rows accidentally stored pin events as
          // `deleted`. They have sender_id=system and must stay an emote-like
          // centered notice, not fall through to a user message bubble.
          const isTelegramPinnedNotice = msg.channel === 'telegram_user'
            && String(msg.sender_id || '') === 'system'
            && /tin nhắn\s+đã được ghim/i.test(String(msg.content || ''));
          if (msg.msg_type === 'system' || isTelegramPinnedNotice) {
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
                    className="inline-flex items-center gap-1 align-middle font-medium text-foreground hover:text-foreground hover:underline transition-colors"
                  >
                    {m.avatar ? (
                      <img src={m.avatar} alt={name} className="w-4 h-4 rounded-full object-cover inline-block flex-shrink-0" onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                    ) : (
                      <PeerInitials id={m.id} name={name} single className="w-4 h-4 text-[8px]" />
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
              <React.Fragment key={msg.msg_id + idx}>
                {daySeparator}
                <div className="flex justify-center my-2 px-4">
                  <span className="text-[11px] text-foreground bg-card border border-border px-3 py-1.5 rounded-full text-center max-w-sm leading-relaxed inline-flex items-center flex-wrap gap-x-0.5 justify-center shadow-sm">
                    {isTelegramPinnedNotice && <span aria-hidden="true" className="mr-0.5">📌</span>}
                    {renderSysContent()}
                  </span>
                </div>
              </React.Fragment>
            );
          }

          // Bắt đầu lượt tin (đổi người gửi / cách > 30 phút): hiện tên người gửi trong nhóm. Mốc ngày: daySeparator.
          const startsRun = !prevMsg ||
            (msg.timestamp - prevMsg.timestamp > 30 * 60 * 1000) ||
            prevMsg.sender_id !== msg.sender_id;

          const isLastInRun = !nextMsg || nextMsg.sender_id !== msg.sender_id;

          // Contact/display info - needed for recalled bubble too
          const contact = !isSent ? getContact(msg.sender_id) : null;
          // A sparse contact row is common for a Telegram group sender. It must
          // not hide the richer parent-group member cache (especially in forums).
          const groupMember = !isSent ? getGroupMember(msg.sender_id) : null;
          const contactName = contact?.alias || contact?.display_name || '';
          const preferredContactName = contactName && contactName !== msg.sender_id ? contactName : '';
          const avatarUrl = toLocalMediaUrl(contact?.avatar_url || groupMember?.avatar || '');
          const displayName = preferredContactName || groupMember?.displayName || contactName || msg.sender_id;

          // Kiểu Telegram cho mọi kênh: màu theo người gửi (tên, ảnh đại diện chữ), chức vụ cạnh tên (lib/chat/peerStyle).
          // Chức vụ: Telegram → danh sách quản trị viên (chức vụ tự đặt) khi đã tải, còn lại theo role thành viên nhóm.
          const senderPeer = !isSent ? (peerColorIndex(msg.sender_id, displayName) ?? 5) : null;
          const senderRank = !isSent && msg.thread_type === 1
            ? (isTelegramCh(msg.channel) && telegramGroupAdmins.size > 0
                ? telegramRankLabel(telegramGroupAdmins.get(String(msg.sender_id)))
                : groupRankLabel(msg.channel, (groupMember as any)?.role))
            : '';
          const senderAvatarFallback = !isSent ? (
            <PeerInitials id={msg.sender_id} name={displayName} fallback="U" className="w-7 h-7 text-[10px]" />
          ) : null;

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
              <div key={msg.msg_id + idx} id={`msg-${msg.msg_id}`} data-msg-ids={getRowMsgIds(msg)} className={`flex flex-col mb-0.5 ${isSent ? 'items-end' : 'items-start'}`}>
                {daySeparator}
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
                                  handleAvatarError({ ownerId: activeAccountId, contactId: msg.sender_id, channel: contact?.channel || CHANNEL.ZALO })
                                    .then(newUrl => {
                                      if (newUrl) {
                                        updateContact(activeAccountId!, { contact_id: msg.sender_id, avatar_url: newUrl });
                                        setFailedMsgAvatars(prev => { const n = new Set(prev); n.delete(msg.sender_id); return n; });
                                      }
                                    }).catch(() => {});
                                }
                              }} />
                          ) : (
                            senderAvatarFallback
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
                    onView={openViewer}
                    onOpenProfile={(userId, e) => setUserProfilePopup({ userId, x: e.clientX, y: e.clientY })}
                    onContextMenu={(e, previewMsg) => {
                      if (isSelecting) { e.preventDefault(); return; }
                      // Đang bôi đen chữ → để trình duyệt xử lý (copy tự nhiên)
                      const sel = window.getSelection();
                      if (sel && sel.toString().length > 0) return;
                      e.preventDefault();
                      // Tin đã thu hồi: chỉ thao tác cục bộ (sao chép, lưu ảnh/file, đánh dấu, xoá khỏi app)
                      setContextMenu({ x: e.clientX, y: e.clientY, msg: previewMsg, isSent, recalled: true });
                    }}
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
          const isPollMsg = cached?.isPoll ?? (
            msg.msg_type === 'group.poll'
            || msg.msg_type === 'telegram.poll'
            || (msg.msg_type === 'poll' && isTelegramCh(msg.channel))
          );
          const isVideoMsg = cached?.isVideo ?? (isVideoType(msg.msg_type) || msg.msg_type === 'gif');
          const isVoiceMsg = cached?.isVoice ?? isVoiceType(msg.msg_type);
          const isBankCardMsg = isBankCardType(msg.msg_type, msg.content);
          const isLocationMsg = msg.msg_type === 'chat.location.new';
          // Tin mẫu của Page Facebook (thẻ + nút) / tin Facebook cũ lưu rỗng (bản trước chưa đọc được tin mẫu)
          const isFbTemplateMsg = msg.msg_type === FB_TEMPLATE_MSG_TYPE;
          const isZinstantMsg = cached?.isZinstant ?? isZinstantMsgType(msg.msg_type, msg.content);
          const isFbEmptyMsg = !isFbTemplateMsg && isFacebook(msg.channel) && (!msg.msg_type || msg.msg_type === 'text')
            && !msg.is_recalled && !String(msg.content || '').trim() && !hasStoredAttachments(msg.attachments);
          const telegramPostMeta = getTelegramPostMeta(msg);
          // Telegram: tin chuyển tiếp → "Chuyển tiếp từ <nguồn>" (tên lưu kèm tin; không có thì tra liên hệ / thành viên nhóm)
          const telegramForward = getTelegramForwardMeta(msg);
          const forwardKnown = telegramForward?.fromId ? (getContact(telegramForward.fromId) || getGroupMember(telegramForward.fromId)) as any : null;
          const forwardKnownName = String(forwardKnown?.alias || forwardKnown?.display_name || forwardKnown?.displayName || '');
          const forwardName = !telegramForward ? ''
            : telegramForward.fromId && telegramForward.fromId === activeAccountId ? 'Bạn'
            : telegramForward.fromName
              || (forwardKnownName && forwardKnownName !== telegramForward.fromId ? forwardKnownName : '')
              || (telegramForward.fromUsername ? `@${telegramForward.fromUsername}` : '')
              || (telegramForward.fromType === 'channel' ? 'Kênh Telegram' : telegramForward.fromType === 'chat' ? 'Nhóm Telegram' : 'Người dùng Telegram');
          const forwardAvatar = telegramForward ? toLocalMediaUrl(forwardKnown?.avatar_url || forwardKnown?.avatar || '') : '';
          const isGroupMedia = cached?.isGroupMedia ?? (!isPollMsg && !isVoiceMsg && !!groupedFirstMsgs[msg.msg_id]);
          const groupMediaMsgs = isGroupMedia ? groupedFirstMsgs[msg.msg_id] : null;
          const isMediaMsg = cached?.isMedia ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isGroupMedia && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && !isLocationMsg && !isZinstantMsg && isMediaType(msg.msg_type, msg.content, msg.attachments));
          const isFileMsg = cached?.isFile ?? (!isCardMsg && !isEcardMsg && !isStickerMsg && !isMediaMsg && !isRtf && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isBankCardMsg && !isLocationMsg && !isZinstantMsg && isFileType(msg.msg_type, msg.content, msg.attachments));
          // Bài đăng kênh Telegram (như Telegram): ảnh / album / video sát mép khung bài; số liệu lấy cả album (Telegram gắn
          // số bình luận vào MỘT tin của album — trước đây đọc tin đầu nên lệch / mất)
          const postEdgeMedia = !!telegramPostMeta && (isMediaMsg || isGroupMedia || isVideoMsg);
          const postStats = telegramPostMeta
            ? pickTelegramPostStats((groupMediaMsgs || [msg]).map((m: any) => ({ msgId: String(m.msg_id), meta: getTelegramPostMeta(m) })))
            : null;
          // Tin định dạng phong phú (tiêu đề, danh sách, bảng, ảnh / video trong tin)
          const richBlocks = isTelegramUser(msg.channel) ? getRichMessageBlocks(msg) : null;
          const content = cached?.content ?? (isMediaMsg || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isGroupMedia || isRtf || isPollMsg || isVideoMsg || isVoiceMsg || isBankCardMsg || isLocationMsg || isZinstantMsg ? '' : parseContent(msg.content, msg.msg_type, msg.channel));
          // Tin hệ thống Telegram (vd. "Channel created") lưu nhầm thành "bài đăng kênh" rỗng ở bản cũ: không vẽ thẻ trống.
          // Bài đăng thật luôn có chữ hoặc media; lần tải lịch sử kế tiếp sửa hàng thành dòng thông báo.
          if (telegramPostMeta && msg.msg_type === 'text' && !String(msg.content || '').trim() && !isGroupMedia) return null;

          // Tin trả lời loại ảnh / album / file / thẻ: MỘT khung bong bóng bao cả trích dẫn lẫn nội dung (như Telegram)
          const isNoBubbleMsg = isMediaMsg || isGroupMedia || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isBankCardMsg || isFbTemplateMsg || isZinstantMsg;
          const hasQuote = !!(msg.quote_data || (msg.reply_to_id && !(
            msg.channel === 'telegram_user' && msg.topic_id != null &&
            String(msg.reply_to_id) === String(msg.topic_id)
          )));
          const quoteShell = hasQuote && isNoBubbleMsg && !isEcardMsg && !isStickerMsg && !isBankCardMsg && !telegramPostMeta;

          // Tên người gửi trong nhóm (mọi kênh): trong bong bóng, màu theo người gửi + chức vụ góc phải (như Telegram).
          // Tin ảnh / album / file / thẻ mở đầu lượt: bọc MỘT khung (như tin trả lời — quoteShell) để tên nằm trong khung;
          // sticker / thiệp / thẻ ngân hàng không khung → tên trên tin như cũ (có màu).
          // Tin mình gửi: ✓ đã gửi / ✓✓ đã nhận / ✓✓ màu nhấn đã xem (kênh không hỗ trợ → null, không vẽ dấu)
          const outgoingStatus = isSent ? outgoingMessageStatus(msg, msg.channel || activeContact?.channel, threadReceipt) : null;
          const showGroupName = !isSent && !isEcardMsg && msg.thread_type === 1 && startsRun && !!displayName && displayName !== msg.sender_id;
          const nameShell = showGroupName && isNoBubbleMsg && !quoteShell && !isStickerMsg && !isBankCardMsg && !telegramPostMeta;
          // Ảnh / album / file chuyển tiếp: "Chuyển tiếp từ …" chung khung với nội dung, chữ xuống dòng theo bề rộng ảnh (như
          // Telegram); trước đây dòng nguồn nằm trên ảnh, ngoài khung, dài hơn ảnh thì kéo lệch cả tin
          const forwardShell = !!telegramForward && isNoBubbleMsg && !telegramPostMeta && !isStickerMsg && !isEcardMsg && !isBankCardMsg;
          const bubbleShell = quoteShell || nameShell || forwardShell;
          const nameInBubble = showGroupName && !telegramPostMeta && (!isNoBubbleMsg || bubbleShell);
          // Giờ gửi ở góc dưới phải, chung dòng chữ cuối nếu đủ chỗ (như Telegram) — chỉ tin chữ thường; tin có khối riêng
          // (thăm dò, video, thẻ link có tên trang / tiêu đề, nội dung cũ đang mở) giữ dòng giờ riêng. Tin link Telegram
          // không có thẻ (chỉ URL) là tin chữ thường.
          const inlineTime = !isNoBubbleMsg && !telegramPostMeta && !isFbEmptyMsg && !richBlocks
            && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isRtf && !isLocationMsg
            && !(msg.msg_type === 'telegram.webpage' && getTelegramWebpageMeta(msg)) && !revealedEditIds.has(msg.msg_id);

          // Sticker nhóm: nhiều sticker liền nhau từ cùng người gửi trong 30 phút
          const isGroupedStickerFirst = isStickerMsg && !!groupedStickerFirstMsgs[msg.msg_id];
          const groupStickerMsgs = isGroupedStickerFirst ? groupedStickerFirstMsgs[msg.msg_id] : null;


          // Reactions: parse new PHP-like format or legacy format
          const reactionCounts = parseReactions(msg.reactions, msg.channel);
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

          // First visible message: attach ref for IntersectionObserver (loadMore trigger)
          return (
            <div key={msg.msg_id + idx} id={`msg-${msg.msg_id}`} data-msg-ids={getRowMsgIds(msg)} data-out={isSent ? '' : undefined}
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
              {daySeparator}

              {/* Outer row: bubble + action buttons */}
              <div className={`flex items-end gap-1 ${isEcardMsg ? 'w-full justify-center' : isSent ? 'flex-row-reverse' : 'flex-row'}`} style={{ maxWidth: '100%' }}>
                {/* Selection checkbox - visible when in selection mode */}
                {isSelecting && !isEcardMsg && (
                  <div className="w-5 h-5 flex-shrink-0 self-center mb-1">
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isMsgSelected ? 'bg-blue-500 border-blue-500' : 'border-border-strong bg-transparent'}`}>
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
                    // Album: ảnh được bấm chuột phải (Copy hình ảnh / Lưu về máy / đánh dấu áp vào đúng ảnh đó, như Zalo)
                    const albumTile = (e.target as HTMLElement)?.closest?.('[data-album-msg-id]') as HTMLElement | null;
                    const albumMsgId = albumTile?.dataset.albumMsgId;
                    const mediaMsg = albumMsgId
                      ? (groupedFirstMsgs[msg.msg_id] || []).find((m: any) => String(m.msg_id) === albumMsgId)
                      : undefined;
                    setContextMenu({ x: e.clientX, y: e.clientY, msg, mediaMsg, isSent, isGroupAdmin });
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
                                  handleAvatarError({ ownerId: activeAccountId, contactId: msg.sender_id, channel: contact?.channel || CHANNEL.ZALO })
                                    .then(newUrl => {
                                      if (newUrl) {
                                        updateContact(activeAccountId!, { contact_id: msg.sender_id, avatar_url: newUrl });
                                        setFailedMsgAvatars(prev => { const n = new Set(prev); n.delete(msg.sender_id); return n; });
                                      }
                                    }).catch(() => {});
                                }
                              }} />
                          ) : (
                            senderAvatarFallback
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

                  {/* Bài đăng kênh: cột không rộng hơn khung bài. Khung bài rộng min(30rem, 100%) theo chính cột này, lúc đo cột
                      trình duyệt bỏ qua phần trăm → cột giãn hết khung chat, nút 👍 (góc của cột) và nút Trả lời lệch ra ngoài bài */}
                  <div className={`flex flex-col ${isEcardMsg ? 'w-full items-center' : isSent ? 'items-end' : 'items-start'} relative min-w-0${hasReactions && !isGroupedStickerFirst && !telegramPostMeta ? ' mb-3' : ''}`}
                    style={telegramPostMeta ? { maxWidth: TELEGRAM_POST_MAX_WIDTH } : undefined}>
                    {/* Tên người gửi trong nhóm cho tin không khung (sticker…); tin có khung: trong bong bóng — nameInBubble */}
                    {showGroupName && !nameInBubble && (
                      <p className="flex items-center gap-2 mb-0.5 px-1 min-w-0 max-w-full">
                        <span className={`chat-peer-${senderPeer ?? 5} chat-peer-name truncate text-xs font-semibold`}>{displayName}</span>
                        {senderRank && <span className="chat-rank shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4">{senderRank}</span>}
                      </p>
                    )}
                    {/* Sticker chuyển tiếp (không khung): nguồn đặt ngay trên sticker */}
                    {telegramForward && isNoBubbleMsg && !telegramPostMeta && !bubbleShell && (
                      <TelegramForwardHeader name={forwardName} sourceId={telegramForward.fromId} avatarUrl={forwardAvatar}
                        postAuthor={telegramForward.postAuthor} className="mb-0.5 px-1" />
                    )}
                    <MessageTtlContext.Provider value={Number((msg as any).ttl) || 0}>
                    <MessageStatusContext.Provider value={outgoingStatus}>
                    <div style={telegramPostMeta ? (postEdgeMedia ? { width: TELEGRAM_POST_WIDTH } : { maxWidth: TELEGRAM_POST_WIDTH, minWidth: 'min(18rem, 100%)' }) : undefined}
                      className={`rounded-lg text-sm break-words min-w-0 max-w-full overflow-hidden${inlineTime ? ' relative' : ''}${hasQuote && !isNoBubbleMsg ? ' min-w-[13rem]' : ''} ${
                      telegramPostMeta ? `${isSent ? 'bg-bubble-out border border-bubble-out-border' : 'bg-bubble-in border border-bubble-in-border'} rounded-lg` :
                      bubbleShell ? (isSent ? 'bg-bubble-out text-foreground border border-bubble-out-border' : 'bg-bubble-in text-foreground border border-bubble-in-border') :
                      isNoBubbleMsg ? '' : isSent
                        ? 'px-3 py-2 bg-bubble-out text-foreground border border-bubble-out-border'
                        : 'px-3 py-2 bg-bubble-in text-foreground border border-bubble-in-border'
                    } ${useEmployeeStore.getState().mode === 'employee' && (msg.send_status === 'pending' ? 'opacity-60' : msg.send_status === 'sending' ? 'opacity-80' : '')}`}>
                    {/* Bài đăng: media sát mép (chữ tự đệm trong khung ảnh / video), bài chữ có đệm; người đăng ở chân bài */}
                    <div className={telegramPostMeta && !postEdgeMedia ? 'px-3 pt-2' : undefined}>
                    {/* Tên người gửi (màu theo người gửi, bấm mở hồ sơ) + chức vụ ở góc phải, đầu bong bóng. Khung bao ảnh /
                        file (nameShell): tên không kéo rộng khung (w-0 min-w-full) — rộng theo ảnh như Telegram */}
                    {nameInBubble && (
                      <div className={`flex items-center gap-2 min-w-0 ${bubbleShell ? `px-2.5 pt-1.5${quoteShell ? '' : ' pb-1.5'}` : 'mb-0.5'}${nameShell ? ' w-0 min-w-full' : ''}`}>
                        <button
                          type="button"
                          className={`chat-peer-${senderPeer ?? 5} chat-peer-name min-w-0 truncate text-left text-[13px] font-semibold leading-5 hover:underline`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setUserProfilePopup({ userId: msg.sender_id, x: e.clientX, y: e.clientY });
                          }}
                        >
                          {displayName}
                        </button>
                        {senderRank && (
                          <span className="chat-rank ml-auto shrink-0 rounded-full px-1.5 py-px text-[11px] leading-4">{senderRank}</span>
                        )}
                      </div>
                    )}
                    {/* Tin chuyển tiếp: nguồn ở đầu bong bóng, trên trích dẫn (như Telegram). Khung bao ảnh / file: chữ xuống dòng
                        theo bề rộng ảnh, không kéo rộng khung (w-0 min-w-full) */}
                    {telegramForward && (!isNoBubbleMsg || telegramPostMeta || bubbleShell) && (
                      <TelegramForwardHeader name={forwardName} sourceId={telegramForward.fromId} avatarUrl={forwardAvatar}
                        postAuthor={telegramForward.postAuthor}
                        className={bubbleShell ? `w-0 min-w-full px-2.5 pb-1.5${nameInBubble ? '' : ' pt-1.5'}` : postEdgeMedia ? 'mb-1 px-3 pt-2' : 'mb-1'} />
                    )}
                    <TelegramPostLayoutContext.Provider value={postEdgeMedia}>
                    {/* Bài đăng kênh: tệp / thoại / bình chọn… nằm trong khung bài, không lồng thêm bong bóng riêng */}
                    <BubbleEmbedContext.Provider value={bubbleShell || !!telegramPostMeta}>
                    {/* Quote preview - supports both pre-built quote_data and reply_to_id fallback */}
                    {(msg.quote_data || (msg.reply_to_id && !(
                      msg.channel === 'telegram_user' && msg.topic_id != null &&
                      String(msg.reply_to_id) === String(msg.topic_id)
                    ))) && (() => {
                      // Build quote object from quote_data or fallback to reply_to_id + msgs lookup
                      let q: any;
                      if (msg.quote_data) {
                        try { q = JSON.parse(msg.quote_data); } catch { q = {}; }
                      } else {
                        // Fallback: look up original message from msgs by reply_to_id
                        const origFromMsgs = findMsgById(msg.reply_to_id);
                        q = {
                          msgId: msg.reply_to_id,
                          msg: origFromMsgs?.content || '',
                          senderId: '',
                          msgType: origFromMsgs?.msg_type || 'text',
                        };
                      }

                      try {
                      //  Ưu tiên imageUrl đã lưu, sau đó extract từ msg/attach
                        const quotedImgUrl = q.imageUrl
                          || (q.imageLocalPath ? toLocalMediaUrl(q.imageLocalPath) : '')
                          || extractQuoteImage(q.msg, q.attach, q.msgType);
                        // Nếu vẫn không có URL, tìm trong danh sách tin nhắn theo msgId
                        let lookupImgUrl = '';
                        // Khi q.msg rỗng (ví dụ Zalo gửi TQuote với msg="" cho chat.recommended/cliMsgType=38)
                        // → tìm tin nhắn gốc để lấy content hiển thị
                        let lookupContent = '';
                        // Content của sticker gốc (để QuotedStickerPreview tải ảnh)
                        let quotedStickerContent = '';
                        // Nội dung tin gốc (lấy chú thích của ảnh / video được trích dẫn)
                        let origContent = '';
                        const isQuotedSticker = q.msgType === 'chat.sticker';

                        if (q.msgId) {
                          const origMsg = findMsgById(String(q.msgId));
                          if (origMsg) {
                            origContent = String(origMsg.content || '');
                            // Dùng msg_type thật từ tin nhắn gốc nếu quote_data đang fallback sai
                            if (origMsg.msg_type && origMsg.msg_type !== 'text') {
                              q.msgType = origMsg.msg_type;
                            }
                            if (!quotedImgUrl && isMediaType(origMsg.msg_type, origMsg.content, origMsg.attachments)) {
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
                        const quoteAuthor = resolveQuoteAuthor(q);
                        // Telegram: khung trích dẫn theo màu người được trích (vạch trái + nền nhạt + tên cùng màu); chữ trích dẫn
                        // dài không kéo rộng bong bóng (w-0 min-w-full, chỉ tên người được trích tính) — tối thiểu 13rem, như Telegram
                        const quoteSenderId = String(q.senderId || q.ownerId
                          || (q.msgId ? findMsgById(String(q.msgId))?.sender_id : '') || '');
                        const quotePeer = peerColorIndex(quoteSenderId, quoteAuthor);
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
                            className={`${quotePeer !== null ? `border-l-[3px] chat-peer-${quotePeer} chat-peer-quote` : `border-l-2 ${(quoteShell || !isNoBubbleMsg) ? (isSent ? 'border-primary bg-primary/20' : 'border-border-strong bg-background') : (isSent ? 'border-primary bg-bubble-out' : 'border-border-strong bg-bubble-in')}`} rounded pl-2 pr-1 py-1 text-xs cursor-pointer hover:opacity-100 overflow-hidden min-w-0 ${quoteShell ? 'w-0 min-w-[calc(100%-1rem)] mx-2 mt-2 mb-1.5' : postEdgeMedia ? 'mx-3 mt-2 mb-1.5' : 'mb-1 max-w-full'}`}
                            onClick={() => handleScrollToMsg(String(q.msgId || ''), String(q.cliMsgId || ''))}
                          >
                            {(isQuotedSticker || finalImgUrl) ? (() => {
                              // Như Telegram: ảnh thu nhỏ bên trái, tên + chú thích bên phải; ảnh không chú thích → nhãn "Hình ảnh"
                              const quoteCaption = getQuotedMediaCaption(q, origContent || lookupContent);
                              const quoteLabel = quoteCaption || quoteDisplayText.replace(/^\[(.*)\]$/, '$1');
                              return (
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="w-10 h-10 flex-shrink-0 overflow-hidden rounded bg-foreground/5 [&_img]:w-full [&_img]:h-full [&_img]:object-cover">
                                    {isQuotedSticker ? (
                                      <QuotedStickerPreview content={quotedStickerContent} />
                                    ) : (
                                      <img
                                        src={finalImgUrl}
                                        alt="ảnh trích dẫn"
                                        className="w-full h-full object-cover"
                                        onError={(e) => { const box = e.currentTarget.parentElement; if (box) box.style.display = 'none'; }}
                                      />
                                    )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    {quoteAuthor && <p className={`font-semibold truncate ${quotePeer !== null ? 'chat-peer-name' : 'text-foreground'}`}>{quoteAuthor}</p>}
                                    <p className={`truncate ${quoteCaption ? 'text-foreground/80' : 'text-muted-foreground'}${quotePeer !== null ? ' w-0 min-w-full' : ''}`}>{quoteLabel}</p>
                                  </div>
                                </div>
                              );
                            })() : (
                              <>
                                {quoteAuthor && <p className={`font-semibold truncate ${quotePeer !== null ? 'chat-peer-name' : 'text-foreground'}`}>{quoteAuthor}</p>}
                                <p className={`line-clamp-2 break-words whitespace-pre-wrap mt-1 mb-1${quotePeer !== null ? ' w-0 min-w-full' : ''}`}>{quoteDisplayText}</p>
                              </>
                            )}
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
                      inlineButtons={(() => {
                        try { return msg.inline_buttons ? JSON.parse(msg.inline_buttons) : undefined; } catch { return undefined; }
                      })()}
                      onInlineButtonClick={(btn) => {
                        if (btn.type === 'url' && btn.url) {
                          window.open(btn.url, '_blank');
                        } else if (btn.type === 'webview' && btn.url) {
                          setWebviewModal({ botId: msg.sender_id, url: btn.url, title: btn.text });
                        }
                      }}
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
                      isFbTemplate={isFbTemplateMsg}
                      renderFbTemplate={() => <FacebookTemplateCard msg={msg} isSent={isSent} />}
                      isZinstant={isZinstantMsg}
                      renderZinstant={() => <ZaloOaCard msg={msg} isSent={isSent} />}
                      renderGroupMedia={() => <MediaGroupBubble msgs={groupMediaMsgs!} onView={openViewer} isSent={isSent} isSelecting={isSelecting} selectedMsgIds={selectedMsgIds}
                        allContacts={contactList} groupMembersList={groupMembers}
                        onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })}
                        onToggleSelect={(id) => {
                        setSelectedMsgIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
                      }} onVideoPlay={openVideoPlayer} />}
                      renderPoll={() => msg.msg_type === 'group.poll'
                        ? <PollBubble msg={msg} isSent={isSent} activeAccountId={activeAccountId || ''} threadId={activeThreadId || ''} />
                        : <TelegramPollBubble msg={msg} isSent={isSent} />
                      }
                      renderVideo={() => {
                        let videoPath = '';
                        try {
                          const lp = typeof msg.local_paths === 'string'
                            ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
                          videoPath = lp.file || lp.video || lp.main || '';
                          if (!videoPath) {
                            const attKey = Object.keys(lp).find(k => k.startsWith('att_'));
                            if (attKey) videoPath = lp[attKey];
                          }
                        } catch {}
                        if (!videoPath && isFacebook(msg.channel)) {
                          videoPath = getLocalMediaPath(msg, 'video') || getLocalMediaPath(msg);
                        }
                        // Extract caption from content (Telegram video + text)
                        let videoCaption = '';
                        try {
                          const parsed = JSON.parse(msg.content || '{}');
                          videoCaption = typeof parsed === 'string' ? parsed : (parsed.title || parsed.text || parsed.caption || '');
                        } catch { videoCaption = ''; }
                        if (!videoCaption && msg.content && !msg.content.startsWith('{')) videoCaption = msg.content;
                        // Zalo chưa có file local (vd tin đồng bộ từ điện thoại) → thumbnail + phát từ CDN,
                        // hiện "Video đã hết hạn" khi Zalo không còn lưu file
                        const videoNode = !videoPath && isZalo(msg.channel)
                          ? <ZaloRemoteVideoThumb msg={msg} onPlay={() => openVideoPlayer(msg)} />
                          // Telegram chưa có file: tải khi bấm (≤ 10 MB tự tải) rồi mở trình phát — trước đây bấm không làm gì
                          : !videoPath && isTelegramUser(msg.channel)
                            ? <TelegramVideoPending msg={msg} onPlay={(downloaded) => openVideoPlayer(downloaded)} />
                            : (() => {
                                // Telegram: khung theo tỉ lệ thật + ảnh bìa mờ trong lúc chụp khung hình đầu (khớp lúc chưa tải)
                                const tgVideo = isTelegramUser(msg.channel) ? getTelegramVideoMedia(msg) : null;
                                return (
                                  <FBVideoThumb videoPath={videoPath} onPlay={() => openVideoPlayer(msg)} dimsMsg={msg}
                                    width={tgVideo?.width || undefined} height={tgVideo?.height || undefined}
                                    placeholderSrc={tgVideo?.thumb || undefined}
                                    autoPlayInline={!!tgVideo && tgVideo.size > 0 && tgVideo.size <= TELEGRAM_INLINE_AUTOPLAY_MAX_BYTES}
                                    duration={tgVideo?.duration || undefined} />
                                );
                              })();
                        // Link preview có video (vd. fxTikTok): link ở trên, thẻ tên trang / tiêu đề / mô tả bọc video — như Telegram
                        const videoWebpage = isTelegramUser(msg.channel) ? getTelegramWebpageMeta(msg) : null;
                        // Chú thích: link / @tên bấm được (trước đây là chữ thô)
                        const captionNode = videoCaption ? (
                          <TextWithMentions text={videoCaption} channel={msg.channel} allContacts={contactList} groupMembersList={groupMembers}
                            mentionRanges={getMentionRanges(msg.attachments)}
                            highlight={searchHighlightQuery}
                            onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
                        ) : null;
                        // Bản ghi cũ (video link chưa có thẻ / thiếu tiêu đề): xin Telegram bù khi hiện ra, gom theo lô
                        const previewRefresh = isTelegramUser(msg.channel) ? <TelegramPreviewRefresh msg={msg} /> : null;
                        if (videoWebpage) {
                          return (
                            <div className={telegramPostMeta ? 'flex w-full flex-col px-3 pt-2' : 'flex w-[19.5rem] max-w-full flex-col'}>
                              {previewRefresh}
                              {captionNode && <div className="pb-1.5 text-sm break-words">{captionNode}</div>}
                              <TelegramLinkPreviewCard meta={videoWebpage}>{videoNode}</TelegramLinkPreviewCard>
                            </div>
                          );
                        }
                        if (captionNode) {
                          return (
                            <div className={telegramPostMeta ? 'flex w-full flex-col' : 'flex flex-col max-w-xs'}>
                              {previewRefresh}
                              {videoNode}
                              <div className={telegramPostMeta ? 'px-3 pt-2 text-sm break-words' : 'pt-1.5 text-sm break-words'}>
                                {captionNode}
                              </div>
                            </div>
                          );
                        }
                        return <>{previewRefresh}{videoNode}</>;
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
                          allContacts={contactList}
                          groupMembersList={groupMembers}
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
                        : <StickerBubble msg={msg}
                            onOpenSet={isTelegramUser(msg.channel) && /^\d+$/.test(String(msg.msg_id || '')) ? () => openStickerSetOfMessage(msg) : undefined} />
                      }
                      renderRtf={() => (
                        <RtfBubble msg={msg} allContacts={contactList} groupMembersList={groupMembers}
                          onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
                      )}
                      renderText={() => isFbEmptyMsg ? <FacebookEmptyMessage msg={msg} /> : (
                        <>
                          {richBlocks ? (
                            <TelegramRichMessageBody msg={msg} onOpenImages={openImageList} highlight={searchHighlightQuery}
                              allContacts={contactList} groupMembersList={groupMembers} />
                          ) : (
                          <TextWithMentions text={content} channel={msg.channel} allContacts={contactList} groupMembersList={groupMembers}
                            mentionRanges={getMentionRanges(msg.attachments)}
                            highlight={searchHighlightQuery}
                            onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
                          )}
                          {/* Link Telegram không có ảnh / video: thẻ tên trang, tiêu đề, mô tả như Telegram */}
                          {msg.msg_type === 'telegram.webpage' && (() => {
                            const webpage = getTelegramWebpageMeta(msg);
                            return webpage ? (
                              <TelegramLinkPreviewCard meta={webpage} className="mt-1.5"
                                hideTitle={String(content || '').trim() === webpage.title} />
                            ) : null;
                          })()}
                          {msg.is_edited === 1 && (
                            <>
                              {!telegramPostMeta && (
                                <span className="ml-1 text-[10px] opacity-60 select-none font-normal">
                                  (đã chỉnh sửa)
                                </span>
                              )}
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
                                      className="ml-1 text-[10px] font-medium text-blue-300 transition-colors underline underline-offset-2 select-none pointer-events-auto"
                                    >
                                      {revealedEditIds.has(msg.msg_id) ? 'Ẩn' : 'Xem nội dung cũ'}
                                    </button>
                                  );
                                } catch { return null; }
                              })()}
                            </>
                          )}
                          {/* Tin hẹn tự xoá đã quá hạn: Zalo xoá trên thiết bị Zalo, Deplao giữ nội dung (FR-ZL05.6) */}
                          <TtlExpiredNote ttl={(msg as any).ttl} sentAt={msg.timestamp} />
                          {/* Chừa chỗ cuối dòng chữ cuối cho giờ gửi ở góc dưới phải (inlineTime); thiếu chỗ thì xuống dòng.
                              Tin có ngày giờ sắp tới ("mai 9h", "20 phút nữa"): nút "Tạo lịch hẹn" ngay dưới, cùng dòng với giờ gửi */}
                          {(() => {
                            const spacer = inlineTime
                              ? <span aria-hidden="true" className={`inline-block ${inlineTimeSpacerClass(!!outgoingStatus, (msg as any).ttl)} select-none`} />
                              : null;
                            return erpAccess.event && !isSelecting && !richBlocks && !telegramPostMeta && content ? (
                              <ScheduleChip msgId={msg.msg_id} timestamp={msg.timestamp} text={content}
                                onCreate={() => setErpDraft({ kind: 'event', msgs: [msg] })}>
                                {spacer}
                              </ScheduleChip>
                            ) : spacer;
                          })()}
                          {revealedEditIds.has(msg.msg_id) && (() => {
                            try {
                              const parsed = JSON.parse(msg.edit_history || '[]');
                              if (!Array.isArray(parsed) || parsed.length === 0) return null;
                              return (
                                <div className="w-full mt-1 space-y-1">
                                  {parsed.map((entry: any, i: number) => (
                                    <div
                                      key={i}
                                      className={`px-3 py-1.5 rounded-lg text-xs opacity-60 ${isSent ? 'bg-blue-700/30 mr-8' : 'bg-accent/30 ml-8'}`}
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
                    </BubbleEmbedContext.Provider>
                    </TelegramPostLayoutContext.Provider>
                    </div>
                    {!telegramPostMeta && !isNoBubbleMsg && (inlineTime ? (
                      <span className="absolute bottom-1.5 right-2.5 inline-flex items-center gap-0.5 text-[11px] leading-none text-subtle-foreground select-none cursor-default"
                        title={formatFullDateTime(msg.timestamp)}>
                        <TtlMark ttl={(msg as any).ttl} sentAt={msg.timestamp} />
                        {formatBubbleTime(msg.timestamp)}
                        <StatusTicks status={outgoingStatus} />
                      </span>
                    ) : (
                      <BubbleTime timestamp={msg.timestamp} />
                    ))}
                    {telegramPostMeta && (
                      <>
                        {/* Cảm xúc trong khung bài, bấm = thả / gỡ (như Telegram) */}
                        {hasReactions && (() => {
                          const rFull = parseReactionsFull(msg.reactions, msg.channel);
                          const mine = activeAccountId
                            ? (Object.entries(rFull.emoji || {}).find(([, d]) => (d as any).users?.[activeAccountId] > 0)?.[0] || null)
                            : null;
                          return (
                            <TelegramPostReactions counts={reactionCounts} myEmoji={mine}
                              onToggle={(emoji, isMine) => {
                                if (isMine) void handleCancelReaction(msg);
                                else void handleReact(msg, emoji);
                              }} />
                          );
                        })()}
                        <TelegramPostFooter postAuthor={postStats?.postAuthor || telegramPostMeta.postAuthor}
                          views={postStats?.views ?? telegramPostMeta.views} edited={msg.is_edited === 1} timestamp={msg.timestamp} />
                        {/* Bình luận nằm ở nhóm thảo luận của kênh: mở ngay trong khung chat, quay lại đúng chỗ bài đang xem */}
                        {postStats?.hasDiscussion && activeAccountId && activeThreadId && (
                          <TelegramPostCommentsBar count={postStats.comments} repliers={postStats.recentRepliers} peers={postReplierPeers}
                            isSent={isSent} unread={postStats.unread}
                            onOpen={() => useChatStore.getState().setPostDiscussion({
                              accountId: activeAccountId, channelId: activeThreadId, postId: postStats.postId,
                            })} />
                        )}
                      </>
                    )}
                  </div>
                  </MessageStatusContext.Provider>
                  </MessageTtlContext.Provider>


                  {/* Nút reaction ở góc dưới, phía TRONG khung chat (như các app lớn): tin của mình → góc trái, tin người
                      khác → góc phải — gần giữa màn hình, dễ với tới; thanh chọn mọc lên từ nút, tin sát mép trên thì mọc
                      xuống. Đang mở → z-30: chip reaction của các tin bên dưới (z-20, sau trong DOM) không đè lên thanh */}
                  {channelCap.supportsReaction && !isEcardMsg && !isGroupedStickerFirst && (() => {
                    const rFull = parseReactionsFull(msg.reactions, msg.channel);
                    const myEmoji = activeAccountId
                      ? (Object.entries(rFull.emoji || {}).find(([, d]) => (d as any).users?.[activeAccountId] > 0)?.[0] || null)
                      : null;
                    const loadTelegramReactions = () => {
                      if (msg.channel === 'telegram_user') telegramReactions.load();
                    };
                    return (
                      <MessageReactionCorner
                        isSent={isSent}
                        counts={reactionCounts}
                        myEmoji={myEmoji}
                        variant={isTelegramCh(msg.channel) ? 'chips' : 'summary'}
                        // Bài đăng kênh: cảm xúc đã vẽ trong khung bài → ở đây chỉ còn nút 👍 khi rê chuột
                        hideCounts={!!telegramPostMeta}
                        pickerOpen={reactionPickerMsgId === msg.msg_id}
                        pickerEmojis={getReactionChoices(msg.channel, telegramReactions.reactions).all}
                        onArm={() => armReactionPicker(msg.msg_id, loadTelegramReactions)}
                        onLeave={scheduleCloseReactionPicker}
                        onOpenPicker={() => {
                          openReactionPicker(msg.msg_id);
                          loadTelegramReactions();
                        }}
                        onPick={(e) => {
                          if (sameReaction(e, myEmoji)) handleCancelReaction(msg);
                          else handleReact(msg, e);
                          closeReactionPicker();
                        }}
                        onShowReactors={(emoji) => setReactionPopup({ msg, activeEmoji: emoji })}
                      />
                    );
                  })()}

                  {/* ── Send status indicator (optimistic messages) ──── */}
                  {/* Only show in employee mode — boss sends directly via Zalo (fast, no need for status) */}
                  {isSent && msg.send_status && msg.send_status !== 'received' && useEmployeeStore.getState().mode === 'employee' && (
                    <div className="flex items-center gap-1 mt-0.5 px-1">
                      {msg.send_status === 'pending' && (
                        <span title="Đang chờ gửi">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground opacity-60">
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
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground">
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
                                const channel = (msg.channel || CHANNEL.ZALO) as any;
                                useChatStore.getState().addMessage(activeAccountId!, activeThreadId, {
                                  msg_id: retryTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
                                  thread_type: msg.thread_type, sender_id: activeAccountId!, content: msg.content,
                                  msg_type: msg.msg_type, timestamp: Date.now(), is_sent: 1, status: 'sending',
                                  send_status: 'pending', temp_id: retryTempId, media_type: 'text',
                                  ...(msg.quote_data ? { quote_data: msg.quote_data } : {}),
                                });
                                import('@/lib/MessageQueue').then(({ messageQueue }) => {
                                  const auth = (() => {
                                    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
                                    return acc ? { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent, accountId: activeAccountId } : null;
                                  })();
                                  if (!auth) return;
                                  messageQueue.enqueue({
                                    tempId: retryTempId, zaloId: activeAccountId!, threadId: activeThreadId,
                                    threadType: msg.thread_type, channel,
                                    sendFn: async () => {
                                      try {
                                        const adapter = getAdapter(channel);
                                        const result = await adapter.sendMessage({
                                          accountId: activeAccountId!,
                                          threadId: activeThreadId,
                                          body: msg.content,
                                          threadType: msg.thread_type,
                                          auth,
                                        });
                                        return { success: result.success, msgId: result.messageId, error: result.error };
                                      } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
                                    },
                                  });
                                });
                              }}
                              className="text-[10px] text-red-400 hover:text-red-300 underline"
                            >Gửi lại</button>
                          ) : (
                            <span className="text-[10px] text-subtle-foreground italic">Không thể gửi lại media</span>
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
        <div className="flex items-center justify-between px-3 py-2 bg-card border-t border-blue-500/40 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => { setIsSelecting(false); setSelectedMsgIds(new Set()); }}
              className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-muted text-foreground/80 hover:text-foreground text-xs transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              Sao chép
            </button>
            {/* Quản lý công việc: các tin đã chọn → một lịch hẹn (ghi chú = nội dung các tin) / một ghi chú */}
            {(erpAccess.event || erpAccess.note) && (['event', 'note'] as const).filter(kind => erpAccess[kind]).map(kind => (
              <button key={kind} onClick={() => {
                const selectedMsgs = msgs.filter(m => selectedMsgIds.has(m.msg_id))
                  .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
                if (!selectedMsgs.some(m => { const t = extractMsgText(m); return t && t !== '[Tin nhắn]'; })) {
                  showNotification('Các tin đã chọn không có nội dung chữ', 'info');
                  return;
                }
                setErpDraft({ kind, msgs: selectedMsgs });
                setIsSelecting(false);
                setSelectedMsgIds(new Set());
              }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-muted text-foreground/80 hover:text-foreground text-xs transition-colors">
                {kind === 'event' ? <CalendarIcon className="w-3.5 h-3.5" /> : <FileTextIcon className="w-3.5 h-3.5" />}
                {kind === 'event' ? 'Thêm vào lịch' : 'Lưu ghi chú'}
              </button>
            ))}
            {channelCap.supportsForward && (
              <button onClick={() => {
                const selectedMsgs = msgs.filter(m => selectedMsgIds.has(m.msg_id));
                // Cuộc gọi, bình chọn, tin hệ thống… không chuyển tiếp được → bỏ ra trước khi chọn người nhận
                const forwardable = selectedMsgs.filter(m => !getForwardBlockReason(m));
                const skipped = selectedMsgs.length - forwardable.length;
                if (skipped > 0) {
                  showNotification(
                    forwardable.length > 0
                      ? `Bỏ qua ${skipped} tin không chuyển tiếp được (cuộc gọi, bình chọn, tin hệ thống…)`
                      : 'Các tin đã chọn không chuyển tiếp được (cuộc gọi, bình chọn, tin hệ thống…)',
                    'info',
                  );
                }
                if (forwardable.length > 0) {
                  setForwardMsgs(forwardable);
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
        const typingEntries = Object.entries(useChatStore.getState().typingUsers).filter(
          ([k, ts]) => k.startsWith(prefix) && nowTs - ts < 5000
        );
        if (!typingEntries.length) return null;

        const groupCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];

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
        const firstMember = groupCache?.members?.find((m: any) => m.userId === firstUid);
        const rawAvatar = firstContact?.avatar_url || firstMember?.avatar || '';
        const firstAvatar = rawAvatar ? toLocalMediaUrl(rawAvatar, activeAccountId) : '';

        return (
          <div className="flex items-center gap-1.5 px-4 py-1.5 flex-shrink-0 pointer-events-none">
            {firstAvatar ? (
              <img src={firstAvatar} className="w-4 h-4 rounded-full object-cover flex-shrink-0 opacity-80" alt="" />
            ) : (
              <PeerInitials id={firstUid} name={resolveName(firstUid)} single className="w-4 h-4 text-[9px] opacity-80" />
            )}
            <div className="flex items-center gap-1.5 bg-card backdrop-blur-sm border border-border/60 rounded-full px-2.5 py-1 shadow-md">
              <div className="flex items-center gap-0.5">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-[11px] text-muted-foreground italic leading-none">{nameText}</span>
            </div>
          </div>
        );
      })()}

      {/* Seen indicator for sent messages */}
      {threadReady && activeAccountId && activeThreadId && (() => {
        const seen = threadSeen;
        if (!seen || !seen.seenUids?.length) return null;

        // Lấy thông tin người đã seen
        const groupCache = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[activeThreadId];
        const allContacts = contactList;

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
            <span className="text-[11px] text-muted-foreground mr-0.5">Đã xem</span>
            <div className="flex items-center -space-x-1">
              {shown.map((u) => (
                <div key={u.userId} title={u.name} className="w-4 h-4 rounded-full ring-1 ring-border overflow-hidden flex-shrink-0">
                  {u.avatar ? (
                    <img src={u.avatar} alt={u.name} className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    <PeerInitials id={u.userId} name={u.name} single className="w-full h-full text-[7px]" />
                  )}
                </div>
              ))}
              {extra > 0 && (
                <div className="w-4 h-4 rounded-full ring-1 ring-border bg-accent flex items-center justify-center text-foreground" style={{ fontSize: '0.4375rem' }}>
                  +{extra}
                </div>
              )}
            </div>
          </div>
        );
      })()}


      <MediaGalleryViewer
        ref={mediaGalleryRef}
        accountId={activeAccountId}
        threadId={activeThreadId}
        buildEntry={buildImageEntry}
      />

      {/* Video player modal */}
      {videoPlayerState && (
        <VideoPlayer
          localPath={videoPlayerState.localPath}
          remoteUrl={videoPlayerState.remoteUrl}
          thumbUrl={videoPlayerState.thumbUrl}
          width={videoPlayerState.width}
          height={videoPlayerState.height}
          duration={videoPlayerState.duration}
          msgId={videoPlayerState.msgId}
          threadId={videoPlayerState.threadId}
          onClose={() => setVideoPlayerState(null)}
        />
      )}

      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          msg={contextMenu.msg}
          mediaMsg={contextMenu.mediaMsg}
          isSent={contextMenu.isSent}
          isGroupAdmin={contextMenu.isGroupAdmin}
          recalled={contextMenu.recalled}
          channelCap={channelCap}
          onClose={() => setContextMenu(null)}
          onReply={(m) => setReplyTo(m)}
          onForward={handleForward}
          onSelectMessages={(m) => { setIsSelecting(true); setSelectedMsgIds(new Set((groupedFirstMsgs[m.msg_id] || [m]).map((x: any) => x.msg_id))); }}
          onUndo={handleUndo}
          onDelete={handleDelete}
          onDeleteFromDb={handleDeleteFromDb}
          onReact={handleReact}
          onCancelReact={handleCancelReaction}
          reactionChoices={getReactionChoices(contextMenu.msg?.channel, telegramReactions.reactions)}
          myReaction={(() => {
            if (!activeAccountId || !contextMenu.msg) return null;
            const full = parseReactionsFull(contextMenu.msg.reactions, contextMenu.msg.channel);
            return Object.entries(full.emoji || {}).find(([, data]) => (data as any).users?.[activeAccountId] > 0)?.[0] || null;
          })()}
          onPin={handlePin}
          onEdit={(m) => {
            setEditingMsg(m);
            setContextMenu(null);
          }}
          isStarred={contextTargetStarred}
          onToggleStar={handleToggleStar}
          onSaveToMyDocuments={(activeContact?.channel || CHANNEL.ZALO) === CHANNEL.ZALO && channelCap.supportsForward ? handleSaveToMyDocuments : undefined}
          onAddToCalendar={erpAccess.event ? (m) => setErpDraft({ kind: 'event', msgs: groupedFirstMsgs[m.msg_id] || [m] }) : undefined}
          onSaveToNote={erpAccess.note ? (m) => setErpDraft({ kind: 'note', msgs: groupedFirstMsgs[m.msg_id] || [m] }) : undefined}
          showNotification={showNotification}
          readReceipts={activeAccountId && canQueryTelegramReadReceipts(contextMenu.msg, {
            isSent: contextMenu.isSent,
            isChannelPost: !!getTelegramPostMeta(contextMenu.msg),
            recalled: contextMenu.recalled,
          }) ? {
            accountId: activeAccountId,
            // Tên / avatar người xem: liên hệ của tài khoản → thành viên nhóm đang mở (main có tên dự phòng)
            resolvePerson: (userId: string) => {
              const contact = getContact(userId) as any;
              const member = getGroupMember(userId) as any;
              const name = String(contact?.alias || contact?.display_name || member?.displayName || '');
              const avatar = toLocalMediaUrl(contact?.avatar_url || member?.avatar || '');
              return name && name !== userId ? { name, avatar } : (avatar ? { name: '', avatar } : null);
            },
          } : undefined}
        />
      )}

      {/* Forward message modal */}
      {channelCap.supportsForward && forwardMsgs && (
        <ForwardMessageModal
          messages={forwardMsgs}
          onClose={() => setForwardMsgs(null)}
          onForward={(messages, targets, composeText) => {
            setForwardMsgs(null);
            runForward(messages, targets, composeText);
          }}
        />
      )}

      {/* Quản lý công việc: lịch hẹn / ghi chú từ tin (điền sẵn tiêu đề, ngày giờ đọc trong tin, nội dung tin) */}
      {erpDraft && activeAccountId && activeThreadId && (() => {
        const conversation = activeContact?.alias || activeContact?.display_name || activeThreadId;
        const account = allAccounts.find(a => a.zalo_id === activeAccountId);
        const ctx = {
          conversation,
          channelLabel: getChannelLabel(((activeContact?.channel || account?.channel || CHANNEL.ZALO) as Channel)),
          accountName: account?.full_name || '',
        };
        const sources = erpDraft.msgs.map(erpSourceOf);
        if (erpDraft.kind === 'note') {
          return <QuickNoteDialog initial={noteDraftFromMessages(sources, ctx)} onClose={() => setErpDraft(null)} />;
        }
        const draft = eventDraftFromMessages(sources, ctx);
        const linkedMsg = erpDraft.msgs[draft.sourceIndex];
        const msgId = linkedMsg && !/^(temp|retry)_/.test(String(linkedMsg.msg_id)) ? String(linkedMsg.msg_id) : undefined;
        return (
          <QuickEventDialog
            heading="Thêm vào lịch"
            activeThread={{ id: activeThreadId, name: conversation, accountId: activeAccountId, msgId }}
            initial={draft}
            onClose={() => setErpDraft(null)}
          />
        );
      })()}

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
          ownerZaloId={activeAccountId || undefined}
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
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-[380px] max-h-[80vh] flex flex-col overflow-hidden">
            <ManagePanel
              groupInfo={threadGroupInfo || null}
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

      {/* Telegram WebView Modal */}
      {webviewModal && activeAccountId && (
        <TelegramWebViewModal
          accountId={activeAccountId}
          botId={webviewModal.botId}
          url={webviewModal.url}
          title={webviewModal.title}
          onClose={() => setWebviewModal(null)}
        />
      )}

      {/* Popup bộ sticker Telegram (bấm sticker trong chat / bảng sticker của ô nhập) */}
      <TelegramStickerSetHost />
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────




// extractMsgText: imported from @/lib/chat/messageParser

type ForwardTarget = { threadId: string; threadType: number };

/**
 * File local đã tải của tin, đúng key theo loại (video có cả `thumb` — không được lấy nhầm ảnh bìa làm video).
 * Bỏ qua file `.jxl` cũ (Chromium / Zalo không dùng được).
 */
function getForwardLocalPath(msg: any, kind?: ForwardKind): string {
  const resolved = getLocalMediaPath(msg);
  if (resolved) return resolved;
  try {
    const raw = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    if (!raw || typeof raw !== 'object') return '';
    const pick = (...keys: string[]): string =>
      keys.map(key => raw[key]).find(value => typeof value === 'string' && value && !/\.jxl$/i.test(value)) || '';
    if (kind === 'video') return pick('file', 'video');
    if (kind === 'voice') return pick('file', 'voice');
    if (kind === 'image' || kind === 'gif') return pick('main', 'hd', 'file');
    if (kind === 'file') return pick('file', 'main');
    return pick('file', 'video', 'voice', 'main', 'hd')
      || (Object.values(raw).find(value => typeof value === 'string' && value) as string) || '';
  } catch {}
  return '';
}

function ensureForwardSuccess(result: { success?: boolean; error?: string } | undefined, fallback: string): void {
  if (!result?.success) throw new Error(result?.error || fallback);
}

async function sendForwardText(
  auth: any,
  channel: string | undefined,
  accountId: string | undefined,
  target: ForwardTarget,
  text: string,
): Promise<void> {
  if (!text) return;

  if (isFacebook(channel) || isTelegramCh(channel)) {
    if (!accountId) throw new Error('Không tìm thấy tài khoản gửi');
    const result = await getAdapter(channel as Channel).sendMessage({
      accountId,
      threadId: target.threadId,
      body: text,
      threadType: target.threadType,
    });
    ensureForwardSuccess(result, 'Không gửi được tin nhắn');
    return;
  }

  const result = await ipc.zalo?.sendMessage({
    auth,
    message: text,
    threadId: target.threadId,
    type: target.threadType,
  });
  ensureForwardSuccess(result, 'Không gửi được tin nhắn Zalo');
}

/** Đích Zalo (mặc định khi không rõ kênh) */
const isZaloForwardTarget = (channel?: string) => !isFacebook(channel) && !isTelegramCh(channel);

const FORWARD_DOWNLOAD_KINDS: Partial<Record<ForwardKind, 'image' | 'gif' | 'file' | 'voice' | 'video'>> = {
  image: 'image', gif: 'gif', file: 'file', voice: 'voice', video: 'video',
};

/**
 * File local để gửi lại media. Chưa tải (tin đồng bộ từ điện thoại, tin cũ…) → main process tải về theo link CDN
 * trong content (chỉ tin Zalo), cập nhật local_paths để bubble hiện "đã có trên máy".
 */
async function ensureForwardLocalPath(msg: any, kind: ForwardKind): Promise<string> {
  const existing = getForwardLocalPath(msg, kind);
  if (existing) return existing;
  const downloadKind = FORWARD_DOWNLOAD_KINDS[kind];
  if (!downloadKind || !isZalo(msg.channel) || !msg.owner_zalo_id || !msg.msg_id) return '';
  const res = await ipc.file?.downloadMessageMedia?.({
    zaloId: String(msg.owner_zalo_id),
    msgId: String(msg.msg_id),
    threadId: msg.thread_id ? String(msg.thread_id) : undefined,
    kind: downloadKind,
  }).catch(() => null);
  if (!res?.success || !res.localPath) {
    if (res?.error) console.warn(`[Forward] Không tải được ${downloadKind} của tin ${msg.msg_id}:`, res.error);
    return '';
  }
  if (res.localPaths && msg.thread_id) {
    useChatStore.getState().updateMessageLocalPath(String(msg.owner_zalo_id), String(msg.thread_id), String(msg.msg_id), res.localPaths);
  }
  return res.localPath;
}

/**
 * Gom các tin cùng album (liền nhau trong danh sách chuyển tiếp) thành 1 nhóm, theo thứ tự ảnh trong album.
 * `albums`: msg_id ảnh đầu → toàn bộ tin của album (groupedFirstMsgs).
 */
function groupForwardAlbums(messages: any[], albums: Record<string, any[]>): any[][] {
  const albumOf = new Map<string, any[]>();
  for (const album of Object.values(albums)) {
    for (const m of album) albumOf.set(m.msg_id, album);
  }
  const units: any[][] = [];
  for (const m of messages) {
    const album = albumOf.get(m.msg_id);
    const last = units[units.length - 1];
    if (album && last && albumOf.get(last[0].msg_id) === album) last.push(m);
    else units.push([m]);
  }
  return units.map((unit) => {
    const album = albumOf.get(unit[0].msg_id);
    if (!album || unit.length < 2) return unit;
    const order = new Map(album.map((m, i) => [m.msg_id, i]));
    return [...unit].sort((a, b) => (order.get(a.msg_id) ?? 0) - (order.get(b.msg_id) ?? 0));
  });
}

const FORWARD_ALBUM_FILE_RE = /\.(jpe?g|png|webp)$/i;
/** Lỗi ZaloService.sendImages khi kiểm tra file, trước khi upload (giữ khớp câu chữ bên đó). */
const FORWARD_ALBUM_PRECHECK_ERROR_RE = /Không tìm thấy một trong các tệp ảnh|không phải ảnh JPG, PNG hoặc WebP|Không đọc được kích thước ảnh/;

/**
 * File local của album nếu gửi gộp được: đích là Zalo, mọi tin là ảnh và có (hoặc tải về được) file JPG/PNG/WebP
 * (định dạng sendImages chấp nhận). Ngược lại null → gửi từng tin.
 */
async function prepareForwardAlbum(unit: any[], channel?: string): Promise<string[] | null> {
  if (unit.length < 2 || !isZaloForwardTarget(channel)) return null;
  if (!unit.every(m => getForwardPlan(m).kind === 'image')) return null;
  const paths: string[] = [];
  for (const m of unit) {
    const filePath = await ensureForwardLocalPath(m, 'image');
    if (!FORWARD_ALBUM_FILE_RE.test(filePath)) return null;
    paths.push(filePath);
  }
  return paths;
}

/** Gửi album bằng 1 lần sendImages (zca-js gán groupLayoutId → người nhận thấy album), caption gửi sau như sendOneForward. */
async function sendForwardAlbum(
  auth: any, unit: any[], filePaths: string[], target: ForwardTarget,
  channel?: string, accountId?: string,
): Promise<void> {
  const result = await ipc.zalo?.sendImages({ auth, filePaths, threadId: target.threadId, type: target.threadType });
  ensureForwardSuccess(result, 'Không gửi được album ảnh Zalo');
  for (const msg of unit) {
    const caption = getForwardCaption(msg, 'image');
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
  }
}

function getForwardVideoThumbPath(msg: any): string {
  try {
    const raw = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    return typeof raw?.thumb === 'string' ? raw.thumb : '';
  } catch {
    return '';
  }
}

/**
 * Video sang Zalo phải gửi bằng sendVideo — sendFile ra tin file .mp4, không xem được ngay.
 * Video Zalo còn link CDN → dùng lại link + ảnh bìa gốc, không upload lại (sendVideo của zca-js chính là API
 * "forward" msgType 5, cách Zalo chuyển tiếp video). Link hết hạn / gửi lỗi / video kênh khác → upload file đã tải về.
 * Trả false nếu không có link lẫn file (để thử native forward).
 */
async function sendZaloVideoForward(auth: any, msg: any, localPath: string, target: ForwardTarget): Promise<boolean> {
  const info = getZaloVideoInfo(msg);
  if (info) {
    let expired = !!msg.media_expired;
    if (!expired && msg.owner_zalo_id && msg.msg_id) {
      const check = await ipc.file?.checkMediaExpired({
        zaloId: String(msg.owner_zalo_id), msgId: String(msg.msg_id), urls: [info.videoUrl],
      }).catch(() => null);
      expired = !!check?.expired;
    }
    if (!expired) {
      const result = await ipc.zalo?.sendVideo({
        auth,
        options: { videoUrl: info.videoUrl, thumbnailUrl: info.thumbUrl || info.videoUrl, duration: info.duration, width: info.width, height: info.height },
        threadId: target.threadId,
        type: target.threadType,
      });
      if (result?.success) return true;
      // sendVideo lỗi = chưa gửi gì (lỗi ở bước HEAD link hoặc ở request forward duy nhất) → upload file nếu có
      if (!localPath) ensureForwardSuccess(result, 'Không gửi được video Zalo');
      console.warn('[Forward] Gửi video bằng link CDN lỗi → upload file đã tải về:', result?.error);
    } else if (!localPath) {
      // Native forward lúc này chỉ ra video không phát được ở người nhận
      throw new Error('Video đã hết hạn trên Zalo và chưa tải về máy');
    }
  }
  if (!localPath) return false;

  const meta = await ipc.file?.getVideoMeta?.({ filePath: localPath }).catch(() => null);
  const thumbPath: string = meta?.thumbPath || getForwardVideoThumbPath(msg);
  let thumbUrl = '';
  if (thumbPath) {
    const uploadRes = await ipc.zalo?.uploadVideoThumb?.({ auth, thumbPath, threadId: target.threadId, type: target.threadType }).catch(() => null);
    const resp = uploadRes?.response;
    thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
  }
  const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({ auth, videoPath: localPath, threadId: target.threadId, type: target.threadType });
  const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
  if (!videoUrl) throw new Error(uploadVideoRes?.error || 'Tải video lên Zalo thất bại');
  const result = await ipc.zalo?.sendVideo({
    auth,
    options: {
      videoUrl,
      thumbnailUrl: thumbUrl || videoUrl,
      duration: meta?.duration ? meta.duration * 1000 : info?.duration,
      width: meta?.width || info?.width,
      height: meta?.height || info?.height,
    },
    threadId: target.threadId,
    type: target.threadType,
  });
  ensureForwardSuccess(result, 'Không gửi được video Zalo');
  return true;
}

/**
 * Tin thoại sang Zalo: sendVoice (sendFile ra tin file .m4a). Dùng lại link m4a gốc như video (sendVoice của zca-js
 * là API "forward" msgType 3); link hết hạn / gửi lỗi → tải file lên lại. Trả false nếu không có link lẫn file.
 */
async function sendZaloVoiceForward(auth: any, msg: any, target: ForwardTarget): Promise<boolean> {
  const voiceUrl = isZalo(msg.channel) ? getZaloVoiceUrl(msg) : '';
  if (voiceUrl && !msg.media_expired) {
    const check = msg.owner_zalo_id && msg.msg_id
      ? await ipc.file?.checkMediaExpired({ zaloId: String(msg.owner_zalo_id), msgId: String(msg.msg_id), urls: [voiceUrl] }).catch(() => null)
      : null;
    if (!check?.expired) {
      const result = await ipc.zalo?.sendVoice({ auth, options: { voiceUrl }, threadId: target.threadId, type: target.threadType });
      if (result?.success) return true;
      // sendVoice lỗi = chưa gửi gì (lỗi ở bước HEAD link hoặc request forward duy nhất) → tải file lên lại
      console.warn('[Forward] Gửi tin thoại bằng link gốc lỗi → tải file lên lại:', result?.error);
    }
  }
  const localPath = await ensureForwardLocalPath(msg, 'voice');
  if (!localPath) return false;
  const uploadRes = await ipc.zalo?.uploadVoiceFile?.({ auth, voicePath: localPath, threadId: target.threadId, type: target.threadType });
  const resp = uploadRes?.response;
  const uploadedUrl: string = resp?.fileUrl || resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.href || '';
  if (!uploadedUrl) throw new Error(uploadRes?.error || 'Tải tin thoại lên Zalo thất bại');
  const result = await ipc.zalo?.sendVoice({ auth, options: { voiceUrl: uploadedUrl }, threadId: target.threadId, type: target.threadType });
  ensureForwardSuccess(result, 'Không gửi được tin thoại Zalo');
  return true;
}

/**
 * Gửi lại tin dạng chữ / thẻ của Zalo theo đúng loại (xem forwardSupport.ts). Trả false nếu loại tin cần gửi
 * dạng media (xử lý ở sendOneForward).
 */
async function sendZaloStructuredForward(
  auth: any, msg: any, kind: ForwardKind, target: ForwardTarget,
  channel?: string, accountId?: string,
): Promise<boolean> {
  const toZalo = isZaloForwardTarget(channel);
  switch (kind) {
    case 'rtf': {
      // Chữ định dạng: giữ in đậm / nghiêng / màu / cỡ chữ / danh sách
      const { text, styles } = getZaloRichText(msg);
      if (!text) throw new Error('Tin nhắn không có nội dung để chuyển tiếp');
      if (toZalo && styles.length > 0) {
        const result = await ipc.zalo?.sendMessage({ auth, message: text, styles, threadId: target.threadId, type: target.threadType });
        ensureForwardSuccess(result, 'Không gửi được tin nhắn Zalo');
      } else {
        await sendForwardText(auth, channel, accountId, target, text);
      }
      return true;
    }
    case 'link': {
      const { url, text } = getZaloLinkInfo(msg);
      const fullText = !text ? url : (url && !text.includes(url) ? `${text}\n${url}` : text);
      if (!fullText) throw new Error('Tin nhắn link không có nội dung');
      if (toZalo && url) {
        // sendLink: 1 tin gồm chữ (chứa link) + khung xem trước, giống tin gốc
        const result = await ipc.zalo?.sendLink({ auth, url, message: text || undefined, threadId: target.threadId, type: target.threadType });
        if (result?.success) return true;
        // Không đọc được xem trước của link (parseLink lỗi, chưa gửi gì) → gửi dạng chữ, link vẫn bấm được
        console.warn('[Forward] sendLink lỗi → gửi dạng chữ:', result?.error);
      }
      await sendForwardText(auth, channel, accountId, target, fullText);
      return true;
    }
    case 'card': {
      const { userId, phone, name } = getZaloCardInfo(msg);
      if (toZalo && userId) {
        const result = await ipc.zalo?.sendCard({
          auth, options: { userId, ...(phone ? { phoneNumber: phone } : {}) }, threadId: target.threadId, type: target.threadType,
        });
        ensureForwardSuccess(result, 'Không gửi được danh thiếp Zalo');
        return true;
      }
      // Kênh khác không có danh thiếp Zalo → gửi tên + số điện thoại
      const cardText = [name && `👤 ${name}`, phone].filter(Boolean).join('\n');
      if (!cardText) throw new Error('Không đọc được danh thiếp');
      await sendForwardText(auth, channel, accountId, target, cardText);
      return true;
    }
    case 'sticker': {
      if (!toZalo) throw new Error('Sticker Zalo chỉ chuyển tiếp được sang Zalo');
      const stickerId = getZaloStickerId(msg);
      if (!stickerId) throw new Error('Không đọc được sticker');
      const result = await ipc.zalo?.sendSticker({ auth, stickerId, threadId: target.threadId, type: target.threadType });
      ensureForwardSuccess(result, 'Không gửi được sticker Zalo');
      return true;
    }
    default:
      return false;
  }
}

/**
 * Gửi một tin nguồn theo đúng loại. Caption nguồn được gửi thành một tin độc lập khi phải resend media.
 * Không dùng `forwardMessage` của zca-js cho media: API đó chỉ chuyển tiếp văn bản (message rỗng → lỗi).
 */
async function sendOneForward(
  auth: any, msg: any, target: ForwardTarget,
  channel?: string, accountId?: string, sourceAccountId?: string,
): Promise<void> {
  const plan = getForwardPlan(msg);
  const { kind } = plan;
  if (kind === 'unsupported') throw new Error(`${plan.reason || 'Loại tin nhắn này'} không chuyển tiếp được`);
  const caption = getForwardCaption(msg, kind);
  const toZalo = isZaloForwardTarget(channel);

  if (kind === 'text' || kind === 'location') {
    if (!caption) throw new Error('Loại tin nhắn này chưa có nội dung để chuyển tiếp');
    await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }

  if (isZalo(msg.channel) && await sendZaloStructuredForward(auth, msg, kind, target, channel, accountId)) return;

  // Video / tin thoại sang Zalo: tin xem / nghe được ngay, không phải tin file
  if (kind === 'video' && toZalo && await sendZaloVideoForward(auth, msg, getForwardLocalPath(msg, 'video'), target)) {
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }
  if (kind === 'voice' && toZalo && await sendZaloVoiceForward(auth, msg, target)) return;

  // Media còn lại: gửi lại từ file local (tải về nếu chưa có) để chuyển được giữa các tài khoản / kênh.
  const localPath = await ensureForwardLocalPath(msg, kind);
  if (localPath) {
    if (!toZalo) {
      if (!accountId) throw new Error('Không tìm thấy tài khoản gửi');
      const fileType = kind === 'image' ? 'image'
        : kind === 'video' ? (msg.msg_type === 'video_note' ? 'video_note' : 'video')
          : kind === 'voice' ? 'voice'
            : kind === 'sticker' ? 'sticker'
              : kind === 'animation' || kind === 'gif' ? 'animation'
                : 'file';
      const result = await getAdapter(channel as Channel).sendAttachment({
        accountId, threadId: target.threadId, filePath: localPath, threadType: target.threadType, fileType,
      });
      ensureForwardSuccess(result, 'Không gửi được tệp đính kèm');
    } else {
      // Ảnh / GIF (zca-js gửi .gif thành tin GIF) / sticker kênh khác dạng ảnh → sendImage; còn lại → file
      const asImage = (kind === 'image' || kind === 'gif' || kind === 'animation' || kind === 'sticker')
        && /\.(jpe?g|png|webp|gif)$/i.test(localPath);
      const result = asImage
        ? await ipc.zalo?.sendImage({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType, message: '' })
        : await ipc.zalo?.sendFile({ auth, filePath: localPath, threadId: target.threadId, type: target.threadType });
      ensureForwardSuccess(result, 'Không gửi được tệp đính kèm Zalo');
    }

    // Không nhét caption vào attachment: gửi riêng để giữ đúng thứ tự/behaviour
    // chung giữa các kênh, và không làm mất text khi chuyển nhiều message.
    if (caption) await sendForwardText(auth, channel, accountId, target, caption);
    return;
  }

  // Không có file local: Facebook / Telegram còn native forward trên đúng tài khoản nguồn.
  const canUseNativeForward = !sourceAccountId || sourceAccountId === accountId;
  if (!toZalo && canUseNativeForward && msg.msg_id && accountId) {
    if (isFacebook(channel)) {
      const result = await getAdapter(channel as Channel).forwardMessage({
        accountId, messageId: String(msg.msg_id), targetThreadId: target.threadId, threadType: target.threadType,
      });
      ensureForwardSuccess(result, 'Không chuyển tiếp được tin nhắn Facebook');
      return;
    }
    const sourceThreadId = msg.thread_id || msg.chat_id;
    if (!sourceThreadId) throw new Error('Tin nhắn Telegram không có hội thoại nguồn');
    const result = await getAdapter(channel as Channel).forwardMessage({
      accountId, messageId: String(msg.msg_id), targetThreadId: target.threadId, sourceThreadId: String(sourceThreadId), threadType: target.threadType,
    });
    ensureForwardSuccess(result, 'Không chuyển tiếp được tin nhắn Telegram');
    return;
  }
  throw new Error(isZalo(msg.channel)
    ? 'Không tải được tệp từ Zalo (link đã hết hạn?) nên không chuyển tiếp được'
    : 'Tệp chưa được tải về; không thể chuyển tiếp sang tài khoản khác');
}
