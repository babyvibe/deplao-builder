/**
 * Telegram group in forum or channel-post comments form: the name of the open topic + a button to go back to the topic list.
 */
import { useChatStore } from '@/store/chat/chatStore';
import type { OpenThread } from '../hooks/useOpenThread';
import { tr } from '../../../../../shared/i18n';

type ForumTopicBarProps = Pick<OpenThread, 'activeForumTopicId' | 'activeTopicTitle'>;

export function ForumTopicBar({ activeForumTopicId, activeTopicTitle }: ForumTopicBarProps) {
  return (
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
        title={tr('Quay lại danh sách chủ đề')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>{activeForumTopicId ? tr('Chủ đề') : tr('Bài đăng')}</span>
      </button>
      <span className="text-subtle-foreground">/</span>
      <span className="text-foreground font-medium truncate">{activeTopicTitle}</span>
    </div>
  );
}
