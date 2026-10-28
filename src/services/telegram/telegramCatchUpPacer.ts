/**
 * Nhịp bù tin Telegram sau khi offline (GetDifference, ChannelDifference, lịch sử kênh TooLong, đồng bộ lại hội thoại,
 * lượt dialog watch). Mỗi tin là vài lệnh SQLite đồng bộ + một event:message; `await handleNewMessage` chỉ nhường
 * microtask nên vài nghìn tin chạy thành MỘT khối trên luồng chính: IPC của giao diện (mở hội thoại, tải tin) phải chờ
 * hết khối. Bộ nhịp cho làm tối đa `sliceMs` rồi nghỉ `restMs` (setTimeout) để IPC, tin realtime, thao tác người dùng
 * chen vào: tốc độ bù tin còn khoảng 60 %, không khối nào dài hơn ~12 ms. Ít tin thì không chậm thêm gì.
 *
 * Một bộ nhịp dùng chung cho mọi tài khoản và mọi vòng bù tin: khi đang nghỉ, mọi vòng cùng chờ (nếu mỗi vòng một bộ
 * thì vòng này nghỉ, vòng kia vẫn làm, luồng chính không được nghỉ).
 */
export const CATCH_UP_SLICE_MS = 12;
export const CATCH_UP_REST_MS = 8;

export type CatchUpPacer = () => Promise<void>;

type PacerOptions = {
  sliceMs?: number;
  restMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const monotonicNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createCatchUpPacer(options: PacerOptions = {}): CatchUpPacer {
  const sliceMs = options.sliceMs ?? CATCH_UP_SLICE_MS;
  const restMs = options.restMs ?? CATCH_UP_REST_MS;
  const now = options.now ?? monotonicNow;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let sliceStart: number | null = null;
  let resting: Promise<void> | null = null;
  return async () => {
    if (resting) return resting;
    const at = now();
    // Lần gọi đầu (hoặc đồng hồ lùi) mở lượt làm mới
    if (sliceStart === null || at < sliceStart) {
      sliceStart = at;
      return;
    }
    if (at - sliceStart < sliceMs) return;
    resting = sleep(restMs).then(() => {
      resting = null;
      sliceStart = now();
    });
    return resting;
  };
}

/** Phần tử của hội thoại đang mở lên trước, giữ nguyên thứ tự trong từng nhóm (thứ tự tin trong một hội thoại không đổi). */
export function focusFirst<T>(items: T[], isFocused: (item: T) => boolean): T[] {
  const focused: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isFocused(item) ? focused : rest).push(item);
  return focused.length && rest.length ? [...focused, ...rest] : items;
}
