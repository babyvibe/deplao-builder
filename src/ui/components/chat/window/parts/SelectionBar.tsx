/**
 * Thanh chọn nhiều tin: sao chép, thêm vào lịch / lưu ghi chú, chuyển tiếp.
 */
import { CalendarIcon, FileTextIcon } from '@/components/common/icons';
import { extractMsgText } from '@/lib/chat/messages/messageParser';
import { getForwardBlockReason } from '@/lib/chat/forward/forwardSupport';
import type { useQuickErpAccess } from '@/hooks/erp/useQuickErpAccess';
import type { OpenThread } from '../hooks/useOpenThread';
import type { MessageSelection } from '../hooks/useMessageSelection';
import type { ChatWindowDialogs } from '../hooks/useChatWindowDialogs';

type SelectionBarProps = Pick<OpenThread, 'msgs' | 'channelCap' | 'showNotification'>
  & Pick<MessageSelection, 'selectedMsgIds' | 'setIsSelecting' | 'setSelectedMsgIds'>
  & Pick<ChatWindowDialogs, 'setErpDraft' | 'setForwardMsgs'>
  & { erpAccess: ReturnType<typeof useQuickErpAccess> };

export function SelectionBar({ channelCap, erpAccess, msgs, selectedMsgIds, setErpDraft, setForwardMsgs, setIsSelecting, setSelectedMsgIds, showNotification }: SelectionBarProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-card border-t border-blue-500/40 flex-shrink-0">
      <div className="flex items-center gap-2">
        <button onClick={() => { setIsSelecting(false); setSelectedMsgIds(new Set()); }}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <span className="text-sm text-blue-400 font-medium">Đã chọn {selectedMsgIds.size} tin nhắn</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button onClick={() => {
          // Copy selected text messages
          const selectedMsgs = msgs.filter(m => selectedMsgIds.has(m.msg_id));
          const texts = selectedMsgs.map(m => extractMsgText(m)).filter(t => t && t !== '[Tin nhắn]');
          if (texts.length > 0) {
            navigator.clipboard.writeText(texts.join('\n'));
            showNotification(`Đã sao chép ${texts.length} tin nhắn`, 'success');
          } else {
            showNotification('Không có tin nhắn văn bản nào được chọn', 'info');
          }
        }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-muted text-foreground/80 hover:text-foreground text-xs transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Sao chép
        </button>
        {/* Quản lý công việc: các tin đã chọn → một lịch hẹn (ghi chú = nội dung các tin) / một ghi chú */}
        {(erpAccess.event || erpAccess.note) && (['event', 'note'] as const).filter(kind => erpAccess[kind]).map(kind => (
          <button key={kind} onClick={() => {
            const selectedMsgs = msgs.filter(m => selectedMsgIds.has(m.msg_id))
              .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
            if (!selectedMsgs.some(m => { const t = extractMsgText(m); return t && t !== '[Tin nhắn]'; })) {
              showNotification('Các tin đã chọn không có nội dung chữ', 'info');
              return;
            }
            setErpDraft({ kind, msgs: selectedMsgs });
            setIsSelecting(false);
            setSelectedMsgIds(new Set());
          }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-muted text-foreground/80 hover:text-foreground text-xs transition-colors">
            {kind === 'event' ? <CalendarIcon className="w-3.5 h-3.5" /> : <FileTextIcon className="w-3.5 h-3.5" />}
            {kind === 'event' ? 'Thêm vào lịch' : 'Lưu ghi chú'}
          </button>
        ))}
        {channelCap.supportsForward && (
          <button onClick={() => {
            const selectedMsgs = msgs.filter(m => selectedMsgIds.has(m.msg_id));
            // Cuộc gọi, bình chọn, tin hệ thống… không chuyển tiếp được → bỏ ra trước khi chọn người nhận
            const forwardable = selectedMsgs.filter(m => !getForwardBlockReason(m));
            const skipped = selectedMsgs.length - forwardable.length;
            if (skipped > 0) {
              showNotification(
                forwardable.length > 0
                  ? `Bỏ qua ${skipped} tin không chuyển tiếp được (cuộc gọi, bình chọn, tin hệ thống…)`
                  : 'Các tin đã chọn không chuyển tiếp được (cuộc gọi, bình chọn, tin hệ thống…)',
                'info',
              );
            }
            if (forwardable.length > 0) {
              setForwardMsgs(forwardable);
              setIsSelecting(false);
              setSelectedMsgIds(new Set());
            }
          }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>
            Chuyển tiếp
          </button>
        )}
      </div>
    </div>
  );
}
