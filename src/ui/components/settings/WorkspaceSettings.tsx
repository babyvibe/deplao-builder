import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useWorkspaceStore, WorkspaceInfo } from '@/store/workspaceStore';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../common/ConfirmDialog';

// ── WorkspaceSettings ─────────────────────────────────────────────────────────

export default function WorkspaceSettings() {
    const { workspaces, activeWorkspaceId, setWorkspaces, setActiveWorkspaceId, connectionStatuses } = useWorkspaceStore();
    const { showNotification } = useAppStore();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [showCreateForm, setShowCreateForm] = useState(false);

    const reload = useCallback(async () => {
        const [listRes, activeRes] = await Promise.all([
            ipc.workspace?.list(),
            ipc.workspace?.getActive(),
        ]);
        if (listRes?.success) setWorkspaces(listRes.workspaces);
        if (activeRes?.success) setActiveWorkspaceId(activeRes.workspace.id);
    }, [setWorkspaces, setActiveWorkspaceId]);

    useEffect(() => { reload(); }, [reload]);

    const handleDelete = async (ws: WorkspaceInfo) => {
        const ok = await showConfirm({
            title: `Xóa workspace "${ws.name}"?`,
            message: ws.type === 'local'
                ? 'DB và tất cả dữ liệu của workspace này sẽ bị xóa vĩnh viễn.'
                : 'Kết nối tới boss sẽ bị ngắt và workspace bị xóa.',
            confirmText: 'Xóa',
            variant: 'danger',
        });
        if (!ok) return;
        const res = await ipc.workspace?.delete(ws.id);
        if (res?.success) {
            showNotification('Đã xóa workspace', 'success');
            // Always reload list; if deleted WS was active, workspace:switched event
            // fired from main process will handle full state reload.
            reload();
        } else {
            showNotification(res?.error || 'Xóa thất bại', 'error');
        }
    };

    const handleSwitch = async (id: string) => {
        if (id === activeWorkspaceId) return;
        const res = await ipc.workspace?.switch(id);
        if (!res?.success) showNotification(res?.error || 'Lỗi chuyển workspace', 'error');
    };

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-semibold text-gray-200">Quản lý Workspace</h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                        Mỗi workspace có dữ liệu, tài khoản Zalo và cài đặt riêng biệt.
                    </p>
                </div>
                {!showCreateForm && (
                    <button
                        onClick={() => setShowCreateForm(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
                    >
                        <span>➕</span> Thêm workspace
                    </button>
                )}
            </div>

            {/* Create form */}
            {showCreateForm && (
                <CreateWorkspaceForm
                    onCreated={() => { setShowCreateForm(false); reload(); }}
                    onCancel={() => setShowCreateForm(false)}
                />
            )}

            {/* Workspace list */}
            <div className="space-y-2">
                {workspaces.map(ws => (
                    editingId === ws.id ? (
                        <EditWorkspaceForm
                            key={ws.id}
                            workspace={ws}
                            connectionStatus={connectionStatuses[ws.id]}
                            onSaved={() => { setEditingId(null); reload(); }}
                            onCancel={() => setEditingId(null)}
                        />
                    ) : (
                        <WorkspaceCard
                            key={ws.id}
                            workspace={ws}
                            isActive={ws.id === activeWorkspaceId}
                            connectionStatus={connectionStatuses[ws.id]}
                            onSwitch={() => handleSwitch(ws.id)}
                            onEdit={() => setEditingId(ws.id)}
                            onDelete={() => handleDelete(ws)}
                        />
                    )
                ))}
            </div>

            {/* Info */}
            <div className="rounded-xl bg-blue-600/10 border border-blue-600/20 p-3 text-xs text-blue-300 space-y-1">
                <p className="font-medium">💡 Hướng dẫn</p>
                <p className="text-blue-500">
                    • <strong>Local workspace</strong>: Chạy trực tiếp trên máy này — kết nối Zalo trực tiếp, có thể bật relay server cho nhân viên.
                </p>
                <p className="text-blue-500">
                    • <strong>Remote workspace</strong>: Nhân viên — nhập IP, Port, tên đăng nhập và mật khẩu (do quản lý cấp) để kết nối tới boss.
                </p>
                <p className="text-blue-500">
                    • <strong>Tối đa 5 workspace</strong>. Dữ liệu mỗi workspace hoàn toàn độc lập.
                </p>
            </div>
        </div>
    );
}

// ── Workspace Card ─────────────────────────────────────────────────────────────

function WorkspaceCard({ workspace, isActive, connectionStatus, onSwitch, onEdit, onDelete }: {
    workspace: WorkspaceInfo;
    isActive: boolean;
    connectionStatus?: { connected: boolean; latency: number };
    onSwitch: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const isRemote = workspace.type === 'remote';
    const isConnected = connectionStatus?.connected ?? false;

    return (
        <div className={`rounded-xl border p-4 transition-all ${
            isActive
                ? 'bg-blue-600/10 border-blue-500/40'
                : 'bg-gray-800/60 border-gray-700/60 hover:border-gray-600'
        }`}>
            <div className="flex items-start gap-3">
                <span className="text-2xl mt-0.5 flex-shrink-0">{workspace.icon || (isRemote ? '👤' : '🏠')}</span>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-200">{workspace.name}</span>
                        {isActive && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-600/30 text-blue-300 font-medium">
                                Active
                            </span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                            isRemote
                                ? 'bg-purple-600/20 text-purple-300'
                                : 'bg-gray-700 text-gray-400'
                        }`}>
                            {isRemote ? '👤 Remote' : '🏠 Local'}
                        </span>
                        {isRemote && (
                            <span className={`flex items-center gap-1 text-[10px] font-medium ${
                                isConnected ? 'text-green-400' : 'text-gray-500'
                            }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                    isConnected ? 'bg-green-400' : 'bg-gray-600'
                                }`} />
                                {isConnected
                                    ? `Online${connectionStatus?.latency ? ` · ${connectionStatus.latency}ms` : ''}`
                                    : 'Offline'
                                }
                            </span>
                        )}
                    </div>

                    <div className="mt-1 space-y-0.5">
                        {isRemote && workspace.employeeName && (
                            <p className="text-[11px] text-gray-500">
                                👤 {workspace.employeeName}
                                {workspace.employeeUsername && <span className="text-gray-600"> (@{workspace.employeeUsername})</span>}
                            </p>
                        )}
                        {isRemote && workspace.bossUrl && (
                            <p className="text-[11px] text-gray-600 truncate">
                                🔗 {workspace.bossUrl.replace(/^https?:\/\//, '')}
                            </p>
                        )}
                        {!isRemote && workspace.dbPath && (
                            <p className="text-[11px] text-gray-600 font-mono truncate">{workspace.dbPath}</p>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!isActive && (
                        <button
                            onClick={onSwitch}
                            className="px-2.5 py-1 text-[11px] font-medium text-blue-400 border border-blue-500/40 rounded-lg hover:bg-blue-600/20 transition-colors"
                        >
                            Chuyển
                        </button>
                    )}
                    <button
                        onClick={onEdit}
                        className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-700 rounded-lg transition-colors"
                        title="Chỉnh sửa"
                    >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    {workspace.id !== 'default' && (
                        <button
                            onClick={onDelete}
                            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-600/10 rounded-lg transition-colors"
                            title="Xóa"
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6l-1 14H6L5 6"/>
                                <path d="M10 11v6M14 11v6"/>
                                <path d="M9 6V4h6v2"/>
                            </svg>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Create Form ────────────────────────────────────────────────────────────────

function CreateWorkspaceForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
    const { showNotification } = useAppStore();
    const [name, setName] = useState('');
    const [type, setType] = useState<'local' | 'remote'>('local');
    const [icon, setIcon] = useState('');
    // Remote fields — user-friendly
    const [ip, setIp] = useState('');
    const [port, setPort] = useState('9900');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [autoConnect, setAutoConnect] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loginStep, setLoginStep] = useState<'idle' | 'logging-in' | 'connecting'>('idle');

    const handleCreate = async () => {
        if (!name.trim()) return;
        setSaving(true);

        try {
            if (type === 'remote') {
                // Step 1: Validate inputs
                if (!ip.trim() || !port.trim()) {
                    showNotification('Nhập IP và Port của Boss', 'warning');
                    setSaving(false);
                    return;
                }
                if (!username.trim() || !password.trim()) {
                    showNotification('Nhập tên đăng nhập và mật khẩu', 'warning');
                    setSaving(false);
                    return;
                }

                const bossUrl = `http://${ip.trim()}:${port.trim()}`;

                // Step 2: Login to boss to get token
                setLoginStep('logging-in');
                const loginRes = await ipc.workspace?.loginRemote(bossUrl, username.trim(), password);
                if (!loginRes?.success) {
                    showNotification(loginRes?.error || 'Đăng nhập thất bại — kiểm tra lại thông tin', 'error');
                    setSaving(false);
                    setLoginStep('idle');
                    return;
                }

                // Step 3: Create workspace with token
                setLoginStep('connecting');
                const res = await ipc.workspace?.create({
                    name: name.trim(),
                    type: 'remote',
                    icon: icon.trim() || undefined,
                    bossUrl,
                    token: loginRes.token,
                    employeeId: loginRes.employee?.employee_id,
                    employeeName: loginRes.employee?.display_name || username.trim(),
                    employeeUsername: username.trim(),
                    autoConnect,
                });

                if (res?.success) {
                    // Step 4: Auto-connect immediately
                    if (res.workspace?.id && loginRes.token) {
                        await ipc.workspace?.connectRemote(res.workspace.id, bossUrl, loginRes.token);
                    }
                    showNotification(`Workspace "${name}" — đã kết nối thành công!`, 'success');
                    onCreated();
                } else {
                    showNotification(res?.error || 'Tạo workspace thất bại', 'error');
                }
            } else {
                // Local workspace — simple create
                const res = await ipc.workspace?.create({
                    name: name.trim(),
                    type,
                    icon: icon.trim() || undefined,
                });
                if (res?.success) {
                    showNotification(`Workspace "${name}" đã được tạo`, 'success');
                    onCreated();
                } else {
                    showNotification(res?.error || 'Tạo thất bại', 'error');
                }
            }
        } catch {
            showNotification('Lỗi tạo workspace', 'error');
        }
        setSaving(false);
        setLoginStep('idle');
    };

    const stepLabel = loginStep === 'logging-in' ? 'Đang đăng nhập...'
        : loginStep === 'connecting' ? 'Đang kết nối...'
        : saving ? 'Đang tạo...' : 'Tạo workspace';

    return (
        <div className="rounded-xl bg-gray-800/80 border border-gray-600/60 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-300">Tạo workspace mới</p>

            <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 flex gap-2">
                    <input
                        value={icon}
                        onChange={e => setIcon(e.target.value)}
                        placeholder="🏠"
                        className="w-12 text-center text-sm bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
                    />
                    <input
                        autoFocus
                        value={name}
                        onChange={e => setName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') onCancel(); }}
                        placeholder="Tên workspace (VD: Cá nhân, Công ty ABC...)"
                        className="flex-1 text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                </div>

                <div>
                    <label className="block text-[11px] text-gray-500 mb-1">Loại workspace</label>
                    <select
                        value={type}
                        onChange={e => setType(e.target.value as any)}
                        className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-gray-300 focus:outline-none focus:border-blue-500"
                    >
                        <option value="local">🏠 Local (Boss / Standalone)</option>
                        <option value="remote">👤 Remote (Nhân viên)</option>
                    </select>
                </div>
            </div>

            {type === 'remote' && (
                <div className="space-y-2 pt-1 border-t border-gray-700">
                    <p className="text-[11px] text-gray-500">Kết nối tới Boss (nhập IP, Port, tài khoản nhân viên)</p>
                    <div className="flex gap-2">
                        <input
                            value={ip}
                            onChange={e => setIp(e.target.value)}
                            placeholder="IP Boss — 192.168.1.100"
                            className="flex-1 text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                        <input
                            value={port}
                            onChange={e => setPort(e.target.value)}
                            placeholder="Port"
                            className="w-20 text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                    </div>
                    <input
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        placeholder="Tên đăng nhập (nhận từ quản lý)"
                        className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                    <input
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="Mật khẩu"
                        type="password"
                        onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                        className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={autoConnect}
                            onChange={e => setAutoConnect(e.target.checked)}
                            className="rounded"
                        />
                        <span className="text-xs text-gray-400">Tự động kết nối khi mở app</span>
                    </label>
                </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
                <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-lg transition-colors">
                    Hủy
                </button>
                <button
                    onClick={handleCreate}
                    disabled={!name.trim() || saving}
                    className="text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                >
                    {stepLabel}
                </button>
            </div>
        </div>
    );
}

// ── Edit Form ──────────────────────────────────────────────────────────────────

function EditWorkspaceForm({ workspace, connectionStatus, onSaved, onCancel }: {
    workspace: WorkspaceInfo;
    connectionStatus?: { connected: boolean; latency: number };
    onSaved: () => void;
    onCancel: () => void;
}) {
    const { showNotification } = useAppStore();
    const [name, setName] = useState(workspace.name);
    const [icon, setIcon] = useState(workspace.icon || '');
    const [autoConnect, setAutoConnect] = useState(workspace.autoConnect ?? true);
    const [saving, setSaving] = useState(false);
    const [connecting, setConnecting] = useState(false);

    // Parse IP + Port from existing bossUrl
    const parseBossUrl = (url: string) => {
        try {
            const parsed = new URL(url);
            return { ip: parsed.hostname, port: parsed.port || '9900' };
        } catch {
            // Try without protocol
            const parts = url.replace(/^https?:\/\//, '').split(':');
            return { ip: parts[0] || '', port: parts[1] || '9900' };
        }
    };
    const parsed = parseBossUrl(workspace.bossUrl || '');
    const [ip, setIp] = useState(parsed.ip);
    const [port, setPort] = useState(parsed.port);
    const [username, setUsername] = useState(workspace.employeeUsername || '');
    const [password, setPassword] = useState('');

    const isRemote = workspace.type === 'remote';
    const isConnected = connectionStatus?.connected ?? false;

    const handleSave = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            const updates: any = { name: name.trim(), icon: icon.trim() || undefined };
            if (isRemote) {
                updates.bossUrl = ip.trim() && port.trim() ? `http://${ip.trim()}:${port.trim()}` : workspace.bossUrl;
                updates.employeeUsername = username.trim();
                updates.autoConnect = autoConnect;
            }
            const res = await ipc.workspace?.update(workspace.id, updates);
            if (res?.success) {
                showNotification('Đã lưu', 'success');
                onSaved();
            } else {
                showNotification(res?.error || 'Lưu thất bại', 'error');
            }
        } catch {
            showNotification('Lỗi lưu', 'error');
        }
        setSaving(false);
    };

    const handleConnect = async () => {
        if (!ip.trim() || !port.trim()) {
            showNotification('Nhập IP và Port của Boss', 'warning');
            return;
        }
        if (!username.trim() || !password.trim()) {
            showNotification('Nhập tên đăng nhập và mật khẩu để kết nối', 'warning');
            return;
        }

        setConnecting(true);
        try {
            const bossUrl = `http://${ip.trim()}:${port.trim()}`;

            // Step 1: Login to get fresh token
            const loginRes = await ipc.workspace?.loginRemote(bossUrl, username.trim(), password);
            if (!loginRes?.success) {
                showNotification(loginRes?.error || 'Đăng nhập thất bại', 'error');
                setConnecting(false);
                return;
            }

            // Step 2: Update workspace with new connection info
            await ipc.workspace?.update(workspace.id, {
                bossUrl,
                token: loginRes.token,
                employeeId: loginRes.employee?.employee_id,
                employeeName: loginRes.employee?.display_name || username.trim(),
                employeeUsername: username.trim(),
            });

            // Step 3: Connect via Socket.IO
            const res = await ipc.workspace?.connectRemote(workspace.id, bossUrl, loginRes.token!);
            if (res?.success) {
                showNotification('Đã kết nối tới boss!', 'success');
            } else {
                showNotification(res?.error || 'Kết nối thất bại', 'error');
            }
        } catch {
            showNotification('Lỗi kết nối', 'error');
        }
        setConnecting(false);
    };

    const handleDisconnect = async () => {
        try {
            await ipc.workspace?.disconnectRemote(workspace.id);
            showNotification('Đã ngắt kết nối', 'success');
        } catch {
            showNotification('Lỗi ngắt kết nối', 'error');
        }
    };

    return (
        <div className="rounded-xl bg-gray-800/80 border border-blue-500/30 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-300">Chỉnh sửa workspace</p>

            <div className="flex gap-2">
                <input
                    value={icon}
                    onChange={e => setIcon(e.target.value)}
                    placeholder="🏠"
                    className="w-12 text-center text-sm bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500"
                />
                <input
                    autoFocus
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
                    placeholder="Tên workspace"
                    className="flex-1 text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
            </div>

            {isRemote && (
                <div className="space-y-2 pt-1 border-t border-gray-700">
                    <div className="flex items-center justify-between">
                        <p className="text-[11px] text-gray-500">Kết nối boss</p>
                        <span className={`flex items-center gap-1 text-[10px] font-medium ${isConnected ? 'text-green-400' : 'text-gray-500'}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-400' : 'bg-gray-600'}`} />
                            {isConnected ? `Online${connectionStatus?.latency ? ` · ${connectionStatus.latency}ms` : ''}` : 'Offline'}
                        </span>
                    </div>
                    <div className="flex gap-2">
                        <input
                            value={ip}
                            onChange={e => setIp(e.target.value)}
                            placeholder="IP Boss — 192.168.1.100"
                            className="flex-1 text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                        <input
                            value={port}
                            onChange={e => setPort(e.target.value)}
                            placeholder="Port"
                            className="w-20 text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                    </div>
                    <input
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        placeholder="Tên đăng nhập"
                        className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                    <input
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="Mật khẩu (nhập để kết nối lại)"
                        type="password"
                        onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
                        className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />

                    {workspace.employeeName && (
                        <p className="text-[11px] text-gray-500">
                            👤 Đăng nhập: <span className="text-gray-400">{workspace.employeeName}</span>
                            {workspace.employeeUsername && <span className="text-gray-600"> (@{workspace.employeeUsername})</span>}
                        </p>
                    )}

                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={autoConnect}
                            onChange={e => setAutoConnect(e.target.checked)}
                            className="rounded"
                        />
                        <span className="text-xs text-gray-400">Tự động kết nối khi mở app</span>
                    </label>

                    <div className="flex gap-2">
                        {isConnected ? (
                            <button
                                onClick={handleDisconnect}
                                className="text-xs text-red-400 border border-red-500/40 hover:bg-red-600/10 px-3 py-1.5 rounded-lg transition-colors"
                            >
                                Ngắt kết nối
                            </button>
                        ) : (
                            <button
                                onClick={handleConnect}
                                disabled={connecting}
                                className="text-xs text-green-300 border border-green-500/40 hover:bg-green-600/10 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                            >
                                {connecting ? 'Đang đăng nhập & kết nối...' : '🔌 Đăng nhập & Kết nối'}
                            </button>
                        )}
                    </div>
                </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
                <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-lg transition-colors">
                    Hủy
                </button>
                <button
                    onClick={handleSave}
                    disabled={!name.trim() || saving}
                    className="text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                >
                    {saving ? 'Đang lưu...' : 'Lưu'}
                </button>
            </div>
        </div>
    );
}

