/**
 * Biểu tượng plugin: ảnh từ manifest.icon, hoặc chữ cái đầu trên nền gradient cố định theo id.
 * Chữ trắng đặt bằng style (theme sáng remap class text-foreground).
 */
import React from 'react';

const GRADIENTS = [
  ['#2563eb', '#7c3aed'], ['#059669', '#0ea5e9'], ['#db2777', '#f59e0b'], ['#7c3aed', '#ec4899'],
  ['#0891b2', '#22c55e'], ['#ea580c', '#e11d48'], ['#4f46e5', '#06b6d4'], ['#16a34a', '#a3e635'],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export default function PluginAvatar({ id, name, icon, size = 48, rounded = 14 }: { id: string; name: string; icon?: string | null; size?: number; rounded?: number }) {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: rounded, objectFit: 'cover', flexShrink: 0 }}
        draggable={false}
      />
    );
  }
  const [a, b] = GRADIENTS[hash(id) % GRADIENTS.length];
  return (
    <div
      aria-hidden
      style={{
        width: size, height: size, borderRadius: rounded, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `linear-gradient(135deg, ${a}, ${b})`, color: '#fff', fontWeight: 700, fontSize: Math.round(size * 0.36), letterSpacing: '0.02em',
      }}
    >
      {initials(name)}
    </div>
  );
}
