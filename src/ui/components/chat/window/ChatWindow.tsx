/**
 * Khung chat của hội thoại đang mở. File này chỉ GHÉP các phần (mỗi phần một file nhỏ, sửa / nâng cấp riêng):
 *   hooks/      logic (hội thoại, danh sách tin + cuộn, tải tin cũ, nhảy tới tin, chọn nhiều tin, thao tác trên tin…)
 *   rows/       một hàng tin (renderMessageRow) + dữ liệu hàng cần (rowContext)
 *   parts/      phần giao diện nhỏ (thanh chọn nhiều tin, đang nhập, đã xem, nút cuộn, popup / hộp thoại…)
 *   channels/   phần riêng từng kênh (tải tin cũ từ server, tải tin để nhảy tới, thành viên nhóm; Telegram: topic forum…)
 * Thứ tự gọi hook giữ đúng thứ tự effect của bản cũ (reset khi đổi hội thoại → thanh ghim → khôi phục cuộn). Xem README.md.
 */
import { useRef } from 'react';
import { useQuickErpAccess } from '@/hooks/erp/useQuickErpAccess';
import { useTelegramChatReactions } from '@/lib/chat/reactions/reactionChoices';
import { useReactionHoverPicker } from '../messages/reactions/MessageReactionCorner';
import PinnedBar, { usePinnedData } from '../messages/PinnedMessages';
import ChatHistoryList from '../messages/ChatHistoryList';
import StickyDayPill from './parts/StickyDayPill';
import { useOpenThread } from './hooks/useOpenThread';
import { useMessageListState } from './hooks/useMessageListState';
import { useChatWindowDialogs } from './hooks/useChatWindowDialogs';
import { useRowDisplayState } from './hooks/useRowDisplayState';
import { useMediaViewers } from './hooks/useMediaViewers';
import { useFileDrop } from './hooks/useFileDrop';
import { useMessageSelection } from './hooks/useMessageSelection';
import { useTypingTicker } from './hooks/useTypingTicker';
import { useMessageGrouping } from './hooks/useMessageGrouping';
import { useSenderDirectory } from './hooks/useSenderDirectory';
import { useThreadLifecycle } from './hooks/useThreadLifecycle';
import { useOlderMessages } from './hooks/useOlderMessages';
import { useScrollFollow } from './hooks/useScrollFollow';
import { useThreadMediaMaintenance } from './hooks/useThreadMediaMaintenance';
import { useGroupMembers } from './hooks/useGroupMembers';
import { useMessageActions } from './hooks/useMessageActions';
import { useJumpToMessage } from './hooks/useJumpToMessage';
import { useChannelThreadSync } from './channels';
import { renderMessageRow } from './rows/MessageRow';
import type { MessageRowContext } from './rows/rowContext';
import { NoThreadSelected } from './parts/NoThreadSelected';
import { DropOverlay } from './parts/DropOverlay';
import { ForumTopicBar } from './parts/ForumTopicBar';
import { FriendRequestArea } from './parts/FriendRequestArea';
import { ScrollToLatestButton } from './parts/ScrollToLatestButton';
import { LoadOlderButton } from './parts/LoadOlderButton';
import { EmptyMessages } from './parts/EmptyMessages';
import { SelectionBar } from './parts/SelectionBar';
import { TypingIndicator } from './parts/TypingIndicator';
import { SeenIndicator } from './parts/SeenIndicator';
import { ChatWindowModals } from './parts/ChatWindowModals';

export default function ChatWindow() {
  // ─── Hội thoại đang mở (chỉ đúng phần store của hội thoại này) ────────────────────────────────────────────────────
  const thread = useOpenThread();
  const {
    activeAccountId, getActiveAccount, allAccounts, activeThreadId, activeTopicId, activeForumTopicId, activeTopicTitle,
    threadKey, prependMessages, setMessages, setReplyTo, setEditingMsg, removeMessage, updateContact, messagesLoading,
    msgs, contactList, threadTypingKey, threadSeen, threadGroupInfo, activeContact, channelCap, threadReceipt,
    telegramGroupAdmins, postReplierPeers, showNotification, searchHighlightQuery,
  } = thread;

  // ─── Danh sách tin: khung cuộn, cờ sẵn sàng, phân trang (dùng chung cho các hook bên dưới) ─────────────────────────
  const list = useMessageListState();
  const {
    bottomRef, messagesContainerRef, messagesContentRef, pinnedBarWrapperRef, loadingMore, hasMore, olderKnown, loadError,
    atBottom, isViewingHistory, loadingLatest, threadReady, initialLoading, loadingSpinner,
  } = list;

  // Quản lý công việc: "Thêm vào lịch" / "Lưu vào ghi chú" từ tin (chuột phải một tin, hoặc chọn nhiều tin)
  const erpAccess = useQuickErpAccess();
  // Thanh chọn cảm xúc: giữ chuột 300 ms trên nút mới mở (lia ngang qua không tự bật), bấm thì mở ngay, rời thì đóng sau
  // 250 ms — dùng chung với phần bình luận bài đăng kênh (MessageReactionCorner)
  const {
    openId: reactionPickerMsgId, open: openReactionPicker, arm: armReactionPicker,
    scheduleClose: scheduleCloseReactionPicker, close: closeReactionPicker,
  } = useReactionHoverPicker();
  // Telegram: reaction dùng được trong hội thoại đang mở (tải khi mở thanh chọn / menu chuột phải)
  const telegramReactions = useTelegramChatReactions(activeAccountId, activeThreadId, activeContact?.channel === 'telegram_user');

  // ─── Menu / popup / hộp thoại, trạng thái hiển thị hàng, trình xem media, kéo thả file, chọn nhiều tin ────────────
  const dialogs = useChatWindowDialogs(telegramReactions);
  const {
    contextMenu, setContextMenu, forwardMsgs, setForwardMsgs, erpDraft, setErpDraft,
    reactionPopup, setReactionPopup, reactionContextMenu, setReactionContextMenu,
    userProfilePopup, setUserProfilePopup, manageGroupOpen, setManageGroupOpen,
    noteModal, setNoteModal, webviewModal, setWebviewModal,
  } = dialogs;
  const {
    failedMsgAvatars, setFailedMsgAvatars, avatarRefreshAttempted,
    revealedRecallIds, setRevealedRecallIds, revealedEditIds, setRevealedEditIds,
  } = useRowDisplayState();
  const msgsRef = useRef<any[]>([]);
  const {
    videoPlayerState, setVideoPlayerState, buildImageEntry, mediaGalleryRef, openViewer, openImageList, openVideoPlayer,
  } = useMediaViewers(msgsRef, activeThreadId);
  const { isDragging, handleDragEnter, handleDragLeave, handleDragOver, handleDrop } = useFileDrop(activeThreadId);
  const {
    isSelecting, setIsSelecting, selectedMsgIds, setSelectedMsgIds, dragSelectRef, clickSuppressUntilRef,
  } = useMessageSelection(msgsRef);
  const typingNow = useTypingTicker(activeAccountId, activeThreadId, threadTypingKey);

  // ─── Pinned messages + notes (OPTIMIZED: 1 IPC call thay vì 2) ──────────────
  const { pins, setPins, pinnedNotes, setPinnedNotes, ready: pinsReady } = usePinnedData(activeAccountId, activeThreadId, activeContact?.channel);

  msgsRef.current = msgs;

  // ─── Riêng từng kênh khi mở hội thoại (Telegram: tin topic forum, sửa dữ liệu cũ, đồng bộ cảm xúc) ─────────────────
  useChannelThreadSync({ activeAccountId, activeThreadId, activeTopicId, activeContact, msgs, threadKey, threadReady, setMessages });

  // ─── Gom tin để vẽ + tra người gửi ─────────────────────────────────────────────────────────────────────────────────
  const {
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, groupedStickerFirstMsgs, groupedStickerSkipIds,
    dayStartIds, msgIndexById, findMsgById, msgTypeCache, getRowMsgIds,
  } = useMessageGrouping(msgs);
  const {
    contactMap, getContact, groupMembers, getGroupMember, erpSourceOf, isGroupAdmin, resolveQuoteAuthor, resolveStarSender,
  } = useSenderDirectory({ contactList, threadGroupInfo, activeAccountId, activeThreadId, activeContact, allAccounts, findMsgById });

  // ─── Vòng đời hội thoại, tải tin cũ, bám đáy / giữ vị trí cuộn ─────────────────────────────────────────────────────
  useThreadLifecycle(list, {
    activeAccountId, activeThreadId, threadKey, msgs, messagesLoading, pinsReady,
    onThreadSwitch: () => {
      // Reset selection mode when switching threads
      setIsSelecting(false);
      setSelectedMsgIds(new Set());
      // Thanh chọn reaction của hội thoại trước: tin đó bị gỡ khỏi DOM nên không có mouseleave → đóng + huỷ hẹn giờ
      // (kẻo bật lên trên lớp "Đang tải..." hoặc quay lại hội thoại cũ vẫn thấy thanh mở)
      closeReactionPicker();
    },
  });
  const { handleLoadMore, maybeLoadOlder } = useOlderMessages(list, {
    activeAccountId, activeThreadId, activeTopicId, getActiveAccount, prependMessages,
  });
  useScrollFollow(list, { activeAccountId, activeThreadId, activeContact, msgs, pins, pinnedNotes, maybeLoadOlder });

  // ─── Chạy nền khi mở hội thoại: ảnh hỏng / nạp sẵn media, thành viên nhóm + người gửi chưa biết ────────────────────
  useThreadMediaMaintenance({ threadReady, activeAccountId, activeThreadId, msgs });
  useGroupMembers({ activeAccountId, activeThreadId, msgs, threadGroupInfo, activeContact, getContact, getGroupMember });

  // ─── Thao tác trên tin + nhảy tới tin ──────────────────────────────────────────────────────────────────────────────
  const {
    getAuth, handleUndo, handleDelete, handleDeleteFromDb, handleReact, handleCancelReaction, handleForward, runForward,
    handleSaveToMyDocuments, contextTargetStarred, handleToggleStar, handlePin,
  } = useMessageActions({
    activeAccountId, activeThreadId, activeContact, contactList, allAccounts, getActiveAccount, showNotification,
    removeMessage, groupedFirstMsgs, setForwardMsgs, contextMenu, pins, setPins, getContact, getGroupMember, resolveStarSender,
  });
  const { handleScrollToMsg, handleReturnToLatest } = useJumpToMessage(list, {
    activeAccountId, activeThreadId, activeTopicId, activeContact, messagesLoading, setMessages, showNotification,
  });

  if (!activeThreadId) {
    return <NoThreadSelected />;
  }

  // Dữ liệu cho từng hàng tin (rows/rowContext.ts)
  const rowCtx: MessageRowContext = {
    activeAccountId, activeThreadId, activeContact, channelCap, msgs, contactList, threadReceipt,
    telegramGroupAdmins, postReplierPeers, searchHighlightQuery, updateContact, removeMessage, setReplyTo,
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, groupedStickerFirstMsgs, groupedStickerSkipIds,
    dayStartIds, msgIndexById, findMsgById, msgTypeCache, getRowMsgIds,
    getContact, getGroupMember, groupMembers, isGroupAdmin, resolveQuoteAuthor,
    failedMsgAvatars, setFailedMsgAvatars, avatarRefreshAttempted,
    revealedRecallIds, setRevealedRecallIds, revealedEditIds, setRevealedEditIds,
    isSelecting, selectedMsgIds, setSelectedMsgIds, dragSelectRef, clickSuppressUntilRef,
    setContextMenu, setErpDraft, setManageGroupOpen, setReactionPopup, setUserProfilePopup, setWebviewModal,
    openViewer, openImageList, openVideoPlayer,
    handleReact, handleCancelReaction, handleScrollToMsg,
    telegramReactions, reactionPickerMsgId, openReactionPicker, armReactionPicker,
    scheduleCloseReactionPicker, closeReactionPicker,
    erpAccess,
  };

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && <DropOverlay />}

      {/* ── Telegram Forum topic bar — shows active topic with back-to-topics ── */}
      {activeTopicId && activeTopicTitle && activeContact?.channel === 'telegram_user' && (
        <ForumTopicBar activeForumTopicId={activeForumTopicId} activeTopicTitle={activeTopicTitle} />
      )}

      {/* ── Pinned messages + notes bar - chỉ hiện khi ready ── */}
      {threadReady && activeAccountId && activeThreadId && (
        <div ref={pinnedBarWrapperRef}>
          {(pins.length > 0 || pinnedNotes.length > 0) && (
            <PinnedBar
              zaloId={activeAccountId}
              threadId={activeThreadId}
              pins={pins}
              onPinsChange={setPins}
              onScrollToMsg={handleScrollToMsg}
              pinnedNotes={pinnedNotes}
              onNoteClick={(note) => setNoteModal({ topicId: note.topicId, title: note.title, creatorName: note.creatorName, createTime: note.createTime })}
              channel={activeContact?.channel}
            />
          )}
        </div>
      )}

      {/* ── Friend request bar (chỉ hiện khi chat 1-1 với người chưa là bạn bè) ── */}
      {threadReady && activeAccountId && activeThreadId && (
        <FriendRequestArea activeAccountId={activeAccountId} activeThreadId={activeThreadId} allAccounts={allAccounts}
          contactMap={contactMap} getAuth={getAuth} messagesContainerRef={messagesContainerRef} />
      )}

      {/* ── Floating button: cuộn xuống / về tin nhắn mới nhất ── */}
      {/* z-30: trên chip reaction của tin (absolute z-20, nằm SAU nút trong DOM nên trước đây đè lên nút); dưới bảng chọn
          reaction và lớp "Đang tải..." (z-30, sau trong DOM), lớp thả file (z-40), hộp thoại (z-50). Nền card + viền +
          bóng nổi rõ trên nền hội thoại cả 2 theme (bg-muted/80 cũ gần trùng màu nền sáng #eceef3). */}
      {threadReady && !atBottom && (
        <ScrollToLatestButton isViewingHistory={isViewingHistory} handleReturnToLatest={handleReturnToLatest}
          bottomRef={bottomRef} loadingLatest={loadingLatest} />
      )}

      {/* Messages container - luôn render khi có thread active, skeleton hiển thị bên trong khi loading */}
      {/* Giúp tránh "double flash" do container mount/unmount khi chuyển thread */}
      {activeAccountId && activeThreadId && (
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto [overflow-anchor:auto] relative" style={{ willChange: 'scroll-position' }}>
        <StickyDayPill containerRef={messagesContainerRef} />
        {/* Lớp "Đang tải..." khi mở hội thoại: z-30 — trên chip reaction / nút 👍 (z-20), nhãn ngày dính (z-20) và nút cuộn
            xuống (z-30, trước trong DOM); dưới popup ô soạn tin (z-30, sau trong DOM), lớp thả file (z-40), hộp thoại (z-50).
            Không xuyên chuột: rê / bấm không trúng tin đang ẩn bên dưới (thanh chọn reaction z-30 không mở được khi đang tải).
            Vòng xoay chỉ hiện khi tải lâu hơn ~300 ms (chat-loading-reveal): tin trong máy mở gần như tức thì → không nháy
            "Đang tải..." mỗi lần chuyển hội thoại; lớp nền vẫn che ngay để không thấy danh sách trước khi cuộn xuống đáy. */}
        {loadingSpinner && <div className="absolute inset-0 z-30 flex items-center justify-center bg-background"><div className="chat-loading-reveal flex flex-col items-center gap-3"><div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin"></div><p className="text-sm text-muted-foreground">Đang tải...</p></div></div>}
        <div ref={messagesContentRef} className="p-4 space-y-1.5">
        {/* Load More Button - Hiển thị trên tin nhắn đầu tiên (cũ nhất). Chỉ khi đang tải lâu, lỗi, hoặc đã biết
            chắc còn tin cũ — "có thể còn" (mặc định khi mở) không hiện: cuộn gần đỉnh sẽ tự tải. */}
        {msgs.length > 0 && (loadError || loadingMore || (hasMore && olderKnown)) && (
          <LoadOlderButton handleLoadMore={handleLoadMore} loadingMore={loadingMore} loadError={loadError} />
        )}

        {/* Empty state - no messages yet */}
        {msgs.length === 0 && !initialLoading && !messagesLoading && <EmptyMessages />}

        <ChatHistoryList items={msgs} bottomRef={bottomRef} renderItem={(msg, idx) => renderMessageRow(rowCtx, msg, idx)} />
        </div>
      </div>
      )}

      {/* Selection action bar */}
      {isSelecting && (
        <SelectionBar msgs={msgs} selectedMsgIds={selectedMsgIds} setIsSelecting={setIsSelecting}
          setSelectedMsgIds={setSelectedMsgIds} showNotification={showNotification} erpAccess={erpAccess}
          setErpDraft={setErpDraft} channelCap={channelCap} setForwardMsgs={setForwardMsgs} />
      )}

      {/* Typing indicator - hiển thị phía trên input, không chồng lên nội dung */}
      {threadReady && activeAccountId && activeThreadId && typingNow > 0 && (
        <TypingIndicator activeAccountId={activeAccountId} activeThreadId={activeThreadId} contactList={contactList} />
      )}

      {/* Seen indicator for sent messages */}
      {threadReady && activeAccountId && activeThreadId && (
        <SeenIndicator activeAccountId={activeAccountId} activeThreadId={activeThreadId} contactList={contactList} threadSeen={threadSeen} />
      )}

      <ChatWindowModals
        activeAccountId={activeAccountId} activeThreadId={activeThreadId} activeContact={activeContact}
        allAccounts={allAccounts} channelCap={channelCap} contactList={contactList} threadGroupInfo={threadGroupInfo}
        setReplyTo={setReplyTo} setEditingMsg={setEditingMsg} showNotification={showNotification}
        groupedFirstMsgs={groupedFirstMsgs}
        contactMap={contactMap} getContact={getContact} getGroupMember={getGroupMember} groupMembers={groupMembers}
        erpSourceOf={erpSourceOf}
        {...dialogs}
        setIsSelecting={setIsSelecting} setSelectedMsgIds={setSelectedMsgIds}
        mediaGalleryRef={mediaGalleryRef} buildImageEntry={buildImageEntry}
        videoPlayerState={videoPlayerState} setVideoPlayerState={setVideoPlayerState}
        handleUndo={handleUndo} handleDelete={handleDelete} handleDeleteFromDb={handleDeleteFromDb}
        handleReact={handleReact} handleCancelReaction={handleCancelReaction} handleForward={handleForward}
        runForward={runForward} handleSaveToMyDocuments={handleSaveToMyDocuments}
        contextTargetStarred={contextTargetStarred} handleToggleStar={handleToggleStar} handlePin={handlePin}
        setPinnedNotes={setPinnedNotes} telegramReactions={telegramReactions} erpAccess={erpAccess}
      />
    </div>
  );
}
