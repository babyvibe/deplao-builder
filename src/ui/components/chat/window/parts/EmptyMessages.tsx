/**
 * Hội thoại chưa có tin nào.
 */
import { ChatIcon } from '@/components/common/icons';

export function EmptyMessages() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 opacity-60">
      <div className="text-3xl mb-3"><ChatIcon className="w-4 h-4" /></div>
      <p className="text-muted-foreground text-sm font-medium">Chưa có tin nhắn nào</p>
      <p className="text-muted-foreground text-xs mt-1 max-w-xs">
        Tin nhắn chỉ hiển thị từ lúc kết nối. Hãy gửi tin nhắn mới để bắt đầu.
      </p>
    </div>
  );
}
