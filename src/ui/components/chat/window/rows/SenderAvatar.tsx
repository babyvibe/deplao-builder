/**
 * Ảnh đại diện người gửi cạnh tin (chỉ tin cuối của lượt): bấm mở hồ sơ; ảnh lỗi → ảnh chữ + thử lấy lại ảnh mới
 * (1 lần / người gửi / phiên).
 */
import { CHANNEL } from '@/lib/channels/channelHelper';
import { handleAvatarError } from '@/lib/contacts/avatarRetry';
import type { MessageRowContext, RowLocals } from './rowContext';

type SenderAvatarProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'isLastInRun' | 'displayName' | 'avatarUrl' | 'senderAvatarFallback'>;

export function SenderAvatar({ ctx, msg, isLastInRun, displayName, avatarUrl, senderAvatarFallback }: SenderAvatarProps) {
  const { activeAccountId, avatarRefreshAttempted, failedMsgAvatars, getContact, setFailedMsgAvatars, setUserProfilePopup, updateContact } = ctx;
  return (
    <div className="w-7 h-7 flex-shrink-0 self-end mb-1">
      {isLastInRun ? (
        <button
          className="w-7 h-7 rounded-full overflow-hidden focus:outline-none hover:ring-2 hover:ring-blue-400 transition-all"
          title={`Xem thông tin: ${displayName}`}
          onClick={(e) => {
            e.stopPropagation();
            setUserProfilePopup({ userId: msg.sender_id, x: e.clientX, y: e.clientY });
          }}
        >
          {avatarUrl && !failedMsgAvatars.has(msg.sender_id) ? (
            <img src={avatarUrl} alt={displayName} className="w-7 h-7 rounded-full object-cover"
              onError={() => {
                setFailedMsgAvatars(prev => new Set(prev).add(msg.sender_id));
                if (activeAccountId && !avatarRefreshAttempted.current.has(msg.sender_id)) {
                  avatarRefreshAttempted.current.add(msg.sender_id);
                  const contact = getContact(msg.sender_id);
                  handleAvatarError({ ownerId: activeAccountId, contactId: msg.sender_id, channel: contact?.channel || CHANNEL.ZALO })
                    .then(newUrl => {
                      if (newUrl) {
                        updateContact(activeAccountId!, { contact_id: msg.sender_id, avatar_url: newUrl });
                        setFailedMsgAvatars(prev => { const n = new Set(prev); n.delete(msg.sender_id); return n; });
                      }
                    }).catch(() => {});
                }
              }} />
          ) : (
            senderAvatarFallback
          )}
        </button>
      ) : <div className="w-7 h-7" />}
    </div>
  );
}
