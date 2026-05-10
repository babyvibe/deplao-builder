import React from 'react';
import DOMPurify from 'dompurify';
import ipc from '@/lib/ipc';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useEmployeeStore } from '@/store/employeeStore';

// ─── PriorityBadge ────────────────────────────────────────────────────────────
export type ErpPriority = 'low' | 'medium' | 'high' | 'urgent' | string;

const PRIORITY_STYLE: Record<string, { label: string; cls: string }> = {
  low:    { label: 'Thấp',    cls: 'bg-gray-500/20 text-gray-300 border-gray-500/40' },
  normal: { label: 'Bình thường', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  medium: { label: 'Trung',   cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  high:   { label: 'Cao',     cls: 'bg-orange-500/20 text-orange-300 border-orange-500/40' },
  urgent: { label: 'Khẩn',    cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
};

export function PriorityBadge({ value, compact }: { value?: ErpPriority; compact?: boolean }) {
  const v = (value ?? 'normal') as string;
  const s = PRIORITY_STYLE[v] ?? PRIORITY_STYLE.normal;
  return (
    <span className={`inline-flex items-center rounded border px-1.5 ${compact ? 'py-0 text-[10px]' : 'py-0.5 text-[11px]'} font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────
export type ErpStatus = 'todo' | 'doing' | 'review' | 'done' | 'cancelled' | string;

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  todo:      { label: 'Cần làm',  cls: 'bg-gray-500/20 text-gray-300' },
  doing:     { label: 'Đang làm', cls: 'bg-blue-500/20 text-blue-300' },
  review:    { label: 'Xem xét',  cls: 'bg-purple-500/20 text-purple-300' },
  done:      { label: 'Hoàn thành', cls: 'bg-green-500/20 text-green-300' },
  cancelled: { label: 'Huỷ',      cls: 'bg-red-500/20 text-red-300 line-through' },
};

export function StatusBadge({ value, compact }: { value?: ErpStatus; compact?: boolean }) {
  const v = (value ?? 'todo') as string;
  const s = STATUS_STYLE[v] ?? STATUS_STYLE.todo;
  return (
    <span className={`inline-flex items-center rounded px-1.5 ${compact ? 'py-0 text-[10px]' : 'py-0.5 text-[11px]'} font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

// ─── EmployeeAvatar + Name ────────────────────────────────────────────────────
const AVATAR_COLORS = [
  'bg-blue-600', 'bg-emerald-600', 'bg-orange-600', 'bg-purple-600',
  'bg-pink-600', 'bg-cyan-600', 'bg-amber-600', 'bg-rose-600',
];

function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const last = parts[parts.length - 1];
  return (last[0] ?? '?').toUpperCase();
}

export function useEmployeeDisplay(employeeId: string | undefined | null): { name: string; avatar?: string | null } {
  const currentEmployee = useEmployeeStore(s => s.currentEmployee);
  const employeeNameMap = useEmployeeStore(s => s.employeeNameMap);
  const employeeAvatarMap = useEmployeeStore(s => s.employeeAvatarMap);
  const profile = useErpEmployeeStore(s =>
    employeeId ? s.profiles.find((p: any) => p.employee_id === employeeId) : undefined
  );
  const employee = useEmployeeStore(s =>
    employeeId ? s.employees.find((p: any) => p.employee_id === employeeId) : undefined
  );
  if (!employeeId) return { name: '—' };
  if (employeeId === 'boss') {
    return { name: 'Boss', avatar: null };
  }
  const name = (profile as any)?.full_name
    || employee?.display_name
    || (employeeId === currentEmployee?.employee_id ? currentEmployee?.display_name : '')
    || (profile as any)?.display_name
    || employeeNameMap[employeeId]
    || employeeId;
  return {
    name,
    avatar: employee?.avatar_url
      ?? (employeeId === currentEmployee?.employee_id ? currentEmployee?.avatar_url : null)
      ?? (profile as any)?.avatar_url
      ?? employeeAvatarMap[employeeId]
      ?? null,
  };
}

export function EmployeeAvatar({
  employeeId, size = 24, showName = false,
}: { employeeId?: string | null; size?: number; showName?: boolean }) {
  const { name, avatar } = useEmployeeDisplay(employeeId ?? undefined);
  const id = employeeId || '';
  const dim = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  return (
    <span className="inline-flex items-center gap-1.5">
      {avatar ? (
        <img src={avatar} alt={name} className="rounded-full object-cover ring-1 ring-gray-700" style={dim} />
      ) : (
        <span
          className={`rounded-full text-white font-semibold inline-flex items-center justify-center ring-1 ring-gray-700 ${colorFor(id)}`}
          style={dim}
          title={name}
        >
          {initialsFrom(name)}
        </span>
      )}
      {showName && <span className="text-xs text-gray-300 truncate">{name}</span>}
    </span>
  );
}

// ─── MarkdownRenderer — safe, no external deps ────────────────────────────────
// Lightweight: escapes HTML first then applies inline + block rules.
// Supports: headings (#..######), bold **x**, italic *x*/_x_, inline `code`,
// code blocks ```…```, links [a](b), unordered lists (- / *), ordered lists,
// blockquotes (>) and paragraphs. Strips raw HTML.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const markdownLinkRegex = new RegExp(String.raw`\[([^\]]+)\]\((https?:[^)\s]+)\)`, 'g');

function inlineMd(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="bg-gray-800 px-1 rounded text-[12px]">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(markdownLinkRegex, (_match, label, href) => (
      `<a href="${href}" target="_blank" rel="noreferrer" class="text-blue-400 underline">${label}</a>`
    ));
}

function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src).replace(/\r\n/g, '\n');
  // Code fences
  const parts: string[] = [];
  const fenceRe = /```([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(escaped)) !== null) {
    parts.push(renderBlocks(escaped.slice(lastIdx, m.index)));
    parts.push(`<pre class="bg-gray-800 rounded p-3 my-2 text-[12px] overflow-x-auto"><code>${m[1].trim()}</code></pre>`);
    lastIdx = m.index + m[0].length;
  }
  parts.push(renderBlocks(escaped.slice(lastIdx)));
  return parts.join('');
}

function renderBlocks(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let listBuf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paraBuf: string[] = [];

  const flushList = () => {
    if (!listBuf.length || !listType) return;
    out.push(`<${listType} class="list-${listType === 'ul' ? 'disc' : 'decimal'} pl-5 my-2 space-y-0.5">` +
      listBuf.map(li => `<li>${inlineMd(li)}</li>`).join('') + `</${listType}>`);
    listBuf = []; listType = null;
  };
  const flushPara = () => {
    if (!paraBuf.length) return;
    out.push(`<p class="my-2 leading-relaxed">${inlineMd(paraBuf.join(' '))}</p>`);
    paraBuf = [];
  };

  for (const raw of lines) {
    const line = raw;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    const bq = /^>\s?(.*)$/.exec(line);

    if (h) { flushList(); flushPara();
      const lvl = h[1].length;
      const sizes = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-xs'];
      out.push(`<h${lvl} class="${sizes[lvl - 1]} font-bold text-white mt-4 mb-2">${inlineMd(h[2])}</h${lvl}>`);
    } else if (ul) { flushPara();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul'; listBuf.push(ul[1]);
    } else if (ol) { flushPara();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol'; listBuf.push(ol[1]);
    } else if (bq) { flushList(); flushPara();
      out.push(`<blockquote class="border-l-2 border-gray-600 pl-3 my-2 text-gray-400 italic">${inlineMd(bq[1])}</blockquote>`);
    } else if (line.trim() === '') {
      flushList(); flushPara();
    } else {
      flushList();
      paraBuf.push(line.trim());
    }
  }
  flushList(); flushPara();
  return out.join('');
}

function looksLikeHtml(source: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(source);
}

function renderRichContent(source: string): string {
  if (!source?.trim()) return '';
  if (!looksLikeHtml(source)) return renderMarkdown(source);
  return DOMPurify.sanitize(source, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel', 'class', 'style'],
  });
}

export function MarkdownRenderer({ source, className }: { source: string; className?: string }) {
  const html = React.useMemo(() => renderRichContent(source ?? ''), [source]);

  const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a') as HTMLAnchorElement | null;
    if (!anchor?.href) return;
    event.preventDefault();
    event.stopPropagation();
    if (/^https?:\/\//i.test(anchor.href)) {
      ipc.shell?.openExternal?.(anchor.href);
    }
  }, []);

  return (
    <div
      className={`erp-md text-sm text-gray-300 ${className ?? ''}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function RichContentPreview({
  source,
  className,
  compact = false,
}: {
  source?: string;
  className?: string;
  compact?: boolean;
}) {
  if (!source?.trim()) {
    return <p className={`text-xs text-gray-500 italic ${className ?? ''}`}>Chưa có nội dung chi tiết</p>;
  }

  return (
    <MarkdownRenderer
      source={source}
      className={`erp-rich-preview ${compact ? 'erp-rich-preview-compact' : ''} ${className ?? ''}`.trim()}
    />
  );
}

