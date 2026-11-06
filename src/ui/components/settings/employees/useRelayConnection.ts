/**
 * Trạng thái kết nối nhân viên của trang Cài đặt → Nhân viên: máy chủ cho nhân viên (relay) bật / tắt, cổng, địa chỉ
 * trong mạng, nhân viên đang online, địa chỉ Internet (tunnel) kiểu cũ. Đọc lại 5 s/lần khi trang đang mở + nghe sự
 * kiện của main (danh sách nhân viên online, tunnel đổi). `enabled = false` (máy nhân viên): không đọc gì.
 */
import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { sortLanIps } from '@/lib/employee/employeeSettingsView';
import { STOPPED_RELAY_TUNNEL, type RelayTunnelStatus } from '../../../../shared/cloud/tunnelAddress';

const REFRESH_MS = 5000;
const DEFAULT_PORT = 9900;

function normalizeTunnel(data: Partial<RelayTunnelStatus> | null | undefined): RelayTunnelStatus {
  return { ...STOPPED_RELAY_TUNNEL, ...(data || {}) };
}

export interface RelayConnection {
  running: boolean;
  /** Đang bật / tắt (chờ main trả lời). */
  busy: boolean;
  port: number;
  localIPs: string[];
  tunnel: RelayTunnelStatus;
  autoStart: boolean;
  start: (port: number) => Promise<boolean>;
  stop: () => Promise<void>;
  setAutoStart: (on: boolean, port: number) => Promise<void>;
  /** Đổi cổng khi đang tắt: lưu vào workspace (lần bật sau / tự bật khi mở app dùng cổng này). */
  savePort: (port: number) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useRelayConnection(enabled = true): RelayConnection {
  const showNotification = useAppStore((s) => s.showNotification);
  const { running, setRunning, port, setPort, setConnected } = useEmployeeStore(useShallow((s) => ({
    running: s.relayRunning,
    setRunning: s.setRelayRunning,
    port: s.relayPort,
    setPort: s.setRelayPort,
    setConnected: s.setConnectedEmployees,
  })));
  const [busy, setBusy] = useState(false);
  const [localIPs, setLocalIPs] = useState<string[]>([]);
  const [tunnel, setTunnel] = useState<RelayTunnelStatus>(STOPPED_RELAY_TUNNEL);
  const [autoStart, setAutoStartState] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await ipc.relay?.getServerStatus();
      if (!res?.success) return;
      setRunning(!!res.running);
      if (res.port) setPort(res.port);
      setConnected(res.connectedEmployees || []);
      setLocalIPs(sortLanIps(res.localIPs || []));
      setTunnel(normalizeTunnel(res.tunnel ?? {
        active: !!res.tunnelActive,
        tunnelUrl: res.tunnelUrl ?? null,
        state: res.tunnelActive ? 'active' : 'stopped',
      }));
    } catch { /* main chưa sẵn sàng → lần sau */ }
  }, [setRunning, setPort, setConnected]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const offList = ipc.on?.('relay:employeeListUpdate', (data: { employees: any[] }) => setConnected(data?.employees || []));
    const offTunnel = ipc.on?.('relay:tunnelStatusUpdate', (data: Partial<RelayTunnelStatus>) => setTunnel(normalizeTunnel(data)));
    return () => { offList?.(); offTunnel?.(); };
  }, [enabled, setConnected]);

  useEffect(() => {
    if (!enabled) return;
    ipc.workspace?.getActive().then((res: any) => {
      if (res?.success && res.workspace) setAutoStartState(!!res.workspace.relayAutoStart);
    }).catch(() => {});
  }, [enabled]);

  /** Lưu cổng (và tự bật) vào workspace: lần mở app sau bật lại đúng cổng này. */
  const saveWorkspace = useCallback(async (updates: { relayPort?: number; relayAutoStart?: boolean }) => {
    try {
      const res = await ipc.workspace?.getActive();
      if (res?.success && res.workspace?.id) await ipc.workspace?.update(res.workspace.id, updates);
    } catch { /* không lưu được thì lần sau vẫn dùng cổng mặc định */ }
  }, []);

  const start = useCallback(async (wanted: number) => {
    setBusy(true);
    try {
      const target = Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : DEFAULT_PORT;
      const res = await ipc.relay?.startServer(target);
      if (!res?.success) {
        showNotification(res?.error || 'Không mở được kết nối cho nhân viên', 'error');
        return false;
      }
      setRunning(true);
      if (res.port) setPort(res.port);
      await saveWorkspace({ relayPort: res.port || target });
      await refresh();
      return true;
    } catch (err: any) {
      showNotification(err?.message || 'Không mở được kết nối cho nhân viên', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, saveWorkspace, setPort, setRunning, showNotification]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      // Tắt kết nối thì tắt luôn địa chỉ Internet kiểu cũ (không để địa chỉ trỏ vào cổng không còn phục vụ)
      if (tunnel.state !== 'stopped') {
        await ipc.relay?.stopTunnel();
        setTunnel(STOPPED_RELAY_TUNNEL);
      }
      const res = await ipc.relay?.stopServer();
      if (res?.success) {
        setRunning(false);
        setConnected([]);
      } else if (res?.error) {
        showNotification(res.error, 'error');
      }
    } finally {
      setBusy(false);
    }
  }, [setConnected, setRunning, showNotification, tunnel.state]);

  const setAutoStart = useCallback(async (on: boolean, currentPort: number) => {
    setAutoStartState(on);
    await saveWorkspace({ relayAutoStart: on, relayPort: currentPort || DEFAULT_PORT });
  }, [saveWorkspace]);

  const savePort = useCallback(async (next: number) => {
    if (!Number.isInteger(next) || next <= 0 || next >= 65536) return;
    setPort(next);
    await saveWorkspace({ relayPort: next });
  }, [saveWorkspace, setPort]);

  return { running, busy, port, localIPs, tunnel, autoStart, start, stop, setAutoStart, savePort, refresh };
}
