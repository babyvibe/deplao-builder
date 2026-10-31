import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { showConfirm } from '../../common/ConfirmDialog';
import RelayStatusPanel from './RelayStatusPanel';
import { copyWithToast } from './RelayAddressNotice';
import { usePublicAddresses } from '../../common/cloud/PublicAddressCard';
import { navigateSettings } from '../cloud/cloudUi';
import { SegmentedControl, SettingsPage } from '../settingsUi';
import { Badge, Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { BookIcon, BotIcon, ChartIcon, ChatIcon, CheckCircleIcon, CheckIcon, ClipboardListIcon, ClockIcon, CopyIcon, EditIcon, FolderIcon, GlobeIcon, ImageIcon, KeyIcon, LightningIcon, LinkIcon, PlusIcon, RefreshIcon, SearchIcon, SettingsIcon, SmartphoneIcon, SunIcon, TrendingUpIcon, UserIcon, UsersIcon } from '@/components/common/icons';

const ALL_MODULES = [
    { key: 'chat', label: 'Chat', icon: <ChatIcon className="w-4 h-4" />, desc: 'Gửi/nhận tin nhắn', group: 'main' },
    { key: 'friends', label: 'Bạn bè', icon: <UsersIcon className="w-4 h-4" />, desc: 'Danh sách bạn bè', group: 'main' },
    { key: 'crm', label: 'CRM', icon: <ChartIcon className="w-4 h-4" />, desc: 'Quản lý khách hàng', group: 'main' },
    { key: 'erp', label: 'ERP', icon: <ClipboardListIcon className="w-4 h-4" />, desc: 'Quản lý công việc & dự án', group: 'main' },
    { key: 'workflow', label: 'Workflow', icon: <LightningIcon className="w-4 h-4" />, desc: 'Tự động hóa', group: 'main' },
    { key: 'integration', label: 'Tích hợp', icon: <LinkIcon className="w-4 h-4" />, desc: 'Kết nối POS/Shipping', group: 'main' },
    { key: 'analytics', label: 'Thống kê', icon: <TrendingUpIcon className="w-4 h-4" />, desc: 'Báo cáo phân tích', group: 'main' },
    { key: 'ai_assistant', label: 'AI', icon: <BotIcon className="w-4 h-4" />, desc: 'Trợ lý AI', group: 'main' },
    { key: 'facebook', label: 'Facebook', icon: <BookIcon className="w-4 h-4" />, desc: 'Facebook Messenger nhóm', group: 'main' },
    { key: 'settings_accounts', label: 'Quản lý TK Zalo', icon: <UserIcon className="w-4 h-4" />, desc: 'Xem/xóa tài khoản (boss)', group: 'settings', bossOnly: true },
    { key: 'settings_employees', label: 'Quản lý nhân viên', icon: <UsersIcon className="w-4 h-4" />, desc: 'Thêm/sửa/xóa NV (boss)', group: 'settings', bossOnly: true },
] as const;

interface EmployeeGroup {
    group_id: string;
    name: string;
    color: string;
    sort_order: number;
    created_at: number;
}

interface EmployeeData {
    employee_id: string;
    username: string;
    display_name: string;
    avatar_url: string;
    role: string;
    is_active: number;
    group_id: string | null;
    created_at: number;
    updated_at: number;
    last_login: number | null;
    permissions: Array<{ module: string; can_access: boolean }>;
    assigned_accounts: string[];
}

type SettingsTab = 'employees' | 'relay';

export default function EmployeeSettings() {
    const showNotification = useAppStore(s => s.showNotification);
    const accounts = useAccountStore(s => s.accounts);
    const { employees, setEmployees, previewEmployeeId, setPreviewEmployeeId, connectedEmployees, relayRunning, setRelayRunning, relayPort, setRelayPort } = useEmployeeStore(useShallow(s => ({
        employees: s.employees,
        setEmployees: s.setEmployees,
        previewEmployeeId: s.previewEmployeeId,
        setPreviewEmployeeId: s.setPreviewEmployeeId,
        connectedEmployees: s.connectedEmployees,
        relayRunning: s.relayRunning,
        setRelayRunning: s.setRelayRunning,
        relayPort: s.relayPort,
        setRelayPort: s.setRelayPort,
    })));
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<SettingsTab>('employees');
    const [searchQuery, setSearchQuery] = useState('');
    const [showGroupPanel, setShowGroupPanel] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingEmployee, setEditingEmployee] = useState<EmployeeData | null>(null);
    const [groups, setGroups] = useState<EmployeeGroup[]>([]);
    const [newGroupName, setNewGroupName] = useState('');
    const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
    const [editingGroupName, setEditingGroupName] = useState('');

    // ─── Relay quick actions state ─────────────────────────────
    const [portInput, setPortInput] = useState(String(relayPort));
    // WAN chỉ để xem: bật / tắt / đổi địa chỉ ở Cài đặt → Internet & Đám mây → Địa chỉ Internet
    const [tunnelActive, setTunnelActive] = useState(false);
    const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
    const [relayStarting, setRelayStarting] = useState(false);
    const [relayHost, setRelayHost] = useState<string | null>(null);
    const publicAddresses = usePublicAddresses();

    const loadEmployees = useCallback(async () => {
        setLoading(true);
        try {
            const [empRes, grpRes] = await Promise.all([
                ipc.employee?.list(),
                ipc.employee?.listGroups(),
            ]);
            if (empRes?.success) setEmployees(empRes.employees);
            if (grpRes?.success) setGroups(grpRes.groups || []);
        } catch { /* */ }
        setLoading(false);
    }, [setEmployees]);

    useEffect(() => { loadEmployees(); }, [loadEmployees]);

    // ─── Relay quick action handlers ────────────────────────────
    const handleQuickStartRelay = async () => {
        setRelayStarting(true);
        try {
            const port = parseInt(portInput) || 9900;
            const res = await ipc.relay?.startServer(port);
            if (res?.success) {
                showNotification(`Relay server đã bật trên cổng ${res.port}`, 'success');
                setRelayRunning(true);
                if (res.port) { setRelayPort(res.port); setPortInput(String(res.port)); }
                if (res.host) setRelayHost(res.host);
            } else {
                showNotification(res?.error || 'Không thể bật server', 'error');
            }
        } catch (err: any) { showNotification(err.message, 'error'); }
        setRelayStarting(false);
    };

    const handleQuickStopRelay = async () => {
        // Tắt relay thì tắt luôn địa chỉ Internet của relay (không để địa chỉ trỏ vào cổng không còn phục vụ)
        if (tunnelActive) {
            await ipc.relay?.stopTunnel();
            setTunnelActive(false);
            setTunnelUrl(null);
        }
        const res = await ipc.relay?.stopServer();
        if (res?.success) {
            showNotification('Relay server đã tắt', 'success');
            setRelayRunning(false);
            setRelayHost(null);
        }
    };

    // ─── Refresh relay status on mount ─────────────────────────
    useEffect(() => {
        ipc.relay?.getServerStatus().then((res: any) => {
            if (res?.success) {
                setRelayRunning(res.running || false);
                if (res.port) { setRelayPort(res.port); setPortInput(String(res.port)); }
                setTunnelActive(res.tunnelActive || false);
                setTunnelUrl(res.tunnelUrl || null);
            }
        }).catch(() => {});
    }, [setRelayRunning, setRelayPort]);

    // ─── Listen for tunnel status updates ──────────────────────
    useEffect(() => {
        const unsub = ipc.on?.('relay:tunnelStatusUpdate', (data: { active: boolean; tunnelUrl: string | null }) => {
            setTunnelActive(data.active);
            setTunnelUrl(data.tunnelUrl);
        });
        return () => unsub?.();
    }, []);

    // ─── Stats ──────────────────────────────────────────────────
    const stats = useMemo(() => ({
        total: employees.length,
        active: employees.filter((e: EmployeeData) => e.is_active).length,
        online: connectedEmployees.length,
        groupCount: groups.length,
    }), [employees, connectedEmployees, groups]);

    // ─── Search filter ─────────────────────────────────────────
    const filteredEmployees = useMemo(() => {
        if (!searchQuery.trim()) return employees;
        const q = searchQuery.toLowerCase().trim();
        return employees.filter((e: EmployeeData) =>
            e.display_name?.toLowerCase().includes(q) ||
            e.username?.toLowerCase().includes(q)
        );
    }, [employees, searchQuery]);

    // ─── Group-based rendering ─────────────────────────────────
    const groupedEmployees = useMemo(() => {
        const src = filteredEmployees;
        if (groups.length === 0) return [{ group: null, employees: src as EmployeeData[] }];
        const result: Array<{ group: EmployeeGroup | null; employees: EmployeeData[] }> = [];
        for (const grp of groups) {
            const emps = src.filter((e: EmployeeData) => e.group_id === grp.group_id);
            if (emps.length > 0) result.push({ group: grp, employees: emps });
        }
        const ungrouped = src.filter((e: EmployeeData) => !e.group_id || !groups.some(g => g.group_id === e.group_id));
        if (ungrouped.length > 0) result.push({ group: null, employees: ungrouped });
        return result;
    }, [filteredEmployees, groups]);

    // ─── Group CRUD ─────────────────────────────────────────────
    const handleCreateGroup = async () => {
        if (!newGroupName.trim()) return;
        const res = await ipc.employee?.createGroup(newGroupName.trim());
        if (res?.success) {
            showNotification('Đã tạo nhóm', 'success');
            setNewGroupName('');
            loadEmployees();
        } else {
            showNotification(res?.error || 'Tạo nhóm thất bại', 'error');
        }
    };

    const handleUpdateGroup = async (groupId: string) => {
        if (!editingGroupName.trim()) return;
        const res = await ipc.employee?.updateGroup(groupId, { name: editingGroupName.trim() });
        if (res?.success) {
            setEditingGroupId(null);
            loadEmployees();
        }
    };

    const handleDeleteGroup = async (group: EmployeeGroup) => {
        const ok = await showConfirm({
            title: 'Xóa nhóm?',
            message: `Xóa nhóm "${group.name}"? Nhân viên trong nhóm sẽ trở thành không có nhóm.`,
            confirmText: 'Xóa',
            variant: 'danger',
        });
        if (!ok) return;
        const res = await ipc.employee?.deleteGroup(group.group_id);
        if (res?.success) {
            showNotification('Đã xóa nhóm', 'success');
            loadEmployees();
        }
    };

    // ─── Employee CRUD ──────────────────────────────────────────
    const handleDelete = async (emp: EmployeeData) => {
        const ok = await showConfirm({
            title: 'Xóa nhân viên?',
            message: `Xóa "${emp.display_name}" sẽ xóa toàn bộ phân quyền và log liên quan. Thao tác không thể hoàn tác.`,
            confirmText: 'Xóa',
            variant: 'danger',
        });
        if (!ok) return;
        const res = await ipc.employee?.delete(emp.employee_id);
        if (res?.success) {
            showNotification('Đã xóa nhân viên', 'success');
            loadEmployees();
        } else {
            showNotification(res?.error || 'Xóa thất bại', 'error');
        }
    };

    const handleToggleActive = async (emp: EmployeeData) => {
        const newActive = emp.is_active ? 0 : 1;
        const res = await ipc.employee?.update(emp.employee_id, { is_active: newActive });
        if (res?.success) {
            showNotification(newActive ? 'Đã kích hoạt' : 'Đã vô hiệu hóa', 'success');
            loadEmployees();
        }
    };

    // ─── Sim banner employee lookup ─────────────────────────────
    const simEmp = useMemo(() => {
        if (!previewEmployeeId) return null;
        return employees.find((e: any) => e.employee_id === previewEmployeeId) || null;
    }, [previewEmployeeId, employees]);

    // ─── Render employee row ────────────────────────────────────
    const renderEmployeeRow = (emp: EmployeeData) => (
        <div key={emp.employee_id} className="flex items-center gap-3 px-3.5 py-2.5 bg-card border border-border/60 rounded-xl hover:bg-muted transition-colors group">
            {/* Avatar */}
            <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-base flex-shrink-0 overflow-hidden">
                {emp.avatar_url ? (
                    <img src={toLocalMediaUrl(emp.avatar_url)} className="w-full h-full rounded-full object-cover" alt="" />
                ) : (
                    <span className="text-foreground/80 font-semibold">{emp.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <p className="text-sm text-foreground font-medium truncate">{emp.display_name}</p>
                    {emp.role === 'boss' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-medium leading-none">Boss</span>
                    )}
                    {!emp.is_active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium leading-none">Tắt</span>
                    )}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5">
                    <span>@{emp.username}</span>
                    <span title="Số mục được dùng"><KeyIcon className="w-4 h-4 inline" /> {emp.permissions?.filter((p: any) => p.can_access).length || 0} quyền</span>
                    <span title="Số tài khoản chat được giao"><SmartphoneIcon className="w-4 h-4 inline" /> {emp.assigned_accounts?.length || 0} tài khoản</span>
                    {emp.last_login && (
                        <span><ClockIcon className="w-4 h-4 inline" /> {new Date(emp.last_login).toLocaleDateString('vi-VN')}</span>
                    )}
                </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={() => {
                        if (previewEmployeeId === emp.employee_id) {
                            setPreviewEmployeeId(null);
                        } else {
                            setPreviewEmployeeId(emp.employee_id);
                            useAppStore.getState().setView('dashboard');
                        }
                    }}
                    className={`p-1.5 rounded-lg transition-colors ${
                        previewEmployeeId === emp.employee_id
                            ? 'text-warning bg-warning/15'
                            : 'text-muted-foreground hover:text-warning hover:bg-warning/10'
                    }`}
                    title={previewEmployeeId === emp.employee_id ? 'Thoát giả lập' : 'Đăng nhập với tư cách nhân viên này'}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
                        <polyline points="17 11 19 13 23 9"/>
                    </svg>
                </button>
                <button
                    onClick={() => handleToggleActive(emp)}
                    className={`p-1.5 rounded-lg transition-colors ${
                        emp.is_active ? 'text-muted-foreground hover:text-warning hover:bg-warning/10' : 'text-muted-foreground hover:text-success hover:bg-success/10'
                    }`}
                    title={emp.is_active ? 'Vô hiệu hóa' : 'Kích hoạt'}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {emp.is_active ? (
                            <><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>
                        ) : (
                            <polygon points="5 3 19 12 5 21 5 3" />
                        )}
                    </svg>
                </button>
                <button
                    onClick={() => { setEditingEmployee(emp); setShowForm(true); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                    title="Sửa"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button
                    onClick={() => handleDelete(emp)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title="Xóa"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                </button>
            </div>
        </div>
    );

    return (
        <SettingsPage
            title="Nhân viên"
            description="Tạo tài khoản cho nhân viên, giao tài khoản chat và quyền dùng từng mục."
            width="wide"
            actions={(
                <Button size="sm" onClick={() => { setEditingEmployee(null); setShowForm(true); }} leftIcon={<PlusIcon className="h-4 w-4" />}>
                    Thêm nhân viên
                </Button>
            )}
        >
        <div className="space-y-4">
            {/* ─── Số liệu ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {[
                    { label: 'Nhân viên', value: stats.total, icon: <UsersIcon className="w-4 h-4" />, color: 'text-foreground' },
                    { label: 'Đang hoạt động', value: stats.active, icon: <CheckIcon className="w-4 h-4" />, color: 'text-foreground' },
                    { label: 'Đang online', value: stats.online, icon: <CheckCircleIcon className="w-4 h-4" />, color: 'text-success' },
                    { label: 'Nhóm', value: stats.groupCount, icon: <FolderIcon className="w-4 h-4" />, color: 'text-foreground' },
                ].map((stat) => (
                    <div key={stat.label} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3.5 py-3">
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{stat.icon}</span>
                        <div>
                            <p className={`text-lg font-semibold leading-tight ${stat.color}`}>{stat.value}</p>
                            <p className="text-[11px] leading-tight text-muted-foreground">{stat.label}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* ─── Simulation Banner ──────────────────────────────── */}
            {simEmp && (
                <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3">
                    <div className="flex items-center gap-3">
                        <div className="relative flex-shrink-0">
                            {simEmp.avatar_url ? (
                                <img src={toLocalMediaUrl(simEmp.avatar_url)} className="w-9 h-9 rounded-full object-cover ring-2 ring-amber-500/60" alt="" />
                            ) : (
                                <div className="w-9 h-9 rounded-full bg-amber-700 ring-2 ring-amber-500/60 flex items-center justify-center text-base text-amber-200 font-bold">
                                    {simEmp.display_name?.charAt(0)?.toUpperCase() || '?'}
                                </div>
                            )}
                            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-amber-400 rounded-full border-2 border-border animate-pulse" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-foreground"><RefreshIcon className="w-4 h-4 inline text-warning" /> Đang giả lập: {simEmp.display_name}</p>
                            <p className="text-[11px] text-muted-foreground">
                                Chỉ thấy {simEmp.assigned_accounts?.length || 0} tài khoản và {simEmp.permissions?.filter((p: any) => p.can_access).length || 0} mục được cấp quyền.
                            </p>
                        </div>
                        <button
                            onClick={() => setPreviewEmployeeId(null)}
                            className="flex items-center gap-1.5 text-xs font-medium text-foreground px-2.5 py-1.5 bg-card rounded-lg hover:bg-muted transition-colors border border-border flex-shrink-0"
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                            Thoát
                        </button>
                    </div>
                </div>
            )}

            {/* ─── Quick Relay Bar ─────────────────────────────────── */}
            <div className="flex items-center gap-2 px-3.5 py-2 bg-card border border-border/60 rounded-xl shadow-sm">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex-shrink-0"><GlobeIcon className="w-4 h-4" /></span>

                {/* LAN toggle */}
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer hover:bg-muted transition-colors select-none flex-shrink-0">
                    <button
                        type="button"
                        role="switch"
                        aria-checked={relayRunning}
                        onClick={relayRunning ? handleQuickStopRelay : handleQuickStartRelay}
                        disabled={relayStarting}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-40 ${
                            relayRunning ? 'bg-green-500' : 'bg-accent'
                        }`}
                    >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                            relayRunning ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`} />
                    </button>
                    <span className={`text-xs font-medium ${relayRunning ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                        LAN
                    </span>
                    {relayRunning && relayHost && (
                        <div className="flex items-center gap-1 max-w-[180px]">
                            <span className="text-[10px] text-green-600 dark:text-green-400 font-mono bg-green-100 dark:bg-green-600/15 px-1.5 py-0.5 rounded truncate font-medium">{relayHost}:{relayPort}</span>
                            <button
                                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(`${relayHost}:${relayPort}`); showNotification('Đã copy địa chỉ LAN', 'info'); }}
                                className="text-muted-foreground hover:text-green-500 transition-colors flex-shrink-0 p-0.5"
                                title="Copy địa chỉ LAN"
                            >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                </svg>
                            </button>
                        </div>
                    )}
                </div>

                {/* Divider */}
                <div className="w-px h-5 bg-border flex-shrink-0" />

                {/* WAN — chỉ xem; bật / tắt / đổi địa chỉ ở Cài đặt → Internet & Đám mây → Địa chỉ Internet */}
                <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 select-none">
                    <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', tunnelActive && tunnelUrl ? 'bg-primary' : 'bg-accent')} aria-hidden="true" />
                    <span className={cn('text-xs font-medium', tunnelActive && tunnelUrl ? 'text-primary' : 'text-muted-foreground')}>WAN</span>
                    {tunnelActive && tunnelUrl ? (
                        <div className="flex min-w-0 max-w-[220px] items-center gap-1">
                            <span className="truncate rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary" title={tunnelUrl}>{tunnelUrl}</span>
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); copyWithToast(tunnelUrl, 'Đã sao chép địa chỉ WAN'); }}
                                className="flex-shrink-0 p-0.5 text-muted-foreground transition-colors hover:text-primary"
                                title="Sao chép địa chỉ WAN"
                                aria-label="Sao chép địa chỉ WAN"
                            >
                                <CopyIcon className="h-3 w-3" />
                            </button>
                            {publicAddresses.get('relay')?.kind === 'temporary' && <Badge size="sm" variant="warning">Địa chỉ tạm</Badge>}
                        </div>
                    ) : (
                        <span className="text-[10px] text-muted-foreground">chưa bật</span>
                    )}
                    {!relayRunning && tunnelActive && (
                        <span className="hidden text-[10px] italic text-muted-foreground sm:inline">cần bật LAN</span>
                    )}
                    {publicAddresses.canConfigure && (
                        <Button variant="link" size="sm" className="flex-shrink-0 text-[11px]" onClick={() => navigateSettings('cloud', 'address')}>
                            {tunnelActive && tunnelUrl ? 'Đổi ở Cài đặt →' : 'Bật ở Cài đặt →'}
                        </Button>
                    )}
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Connected count badge */}
                {connectedEmployees.length > 0 && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-100 dark:bg-green-600/15 border border-green-200 dark:border-green-500/25 rounded-lg flex-shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                        <span className="text-[11px] font-medium text-green-700 dark:text-green-400">{connectedEmployees.length} online</span>
                    </div>
                )}
                {!relayRunning && !tunnelActive && connectedEmployees.length === 0 && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-muted border border-border rounded-lg flex-shrink-0">
                        <span className="text-[11px] text-muted-foreground">Chưa kết nối</span>
                    </div>
                )}
            </div>
            <SegmentedControl
                label="Mục"
                value={activeTab}
                onChange={setActiveTab}
                options={[
                    { value: 'employees', label: 'Nhân viên', count: filteredEmployees.length },
                    { value: 'relay', label: 'Kết nối', count: connectedEmployees.length },
                ]}
            />

            {/* ══════════════════════════════════════════════════════ */}
            {/* TAB: NHÂN VIÊN                                        */}
            {/* ══════════════════════════════════════════════════════ */}
            {activeTab === 'employees' && (
                <div className="space-y-3">
                    {/* Search + Group toggle */}
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                            </svg>
                            <input
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="Tìm theo tên hoặc username..."
                                className="w-full pl-8 pr-3 py-2 bg-card border border-input rounded-xl text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                            />
                        </div>
                        <button
                            onClick={() => setShowGroupPanel(!showGroupPanel)}
                            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-xl border transition-colors ${
                                showGroupPanel
                                    ? 'bg-blue-600/15 border-blue-500/30 text-blue-300'
                                    : 'bg-card border-input text-muted-foreground hover:bg-muted hover:text-foreground'
                            }`}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                            </svg>
                            Nhóm
                            {stats.groupCount > 0 && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${showGroupPanel ? 'bg-blue-600' : 'bg-accent'}`}>{stats.groupCount}</span>
                            )}
                        </button>
                    </div>

                    {/* ─── Inline Group Management Panel ──────────── */}
                    {showGroupPanel && (
                        <div className="bg-card border border-input/60 rounded-xl overflow-hidden">
                            {/* Header */}
                            <div className="px-4 py-2.5 border-b border-border/50 flex items-center justify-between">
                                <h3 className="text-xs font-semibold text-foreground/80"><FolderIcon className="w-4 h-4 inline" /> Quản lý nhóm</h3>
                            </div>

                            {/* Body */}
                            <div className="p-4 space-y-3 max-h-64 overflow-y-auto">
                                {groups.length > 0 ? (
                                    <div className="space-y-1.5">
                                        {groups.map(grp => (
                                            <div key={grp.group_id} className="flex items-center gap-2.5 p-2.5 bg-card border border-border/60 rounded-xl hover:bg-muted transition-colors">
                                                {editingGroupId === grp.group_id ? (
                                                    <input
                                                        autoFocus
                                                        value={editingGroupName}
                                                        onChange={e => setEditingGroupName(e.target.value)}
                                                        onKeyDown={e => { if (e.key === 'Enter') handleUpdateGroup(grp.group_id); if (e.key === 'Escape') setEditingGroupId(null); }}
                                                        onBlur={() => handleUpdateGroup(grp.group_id)}
                                                        className="flex-1 text-sm bg-muted border border-blue-500 rounded-lg px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                    />
                                                ) : (
                                                    <>
                                                        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600/25 to-purple-600/25 flex items-center justify-center flex-shrink-0">
                                                            <span className="text-xs"><FolderIcon className="w-4 h-4" /></span>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm text-foreground font-medium truncate">{grp.name}</p>
                                                            <p className="text-[10px] text-muted-foreground">
                                                                {employees.filter((e: EmployeeData) => e.group_id === grp.group_id).length} nhân viên
                                                            </p>
                                                        </div>
                                                        <div className="flex items-center gap-0.5 flex-shrink-0">
                                                            <button
                                                                onClick={() => { setEditingGroupId(grp.group_id); setEditingGroupName(grp.name); }}
                                                                className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                                                title="Sửa tên"
                                                            >
                                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                                                                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                                                </svg>
                                                            </button>
                                                            <button
                                                                onClick={() => handleDeleteGroup(grp)}
                                                                className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                                                title="Xóa nhóm"
                                                            >
                                                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                                                                </svg>
                                                            </button>
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-center py-4">
                                        <p className="text-2xl mb-1"><FolderIcon className="w-4 h-4" /></p>
                                        <p className="text-sm text-muted-foreground">Chưa có nhóm nào</p>
                                        <p className="text-xs text-muted-foreground mt-0.5">Tạo nhóm để phân loại nhân viên</p>
                                    </div>
                                )}

                                {/* Add new group */}
                                <div className="pt-2 border-t border-border/40">
                                    <p className="text-[11px] text-muted-foreground font-medium mb-2"><PlusIcon className="w-4 h-4 inline" /> Thêm nhóm mới</p>
                                    <div className="flex items-center gap-2">
                                        <input
                                            value={newGroupName}
                                            onChange={e => setNewGroupName(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') handleCreateGroup(); }}
                                            placeholder="Tên nhóm (VD: Marketing, Nhân sự...)"
                                            className="flex-1 text-sm bg-muted border border-input rounded-lg px-3 py-2 text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                                        />
                                        <button
                                            onClick={handleCreateGroup}
                                            disabled={!newGroupName.trim()}
                                            className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                                        >
                                            + Tạo
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ─── Employee List ────────────────────────────── */}
                    <div className="bg-card rounded-xl p-3.5 space-y-2">
                        {loading ? (
                            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
                                <div className="w-4 h-4 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
                                Đang tải...
                            </div>
                        ) : filteredEmployees.length === 0 ? (
                            <div className="text-center py-8">
                                {searchQuery ? (
                                    <>
                                        <p className="text-2xl mb-1"><SearchIcon className="w-4 h-4" /></p>
                                        <p className="text-sm text-muted-foreground">Không tìm thấy nhân viên "{searchQuery}"</p>
                                        <button onClick={() => setSearchQuery('')} className="text-xs text-blue-400 hover:text-blue-300 mt-1">Xóa bộ lọc</button>
                                    </>
                                ) : (
                                    <>
                                        <p className="text-2xl mb-1"><UsersIcon className="w-4 h-4" /></p>
                                        <p className="text-sm text-muted-foreground">Chưa có nhân viên nào</p>
                                        <p className="text-xs text-muted-foreground mt-0.5">Nhấn "Thêm nhân viên" để bắt đầu</p>
                                    </>
                                )}
                            </div>
                        ) : (
                            groupedEmployees.map(({ group, employees: emps }) => (
                                <div key={group?.group_id || '_ungrouped'}>
                                    {/* Group header */}
                                    {groups.length > 0 && (
                                        <div className="flex items-center gap-2 mb-1.5 mt-2 first:mt-0">
                                            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                                                {group ? `Nhóm: ${group.name}` : 'Chưa phân nhóm'}
                                            </span>
                                            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full font-medium">{emps.length}</span>
                                            <div className="flex-1 border-t border-border/30" />
                                        </div>
                                    )}
                                    <div className="space-y-1.5">
                                        {emps.map(renderEmployeeRow)}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════ */}
            {/* TAB: KẾT NỐI RELAY                                    */}
            {/* ══════════════════════════════════════════════════════ */}
            {activeTab === 'relay' && (
                <RelayStatusPanel />
            )}

            {/* ─── Employee Form Modal ─────────────────────────────── */}
            {showForm && (
                <EmployeeFormModal
                    employee={editingEmployee}
                    accounts={accounts}
                    groups={groups}
                    onClose={() => { setShowForm(false); setEditingEmployee(null); }}
                    onSaved={() => { setShowForm(false); setEditingEmployee(null); loadEmployees(); }}
                />
            )}
        </div>
        </SettingsPage>
    );
}

// ─── Employee Form Modal ──────────────────────────────────────────────

function EmployeeFormModal({ employee, accounts, groups, onClose, onSaved }: {
    employee: EmployeeData | null;
    accounts: any[];
    groups: EmployeeGroup[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const isEdit = !!employee;
    const { showNotification } = useAppStore();

    const [username, setUsername] = useState(employee?.username || '');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState(employee?.display_name || '');
    const [role, setRole] = useState(employee?.role || 'employee');
    const [avatarUrl, setAvatarUrl] = useState(employee?.avatar_url || '');
    const [groupId, setGroupId] = useState<string>(employee?.group_id || '');
    const [saving, setSaving] = useState(false);

    // Permissions
    const [permissions, setPermissions] = useState<Record<string, boolean>>(() => {
        const result: Record<string, boolean> = {};
        ALL_MODULES.forEach(m => { result[m.key] = false; });
        if (employee?.permissions) {
            employee.permissions.forEach(p => { result[p.module] = p.can_access; });
        }
        return result;
    });

    // Account access
    const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(
        new Set(employee?.assigned_accounts || [])
    );

    const togglePermission = (key: string) => {
        setPermissions(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const toggleAccount = (zaloId: string) => {
        setSelectedAccounts(prev => {
            const next = new Set(prev);
            if (next.has(zaloId)) next.delete(zaloId);
            else next.add(zaloId);
            return next;
        });
    };

    const toggleAllAccounts = () => {
        if (selectedAccounts.size === accounts.length) setSelectedAccounts(new Set());
        else setSelectedAccounts(new Set(accounts.map(a => a.zalo_id)));
    };

    const toggleAllPermissions = () => {
        const allEnabled = ALL_MODULES.every(m => permissions[m.key]);
        const result: Record<string, boolean> = {};
        ALL_MODULES.forEach(m => { result[m.key] = !allEnabled; });
        setPermissions(result);
    };

    // ─── Avatar upload ───────────────────────────────────────────
    const handleAvatarUpload = async () => {
        try {
            const result = await ipc.file?.openDialog({
                title: 'Chọn ảnh đại diện',
                filters: [{ name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
                properties: ['openFile'],
            });
            if (!result || result.canceled || !result.filePaths?.length) return;
            const filePath = result.filePaths[0];
            // Convert to local-media:// URL so renderer can display local files
            setAvatarUrl(toLocalMediaUrl(filePath));
        } catch (err: any) {
            showNotification('Không thể chọn ảnh: ' + (err.message || ''), 'error');
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            if (isEdit) {
                // Update employee info
                const updates: any = { display_name: displayName, role, avatar_url: avatarUrl, group_id: groupId || null };
                if (password) updates.password = password;
                const res = await ipc.employee?.update(employee!.employee_id, updates);
                if (!res?.success) { showNotification(res?.error || 'Cập nhật thất bại', 'error'); setSaving(false); return; }

                // Update permissions
                const permArray = ALL_MODULES.map(m => ({ module: m.key, can_access: !!permissions[m.key] }));
                await ipc.employee?.setPermissions(employee!.employee_id, permArray);

                // Update account access
                await ipc.employee?.assignAccounts(employee!.employee_id, Array.from(selectedAccounts));

                showNotification('Đã cập nhật nhân viên', 'success');
            } else {
                // Create new
                const res = await ipc.employee?.create({ username, password, display_name: displayName, avatar_url: avatarUrl || undefined, role });
                if (!res?.success) { showNotification(res?.error || 'Tạo thất bại', 'error'); setSaving(false); return; }

                const empId = res.employee?.employee_id;
                if (empId) {
                    const permArray = ALL_MODULES.map(m => ({ module: m.key, can_access: !!permissions[m.key] }));
                    await ipc.employee?.setPermissions(empId, permArray);
                    await ipc.employee?.assignAccounts(empId, Array.from(selectedAccounts));
                    // Set group if selected
                    if (groupId) {
                        await ipc.employee?.update(empId, { group_id: groupId });
                    }
                }

                showNotification('Đã thêm nhân viên mới', 'success');
            }
            onSaved();
        } catch (err: any) {
            showNotification(err.message || 'Lỗi không xác định', 'error');
        }
        setSaving(false);
    };

    const mainModules = ALL_MODULES.filter(m => m.group === 'main');
    const settingsModules = ALL_MODULES.filter(m => m.group === 'settings');

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <div className="bg-card border border-input rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="px-5 pt-5 pb-3 border-b border-border flex-shrink-0">
                    <h3 className="text-base font-semibold text-foreground">
                        {isEdit ? `Sửa nhân viên: ${employee.display_name}` : 'Thêm nhân viên mới'}
                    </h3>
                </div>

                {/* Body - scrollable */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* Avatar + Basic info */}
                    <div className="space-y-3">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Thông tin cơ bản</p>

                        {/* Avatar upload */}
                        <div className="flex items-center gap-4">
                            <div className="relative group flex-shrink-0">
                                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center overflow-hidden border-2 border-input">
                                    {avatarUrl ? (
                                        <img src={avatarUrl} className="w-full h-full object-cover" alt="Avatar"
                                             onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                    ) : (
                                        <span className="text-2xl text-muted-foreground">{displayName?.charAt(0)?.toUpperCase() || <UserIcon className="w-6 h-6" />}</span>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={handleAvatarUpload}
                                    className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                    title="Đổi ảnh đại diện"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                                        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
                                        <circle cx="12" cy="13" r="4"/>
                                    </svg>
                                </button>
                            </div>
                            <div className="flex-1 space-y-1">
                                <p className="text-xs text-muted-foreground">Ảnh đại diện <span className="text-muted-foreground">(không bắt buộc)</span></p>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={handleAvatarUpload}
                                        className="text-[11px] text-blue-400 hover:text-blue-300 px-2 py-1 bg-blue-600/10 rounded-md border border-blue-500/20 hover:bg-blue-600/20 transition-colors"
                                    >
                                        <ImageIcon className="w-4 h-4 inline" /> Chọn ảnh
                                    </button>
                                    {avatarUrl && (
                                        <button
                                            type="button"
                                            onClick={() => setAvatarUrl('')}
                                            className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded-md hover:bg-red-600/10 transition-colors"
                                        >
                                            Xóa
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-xs text-muted-foreground mb-1 block">Tên đăng nhập</label>
                                <input
                                    value={username} onChange={e => setUsername(e.target.value)}
                                    disabled={isEdit}
                                    placeholder="nhanvien01"
                                    className="w-full px-3 py-2 bg-muted border border-input rounded-lg text-sm text-foreground placeholder-subtle-foreground disabled:opacity-50"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground mb-1 block">{isEdit ? 'Mật khẩu mới (bỏ trống = giữ nguyên)' : 'Mật khẩu'}</label>
                                <input
                                    type="password" value={password} onChange={e => setPassword(e.target.value)}
                                    placeholder={isEdit ? '••••' : 'Nhập mật khẩu'}
                                    className="w-full px-3 py-2 bg-muted border border-input rounded-lg text-sm text-foreground placeholder-subtle-foreground"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-xs text-muted-foreground mb-1 block">Tên hiển thị</label>
                                <input
                                    value={displayName} onChange={e => setDisplayName(e.target.value)}
                                    placeholder="Nguyễn Văn A"
                                    className="w-full px-3 py-2 bg-muted border border-input rounded-lg text-sm text-foreground placeholder-subtle-foreground"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-muted-foreground mb-1 block">Vai trò</label>
                                <select
                                    value={role} onChange={e => setRole(e.target.value)}
                                    className="w-full px-3 py-2 bg-muted border border-input rounded-lg text-sm text-foreground"
                                >
                                    <option value="employee">Nhân viên</option>
                                    <option value="boss">BOSS</option>
                                </select>
                            </div>
                        </div>
                        {/* Group selector */}
                        {groups.length > 0 && (
                            <div>
                                <label className="text-xs text-muted-foreground mb-1 block">Nhóm</label>
                                <select
                                    value={groupId} onChange={e => setGroupId(e.target.value)}
                                    className="w-full px-3 py-2 bg-muted border border-input rounded-lg text-sm text-foreground"
                                >
                                    <option value="">- Không có nhóm -</option>
                                    {groups.map(g => (
                                        <option key={g.group_id} value={g.group_id}>{g.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* Permissions - grouped */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Quyền truy cập module</p>
                            <button onClick={toggleAllPermissions} className="text-[11px] text-blue-400 hover:text-blue-300">
                                {ALL_MODULES.every(m => permissions[m.key]) ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                            </button>
                        </div>

                        {/* Main modules */}
                        <div className="grid grid-cols-2 gap-1.5">
                            {mainModules.map(m => (
                                <label
                                    key={m.key}
                                    className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                                        permissions[m.key] ? 'bg-selected border border-primary/30' : 'bg-card border border-border/60 hover:bg-muted'
                                    }`}
                                >
                                    <input
                                        type="checkbox" checked={permissions[m.key]}
                                        onChange={() => togglePermission(m.key)}
                                        className="sr-only"
                                    />
                                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                                        permissions[m.key] ? 'bg-blue-600 border-blue-500' : 'border-border-strong'
                                    }`}>
                                        {permissions[m.key] && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                                    </span>
                                    <span className="text-base">{m.icon}</span>
                                    <div className="min-w-0">
                                        <p className="text-xs text-foreground font-medium">{m.label}</p>
                                        <p className="text-[10px] text-muted-foreground truncate">{m.desc}</p>
                                    </div>
                                </label>
                            ))}
                        </div>

                        {/* Settings sub-permissions */}
                        <div className="mt-2 pt-2 border-t border-border/50">
                            <p className="text-[11px] font-medium text-muted-foreground mb-1.5"><SettingsIcon className="w-4 h-4 inline" /> Cài đặt - phân quyền chi tiết</p>
                            <div className="space-y-1">
                                {settingsModules.map(m => (
                                    <label
                                        key={m.key}
                                        className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                                            permissions[m.key] ? 'bg-selected border border-primary/30' : 'bg-card border border-border/60 hover:bg-muted'
                                        }`}
                                    >
                                        <input
                                            type="checkbox" checked={permissions[m.key]}
                                            onChange={() => togglePermission(m.key)}
                                            className="sr-only"
                                        />
                                        <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                                            permissions[m.key] ? 'bg-blue-600 border-blue-500' : 'border-border-strong'
                                        }`}>
                                            {permissions[m.key] && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                                        </span>
                                        <span className="text-base">{m.icon}</span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <p className="text-xs text-foreground font-medium">{m.label}</p>
                                                {'bossOnly' in m && m.bossOnly && (
                                                    <span className="text-[9px] px-1 py-0.5 rounded bg-amber-600/25 text-amber-400 font-medium leading-none">Boss</span>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-muted-foreground truncate">{m.desc}</p>
                                        </div>
                                    </label>
                                ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1.5 italic"><SunIcon className="w-4 h-4 inline" /> Giao diện, Thông báo, Lưu trữ, Giới thiệu, Log phiên bản - luôn truy cập được. Chỉ Quản lý TK Zalo và Nhân viên cần phân quyền riêng.
                            </p>
                        </div>
                    </div>

                    {/* Account access - with avatar + phone */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tài khoản Zalo được quản lý</p>
                            <button onClick={toggleAllAccounts} className="text-[11px] text-blue-400 hover:text-blue-300">
                                {selectedAccounts.size === accounts.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                            </button>
                        </div>
                        {accounts.length === 0 ? (
                            <p className="text-xs text-muted-foreground py-2">Chưa có tài khoản Zalo nào</p>
                        ) : (
                            <div className="space-y-1 max-h-48 overflow-y-auto">
                                {accounts.map(acc => (
                                    <label
                                        key={acc.zalo_id}
                                        className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                                            selectedAccounts.has(acc.zalo_id) ? 'bg-green-600/15 border border-green-500/30' : 'bg-card border border-border/60 hover:bg-muted'
                                        }`}
                                    >
                                        <input
                                            type="checkbox" checked={selectedAccounts.has(acc.zalo_id)}
                                            onChange={() => toggleAccount(acc.zalo_id)}
                                            className="sr-only"
                                        />
                                        <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                                            selectedAccounts.has(acc.zalo_id) ? 'bg-green-600 border-green-500' : 'border-border-strong'
                                        }`}>
                                            {selectedAccounts.has(acc.zalo_id) && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                                        </span>
                                        {/* Account avatar */}
                                        <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-accent">
                                            {acc.avatar_url ? (
                                                <img src={acc.avatar_url} className="w-full h-full object-cover" alt=""
                                                     onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-bold">
                                                    {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                                                </div>
                                            )}
                                        </div>
                                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-400' : 'bg-accent'}`} />
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs text-foreground font-medium truncate">{acc.full_name || acc.zalo_id}</p>
                                            <div className="flex items-center gap-2">
                                                {acc.phone && (
                                                    <p className="text-[10px] text-muted-foreground">📞 {acc.phone}</p>
                                                )}
                                                <p className="text-[10px] text-muted-foreground">{acc.zalo_id}</p>
                                            </div>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 flex-shrink-0">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors">
                        Hủy
                    </button>
                    <button
                        onClick={handleSave} disabled={saving}
                        className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
                    >
                        {saving ? 'Đang lưu...' : isEdit ? 'Cập nhật' : 'Tạo nhân viên'}
                    </button>
                </div>
            </div>
        </div>
    );
}
