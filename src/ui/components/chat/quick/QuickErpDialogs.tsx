/**
 * Lịch hẹn + ghi chú nhanh (module Quản lý công việc / ERP) từ nút thao tác nhanh.
 * Không theo tài khoản chat: lưu vào lịch / ghi chú của người đang dùng app.
 */
import React, { useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { useErpCalendarStore } from '@/store/erp/erpCalendarStore';
import { useErpNoteStore } from '@/store/erp/erpNoteStore';
import {
  Button, Checkbox, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, Textarea,
} from '@/components/ui';
import {
  QUICK_EVENT_DURATIONS, QUICK_EVENT_REMINDERS, QUICK_EVENT_TYPES, buildQuickEventInput, defaultQuickEventStart, quickNoteTitle,
  type QuickEventDuration,
} from './quickEvent';
import type { ErpEventType } from '../../../../models/erp/CalendarEvent';

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

const pad2 = (value: number) => String(value).padStart(2, '0');
const formatWhen = (ts: number, allDay: boolean) => {
  const d = new Date(ts);
  const day = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  return allDay ? `ngày ${day}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${day}`;
};

/** Thêm lịch hẹn; có hội thoại đang mở thì cho gắn lịch với hội thoại đó. */
export function QuickEventDialog({ activeThread, onClose }: {
  activeThread?: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const [start] = useState(() => defaultQuickEventStart());
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [duration, setDuration] = useState<QuickEventDuration>('30');
  const [type, setType] = useState<ErpEventType>('appointment');
  const [reminder, setReminder] = useState('15');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [linkThread, setLinkThread] = useState(!!activeThread);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const linked = linkThread && activeThread ? activeThread : null;
    // Lịch chưa hiển thị linked_contact_id → ghi thêm tên hội thoại vào ghi chú để mở lịch là biết hẹn với ai.
    const built = buildQuickEventInput({
      title, date, time, duration, type, reminder, location,
      description: linked ? [description.trim(), `Hội thoại: ${linked.name}`].filter(Boolean).join('\n') : description,
      linkedContactId: linked?.id,
    });
    if ('error' in built) { setError(built.error); return; }
    setSaving(true);
    setError('');
    try {
      const event = await useErpCalendarStore.getState().createEvent(built.input);
      if (!event) { setError('Không lưu được lịch hẹn — kiểm tra quyền Quản lý công việc'); return; }
      useAppStore.getState().showNotification(`Đã thêm lịch "${built.input.title}" lúc ${formatWhen(built.input.start_at, duration === 'all_day')}`, 'success');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Không lưu được lịch hẹn');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !saving) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>Thêm lịch hẹn</DialogTitle>
          <DialogDescription>Lưu vào lịch của bạn trong Quản lý công việc</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Field label="Tiêu đề" htmlFor="quick-event-title">
          <Input id="quick-event-title" autoFocus value={title} maxLength={300} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void save(); }} placeholder="Ví dụ: Gọi lại cho khách chốt đơn" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Ngày" htmlFor="quick-event-date">
            <Input id="quick-event-date" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </Field>
          <Field label="Giờ" htmlFor="quick-event-time">
            <Input id="quick-event-time" type="time" value={time} disabled={duration === 'all_day'} onChange={e => setTime(e.target.value)} />
          </Field>
          <Field label="Thời lượng" htmlFor="quick-event-duration">
            <Select id="quick-event-duration" value={duration} onChange={e => setDuration(e.target.value as QuickEventDuration)}>
              {QUICK_EVENT_DURATIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label="Loại" htmlFor="quick-event-type">
            <Select id="quick-event-type" value={type} onChange={e => setType(e.target.value as ErpEventType)}>
              {QUICK_EVENT_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label="Nhắc trước" htmlFor="quick-event-reminder">
            <Select id="quick-event-reminder" value={reminder} onChange={e => setReminder(e.target.value)}>
              {QUICK_EVENT_REMINDERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label="Địa điểm" htmlFor="quick-event-location">
            <Input id="quick-event-location" value={location} onChange={e => setLocation(e.target.value)} placeholder="Không bắt buộc" />
          </Field>
        </div>
        <Field label="Ghi chú" htmlFor="quick-event-description">
          <Textarea id="quick-event-description" value={description} onChange={e => setDescription(e.target.value)} className="min-h-[64px]" placeholder="Không bắt buộc" />
        </Field>
        {activeThread && (
          <Checkbox checked={linkThread} onCheckedChange={setLinkThread}
            label={<span className="text-xs">Gắn với hội thoại đang mở: <span className="font-medium">{activeThread.name}</span></span>} />
        )}
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>Huỷ</Button>
        <Button onClick={() => void save()} loading={saving} disabled={!title.trim()}>Lưu lịch</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Ghi chú nhanh: tiêu đề tự lấy dòng đầu nếu bỏ trống. */
export function QuickNoteDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!title.trim() && !content.trim()) { setError('Ghi chú đang trống'); return; }
    setSaving(true);
    setError('');
    try {
      const noteTitle = quickNoteTitle(title, content);
      const note = await useErpNoteStore.getState().createNote({ title: noteTitle, content: content.trim() });
      if (!note) { setError('Không lưu được ghi chú — kiểm tra quyền Quản lý công việc'); return; }
      useAppStore.getState().showNotification(`Đã lưu ghi chú "${noteTitle}"`, 'success');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Không lưu được ghi chú');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !saving) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>Ghi chú nhanh</DialogTitle>
          <DialogDescription>Lưu vào Ghi chú trong Quản lý công việc · Ctrl+Enter để lưu</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Input value={title} maxLength={300} onChange={e => setTitle(e.target.value)} placeholder="Tiêu đề (bỏ trống: lấy dòng đầu)" aria-label="Tiêu đề ghi chú" />
        <Textarea autoFocus value={content} onChange={e => setContent(e.target.value)} className="min-h-[160px]"
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }}
          placeholder="Nội dung ghi chú…" aria-label="Nội dung ghi chú" />
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>Huỷ</Button>
        <Button onClick={() => void save()} loading={saving} disabled={!title.trim() && !content.trim()}>Lưu ghi chú</Button>
      </DialogFooter>
    </Dialog>
  );
}
