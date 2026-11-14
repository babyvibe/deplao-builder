/**
 * Text message content: text with an @name / link (or a Telegram rich-format message), a Telegram link card, "(đã chỉnh sửa)" (edited) +
 * the old content, an expired self-deleting appointment, space for the send time on the same line + a "Tạo lịch hẹn" (Create appointment) button when the message has a date / time.
 */
import { inlineTimeSpacerClass, TtlExpiredNote } from '../../messages/MessageTime';
import ScheduleChip from './ScheduleChip';
import { getMentionRanges, parseContent } from '@/lib/chat/messages/messageParser';
import { TextWithMentions } from '../../messages/ChatWindowBubbles';
import { getTelegramWebpageMeta, TelegramLinkPreviewCard } from '../../telegram/messages/TelegramLinkPreview';
import TelegramRichMessageBody from '../../telegram/messages/TelegramRichMessageBody';
import type { MessageRowContext, RowLocals } from './rowContext';
import { tr, appLocale } from '../../../../../shared/i18n';

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
      {/* Telegram link without a photo / video: a card with the site name, title and description, like Telegram */}
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
              {tr('(đã chỉnh sửa)')}
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
                  {revealedEditIds.has(msg.msg_id) ? tr('Ẩn') : tr('Xem nội dung cũ')}
                </button>
              );
            } catch { return null; }
          })()}
        </>
      )}
      {/* Expired self-deleting message: Zalo deletes it on Zalo devices, Deplao keeps the content (FR-ZL05.6) */}
      <TtlExpiredNote ttl={(msg as any).ttl} sentAt={msg.timestamp} />
      {/* Leave room at the end of the last line for the send time at the bottom right (inlineTime); if there is no room, wrap to a new line.
          A message with an upcoming date / time ("mai 9h", "20 phút nữa"): the "Tạo lịch hẹn" (Create appointment) button right below, on the same line as the send time */}
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
                    {new Date(entry.editedAt).toLocaleString(appLocale())}
                  </div>
                  <div className="break-words whitespace-pre-wrap italic">
                    {parseContent(entry.oldBody || '') || tr('(Không có nội dung)')}
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
