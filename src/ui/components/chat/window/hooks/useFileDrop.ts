/**
 * Drag & drop files / photos / photo links into the chat window: overlay while dragging, drop → `chat:dragDropFiles` (MessageInput downloads photos
 * from links, sorts them into photos / videos / files, and sends them through the queue).
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
    // Read right inside the event (the drag data is locked afterwards): real files, or a photo link when dragged from a website or another app.
    // MessageInput handles it (downloads photos from links, sorts photos / videos / files, sends through the queue)
    window.dispatchEvent(new CustomEvent('chat:dragDropFiles', { detail: readDropPayload(e.dataTransfer) }));
  }, [activeThreadId]);

  return { isDragging, handleDragEnter, handleDragLeave, handleDragOver, handleDrop };
}

export type FileDrop = ReturnType<typeof useFileDrop>;
