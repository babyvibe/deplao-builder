/**
 * relayChannels.ts — hợp đồng kênh realtime Boss → nhân viên (phần thuần, dùng chung Boss + nhân viên + test).
 *
 * Một nguồn cho cả hai phía (trước đây Boss có RELAY_CHANNELS, nhân viên có FORWARD_CHANNELS riêng → 8 kênh Boss
 * relay nhưng nhân viên vứt đi: db:unreadChanged, db:conversationDeleted, db:contactProfileUpdated, library:*…):
 *  - RELAY_CHANNELS — HttpRelayService móc EventBroadcaster (onBeforeSend) → SocketIOService.publish; người nhận theo
 *    relayAudience.ts (id tài khoản trong payload). Thêm kênh dữ liệu mới: thêm ở đây + listener renderer + preload
 *    (test relaySyncContract.test.ts quét nguồn và báo kênh thiếu).
 *  - DIRECT_PUBLISHED_CHANNELS — Boss tự publish (không qua hook — thêm vào RELAY_CHANNELS sẽ thành phát hai lần).
 *  - RELAY_CONTROL_CHANNELS — lệnh điều khiển gửi riêng một nhân viên (HttpRelayService.pushControlToEmployee).
 *  - BOSS_ONLY_CHANNELS — kênh EventBroadcaster KHÔNG gửi nhân viên, kèm lý do.
 *  - EMPLOYEE_FORWARD_CHANNELS — nhân viên (HttpClientService.handlePushedEvent) chuyển tiếp renderer.
 */
import { BOSS_URL_CHANGED_EVENT } from '../../shared/tunnelAddress';

/** Kênh Boss relay cho nhân viên (móc EventBroadcaster). Nhóm theo nguồn dữ liệu. */
export const RELAY_CHANNELS: readonly string[] = Object.freeze([
  // ─── Tin nhắn / hội thoại (Zalo, Telegram — id tài khoản: zaloId) ───────────
  'event:message',
  'event:reaction',
  'event:telegramReaction',
  'event:messageEdited',
  'event:messagesDeleted',
  'event:undo',
  'event:delete',
  'event:localPath',
  'event:seen',
  'event:receipt', // mốc đã nhận / đã xem tin gửi (dấu ✓ / ✓✓)
  'event:typing',
  'event:userPresence',
  'event:reminder',
  'event:pollVote',
  'event:pinsUpdated',
  // ─── Nhóm / danh bạ ──────────────────────────────────────────────────────
  'event:groupEvent',
  'event:groupInfoUpdate',
  'event:groupMemberAvatar',
  'event:telegramEntityHydrated',
  'event:forumTopicsChanged',
  'event:friendRequest',
  'event:friendRequestSent',
  'event:friendRequestRemoved',
  'event:friendAccepted',
  'event:friendRemoved',
  // ─── Trạng thái tài khoản ────────────────────────────────────────────────
  'event:connected',
  'event:disconnected',
  'event:listenerDead',
  // ─── Facebook (id tài khoản: fbAccountId = accounts.zalo_id) ─────────────
  'fb:onMessage',
  'fb:onReaction',
  'fb:onUnsend',
  'fb:onEdit',
  'fb:onSeen',
  'fb:onTyping',
  'fb:onThreadInfoUpdate',
  'fb:onGroupEvent',
  'fb:onContactUpdate',
  'fb:onConnectionStatus',
  // ─── Cài đặt hội thoại / nhãn / tin nhắn nhanh / CRM ─────────────────────
  'db:localLabelChanged',
  'db:localLabelThreadChanged',
  'db:pinnedMessageChanged',
  'db:localQuickMessageChanged',
  'db:pinnedConversationChanged',
  'db:starredMessageChanged',
  'db:contactFlagsChanged',
  'db:contactAliasChanged',
  'db:contactProfileUpdated',
  'db:conversationDeleted',
  'db:unreadChanged',
  'crm:noteChanged',
  'crm:campaignChanged',
  'crm:campaignDone',
  'crm:queueUpdate',
  'crm:queueStatus',
  // ─── Thư viện media ──────────────────────────────────────────────────────
  'library:itemAdded',
  'library:itemUpdated',
  'library:itemDeleted',
  // ─── Workflow ────────────────────────────────────────────────────────────
  'workflow:executed',
  'workflow:changed', // lưu / xoá / bật tắt / nhân bản (workflowIpc) → danh sách workflow ở máy khác tải lại
  // ─── ERP ─────────────────────────────────────────────────────────────────
  'erp:event:projectCreated',
  'erp:event:projectUpdated',
  'erp:event:projectDeleted',
  'erp:event:taskCreated',
  'erp:event:taskUpdated',
  'erp:event:taskDeleted',
  'erp:event:commentAdded',
  'erp:event:calendarEventCreated',
  'erp:event:calendarEventUpdated',
  'erp:event:calendarEventDeleted',
  'erp:event:reminder',
  'erp:event:noteCreated',
  'erp:event:noteUpdated',
  'erp:event:noteDeleted',
  'erp:event:noteShared',
  'erp:event:notification',
  'erp:event:leaveCreated',
  'erp:event:leaveDecided',
  'erp:event:attendanceUpdated',
  'erp:event:departmentUpdated',
  'erp:event:employeeProfileUpdated',
  'erp:event:employeeProfileDeleted',
]);

/**
 * Boss publish thẳng (SocketIOService.publish / relayEventToEmployees) — KHÔNG có trong RELAY_CHANNELS: kênh này
 * EventBroadcaster.emit cho renderer Boss ngay sau khi publish, thêm hook nữa là nhân viên nhận hai lần.
 */
export const DIRECT_PUBLISHED_CHANNELS: readonly string[] = Object.freeze([
  'relay:messageSentByEmployee', // "ai đã trả lời" — HttpRelayService.executeProxyAction
  BOSS_URL_CHANGED_EVENT, // địa chỉ tunnel đổi — HttpRelayService.recordPublicUrl
]);

/** Lệnh điều khiển gửi riêng một nhân viên (tức thời, không buffer) — HttpClientService xử lý riêng. */
export const RELAY_CONTROL_CHANNELS: readonly string[] = Object.freeze([
  'relay:kicked',
  'relay:initialState',
  'relay:permissionUpdate',
  'relay:accountAccessUpdate',
]);

/**
 * Kênh EventBroadcaster cố ý KHÔNG gửi nhân viên (chỉ renderer của chính máy phát). Mọi kênh EventBroadcaster phát ra
 * phải nằm ở RELAY_CHANNELS, DIRECT_PUBLISHED_CHANNELS hoặc ở đây (kèm lý do) — test relaySyncContract quét nguồn.
 */
export const BOSS_ONLY_CHANNELS: Readonly<Record<string, string>> = Object.freeze({
  'employee:bossUrlChanged': 'Máy nhân viên tự báo renderer (sendDirect) sau khi nhận relay:bossUrlChanged',
  'qr:update': 'QR đăng nhập tài khoản đang thêm trên máy Boss',
  'relay:employeeListUpdate': 'Danh sách nhân viên đang kết nối — màn hình quản lý relay của Boss',
  'relay:tunnelStatusUpdate': 'Trạng thái tunnel của Boss; nhân viên nhận địa chỉ mới qua relay:bossUrlChanged',
  'event:telegramSync': 'Tiến độ đồng bộ lịch sử Telegram do Boss chạy; kết quả tới nhân viên qua db:unreadChanged',
  // Muốn báo cho nhân viên được giao tài khoản: chuyển sang RELAY_CHANNELS + EPHEMERAL (trạng thái đổ chuông không phát lại khi catch-up)
  'event:telegramCall': 'Báo cuộc gọi Telegram đến (đang làm) — Deplao không nghe máy được, chỉ báo trên máy Boss / điện thoại',
  'event:mobileSync': 'Tiến độ "Đồng bộ từ điện thoại" chạy trên máy Boss',
  'event:fbHistorySync': 'Tiến độ "Đồng bộ tin nhắn Facebook" chạy trên máy Boss; tin đã lưu tới nhân viên qua đọc DB của Boss',
  'event:telegramBotEditedMessage': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'event:telegramBotJoinRequest': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'event:telegramBotCallback': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'event:telegramBotMembership': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'fb:onE2EEStatus': 'Trạng thái E2EE của phiên Facebook trên Boss — renderer chỉ ghi log',
  'fb:onPresence': 'Presence Facebook — renderer chưa dùng',
  'integration:payment': 'Trigger workflow trên Boss; chứa dữ liệu thanh toán, renderer không nghe → không gửi mọi nhân viên',
  'integration:webhook': 'Trigger workflow trên Boss; payload webhook thô, renderer không nghe → không gửi mọi nhân viên',
  'integration:posWebhook': 'Trigger workflow trên Boss; đơn / khách hàng từ phần mềm bán hàng, renderer không nghe → không gửi mọi nhân viên',
  'crm:tagChanged': 'Thẻ CRM (crm_tags) không còn UI nào hiển thị (Nhãn Local thay thế)',
});

/** Nhân viên chuyển tiếp renderer: mọi kênh Boss relay / publish thẳng (trừ lệnh điều khiển + đổi địa chỉ Boss). */
export const EMPLOYEE_FORWARD_CHANNELS: ReadonlySet<string> = new Set([
  ...RELAY_CHANNELS,
  ...DIRECT_PUBLISHED_CHANNELS.filter((channel) => channel !== BOSS_URL_CHANGED_EVENT),
]);

const RELAY_CHANNEL_SET: ReadonlySet<string> = new Set(RELAY_CHANNELS);

/** Kênh EventBroadcaster được Boss móc để relay. */
export function isRelayedChannel(channel: string): boolean {
  return RELAY_CHANNEL_SET.has(channel);
}
