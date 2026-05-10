import React from 'react';
import type { LabelData } from '@/store/appStore';

interface ZaloLabelBadgeProps {
  label: LabelData;
  onRemove?: () => void;
  size?: 'sm' | 'xs';
}

export default function ZaloLabelBadge({ label, onRemove, size = 'sm' }: ZaloLabelBadgeProps) {
  const color = label.color || '#3b82f6';
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full font-medium ${
        size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs'
      }`}
      style={{ backgroundColor: color + '28', color, border: `1px solid ${color}55` }}
    >
      {label.emoji && <span>{label.emoji}</span>}
      <span>{label.text}</span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 hover:opacity-70 transition-opacity leading-none"
        >
          ×
        </button>
      )}
    </span>
  );
}

