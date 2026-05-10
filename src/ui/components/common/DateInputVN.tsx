import React from 'react';
import { useAppStore } from '@/store/appStore';

/**
 * DateInputVN — wrapper cho input[type="date"] và input[type="datetime-local"].
 * - Thêm lang="vi-VN" để Chromium hiển thị đúng dd/mm/yyyy
 * - Tự chọn color-scheme theo theme (light/dark)
 */
interface DateInputVNProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  type?: 'date' | 'datetime-local';
}

export default function DateInputVN({ type = 'date', className = '', style, ...props }: DateInputVNProps) {
  const theme = useAppStore(s => s.theme);
  return (
    <input
      type={type}
      lang="vi-VN"
      className={className}
      style={{ colorScheme: theme === 'light' ? 'light' : 'dark', ...style }}
      {...props}
    />
  );
}
