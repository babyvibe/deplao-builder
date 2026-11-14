import React, { useState } from 'react';
import { tr } from '../../../../shared/i18n';

interface CopyableTextProps {
  /** The value that will be copied (UID, code, link…). */
  value: string | undefined | null;
  /** Displayed content, default = value. */
  children?: React.ReactNode;
  className?: string;
  /** Tooltip on hover. */
  title?: string;
}

/**
 * A string with a copy button shown on hover; click anywhere to copy it (same style as PhoneDisplay).
 */
export default function CopyableText({ value, children, className = '', title = tr('Click để copy') }: CopyableTextProps) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span
      className={`inline-flex items-center gap-1 group relative cursor-pointer ${className}`}
      title={title}
      onClick={handleCopy}
    >
      <span className="group-hover:text-primary transition-colors">{children ?? value}</span>
      {/* Clipboard icon: shown on hover */}
      <svg
        className="opacity-0 group-hover:opacity-60 transition-opacity flex-shrink-0"
        width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      {copied && (
        <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-popover border border-border text-success text-[11px] px-2 py-0.5 rounded shadow whitespace-nowrap z-50 pointer-events-none">
          {tr('✓ Đã copy')}
        </span>
      )}
    </span>
  );
}
