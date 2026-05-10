import React, { useRef, useState, useEffect } from 'react';

export interface LocalLabelItem {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
}

interface LocalLabelSelectorProps {
  labels: LocalLabelItem[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  /** Placeholder when nothing selected */
  placeholder?: string;
  /** Disable toggling individual labels (show spinner for this id) */
  togglingId?: number | null;
  /** Show empty-state text */
  emptyText?: string;
}

/**
 * Reusable dropdown multi-select for local labels.
 * Shows selected labels as colored badges in a clickable box,
 * opens a dropdown with checkboxes to toggle each label.
 */
export default function LocalLabelSelector({
  labels,
  selectedIds,
  onChange,
  placeholder = 'Chọn nhãn...',
  togglingId = null,
  emptyText = 'Chưa có nhãn nào',
}: LocalLabelSelectorProps) {
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
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter(x => x !== id)
        : [...selectedIds, id],
    );
  };

  const selected = labels.filter(l => selectedIds.includes(l.id));

  return (
    <div ref={ref} className="relative">
      {/* Trigger box — shows selected badges */}
      <div
        onClick={() => setOpen(v => !v)}
        className="min-h-[32px] flex flex-wrap gap-1 items-center bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 cursor-pointer hover:border-blue-500 transition-colors"
      >
        {selected.length > 0
          ? selected.map(l => (
              <span
                key={l.id}
                className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none"
                style={{ backgroundColor: l.color || '#3b82f6', color: l.text_color || '#fff' }}
              >
                {l.emoji && <span className="text-[9px]">{l.emoji}</span>}
                <span className="truncate max-w-[60px]">{l.name}</span>
              </span>
            ))
          : <span className="text-xs text-gray-500">{placeholder}</span>}
        <span className="ml-auto text-gray-500 text-xs">▾</span>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
          {labels.length === 0 && (
            <p className="text-xs text-gray-500 p-3 text-center">{emptyText}</p>
          )}
          {labels.map(label => {
            const isSelected = selectedIds.includes(label.id);
            const isToggling = togglingId === label.id;
            return (
              <button
                key={label.id}
                onClick={() => toggle(label.id)}
                disabled={isToggling}
                className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left ${
                  isToggling ? 'opacity-50' : ''
                }`}
              >
                {/* Checkbox */}
                <span
                  className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center text-xs ${
                    isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-500'
                  }`}
                >
                  {isSelected && '✓'}
                </span>
                {/* Color dot */}
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: label.color || '#3b82f6' }}
                />
                {label.emoji && <span className="text-xs">{label.emoji}</span>}
                <span className="text-sm text-white truncate">{label.name}</span>
                {isToggling && (
                  <span className="ml-auto text-[10px] text-gray-500 animate-pulse">...</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

