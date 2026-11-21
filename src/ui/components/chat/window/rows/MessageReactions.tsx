/**
 * Reactions of a message in the chat window, each channel like its own app:
 * - Zalo: ZaloReactionCorner at the bottom-right corner (button with your latest reaction, Zalo's horizontal bar with ✕, summary).
 * - Telegram: TelegramReactionTrigger, pinned to the bottom-right corner of the message just under the send time, showing the
 *   account's quick reaction (click = send / remove it, hold = the column of reactions); the chips are drawn INSIDE the message
 *   by MessageRow (TelegramReactionChips), channel posts in the post frame.
 * - Facebook: the shared corner with one combined chip.
 */
import { isFacebook, isTelegram as isTelegramCh } from '@/lib/channels/channelHelper';
import { parseReactionsFull } from '../../messages/reactions/ReactionComponents';
import { MessageReactionCorner } from '../../messages/reactions/MessageReactionCorner';
import { ZaloReactionCorner } from '../../messages/reactions/ZaloReactionCorner';
import { myTelegramReaction, quickReactionAction } from '../../messages/reactions/TelegramReactionChips';
import {
  getReactionChoices, loadTelegramQuickReaction, sameReaction, TELEGRAM_DEFAULT_QUICK_REACTION, useTelegramQuickReaction,
  ZALO_QUICK_REACTIONS,
} from '@/lib/chat/reactions/reactionChoices';
import { zaloLatestReactionOf } from '../../../../../shared/zalo/zaloReactions';
import type { MessageRowContext, RowLocals } from './rowContext';

type MessageReactionsProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'isSent' | 'reactionCounts' | 'telegramPostMeta'>;

/** Zalo's reaction button sends this until you have reacted on the message. */
const ZALO_DEFAULT_REACTION = '👍';

/** The quick reaction of the account (Telegram user: from its Telegram settings; bots have none → 👍, Telegram's default). */
function quickReactionFor(ctx: MessageRowContext, channel: string | undefined): Promise<string> {
  return channel === 'telegram_user'
    ? loadTelegramQuickReaction(ctx.activeAccountId)
    : Promise.resolve(TELEGRAM_DEFAULT_QUICK_REACTION);
}

/** Telegram: send the quick reaction, or remove it when it is already yours (button click / double-click on the message). */
export async function toggleTelegramQuickReaction(ctx: MessageRowContext, msg: any): Promise<void> {
  const quick = await quickReactionFor(ctx, msg.channel);
  const mine = myTelegramReaction(parseReactionsFull(msg.reactions, msg.channel).emoji, ctx.activeAccountId);
  if (quickReactionAction(quick, mine) === 'remove') await ctx.handleCancelReaction(msg);
  else await ctx.handleReact(msg, quick);
}

/** Telegram's reaction button: bottom-right corner of the message, just under the send time (shown on hover). */
export function TelegramReactionTrigger({ ctx, msg, isSent }: { ctx: MessageRowContext; msg: any; isSent: boolean }) {
  const { activeAccountId, armReactionPicker, closeReactionPicker, handleCancelReaction, handleReact, openReactionPicker, reactionPickerMsgId, scheduleCloseReactionPicker, setReactionPopup, telegramReactions } = ctx;
  const quick = useTelegramQuickReaction(activeAccountId, msg.channel === 'telegram_user');
  const myEmoji = myTelegramReaction(parseReactionsFull(msg.reactions, msg.channel).emoji, activeAccountId);
  const loadTelegramReactions = () => {
    if (msg.channel === 'telegram_user') telegramReactions.load();
  };
  return (
    <MessageReactionCorner
      placement="time"
      isSent={isSent}
      counts={{}}
      myEmoji={myEmoji}
      variant="chips"
      hideCounts
      pickerOpen={reactionPickerMsgId === msg.msg_id}
      pickerEmojis={getReactionChoices(msg.channel, telegramReactions.reactions).all}
      quickEmoji={quick.emoji}
      onQuick={() => { void toggleTelegramQuickReaction(ctx, msg); }}
      onArm={() => {
        armReactionPicker(msg.msg_id, loadTelegramReactions);
        if (msg.channel === 'telegram_user') void quick.load();
      }}
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

export function MessageReactions({ ctx, msg, isSent, reactionCounts, telegramPostMeta }: MessageReactionsProps) {
  const { activeAccountId, armReactionPicker, closeReactionPicker, handleCancelReaction, handleReact, openReactionPicker, reactionPickerMsgId, scheduleCloseReactionPicker, setReactionPopup, telegramReactions } = ctx;
  const isTelegram = isTelegramCh(msg.channel);
  const rFull = parseReactionsFull(msg.reactions, msg.channel);
  const pickerOpen = reactionPickerMsgId === msg.msg_id;

  // Telegram: the button under the send time, the chips inside the message
  if (isTelegram) return <TelegramReactionTrigger ctx={ctx} msg={msg} isSent={isSent} />;

  // Zalo (and old rows without a channel)
  if (!isFacebook(msg.channel)) {
    const myLatest = zaloLatestReactionOf(rFull, activeAccountId);
    return (
      <ZaloReactionCorner
        isSent={isSent}
        counts={reactionCounts}
        myEmoji={myLatest}
        barOpen={pickerOpen}
        emojis={ZALO_QUICK_REACTIONS}
        onArm={() => armReactionPicker(msg.msg_id)}
        onLeave={scheduleCloseReactionPicker}
        onQuick={() => { void handleReact(msg, myLatest || ZALO_DEFAULT_REACTION); }}
        onPick={(emoji) => {
          // Zalo counts every tap: picking your own reaction again adds +1, ✕ removes
          void handleReact(msg, emoji);
          closeReactionPicker();
        }}
        onRemoveMine={() => {
          void handleCancelReaction(msg);
          closeReactionPicker();
        }}
        onShowReactors={() => setReactionPopup({ msg, activeEmoji: 'all' })}
      />
    );
  }

  // Facebook: the shared corner with one combined chip
  const myEmoji = activeAccountId
    ? (Object.entries(rFull.emoji || {}).find(([, d]) => (d as any).users?.[activeAccountId] > 0)?.[0] || null)
    : null;
  return (
    <MessageReactionCorner
      isSent={isSent}
      counts={reactionCounts}
      myEmoji={myEmoji}
      variant="summary"
      hideCounts={!!telegramPostMeta}
      pickerOpen={pickerOpen}
      pickerEmojis={getReactionChoices(msg.channel, telegramReactions.reactions).all}
      onArm={() => armReactionPicker(msg.msg_id)}
      onLeave={scheduleCloseReactionPicker}
      onOpenPicker={() => openReactionPicker(msg.msg_id)}
      onPick={(e) => {
        if (sameReaction(e, myEmoji)) handleCancelReaction(msg);
        else handleReact(msg, e);
        closeReactionPicker();
      }}
      onShowReactors={(emoji) => setReactionPopup({ msg, activeEmoji: emoji })}
    />
  );
}
