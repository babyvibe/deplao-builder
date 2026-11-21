/**
 * Button shown when hovering over a message (outside the bubble): Reply, Add (opens the right-click menu).
 */
import React from 'react';
import { MsgActionBtn } from '../../messages/ChatWindowBubbles';
import type { MessageRowContext, RowLocals } from './rowContext';
import { tr } from '../../../../../shared/i18n';

type MessageHoverActionsProps = { ctx: MessageRowContext; afterReactionButton?: boolean } & Pick<RowLocals, 'msg' | 'isSent'>;

export function MessageHoverActions({ ctx, msg, isSent, afterReactionButton }: MessageHoverActionsProps) {
  const { isGroupAdmin, setContextMenu, setReplyTo } = ctx;
  return (
    // afterReactionButton: the Zalo / Telegram reaction button sticks out 16 px past the outer edge of the message (right of
    // others' messages, left of yours, the same side as these buttons) → start after it
    <div className={`flex items-center gap-0.5 self-end mb-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100 flex-shrink-0 flex-nowrap${afterReactionButton ? (isSent ? ' mr-4' : ' ml-4') : ''}`}>
      {/* Reply */}
      <MsgActionBtn title={tr('Trả lời')} onClick={() => setReplyTo(msg)}>
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
      <MsgActionBtn title={tr('Thêm')} onClick={(e) => { (e as React.MouseEvent).stopPropagation(); setContextMenu({ x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY, msg, isSent, isGroupAdmin }); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
        </svg>
      </MsgActionBtn>
    </div>
  );
}
