import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';

export default function RelayStatusPanel() {
    const { showNotification } = useAppStore();
    const { relayRunning, setRelayRunning, relayPort, setRelayPort, connectedEmployees, setConnectedEmployees } = useEmployeeStore();
    const [localIPs, setLocalIPs] = useState<string[]>([]);
    const [portInput, setPortInput] = useState(String(relayPort));
    const [starting, setStarting] = useState(false);
    const [autoStart, setAutoStart] = useState(false);

    // Load auto-start setting from workspace config
    useEffect(() => {
        ipc.workspace?.getActive().then((res: any) => {
            if (res?.success && res.workspace) {
                setAutoStart(!!res.workspace.relayAutoStart);
            }
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
            }
        } catch { /* */ }
    }, [setRelayRunning, setRelayPort, setConnectedEmployees]);

    useEffect(() => {
        refreshStatus();
        const timer = setInterval(refreshStatus, 5000);
        return () => clearInterval(timer);
    }, [refreshStatus]);

    // Listen for employee list updates
    useEffect(() => {
        const unsub = ipc.on?.('relay:employeeListUpdate', (data: { employees: any[] }) => {
            setConnectedEmployees(data.employees);
        });
        return () => unsub?.();
    }, [setConnectedEmployees]);

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
        const res = await ipc.relay?.stopServer();
        if (res?.success) {
            showNotification('Relay server đã tắt', 'success');
            setRelayRunning(false);
            setConnectedEmployees([]);
        }
    };

    const handleKick = async (employeeId: string, name: string) => {
        await ipc.relay?.kickEmployee(employeeId);
        showNotification(`Đã ngắt kết nối ${name}`, 'info');
    };

    const handleToggleAutoStart = async () => {
        const newVal = !autoStart;
        setAutoStart(newVal);
        try {
            const res = await ipc.workspace?.getActive();
            if (res?.success && res.workspace?.id) {
                const port = parseInt(portInput) || 9900;
                await ipc.workspace?.update(res.workspace.id, { relayAutoStart: newVal, relayPort: port });
                showNotification(newVal ? 'Sẽ tự động bật server khi khởi động app' : 'Đã tắt tự động bật server', 'info');
            }
        } catch {}
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">🖧 Relay Server</p>
                <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
                    relayRunning ? 'bg-green-600/20 text-green-400' : 'bg-gray-600/30 text-gray-400'
                }`}>
                    <span className={`w-2 h-2 rounded-full ${relayRunning ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
                    {relayRunning ? 'Đang chạy' : 'Tắt'}
                </div>
            </div>

            <div className="bg-gray-800 rounded-xl p-4 space-y-3">
                {/* Port + Start/Stop */}
                <div className="flex items-center gap-2">
                    <div className="flex-1">
                        <label className="text-[11px] text-gray-500 mb-0.5 block">Cổng (Port)</label>
                        <input
                            value={portInput}
                            onChange={e => setPortInput(e.target.value)}
                            disabled={relayRunning}
                            type="number"
                            className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 disabled:opacity-50"
                        />
                    </div>
                    {relayRunning ? (
                        <button onClick={handleStop} className="mt-4 px-4 py-1.5 text-sm bg-red-600/80 hover:bg-red-600 text-white-important rounded-lg transition-colors">
                            ⏹ Tắt
                        </button>
                    ) : (
                        <button onClick={handleStart} disabled={starting} className="mt-4 px-4 py-1.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-50">
                            {starting ? '⏳ Đang bật...' : '▶ Bật server'}
                        </button>
                    )}
                </div>

                {/* Auto-start toggle */}
                <label className="flex items-center gap-3 py-2 cursor-pointer">
                    <div
                        onClick={handleToggleAutoStart}
                        className={`relative w-9 h-5 rounded-full transition-colors ${autoStart ? 'bg-green-600' : 'bg-gray-600'}`}
                    >
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoStart ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-xs text-gray-300">Tự động bật server khi khởi động app</span>
                </label>

                {/* Connection info */}
                {relayRunning && localIPs.length > 0 && (
                    <div className="bg-gray-700/50 rounded-lg p-3 space-y-1.5">
                        <p className="text-[11px] text-gray-400 font-medium">📡 Nhân viên kết nối bằng một trong các địa chỉ:</p>
                        {localIPs.map(ip => (
                            <div key={ip} className="flex items-center gap-2">
                                <code className="text-xs text-green-300 bg-gray-700 px-2 py-0.5 rounded font-mono">{ip}:{relayPort}</code>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(`${ip}:${relayPort}`);
                                        showNotification('Đã copy địa chỉ', 'info');
                                    }}
                                    className="text-[11px] text-blue-400 hover:text-blue-300"
                                    title="Copy"
                                >📋</button>
                            </div>
                        ))}
                    </div>
                )}

                {/* Connected employees */}
                {relayRunning && (
                    <div>
                        <p className="text-[11px] text-gray-400 font-medium mb-1.5">
                            👥 Nhân viên đang online ({connectedEmployees.length})
                        </p>
                        {connectedEmployees.length === 0 ? (
                            <p className="text-xs text-gray-500 py-2">Chưa có nhân viên nào kết nối</p>
                        ) : (
                            <div className="space-y-1">
                                {connectedEmployees.map((emp: any, idx: number) => (
                                    <div key={`${emp.employee_id}-${idx}`} className="flex items-center gap-2 p-2 bg-gray-700/40 rounded-lg">
                                        <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center text-xs flex-shrink-0">
                                            {emp.avatar_url ? (
                                                <img src={emp.avatar_url} className="w-full h-full rounded-full object-cover" alt="" />
                                            ) : (
                                                emp.display_name?.charAt(0)?.toUpperCase() || '?'
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-gray-200 font-medium truncate">{emp.display_name}</p>
                                            <p className="text-[10px] text-gray-500">{emp.ip_address} · {timeSince(emp.connected_at)}</p>
                                        </div>
                                        {/*<button*/}
                                        {/*    onClick={() => handleKick(emp.employee_id, emp.display_name)}*/}
                                        {/*    className="text-[12px] text-red-400 hover:text-red-300 px-1.5 py-0.5 hover:bg-red-600/20 rounded"*/}
                                        {/*    title="Ngắt kết nối"*/}
                                        {/*>⏏</button>*/}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {!relayRunning && (
                    <p className="text-xs text-gray-500 leading-relaxed">
                        Bật Relay Server để nhân viên có thể kết nối và quản lý tin nhắn từ máy riêng.
                        Nhân viên sẽ nhập địa chỉ IP + cổng ở trên để kết nối.
                    </p>
                )}

                {/* ── Lưu ý khi restart app ── */}
                <div className="mt-1 bg-yellow-500/8 border border-yellow-500/20 rounded-lg p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-yellow-400 flex items-center gap-1.5">
                        ⚠️ Lưu ý — Sau khi khởi động lại ứng dụng
                    </p>
                    <ul className="text-[11px] text-gray-400 space-y-1.5 leading-relaxed list-none">
                        <li className="flex gap-1.5">
                            <span className="text-yellow-500 mt-0.5 flex-shrink-0">•</span>
                            <span>
                                <span className="text-gray-300 font-medium">Server tự dừng khi đóng app</span> — toàn bộ nhân viên bị ngắt kết nối và phiên đăng nhập hết hiệu lực. Cần bật lại server trước, sau đó nhân viên đăng nhập lại.
                            </span>
                        </li>
                        <li className="flex gap-1.5">
                            <span className="text-yellow-500 mt-0.5 flex-shrink-0">•</span>
                            <span>
                                <span className="text-gray-300 font-medium">IP lấy động — có thể thay đổi</span> — mỗi lần bật server, hệ thống đọc lại địa chỉ IP từ card mạng (<code className="text-[10px] bg-gray-700 px-1 rounded">os.networkInterfaces()</code>). Nếu trong thời gian tắt app: DHCP cấp IP mới, bạn chuyển WiFi ↔ LAN, bật/tắt VPN, hoặc kết nối thêm adapter — IP hiển thị sẽ <span className="text-yellow-300">khác lần trước</span> → nhân viên phải cập nhật địa chỉ mới vào app.
                            </span>
                        </li>
                        <li className="flex gap-1.5">
                            <span className="text-yellow-500 mt-0.5 flex-shrink-0">•</span>
                            <span>
                                <span className="text-gray-300 font-medium">Cổng có thể bị chiếm</span> — nếu cổng đã dùng bị ứng dụng khác giữ sau khi máy restart, server sẽ báo lỗi khi bật lại. Hãy đổi sang cổng khác (ví dụ 9901, 9902…).
                            </span>
                        </li>
                        <li className="flex gap-1.5">
                            <span className="text-red-400 mt-0.5 flex-shrink-0">•</span>
                            <span>
                                <span className="text-red-300 font-medium">Tránh tắt/bật app trong giờ nhân viên đang làm việc</span> — nhân viên sẽ mất kết nối giữa chừng, tin nhắn đang xử lý có thể không gửi được cho đến khi đăng nhập lại.
                            </span>
                        </li>
                    </ul>
                    <p className="text-[10px] text-gray-500 pt-0.5 border-t border-yellow-500/10">
                        💡 <span className="text-gray-400">Khuyến nghị:</span> Đặt <span className="text-gray-300">IP tĩnh</span> cho máy boss (trong cài đặt card mạng Windows) để IP không bao giờ thay đổi. Kết hợp với "Tự động bật server" để nhân viên chỉ cần đăng nhập lại sau mỗi lần restart mà không cần đổi địa chỉ.
                    </p>
                </div>
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

