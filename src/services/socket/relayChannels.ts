/**
 * relayChannels.ts: realtime channel contract Boss → employee (pure part, shared by Boss, employees and tests).
 *
 * One source for both sides (previously Boss had RELAY_CHANNELS and employees had their own FORWARD_CHANNELS, so 8 channels that Boss
 * relays were dropped by employees: db:unreadChanged, db:conversationDeleted, db:contactProfileUpdated, library:*…):
 *  - RELAY_CHANNELS: HttpRelayService hooks EventBroadcaster (onBeforeSend) → SocketIOService.publish; recipients are picked by
 *    relayAudience.ts (account id in the payload). To add a new data channel: add it here + a renderer listener + preload
 *    (test relaySyncContract.test.ts scans the source and reports missing channels).
 *  - DIRECT_PUBLISHED_CHANNELS: Boss publishes these itself (not through the hook; adding them to RELAY_CHANNELS would send them twice).
 *  - RELAY_CONTROL_CHANNELS: control commands sent to one employee (HttpRelayService.pushControlToEmployee).
 *  - BOSS_ONLY_CHANNELS: EventBroadcaster channels NOT sent to employees, with the reason.
 *  - EMPLOYEE_FORWARD_CHANNELS: employee (HttpClientService.handlePushedEvent) forwards them to the renderer.
 */
import { BOSS_URL_CHANGED_EVENT } from '../../shared/cloud/tunnelAddress';

/** Boss channels relayed to employees (hooked into EventBroadcaster). Grouped by data source. */
export const RELAY_CHANNELS: readonly string[] = Object.freeze([
  // ─── Messages / conversations (Zalo, Telegram: account id = zaloId) ───────────
  'event:message',
  'event:reaction',
  'event:telegramReaction',
  'event:messageEdited',
  'event:messagesRepaired', // old messages fetched again from Telegram (not supported yet → readable, channel posts drop the wrong topic)
  'event:contactPreview', // conversation preview changes after an old message is edited
  'event:messagesDeleted',
  'event:undo',
  'event:delete',
  'event:localPath',
  'event:seen',
  'event:receipt', // received / read marks of sent messages (✓ / ✓✓ ticks)
  'event:typing',
  'event:userPresence',
  'event:reminder',
  'event:pollVote',
  'event:pinsUpdated',
  // ─── Groups / contacts ──────────────────────────────────────────────────────
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
  // ─── Account status ────────────────────────────────────────────────
  'event:connected',
  'event:disconnected',
  'event:listenerDead',
  'event:accountProfile', // Zalo Business flag, re-read on login / connect
  // ─── Facebook (account id: fbAccountId = accounts.zalo_id) ─────────────
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
  // ─── Conversation settings / labels / quick messages / CRM ─────────────────────
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
  'db:replyStateChanged', // mark as replied / unmark (manual, bulk)
  'crm:noteChanged',
  'crm:campaignChanged',
  'crm:campaignDone',
  'crm:campaignAutoStopped', // auto-stopped after consecutive errors → notify (campaign data changes via crm:campaignChanged)
  'crm:queueUpdate',
  'crm:queueStatus',
  // ─── Media library ──────────────────────────────────────────────────────
  'library:itemAdded',
  'library:itemUpdated',
  'library:itemDeleted',
  // ─── Workflow ────────────────────────────────────────────────────────────
  'workflow:executed',
  'workflow:changed', // save / delete / enable / disable / duplicate (workflowIpc) → workflow list on other machines reloads
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
 * Boss publishes directly (SocketIOService.publish / relayEventToEmployees): NOT in RELAY_CHANNELS. This channel is
 * emitted by EventBroadcaster to Boss's own renderer right after publishing; adding another hook would make employees receive it twice.
 */
export const DIRECT_PUBLISHED_CHANNELS: readonly string[] = Object.freeze([
  'relay:messageSentByEmployee', // "ai đã trả lời" (AI replied): HttpRelayService.executeProxyAction
  BOSS_URL_CHANGED_EVENT, // tunnel address changed: HttpRelayService.recordPublicUrl
]);

/** Control command sent to one employee (immediate, not buffered): HttpClientService handles it separately. */
export const RELAY_CONTROL_CHANNELS: readonly string[] = Object.freeze([
  'relay:kicked',
  'relay:initialState',
  'relay:permissionUpdate',
  'relay:accountAccessUpdate',
]);

/**
 * EventBroadcaster channels deliberately NOT sent to employees (only to the renderer of the machine that emits them). Every EventBroadcaster channel
 * must be in RELAY_CHANNELS, DIRECT_PUBLISHED_CHANNELS or here (with the reason): the relaySyncContract test scans the source.
 */
export const BOSS_ONLY_CHANNELS: Readonly<Record<string, string>> = Object.freeze({
  'employee:bossUrlChanged': 'Máy nhân viên tự báo renderer (sendDirect) sau khi nhận relay:bossUrlChanged',
  'qr:update': 'QR đăng nhập tài khoản đang thêm trên máy Boss',
  'relay:employeeListUpdate': 'Danh sách nhân viên đang kết nối — màn hình quản lý relay của Boss',
  'relay:tunnelStatusUpdate': 'Trạng thái tunnel của Boss; nhân viên nhận địa chỉ mới qua relay:bossUrlChanged',
  'event:telegramSync': 'Tiến độ đồng bộ lịch sử Telegram do Boss chạy; kết quả tới nhân viên qua db:unreadChanged',
  // To notify the employee assigned the account: move to RELAY_CHANNELS + EPHEMERAL (the ring state is not replayed during catch-up)
  'event:telegramCall': 'Báo cuộc gọi Telegram đến (đang làm) — Deplao không nghe máy được, chỉ báo trên máy Boss / điện thoại',
  'event:mobileSync': 'Tiến độ "Đồng bộ từ điện thoại" chạy trên máy Boss',
  'event:fbHistorySync': 'Tiến độ "Đồng bộ tin nhắn Facebook" chạy trên máy Boss; tin đã lưu tới nhân viên qua đọc DB của Boss',
  'event:mediaProgress': 'Nhịp tiến độ tải video ("2.1 / 5.0 MB") trên máy Boss đang tải; file xong tới nhân viên qua event:localPath',
  'event:telegramBotEditedMessage': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'event:telegramBotJoinRequest': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'event:telegramBotCallback': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'event:telegramBotMembership': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'event:telegramBotMemberUpdate': 'Chỉ làm trigger workflow trên Boss (renderer không nghe)',
  'fb:onE2EEStatus': 'Trạng thái E2EE của phiên Facebook trên Boss — renderer chỉ ghi log',
  'fb:onPresence': 'Presence Facebook — renderer chưa dùng',
  'integration:payment': 'Trigger workflow trên Boss; chứa dữ liệu thanh toán, renderer không nghe → không gửi mọi nhân viên',
  'integration:webhook': 'Trigger workflow trên Boss; payload webhook thô, renderer không nghe → không gửi mọi nhân viên',
  'integration:posWebhook': 'Trigger workflow trên Boss; đơn / khách hàng từ phần mềm bán hàng, renderer không nghe → không gửi mọi nhân viên',
  'crm:tagChanged': 'Thẻ CRM (crm_tags) không còn UI nào hiển thị (Nhãn Local thay thế)',
});

/** Employee forwards to the renderer: every channel Boss relays or publishes directly (except control commands + Boss address changes). */
export const EMPLOYEE_FORWARD_CHANNELS: ReadonlySet<string> = new Set([
  ...RELAY_CHANNELS,
  ...DIRECT_PUBLISHED_CHANNELS.filter((channel) => channel !== BOSS_URL_CHANGED_EVENT),
]);

const RELAY_CHANNEL_SET: ReadonlySet<string> = new Set(RELAY_CHANNELS);

/** EventBroadcaster channels that Boss hooks to relay. */
export function isRelayedChannel(channel: string): boolean {
  return RELAY_CHANNEL_SET.has(channel);
}
