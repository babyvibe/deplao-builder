import React from 'react';
import { useEmployeeStore } from '@/store/employeeStore';
import { useAppStore } from '@/store/appStore';

/**
 * Small banner at the top when in Employee mode.
 * Shows connection status and employee name.
 * In simulation mode (boss previewing as employee), shows an immersive simulation bar.
 */
export default function EmployeeConnectionBanner() {
    const { previewEmployeeId } = useEmployeeStore();

    // Boss/standalone simulation mode — immersive employee simulation bar
    if (previewEmployeeId) {
        const store = useEmployeeStore.getState();
        const previewEmp = store.employees.find((e: any) => e.employee_id === previewEmployeeId);
        const assignedCount = previewEmp?.assigned_accounts?.length || 0;
        const permCount = previewEmp?.permissions?.filter((p: any) => p.can_access)?.length || 0;
        const permModules = previewEmp?.permissions?.filter((p: any) => p.can_access)?.map((p: any) => p.module) || [];

        return (
            <div className="flex items-center gap-3 px-4 py-1.5 text-xs bg-gradient-to-r from-amber-900/40 via-orange-900/30 to-amber-900/40 border-b border-amber-700/50 text-amber-200 flex-shrink-0">
                {/* Pulsing indicator */}
                <span className="relative flex-shrink-0">
                    <span className="w-2 h-2 rounded-full bg-amber-400 inline-block animate-pulse" />
                </span>

                {/* Employee avatar + name */}
                <div className="flex items-center gap-2 flex-shrink-0">
                    {previewEmp?.avatar_url ? (
                        <img src={previewEmp.avatar_url} className="w-5 h-5 rounded-full object-cover" alt="" />
                    ) : (
                        <div className="w-5 h-5 rounded-full bg-amber-700 flex items-center justify-center text-[10px] text-amber-200 font-bold">
                            {previewEmp?.display_name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                    )}
                    <span className="font-semibold text-amber-100">
                        🔄 Đang giả lập: {previewEmp?.display_name || 'Nhân viên'}
                    </span>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-3 text-[11px] text-amber-300/70">
                    <span>📱 {assignedCount} TK Zalo</span>
                    <span title={permModules.join(', ')}>🔑 {permCount} modules</span>
                    <span>@{previewEmp?.username}</span>
                </div>

                <div className="flex-1" />

                {/* Quick nav to dashboard (as employee would see) */}
                <button
                    onClick={() => useAppStore.getState().setView('dashboard')}
                    className="flex items-center gap-1 text-[11px] font-medium text-amber-300/80 hover:text-amber-100 px-2 py-0.5 rounded-md hover:bg-amber-800/30 transition-colors"
                    title="Xem Dashboard với góc nhìn nhân viên"
                >
                    📊 Dashboard NV
                </button>

                {/* Exit button */}
                <button
                    onClick={() => useEmployeeStore.getState().setPreviewEmployeeId(null)}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300 hover:text-white px-2.5 py-1 bg-amber-800/30 rounded-lg hover:bg-amber-700/50 transition-colors border border-amber-700/40"
                >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                    Thoát giả lập
                </button>
            </div>
        );
    }

    return null;
}

