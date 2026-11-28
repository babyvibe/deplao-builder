/**
 * Group messages for list rendering: photo albums, duplicate polls, sticker runs, date markers, look up messages by msg_id, parsed message types.
 * Only memoizes the pure functions in lib/chat/messages/messageGrouping (test / change the grouping logic there, no React needed).
 */
import React from 'react';
import { getDayStartIds } from '@/lib/chat/messages/daySeparators';
import {
  buildMsgTypeCache, facebookPollCardRows, groupMediaAlbums, groupStickerRuns, indexMessagesById, pollDuplicateIds,
} from '@/lib/chat/messages/messageGrouping';

export function useMessageGrouping(msgs: any[]) {
  // ─── Group image messages with the same groupLayoutId into 1 bubble ───────────
  // Also group Facebook photos from the same sender within 30 seconds into 1 bubble
  const { groupedFirstMsgs, groupedSkipIds } = React.useMemo(() => groupMediaAlbums(msgs), [msgs]);

  // DEDUP poll messages: several vote events with the same pollId → show only 1 bubble (the latest)
  const pollSkipIds = React.useMemo(() => pollDuplicateIds(msgs), [msgs]);
  // Messenger: the newest vote line of each poll shows the poll card again (vote line msg_id → poll card msg_id)
  const fbPollCardRows = React.useMemo(() => facebookPollCardRows(msgs), [msgs]);

  // ─── Group consecutive stickers from the same sender within 30 minutes ────────────
  const { groupedStickerFirstMsgs, groupedStickerSkipIds } = React.useMemo(
    () => groupStickerRuns(msgs, groupedSkipIds, pollSkipIds),
    [msgs, groupedSkipIds, pollSkipIds],
  );

  // Date marker once per day (like Telegram): the first DISPLAYED message of each calendar day. It used to repeat the "13:38 Hôm nay" (13:38 Today) marker
  // on every sender change / every 30 minutes, while each message's time was already in the bubble.
  const dayStartIds = React.useMemo(
    () => getDayStartIds(msgs, (id) => groupedSkipIds.has(id) || pollSkipIds.has(id) || groupedStickerSkipIds.has(id)),
    [msgs, groupedSkipIds, pollSkipIds, groupedStickerSkipIds],
  );

  // Look up a message by msg_id (keeps the FIRST match, like find/findIndex): rows with a quote or the last album item used to scan the whole
  // list on every render → O(n²) in long conversations
  const msgIndexById = React.useMemo(() => indexMessagesById(msgs), [msgs]);
  const findMsgById = (id: unknown) => {
    const i = msgIndexById.get(id);
    return i === undefined ? undefined : msgs[i];
  };

  // OPTIMIZATION: Message Type Cache: parse the JSON once for all messages
  // Avoids re-parsing on every render, cuts ~85% of JSON.parse() calls
  const msgTypeCache = React.useMemo(() => buildMsgTypeCache(msgs, groupedFirstMsgs), [msgs, groupedFirstMsgs]);

  // The IDs (msg_id + cli_msg_id) of every message in a displayed row → data-msg-ids. A photo album / sticker group only has
  // the first message carrying id="msg-…"; a quote may only know the cliMsgId.
  const getRowMsgIds = (msg: any): string =>
    (groupedFirstMsgs[msg.msg_id] || groupedStickerFirstMsgs[msg.msg_id] || [msg])
      .flatMap((m: any) => [m.msg_id, m.cli_msg_id])
      .filter((id: any) => id && String(id) !== '0')
      .join(' ');

  return {
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, fbPollCardRows, groupedStickerFirstMsgs, groupedStickerSkipIds,
    dayStartIds, msgIndexById, findMsgById, msgTypeCache, getRowMsgIds,
  };
}

export type MessageGrouping = ReturnType<typeof useMessageGrouping>;
