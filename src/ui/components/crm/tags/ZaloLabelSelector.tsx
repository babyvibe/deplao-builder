import React, { useRef, useState, useEffect } from 'react';
import type { LabelData } from '@/store/app/appStore';
import ZaloLabelBadge from './ZaloLabelBadge';

interface ZaloLabelSelectorProps {
  allLabels: LabelData[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  /** When true, only one label can be selected at a time (radio behavior) */
  singleSelect?: boolean;
}

export default function ZaloLabelSelector({ allLabels, selectedIds, onChange, singleSelect = false }: ZaloLabelSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (id: number) => {
    if (singleSelect) {
      // Radio behavior: deselect if already selected, otherwise pick only this one
      onChange(selectedIds.includes(id) ? [] : [id]);
    } else {
      onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]);
    }
  };

  const selected = allLabels.filter(l => selectedIds.includes(l.id));

  return (
    <div ref={ref} className="relative">
      <div
        onClick={() => setOpen(v => !v)}
        className="min-h-[32px] flex flex-wrap gap-1 items-center bg-muted border border-input rounded-lg px-2 py-1 cursor-pointer hover:border-blue-500 transition-colors"
      >
        {selected.length > 0
          ? selected.map(l => <ZaloLabelBadge key={l.id} label={l} size="xs" />)
          : <span className="text-xs text-muted-foreground">Chọn nhãn...</span>}
        <span className="ml-auto text-muted-foreground text-xs">▾</span>
      </div>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-input rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
          {allLabels.length === 0 && (
            <p className="text-xs text-muted-foreground p-3 text-center">Chưa có nhãn nào</p>
          )}
          {singleSelect && (
            <p className="text-[10px] text-muted-foreground px-3 pt-2 pb-1">Zalo chỉ cho 1 nhãn / hội thoại</p>
          )}
          {allLabels.map(label => {
            const isSelected = selectedIds.includes(label.id);
            return (
              <button key={label.id} onClick={() => toggle(label.id)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors text-left">
                <span
                  className={`w-4 h-4 ${singleSelect ? 'rounded-full' : 'rounded'} border flex-shrink-0 flex items-center justify-center text-xs ${
                    isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-border-strong'
                  }`}
                >
                  {isSelected && (singleSelect ? '●' : '✓')}
                </span>
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: label.color || '#3b82f6' }} />
                {label.emoji && <span>{label.emoji}</span>}
                <span className="text-sm text-foreground">{label.text}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

