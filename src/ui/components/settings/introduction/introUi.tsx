/** Thành phần dùng chung cho Cài đặt → Giới thiệu & Hướng dẫn sử dụng (introduction/*Panel.tsx). */
import React from 'react';

export function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${color}`}>{text}</span>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-foreground font-semibold text-sm mb-2">{children}</p>;
}

export function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>;
}

export function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-muted-foreground text-xs">
          <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
          <span dangerouslySetInnerHTML={{ __html: item }} />
        </li>
      ))}
    </ul>
  );
}

export function StepList({ steps }: { steps: { title: string; desc: string }[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-blue-600/30 text-blue-400 text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
            {i + 1}
          </span>
          <div>
            <p className="text-foreground/80 text-xs font-semibold">{s.title}</p>
            <p className="text-muted-foreground text-xs mt-0.5" dangerouslySetInnerHTML={{ __html: s.desc }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border/50 rounded-xl p-4 space-y-3">
      {children}
    </div>
  );
}
