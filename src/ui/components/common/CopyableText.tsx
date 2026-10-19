import React, { useState } from 'react';

interface CopyableTextProps {
  /** Giá trị sẽ được copy (UID, mã, link…). */
  value: string | undefined | null;
  /** Nội dung hiển thị, mặc định = value. */
  children?: React.ReactNode;
  className?: string;
  /** Tooltip khi rê chuột. */
  title?: string;
}

/**
 * Chuỗi có nút copy hiện khi hover, click vào bất kỳ đâu để copy (cùng kiểu với PhoneDisplay).
 */
export default function CopyableText({ value, children, className = '', title = 'Click để copy' }: CopyableTextProps) {
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
      {/* Clipboard icon – hiện khi hover */}
      <svg
        className="opacity-0 group-hover:opacity-60 transition-opacity flex-shrink-0"
        width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      {copied && (
        <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-popover border border-border text-success text-[11px] px-2 py-0.5 rounded shadow whitespace-nowrap z-50 pointer-events-none">
          ✓ Đã copy
        </span>
      )}
    </span>
  );
}
