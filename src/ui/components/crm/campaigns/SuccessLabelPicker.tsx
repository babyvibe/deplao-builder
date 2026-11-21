/**
 * "Gắn nhãn khi gửi xong": a compact trigger row + a centred popup to tick labels.
 *
 * The inline list took a lot of room in the campaign editor, so the labels are only shown once picked
 * (as pills in the trigger) and the picking happens in a popup — the same conversation-detail style rows
 * (colour dot, emoji, name, ✓) the label picker of a conversation uses.
 *
 * Zalo keeps ONE label per conversation, so the Zalo section is a radio group and the popup says that a
 * chosen Zalo label replaces the existing one.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { LabelData } from '@/store/app/appStore';
import { tr } from '../../../../shared/i18n';

export interface LocalLabelOption {
  id: number;
  name: string;
  color?: string;
  emoji?: string;
}

interface SuccessLabelPickerProps {
  localLabels: LocalLabelOption[];
  zaloLabels: LabelData[];
  /** Zalo channel: the Zalo label section is offered too. */
  supportsZalo: boolean;
  localIds: number[];
  zaloIds: number[];
  onLocalChange: (ids: number[]) => void;
  onZaloChange: (ids: number[]) => void;
}

/** One tickable row, styled like the conversation label picker. */
function LabelRow({ color, emoji, name, active, single, onToggle: onToggleRow }: {
  color?: string;
  emoji?: string;
  name: string;
  active: boolean;
  single?: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" onClick={onToggleRow}
      title={active ? tr('Bỏ nhãn "{{name}}"', { name }) : tr('Gán nhãn "{{name}}"', { name })}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm transition-colors ${
        active ? 'bg-blue-500/10 text-foreground' : 'text-foreground/70 hover:bg-muted'
      }`}>
      <span className={`w-4 h-4 ${single ? 'rounded-full' : 'rounded'} border flex-shrink-0 flex items-center justify-center text-[10px] ${
        active ? 'bg-blue-600 border-blue-600 text-white' : 'border-border-strong'
      }`}>{active && (single ? '●' : '✓')}</span>
      <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color || '#3B82F6' }} />
      {emoji && <span className="flex-shrink-0">{emoji}</span>}
      <span className="flex-1 truncate">{name}</span>
    </button>
  );
}

/** The popup body, without the open/close state so the campaign render tests can assert it. */
export function SuccessLabelPickerDialog({
  localLabels, zaloLabels, supportsZalo, localIds, zaloIds, onLocalChange, onZaloChange, onClose,
}: Omit<SuccessLabelPickerProps, never> & { onClose?: () => void }) {
  const toggleLocal = (id: number) =>
    onLocalChange(localIds.includes(id) ? localIds.filter(value => value !== id) : [...localIds, id]);

  return (
    <div className="relative w-[40rem] max-w-full h-[26rem] max-h-[85vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl"
      role="dialog" aria-modal="true" aria-label={tr('Gắn nhãn khi gửi xong')}>
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <div>
          <p className="text-sm font-semibold text-foreground">{tr('Gắn nhãn khi gửi xong')}</p>
          <p className="text-[11px] leading-4 text-muted-foreground mt-0.5">
            {tr('Chỉ gắn sau khi hội thoại đã gửi thành công.')}
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} title={tr('Đóng')} aria-label={tr('Đóng')}
            className="w-6 h-6 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      {/* Ghi chú chính sách: đặt lên trên, nói rõ gắn được cả 2 loại và nhãn Zalo sẽ đè nhãn cũ */}
      {supportsZalo && (
        <div className="mx-3 mt-2 flex-shrink-0 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 space-y-0.5">
          <p className="text-[11px] leading-4 text-foreground/80">
            {tr('Gắn được cả 2 loại nhãn: Local và Zalo.')}
          </p>
          <p className="text-[11px] leading-4 text-warning">
            {tr('Zalo chỉ giữ 1 nhãn cho mỗi hội thoại: nhãn này sẽ đè (gỡ) nhãn Zalo cũ nếu hội thoại đã có nhãn.')}
          </p>
        </div>
      )}

      {/* Hai bên: Local (chọn nhiều) | Zalo (chọn 1) — vùng mỗi bên tự cuộn */}
      <div className={`flex-1 min-h-0 grid ${supportsZalo ? 'grid-cols-2 divide-x divide-border' : 'grid-cols-1'} py-2`}>
        <section className="min-h-0 flex flex-col">
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{tr('Nhãn Local')}</p>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-1">
            {localLabels.length === 0
              ? <p className="px-1 py-1.5 text-[11px] text-subtle-foreground">{tr('Chưa có nhãn Local')}</p>
              : localLabels.map(label => (
                <LabelRow key={label.id} color={label.color} emoji={label.emoji} name={label.name}
                  active={localIds.includes(Number(label.id))} onToggle={() => toggleLocal(Number(label.id))} />
              ))}
          </div>
        </section>

        {supportsZalo && (
          <section className="min-h-0 flex flex-col">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{tr('Nhãn Zalo')}</p>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-1">
              {zaloLabels.length === 0
                ? <p className="px-1 py-1.5 text-[11px] text-subtle-foreground">{tr('Chưa tải được nhãn Zalo')}</p>
                : zaloLabels.map(label => (
                  <LabelRow key={label.id} color={label.color} emoji={label.emoji} name={label.text} single
                    active={zaloIds.includes(Number(label.id))}
                    onToggle={() => onZaloChange(zaloIds.includes(Number(label.id)) ? [] : [Number(label.id)])} />
                ))}
            </div>
          </section>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border flex-shrink-0">
        <button type="button"
          onClick={() => { onLocalChange([]); onZaloChange([]); }}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">
          {tr('Bỏ chọn tất cả')}
        </button>
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors">
          {tr('Xong')}
        </button>
      </div>
    </div>
  );
}

export default function SuccessLabelPicker({
  localLabels, zaloLabels, supportsZalo, localIds, zaloIds, onLocalChange, onZaloChange,
}: SuccessLabelPickerProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /** Picked labels of both sets, in the order the user sees them (Local first, then Zalo). */
  const picked = useMemo(() => {
    const local = localLabels
      .filter(label => localIds.includes(Number(label.id)))
      .map(label => ({ key: `l${label.id}`, name: label.name, color: label.color, emoji: label.emoji, zalo: false }));
    const zalo = supportsZalo
      ? zaloLabels.filter(label => zaloIds.includes(Number(label.id)))
        .map(label => ({ key: `z${label.id}`, name: label.text, color: label.color, emoji: label.emoji, zalo: true }))
      : [];
    return [...local, ...zalo];
  }, [localLabels, zaloLabels, localIds, zaloIds, supportsZalo]);

  const toggleLocal = (id: number) =>
    onLocalChange(localIds.includes(id) ? localIds.filter(value => value !== id) : [...localIds, id]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="w-16 flex-shrink-0 text-[11px] text-muted-foreground">{tr('Nhãn')}</span>
        <button type="button" onClick={() => setOpen(true)}
          title={tr('Chọn nhãn gắn sau khi gửi thành công')}
          className="flex-1 min-w-0 min-h-8 flex items-center gap-1 flex-wrap bg-card border border-input rounded-lg px-2 py-1 text-left hover:border-blue-500 transition-colors">
          {picked.length === 0
            ? <span className="text-xs text-muted-foreground">{tr('Chọn nhãn...')}</span>
            : picked.map(label => (
              <span key={label.key}
                className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[11px] leading-none max-w-[10rem]">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: label.color || '#3B82F6' }} />
                {label.emoji && <span className="flex-shrink-0">{label.emoji}</span>}
                <span className="truncate">{label.name}</span>
                {label.zalo && <span className="text-[9px] text-muted-foreground flex-shrink-0">Zalo</span>}
              </span>
            ))}
          <span className="ml-auto pl-1 text-muted-foreground text-xs flex-shrink-0">▾</span>
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div onClick={event => event.stopPropagation()} className="relative">
            <SuccessLabelPickerDialog
              localLabels={localLabels}
              zaloLabels={zaloLabels}
              supportsZalo={supportsZalo}
              localIds={localIds}
              zaloIds={zaloIds}
              onLocalChange={onLocalChange}
              onZaloChange={onZaloChange}
              onClose={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
