/**
 * Template variables of the workflow editor ({{ $trigger.x }}, {{ $node.<id>.field }}, {{ $var.x }},
 * {{ $date.now }}, {{ $pageId }}).
 *
 * The variable list depends on the workflow: `$trigger.*` fields MUST mirror what
 * `WorkflowEngineService.flattenTriggerData` produces for the workflow's trigger type (a payment
 * trigger has no `threadId`, a schedule trigger has no fields at all, ...), node outputs mirror what
 * `executeNode` returns, and `$var.*` names come from the "Lưu giá trị vào biến" (save value to variable) nodes that run
 * before the current node. Keep these tables in sync when the engine changes.
 */
// Loop body rules shared with the engine (pure, no dependency on Node / Electron)
import { FOR_EACH_DONE_HANDLE, forEachBodyNodeIds, forEachVariableName } from '../../../../services/workflow/forEachLoop';
import { tr } from '../../../../shared/i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TemplateVarGroup = 'suggested' | 'trigger' | 'node' | 'variable' | 'date' | 'account';

export interface TemplateVarInfo {
  /** Expression inserted between {{ }}, e.g. '$trigger.fromName'. */
  key: string;
  label: string;
  description: string;
  group: TemplateVarGroup;
  example?: string;
  /** Contains a placeholder the user must replace, e.g. `$trigger.body.<field>`. */
  isPattern?: boolean;
  /** Node output: node id / type / label (for grouping in the popup). */
  nodeId?: string;
  nodeType?: string;
  nodeLabel?: string;
}

export const TEMPLATE_VAR_GROUP_LABELS: Record<TemplateVarGroup, string> = {
  suggested: tr('Gợi ý cho ô này'),
  trigger: 'Dữ liệu kích hoạt',
  node: tr('Kết quả node trước'),
  variable: tr('Biến tự đặt'),
  date: tr('Ngày giờ'),
  account: tr('Tài khoản'),
};

// ─── Trigger fields (mirror WorkflowEngineService.flattenTriggerData) ─────────

interface FieldDef { label: string; description: string; example?: string; isPattern?: boolean }

const FIELDS: Record<string, FieldDef> = {
  content:        { label: tr('Nội dung tin nhắn'), description: tr('Văn bản của tin nhắn đã kích hoạt workflow (tin ảnh/link: chú thích hoặc tiêu đề).'), example: tr('"Cho mình hỏi giá"') },
  caption:        { label: tr('Chú thích / văn bản gốc'), description: tr('Văn bản gốc của tin (chú thích ảnh, file...).') },
  body:           { label: tr('Nội dung (body)'), description: tr('Văn bản của tin nhắn (giống "Nội dung tin nhắn").') },
  fromId:         { label: tr('ID người gửi'), description: tr('Mã định danh của người gửi - dùng để trả lời riêng hoặc tra cứu.'), example: '"123456789"' },
  fromName:       { label: tr('Tên người gửi'), description: tr('Tên hiển thị của người gửi.'), example: tr('"Nguyễn Văn A"') },
  fromPhone:      { label: tr('SĐT người gửi'), description: tr('Số điện thoại đã lưu của người gửi (bạn bè có số, SĐT nhập ở Thông tin hội thoại / CRM; Telegram: liên hệ đã chia sẻ số). Webhook phần mềm bán hàng: SĐT khách của đơn. Chưa có → trống.'), example: '"0901234567"' },
  threadId:       { label: tr('ID hội thoại'), description: tr('Mã hội thoại chứa tin nhắn - dùng để trả lời đúng hội thoại.'), example: '"987654321"' },
  chatId:         { label: tr('ID cuộc trò chuyện'), description: tr('Mã chat/nhóm Telegram nơi có sự kiện - dùng để trả lời đúng chat.'), example: '"-1001234567890"' },
  threadType:     { label: tr('Loại hội thoại (0/1)'), description: tr('0 = cá nhân, 1 = nhóm.'), example: '"0"' },
  isGroup:        { label: tr('Là tin nhóm (true/false)'), description: tr('true nếu tin đến từ nhóm.'), example: '"false"' },
  groupName:      { label: tr('Tên nhóm'), description: tr('Tên nhóm (khi tin đến từ nhóm, nếu có).'), example: tr('"Nhóm khách sỉ"') },
  msgId:          { label: tr('ID tin nhắn'), description: tr('Mã tin nhắn - dùng để thả cảm xúc, trả lời trích dẫn, thu hồi.'), example: '"7284562398"' },
  messageId:      { label: tr('ID tin nhắn'), description: tr('Mã tin nhắn - dùng để thả cảm xúc, sửa, xoá, ghim.'), example: '"mid.$abc123"' },
  cliMsgId:       { label: tr('ID tin nhắn phía client'), description: tr('Mã tin do ứng dụng gửi tạo ra (dùng khi ID tin chưa có).') },
  timestamp:      { label: tr('Thời điểm (ms)'), description: tr('Thời điểm sự kiện, tính bằng mili giây.'), example: '"1775251200000"' },
  isSelf:         { label: tr('Do mình gửi (true/false)'), description: tr('true nếu chính tài khoản này gửi tin.'), example: '"false"' },
  zaloId:         { label: tr('ID tài khoản Zalo nhận'), description: tr('Mã tài khoản Zalo của bạn đã nhận sự kiện.') },
  images:         { label: tr('Danh sách URL ảnh'), description: tr('Mảng URL ảnh trong tin (nếu có). Lấy ảnh đầu: $trigger.images[0].'), example: '["https://...jpg"]' },
  'images[0]':    { label: tr('URL ảnh đầu tiên'), description: tr('Ảnh đầu tiên trong tin (rỗng nếu không có ảnh).') },
  userId:         { label: tr('ID người gửi lời mời'), description: tr('Mã người gửi lời mời kết bạn - dùng để chấp nhận / từ chối / nhắn tin.') },
  displayName:    { label: tr('Tên người gửi lời mời'), description: tr('Tên hiển thị của người gửi lời mời kết bạn.') },
  phone:          { label: tr('SĐT người gửi lời mời'), description: tr('Số điện thoại kèm lời mời (nếu có).') },
  message:        { label: tr('Lời nhắn kèm lời mời'), description: tr('Nội dung người gửi viết kèm lời mời kết bạn.') },
  groupId:        { label: tr('ID nhóm'), description: tr('Mã nhóm nơi sự kiện xảy ra.') },
  eventType:      { label: tr('Loại sự kiện'), description: tr('Loại sự kiện nhóm (join, leave, remove_member, update, add_admin, remove_admin...).'), example: '"join"' },
  actorName:      { label: tr('Người thực hiện'), description: tr('Tên người thực hiện hành động trong nhóm.') },
  actorId:        { label: tr('ID người thực hiện'), description: tr('Mã người thực hiện hành động.') },
  targetNames:    { label: tr('Thành viên bị tác động'), description: tr('Tên các thành viên chịu ảnh hưởng (cách nhau dấu phẩy).') },
  systemText:     { label: tr('Thông báo hệ thống'), description: tr('Câu thông báo do Zalo tạo, VD "A đã thêm B vào nhóm".') },
  memberNames:    { label: tr('Tên thành viên'), description: tr('Tên các thành viên vừa vào / rời nhóm (cách nhau dấu phẩy).'), example: tr('"Nguyễn Văn A, Trần B"') },
  memberIds:      { label: tr('ID thành viên'), description: tr('Mã các thành viên vừa vào / rời nhóm (cách nhau dấu phẩy).') },
  memberId:       { label: tr('ID thành viên'), description: tr('Telegram user ID của người vừa vào / rời nhóm.'), example: '"123456789"' },
  memberName:     { label: tr('Tên thành viên'), description: tr('Tên người vừa vào / rời nhóm.'), example: tr('"Nguyễn Văn A"') },
  memberUsername: { label: tr('Username thành viên'), description: tr('@username Telegram của thành viên (nếu có, không kèm @).') },
  participantName:{ label: tr('Tên thành viên'), description: tr('Tên đã lưu của thành viên chịu tác động.') },
  command:        { label: tr('Lệnh'), description: tr('Tên lệnh không kèm "/" và @bot, chữ thường.'), example: '"donhang"' },
  args:           { label: tr('Phần sau lệnh'), description: tr('Phần khách gõ sau lệnh, VD /donhang 0901234567 → 0901234567.'), example: '"0901234567"' },
  react:          { label: tr('Cảm xúc'), description: tr('Mã cảm xúc người dùng đã thả.') },
  labelId:        { label: tr('ID nhãn'), description: tr('Mã nhãn vừa được gán / gỡ.') },
  labelText:      { label: tr('Tên nhãn'), description: tr('Tên nhãn vừa được gán / gỡ.'), example: tr('"Khách VIP"') },
  labelColor:     { label: tr('Màu nhãn'), description: tr('Mã màu của nhãn.') },
  labelEmoji:     { label: tr('Emoji nhãn'), description: tr('Emoji của nhãn.') },
  labelSource:    { label: tr('Nguồn nhãn'), description: tr('local (Nhãn Local) hoặc zalo (Nhãn Zalo).') },
  action:         { label: tr('Hành động'), description: tr('assigned = vừa gán, removed = vừa gỡ.'), example: '"assigned"' },
  amount:         { label: tr('Số tiền'), description: tr('Số tiền của giao dịch.'), example: '"239000"' },
  description:    { label: tr('Nội dung chuyển khoản'), description: tr('Nội dung giao dịch ngân hàng.'), example: '"Thanh toan don SPX011"' },
  bankName:       { label: tr('Ngân hàng'), description: tr('Tên ngân hàng của giao dịch.') },
  accountNumber:  { label: tr('Số tài khoản'), description: tr('Số tài khoản nhận tiền.') },
  transactionId:  { label: tr('Mã giao dịch'), description: tr('Mã giao dịch từ ngân hàng / cổng thanh toán.') },
  transactionDate:{ label: tr('Thời gian giao dịch'), description: tr('Thời điểm giao dịch do ngân hàng gửi.') },
  integrationId:  { label: tr('ID kết nối tích hợp'), description: tr('Mã kết nối đã nhận webhook (Casso / SePay, phần mềm bán hàng).') },
  integrationType:{ label: tr('Loại tích hợp'), description: tr('casso, sepay (thanh toán) hoặc kiotviet, haravan, sapo, nhanh, pancake (phần mềm bán hàng).') },
  integrationName:{ label: tr('Tên kết nối'), description: tr('Tên kết nối phần mềm bán hàng đặt ở trang Tích hợp.'), example: tr('"KiotViet - Chi nhánh 1"') },
  event:          { label: tr('Tên sự kiện'), description: tr('Sự kiện nền tảng gửi: order.update / invoice.update (KiotViet), orders/paid (Haravan, Sapo), orderAdd / orderUpdate (Nhanh.vn), orders (Pancake).'), example: '"orders/paid"' },
  entity:         { label: tr('Loại dữ liệu'), description: tr('order, invoice, customer, product, inventory hoặc other.'), example: '"order"' },
  code:           { label: tr('Mã đơn / mã bản ghi'), description: tr('Mã đơn hàng (KiotViet Code, Haravan / Sapo name, Nhanh.vn / Pancake id) hoặc mã khách / sản phẩm.'), example: '"DH000123"' },
  status:         { label: tr('Trạng thái'), description: tr('Trạng thái đơn nền tảng gửi (Nhanh.vn: đã đổi mã số sang tên trạng thái).'), example: tr('"Hoàn thành"') },
  customerName:   { label: tr('Tên khách hàng'), description: tr('Tên người nhận / khách hàng của đơn.'), example: tr('"Nguyễn Văn A"') },
  customerPhone:  { label: tr('SĐT khách hàng'), description: tr('SĐT người nhận / khách hàng — tìm khách trên Zalo hoặc tra cứu POS.'), example: '"0901234567"' },
  total:          { label: tr('Tổng tiền đơn'), description: tr('Tổng tiền đơn do nền tảng gửi.'), example: '"350000"' },
  data:           { label: tr('Dữ liệu gốc'), description: tr('Toàn bộ bản ghi nền tảng gửi (JSON). Dùng $trigger.data.<trường> để lấy 1 trường.') },
  'data.<field>': { label: tr('1 trường trong dữ liệu gốc'), description: tr('Thay <field> bằng tên trường của nền tảng, hỗ trợ lồng nhau: $trigger.data.InvoiceDelivery.Receiver (KiotViet), $trigger.data.shipping_address.address1 (Haravan / Sapo).'), example: '$trigger.data.Code → "DH000123"', isPattern: true },
  raw:            { label: tr('Dữ liệu giao dịch gốc'), description: tr('Toàn bộ dữ liệu giao dịch (JSON). Dùng $trigger.raw.<trường> để lấy 1 trường.') },
  'body.<field>': { label: tr('1 trường trong dữ liệu webhook'), description: tr('Thay <field> bằng tên trường, hỗ trợ lồng nhau: $trigger.body.customer.name.'), example: '$trigger.body.orderId → "ORD123"', isPattern: true },
  webhookBody:    { label: tr('Toàn bộ dữ liệu webhook'), description: tr('JSON bên thứ 3 gửi đến.') },
  method:         { label: tr('Phương thức HTTP'), description: 'POST, GET, PUT...', example: '"POST"' },
  headers:        { label: tr('Headers'), description: tr('HTTP headers của request webhook.') },
  query:          { label: tr('Query string'), description: tr('Tham số trên URL. VD ?source=web → $trigger.query.source.') },
  rawBody:        { label: tr('Body thô'), description: tr('Nội dung request dạng chuỗi gốc.') },
  attachments:    { label: tr('Tệp đính kèm'), description: tr('Thông tin tệp / ảnh / video đính kèm (JSON).') },
  msgType:        { label: tr('Loại tin'), description: tr('Loại tin nhắn (text, photo, video...).') },
  emoji:          { label: tr('Emoji cảm xúc'), description: tr('Emoji người dùng đã thả.') },
  typeChat:       { label: tr('Loại hội thoại'), description: tr('user = cá nhân; trống = nhóm.') },
  fbAccountId:    { label: tr('ID tài khoản Facebook'), description: tr('Mã tài khoản Facebook đã nhận sự kiện.') },
  groupEventType: { label: tr('Loại sự kiện nhóm'), description: tr('Loại sự kiện nhóm Facebook.') },
  participantId:  { label: tr('ID thành viên'), description: tr('Thành viên chịu tác động.') },
  participants:   { label: tr('Danh sách thành viên'), description: tr('Các thành viên liên quan (mảng).') },
  actorFbId:      { label: tr('ID người thực hiện'), description: tr('Tài khoản Facebook thực hiện hành động.') },
  accountId:      { label: tr('ID tài khoản nhận'), description: tr('Mã tài khoản đã nhận sự kiện.') },
  preview:        { label: tr('Xem trước nội dung'), description: tr('Văn bản hiển thị của tin (kể cả tin media).') },
  callbackData:   { label: tr('Dữ liệu nút bấm'), description: tr('callback_data của nút Inline user vừa bấm.'), example: '"order:123"' },
  callbackQueryId:{ label: tr('ID lượt bấm nút'), description: tr('Dùng cho node "Trả lời nút bấm".') },
  chatTitle:      { label: tr('Tên nhóm / kênh'), description: tr('Tên chat Telegram (nhóm, kênh).') },
  chatType:       { label: tr('Loại chat'), description: 'private, group, supergroup, channel.', example: '"private"' },
};

/** Fields per trigger type, in display order. */
const ZALO_MESSAGE = ['content', 'fromName', 'fromId', 'threadId', 'isGroup', 'groupName', 'threadType', 'msgId', 'cliMsgId', 'images', 'images[0]', 'fromPhone', 'timestamp', 'isSelf', 'zaloId'];
const FB_MESSAGE = ['content', 'fromName', 'fromId', 'threadId', 'messageId', 'attachments', 'msgType', 'typeChat', 'isSelf', 'timestamp', 'fbAccountId'];
const TG_MESSAGE = ['content', 'fromName', 'fromId', 'chatId', 'threadId', 'isGroup', 'messageId', 'msgType', 'caption', 'preview', 'attachments', 'fromPhone', 'isSelf', 'timestamp', 'accountId'];
const TGBOT_MESSAGE = ['content', 'fromName', 'fromId', 'chatId', 'chatType', 'chatTitle', 'messageId', 'isSelf', 'timestamp', 'accountId'];

const TRIGGER_FIELDS: Record<string, string[]> = {
  'trigger.message':        ZALO_MESSAGE,
  'trigger.friendRequest':  ['displayName', 'userId', 'phone', 'message', 'zaloId'],
  'trigger.groupEvent':     ['eventType', 'groupId', 'threadId', 'threadType', 'memberNames', 'memberIds', 'actorName', 'targetNames', 'systemText', 'zaloId'],
  'trigger.reaction':       ['react', 'fromName', 'fromId', 'threadId', 'threadType', 'msgId', 'zaloId'],
  'trigger.labelAssigned':  ['labelText', 'action', 'threadId', 'threadType', 'labelId', 'labelSource', 'labelEmoji', 'labelColor', 'zaloId'],
  'trigger.payment':        ['amount', 'description', 'bankName', 'accountNumber', 'transactionId', 'transactionDate', 'integrationType', 'integrationId', 'raw'],
  'trigger.posWebhook':     ['event', 'entity', 'code', 'status', 'customerName', 'customerPhone', 'total', 'fromPhone', 'data', 'data.<field>', 'integrationType', 'integrationName', 'integrationId'],
  'trigger.webhook':        ['webhookBody', 'body.<field>', 'method', 'query', 'headers', 'rawBody'],
  'trigger.api':            ['eventName', 'payload', 'payload.<field>', 'keyId', 'source', 'accountId', 'receivedAt'],
  // "Chạy thử" (Test run) sends simulated message data; a scheduled run has no trigger data
  'trigger.manual':         ['content', 'fromName', 'fromId', 'threadId', 'threadType', 'isGroup', 'zaloId', 'timestamp'],
  'trigger.schedule':       [],
  'fb.trigger.message':     FB_MESSAGE,
  'fb.trigger.image':       FB_MESSAGE,
  'fb.trigger.video':       FB_MESSAGE,
  'fb.trigger.file':        FB_MESSAGE,
  'fb.trigger.sticker':     FB_MESSAGE,
  'fb.trigger.reaction':    ['emoji', 'fromName', 'fromId', 'threadId', 'messageId', 'timestamp', 'fbAccountId'],
  'fb.trigger.unsend':      ['messageId', 'threadId', 'fbAccountId'],
  'fb.trigger.groupEvent':  ['groupEventType', 'threadId', 'fromName', 'actorFbId', 'participantId', 'participantName', 'participants', 'fbAccountId'],
  'tg.trigger.message':     TG_MESSAGE,
  'tg.trigger.unsend':      ['chatId', 'messageId', 'threadId', 'accountId', 'timestamp'],
  'tg.trigger.groupEvent':  ['eventType', 'fromName', 'fromId', 'memberNames', 'memberIds', 'chatId', 'systemText', 'accountId', 'timestamp'],
  'tgbot.trigger.message':       TGBOT_MESSAGE,
  'tgbot.trigger.command':       ['command', 'args', ...TGBOT_MESSAGE],
  'tgbot.trigger.editedMessage': TGBOT_MESSAGE,
  'tgbot.trigger.callback':      ['callbackData', 'callbackQueryId', 'fromName', 'fromId', 'chatId', 'messageId', 'accountId', 'timestamp'],
  'tgbot.trigger.join':          ['eventType', 'chatId', 'chatTitle', 'chatType', 'actorName', 'actorId', 'accountId', 'timestamp'],
  'tgbot.trigger.joinRequest':   ['fromName', 'fromId', 'chatId', 'chatTitle', 'accountId', 'timestamp'],
  'tgbot.trigger.memberUpdate':  ['eventType', 'memberName', 'memberId', 'memberUsername', 'chatId', 'chatTitle', 'actorName', 'actorId', 'accountId', 'timestamp'],
};

/** Trigger fields holding an object: nested keys ($trigger.raw.amount) are available too. */
const OBJECT_FIELDS: ReadonlySet<string> = new Set(['raw', 'query', 'headers', 'payload', 'data']);

/** Engine key for a field (webhookBody is shown as $trigger.body). */
function triggerKey(field: string): string {
  return field === 'webhookBody' ? '$trigger.body' : `$trigger.${field}`;
}

/** Same rule as nodeVisuals.getNodeFamily (kept dependency-free for unit tests). */
export function isTriggerType(type: string | undefined | null): boolean {
  return !!type && (type.startsWith('trigger.') || type.includes('.trigger.'));
}

/** `$trigger.*` variables the engine provides for these trigger types (union, display order kept). */
export function getTriggerVars(triggerTypes: string[]): TemplateVarInfo[] {
  const seen = new Set<string>();
  const vars: TemplateVarInfo[] = [];
  for (const type of triggerTypes) {
    for (const field of TRIGGER_FIELDS[type] || []) {
      const key = triggerKey(field);
      if (seen.has(key)) continue;
      seen.add(key);
      const def = FIELDS[field] || { label: field, description: '' };
      vars.push({ key, label: def.label, description: def.description, example: def.example, isPattern: def.isPattern, group: 'trigger' });
    }
  }
  return vars;
}

/**
 * true when `key` (e.g. '$trigger.fromName') is available for the workflow. Non-trigger keys and
 * workflows without a known trigger are always considered available.
 */
export function isVarAvailable(key: string, triggerTypes: string[]): boolean {
  if (!key.startsWith('$trigger.')) return true;
  const known = triggerTypes.filter(type => type in TRIGGER_FIELDS);
  if (known.length === 0) return true;
  const field = key.slice('$trigger.'.length);
  return known.some(type => (TRIGGER_FIELDS[type] || []).some(name => {
    if (name === 'webhookBody') return field === 'body' || field.startsWith('body.');
    // Pattern '<object>.<field>' (body, payload, data): every child field
    if (name.endsWith('.<field>')) return field.startsWith(name.slice(0, -'<field>'.length));
    if (OBJECT_FIELDS.has(name)) return field === name || field.startsWith(`${name}.`);
    return name === field || (name === 'images' && field.startsWith('images['));
  }));
}

// ─── Node outputs (mirror WorkflowEngineService.executeNode return values) ────

export interface OutputDef { path: string; label: string; description?: string; isPattern?: boolean }

// POS lookup nodes (same result shape for KiotViet / Haravan / Sapo / Nhanh.vn / Pancake). If the phone + order code are both empty, the engine
// does not look up and returns found = false (services/workflow/posLookupGuard.ts).
const POS_CUSTOMER_OUTPUTS: OutputDef[] = [
  { path: 'found', label: tr('Tìm thấy khách (true/false)'), description: tr('false cả khi SĐT trống (không tra cứu).') },
  { path: 'firstCustomer', label: tr('Khách hàng tìm thấy đầu tiên') },
  { path: 'firstCustomer.<field>', label: tr('1 trường của khách hàng'), description: tr('Tên trường theo từng nền tảng, VD KiotViet: name, contactNumber, rewardPoint.'), isPattern: true },
  { path: 'customers', label: tr('Danh sách khách hàng') },
];
const POS_ORDER_OUTPUTS: OutputDef[] = [
  { path: 'found', label: tr('Tìm thấy đơn (true/false)'), description: tr('false cả khi SĐT và mã đơn trống (không tra cứu).') },
  { path: 'order', label: tr('Đơn hàng mới nhất') },
  { path: 'order.<field>', label: tr('1 trường của đơn hàng'), description: tr('Tên trường theo từng nền tảng, VD KiotViet: code, statusValue, total; Haravan: name, total_price.'), isPattern: true },
  { path: 'orders', label: tr('Danh sách đơn hàng') },
];
const POS_PRODUCT_OUTPUTS: OutputDef[] = [
  { path: 'found', label: tr('Tìm thấy sản phẩm (true/false)') },
  { path: 'products', label: tr('Danh sách sản phẩm'), description: tr('Dùng làm danh sách của "Lặp qua danh sách" để liệt kê từng sản phẩm.') },
  { path: 'products[0].<field>', label: tr('1 trường của sản phẩm đầu tiên'), isPattern: true },
];
const POS_LOOKUP_OUTPUTS: Record<string, OutputDef[]> = Object.fromEntries(
  ['kiotviet', 'haravan', 'sapo', 'nhanh', 'pancake'].flatMap(platform => [
    [`${platform}.lookupCustomer`, POS_CUSTOMER_OUTPUTS],
    [`${platform}.lookupOrder`, POS_ORDER_OUTPUTS],
    [`${platform}.lookupProduct`, POS_PRODUCT_OUTPUTS],
  ]),
);

export const NODE_OUTPUTS: Record<string, OutputDef[]> = {
  ...POS_LOOKUP_OUTPUTS,
  'ai.generateText':     [{ path: 'result', label: tr('Nội dung AI trả lời') }, { path: 'model', label: tr('Model đã dùng') }, { path: 'totalTokens', label: tr('Số token đã dùng') }],
  'ai.classify':         [{ path: 'category', label: tr('Nhóm AI phân loại'), description: tr('Đúng tên một danh mục đã khai báo (AI trả "Hỏi giá." vẫn thành "Hỏi giá").') }, { path: 'matched', label: tr('Khớp danh mục (true/false)'), description: tr('false = AI trả lời ngoài danh sách; category khi đó là nguyên câu AI.') }, { path: 'raw', label: tr('Câu trả lời gốc của AI') }, { path: 'input', label: tr('Văn bản đã phân loại') }],
  'zalo.sendMessage':    [{ path: 'sentCount', label: tr('Số hội thoại đã gửi') }, { path: 'failedCount', label: tr('Số hội thoại gửi lỗi') }, { path: 'msgId', label: tr('ID tin vừa gửi') }],
  'tgbot.action.sendMessage': [{ path: 'messageId', label: tr('ID tin Bot vừa gửi'), description: tr('Dùng cho Sửa / Xoá / Ghim tin này ở bước sau.') }],
  'tgbot.action.approveJoinRequest': [{ path: 'decision', label: tr('Kết quả (approve / decline)') }, { path: 'userId', label: tr('Người xin vào') }],
  'data.textFormat':     [{ path: 'result', label: tr('Văn bản đã ghép') }],
  'data.randomPick':     [{ path: 'result', label: tr('Mục được chọn ngẫu nhiên') }],
  'data.dateFormat':     [{ path: 'result', label: tr('Ngày giờ đã định dạng') }, { path: 'timestamp', label: tr('Timestamp (ms)') }],
  'data.jsonParse':      [{ path: 'data', label: tr('Object đã đọc') }, { path: 'data.<field>', label: tr('1 trường của object'), isPattern: true }],
  'output.httpRequest':  [{ path: 'status', label: tr('Mã trạng thái HTTP') }, { path: 'data', label: tr('Dữ liệu phản hồi') }, { path: 'data.<field>', label: tr('1 trường của phản hồi'), isPattern: true }],
  'zalo.findUser':       [{ path: 'found', label: tr('Tìm thấy (true/false)') }, { path: 'userId', label: tr('ID người dùng tìm được') }, { path: 'displayName', label: tr('Tên hiển thị') }, { path: 'avatar', label: tr('Ảnh đại diện') }, { path: 'isFriend', label: tr('Đã là bạn bè') }],
  'zalo.getUserInfo':    [{ path: 'displayName', label: tr('Tên hiển thị') }, { path: 'avatar', label: tr('Ảnh đại diện') }, { path: 'found', label: tr('Lấy được thông tin (true/false)') }, { path: '<field>', label: tr('1 trường thông tin người dùng'), description: tr('VD: gender, dob, zaloName…'), isPattern: true }],
  'zalo.getMessageHistory': [{ path: 'messages', label: tr('Danh sách tin nhắn') }],
  'sheets.readValues':   [{ path: 'firstRow[0]', label: tr('Ô đầu tiên của dòng đầu') }, { path: 'rows', label: tr('Tất cả các dòng') }, { path: 'count', label: tr('Số dòng') }, { path: 'firstRow', label: tr('Dòng đầu tiên') }],
  'logic.forEachContact': [{ path: 'result', label: tr('Danh sách ID người nhận (JSON)'), description: tr('Dán vào "Danh sách hội thoại động" của node gửi tin để gửi hàng loạt.') }, { path: 'count', label: tr('Số người nhận') }, { path: 'items', label: tr('Danh sách người nhận (ID + tên)') }],
  'logic.forEach':       [{ path: 'count', label: tr('Số phần tử trong danh sách') }, { path: 'processed', label: tr('Số phần tử đã lặp') }, { path: 'items', label: tr('Danh sách phần tử') }],
  'logic.if':            [{ path: 'result', label: tr('Kết quả điều kiện (true/false)') }, { path: 'branch', label: tr('Nhánh đã chạy') }],
  'logic.switch':        [{ path: 'value', label: tr('Giá trị đã so sánh') }, { path: 'matchedHandle', label: tr('Nhánh khớp') }, { path: 'matched', label: tr('Khớp một nhánh (true/false)') }],
};

export interface VarNode { id: string; label: string; type: string; config?: Record<string, any> }

interface VarEdge { source: string; target: string; sourceHandle?: string | null; data?: { telegramInline?: boolean } | null }

/**
 * Nodes that ran before `nodeId` (suggestions for $node.* / $var.*, checks of the AI copilot): every node upstream along the edges; for a
 * node after the "Xong" (done) gate of "Lặp qua danh sách" (loop over list), the loop body is added too (it finishes before the Done branch, so
 * variables set inside the loop can be used here).
 */
export function upstreamNodeIds(nodeId: string, edges: readonly VarEdge[], typeOf: (id: string) => string | undefined): Set<string> {
  const upstream = new Set<string>();
  const queue = [nodeId];
  const add = (id: string) => {
    if (id === nodeId || upstream.has(id)) return;
    upstream.add(id);
    queue.push(id);
  };
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.target !== current) continue;
      add(edge.source);
      if (edge.sourceHandle === FOR_EACH_DONE_HANDLE && typeOf(edge.source) === 'logic.forEach') {
        forEachBodyNodeIds(edges, edge.source).forEach(add);
      }
    }
  }
  return upstream;
}

/** `$node.<id>.*` variables for the given (upstream) nodes; `output` first, then known fields. */
export function getNodeOutputVars(nodes: VarNode[]): TemplateVarInfo[] {
  const vars: TemplateVarInfo[] = [];
  for (const node of nodes) {
    // Trigger data is in $trigger.*, saved variables in $var.* → not repeated as node outputs
    if (isTriggerType(node.type) || node.type === 'logic.setVariable') continue;
    const base = { group: 'node' as const, nodeId: node.id, nodeType: node.type, nodeLabel: node.label };
    vars.push({
      ...base,
      key: `$node.${node.id}.output`,
      label: tr('Kết quả chính'),
      description: tr('Văn bản kết quả (result / text / message) hoặc toàn bộ dữ liệu dạng JSON.'),
    });
    for (const out of NODE_OUTPUTS[node.type] || []) {
      vars.push({
        ...base,
        key: `$node.${node.id}.${out.path}`,
        label: out.label,
        description: out.description || '',
        isPattern: out.isPattern,
      });
    }
  }
  return vars;
}

/** `$var.<name>` for "Lưu giá trị vào biến" (save value to variable) nodes, the item of "Lặp qua danh sách" (loop over list) nodes (plus the generic pattern). */
export function getVariableVars(nodes: VarNode[]): TemplateVarInfo[] {
  const names = new Set<string>();
  const loopVars: TemplateVarInfo[] = [];
  for (const node of nodes) {
    if (node.type === 'logic.forEach') {
      const item = forEachVariableName(node.config?.itemVariable);
      if (loopVars.some(v => v.key === `$var.${item}`)) continue;
      loopVars.push(
        { key: `$var.${item}`, label: tr('Phần tử đang lặp'), description: tr('Phần tử hiện tại của "{{v1}}" — chỉ có ở các bước nối từ cổng "Mỗi phần tử".', { v1: node.label || tr('Lặp qua danh sách') }), group: 'variable' },
        { key: `$var.${item}.<field>`, label: tr('1 trường của phần tử đang lặp'), description: tr('Thay <field> bằng tên trường, VD $var.item.name.'), group: 'variable', isPattern: true },
        { key: `$var.${item}Index`, label: tr('Số thứ tự phần tử (từ 1)'), description: tr('Lượt lặp hiện tại: 1, 2, 3…'), group: 'variable' },
      );
      continue;
    }
    const name = node.type === 'logic.setVariable' ? String(node.config?.name ?? '').trim() : '';
    if (name && !name.includes('{{')) names.add(name);
  }
  const vars: TemplateVarInfo[] = [...loopVars, ...[...names].map(name => ({
    key: `$var.${name}`,
    label: tr('Biến "{{name}}"', { name }),
    description: tr('Giá trị đã lưu bằng node "Lưu giá trị vào biến" ở bước trước.'),
    group: 'variable' as const,
  }))];
  vars.push({
    key: '$var.<tên_biến>',
    label: tr('Biến tự đặt khác'),
    description: tr('Thay <tên_biến> bằng tên đã đặt trong node "Lưu giá trị vào biến".'),
    group: 'variable',
    isPattern: true,
  });
  return vars;
}

export const DATE_VARS: TemplateVarInfo[] = [
  { key: '$date.now', label: tr('Ngày giờ hiện tại'), description: tr('Theo giờ Việt Nam, dạng dd/MM/yyyy HH:mm:ss.'), example: '"13/10/2026 14:30:00"', group: 'date' },
  { key: '$date.today', label: tr('Ngày hôm nay'), description: tr('Theo giờ Việt Nam, dạng dd/MM/yyyy.'), example: '"13/10/2026"', group: 'date' },
];

export const ACCOUNT_VARS: TemplateVarInfo[] = [
  { key: '$pageId', label: tr('ID tài khoản đang chạy'), description: tr('Tài khoản đang thực thi workflow (Zalo / Facebook / Telegram).'), group: 'account' },
];

export interface VarCatalog {
  groups: Array<{ id: TemplateVarGroup; label: string; vars: TemplateVarInfo[] }>;
  triggerTypes: string[];
}

/**
 * Every variable usable in the current node: suggestions of the field (when available), the
 * trigger's fields, outputs of upstream nodes, user variables, date and account.
 */
export function buildVarCatalog(opts: {
  triggerTypes: string[];
  upstreamNodes: VarNode[];
  suggestedKeys?: string[];
}): VarCatalog {
  const triggerVars = getTriggerVars(opts.triggerTypes);
  const nodeVars = getNodeOutputVars(opts.upstreamNodes);
  const variableVars = getVariableVars(opts.upstreamNodes);
  const all = [...triggerVars, ...nodeVars, ...variableVars, ...DATE_VARS, ...ACCOUNT_VARS];
  const byKey = new Map(all.map(v => [v.key, v]));

  const suggested: TemplateVarInfo[] = [];
  for (const key of opts.suggestedKeys || []) {
    if (!isVarAvailable(key, opts.triggerTypes)) continue;
    const known = byKey.get(key);
    if (known) suggested.push({ ...known, group: 'suggested' });
    else if (!key.startsWith('$trigger.')) suggested.push({ key, label: key, description: '', group: 'suggested' });
  }

  const groups: VarCatalog['groups'] = [];
  const push = (id: TemplateVarGroup, vars: TemplateVarInfo[]) => {
    if (vars.length) groups.push({ id, label: TEMPLATE_VAR_GROUP_LABELS[id], vars });
  };
  push('suggested', suggested);
  push('trigger', triggerVars);
  push('node', nodeVars);
  push('variable', variableVars);
  push('date', DATE_VARS);
  push('account', ACCOUNT_VARS);
  return { groups, triggerTypes: opts.triggerTypes };
}
