/**
 * Gom tin để vẽ danh sách: album ảnh, bình chọn trùng, chuỗi sticker, mốc ngày, tra tin theo msg_id, loại tin đã parse.
 * Chỉ là memo trên các hàm thuần ở lib/chat/messages/messageGrouping (thử / sửa logic gom ở đó, không cần React).
 */
import React from 'react';
import { getDayStartIds } from '@/lib/chat/messages/daySeparators';
import {
  buildMsgTypeCache, groupMediaAlbums, groupStickerRuns, indexMessagesById, pollDuplicateIds,
} from '@/lib/chat/messages/messageGrouping';

export function useMessageGrouping(msgs: any[]) {
  // ─── Group image messages với cùng groupLayoutId thành 1 bubble ───────────
  // Cũng gom các ảnh Facebook từ cùng người gửi trong 30 giây vào 1 bubble
  const { groupedFirstMsgs, groupedSkipIds } = React.useMemo(() => groupMediaAlbums(msgs), [msgs]);

  // DEDUP poll messages: nhiều event vote cùng pollId → chỉ hiện 1 bubble (mới nhất)
  const pollSkipIds = React.useMemo(() => pollDuplicateIds(msgs), [msgs]);

  // ─── Group consecutive stickers từ cùng người gửi trong 30 phút ────────────
  const { groupedStickerFirstMsgs, groupedStickerSkipIds } = React.useMemo(
    () => groupStickerRuns(msgs, groupedSkipIds, pollSkipIds),
    [msgs, groupedSkipIds, pollSkipIds],
  );

  // Mốc ngày 1 lần / ngày (như Telegram): tin HIỂN THỊ đầu tiên của mỗi ngày lịch. Trước đây mốc "13:38 Hôm nay" lặp
  // ở mỗi lần đổi người gửi / cách 30 phút trong khi giờ từng tin đã có trong bubble.
  const dayStartIds = React.useMemo(
    () => getDayStartIds(msgs, (id) => groupedSkipIds.has(id) || pollSkipIds.has(id) || groupedStickerSkipIds.has(id)),
    [msgs, groupedSkipIds, pollSkipIds, groupedStickerSkipIds],
  );

  // Tra tin theo msg_id (giữ phần tử ĐẦU như find/findIndex): hàng có trích dẫn / cuối album trước đây quét cả
  // danh sách ở mỗi lần render → O(n²) khi hội thoại dài
  const msgIndexById = React.useMemo(() => indexMessagesById(msgs), [msgs]);
  const findMsgById = (id: unknown) => {
    const i = msgIndexById.get(id);
    return i === undefined ? undefined : msgs[i];
  };

  // OPTIMIZATION: Message Type Cache - Parse JSON 1 lần cho tất cả messages
  // Tránh re-parse trong mỗi lần render, giảm ~85% JSON.parse() calls
  const msgTypeCache = React.useMemo(() => buildMsgTypeCache(msgs, groupedFirstMsgs), [msgs, groupedFirstMsgs]);

  // ID (msg_id + cli_msg_id) của mọi tin một hàng hiển thị → data-msg-ids. Album ảnh / nhóm sticker chỉ có
  // tin đầu mang id="msg-…"; quote có thể chỉ biết cliMsgId.
  const getRowMsgIds = (msg: any): string =>
    (groupedFirstMsgs[msg.msg_id] || groupedStickerFirstMsgs[msg.msg_id] || [msg])
      .flatMap((m: any) => [m.msg_id, m.cli_msg_id])
      .filter((id: any) => id && String(id) !== '0')
      .join(' ');

  return {
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, groupedStickerFirstMsgs, groupedStickerSkipIds,
    dayStartIds, msgIndexById, findMsgById, msgTypeCache, getRowMsgIds,
  };
}

export type MessageGrouping = ReturnType<typeof useMessageGrouping>;
