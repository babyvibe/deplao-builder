import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { useWorkspaceStore } from '@/store/app/workspaceStore';
import Logger from '../../../../utils/Logger';
import {
  bossAddressProviderLabel,
  classifyBossUrl,
  describeBossProbe,
  nextBossProbeDelay,
  shouldSuggestNewBossAddress,
  urlHost,
  type BossProbeVerdict,
} from '../../../../shared/cloud/tunnelAddress';
import { tr } from '../../../../shared/i18n';

/** The owner's address (temporary tunnel) seems dead: TopBar invites the user to enter a new address. */
export interface DeadBossAddress {
  url: string;
  host: string;
  /** trycloudflare.com / free ngrok / loca.lt */
  providerLabel: string;
  verdict: BossProbeVerdict;
  /** Reason text in Vietnamese (describeBossProbe). */
  reason: string;
  offlineSince: number;
  detectedAt: number;
}

/** The owner just reported a new WAN address over the realtime channel (employee:bossUrlChanged). */
export interface AnnouncedBossAddress {
  workspaceId: string;
  previousUrl: string;
  newUrl: string;
  /** true = main saved the new address and is reconnecting; false = the workspace is using another address (LAN…). */
  applied: boolean;
  at: number;
}

/**
 * Employee side (TopBar, "Kết nối lại" (Reconnect) popup):
 * - The saved owner address is a temporary tunnel (trycloudflare.com / free ngrok / loca.lt) and the connection keeps dropping
 *   for >= 30 s (not because the user clicked Disconnect) → probe through main (relay:probeBossAddress: DNS + /api/health,
 *   no token sent) every 30 s; a dead address (domain gone / tunnel offline / connection refused) → deadAddress.
 * - The owner reports a new address (employee:bossUrlChanged): main already saved it + reconnects if it was using the old address;
 *   here it only syncs the workspace copy in the renderer, tells the user, and keeps the hint for the input field.
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

  // The user clicked Disconnect / was kicked by the owner → main does not retry on its own → do not prompt about an address change
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

  // Address / workspace changed → recompute from scratch (declared BEFORE the offlineSince effect so updates run in the right order)
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

  // Probe: first time once the connection has been lost for 30 s, then every 30 s until it comes back / the address changes
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
      } catch { /* main has no handler yet */ }
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
        // The address is still correct → main will reconnect by itself
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

  // The owner reports a new address (main already handled it: switches automatically if the old address is in use)
  useEffect(() => {
    const off = ipc.on?.('employee:bossUrlChanged', (data) => {
      if (!data?.workspaceId || !data.newUrl) return;
      const wsState = useWorkspaceStore.getState();
      if (data.applied) {
        // Config copy in the renderer (main is the source of truth, already saved)
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
        useAppStore.getState().showNotification(tr('BOSS đã đổi địa chỉ — đã tự chuyển sang {{v1}}', { v1: urlHost(data.newUrl) || data.newUrl }), 'info');
      }
    });
    return () => off?.();
  }, []);

  return { deadAddress, announced };
}

export default useBossAddressWatch;
