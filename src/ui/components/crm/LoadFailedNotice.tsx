import React from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface LoadFailedNoticeProps {
  /** Vd "Không tải được Nhãn Local". */
  text: React.ReactNode;
  /** Bấm "Thử lại" — bỏ trống thì không hiện nút. */
  onRetry?: () => void;
  /** Đang tải lại → khoá nút. */
  busy?: boolean;
  className?: string;
}

/**
 * Báo lỗi tải gọn cho các màn CRM (chế độ nhân viên: mất kết nối BOSS) — đặt ở chỗ danh sách lẽ ra trống, hoặc cạnh dữ
 * liệu cũ đang được giữ lại. Lỗi mạng không được trông như "không có dữ liệu".
 */
export function LoadFailedNotice({ text, onRetry, busy, className }: LoadFailedNoticeProps) {
  return (
    <div role="status" className={cn('flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground', className)}>
      <span>{text}</span>
      {onRetry && (
        <Button variant="link" size="sm" className="text-xs" onClick={onRetry} disabled={busy}>Thử lại</Button>
      )}
    </div>
  );
}

export default LoadFailedNotice;
