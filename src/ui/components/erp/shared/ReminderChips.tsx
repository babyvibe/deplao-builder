/**
 * Pick the reminder times for an event (multi-select): On time · 5 min · 15 min · 30 min · 1 hour · 1 day. Clear all = no reminders.
 * On time: popup like Zalo appointment reminders; earlier times: notification in the bell + the title-bar bell rings. Used on the Calendar page
 * (create / edit) and in the quick "Thêm lịch hẹn" (Add appointment) and from messages. Unknown times (e.g. 2 hours set via the API) still show, so editing the event does not drop them.
 */
import React from 'react';
import {
  ERP_REMINDER_CHOICES, erpDurationText, erpReminderChoiceLabel, normalizeErpReminderMinutes,
} from '../../../../shared/erp/erpReminderText';
import { tr } from '../../../../shared/i18n';

export default function ReminderChips({ value, onChange, labelledBy }: {
  value: readonly number[];
  onChange: (next: number[]) => void;
  labelledBy?: string;
}) {
  const selected = new Set(value);
  const choices = normalizeErpReminderMinutes([...ERP_REMINDER_CHOICES, ...value]).sort((a, b) => a - b);
  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-1.5">
      {choices.map(minutes => {
        const on = selected.has(minutes);
        return (
          <button
            key={minutes}
            type="button"
            aria-pressed={on}
            title={minutes === 0 ? tr('Popup nhắc đúng giờ hẹn') : tr('Thông báo trước giờ hẹn {{v1}}', { v1: erpDurationText(minutes) })}
            onClick={() => onChange(normalizeErpReminderMinutes(on ? value.filter(v => v !== minutes) : [...value, minutes]))}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${on
              ? 'border-primary bg-primary/15 text-primary'
              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            {erpReminderChoiceLabel(minutes)}
          </button>
        );
      })}
    </div>
  );
}
