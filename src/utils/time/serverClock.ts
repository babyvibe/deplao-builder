/**
 * Giờ server ước lượng (main process). Máy tính hay chạy lệch vài giây so với giờ chuẩn — máy của chủ dự án nhanh 6,4 s
 * (đo bằng w32tm ngày 22/10/2026). Tin nhận mang giờ server, còn tin gửi từ Deplao trước đây đóng dấu bằng giờ máy, nên
 * khách trả lời ngay trong vài giây bị xếp TRƯỚC tin mình vừa gửi (Telegram Desktop tự bù độ lệch nên vẫn đúng thứ tự).
 *
 * Tin gửi đi luôn dùng giờ server nền tảng trả về (Telegram `date`, Facebook `timestamp`); module này là dự phòng khi
 * nền tảng không trả + ghi Nhật ký khi đồng hồ máy lệch. Độ lệch (giờ server − giờ máy) chỉ học từ tin MÌNH gửi có giờ
 * server: lúc gửi ≤ giờ server ≤ lúc có kết quả → một khoảng [cận dưới, cận trên]; lấy giao các khoảng trong 15 phút gần
 * nhất. Không học từ tin nhận: tin tải bù / kết nối lại đến trễ hàng phút làm ước lượng sai mà không phát hiện được.
 */
import Logger from '../Logger';

/** Lệch quá mức này coi là dữ liệu sai đơn vị (giây ↔ mili-giây) — bỏ qua. */
const MAX_ABS_OFFSET_MS = 60 * 60_000;
const WINDOW_MS = 15 * 60_000;
const MAX_SAMPLES = 128;
/** Lệch từ mức này ghi Nhật ký (tối đa 1 lần / 6 giờ). */
export const CLOCK_SKEW_WARN_MS = 2_000;
const WARN_INTERVAL_MS = 6 * 60 * 60_000;

interface Sample { at: number; lower: number; upper: number }

export interface ServerClock {
  /**
   * Tin mình gửi có giờ server trả về: bắt đầu gửi lúc `sentAt`, có kết quả lúc `ackAt` (giờ máy); giờ server làm tròn
   * xuống `precisionMs` (Telegram chỉ có giây → 1000).
   */
  noteSent(serverMs: number, sentAt: number, ackAt: number, precisionMs?: number): void;
  /** Độ lệch giờ server − giờ máy (ms); null khi chưa có mốc. */
  offsetMs(): number | null;
  /** Giờ server ước lượng (ms) — chưa có mốc thì là giờ máy. */
  now(): number;
}

export function createServerClock(clock: () => number = () => Date.now()): ServerClock {
  let samples: Sample[] = [];
  let lastWarnAt = 0;

  const valid = (value: number) => Number.isFinite(value) && value > 0;

  /** Giao các khoảng còn trong cửa sổ; khoảng mới mâu thuẫn với phần giao cũ (đồng hồ máy vừa chỉnh) → bỏ mốc cũ. */
  const bounds = (now: number): { lower: number; upper: number } | null => {
    samples = samples.filter(sample => now - sample.at <= WINDOW_MS);
    let lower = -Infinity;
    let upper = Infinity;
    for (let i = samples.length - 1; i >= 0; i--) {
      const nextLower = Math.max(lower, samples[i].lower);
      const nextUpper = Math.min(upper, samples[i].upper);
      if (nextLower > nextUpper) {
        samples = samples.slice(i + 1);
        break;
      }
      lower = nextLower;
      upper = nextUpper;
    }
    return samples.length ? { lower, upper } : null;
  };

  const estimate = (now: number): number | null => {
    const range = bounds(now);
    return range ? Math.round((range.lower + range.upper) / 2) : null;
  };

  return {
    noteSent(serverMs, sentAt, ackAt, precisionMs = 1) {
      if (!valid(serverMs) || !valid(sentAt) || !valid(ackAt) || ackAt < sentAt) return;
      const lower = serverMs - ackAt;
      const upper = serverMs + Math.max(1, precisionMs) - sentAt;
      if (Math.abs(lower) > MAX_ABS_OFFSET_MS || Math.abs(upper) > MAX_ABS_OFFSET_MS) return;
      samples.push({ at: ackAt, lower, upper });
      if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);

      const range = bounds(ackAt);
      if (!range) return;
      const offset = Math.round((range.lower + range.upper) / 2);
      // Chỉ báo khi chắc: cả khoảng đều lệch quá ngưỡng (không phải do khoảng còn rộng)
      const sure = Math.min(Math.abs(range.lower), Math.abs(range.upper)) >= CLOCK_SKEW_WARN_MS
        && Math.sign(range.lower) === Math.sign(range.upper);
      if (!sure || ackAt - lastWarnAt < WARN_INTERVAL_MS) return;
      lastWarnAt = ackAt;
      const seconds = (Math.abs(offset) / 1000).toFixed(1).replace('.', ',');
      Logger.warn(
        `[Đồng hồ] Đồng hồ máy tính đang ${offset < 0 ? 'nhanh' : 'chậm'} khoảng ${seconds} giây so với giờ server. `
        + 'Deplao ghi giờ tin nhắn theo giờ server; bật "Đặt giờ tự động" rồi bấm "Đồng bộ ngay" trong Cài đặt Windows '
        + '(Thời gian & ngôn ngữ → Ngày & giờ) để giờ hiển thị khớp các app khác trên máy.',
      );
    },
    offsetMs() {
      return estimate(clock());
    },
    now() {
      const now = clock();
      return now + (estimate(now) ?? 0);
    },
  };
}

/** Đồng hồ chung của main process. */
export const serverClock = createServerClock();

/** Giây (Telegram / Bot API `date`) → ms; không hợp lệ → null. */
export function secondsToMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 1e9 && n < 1e11 ? Math.floor(n) * 1000 : null;
}

/**
 * Giờ server (ms) của tin Telegram vừa gửi từ kết quả GramJS: Api.Message.date, UpdateShortSentMessage.date hoặc tin
 * trong Updates (`updates[].message.date`). Không có → null.
 */
export function telegramSentDateMs(result: unknown): number | null {
  const value: any = result;
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const ms = telegramSentDateMs(item);
      if (ms) return ms;
    }
    return null;
  }
  if (Array.isArray(value.updates)) {
    for (const update of value.updates) {
      const ms = secondsToMs(update?.message?.date);
      if (ms) return ms;
    }
  }
  return secondsToMs(value.date);
}

/**
 * Mốc thời gian lưu cho tin Telegram (user / bot) vừa gửi: giờ server trong kết quả (đồng thời ghi nhận độ lệch đồng hồ
 * khi biết lúc bắt đầu gửi), không có thì giờ server ước lượng. Không dùng giờ máy: máy nhanh vài giây thì khách trả
 * lời ngay bị xếp trước tin này.
 */
export function telegramSentTimestamp(result: unknown, sentAt?: number, ackAt: number = Date.now()): number {
  const serverMs = telegramSentDateMs(result);
  if (serverMs === null) return serverClock.now();
  if (sentAt) serverClock.noteSent(serverMs, sentAt, ackAt, 1000);
  return serverMs;
}
