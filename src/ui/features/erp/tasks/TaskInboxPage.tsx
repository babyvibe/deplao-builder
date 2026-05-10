import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useErpTaskStore } from '@/store/erp/erpTaskStore';
import { useCurrentEmployeeId, useErpPermissions } from '@/hooks/erp/useErpContext';
import TaskEditorDrawer from './TaskEditorDrawer';
import { EmployeeAvatar, RichContentPreview } from '../shared/ErpBadges';
import { ConfirmDialog, ErpModalCard, ErpOverlay } from '../shared/ErpDialogs';
import { ERP_DATE_FILTER_OPTIONS, getDefaultCustomRange, resolveErpDateRange, type ErpDateFilterPreset } from '../shared/erpDateFilters';
import type { CreateCalendarEventInput, ErpCalendarEvent, ErpTask } from '../../../../models/erp';

const STATUS_LABELS: Record<string, string> = {
  todo: 'Cần làm',
  doing: 'Đang làm',
  review: 'Xem xét',
  done: 'Hoàn thành',
  cancelled: 'Huỷ',
};

function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function taskFallsWithinWindow(task: ErpTask, windowStart: number, futureEnd: number) {
  if (task.status === 'cancelled') return false;
  if (task.due_date && task.due_date < Date.now() && task.status !== 'done') return true;
  const markers = [task.created_at, task.updated_at, task.start_date, task.due_date, task.completed_at].filter((value): value is number => typeof value === 'number');
  return markers.some(value => value >= windowStart && value <= futureEnd);
}

function roleLabel(role: string) {
  return role === 'owner' ? 'Chủ hệ thống (Boss)' : role === 'admin' ? 'Quản trị ERP' : role === 'manager' ? 'Quản lý' : 'Nhân viên';
}

function eventToFormSeed(event: ErpCalendarEvent): Partial<CreateCalendarEventInput> {
  return {
    title: event.title,
    description: event.description,
    type: event.type,
    start_at: event.start_at,
    end_at: event.end_at,
    all_day: event.all_day,
    location: event.location,
    color: event.color,
    linked_task_id: event.linked_task_id,
    linked_contact_id: event.linked_contact_id,
  };
}

export default function TaskInboxPage() {
  const { showNotification } = useAppStore();
  const currentEmployeeId = useCurrentEmployeeId();
  const perms = useErpPermissions();
  const { inboxTasks, loadInbox } = useErpTaskStore();
  const loadProfiles = useErpEmployeeStore(s => s.loadProfiles);
  const [dateFilter, setDateFilter] = useState<ErpDateFilterPreset>('last30');
  const [customDateRange, setCustomDateRange] = useState(() => getDefaultCustomRange());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [events, setEvents] = useState<ErpCalendarEvent[]>([]);
  const [showEventModal, setShowEventModal] = useState(false);
  const [eventDraft, setEventDraft] = useState<Partial<CreateCalendarEventInput>>({});
  const [selectedEvent, setSelectedEvent] = useState<ErpCalendarEvent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ErpCalendarEvent | null>(null);
  const [hasEndTime, setHasEndTime] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [savingEvent, setSavingEvent] = useState(false);

  const activeRange = useMemo(() => resolveErpDateRange(dateFilter, customDateRange), [customDateRange, dateFilter]);
  const windowStart = activeRange?.from ?? startOfDay(Date.now() - 29 * 86400_000);
  const windowEnd = activeRange?.to ?? endOfDay(Date.now());

  useEffect(() => {
    loadInbox('all');
    loadProfiles();
  }, []);

  const loadOwnEvents = useCallback(async () => {
    const res = await ipc.erp?.calendarListEvents({ from: windowStart, to: windowEnd, organizerId: currentEmployeeId });
    if (res?.success) {
      const next = (res.events || [])
        .filter((event: ErpCalendarEvent) => (event.end_at ?? event.start_at) >= windowStart && event.start_at <= windowEnd)
        .sort((a: ErpCalendarEvent, b: ErpCalendarEvent) => a.start_at - b.start_at);
      setEvents(next);
      return;
    }
    setEvents([]);
    if (res?.error) showNotification(res.error, 'error');
  }, [currentEmployeeId, showNotification, windowEnd, windowStart]);

  useEffect(() => {
    if (!activeRange) return;
    loadOwnEvents();
  }, [activeRange, loadOwnEvents]);

  const resetEventForm = useCallback((seed: Partial<CreateCalendarEventInput> = {}) => {
    setEventDraft({ ...seed, description: seed.description ?? '' });
    setHasEndTime(!!seed.end_at && seed.end_at > (seed.start_at ?? 0));
  }, []);

  const closeEventModal = useCallback(() => {
    setShowEventModal(false);
    setEditingEventId(null);
    setSavingEvent(false);
  }, []);

  const openCreateEventModal = useCallback(() => {
    const baseStart = new Date();
    baseStart.setMinutes(0, 0, 0);
    const startAt = Math.max(windowStart, baseStart.getTime());
    const endAt = startAt + 60 * 60 * 1000;
    setEditingEventId(null);
    resetEventForm({ start_at: startAt, end_at: endAt });
    setShowEventModal(true);
  }, [resetEventForm, windowStart]);

  const openEditEventModal = useCallback((event: ErpCalendarEvent) => {
    setEditingEventId(event.id);
    resetEventForm(eventToFormSeed(event));
    setSelectedEvent(null);
    setShowEventModal(true);
  }, [resetEventForm]);

  const handleSaveEvent = useCallback(async () => {
    if (!eventDraft.title?.trim() || !eventDraft.start_at) return;
    const payload: CreateCalendarEventInput = {
      ...(eventDraft as CreateCalendarEventInput),
      description: eventDraft.description?.trim() || undefined,
      end_at: hasEndTime ? eventDraft.end_at : undefined,
    };
    if (payload.end_at !== undefined && payload.end_at < payload.start_at) {
      showNotification('Thời gian kết thúc phải lớn hơn hoặc bằng thời gian bắt đầu', 'warning');
      return;
    }

    setSavingEvent(true);
    try {
      const res = editingEventId
        ? await ipc.erp?.calendarUpdate({ id: editingEventId, patch: payload })
        : await ipc.erp?.calendarCreate({ input: payload });

      if (!res?.success) {
        showNotification(res?.error || 'Không thể lưu sự kiện', 'error');
        return;
      }

      closeEventModal();
      resetEventForm({});
      await loadOwnEvents();
      showNotification(editingEventId ? 'Đã cập nhật sự kiện' : 'Đã tạo sự kiện mới', 'success');
    } finally {
      setSavingEvent(false);
    }
  }, [closeEventModal, editingEventId, eventDraft, hasEndTime, loadOwnEvents, resetEventForm, showNotification]);

  const handleDeleteEvent = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const res = await ipc.erp?.calendarDelete({ id: target.id });
    if (!res?.success) {
      showNotification(res?.error || 'Không thể xóa sự kiện', 'error');
      return;
    }
    setDeleteTarget(null);
    setSelectedEvent(current => current?.id === target.id ? null : current);
    await loadOwnEvents();
    showNotification('Đã xóa sự kiện', 'success');
  }, [deleteTarget, loadOwnEvents, showNotification]);

  const relevantTasks = useMemo(() => {
    if (!activeRange) return [];
    return inboxTasks.filter(task => taskFallsWithinWindow(task, windowStart, windowEnd));
  }, [activeRange, inboxTasks, windowEnd, windowStart]);

  const summaryCards = useMemo(() => {
    const overdue = relevantTasks.filter(task => !!task.due_date && task.due_date < Date.now() && !['done', 'cancelled'].includes(task.status));
    const todo = relevantTasks.filter(task => task.status === 'todo');
    const doing = relevantTasks.filter(task => task.status === 'doing');
    const done = relevantTasks.filter(task => task.status === 'done' && (task.completed_at ?? task.updated_at) >= windowStart && (task.completed_at ?? task.updated_at) <= windowEnd);
    const review = relevantTasks.filter(task => task.status === 'review');

    const cards = [
      { label: 'Cần làm', value: todo.length, tone: 'text-blue-100', chip: 'text-blue-200 bg-blue-900/30 border-blue-500/30', card: 'border-blue-500/20 bg-blue-900/10' },
      { label: 'Đang làm', value: doing.length, tone: 'text-sky-300', chip: 'text-sky-300 bg-sky-900/50 border-sky-600', card: 'border-sky-600/30 bg-sky-900/50' },
      { label: 'Đã hoàn thành', value: done.length, tone: 'text-green-200', chip: 'text-green-200 bg-green-900/50 border-green-600/40', card: 'border-green-600/30 bg-green-900/30' },
      { label: 'Quá hạn', value: overdue.length, tone: 'text-red-200', chip: 'text-red-200 bg-red-900/40 border-red-400/40', card: 'border-red-500/20 bg-red-500/5' },
    ];

    if (perms.role === 'owner' || perms.role === 'admin' || perms.role === 'manager') {
      cards.push({ label: 'Chờ xem xét', value: review.length, tone: 'text-yellow-200', chip: 'text-yellow-200 bg-yellow-900/40 border-yellow-500/30', card: 'border-yellow-500/20 bg-yellow-500/10' });
    } else {
      cards.push({ label: 'Sự kiện trong kỳ', value: events.length, tone: 'text-violet-300', chip: 'text-violet-300 bg-violet-600/20 border-violet-500/40', card: 'border-violet-500/20 bg-purple-500/10' });
    }

    return { cards, overdue };
  }, [events.length, perms.role, relevantTasks, windowEnd, windowStart]);

  const taskList = useMemo(() => {
    return [...relevantTasks]
      .filter(task => task.status !== 'done' || (task.completed_at ?? task.updated_at) >= windowStart)
      .sort((a, b) => {
        const aOverdue = !!a.due_date && a.due_date < Date.now() && !['done', 'cancelled'].includes(a.status);
        const bOverdue = !!b.due_date && b.due_date < Date.now() && !['done', 'cancelled'].includes(b.status);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        return (a.due_date ?? a.updated_at) - (b.due_date ?? b.updated_at);
      })
      .slice(0, 16);
  }, [relevantTasks, windowStart]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700/60 flex-shrink-0 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-white">Tổng quan công việc của tôi</h3>
            <p className="text-[11px] text-gray-500 mt-1">Vai trò hiện tại: <span className="text-gray-300">{roleLabel(perms.role)}</span></p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-gray-500">Thời gian</span>
            <select
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value as ErpDateFilterPreset)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
            >
              {ERP_DATE_FILTER_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            {dateFilter === 'custom' && (
              <>
                <input
                  type="date"
                  value={customDateRange.from}
                  onChange={e => setCustomDateRange(current => ({ ...current, from: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
                />
                <input
                  type="date"
                  value={customDateRange.to}
                  onChange={e => setCustomDateRange(current => ({ ...current, to: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200"
                />
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
          {summaryCards.cards.map(card => (
            <div key={card.label} className={`rounded-xl border px-4 py-3 shadow-sm ${card.card}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold">{card.label}</div>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${card.chip}`}>task</span>
              </div>
              <div className={`text-[32px] leading-none font-bold mt-3 tracking-tight ${card.tone}`}>{card.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] gap-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Task trong giai đoạn đã chọn</div>
            <div className="text-[11px] text-gray-500">{taskList.length} / {relevantTasks.length} task hiển thị</div>
          </div>

          {taskList.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-600 bg-gray-800/40 border border-gray-700/50 rounded-xl">
              <span className="text-3xl mb-2">✅</span>
              <p className="text-sm">Không có task nào trong giai đoạn này</p>
            </div>
          ) : (
            taskList.map(task => {
              const overdue = !!task.due_date && task.due_date < Date.now() && !['done', 'cancelled'].includes(task.status);
              return (
                <div
                  key={task.id}
                  onClick={() => setSelectedTaskId(task.id)}
                  className="bg-gray-800 border border-gray-700/60 rounded-xl p-3 cursor-pointer shadow-sm hover:border-gray-500 hover:bg-gray-800/80 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-gray-100 font-semibold leading-snug">{task.title}</p>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                      task.status === 'done' ? 'bg-green-900/50 text-green-200 border border-green-600/40'
                      : task.status === 'doing' ? 'bg-blue-900/50 text-blue-200 border border-blue-500/30'
                      : task.status === 'review' ? 'bg-yellow-900/50 text-yellow-200 border border-yellow-500/30'
                      : 'bg-gray-700 text-gray-300 border border-gray-600'
                    }`}>{STATUS_LABELS[task.status] || task.status}</span>
                  </div>
                  {task.description?.trim() && (
                    <div className="mt-2 rounded-lg border border-gray-700/50 bg-gray-900/30 px-3 py-2">
                      <RichContentPreview source={task.description} compact className="text-[12px] text-gray-400" />
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-2 text-[11px] text-gray-400 flex-wrap">
                    <span className="font-medium">{task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟠' : task.priority === 'normal' ? '🔵' : '⚪'} {task.priority}</span>
                    {task.due_date && (
                      <span className={overdue ? 'text-red-300 font-medium' : 'text-gray-400'}>
                        📅 {new Date(task.due_date).toLocaleDateString('vi-VN')}
                      </span>
                    )}
                    {!!task.assignees?.length && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>👥</span>
                        {task.assignees.slice(0, 3).map(employeeId => (
                          <EmployeeAvatar key={`${task.id}-${employeeId}`} employeeId={employeeId} size={18} showName />
                        ))}
                        {task.assignees.length > 3 && <span>+{task.assignees.length - 3}</span>}
                      </div>
                    )}
                    {!!task.watchers?.length && (
                      <div className="flex items-center gap-1.5 flex-wrap rounded-full border border-violet-500/20 bg-violet-500/5 px-2 py-1 text-violet-500">
                        <span>👀</span>
                        {task.watchers.slice(0, 2).map(employeeId => (
                          <EmployeeAvatar key={`watcher-${task.id}-${employeeId}`} employeeId={employeeId} size={16} showName={false} />
                        ))}
                        <span>{task.watchers.length} theo dõi</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Lịch của tôi</div>
            <button
              type="button"
              onClick={openCreateEventModal}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-300 hover:border-blue-400/50 hover:bg-blue-500/20 hover:text-white transition-colors"
            >
              <span className="text-sm leading-none">＋</span>
              <span>Thêm sự kiện</span>
            </button>
          </div>
          <div className="bg-gray-800/50 border border-gray-700/60 rounded-xl p-3 space-y-2">
            {events.length === 0 ? (
              <div className="text-sm text-gray-500 py-6 text-center">Không có sự kiện trong khoảng thời gian hiện tại</div>
            ) : (
              events.slice(0, 12).map(event => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => setSelectedEvent(event)}
                  className="w-full rounded-lg border border-gray-700/60 bg-gray-900/30 px-3 py-2 shadow-sm text-left hover:border-blue-500/40 hover:bg-gray-900/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-gray-100 font-medium truncate">{event.title}</p>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: event.color || '#3b82f6' }} />
                  </div>
                  <p className="text-xs text-gray-300 mt-1">{new Date(event.start_at).toLocaleString('vi-VN')}</p>
                  {event.location && <p className="text-[11px] text-gray-500 mt-1">📍 {event.location}</p>}
                </button>
              ))
            )}
          </div>

          {summaryCards.overdue.length > 0 && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
              <div className="text-xs font-semibold text-red-300 uppercase tracking-wider mb-2">Ưu tiên xử lý</div>
              <div className="space-y-2">
                {summaryCards.overdue.slice(0, 4).map(task => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setSelectedTaskId(task.id)}
                    className="w-full text-left rounded-lg border border-red-500/10 bg-gray-900/30 px-3 py-2 hover:border-red-400/40"
                  >
                    <div className="text-sm text-white truncate">{task.title}</div>
                    <div className="text-[11px] text-red-300 mt-1">Quá hạn từ {task.due_date ? new Date(task.due_date).toLocaleDateString('vi-VN') : '—'}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedTaskId && (
        <TaskEditorDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      )}

      {showEventModal && (
        <ErpOverlay onClose={closeEventModal} className="z-50">
          <ErpModalCard className="w-full max-w-md p-5">
            <h3 className="text-sm font-bold text-white mb-4">{editingEventId ? 'Chỉnh sửa sự kiện' : 'Tạo sự kiện mới'}</h3>
            <div className="space-y-3">
              <input
                placeholder="Tiêu đề sự kiện"
                value={eventDraft.title ?? ''}
                onChange={e => setEventDraft(v => ({ ...v, title: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">Bắt đầu</label>
                <input
                  type="datetime-local"
                  value={eventDraft.start_at ? new Date(eventDraft.start_at - new Date(eventDraft.start_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                  onChange={e => setEventDraft(v => ({ ...v, start_at: e.target.value ? new Date(e.target.value).getTime() : undefined }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <label className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasEndTime}
                  onChange={e => {
                    const checked = e.target.checked;
                    setHasEndTime(checked);
                    if (!checked) setEventDraft(v => ({ ...v, end_at: undefined }));
                  }}
                />
                Có thời gian / ngày kết thúc
              </label>
              {hasEndTime && (
                <div>
                  <label className="text-[11px] text-gray-500 mb-1 block">Kết thúc</label>
                  <input
                    type="datetime-local"
                    value={eventDraft.end_at ? new Date(eventDraft.end_at - new Date(eventDraft.end_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                    onChange={e => setEventDraft(v => ({ ...v, end_at: e.target.value ? new Date(e.target.value).getTime() : undefined }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
              )}
              <input
                placeholder="Địa điểm (tùy chọn)"
                value={eventDraft.location ?? ''}
                onChange={e => setEventDraft(v => ({ ...v, location: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <textarea
                placeholder="Ghi chú / note thông tin thêm (tùy chọn)"
                value={eventDraft.description ?? ''}
                onChange={e => setEventDraft(v => ({ ...v, description: e.target.value }))}
                rows={3}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y"
              />
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleSaveEvent}
                disabled={savingEvent || !eventDraft.title?.trim() || !eventDraft.start_at || (hasEndTime && !eventDraft.end_at)}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg"
              >{savingEvent ? 'Đang lưu...' : (editingEventId ? 'Lưu' : 'Tạo')}</button>
              <button onClick={closeEventModal} className="px-4 py-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg text-sm">Huỷ</button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}

      {selectedEvent && (
        <ErpOverlay onClose={() => setSelectedEvent(null)} className="z-50" backdropClassName="bg-black/50">
          <ErpModalCard className="w-full max-w-sm p-5">
            <h3 className="text-sm font-bold text-white mb-2">{selectedEvent.title}</h3>
            <p className="text-xs text-gray-400">
              {new Date(selectedEvent.start_at).toLocaleString('vi-VN')}
              {selectedEvent.end_at && selectedEvent.end_at > selectedEvent.start_at
                ? ` → ${new Date(selectedEvent.end_at).toLocaleString('vi-VN')}`
                : ''}
            </p>
            {selectedEvent.location && <p className="text-xs text-gray-400 mt-1">📍 {selectedEvent.location}</p>}
            {selectedEvent.description && <p className="text-xs text-gray-300 mt-2 whitespace-pre-wrap">{selectedEvent.description}</p>}
            <div className="flex gap-2 mt-4 justify-end">
              <button
                onClick={() => openEditEventModal(selectedEvent)}
                className="px-3 py-1.5 text-xs text-blue-300 hover:text-white hover:bg-blue-600 rounded-lg"
              >Sửa</button>
              <button
                onClick={() => {
                  setDeleteTarget(selectedEvent);
                  setSelectedEvent(null);
                }}
                className="px-3 py-1.5 text-xs font-medium text-red-300 border border-red-500/30 bg-red-500/10 hover:text-white hover:bg-red-600 rounded-lg"
              >Xoá</button>
              <button onClick={() => setSelectedEvent(null)} className="px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg">Đóng</button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message={`Xoá sự kiện "${deleteTarget.title}"?`}
          onConfirm={handleDeleteEvent}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

