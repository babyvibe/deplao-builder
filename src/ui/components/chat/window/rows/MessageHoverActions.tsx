/**
 * Nút hiện khi rê chuột lên tin (ngoài bong bóng): Trả lời, Thêm (mở menu chuột phải).
 */
import React from 'react';
import { MsgActionBtn } from '../../messages/ChatWindowBubbles';
import type { MessageRowContext, RowLocals } from './rowContext';

type MessageHoverActionsProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'isSent'>;

export function MessageHoverActions({ ctx, msg, isSent }: MessageHoverActionsProps) {
  const { isGroupAdmin, setContextMenu, setReplyTo } = ctx;
  return (
    <div className="flex items-center gap-0.5 self-end mb-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100 flex-shrink-0 flex-nowrap">
      {/* Reply */}
      <MsgActionBtn title="Trả lời" onClick={() => setReplyTo(msg)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
        </svg>
      </MsgActionBtn>
      {/* Forward */}
      {/*<MsgActionBtn title="Chuyển tiếp" onClick={() => handleForward(msg)}>*/}
      {/*  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">*/}
      {/*    <polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>*/}
      {/*  </svg>*/}
      {/*</MsgActionBtn>*/}
      {/* More */}
      <MsgActionBtn title="Thêm" onClick={(e) => { (e as React.MouseEvent).stopPropagation(); setContextMenu({ x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY, msg, isSent, isGroupAdmin }); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
        </svg>
      </MsgActionBtn>
    </div>
  );
}
