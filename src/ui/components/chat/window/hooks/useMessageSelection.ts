/**
 * Chọn nhiều tin: bật chế độ chọn, giữ chuột kéo qua nhiều tin để chọn cả dải (cộng dồn khi kéo nhiều lần), ESC thoát.
 */
import React, { useEffect, useRef, useState } from 'react';

export function useMessageSelection(msgsRef: React.MutableRefObject<any[]>) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  // ── Drag-to-select: giữ chuột kéo qua nhiều tin nhắn → auto chọn ───────────
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

      // Tìm message element dưới cursor
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

      // Nếu chưa activate và đã kéo sang message khác → activate selection mode
      if (!drag.hasActivated) {
        if (currentMsgId === drag.startMsgId) return; // Chưa rời khỏi message gốc
        drag.hasActivated = true;
        setIsSelecting(true);
        // Cancel text selection
        document.getSelection()?.removeAllRanges();
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
      }

      // Select tất cả messages trong range [startIdx, endIdx]
      const minIdx = Math.min(startIdx, endIdx);
      const maxIdx = Math.max(startIdx, endIdx);
      const rangeIds = new Set(
        currentMsgs.slice(minIdx, maxIdx + 1).map((m: any) => m.msg_id)
      );
      // Merge với selection hiện tại (accumulate khi kéo nhiều lần)
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
        // Giữ selection mode active, suppress click tiếp theo
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
