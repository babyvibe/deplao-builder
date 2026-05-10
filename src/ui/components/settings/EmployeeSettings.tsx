import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { showConfirm } from '../common/ConfirmDialog';
import RelayStatusPanel from './RelayStatusPanel';
import { toLocalMediaUrl } from '@/lib/localMedia';

const ALL_MODULES = [
    { key: 'chat', label: 'Chat', icon: '💬', desc: 'Gửi/nhận tin nhắn', group: 'main' },
    { key: 'friends', label: 'Bạn bè', icon: '👥', desc: 'Danh sách bạn bè', group: 'main' },
    { key: 'crm', label: 'CRM', icon: '📊', desc: 'Quản lý khách hàng', group: 'main' },
    { key: 'workflow', label: 'Workflow', icon: '⚡', desc: 'Tự động hóa', group: 'main' },
    { key: 'integration', label: 'Tích hợp', icon: '🔗', desc: 'Kết nối POS/Shipping', group: 'main' },
    { key: 'analytics', label: 'Thống kê', icon: '📈', desc: 'Báo cáo phân tích', group: 'main' },
    { key: 'ai_assistant', label: 'AI', icon: '🤖', desc: 'Trợ lý AI', group: 'main' },
    { key: 'facebook', label: 'Facebook', icon: '📘', desc: 'Facebook Messenger nhóm', group: 'main' },
    { key: 'settings_accounts', label: 'Quản lý TK Zalo', icon: '👤', desc: 'Xem/xóa tài khoản (boss)', group: 'settings', bossOnly: true },
    { key: 'settings_employees', label: 'Quản lý nhân viên', icon: '👥', desc: 'Thêm/sửa/xóa NV (boss)', group: 'settings', bossOnly: true },
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

export default function EmployeeSettings() {
    const { showNotification } = useAppStore();
    const { accounts } = useAccountStore();
    const { employees, setEmployees, previewEmployeeId, setPreviewEmployeeId } = useEmployeeStore();
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingEmployee, setEditingEmployee] = useState<EmployeeData | null>(null);
    const [groups, setGroups] = useState<EmployeeGroup[]>([]);
    const [newGroupName, setNewGroupName] = useState('');
    const [showGroupForm, setShowGroupForm] = useState(false);
    const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
    const [editingGroupName, setEditingGroupName] = useState('');

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

    // ─── Group management ───────────────────────────────────────────
    const handleCreateGroup = async () => {
        if (!newGroupName.trim()) return;
        const res = await ipc.employee?.createGroup(newGroupName.trim());
        if (res?.success) {
            showNotification('Đã tạo nhóm', 'success');
            setNewGroupName('');
            setShowGroupForm(false);
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

    // ─── Group-based rendering ──────────────────────────────────────
    const groupedEmployees = groups.length > 0 ? (() => {
        const result: Array<{ group: EmployeeGroup | null; employees: EmployeeData[] }> = [];
        for (const grp of groups) {
            const emps = employees.filter((e: EmployeeData) => e.group_id === grp.group_id);
            if (emps.length > 0) result.push({ group: grp, employees: emps });
        }
        const ungrouped = employees.filter((e: EmployeeData) => !e.group_id || !groups.some(g => g.group_id === e.group_id));
        if (ungrouped.length > 0) result.push({ group: null, employees: ungrouped });
        return result;
    })() : [{ group: null, employees: employees as EmployeeData[] }];

    const renderEmployeeRow = (emp: EmployeeData) => (
        <div key={emp.employee_id} className="flex items-center gap-3 p-3 bg-gray-700/60 rounded-xl hover:bg-gray-700 transition-colors">
            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center text-lg flex-shrink-0">
                {emp.avatar_url ? (
                    <img src={toLocalMediaUrl(emp.avatar_url)} className="w-full h-full rounded-full object-cover" alt="" />
                ) : (
                    <span>{emp.display_name?.charAt(0)?.toUpperCase() || '?'}</span>
                )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <p className="text-sm text-gray-200 font-medium truncate">{emp.display_name}</p>
                    {emp.role === 'boss' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-600/30 text-amber-300 font-medium">Boss</span>
                    )}
                    {!emp.is_active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-600/30 text-red-300 font-medium">Tắt</span>
                    )}
                </div>
                <p className="text-xs text-gray-500">@{emp.username}</p>
                <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-[11px] text-gray-500">
                        🔑 {emp.permissions?.filter((p: any) => p.can_access).length || 0} modules
                    </span>
                    <span className="text-[11px] text-gray-500">
                        📱 {emp.assigned_accounts?.length || 0} TK Zalo
                    </span>
                    {emp.last_login && (
                        <span className="text-[11px] text-gray-500">
                            🕐 {new Date(emp.last_login).toLocaleDateString('vi-VN')}
                        </span>
                    )}
                </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
                <button
                    onClick={() => {
                        if (previewEmployeeId === emp.employee_id) {
                            setPreviewEmployeeId(null);
                        } else {
                            setPreviewEmployeeId(emp.employee_id);
                            useAppStore.getState().setView('dashboard');
                        }
                    }}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                        previewEmployeeId === emp.employee_id
                            ? 'text-amber-200 bg-amber-600/30 border border-amber-500/40'
                            : 'text-amber-400 hover:text-amber-300 hover:bg-amber-600/15 border border-transparent'
                    }`}
                    title={previewEmployeeId === emp.employee_id ? 'Thoát giả lập' : 'Đăng nhập với tư cách nhân viên này'}
                >
                    {previewEmployeeId === emp.employee_id ? (
                        <>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                            Thoát
                        </>
                    ) : (
                        <>🔄 Giả lập</>
                    )}
                </button>
                <button
                    onClick={() => handleToggleActive(emp)}
                    className={`px-2 py-1 rounded-lg transition-colors ${emp.is_active ? 'text-yellow-400 hover:bg-yellow-600/20' : 'text-green-400 hover:bg-green-600/20'}`}
                    title={emp.is_active ? 'Vô hiệu hóa tài khoản' : 'Kích hoạt'}
                >
                    {emp.is_active ? '⏸' : '▶️'}
                </button>
                <button
                    onClick={() => { setEditingEmployee(emp); setShowForm(true); }}
                    className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded-lg hover:bg-blue-600/20 transition-colors"
                >
                    ✏️
                </button>
                <button
                    onClick={() => handleDelete(emp)}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded-lg hover:bg-red-600/20 transition-colors"
                >
                    🗑️
                </button>
            </div>
        </div>
    );

    return (
        <div className="space-y-5">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-white">👥 Quản lý nhân viên</h2>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowGroupForm(!showGroupForm)}
                        className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 border border-gray-600 transition-colors"
                    >
                        📁 Nhóm
                    </button>
                    <button
                        onClick={() => { setEditingEmployee(null); setShowForm(true); }}
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                    >
                        ➕ Thêm nhân viên
                    </button>
                </div>
            </div>

            {/* Info box */}
            <div className="bg-blue-900/20 border border-blue-500/30 rounded-xl p-4 text-xs text-blue-200 space-y-1.5">
                <p className="font-semibold text-blue-300">ℹ️ Tính năng quản lý nhân viên</p>
                <p>Cho phép tạo tài khoản nhân viên để chia sẻ quyền quản lý tin nhắn Zalo. Nhân viên đăng nhập trên máy riêng và nhận tin nhắn qua kết nối mạng từ máy Boss.</p>
                <p className="text-blue-500">⚡ Bước tiếp theo: Sau khi tạo nhân viên, bật Relay Server ở mục bên dưới để nhân viên kết nối.</p>
            </div>

            {/* Group management panel — popup modal */}
            {showGroupForm && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setShowGroupForm(false)}>
                    <div className="bg-gray-800 border border-gray-600 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div className="px-5 pt-5 pb-3 border-b border-gray-700 flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-white">📁 Quản lý nhóm nhân viên</h3>
                            <button onClick={() => setShowGroupForm(false)} className="text-gray-400 hover:text-white transition-colors w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-700">✕</button>
                        </div>

                        {/* Body */}
                        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
                            {/* Existing groups */}
                            {groups.length > 0 ? (
                                <div className="space-y-2">
                                    {groups.map(grp => (
                                        <div key={grp.group_id} className="flex items-center gap-2.5 p-3 bg-gray-700/60 rounded-xl hover:bg-gray-700 transition-colors">
                                            {editingGroupId === grp.group_id ? (
                                                <input
                                                    autoFocus
                                                    value={editingGroupName}
                                                    onChange={e => setEditingGroupName(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') handleUpdateGroup(grp.group_id); if (e.key === 'Escape') setEditingGroupId(null); }}
                                                    onBlur={() => handleUpdateGroup(grp.group_id)}
                                                    className="flex-1 text-sm bg-gray-600 border border-blue-500 rounded-lg px-3 py-1.5 text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                                />
                                            ) : (
                                                <>
                                                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600/30 to-purple-600/30 flex items-center justify-center flex-shrink-0">
                                                        <span className="text-sm">📁</span>
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm text-gray-200 font-medium truncate">{grp.name}</p>
                                                        <p className="text-[10px] text-gray-500">
                                                            {employees.filter((e: EmployeeData) => e.group_id === grp.group_id).length} nhân viên
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-1 flex-shrink-0">
                                                        <button
                                                            onClick={() => { setEditingGroupId(grp.group_id); setEditingGroupName(grp.name); }}
                                                            className="p-1.5 rounded-lg text-blue-400 hover:text-blue-300 hover:bg-blue-600/20 transition-colors"
                                                            title="Sửa tên"
                                                        >✏️</button>
                                                        <button
                                                            onClick={() => handleDeleteGroup(grp)}
                                                            className="p-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-600/20 transition-colors"
                                                            title="Xóa nhóm"
                                                        >🗑️</button>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-center py-6">
                                    <p className="text-3xl mb-2">📁</p>
                                    <p className="text-sm text-gray-400">Chưa có nhóm nào</p>
                                    <p className="text-xs text-gray-500 mt-1">Tạo nhóm để phân loại nhân viên</p>
                                </div>
                            )}

                            {/* Add new group */}
                            <div className="pt-2 border-t border-gray-700/50">
                                <p className="text-[11px] text-gray-400 font-medium mb-2">➕ Thêm nhóm mới</p>
                                <div className="flex items-center gap-2">
                                    <input
                                        value={newGroupName}
                                        onChange={e => setNewGroupName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') handleCreateGroup(); }}
                                        placeholder="Tên nhóm (VD: Marketing, Nhân sự...)"
                                        className="flex-1 text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
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

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-gray-700 flex justify-end">
                            <button onClick={() => setShowGroupForm(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg transition-colors">
                                Đóng
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Active simulation banner */}
            {previewEmployeeId && (() => {
                const simEmp = employees.find((e: any) => e.employee_id === previewEmployeeId);
                if (!simEmp) return null;
                const permCount = simEmp.permissions?.filter((p: any) => p.can_access)?.length || 0;
                const accCount = simEmp.assigned_accounts?.length || 0;
                return (
                    <div className="bg-gradient-to-r from-amber-900/30 via-orange-900/20 to-amber-900/30 border border-amber-600/40 rounded-xl p-4 space-y-2">
                        <div className="flex items-center gap-3">
                            <div className="relative flex-shrink-0">
                                {simEmp.avatar_url ? (
                                    <img src={toLocalMediaUrl(simEmp.avatar_url)} className="w-10 h-10 rounded-full object-cover ring-2 ring-amber-500/50" alt="" />
                                ) : (
                                    <div className="w-10 h-10 rounded-full bg-amber-700 ring-2 ring-amber-500/50 flex items-center justify-center text-lg text-amber-200 font-bold">
                                        {simEmp.display_name?.charAt(0)?.toUpperCase() || '?'}
                                    </div>
                                )}
                                <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-amber-400 rounded-full border-2 border-gray-800 animate-pulse" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-amber-100">🔄 Đang giả lập: {simEmp.display_name}</p>
                                <p className="text-[11px] text-amber-300/70">
                                    Bạn đang xem app như nhân viên "{simEmp.display_name}" — chỉ thấy {accCount} TK Zalo, {permCount} modules được phân quyền.
                                </p>
                            </div>
                            <button
                                onClick={() => setPreviewEmployeeId(null)}
                                className="flex items-center gap-1.5 text-xs font-medium text-amber-200 hover:text-white px-3 py-1.5 bg-amber-700/40 rounded-lg hover:bg-amber-600/50 transition-colors border border-amber-600/40 flex-shrink-0"
                            >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                                Thoát giả lập
                            </button>
                        </div>
                    </div>
                );
            })()}

            {/* Employee list — grouped if groups exist */}
            <div className="bg-gray-800 rounded-xl p-4 space-y-3">
                {loading ? (
                    <p className="text-gray-500 text-sm py-4 text-center">Đang tải...</p>
                ) : employees.length === 0 ? (
                    <p className="text-gray-500 text-sm py-4 text-center">Chưa có nhân viên nào. Nhấn "Thêm nhân viên" để bắt đầu.</p>
                ) : (
                    groupedEmployees.map(({ group, employees: emps }) => (
                        <div key={group?.group_id || '_ungrouped'}>
                            {/* Group header — only show if there are groups */}
                            {groups.length > 0 && (
                                <div className="flex items-center gap-2 mb-1.5 mt-1">
                                    <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                                        {group ? `📁 ${group.name}` : '📋 Chưa phân nhóm'}
                                    </span>
                                    <span className="text-[10px] text-gray-600 bg-gray-700/50 px-1.5 py-0.5 rounded-full">{emps.length}</span>
                                    <div className="flex-1 border-t border-gray-700/50" />
                                </div>
                            )}
                            <div className="space-y-2">
                                {emps.map(renderEmployeeRow)}
                            </div>
                        </div>
                    ))
                )}
            </div>


            {/* Relay Server Panel */}
            <RelayStatusPanel />

            {/* Employee form modal */}
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
            <div className="bg-gray-800 border border-gray-600 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="px-5 pt-5 pb-3 border-b border-gray-700 flex-shrink-0">
                    <h3 className="text-base font-semibold text-white">
                        {isEdit ? `✏️ Sửa nhân viên: ${employee.display_name}` : '➕ Thêm nhân viên mới'}
                    </h3>
                </div>

                {/* Body — scrollable */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* Avatar + Basic info */}
                    <div className="space-y-3">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Thông tin cơ bản</p>

                        {/* Avatar upload */}
                        <div className="flex items-center gap-4">
                            <div className="relative group flex-shrink-0">
                                <div className="w-16 h-16 rounded-full bg-gray-700 flex items-center justify-center overflow-hidden border-2 border-gray-600">
                                    {avatarUrl ? (
                                        <img src={avatarUrl} className="w-full h-full object-cover" alt="Avatar"
                                             onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                    ) : (
                                        <span className="text-2xl text-gray-400">{displayName?.charAt(0)?.toUpperCase() || '👤'}</span>
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
                                <p className="text-xs text-gray-400">Ảnh đại diện <span className="text-gray-600">(không bắt buộc)</span></p>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={handleAvatarUpload}
                                        className="text-[11px] text-blue-400 hover:text-blue-300 px-2 py-1 bg-blue-600/10 rounded-md border border-blue-500/20 hover:bg-blue-600/20 transition-colors"
                                    >
                                        📷 Chọn ảnh
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
                                <label className="text-xs text-gray-400 mb-1 block">Tên đăng nhập</label>
                                <input
                                    value={username} onChange={e => setUsername(e.target.value)}
                                    disabled={isEdit}
                                    placeholder="nhanvien01"
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500 disabled:opacity-50"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-gray-400 mb-1 block">{isEdit ? 'Mật khẩu mới (bỏ trống = giữ nguyên)' : 'Mật khẩu'}</label>
                                <input
                                    type="password" value={password} onChange={e => setPassword(e.target.value)}
                                    placeholder={isEdit ? '••••' : 'Nhập mật khẩu'}
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-xs text-gray-400 mb-1 block">Tên hiển thị</label>
                                <input
                                    value={displayName} onChange={e => setDisplayName(e.target.value)}
                                    placeholder="Nguyễn Văn A"
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-gray-400 mb-1 block">Vai trò</label>
                                <select
                                    value={role} onChange={e => setRole(e.target.value)}
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200"
                                >
                                    <option value="employee">Nhân viên</option>
                                    <option value="boss">BOSS</option>
                                </select>
                            </div>
                        </div>
                        {/* Group selector */}
                        {groups.length > 0 && (
                            <div>
                                <label className="text-xs text-gray-400 mb-1 block">Nhóm</label>
                                <select
                                    value={groupId} onChange={e => setGroupId(e.target.value)}
                                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200"
                                >
                                    <option value="">— Không có nhóm —</option>
                                    {groups.map(g => (
                                        <option key={g.group_id} value={g.group_id}>{g.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* Permissions — grouped */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Quyền truy cập module</p>
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
                                        permissions[m.key] ? 'bg-blue-600/15 border border-blue-500/30' : 'bg-gray-700/50 border border-transparent hover:bg-gray-700'
                                    }`}
                                >
                                    <input
                                        type="checkbox" checked={permissions[m.key]}
                                        onChange={() => togglePermission(m.key)}
                                        className="sr-only"
                                    />
                                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                                        permissions[m.key] ? 'bg-blue-600 border-blue-500' : 'border-gray-500'
                                    }`}>
                                        {permissions[m.key] && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                                    </span>
                                    <span className="text-base">{m.icon}</span>
                                    <div className="min-w-0">
                                        <p className="text-xs text-gray-200 font-medium">{m.label}</p>
                                        <p className="text-[10px] text-gray-500 truncate">{m.desc}</p>
                                    </div>
                                </label>
                            ))}
                        </div>

                        {/* Settings sub-permissions */}
                        <div className="mt-2 pt-2 border-t border-gray-700/50">
                            <p className="text-[11px] font-medium text-gray-500 mb-1.5">⚙️ Cài đặt — phân quyền chi tiết</p>
                            <div className="space-y-1">
                                {settingsModules.map(m => (
                                    <label
                                        key={m.key}
                                        className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                                            permissions[m.key] ? 'bg-blue-600/15 border border-blue-500/30' : 'bg-gray-700/50 border border-transparent hover:bg-gray-700'
                                        }`}
                                    >
                                        <input
                                            type="checkbox" checked={permissions[m.key]}
                                            onChange={() => togglePermission(m.key)}
                                            className="sr-only"
                                        />
                                        <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                                            permissions[m.key] ? 'bg-blue-600 border-blue-500' : 'border-gray-500'
                                        }`}>
                                            {permissions[m.key] && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                                        </span>
                                        <span className="text-base">{m.icon}</span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <p className="text-xs text-gray-200 font-medium">{m.label}</p>
                                                {'bossOnly' in m && m.bossOnly && (
                                                    <span className="text-[9px] px-1 py-0.5 rounded bg-amber-600/25 text-amber-400 font-medium leading-none">Boss</span>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-gray-500 truncate">{m.desc}</p>
                                        </div>
                                    </label>
                                ))}
                            </div>
                            <p className="text-[10px] text-gray-600 mt-1.5 italic">
                                💡 Giao diện, Thông báo, Lưu trữ, Giới thiệu, Log phiên bản — luôn truy cập được. Chỉ Quản lý TK Zalo và Nhân viên cần phân quyền riêng.
                            </p>
                        </div>
                    </div>

                    {/* Account access — with avatar + phone */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Tài khoản Zalo được quản lý</p>
                            <button onClick={toggleAllAccounts} className="text-[11px] text-blue-400 hover:text-blue-300">
                                {selectedAccounts.size === accounts.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                            </button>
                        </div>
                        {accounts.length === 0 ? (
                            <p className="text-xs text-gray-500 py-2">Chưa có tài khoản Zalo nào</p>
                        ) : (
                            <div className="space-y-1 max-h-48 overflow-y-auto">
                                {accounts.map(acc => (
                                    <label
                                        key={acc.zalo_id}
                                        className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                                            selectedAccounts.has(acc.zalo_id) ? 'bg-green-600/15 border border-green-500/30' : 'bg-gray-700/50 border border-transparent hover:bg-gray-700'
                                        }`}
                                    >
                                        <input
                                            type="checkbox" checked={selectedAccounts.has(acc.zalo_id)}
                                            onChange={() => toggleAccount(acc.zalo_id)}
                                            className="sr-only"
                                        />
                                        <span className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                                            selectedAccounts.has(acc.zalo_id) ? 'bg-green-600 border-green-500' : 'border-gray-500'
                                        }`}>
                                            {selectedAccounts.has(acc.zalo_id) && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}
                                        </span>
                                        {/* Account avatar */}
                                        <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-gray-600">
                                            {acc.avatar_url ? (
                                                <img src={acc.avatar_url} className="w-full h-full object-cover" alt=""
                                                     onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-xs text-gray-400 font-bold">
                                                    {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                                                </div>
                                            )}
                                        </div>
                                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-400' : 'bg-gray-500'}`} />
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs text-gray-200 font-medium truncate">{acc.full_name || acc.zalo_id}</p>
                                            <div className="flex items-center gap-2">
                                                {acc.phone && (
                                                    <p className="text-[10px] text-gray-500">📞 {acc.phone}</p>
                                                )}
                                                <p className="text-[10px] text-gray-600">{acc.zalo_id}</p>
                                            </div>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-gray-700 flex items-center justify-end gap-2 flex-shrink-0">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded-lg transition-colors">
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

