/**
 * Phần bình luận của bài đăng kênh Telegram, như Telegram: mở ngay trong khung chat (phủ lên kênh — danh sách bài vẫn
 * giữ nguyên bên dưới nên quay lại đúng vị trí bài đang xem, không bị cuộn xuống cuối).
 *
 * Bình luận nằm ở NHÓM THẢO LUẬN của kênh (main: telegramUser:getPostDiscussion) — trước đây bình luận bị lưu lẫn vào kênh
 * như bài đăng (thẻ "BÀI ĐĂNG KÊNH", ngược thứ tự, người gửi "U"). Ở đây: bài gốc trên cùng, "Bắt đầu thảo luận", bình
 * luận cũ → mới theo ngày, người gửi có ảnh / tên màu, trả lời bình luận khác có trích dẫn, tham gia nhóm khi nhóm bắt buộc
 * (hoặc gửi yêu cầu duyệt).
 *
 * Gửi = ô soạn tin của khung chat (MessageInput qua ComposerTargetContext): chữ, ảnh, video, tệp, ghi âm, sticker, GIF,
 * @nhắc tên, tin nhắn nhanh, dán / kéo thả ảnh, trả lời một bình luận — vào nhóm thảo luận, chủ đề = tin gốc. Bình luận
 * nằm trong store (khoá nhóm thảo luận + chủ đề) nên tin vừa gửi, file tải xong, cảm xúc đều cập nhật như khung chat.
 *
 * Mở như Telegram: chưa đọc bình luận nào → từ bình luận đầu tiên (bài gốc ở trên); còn bình luận chưa đọc → ngay vạch
 * "Bình luận chưa đọc"; đã đọc hết → mới nhất. Tải thêm hai chiều khi cuộn, bình luận hiện ra thì báo đã đọc
 * (messages.readDiscussion — lần mở sau bắt đầu đúng chỗ, điện thoại hết báo bình luận mới). Thả cảm xúc y như khung chat
 * (MessageReactionCorner dùng chung: nút ở góc dưới bong bóng, giữ chuột 300 ms là mở, bấm chip xem ai đã thả).
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { getTelegramPostMeta } from '@/lib/mediaResolver';
import { peerColorIndex } from '@/lib/chat/peerStyle';
import { formatDaySeparator } from '@/lib/chat/messageParser';
import { readDropPayload } from '@/lib/chat/dropFiles';
import { isFileType, isMediaType, isStickerType, isVideoType, isVoiceType } from '@/lib/chat/messageTypeUtils';
import {
  firstUnreadCommentId, isPendingComment, isUserCommentSender, mergeDiscussionComments, oldestCommentId, setOwnReaction,
  withPostCommentCount,
} from '@/lib/chat/telegramDiscussion';
import { getReactionChoices, sameReaction, useTelegramChatReactions } from '@/lib/chat/reactionChoices';
import { getMessageCacheKey, useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import PeerInitials from '@/components/common/PeerInitials';
import { UserProfilePopup } from '@/components/common/UserProfilePopup';
import MediaViewer, { type MediaViewerImage } from '../MediaViewer';
import VideoPlayer from '../VideoPlayer';
import FBVideoThumb from '../FBVideoThumb';
import MessageInput from '../MessageInput';
import { ComposerTargetContext, type ComposerTarget } from '../composerTarget';
import {
  FileBubble, MediaBubble, MediaGroupBubble, MsgActionBtn, StickerBubble, TelegramVideoPending, TextWithMentions, VoiceBubble,
  getGroupLayoutId, getTelegramVideoMedia,
} from '../ChatWindowBubbles';
import { ReactionPopup, parseReactions, parseReactionsFull } from '../ReactionComponents';
import { MessageReactionCorner, useReactionHoverPicker } from '../MessageReactionCorner';
import { formatBubbleTime, formatFullDateTime } from '../MessageTime';
import { TELEGRAM_POST_WIDTH, TelegramPostLayoutContext, formatTelegramPostCount, pickTelegramPostStats } from '../telegramPostLayout';
import { TelegramPostFooter } from './TelegramPostParts';
import TelegramRichMessageBody, { getRichMessageBlocks } from './TelegramRichMessageBody';

const PAGE_SIZE = 50;
const POLL_MS = 30_000;
/** Cuộn gần đáy hơn ngần này coi như đang ở cuối (bình luận mới về thì cuộn theo). */
const STICK_BOTTOM_PX = 120;
/** Còn cách đầu / cuối ngần này thì tải thêm. */
const LOAD_MORE_PX = 400;
/** Giữ vị trí mở đầu (vạch chưa đọc / bài gốc) trong lúc ảnh tải xong, tới khi người dùng tự cuộn hoặc hết thời gian. */
const ANCHOR_LOCK_MS = 4_000;
/** Bình luận hiện ra được bao lâu thì báo đã đọc (gom nhiều lần cuộn thành một lần gọi). */
const READ_DELAY_MS = 800;
/** Có tin mới trong nhóm thảo luận (mình vừa gửi / người khác bình luận) → lấy lại phần mới nhất sau ngần này. */
const LIVE_REFRESH_MS = 1_500;
const EMPTY_LIST: any[] = [];

type PageMode = 'initial' | 'older' | 'newer' | 'latest';
type Anchor = 'top' | 'unread' | 'bottom';

interface DiscussionMeta {
  chatId: string;
  rootId: string;
  title: string;
  avatar: string;
  isMember: boolean;
  canWrite: boolean;
  joinMode: 'none' | 'join' | 'request';
  reason: string;
  total: number;
  unreadCount: number;
  readInboxMaxId: number;
  maxId: number;
}

/** Bình luận: tin của nhóm thảo luận trong store (tải từ Telegram có thêm tên / ảnh người gửi; tin vừa gửi có id tạm). */
interface Comment {
  msg_id: string;
  owner_zalo_id?: string;
  thread_id: string;
  thread_type?: number;
  channel?: string;
  topic_id?: string | null;
  sender_id: string;
  sender_name?: string;
  sender_kind?: 'user' | 'chat';
  sender_avatar?: string;
  content: string;
  msg_type: string;
  timestamp: number;
  is_sent: number;
  attachments?: any;
  reactions?: any;
  local_paths?: any;
  reply_to_id?: string | null;
  is_edited?: number;
  temp_id?: string;
  real_msg_id?: string;
  send_status?: string;
}

function videoLocalPath(msg: any): string {
  try {
    const paths = typeof msg?.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg?.local_paths || {});
    const direct = paths.file || paths.video || paths.main || '';
    if (direct) return direct;
    const key = Object.keys(paths).find((item) => item.startsWith('att_'));
    return key ? paths[key] : '';
  } catch {
    return '';
  }
}

function commentSnippet(comment: Comment | undefined): string {
  if (!comment) return 'Bình luận';
  const text = String(comment.content || '').trim();
  if (text && !text.startsWith('{')) return text.replace(/\s+/g, ' ').slice(0, 120);
  const type = String(comment.msg_type || '');
  if (isVideoType(type) || type === 'gif') return 'Video';
  if (isVoiceType(type)) return 'Tin nhắn thoại';
  if (isStickerType(type)) return 'Sticker';
  if (type === 'photo' || type === 'image') return 'Hình ảnh';
  return 'Tệp đính kèm';
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function newestCommentId(comments: Comment[]): number {
  let newest = 0;
  for (const comment of comments) {
    const id = Number(comment.msg_id);
    if (!isPendingComment(comment) && Number.isSafeInteger(id) && id > newest) newest = id;
  }
  return newest;
}

/** Cảm xúc của mình trên bình luận (Telegram: mỗi người một) — null = chưa thả. */
function myReactionOf(reactions: unknown, accountId: string): string | null {
  const full = parseReactionsFull(reactions, 'telegram_user');
  return Object.entries(full.emoji || {}).find(([, entry]) => (entry as any)?.users?.[accountId] > 0)?.[0] || null;
}

function reactionErrorText(message: string): string {
  if (/REACTION_INVALID|REACTION_EMPTY/i.test(message)) return 'Nhóm thảo luận không cho thả cảm xúc này';
  if (/CHAT_WRITE_FORBIDDEN|USER_BANNED|CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE/i.test(message)) return 'Bạn không được thả cảm xúc trong nhóm thảo luận này';
  return `Không thả được cảm xúc${message ? `: ${message}` : ''}`;
}

/** Gắn vào App: hiện khi người dùng mở bình luận của một bài trong kênh đang mở. */
export function TelegramPostDiscussionHost({ activeAccountId, activeThreadId }: { activeAccountId: string | null; activeThreadId: string | null }) {
  const postDiscussion = useChatStore((state) => state.postDiscussion);
  const setPostDiscussion = useChatStore((state) => state.setPostDiscussion);
  if (!postDiscussion || postDiscussion.accountId !== activeAccountId || postDiscussion.channelId !== activeThreadId) return null;
  return (
    <TelegramPostDiscussion
      key={`${postDiscussion.accountId}:${postDiscussion.channelId}:${postDiscussion.postId}`}
      accountId={postDiscussion.accountId}
      channelId={postDiscussion.channelId}
      postId={postDiscussion.postId}
      onClose={() => setPostDiscussion(null)}
    />
  );
}

export default function TelegramPostDiscussion({ accountId, channelId, postId, onClose }: {
  accountId: string;
  channelId: string;
  postId: string;
  onClose: () => void;
}) {
  const [discussion, setDiscussion] = React.useState<DiscussionMeta | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [hasOlder, setHasOlder] = React.useState(false);
  const [hasNewer, setHasNewer] = React.useState(false);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [loadingNewer, setLoadingNewer] = React.useState(false);
  /** Mốc đã đọc lúc mở (vạch "Bình luận chưa đọc" đứng yên tới khi đóng, như Telegram) */
  const [unreadFrom, setUnreadFrom] = React.useState<number | null>(null);
  const [showJump, setShowJump] = React.useState(false);
  /** Lỗi thả cảm xúc / tham gia nhóm (gửi tin: ô soạn tin tự báo như khung chat) */
  const [actionError, setActionError] = React.useState('');
  const [joinState, setJoinState] = React.useState<'idle' | 'joining' | 'requested' | 'failed'>('idle');
  const [viewer, setViewer] = React.useState<{ images: MediaViewerImage[]; index: number } | null>(null);
  const [video, setVideo] = React.useState<any | null>(null);
  /** Bảng "ai đã thả cảm xúc" của một bình luận (như khung chat) */
  const [reactorsFor, setReactorsFor] = React.useState<{ comment: Comment; emoji: string } | null>(null);
  /** Hồ sơ người bình luận (bấm ảnh / tên, như trong nhóm) */
  const [profileFor, setProfileFor] = React.useState<{ userId: string; x: number; y: number } | null>(null);
  // Thanh chọn cảm xúc: dùng chung hẹn giờ với khung chat (giữ chuột 300 ms mở, rời 250 ms đóng)
  const reactionHover = useReactionHoverPicker();

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const stickBottomRef = React.useRef(false);
  const prependAnchorRef = React.useRef<{ height: number; top: number } | null>(null);
  /** Vị trí mở đầu cần áp sau lần vẽ kế tiếp / còn giữ trong lúc ảnh tải (tới khi người dùng tự cuộn). */
  const pendingAnchorRef = React.useRef<Anchor | null>(null);
  const lockedAnchorRef = React.useRef<Anchor | null>(null);
  const lockTimerRef = React.useRef<number>(0);
  const readSentRef = React.useRef(0);
  const readTimerRef = React.useRef<number>(0);
  const liveRefreshTimerRef = React.useRef<number>(0);
  const discussionRef = React.useRef<DiscussionMeta | null>(null);
  discussionRef.current = discussion;
  const hasOlderRef = React.useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const hasNewerRef = React.useRef(hasNewer);
  hasNewerRef.current = hasNewer;
  const loadingOlderRef = React.useRef(false);
  const loadingNewerRef = React.useRef(false);

  // ── Bình luận = tin của nhóm thảo luận trong store, khoá theo chủ đề (tin gốc) ────────────────────────────────────
  const topicKey = discussion ? getMessageCacheKey(accountId, discussion.chatId, discussion.rootId) : '';
  const storeComments = useChatStore((state) => (topicKey ? state.messages[topicKey] : undefined)) as Comment[] | undefined;
  const comments: Comment[] = storeComments ?? EMPTY_LIST;
  /** Bản gần nhất (store bỏ bớt hội thoại cũ khi giữ quá 20 → khôi phục ngay, không để trống phần bình luận). */
  const lastCommentsRef = React.useRef<Comment[]>([]);
  if (storeComments) lastCommentsRef.current = storeComments;
  const commentsRef = React.useRef<Comment[]>(comments);
  commentsRef.current = comments;

  const writeComments = React.useCallback((meta: DiscussionMeta, update: (current: Comment[]) => Comment[]) => {
    const store = useChatStore.getState();
    const key = getMessageCacheKey(accountId, meta.chatId, meta.rootId);
    const current = (store.messages[key] as Comment[] | undefined) ?? lastCommentsRef.current;
    const next = update(current);
    lastCommentsRef.current = next;
    store.setMessages(accountId, meta.chatId, next as any, meta.rootId);
  }, [accountId]);

  React.useEffect(() => {
    if (!discussion || storeComments || !lastCommentsRef.current.length) return;
    useChatStore.getState().setMessages(accountId, discussion.chatId, lastCommentsRef.current as any, discussion.rootId);
  }, [accountId, discussion, storeComments]);

  // Cảm xúc nhóm thảo luận cho phép (tải khi mở thanh chọn)
  const groupReactions = useTelegramChatReactions(accountId, discussion?.chatId, !!discussion?.chatId);
  const reactionChoices = React.useMemo(() => getReactionChoices('telegram_user', groupReactions.reactions).all, [groupReactions.reactions]);

  // Bài gốc trong kênh (đang có trong store vì người dùng mở từ kênh) + các ảnh cùng album
  const channelMsgs = useChatStore((state) => state.messages[getMessageCacheKey(accountId, channelId, null)]);
  const { post, album } = React.useMemo(() => {
    const list = channelMsgs || [];
    const found = list.find((msg) => String(msg.msg_id) === String(postId)) || null;
    if (!found) return { post: null, album: [] as any[] };
    const layoutId = getGroupLayoutId(found);
    const siblings = layoutId ? list.filter((msg) => getGroupLayoutId(msg) === layoutId) : [found];
    return { post: found, album: siblings.length ? siblings : [found] };
  }, [channelMsgs, postId]);

  // Tên / ảnh người gửi: tải từ Telegram kèm tin; tin về trực tiếp / vừa gửi thì tra danh bạ + thành viên nhóm đã biết
  const accountContacts = useChatStore((state) => state.contacts[accountId]) ?? EMPTY_LIST;
  const groupCacheMembers = useAppStore((state) => (discussion?.chatId ? (state as any).groupInfoCache?.[accountId]?.[discussion.chatId]?.members : undefined)) ?? EMPTY_LIST;
  const profiles = React.useMemo(() => {
    const known = new Map<string, { userId: string; displayName: string; avatar: string }>();
    for (const member of groupCacheMembers) {
      const id = String(member?.userId || member?.id || '');
      if (id) known.set(id, { userId: id, displayName: member?.displayName || '', avatar: member?.avatar || '' });
    }
    for (const comment of comments) {
      if (comment.sender_id && comment.sender_name && !known.has(comment.sender_id)) {
        known.set(comment.sender_id, { userId: comment.sender_id, displayName: comment.sender_name, avatar: comment.sender_avatar || '' });
      }
    }
    return known;
  }, [groupCacheMembers, comments]);
  const reactorProfiles = React.useMemo(() => Array.from(profiles.values()), [profiles]);
  const senderOf = (comment: Comment) => {
    const known = profiles.get(comment.sender_id);
    const contact = accountContacts.find((item: any) => String(item.contact_id) === String(comment.sender_id));
    return {
      name: comment.sender_name || known?.displayName || contact?.alias || contact?.display_name || comment.sender_id,
      avatar: comment.sender_avatar || known?.avatar || contact?.avatar_url || '',
    };
  };

  const fetchPage = React.useCallback((mode: PageMode, offsetId = 0) => (
    ipc.telegramUser?.getPostDiscussion?.({ accountId, channelId, postId, mode, offsetId: offsetId || undefined, limit: PAGE_SIZE })
      ?? Promise.resolve(undefined)
  ), [accountId, channelId, postId]);

  const releaseAnchorLock = React.useCallback(() => {
    lockedAnchorRef.current = null;
    if (lockTimerRef.current) window.clearTimeout(lockTimerRef.current);
    lockTimerRef.current = 0;
  }, []);

  /** initial / jump = thay toàn bộ (giữ tin đang gửi); còn lại gộp trang vào danh sách. */
  const applyResult = React.useCallback((result: any, mode: PageMode | 'jump') => {
    if (!result?.success || !result.discussion) return false;
    const meta = result.discussion as DiscussionMeta;
    discussionRef.current = meta;
    setDiscussion(meta);
    const incoming = (result.comments || []) as Comment[];
    if (mode === 'initial' || mode === 'jump') {
      const anchor: Anchor = mode === 'jump' ? 'bottom' : (result.anchor || 'bottom');
      writeComments(meta, (current) => mergeDiscussionComments(current.filter(isPendingComment), incoming));
      setHasOlder(anchor === 'top' ? false : result.hasOlder ?? incoming.length >= PAGE_SIZE);
      setHasNewer(mode === 'jump' ? false : !!result.hasNewer);
      if (mode === 'initial') setUnreadFrom(anchor === 'unread' ? Number(meta.readInboxMaxId) || null : null);
      readSentRef.current = Math.max(readSentRef.current, Number(meta.readInboxMaxId) || 0);
      pendingAnchorRef.current = anchor;
      stickBottomRef.current = anchor === 'bottom' && !(mode === 'initial' && result.hasNewer);
      releaseAnchorLock();
      if (anchor !== 'bottom') {
        lockedAnchorRef.current = anchor;
        lockTimerRef.current = window.setTimeout(releaseAnchorLock, ANCHOR_LOCK_MS);
      }
    } else if (mode === 'older') {
      const scroller = scrollRef.current;
      if (scroller) prependAnchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
      writeComments(meta, (current) => mergeDiscussionComments(current, incoming));
      if (result.hasOlder != null) setHasOlder(!!result.hasOlder);
    } else {
      // newer / latest: thêm ở dưới (làm mới định kỳ cũng cập nhật sửa / cảm xúc của các bình luận mới nhất)
      writeComments(meta, (current) => mergeDiscussionComments(current, incoming));
      if (mode === 'newer' && result.hasNewer != null) setHasNewer(!!result.hasNewer);
    }
    // Số bình luận của bài trong kênh = số thật của phần bình luận (trước đây lệch với Telegram)
    const store = useChatStore.getState();
    const target = (store.messages[getMessageCacheKey(accountId, channelId, null)] || []).find((msg) => String(msg.msg_id) === String(postId));
    if (target) {
      const raw = typeof target.attachments === 'string' ? target.attachments : JSON.stringify(target.attachments || []);
      const attachments = withPostCommentCount(raw, meta.total);
      if (attachments) store.patchMessage(accountId, channelId, String(postId), { attachments } as any);
    }
    return true;
  }, [accountId, channelId, postId, releaseAnchorLock, writeComments]);

  // ── Báo đã đọc: bình luận mới nhất đang hiện trên màn hình (cửa sổ đang dùng, như Telegram) ────────────────────────
  const markVisibleRead = React.useCallback(async () => {
    const meta = discussionRef.current;
    const scroller = scrollRef.current;
    if (!meta || !scroller || document.hidden || !document.hasFocus()) return;
    const bottom = scroller.getBoundingClientRect().bottom;
    const nodes = scroller.querySelectorAll<HTMLElement>('[data-comment-id]');
    let newest = 0;
    for (let index = nodes.length - 1; index >= 0; index--) {
      if (nodes[index].getBoundingClientRect().top < bottom - 8) {
        newest = Number(nodes[index].dataset.commentId) || 0;
        break;
      }
    }
    if (!newest || newest <= readSentRef.current) return;
    const previous = readSentRef.current;
    readSentRef.current = newest;
    try {
      const result = await ipc.telegramUser?.readPostDiscussion?.({
        accountId, chatId: meta.chatId, rootId: meta.rootId, readMaxId: newest, channelId, postId,
      });
      if (!result?.success) {
        if (readSentRef.current === newest) readSentRef.current = previous;
        return;
      }
      if (result.attachments) useChatStore.getState().patchMessage(accountId, channelId, String(postId), { attachments: result.attachments } as any);
    } catch {
      if (readSentRef.current === newest) readSentRef.current = previous;
    }
  }, [accountId, channelId, postId]);

  const scheduleReadCheck = React.useCallback(() => {
    if (readTimerRef.current) return;
    readTimerRef.current = window.setTimeout(() => {
      readTimerRef.current = 0;
      void markVisibleRead();
    }, READ_DELAY_MS);
  }, [markVisibleRead]);

  React.useEffect(() => {
    const onFocus = () => scheduleReadCheck();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (readTimerRef.current) window.clearTimeout(readTimerRef.current);
      if (lockTimerRef.current) window.clearTimeout(lockTimerRef.current);
      if (liveRefreshTimerRef.current) window.clearTimeout(liveRefreshTimerRef.current);
    };
  }, [scheduleReadCheck]);

  // ── Mở đầu + làm mới 30 s / lần (chỉ khi đang ở phần mới nhất — chưa tải tới cuối thì làm mới sẽ để hở khoảng giữa) ──
  const refreshLatest = React.useCallback(() => {
    if (document.hidden || !discussionRef.current || hasNewerRef.current) return;
    void fetchPage('latest').then((result) => applyResult(result, 'latest'));
  }, [applyResult, fetchPage]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void fetchPage('initial').then((result) => {
      if (cancelled) return;
      const ok = applyResult(result, 'initial');
      setLoading(false);
      if (!ok) setError(result?.error || 'Không tải được bình luận');
    });
    const timer = window.setInterval(() => { if (!cancelled) refreshLatest(); }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fetchPage, applyResult, refreshLatest]);

  const retry = () => {
    setLoading(true);
    setError('');
    void fetchPage('initial').then((result) => {
      const ok = applyResult(result, 'initial');
      setLoading(false);
      if (!ok) setError(result?.error || 'Không tải được bình luận');
    });
  };

  // Tin mới trong nhóm thảo luận (mình vừa gửi — echo của Telegram; hoặc người khác bình luận khi mình là thành viên) →
  // lấy lại phần mới nhất: đúng chỗ trong chuỗi bình luận, đủ tên / ảnh người gửi. Ảnh đại diện người bình luận tải nền.
  React.useEffect(() => {
    const offMessage = ipc.on?.('event:message', (data: any) => {
      const group = discussionRef.current?.chatId;
      if (!group || String(data?.zaloId || '') !== accountId || String(data?.message?.threadId || '') !== group) return;
      if (liveRefreshTimerRef.current) window.clearTimeout(liveRefreshTimerRef.current);
      liveRefreshTimerRef.current = window.setTimeout(() => {
        liveRefreshTimerRef.current = 0;
        refreshLatest();
      }, LIVE_REFRESH_MS);
    });
    const offAvatar = ipc.on?.('event:groupMemberAvatar', (data: any) => {
      const meta = discussionRef.current;
      if (!meta || String(data?.zaloId || '') !== accountId || String(data?.groupId || '') !== meta.chatId || !data?.avatar) return;
      const memberId = String(data.memberId || '');
      if (!commentsRef.current.some((comment) => comment.sender_id === memberId && !comment.sender_avatar)) return;
      writeComments(meta, (current) => current.map((comment) => (
        comment.sender_id === memberId && !comment.sender_avatar ? { ...comment, sender_avatar: data.avatar } : comment
      )));
    });
    return () => {
      if (typeof offMessage === 'function') offMessage();
      if (typeof offAvatar === 'function') offAvatar();
    };
  }, [accountId, refreshLatest, writeComments]);

  // Esc = đóng bảng cảm xúc / thanh chọn / bỏ trả lời / quay lại kênh (khi không mở trình xem ảnh / video)
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || viewer || video) return;
      if (profileFor) {
        setProfileFor(null);
        return;
      }
      if (reactorsFor) {
        setReactorsFor(null);
        return;
      }
      if (reactionHover.openId) {
        reactionHover.close();
        return;
      }
      const chat = useChatStore.getState();
      if (chat.replyTo) {
        chat.setReplyTo(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, viewer, video, profileFor, reactorsFor, reactionHover.openId, reactionHover.close]);

  // ── Vị trí cuộn ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const applyAnchor = React.useCallback((anchor: Anchor) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (anchor === 'top') {
      scroller.scrollTop = 0;
      return;
    }
    const divider = anchor === 'unread' ? scroller.querySelector<HTMLElement>('[data-unread-divider]') : null;
    if (divider) {
      scroller.scrollTop = scroller.scrollTop + (divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - 8;
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }, []);

  /** Đang ở cuối? (bám cuối khi bình luận mới về) + nút ↓ — tính lại sau mỗi lần cuộn / đặt vị trí. */
  const syncScrollState = React.useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return 0;
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickBottomRef.current = !hasNewerRef.current && fromBottom < STICK_BOTTOM_PX;
    setShowJump(hasNewerRef.current || fromBottom > 600);
    return fromBottom;
  }, []);

  React.useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || loading) return;
    const prepend = prependAnchorRef.current;
    if (prepend) {
      prependAnchorRef.current = null;
      scroller.scrollTop = prepend.top + (scroller.scrollHeight - prepend.height);
      return;
    }
    const pending = pendingAnchorRef.current;
    if (pending) {
      pendingAnchorRef.current = null;
      applyAnchor(pending);
      syncScrollState();
      scheduleReadCheck();
      return;
    }
    if (stickBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
      // Bình luận mới về khi đang đọc ở cuối → cũng tính đã đọc
      scheduleReadCheck();
    }
  }, [comments, loading, hasOlder, applyAnchor, scheduleReadCheck, syncScrollState]);

  // Ảnh / video tải xong làm nội dung đổi cao: còn giữ vị trí mở đầu thì giữ, đang ở cuối thì bám cuối
  React.useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (prependAnchorRef.current || pendingAnchorRef.current) return;
      if (lockedAnchorRef.current) applyAnchor(lockedAnchorRef.current);
      else if (stickBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [applyAnchor]);

  const loadOlder = React.useCallback(async () => {
    if (loadingOlderRef.current || !hasOlderRef.current) return;
    const offsetId = oldestCommentId(commentsRef.current.filter((comment) => !isPendingComment(comment)));
    if (!offsetId) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      applyResult(await fetchPage('older', offsetId), 'older');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [applyResult, fetchPage]);

  const loadNewer = React.useCallback(async () => {
    if (loadingNewerRef.current || !hasNewerRef.current) return;
    const offsetId = newestCommentId(commentsRef.current);
    if (!offsetId) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    try {
      applyResult(await fetchPage('newer', offsetId), 'newer');
    } finally {
      loadingNewerRef.current = false;
      setLoadingNewer(false);
    }
  }, [applyResult, fetchPage]);

  /** Nút ↓: chưa tải tới cuối thì tải trang mới nhất (bỏ khoảng giữa), đã có thì cuộn xuống. */
  const jumpToLatest = React.useCallback(async () => {
    releaseAnchorLock();
    const scroller = scrollRef.current;
    if (!hasNewerRef.current) {
      stickBottomRef.current = true;
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      return;
    }
    applyResult(await fetchPage('latest'), 'jump');
  }, [applyResult, fetchPage, releaseAnchorLock]);

  // Mình vừa gửi bình luận (ô soạn tin thêm tin tạm ở cuối): như Telegram, nhảy xuống cuối để thấy tin vừa gửi
  const lastSentRef = React.useRef('');
  React.useEffect(() => {
    const last = comments[comments.length - 1];
    if (!last || !last.is_sent || !last.temp_id || lastSentRef.current === last.msg_id) return;
    lastSentRef.current = last.msg_id;
    releaseAnchorLock();
    stickBottomRef.current = true;
    if (hasNewerRef.current) void jumpToLatest();
  }, [comments, jumpToLatest, releaseAnchorLock]);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const fromBottom = syncScrollState();
    if (scroller.scrollTop < LOAD_MORE_PX) void loadOlder();
    if (fromBottom < LOAD_MORE_PX) void loadNewer();
    scheduleReadCheck();
  };

  // ── Tham gia nhóm thảo luận (nhóm bắt buộc tham gia mới được bình luận) ────────────────────────────────────────────
  const join = async () => {
    const meta = discussionRef.current;
    if (!meta || joinState === 'joining') return;
    setJoinState('joining');
    setActionError('');
    try {
      const result = await ipc.telegramUser?.joinGroup?.({ accountId, chatId: meta.chatId });
      if (!result?.success) {
        setJoinState('failed');
        setActionError(result?.error || 'Không tham gia được nhóm thảo luận');
        return;
      }
      if (result.requested) {
        setJoinState('requested');
        return;
      }
      setJoinState('idle');
      applyResult(await fetchPage(hasNewerRef.current ? 'newer' : 'latest', hasNewerRef.current ? newestCommentId(commentsRef.current) : 0), 'latest');
    } catch (err: any) {
      setJoinState('failed');
      setActionError(err?.message || 'Không tham gia được nhóm thảo luận');
    }
  };

  // ── Cảm xúc ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const react = React.useCallback(async (comment: Comment, emoji: string) => {
    const meta = discussionRef.current;
    if (!meta || isPendingComment(comment) || !emoji) return;
    const remove = sameReaction(emoji, myReactionOf(comment.reactions, accountId));
    const before = comment.reactions;
    setActionError('');
    writeComments(meta, (current) => current.map((item) => (
      item.msg_id === comment.msg_id ? { ...item, reactions: setOwnReaction(item.reactions as any, accountId, remove ? '' : emoji) } : item
    )));
    try {
      const result = await ipc.telegramUser?.sendReaction?.({
        accountId, chatId: meta.chatId, messageId: comment.msg_id, emoji: remove ? undefined : emoji,
      });
      if (!result?.success) throw new Error(result?.error || '');
    } catch (err: any) {
      writeComments(meta, (current) => current.map((item) => (item.msg_id === comment.msg_id ? { ...item, reactions: before } : item)));
      setActionError(reactionErrorText(String(err?.message || '')));
    }
  }, [accountId, writeComments]);

  // ── Xem ảnh / video ─────────────────────────────────────────────────────────────────────────────────────────────────
  const openImage = React.useCallback((url: string) => {
    if (url) setViewer({ images: [{ src: url, displaySrc: url }], index: 0 });
  }, []);
  const openImages = React.useCallback((images: MediaViewerImage[], index: number) => {
    if (images.length) setViewer({ images, index });
  }, []);
  const playVideo = React.useCallback((msg: any) => {
    const localPath = videoLocalPath(msg);
    if (!localPath) return;
    const media = getTelegramVideoMedia(msg);
    setVideo({ localPath, width: media?.width || undefined, height: media?.height || undefined, duration: media?.duration || undefined, msgId: msg.msg_id, threadId: msg.thread_id });
  }, []);

  // Ô soạn tin của khung chat, gửi vào nhóm thảo luận / chuỗi bình luận
  const composerTarget = React.useMemo<ComposerTarget | null>(() => (discussion ? {
    kind: 'telegramComments',
    accountId,
    threadId: discussion.chatId,
    threadType: 1,
    topicId: discussion.rootId,
    contact: {
      contact_id: discussion.chatId, channel: 'telegram_user', contact_type: 'group', display_name: discussion.title,
      avatar_url: discussion.avatar, telegram_peer_type: 'supergroup',
    },
    placeholder: 'Viết bình luận… (Enter gửi, Shift+Enter xuống dòng)',
  } : null), [accountId, discussion?.chatId, discussion?.rootId, discussion?.title, discussion?.avatar]);

  const byId = React.useMemo(() => new Map(comments.map((comment) => [String(comment.msg_id), comment])), [comments]);
  const unreadDividerId = React.useMemo(
    () => firstUnreadCommentId(comments.filter((comment) => !isPendingComment(comment)), unreadFrom),
    [comments, unreadFrom],
  );
  const total = Math.max(discussion?.total || 0, comments.filter((comment) => !isPendingComment(comment)).length);

  const renderContent = (comment: Comment) => {
    const type = String(comment.msg_type || '');
    const isSent = !!comment.is_sent;
    if (getRichMessageBlocks(comment)) return { boxed: true, node: <TelegramRichMessageBody msg={comment} onOpenImages={openImages} /> };
    if (isStickerType(type)) return { boxed: false, node: <StickerBubble msg={comment} /> };
    if (isVideoType(type) || type === 'gif') {
      const path = videoLocalPath(comment);
      const media = getTelegramVideoMedia(comment);
      const node = path
        ? <FBVideoThumb videoPath={path} onPlay={() => playVideo(comment)} dimsMsg={comment} width={media?.width || undefined}
            height={media?.height || undefined} placeholderSrc={media?.thumb || undefined} duration={media?.duration || undefined} />
        : <TelegramVideoPending msg={comment} onPlay={(downloaded) => playVideo(downloaded)} />;
      const caption = String(comment.content || '').trim();
      return {
        boxed: false,
        node: (
          <div className="flex max-w-xs flex-col gap-1">
            {node}
            {caption && !caption.startsWith('{') && !/^🎬/.test(caption) && <div className="text-sm break-words"><TextWithMentions text={caption} channel="telegram_user" /></div>}
          </div>
        ),
      };
    }
    if (isVoiceType(type)) return { boxed: false, node: <VoiceBubble msg={comment} isSent={isSent} /> };
    if (isMediaType(type, comment.content, typeof comment.attachments === 'string' ? comment.attachments : undefined)) {
      return { boxed: false, node: <MediaBubble msg={comment} onView={openImage} isSent={isSent} /> };
    }
    if (isFileType(type, comment.content, typeof comment.attachments === 'string' ? comment.attachments : undefined) || type === 'file') {
      return { boxed: false, node: <FileBubble msg={comment} isSent={isSent} /> };
    }
    return {
      boxed: true,
      node: <div className="text-sm whitespace-pre-wrap break-words"><TextWithMentions text={String(comment.content || '')} channel="telegram_user" /></div>,
    };
  };

  const daySeparator = (timestamp: number) => (
    <div className="my-2 flex w-full justify-center">
      <span className="rounded-full bg-black/20 px-2.5 py-0.5 text-[11px] text-white dark:bg-white/15">{formatDaySeparator(timestamp)}</span>
    </div>
  );

  const renderComment = (comment: Comment, index: number) => {
    const previous = index > 0 ? comments[index - 1] : null;
    const next = index < comments.length - 1 ? comments[index + 1] : null;
    const isSent = !!comment.is_sent;
    const pending = isPendingComment(comment);
    const failed = comment.send_status === 'failed' || comment.send_status === 'timeout';
    const numericId = /^\d+$/.test(String(comment.msg_id)) ? String(comment.msg_id) : undefined;
    const newDay = !previous || dayKey(previous.timestamp) !== dayKey(comment.timestamp);
    const unreadHere = comment.msg_id === unreadDividerId;
    const startsRun = newDay || unreadHere || !previous || previous.sender_id !== comment.sender_id || comment.timestamp - previous.timestamp > 5 * 60_000;
    const endsRun = !next || next.sender_id !== comment.sender_id || dayKey(next.timestamp) !== dayKey(comment.timestamp)
      || next.timestamp - comment.timestamp > 5 * 60_000 || next.msg_id === unreadDividerId;
    const unreadDivider = unreadHere ? (
      <div data-unread-divider className="-mx-3 my-2 bg-primary/10 py-1 text-center text-xs font-medium text-primary select-none">
        Bình luận chưa đọc
      </div>
    ) : null;
    if (comment.msg_type === 'system') {
      return (
        <React.Fragment key={comment.msg_id}>
          {newDay && daySeparator(comment.timestamp)}
          {unreadDivider}
          <div className="my-1.5 flex justify-center" data-comment-id={numericId}>
            <span className="max-w-[80%] rounded-full bg-black/15 px-2.5 py-0.5 text-center text-[11px] text-white dark:bg-white/10">{comment.content}</span>
          </div>
        </React.Fragment>
      );
    }
    const sender = senderOf(comment);
    const color = peerColorIndex(comment.sender_id, sender.name) ?? 5;
    // Trả lời một bình luận khác (trả lời thẳng vào bài = tin gốc thì không có trích dẫn)
    const replyId = comment.reply_to_id && String(comment.reply_to_id) !== String(discussion?.rootId) ? String(comment.reply_to_id) : '';
    const replied = replyId ? byId.get(replyId) : undefined;
    const repliedName = replied ? (replied.is_sent ? 'Bạn' : senderOf(replied).name) : 'Bình luận';
    const reactionCounts = parseReactions(comment.reactions, 'telegram_user');
    const hasReactions = Object.values(reactionCounts).some((count) => count > 0);
    const mine = myReactionOf(comment.reactions, accountId);
    const { boxed, node } = renderContent(comment);
    const avatar = sender.avatar ? toLocalMediaUrl(sender.avatar) : '';
    // Bấm ảnh / tên người bình luận → hồ sơ Telegram như trong nhóm
    const openProfile = isUserCommentSender(comment)
      ? (event: React.MouseEvent) => {
        event.stopPropagation();
        setProfileFor({ userId: String(comment.sender_id), x: event.clientX, y: event.clientY });
      }
      : undefined;
    const avatarNode = avatar
      ? <img src={avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
      : <PeerInitials id={comment.sender_id} name={sender.name} className="h-8 w-8 text-xs" />;
    const time = (
      <span className={`ml-2 inline-flex shrink-0 items-center gap-1 align-bottom text-[11px] leading-4 select-none ${failed ? 'text-red-500' : 'text-subtle-foreground'}`} title={formatFullDateTime(comment.timestamp)}>
        {comment.is_edited ? 'đã sửa' : ''}
        {failed ? 'Gửi lỗi' : pending ? 'Đang gửi…' : formatBubbleTime(comment.timestamp)}
      </span>
    );
    return (
      <React.Fragment key={comment.msg_id}>
        {newDay && daySeparator(comment.timestamp)}
        {unreadDivider}
        <div
          data-comment-id={numericId}
          data-out={isSent ? '' : undefined}
          className={`group/msg flex items-end gap-2 ${isSent ? 'flex-row-reverse' : ''} ${endsRun ? 'mb-2' : 'mb-0.5'}`}
        >
          {!isSent && (
            <div className="h-8 w-8 shrink-0">
              {endsRun && (openProfile ? (
                <button type="button" onClick={openProfile} title={`Xem thông tin: ${sender.name}`}
                  className="h-8 w-8 overflow-hidden rounded-full transition-all hover:ring-2 hover:ring-blue-400 focus:outline-none">
                  {avatarNode}
                </button>
              ) : avatarNode)}
            </div>
          )}
          <div className={`relative flex min-w-0 max-w-[min(30rem,85%)] flex-col ${isSent ? 'items-end' : 'items-start'}${hasReactions ? ' mb-3' : ''}`}>
            <div className={`min-w-0 max-w-full overflow-hidden rounded-lg ${boxed || replyId || (startsRun && !isSent)
              ? `${isSent ? 'bg-bubble-out border-bubble-out-border' : 'bg-bubble-in border-bubble-in-border'} border px-3 py-1.5`
              : ''}${pending ? ' opacity-70' : ''}`}>
              {startsRun && !isSent && (openProfile ? (
                <button type="button" onClick={openProfile}
                  className={`chat-peer-${color} chat-peer-name block max-w-full truncate text-left text-[13px] font-semibold leading-5 hover:underline`}>
                  {sender.name}
                </button>
              ) : (
                <div className={`chat-peer-${color} chat-peer-name truncate text-[13px] font-semibold leading-5`}>{sender.name}</div>
              ))}
              {replyId && (
                <div className={`mb-1 rounded border-l-[3px] px-2 py-0.5 text-xs ${replied ? `chat-peer-${peerColorIndex(replied.sender_id, repliedName) ?? 5} chat-peer-quote` : 'border-foreground/20 bg-foreground/[0.04]'}`}>
                  <div className="truncate font-semibold chat-peer-name">{repliedName}</div>
                  <div className="truncate text-foreground/80">{commentSnippet(replied)}</div>
                </div>
              )}
              <div className={boxed ? 'flex flex-wrap items-end justify-end' : ''}>
                <div className={boxed ? 'min-w-0 flex-1' : ''}>{node}</div>
                {boxed && time}
              </div>
              {!boxed && <div className="mt-0.5 flex justify-end">{time}</div>}
            </div>
            {/* Nút / chip cảm xúc ở góc dưới bong bóng — y như khung chat (giữ chuột 300 ms mở thanh chọn, bấm chip xem ai thả) */}
            {numericId && (
              <MessageReactionCorner
                isSent={isSent}
                counts={reactionCounts}
                myEmoji={mine}
                variant="chips"
                pickerOpen={reactionHover.openId === comment.msg_id}
                pickerEmojis={reactionChoices}
                onArm={() => reactionHover.arm(comment.msg_id, groupReactions.load)}
                onLeave={reactionHover.scheduleClose}
                onOpenPicker={() => {
                  reactionHover.open(comment.msg_id);
                  groupReactions.load();
                }}
                onPick={(emoji) => {
                  reactionHover.close();
                  void react(comment, emoji);
                }}
                onShowReactors={(emoji) => setReactorsFor({ comment, emoji })}
              />
            )}
          </div>
          {/* Thao tác khi rê chuột, như khung chat: trả lời bình luận (ô soạn tin bên dưới hiện trích dẫn) */}
          {numericId && discussion?.canWrite && (
            <div className="flex items-center gap-0.5 self-end mb-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100 flex-shrink-0 flex-nowrap">
              <MsgActionBtn
                title="Trả lời"
                onClick={() => useChatStore.getState().setReplyTo(comment as any)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
                </svg>
              </MsgActionBtn>
            </div>
          )}
        </div>
      </React.Fragment>
    );
  };

  const renderPost = () => {
    if (!post) return null;
    const stats = pickTelegramPostStats(album.map((msg) => ({ msgId: String(msg.msg_id), meta: getTelegramPostMeta(msg) })));
    const type = String(post.msg_type || '');
    const isAlbum = album.length > 1;
    const isVideo = !isAlbum && (isVideoType(type) || type === 'gif');
    const isPhoto = !isAlbum && !isVideo && isMediaType(type, post.content, post.attachments);
    const rich = getRichMessageBlocks(post);
    const caption = String(post.content || '').trim();
    let media: React.ReactNode = null;
    if (isAlbum) media = <MediaGroupBubble msgs={album} onView={openImage} onVideoPlay={playVideo} />;
    else if (isPhoto) media = <MediaBubble msg={post} onView={openImage} />;
    else if (isVideo) {
      const path = videoLocalPath(post);
      const info = getTelegramVideoMedia(post);
      media = path
        ? <FBVideoThumb videoPath={path} onPlay={() => playVideo(post)} dimsMsg={post} width={info?.width || undefined} height={info?.height || undefined}
            placeholderSrc={info?.thumb || undefined} duration={info?.duration || undefined} />
        : <TelegramVideoPending msg={post} onPlay={(downloaded) => playVideo(downloaded)} />;
    }
    // Ảnh / album tự vẽ chú thích; video / chữ: chú thích vẽ ở đây
    const showText = !isAlbum && !isPhoto && (rich || (caption && !caption.startsWith('{')));
    return (
      <div className="mb-2 flex justify-start">
        <div className="overflow-hidden rounded-lg border border-bubble-in-border bg-bubble-in" style={{ width: TELEGRAM_POST_WIDTH }}>
          {media && <TelegramPostLayoutContext.Provider value>{media}</TelegramPostLayoutContext.Provider>}
          {showText && (
            <div className="px-3 pt-2 text-sm break-words">
              {rich ? <TelegramRichMessageBody msg={post} onOpenImages={openImages} /> : <div className="whitespace-pre-wrap"><TextWithMentions text={caption} channel={post.channel} /></div>}
            </div>
          )}
          <TelegramPostFooter postAuthor={stats?.postAuthor} views={stats?.views || 0} edited={post.is_edited === 1} timestamp={post.timestamp} />
        </div>
      </div>
    );
  };

  const meta = discussion;
  const releaseOnUserScroll = () => {
    if (lockedAnchorRef.current) releaseAnchorLock();
  };
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background" onClick={(event) => event.stopPropagation()}>
      {/* Đầu: quay lại kênh, "Bình luận" + số, tên nhóm thảo luận */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2 py-1.5">
        <button type="button" onClick={onClose} title="Quay lại bài đăng (Esc)"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="15 6 9 12 15 18" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {total > 0 ? `${formatTelegramPostCount(total)} bình luận` : 'Bình luận'}
          </div>
          {meta?.title && <div className="truncate text-[11px] text-muted-foreground">{meta.title}</div>}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Đang tải thêm: nổi trên danh sách (không đẩy nội dung → không giật vị trí đang đọc) */}
        {(loadingOlder || loadingNewer) && (
          <div className={`pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 rounded-full bg-card/95 px-3 py-1 text-[11px] text-muted-foreground shadow ${loadingOlder ? 'top-2' : 'bottom-2'}`}>
            {loadingOlder ? 'Đang tải bình luận cũ hơn…' : 'Đang tải bình luận mới hơn…'}
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={releaseOnUserScroll}
          onPointerDown={releaseOnUserScroll}
          onTouchStart={releaseOnUserScroll}
          onKeyDown={releaseOnUserScroll}
          // Kéo thả ảnh / file vào danh sách bình luận = gửi như kéo vào khung chat (ô soạn tin bên dưới nhận)
          onDragOver={(event) => {
            if (!discussion?.canWrite) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={(event) => {
            if (!discussion?.canWrite) return;
            event.preventDefault();
            event.stopPropagation();
            window.dispatchEvent(new CustomEvent('chat:dragDropFiles', { detail: readDropPayload(event.dataTransfer) }));
          }}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [overflow-anchor:none]"
        >
          <div ref={contentRef}>
            {!hasOlder && !loading && renderPost()}
            {!hasOlder && !loading && !error && (
              <div className="my-2 flex justify-center">
                <span className="rounded-full bg-black/20 px-2.5 py-0.5 text-[11px] text-white dark:bg-white/15">
                  {comments.length ? 'Bắt đầu thảo luận' : 'Chưa có bình luận'}
                </span>
              </div>
            )}
            {loading && <div className="py-6 text-center text-sm text-muted-foreground">Đang tải bình luận…</div>}
            {!loading && error && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                <div>{error}</div>
                <button type="button" className="mt-2 text-primary hover:underline" onClick={retry}>Thử lại</button>
              </div>
            )}
            {!loading && comments.map(renderComment)}
          </div>
        </div>
        {/* Xuống bình luận mới nhất (như Telegram) */}
        {showJump && !loading && (
          <button
            type="button"
            onClick={() => void jumpToLatest()}
            title="Bình luận mới nhất"
            className="absolute bottom-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg hover:text-foreground"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

      {actionError && (
        <div className="shrink-0 border-t border-border bg-card px-3 py-1 text-xs text-red-500">{actionError}</div>
      )}
      {/* Ô bình luận: ô soạn tin của khung chat (gửi đủ loại tin); nhóm bắt buộc tham gia → nút tham gia */}
      {meta && !meta.canWrite ? (
        <div className="shrink-0 border-t border-border bg-card px-3 py-2">
          <div className="flex flex-col items-center gap-1.5 py-1 text-center text-sm">
            {joinState === 'requested' ? (
              <span className="text-muted-foreground">Đã gửi yêu cầu tham gia — chờ quản trị viên nhóm thảo luận duyệt</span>
            ) : meta.joinMode !== 'none' ? (
              <button type="button" onClick={() => void join()} disabled={joinState === 'joining'}
                className="rounded-md px-3 py-1.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-60">
                {joinState === 'joining' ? 'Đang tham gia…' : meta.joinMode === 'request' ? 'Gửi yêu cầu tham gia để bình luận' : 'Tham gia nhóm thảo luận để bình luận'}
              </button>
            ) : (
              <span className="text-muted-foreground">{meta.reason || 'Không bình luận được bài này'}</span>
            )}
          </div>
        </div>
      ) : composerTarget ? (
        <ComposerTargetContext.Provider value={composerTarget}>
          <MessageInput />
        </ComposerTargetContext.Provider>
      ) : (
        <div className="shrink-0 border-t border-border bg-card px-4 py-3 text-center text-sm text-muted-foreground">
          {error ? 'Chưa bình luận được — thử tải lại phần bình luận' : 'Đang tải…'}
        </div>
      )}

      {reactorsFor && (
        <ReactionPopup
          msg={reactorsFor.comment}
          initialEmoji={reactorsFor.emoji}
          contacts={accountContacts}
          groupMembers={reactorProfiles}
          currentUserId={accountId}
          onClose={() => setReactorsFor(null)}
          ownerZaloId={accountId}
        />
      )}
      {profileFor && (
        <UserProfilePopup
          userId={profileFor.userId}
          anchorX={profileFor.x}
          anchorY={profileFor.y}
          contacts={accountContacts}
          activeAccountId={accountId}
          activeThreadId={discussion?.chatId || null}
          onClose={() => setProfileFor(null)}
        />
      )}
      {viewer && (
        <MediaViewer images={viewer.images} initialIndex={viewer.index} zaloId={accountId} onClose={() => setViewer(null)} />
      )}
      {video && (
        <VideoPlayer localPath={video.localPath} width={video.width} height={video.height} duration={video.duration}
          msgId={video.msgId} threadId={video.threadId} onClose={() => setVideo(null)} />
      )}
    </div>
  );
}
