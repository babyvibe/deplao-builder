/**
 * catchUpProtocol.ts: the catch-up protocol between Boss and employees over Socket.IO (pure part, shared by both sides).
 *
 * Wire (backward compatible: each side ignores unknown fields / events):
 *   Boss → employee   'event'    { seqId, channel, data, bootId }   (old Boss: no bootId)
 *   Boss → employee   'seq'      { bootId, seqId }                  a "sent everything up to seqId" mark for employees with few events
 *   employee → Boss   'catch-up' { proto: 2, lastSeqId, bootId, sinceTs? } + ack(CatchUpResult)
 *                                 (old client: { lastSeqId }, no ack)
 *
 * Boss (planCatchUp):
 *  - new client, same bootId, buffer still covers lastSeqId → replays the events AFTER lastSeqId that the employee may receive
 *    (≤ maxEvents, over the limit → reset);
 *  - different bootId (Boss restarted) → reset 'boss-restart'; the buffer has trimmed past the client's position
 *    (oldestSeqId > lastSeqId + 1) / the client is ahead of Boss / too many events → reset 'catchup-gap';
 *    reset = nothing is replayed, ack { mode: 'reset', bootId, headSeqId } → the client jumps to headSeqId and resyncs everything;
 *  - new connection (no position yet) → only replays events from `sinceTs` (Boss time when the employee registered through the heartbeat:
 *    covers the gap between loading REST and joining the room) or the latest FRESH_WINDOW; the whole buffer is no longer sent;
 *  - old client (no ack, does not understand reset) → as before (seqId > lastSeqId) but FILTERED per employee and only sends the
 *    newest legacyMaxEvents events; a new connection from an old client → the FRESH_WINDOW.
 * Employee (trackEnvelope / applyCatchUpResult): stores { bootId, lastSeqId }; an old Boss that does not ack → as before +
 *  resync on reconnect ('catchup-unverified').
 */
import type { EmployeeResyncReason } from '../../shared/employee/employeeConnection';
import type { BufferedEvent, CollectResult, CollectSinceTsResult } from './EventBuffer';

export const CATCH_UP_PROTOCOL = 2;

/** Reset reason returned by Boss; the employee side reports the same reason in employee:resync. */
export type CatchUpResetReason = Extract<EmployeeResyncReason, 'boss-restart' | 'catchup-gap'>;
export type CatchUpMode = 'replay' | 'fresh' | 'reset';

/** 'event' envelope (old Boss: no bootId; instant events such as typing: no seqId). */
export interface EventEnvelope {
  seqId?: number;
  channel: string;
  data: any;
  bootId?: string;
}

/** 'seq': every event for this employee with seqId <= seqId has been sent before this mark. */
export interface SeqWatermark {
  bootId: string;
  seqId: number;
}

export interface CatchUpRequest {
  proto: number;
  lastSeqId: number;
  bootId: string | null;
  /** Boss time (ms): only used when there is no position yet (new connection). */
  sinceTs?: number;
}

export interface CatchUpResult {
  proto: number;
  mode: CatchUpMode;
  reason?: CatchUpResetReason;
  bootId: string;
  /** Boss's latest seqId when it replied: the client is at this point after catch-up. */
  headSeqId: number;
  replayed: number;
}

export interface CatchUpLimits {
  /** New client: maximum number of events to replay; over the limit → reset 'catchup-gap' (a resync is cheaper than sending thousands of events). */
  maxEvents: number;
  /** Old client (cannot resync): only sends this many of the NEWEST events. */
  legacyMaxEvents: number;
  /** New connection without sinceTs: replays the events within this window. */
  freshWindowMs: number;
  /** A sinceTs older than this is clamped. */
  freshMaxLookbackMs: number;
}

export const DEFAULT_CATCH_UP_LIMITS: Readonly<CatchUpLimits> = Object.freeze({
  maxEvents: 500,
  legacyMaxEvents: 1000,
  freshWindowMs: 30_000,
  freshMaxLookbackMs: 5 * 60_000,
});

/** Boss sends a 'seq' mark to an employee after this many consecutive events were skipped (keeps the position of employees with few events near the head). */
export const SEQ_WATERMARK_EVERY = 250;

/** The employee waits at most this long for the catch-up ack; after that it is treated as an old Boss build (or the network is too slow). */
export const CATCH_UP_ACK_TIMEOUT_MS = 10_000;

const MAX_BOOT_ID_LENGTH = 128;

function toSeq(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toBootId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= MAX_BOOT_ID_LENGTH ? id : null;
}

function toTs(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── Boss ───────────────────────────────────────────────────────────

/** Reads the 'catch-up' payload from the client (new or old): the client data is not trusted. */
export function parseCatchUpRequest(payload: unknown): CatchUpRequest {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const proto = toSeq(p.proto) || 1;
  const sinceTs = toTs(p.sinceTs);
  return {
    proto,
    lastSeqId: toSeq(p.lastSeqId),
    bootId: toBootId(p.bootId),
    ...(sinceTs !== undefined ? { sinceTs } : {}),
  };
}

/** The part of EventBuffer that planCatchUp needs (EventBuffer satisfies it). */
export interface CatchUpBuffer<A> {
  readonly bootId: string;
  readonly headSeqId: number;
  readonly oldestSeqId: number;
  collectAfter(afterSeqId: number, accept: (event: BufferedEvent<A>) => boolean, limit: number, newest?: boolean): CollectResult<A>;
  collectSinceTs(sinceTs: number, accept: (event: BufferedEvent<A>) => boolean, limit: number, newest?: boolean): CollectSinceTsResult<A>;
}

export interface CatchUpPlan<A> {
  /** New client (sends an ack): receives `result` through the ack. */
  modern: boolean;
  mode: CatchUpMode | 'legacy';
  reason?: CatchUpResetReason;
  /** Replayed events, in seqId order. */
  events: BufferedEvent<A>[];
  /** Old client: some older events were dropped for exceeding legacyMaxEvents. */
  truncated: boolean;
  /** Returned through the ack (new client); null for an old client. */
  result: CatchUpResult | null;
  request: CatchUpRequest;
}

/**
 * Time mark (Boss time) where replay starts for a new connection: the client's sinceTs (not later than `now`) or the latest
 * freshWindowMs window. null = the mark is older than freshMaxLookbackMs → nothing is replayed, the client must resync.
 */
export function freshReplaySince(sinceTs: number | undefined, now: number, limits: CatchUpLimits = DEFAULT_CATCH_UP_LIMITS): number | null {
  const since = sinceTs === undefined ? now - limits.freshWindowMs : Math.min(now, sinceTs);
  return since < now - limits.freshMaxLookbackMs ? null : since;
}

/**
 * Catch-up decision for one socket. `accept` = whether this employee may receive the event (relayAudience).
 * `hasAck` = the client sent an ack (new client).
 */
export function planCatchUp<A>(
  payload: unknown,
  hasAck: boolean,
  buffer: CatchUpBuffer<A>,
  accept: (event: BufferedEvent<A>) => boolean,
  now: number,
  limits: CatchUpLimits = DEFAULT_CATCH_UP_LIMITS,
): CatchUpPlan<A> {
  const request = parseCatchUpRequest(payload);
  const bootId = buffer.bootId;
  const headSeqId = buffer.headSeqId;

  if (!hasAck) {
    // Old client: position by seqId as before. The new stream's seqIds are larger than all old ones, so a lastSeqId from before the restart
    // still receives the full new stream. lastSeqId > head (clock set back...) → the stream is unclear → send the whole buffer.
    const L = request.lastSeqId;
    const legacy = L <= 0
      ? buffer.collectSinceTs(now - limits.freshWindowMs, accept, limits.legacyMaxEvents, true)
      : buffer.collectAfter(L > headSeqId ? 0 : L, accept, limits.legacyMaxEvents, true);
    return { modern: false, mode: 'legacy', events: legacy.events, truncated: legacy.overflow, result: null, request };
  }

  const reset = (reason: CatchUpResetReason): CatchUpPlan<A> => ({
    modern: true,
    mode: 'reset',
    reason,
    events: [],
    truncated: false,
    result: { proto: CATCH_UP_PROTOCOL, mode: 'reset', reason, bootId, headSeqId, replayed: 0 },
    request,
  });
  const done = (mode: 'replay' | 'fresh', events: BufferedEvent<A>[]): CatchUpPlan<A> => ({
    modern: true,
    mode,
    events,
    truncated: false,
    result: { proto: CATCH_UP_PROTOCOL, mode, bootId, headSeqId, replayed: events.length },
    request,
  });

  if (!request.bootId) {
    // Has a position but no bootId: the position of an old Boss build (before the upgrade) → cannot be verified
    if (request.lastSeqId > 0) return reset('boss-restart');
    const since = freshReplaySince(request.sinceTs, now, limits);
    if (since === null) return reset('catchup-gap');
    const fresh = buffer.collectSinceTs(since, accept, limits.maxEvents);
    if (fresh.overflow || !fresh.complete) return reset('catchup-gap');
    return done('fresh', fresh.events);
  }
  if (request.bootId !== bootId) return reset('boss-restart');
  if (request.lastSeqId > headSeqId) return reset('catchup-gap');
  // Events between (lastSeqId, oldestSeqId) were trimmed from the buffer → this employee may have missed some
  if (buffer.oldestSeqId > request.lastSeqId + 1) return reset('catchup-gap');
  const replay = buffer.collectAfter(request.lastSeqId, accept, limits.maxEvents);
  if (replay.overflow) return reset('catchup-gap');
  return done('replay', replay.events);
}

/** Envelope sent for one buffered event. */
export function toEnvelope<A>(event: BufferedEvent<A>, bootId: string): EventEnvelope {
  return { seqId: event.seqId, channel: event.channel, data: event.data, bootId };
}

// ── Employee ──────────────────────────────────────────────────────

/** The employee's catch-up position: the stream (Boss bootId, null = unknown / old Boss) + the last seqId received. */
export interface ClientSyncState {
  bootId: string | null;
  lastSeqId: number;
}

export function initialClientSyncState(): ClientSyncState {
  return { bootId: null, lastSeqId: 0 };
}

/** No position yet (new connection). */
export function isFreshClientState(state: ClientSyncState): boolean {
  return !state.bootId && state.lastSeqId <= 0;
}

/** The 'catch-up' payload of a new client. sinceTs is only sent when there is no position yet. */
export function buildCatchUpRequest(state: ClientSyncState, sinceTs?: number): CatchUpRequest {
  const ts = toTs(sinceTs);
  return {
    proto: CATCH_UP_PROTOCOL,
    lastSeqId: toSeq(state.lastSeqId),
    bootId: state.bootId,
    ...(ts !== undefined && isFreshClientState(state) ? { sinceTs: ts } : {}),
  };
}

export interface TrackResult {
  state: ClientSyncState;
  /** Envelope without bootId → old Boss build. */
  legacy: boolean;
  /** The old position no longer makes sense (the stream changed unexpectedly): a resync is advised. */
  streamChanged: boolean;
}

/** Updates the position when an 'event' is received (the event is still always forwarded as before). */
export function trackEnvelope(state: ClientSyncState, envelope: unknown): TrackResult {
  const env = envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : {};
  const seq = toSeq(env.seqId);
  const bootId = toBootId(env.bootId);

  if (!bootId) {
    // Old Boss build: tracks the max seqId as before. Currently on a new Boss stream → switch the reference frame.
    if (state.bootId !== null) {
      return { state: { bootId: null, lastSeqId: seq }, legacy: true, streamChanged: true };
    }
    return { state: seq > state.lastSeqId ? { bootId: null, lastSeqId: seq } : state, legacy: true, streamChanged: false };
  }
  // Instant events (no seqId) do not change the position
  if (seq <= 0) return { state, legacy: false, streamChanged: false };
  if (state.bootId === bootId) {
    return { state: seq > state.lastSeqId ? { bootId, lastSeqId: seq } : state, legacy: false, streamChanged: false };
  }
  if (state.bootId === null) {
    // New connection (replay before the ack) → accept this stream. Holding the position of an old Boss → that position is meaningless.
    return { state: { bootId, lastSeqId: seq }, legacy: false, streamChanged: state.lastSeqId > 0 };
  }
  // A different stream that the ack has not reported (does not happen when Boss follows the protocol) → accept the new stream, resync needed
  return { state: { bootId, lastSeqId: seq }, legacy: false, streamChanged: true };
}

/** A 'seq' mark in the same stream → moves the position forward (never back). */
export function trackWatermark(state: ClientSyncState, watermark: unknown): ClientSyncState {
  const wm = watermark && typeof watermark === 'object' ? (watermark as Record<string, unknown>) : {};
  const bootId = toBootId(wm.bootId);
  if (!bootId || bootId !== state.bootId) return state;
  const seq = toSeq(wm.seqId);
  return seq > state.lastSeqId ? { bootId, lastSeqId: seq } : state;
}

/** Reads Boss's ack; null if invalid. */
export function parseCatchUpResult(value: unknown): CatchUpResult | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const bootId = toBootId(r.bootId);
  const mode: CatchUpMode | null = r.mode === 'replay' ? 'replay' : r.mode === 'fresh' ? 'fresh' : r.mode === 'reset' ? 'reset' : null;
  if (!bootId || !mode) return null;
  const reason: CatchUpResetReason | undefined = r.reason === 'boss-restart' ? 'boss-restart' : r.reason === 'catchup-gap' ? 'catchup-gap' : undefined;
  return {
    proto: toSeq(r.proto) || CATCH_UP_PROTOCOL,
    mode,
    ...(mode === 'reset' ? { reason: reason ?? 'catchup-gap' } : {}),
    bootId,
    headSeqId: toSeq(r.headSeqId),
    replayed: toSeq(r.replayed),
  };
}

export interface ApplyCatchUpResult {
  state: ClientSyncState;
  /** Resync reason (Boss reset); null = catch-up is complete. */
  resync: CatchUpResetReason | null;
  /** false = invalid ack (position kept as is). */
  valid: boolean;
}

/** Applies the catch-up ack (arrives AFTER the replayed events): reset → jump to head + resync; otherwise → stay at head. */
export function applyCatchUpResult(state: ClientSyncState, value: unknown): ApplyCatchUpResult {
  const result = parseCatchUpResult(value);
  if (!result) return { state, resync: null, valid: false };
  if (result.mode === 'reset') {
    return { state: { bootId: result.bootId, lastSeqId: result.headSeqId }, resync: result.reason ?? 'catchup-gap', valid: true };
  }
  const position = state.bootId === result.bootId ? state.lastSeqId : 0;
  return { state: { bootId: result.bootId, lastSeqId: Math.max(position, result.headSeqId) }, resync: null, valid: true };
}
