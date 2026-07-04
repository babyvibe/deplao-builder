import React, { useState, useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employeeStore';
import { useAppStore } from '@/store/appStore';
import RestQueryService from '../../../services/http/RestQueryService';

interface Props {
    onBossMode: () => void;
    onEmployeeConnected: () => void;
}

export default function EmployeeLoginScreen({ onBossMode, onEmployeeConnected }: Props) {
    const { showNotification } = useAppStore();
    const {
        setMode, setCurrentEmployee, setPermissions, setAssignedAccounts,
        setBossUrl, setBossConnected, setToken,
    } = useEmployeeStore();

    const [tab, setTab] = useState<'boss' | 'employee'>('boss');
    const [bossAddress, setBossAddress] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');

    // Load saved values from localStorage
    useEffect(() => {
        try {
            const saved = localStorage.getItem('deplao_employee_login');
            if (saved) {
                const data = JSON.parse(saved);
                if (data.bossAddress) setBossAddress(data.bossAddress);
                if (data.username) setUsername(data.username);
            }
        } catch { /* */ }
    }, []);

    const handleBossLogin = () => {
        setMode('boss');
        onBossMode();
    };

    const handleEmployeeLogin = async () => {
        setError('');
        if (!bossAddress.trim()) { setError('Vui lòng nhập địa chỉ BOSS'); return; }
        if (!username.trim()) { setError('Vui lòng nhập tên đăng nhập'); return; }
        if (!password) { setError('Vui lòng nhập mật khẩu'); return; }

        setConnecting(true);

        try {
            // Step 1: Gọi REST API login trực tiếp (không qua IPC local)
            const loginRes = await RestQueryService.login(
                bossAddress.trim(),
                username.trim(),
                password
            );

            if (!loginRes.success) {
                setError(loginRes.error || 'Đăng nhập thất bại');
                setConnecting(false);
                return;
            }

            const { token, employee, snapshot } = loginRes.data || {};

            if (!token || !employee) {
                setError('Phản hồi từ BOSS không hợp lệ');
                setConnecting(false);
                return;
            }

            // Step 2: Init RestQueryService với token
            RestQueryService.getInstance().init(bossAddress.trim(), token);
            // Theo dõi trạng thái kết nối → header cập nhật real-time
            RestQueryService.getInstance().setOnStatusChange((connected, latency) => {
              useEmployeeStore.getState().setBossConnected(connected);
              if (latency > 0) useEmployeeStore.getState().setLatency(latency);
            });

            // Step 3: Set mode và lưu thông tin
            await ipc.employee?.setMode('employee');

            // Step 3b: Mở SSE connection để nhận realtime events (không sync data)
            // connectToBoss sẽ start HttpClientService → heartbeat + SSE stream
            const connectRes = await ipc.employee?.connectToBoss(bossAddress.trim(), token);
            if (!connectRes?.success) {
                console.warn('[EmployeeLogin] SSE connection failed, realtime events disabled');
            }

            // Lưu login cho lần sau
            localStorage.setItem('deplao_employee_login', JSON.stringify({
                bossAddress: bossAddress.trim(),
                username: username.trim(),
            }));

            // Step 4: Update store
            const permsMap: Record<string, boolean> = {};
            if (employee.permissions) {
                for (const p of employee.permissions) {
                    permsMap[p.module] = p.can_access;
                }
            }

            setCurrentEmployee(employee);
            setPermissions(permsMap);
            setAssignedAccounts(employee.assigned_accounts || []);
            setBossUrl(bossAddress.trim());
            setBossConnected(true);
            setToken(token);
            setMode('employee');
            setConnecting(false);

            showNotification(`Đăng nhập thành công! Xin chào ${employee.display_name}`, 'success');

            // Step 5: Kết nối xong → vào app. Data sẽ load lazy qua DataAccessor.
            onEmployeeConnected();

        } catch (err: any) {
            setError(err.message || 'Lỗi kết nối');
            setConnecting(false);
        }
    };

    // ─── Login screen ──────────────────────────────────────────────
    return (
        <div className="flex-1 flex items-center justify-center bg-gray-900 p-4">
            <div className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="px-6 pt-6 pb-4 text-center">
                    <h1 className="text-xl font-bold text-white mb-1">Deplao</h1>
                    <p className="text-sm text-gray-400">Chọn chế độ đăng nhập</p>
                </div>

                {/* Tab switcher */}
                <div className="flex mx-6 mb-4 bg-gray-700/50 rounded-xl p-1">
                    <button
                        onClick={() => setTab('boss')}
                        className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all ${
                            tab === 'boss'
                                ? 'bg-blue-600 text-white shadow-lg'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        👔 BOSS
                    </button>
                    <button
                        onClick={() => setTab('employee')}
                        className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all ${
                            tab === 'employee'
                                ? 'bg-green-600 text-white shadow-lg'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        👤 Nhân viên
                    </button>
                </div>

                {/* Tab content */}
                <div className="px-6 pb-6">
                    {tab === 'boss' ? (
                        <div className="space-y-4">
                            <p className="text-xs text-gray-400 leading-relaxed">
                                Chế độ BOSS: App hoạt động đầy đủ tính năng, giữ kết nối Zalo và relay tin nhắn cho nhân viên.
                            </p>
                            <button
                                onClick={handleBossLogin}
                                className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl transition-colors"
                            >
                                Tiếp tục với chế độ BOSS →
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-xs text-gray-400 leading-relaxed">
                                Kết nối tới máy Boss để nhận và quản lý tin nhắn. BOSS cần bật Relay Server.
                            </p>

                            {/* Boss Address */}
                            <div>
                                <label className="text-[11px] text-gray-500 mb-1 block">Địa chỉ BOSS</label>
                                <input
                                    value={bossAddress} onChange={e => setBossAddress(e.target.value)}
                                    placeholder="192.168.1.100:9900 hoặc https://xxx.trycloudflare.com"
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
                                />
                                <p className="text-[10px] text-gray-600 mt-1">
                                    {bossAddress.includes('://')
                                        ? '🌐 Kết nối qua internet (Tunnel URL)'
                                        : '🏠 Kết nối qua LAN (IP:Port)'}
                                </p>
                            </div>

                            {/* Credentials */}
                            <div>
                                <label className="text-[11px] text-gray-500 mb-1 block">Tên đăng nhập</label>
                                <input
                                    value={username} onChange={e => setUsername(e.target.value)}
                                    placeholder="nhanvien01"
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
                                />
                            </div>
                            <div>
                                <label className="text-[11px] text-gray-500 mb-1 block">Mật khẩu</label>
                                <input
                                    type="password" value={password} onChange={e => setPassword(e.target.value)}
                                    placeholder="••••••"
                                    onKeyDown={e => e.key === 'Enter' && handleEmployeeLogin()}
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
                                />
                            </div>

                            {error && (
                                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                                    ⚠️ {error}
                                </p>
                            )}

                            <button
                                onClick={handleEmployeeLogin}
                                disabled={connecting}
                                className="w-full py-3 bg-green-600 hover:bg-green-500 text-white font-medium rounded-xl transition-colors disabled:opacity-50"
                            >
                                {connecting ? '⏳ Đang kết nối...' : '🔌 Kết nối & Đăng nhập'}
                            </button>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-3 border-t border-gray-700/50 text-center">
                    <p className="text-[10px] text-gray-600">Deplao - Quản lý Zalo & Facebook đa tài khoản</p>
                </div>
            </div>
        </div>
    );
}
