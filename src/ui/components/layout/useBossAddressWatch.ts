import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import Logger from '../../../utils/Logger';
import {
  bossAddressProviderLabel,
  classifyBossUrl,
  describeBossProbe,
  nextBossProbeDelay,
  shouldSuggestNewBossAddress,
  urlHost,
  type BossProbeVerdict,
} from '../../../shared/tunnelAddress';

/** Địa chỉ Boss (tunnel tạm) có vẻ đã chết — TopBar mời nhập địa chỉ mới. */
export interface DeadBossAddress {
  url: string;
  host: string;
  /** trycloudflare.com / ngrok miễn phí / loca.lt */
  providerLabel: string;
  verdict: BossProbeVerdict;
  /** Lý do tiếng Việt (describeBossProbe). */
  reason: string;
  offlineSince: number;
  detectedAt: number;
}

/** Boss vừa báo địa chỉ WAN mới qua kênh realtime (employee:bossUrlChanged). */
export interface AnnouncedBossAddress {
  workspaceId: string;
  previousUrl: string;
  newUrl: string;
  /** true = main đã lưu địa chỉ mới và đang kết nối lại; false = workspace đang dùng địa chỉ khác (LAN…). */
  applied: boolean;
  at: number;
}

/**
 * Phía nhân viên (TopBar, popup "Kết nối lại"):
 * - Địa chỉ Boss đã lưu là tunnel tạm (trycloudflare.com / ngrok free / loca.lt) mà mất kết nối liên tục
 *   >= 30 s (không phải do người dùng bấm Ngắt) → thăm dò qua main (relay:probeBossAddress: DNS + /api/health,
 *   không gửi token) mỗi 30 s; địa chỉ chết (tên miền không còn / tunnel offline / từ chối kết nối) → deadAddress.
 * - Boss báo địa chỉ mới (employee:bossUrlChanged): main đã tự lưu + kết nối lại nếu đang dùng địa chỉ cũ;
 *   ở đây chỉ đồng bộ bản sao workspace ở renderer, báo người dùng và giữ gợi ý cho ô nhập.
 */
export function useBossAddressWatch(): { deadAddress: DeadBossAddress | null; announced: AnnouncedBossAddress | null } {
  const { mode, badge, bossUrl } = useEmployeeStore(useShallow(s => ({
    mode: s.mode,
    badge: s.connectionBadge,
    bossUrl: s.bossUrl,
  })));
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const [userStopped, setUserStopped] = useState(false);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [deadAddress, setDeadAddress] = useState<DeadBossAddress | null>(null);
  const [announced, setAnnounced] = useState<AnnouncedBossAddress | null>(null);
  const reportedUrlRef = useRef<string | null>(null);

  const info = useMemo(() => classifyBossUrl(bossUrl), [bossUrl]);
  const watching = mode === 'employee' && badge === 'offline' && !userStopped && info.kind === 'temporary';

  // Người dùng bấm Ngắt / bị Boss kick → main không tự thử lại → không nhắc địa chỉ đổi
  useEffect(() => {
    const off = ipc.on?.('workspace:connectionStatus', (data) => {
      if (!data?.workspaceId || data.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) return;
      if (data.connected) setUserStopped(false);
      else if (data.reason === 'user-disconnect' || data.kicked) setUserStopped(true);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    setUserStopped(false);
    setAnnounced(null);
  }, [activeWorkspaceId]);

  // Địa chỉ / workspace đổi → tính lại từ đầu (khai báo TRƯỚC effect offlineSince để thứ tự cập nhật đúng)
  useEffect(() => {
    setDeadAddress(null);
    setOfflineSince(null);
    reportedUrlRef.current = null;
  }, [info.url, activeWorkspaceId]);

  useEffect(() => {
    if (watching) setOfflineSince(prev => prev ?? Date.now());
    else setOfflineSince(null);
  }, [watching]);

  useEffect(() => {
    if (badge === 'online' || badge === 'recovering') {
      setDeadAddress(null);
      reportedUrlRef.current = null;
    }
  }, [badge]);

  // Thăm dò: lần đầu khi mất kết nối đủ 30 s, sau đó mỗi 30 s cho tới khi có lại kết nối / đổi địa chỉ
  useEffect(() => {
    if (!watching || !offlineSince || !info.url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastProbeAt: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => { void run(); }, nextBossProbeDelay(offlineSince, lastProbeAt, Date.now()));
    };

    const run = async () => {
      if (cancelled) return;
      lastProbeAt = Date.now();
      let verdict: BossProbeVerdict | null = null;
      try {
        const res = await ipc.relay?.probeBossAddress?.({ url: info.url });
        if (res?.success && res.verdict) verdict = res.verdict;
      } catch { /* main chưa có handler */ }
      if (cancelled) return;
      const now = Date.now();
      if (verdict && shouldSuggestNewBossAddress({ info, offlineSince, now, verdict })) {
        const reason = describeBossProbe(verdict, info);
        if (reportedUrlRef.current !== info.url) {
          reportedUrlRef.current = info.url;
          Logger.notice(`[TopBar] Địa chỉ BOSS có thể đã đổi: ${info.url} — ${reason} (mất kết nối ${Math.round((now - offlineSince) / 1000)}s)`);
        }
        setDeadAddress(prev => (prev && prev.url === info.url && prev.verdict === verdict
          ? prev
          : {
            url: info.url,
            host: info.host,
            providerLabel: bossAddressProviderLabel(info),
            verdict: verdict as BossProbeVerdict,
            reason,
            offlineSince,
            detectedAt: prev?.url === info.url ? prev.detectedAt : now,
          }));
      } else if (verdict === 'reachable') {
        // Địa chỉ vẫn đúng — main sẽ tự nối lại
        setDeadAddress(null);
      }
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [watching, offlineSince, info]);

  // Boss báo địa chỉ mới (main đã xử lý: tự chuyển nếu đang dùng địa chỉ cũ)
  useEffect(() => {
    const off = ipc.on?.('employee:bossUrlChanged', (data) => {
      if (!data?.workspaceId || !data.newUrl) return;
      const wsState = useWorkspaceStore.getState();
      if (data.applied) {
        // Bản sao cấu hình ở renderer (main là nguồn sự thật, đã lưu)
        wsState.setWorkspaces(wsState.workspaces.map(ws => (ws.id === data.workspaceId ? { ...ws, bossUrl: data.newUrl } : ws)));
      }
      if (data.workspaceId !== wsState.activeWorkspaceId) return;
      setAnnounced({
        workspaceId: data.workspaceId,
        previousUrl: data.previousUrl,
        newUrl: data.newUrl,
        applied: !!data.applied,
        at: data.at || Date.now(),
      });
      Logger.notice(`[TopBar] BOSS báo địa chỉ mới ${data.newUrl} (${data.applied ? 'đã tự chuyển' : 'đang dùng địa chỉ khác — giữ nguyên'})`);
      if (data.applied) {
        setDeadAddress(null);
        useAppStore.getState().showNotification(`BOSS đã đổi địa chỉ — đã tự chuyển sang ${urlHost(data.newUrl) || data.newUrl}`, 'info');
      }
    });
    return () => off?.();
  }, []);

  return { deadAddress, announced };
}

export default useBossAddressWatch;
