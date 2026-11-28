/**
 * Chat window of the open conversation. This file only ASSEMBLES the parts (each part is a small file, edited / upgraded on its own):
 *   hooks/      logic (conversation, message list + scrolling, loading older messages, jumping to a message, multi-select, message actions…)
 *   rows/       one message row (renderMessageRow) + the data a row needs (rowContext)
 *   parts/      small UI pieces (multi-select bar, typing, seen, scroll button, popups / dialogs…)
 *   channels/   per-channel parts (load older messages from the server, load messages to jump to, group members; Telegram: forum topics…)
 * The hook call order keeps the same effect order as the old version (reset on conversation change → pinned bar → restore scroll). See README.md.
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
import { tr } from '../../../../shared/i18n';

export default function ChatWindow() {
  // ─── Open conversation (only the store slice of this conversation) ────────────────────────────────────────────────────
  const thread = useOpenThread();
  const {
    activeAccountId, getActiveAccount, allAccounts, activeThreadId, activeTopicId, activeForumTopicId, activeTopicTitle,
    threadKey, prependMessages, setMessages, setReplyTo, setEditingMsg, removeMessage, updateContact, messagesLoading,
    msgs, contactList, threadTypingKey, threadSeen, threadGroupInfo, activeContact, channelCap, threadReceipt,
    telegramGroupAdmins, postReplierPeers, showNotification, searchHighlightQuery,
  } = thread;

  // ─── Message list: scroll container, ready flag, paging (shared by the hooks below) ─────────────────────────
  const list = useMessageListState();
  const {
    bottomRef, messagesContainerRef, messagesContentRef, pinnedBarWrapperRef, loadingMore, hasMore, olderKnown, loadError,
    atBottom, isViewingHistory, loadingLatest, threadReady, initialLoading, loadingSpinner,
  } = list;

  // Task management: "Thêm vào lịch" (Add to calendar) / "Lưu vào ghi chú" (Save to notes) from a message (right-click a message, or select several messages)
  const erpAccess = useQuickErpAccess();
  // Reaction bar: hold the mouse 300 ms on the newly opened button (a quick pass over it does not open it); a click opens it at once, leaving closes it after a delay
  // 250 ms: shared with the comment part of channel posts (MessageReactionCorner)
  const {
    openId: reactionPickerMsgId, open: openReactionPicker, arm: armReactionPicker,
    scheduleClose: scheduleCloseReactionPicker, close: closeReactionPicker,
  } = useReactionHoverPicker();
  // Telegram: reactions available in the open conversation (loaded when the reaction bar / right-click menu opens)
  const telegramReactions = useTelegramChatReactions(activeAccountId, activeThreadId, activeContact?.channel === 'telegram_user');

  // ─── Menus / popups / dialogs, row display state, media viewer, file drag & drop, multi-select ────────────
  const dialogs = useChatWindowDialogs(telegramReactions);
  const {
    contextMenu, setContextMenu, forwardMsgs, setForwardMsgs, erpDraft, setErpDraft,
    reactionPopup, setReactionPopup, reactionContextMenu, setReactionContextMenu,
    userProfilePopup, setUserProfilePopup, manageGroupOpen, setManageGroupOpen,
    noteModal, setNoteModal,
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

  // ─── Pinned messages + notes (OPTIMIZED: 1 IPC call instead of 2) ──────────────
  const { pins, setPins, pinnedNotes, setPinnedNotes, ready: pinsReady } = usePinnedData(activeAccountId, activeThreadId, activeContact?.channel);

  msgsRef.current = msgs;

  // ─── Per-channel work when opening a conversation (Telegram: forum topic messages, fixing old data, syncing reactions) ─────────────────
  useChannelThreadSync({ activeAccountId, activeThreadId, activeTopicId, activeContact, msgs, threadKey, threadReady, setMessages });

  // ─── Collect messages to render + look up senders ─────────────────────────────────────────────────────────────────────────────────
  const {
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, fbPollCardRows, groupedStickerFirstMsgs, groupedStickerSkipIds,
    dayStartIds, msgIndexById, findMsgById, msgTypeCache, getRowMsgIds,
  } = useMessageGrouping(msgs);
  const {
    contactMap, getContact, groupMembers, getGroupMember, erpSourceOf, isGroupAdmin, resolveQuoteAuthor, resolveStarSender,
  } = useSenderDirectory({ contactList, threadGroupInfo, activeAccountId, activeThreadId, activeContact, allAccounts, findMsgById });

  // ─── Conversation lifecycle, loading older messages, stick to bottom / keep scroll position ─────────────────────────────────────────────────────
  useThreadLifecycle(list, {
    activeAccountId, activeThreadId, threadKey, msgs, messagesLoading, pinsReady,
    onThreadSwitch: () => {
      // Reset selection mode when switching threads
      setIsSelecting(false);
      setSelectedMsgIds(new Set());
      // The reaction bar of the previous conversation: that message is removed from the DOM, so no mouseleave fires → close it and cancel its timer
      // (otherwise it would pop up over the "Đang tải..." (Loading...) layer, or the old conversation would still show the bar open when you return)
      closeReactionPicker();
    },
  });
  const { handleLoadMore, maybeLoadOlder } = useOlderMessages(list, {
    activeAccountId, activeThreadId, activeTopicId, getActiveAccount, prependMessages,
  });
  useScrollFollow(list, { activeAccountId, activeThreadId, activeContact, msgs, pins, pinnedNotes, maybeLoadOlder });

  // ─── Background work when opening a conversation: broken images / preloading media, group members + unknown senders ────────────────────
  useThreadMediaMaintenance({ threadReady, activeAccountId, activeThreadId, msgs });
  useGroupMembers({ activeAccountId, activeThreadId, msgs, threadGroupInfo, activeContact, getContact, getGroupMember });

  // ─── Message actions + jump to message ──────────────────────────────────────────────────────────────────────────────
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

  // Data for each message row (rows/rowContext.ts)
  const rowCtx: MessageRowContext = {
    activeAccountId, activeThreadId, activeContact, channelCap, msgs, contactList, threadReceipt,
    telegramGroupAdmins, postReplierPeers, searchHighlightQuery, updateContact, removeMessage, setReplyTo,
    groupedFirstMsgs, groupedSkipIds, pollSkipIds, fbPollCardRows, groupedStickerFirstMsgs, groupedStickerSkipIds,
    dayStartIds, msgIndexById, findMsgById, msgTypeCache, getRowMsgIds,
    getContact, getGroupMember, groupMembers, isGroupAdmin, resolveQuoteAuthor,
    failedMsgAvatars, setFailedMsgAvatars, avatarRefreshAttempted,
    revealedRecallIds, setRevealedRecallIds, revealedEditIds, setRevealedEditIds,
    isSelecting, selectedMsgIds, setSelectedMsgIds, dragSelectRef, clickSuppressUntilRef,
    setContextMenu, setErpDraft, setManageGroupOpen, setReactionPopup, setUserProfilePopup,
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

      {/* ── Pinned messages + notes bar: shown only when ready ── */}
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

      {/* ── Friend request bar (shown only in a 1-1 chat with someone who is not a friend yet) ── */}
      {threadReady && activeAccountId && activeThreadId && (
        <FriendRequestArea activeAccountId={activeAccountId} activeThreadId={activeThreadId} allAccounts={allAccounts}
          contactMap={contactMap} getAuth={getAuth} messagesContainerRef={messagesContainerRef} />
      )}

      {/* ── Floating button: scroll down / back to the latest message ── */}
      {/* z-30: above the message's reaction chip (absolute z-20, comes AFTER the button in the DOM, so it used to cover the button); below the reaction
          picker and the "Đang tải..." (Loading...) layer (z-30, later in the DOM), the file drop layer (z-40), dialogs (z-50). Card background + border +
          shadow clearly visible on the conversation background in both themes (the old bg-muted/80 was almost the same color as the light background #eceef3). */}
      {threadReady && !atBottom && (
        <ScrollToLatestButton isViewingHistory={isViewingHistory} handleReturnToLatest={handleReturnToLatest}
          bottomRef={bottomRef} loadingLatest={loadingLatest} />
      )}

      {/* Messages container: always rendered when a thread is active, the skeleton shows inside while loading */}
      {/* Avoids a "double flash" caused by the container mounting / unmounting when switching threads */}
      {activeAccountId && activeThreadId && (
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto [overflow-anchor:auto] relative" style={{ willChange: 'scroll-position' }}>
        <StickyDayPill containerRef={messagesContainerRef} />
        {/* "Đang tải..." (Loading...) layer when opening a conversation: z-30, above the reaction chip / 👍 button (z-20), the sticky date label (z-20) and the scroll-down button
            (z-30, earlier in the DOM); below the composer popup (z-30, later in the DOM), the file drop layer (z-40), dialogs (z-50).
            Mouse events do not pass through: hovering / clicking does not hit the messages hidden underneath (the reaction bar at z-30 cannot open while loading).
            The spinner only appears when loading takes longer than ~300 ms (chat-loading-reveal): messages on this machine open almost at once → no flicker of
            "Đang tải..." on each conversation switch; the background layer still covers at once so the list is not seen before scrolling to the bottom. */}
        {loadingSpinner && <div className="absolute inset-0 z-30 flex items-center justify-center bg-background"><div className="chat-loading-reveal flex flex-col items-center gap-3"><div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin"></div><p className="text-sm text-muted-foreground">{tr('Đang tải...')}</p></div></div>}
        <div ref={messagesContentRef} className="p-4 space-y-1.5">
        {/* Load More Button: shown on the first (oldest) message. Only when loading is slow, on error, or when older messages are known to remain
            - "có thể còn" (may have more, the default on open) does not show it: scrolling near the top loads them automatically. */}
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

      {/* Typing indicator: shown above the input, does not overlap the content */}
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
