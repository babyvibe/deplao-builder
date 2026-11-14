import React from 'react';
import { useAppStore } from '@/store/app/appStore';

/**
 * DateInputVN - wrapper for input[type="date"] and input[type="datetime-local"].
 * - Adds lang="vi-VN" so Chromium shows dd/mm/yyyy correctly
 * - Picks color-scheme from the theme automatically (light/dark)
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
