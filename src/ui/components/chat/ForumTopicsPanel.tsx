/**
 * ForumTopicsPanel.tsx - Danh sách Topics của Telegram Forum Group
 *
 * Style: Clean, modern, giống Telegram — không icon, focus vào content.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/appStore';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/store/chatStore';
import { getAdapter } from '@/lib/adapters/registry';
import { Spinner } from '@/components/common/PageLoading';

interface ForumTopic {
  id: string;
  forumTopicId?: string;
  rootMessageId?: string;
  title: string;
  iconEmojiId: string;
  iconColor: number;
  topMessageId: string;
  topMessageDate: number;
  unreadCount: number;
  isPinned: boolean;
  isClosed: boolean;
  creatorId: string;
  creatorName: string;
}

interface ForumTopicsPanelProps {
  accountId: string;
  chatId: string;
  chatName: string;
  activeTopicId?: string | null;
  onSelectTopic: (rootMessageId: string, topicTitle: string, forumTopicId?: string, topMessageId?: string) => void;
  onBack: () => void;
  compact?: boolean;
}

function formatTopicDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'Vừa xong';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}p`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
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

export default function ForumTopicsPanel({ accountId, chatId, chatName, activeTopicId, onSelectTopic, onBack }: ForumTopicsPanelProps) {
  const cacheKey = `${accountId}_${chatId}`;
  const { forumTopics, setForumTopics } = useChatStore(useShallow(s => ({
    forumTopics: s.forumTopics, setForumTopics: s.setForumTopics,
  })));
  const cached = forumTopics[cacheKey];
  const groupInfoCache = useAppStore(state => state.groupInfoCache);
  const cachedCanManageTopics = groupInfoCache?.[accountId]?.[chatId]?.canManageTopics === true;

  const [topics, setTopics] = useState<ForumTopic[]>(cached || []);
  const [initialLoading, setInitialLoading] = useState(!cached);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [canManageTopics, setCanManageTopics] = useState(cachedCanManageTopics);
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));
  const mountedRef = useRef(true);

  const sortTopics = useCallback((list: ForumTopic[]) => {
    return [...list].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return (b.topMessageDate || 0) - (a.topMessageDate || 0);
    });
  }, []);

  const loadTopics = useCallback(async (isRefresh = false) => {
    if (!mountedRef.current) return;
    if (!isRefresh && cached && cached.length > 0) {
      setTopics(sortTopics(cached));
      setInitialLoading(false);
    }
    if (isRefresh) setRefreshing(true);
    else if (!cached) setInitialLoading(true);
    setError('');

    try {
      const adapter = getAdapter('telegram_user');
      const res = await (adapter as any).getForumTopics({ accountId, threadId: chatId });
      if (!mountedRef.current) return;
      if (res?.success && res.topics) {
        // The server may still report the pre-read unread count right after
        // messages.ReadDiscussion. Drop the badge for topics whose top message
        // is the one the user already opened.
        const normalised = (res.topics as ForumTopic[]).map((t) => {
          const key = topicKeyOf(t);
          const readTop = readTopicTops.get(`${cacheKey}:${key}`);
          if (readTop !== undefined && readTop === String(t.topMessageId || '')) {
            return { ...t, unreadCount: 0 };
          }
          return t;
        });
        const sorted = sortTopics(normalised);
        setTopics(sorted);
        setForumTopics(cacheKey, sorted);
      } else if (!cached) {
        setError(res?.error || 'Không thể tải danh sách chủ đề');
      }
    } catch (err: any) {
      if (!mountedRef.current) return;
      if (!cached) setError(err.message || 'Lỗi kết nối');
    } finally {
      if (mountedRef.current) { setInitialLoading(false); setRefreshing(false); }
    }
  }, [accountId, chatId, cacheKey, cached, sortTopics, setForumTopics]);

  useEffect(() => {
    mountedRef.current = true;
    loadTopics(false);
    return () => { mountedRef.current = false; };
  }, [cacheKey]);

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
      if (res?.success) { showNotification('Đã tạo chủ đề mới', 'success'); loadTopics(true); }
      else showNotification(res?.error || 'Tạo chủ đề thất bại', 'error');
    } catch (err: any) { showNotification(err.message, 'error'); }
  };

  const handleTopicClick = (topic: ForumTopic) => {
    const key = topicKeyOf(topic);
    // Remember the message we read up to, so a later server refetch that still
    // reports the old unread count cannot resurrect the badge for this topic.
    readTopicTops.set(`${cacheKey}:${key}`, String(topic.topMessageId || ''));
    // Clear unread locally
    const updated = topics.map(t =>
      topicKeyOf(t) === key ? { ...t, unreadCount: 0 } : t
    );
    setTopics(updated);
    setForumTopics(cacheKey, updated);
    onSelectTopic(topic.rootMessageId || topic.id, topic.title, topic.forumTopicId, topic.topMessageId);
  };

  const totalUnread = topics.reduce((sum, t) => sum + (t.unreadCount || 0), 0);

  // A topic is addressed by three interchangeable ids (ForumTopic.id, its root
  // message id and the forum topic id). Compare them all as strings: an id that
  // arrives from IPC or the persisted cache as a number must not silently fall
  // through a strict === check and leave the open topic unhighlighted.
  const activeKey = activeTopicId == null || activeTopicId === '' ? '' : String(activeTopicId);
  const isTopicSelected = (topic: ForumTopic): boolean => {
    if (activeKey) {
      return [topic.rootMessageId, topic.id, topic.forumTopicId]
        .filter(Boolean)
        .some(v => String(v) === activeKey);
    }
    // Nothing chosen yet: the chat window is showing the channel root, which is
    // Telegram's General topic. Highlight it so the list matches the view.
    return String(topic.id) === '1';
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/80 bg-card/50">
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <div className="flex-1 min-w-0">
          <h3 className="text-[13px] font-semibold text-foreground truncate">{chatName}</h3>
          <p className="text-[11px] text-subtle-foreground">
            {topics.length} chủ đề{totalUnread > 0 ? ` · ${totalUnread} chưa đọc` : ''}
            {refreshing && <span className="ml-1 text-subtle-foreground">· Đang cập nhật...</span>}
          </p>
        </div>
        {canManageTopics && (
          <button onClick={handleCreateTopic} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-blue-400" title="Tạo chủ đề mới">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
        )}
      </div>

      {/* Topic list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {initialLoading && topics.length === 0 ? (
          <div className="flex items-center justify-center h-40"><Spinner size={6} /></div>
        ) : error && topics.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <p className="text-red-400 text-xs">{error}</p>
            <button onClick={() => loadTopics(true)} className="text-blue-400 text-xs hover:underline">Thử lại</button>
          </div>
        ) : topics.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <p className="text-subtle-foreground text-sm">Chưa có chủ đề nào</p>
            {canManageTopics && <button onClick={handleCreateTopic} className="text-blue-400 text-xs hover:underline">Tạo chủ đề đầu tiên</button>}
          </div>
        ) : (
          <div className="space-y-1">
            {topics.map((topic) => {
              const isSelected = isTopicSelected(topic);
              const key = topicKeyOf(topic);
              const readTop = readTopicTops.get(`${cacheKey}:${key}`);
              // The topic on screen is read by definition. A topic the user has
              // already opened keeps its badge cleared until it gains a new top
              // message.
              const alreadyRead = isSelected
                || (readTop !== undefined && readTop === String(topic.topMessageId || ''));
              const hasUnread = topic.unreadCount > 0 && !alreadyRead;
              return (
                <button
                  key={topic.id}
                  onClick={() => handleTopicClick(topic)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-xl border transition-colors
                    ${isSelected
                      ? 'bg-blue-500/15 border-blue-500/40'
                      : 'border-transparent hover:bg-card/50'}`}
                >
                  {/* Selection accent */}
                  <span className={`w-1 self-stretch rounded-full flex-shrink-0 transition-colors
                    ${isSelected ? 'bg-blue-500' : 'bg-transparent'}`} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {topic.isPinned && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className={`flex-shrink-0 ${isSelected ? 'text-blue-400' : 'text-subtle-foreground'}`}>
                          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                        </svg>
                      )}
                      <span className={`text-[13px] truncate ${isSelected ? 'text-blue-300 font-semibold' : hasUnread ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                        {topic.title}
                      </span>
                      {topic.isClosed && (
                        <span className="text-[9px] text-subtle-foreground bg-muted/80 px-1.5 py-0.5 rounded-full flex-shrink-0">Đóng</span>
                      )}
                    </div>
                    {topic.creatorName && (
                      <p className="text-[11px] text-subtle-foreground truncate mt-0.5">{topic.creatorName}</p>
                    )}
                  </div>

                  {/* Right side: time + badge */}
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    {topic.topMessageDate > 0 && (
                      <span className={`text-[11px] ${hasUnread ? 'text-blue-400' : 'text-subtle-foreground'}`}>
                        {formatTopicDate(topic.topMessageDate)}
                      </span>
                    )}
                    {hasUnread && (
                      <span className="bg-blue-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                        {topic.unreadCount > 99 ? '99+' : topic.unreadCount}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
