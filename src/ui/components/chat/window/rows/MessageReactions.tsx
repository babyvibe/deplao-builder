/**
 * Cảm xúc ở góc dưới tin (phía trong khung chat): chip / tóm tắt số cảm xúc + nút 👍 mở thanh chọn khi rê chuột.
 * Telegram: danh sách cảm xúc của hội thoại; bài đăng kênh: chỉ còn nút (cảm xúc đã vẽ trong khung bài).
 */
import { isTelegram as isTelegramCh } from '@/lib/channels/channelHelper';
import { parseReactionsFull } from '../../messages/reactions/ReactionComponents';
import { MessageReactionCorner } from '../../messages/reactions/MessageReactionCorner';
import { getReactionChoices, sameReaction } from '@/lib/chat/reactions/reactionChoices';
import type { MessageRowContext, RowLocals } from './rowContext';

type MessageReactionsProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'isSent' | 'reactionCounts' | 'telegramPostMeta'>;

export function MessageReactions({ ctx, msg, isSent, reactionCounts, telegramPostMeta }: MessageReactionsProps) {
  const { activeAccountId, armReactionPicker, closeReactionPicker, handleCancelReaction, handleReact, openReactionPicker, reactionPickerMsgId, scheduleCloseReactionPicker, setReactionPopup, telegramReactions } = ctx;
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
}
