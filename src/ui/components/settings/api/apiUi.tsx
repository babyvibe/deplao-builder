/**
 * apiUi.tsx — mảnh giao diện dùng chung cho trang Công cụ → Ứng dụng, API & Webhook (phần API và phần Ứng dụng).
 * Chỉ dùng token màu của hệ thống giao diện (bg-card, text-foreground, primary/success/warning/destructive…).
 */
import React, { useState } from 'react';
import { CheckIcon, CopyIcon, AlertIcon } from '@/components/common/icons';

export function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('vi-VN', { hour12: false });
}

export function fmtAgo(ts?: number | null, now = Date.now()): string {
  if (!ts) return 'chưa dùng';
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return 'vừa xong';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} phút trước`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}

export const btn = {
  primary: 'px-3 py-1.5 text-xs whitespace-nowrap bg-primary hover:bg-primary-hover disabled:opacity-40 text-primary-foreground rounded-lg transition-colors',
  secondary: 'px-3 py-1.5 text-xs whitespace-nowrap bg-muted hover:bg-accent disabled:opacity-40 text-foreground rounded-lg transition-colors',
  danger: 'px-3 py-1.5 text-xs whitespace-nowrap bg-destructive hover:bg-destructive/90 disabled:opacity-40 text-destructive-foreground rounded-lg transition-colors',
  link: 'text-xs text-primary hover:text-primary-hover disabled:opacity-40 transition-colors',
};

export const inputCls = 'w-full bg-muted text-foreground text-xs rounded-lg px-2.5 py-1.5 border border-input focus:border-primary outline-none disabled:opacity-50';

export function Toggle({ checked, onChange, disabled, busy, title }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${checked ? 'bg-primary' : 'bg-accent'}`}
    >
      {busy ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </span>
      ) : (
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      )}
    </button>
  );
}

export function Section({ title, icon, right, children }: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2">{icon}{title}</p>
        {right}
      </div>
      {children}
    </div>
  );
}

export function CopyField({ value, label, secret }: { value: string; label?: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard bị chặn */ }
  };
  return (
    <div className="bg-muted rounded-lg px-3 py-2">
      {label && <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>}
      <div className="flex items-center gap-2">
        <code className={`flex-1 text-xs break-all select-all font-mono ${secret ? 'text-warning' : 'text-success'}`}>{value}</code>
        <button type="button" onClick={copy} className="text-primary hover:text-primary-hover flex-shrink-0" title="Copy">
          {copied ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

type Tone = 'gray' | 'green' | 'red' | 'yellow' | 'blue';

const TONE: Record<Tone, string> = {
  gray: 'bg-muted text-muted-foreground',
  green: 'bg-success/15 text-success',
  red: 'bg-destructive/15 text-destructive',
  yellow: 'bg-warning/15 text-warning',
  blue: 'bg-primary/15 text-primary',
};

export function Badge({ tone = 'gray', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center h-5 px-1.5 rounded-md text-[11px] font-semibold whitespace-nowrap ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function httpTone(status?: number | null): Tone {
  if (!status) return 'red';
  if (status < 300) return 'green';
  if (status < 500) return 'yellow';
  return 'red';
}

export function ErrorBox({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
      <p className="text-xs text-destructive"><AlertIcon className="w-4 h-4 inline" /> {message}</p>
    </div>
  );
}

/** Hộp hiện bí mật (API key / webhook secret) đúng một lần. */
export function OneTimeSecret({ title, value, onDone }: { title: string; value: string; onDone: () => void }) {
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 space-y-2">
      <p className="text-sm font-semibold text-warning">{title}</p>
      <p className="text-xs text-muted-foreground">Chỉ hiện <strong>một lần</strong>. Copy và lưu vào nơi an toàn (biến môi trường, trình quản lý mật khẩu). Mất thì tạo cái mới.</p>
      <CopyField value={value} secret />
      <div className="flex justify-end">
        <button type="button" className={btn.primary} onClick={onDone}>Tôi đã lưu</button>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-subtle-foreground leading-relaxed">{hint}</span>}
    </label>
  );
}

/** Danh sách tài khoản rút gọn để chọn quyền (key, webhook). */
export interface AccountOption {
  id: string;
  name: string;
  channel: string;
}

export function AccountPicker({ accounts, value, onChange }: {
  accounts: AccountOption[];
  /** null = tất cả tài khoản */
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const all = value === null;
  const toggle = (id: string) => {
    const cur = new Set(value || []);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    onChange(Array.from(cur));
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-4 text-xs text-foreground/80">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={all} onChange={() => onChange(null)} /> Tất cả tài khoản
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={!all} onChange={() => onChange(value || [])} /> Chỉ tài khoản được chọn
        </label>
      </div>
      {!all && (
        <div className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
          {accounts.length === 0 && <p className="text-xs text-subtle-foreground px-3 py-2">Chưa có tài khoản nào.</p>}
          {accounts.map(acc => (
            <label key={acc.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 cursor-pointer hover:bg-muted">
              <input type="checkbox" checked={!!value?.includes(acc.id)} onChange={() => toggle(acc.id)} />
              <span className="flex-1 truncate">{acc.name || acc.id}</span>
              <Badge>{acc.channel}</Badge>
              <span className="text-[10px] text-subtle-foreground font-mono">{acc.id}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
