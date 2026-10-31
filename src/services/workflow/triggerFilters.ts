/**
 * triggerFilters.ts
 *
 * Pure helpers cho các bộ lọc trigger / audience mở rộng của Workflow Engine.
 * KHÔNG import Electron, DB hay zca-js → dùng được trong main process và unit-test trực tiếp
 * (src/__tests__/workflow/workflowTriggerFilters.test.ts).
 *
 * Mọi khoá cấu hình đều tuỳ chọn: khi vắng / rỗng / ở giá trị trung tính, bộ lọc KHÔNG có tác dụng
 * → workflow cũ chạy y như trước.
 *
 *  - ID list (excludeSenderIds / excludeThreadIds / excludeIds): JSON array từ contact picker
 *    '["1","2"]', một id '1234', danh sách cách nhau bởi dấu phẩy / xuống dòng, hoặc array thật.
 *    Bộ lọc trigger đọc config THÔ (chưa render template) → mục chứa "{{" bị bỏ qua.
 *  - Active hours: { mode: 'always' | 'inside' | 'outside', start: 'HH:mm', end: 'HH:mm', days: number[] }
 *    tính theo giờ Việt Nam (UTC+7, không DST); days theo getDay(): 0 = Chủ nhật … 6 = Thứ 7.
 *  - senderRole: 'all' | 'owner' | 'deputy' | 'admins' | 'members'.
 *  - cooldownMinutes: số phút ≥ 0 (0 = tắt).
 */

export type ZaloGroupRole = 'owner' | 'deputy' | 'member';

export type ActiveHoursMode = 'always' | 'inside' | 'outside';

export interface ActiveHoursConfig {
  mode?: ActiveHoursMode;
  start?: string;
  end?: string;
  days?: number[];
}

/** Các nhóm loại tin nhắn Zalo mà bộ lọc messageTypes hỗ trợ. */
export const ZALO_MESSAGE_KINDS = ['text', 'image', 'sticker', 'file', 'voice', 'video', 'link', 'other'] as const;
export type ZaloMessageKind = typeof ZALO_MESSAGE_KINDS[number];

// ─── ID list ──────────────────────────────────────────────────────────────────

const ID_SEPARATORS = /[,;\r\n]+/;
const TEMPLATE_SEGMENT = /\{\{[\s\S]*?\}\}/g;

function idFromEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'number') return Number.isFinite(entry) ? String(entry) : '';
  if (typeof entry === 'bigint') return entry.toString();
  if (entry && typeof entry === 'object') {
    // Phòng hờ mảng object (vd items của logic.forEachContact): { id | threadId | userId | uid }
    const obj = entry as Record<string, unknown>;
    const id = obj.id ?? obj.threadId ?? obj.userId ?? obj.uid;
    return typeof id === 'string' || typeof id === 'number' ? String(id).trim() : '';
  }
  return '';
}

function splitIdText(text: string): string[] {
  return text
    // Đoạn {{ ... }} có thể chứa dấu phẩy → giữ nguyên cả đoạn để mục đó bị bỏ qua trọn vẹn
    .replace(TEMPLATE_SEGMENT, segment => segment.replace(/[,;\r\n]/g, ' '))
    .split(ID_SEPARATORS)
    // JSON hỏng / có số trần ('[1, "2"') → bỏ ngoặc vuông và dấu nháy bao quanh từng mục
    .map(token => token.trim().replace(/^[\s["']+|[\s\]"']+$/g, ''));
}

function collectIdEntries(value: unknown, depth: number): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(idFromEntry);
  if (typeof value === 'number' || typeof value === 'bigint') return [idFromEntry(value)];
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  // Chỉ JSON.parse khi trông như array / chuỗi JSON: uid Zalo ~19 chữ số sẽ mất chính xác
  // nếu bị parse thành number ('8123456789012345678' → 8123456789012345000).
  if (depth < 2 && (text.startsWith('[') || text.startsWith('"'))) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && !parsed.some(item => typeof item === 'number')) return parsed.map(idFromEntry);
      if (typeof parsed === 'string') return collectIdEntries(parsed, depth + 1);
    } catch {
      /* không phải JSON hợp lệ → tách theo dấu phân cách bên dưới */
    }
  }
  return splitIdText(text);
}

/**
 * Chuẩn hoá một "ID list" về mảng id (chuỗi đã trim, không rỗng, không trùng, giữ thứ tự).
 * Nhận: JSON array '["1","2"]', một id '1234', '1, 2' / '1\n2', array thật, '' / undefined.
 * Mục chứa "{{" (template chưa render) bị bỏ qua.
 */
export function parseIdList(value: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of collectIdEntries(value, 0)) {
    if (!id || id.includes('{{') || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** true khi `id` (so sánh dạng chuỗi đã trim) nằm trong ID list `list`. id rỗng → false. */
export function isExcludedId(list: unknown, id: unknown): boolean {
  if (id === null || id === undefined) return false;
  const needle = String(id).trim();
  if (!needle) return false;
  return parseIdList(list).includes(needle);
}

// ─── Active hours ─────────────────────────────────────────────────────────────

const VN_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const STRICT_HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:mm' (00:00–23:59, đúng 2 chữ số giờ) → số phút trong ngày; sai định dạng → null. */
function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = STRICT_HH_MM.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** days → tập 0..6; vắng / rỗng / không có giá trị hợp lệ → null (= mọi ngày). */
function parseActiveDays(value: unknown): Set<number> | null {
  if (!Array.isArray(value)) return null;
  const days = new Set<number>();
  for (const item of value) {
    const day = typeof item === 'number' ? item : (typeof item === 'string' && item.trim() !== '' ? Number(item) : NaN);
    if (Number.isInteger(day) && day >= 0 && day <= 6) days.add(day);
  }
  return days.size > 0 ? days : null;
}

/**
 * true khi trigger ĐƯỢC PHÉP kích hoạt tại thời điểm `nowMs`.
 *  - cfg vắng / không hợp lệ / mode 'always' / giờ sai định dạng → true (không lọc).
 *  - 'inside'  → chỉ khi now ∈ [start, end) vào một ngày được chọn.
 *  - 'outside' → chỉ khi KHÔNG thuộc khung đó.
 * start > end: khung qua nửa đêm, thuộc về ngày bắt đầu (T2 22:00–06:00 = T2 22:00 → T3 06:00).
 * start === end: cả ngày.
 */
export function isWithinActiveHours(cfg: unknown, nowMs: number): boolean {
  let config: unknown = cfg;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return true; }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return true;
  const { mode, start, end, days } = config as Record<string, unknown>;
  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (normalizedMode !== 'inside' && normalizedMode !== 'outside') return true;
  const startMin = parseClockMinutes(start);
  const endMin = parseClockMinutes(end);
  if (startMin === null || endMin === null) return true;

  const allowedDays = parseActiveDays(days);
  const isDayAllowed = (day: number) => !allowedDays || allowedDays.has(day);

  // Giờ Việt Nam tính số học từ epoch, không phụ thuộc timezone của máy
  const vnNow = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + VN_UTC_OFFSET_MS);
  const today = vnNow.getUTCDay();
  const minuteOfDay = vnNow.getUTCHours() * 60 + vnNow.getUTCMinutes();

  let inWindow: boolean;
  if (startMin === endMin) {
    inWindow = isDayAllowed(today);
  } else if (startMin < endMin) {
    inWindow = isDayAllowed(today) && minuteOfDay >= startMin && minuteOfDay < endMin;
  } else if (minuteOfDay >= startMin) {
    inWindow = isDayAllowed(today);                 // phần trước nửa đêm của khung hôm nay
  } else if (minuteOfDay < endMin) {
    inWindow = isDayAllowed((today + 6) % 7);       // phần sau nửa đêm của khung hôm qua
  } else {
    inWindow = false;
  }
  return normalizedMode === 'inside' ? inWindow : !inWindow;
}

// ─── Zalo message type ────────────────────────────────────────────────────────

const ZALO_MSG_TYPE_KIND = new Map<string, ZaloMessageKind>([
  ['webchat', 'text'],
  ['chat.photo', 'image'], ['photo', 'image'], ['image', 'image'], ['chat.gif', 'image'],
  ['chat.sticker', 'sticker'], ['sticker', 'sticker'],
  ['share.file', 'file'],
  ['chat.voice', 'voice'], ['voice', 'voice'], ['audio', 'voice'],
  ['chat.video.msg', 'video'], ['video', 'video'],
  ['share.link', 'link'], ['chat.link', 'link'],
]);

/** content.action của tin chat.recommended (object hoặc chuỗi JSON). */
function recommendedAction(content: unknown): string {
  let value: unknown = content;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return ''; }
  }
  const action = value && typeof value === 'object' ? (value as { action?: unknown }).action : undefined;
  return typeof action === 'string' ? action.trim().toLowerCase() : '';
}

/** msgData.msgType của zca-js → text | image | sticker | file | voice | video | link | other. */
export function classifyZaloMessageType(msgType: unknown, content: unknown): ZaloMessageKind {
  const type = msgType === null || msgType === undefined ? '' : String(msgType).trim().toLowerCase();
  // chat.recommended chở cả liên kết, danh thiếp (recommened.user / .vip) và nhật ký cuộc gọi
  // (recommened.calltime / .misscall) → chỉ là "link" khi action là link
  if (type === 'chat.recommended' || type === 'chat.recommend') {
    const action = recommendedAction(content);
    return action === 'recommened.link' || action === 'recommended.link' ? 'link' : 'other';
  }
  if (type) return ZALO_MSG_TYPE_KIND.get(type) ?? 'other';
  // Payload không có msgType (sự kiện cũ / relay): nội dung dạng chuỗi = tin văn bản
  return typeof content === 'string' ? 'text' : 'other';
}

/** messageTypes của config → mảng loại (lowercase, không trùng); rỗng / 'all' = không lọc. */
export function normalizeMessageTypes(value: unknown): string[] {
  const types = parseIdList(value).map(type => type.toLowerCase());
  return types.includes('all') ? [] : [...new Set(types)];
}

// ─── Mentions ─────────────────────────────────────────────────────────────────

/**
 * true khi danh sách mentions (TMention[] của zca-js) @nhắc tài khoản `accountId`
 * hoặc @All (type === 1 hoặc uid === '-1').
 */
export function mentionsAccount(mentions: unknown, accountId: string): boolean {
  let list: unknown = mentions;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return false; }
  }
  if (!Array.isArray(list)) return false;
  const self = accountId === null || accountId === undefined ? '' : String(accountId).trim();
  return list.some(item => {
    if (!item || typeof item !== 'object') return false;
    const mention = item as Record<string, unknown>;
    const uid = mention.uid === null || mention.uid === undefined ? '' : String(mention.uid).trim();
    if (Number(mention.type) === 1 || uid === '-1') return true;   // @All
    return self !== '' && uid === self;
  });
}

// ─── Sender role ──────────────────────────────────────────────────────────────

function normalizeSenderRole(senderRole: unknown): string {
  return typeof senderRole === 'string' ? senderRole.trim().toLowerCase() : '';
}

/** true khi senderRole có tác dụng (khác vắng / rỗng / 'all') → cần tra vai trò, tin cá nhân bị loại. */
export function hasSenderRoleFilter(senderRole: unknown): boolean {
  const role = normalizeSenderRole(senderRole);
  return role !== '' && role !== 'all';
}

/** Chuẩn hoá uid Zalo: trim + bỏ hậu tố phiên bản "_0" ("123_0" → "123") như getGroupInfo đôi khi trả về. */
export function normalizeZaloUid(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/_\d+$/, '');
}

/** Vai trò của người gửi trong nhóm: creatorId → owner, adminIds → deputy, còn lại → member. */
export function resolveZaloGroupRole(senderId: unknown, creatorId: unknown, adminIds: readonly unknown[] | null | undefined): ZaloGroupRole {
  const sender = normalizeZaloUid(senderId);
  if (!sender) return 'member';
  if (sender === normalizeZaloUid(creatorId)) return 'owner';
  return (adminIds || []).some(id => normalizeZaloUid(id) === sender) ? 'deputy' : 'member';
}

/**
 * Ma trận vai trò: all → mọi vai trò; owner → trưởng nhóm; deputy → phó nhóm;
 * admins → trưởng hoặc phó; members → thành viên thường. Giá trị lạ → không khớp.
 */
export function isRoleAllowed(role: ZaloGroupRole, senderRole: string): boolean {
  switch (normalizeSenderRole(senderRole)) {
    case '':
    case 'all': return true;
    case 'owner': return role === 'owner';
    case 'deputy': return role === 'deputy';
    case 'admins': return role === 'owner' || role === 'deputy';
    case 'members': return role === 'member';
    default: return false;
  }
}

// ─── Cooldown ─────────────────────────────────────────────────────────────────

/** cooldownMinutes → mili giây; vắng / ≤ 0 / không phải số → 0 (tắt). */
export function parseCooldownMs(value: unknown): number {
  const minutes = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60 * 1000) : 0;
}

/** true khi lần chạy gần nhất (`lastRunAt`) còn nằm trong cooldown tại `nowMs`. */
export function isCooldownActive(lastRunAt: number | undefined, nowMs: number, cooldownMs: number): boolean {
  if (lastRunAt === undefined || !(cooldownMs > 0)) return false;
  return nowMs - lastRunAt < cooldownMs;
}
