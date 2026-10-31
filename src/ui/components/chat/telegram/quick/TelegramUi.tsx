/** Mảnh giao diện dùng chung cho các hộp thoại Telegram (ảnh đại diện chữ cái, chọn ảnh, bước, ô chọn tròn). */
import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { CheckIcon, CloseIcon } from '@/components/common/icons';
import { telegramInitials, telegramPeerColor } from './telegramPeople';

export function TelegramAvatar({ id, name, src, size = 36, className }: {
  id: string;
  name: string;
  src?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (src && !failed) {
    return <img src={toLocalMediaUrl(src)} alt="" onError={() => setFailed(true)} style={style} className={cn('shrink-0 rounded-full object-cover', className)} />;
  }
  return (
    <span
      aria-hidden
      style={{ ...style, background: telegramPeerColor(id), color: '#fff', fontSize: Math.max(10, Math.round(size * 0.36)) }}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', className)}
    >
      {telegramInitials(name)}
    </span>
  );
}

/** Loa phát tin (biểu tượng "Kênh mới" của Telegram). */
export function MegaphoneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

export function CameraIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

/** Chọn ảnh nhóm / kênh (hộp chọn file của máy — Electron mới không còn File.path). */
export function TelegramPhotoField({ value, onChange, size = 72, disabled }: {
  value: string;
  onChange: (path: string) => void;
  size?: number;
  disabled?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const pick = async () => {
    const res: any = await ipc.file?.openDialog({ filters: [{ name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    const path = res?.filePaths?.[0];
    if (path) {
      setFailed(false);
      onChange(path);
    }
  };
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <button type="button" onClick={() => void pick()} disabled={disabled}
        aria-label={value ? 'Đổi ảnh' : 'Chọn ảnh'} title={value ? 'Đổi ảnh' : 'Chọn ảnh'}
        className="group relative flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-primary/10 text-primary ring-1 ring-inset ring-primary/25 transition-colors hover:bg-primary/15 disabled:opacity-60">
        {value && !failed ? (
          <>
            <img src={toLocalMediaUrl(value)} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" />
            <span className="absolute inset-0 hidden items-center justify-center bg-black/45 group-hover:flex" style={{ color: '#fff' }}>
              <CameraIcon className="h-6 w-6" />
            </span>
          </>
        ) : (
          <CameraIcon className="h-7 w-7" />
        )}
      </button>
      {value && !disabled && (
        <button type="button" onClick={() => onChange('')} aria-label="Bỏ ảnh" title="Bỏ ảnh"
          className="absolute -right-0.5 -top-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm hover:text-foreground">
          <CloseIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Ô chọn tròn kiểu Telegram. */
export function RoundCheck({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={cn(
      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong',
    )}>
      {checked && <CheckIcon className="h-3 w-3" />}
    </span>
  );
}

/** "Bước 1/3" + các chấm. */
export function StepDots({ step, total }: { step: number; total: number }) {
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={`Bước ${step}/${total}`}>
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className={cn('h-1.5 rounded-full transition-all', index + 1 === step ? 'w-4 bg-primary' : index + 1 < step ? 'w-1.5 bg-primary/60' : 'w-1.5 bg-border-strong')} />
      ))}
    </span>
  );
}

export function FieldLabel({ htmlFor, children, hint }: { htmlFor?: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{children}</label>
      {hint && <span className="text-[11px] text-subtle-foreground">{hint}</span>}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'error' | 'success'; children: React.ReactNode }) {
  const tones = {
    info: 'bg-primary/5 text-foreground/80 ring-primary/15',
    warning: 'bg-warning/10 text-warning ring-warning/20',
    error: 'bg-destructive/10 text-destructive ring-destructive/20',
    success: 'bg-success/10 text-success ring-success/20',
  } as const;
  return <div role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-lg px-3 py-2 text-xs leading-5 ring-1 ring-inset', tones[tone])}>{children}</div>;
}
