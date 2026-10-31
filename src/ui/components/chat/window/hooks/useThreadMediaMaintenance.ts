/**
 * Bảo trì media khi mở hội thoại (chạy nền, 1 lần / hội thoại / phiên): kiểm tra ảnh trên máy hỏng → tải lại từ CDN;
 * chế độ nhân viên: nạp sẵn ảnh / video / file từ Boss vào bộ đệm của máy.
 */
import { useEffect, useRef } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { toZaloJpgUrl } from '../../../../../utils/zalo/zaloImageUrl';

export function useThreadMediaMaintenance(deps: {
  threadReady: boolean;
  activeAccountId: string | null;
  activeThreadId: string | null;
  msgs: any[];
}) {
  const { threadReady, activeAccountId, activeThreadId, msgs } = deps;
  // ─── Lazy scan: quét ảnh lỗi trong conversation khi mở thread ────────────────
  // Chạy 1 lần per thread, sau khi threadReady. Background, không block UI.
  const scannedThreadsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!threadReady || !activeAccountId || !activeThreadId || !msgs.length) return;
    const scanKey = `${activeAccountId}_${activeThreadId}`;
    if (scannedThreadsRef.current.has(scanKey)) return;
    scannedThreadsRef.current.add(scanKey);

    // Collect messages with local_paths that are image types
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'avif'];
    const items: Array<{ zaloId: string; msgId: string; threadId: string; localPath: string; remoteUrl?: string }> = [];
    for (const msg of msgs) {
      try {
        const lp: Record<string, string> = typeof msg.local_paths === 'string'
          ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        const localFilePath = lp.main || lp.hd || '';
        if (!localFilePath) continue;
        const ext = localFilePath.split('.').pop()?.toLowerCase() || '';
        if (!imageExts.includes(ext)) continue;

        // Extract remoteUrl for repair
        let remoteUrl = '';
        try {
          const parsed = JSON.parse(msg.content || '{}');
          const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
          remoteUrl = toZaloJpgUrl(params.hd || params.rawUrl || parsed.href || parsed.thumb || '');
        } catch {}

        items.push({
          zaloId: activeAccountId,
          msgId: String(msg.msg_id),
          threadId: activeThreadId,
          localPath: localFilePath,
          remoteUrl,
        });
      } catch {}
    }

    if (!items.length) return;

    // Validate in main process, then repair corrupted ones
    ipc.file?.validateLocalImages(items).then((res) => {
      if (!res?.success || !res.corrupted?.length) return;
      console.log(`[ChatWindow] Found ${res.corrupted.length} corrupted images in thread ${activeThreadId}, repairing...`);
      for (const item of res.corrupted) {
        // localPath: file hỏng chỉ bị bỏ khi đã tải được bản mới
        ipc.file?.repairImage({
          zaloId: item.zaloId,
          msgId: item.msgId,
          threadId: item.threadId,
          localPath: item.localPath,
          remoteUrl: item.remoteUrl,
        }).catch(() => {});
      }
    }).catch(() => {});
  }, [threadReady, activeAccountId, activeThreadId, msgs]);

  // ─── Media cache preloader (employee mode) ─────────────────────
  // Khi mo hoi thoai, download background cac file media ve cache local
  // de lan sau xem khong can load tu Boss. Preload ca anh, video, file.
  const preloadScannedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!activeAccountId || !activeThreadId || !threadReady) return;
    const key = `${activeAccountId}_${activeThreadId}`;
    if (preloadScannedRef.current.has(key)) return;
    preloadScannedRef.current.add(key);

    // Chi chay o employee mode
    const isEmployee = useEmployeeStore.getState().mode === 'employee';
    if (!isEmployee) return;

    // Helper: extract Boss URLs tu local_paths cua 1 message
    const extractBossUrls = (msg: any): string[] => {
      const urls: string[] = [];
      try {
        const lp = typeof msg.local_paths === 'string'
          ? JSON.parse(msg.local_paths || '{}')
          : (msg.local_paths || {});
        // Image: lp.main, lp.hd, lp.thumb
        // Video: lp.file, lp.video, lp.thumb (thumb nho)
        // File:  lp.file, lp.main
        const candidates = [lp.main, lp.hd, lp.thumb, lp.file, lp.video];
        for (const val of candidates) {
          if (!val || val === 'undefined') continue;
          const bossUrl = toLocalMediaUrl(val);
          if (bossUrl && !bossUrl.startsWith('local-media://') && !bossUrl.startsWith('file://') && bossUrl.startsWith('http')) {
            urls.push(bossUrl);
          }
        }
      } catch {}
      return urls;
    };

    // Chay async, khong block UI
    (async () => {
      try {
        // ── Lay media messages (anh + video) ──
        const mediaR = await DataAccessor.getMediaMessages({
          zaloId: activeAccountId!,
          threadId: activeThreadId,
          limit: 50,
          offset: 0,
        });
        const mediaMsgs = mediaR?.messages || [];

        // ── Lay file messages ──
        const fileR = await DataAccessor.getFileMessages({
          zaloId: activeAccountId!,
          threadId: activeThreadId,
          limit: 50,
          offset: 0,
        });
        const fileMsgs = fileR?.messages || [];

        // Build danh sach Boss URLs de preload
        const bossUrls: string[] = [];
        for (const msg of mediaMsgs) {
          bossUrls.push(...extractBossUrls(msg));
        }
        for (const msg of fileMsgs) {
          bossUrls.push(...extractBossUrls(msg));
        }

        // Dedup URLs (tranh preload cung 1 file 2 lan)
        const uniqueUrls = [...new Set(bossUrls.filter(Boolean))];

        if (uniqueUrls.length > 0) {
          console.log(`[MediaCache] Preloading ${uniqueUrls.length} files (${mediaMsgs.length} media, ${fileMsgs.length} files) for thread ${activeThreadId}`);
          ipc.file?.preloadMediaBatch(uniqueUrls).catch(() => {});
        }
      } catch (err) {
        console.warn('[MediaCache] Preload error:', err);
      }
    })();
  }, [activeAccountId, activeThreadId, threadReady]);
}
