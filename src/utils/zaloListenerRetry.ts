/**
 * Kết nối lại websocket Zalo như Zalo Web: zca-js `listener.start({ retryOnClose: true })` (zca-js#386). Zalo PC đăng
 * nhập / đăng xuất làm Zalo đóng kết nối của Zalo Web và zca-js; Zalo Web tự nối lại ngay trên cùng phiên, Deplao trước
 * đây đợi 5 s rồi đăng nhập lại cả phiên bằng cookie (tối đa 5 lần rồi bỏ).
 *
 * zca-js tự thử lại theo cấu hình Zalo gửi về (`settings.features.socket.close_and_retry_codes` + `retries`): đóng kết
 * nối → "disconnected" → (mã được thử lại) hẹn giờ `start()` lại; hết lượt / mã không thử lại → "closed". Không sửa
 * zca-js, chỉ gắn vào đúng đối tượng listener:
 * - `canRetry`: chỉ cho thử lại khi Deplao còn dùng listener này (chưa ngắt tay, tài khoản chưa xoá, kết nối chưa bị
 *   phiên đăng nhập mới thay). Không thì zca-js phát "closed" như cũ.
 * - `start`: lần thử lại đã hẹn trước khi ngắt / thay kết nối thì bỏ, không để listener cũ nối lại (tin về hai lần).
 * - Kết nối lại được thì trả lại lượt thử (zca-js không bao giờ đếm lại, phiên chạy lâu sẽ hết lượt).
 */
export interface ZaloListenerRetryGuard {
  /** Đã kết nối lại: trả lại lượt thử của mọi mã đóng. */
  resetRetryBudget(): void;
}

export function installZaloListenerRetryGuard(listener: any, options: {
  /** Deplao còn dùng listener này không */
  allowRetry: () => boolean;
  /** Lần thử lại bị chặn (listener cũ) */
  onBlocked?: () => void;
}): ZaloListenerRetryGuard {
  const originalCanRetry = listener?.canRetry;
  const originalStart = listener?.start;
  if (typeof originalCanRetry === 'function') {
    listener.canRetry = function guardedCanRetry(this: any, code: number) {
      if (!options.allowRetry()) return false;
      return originalCanRetry.call(this, code);
    };
  }
  if (typeof originalStart === 'function') {
    let started = false;
    listener.start = function guardedStart(this: any, ...args: any[]) {
      // Lần đầu do Deplao gọi; các lần sau là zca-js tự thử lại
      if (started && !options.allowRetry()) {
        options.onBlocked?.();
        return undefined;
      }
      started = true;
      return originalStart.apply(this, args);
    };
  }
  return {
    resetRetryBudget() {
      const counts = listener?.retryCount;
      if (!counts || typeof counts !== 'object') return;
      for (const key of Object.keys(counts)) {
        if (counts[key] && typeof counts[key].count === 'number') counts[key].count = 0;
      }
    },
  };
}

/** Mã đóng, lượt thử, thời gian chờ Zalo cấu hình cho phiên này (ghi nhật ký để biết mã nào được tự nối lại). */
export function describeZaloSocketRetry(api: any): string {
  try {
    const socket = api?.getContext?.()?.settings?.features?.socket;
    if (!socket) return 'không có cấu hình socket';
    const codes = Array.isArray(socket.close_and_retry_codes) ? socket.close_and_retry_codes.join(',') : '-';
    const retries = socket.retries && typeof socket.retries === 'object'
      ? Object.entries(socket.retries).map(([code, value]: [string, any]) => {
        const times = Array.isArray(value?.times) ? value.times.join('/') : value?.times;
        return `${code}:${value?.max ?? 0}x(${times ?? '-'}ms)`;
      }).join(' ')
      : '-';
    return `close_and_retry_codes=[${codes}] retries=${retries}`;
  } catch {
    return 'không đọc được cấu hình socket';
  }
}
