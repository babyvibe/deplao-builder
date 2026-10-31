/**
 * Nội dung tin chữ: chữ có @tên / link (hoặc tin định dạng phong phú Telegram), thẻ link Telegram, "(đã chỉnh sửa)" +
 * nội dung cũ, hẹn tự xoá đã quá hạn, chỗ cho giờ gửi cùng dòng + nút "Tạo lịch hẹn" khi tin có ngày giờ.
 */
import { inlineTimeSpacerClass, TtlExpiredNote } from '../../messages/MessageTime';
import ScheduleChip from './ScheduleChip';
import { getMentionRanges, parseContent } from '@/lib/chat/messages/messageParser';
import { TextWithMentions } from '../../messages/ChatWindowBubbles';
import { getTelegramWebpageMeta, TelegramLinkPreviewCard } from '../../telegram/messages/TelegramLinkPreview';
import TelegramRichMessageBody from '../../telegram/messages/TelegramRichMessageBody';
import type { MessageRowContext, RowLocals } from './rowContext';

type TextMessageBodyProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'isSent' | 'content' | 'richBlocks' | 'telegramPostMeta' | 'inlineTime' | 'outgoingStatus'>;

export function TextMessageBody({ ctx, msg, isSent, content, richBlocks, telegramPostMeta, inlineTime, outgoingStatus }: TextMessageBodyProps) {
  const { contactList, erpAccess, groupMembers, isSelecting, openImageList, revealedEditIds, searchHighlightQuery, setErpDraft, setRevealedEditIds, setUserProfilePopup } = ctx;
  return (
    <>
      {richBlocks ? (
        <TelegramRichMessageBody msg={msg} onOpenImages={openImageList} highlight={searchHighlightQuery}
          allContacts={contactList} groupMembersList={groupMembers} />
      ) : (
      <TextWithMentions text={content} channel={msg.channel} allContacts={contactList} groupMembersList={groupMembers}
        mentionRanges={getMentionRanges(msg.attachments)}
        highlight={searchHighlightQuery}
        onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
      )}
      {/* Link Telegram không có ảnh / video: thẻ tên trang, tiêu đề, mô tả như Telegram */}
      {msg.msg_type === 'telegram.webpage' && (() => {
        const webpage = getTelegramWebpageMeta(msg);
        return webpage ? (
          <TelegramLinkPreviewCard meta={webpage} className="mt-1.5"
            hideTitle={String(content || '').trim() === webpage.title} />
        ) : null;
      })()}
      {msg.is_edited === 1 && (
        <>
          {!telegramPostMeta && (
            <span className="ml-1 text-[10px] opacity-60 select-none font-normal">
              (đã chỉnh sửa)
            </span>
          )}
          {(() => {
            try {
              const parsed = JSON.parse(msg.edit_history || '[]');
              if (!Array.isArray(parsed) || parsed.length === 0) return null;
              return (
                <button
                  onClick={() => setRevealedEditIds(prev => {
                    const next = new Set(prev);
                    if (next.has(msg.msg_id)) next.delete(msg.msg_id);
                    else next.add(msg.msg_id);
                    return next;
                  })}
                  className="ml-1 text-[10px] font-medium text-blue-300 transition-colors underline underline-offset-2 select-none pointer-events-auto"
                >
                  {revealedEditIds.has(msg.msg_id) ? 'Ẩn' : 'Xem nội dung cũ'}
                </button>
              );
            } catch { return null; }
          })()}
        </>
      )}
      {/* Tin hẹn tự xoá đã quá hạn: Zalo xoá trên thiết bị Zalo, Deplao giữ nội dung (FR-ZL05.6) */}
      <TtlExpiredNote ttl={(msg as any).ttl} sentAt={msg.timestamp} />
      {/* Chừa chỗ cuối dòng chữ cuối cho giờ gửi ở góc dưới phải (inlineTime); thiếu chỗ thì xuống dòng.
          Tin có ngày giờ sắp tới ("mai 9h", "20 phút nữa"): nút "Tạo lịch hẹn" ngay dưới, cùng dòng với giờ gửi */}
      {(() => {
        const spacer = inlineTime
          ? <span aria-hidden="true" className={`inline-block ${inlineTimeSpacerClass(!!outgoingStatus, (msg as any).ttl)} select-none`} />
          : null;
        return erpAccess.event && !isSelecting && !richBlocks && !telegramPostMeta && content ? (
          <ScheduleChip msgId={msg.msg_id} timestamp={msg.timestamp} text={content}
            onCreate={() => setErpDraft({ kind: 'event', msgs: [msg] })}>
            {spacer}
          </ScheduleChip>
        ) : spacer;
      })()}
      {revealedEditIds.has(msg.msg_id) && (() => {
        try {
          const parsed = JSON.parse(msg.edit_history || '[]');
          if (!Array.isArray(parsed) || parsed.length === 0) return null;
          return (
            <div className="w-full mt-1 space-y-1">
              {parsed.map((entry: any, i: number) => (
                <div
                  key={i}
                  className={`px-3 py-1.5 rounded-lg text-xs opacity-60 ${isSent ? 'bg-blue-700/30 mr-8' : 'bg-accent/30 ml-8'}`}
                >
                  <div className="text-[10px] opacity-50 mb-0.5">
                    {new Date(entry.editedAt).toLocaleString('vi-VN')}
                  </div>
                  <div className="break-words whitespace-pre-wrap italic">
                    {parseContent(entry.oldBody || '') || '(Không có nội dung)'}
                  </div>
                </div>
              ))}
            </div>
          );
        } catch { return null; }
      })()}
    </>
  );
}
