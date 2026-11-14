/**
 * EventBuffer: ring buffer that keeps the most recent events so employees can catch up when they reconnect (Boss side, pure part).
 *
 * Every time the relay starts (app opened, relay turned on again, workspace switched) is ONE new stream:
 * - a random `bootId`: attached to every envelope + in the catch-up handshake → an employee knows Boss has restarted
 *   (events while the relay was off are not buffered → they cannot be replayed, a resync is needed).
 * - consecutive `seqId`, starting from `start time (ms) × 1000` instead of 1 → a later stream always has a LARGER seqId than the
 *   previous one. An OLD employee build (does not know bootId, only remembers lastSeqId) therefore still receives the new stream's events on catch-up,
 *   instead of receiving nothing until the new numbers pass the old ones.
 * - Each event is stored ONCE with its `audience` (who may receive it: relayAudience.ts); catch-up filters per employee.
 *   (Previously an event was pushed once for EACH employee, without recording the recipient.)
 * - seqIds in the buffer are consecutive (trimmed only at the front) → the position of a seqId is computed in O(1), no filtering / copying of the whole buffer.
 *   Events are stored by reference (not cloned).
 */
import { randomUUID } from 'crypto';

export interface BufferedEvent<A = unknown> {
  seqId: number;
  channel: string;
  data: any;
  /** Boss's Date.now() when buffered. */
  ts: number;
  /** Who may receive it: the buffer does not interpret it (SocketIOService uses RelayAudience). */
  audience: A;
}

export interface CollectResult<A = unknown> {
  /** In ascending seqId order. */
  events: BufferedEvent<A>[];
  /** Number of matching events beyond `limit` (events only keeps `limit` events). */
  overflow: boolean;
}

export interface CollectSinceTsResult<A = unknown> extends CollectResult<A> {
  /** false = the buffer has trimmed events that may fall within the requested time range (not certain to be complete). */
  complete: boolean;
}

export interface EventBufferOptions {
  /** Maximum number of events kept (default DEFAULT_EVENT_BUFFER_SIZE). */
  maxSize?: number;
  /** Clock (for tests). */
  now?: () => number;
  /** Sinh bootId (test). */
  createBootId?: () => string;
}

export const DEFAULT_EVENT_BUFFER_SIZE = 5000;
export const MIN_EVENT_BUFFER_SIZE = 1;
export const MAX_EVENT_BUFFER_SIZE = 50_000;
/** First seqId of a stream = start time (ms) × this factor + 1 (Number is safe until around the year 2255). */
export const SEQ_BASE_MULTIPLIER = 1000;

export function createBootId(): string {
  return randomUUID();
}

/** First seqId of a stream that starts at `startedAtMs`: a stream that starts later always has a larger one. */
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

  /** Ring: logical element i is at ring[(start + i) % capacity]. */
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

  /** Id of the current stream (changes on every reset). */
  get bootId(): string {
    return this.currentBootId;
  }

  /** seqId of the latest event (no events yet: the first seqId - 1). */
  get headSeqId(): number {
    return this.nextSeqId - 1;
  }

  /**
   * Oldest seqId still in the buffer (empty buffer: the next seqId). A client with lastSeqId >= oldestSeqId - 1 can be
   * fully replayed; a smaller value → some events have been trimmed from the buffer.
   */
  get oldestSeqId(): number {
    return this.count > 0 ? this.at(0).seqId : this.nextSeqId;
  }

  /** Current number of events in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Maximum number of events kept. */
  get maxSize(): number {
    return this.capacity;
  }

  /** Number of events dropped because the buffer was full (in the current stream). */
  get totalPruned(): number {
    return this.prunedCount;
  }

  /** Adds an event (stores a reference to `data`, no clone) and returns the numbered event. */
  push(channel: string, data: any, audience: A): BufferedEvent<A> {
    const event: BufferedEvent<A> = { seqId: this.nextSeqId++, channel, data, ts: this.now(), audience };
    if (this.count < this.capacity) {
      this.ring[(this.start + this.count) % this.capacity] = event;
      this.count++;
    } else {
      // Full → overwrite the oldest event
      this.ring[this.start] = event;
      this.start = (this.start + 1) % this.capacity;
      this.prunedCount++;
    }
    return event;
  }

  /**
   * Events with seqId > afterSeqId that `accept` lets through, at most `limit` events.
   * newest=false: the `limit` OLDEST events (overflow = more remain); newest=true: the `limit` NEWEST events.
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
   * Buffered events with ts >= sinceTs (Boss time) that `accept` lets through. ts does not decrease (unless the clock is set back)
   * → scans backwards from the newest event, touching only the part that is needed.
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
    // Reached an event older than the mark → enough; scanned the whole buffer and it had been trimmed before → events in the range may be lost
    const complete = fromIndex > 0 || this.prunedCount === 0;
    return { ...this.collectFrom(fromIndex, accept, limit, newest), complete };
  }

  /** Starts a new stream: new bootId, new seqId (larger than the old stream), clears the buffer. */
  reset(): void {
    this.ring = [];
    this.start = 0;
    this.count = 0;
    this.prunedCount = 0;
    this.currentBootId = this.makeBootId();
    // The new stream's seqId must be larger than every seqId already sent (even if the clock was set back within the same process)
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
