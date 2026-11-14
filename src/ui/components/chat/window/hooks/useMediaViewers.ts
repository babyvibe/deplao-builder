/**
 * Photo viewer (a gallery paged by cursor, MediaGalleryViewer) and the video player of the chat window. While a video is
 * watched full screen, the auto-playing video inside the chat window is stopped.
 */
import React, { useEffect, useState } from 'react';
import type { MediaViewerImage } from '../../media/MediaViewer';
import type { MediaGalleryViewerHandle } from '../../media/MediaGalleryViewer';
import { isFacebook } from '@/lib/channels/channelHelper';
import { isMediaType, isVideoType } from '@/lib/chat/messages/messageTypeUtils';
import { getLocalMediaPath } from '@/lib/media/mediaResolver';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { setInlineAutoplaySuspended } from '@/lib/media/inlineAutoplay';
import { toZaloJpgUrl } from '../../../../../utils/zalo/zaloImageUrl';

export function useMediaViewers(msgsRef: React.MutableRefObject<any[]>, activeThreadId: string | null) {
  // Video player modal
  const [videoPlayerState, setVideoPlayerState] = useState<{
    localPath?: string;
    remoteUrl?: string;
    thumbUrl?: string;
    width?: number;
    height?: number;
    duration?: number;
    msgId?: string;
    threadId?: string;
  } | null>(null);
  // Watching a video full screen (with sound) → stop the auto-playing video in the chat window
  useEffect(() => {
    setInlineAutoplaySuspended(!!videoPlayerState);
    return () => setInlineAutoplaySuspended(false);
  }, [videoPlayerState]);

  const buildImageEntry = React.useCallback((msg: any): MediaViewerImage | null => {
    const mt = msg?.msg_type || '';
    const mc = msg?.content || '';
    if (!isMediaType(mt, mc, msg?.attachments) || isVideoType(mt)) return null;

    let localUrl = '';
    let remoteUrl = '';
    let localPath = '';
    try {
      const lp: Record<string, string> = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}')
        : (msg.local_paths || {});
      const lf = lp.main || lp.hd || lp.thumb || (Object.values(lp)[0] as string) || '';
      // JPEG XL files (downloaded before switching to the JPG copy) cannot be displayed → skip them
      if (lf && !/\.jxl$/i.test(lf)) {
        localPath = lf;
        localUrl = toLocalMediaUrl(lf);
      }
    } catch {}
    try {
      const p = JSON.parse(msg.content || '{}');
      const params = typeof p.params === 'string' ? JSON.parse(p.params || '{}') : (p.params || {});
      remoteUrl = toZaloJpgUrl(params.hd || params.rawUrl || p.href || p.thumb || '');
    } catch {}
    if (!remoteUrl && !localUrl) return null;
    const defaultName = localPath
      ? localPath.replace(/.*[/\\]/, '')
      : `image_${msg?.msg_id || Date.now()}.jpg`;
    return {
      src: remoteUrl || localUrl,
      displaySrc: localUrl || remoteUrl,
      fallbackSrc: remoteUrl || undefined,  // Zalo CDN as the fallback
      localPath,
      defaultName,
      msgId: msg?.msg_id ? String(msg.msg_id) : undefined,
      threadId: msg?.thread_id ? String(msg.thread_id) : undefined,
      timestamp: Number(msg?.timestamp) || undefined,
    };
  }, []);

  /**
   * Photo viewer gallery, paged like messages (Telegram / Zalo style): opens at once with the photos already in the
   * conversation, loads the photos around the one clicked by cursor (timestamp, msg_id), adds pages when scrolling near the start or end of the strip,
   * or when pressing ←/→ past the first / last loaded photo. State lives in MediaGalleryViewer → loading a page does not re-render ChatWindow.
   */
  const mediaGalleryRef = React.useRef<MediaGalleryViewerHandle>(null);
  const openViewer = React.useCallback((clickedUrl: string) => {
    mediaGalleryRef.current?.openFromMessages(msgsRef.current, clickedUrl);
  }, []);
  /** Photos in a Telegram rich-format message: the viewer with that message's photos */
  const openImageList = React.useCallback((items: MediaViewerImage[], index: number) => {
    mediaGalleryRef.current?.open(items, index);
  }, []);

  /** Open the inline video player from a video message */
  const openVideoPlayer = React.useCallback((msg: any) => {
    let localPath = '';
    let remoteUrl = '';
    let thumbUrl = '';
    let width = 0;
    let height = 0;
    let duration = 0;

    // Parse local paths
    try {
      const lp: Record<string, string> = typeof msg.local_paths === 'string'
        ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
      localPath = lp.file || lp.video || lp.main || '';
      if (!localPath) {
        const attKey = Object.keys(lp).find(k => k.startsWith('att_'));
        if (attKey) localPath = lp[attKey];
      }
      thumbUrl = lp.thumb || '';
    } catch {}

    // Facebook fallback for localPath
    if (!localPath && isFacebook(msg.channel)) {
      localPath = getLocalMediaPath(msg, 'video') || getLocalMediaPath(msg) || '';
    }

    // Parse remote URLs from content
    try {
      const parsed = JSON.parse(msg.content || '{}');
      remoteUrl = parsed.href || '';
      thumbUrl = thumbUrl || parsed.thumb || '';
      const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
      width = params.video_width || 0;
      height = params.video_height || 0;
      duration = params.duration ? Math.round(params.duration / 1000) : 0;
    } catch {}

    if (!localPath && !remoteUrl) return;

    setVideoPlayerState({
      localPath: localPath || undefined,
      remoteUrl: remoteUrl || undefined,
      thumbUrl: thumbUrl || undefined,
      width: width || undefined,
      height: height || undefined,
      duration: duration || undefined,
      msgId: String(msg.msg_id || ''),
      threadId: activeThreadId || undefined,
    });
  }, [activeThreadId]);

  return { videoPlayerState, setVideoPlayerState, buildImageEntry, mediaGalleryRef, openViewer, openImageList, openVideoPlayer };
}

export type MediaViewers = ReturnType<typeof useMediaViewers>;
