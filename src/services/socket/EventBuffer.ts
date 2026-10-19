/**
 * EventBuffer - Ring buffer lưu event gần nhất để catch-up khi employee reconnect (Boss side, phần thuần).
 *
 * Mỗi lần relay khởi động (mở app, bật lại relay, đổi workspace) là MỘT luồng (stream) mới:
 * - `bootId` ngẫu nhiên — gắn vào mọi envelope + bắt tay catch-up → nhân viên biết Boss đã khởi động lại
 *   (event trong lúc relay tắt không được buffer → không phát lại được, phải resync).
 * - `seqId` liên tiếp, bắt đầu từ `thời điểm bắt đầu (ms) × 1000` thay vì 1 → luồng sau luôn có seqId LỚN hơn luồng
 *   trước. Bản nhân viên CŨ (không biết bootId, chỉ nhớ lastSeqId) vì thế vẫn nhận event của luồng mới khi catch-up,
 *   thay vì không nhận gì cho tới khi chuỗi số mới vượt số cũ.
 * - Mỗi event lưu MỘT lần kèm `audience` (ai được nhận — relayAudience.ts); catch-up lọc theo từng nhân viên.
 *   (Trước đây event được push một lần cho MỖI nhân viên, không ghi người nhận.)
 * - seqId trong buffer liên tiếp (chỉ cắt ở đầu) → vị trí của một seqId tính O(1), không filter / copy cả buffer.
 *   Event lưu theo tham chiếu (không clone).
 */
import { randomUUID } from 'crypto';

export interface BufferedEvent<A = unknown> {
  seqId: number;
  channel: string;
  data: any;
  /** Date.now() của Boss lúc buffer. */
  ts: number;
  /** Ai được nhận — buffer không diễn giải (SocketIOService dùng RelayAudience). */
  audience: A;
}

export interface CollectResult<A = unknown> {
  /** Theo thứ tự seqId tăng dần. */
  events: BufferedEvent<A>[];
  /** Số event khớp vượt `limit` (events chỉ giữ `limit` event). */
  overflow: boolean;
}

export interface CollectSinceTsResult<A = unknown> extends CollectResult<A> {
  /** false = buffer đã cắt bớt event có thể nằm trong khoảng thời gian yêu cầu (không chắc đủ). */
  complete: boolean;
}

export interface EventBufferOptions {
  /** Số event tối đa giữ lại (mặc định DEFAULT_EVENT_BUFFER_SIZE). */
  maxSize?: number;
  /** Đồng hồ (test). */
  now?: () => number;
  /** Sinh bootId (test). */
  createBootId?: () => string;
}

export const DEFAULT_EVENT_BUFFER_SIZE = 5000;
export const MIN_EVENT_BUFFER_SIZE = 1;
export const MAX_EVENT_BUFFER_SIZE = 50_000;
/** seqId đầu tiên của một luồng = thời điểm bắt đầu (ms) × hệ số này + 1 (Number an toàn tới năm ~2255). */
export const SEQ_BASE_MULTIPLIER = 1000;

export function createBootId(): string {
  return randomUUID();
}

/** seqId đầu tiên của luồng bắt đầu lúc `startedAtMs` — luồng bắt đầu sau luôn lớn hơn. */
export function seqBaseFor(startedAtMs: number): number {
  const ms = Number.isFinite(startedAtMs) && startedAtMs > 0 ? Math.floor(startedAtMs) : 0;
  const base = ms * SEQ_BASE_MULTIPLIER + 1;
  return Number.isSafeInteger(base) ? base : 1;
}

function clampSize(size: number): number {
  const n = Number.isFinite(size) ? Math.floor(size) : DEFAULT_EVENT_BUFFER_SIZE;
  return Math.max(MIN_EVENT_BUFFER_SIZE, Math.min(n, MAX_EVENT_BUFFER_SIZE));
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

class EventBuffer<A = unknown> {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly makeBootId: () => string;

  /** Ring: phần tử logic i nằm ở ring[(start + i) % capacity]. */
  private ring: Array<BufferedEvent<A> | undefined> = [];
  private start = 0;
  private count = 0;

  private currentBootId = '';
  private nextSeqId = 1;
  private prunedCount = 0;

  constructor(options: EventBufferOptions = {}) {
    this.capacity = clampSize(options.maxSize ?? DEFAULT_EVENT_BUFFER_SIZE);
    this.now = options.now ?? Date.now;
    this.makeBootId = options.createBootId ?? createBootId;
    this.reset();
  }

  /** Id của luồng hiện tại (đổi mỗi lần reset). */
  get bootId(): string {
    return this.currentBootId;
  }

  /** seqId của event mới nhất (chưa có event nào: seqId đầu tiên - 1). */
  get headSeqId(): number {
    return this.nextSeqId - 1;
  }

  /**
   * seqId cũ nhất còn trong buffer (buffer rỗng: seqId kế tiếp). Client có lastSeqId >= oldestSeqId - 1 thì
   * phát lại được đủ; nhỏ hơn → đã có event bị cắt khỏi buffer.
   */
  get oldestSeqId(): number {
    return this.count > 0 ? this.at(0).seqId : this.nextSeqId;
  }

  /** Số event hiện tại trong buffer. */
  get size(): number {
    return this.count;
  }

  /** Số event tối đa giữ lại. */
  get maxSize(): number {
    return this.capacity;
  }

  /** Số event đã bị loại bỏ do buffer đầy (trong luồng hiện tại). */
  get totalPruned(): number {
    return this.prunedCount;
  }

  /** Thêm event (lưu tham chiếu `data`, không clone) — trả event đã đánh số. */
  push(channel: string, data: any, audience: A): BufferedEvent<A> {
    const event: BufferedEvent<A> = { seqId: this.nextSeqId++, channel, data, ts: this.now(), audience };
    if (this.count < this.capacity) {
      this.ring[(this.start + this.count) % this.capacity] = event;
      this.count++;
    } else {
      // Đầy → ghi đè event cũ nhất
      this.ring[this.start] = event;
      this.start = (this.start + 1) % this.capacity;
      this.prunedCount++;
    }
    return event;
  }

  /**
   * Event có seqId > afterSeqId mà `accept` cho qua, tối đa `limit` event.
   * newest=false: `limit` event CŨ nhất (overflow = còn nữa); newest=true: `limit` event MỚI nhất.
   */
  collectAfter(
    afterSeqId: number,
    accept: (event: BufferedEvent<A>) => boolean,
    limit: number,
    newest = false,
  ): CollectResult<A> {
    const after = Number.isFinite(afterSeqId) ? Math.floor(afterSeqId) : 0;
    const fromIndex = Math.max(0, Math.min(this.count, after + 1 - this.oldestSeqId));
    return this.collectFrom(fromIndex, accept, limit, newest);
  }

  /**
   * Event buffer lúc ts >= sinceTs (giờ Boss) mà `accept` cho qua. ts không giảm (trừ khi đồng hồ chỉnh lùi)
   * → quét ngược từ event mới nhất, chỉ chạm phần cần lấy.
   */
  collectSinceTs(
    sinceTs: number,
    accept: (event: BufferedEvent<A>) => boolean,
    limit: number,
    newest = false,
  ): CollectSinceTsResult<A> {
    const since = Number.isFinite(sinceTs) ? sinceTs : 0;
    let fromIndex = this.count;
    while (fromIndex > 0 && this.at(fromIndex - 1).ts >= since) fromIndex--;
    // Gặp event cũ hơn mốc → đủ; quét hết buffer mà đã từng cắt bớt → event trong khoảng có thể đã mất
    const complete = fromIndex > 0 || this.prunedCount === 0;
    return { ...this.collectFrom(fromIndex, accept, limit, newest), complete };
  }

  /** Bắt đầu luồng mới: bootId mới, seqId mới (lớn hơn luồng cũ), xoá buffer. */
  reset(): void {
    this.ring = [];
    this.start = 0;
    this.count = 0;
    this.prunedCount = 0;
    this.currentBootId = this.makeBootId();
    // seqId luồng mới phải lớn hơn mọi seqId đã phát (kể cả khi đồng hồ chỉnh lùi trong cùng tiến trình)
    this.nextSeqId = Math.max(seqBaseFor(this.now()), this.nextSeqId);
  }

  private at(index: number): BufferedEvent<A> {
    return this.ring[(this.start + index) % this.capacity] as BufferedEvent<A>;
  }

  private collectFrom(
    fromIndex: number,
    accept: (event: BufferedEvent<A>) => boolean,
    limit: number,
    newest: boolean,
  ): CollectResult<A> {
    const max = clampLimit(limit);
    const events: BufferedEvent<A>[] = [];
    if (!newest) {
      for (let i = fromIndex; i < this.count; i++) {
        const event = this.at(i);
        if (!accept(event)) continue;
        if (events.length >= max) return { events, overflow: true };
        events.push(event);
      }
      return { events, overflow: false };
    }
    let overflow = false;
    for (let i = this.count - 1; i >= fromIndex; i--) {
      const event = this.at(i);
      if (!accept(event)) continue;
      if (events.length >= max) {
        overflow = true;
        break;
      }
      events.push(event);
    }
    events.reverse();
    return { events, overflow };
  }
}

export default EventBuffer;
