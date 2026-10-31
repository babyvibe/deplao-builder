/**
 * useEmployeeResync — chế độ nhân viên: tải lại dữ liệu khi kết nối tới BOSS phục hồi.
 *
 * Lỗi REST tạm thời không còn bị biến thành "không có dữ liệu" (DataAccessor trả `success: false`, người gọi giữ
 * dữ liệu cũ) — nhưng dữ liệu cũ đó cần được làm mới khi mạng quay lại. Hook này gọi `callback` khi:
 *  - `RestQueryService.onRecovered` — REST client chuyển từ bị chặn / mất kết nối về kết nối được;
 *  - window event `employee:resync` — main process kết nối lại BOSS / máy thức dậy sau khi ngủ.
 *
 * Hai nguồn thường bắn sát nhau → gộp (debounce ~500 ms) thành MỘT lần gọi. Kích hoạt trong lúc lần trước còn
 * chạy (callback trả Promise) → chạy thêm đúng một lần sau khi xong, không chạy chồng.
 * Chế độ chủ / standalone: không đăng ký gì, không bao giờ gọi `callback`.
 */
import { useEffect, useRef } from 'react';
import RestQueryService from '../../../services/http/RestQueryService';
import { useEmployeeStore } from '../../store/employee/employeeStore';

/** Window event do App bắn sau khi main process kết nối lại BOSS / hệ thống thức dậy. */
export const EMPLOYEE_RESYNC_EVENT = 'employee:resync';
export const EMPLOYEE_RESYNC_DEBOUNCE_MS = 500;

export interface ResyncScheduler {
  /** Yêu cầu tải lại — các yêu cầu trong cửa sổ debounce gộp thành một lần chạy. */
  request(): void;
  /** Huỷ lịch đang chờ và mọi lần chạy bổ sung (lần đang chạy dở vẫn chạy nốt). */
  cancel(): void;
}

/**
 * Lịch tải lại thuần (không React): debounce đuôi `debounceMs`, không chạy chồng — yêu cầu tới khi `run` đang chạy
 * được dồn thành một lần chạy nữa sau khi xong.
 */
export function createResyncScheduler(
  run: () => void | Promise<unknown>,
  debounceMs: number = EMPLOYEE_RESYNC_DEBOUNCE_MS,
): ResyncScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let cancelled = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };

  function fire() {
    timer = null;
    if (cancelled) return;
    if (running) { again = true; return; }
    running = true;
    let pending: unknown;
    try {
      pending = run();
    } catch (err) {
      console.warn('[useEmployeeResync] resync failed:', err);
    }
    Promise.resolve(pending)
      .catch((err) => { console.warn('[useEmployeeResync] resync failed:', err); })
      .finally(() => {
        running = false;
        if (again && !cancelled) {
          again = false;
          schedule();
        }
      });
  }

  return {
    request() {
      if (!cancelled) schedule();
    },
    cancel() {
      cancelled = true;
      again = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Đăng ký `RestQueryService.onRecovered` (API mới) một cách phòng thủ: bản chưa có API thì chỉ còn nguồn
 * window event. Trả hàm huỷ đăng ký.
 */
export function subscribeRestRecovered(cb: () => void): () => void {
  try {
    const service = RestQueryService.getInstance() as unknown as {
      onRecovered?: (listener: () => void) => (() => void) | void;
    };
    if (typeof service?.onRecovered !== 'function') return () => {};
    const unsubscribe = service.onRecovered(cb);
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  } catch {
    return () => {};
  }
}

/**
 * Gọi `callback` (bản mới nhất của lần render gần nhất) mỗi khi kết nối BOSS phục hồi — chỉ ở chế độ nhân viên.
 * Callback nên tự đọc state mới nhất (store.getState()) và chỉ tải lại phần đang hiển thị.
 */
export function useEmployeeResync(
  callback: () => void | Promise<unknown>,
  debounceMs: number = EMPLOYEE_RESYNC_DEBOUNCE_MS,
): void {
  // Selector boolean: chỉ render lại khi đổi chế độ (không subscribe cả employeeStore)
  const isEmployee = useEmployeeStore((s) => s.mode === 'employee');
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!isEmployee) return;
    const scheduler = createResyncScheduler(() => callbackRef.current(), debounceMs);
    const trigger = () => scheduler.request();
    const unsubscribeRecovered = subscribeRestRecovered(trigger);
    window.addEventListener(EMPLOYEE_RESYNC_EVENT, trigger);
    return () => {
      scheduler.cancel();
      unsubscribeRecovered();
      window.removeEventListener(EMPLOYEE_RESYNC_EVENT, trigger);
    };
  }, [isEmployee, debounceMs]);
}

export default useEmployeeResync;
