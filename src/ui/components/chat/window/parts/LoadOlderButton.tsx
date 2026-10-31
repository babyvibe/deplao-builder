/**
 * Nút "Tải tin nhắn cũ hơn" trên tin đầu: đang tải lâu, lỗi (Thử lại), hoặc đã biết chắc còn tin cũ.
 */
import { Spinner } from '@/components/common/PageLoading';
import type { MessageListState } from '../hooks/useMessageListState';
import type { OlderMessages } from '../hooks/useOlderMessages';

type LoadOlderButtonProps = Pick<MessageListState, 'loadingMore' | 'loadError'> & Pick<OlderMessages, 'handleLoadMore'>;

export function LoadOlderButton({ handleLoadMore, loadError, loadingMore }: LoadOlderButtonProps) {
  return (
    <div className="flex justify-center py-3 mb-2">
      <button
        onClick={handleLoadMore}
        disabled={loadingMore}
        className={`text-xs px-4 py-2 rounded-full shadow-md transition-all disabled:opacity-50 flex items-center gap-2 ${
          loadError
            ? 'bg-red-800 text-red-200 hover:bg-red-700'
            : 'bg-muted text-foreground hover:bg-accent hover:scale-105'
        }`}
      >
        {loadingMore ? (
          <>
            <Spinner size={3} />
            <span>Đang tải...</span>
          </>
        ) : loadError ? (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Lỗi - Thử lại</span>
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
            <span>Tải tin nhắn cũ hơn</span>
          </>
        )}
      </button>
    </div>
  );
}
