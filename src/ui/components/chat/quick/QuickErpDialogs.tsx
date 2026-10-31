/**
 * Lịch hẹn + ghi chú nhanh (module Quản lý công việc / ERP) từ nút thao tác nhanh.
 * Không theo tài khoản chat: lưu vào lịch / ghi chú của người đang dùng app.
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

/** Giá trị điền sẵn (vd "Thêm vào lịch" từ tin nhắn: lib/chat/erp/messageToErp). */
export interface QuickEventInitial {
  title?: string;
  /** Thời điểm bắt đầu (ms); không có → nửa giờ tròn kế tiếp. */
  start?: number | null;
  /** Tin chỉ có ngày, không có giờ: ô giờ để trống cho người dùng chọn. */
  dateOnly?: boolean;
  type?: ErpEventType;
  /** Mốc nhắc (phút trước giờ hẹn, 0 = đúng giờ); không có → 15 phút + đúng giờ. */
  reminders?: number[];
  description?: string;
}

/** Thêm lịch hẹn; có hội thoại đang mở thì cho gắn lịch với hội thoại đó (từ tin nhắn: gắn cả tin để nhắc lịch nhảy tới). */
export function QuickEventDialog({ activeThread, initial, heading = 'Thêm lịch hẹn', onClose }: {
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
    // Lịch chưa hiển thị linked_contact_id → ghi thêm tên hội thoại vào ghi chú để mở lịch là biết hẹn với ai.
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
      if (!event) { setError('Không lưu được lịch hẹn: kiểm tra quyền Quản lý công việc'); return; }
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
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>Lưu vào lịch của bạn trong Quản lý công việc, tới giờ nhắc sẽ hiện thông báo</DialogDescription>
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
          <Field label={!time && duration !== 'all_day' ? 'Chọn giờ' : 'Giờ'} htmlFor="quick-event-time">
            <Input id="quick-event-time" type="time" value={time} disabled={duration === 'all_day'} onChange={e => setTime(e.target.value)}
              className={!time && duration !== 'all_day' ? 'ring-1 ring-amber-500' : undefined} />
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
        </div>
        <Field label="Địa điểm" htmlFor="quick-event-location">
          <Input id="quick-event-location" value={location} onChange={e => setLocation(e.target.value)} placeholder="Không bắt buộc" />
        </Field>
        <div className="space-y-1.5">
          <span id="quick-event-reminders" className="text-xs font-medium text-muted-foreground">Nhắc trước</span>
          <ReminderChips value={reminders} onChange={setReminders} labelledBy="quick-event-reminders" />
        </div>
        <Field label="Ghi chú" htmlFor="quick-event-description">
          <Textarea id="quick-event-description" value={description} onChange={e => setDescription(e.target.value)}
            className={initial?.description ? 'min-h-[96px]' : 'min-h-[64px]'} placeholder="Không bắt buộc" />
        </Field>
        {activeThread && (
          <Checkbox checked={linkThread} onCheckedChange={setLinkThread}
            label={<span className="text-xs">
              {activeThread.msgId ? 'Gắn với tin nhắn trong hội thoại' : 'Gắn với hội thoại đang mở'}: <span className="font-medium">{activeThread.name}</span>
            </span>} />
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

/** Ghi chú nhanh: tiêu đề tự lấy dòng đầu nếu bỏ trống. Từ tin nhắn: điền sẵn tiêu đề + nội dung tin. */
export function QuickNoteDialog({ initial, onClose }: { initial?: { title?: string; content?: string }; onClose: () => void }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [content, setContent] = useState(initial?.content || '');
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
