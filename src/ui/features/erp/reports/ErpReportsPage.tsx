import React, { useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useEmployeeStore } from '@/store/employeeStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { ERP_DATE_FILTER_OPTIONS, getDefaultCustomRange, resolveErpDateRange, startOfDay, endOfDay, type ErpDateFilterPreset } from '../shared/erpDateFilters';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, AreaChart, Area, Legend,
} from 'recharts';
import type { ErpCalendarEvent, ErpTask } from '../../../../models/erp';

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-800/50 p-4">
      <h3 className="text-sm font-semibold text-white mb-3">{title}</h3>
      {children}
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-800/50 p-4">
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold mt-2 ${tone}`}>{value}</div>
    </div>
  );
}

function ReportTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-xs shadow-xl">
      {label && <div className="text-white font-medium mb-1">{label}</div>}
      {payload.map((item: any) => (
        <div key={item.dataKey} className="flex items-center justify-between gap-4">
          <span className="text-gray-300">{item.name}</span>
          <span style={{ color: item.color || item.fill }}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function ErpReportsPage() {
  const { employees, loadEmployees } = useEmployeeStore();
  const { profiles, departments, loadProfiles, loadDepartments, pendingLeaves, loadPendingLeaves } = useErpEmployeeStore();
  const [tasks, setTasks] = useState<ErpTask[]>([]);
  const [events, setEvents] = useState<ErpCalendarEvent[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState<ErpDateFilterPreset>('last30');
  const [customDateRange, setCustomDateRange] = useState(() => getDefaultCustomRange());

  const activeRange = useMemo(() => resolveErpDateRange(dateFilter, customDateRange), [customDateRange, dateFilter]);
  const rangeStart = activeRange?.from ?? startOfDay(Date.now() - 29 * 86400_000);
  const todayEnd = activeRange?.to ?? endOfDay(Date.now());
  const periodDays = useMemo(() => Math.max(1, Math.ceil((todayEnd - rangeStart + 1) / 86400_000)), [rangeStart, todayEnd]);
  const forecastEnd = useMemo(() => endOfDay(Date.now() + 14 * 86400_000), []);

  const reload = async () => {
    setLoading(true);
    await Promise.all([loadEmployees(), loadProfiles(), loadDepartments(), loadPendingLeaves()]);

    const [taskRes, eventRes, attendanceRes] = await Promise.all([
      ipc.erp?.taskList?.({ archived: false }),
      ipc.erp?.calendarListEvents?.({ from: rangeStart, to: forecastEnd }),
      ipc.erp?.attendanceList?.({ all: true, from: new Date(rangeStart).toISOString().slice(0, 10), to: new Date(todayEnd).toISOString().slice(0, 10) }),
    ]);

    setTasks(taskRes?.success ? (taskRes.tasks || []) : []);
    setEvents(eventRes?.success ? (eventRes.events || []) : []);
    setAttendance(attendanceRes?.success ? (attendanceRes.list || []) : []);
    setLoading(false);
  };

  useEffect(() => {
    if (!activeRange) return;
    reload();
  }, [activeRange, dateFilter]);

  const employeeName = (employeeId: string) => employees.find((employee: any) => employee.employee_id === employeeId)?.display_name || employeeId;

  const summary = useMemo(() => {
    const now = Date.now();
    const windowTasks = tasks.filter(task => {
      const markers = [task.created_at, task.updated_at, task.completed_at, task.due_date].filter((value): value is number => typeof value === 'number');
      return markers.some(value => value >= rangeStart && value <= todayEnd) || (!!task.due_date && task.due_date < now && !['done', 'cancelled'].includes(task.status));
    });
    const overdueTasks = tasks.filter(task => !!task.due_date && task.due_date < now && !['done', 'cancelled'].includes(task.status));
    const unassignedTasks = tasks.filter(task => !task.assignees?.length);
    const tasksDueSoon = tasks.filter(task => !!task.due_date && task.due_date >= now && task.due_date <= forecastEnd && !['done', 'cancelled'].includes(task.status));
    const todayAttendanceEmployeeIds = new Set(attendance.filter(item => item.date === new Date().toISOString().slice(0, 10)).map(item => item.employee_id));
    const activeEmployees = employees.filter((employee: any) => employee.is_active);
    const missingCheckIn = activeEmployees.filter((employee: any) => !todayAttendanceEmployeeIds.has(employee.employee_id));
    const employeesWithoutProfile = activeEmployees.filter((employee: any) => !profiles.some(profile => profile.employee_id === employee.employee_id));
    const departmentsWithoutManager = departments.filter(department => !department.manager_employee_id);
    const upcomingEvents = events.filter(event => event.start_at >= Date.now()).sort((a, b) => a.start_at - b.start_at);

    const taskStatusData = [
      { name: 'Cần làm', value: windowTasks.filter(task => task.status === 'todo').length },
      { name: 'Đang làm', value: windowTasks.filter(task => task.status === 'doing').length },
      { name: 'Xem xét', value: windowTasks.filter(task => task.status === 'review').length },
      { name: 'Hoàn thành', value: windowTasks.filter(task => task.status === 'done').length },
      { name: 'Huỷ', value: windowTasks.filter(task => task.status === 'cancelled').length },
    ];

    const taskPriorityData = [
      { name: 'Thấp', value: windowTasks.filter(task => task.priority === 'low').length },
      { name: 'Bình thường', value: windowTasks.filter(task => task.priority === 'normal').length },
      { name: 'Cao', value: windowTasks.filter(task => task.priority === 'high').length },
      { name: 'Khẩn cấp', value: windowTasks.filter(task => task.priority === 'urgent').length },
    ].filter(item => item.value > 0);

    const dailyTrendData = Array.from({ length: periodDays }, (_, index) => {
      const dayTs = startOfDay(rangeStart + index * 86400_000);
      const dayEnd = endOfDay(dayTs);
      return {
        day: new Date(dayTs).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
        taskMoi: tasks.filter(task => task.created_at >= dayTs && task.created_at <= dayEnd).length,
        taskXong: tasks.filter(task => (task.completed_at ?? 0) >= dayTs && (task.completed_at ?? 0) <= dayEnd).length,
        suKien: events.filter(event => event.start_at >= dayTs && event.start_at <= dayEnd).length,
      };
    });

    const attendanceByDay = Array.from({ length: periodDays }, (_, index) => {
      const dayTs = startOfDay(rangeStart + index * 86400_000);
      const dayKey = new Date(dayTs).toISOString().slice(0, 10);
      return {
        day: new Date(dayTs).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
        checkIn: attendance.filter(item => item.date === dayKey && item.check_in_at).length,
      };
    });

    return {
      overdueTasks,
      unassignedTasks,
      tasksDueSoon,
      missingCheckIn,
      employeesWithoutProfile,
      departmentsWithoutManager,
      upcomingEvents,
      taskStatusData,
      taskPriorityData,
      dailyTrendData,
      attendanceByDay,
    };
  }, [attendance, departments, employees, events, forecastEnd, profiles, rangeStart, tasks, todayEnd]);

  const sections = [
    {
      title: 'Task cần theo dõi',
      empty: 'Không có task nổi bật cần theo dõi',
      items: [
        ...summary.overdueTasks.slice(0, 5).map(task => ({ key: `overdue-${task.id}`, title: task.title, meta: 'Quá hạn', tone: 'text-red-300' })),
        ...summary.unassignedTasks.slice(0, 5).map(task => ({ key: `unassigned-${task.id}`, title: task.title, meta: 'Chưa có người thực hiện', tone: 'text-yellow-300' })),
      ],
    },
    {
      title: 'Nhân sự cần xử lý',
      empty: 'Nhân sự đã đồng bộ ổn',
      items: [
        ...summary.missingCheckIn.slice(0, 5).map((employee: any) => ({ key: `attendance-${employee.employee_id}`, title: employee.display_name, meta: 'Chưa check-in hôm nay', tone: 'text-pink-300' })),
        ...summary.employeesWithoutProfile.slice(0, 5).map((employee: any) => ({ key: `profile-${employee.employee_id}`, title: employee.display_name, meta: 'Thiếu hồ sơ ERP', tone: 'text-violet-300' })),
      ],
    },
    {
      title: 'Nghỉ phép chờ duyệt',
      empty: 'Không có đơn nghỉ cần duyệt',
      items: pendingLeaves.slice(0, 6).map((leave: any) => ({
        key: `leave-${leave.id}`,
        title: employeeName(leave.requester_id),
        meta: `${leave.leave_type} · ${leave.start_date} → ${leave.end_date}`,
        tone: 'text-yellow-300',
      })),
    },
  ];

  return (
    <div className="h-full overflow-auto p-4 space-y-4 bg-gray-900">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-white">Báo cáo ERP trực quan</h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={dateFilter}
            onChange={e => setDateFilter(e.target.value as ErpDateFilterPreset)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
          >
            {ERP_DATE_FILTER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          {dateFilter === 'custom' && (
            <>
              <input
                type="date"
                value={customDateRange.from}
                onChange={e => setCustomDateRange(current => ({ ...current, from: e.target.value }))}
                className="bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
              />
              <input
                type="date"
                value={customDateRange.to}
                onChange={e => setCustomDateRange(current => ({ ...current, to: e.target.value }))}
                className="bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
              />
            </>
          )}
          <button
            onClick={reload}
            className="px-3 py-1.5 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200"
          >
            Làm mới
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <MetricCard label="Task quá hạn" value={summary.overdueTasks.length} tone="text-red-400" />
        <MetricCard label="Task chưa phân công" value={summary.unassignedTasks.length} tone="text-yellow-300" />
        <MetricCard label="Task đến hạn sắp tới" value={summary.tasksDueSoon.length} tone="text-blue-300" />
        <MetricCard label="Đơn nghỉ chờ duyệt" value={pendingLeaves.length} tone="text-orange-300" />
        <MetricCard label="Chưa check-in hôm nay" value={summary.missingCheckIn.length} tone="text-pink-300" />
        <MetricCard label="Thiếu hồ sơ ERP" value={summary.employeesWithoutProfile.length} tone="text-violet-300" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard title="Phân bổ trạng thái task">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={summary.taskStatusData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} allowDecimals={false} />
                <Tooltip content={<ReportTooltip />} />
                <Bar dataKey="value" name="Số task" fill="#3b82f6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Tỷ trọng độ ưu tiên">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={summary.taskPriorityData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={3}>
                  {summary.taskPriorityData.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<ReportTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Xu hướng task và lịch theo ngày">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={summary.dailyTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="day" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} allowDecimals={false} />
                <Tooltip content={<ReportTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="taskMoi" name="Task mới" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} />
                <Area type="monotone" dataKey="taskXong" name="Task hoàn thành" stroke="#10b981" fill="#10b981" fillOpacity={0.25} />
                <Area type="monotone" dataKey="suKien" name="Sự kiện" stroke="#a855f7" fill="#a855f7" fillOpacity={0.2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Chấm công theo ngày">
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={summary.attendanceByDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="day" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} allowDecimals={false} />
                <Tooltip content={<ReportTooltip />} />
                <Bar dataKey="checkIn" name="Số người check-in" fill="#06b6d4" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {sections.map(section => (
          <div key={section.title} className="rounded-xl border border-gray-700/60 bg-gray-800/50 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">{section.title}</h3>
            {loading ? (
              <div className="text-sm text-gray-500">Đang tổng hợp dữ liệu…</div>
            ) : section.items.length === 0 ? (
              <div className="text-sm text-gray-500">{section.empty}</div>
            ) : (
              <div className="space-y-2">
                {section.items.map(item => (
                  <div key={item.key} className="rounded-lg border border-gray-700/60 bg-gray-900/30 px-3 py-2">
                    <div className="text-sm text-white truncate">{item.title}</div>
                    <div className={`text-xs mt-1 ${item.tone}`}>{item.meta}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
