import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employeeStore';

interface EmployeeKPIStats {
    employee_id: string;
    display_name: string;
    avatar_url: string;
    messages_sent: number;
    conversations_handled: number;
    avg_response_time_ms: number;
    total_online_hours: number;
    loading: boolean;
}

type DateRange = 'today' | '7d' | '30d' | 'custom';

function getDateRange(range: DateRange, customFrom?: number, customTo?: number): { sinceTs: number; untilTs: number } {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    switch (range) {
        case 'today':
            return { sinceTs: todayStart.getTime(), untilTs: now };
        case '7d':
            return { sinceTs: now - 7 * 24 * 60 * 60 * 1000, untilTs: now };
        case '30d':
            return { sinceTs: now - 30 * 24 * 60 * 60 * 1000, untilTs: now };
        case 'custom':
            return { sinceTs: customFrom || 0, untilTs: customTo || now };
        default:
            return { sinceTs: todayStart.getTime(), untilTs: now };
    }
}

function formatResponseTime(ms: number): string {
    if (!ms || ms <= 0) return '—';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 3600_000).toFixed(1)}h`;
}

export default function EmployeeKPIPanel() {
    const { employees } = useEmployeeStore();
    const [dateRange, setDateRange] = useState<DateRange>('today');
    const [stats, setStats] = useState<EmployeeKPIStats[]>([]);
    const [loading, setLoading] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [sessions, setSessions] = useState<any[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);

    const loadStats = useCallback(async () => {
        if (employees.length === 0) return;
        setLoading(true);
        const { sinceTs, untilTs } = getDateRange(dateRange);

        const results: EmployeeKPIStats[] = [];
        for (const emp of employees) {
            try {
                const res = await ipc.employee?.getStats(emp.employee_id, sinceTs, untilTs);
                results.push({
                    employee_id: emp.employee_id,
                    display_name: emp.display_name,
                    avatar_url: emp.avatar_url || '',
                    messages_sent: res?.stats?.messages_sent || 0,
                    conversations_handled: res?.stats?.conversations_handled || 0,
                    avg_response_time_ms: res?.stats?.avg_response_time_ms || 0,
                    total_online_hours: res?.stats?.total_online_hours || 0,
                    loading: false,
                });
            } catch {
                results.push({
                    employee_id: emp.employee_id,
                    display_name: emp.display_name,
                    avatar_url: emp.avatar_url || '',
                    messages_sent: 0,
                    conversations_handled: 0,
                    avg_response_time_ms: 0,
                    total_online_hours: 0,
                    loading: false,
                });
            }
        }
        setStats(results);
        setLoading(false);
    }, [employees, dateRange]);

    useEffect(() => { loadStats(); }, [loadStats]);

    const handleExpandSessions = async (employeeId: string) => {
        if (expandedId === employeeId) {
            setExpandedId(null);
            setSessions([]);
            return;
        }
        setExpandedId(employeeId);
        setSessionsLoading(true);
        try {
            const res = await ipc.employee?.getSessions(employeeId, 20);
            setSessions(res?.sessions || []);
        } catch {
            setSessions([]);
        }
        setSessionsLoading(false);
    };

    // Calculate totals
    const totals = stats.reduce(
        (acc, s) => ({
            messages_sent: acc.messages_sent + s.messages_sent,
            conversations_handled: acc.conversations_handled + s.conversations_handled,
            total_online_hours: acc.total_online_hours + s.total_online_hours,
        }),
        { messages_sent: 0, conversations_handled: 0, total_online_hours: 0 }
    );

    const handleExportCSV = () => {
        const headers = ['Nhân viên', 'Tin gửi', 'TB phản hồi', 'Hội thoại', 'Online (giờ)'];
        const rows = stats.map(s => [
            s.display_name,
            s.messages_sent,
            formatResponseTime(s.avg_response_time_ms),
            s.conversations_handled,
            s.total_online_hours,
        ]);
        rows.push(['TỔNG', totals.messages_sent, '—', totals.conversations_handled, totals.total_online_hours]);

        const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `KPI_NhanVien_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    if (employees.length === 0) return null;

    return (
        <div className="bg-gray-800 rounded-xl p-4 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    📊 Thống kê nhân viên
                </h3>
                <div className="flex items-center gap-2">
                    {/* Date range selector */}
                    <div className="flex items-center bg-gray-700 rounded-lg overflow-hidden">
                        {([
                            { key: 'today', label: 'Hôm nay' },
                            { key: '7d', label: '7 ngày' },
                            { key: '30d', label: '30 ngày' },
                        ] as const).map(({ key, label }) => (
                            <button
                                key={key}
                                onClick={() => setDateRange(key)}
                                className={`text-[11px] px-2.5 py-1 transition-colors ${
                                    dateRange === key
                                        ? 'bg-blue-600 text-white font-medium'
                                        : 'text-gray-400 hover:text-gray-200'
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {/* Export */}
                    <button
                        onClick={handleExportCSV}
                        className="text-[11px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded-lg hover:bg-gray-700 transition-colors"
                        title="Xuất CSV"
                    >
                        📥 Export
                    </button>
                    {/* Refresh */}
                    <button
                        onClick={loadStats}
                        disabled={loading}
                        className="text-[11px] text-gray-400 hover:text-gray-200 px-1.5 py-1 rounded-lg hover:bg-gray-700 transition-colors"
                        title="Làm mới"
                    >
                        {loading ? '⏳' : '🔄'}
                    </button>
                </div>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-700/50 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-blue-400">{totals.messages_sent}</p>
                    <p className="text-[10px] text-gray-500">Tổng tin gửi</p>
                </div>
                <div className="bg-gray-700/50 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-green-400">{totals.conversations_handled}</p>
                    <p className="text-[10px] text-gray-500">Hội thoại xử lý</p>
                </div>
                <div className="bg-gray-700/50 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold text-amber-400">{totals.total_online_hours}h</p>
                    <p className="text-[10px] text-gray-500">Tổng giờ online</p>
                </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-gray-500 border-b border-gray-700">
                            <th className="text-left py-2 px-2 font-medium">Nhân viên</th>
                            <th className="text-right py-2 px-2 font-medium">Tin gửi</th>
                            <th className="text-right py-2 px-2 font-medium">TB phản hồi</th>
                            <th className="text-right py-2 px-2 font-medium">Hội thoại</th>
                            <th className="text-right py-2 px-2 font-medium">Online</th>
                            <th className="text-right py-2 px-2 font-medium"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {loading ? (
                            <tr>
                                <td colSpan={6} className="text-center py-6 text-gray-500">Đang tải...</td>
                            </tr>
                        ) : stats.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="text-center py-6 text-gray-500">Không có dữ liệu</td>
                            </tr>
                        ) : (
                            <>
                                {stats.map((s) => (
                                    <React.Fragment key={s.employee_id}>
                                        <tr className="border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors">
                                            <td className="py-2 px-2">
                                                <div className="flex items-center gap-2">
                                                    <div className="w-6 h-6 rounded-full bg-gray-600 flex items-center justify-center text-[10px] flex-shrink-0 overflow-hidden">
                                                        {s.avatar_url ? (
                                                            <img src={s.avatar_url} className="w-full h-full object-cover" alt="" />
                                                        ) : (
                                                            s.display_name?.charAt(0)?.toUpperCase() || '?'
                                                        )}
                                                    </div>
                                                    <span className="text-gray-200 font-medium truncate">{s.display_name}</span>
                                                </div>
                                            </td>
                                            <td className="text-right py-2 px-2 text-gray-300 font-mono">{s.messages_sent}</td>
                                            <td className="text-right py-2 px-2 text-gray-300">
                                                <span className={`${s.avg_response_time_ms > 300_000 ? 'text-red-400' : s.avg_response_time_ms > 120_000 ? 'text-amber-400' : 'text-green-400'}`}>
                                                    {formatResponseTime(s.avg_response_time_ms)}
                                                </span>
                                            </td>
                                            <td className="text-right py-2 px-2 text-gray-300 font-mono">{s.conversations_handled}</td>
                                            <td className="text-right py-2 px-2 text-gray-300">{s.total_online_hours}h</td>
                                            <td className="text-right py-2 px-2">
                                                <button
                                                    onClick={() => handleExpandSessions(s.employee_id)}
                                                    className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                                                    title="Xem phiên đăng nhập"
                                                >
                                                    {expandedId === s.employee_id ? '▲' : '▼'}
                                                </button>
                                            </td>
                                        </tr>

                                        {/* Expanded sessions row */}
                                        {expandedId === s.employee_id && (
                                            <tr>
                                                <td colSpan={6} className="px-2 pb-2">
                                                    <div className="bg-gray-700/40 rounded-lg p-2 mt-1">
                                                        <p className="text-[10px] text-gray-400 font-semibold mb-1.5">📋 Lịch sử phiên đăng nhập gần nhất</p>
                                                        {sessionsLoading ? (
                                                            <p className="text-[10px] text-gray-500">Đang tải...</p>
                                                        ) : sessions.length === 0 ? (
                                                            <p className="text-[10px] text-gray-500">Chưa có phiên nào</p>
                                                        ) : (
                                                            <div className="space-y-1 max-h-40 overflow-y-auto">
                                                                {sessions.map((sess: any, i: number) => (
                                                                    <div key={i} className="flex items-center gap-3 text-[10px]">
                                                                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sess.disconnected_at ? 'bg-gray-500' : 'bg-green-400'}`} />
                                                                        <span className="text-gray-400">
                                                                            {new Date(sess.connected_at).toLocaleString('vi-VN')}
                                                                        </span>
                                                                        <span className="text-gray-500">→</span>
                                                                        <span className="text-gray-400">
                                                                            {sess.disconnected_at
                                                                                ? new Date(sess.disconnected_at).toLocaleString('vi-VN')
                                                                                : '🟢 Đang online'}
                                                                        </span>
                                                                        {sess.ip_address && (
                                                                            <span className="text-gray-600 ml-auto">{sess.ip_address}</span>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                ))}

                                {/* Totals row */}
                                <tr className="border-t border-gray-600 font-semibold">
                                    <td className="py-2 px-2 text-gray-300">Tổng ({stats.length} NV)</td>
                                    <td className="text-right py-2 px-2 text-blue-400 font-mono">{totals.messages_sent}</td>
                                    <td className="text-right py-2 px-2 text-gray-500">—</td>
                                    <td className="text-right py-2 px-2 text-green-400 font-mono">{totals.conversations_handled}</td>
                                    <td className="text-right py-2 px-2 text-amber-400">{totals.total_online_hours}h</td>
                                    <td></td>
                                </tr>
                            </>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}


