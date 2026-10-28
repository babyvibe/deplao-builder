/**
 * Tin bù sau khi offline (Telegram difference / lịch sử kênh, tin cũ tải lại) đổ về giao diện thành nghìn event:message
 * liền nhau: mỗi tin một lượt cập nhật store + vẽ lại danh sách hội thoại (log 28/10/2026: "Giao diện bận 14.3 s" lúc mở
 * app sau 1 ngày). Tin im lặng của hội thoại KHÔNG đang mở được gom lại, xử lý sau ≤ `delayMs`, mỗi task ≤ `sliceMs`
 * (React vẽ một lần cho cả phần, giữa các phần vẫn nhận thao tác của người dùng). Hội thoại đang mở và tin thường xử lý
 * ngay, sau khi xử lý hết tin đang chờ, nên thứ tự tin không đổi.
 */
export const CATCH_UP_DELAY_MS = 250;
export const CATCH_UP_SLICE_MS = 8;

export type CatchUpBatcher<T> = {
  /** Xếp vào hàng chờ. */
  defer: (item: T) => void;
  /** Xử lý ngay mọi tin đang chờ, đúng thứ tự (trước tin cần xử lý ngay, trước sự kiện sửa / xoá / cảm xúc). */
  flush: () => void;
  /** Xử lý nốt tin đang chờ rồi ngừng nhận. */
  close: () => void;
  size: () => number;
};

type BatcherOptions = {
  delayMs?: number;
  sliceMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
};

export function createCatchUpBatcher<T>(process: (item: T) => void, options: BatcherOptions = {}): CatchUpBatcher<T> {
  const delayMs = options.delayMs ?? CATCH_UP_DELAY_MS;
  const sliceMs = options.sliceMs ?? CATCH_UP_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  const onError = options.onError ?? ((err: unknown) => console.error('[catchUpEventBatcher]', err));
  let queue: T[] = [];
  let head = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const pending = () => queue.length - head;
  const takeNext = (): T => {
    const item = queue[head++];
    if (head === queue.length) {
      queue = [];
      head = 0;
    }
    return item;
  };
  const runOne = (item: T) => {
    try {
      process(item);
    } catch (err) {
      onError(err);
    }
  };
  const schedule = (ms: number) => {
    if (timer === null && pending() > 0) timer = setTimeout(drainSlice, ms);
  };
  function drainSlice() {
    timer = null;
    const start = now();
    while (pending() > 0) {
      runOne(takeNext());
      if (now() - start >= sliceMs) break;
    }
    schedule(0);
  }
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    while (pending() > 0) runOne(takeNext());
  };

  return {
    defer(item) {
      if (closed) {
        runOne(item);
        return;
      }
      queue.push(item);
      schedule(delayMs);
    },
    flush,
    close() {
      closed = true;
      flush();
    },
    size: pending,
  };
}

/** event:message gom được: tin im lặng (bù sau khi offline / tin cũ), không phải của mình, không thuộc hội thoại đang mở. */
export function isDeferrableCatchUpMessage(
  data: any,
  active: { accountId?: string | null; threadId?: string | null },
): boolean {
  const message = data?.message;
  if (!message || message.isSelf === true) return false;
  if (message._silentNotification !== true && message._silent !== true) return false;
  const threadId = String(message.threadId || '');
  if (!threadId) return false;
  return !(threadId === String(active.threadId || '') && String(data?.zaloId || '') === String(active.accountId || ''));
}
