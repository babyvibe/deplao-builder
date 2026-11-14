import React from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { tr } from '../../../shared/i18n';

export interface LoadFailedNoticeProps {
  /** E.g. "Không tải được Nhãn Local" (Failed to load Local labels). */
  text: React.ReactNode;
  /** Press "Thử lại" (Retry); if empty, the button is not shown. */
  onRetry?: () => void;
  /** Reloading → lock the button. */
  busy?: boolean;
  className?: string;
}

/**
 * Short load-error notice for the CRM screens (employee mode: lost connection to BOSS): placed where the list would otherwise be empty, or next to the old
 * data being kept. A network error must not look like "không có dữ liệu" (no data).
 */
export function LoadFailedNotice({ text, onRetry, busy, className }: LoadFailedNoticeProps) {
  return (
    <div role="status" className={cn('flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground', className)}>
      <span>{text}</span>
      {onRetry && (
        <Button variant="link" size="sm" className="text-xs" onClick={onRetry} disabled={busy}>{tr('Thử lại')}</Button>
      )}
    </div>
  );
}

export default LoadFailedNotice;
