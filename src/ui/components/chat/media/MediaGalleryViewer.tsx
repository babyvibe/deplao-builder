/**
 * MediaGalleryViewer - MediaViewer + useMediaGallery in their own (memoized) component.
 *
 * Paging the gallery is a state update per page; living here, it re-renders only the viewer - never the chat
 * window that opened it (ChatWindow renders every message row, tens to hundreds of ms per render).
 * Render it unconditionally (null while closed) and open it through the ref:
 *
 *   const galleryRef = useRef<MediaGalleryViewerHandle>(null);
 *   galleryRef.current?.openFromMessages(threadMessages, clickedUrl);
 *   <MediaGalleryViewer ref={galleryRef} accountId={acc} threadId={thread} buildEntry={buildImageEntry} />
 */
import React, { forwardRef, useImperativeHandle } from 'react';
import MediaViewer, { type MediaViewerImage } from './MediaViewer';
import { useMediaGallery } from './useMediaGallery';

export interface MediaGalleryViewerHandle {
  /** Open on the image whose bubble URL was clicked, from the thread's messages in memory. */
  openFromMessages: (messages: any[], clickedUrl: string) => void;
  /** Open with ready-made items on `clicked` (index into `items`, or the item). */
  open: (items: MediaViewerImage[], clicked?: number | MediaViewerImage) => void;
  close: () => void;
}

export interface MediaGalleryViewerProps {
  /** Account + thread of the gallery; without them the viewer only shows what it was opened with. */
  accountId?: string | null;
  threadId?: string | null;
  /** Message row → viewer item (null = not a gallery image). Keep it stable (useCallback). */
  buildEntry: (msg: any) => MediaViewerImage | null;
  /** Account used by the viewer to save / repair images (default: accountId). */
  zaloId?: string;
}

const MediaGalleryViewer = React.memo(forwardRef<MediaGalleryViewerHandle, MediaGalleryViewerProps>(
  function MediaGalleryViewer({ accountId, threadId, buildEntry, zaloId }, ref) {
    const gallery = useMediaGallery({ accountId, threadId, buildEntry });
    const { open, openFromMessages, close } = gallery;
    useImperativeHandle(ref, () => ({ open, openFromMessages, close }), [open, openFromMessages, close]);

    if (!gallery.isOpen) return null;
    return (
      <MediaViewer
        key={gallery.sessionId}
        images={gallery.items}
        initialIndex={gallery.initialIndex}
        zaloId={zaloId ?? (accountId || undefined)}
        hasOlder={gallery.hasOlder}
        hasNewer={gallery.hasNewer}
        loadingOlder={gallery.loadingOlder}
        loadingNewer={gallery.loadingNewer}
        onReachStart={gallery.loadOlder}
        onReachEnd={gallery.loadNewer}
        onClose={close}
      />
    );
  },
));

export default MediaGalleryViewer;
