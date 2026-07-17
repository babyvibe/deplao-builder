import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { AlertIcon, ClipboardListIcon, CloseIcon, GlobeIcon, HomeIcon, PlayIcon, RocketIcon, UsersIcon } from '@/components/common/icons';
import { Spinner } from '@/components/common/PageLoading';


export default function RelayStatusPanel() {
    const { showNotification } = useAppStore();
    const { relayRunning, setRelayRunning, relayPort, setRelayPort, connectedEmployees, setConnectedEmployees } = useEmployeeStore();
    const [localIPs, setLocalIPs] = useState<string[]>([]);
    const [portInput, setPortInput] = useState(String(relayPort));
    const [starting, setStarting] = useState(false);
    const [autoStart, setAutoStart] = useState(false);
    const [tunnelActive, setTunnelActive] = useState(false);
    const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
    const [tunnelLoading, setTunnelLoading] = useState(false);
    // Tunnel provider config: cloudflare (URL random) | ngrok (static domain)
    const [tunnelProvider, setTunnelProvider] = useState<'cloudflare' | 'ngrok'>('cloudflare');
    const [ngrokToken, setNgrokToken] = useState('');
    const [ngrokDomain, setNgrokDomain] = useState('');

    useEffect(() => {
        ipc.relay?.getTunnelConfig?.().then((res: any) => {
            if (res?.success) {
                setTunnelProvider(res.provider === 'ngrok' ? 'ngrok' : 'cloudflare');
                setNgrokToken(res.authtoken || '');
                setNgrokDomain(res.domain || '');
            }
        }).catch(() => {});
    }, []);

    const saveTunnelConfig = useCallback(async (cfg: { provider?: string; authtoken?: string; domain?: string }) => {
        try { await ipc.relay?.setTunnelConfig?.(cfg); } catch { /* */ }
    }, []);

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
                setTunnelActive(res.tunnelActive || false);
                setTunnelUrl(res.tunnelUrl || null);
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
        const unsub = ipc.on?.('relay:tunnelStatusUpdate', (data: { active: boolean; tunnelUrl: string | null }) => {
            setTunnelActive(data.active);
            setTunnelUrl(data.tunnelUrl);
        });
        return () => unsub?.();
    }, []);

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
        if (tunnelActive) {
            await ipc.relay?.stopTunnel();
            setTunnelActive(false);
            setTunnelUrl(null);
        }
        const res = await ipc.relay?.stopServer();
        if (res?.success) {
            showNotification('Relay server đã tắt', 'success');
            setRelayRunning(false);
            setConnectedEmployees([]);
        }
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

    const handleToggleTunnel = async () => {
        setTunnelLoading(true);
        try {
            if (tunnelActive) {
                await ipc.relay?.stopTunnel();
                setTunnelActive(false);
                setTunnelUrl(null);
                showNotification('Đã tắt tunnel', 'info');
            } else {
                const res = await ipc.relay?.startTunnel();
                if (res?.success && res.tunnelUrl) {
                    setTunnelActive(true);
                    setTunnelUrl(res.tunnelUrl);
                    showNotification('Tunnel đã bật! Nhân viên kết nối từ bất kỳ đâu.', 'success');
                } else {
                    showNotification(res?.error || 'Không thể bật tunnel', 'error');
                }
            }
        } catch (err: any) {
            showNotification(err.message, 'error');
        }
        setTunnelLoading(false);
    };

    return (
        <div className="space-y-4">
            {/* ── Header ──────────────────────────────────── */}
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider"><GlobeIcon className="w-4 h-4 inline" /> Kết nối nhân viên từ xa</p>

            {/* ── Two equal-level option cards ─────────────────────────── */}
            <div className="grid grid-cols-2 gap-3">

                {/* ── Card 1: LAN ──────────────────────────── */}
                <div className={`rounded-xl border p-3.5 space-y-3 transition-colors ${
                    relayRunning
                        ? 'bg-green-900/10 border-green-600/40'
                        : 'bg-gray-800/80 border-gray-700'
                }`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <span className="text-base"><HomeIcon className="w-4 h-4" /></span>
                            <span className="text-xs font-semibold text-gray-200">Kết nối LAN</span>
                        </div>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            relayRunning ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-400'
                        }`}>
                            {relayRunning ? '● Đang chạy' : '○ Tắt'}
                        </span>
                    </div>

                    {/* Pros / Cons */}
                    <div className="space-y-0.5">
                        <p className="text-[10px] text-green-400">✓ Tốc độ cao, ổn định</p>
                        <p className="text-[10px] text-green-400">✓ Bảo mật - không qua internet</p>
                        <p className="text-[10px] text-gray-400">✗ Phải cùng mạng nội bộ (LAN / VPN)</p>
                        <p className="text-[10px] text-gray-400">✗ IP có thể thay đổi nếu dùng DHCP</p>
                    </div>

                    {/* Port input + Start/Stop */}
                    <div className="flex items-center gap-1.5">
                        <input
                            value={portInput}
                            onChange={e => setPortInput(e.target.value)}
                            disabled={relayRunning}
                            type="number"
                            placeholder="Port"
                            className="w-20 px-2 py-1 bg-gray-700 border border-gray-600 rounded-lg text-xs text-gray-200 disabled:opacity-50"
                        />
                        {relayRunning ? (
                            <button onClick={handleStop} className="flex-1 py-1 text-xs bg-red-600/80 hover:bg-red-600 text-white-important rounded-lg transition-colors">
                                <CloseIcon className="w-4 h-4 inline" /> Tắt
                            </button>
                        ) : (
                            <button onClick={handleStart} disabled={starting} className="flex-1 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-50">
                                {starting ? <><Spinner size={3} />...</> : <><PlayIcon className="w-4 h-4 inline" /> Bật</>}
                            </button>
                        )}
                    </div>

                    {/* Auto-start */}
                    <button onClick={handleToggleAutoStart} className="flex items-center gap-2 w-full">
                        <div className={`relative w-7 h-4 rounded-full transition-colors flex-shrink-0 ${autoStart ? 'bg-green-600' : 'bg-gray-600'}`}>
                            <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${autoStart ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                        </div>
                        <span className="text-[10px] text-gray-400">Tự động bật khi mở app</span>
                    </button>

                    {/* LAN addresses */}
                    {relayRunning && localIPs.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-gray-700/50">
                            <p className="text-[10px] text-gray-400">Địa chỉ kết nối:</p>
                            {localIPs.map(ip => (
                                <div key={ip} className="flex items-center gap-1.5">
                                    <code className="flex-1 text-[10px] text-green-300 bg-gray-700 px-1.5 py-0.5 rounded font-mono truncate">{ip}:{relayPort}</code>
                                    <button
                                        onClick={() => { navigator.clipboard.writeText(`${ip}:${relayPort}`); showNotification('Đã copy', 'info'); }}
                                        className="text-gray-400 hover:text-blue-400 flex-shrink-0" title="Copy"
                                    ><ClipboardListIcon className="w-4 h-4" /></button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── Card 2: WAN / Tunnel ─────────────────── */}
                <div className={`rounded-xl border p-3.5 space-y-3 transition-colors ${
                    tunnelActive
                        ? 'bg-blue-900/10 border-blue-500/40'
                        : relayRunning
                            ? 'bg-gray-800/80 border-gray-700'
                            : 'bg-gray-800/40 border-gray-700/50 opacity-60'
                }`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <span className="text-base"><GlobeIcon className="w-4 h-4" /></span>
                            <span className="text-xs font-semibold text-gray-200">Kết nối WAN</span>
                        </div>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            tunnelActive ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-700 text-gray-400'
                        }`}>
                            {tunnelActive ? '● Đang chạy' : '○ Tắt'}
                        </span>
                    </div>

                    {/* Pros / Cons */}
                    <div className="space-y-0.5">
                        <p className="text-[10px] text-green-400">✓ Kết nối từ bất kỳ đâu qua internet</p>
                        <p className="text-[10px] text-green-400">✓ Không cần IP tĩnh hay port forward</p>
                        {tunnelProvider === 'ngrok'
                            ? <p className="text-[10px] text-green-400">✓ URL cố định (ngrok static domain)</p>
                            : <p className="text-[10px] text-gray-400">✗ URL thay đổi mỗi lần bật tunnel</p>}
                    </div>

                    {/* Provider selector — đổi được khi tunnel đang tắt */}
                    <div className="space-y-1.5 pt-1 border-t border-gray-700/50">
                        <div className="flex gap-1.5">
                            {(['cloudflare', 'ngrok'] as const).map(p => (
                                <button
                                    key={p}
                                    disabled={tunnelActive}
                                    onClick={() => { setTunnelProvider(p); saveTunnelConfig({ provider: p }); }}
                                    className={`flex-1 py-1 text-[10px] rounded-lg transition-colors disabled:opacity-50 ${
                                        tunnelProvider === p ? 'bg-blue-600 text-white-important' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                    }`}
                                >{p === 'cloudflare' ? 'Cloudflare (random)' : 'ngrok (cố định)'}</button>
                            ))}
                        </div>
                        {tunnelProvider === 'ngrok' && (
                            <div className="space-y-1">
                                <input
                                    value={ngrokToken}
                                    onChange={e => setNgrokToken(e.target.value)}
                                    onBlur={() => saveTunnelConfig({ authtoken: ngrokToken })}
                                    disabled={tunnelActive}
                                    type="password"
                                    placeholder="ngrok authtoken"
                                    className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded-lg text-[10px] text-gray-200 disabled:opacity-50"
                                />
                                <input
                                    value={ngrokDomain}
                                    onChange={e => setNgrokDomain(e.target.value)}
                                    onBlur={() => saveTunnelConfig({ domain: ngrokDomain })}
                                    disabled={tunnelActive}
                                    placeholder="static domain (vd: abc.ngrok-free.app)"
                                    className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded-lg text-[10px] text-gray-200 disabled:opacity-50"
                                />
                                <p className="text-[10px] text-gray-400">Lấy token + tạo domain free tại dashboard.ngrok.com</p>
                            </div>
                        )}
                    </div>

                    {/* Toggle button */}
                    {!relayRunning ? (
                        <div className="text-[10px] text-yellow-500/80 bg-yellow-500/8 border border-yellow-500/20 rounded-lg px-2.5 py-2 leading-relaxed">
                            <AlertIcon className="w-4 h-4 inline" /> Cần bật <span className="text-yellow-300 font-medium">LAN server</span> trước khi sử dụng WAN Tunnel
                        </div>
                    ) : (
                        <button
                            onClick={handleToggleTunnel}
                            disabled={tunnelLoading}
                            className={`w-full py-1 text-xs rounded-lg transition-colors disabled:opacity-50 ${
                                tunnelActive
                                    ? 'bg-red-600/80 hover:bg-red-600 text-white-important'
                                    : 'bg-blue-600 hover:bg-blue-500 text-white-important'
                            }`}
                        >
                            {tunnelLoading ? <><Spinner size={3} /> Đang xử lý...</> : tunnelActive ? <><CloseIcon className="w-4 h-4 inline" /> Tắt tunnel</> : <><RocketIcon className="w-4 h-4 inline" /> Bật tunnel</>}
                        </button>
                    )}

                    {/* Tunnel URL */}
                    {tunnelActive && tunnelUrl && (
                        <div className="space-y-1 pt-1 border-t border-gray-700/50">
                            <p className="text-[10px] text-gray-400">Địa chỉ kết nối:</p>
                            <div className="flex items-center gap-1.5">
                                <code className="flex-1 text-[10px] text-blue-300 bg-gray-700 px-1.5 py-0.5 rounded font-mono truncate">{tunnelUrl}</code>
                                <button
                                    onClick={() => { navigator.clipboard.writeText(tunnelUrl); showNotification('Đã copy tunnel URL', 'info'); }}
                                    className="text-gray-400 hover:text-blue-400 flex-shrink-0" title="Copy"
                                ><ClipboardListIcon className="w-4 h-4" /></button>
                            </div>
                            {tunnelProvider === 'ngrok'
                                ? <p className="text-[10px] text-green-400/80">✓ URL cố định, không đổi khi bật lại</p>
                                : <p className="text-[10px] text-yellow-500/70"><AlertIcon className="w-4 h-4 inline" /> URL thay đổi mỗi lần bật lại</p>}
                        </div>
                    )}

                    {/* Hint when idle */}
                    {relayRunning && !tunnelActive && (
                        <p className="text-[10px] text-gray-400 leading-relaxed pt-1 border-t border-gray-700/50">
                            {tunnelProvider === 'ngrok'
                                ? 'Dùng ngrok static domain - URL cố định, nhân viên không cần cập nhật lại mỗi lần bật.'
                                : 'Dùng Cloudflare tunnel - miễn phí, URL random mỗi lần. Chuyển sang ngrok nếu muốn URL cố định.'}
                        </p>
                    )}
                </div>
            </div>

            {/* ── Connected employees ─────────────────────────────────── */}
            {relayRunning && (
                <div className="bg-gray-800 rounded-xl p-3.5 space-y-2">
                    <p className="text-[11px] text-gray-400 font-medium"><UsersIcon className="w-4 h-4 inline" /> Nhân viên đang online
                        <span className="ml-1.5 text-[10px] bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{connectedEmployees.length}</span>
                    </p>
                    {connectedEmployees.length === 0 ? (
                        <p className="text-xs text-gray-400 py-1">Chưa có nhân viên nào kết nối</p>
                    ) : (
                        <div className="space-y-1">
                            {connectedEmployees.map((emp: any, idx: number) => (
                                <div key={`${emp.employee_id}-${idx}`} className="flex items-center gap-2 p-2 bg-gray-700/40 rounded-lg">
                                    <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-xs flex-shrink-0">
                                        {emp.avatar_url
                                            ? <img src={emp.avatar_url} className="w-full h-full rounded-full object-cover" alt="" />
                                            : emp.display_name?.charAt(0)?.toUpperCase() || '?'
                                        }
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs text-gray-200 font-medium truncate">{emp.display_name}</p>
                                        <p className="text-[10px] text-gray-400 flex items-center gap-1.5">
                                            <span>{emp.ip_address} · {timeSince(emp.connected_at)}</span>
                                            {emp.sseConnected && <span className="text-blue-400">● SSE</span>}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Notes ──────────────────────────────────────────────── */}
            <div className="bg-yellow-500/8 border border-yellow-500/20 rounded-xl p-3 space-y-2">
                <p className="text-[11px] font-semibold text-yellow-400"><AlertIcon className="w-4 h-4 inline" /> Lưu ý quan trọng</p>
                <ul className="text-[11px] text-gray-400 space-y-1.5 leading-relaxed">
                    <li><span className="text-gray-300 font-medium">Server tắt khi đóng app</span> - nhân viên bị ngắt kết nối, cần bật lại và đăng nhập lại sau mỗi lần restart.</li>
                    <li><span className="text-gray-300 font-medium">LAN - IP động</span>: Khuyến nghị đặt IP tĩnh để nhân viên không cần đổi địa chỉ sau mỗi lần restart.</li>
                    <li><span className="text-gray-300 font-medium">WAN - URL tunnel thay đổi</span>: Nhân viên cần cập nhật URL mới mỗi khi Boss bật lại tunnel.</li>
                    <li><span className="text-gray-300 font-medium">Kết nối SSE</span>: Không cần mở port trên máy nhân viên - hoạt động cả LAN lẫn WAN.</li>
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
