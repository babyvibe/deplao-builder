/**
 * Trình xem ảnh (bộ sưu tập phân trang theo cursor, MediaGalleryViewer) và trình phát video của khung chat; đang xem
 * video toàn màn hình thì dừng video tự phát trong khung.
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
  // Đang xem video toàn màn hình (có tiếng) → dừng video tự phát trong khung chat
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
      // File JPEG XL (tải trước khi đổi sang bản JPG) không hiển thị được → bỏ qua
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
      fallbackSrc: remoteUrl || undefined,  // Zalo CDN làm fallback
      localPath,
      defaultName,
      msgId: msg?.msg_id ? String(msg.msg_id) : undefined,
      threadId: msg?.thread_id ? String(msg.thread_id) : undefined,
      timestamp: Number(msg?.timestamp) || undefined,
    };
  }, []);

  /**
   * Bộ sưu tập của trình xem ảnh, phân trang như tin nhắn (kiểu Telegram/Zalo): mở ngay với ảnh đang có trong
   * hội thoại, tải ảnh quanh ảnh được bấm theo cursor (timestamp, msg_id), thêm trang khi cuộn gần đầu/cuối dải
   * hoặc ←/→ quá ảnh đầu/cuối đã tải. State nằm trong MediaGalleryViewer → tải trang không render lại ChatWindow.
   */
  const mediaGalleryRef = React.useRef<MediaGalleryViewerHandle>(null);
  const openViewer = React.useCallback((clickedUrl: string) => {
    mediaGalleryRef.current?.openFromMessages(msgsRef.current, clickedUrl);
  }, []);
  /** Ảnh trong tin định dạng phong phú Telegram: trình xem với các ảnh của tin đó */
  const openImageList = React.useCallback((items: MediaViewerImage[], index: number) => {
    mediaGalleryRef.current?.open(items, index);
  }, []);

  /** Mở video player inline từ 1 tin nhắn video */
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
