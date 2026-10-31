/**
 * Chân bài đăng kênh Telegram: cảm xúc trong khung bài (bấm = thả / gỡ), người đăng + lượt xem + giờ, thanh bình luận
 * (mở nhóm thảo luận ngay trong khung chat).
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
  );
}
