/**
 * Tin đã thu hồi / đã xoá: RecalledBubble (dùng chung MessageBubbles), "Xem nội dung gốc" nếu app còn giữ, menu chuột
 * phải chỉ thao tác cục bộ. Hàm vẽ (không phải component) → giữ nguyên key / cây phần tử của hàng như bản cũ.
 */
import React from 'react';
import { RecalledBubble } from '../../messages/MessageBubbles';
import { SenderAvatar } from './SenderAvatar';
import type { MessageRowContext, RowLocals } from './rowContext';

export function renderRecalledRow(
  ctx: MessageRowContext,
  { msg, idx, isSent, daySeparator, isLastInRun, displayName, avatarUrl, senderAvatarFallback }: Pick<RowLocals,
    'msg' | 'idx' | 'isSent' | 'daySeparator' | 'isLastInRun' | 'displayName' | 'avatarUrl' | 'senderAvatarFallback'>,
): React.ReactNode {
  const { getRowMsgIds, isSelecting, openViewer, revealedRecallIds, setContextMenu, setRevealedRecallIds, setUserProfilePopup } = ctx;
  const isRevealed = revealedRecallIds.has(msg.msg_id);
  const toggleReveal = () => setRevealedRecallIds(prev => {
    const next = new Set(prev);
    if (next.has(msg.msg_id)) next.delete(msg.msg_id);
    else next.add(msg.msg_id);
    return next;
  });

  return (
    <div key={msg.msg_id + idx} id={`msg-${msg.msg_id}`} data-msg-ids={getRowMsgIds(msg)} className={`flex flex-col mb-0.5 ${isSent ? 'items-end' : 'items-start'}`}>
      {daySeparator}
      <div className={`flex items-end gap-2 ${isSent ? 'flex-row-reverse' : 'flex-row'}`}>
        {!isSent && (
          <SenderAvatar ctx={ctx} msg={msg} isLastInRun={isLastInRun} displayName={displayName} avatarUrl={avatarUrl}
            senderAvatarFallback={senderAvatarFallback} />
        )}
        <RecalledBubble
          msg={msg}
          isSelf={isSent}
          displayName={displayName}
          isRevealed={isRevealed}
          onToggleReveal={toggleReveal}
          onView={openViewer}
          onOpenProfile={(userId, e) => setUserProfilePopup({ userId, x: e.clientX, y: e.clientY })}
          onContextMenu={(e, previewMsg) => {
            if (isSelecting) { e.preventDefault(); return; }
            // Đang bôi đen chữ → để trình duyệt xử lý (copy tự nhiên)
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            e.preventDefault();
            // Tin đã thu hồi: chỉ thao tác cục bộ (sao chép, lưu ảnh/file, đánh dấu, xoá khỏi app)
            setContextMenu({ x: e.clientX, y: e.clientY, msg: previewMsg, isSent, recalled: true });
          }}
        />
      </div>
    </div>
  );
}
