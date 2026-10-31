/**
 * Một hàng trong khung chat: mốc ngày, rồi theo loại: tin hệ thống (SystemNoticeRow), tin thu hồi (RecalledRow), còn
 * lại là bong bóng tin: ảnh người gửi, tên + chức vụ, chuyển tiếp, trích dẫn (QuotePreview), nội dung theo loại
 * (SharedMessageContent; chữ: TextMessageBody, video: VideoMessageBody), giờ / ✓✓, chân bài kênh Telegram, cảm xúc
 * (MessageReactions), trạng thái gửi của nhân viên, nút khi rê chuột. Album ảnh / chuỗi sticker / bình chọn trùng: chỉ
 * tin đầu vẽ hàng. Loại tin: messageKind.ts.
 */
import React from 'react';
import { groupRankLabel, peerColorIndex, telegramRankLabel } from '@/lib/chat/messages/peerStyle';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { BubbleTime, formatBubbleTime, formatFullDateTime, MessageStatusContext, MessageTtlContext, StatusTicks, TtlMark } from '../../messages/MessageTime';
import { outgoingMessageStatus } from '@/lib/chat/messages/messageStatus';
import SharedMessageContent from '../../messages/SharedMessageContent';
import FacebookTemplateCard, { FacebookEmptyMessage } from '../../facebook/FacebookTemplateCard';
import ZaloOaCard from '../../zalo/messages/ZaloOaCard';
import { isTelegram as isTelegramCh, isTelegramUser } from '@/lib/channels/channelHelper';
import { BankCardBubble } from '../../messages/MessageBubbles';
import { getTelegramPostMeta } from '@/lib/media/mediaResolver';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { formatDaySeparator } from '@/lib/chat/messages/messageParser';
import PollBubble from '../../polls/PollBubble';
import TelegramPollBubble from '../../telegram/messages/TelegramPollBubble';
import { parseReactions } from '../../messages/reactions/ReactionComponents';
import { BubbleEmbedContext, CardBubble, EcardBubble, FileBubble, MediaBubble, MediaGroupBubble, RtfBubble, StickerBubble, StickerGroupBubble, TelegramForwardHeader, VoiceBubble } from '../../messages/ChatWindowBubbles';
import { getTelegramWebpageMeta } from '../../telegram/messages/TelegramLinkPreview';
import { openStickerSetOfMessage } from '@/lib/chat/telegram/telegramStickerStore';
import { pickTelegramPostStats, TELEGRAM_POST_MAX_WIDTH, TELEGRAM_POST_WIDTH, TelegramPostLayoutContext } from '../../telegram/posts/telegramPostLayout';
import { getRichMessageBlocks } from '../../telegram/messages/TelegramRichMessageBody';
import { classifyMessage } from './messageKind';
import { renderSystemNoticeRow } from './SystemNoticeRow';
import { renderRecalledRow } from './RecalledRow';
import { SenderAvatar } from './SenderAvatar';
import { HandledByEmployeeAvatar } from './HandledByEmployeeAvatar';
import { QuotePreview } from './QuotePreview';
import { VideoMessageBody } from './VideoMessageBody';
import { TextMessageBody } from './TextMessageBody';
import { MessageReactions } from './MessageReactions';
import { SendStatusIndicator } from './SendStatusIndicator';
import { MessageHoverActions } from './MessageHoverActions';
import { resolveTelegramForward } from '../channels/telegram/forwardSource';
import { TelegramPostRowFooter } from '../channels/telegram/TelegramPostRowFooter';
import type { MessageRowContext } from './rowContext';

/** Mốc ngày (tin hiển thị đầu tiên của mỗi ngày lịch) */
function renderDaySeparator(timestamp: number) {
  const label = formatDaySeparator(timestamp);
  return (
    <div className="flex justify-center w-full my-2" data-day-label={label}>
      <span className="text-[11px] text-white bg-black/20 dark:bg-white/15 px-2.5 py-0.5 rounded-full">{label}</span>
    </div>
  );
}

/** Vẽ một hàng tin (renderItem của ChatHistoryList). Trả null cho tin không vẽ hàng riêng. */
export function renderMessageRow(ctx: MessageRowContext, msg: any, idx: number): React.ReactNode {
  const {
    activeAccountId, activeThreadId, activeContact, channelCap, msgs, contactList, threadReceipt, telegramGroupAdmins,
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, groupedStickerFirstMsgs, groupedStickerSkipIds, dayStartIds,
    msgIndexById, msgTypeCache, getRowMsgIds, getContact, getGroupMember, groupMembers, isGroupAdmin, revealedEditIds,
    isSelecting, selectedMsgIds, setSelectedMsgIds, dragSelectRef, clickSuppressUntilRef, setContextMenu,
    setManageGroupOpen, setUserProfilePopup, setWebviewModal, openViewer, openVideoPlayer,
  } = ctx;

  // Skip non-first images in a group layout batch
  if (groupedSkipIds.has(msg.msg_id)) return null;
  if (pollSkipIds.has(msg.msg_id)) return null;
  if (groupedStickerSkipIds.has(msg.msg_id)) return null;

  const isSent = !!msg.is_sent;
  const prevMsg = idx > 0 ? msgs[idx - 1] : null;
  const daySeparator = dayStartIds.has(msg.msg_id) ? renderDaySeparator(Number(msg.timestamp) || 0) : null;
  // nextMsg: skip over non-first group images to find actual next visible msg
  let nextMsg = idx < msgs.length - 1 ? msgs[idx + 1] : null;
  if (nextMsg && groupedSkipIds.has(nextMsg.msg_id)) {
    // Find the first non-skipped message after this group
    const groupMsgsForThis = groupedFirstMsgs[msg.msg_id];
    if (groupMsgsForThis) {
      const lastInGroup = groupMsgsForThis[groupMsgsForThis.length - 1];
      const lastInGroupIdx = msgIndexById.get(lastInGroup.msg_id) ?? -1;
      nextMsg = lastInGroupIdx >= 0 && lastInGroupIdx + 1 < msgs.length ? msgs[lastInGroupIdx + 1] : null;
    }
  }
  if (nextMsg && groupedStickerSkipIds.has(nextMsg.msg_id)) {
    const stickerGroupForThis = groupedStickerFirstMsgs[msg.msg_id];
    if (stickerGroupForThis) {
      const lastInGroup = stickerGroupForThis[stickerGroupForThis.length - 1];
      const lastInGroupIdx = msgIndexById.get(lastInGroup.msg_id) ?? -1;
      nextMsg = lastInGroupIdx >= 0 && lastInGroupIdx + 1 < msgs.length ? msgs[lastInGroupIdx + 1] : null;
    }
  }

  // ── System / group-event notification ─────────────────────────
  // Older Telegram history rows accidentally stored pin events as
  // `deleted`. They have sender_id=system and must stay an emote-like
  // centered notice, not fall through to a user message bubble.
  const isTelegramPinnedNotice = msg.channel === 'telegram_user'
    && String(msg.sender_id || '') === 'system'
    && /tin nhắn\s+đã được ghim/i.test(String(msg.content || ''));
  if (msg.msg_type === 'system' || isTelegramPinnedNotice) {
    return renderSystemNoticeRow(ctx, { msg, idx, daySeparator, isTelegramPinnedNotice });
  }

  // Bắt đầu lượt tin (đổi người gửi / cách > 30 phút): hiện tên người gửi trong nhóm. Mốc ngày: daySeparator.
  const startsRun = !prevMsg ||
    (msg.timestamp - prevMsg.timestamp > 30 * 60 * 1000) ||
    prevMsg.sender_id !== msg.sender_id;

  const isLastInRun = !nextMsg || nextMsg.sender_id !== msg.sender_id;

  // Contact/display info - needed for recalled bubble too
  const contact = !isSent ? getContact(msg.sender_id) : null;
  // A sparse contact row is common for a Telegram group sender. It must
  // not hide the richer parent-group member cache (especially in forums).
  const groupMember = !isSent ? getGroupMember(msg.sender_id) : null;
  const contactName = contact?.alias || contact?.display_name || '';
  const preferredContactName = contactName && contactName !== msg.sender_id ? contactName : '';
  const avatarUrl = toLocalMediaUrl(contact?.avatar_url || groupMember?.avatar || '');
  const displayName = preferredContactName || groupMember?.displayName || contactName || msg.sender_id;

  // Kiểu Telegram cho mọi kênh: màu theo người gửi (tên, ảnh đại diện chữ), chức vụ cạnh tên (lib/chat/messages/peerStyle).
  // Chức vụ: Telegram → danh sách quản trị viên (chức vụ tự đặt) khi đã tải, còn lại theo role thành viên nhóm.
  const senderPeer = !isSent ? (peerColorIndex(msg.sender_id, displayName) ?? 5) : null;
  const senderRank = !isSent && msg.thread_type === 1
    ? (isTelegramCh(msg.channel) && telegramGroupAdmins.size > 0
        ? telegramRankLabel(telegramGroupAdmins.get(String(msg.sender_id)))
        : groupRankLabel(msg.channel, (groupMember as any)?.role))
    : '';
  const senderAvatarFallback = !isSent ? (
    <PeerInitials id={msg.sender_id} name={displayName} fallback="U" className="w-7 h-7 text-[10px]" />
  ) : null;

  const isRecalled = msg.is_recalled === 1 || msg.status === 'recalled' || msg.msg_type === 'recalled';

  // ── Recalled message - dùng RecalledBubble chung với MessageBubbles ─
  if (isRecalled) {
    return renderRecalledRow(ctx, { msg, idx, isSent, daySeparator, isLastInRun, displayName, avatarUrl, senderAvatarFallback });
  }

  // OPTIMIZATION: Dùng cache thay vì parse lại type cho mỗi message (rows/messageKind)
  const {
    isCardMsg, isEcardMsg, isStickerMsg, isRtf, isPollMsg, isVideoMsg, isVoiceMsg, isBankCardMsg, isLocationMsg,
    isFbTemplateMsg, isZinstantMsg, isFbEmptyMsg, isGroupMedia, groupMediaMsgs, isMediaMsg, isFileMsg, content,
  } = classifyMessage(msg, msgTypeCache.get(msg.msg_id), groupedFirstMsgs);
  const telegramPostMeta = getTelegramPostMeta(msg);
  // Telegram: tin chuyển tiếp → "Chuyển tiếp từ <nguồn>" (channels/telegram/forwardSource)
  const { telegramForward, forwardName, forwardAvatar } = resolveTelegramForward(ctx, msg);
  // Bài đăng kênh Telegram (như Telegram): ảnh / album / video sát mép khung bài; số liệu lấy cả album (Telegram gắn
  // số bình luận vào MỘT tin của album — trước đây đọc tin đầu nên lệch / mất)
  const postEdgeMedia = !!telegramPostMeta && (isMediaMsg || isGroupMedia || isVideoMsg);
  const postStats = telegramPostMeta
    ? pickTelegramPostStats((groupMediaMsgs || [msg]).map((m: any) => ({ msgId: String(m.msg_id), meta: getTelegramPostMeta(m) })))
    : null;
  // Tin định dạng phong phú (tiêu đề, danh sách, bảng, ảnh / video trong tin)
  const richBlocks = isTelegramUser(msg.channel) ? getRichMessageBlocks(msg) : null;
  // Tin hệ thống Telegram (vd. "Channel created") lưu nhầm thành "bài đăng kênh" rỗng ở bản cũ: không vẽ thẻ trống.
  // Bài đăng thật luôn có chữ hoặc media; lần tải lịch sử kế tiếp sửa hàng thành dòng thông báo.
  if (telegramPostMeta && msg.msg_type === 'text' && !String(msg.content || '').trim() && !isGroupMedia) return null;

  // Tin trả lời loại ảnh / album / file / thẻ: MỘT khung bong bóng bao cả trích dẫn lẫn nội dung (như Telegram)
  const isNoBubbleMsg = isMediaMsg || isGroupMedia || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isBankCardMsg || isFbTemplateMsg || isZinstantMsg;
  const hasQuote = !!(msg.quote_data || (msg.reply_to_id && !(
    msg.channel === 'telegram_user' && msg.topic_id != null &&
    String(msg.reply_to_id) === String(msg.topic_id)
  )));
  const quoteShell = hasQuote && isNoBubbleMsg && !isEcardMsg && !isStickerMsg && !isBankCardMsg && !telegramPostMeta;

  // Tên người gửi trong nhóm (mọi kênh): trong bong bóng, màu theo người gửi + chức vụ góc phải (như Telegram).
  // Tin ảnh / album / file / thẻ mở đầu lượt: bọc MỘT khung (như tin trả lời — quoteShell) để tên nằm trong khung;
  // sticker / thiệp / thẻ ngân hàng không khung → tên trên tin như cũ (có màu).
  // Tin mình gửi: ✓ đã gửi / ✓✓ đã nhận / ✓✓ màu nhấn đã xem (kênh không hỗ trợ → null, không vẽ dấu)
  const outgoingStatus = isSent ? outgoingMessageStatus(msg, msg.channel || activeContact?.channel, threadReceipt) : null;
  const showGroupName = !isSent && !isEcardMsg && msg.thread_type === 1 && startsRun && !!displayName && displayName !== msg.sender_id;
  const nameShell = showGroupName && isNoBubbleMsg && !quoteShell && !isStickerMsg && !isBankCardMsg && !telegramPostMeta;
  // Ảnh / album / file chuyển tiếp: "Chuyển tiếp từ …" chung khung với nội dung, chữ xuống dòng theo bề rộng ảnh (như
  // Telegram); trước đây dòng nguồn nằm trên ảnh, ngoài khung, dài hơn ảnh thì kéo lệch cả tin
  const forwardShell = !!telegramForward && isNoBubbleMsg && !telegramPostMeta && !isStickerMsg && !isEcardMsg && !isBankCardMsg;
  const bubbleShell = quoteShell || nameShell || forwardShell;
  const nameInBubble = showGroupName && !telegramPostMeta && (!isNoBubbleMsg || bubbleShell);
  // Giờ gửi ở góc dưới phải, chung dòng chữ cuối nếu đủ chỗ (như Telegram) — chỉ tin chữ thường; tin có khối riêng
  // (thăm dò, video, thẻ link có tên trang / tiêu đề, nội dung cũ đang mở) giữ dòng giờ riêng. Tin link Telegram
  // không có thẻ (chỉ URL) là tin chữ thường.
  const inlineTime = !isNoBubbleMsg && !telegramPostMeta && !isFbEmptyMsg && !richBlocks
    && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isRtf && !isLocationMsg
    && !(msg.msg_type === 'telegram.webpage' && getTelegramWebpageMeta(msg)) && !revealedEditIds.has(msg.msg_id);

  // Sticker nhóm: nhiều sticker liền nhau từ cùng người gửi trong 30 phút
  const isGroupedStickerFirst = isStickerMsg && !!groupedStickerFirstMsgs[msg.msg_id];
  const groupStickerMsgs = isGroupedStickerFirst ? groupedStickerFirstMsgs[msg.msg_id] : null;


  // Reactions: parse new PHP-like format or legacy format
  const reactionCounts = parseReactions(msg.reactions, msg.channel);
  const hasReactions = Object.keys(reactionCounts).length > 0;

  // Selection state for this message
  const isMsgSelected = isSelecting && selectedMsgIds.has(msg.msg_id);
  const isGroupedFirst = !!groupedFirstMsgs[msg.msg_id];

  // Toggle selection for this message (and all images in group if applicable)
  const toggleMsgSelect = () => {
    if (!isSelecting) return;
    setSelectedMsgIds(prev => {
      const next = new Set(prev);
      if (isGroupedFirst) {
        // Select/deselect ALL images in the media group
        const allIds = groupedFirstMsgs[msg.msg_id].map((m: any) => m.msg_id);
        const allSelected = allIds.every((id: string) => next.has(id));
        if (allSelected) { allIds.forEach((id: string) => next.delete(id)); }
        else { allIds.forEach((id: string) => next.add(id)); }
      } else {
        if (next.has(msg.msg_id)) next.delete(msg.msg_id);
        else next.add(msg.msg_id);
      }
      return next;
    });
  };

  // First visible message: attach ref for IntersectionObserver (loadMore trigger)
  return (
    <div key={msg.msg_id + idx} id={`msg-${msg.msg_id}`} data-msg-ids={getRowMsgIds(msg)} data-out={isSent ? '' : undefined}
      className={`flex flex-col mb-0.5 rounded-lg transition-colors ${isEcardMsg ? 'items-center' : isSent ? 'items-end' : 'items-start'} group/msg${isMsgSelected ? ' bg-blue-500/10 ring-1 ring-blue-500/40 rounded-lg' : ''}${isSelecting && !isEcardMsg ? ' cursor-pointer' : ''}`}
      onClick={isSelecting && !isEcardMsg ? (e) => {
        // Skip click nếu vừa kết thúc drag-select (tránh toggle ngay sau drag)
        if (Date.now() < clickSuppressUntilRef.current) return;
        e.stopPropagation(); toggleMsgSelect();
      } : undefined}
      onPointerDown={!isEcardMsg ? (e) => {
        // Không intercept pointerdown trên interactive elements
        const target = e.target as HTMLElement;
        if (target.closest('a, button, img, video, audio, [role="button"], input, textarea, select')) return;
        dragSelectRef.current = {
          startMsgId: msg.msg_id,
          startIdx: idx,
          hasActivated: false,
        };
      } : undefined}
    >
      {daySeparator}

      {/* Outer row: bubble + action buttons */}
      <div className={`flex items-end gap-1 ${isEcardMsg ? 'w-full justify-center' : isSent ? 'flex-row-reverse' : 'flex-row'}`} style={{ maxWidth: '100%' }}>
        {/* Selection checkbox - visible when in selection mode */}
        {isSelecting && !isEcardMsg && (
          <div className="w-5 h-5 flex-shrink-0 self-center mb-1">
            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isMsgSelected ? 'bg-blue-500 border-blue-500' : 'border-border-strong bg-transparent'}`}>
              {isMsgSelected && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
              )}
            </div>
          </div>
        )}
        {/* Bubble area */}
        <div
          className={`flex items-end gap-2 min-w-0 ${isEcardMsg ? 'w-full' : isSent ? 'flex-row-reverse' : 'flex-row'}`}
          onContextMenu={(e) => {
            if (isSelecting) { e.preventDefault(); return; } // Suppress context menu in selection mode
            if (isEcardMsg) return;
            if (isGroupedStickerFirst) return; // Mỗi sticker trong nhóm tự xử lý context menu
            // Nếu người dùng đang chọn text → để browser xử lý (copy tự nhiên)
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            e.preventDefault();
            // Album: ảnh được bấm chuột phải (Copy hình ảnh / Lưu về máy / đánh dấu áp vào đúng ảnh đó, như Zalo)
            const albumTile = (e.target as HTMLElement)?.closest?.('[data-album-msg-id]') as HTMLElement | null;
            const albumMsgId = albumTile?.dataset.albumMsgId;
            const mediaMsg = albumMsgId
              ? (groupedFirstMsgs[msg.msg_id] || []).find((m: any) => String(m.msg_id) === albumMsgId)
              : undefined;
            setContextMenu({ x: e.clientX, y: e.clientY, msg, mediaMsg, isSent, isGroupAdmin });
          }}
        >
          {!isSent && !isEcardMsg && (
            <SenderAvatar ctx={ctx} msg={msg} isLastInRun={isLastInRun} displayName={displayName} avatarUrl={avatarUrl}
              senderAvatarFallback={senderAvatarFallback} />
          )}

          {/* Employee avatar on right side - every message with handled_by_employee */}
          {isSent && !isEcardMsg && <HandledByEmployeeAvatar msg={msg} />}

          {/* Bài đăng kênh: cột không rộng hơn khung bài. Khung bài rộng min(30rem, 100%) theo chính cột này, lúc đo cột
              trình duyệt bỏ qua phần trăm → cột giãn hết khung chat, nút 👍 (góc của cột) và nút Trả lời lệch ra ngoài bài */}
          <div className={`flex flex-col ${isEcardMsg ? 'w-full items-center' : isSent ? 'items-end' : 'items-start'} relative min-w-0${hasReactions && !isGroupedStickerFirst && !telegramPostMeta ? ' mb-3' : ''}`}
            style={telegramPostMeta ? { maxWidth: TELEGRAM_POST_MAX_WIDTH } : undefined}>
            {/* Tên người gửi trong nhóm cho tin không khung (sticker…); tin có khung: trong bong bóng — nameInBubble */}
            {showGroupName && !nameInBubble && (
              <p className="flex items-center gap-2 mb-0.5 px-1 min-w-0 max-w-full">
                <span className={`chat-peer-${senderPeer ?? 5} chat-peer-name truncate text-xs font-semibold`}>{displayName}</span>
                {senderRank && <span className="chat-rank shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4">{senderRank}</span>}
              </p>
            )}
            {/* Sticker chuyển tiếp (không khung): nguồn đặt ngay trên sticker */}
            {telegramForward && isNoBubbleMsg && !telegramPostMeta && !bubbleShell && (
              <TelegramForwardHeader name={forwardName} sourceId={telegramForward.fromId} avatarUrl={forwardAvatar}
                postAuthor={telegramForward.postAuthor} className="mb-0.5 px-1" />
            )}
            <MessageTtlContext.Provider value={Number((msg as any).ttl) || 0}>
            <MessageStatusContext.Provider value={outgoingStatus}>
            <div style={telegramPostMeta ? (postEdgeMedia ? { width: TELEGRAM_POST_WIDTH } : { maxWidth: TELEGRAM_POST_WIDTH, minWidth: 'min(18rem, 100%)' }) : undefined}
              className={`rounded-lg text-sm break-words min-w-0 max-w-full overflow-hidden${inlineTime ? ' relative' : ''}${hasQuote && !isNoBubbleMsg ? ' min-w-[13rem]' : ''} ${
              telegramPostMeta ? `${isSent ? 'bg-bubble-out border border-bubble-out-border' : 'bg-bubble-in border border-bubble-in-border'} rounded-lg` :
              bubbleShell ? (isSent ? 'bg-bubble-out text-foreground border border-bubble-out-border' : 'bg-bubble-in text-foreground border border-bubble-in-border') :
              isNoBubbleMsg ? '' : isSent
                ? 'px-3 py-2 bg-bubble-out text-foreground border border-bubble-out-border'
                : 'px-3 py-2 bg-bubble-in text-foreground border border-bubble-in-border'
            } ${useEmployeeStore.getState().mode === 'employee' && (msg.send_status === 'pending' ? 'opacity-60' : msg.send_status === 'sending' ? 'opacity-80' : '')}`}>
            {/* Bài đăng: media sát mép (chữ tự đệm trong khung ảnh / video), bài chữ có đệm; người đăng ở chân bài */}
            <div className={telegramPostMeta && !postEdgeMedia ? 'px-3 pt-2' : undefined}>
            {/* Tên người gửi (màu theo người gửi, bấm mở hồ sơ) + chức vụ ở góc phải, đầu bong bóng. Khung bao ảnh /
                file (nameShell): tên không kéo rộng khung (w-0 min-w-full) — rộng theo ảnh như Telegram */}
            {nameInBubble && (
              <div className={`flex items-center gap-2 min-w-0 ${bubbleShell ? `px-2.5 pt-1.5${quoteShell ? '' : ' pb-1.5'}` : 'mb-0.5'}${nameShell ? ' w-0 min-w-full' : ''}`}>
                <button
                  type="button"
                  className={`chat-peer-${senderPeer ?? 5} chat-peer-name min-w-0 truncate text-left text-[13px] font-semibold leading-5 hover:underline`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setUserProfilePopup({ userId: msg.sender_id, x: e.clientX, y: e.clientY });
                  }}
                >
                  {displayName}
                </button>
                {senderRank && (
                  <span className="chat-rank ml-auto shrink-0 rounded-full px-1.5 py-px text-[11px] leading-4">{senderRank}</span>
                )}
              </div>
            )}
            {/* Tin chuyển tiếp: nguồn ở đầu bong bóng, trên trích dẫn (như Telegram). Khung bao ảnh / file: chữ xuống dòng
                theo bề rộng ảnh, không kéo rộng khung (w-0 min-w-full) */}
            {telegramForward && (!isNoBubbleMsg || telegramPostMeta || bubbleShell) && (
              <TelegramForwardHeader name={forwardName} sourceId={telegramForward.fromId} avatarUrl={forwardAvatar}
                postAuthor={telegramForward.postAuthor}
                className={bubbleShell ? `w-0 min-w-full px-2.5 pb-1.5${nameInBubble ? '' : ' pt-1.5'}` : postEdgeMedia ? 'mb-1 px-3 pt-2' : 'mb-1'} />
            )}
            <TelegramPostLayoutContext.Provider value={postEdgeMedia}>
            {/* Bài đăng kênh: tệp / thoại / bình chọn… nằm trong khung bài, không lồng thêm bong bóng riêng */}
            <BubbleEmbedContext.Provider value={bubbleShell || !!telegramPostMeta}>
            {/* Quote preview - supports both pre-built quote_data and reply_to_id fallback */}
            {(msg.quote_data || (msg.reply_to_id && !(
              msg.channel === 'telegram_user' && msg.topic_id != null &&
              String(msg.reply_to_id) === String(msg.topic_id)
            ))) && (
              <QuotePreview ctx={ctx} msg={msg} isSent={isSent} quoteShell={quoteShell} isNoBubbleMsg={isNoBubbleMsg}
                postEdgeMedia={postEdgeMedia} />
            )}

            <SharedMessageContent
              msg={msg}
              isSelf={isSent}
              senderName={!isSent ? displayName : undefined}
              onManage={() => setManageGroupOpen(true)}
              onView={openViewer}
              onOpenProfile={(userId, e) => setUserProfilePopup({ userId, x: e.clientX, y: e.clientY })}
              inlineButtons={(() => {
                try { return msg.inline_buttons ? JSON.parse(msg.inline_buttons) : undefined; } catch { return undefined; }
              })()}
              onInlineButtonClick={(btn) => {
                if (btn.type === 'url' && btn.url) {
                  window.open(btn.url, '_blank');
                } else if (btn.type === 'webview' && btn.url) {
                  setWebviewModal({ botId: msg.sender_id, url: btn.url, title: btn.text });
                }
              }}
              isGroupMedia={isGroupMedia}
              isPoll={isPollMsg}
              isVideo={isVideoMsg}
              isVoice={isVoiceMsg}
              isFile={isFileMsg}
              isMedia={isMediaMsg}
              isCard={isCardMsg}
              isEcard={isEcardMsg}
              isSticker={isStickerMsg}
              isRtf={isRtf}
              isBankCard={isBankCardMsg}
              isLocation={isLocationMsg}
              isFbTemplate={isFbTemplateMsg}
              renderFbTemplate={() => <FacebookTemplateCard msg={msg} isSent={isSent} />}
              isZinstant={isZinstantMsg}
              renderZinstant={() => <ZaloOaCard msg={msg} isSent={isSent} />}
              renderGroupMedia={() => <MediaGroupBubble msgs={groupMediaMsgs!} onView={openViewer} isSent={isSent} isSelecting={isSelecting} selectedMsgIds={selectedMsgIds}
                allContacts={contactList} groupMembersList={groupMembers}
                onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })}
                onToggleSelect={(id) => {
                setSelectedMsgIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
              }} onVideoPlay={openVideoPlayer} />}
              renderPoll={() => msg.msg_type === 'group.poll'
                ? <PollBubble msg={msg} isSent={isSent} activeAccountId={activeAccountId || ''} threadId={activeThreadId || ''} />
                : <TelegramPollBubble msg={msg} isSent={isSent} />
              }
              renderVideo={() => <VideoMessageBody ctx={ctx} msg={msg} telegramPostMeta={telegramPostMeta} />}
              renderVoice={() => <VoiceBubble msg={msg} isSent={isSent} />}
              renderFile={() => <FileBubble msg={msg} isSent={isSent} />}
              renderMedia={() => (
                <MediaBubble msg={msg} onView={openViewer} isSent={isSent}
                  allContacts={contactList} groupMembersList={groupMembers}
                  onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
              )}
              renderCard={() => (
                <CardBubble
                  msg={msg}
                  isSent={isSent}
                  allContacts={contactList}
                  groupMembersList={groupMembers}
                  onOpenProfile={(userId, e) => setUserProfilePopup({ userId, x: e.clientX, y: e.clientY })}
                />
              )}
              renderBankCard={() => <BankCardBubble msg={msg} />}
              renderEcard={() => <EcardBubble msg={msg} onManage={() => setManageGroupOpen(true)} />}
              renderSticker={() => isGroupedStickerFirst
                ? <StickerGroupBubble
                    msgs={groupStickerMsgs!}
                    onContextMenu={(e, stickerMsg) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, msg: stickerMsg, isSent, isGroupAdmin });
                    }}
                  />
                : <StickerBubble msg={msg}
                    onOpenSet={isTelegramUser(msg.channel) && /^\d+$/.test(String(msg.msg_id || '')) ? () => openStickerSetOfMessage(msg) : undefined} />
              }
              renderRtf={() => (
                <RtfBubble msg={msg} allContacts={contactList} groupMembersList={groupMembers}
                  onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
              )}
              renderText={() => isFbEmptyMsg ? <FacebookEmptyMessage msg={msg} /> : (
                <TextMessageBody ctx={ctx} msg={msg} isSent={isSent} content={content} richBlocks={richBlocks}
                  telegramPostMeta={telegramPostMeta} inlineTime={inlineTime} outgoingStatus={outgoingStatus} />
              )}
            />
            </BubbleEmbedContext.Provider>
            </TelegramPostLayoutContext.Provider>
            </div>
            {!telegramPostMeta && !isNoBubbleMsg && (inlineTime ? (
              <span className="absolute bottom-1.5 right-2.5 inline-flex items-center gap-0.5 text-[11px] leading-none text-subtle-foreground select-none cursor-default"
                title={formatFullDateTime(msg.timestamp)}>
                <TtlMark ttl={(msg as any).ttl} sentAt={msg.timestamp} />
                {formatBubbleTime(msg.timestamp)}
                <StatusTicks status={outgoingStatus} />
              </span>
            ) : (
              <BubbleTime timestamp={msg.timestamp} />
            ))}
            {telegramPostMeta && (
              <TelegramPostRowFooter ctx={ctx} msg={msg} isSent={isSent} telegramPostMeta={telegramPostMeta}
                postStats={postStats} reactionCounts={reactionCounts} hasReactions={hasReactions} />
            )}
          </div>
          </MessageStatusContext.Provider>
          </MessageTtlContext.Provider>


          {/* Nút reaction ở góc dưới, phía TRONG khung chat (như các app lớn): tin của mình → góc trái, tin người
              khác → góc phải — gần giữa màn hình, dễ với tới; thanh chọn mọc lên từ nút, tin sát mép trên thì mọc
              xuống. Đang mở → z-30: chip reaction của các tin bên dưới (z-20, sau trong DOM) không đè lên thanh */}
          {channelCap.supportsReaction && !isEcardMsg && !isGroupedStickerFirst && (
            <MessageReactions ctx={ctx} msg={msg} isSent={isSent} reactionCounts={reactionCounts} telegramPostMeta={telegramPostMeta} />
          )}

          {/* ── Send status indicator (optimistic messages) ──── */}
          {/* Only show in employee mode — boss sends directly via Zalo (fast, no need for status) */}
          {isSent && msg.send_status && msg.send_status !== 'received' && useEmployeeStore.getState().mode === 'employee' && (
            <SendStatusIndicator ctx={ctx} msg={msg} />
          )}

          </div>{/* end flex flex-col (bubble content column) */}
        </div>{/* end bubble area (flex items-end gap-2) */}

        {/* Hover action buttons - visible on msg hover, outside bubble */}
        {!isEcardMsg && !isGroupedStickerFirst && !isSelecting && (
        <MessageHoverActions ctx={ctx} msg={msg} isSent={isSent} />
        )}
      </div>{/* end outer row */}

    </div>
  );
}
