/**
 * Reactions at the bottom corner of the message (inside the chat window): a chip / summary of the reaction count + a 👍 button that opens the picker on hover.
 * Telegram: the conversation's reaction list; channel posts: only the button is left (the reactions are drawn inside the post frame).
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
      // Channel post: reactions are drawn inside the post frame → only the 👍 button is left here, on hover
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
