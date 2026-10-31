/**
 * Kéo thả file / ảnh / link ảnh vào khung chat: lớp phủ khi đang kéo, thả → `chat:dragDropFiles` (MessageInput tải ảnh
 * từ link, phân loại ảnh / video / file, gửi qua hàng đợi).
 */
import React, { useRef, useState } from 'react';
import { readDropPayload } from '@/lib/chat/media/dropFiles';

export function useFileDrop(activeThreadId: string | null) {
  // Drag-and-drop state (forward to MessageInput)
  const dragCounterRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  // ── Drag-and-drop handlers (forward to MessageInput) ────────────────
  // MUST be placed BEFORE early returns to maintain React hooks order
  const handleDragEnter = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;

    if (!activeThreadId) return;
    // Đọc ngay trong sự kiện (sau đó dữ liệu kéo bị khoá): file thật, hoặc link ảnh khi kéo từ trang web / app khác.
    // MessageInput xử lý (tải ảnh từ link, phân loại ảnh / video / file, gửi qua hàng đợi)
    window.dispatchEvent(new CustomEvent('chat:dragDropFiles', { detail: readDropPayload(e.dataTransfer) }));
  }, [activeThreadId]);

  return { isDragging, handleDragEnter, handleDragLeave, handleDragOver, handleDrop };
}

export type FileDrop = ReturnType<typeof useFileDrop>;
