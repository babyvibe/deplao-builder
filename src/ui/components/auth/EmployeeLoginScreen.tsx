import React, { useState, useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employeeStore';
import { useAppStore } from '@/store/appStore';

interface Props {
    onBossMode: () => void;
    onEmployeeConnected: () => void;
}

export default function EmployeeLoginScreen({ onBossMode, onEmployeeConnected }: Props) {
    const { showNotification } = useAppStore();
    const { setMode, setCurrentEmployee, setPermissions, setAssignedAccounts, setBossUrl, setBossConnected, setSyncProgress, setLastSyncTime } = useEmployeeStore();

    const [tab, setTab] = useState<'boss' | 'employee'>('boss');
    const [bossIp, setBossIp] = useState('');
    const [bossPort, setBossPort] = useState('9900');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');

    // Sync progress state
    const [syncing, setSyncing] = useState(false);
    const [syncPhase, setSyncPhase] = useState('');
    const [syncPercent, setSyncPercent] = useState(0);
    const [syncDone, setSyncDone] = useState(false);

    // Load saved values from localStorage
    useEffect(() => {
        try {
            const saved = localStorage.getItem('deplao_employee_login');
            if (saved) {
                const data = JSON.parse(saved);
                if (data.bossIp) setBossIp(data.bossIp);
                if (data.bossPort) setBossPort(data.bossPort);
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
        if (!bossIp.trim()) { setError('Vui lòng nhập địa chỉ IP của BOSS'); return; }
        if (!username.trim()) { setError('Vui lòng nhập tên đăng nhập'); return; }
        if (!password) { setError('Vui lòng nhập mật khẩu'); return; }

        setConnecting(true);

        try {
            // Step 1: Authenticate locally to get JWT token
            const authRes = await ipc.employee?.login(username.trim(), password);
            if (!authRes?.success || !authRes.token) {
                setError(authRes?.error || 'Đăng nhập thất bại');
                setConnecting(false);
                return;
            }

            // Step 2: Connect to Boss via main process
            const bossUrl = `${bossIp.trim()}:${bossPort.trim()}`;
            const connectRes = await ipc.employee?.connectToBoss(bossUrl, authRes.token);
            if (!connectRes?.success) {
                setError(connectRes?.error || 'Kết nối tới BOSS thất bại');
                setConnecting(false);
                return;
            }

            // Step 3: Set mode in main process
            await ipc.employee?.setMode('employee');

            // Save for next time
            localStorage.setItem('deplao_employee_login', JSON.stringify({
                bossIp: bossIp.trim(),
                bossPort: bossPort.trim(),
                username: username.trim(),
            }));

            // Update store
            const emp = authRes.employee;
            const permsMap: Record<string, boolean> = {};
            if (emp.permissions) {
                for (const p of emp.permissions) {
                    permsMap[p.module] = p.can_access;
                }
            }

            setCurrentEmployee(emp);
            setPermissions(permsMap);
            setAssignedAccounts(emp.assigned_accounts || []);
            setBossUrl(bossUrl);
            setBossConnected(true);
            setMode('employee');
            setConnecting(false);

            // Step 4: Start data sync
            const assignedAccounts = emp.assigned_accounts || [];
            if (assignedAccounts.length > 0) {
                setSyncing(true);
                setSyncPhase('Đang kiểm tra dữ liệu...');
                setSyncPercent(0);
                setSyncProgress({ phase: 'Đang đồng bộ...', percent: 0 });

                try {
                    // Check if we have a previous sync → delta, otherwise full
                    const statusRes = await ipc.sync?.getStatus();
                    const lastSync = statusRes?.lastSyncTs || 0;

                    let syncRes: any;
                    if (lastSync > 0) {
                        setSyncPhase('Đang cập nhật dữ liệu mới...');
                        syncRes = await ipc.sync?.requestDeltaSync(lastSync);
                    } else {
                        setSyncPhase('Đang tải dữ liệu lần đầu...');
                        syncRes = await ipc.sync?.requestFullSync(assignedAccounts);
                    }

                    if (syncRes?.success) {
                        setSyncPercent(100);
                        setSyncPhase('Hoàn tất đồng bộ!');
                        setLastSyncTime(Date.now());
                        setSyncProgress({ phase: 'Hoàn tất', percent: 100 });
                    } else {
                        setSyncPhase(`⚠️ ${syncRes?.error || 'Lỗi đồng bộ'}`);
                        setSyncProgress(null);
                    }
                } catch (syncErr: any) {
                    setSyncPhase(`⚠️ ${syncErr.message}`);
                    setSyncProgress(null);
                }

                setSyncing(false);
                setSyncDone(true);
            } else {
                setSyncDone(true);
            }

            showNotification(`Đăng nhập thành công! Xin chào ${emp.display_name}`, 'success');

        } catch (err: any) {
            setError(err.message || 'Lỗi kết nối');
            setConnecting(false);
        }
    };

    const handleContinueAfterSync = () => {
        onEmployeeConnected();
    };

    // ─── Sync progress screen ──────────────────────────────────────
    if (syncing || syncDone) {
        return (
            <div className="flex-1 flex items-center justify-center bg-gray-900 p-4">
                <div className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
                    <div className="px-6 pt-6 pb-4 text-center">
                        <h1 className="text-xl font-bold text-white mb-1">Deplao</h1>
                        <p className="text-sm text-gray-400">Đồng bộ dữ liệu</p>
                    </div>

                    <div className="px-6 pb-6 space-y-4">
                        {/* Progress bar */}
                        <div>
                            <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                                <span>{syncPhase}</span>
                                <span>{syncPercent}%</span>
                            </div>
                            <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                        syncPercent >= 100 ? 'bg-green-500' : 'bg-blue-500'
                                    }`}
                                    style={{ width: `${Math.min(syncPercent, 100)}%` }}
                                />
                            </div>
                        </div>

                        {syncing && (
                            <p className="text-xs text-gray-500 text-center animate-pulse">
                                ⏳ Vui lòng đợi, đang đồng bộ dữ liệu từ BOSS...
                            </p>
                        )}

                        {syncDone && (
                            <button
                                onClick={handleContinueAfterSync}
                                className="w-full py-3 bg-green-600 hover:bg-green-500 text-white font-medium rounded-xl transition-colors"
                            >
                                ✅ Tiếp tục vào ứng dụng
                            </button>
                        )}
                    </div>

                    <div className="px-6 py-3 border-t border-gray-700/50 text-center">
                        <p className="text-[10px] text-gray-600">Deplao — Quản lý Zalo đa tài khoản</p>
                    </div>
                </div>
            </div>
        );
    }

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

                            {/* Boss IP */}
                            <div className="grid grid-cols-3 gap-2">
                                <div className="col-span-2">
                                    <label className="text-[11px] text-gray-500 mb-1 block">Địa chỉ IP BOSS</label>
                                    <input
                                        value={bossIp} onChange={e => setBossIp(e.target.value)}
                                        placeholder="192.168.1.100"
                                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
                                    />
                                </div>
                                <div>
                                    <label className="text-[11px] text-gray-500 mb-1 block">Cổng</label>
                                    <input
                                        value={bossPort} onChange={e => setBossPort(e.target.value)}
                                        placeholder="9900"
                                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
                                    />
                                </div>
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
                    <p className="text-[10px] text-gray-600">Deplao — Quản lý Zalo đa tài khoản</p>
                </div>
            </div>
        </div>
    );
}
