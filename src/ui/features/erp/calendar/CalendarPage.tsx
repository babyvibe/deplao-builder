import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useErpCalendarStore } from '@/store/erp/erpCalendarStore';
import { ConfirmDialog, ErpModalCard, ErpOverlay } from '../shared/ErpDialogs';
import type { ErpCalendarEvent, CreateCalendarEventInput } from '../../../../models/erp';

type ViewMode = 'week' | 'month' | 'list';

function startOfDay(ts: number) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime();
}
function startOfWeek(ts: number) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  // Monday-first week (VN convention). Sunday = 0 → shift to 6.
  const dow = d.getDay(); const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d.getTime();
}
function startOfMonth(ts: number) {
  const d = new Date(ts); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime();
}
function toYearMonth(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
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

export default function CalendarPage() {
  const { events, loadEvents, createEvent, updateEvent, deleteEvent } = useErpCalendarStore();
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState(Date.now());
  const [showModal, setShowModal] = useState(false);
  const [newEvent, setNewEvent] = useState<Partial<CreateCalendarEventInput>>({});
  const [selectedEvent, setSelectedEvent] = useState<ErpCalendarEvent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ErpCalendarEvent | null>(null);
  const [selectedDayTs, setSelectedDayTs] = useState<number | null>(null);
  const [hasEndTime, setHasEndTime] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

  const { gridStart, gridDays, rangeFrom, rangeTo } = useMemo(() => {
    if (viewMode === 'week') {
      const gs = startOfWeek(currentDate);
      return {
        gridStart: gs,
        gridDays: 7,
        rangeFrom: gs,
        rangeTo: gs + 7 * 86400_000,
      };
    }
    if (viewMode === 'list') {
      const gs = startOfWeek(currentDate);
      return {
        gridStart: gs,
        gridDays: 14,
        rangeFrom: gs,
        rangeTo: gs + 14 * 86400_000,
      };
    }
    // month view: always render a 6-week grid beginning on the Monday on/before day-1.
    const som = startOfMonth(currentDate);
    const gs = startOfWeek(som);
    return {
      gridStart: gs,
      gridDays: 42,
      rangeFrom: gs,
      rangeTo: gs + 42 * 86400_000,
    };
  }, [viewMode, currentDate]);

  const loadForCurrent = useCallback(() => {
    loadEvents(rangeFrom, rangeTo);
  }, [rangeFrom, rangeTo]);

  useEffect(() => { loadForCurrent(); }, [loadForCurrent]);

  const days = useMemo(
    () => Array.from({ length: gridDays }, (_, i) => gridStart + i * 86400_000),
    [gridStart, gridDays]
  );

  const eventOverlapsDay = (event: ErpCalendarEvent, dayTs: number) => {
    const dayStart = startOfDay(dayTs);
    const dayEnd = dayStart + 86400_000 - 1;
    const endAt = event.end_at ?? event.start_at;
    return event.start_at <= dayEnd && endAt >= dayStart;
  };

  const eventsOnDay = (dayTs: number) => events
    .filter(e => eventOverlapsDay(e, dayTs))
    .sort((a, b) => a.start_at - b.start_at);

  const DAYS_VN = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const currentMonth = new Date(currentDate).getMonth();
  const listEvents = useMemo(() => [...events].sort((a, b) => a.start_at - b.start_at), [events]);
  const selectedDayEvents = selectedDayTs !== null ? eventsOnDay(selectedDayTs).sort((a, b) => a.start_at - b.start_at) : [];

  const resetEventForm = (seed: Partial<CreateCalendarEventInput> = {}) => {
    setNewEvent({ ...seed, description: seed.description ?? '' });
    setHasEndTime(!!seed.end_at && seed.end_at > (seed.start_at ?? 0));
  };

  const closeEventModal = () => {
    setShowModal(false);
    setEditingEventId(null);
  };

  const openCreateEventModal = (seed: Partial<CreateCalendarEventInput> = {}) => {
    setEditingEventId(null);
    resetEventForm(seed);
    setShowModal(true);
  };

  const openEditEventModal = (event: ErpCalendarEvent) => {
    setEditingEventId(event.id);
    resetEventForm(eventToFormSeed(event));
    setShowModal(true);
    setSelectedEvent(null);
  };

  const goPrev = () => {
    if (viewMode === 'week') setCurrentDate(d => d - 7 * 86400_000);
    else {
      const d = new Date(currentDate); d.setMonth(d.getMonth() - 1); setCurrentDate(d.getTime());
    }
  };
  const goNext = () => {
    if (viewMode === 'week') setCurrentDate(d => d + 7 * 86400_000);
    else {
      const d = new Date(currentDate); d.setMonth(d.getMonth() + 1); setCurrentDate(d.getTime());
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Controls */}
      <div className="flex items-center flex-wrap gap-2 px-4 py-2 border-b border-gray-700/60 flex-shrink-0">
        <button onClick={goPrev}        className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-700 hover:text-white">←</button>
        <button onClick={() => setCurrentDate(Date.now())}
                className="px-2 py-1 text-xs text-gray-400 hover:bg-gray-700 rounded-lg">Hôm nay</button>
        <button onClick={goNext}        className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-700 hover:text-white">→</button>

        <span className="text-sm text-gray-300 font-medium ml-1 min-w-[130px]">
          {new Date(currentDate).toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' })}
        </span>

        {/* Month / date jumpers */}
        <input
          type="month"
          value={toYearMonth(currentDate)}
          onChange={e => {
            if (!e.target.value) return;
            const [y, m] = e.target.value.split('-').map(Number);
            const d = new Date(currentDate); d.setFullYear(y, (m || 1) - 1, 1); d.setHours(0, 0, 0, 0);
            setCurrentDate(d.getTime());
          }}
          className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
          title="Chọn tháng"
        />
        <input
          type="date"
          value={new Date(currentDate).toISOString().slice(0, 10)}
          onChange={e => {
            if (!e.target.value) return;
            const d = new Date(e.target.value); d.setHours(12, 0, 0, 0);
            setCurrentDate(d.getTime());
          }}
          className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
          title="Đi tới ngày"
        />

        <div className="flex gap-1 ml-auto">
          {(['week', 'month', 'list'] as ViewMode[]).map(v => (
            <button key={v} onClick={() => setViewMode(v)}
              className={`px-2.5 py-1 text-xs rounded-lg ${viewMode === v ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-700'}`}>
              {v === 'week' ? 'Tuần' : v === 'month' ? 'Tháng' : 'Danh sách'}
            </button>
          ))}
          <button onClick={() => openCreateEventModal()}
            className="ml-1 px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg">
            + Sự kiện
          </button>
        </div>
      </div>

      {viewMode !== 'list' && (
        <div className="grid grid-cols-7 gap-2 px-4 pt-3 flex-shrink-0">
          {DAYS_VN.map(d => (
            <div key={d} className="text-[11px] uppercase tracking-wider text-gray-500 text-center">{d}</div>
          ))}
        </div>
      )}

      {/* Grid / List */}
      <div className="flex-1 overflow-auto px-4 pb-4 pt-2">
        {viewMode === 'list' ? (
          <div className="space-y-3">
            {listEvents.length === 0 ? (
              <div className="h-40 rounded-xl border border-gray-700/60 bg-gray-800/40 flex items-center justify-center text-sm text-gray-500">
                Chưa có sự kiện trong phạm vi đang chọn
              </div>
            ) : (
              listEvents.map(ev => (
                <div key={ev.id} className="group rounded-xl border border-gray-700/60 bg-gray-800/50 px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-500 mb-1">{new Date(ev.start_at).toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}</div>
                    <button onClick={() => setSelectedEvent(ev)} className="text-left text-sm font-medium text-white hover:text-blue-300 truncate max-w-full">{ev.title}</button>
                    <div className="text-xs text-gray-400 mt-1">
                      {new Date(ev.start_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                      {ev.end_at && ev.end_at > ev.start_at ? ` → ${new Date(ev.end_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </div>
                    {ev.location && <div className="text-xs text-gray-500 mt-1">📍 {ev.location}</div>}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: ev.color || '#3b82f6' }} />
                    <button
                      onClick={() => setDeleteTarget(ev)}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 opacity-0 pointer-events-none transition-all group-hover:opacity-100 group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto hover:border-red-400/50 hover:bg-red-500/20 hover:text-white"
                    >
                      🗑 Xóa
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
        <div className={`grid grid-cols-7 gap-2 ${viewMode === 'month' ? 'auto-rows-[136px]' : 'auto-rows-[180px]'}`}>
          {days.map((dayTs) => {
            const isToday  = startOfDay(dayTs) === startOfDay(Date.now());
            const isOther  = viewMode === 'month' && new Date(dayTs).getMonth() !== currentMonth;
            const dayEvents = eventsOnDay(dayTs);
            const visibleEvents = dayEvents.slice(0, 2);
            const hiddenCount = Math.max(0, dayEvents.length - visibleEvents.length);
            return (
              <div
                key={dayTs}
                className={`h-[136px] rounded-xl p-2 border transition-colors flex flex-col overflow-hidden ${
                  isToday ? 'border-blue-500/60 bg-blue-900/10'
                  : isOther ? 'border-gray-800 bg-gray-900/40 opacity-60'
                  : 'border-gray-700/60 bg-gray-800/40'
                }`}
                onDoubleClick={() => {
                  // quick-create on double-click: pre-fill start/end for that day.
                  const base = new Date(dayTs); base.setHours(9, 0, 0, 0);
                  const end  = new Date(dayTs); end.setHours(10, 0, 0, 0);
                  openCreateEventModal({ start_at: base.getTime(), end_at: end.getTime() });
                }}
              >
                <p className={`text-xs font-semibold mb-1.5 ${
                  isToday ? 'text-blue-400' : isOther ? 'text-gray-600' : 'text-gray-400'
                }`}>
                  {new Date(dayTs).getDate()}
                </p>
                <div className="space-y-1 min-h-[58px]">
                  {visibleEvents.map(ev => (
                    <div
                      key={ev.id}
                      className="group relative h-7 text-[11px] px-2 py-1 rounded-lg truncate cursor-pointer"
                      style={{ background: (ev.color || '#3b82f6') + '33', color: ev.color || '#60a5fa' }}
                      title={`${ev.title} — ${new Date(ev.start_at).toLocaleString('vi-VN')}`}
                      onClick={() => setSelectedEvent(ev)}
                    >
                      <span>
                        {new Date(ev.start_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} {ev.title}
                      </span>
                    </div>
                  ))}
                  {Array.from({ length: Math.max(0, 2 - visibleEvents.length) }).map((_, idx) => (
                    <div key={`empty-${dayTs}-${idx}`} className="h-7 rounded-lg border border-dashed border-transparent" />
                  ))}
                </div>
                <div className="pt-1 min-h-[22px]">
                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedDayTs(dayTs)}
                      className="text-[10px] text-blue-400 hover:text-blue-300"
                    >
                      Xem thêm ({hiddenCount})
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* Create event modal */}
      {showModal && (
        <ErpOverlay onClose={closeEventModal} className="z-50">
          <ErpModalCard className="w-full max-w-md p-5">
            <h3 className="text-sm font-bold text-white mb-4">{editingEventId ? 'Chỉnh sửa sự kiện' : 'Tạo sự kiện mới'}</h3>
            <div className="space-y-3">
              <input
                placeholder="Tiêu đề sự kiện"
                value={newEvent.title ?? ''}
                onChange={e => setNewEvent(v => ({ ...v, title: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">Bắt đầu</label>
                <input
                  type="datetime-local"
                  value={newEvent.start_at ? new Date(newEvent.start_at - new Date(newEvent.start_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                  onChange={e => setNewEvent(v => ({ ...v, start_at: e.target.value ? new Date(e.target.value).getTime() : undefined }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <label className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/40 px-3 py-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" checked={hasEndTime} onChange={e => {
                  const checked = e.target.checked;
                  setHasEndTime(checked);
                  if (!checked) setNewEvent(v => ({ ...v, end_at: undefined }));
                }} />
                Có thời gian / ngày kết thúc
              </label>
              {hasEndTime && (
                <div>
                  <label className="text-[11px] text-gray-500 mb-1 block">Kết thúc</label>
                  <input
                    type="datetime-local"
                    value={newEvent.end_at ? new Date(newEvent.end_at - new Date(newEvent.end_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                    onChange={e => setNewEvent(v => ({ ...v, end_at: e.target.value ? new Date(e.target.value).getTime() : undefined }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
              )}
              <input
                placeholder="Địa điểm (tùy chọn)"
                value={newEvent.location ?? ''}
                onChange={e => setNewEvent(v => ({ ...v, location: e.target.value }))}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <textarea
                placeholder="Ghi chú / note thông tin thêm (tùy chọn)"
                value={newEvent.description ?? ''}
                onChange={e => setNewEvent(v => ({ ...v, description: e.target.value }))}
                rows={3}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y"
              />
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={async () => {
                  if (!newEvent.title || !newEvent.start_at) return;
                  const payload: CreateCalendarEventInput = {
                    ...(newEvent as CreateCalendarEventInput),
                    description: newEvent.description?.trim() || undefined,
                    end_at: hasEndTime ? newEvent.end_at : undefined,
                  };
                  if (payload.end_at !== undefined && payload.end_at < payload.start_at) return;
                  if (editingEventId) await updateEvent(editingEventId, payload);
                  else await createEvent(payload);
                  closeEventModal();
                  resetEventForm({});
                }}
                disabled={!newEvent.title?.trim() || !newEvent.start_at || (hasEndTime && !newEvent.end_at)}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm rounded-lg"
              >{editingEventId ? 'Lưu' : 'Tạo'}</button>
              <button onClick={closeEventModal} className="px-4 py-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg text-sm">Huỷ</button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}

      {/* Event details popover */}
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
                onClick={() => { setDeleteTarget(selectedEvent); setSelectedEvent(null); }}
                className="px-3 py-1.5 text-xs font-medium text-red-300 border border-red-500/30 bg-red-500/10 hover:text-white hover:bg-red-600 rounded-lg"
              >Xoá</button>
              <button onClick={() => setSelectedEvent(null)}
                className="px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg">Đóng</button>
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <ConfirmDialog
          message={`Xoá sự kiện "${deleteTarget.title}"?`}
          onConfirm={() => { deleteEvent(deleteTarget.id); setDeleteTarget(null); }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {selectedDayTs !== null && (
        <ErpOverlay onClose={() => setSelectedDayTs(null)} className="z-50" backdropClassName="bg-black/50">
          <ErpModalCard className="w-full max-w-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-white">Danh sách sự kiện ngày {new Date(selectedDayTs).toLocaleDateString('vi-VN')}</h3>
              <button onClick={() => setSelectedDayTs(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-auto">
              {selectedDayEvents.map(ev => (
                <div key={ev.id} className="rounded-xl border border-gray-700/60 bg-gray-900/40 px-3 py-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button onClick={() => { setSelectedEvent(ev); setSelectedDayTs(null); }} className="text-left text-sm text-white hover:text-blue-300 truncate max-w-full">{ev.title}</button>
                    <div className="text-xs text-gray-400 mt-1">
                      {new Date(ev.start_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                      {ev.end_at && ev.end_at > ev.start_at ? ` → ${new Date(ev.end_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </div>
                    {ev.description && <div className="text-[11px] text-gray-500 mt-1 whitespace-pre-wrap">{ev.description}</div>}
                  </div>
                  <button
                    onClick={() => setDeleteTarget(ev)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 hover:border-red-400/50 hover:bg-red-500/20 hover:text-white"
                  >
                    🗑 Xóa
                  </button>
                </div>
              ))}
            </div>
          </ErpModalCard>
        </ErpOverlay>
      )}
    </div>
  );
}

