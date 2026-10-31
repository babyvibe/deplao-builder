/**
 * ForumTopicsPanel.tsx - Danh sách chủ đề (topic) của nhóm forum Telegram, trình bày như Telegram: biểu tượng chủ đề,
 * tên + giờ tin mới nhất, "người gửi: nội dung", số chưa đọc (xám khi tắt thông báo), ghim / đã đóng. Chủ đề ghim theo
 * thứ tự ghim, còn lại tin mới trước. Danh sách nằm ở chatStore.forumTopics (lưu localStorage) — tin mới tới thì
 * forumTopicsLive cập nhật ngay dòng của chủ đề đó.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import { getAdapter } from '@/lib/channels/adapters/registry';
import { cn } from '@/lib/cn';
import { Spinner } from '@/components/common/PageLoading';
import { BellOffIcon, LockIcon } from '@/components/common/icons';
import { ForumTopicIcon } from './ForumTopicIcon';
import {
  forumTopicHasId,
  formatForumTopicTime,
  isForumTopicMuted,
  isGeneralForumTopic,
  sortForumTopics,
  type ForumTopicRow,
} from '../../../../../shared/telegram/forumTopics';

interface ForumTopicsPanelProps {
  accountId: string;
  chatId: string;
  chatName: string;
  activeTopicId?: string | null;
  onSelectTopic: (rootMessageId: string, topicTitle: string, forumTopicId?: string, topMessageId?: string) => void;
  onBack: () => void;
  compact?: boolean;
}

/**
 * Topics the user has already opened, mapped to the top message id that was
 * showing at that moment. The panel is remounted when the user switches chats,
 * so this lives at module scope and outlives the component. An entry is only
 * ignored once the topic's top message changes again — a fresh message brings
 * the unread badge back.
 */
const readTopicTops = new Map<string, string>();
const topicKeyOf = (topic: { rootMessageId?: string; id?: string }): string =>
  String(topic.rootMessageId || topic.id || '');

const EMPTY_TOPICS: ForumTopicRow[] = [];

/** Ghim (đinh ghim) — như Telegram, hiện bên phải khi chủ đề ghim không có tin chưa đọc. */
function PinGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
    </svg>
  );
}

export default function ForumTopicsPanel({ accountId, chatId, chatName, activeTopicId, onSelectTopic, onBack }: ForumTopicsPanelProps) {
  const cacheKey = `${accountId}_${chatId}`;
  const stored = useChatStore(s => s.forumTopics[cacheKey]) as ForumTopicRow[] | undefined;
  const setForumTopics = useChatStore(s => s.setForumTopics);
  const showNotification = useAppStore(s => s.showNotification);
  const cachedCanManageTopics = useAppStore(s => s.groupInfoCache?.[accountId]?.[chatId]?.canManageTopics === true);
  const memberCount = useAppStore(s => Number(s.groupInfoCache?.[accountId]?.[chatId]?.memberCount || 0));
  // Badge xám như Telegram: nhóm đang tắt thông báo (chủ đề không đặt riêng)
  const groupMuted = useAppStore(s => {
    const until = s.mutedThreads[accountId]?.[chatId];
    return until !== undefined && (until === 0 || Date.now() < until);
  });

  // Danh sách vừa bị xoá khỏi bộ đệm (sự kiện chủ đề đổi) → vẫn hiện bản cũ trong lúc tải lại, không nháy trống
  const lastListRef = useRef<{ key: string; list: ForumTopicRow[] } | null>(null);
  if (stored) lastListRef.current = { key: cacheKey, list: stored };
  const source = stored ?? (lastListRef.current?.key === cacheKey ? lastListRef.current.list : undefined);
  const topics = useMemo(() => (source ? sortForumTopics(source) : EMPTY_TOPICS), [source]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [canManageTopics, setCanManageTopics] = useState(cachedCanManageTopics);
  const mountedRef = useRef(true);
  // Nhóm đang tải (panel giữ nguyên khi đổi nhóm: lượt tải của nhóm cũ không chặn / không đổi trạng thái của nhóm mới)
  const loadingKeyRef = useRef<string | null>(null);
  const currentKeyRef = useRef(cacheKey);
  currentKeyRef.current = cacheKey;

  const loadTopics = useCallback(async () => {
    if (loadingKeyRef.current === cacheKey) return;
    loadingKeyRef.current = cacheKey;
    setLoading(true);
    setError('');
    const isCurrent = () => mountedRef.current && currentKeyRef.current === cacheKey;
    try {
      const adapter = getAdapter('telegram_user');
      const res = await (adapter as any).getForumTopics({ accountId, threadId: chatId });
      if (res?.success && res.topics) {
        // The server may still report the pre-read unread count right after
        // messages.ReadDiscussion. Drop the badge for topics whose top message
        // is the one the user already opened.
        const normalised = (res.topics as ForumTopicRow[]).map((topic) => {
          const readTop = readTopicTops.get(`${cacheKey}:${topicKeyOf(topic)}`);
          return readTop !== undefined && readTop === String(topic.topMessageId || '') ? { ...topic, unreadCount: 0 } : topic;
        });
        // Lưu kể cả khi đã rời nhóm: lần mở sau hiện ngay bản mới
        setForumTopics(cacheKey, normalised);
      } else if (isCurrent()) {
        setError(res?.error || 'Không thể tải danh sách chủ đề');
      }
    } catch (err: any) {
      if (isCurrent()) setError(err?.message || 'Lỗi kết nối');
    } finally {
      if (loadingKeyRef.current === cacheKey) loadingKeyRef.current = null;
      if (isCurrent()) setLoading(false);
    }
  }, [accountId, chatId, cacheKey, setForumTopics]);

  // Mở panel: hiện ngay bản đã lưu, đồng thời lấy bản mới từ Telegram
  useEffect(() => {
    mountedRef.current = true;
    void loadTopics();
    return () => { mountedRef.current = false; };
  }, [loadTopics]);

  // Chủ đề được tạo / sửa / đóng ở nơi khác (event:forumTopicsChanged xoá bộ đệm) → tải lại
  const hadStoredRef = useRef(!!stored);
  useEffect(() => {
    if (stored) { hadStoredRef.current = true; return; }
    if (hadStoredRef.current) {
      hadStoredRef.current = false;
      void loadTopics();
    }
  }, [stored, loadTopics]);

  useEffect(() => {
    let cancelled = false;
    setCanManageTopics(cachedCanManageTopics);
    const adapter = getAdapter('telegram_user');
    void (adapter as any).getGroupInfo({ accountId, threadId: chatId })
      .then((res: any) => { if (!cancelled && res?.success) setCanManageTopics(res?.info?.canManageTopics === true); })
      .catch(() => { if (!cancelled) setCanManageTopics(false); });
    return () => { cancelled = true; };
  }, [accountId, chatId, cachedCanManageTopics]);

  const handleCreateTopic = async () => {
    const title = prompt('Tên chủ đề mới:');
    if (!title?.trim()) return;
    try {
      const adapter = getAdapter('telegram_user');
      const res = await (adapter as any).createForumTopic({ accountId, threadId: chatId, title: title.trim() });
      if (res?.success) { showNotification('Đã tạo chủ đề mới', 'success'); void loadTopics(); }
      else showNotification(res?.error || 'Tạo chủ đề thất bại', 'error');
    } catch (err: any) { showNotification(err.message, 'error'); }
  };

  const handleTopicClick = (topic: ForumTopicRow) => {
    const key = topicKeyOf(topic);
    // Remember the message we read up to, so a later server refetch that still
    // reports the old unread count cannot resurrect the badge for this topic.
    readTopicTops.set(`${cacheKey}:${key}`, String(topic.topMessageId || ''));
    // Clear unread locally
    const current = useChatStore.getState().forumTopics[cacheKey] as ForumTopicRow[] | undefined;
    if (current) {
      setForumTopics(cacheKey, current.map(t => (topicKeyOf(t) === key ? { ...t, unreadCount: 0, unreadMentionsCount: 0 } : t)));
    }
    onSelectTopic(topic.rootMessageId || topic.id, topic.title, topic.forumTopicId, topic.topMessageId);
  };

  // A topic is addressed by three interchangeable ids (ForumTopic.id, its root
  // message id and the forum topic id). Compare them all as strings: an id that
  // arrives from IPC or the persisted cache as a number must not silently fall
  // through a strict === check and leave the open topic unhighlighted.
  const isTopicSelected = (topic: ForumTopicRow): boolean => {
    if (activeTopicId != null && activeTopicId !== '') return forumTopicHasId(topic, String(activeTopicId));
    // Nothing chosen yet: the chat window is showing the channel root, which is
    // Telegram's General topic. Highlight it so the list matches the view.
    return isGeneralForumTopic(topic);
  };

  const subtitle = [
    memberCount > 0 ? `${memberCount.toLocaleString('vi-VN')} thành viên` : '',
    topics.length > 0 ? `${topics.length} chủ đề` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-2 border-b border-border bg-card/50">
        <button onClick={onBack} title="Quay lại" className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
        </button>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{chatName}</h3>
          <p className="text-xs text-muted-foreground truncate">
            {subtitle}
            {loading && source && <span>{subtitle ? ' · ' : ''}Đang cập nhật...</span>}
          </p>
        </div>
        {canManageTopics && (
          <button onClick={handleCreateTopic} className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground" title="Tạo chủ đề mới">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
        )}
      </div>

      {/* Topic list */}
      <div className="flex-1 overflow-y-auto">
        {!source && loading ? (
          <div className="flex items-center justify-center h-40"><Spinner size={6} /></div>
        ) : error && topics.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <p className="text-red-400 text-xs">{error}</p>
            <button onClick={() => void loadTopics()} className="text-primary text-xs hover:underline">Thử lại</button>
          </div>
        ) : topics.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <p className="text-muted-foreground text-sm">Chưa có chủ đề nào</p>
            {canManageTopics && <button onClick={handleCreateTopic} className="text-primary text-xs hover:underline">Tạo chủ đề đầu tiên</button>}
          </div>
        ) : (
          topics.map((topic) => {
            const isSelected = isTopicSelected(topic);
            const readTop = readTopicTops.get(`${cacheKey}:${topicKeyOf(topic)}`);
            // The topic on screen is read by definition. A topic the user has
            // already opened keeps its badge cleared until it gains a new top
            // message.
            const alreadyRead = isSelected
              || (readTop !== undefined && readTop === String(topic.topMessageId || ''));
            const hasUnread = topic.unreadCount > 0 && !alreadyRead;
            const hasMention = (topic.unreadMentionsCount || 0) > 0 && !alreadyRead;
            const muted = isForumTopicMuted(topic, groupMuted);
            const sender = topic.lastIsOut ? 'Bạn' : topic.lastSenderName || '';
            return (
              <button
                key={topic.id}
                type="button"
                onClick={() => handleTopicClick(topic)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                  isSelected ? 'bg-selected' : 'hover:bg-muted',
                )}
              >
                <ForumTopicIcon accountId={accountId} topic={topic} className="w-8 h-8 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className={cn('truncate text-sm text-foreground', hasUnread ? 'font-semibold' : 'font-medium')}>{topic.title}</span>
                    {topic.isClosed && <span title="Chủ đề đã đóng" className="flex-shrink-0 text-muted-foreground"><LockIcon className="w-3.5 h-3.5" /></span>}
                    {muted && <span title="Đã tắt thông báo" className="flex-shrink-0 text-muted-foreground"><BellOffIcon className="w-3.5 h-3.5" /></span>}
                    <span className="ml-auto pl-2 flex-shrink-0 text-xs text-muted-foreground whitespace-nowrap">{formatForumTopicTime(topic.topMessageDate)}</span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="flex-1 min-w-0 truncate text-sm text-muted-foreground">
                      {sender && <span className="text-foreground/80">{sender}: </span>}
                      {topic.lastMessageText || ''}
                    </span>
                    {hasMention && (
                      <span className="flex-shrink-0 bg-primary text-primary-foreground text-[11px] font-bold rounded-full w-[18px] h-[18px] flex items-center justify-center">@</span>
                    )}
                    {hasUnread ? (
                      <span className={cn(
                        'flex-shrink-0 text-[11px] font-medium leading-none tabular-nums rounded-full h-[18px] min-w-[18px] px-1.5 inline-flex items-center justify-center',
                        muted ? 'bg-muted-foreground/60 text-background' : 'bg-primary text-primary-foreground',
                      )}>
                        {topic.unreadCount}
                      </span>
                    ) : topic.isPinned && !hasMention ? (
                      <span title="Đã ghim" className="flex-shrink-0 text-muted-foreground/80"><PinGlyph className="w-3.5 h-3.5 rotate-45" /></span>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
