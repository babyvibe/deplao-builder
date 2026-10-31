/**
 * catchUpProtocol.ts — giao thức catch-up Boss ↔ nhân viên qua Socket.IO (phần thuần, dùng chung hai phía).
 *
 * Wire (tương thích ngược — mỗi phía bỏ qua field / event lạ):
 *   Boss → nhân viên   'event'    { seqId, channel, data, bootId }   (Boss cũ: không có bootId)
 *   Boss → nhân viên   'seq'      { bootId, seqId }                  mốc "đã gửi đủ tới seqId" cho nhân viên ít event
 *   nhân viên → Boss   'catch-up' { proto: 2, lastSeqId, bootId, sinceTs? } + ack(CatchUpResult)
 *                                 (client cũ: { lastSeqId }, không ack)
 *
 * Boss (planCatchUp):
 *  - client mới, cùng bootId, buffer còn phủ lastSeqId → phát lại event SAU lastSeqId mà nhân viên được nhận
 *    (≤ maxEvents, vượt → reset);
 *  - bootId khác (Boss khởi động lại) → reset 'boss-restart'; buffer đã cắt qua vị trí của client
 *    (oldestSeqId > lastSeqId + 1) / client đi trước Boss / quá nhiều → reset 'catchup-gap';
 *    reset = không phát lại, ack { mode: 'reset', bootId, headSeqId } → client nhảy tới headSeqId và resync toàn bộ;
 *  - kết nối mới (chưa có vị trí) → chỉ phát lại event từ `sinceTs` (giờ Boss lúc nhân viên đăng ký qua heartbeat —
 *    phủ khe giữa lúc tải REST và lúc socket vào phòng) hoặc FRESH_WINDOW gần nhất; không còn gửi cả buffer;
 *  - client cũ (không ack, không hiểu reset) → như cũ (seqId > lastSeqId) nhưng LỌC theo nhân viên và chỉ gửi
 *    legacyMaxEvents event mới nhất; kết nối mới của client cũ → cửa sổ FRESH_WINDOW.
 * Nhân viên (trackEnvelope / applyCatchUpResult): lưu { bootId, lastSeqId }; Boss cũ không ack → làm như cũ +
 *  resync nếu là kết nối lại ('catchup-unverified').
 */
import type { EmployeeResyncReason } from '../../shared/employee/employeeConnection';
import type { BufferedEvent, CollectResult, CollectSinceTsResult } from './EventBuffer';

export const CATCH_UP_PROTOCOL = 2;

/** Lý do reset do Boss trả về — cũng là lý do employee:resync phát ra ở nhân viên. */
export type CatchUpResetReason = Extract<EmployeeResyncReason, 'boss-restart' | 'catchup-gap'>;
export type CatchUpMode = 'replay' | 'fresh' | 'reset';

/** Envelope 'event' (Boss cũ: không có bootId; event tức thời như typing: không có seqId). */
export interface EventEnvelope {
  seqId?: number;
  channel: string;
  data: any;
  bootId?: string;
}

/** 'seq' — mọi event dành cho nhân viên này có seqId <= seqId đã được gửi trước mốc này. */
export interface SeqWatermark {
  bootId: string;
  seqId: number;
}

export interface CatchUpRequest {
  proto: number;
  lastSeqId: number;
  bootId: string | null;
  /** Giờ Boss (ms) — chỉ dùng khi chưa có vị trí (kết nối mới). */
  sinceTs?: number;
}

export interface CatchUpResult {
  proto: number;
  mode: CatchUpMode;
  reason?: CatchUpResetReason;
  bootId: string;
  /** seqId mới nhất của Boss lúc trả lời — client đứng ở đây sau catch-up. */
  headSeqId: number;
  replayed: number;
}

export interface CatchUpLimits {
  /** Client mới: tối đa số event phát lại; vượt → reset 'catchup-gap' (resync rẻ hơn gửi hàng nghìn event). */
  maxEvents: number;
  /** Client cũ (không resync được): chỉ gửi ngần này event MỚI nhất. */
  legacyMaxEvents: number;
  /** Kết nối mới không gửi sinceTs: phát lại event trong cửa sổ này. */
  freshWindowMs: number;
  /** sinceTs cũ hơn ngần này được kẹp lại. */
  freshMaxLookbackMs: number;
}

export const DEFAULT_CATCH_UP_LIMITS: Readonly<CatchUpLimits> = Object.freeze({
  maxEvents: 500,
  legacyMaxEvents: 1000,
  freshWindowMs: 30_000,
  freshMaxLookbackMs: 5 * 60_000,
});

/** Boss gửi mốc 'seq' cho nhân viên đã bị bỏ qua ngần này event liên tiếp (giữ vị trí của nhân viên ít event gần đầu). */
export const SEQ_WATERMARK_EVERY = 250;

/** Nhân viên chờ ack catch-up tối đa ngần này; quá → coi là Boss bản cũ (hoặc mạng quá chậm). */
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

/** Đọc payload 'catch-up' từ client (mới hoặc cũ) — không tin dữ liệu client. */
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

/** Phần EventBuffer mà planCatchUp cần (EventBuffer thoả mãn). */
export interface CatchUpBuffer<A> {
  readonly bootId: string;
  readonly headSeqId: number;
  readonly oldestSeqId: number;
  collectAfter(afterSeqId: number, accept: (event: BufferedEvent<A>) => boolean, limit: number, newest?: boolean): CollectResult<A>;
  collectSinceTs(sinceTs: number, accept: (event: BufferedEvent<A>) => boolean, limit: number, newest?: boolean): CollectSinceTsResult<A>;
}

export interface CatchUpPlan<A> {
  /** Client mới (gửi ack) — nhận `result` qua ack. */
  modern: boolean;
  mode: CatchUpMode | 'legacy';
  reason?: CatchUpResetReason;
  /** Event phát lại, theo thứ tự seqId. */
  events: BufferedEvent<A>[];
  /** Client cũ: có event cũ hơn bị bỏ vì vượt legacyMaxEvents. */
  truncated: boolean;
  /** Trả qua ack (client mới); null với client cũ. */
  result: CatchUpResult | null;
  request: CatchUpRequest;
}

/**
 * Mốc thời gian (giờ Boss) bắt đầu phát lại cho kết nối mới: sinceTs của client (không quá `now`) hoặc cửa sổ
 * freshWindowMs gần nhất. null = mốc cũ hơn freshMaxLookbackMs → không phát lại, client phải resync.
 */
export function freshReplaySince(sinceTs: number | undefined, now: number, limits: CatchUpLimits = DEFAULT_CATCH_UP_LIMITS): number | null {
  const since = sinceTs === undefined ? now - limits.freshWindowMs : Math.min(now, sinceTs);
  return since < now - limits.freshMaxLookbackMs ? null : since;
}

/**
 * Quyết định catch-up cho một socket. `accept` = nhân viên này được nhận event không (relayAudience).
 * `hasAck` = client gửi kèm ack (client mới).
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
    // Client cũ: vị trí theo seqId như trước. seqId luồng mới > mọi seqId luồng cũ → lastSeqId của lần khởi động
    // trước vẫn nhận đủ luồng mới. lastSeqId > head (đồng hồ lùi…) → không rõ luồng → gửi cả buffer.
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
    // Có vị trí nhưng không có bootId: vị trí của Boss bản cũ (trước khi nâng cấp) — không đối chiếu được
    if (request.lastSeqId > 0) return reset('boss-restart');
    const since = freshReplaySince(request.sinceTs, now, limits);
    if (since === null) return reset('catchup-gap');
    const fresh = buffer.collectSinceTs(since, accept, limits.maxEvents);
    if (fresh.overflow || !fresh.complete) return reset('catchup-gap');
    return done('fresh', fresh.events);
  }
  if (request.bootId !== bootId) return reset('boss-restart');
  if (request.lastSeqId > headSeqId) return reset('catchup-gap');
  // Event (lastSeqId, oldestSeqId) đã bị cắt khỏi buffer — có thể có event của nhân viên này
  if (buffer.oldestSeqId > request.lastSeqId + 1) return reset('catchup-gap');
  const replay = buffer.collectAfter(request.lastSeqId, accept, limits.maxEvents);
  if (replay.overflow) return reset('catchup-gap');
  return done('replay', replay.events);
}

/** Envelope gửi đi cho một event đã buffer. */
export function toEnvelope<A>(event: BufferedEvent<A>, bootId: string): EventEnvelope {
  return { seqId: event.seqId, channel: event.channel, data: event.data, bootId };
}

// ── Nhân viên ──────────────────────────────────────────────────────

/** Vị trí catch-up của nhân viên: luồng (bootId của Boss, null = chưa biết / Boss cũ) + seqId cuối đã nhận. */
export interface ClientSyncState {
  bootId: string | null;
  lastSeqId: number;
}

export function initialClientSyncState(): ClientSyncState {
  return { bootId: null, lastSeqId: 0 };
}

/** Chưa có vị trí nào (kết nối mới). */
export function isFreshClientState(state: ClientSyncState): boolean {
  return !state.bootId && state.lastSeqId <= 0;
}

/** Payload 'catch-up' của client mới. sinceTs chỉ gửi khi chưa có vị trí. */
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
  /** Envelope không có bootId → Boss bản cũ. */
  legacy: boolean;
  /** Vị trí cũ không còn ý nghĩa (đổi luồng ngoài dự kiến) — nên resync. */
  streamChanged: boolean;
}

/** Cập nhật vị trí khi nhận 'event' (event vẫn luôn được chuyển tiếp như cũ). */
export function trackEnvelope(state: ClientSyncState, envelope: unknown): TrackResult {
  const env = envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : {};
  const seq = toSeq(env.seqId);
  const bootId = toBootId(env.bootId);

  if (!bootId) {
    // Boss bản cũ: theo dõi max seqId như trước. Đang đứng ở luồng của Boss mới → đổi hệ quy chiếu.
    if (state.bootId !== null) {
      return { state: { bootId: null, lastSeqId: seq }, legacy: true, streamChanged: true };
    }
    return { state: seq > state.lastSeqId ? { bootId: null, lastSeqId: seq } : state, legacy: true, streamChanged: false };
  }
  // Event tức thời (không có seqId) không đổi vị trí
  if (seq <= 0) return { state, legacy: false, streamChanged: false };
  if (state.bootId === bootId) {
    return { state: seq > state.lastSeqId ? { bootId, lastSeqId: seq } : state, legacy: false, streamChanged: false };
  }
  if (state.bootId === null) {
    // Kết nối mới (phát lại trước ack) → nhận luồng này. Đang giữ vị trí của Boss cũ → vị trí đó vô nghĩa.
    return { state: { bootId, lastSeqId: seq }, legacy: false, streamChanged: state.lastSeqId > 0 };
  }
  // Luồng khác mà ack chưa báo (không xảy ra khi Boss đúng giao thức) → nhận luồng mới, cần resync
  return { state: { bootId, lastSeqId: seq }, legacy: false, streamChanged: true };
}

/** Mốc 'seq' cùng luồng → tiến vị trí (không lùi). */
export function trackWatermark(state: ClientSyncState, watermark: unknown): ClientSyncState {
  const wm = watermark && typeof watermark === 'object' ? (watermark as Record<string, unknown>) : {};
  const bootId = toBootId(wm.bootId);
  if (!bootId || bootId !== state.bootId) return state;
  const seq = toSeq(wm.seqId);
  return seq > state.lastSeqId ? { bootId, lastSeqId: seq } : state;
}

/** Đọc ack của Boss; null nếu không hợp lệ. */
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
  /** Lý do resync (Boss reset); null = catch-up đủ. */
  resync: CatchUpResetReason | null;
  /** false = ack không hợp lệ (giữ nguyên vị trí). */
  valid: boolean;
}

/** Áp dụng ack catch-up (đến SAU các event phát lại): reset → nhảy tới head + resync; còn lại → đứng ở head. */
export function applyCatchUpResult(state: ClientSyncState, value: unknown): ApplyCatchUpResult {
  const result = parseCatchUpResult(value);
  if (!result) return { state, resync: null, valid: false };
  if (result.mode === 'reset') {
    return { state: { bootId: result.bootId, lastSeqId: result.headSeqId }, resync: result.reason ?? 'catchup-gap', valid: true };
  }
  const position = state.bootId === result.bootId ? state.lastSeqId : 0;
  return { state: { bootId: result.bootId, lastSeqId: Math.max(position, result.headSeqId) }, resync: null, valid: true };
}
