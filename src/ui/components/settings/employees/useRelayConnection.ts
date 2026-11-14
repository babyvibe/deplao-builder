/**
 * Employee connection status for the Settings → Employees page: the server for employees (relay) on / off, port, address
 * on the network, employees currently online, the old-style Internet address (tunnel). Re-read every 5 s while the page is open + listens to
 * main's events (online employee list, tunnel changes). `enabled = false` (employee machine): reads nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { sortLanIps } from '@/lib/employee/employeeSettingsView';
import { STOPPED_RELAY_TUNNEL, type RelayTunnelStatus } from '../../../../shared/cloud/tunnelAddress';
import { tr } from '../../../../shared/i18n';

const REFRESH_MS = 5000;
const DEFAULT_PORT = 9900;

function normalizeTunnel(data: Partial<RelayTunnelStatus> | null | undefined): RelayTunnelStatus {
  return { ...STOPPED_RELAY_TUNNEL, ...(data || {}) };
}

export interface RelayConnection {
  running: boolean;
  /** On / off in progress (waiting for main to reply). */
  busy: boolean;
  port: number;
  localIPs: string[];
  tunnel: RelayTunnelStatus;
  autoStart: boolean;
  start: (port: number) => Promise<boolean>;
  stop: () => Promise<void>;
  setAutoStart: (on: boolean, port: number) => Promise<void>;
  /** Changing the port while off: saved to the workspace (the next time it is turned on / auto-start when the app opens uses this port). */
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
    } catch { /* main not ready → next time */ }
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

  /** Save the port (and auto-on) to the workspace: the next app launch turns on this exact port. */
  const saveWorkspace = useCallback(async (updates: { relayPort?: number; relayAutoStart?: boolean }) => {
    try {
      const res = await ipc.workspace?.getActive();
      if (res?.success && res.workspace?.id) await ipc.workspace?.update(res.workspace.id, updates);
    } catch { /* if it cannot be saved, the next time still uses the default port */ }
  }, []);

  const start = useCallback(async (wanted: number) => {
    setBusy(true);
    try {
      const target = Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : DEFAULT_PORT;
      const res = await ipc.relay?.startServer(target);
      if (!res?.success) {
        showNotification(res?.error || tr('Không mở được kết nối cho nhân viên'), 'error');
        return false;
      }
      setRunning(true);
      if (res.port) setPort(res.port);
      await saveWorkspace({ relayPort: res.port || target });
      await refresh();
      return true;
    } catch (err: any) {
      showNotification(err?.message || tr('Không mở được kết nối cho nhân viên'), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, saveWorkspace, setPort, setRunning, showNotification]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      // Turning the connection off also turns off the old-style Internet address (so an address does not point at a port that no longer serves)
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
