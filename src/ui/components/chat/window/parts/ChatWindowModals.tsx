/**
 * Popup / hộp thoại của khung chat: trình xem ảnh + video, menu chuột phải của tin, chuyển tiếp, lịch hẹn / ghi chú từ
 * tin, menu + danh sách cảm xúc, hồ sơ người gửi, quản lý nhóm, ghi chú nhóm, WebView bot Telegram, bộ sticker Telegram.
 * Trạng thái mở / đóng ở useChatWindowDialogs (+ useMediaViewers); thao tác ở useMessageActions.
 */
import MediaGalleryViewer from '../../media/MediaGalleryViewer';
import MessageContextMenu from '../../messages/MessageContextMenu';
import TelegramWebViewModal from '../../telegram/TelegramWebViewModal';
import VideoPlayer from '../../media/VideoPlayer';
import { type Channel, getChannelLabel } from '@/../configs/channels/channelConfig';
import { QuickEventDialog, QuickNoteDialog } from '../../quick/QuickErpDialogs';
import { eventDraftFromMessages, noteDraftFromMessages } from '@/lib/chat/erp/messageToErp';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { ManagePanel } from '../../groups/GroupInfoPanel';
import { UserProfilePopup } from '../../../common/profile/UserProfilePopup';
import { getTelegramPostMeta } from '@/lib/media/mediaResolver';
import { canQueryTelegramReadReceipts } from '@/lib/chat/read/readReceipts';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { NoteViewModal } from '../../groups/NoteViewModal';
import ForwardMessageModal from '../../messages/ForwardMessageModal';
import { parseReactionsFull, ReactionContextMenu, ReactionPopup } from '../../messages/reactions/ReactionComponents';
import { getReactionChoices } from '@/lib/chat/reactions/reactionChoices';
import { TelegramStickerSetHost } from '../../telegram/stickers/TelegramStickerSetDialog';
import type { useQuickErpAccess } from '@/hooks/erp/useQuickErpAccess';
import type { useTelegramChatReactions } from '@/lib/chat/reactions/reactionChoices';
import type { usePinnedData } from '../../messages/PinnedMessages';
import type { OpenThread } from '../hooks/useOpenThread';
import type { MessageGrouping } from '../hooks/useMessageGrouping';
import type { SenderDirectory } from '../hooks/useSenderDirectory';
import type { ChatWindowDialogs } from '../hooks/useChatWindowDialogs';
import type { MessageSelection } from '../hooks/useMessageSelection';
import type { MediaViewers } from '../hooks/useMediaViewers';
import type { MessageActions } from '../hooks/useMessageActions';

type PinnedData = ReturnType<typeof usePinnedData>;

interface ModalExtras {
  telegramReactions: ReturnType<typeof useTelegramChatReactions>;
  erpAccess: ReturnType<typeof useQuickErpAccess>;
}

export type ChatWindowModalsProps =
  // Hội thoại đang mở
  Pick<OpenThread, 'activeAccountId' | 'activeThreadId' | 'activeContact' | 'allAccounts' | 'channelCap' | 'contactList' | 'threadGroupInfo' | 'setReplyTo' | 'setEditingMsg' | 'showNotification'>
  // Gom tin
  & Pick<MessageGrouping, 'groupedFirstMsgs'>
  // Người gửi
  & Pick<SenderDirectory, 'contactMap' | 'getContact' | 'getGroupMember' | 'groupMembers' | 'erpSourceOf'>
  // Menu / popup đang mở
  & Pick<ChatWindowDialogs, 'contextMenu' | 'setContextMenu' | 'forwardMsgs' | 'setForwardMsgs' | 'erpDraft' | 'setErpDraft' | 'reactionPopup' | 'setReactionPopup' | 'reactionContextMenu' | 'setReactionContextMenu' | 'userProfilePopup' | 'setUserProfilePopup' | 'manageGroupOpen' | 'setManageGroupOpen' | 'noteModal' | 'setNoteModal' | 'webviewModal' | 'setWebviewModal'>
  // Chọn nhiều tin
  & Pick<MessageSelection, 'setIsSelecting' | 'setSelectedMsgIds'>
  // Xem ảnh / video
  & Pick<MediaViewers, 'mediaGalleryRef' | 'buildImageEntry' | 'videoPlayerState' | 'setVideoPlayerState'>
  // Thao tác trên tin
  & Pick<MessageActions, 'handleUndo' | 'handleDelete' | 'handleDeleteFromDb' | 'handleReact' | 'handleCancelReaction' | 'handleForward' | 'runForward' | 'handleSaveToMyDocuments' | 'contextTargetStarred' | 'handleToggleStar' | 'handlePin'>
  // Ghi chú đã ghim (usePinnedData)
  & Pick<PinnedData, 'setPinnedNotes'>
  // Reaction dùng được của hội thoại Telegram + quyền Quản lý công việc
  & Pick<ModalExtras, 'telegramReactions' | 'erpAccess'>;

export function ChatWindowModals(props: ChatWindowModalsProps) {
  const {
    activeAccountId, activeThreadId, activeContact, allAccounts, channelCap, contactList, threadGroupInfo, setReplyTo, setEditingMsg, showNotification,
    groupedFirstMsgs,
    contactMap, getContact, getGroupMember, groupMembers, erpSourceOf,
    contextMenu, setContextMenu, forwardMsgs, setForwardMsgs, erpDraft, setErpDraft, reactionPopup, setReactionPopup, reactionContextMenu, setReactionContextMenu, userProfilePopup, setUserProfilePopup, manageGroupOpen, setManageGroupOpen, noteModal, setNoteModal, webviewModal, setWebviewModal,
    setIsSelecting, setSelectedMsgIds,
    mediaGalleryRef, buildImageEntry, videoPlayerState, setVideoPlayerState,
    handleUndo, handleDelete, handleDeleteFromDb, handleReact, handleCancelReaction, handleForward, runForward, handleSaveToMyDocuments, contextTargetStarred, handleToggleStar, handlePin,
    setPinnedNotes,
    telegramReactions, erpAccess,
  } = props;
  return (
    <>
      <MediaGalleryViewer
        ref={mediaGalleryRef}
        accountId={activeAccountId}
        threadId={activeThreadId}
        buildEntry={buildImageEntry}
      />

      {/* Video player modal */}
      {videoPlayerState && (
        <VideoPlayer
          localPath={videoPlayerState.localPath}
          remoteUrl={videoPlayerState.remoteUrl}
          thumbUrl={videoPlayerState.thumbUrl}
          width={videoPlayerState.width}
          height={videoPlayerState.height}
          duration={videoPlayerState.duration}
          msgId={videoPlayerState.msgId}
          threadId={videoPlayerState.threadId}
          onClose={() => setVideoPlayerState(null)}
        />
      )}

      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          msg={contextMenu.msg}
          mediaMsg={contextMenu.mediaMsg}
          isSent={contextMenu.isSent}
          isGroupAdmin={contextMenu.isGroupAdmin}
          recalled={contextMenu.recalled}
          channelCap={channelCap}
          onClose={() => setContextMenu(null)}
          onReply={(m) => setReplyTo(m)}
          onForward={handleForward}
          onSelectMessages={(m) => { setIsSelecting(true); setSelectedMsgIds(new Set((groupedFirstMsgs[m.msg_id] || [m]).map((x: any) => x.msg_id))); }}
          onUndo={handleUndo}
          onDelete={handleDelete}
          onDeleteFromDb={handleDeleteFromDb}
          onReact={handleReact}
          onCancelReact={handleCancelReaction}
          reactionChoices={getReactionChoices(contextMenu.msg?.channel, telegramReactions.reactions)}
          myReaction={(() => {
            if (!activeAccountId || !contextMenu.msg) return null;
            const full = parseReactionsFull(contextMenu.msg.reactions, contextMenu.msg.channel);
            return Object.entries(full.emoji || {}).find(([, data]) => (data as any).users?.[activeAccountId] > 0)?.[0] || null;
          })()}
          onPin={handlePin}
          onEdit={(m) => {
            setEditingMsg(m);
            setContextMenu(null);
          }}
          isStarred={contextTargetStarred}
          onToggleStar={handleToggleStar}
          onSaveToMyDocuments={(activeContact?.channel || CHANNEL.ZALO) === CHANNEL.ZALO && channelCap.supportsForward ? handleSaveToMyDocuments : undefined}
          onAddToCalendar={erpAccess.event ? (m) => setErpDraft({ kind: 'event', msgs: groupedFirstMsgs[m.msg_id] || [m] }) : undefined}
          onSaveToNote={erpAccess.note ? (m) => setErpDraft({ kind: 'note', msgs: groupedFirstMsgs[m.msg_id] || [m] }) : undefined}
          showNotification={showNotification}
          readReceipts={activeAccountId && canQueryTelegramReadReceipts(contextMenu.msg, {
            isSent: contextMenu.isSent,
            isChannelPost: !!getTelegramPostMeta(contextMenu.msg),
            recalled: contextMenu.recalled,
          }) ? {
            accountId: activeAccountId,
            // Tên / avatar người xem: liên hệ của tài khoản → thành viên nhóm đang mở (main có tên dự phòng)
            resolvePerson: (userId: string) => {
              const contact = getContact(userId) as any;
              const member = getGroupMember(userId) as any;
              const name = String(contact?.alias || contact?.display_name || member?.displayName || '');
              const avatar = toLocalMediaUrl(contact?.avatar_url || member?.avatar || '');
              return name && name !== userId ? { name, avatar } : (avatar ? { name: '', avatar } : null);
            },
          } : undefined}
        />
      )}

      {/* Forward message modal */}
      {channelCap.supportsForward && forwardMsgs && (
        <ForwardMessageModal
          messages={forwardMsgs}
          onClose={() => setForwardMsgs(null)}
          onForward={(messages, targets, composeText) => {
            setForwardMsgs(null);
            runForward(messages, targets, composeText);
          }}
        />
      )}

      {/* Quản lý công việc: lịch hẹn / ghi chú từ tin (điền sẵn tiêu đề, ngày giờ đọc trong tin, nội dung tin) */}
      {erpDraft && activeAccountId && activeThreadId && (() => {
        const conversation = activeContact?.alias || activeContact?.display_name || activeThreadId;
        const account = allAccounts.find(a => a.zalo_id === activeAccountId);
        const ctx = {
          conversation,
          channelLabel: getChannelLabel(((activeContact?.channel || account?.channel || CHANNEL.ZALO) as Channel)),
          accountName: account?.full_name || '',
        };
        const sources = erpDraft.msgs.map(erpSourceOf);
        if (erpDraft.kind === 'note') {
          return <QuickNoteDialog initial={noteDraftFromMessages(sources, ctx)} onClose={() => setErpDraft(null)} />;
        }
        const draft = eventDraftFromMessages(sources, ctx);
        const linkedMsg = erpDraft.msgs[draft.sourceIndex];
        const msgId = linkedMsg && !/^(temp|retry)_/.test(String(linkedMsg.msg_id)) ? String(linkedMsg.msg_id) : undefined;
        return (
          <QuickEventDialog
            heading="Thêm vào lịch"
            activeThread={{ id: activeThreadId, name: conversation, accountId: activeAccountId, msgId }}
            initial={draft}
            onClose={() => setErpDraft(null)}
          />
        );
      })()}

      {/* Reaction context menu (right-click on reaction pill) */}
      {channelCap.supportsReaction && reactionContextMenu && (
        <ReactionContextMenu
          x={reactionContextMenu.x}
          y={reactionContextMenu.y}
          msg={reactionContextMenu.msg}
          myEmoji={reactionContextMenu.myEmoji}
          onClose={() => setReactionContextMenu(null)}
          onReact={(msg, emoji) => { handleReact(msg, emoji); setReactionContextMenu(null); }}
          onCancel={(msg) => { handleCancelReaction(msg); setReactionContextMenu(null); }}
        />
      )}

      {/* Reaction popup: xem ai thả cảm xúc */}
      {channelCap.supportsReaction && reactionPopup && (
        <ReactionPopup
          msg={reactionPopup.msg}
          initialEmoji={reactionPopup.activeEmoji}
          contacts={contactList}
          groupMembers={groupMembers}
          currentUserId={activeAccountId || ''}
          onClose={() => setReactionPopup(null)}
          ownerZaloId={activeAccountId || undefined}
        />
      )}

      {/* User profile popup */}
      {userProfilePopup && (
        <UserProfilePopup
          userId={userProfilePopup.userId}
          anchorX={userProfilePopup.x}
          anchorY={userProfilePopup.y}
          contacts={contactList}
          activeAccountId={activeAccountId || ''}
          activeThreadId={activeThreadId}
          onClose={() => setUserProfilePopup(null)}
        />
      )}

      {/* Manage group modal - mở từ nút "Quản lý nhóm" trong EcardBubble */}
      {manageGroupOpen && activeThreadId && activeAccountId && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setManageGroupOpen(false); }}
        >
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-[380px] max-h-[80vh] flex flex-col overflow-hidden">
            <ManagePanel
              groupInfo={threadGroupInfo || null}
              groupId={activeThreadId}
              onBack={() => setManageGroupOpen(false)}
              myAccountId={activeAccountId}
              asModal
            />
          </div>
        </div>
      )}

      {/* Note view modal - mở khi click vào ghi chú đã ghim */}
      {noteModal && activeThreadId && activeAccountId && (
        <NoteViewModal
          topicId={noteModal.topicId}
          initialTitle={noteModal.title || ''}
          groupId={activeThreadId}
          creatorName={noteModal.creatorName}
          createTime={noteModal.createTime}
          isGroup={!!contactMap.get(activeThreadId) && (contactMap.get(activeThreadId)?.contact_type === 'group' || contactMap.get(activeThreadId)?.contact_type === '1')}
          activeAccountId={activeAccountId}
          onClose={() => setNoteModal(null)}
          onNotePinned={(note) => {
            // Save to DB so it persists across restarts
            ipc.db?.pinMessage({
              zaloId: activeAccountId,
              threadId: activeThreadId,
              pin: {
                msgId: `note_${note.topicId}`,
                msgType: 'note',
                content: JSON.stringify({ topicId: note.topicId, title: note.title, creatorId: note.creatorId, createTime: note.createTime }),
                previewText: note.title,
                previewImage: '',
                senderId: note.creatorId || '',
                senderName: note.creatorName || '',
                timestamp: note.createTime || Date.now(),
              },
            }).catch(() => {});
            setPinnedNotes(prev => {
              const filtered = prev.filter(n => n.topicId !== note.topicId);
              return [note, ...filtered];
            });
          }}
        />
      )}

      {/* Telegram WebView Modal */}
      {webviewModal && activeAccountId && (
        <TelegramWebViewModal
          accountId={activeAccountId}
          botId={webviewModal.botId}
          url={webviewModal.url}
          title={webviewModal.title}
          onClose={() => setWebviewModal(null)}
        />
      )}

      {/* Popup bộ sticker Telegram (bấm sticker trong chat / bảng sticker của ô nhập) */}
      <TelegramStickerSetHost />
    </>
  );
}
