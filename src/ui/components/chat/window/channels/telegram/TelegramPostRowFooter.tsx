/**
 * Footer of a Telegram channel post: reactions inside the post frame (click = add / remove), author + views + time, comment bar
 * (opens the discussion group right in the chat window).
 */
import { useChatStore } from '@/store/chat/chatStore';
import { parseReactionsFull } from '../../../messages/reactions/ReactionComponents';
import { TelegramPostCommentsBar, TelegramPostFooter, TelegramPostReactions } from '../../../telegram/posts/TelegramPostParts';
import type { MessageRowContext, RowLocals } from '../../rows/rowContext';

type TelegramPostRowFooterProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'isSent' | 'telegramPostMeta' | 'postStats' | 'reactionCounts' | 'hasReactions'>;

export function TelegramPostRowFooter({ ctx, msg, isSent, telegramPostMeta, postStats, reactionCounts, hasReactions }: TelegramPostRowFooterProps) {
  const { activeAccountId, activeThreadId, handleCancelReaction, handleReact, postReplierPeers } = ctx;
  return (
    <>
      {/* Reactions inside the post frame, click = add / remove (like Telegram) */}
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
      {/* Comments live in the channel's discussion group: opens right in the chat window, and returns to the exact spot of the post being viewed */}
      {postStats?.hasDiscussion && activeAccountId && activeThreadId && (
        <TelegramPostCommentsBar count={postStats.comments} repliers={postStats.recentRepliers} peers={postReplierPeers}
          isSent={isSent} unread={postStats.unread}
          onOpen={() => useChatStore.getState().setPostDiscussion({
            accountId: activeAccountId, channelId: activeThreadId, postId: postStats.postId,
          })} />
      )}
    </>
  );
}
