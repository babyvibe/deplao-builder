import React, { useState, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useWorkspaceStore, WorkspaceInfo } from '@/store/app/workspaceStore';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '../../common/ConfirmDialog';
import { cn } from '@/lib/cn';
import { EditIcon, HomeIcon, LinkIcon, PlusIcon, TrashIcon, UserIcon } from '@/components/common/icons';
import { Button, Input } from '@/components/ui';
import { RadioList } from '../cloud/cloudUi';
import { SettingsPage } from '../settingsUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';


/**
 * Build a normalized Boss URL from an address input and optional port.
 * - If address is already a full URL (http:// or https://), use as-is (ignore port)
 * - Otherwise prepend http:// and append :port
 */
function buildBossUrl(address: string, port: string): string {
    if (!address) return '';
    if (address.startsWith('http://') || address.startsWith('https://')) {
        return address.replace(/\/+$/, '');
    }
    const p = port || '9900';
    return `http://${address}:${p}`;
}

// ── WorkspaceSettings ─────────────────────────────────────────────────────────

/** Workspace "trên máy này" (local: host or single user) or "kết nối máy chủ" (remote: employee machine). */
export const WORKSPACE_KIND_LABEL = { local: tr('Trên máy này'), remote: tr('Kết nối máy chủ') } as const;

export default function WorkspaceSettings() {
    const { workspaces, activeWorkspaceId, setWorkspaces, setActiveWorkspaceId, connectionStatuses } = useWorkspaceStore(useShallow(s => ({
        workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId, setWorkspaces: s.setWorkspaces,
        setActiveWorkspaceId: s.setActiveWorkspaceId, connectionStatuses: s.connectionStatuses,
    })));
    const showNotification = useAppStore(s => s.showNotification);
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
            title: tr('Xóa workspace "{{name}}"?', { name: ws.name }),
            message: ws.type === 'local'
                ? tr('DB và tất cả dữ liệu của workspace này sẽ bị xóa vĩnh viễn.')
                : tr('Kết nối tới boss sẽ bị ngắt và workspace bị xóa.'),
            confirmText: tr('Xóa'),
            variant: 'danger',
        });
        if (!ok) return;
        const res = await ipc.workspace?.delete(ws.id);
        if (res?.success) {
            showNotification(tr('Đã xóa workspace'), 'success');
            // Always reload list; if deleted WS was active, workspace:switched event
            // fired from main process will handle full state reload.
            reload();
        } else {
            showNotification(res?.error || tr('Xóa thất bại'), 'error');
        }
    };

    const handleSwitch = async (id: string) => {
        if (id === activeWorkspaceId) return;
        const res = await ipc.workspace?.switch(id);
        if (!res?.success) showNotification(res?.error || tr('Lỗi chuyển workspace'), 'error');
    };

    return (
        <SettingsPage
            title={tr('Workspace')}
            description={tr('Mỗi workspace có dữ liệu, tài khoản và cài đặt riêng. Tối đa 5.')}
            actions={!showCreateForm && (
                <Button size="sm" onClick={() => setShowCreateForm(true)} leftIcon={<PlusIcon className="h-4 w-4" />}>{tr('Thêm workspace')}</Button>
            )}
        >
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
        </SettingsPage>
    );
}

// ── Workspace Card ─────────────────────────────────────────────────────────────

function OnlineStatus({ connected, latency }: { connected: boolean; latency?: number }) {
    return (
        <span className={cn('flex items-center gap-1 text-[11px] font-medium', connected ? 'text-success' : 'text-muted-foreground')}>
            <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-success' : 'bg-border-strong')} />
            {connected ? tr('Online{{v1}}', { v1: latency ? ` · ${latency}ms` : '' }) : tr('Offline')}
        </span>
    );
}

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
        <div className={cn(
            'flex items-start gap-3 rounded-xl border p-4 transition-colors',
            isActive ? 'border-primary/40 bg-selected' : 'border-border/60 bg-card hover:border-input',
        )}>
            <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-xl">
                {workspace.icon || (isRemote ? <UserIcon className="h-5 w-5 text-muted-foreground" /> : <HomeIcon className="h-5 w-5 text-muted-foreground" />)}
            </span>

            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{workspace.name}</span>
                    {isActive && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{tr('Đang dùng')}</span>
                    )}
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {isRemote ? WORKSPACE_KIND_LABEL.remote : WORKSPACE_KIND_LABEL.local}
                    </span>
                    {isRemote && <OnlineStatus connected={isConnected} latency={connectionStatus?.latency} />}
                </div>

                <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {isRemote && workspace.employeeName && (
                        <p className="flex items-center gap-1">
                            <UserIcon className="h-3.5 w-3.5" /> {workspace.employeeName}
                            {workspace.employeeUsername && <span> (@{workspace.employeeUsername})</span>}
                        </p>
                    )}
                    {isRemote && workspace.bossUrl && (
                        <p className="flex items-center gap-1 truncate"><LinkIcon className="h-3.5 w-3.5 flex-shrink-0" /> {workspace.bossUrl.replace(/^https?:\/\//, '')}</p>
                    )}
                    {!isRemote && workspace.dbPath && (
                        <p className="truncate font-mono" title={workspace.dbPath}>{workspace.dbPath}</p>
                    )}
                </div>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1">
                {!isActive && <Button variant="outline" size="sm" onClick={onSwitch}>{tr('Chuyển sang')}</Button>}
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={tr('Sửa')} title={tr('Sửa')}>
                    <EditIcon className="h-4 w-4" />
                </Button>
                {workspace.id !== 'default' && (
                    <Button variant="ghost" size="icon" onClick={onDelete} aria-label={tr('Xoá')} title={tr('Xoá')}
                        className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                        <TrashIcon className="h-4 w-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}

// ── Create Form ────────────────────────────────────────────────────────────────

function CreateWorkspaceForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
    const showNotification = useAppStore(s => s.showNotification);
    const [name, setName] = useState('');
    const [type, setType] = useState<'local' | 'remote'>('local');
    const [icon, setIcon] = useState('');
    // Remote fields - user-friendly
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
                    showNotification(tr('Nhập IP và Port của Boss'), 'warning');
                    setSaving(false);
                    return;
                }
                if (!username.trim() || !password.trim()) {
                    showNotification(tr('Nhập tên đăng nhập và mật khẩu'), 'warning');
                    setSaving(false);
                    return;
                }

                const bossUrl = buildBossUrl(ip.trim(), port.trim());

                // Step 2: Login to boss to get token
                setLoginStep('logging-in');
                const loginRes = await ipc.workspace?.loginRemote(bossUrl, username.trim(), password);
                if (!loginRes?.success) {
                    showNotification(loginRes?.error || tr('Đăng nhập thất bại - kiểm tra lại thông tin'), 'error');
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
                    showNotification(tr('Workspace "{{name}}" - đã kết nối thành công!', { name }), 'success');
                    onCreated();
                } else {
                    showNotification(res?.error || tr('Tạo workspace thất bại'), 'error');
                }
            } else {
                // Local workspace - simple create
                const res = await ipc.workspace?.create({
                    name: name.trim(),
                    type,
                    icon: icon.trim() || undefined,
                });
                if (res?.success) {
                    showNotification(tr('Workspace "{{name}}" đã được tạo', { name }), 'success');
                    onCreated();
                } else {
                    showNotification(res?.error || tr('Tạo thất bại'), 'error');
                }
            }
        } catch {
            showNotification(tr('Lỗi tạo workspace'), 'error');
        }
        setSaving(false);
        setLoginStep('idle');
    };

    const stepLabel = loginStep === 'logging-in' ? tr('Đang đăng nhập...')
        : loginStep === 'connecting' ? tr('Đang kết nối...')
        : saving ? tr('Đang tạo...') : tr('Tạo workspace');

    return (
        <div className="space-y-4 rounded-xl border border-border/60 bg-card p-4">
            <p className="text-sm font-semibold text-foreground">{tr('Tạo workspace')}</p>

            <div className="flex gap-2">
                <Input
                    value={icon}
                    onChange={e => setIcon(e.target.value)}
                    placeholder="🏠"
                    aria-label={tr('Biểu tượng')}
                    title={tr('Biểu tượng (emoji)')}
                    className="w-14 text-center"
                />
                <Input
                    autoFocus
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') onCancel(); }}
                    placeholder={tr('Tên workspace (VD: Cá nhân, Công ty ABC)')}
                    aria-label={tr('Tên workspace')}
                    className="flex-1"
                />
            </div>

            <RadioList
                label={tr('Loại workspace')}
                value={type}
                onChange={(next) => setType(next as 'local' | 'remote')}
                options={[
                    { value: 'local', label: WORKSPACE_KIND_LABEL.local, description: tr('Đăng nhập tài khoản chat ngay trên máy này (chủ shop, dùng một mình).') },
                    { value: 'remote', label: WORKSPACE_KIND_LABEL.remote, description: tr('Máy nhân viên: dùng tài khoản do quản lý cấp để vào dữ liệu của máy chủ.') },
                ]}
            />

            {type === 'remote' && (
                <div className="space-y-2 border-t border-border/60 pt-3">
                    <p className="text-xs text-muted-foreground">{tr('Địa chỉ máy chủ và tài khoản nhân viên (quản lý gửi cho bạn)')}</p>
                    <div className="flex gap-2">
                        <Input value={ip} onChange={e => setIp(e.target.value)} placeholder={tr('IP máy chủ, VD 192.168.1.100')} aria-label={tr('IP máy chủ')} className="flex-1" />
                        <Input value={port} onChange={e => setPort(e.target.value)} placeholder={tr('Cổng')} aria-label={tr('Cổng')} className="w-24" />
                    </div>
                    <Input value={username} onChange={e => setUsername(e.target.value)} placeholder={tr('Tên đăng nhập')} aria-label={tr('Tên đăng nhập')} />
                    <Input
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder={tr('Mật khẩu')}
                        aria-label={tr('Mật khẩu')}
                        type="password"
                        onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                    />
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" checked={autoConnect} onChange={e => setAutoConnect(e.target.checked)} className="rounded accent-primary" />
                        {tr('Tự kết nối khi mở app')}
                    </label>
                </div>
            )}

            <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onCancel}>{tr('Huỷ')}</Button>
                <Button size="sm" onClick={handleCreate} disabled={!name.trim() || saving}>{stepLabel}</Button>
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
    const showNotification = useAppStore(s => s.showNotification);
    const [name, setName] = useState(workspace.name);
    const [icon, setIcon] = useState(workspace.icon || '');
    const [autoConnect, setAutoConnect] = useState(workspace.autoConnect ?? true);
    const [saving, setSaving] = useState(false);
    const [connecting, setConnecting] = useState(false);

    // Parse IP + Port from existing bossUrl
    const parseBossUrl = (url: string) => {
        if (!url) return { ip: '', port: '9900' };
        try {
            const parsed = new URL(url);
            // Tunnel URL (https:// or non-standard hostname) - preserve full URL
            if (parsed.protocol === 'https:' || parsed.hostname.includes('.')) {
                // Return the full URL as the "ip" so the user can see and edit it
                // Port field will be hidden when ip is a full URL
                return { ip: url.replace(/\/+$/, ''), port: parsed.port || '9900' };
            }
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
                updates.bossUrl = ip.trim() ? buildBossUrl(ip.trim(), port.trim()) : workspace.bossUrl;
                updates.employeeUsername = username.trim();
                updates.autoConnect = autoConnect;
            }
            const res = await ipc.workspace?.update(workspace.id, updates);
            if (res?.success) {
                showNotification(tr('Đã lưu'), 'success');
                onSaved();
            } else {
                showNotification(res?.error || tr('Lưu thất bại'), 'error');
            }
        } catch {
            showNotification(tr('Lỗi lưu'), 'error');
        }
        setSaving(false);
    };

    const handleConnect = async () => {
        if (!ip.trim() || !port.trim()) {
            showNotification(tr('Nhập IP và Port của Boss'), 'warning');
            return;
        }
        if (!username.trim() || !password.trim()) {
            showNotification(tr('Nhập tên đăng nhập và mật khẩu để kết nối'), 'warning');
            return;
        }

        setConnecting(true);
        try {
            const bossUrl = buildBossUrl(ip.trim(), port.trim());

            // Step 1: Login to get fresh token
            const loginRes = await ipc.workspace?.loginRemote(bossUrl, username.trim(), password);
            if (!loginRes?.success || !loginRes.token) {
                showNotification(loginRes?.error || tr('Đăng nhập thất bại'), 'error');
                setConnecting(false);
                return;
            }

            // Step 2: Save the employee info (does NOT include URL/token → workspace:update does not reconnect by itself)
            await ipc.workspace?.update(workspace.id, {
                employeeId: loginRes.employee?.employee_id,
                employeeName: loginRes.employee?.display_name || username.trim(),
                employeeUsername: username.trim(),
            });

            // Step 3: Save BOTH the URL and token to the workspace config, then connect through main (heartbeat + Socket.IO)
            // → main emits employee:credentials → the renderer's REST client uses the new URL/token.
            const res = await ipc.workspace?.connectRemote(workspace.id, bossUrl, loginRes.token);
            if (res?.success) {
                showNotification(tr('Đã kết nối tới boss!'), 'success');
            } else {
                showNotification(res?.error || tr('Kết nối thất bại'), 'error');
            }
        } catch {
            showNotification(tr('Lỗi kết nối'), 'error');
        }
        setConnecting(false);
    };

    const handleDisconnect = async () => {
        try {
            await ipc.workspace?.disconnectRemote(workspace.id);
            showNotification(tr('Đã ngắt kết nối'), 'success');
        } catch {
            showNotification(tr('Lỗi ngắt kết nối'), 'error');
        }
    };

    return (
        <div className="space-y-4 rounded-xl border border-primary/40 bg-card p-4">
            <p className="text-sm font-semibold text-foreground">{tr('Sửa workspace')}</p>

            <div className="flex gap-2">
                <Input
                    value={icon}
                    onChange={e => setIcon(e.target.value)}
                    placeholder="🏠"
                    aria-label={tr('Biểu tượng')}
                    title={tr('Biểu tượng (emoji)')}
                    className="w-14 text-center"
                />
                <Input
                    autoFocus
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
                    placeholder={tr('Tên workspace')}
                    aria-label={tr('Tên workspace')}
                    className="flex-1"
                />
            </div>

            {isRemote && (
                <div className="space-y-2 border-t border-border/60 pt-3">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-foreground">{tr('Kết nối máy chủ')}</p>
                        <OnlineStatus connected={isConnected} latency={connectionStatus?.latency} />
                    </div>
                    <div className="flex gap-2">
                        <Input value={ip} onChange={e => setIp(e.target.value)} placeholder={tr('192.168.1.100 hoặc https://shop.example.com')}
                            aria-label={tr('Địa chỉ máy chủ')} className="flex-1" />
                        {!ip.startsWith('http') && (
                            <Input value={port} onChange={e => setPort(e.target.value)} placeholder={tr('Cổng')} aria-label={tr('Cổng')} className="w-24" />
                        )}
                    </div>
                    <Input value={username} onChange={e => setUsername(e.target.value)} placeholder={tr('Tên đăng nhập')} aria-label={tr('Tên đăng nhập')} />
                    <Input
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder={tr('Mật khẩu (nhập để kết nối lại)')}
                        aria-label={tr('Mật khẩu')}
                        type="password"
                        onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
                    />

                    {workspace.employeeName && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                            {trx('<0/> Đang đăng nhập: {{employeeName}}', { 0: <UserIcon className="h-3.5 w-3.5" />, employeeName: workspace.employeeName })}
                            {workspace.employeeUsername && <span> (@{workspace.employeeUsername})</span>}
                        </p>
                    )}

                    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" checked={autoConnect} onChange={e => setAutoConnect(e.target.checked)} className="rounded accent-primary" />
                        {tr('Tự kết nối khi mở app')}
                    </label>

                    <div className="flex gap-2">
                        {isConnected ? (
                            <Button variant="outline" size="sm" onClick={handleDisconnect}
                                className="border-destructive/40 text-destructive hover:bg-destructive/10">
                                {tr('Ngắt kết nối')}
                            </Button>
                        ) : (
                            <Button variant="outline" size="sm" onClick={handleConnect} disabled={connecting} leftIcon={<LinkIcon className="h-4 w-4" />}>
                                {connecting ? tr('Đang đăng nhập và kết nối...') : tr('Đăng nhập và kết nối')}
                            </Button>
                        )}
                    </div>
                </div>
            )}

            <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onCancel}>{tr('Huỷ')}</Button>
                <Button size="sm" onClick={handleSave} disabled={!name.trim() || saving}>{saving ? tr('Đang lưu...') : tr('Lưu')}</Button>
            </div>
        </div>
    );
}

