import React, { useState } from 'react';
import { formatPhone } from '@/utils/phoneUtils';

interface PhoneDisplayProps {
  phone: string | undefined | null;
  /** Hiển thị "**********" thay vì ẩn hoàn toàn khi không có SĐT */
  maskIfEmpty?: boolean;
  className?: string;
  /** Thêm icon 📞 trước số */
  showIcon?: boolean;
}

/**
 * Hiển thị số điện thoại đã format (84→0 cho VN) với nút copy khi hover.
 * Click vào bất kỳ đâu trong component để copy.
 */
export default function PhoneDisplay({ phone, maskIfEmpty = false, className = '', showIcon = false }: PhoneDisplayProps) {
  const [copied, setCopied] = useState(false);

  const formatted = formatPhone(phone);
  if (!formatted && !maskIfEmpty) return null;

  const display = formatted || '**********';

  const handleCopy = () => {
    if (!formatted) return;
    navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span
      className={`inline-flex items-center gap-1 group relative ${formatted ? 'cursor-pointer' : 'cursor-default'} ${className}`}
      title={formatted ? 'Click để copy SĐT' : ''}
      onClick={handleCopy}
    >
      {showIcon && <span>📞</span>}
      <span className={`${formatted ? 'group-hover:text-blue-400 transition-colors' : 'text-gray-600'}`}>
        {display}
      </span>
      {/* Clipboard icon – hiện khi hover */}
      {formatted && (
        <svg
          className="opacity-0 group-hover:opacity-60 transition-opacity flex-shrink-0"
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      )}
      {/* Tooltip "Đã copy" */}
      {copied && (
        <span className="absolute -top-7 left-1/2 -translate-x-1/2 bg-gray-900 text-green-400 text-[11px] px-2 py-0.5 rounded shadow whitespace-nowrap z-50 pointer-events-none">
          ✓ Đã copy
        </span>
      )}
    </span>
  );
}

