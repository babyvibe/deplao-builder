/**
 * Quick appointment + quick note (Task management / ERP module) from the quick action button.
 * Not tied to a chat account: saved to the calendar / notes of the person using the app.
 */
import React, { useState } from 'react';
import { useAppStore } from '@/store/app/appStore';
import { useErpCalendarStore } from '@/store/erp/erpCalendarStore';
import { useErpNoteStore } from '@/store/erp/erpNoteStore';
import {
  Button, Checkbox, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, Textarea,
} from '@/components/ui';
import {
  QUICK_EVENT_DURATIONS, QUICK_EVENT_TYPES, buildQuickEventInput, defaultQuickEventStart, quickEventInputsAt,
  quickNoteTitle, type QuickEventDuration,
} from './quickEvent';
import ReminderChips from '@/components/erp/shared/ReminderChips';
import type { ErpEventType } from '../../../../models/erp/CalendarEvent';
import { DEFAULT_ERP_REMINDERS } from '../../../../shared/erp/erpReminderText';
import { tr } from '../../../../shared/i18n';

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
  return allDay ? tr('ngày {{day}}', { day }) : `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${day}`;
};

/** Prefilled values (e.g. "Thêm vào lịch" (Add to calendar) from a message: lib/chat/erp/messageToErp). */
export interface QuickEventInitial {
  title?: string;
  /** Start time (ms); if missing → the next half-hour mark. */
  start?: number | null;
  /** Message with a date only and no time: the time field is left empty for the user to pick. */
  dateOnly?: boolean;
  type?: ErpEventType;
  /** Reminder offset (minutes before the appointment, 0 = at the time); if missing → 15 min + at the time. */
  reminders?: number[];
  description?: string;
}

/** Add an appointment; if a conversation is open, the appointment can be linked to it (from a message: the message is linked too, so the reminder jumps to it). */
export function QuickEventDialog({ activeThread, initial, heading = tr('Thêm lịch hẹn'), onClose }: {
  activeThread?: { id: string; name: string; accountId?: string; msgId?: string } | null;
  initial?: QuickEventInitial;
  heading?: string;
  onClose: () => void;
}) {
  const [start] = useState(() => (initial?.start ? quickEventInputsAt(initial.start) : defaultQuickEventStart()));
  const [title, setTitle] = useState(initial?.title || '');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(initial?.start && initial.dateOnly ? '' : start.time);
  const [duration, setDuration] = useState<QuickEventDuration>('30');
  const [type, setType] = useState<ErpEventType>(initial?.type || 'appointment');
  const [reminders, setReminders] = useState<number[]>(() => [...(initial?.reminders ?? DEFAULT_ERP_REMINDERS)]);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState(initial?.description || '');
  const [linkThread, setLinkThread] = useState(!!activeThread);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const linked = linkThread && activeThread ? activeThread : null;
    // The calendar does not display linked_contact_id yet → also write the conversation name into the note, so opening the appointment shows who it is with.
    const threadLine = linked ? `Hội thoại: ${linked.name}` : '';
    const built = buildQuickEventInput({
      title, date, time, duration, type, reminders, location,
      description: linked && !description.includes(threadLine) ? [description.trim(), threadLine].filter(Boolean).join('\n') : description,
      linkedContactId: linked?.id,
      linkedAccountId: linked?.accountId,
      linkedMsgId: linked?.msgId,
    });
    if ('error' in built) { setError(built.error); return; }
    setSaving(true);
    setError('');
    try {
      const event = await useErpCalendarStore.getState().createEvent(built.input);
      if (!event) { setError(tr('Không lưu được lịch hẹn: kiểm tra quyền Quản lý công việc')); return; }
      useAppStore.getState().showNotification(tr('Đã thêm lịch "{{title}}" lúc {{v1}}', { title: built.input.title, v1: formatWhen(built.input.start_at, duration === 'all_day') }), 'success');
      onClose();
    } catch (err: any) {
      setError(err?.message || tr('Không lưu được lịch hẹn'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !saving) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{tr('Lưu vào lịch của bạn trong Quản lý công việc, tới giờ nhắc sẽ hiện thông báo')}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Field label={tr('Tiêu đề')} htmlFor="quick-event-title">
          <Input id="quick-event-title" autoFocus value={title} maxLength={300} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void save(); }} placeholder={tr('Ví dụ: Gọi lại cho khách chốt đơn')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('Ngày')} htmlFor="quick-event-date">
            <Input id="quick-event-date" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </Field>
          <Field label={!time && duration !== 'all_day' ? tr('Chọn giờ') : tr('Giờ')} htmlFor="quick-event-time">
            <Input id="quick-event-time" type="time" value={time} disabled={duration === 'all_day'} onChange={e => setTime(e.target.value)}
              className={!time && duration !== 'all_day' ? 'ring-1 ring-amber-500' : undefined} />
          </Field>
          <Field label={tr('Thời lượng')} htmlFor="quick-event-duration">
            <Select id="quick-event-duration" value={duration} onChange={e => setDuration(e.target.value as QuickEventDuration)}>
              {QUICK_EVENT_DURATIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label={tr('Loại')} htmlFor="quick-event-type">
            <Select id="quick-event-type" value={type} onChange={e => setType(e.target.value as ErpEventType)}>
              {QUICK_EVENT_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={tr('Địa điểm')} htmlFor="quick-event-location">
          <Input id="quick-event-location" value={location} onChange={e => setLocation(e.target.value)} placeholder={tr('Không bắt buộc')} />
        </Field>
        <div className="space-y-1.5">
          <span id="quick-event-reminders" className="text-xs font-medium text-muted-foreground">{tr('Nhắc trước')}</span>
          <ReminderChips value={reminders} onChange={setReminders} labelledBy="quick-event-reminders" />
        </div>
        <Field label={tr('Ghi chú')} htmlFor="quick-event-description">
          <Textarea id="quick-event-description" value={description} onChange={e => setDescription(e.target.value)}
            className={initial?.description ? 'min-h-[96px]' : 'min-h-[64px]'} placeholder={tr('Không bắt buộc')} />
        </Field>
        {activeThread && (
          <Checkbox checked={linkThread} onCheckedChange={setLinkThread}
            label={<span className="text-xs">
              {activeThread.msgId ? tr('Gắn với tin nhắn trong hội thoại') : tr('Gắn với hội thoại đang mở')}: <span className="font-medium">{activeThread.name}</span>
            </span>} />
        )}
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>{tr('Huỷ')}</Button>
        <Button onClick={() => void save()} loading={saving} disabled={!title.trim()}>{tr('Lưu lịch')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Quick note: the title is the first line when left empty. From a message: prefills the title + message content. */
export function QuickNoteDialog({ initial, onClose }: { initial?: { title?: string; content?: string }; onClose: () => void }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [content, setContent] = useState(initial?.content || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!title.trim() && !content.trim()) { setError(tr('Ghi chú đang trống')); return; }
    setSaving(true);
    setError('');
    try {
      const noteTitle = quickNoteTitle(title, content);
      const note = await useErpNoteStore.getState().createNote({ title: noteTitle, content: content.trim() });
      if (!note) { setError(tr('Không lưu được ghi chú — kiểm tra quyền Quản lý công việc')); return; }
      useAppStore.getState().showNotification(tr('Đã lưu ghi chú "{{noteTitle}}"', { noteTitle }), 'success');
      onClose();
    } catch (err: any) {
      setError(err?.message || tr('Không lưu được ghi chú'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={next => { if (!next && !saving) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>{tr('Ghi chú nhanh')}</DialogTitle>
          <DialogDescription>{tr('Lưu vào Ghi chú trong Quản lý công việc · Ctrl+Enter để lưu')}</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <Input value={title} maxLength={300} onChange={e => setTitle(e.target.value)} placeholder={tr('Tiêu đề (bỏ trống: lấy dòng đầu)')} aria-label={tr('Tiêu đề ghi chú')} />
        <Textarea autoFocus value={content} onChange={e => setContent(e.target.value)} className="min-h-[160px]"
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }}
          placeholder={tr('Nội dung ghi chú…')} aria-label={tr('Nội dung ghi chú')} />
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>{tr('Huỷ')}</Button>
        <Button onClick={() => void save()} loading={saving} disabled={!title.trim() && !content.trim()}>{tr('Lưu ghi chú')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
