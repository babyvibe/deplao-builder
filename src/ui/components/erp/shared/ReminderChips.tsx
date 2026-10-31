/**
 * Chọn mốc nhắc của lịch (chọn nhiều): Đúng giờ · 5 phút · 15 phút · 30 phút · 1 giờ · 1 ngày. Bỏ hết = không nhắc.
 * Đúng giờ: popup như nhắc hẹn Zalo; mốc trước: thông báo trong chuông + chuông rung trên thanh tiêu đề. Dùng ở trang Lịch
 * (tạo / sửa) và "Thêm lịch hẹn" nhanh / từ tin nhắn. Mốc lạ (API đặt 2 giờ) vẫn hiện để sửa lịch không làm mất.
 */
import React from 'react';
import {
  ERP_REMINDER_CHOICES, erpDurationText, erpReminderChoiceLabel, normalizeErpReminderMinutes,
} from '../../../../shared/erp/erpReminderText';

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
            title={minutes === 0 ? 'Popup nhắc đúng giờ hẹn' : `Thông báo trước giờ hẹn ${erpDurationText(minutes)}`}
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
