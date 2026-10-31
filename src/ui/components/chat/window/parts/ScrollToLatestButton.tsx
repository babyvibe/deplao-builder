/**
 * Nút nổi góc dưới: cuộn xuống tin mới nhất, hoặc "Về tin nhắn mới nhất" khi đang xem tin cũ (nhảy tới tin).
 */
import { Spinner } from '@/components/common/PageLoading';
import type { MessageListState } from '../hooks/useMessageListState';
import type { JumpToMessage } from '../hooks/useJumpToMessage';

type ScrollToLatestButtonProps = Pick<MessageListState, 'bottomRef' | 'isViewingHistory' | 'loadingLatest'> & Pick<JumpToMessage, 'handleReturnToLatest'>;

export function ScrollToLatestButton({ bottomRef, handleReturnToLatest, isViewingHistory, loadingLatest }: ScrollToLatestButtonProps) {
  return (
    <div className="absolute bottom-4 right-4 z-30 pointer-events-none">
      <button
        onClick={isViewingHistory ? handleReturnToLatest : () => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
        disabled={loadingLatest}
        title={isViewingHistory ? 'Về tin nhắn mới nhất' : 'Cuộn xuống tin mới nhất'}
        aria-label={isViewingHistory ? 'Về tin nhắn mới nhất' : 'Cuộn xuống tin mới nhất'}
        className={`pointer-events-auto flex items-center justify-center rounded-full transition-[color,background-color,box-shadow,transform] duration-150 active:scale-95 disabled:opacity-60 ${
          isViewingHistory
            ? 'h-9 gap-1.5 pl-3 pr-3.5 bg-primary hover:bg-primary-hover text-primary-foreground text-[13px] font-medium shadow-[0_6px_16px_-4px_rgba(31,107,242,0.55),0_1px_3px_rgba(15,31,61,0.15)] dark:shadow-[0_6px_18px_-4px_rgba(0,0,0,0.65),0_1px_3px_rgba(0,0,0,0.5)]'
            : 'w-10 h-10 bg-card dark:bg-muted text-muted-foreground border border-border hover:text-primary hover:-translate-y-px shadow-[0_6px_16px_-6px_rgba(15,31,61,0.28),0_1px_3px_rgba(15,31,61,0.10)] hover:shadow-[0_10px_22px_-8px_rgba(15,31,61,0.32),0_2px_4px_rgba(15,31,61,0.10)] dark:shadow-[0_6px_18px_-6px_rgba(0,0,0,0.7),0_1px_3px_rgba(0,0,0,0.45)] dark:hover:shadow-[0_10px_24px_-8px_rgba(0,0,0,0.75),0_2px_4px_rgba(0,0,0,0.45)]'
        }`}
      >
        {loadingLatest ? (
          <Spinner size={4} />
        ) : isViewingHistory ? (
          <>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="4" x2="12" y2="18"/>
              <polyline points="6 12 12 18 18 12"/>
            </svg>
            <span>Về tin nhắn mới nhất</span>
          </>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9.5 12 15.5 18 9.5"/>
          </svg>
        )}
      </button>
    </div>
  );
}
