import React, { useEffect, useRef, useState } from 'react';

interface TaskMultiSelectOption {
  value: string;
  label: string;
}

interface TaskMultiSelectProps {
  options: TaskMultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  tone?: 'blue' | 'violet';
}

const TONE_STYLE = {
  blue: {
    badge: 'bg-blue-900/30 border border-blue-500/30 text-blue-200',
    checked: 'bg-blue-600 border-blue-600 text-white',
    action: 'text-blue-300 hover:text-blue-200',
    count: 'bg-blue-900/30 border-blue-500/30 text-blue-200',
    row: 'data-[checked=true]:bg-blue-900/20 data-[checked=true]:border-blue-500/30',
  },
  violet: {
    badge: 'bg-violet-900/30 border border-violet-500/30 text-violet-500',
    checked: 'bg-violet-600 border-violet-600 text-white',
    action: 'text-violet-300 hover:text-violet-600',
    count: 'bg-violet-900/30 border-violet-500/30 text-violet-500',
    row: 'data-[checked=true]:bg-violet-900/20 data-[checked=true]:border-violet-500/30',
  },
} as const;

export default function TaskMultiSelect({ options, value, onChange, placeholder, tone = 'blue' }: TaskMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selectedOptions = options.filter(option => value.includes(option.value));
  const toneStyle = TONE_STYLE[tone];

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const toggleOption = (optionValue: string) => {
    onChange(value.includes(optionValue)
      ? value.filter(item => item !== optionValue)
      : [...value, optionValue]);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full min-h-[50px] flex flex-wrap items-center gap-1.5 bg-gray-900/70 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-left text-gray-100 shadow-sm hover:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
      >
        {selectedOptions.length > 0 ? selectedOptions.map(option => (
          <span key={option.value} className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium max-w-[150px] truncate ${toneStyle.badge}`}>
            {option.label}
          </span>
        )) : <span className="text-gray-400 font-medium">{placeholder}</span>}
        <span className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneStyle.count}`}>
          {selectedOptions.length} chọn
        </span>
        <span className="text-sm text-gray-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-2 w-full rounded-xl border border-gray-600 bg-gray-800 shadow-2xl max-h-64 overflow-auto p-2.5">
          <div className="px-1 pb-2 text-[11px] font-medium text-gray-400">
            {selectedOptions.length > 0 ? `Đã chọn ${selectedOptions.length} người` : placeholder}
          </div>
          {options.map(option => {
            const checked = value.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => toggleOption(option.value)}
                data-checked={checked}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-transparent hover:bg-gray-700/70 text-sm text-gray-100 text-left transition-colors ${toneStyle.row}`}
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] font-bold ${checked ? toneStyle.checked : 'border-gray-500 bg-gray-900/50 text-transparent'}`}>
                  ✓
                </span>
                <span className="truncate font-medium">{option.label}</span>
              </button>
            );
          })}
          <div className="mt-3 flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              onClick={() => onChange([])}
              className={`text-[11px] font-medium ${toneStyle.action}`}
            >
              Bỏ chọn hết
            </button>
            <button type="button" onClick={() => setOpen(false)} className={`text-[11px] font-medium ${toneStyle.action}`}>
              Đóng
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

