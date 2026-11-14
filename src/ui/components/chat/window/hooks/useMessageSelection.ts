/**
 * Multi-select: turn on select mode; hold the mouse and drag across messages to select a whole range (added up across several drags). ESC exits.
 */
import React, { useEffect, useRef, useState } from 'react';

export function useMessageSelection(msgsRef: React.MutableRefObject<any[]>) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  // ── Drag-to-select: hold the mouse and drag across messages → auto-select ───────────
  const dragSelectRef = useRef<{
    startMsgId: string | null;
    startIdx: number;
    hasActivated: boolean;
  }>({ startMsgId: null, startIdx: -1, hasActivated: false });
  const clickSuppressUntilRef = useRef(0);

  // ─── Drag-to-select: pointer move/up (document level) ──────────────────────
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragSelectRef.current;
      if (!drag.startMsgId) return;

      // Find the message element under the cursor
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      let currentMsgId: string | null = null;
      for (const el of elements) {
        const msgEl = (el as HTMLElement).closest?.('[id^="msg-"]') as HTMLElement;
        if (msgEl) {
          currentMsgId = msgEl.id.replace('msg-', '');
          break;
        }
      }
      if (!currentMsgId) return;

      const currentMsgs = msgsRef.current;
      const startIdx = currentMsgs.findIndex((m: any) => m.msg_id === drag.startMsgId);
      const endIdx = currentMsgs.findIndex((m: any) => m.msg_id === currentMsgId);
      if (startIdx === -1 || endIdx === -1) return;

      // If not activated yet and the drag has moved to another message → activate selection mode
      if (!drag.hasActivated) {
        if (currentMsgId === drag.startMsgId) return; // Has not left the original message yet
        drag.hasActivated = true;
        setIsSelecting(true);
        // Cancel text selection
        document.getSelection()?.removeAllRanges();
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
      }

      // Select all messages in the range [startIdx, endIdx]
      const minIdx = Math.min(startIdx, endIdx);
      const maxIdx = Math.max(startIdx, endIdx);
      const rangeIds = new Set(
        currentMsgs.slice(minIdx, maxIdx + 1).map((m: any) => m.msg_id)
      );
      // Merge with the current selection (accumulates across several drags)
      setSelectedMsgIds(prev => {
        if (prev.size === 0) return rangeIds;
        const next = new Set(prev);
        for (const id of rangeIds) next.add(id);
        return next;
      });
    };

    const handlePointerUp = () => {
      const drag = dragSelectRef.current;
      if (!drag.startMsgId) return;

      if (drag.hasActivated) {
        // Keep selection mode active, suppress the next click
        clickSuppressUntilRef.current = Date.now() + 150;
        // Restore user-select
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
      }

      drag.startMsgId = null;
      drag.startIdx = -1;
      drag.hasActivated = false;
    };

    document.addEventListener('pointermove', handlePointerMove, { capture: true });
    document.addEventListener('pointerup', handlePointerUp, { capture: true });

    return () => {
      document.removeEventListener('pointermove', handlePointerMove, { capture: true });
      document.removeEventListener('pointerup', handlePointerUp, { capture: true });
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    };
  }, []);

  // ─── ESC to exit selection mode ─────────────────────────────────────────
  useEffect(() => {
    if (!isSelecting) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsSelecting(false);
        setSelectedMsgIds(new Set());
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
      }
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isSelecting]);

  return { isSelecting, setIsSelecting, selectedMsgIds, setSelectedMsgIds, dragSelectRef, clickSuppressUntilRef };
}

export type MessageSelection = ReturnType<typeof useMessageSelection>;
