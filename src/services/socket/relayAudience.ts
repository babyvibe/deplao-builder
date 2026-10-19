/**
 * relayAudience.ts — ai được nhận một event realtime Boss → nhân viên (phần thuần, test được).
 *
 * Dùng chung cho phát trực tiếp (SocketIOService.publish) và phát lại khi kết nối lại (catch-up): cùng một quy tắc,
 * cùng nguồn "tài khoản được giao" với kiểm tra quyền REST (RegisteredEmployee.assigned_accounts ở HttpRelayService,
 * giữ đồng bộ bởi updateEmployeeRooms). Trước đây catch-up gửi cả buffer (mọi tài khoản, mọi nhân viên) cho client.
 *
 * classifyRelayEvent → RelayAudience:
 *  - accounts  — event mang id tài khoản (zaloId / ownerZaloId / accountId…): chỉ nhân viên được giao tài khoản đó.
 *                Nhân viên chưa được giao tài khoản nào → không nhận (giống REST: mọi tài khoản đều 403).
 *  - employees — event gửi đích danh: ERP lịch + nhắc lịch (người tổ chức / người tham gia), ghi chú (tác giả / người
 *                được chia sẻ), thông báo ERP (recipient_id). Danh sách rỗng → chỉ Boss ('boss' — không phải nhân viên).
 *  - global    — dữ liệu chung của workspace, an toàn cho mọi nhân viên: GLOBAL_RELAY_CHANNELS, ghi chú ERP phạm vi
 *                workspace, và event KHÔNG mang id tài khoản ở các kênh cấu hình (vd db:localQuickMessageChanged
 *                active/reorder, relay:*…).
 *  - nobody    — kênh chat / CRM / Facebook (ACCOUNT_REQUIRED_PREFIXES) hoặc dữ liệu hội thoại theo tài khoản
 *                (ACCOUNT_REQUIRED_CHANNELS) nhưng thiếu id tài khoản → không gửi ai (không lộ sang tài khoản khác).
 * Danh sách kênh được relay: relayChannels.ts.
 */

/** Id "người dùng" của Boss trong ERP (ErpAuthContext) — không bao giờ là employee_id của nhân viên. */
export const BOSS_ACTOR_ID = 'boss';

export type RelayAudience =
  | { kind: 'global' }
  | { kind: 'nobody' }
  | { kind: 'accounts'; accountIds: readonly string[] }
  | { kind: 'employees'; employeeIds: readonly string[] };

const GLOBAL: RelayAudience = { kind: 'global' };
const NOBODY: RelayAudience = { kind: 'nobody' };

/**
 * Kênh dữ liệu chung của workspace — mọi nhân viên đang kết nối đều nhận (kể cả khi payload có id tài khoản).
 * ERP: dự án / công việc / bình luận / nghỉ phép / chấm công / phòng ban / hồ sơ nhân sự là dữ liệu cấp workspace
 * của module ERP (như trước, không lọc theo tài khoản).
 */
export const GLOBAL_RELAY_CHANNELS: ReadonlySet<string> = new Set([
  'db:localLabelChanged', // định nghĩa nhãn dùng chung (bảng local_labels không theo tài khoản)
  'workflow:executed', // trạng thái chạy / lưu workflow
  'workflow:changed', // danh sách workflow đổi (chỉ id + hành động) — mỗi máy tự tải lại danh sách đã lọc theo quyền
  // integration:payment / integration:webhook: không còn relay (chỉ trigger workflow trên Boss) — relayChannels.ts
  'erp:event:projectCreated',
  'erp:event:projectUpdated',
  'erp:event:projectDeleted',
  'erp:event:taskCreated',
  'erp:event:taskUpdated',
  'erp:event:taskDeleted',
  'erp:event:commentAdded',
  'erp:event:leaveCreated',
  'erp:event:leaveDecided',
  'erp:event:attendanceUpdated',
  'erp:event:departmentUpdated',
  'erp:event:employeeProfileUpdated',
  'erp:event:employeeProfileDeleted',
]);

/** Kênh chat / CRM / Facebook luôn thuộc MỘT tài khoản — thiếu id tài khoản thì không gửi ai (an toàn hơn gửi tất cả). */
export const ACCOUNT_REQUIRED_PREFIXES: readonly string[] = ['event:', 'crm:', 'fb:'];

/**
 * Kênh cấu hình (db:*, library:*) nhưng dữ liệu là của MỘT hội thoại / tài khoản: nơi phát quên id tài khoản thì không
 * gửi ai (trước đây rơi vào "global" → mọi nhân viên nhận ghim / cờ / bí danh / xoá hội thoại của tài khoản khác).
 * Không gồm db:localQuickMessageChanged (active/reorder chỉ có id), db:localLabelChanged (dùng chung).
 * library:itemUpdated: LibraryService.updateItem gửi zaloId = trang sở hữu item (trước đây không có → mọi nhân viên).
 */
export const ACCOUNT_REQUIRED_CHANNELS: ReadonlySet<string> = new Set([
  'db:localLabelThreadChanged',
  'db:pinnedMessageChanged',
  'db:pinnedConversationChanged',
  'db:starredMessageChanged',
  'db:contactFlagsChanged',
  'db:contactAliasChanged',
  'db:contactProfileUpdated',
  'db:conversationDeleted',
  'db:unreadChanged',
  'library:itemAdded',
  'library:itemUpdated',
  'library:itemDeleted',
]);

/**
 * Kênh chỉ có ý nghĩa tức thời — phát trực tiếp nhưng KHÔNG buffer / phát lại: "đang soạn tin" phát lại sau khi kết nối
 * lại chỉ hiện chỉ báo sai, và đây là event dày nhất (đẩy event thật ra khỏi buffer).
 */
export const EPHEMERAL_RELAY_CHANNELS: ReadonlySet<string> = new Set([
  'event:typing',
  'fb:onTyping',
  // Online / lần cuối truy cập (Telegram): giá trị cũ phát lại sau khi kết nối lại chỉ gây sai lệch
  'event:userPresence',
  // Thông điệp điều khiển gửi riêng một nhân viên: chỉ phát trực tiếp. Phát lại sau khi kết nối lại là sai
  // ("kicked" sẽ đá nhân viên vừa đăng nhập lại) hoặc thừa (client tự làm mới snapshot khi resync).
  'relay:kicked',
  'relay:accountAccessUpdate',
  'relay:initialState',
  'relay:permissionUpdate',
]);

export function isEphemeralRelayChannel(channel: string): boolean {
  return EPHEMERAL_RELAY_CHANNELS.has(channel);
}

/**
 * Tên field mang id tài khoản trong payload event (Zalo / Facebook / Telegram đều lưu ở accounts.zalo_id).
 * fbAccountId: event fb:* (FacebookService.getFacebookId() = accounts.zalo_id của tài khoản Facebook).
 */
export const RELAY_ACCOUNT_FIELDS = ['zaloId', 'zalo_id', 'ownerZaloId', 'owner_zalo_id', 'accountId', 'account_id', 'fbAccountId'] as const;

function nonEmpty(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** Id tài khoản của event ('' nếu không có). event:message bản cũ chỉ có message.zaloId. */
export function relayEventAccountId(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  for (const key of RELAY_ACCOUNT_FIELDS) {
    const id = nonEmpty(record[key]);
    if (id) return id;
  }
  const message = record.message;
  if (message && typeof message === 'object') {
    const nested = message as Record<string, unknown>;
    return nonEmpty(nested.zaloId) || nonEmpty(nested.accountId);
  }
  return '';
}

function uniqueIds(values: unknown[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const id = nonEmpty(value);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Đích danh các nhân viên; không ai → chỉ Boss (giữ nguyên quy tắc cũ `allowed.size === 0 ? id === 'boss'`). */
function employeesAudience(ids: unknown[]): RelayAudience {
  const employeeIds = uniqueIds(ids);
  return { kind: 'employees', employeeIds: employeeIds.length ? employeeIds : [BOSS_ACTOR_ID] };
}

function arrayOf(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/** Người tổ chức + người tham gia của một sự kiện lịch ERP (= ErpCalendarService.getVisibleEmployeeIdsForEvent). */
function calendarParticipants(event: any): unknown[] {
  if (!event || typeof event !== 'object') return [];
  return [event.organizer_id, ...arrayOf(event.attendees).map((attendee: any) => attendee?.employee_id)];
}

/** Gửi một event tới đúng một nhân viên (SocketIOService.emitToEmployee). */
export function addressedAudience(employeeId: string): RelayAudience {
  return employeesAudience([employeeId]);
}

/** Phân loại người nhận của một event relay — xem đầu file. */
export function classifyRelayEvent(channel: string, data: any): RelayAudience {
  const name = String(channel || '');

  // ── ERP: lịch / nhắc lịch — chỉ người tổ chức + người tham gia (quy tắc cũ của HttpRelayService) ──
  if (name.startsWith('erp:event:calendarEvent') || name === 'erp:event:reminder') {
    return employeesAudience([...arrayOf(data?.visibleEmployeeIds), ...calendarParticipants(data?.event)]);
  }

  // ── ERP: ghi chú — phạm vi workspace thì ai cũng nhận; còn lại tác giả + người được xem / chia sẻ ──
  if (name.startsWith('erp:event:note')) {
    const note = data?.note;
    if (note?.share_scope === 'workspace' || data?.scope === 'workspace') return GLOBAL;
    // noteShared (không mang nội dung): phạm vi CŨ là workspace → mọi người từng xem đều nhận để bỏ note khỏi danh sách
    if (name === 'erp:event:noteShared' && data?.previousScope === 'workspace') return GLOBAL;
    return employeesAudience([
      note?.author_id,
      data?.authorId,
      ...arrayOf(data?.visibleEmployeeIds),
      ...arrayOf(data?.shares).map((share: any) => share?.employeeId || share?.employee_id),
    ]);
  }

  // ── ERP: thông báo — gửi đúng người nhận (trước đây mọi nhân viên đều thêm vào hộp thư của mình) ──
  if (name === 'erp:event:notification') {
    return employeesAudience([data?.notification?.recipient_id ?? data?.notification?.recipientId]);
  }

  if (GLOBAL_RELAY_CHANNELS.has(name)) return GLOBAL;

  const accountId = relayEventAccountId(data);
  if (accountId) return { kind: 'accounts', accountIds: [accountId] };

  if (ACCOUNT_REQUIRED_PREFIXES.some((prefix) => name.startsWith(prefix))) return NOBODY;
  if (ACCOUNT_REQUIRED_CHANNELS.has(name)) return NOBODY;
  // Kênh cấu hình không mang id tài khoản (vd db:localQuickMessageChanged active/reorder):
  // chỉ có id + cờ / trường vừa sửa → giữ như trước, gửi mọi nhân viên.
  return GLOBAL;
}

/**
 * Nhân viên `employeeId` (được giao `assignedAccounts`) có được nhận event với audience này không.
 * `assignedAccounts` phải là danh sách hiện hành — cùng nguồn với kiểm tra quyền REST.
 */
export function canReceiveRelayEvent(
  audience: RelayAudience | null | undefined,
  employeeId: string,
  assignedAccounts: readonly string[] | null | undefined,
): boolean {
  if (!audience) return false;
  switch (audience.kind) {
    case 'global':
      return true;
    case 'employees':
      return !!employeeId && audience.employeeIds.includes(String(employeeId));
    case 'accounts': {
      if (!assignedAccounts || assignedAccounts.length === 0) return false;
      return audience.accountIds.some((id) => assignedAccounts.some((assigned) => String(assigned) === id));
    }
    default:
      return false;
  }
}

/** Chuẩn hoá danh sách tài khoản được giao (bỏ rỗng / trùng, ép chuỗi). */
export function normalizeAccountList(value: unknown): string[] {
  return uniqueIds(arrayOf(value));
}
