/**
 * Cài đặt → Nhân viên → Kết nối: relay LAN (bật/tắt, cổng, tự bật), địa chỉ Internet cho nhân viên ở xa (CHỈ XEM —
 * bật / tắt / đổi kiểu địa chỉ ở Cài đặt → Internet & Đám mây → Địa chỉ Internet), nhân viên đang online, đăng xuất tất cả.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { Badge, Button, Switch } from '@/components/ui';
import { AlertIcon, CloseIcon, CopyIcon, GlobeIcon, HomeIcon, PlayIcon, UsersIcon } from '@/components/common/icons';
import { Spinner } from '@/components/common/PageLoading';
import { showConfirm } from '../common/ConfirmDialog';
import RelayAddressNotice, { copyWithToast } from './RelayAddressNotice';
import PublicAddressCard, { usePublicAddresses } from '../common/PublicAddressCard';
import {
    STOPPED_RELAY_TUNNEL,
    TUNNEL_KIND_LABEL,
    type RelayTunnelStatus,
} from '../../../shared/tunnelAddress';

function normalizeTunnelStatus(data: Partial<RelayTunnelStatus> | null | undefined): RelayTunnelStatus {
    return { ...STOPPED_RELAY_TUNNEL, ...(data || {}) };
}

export default function RelayStatusPanel() {
    const showNotification = useAppStore(s => s.showNotification);
    const { relayRunning, setRelayRunning, relayPort, setRelayPort, connectedEmployees, setConnectedEmployees } = useEmployeeStore(useShallow(s => ({
        relayRunning: s.relayRunning,
        setRelayRunning: s.setRelayRunning,
        relayPort: s.relayPort,
        setRelayPort: s.setRelayPort,
        connectedEmployees: s.connectedEmployees,
        setConnectedEmployees: s.setConnectedEmployees,
    })));
    const [localIPs, setLocalIPs] = useState<string[]>([]);
    const [portInput, setPortInput] = useState(String(relayPort));
    const [starting, setStarting] = useState(false);
    const [autoStart, setAutoStart] = useState(false);

    // ── WAN: chỉ đọc trạng thái tunnel của relay (bật / tắt / đổi ở Cài đặt → Internet & Đám mây → Địa chỉ Internet) ──
    const [tunnel, setTunnel] = useState<RelayTunnelStatus>(STOPPED_RELAY_TUNNEL);
    const [now, setNow] = useState(() => Date.now());

    const tunnelOn = tunnel.state !== 'stopped';
    const tunnelUrl = tunnel.tunnelUrl;
    const pub = usePublicAddresses();

    useEffect(() => {
        ipc.workspace?.getActive().then((res: any) => {
            if (res?.success && res.workspace) setAutoStart(!!res.workspace.relayAutoStart);
        }).catch(() => {});
    }, []);

    const refreshStatus = useCallback(async () => {
        try {
            const res = await ipc.relay?.getServerStatus();
            if (res?.success) {
                setRelayRunning(res.running || false);
                if (res.port) setRelayPort(res.port);
                setConnectedEmployees(res.connectedEmployees || []);
                setLocalIPs(res.localIPs || []);
                const legacy: Partial<RelayTunnelStatus> = {
                    active: !!res.tunnelActive,
                    tunnelUrl: res.tunnelUrl ?? null,
                    state: res.tunnelActive ? 'active' : 'stopped',
                };
                setTunnel(normalizeTunnelStatus(res.tunnel ?? legacy));
            }
        } catch { /* */ }
    }, [setRelayRunning, setRelayPort, setConnectedEmployees]);

    useEffect(() => {
        refreshStatus();
        const timer = setInterval(refreshStatus, 5000);
        return () => clearInterval(timer);
    }, [refreshStatus]);

    useEffect(() => {
        const unsub = ipc.on?.('relay:employeeListUpdate', (data: { employees: any[] }) => {
            setConnectedEmployees(data.employees);
        });
        return () => unsub?.();
    }, [setConnectedEmployees]);

    useEffect(() => {
        const unsub = ipc.on?.('relay:tunnelStatusUpdate', (data) => {
            setTunnel(normalizeTunnelStatus(data));
        });
        return () => unsub?.();
    }, []);

    // Đếm ngược "thử lại sau Xs" chỉ khi tunnel đang tự chạy lại
    useEffect(() => {
        if (tunnel.state !== 'restarting') return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [tunnel.state]);

    const handleStart = async () => {
        setStarting(true);
        try {
            const port = parseInt(portInput) || 9900;
            const res = await ipc.relay?.startServer(port);
            if (res?.success) {
                showNotification(`Relay server đã bật trên cổng ${res.port}`, 'success');
                setRelayRunning(true);
                if (res.port) setRelayPort(res.port);
                refreshStatus();
            } else {
                showNotification(res?.error || 'Không thể bật server', 'error');
            }
        } catch (err: any) {
            showNotification(err.message, 'error');
        }
        setStarting(false);
    };

    const handleStop = async () => {
        // Tắt relay thì tắt luôn địa chỉ Internet của relay (không để địa chỉ trỏ vào cổng không còn phục vụ)
        if (tunnelOn) {
            await ipc.relay?.stopTunnel();
            setTunnel(STOPPED_RELAY_TUNNEL);
        }
        const res = await ipc.relay?.stopServer();
        if (res?.success) {
            showNotification('Relay server đã tắt', 'success');
            setRelayRunning(false);
            setConnectedEmployees([]);
        }
    };

    // ── Đăng xuất tất cả nhân viên: đổi khoá ký token → ai cũng phải đăng nhập lại bằng mật khẩu ──
    const [loggingOutAll, setLoggingOutAll] = useState(false);
    const handleLogoutAll = async () => {
        const ok = await showConfirm({
            title: 'Đăng xuất tất cả nhân viên?',
            message: 'Mọi phiên đăng nhập của nhân viên hết hiệu lực: nhân viên đang online bị ngắt ngay, mọi máy nhân viên (kể cả đang offline) phải đăng nhập lại bằng mật khẩu.',
            confirmText: 'Đăng xuất tất cả',
            variant: 'danger',
        });
        if (!ok) return;
        setLoggingOutAll(true);
        try {
            const res = await ipc.employee?.logoutAll();
            if (res?.success) {
                showNotification(res.notified
                    ? `Đã đăng xuất tất cả nhân viên (${res.notified} nhân viên đang online bị ngắt)`
                    : 'Đã đăng xuất tất cả nhân viên', 'success');
                refreshStatus();
            } else {
                showNotification(res?.error || 'Không đăng xuất được nhân viên', 'error');
            }
        } catch (err: any) {
            showNotification(err?.message || 'Không đăng xuất được nhân viên', 'error');
        }
        setLoggingOutAll(false);
    };

    const handleToggleAutoStart = async () => {
        const newVal = !autoStart;
        setAutoStart(newVal);
        try {
            const res = await ipc.workspace?.getActive();
            if (res?.success && res.workspace?.id) {
                const port = parseInt(portInput) || 9900;
                await ipc.workspace?.update(res.workspace.id, { relayAutoStart: newVal, relayPort: port });
                showNotification(newVal ? 'Sẽ tự động bật khi khởi động app' : 'Đã tắt tự động bật', 'info');
            }
        } catch {}
    };

    const runningKind = tunnel.kind;
    const retryInSec = tunnel.nextRetryAt ? Math.max(0, Math.ceil((tunnel.nextRetryAt - now) / 1000)) : null;

    return (
        <div className="space-y-4">
            {/* ── Header ──────────────────────────────────── */}
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider"><GlobeIcon className="w-4 h-4 inline" /> Kết nối nhân viên từ xa</p>

            {/* ── Địa chỉ cho nhân viên đã đổi ("Thiết lập địa chỉ cố định" → Cài đặt → Internet & Đám mây) ── */}
            <RelayAddressNotice status={tunnel} />

            {/* ── Two equal-level option cards ─────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 items-start">

                {/* ── Card 1: LAN ──────────────────────────── */}
                <div className={`rounded-xl border p-3.5 space-y-3 transition-colors ${
                    relayRunning ? 'bg-success/5 border-success/40' : 'bg-card border-border'
                }`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <span className="text-base"><HomeIcon className="w-4 h-4" /></span>
                            <span className="text-xs font-semibold text-foreground">Kết nối LAN</span>
                        </div>
                        <Badge size="sm" variant={relayRunning ? 'success' : 'default'} dot>{relayRunning ? 'Đang chạy' : 'Tắt'}</Badge>
                    </div>

                    {/* Pros / Cons */}
                    <div className="space-y-0.5">
                        <p className="text-[10px] text-success">✓ Tốc độ cao, ổn định</p>
                        <p className="text-[10px] text-success">✓ Bảo mật - không qua internet</p>
                        <p className="text-[10px] text-muted-foreground">✗ Phải cùng mạng nội bộ (LAN / VPN)</p>
                        <p className="text-[10px] text-muted-foreground">✗ IP có thể thay đổi nếu dùng DHCP</p>
                    </div>

                    {/* Port input + Start/Stop */}
                    <div className="flex items-center gap-1.5">
                        <input
                            value={portInput}
                            onChange={e => setPortInput(e.target.value)}
                            disabled={relayRunning}
                            type="number"
                            placeholder="Port"
                            className="w-20 px-2 py-1 bg-muted border border-input rounded-lg text-xs text-foreground disabled:opacity-50"
                        />
                        {relayRunning ? (
                            <Button size="sm" variant="destructive" className="flex-1" onClick={handleStop} leftIcon={<CloseIcon className="w-4 h-4" />}>Tắt</Button>
                        ) : (
                            <Button size="sm" className="flex-1" onClick={handleStart} disabled={starting} leftIcon={starting ? <Spinner size={3} /> : <PlayIcon className="w-4 h-4" />}>Bật</Button>
                        )}
                    </div>

                    {/* Auto-start */}
                    <Switch size="sm" checked={autoStart} onCheckedChange={() => { void handleToggleAutoStart(); }} label={<span className="text-[11px] font-normal text-muted-foreground">Tự động bật khi mở app</span>} />

                    {/* LAN addresses */}
                    {relayRunning && localIPs.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-border/50">
                            <p className="text-[10px] text-muted-foreground">Địa chỉ kết nối:</p>
                            {localIPs.map(ip => (
                                <div key={ip} className="flex items-center gap-1.5">
                                    <code className="flex-1 text-[10px] text-success bg-muted px-1.5 py-0.5 rounded font-mono truncate">{ip}:{relayPort}</code>
                                    <button
                                        onClick={() => copyWithToast(`${ip}:${relayPort}`, 'Đã copy')}
                                        className="text-muted-foreground hover:text-primary flex-shrink-0" title="Copy"
                                    ><CopyIcon className="w-4 h-4" /></button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── Card 2: WAN — chỉ xem; bật / tắt / đổi địa chỉ ở Cài đặt → Internet & Đám mây → Địa chỉ Internet ── */}
                <div className={`rounded-xl border p-3.5 space-y-3 transition-colors ${
                    tunnel.active
                        ? 'bg-primary/5 border-primary/40'
                        : tunnel.state === 'restarting'
                            ? 'bg-warning/5 border-warning/40'
                            : relayRunning ? 'bg-card border-border' : 'bg-card border-border/50'
                }`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <span className="text-base"><GlobeIcon className="w-4 h-4" /></span>
                            <span className="text-xs font-semibold text-foreground">Kết nối WAN</span>
                        </div>
                        <Badge size="sm" dot variant={tunnel.active ? 'primary' : tunnel.state === 'restarting' ? 'warning' : tunnel.state === 'starting' ? 'info' : 'default'}>
                            {tunnel.active ? 'Đang chạy' : tunnel.state === 'restarting' ? 'Đang chạy lại' : tunnel.state === 'starting' ? 'Đang bật' : 'Tắt'}
                        </Badge>
                    </div>

                    {/* Địa chỉ đang dùng (mọi cách tạo địa chỉ). Bản app không có module Cloudflare: hiện địa chỉ relay báo về. */}
                    {pub.available ? (
                        <PublicAddressCard service="relay" title="Địa chỉ cho nhân viên" anyMode compact statusNote="dùng chung với API" />
                    ) : tunnelUrl && (
                        <div className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-[10px] text-muted-foreground">Địa chỉ cho nhân viên:</p>
                                {runningKind && (
                                    <Badge size="sm" variant={runningKind === 'fixed' ? 'success' : 'warning'}>{TUNNEL_KIND_LABEL[runningKind]}</Badge>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <code className="flex-1 min-w-0 text-[10px] text-primary bg-muted px-1.5 py-0.5 rounded font-mono truncate select-all" title={tunnelUrl}>{tunnelUrl}</code>
                                <button
                                    onClick={() => copyWithToast(tunnelUrl, 'Đã copy địa chỉ cho nhân viên')}
                                    className="text-muted-foreground hover:text-primary flex-shrink-0" title="Copy"
                                ><CopyIcon className="w-4 h-4" /></button>
                            </div>
                        </div>
                    )}

                    {/* Trạng thái tự chạy lại / cảnh báo */}
                    {tunnel.state === 'restarting' && (
                        <p className="text-[10px] text-warning leading-relaxed">
                            <AlertIcon className="w-3.5 h-3.5 inline" /> Tunnel bị ngắt — đang tự chạy lại
                            {tunnel.attempt > 0 ? ` (lần ${tunnel.attempt}` : ' ('}
                            {retryInSec !== null ? `${tunnel.attempt > 0 ? ', ' : ''}thử lại sau ${retryInSec}s)` : ')'}
                            {tunnel.lastError ? <span className="block text-muted-foreground break-words">{tunnel.lastError}</span> : null}
                            {tunnel.kind === 'temporary' && <span className="block text-muted-foreground">Địa chỉ tạm sẽ đổi sau khi chạy lại.</span>}
                        </p>
                    )}
                    {tunnel.active && tunnel.restarts > 0 && (
                        <p className="text-[10px] text-muted-foreground">Đã tự chạy lại {tunnel.restarts} lần trong phiên này.</p>
                    )}
                    {tunnel.warning && tunnel.warning !== pub.get('relay')?.error && (
                        <p className="text-[10px] text-warning leading-relaxed"><AlertIcon className="w-3.5 h-3.5 inline" /> {tunnel.warning}</p>
                    )}

                    {/* LAN tắt thì địa chỉ Internet không có gì phía sau */}
                    {!relayRunning && (
                        <div className="text-[10px] text-warning bg-warning/10 border border-warning/30 rounded-lg px-2.5 py-2 leading-relaxed">
                            <AlertIcon className="w-4 h-4 inline" /> Cần bật <span className="font-medium">LAN server</span> để nhân viên vào được qua địa chỉ Internet.
                        </div>
                    )}

                    {pub.canConfigure && (
                        <p className="text-[10px] text-muted-foreground leading-relaxed pt-1 border-t border-border/50">
                            Bật, tắt hoặc đổi kiểu địa chỉ ở <span className="font-medium text-foreground">Cài đặt → Internet &amp; Đám mây → Địa chỉ Internet</span>.
                        </p>
                    )}
                </div>
            </div>

            {/* ── Connected employees ─────────────────────────────────── */}
            {relayRunning && (
                <div className="bg-card rounded-xl p-3.5 space-y-2">
                    <p className="text-[11px] text-muted-foreground font-medium"><UsersIcon className="w-4 h-4 inline" /> Nhân viên đang online
                        <span className="ml-1.5 text-[10px] bg-muted text-foreground/80 px-1.5 py-0.5 rounded-full">{connectedEmployees.length}</span>
                    </p>
                    {connectedEmployees.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-1">Chưa có nhân viên nào kết nối</p>
                    ) : (
                        <div className="space-y-1">
                            {connectedEmployees.map((emp: any, idx: number) => (
                                <div key={`${emp.employee_id}-${idx}`} className="flex items-center gap-2 p-2 bg-card border border-border/60 rounded-lg">
                                    <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center text-xs flex-shrink-0">
                                        {emp.avatar_url
                                            ? <img src={emp.avatar_url} className="w-full h-full rounded-full object-cover" alt="" />
                                            : emp.display_name?.charAt(0)?.toUpperCase() || '?'
                                        }
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs text-foreground font-medium truncate">{emp.display_name}</p>
                                        <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                                            <span>{emp.ip_address} · {timeSince(emp.connected_at)}</span>
                                            {emp.sseConnected && <span className="text-primary">● SSE</span>}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Đăng xuất tất cả nhân viên ──────────────────────────── */}
            <div className="bg-card rounded-xl p-3.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-foreground font-medium">Đăng xuất tất cả nhân viên</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">
                        Thu hồi mọi phiên đăng nhập (vd nghi lộ tài khoản): nhân viên đang online bị ngắt ngay, mọi máy nhân viên phải đăng nhập lại.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    loading={loggingOutAll}
                    onClick={handleLogoutAll}
                    className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                    Đăng xuất tất cả
                </Button>
            </div>

            {/* ── Notes ──────────────────────────────────────────────── */}
            <div className="bg-warning/5 border border-warning/30 rounded-xl p-3 space-y-2">
                <p className="text-[11px] font-semibold text-warning"><AlertIcon className="w-4 h-4 inline" /> Lưu ý quan trọng</p>
                <ul className="text-[11px] text-muted-foreground space-y-1.5 leading-relaxed">
                    <li><span className="text-foreground/80 font-medium">Server tắt khi đóng app</span> - nhân viên bị ngắt kết nối và tự kết nối lại khi bạn mở app (bật "Tự động bật khi mở app").</li>
                    <li><span className="text-foreground/80 font-medium">LAN - IP động</span>: Khuyến nghị đặt IP tĩnh để nhân viên không cần đổi địa chỉ sau mỗi lần restart.</li>
                    <li><span className="text-foreground/80 font-medium">WAN - Địa chỉ tạm</span> đổi mỗi lần tunnel bật lại (khởi động lại app, mất mạng lâu). Nhân viên còn kết nối được báo tự động; nhân viên ở xa phải nhập địa chỉ mới. Dùng <span className="text-foreground/80 font-medium">Địa chỉ cố định</span> để tránh việc này.</li>
                    <li><span className="text-foreground/80 font-medium">Tunnel tự chạy lại</span> khi bị ngắt ngoài ý muốn. Bật, tắt hay đổi kiểu địa chỉ ở <span className="text-foreground/80 font-medium">Cài đặt → Internet &amp; Đám mây → Địa chỉ Internet</span>.</li>
                </ul>
            </div>
        </div>
    );
}

function timeSince(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'vừa kết nối';
    if (mins < 60) return `${mins} phút`;
    const hours = Math.floor(mins / 60);
    return `${hours}h${mins % 60}m`;
}
