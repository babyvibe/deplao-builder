import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useWorkspaceStore, WorkspaceInfo } from '@/store/workspaceStore';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';

// ── WorkspaceSwitcher ─────────────────────────────────────────────────────────
// Compact dropdown in TopBar — shows active workspace + quick switch.
// Only visible when multi-workspace mode is active.

export default function WorkspaceSwitcher() {
    const {
        workspaces, activeWorkspaceId, setWorkspaces, setActiveWorkspaceId,
        connectionStatuses, unreadCounts, isSwitching, setIsSwitching,
    } = useWorkspaceStore();
    const { showNotification } = useAppStore();
    const [open, setOpen] = useState(false);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // ─── Load workspaces on mount ────────────────────────────────────
    const loadWorkspaces = useCallback(async () => {
        try {
            const [listRes, activeRes] = await Promise.all([
                ipc.workspace?.list(),
                ipc.workspace?.getActive(),
            ]);
            if (listRes?.success) setWorkspaces(listRes.workspaces);
            if (activeRes?.success) setActiveWorkspaceId(activeRes.workspace.id);
        } catch { /* */ }
    }, [setWorkspaces, setActiveWorkspaceId]);

    useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

    // ─── Listen for workspace:switched events ────────────────────────
    useEffect(() => {
        const unsub = window.electronAPI?.on?.('workspace:switched', (data: any) => {
            if (data?.workspace) {
                setActiveWorkspaceId(data.workspace.id);
                loadWorkspaces();
            }
            setIsSwitching(false);
        });
        return () => { unsub?.(); };
    }, [setActiveWorkspaceId, loadWorkspaces, setIsSwitching]);

    // ─── Click outside to close ──────────────────────────────────────
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setOpen(false);
                setShowCreateForm(false);
            }
        };
        if (open) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // ─── Switch workspace ────────────────────────────────────────────
    const handleSwitch = async (id: string) => {
        if (id === activeWorkspaceId || isSwitching) return;
        setIsSwitching(true);
        setOpen(false);
        // Safety timeout: always reset switching state after 10s
        const safetyTimer = setTimeout(() => setIsSwitching(false), 10000);
        try {
            const res = await ipc.workspace?.switch(id);
            if (!res?.success) {
                showNotification(res?.error || 'Lỗi chuyển workspace', 'error');
                clearTimeout(safetyTimer);
                setIsSwitching(false);
            }
            // workspace:switched event will set isSwitching = false
        } catch {
            clearTimeout(safetyTimer);
            setIsSwitching(false);
        }
    };

    // ─── Only show if multi-workspace ────────────────────────────────
    if (workspaces.length <= 1) return null;

    const activeWs = workspaces.find(w => w.id === activeWorkspaceId);

    return (
        <div ref={dropdownRef} className="relative">
            {/* Trigger button */}
            <button
                onClick={() => setOpen(!open)}
                disabled={isSwitching}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all
                    ${isSwitching
                        ? 'bg-gray-700/50 text-gray-500 cursor-wait'
                        : 'bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-600/50'
                    }`}
            >
                {isSwitching ? (
                    <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle className="opacity-25" cx="12" cy="12" r="10" />
                        <path className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" stroke="none" />
                    </svg>
                ) : (
                    <span className="text-sm">{activeWs?.icon || '🏠'}</span>
                )}
                <span className="max-w-[100px] truncate">{activeWs?.name || 'Workspace'}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-50">
                    <path d="M6 9l6 6 6-6" />
                </svg>

                {/* Badge for other workspaces with unread */}
                {(() => {
                    const totalOtherUnread = Object.entries(unreadCounts)
                        .filter(([wsId]) => wsId !== activeWorkspaceId)
                        .reduce((sum, [, count]) => sum + count, 0);
                    if (totalOtherUnread <= 0) return null;
                    return (
                        <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-[9px] text-white rounded-full flex items-center justify-center font-bold">
                            {totalOtherUnread > 9 ? '9+' : totalOtherUnread}
                        </span>
                    );
                })()}
            </button>

            {/* Dropdown */}
            {open && (
                <div className="absolute top-full left-0 mt-1.5 w-64 bg-gray-800 border border-gray-600/60 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                    {/* Workspace list */}
                    <div className="py-1.5 max-h-64 overflow-y-auto">
                        {workspaces.map(ws => (
                            <WorkspaceRow
                                key={ws.id}
                                workspace={ws}
                                isActive={ws.id === activeWorkspaceId}
                                connectionStatus={connectionStatuses[ws.id]}
                                unreadCount={unreadCounts[ws.id] || 0}
                                onClick={() => handleSwitch(ws.id)}
                            />
                        ))}
                    </div>

                    {/* Footer actions */}
                    <div className="border-t border-gray-700 px-2 py-1.5 space-y-0.5">
                        {showCreateForm ? (
                            <CreateWorkspaceInline
                                onCreated={() => { setShowCreateForm(false); loadWorkspaces(); }}
                                onCancel={() => setShowCreateForm(false)}
                            />
                        ) : (
                            <>
                                <button
                                    onClick={() => setShowCreateForm(true)}
                                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 rounded-lg transition-colors"
                                >
                                    <span>➕</span>
                                    <span>Thêm workspace...</span>
                                </button>
                                <button
                                    onClick={() => {
                                        setOpen(false);
                                        window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'workspace' } }));
                                        window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                                    }}
                                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 rounded-lg transition-colors"
                                >
                                    <span>⚙️</span>
                                    <span>Quản lý workspace</span>
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Workspace Row ─────────────────────────────────────────────────────────────

function WorkspaceRow({ workspace, isActive, connectionStatus, unreadCount, onClick }: {
    workspace: WorkspaceInfo;
    isActive: boolean;
    connectionStatus?: { connected: boolean; latency: number };
    unreadCount: number;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={isActive}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors
                ${isActive
                    ? 'bg-blue-600/10 border-l-2 border-blue-500'
                    : 'hover:bg-gray-700/40 border-l-2 border-transparent'
                }`}
        >
            <span className="text-base flex-shrink-0">{workspace.icon || (workspace.type === 'local' ? '🏠' : '👤')}</span>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-medium truncate ${isActive ? 'text-blue-300' : 'text-gray-200'}`}>
                        {workspace.name}
                    </span>
                    {isActive && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-blue-600/30 text-blue-300 font-medium">Active</span>
                    )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-500">
                        {workspace.type === 'local' ? 'Boss' : `Nhân viên`}
                    </span>
                    {workspace.type === 'remote' && connectionStatus && (
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${connectionStatus.connected ? 'bg-green-400' : 'bg-red-400'}`} />
                    )}
                    {workspace.type === 'remote' && workspace.employeeName && (
                        <span className="text-[10px] text-gray-600 truncate">→ {workspace.employeeName}</span>
                    )}
                </div>
            </div>
            {/* Unread badge */}
            {!isActive && unreadCount > 0 && (
                <span className="flex-shrink-0 w-5 h-5 bg-red-500 text-[10px] text-white rounded-full flex items-center justify-center font-bold">
                    {unreadCount > 9 ? '9+' : unreadCount}
                </span>
            )}
        </button>
    );
}

// ── Inline Create Form ────────────────────────────────────────────────────────

function CreateWorkspaceInline({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
    const { showNotification } = useAppStore();
    const [name, setName] = useState('');
    const [type, setType] = useState<'local' | 'remote'>('local');
    const [ip, setIp] = useState('');
    const [port, setPort] = useState('9900');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [creating, setCreating] = useState(false);
    const [step, setStep] = useState<'idle' | 'logging-in' | 'connecting'>('idle');

    const handleCreate = async () => {
        if (!name.trim()) return;
        setCreating(true);
        try {
            if (type === 'remote') {
                if (!ip.trim() || !username.trim() || !password.trim()) {
                    showNotification('Nhập đầy đủ IP, tên đăng nhập và mật khẩu', 'warning');
                    setCreating(false);
                    return;
                }
                const bossUrl = `http://${ip.trim()}:${port.trim() || '9900'}`;

                setStep('logging-in');
                const loginRes = await ipc.workspace?.loginRemote(bossUrl, username.trim(), password);
                if (!loginRes?.success) {
                    showNotification(loginRes?.error || 'Đăng nhập thất bại', 'error');
                    setCreating(false);
                    setStep('idle');
                    return;
                }

                setStep('connecting');
                const res = await ipc.workspace?.create({
                    name: name.trim(),
                    type: 'remote',
                    bossUrl,
                    token: loginRes.token,
                    employeeId: loginRes.employee?.employee_id,
                    employeeName: loginRes.employee?.display_name || username.trim(),
                    employeeUsername: username.trim(),
                    autoConnect: true,
                });
                if (res?.success) {
                    if (res.workspace?.id && loginRes.token) {
                        await ipc.workspace?.connectRemote(res.workspace.id, bossUrl, loginRes.token);
                    }
                    showNotification(`Workspace "${name}" — đã kết nối!`, 'success');
                    onCreated();
                } else {
                    showNotification(res?.error || 'Tạo thất bại', 'error');
                }
            } else {
                const res = await ipc.workspace?.create({ name: name.trim(), type });
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
        setCreating(false);
        setStep('idle');
    };

    const btnLabel = step === 'logging-in' ? '...' : step === 'connecting' ? '...' : creating ? '...' : 'Tạo';

    return (
        <div className="space-y-2 p-1">
            <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
                placeholder="Tên workspace..."
                className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center gap-2">
                <select
                    value={type}
                    onChange={e => setType(e.target.value as any)}
                    className="text-[11px] bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-gray-300 focus:outline-none"
                >
                    <option value="local">🏠 Local (Boss)</option>
                    <option value="remote">👤 Remote (Nhân viên)</option>
                </select>
            </div>
            {type === 'remote' && (
                <>
                    <div className="flex gap-1.5">
                        <input
                            value={ip}
                            onChange={e => setIp(e.target.value)}
                            placeholder="IP — 192.168.1.100"
                            className="flex-1 text-xs bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                        <input
                            value={port}
                            onChange={e => setPort(e.target.value)}
                            placeholder="Port"
                            className="w-14 text-xs bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                        />
                    </div>
                    <input
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        placeholder="Tên đăng nhập"
                        className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                    <input
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="Mật khẩu"
                        type="password"
                        onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                        className="w-full text-xs bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                </>
            )}
            <div className="flex items-center gap-2 justify-end">
                <button
                    onClick={onCancel}
                    className="text-[11px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded transition-colors"
                >
                    Hủy
                </button>
                <button
                    onClick={handleCreate}
                    disabled={!name.trim() || creating}
                    className="text-[11px] font-medium text-white bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded-lg transition-colors disabled:opacity-40"
                >
                    {btnLabel}
                </button>
            </div>
        </div>
    );
}

