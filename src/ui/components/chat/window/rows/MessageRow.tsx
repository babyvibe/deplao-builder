/**
 * One row in the chat window: the date marker, then by type: system message (SystemNoticeRow), unsent / recalled message (RecalledRow), otherwise a message
 * bubble: sender avatar, name + role, forward, quote (QuotePreview), content by type
 * (SharedMessageContent; text: TextMessageBody, video: VideoMessageBody), time / ✓✓, Telegram channel post footer, reactions
 * (MessageReactions), employee send status, hover buttons. Photo album / sticker run / duplicate poll: only
 * the first message draws the row. Message types: messageKind.ts.
 */
import React from 'react';
import { groupRankLabel, peerColorIndex, telegramRankLabel } from '@/lib/chat/messages/peerStyle';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { BubbleTime, formatBubbleTime, formatFullDateTime, inlineTimeSpacerClass, MessageStatusContext, MessageTimeElsewhereContext, MessageTtlChannelContext, MessageTtlContext, StatusTicks, TtlMark } from '../../messages/MessageTime';
import { outgoingMessageStatus } from '@/lib/chat/messages/messageStatus';
import SharedMessageContent from '../../messages/SharedMessageContent';
import FacebookTemplateCard, { FacebookEmptyMessage } from '../../facebook/FacebookTemplateCard';
import ZaloOaCard from '../../zalo/messages/ZaloOaCard';
import { isFacebook, isTelegram as isTelegramCh, isTelegramUser } from '@/lib/channels/channelHelper';
import { BankCardBubble } from '../../messages/MessageBubbles';
import { getTelegramPostMeta } from '@/lib/media/mediaResolver';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { formatDaySeparator } from '@/lib/chat/messages/messageParser';
import PollBubble from '../../polls/PollBubble';
import TelegramPollBubble from '../../telegram/messages/TelegramPollBubble';
import FacebookPollBubble from '../../facebook/FacebookPollBubble';
import { pollPersonResolver } from './pollPeople';
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
import { MessageTelegramReactions } from './MessageTelegramReactions';
import { SendStatusIndicator } from './SendStatusIndicator';
import { MessageHoverActions } from './MessageHoverActions';
import { resolveTelegramForward } from '../channels/telegram/forwardSource';
import { TelegramPostRowFooter } from '../channels/telegram/TelegramPostRowFooter';
import { handleTelegramInlineButton } from '@/lib/chat/links/chatLinks';
import type { MessageRowContext } from './rowContext';

/** Date marker (the first displayed message of each calendar day) */
function renderDaySeparator(timestamp: number) {
  const label = formatDaySeparator(timestamp);
  return (
    <div className="flex justify-center w-full my-2" data-day-label={label}>
      <span className="text-[11px] text-white bg-black/20 dark:bg-white/15 px-2.5 py-0.5 rounded-full">{label}</span>
    </div>
  );
}

/** Draws one message row (renderItem of ChatHistoryList). Returns null for messages that do not draw their own row. */
export function renderMessageRow(ctx: MessageRowContext, msg: any, idx: number): React.ReactNode {
  const {
    activeAccountId, activeThreadId, activeContact, channelCap, msgs, contactList, threadReceipt, telegramGroupAdmins,
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, groupedStickerFirstMsgs, groupedStickerSkipIds, dayStartIds,
    msgIndexById, msgTypeCache, getRowMsgIds, getContact, getGroupMember, groupMembers, isGroupAdmin, revealedEditIds,
    isSelecting, selectedMsgIds, setSelectedMsgIds, dragSelectRef, clickSuppressUntilRef, setContextMenu,
    setManageGroupOpen, setUserProfilePopup, openViewer, openImageList, openVideoPlayer,
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

  // Start of a message run (sender changed / more than 30 minutes apart): show the sender's name in the group. Date marker: daySeparator.
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

  // Telegram style for every channel: color by sender (name, letter avatar), role next to the name (lib/chat/messages/peerStyle).
  // Role: Telegram → list of admins (custom titles) once loaded, otherwise by the group member role.
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

  // ── Recalled message: uses the shared RecalledBubble with MessageBubbles ─
  if (isRecalled) {
    return renderRecalledRow(ctx, { msg, idx, isSent, daySeparator, isLastInRun, displayName, avatarUrl, senderAvatarFallback });
  }

  // OPTIMIZATION: Use the cache instead of parsing the type again for each message (rows/messageKind)
  const {
    isCardMsg, isEcardMsg, isStickerMsg, isRtf, isPollMsg, isVideoMsg, isVoiceMsg, isBankCardMsg, isLocationMsg,
    isFbTemplateMsg, isZinstantMsg, isFbEmptyMsg, isGroupMedia, groupMediaMsgs, isMediaMsg, isFileMsg, content,
  } = classifyMessage(msg, msgTypeCache.get(msg.msg_id), groupedFirstMsgs);
  const telegramPostMeta = getTelegramPostMeta(msg);
  // Telegram: forwarded message → "Chuyển tiếp từ <nguồn>" (Forwarded from <source>) (channels/telegram/forwardSource)
  const { telegramForward, forwardName, forwardAvatar } = resolveTelegramForward(ctx, msg);
  // Telegram channel post (like Telegram): photo / album / video flush with the post frame; the counts include the whole album (Telegram attaches
  // the comment count to ONE message of the album; it used to read the first message, so the count was off / lost)
  const postEdgeMedia = !!telegramPostMeta && (isMediaMsg || isGroupMedia || isVideoMsg);
  const postStats = telegramPostMeta
    ? pickTelegramPostStats((groupMediaMsgs || [msg]).map((m: any) => ({ msgId: String(m.msg_id), meta: getTelegramPostMeta(m) })))
    : null;
  // Rich-format messages (headings, lists, tables, photos / videos inside the message)
  const richBlocks = isTelegramUser(msg.channel) ? getRichMessageBlocks(msg) : null;
  // Telegram system message (e.g. "Channel created") that an old version saved by mistake as an empty "bài đăng kênh" (channel post): do not draw an empty card.
  // Real posts always have text or media; the next history load turns the row into a notice line.
  if (telegramPostMeta && msg.msg_type === 'text' && !String(msg.content || '').trim() && !isGroupMedia) return null;

  // Reply to a photo / album / file / card: ONE bubble frame wrapping both the quote and the content (like Telegram)
  const isNoBubbleMsg = isMediaMsg || isGroupMedia || isFileMsg || isCardMsg || isEcardMsg || isStickerMsg || isBankCardMsg || isFbTemplateMsg || isZinstantMsg;
  const hasQuote = !!(msg.quote_data || (msg.reply_to_id && !(
    msg.channel === 'telegram_user' && msg.topic_id != null &&
    String(msg.reply_to_id) === String(msg.topic_id)
  )));
  const quoteShell = hasQuote && isNoBubbleMsg && !isEcardMsg && !isStickerMsg && !isBankCardMsg && !telegramPostMeta;

  // Sender name in a group (all channels): inside the bubble, colored by sender + role at the top right (like Telegram).
  // A photo / album / file / card message that starts a run: wraps it in ONE frame (like a reply message: quoteShell) so the name sits inside the frame;
  // sticker / greeting card / bank card with no frame → the name above the message stays as before (colored).
  // My sent messages: ✓ sent / ✓✓ received / ✓✓ in accent color = seen (channels without support → null, no mark drawn)
  const outgoingStatus = isSent ? outgoingMessageStatus(msg, msg.channel || activeContact?.channel, threadReceipt) : null;
  const showGroupName = !isSent && !isEcardMsg && msg.thread_type === 1 && startsRun && !!displayName && displayName !== msg.sender_id;
  const nameShell = showGroupName && isNoBubbleMsg && !quoteShell && !isStickerMsg && !isBankCardMsg && !telegramPostMeta;
  // Forwarded photos / album / file: "Chuyển tiếp từ …" (Forwarded from …) shares the frame with the content, text wraps to the photo width (like
  // Telegram); before, the source line sat above the photo, outside the frame, and if it was longer than the photo it pulled the whole message sideways
  const forwardShell = !!telegramForward && isNoBubbleMsg && !telegramPostMeta && !isStickerMsg && !isEcardMsg && !isBankCardMsg;

  // Sticker group: several consecutive stickers from the same sender within 30 minutes
  const isGroupedStickerFirst = isStickerMsg && !!groupedStickerFirstMsgs[msg.msg_id];
  const groupStickerMsgs = isGroupedStickerFirst ? groupedStickerFirstMsgs[msg.msg_id] : null;

  // Reactions: parse new PHP-like format or legacy format
  const reactionCounts = parseReactions(msg.reactions, msg.channel);
  const hasReactions = Object.keys(reactionCounts).length > 0;
  // Each channel like its app: Telegram chips INSIDE the message frame, Zalo's corner hangs from the bottom-right corner (its
  // button always shown on the last message of a run, like Zalo)
  const isTelegramMsg = isTelegramCh(msg.channel);
  // Messenger takes no reaction on a poll (its own app offers none there)
  const reactionsShown = channelCap.supportsReaction && !isEcardMsg && !isGroupedStickerFirst
    && !(isFacebook(msg.channel) && msg.msg_type === 'fb.poll');
  const telegramChips = reactionsShown && isTelegramMsg && hasReactions && !telegramPostMeta;
  // Telegram photo / album / file / contact card with reactions: ONE frame around the content and the chips (like Telegram, and like
  // a reply / forward); only a sticker keeps them right below it, without a frame
  const reactionShell = telegramChips && isNoBubbleMsg && !isStickerMsg && !isEcardMsg && !isBankCardMsg && !isFbTemplateMsg && !isZinstantMsg;
  const bubbleShell = quoteShell || nameShell || forwardShell || reactionShell;
  const telegramChipsInFrame = telegramChips && (!isNoBubbleMsg || reactionShell);
  // Like Telegram: with reaction chips in the frame, the send time moves to the end of the chips line (the frame's last line);
  // the photo badge / caption / file time inside the content is hidden (MessageTimeElsewhereContext)
  const timeOnReactionRow = telegramChipsInFrame;
  const nameInBubble = showGroupName && !telegramPostMeta && (!isNoBubbleMsg || bubbleShell);
  // Send time at the bottom right, on the same line as the last word if there is room (like Telegram): plain text messages only; messages with their own block
  // (polls, video, link cards with a site name / title, old content being viewed) keep their own time line. Telegram link messages
  // with no card (URL only) are plain text messages.
  const inlineTime = !isNoBubbleMsg && !telegramPostMeta && !isFbEmptyMsg && !richBlocks
    && !isPollMsg && !isVideoMsg && !isVoiceMsg && !isRtf && !isLocationMsg
    && !(msg.msg_type === 'telegram.webpage' && getTelegramWebpageMeta(msg)) && !revealedEditIds.has(msg.msg_id);

  // Zalo / Telegram reaction button: outer bottom corner (right of others' messages, left of yours), 16 px past the edge
  // (the hover buttons on that side start after it)
  const isZaloReactions = reactionsShown && !isTelegramMsg && !isFacebook(msg.channel);
  // Zalo's summary hangs 22 px under the frame (ZaloReactionCorner): keep that room before the next message
  const reactionGap = isZaloReactions && hasReactions ? ' mb-6'
    : reactionsShown && hasReactions && !telegramPostMeta && !isTelegramMsg && !isZaloReactions ? ' mb-3' : '';

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
        // Skip the click if a drag-select just ended (avoids toggling right after a drag)
        if (Date.now() < clickSuppressUntilRef.current) return;
        e.stopPropagation(); toggleMsgSelect();
      } : undefined}
      onPointerDown={!isEcardMsg ? (e) => {
        // Do not intercept pointerdown on interactive elements
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
            if (isGroupedStickerFirst) return; // Each sticker in the group handles its own context menu
            // If the user is selecting text → let the browser handle it (natural copy)
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            e.preventDefault();
            // Album: a photo that is right-clicked (Copy image / Save to computer / star applies to that exact photo, like Zalo)
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

          {/* Channel post: the column is not wider than the post frame. The post frame is min(30rem, 100%) of this column itself; when measuring the column,
              the browser ignores the percentage → the column stretches to the whole chat, and the 👍 button (the column's corner) and the Reply button fall outside the post */}
          <div className={`flex flex-col ${isEcardMsg ? 'w-full items-center' : isSent ? 'items-end' : 'items-start'} relative min-w-0${reactionGap}`}
            style={telegramPostMeta ? { maxWidth: TELEGRAM_POST_MAX_WIDTH } : undefined}>
            {/* Sender name in a group for messages without a frame (stickers…); messages with a frame: inside the bubble (nameInBubble) */}
            {showGroupName && !nameInBubble && (
              <p className="flex items-center gap-2 mb-0.5 px-1 min-w-0 max-w-full">
                <span className={`chat-peer-${senderPeer ?? 5} chat-peer-name truncate text-xs font-semibold`}>{displayName}</span>
                {senderRank && <span className="chat-rank shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4">{senderRank}</span>}
              </p>
            )}
            {/* Forwarded sticker (no frame): the source sits right above the sticker */}
            {telegramForward && isNoBubbleMsg && !telegramPostMeta && !bubbleShell && (
              <TelegramForwardHeader name={forwardName} sourceId={telegramForward.fromId} avatarUrl={forwardAvatar}
                postAuthor={telegramForward.postAuthor} className="mb-0.5 px-1" />
            )}
            <MessageTtlContext.Provider value={Number((msg as any).ttl) || 0}>
            <MessageTtlChannelContext.Provider value={String(msg.channel || '')}>
            <MessageStatusContext.Provider value={outgoingStatus}>
            <div style={telegramPostMeta ? (postEdgeMedia ? { width: TELEGRAM_POST_WIDTH } : { maxWidth: TELEGRAM_POST_WIDTH, minWidth: 'min(18rem, 100%)' }) : undefined}
              // No double-click reaction: a double-click selects a word, the quick reaction is the button at the message edge
              className={`rounded-lg text-sm break-words min-w-0 max-w-full overflow-hidden${inlineTime || timeOnReactionRow ? ' relative' : ''}${hasQuote && !isNoBubbleMsg ? ' min-w-[13rem]' : ''} ${
              telegramPostMeta ? `${isSent ? 'bg-bubble-out border border-bubble-out-border' : 'bg-bubble-in border border-bubble-in-border'} rounded-lg` :
              bubbleShell ? (isSent ? 'bg-bubble-out text-foreground border border-bubble-out-border' : 'bg-bubble-in text-foreground border border-bubble-in-border') :
              isNoBubbleMsg ? '' : isSent
                ? 'px-3 py-2 bg-bubble-out text-foreground border border-bubble-out-border'
                : 'px-3 py-2 bg-bubble-in text-foreground border border-bubble-in-border'
            } ${useEmployeeStore.getState().mode === 'employee' && (msg.send_status === 'pending' ? 'opacity-60' : msg.send_status === 'sending' ? 'opacity-80' : '')}`}>
            {/* Posts: media flush with the edge (the text pads itself inside the photo / video frame), text posts have padding; the poster sits in the post footer */}
            <div className={telegramPostMeta && !postEdgeMedia ? 'px-3 pt-2' : undefined}>
            {/* Sender name (colored by sender, click to open the profile) + role at the right corner, top of the bubble. Frame around a photo /
                file (nameShell): the name does not stretch the frame (w-0 min-w-full), it is as wide as the photo, like Telegram */}
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
            {/* Forwarded message: the source sits at the top of the bubble, above the quote (like Telegram). Frame around a photo / file: text wraps
                to the photo width, does not stretch the frame (w-0 min-w-full) */}
            {telegramForward && (!isNoBubbleMsg || telegramPostMeta || bubbleShell) && (
              <TelegramForwardHeader name={forwardName} sourceId={telegramForward.fromId} avatarUrl={forwardAvatar}
                postAuthor={telegramForward.postAuthor}
                className={bubbleShell ? `w-0 min-w-full px-2.5 pb-1.5${nameInBubble ? '' : ' pt-1.5'}` : postEdgeMedia ? 'mb-1 px-3 pt-2' : 'mb-1'} />
            )}
            <TelegramPostLayoutContext.Provider value={postEdgeMedia}>
            {/* Channel post: files / voice / polls… sit inside the post frame, without a separate bubble on top */}
            <BubbleEmbedContext.Provider value={bubbleShell || !!telegramPostMeta}>
            <MessageTimeElsewhereContext.Provider value={timeOnReactionRow}>
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
              onInlineButtonClick={(btn, row, col) => handleTelegramInlineButton(msg, btn, activeAccountId || '', displayName, { row, col })}
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
                : msg.msg_type === 'fb.poll'
                  ? <FacebookPollBubble msg={msg} isSent={isSent} accountId={activeAccountId || ''} threadId={activeThreadId || ''} getPerson={pollPersonResolver(ctx)} />
                  : <TelegramPollBubble msg={msg} isSent={isSent} />
              }
              renderVideo={() => <VideoMessageBody ctx={ctx} msg={msg} telegramPostMeta={telegramPostMeta} />}
              renderVoice={() => <VoiceBubble msg={msg} isSent={isSent} />}
              renderFile={() => <FileBubble msg={msg} isSent={isSent} onOpenImage={(image) => openImageList([image], 0)} />}
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
                  // Telegram reactions inside the frame: the send time moves to the end of the reaction line
                  telegramPostMeta={telegramPostMeta} inlineTime={inlineTime && !telegramChipsInFrame} outgoingStatus={outgoingStatus} />
              )}
            />
            </MessageTimeElsewhereContext.Provider>
            </BubbleEmbedContext.Provider>
            </TelegramPostLayoutContext.Provider>
            </div>
            {/* Telegram: reaction chips on the last line of the frame, close to the content, the send time at its end (like Telegram) */}
            {telegramChipsInFrame && (
              <MessageTelegramReactions ctx={ctx} msg={msg}
                // In a frame around a photo / file (no padding of its own): wrap within the content's width, like the forward header
                className={bubbleShell ? 'w-0 min-w-full px-2.5 pb-1.5 pt-1' : 'mt-1'}
                trailingSpacerClass={inlineTimeSpacerClass(!!outgoingStatus, (msg as any).ttl)} />
            )}
            {!telegramPostMeta && (inlineTime || timeOnReactionRow) ? (
              <span className="absolute bottom-1.5 right-2.5 inline-flex items-center gap-0.5 text-[11px] leading-none text-subtle-foreground select-none cursor-default"
                title={formatFullDateTime(msg.timestamp)}>
                <TtlMark ttl={(msg as any).ttl} sentAt={msg.timestamp} />
                {formatBubbleTime(msg.timestamp)}
                <StatusTicks status={outgoingStatus} />
              </span>
            ) : !telegramPostMeta && !isNoBubbleMsg ? (
              <BubbleTime timestamp={msg.timestamp} />
            ) : null}
            {telegramPostMeta && (
              <TelegramPostRowFooter ctx={ctx} msg={msg} isSent={isSent} telegramPostMeta={telegramPostMeta}
                postStats={postStats} reactionCounts={reactionCounts} hasReactions={hasReactions} />
            )}
          </div>
          {/* Telegram sticker (no frame, like Telegram): the chips right below it */}
          {telegramChips && isNoBubbleMsg && !reactionShell && <MessageTelegramReactions ctx={ctx} msg={msg} className="mt-1" />}
          </MessageStatusContext.Provider>
          </MessageTtlChannelContext.Provider>
          </MessageTtlContext.Provider>


          {/* Reactions per channel (MessageReactions): Zalo and Telegram: the button at the outermost bottom-right corner, right after the
              send time (Zalo's summary next to it, just under the frame); Facebook: the button at the bottom corner INSIDE the chat window
              (own message → left, others → right). Pickers pop up (down for a message flush with the top edge). When open → z-30: the
              reaction chips of the messages below (z-20, later in the DOM) do not cover the bar */}
          {reactionsShown && (
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
        <MessageHoverActions ctx={ctx} msg={msg} isSent={isSent} afterReactionButton={reactionsShown && (isTelegramMsg || isZaloReactions)} />
        )}
      </div>{/* end outer row */}

    </div>
  );
}
