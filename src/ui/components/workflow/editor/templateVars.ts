/**
 * Template variables of the workflow editor ({{ $trigger.x }}, {{ $node.<id>.field }}, {{ $var.x }},
 * {{ $date.now }}, {{ $pageId }}).
 *
 * The variable list depends on the workflow: `$trigger.*` fields MUST mirror what
 * `WorkflowEngineService.flattenTriggerData` produces for the workflow's trigger type (a Facebook
 * trigger has no `fromName`, a payment trigger has no `threadId`, ...), node outputs mirror what
 * `executeNode` returns, and `$var.*` names come from the "Lưu giá trị vào biến" nodes that run
 * before the current node. Keep these tables in sync when the engine changes.
 */
// Quy tắc thân vòng lặp dùng chung với engine (thuần, không phụ thuộc Node / Electron)
import { FOR_EACH_DONE_HANDLE, forEachBodyNodeIds, forEachVariableName } from '../../../../services/workflow/forEachLoop';

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
  suggested: 'Gợi ý cho ô này',
  trigger: 'Dữ liệu kích hoạt',
  node: 'Kết quả node trước',
  variable: 'Biến tự đặt',
  date: 'Ngày giờ',
  account: 'Tài khoản',
};

// ─── Trigger fields (mirror WorkflowEngineService.flattenTriggerData) ─────────

interface FieldDef { label: string; description: string; example?: string; isPattern?: boolean }

const FIELDS: Record<string, FieldDef> = {
  content:        { label: 'Nội dung tin nhắn', description: 'Văn bản của tin nhắn đã kích hoạt workflow (tin ảnh/link: chú thích hoặc tiêu đề).', example: '"Cho mình hỏi giá"' },
  caption:        { label: 'Chú thích / văn bản gốc', description: 'Văn bản gốc của tin (chú thích ảnh, file...).' },
  body:           { label: 'Nội dung (body)', description: 'Văn bản của tin nhắn (giống "Nội dung tin nhắn").' },
  fromId:         { label: 'ID người gửi', description: 'Mã định danh của người gửi - dùng để trả lời riêng hoặc tra cứu.', example: '"123456789"' },
  fromName:       { label: 'Tên người gửi', description: 'Tên hiển thị của người gửi.', example: '"Nguyễn Văn A"' },
  fromPhone:      { label: 'SĐT người gửi', description: 'Số điện thoại đã lưu của người gửi (bạn bè có số, SĐT nhập ở Thông tin hội thoại / CRM; Telegram: liên hệ đã chia sẻ số). Webhook phần mềm bán hàng: SĐT khách của đơn. Chưa có → trống.', example: '"0901234567"' },
  threadId:       { label: 'ID hội thoại', description: 'Mã hội thoại chứa tin nhắn - dùng để trả lời đúng hội thoại.', example: '"987654321"' },
  chatId:         { label: 'ID cuộc trò chuyện', description: 'Mã chat/nhóm Telegram nơi có sự kiện - dùng để trả lời đúng chat.', example: '"-1001234567890"' },
  threadType:     { label: 'Loại hội thoại (0/1)', description: '0 = cá nhân, 1 = nhóm.', example: '"0"' },
  isGroup:        { label: 'Là tin nhóm (true/false)', description: 'true nếu tin đến từ nhóm.', example: '"false"' },
  groupName:      { label: 'Tên nhóm', description: 'Tên nhóm (khi tin đến từ nhóm, nếu có).', example: '"Nhóm khách sỉ"' },
  msgId:          { label: 'ID tin nhắn', description: 'Mã tin nhắn - dùng để thả cảm xúc, trả lời trích dẫn, thu hồi.', example: '"7284562398"' },
  messageId:      { label: 'ID tin nhắn', description: 'Mã tin nhắn - dùng để thả cảm xúc, sửa, xoá, ghim.', example: '"mid.$abc123"' },
  cliMsgId:       { label: 'ID tin nhắn phía client', description: 'Mã tin do ứng dụng gửi tạo ra (dùng khi ID tin chưa có).' },
  timestamp:      { label: 'Thời điểm (ms)', description: 'Thời điểm sự kiện, tính bằng mili giây.', example: '"1775251200000"' },
  isSelf:         { label: 'Do mình gửi (true/false)', description: 'true nếu chính tài khoản này gửi tin.', example: '"false"' },
  zaloId:         { label: 'ID tài khoản Zalo nhận', description: 'Mã tài khoản Zalo của bạn đã nhận sự kiện.' },
  images:         { label: 'Danh sách URL ảnh', description: 'Mảng URL ảnh trong tin (nếu có). Lấy ảnh đầu: $trigger.images[0].', example: '["https://...jpg"]' },
  'images[0]':    { label: 'URL ảnh đầu tiên', description: 'Ảnh đầu tiên trong tin (rỗng nếu không có ảnh).' },
  userId:         { label: 'ID người gửi lời mời', description: 'Mã người gửi lời mời kết bạn - dùng để chấp nhận / từ chối / nhắn tin.' },
  displayName:    { label: 'Tên người gửi lời mời', description: 'Tên hiển thị của người gửi lời mời kết bạn.' },
  phone:          { label: 'SĐT người gửi lời mời', description: 'Số điện thoại kèm lời mời (nếu có).' },
  message:        { label: 'Lời nhắn kèm lời mời', description: 'Nội dung người gửi viết kèm lời mời kết bạn.' },
  groupId:        { label: 'ID nhóm', description: 'Mã nhóm nơi sự kiện xảy ra.' },
  eventType:      { label: 'Loại sự kiện', description: 'Loại sự kiện nhóm (join, leave, remove_member, update, add_admin, remove_admin...).', example: '"join"' },
  actorName:      { label: 'Người thực hiện', description: 'Tên người thực hiện hành động trong nhóm.' },
  actorId:        { label: 'ID người thực hiện', description: 'Mã người thực hiện hành động.' },
  targetNames:    { label: 'Thành viên bị tác động', description: 'Tên các thành viên chịu ảnh hưởng (cách nhau dấu phẩy).' },
  systemText:     { label: 'Thông báo hệ thống', description: 'Câu thông báo do Zalo tạo, VD "A đã thêm B vào nhóm".' },
  react:          { label: 'Cảm xúc', description: 'Mã cảm xúc người dùng đã thả.' },
  labelId:        { label: 'ID nhãn', description: 'Mã nhãn vừa được gán / gỡ.' },
  labelText:      { label: 'Tên nhãn', description: 'Tên nhãn vừa được gán / gỡ.', example: '"Khách VIP"' },
  labelColor:     { label: 'Màu nhãn', description: 'Mã màu của nhãn.' },
  labelEmoji:     { label: 'Emoji nhãn', description: 'Emoji của nhãn.' },
  labelSource:    { label: 'Nguồn nhãn', description: 'local (Nhãn Local) hoặc zalo (Nhãn Zalo).' },
  action:         { label: 'Hành động', description: 'assigned = vừa gán, removed = vừa gỡ.', example: '"assigned"' },
  amount:         { label: 'Số tiền', description: 'Số tiền của giao dịch.', example: '"239000"' },
  description:    { label: 'Nội dung chuyển khoản', description: 'Nội dung giao dịch ngân hàng.', example: '"Thanh toan don SPX011"' },
  bankName:       { label: 'Ngân hàng', description: 'Tên ngân hàng của giao dịch.' },
  accountNumber:  { label: 'Số tài khoản', description: 'Số tài khoản nhận tiền.' },
  transactionId:  { label: 'Mã giao dịch', description: 'Mã giao dịch từ ngân hàng / cổng thanh toán.' },
  transactionDate:{ label: 'Thời gian giao dịch', description: 'Thời điểm giao dịch do ngân hàng gửi.' },
  integrationId:  { label: 'ID kết nối tích hợp', description: 'Mã kết nối đã nhận webhook (Casso / SePay, phần mềm bán hàng).' },
  integrationType:{ label: 'Loại tích hợp', description: 'casso, sepay (thanh toán) hoặc kiotviet, haravan, sapo, nhanh, pancake (phần mềm bán hàng).' },
  integrationName:{ label: 'Tên kết nối', description: 'Tên kết nối phần mềm bán hàng đặt ở trang Tích hợp.', example: '"KiotViet - Chi nhánh 1"' },
  event:          { label: 'Tên sự kiện', description: 'Sự kiện nền tảng gửi: order.update / invoice.update (KiotViet), orders/paid (Haravan, Sapo), orderAdd / orderUpdate (Nhanh.vn), orders (Pancake).', example: '"orders/paid"' },
  entity:         { label: 'Loại dữ liệu', description: 'order, invoice, customer, product, inventory hoặc other.', example: '"order"' },
  code:           { label: 'Mã đơn / mã bản ghi', description: 'Mã đơn hàng (KiotViet Code, Haravan / Sapo name, Nhanh.vn / Pancake id) hoặc mã khách / sản phẩm.', example: '"DH000123"' },
  status:         { label: 'Trạng thái', description: 'Trạng thái đơn nền tảng gửi (Nhanh.vn: đã đổi mã số sang tên trạng thái).', example: '"Hoàn thành"' },
  customerName:   { label: 'Tên khách hàng', description: 'Tên người nhận / khách hàng của đơn.', example: '"Nguyễn Văn A"' },
  customerPhone:  { label: 'SĐT khách hàng', description: 'SĐT người nhận / khách hàng — tìm khách trên Zalo hoặc tra cứu POS.', example: '"0901234567"' },
  total:          { label: 'Tổng tiền đơn', description: 'Tổng tiền đơn do nền tảng gửi.', example: '"350000"' },
  data:           { label: 'Dữ liệu gốc', description: 'Toàn bộ bản ghi nền tảng gửi (JSON). Dùng $trigger.data.<trường> để lấy 1 trường.' },
  'data.<field>': { label: '1 trường trong dữ liệu gốc', description: 'Thay <field> bằng tên trường của nền tảng, hỗ trợ lồng nhau: $trigger.data.InvoiceDelivery.Receiver (KiotViet), $trigger.data.shipping_address.address1 (Haravan / Sapo).', example: '$trigger.data.Code → "DH000123"', isPattern: true },
  raw:            { label: 'Dữ liệu giao dịch gốc', description: 'Toàn bộ dữ liệu giao dịch (JSON). Dùng $trigger.raw.<trường> để lấy 1 trường.' },
  'body.<field>': { label: '1 trường trong dữ liệu webhook', description: 'Thay <field> bằng tên trường, hỗ trợ lồng nhau: $trigger.body.customer.name.', example: '$trigger.body.orderId → "ORD123"', isPattern: true },
  webhookBody:    { label: 'Toàn bộ dữ liệu webhook', description: 'JSON bên thứ 3 gửi đến.' },
  method:         { label: 'Phương thức HTTP', description: 'POST, GET, PUT...', example: '"POST"' },
  headers:        { label: 'Headers', description: 'HTTP headers của request webhook.' },
  query:          { label: 'Query string', description: 'Tham số trên URL. VD ?source=web → $trigger.query.source.' },
  rawBody:        { label: 'Body thô', description: 'Nội dung request dạng chuỗi gốc.' },
  attachments:    { label: 'Tệp đính kèm', description: 'Thông tin tệp / ảnh / video đính kèm (JSON).' },
  msgType:        { label: 'Loại tin', description: 'Loại tin nhắn (text, photo, video...).' },
  emoji:          { label: 'Emoji cảm xúc', description: 'Emoji người dùng đã thả.' },
  typeChat:       { label: 'Loại hội thoại', description: 'user = cá nhân; trống = nhóm.' },
  fbAccountId:    { label: 'ID tài khoản Facebook', description: 'Mã tài khoản Facebook đã nhận sự kiện.' },
  groupEventType: { label: 'Loại sự kiện nhóm', description: 'Loại sự kiện nhóm Facebook.' },
  participantId:  { label: 'ID thành viên', description: 'Thành viên chịu tác động.' },
  participants:   { label: 'Danh sách thành viên', description: 'Các thành viên liên quan (mảng).' },
  actorFbId:      { label: 'ID người thực hiện', description: 'Tài khoản Facebook thực hiện hành động.' },
  accountId:      { label: 'ID tài khoản nhận', description: 'Mã tài khoản đã nhận sự kiện.' },
  preview:        { label: 'Xem trước nội dung', description: 'Văn bản hiển thị của tin (kể cả tin media).' },
  callbackData:   { label: 'Dữ liệu nút bấm', description: 'callback_data của nút Inline user vừa bấm.', example: '"order:123"' },
  callbackQueryId:{ label: 'ID lượt bấm nút', description: 'Dùng cho node "Trả lời nút bấm".' },
  chatTitle:      { label: 'Tên nhóm / kênh', description: 'Tên chat Telegram (nhóm, kênh).' },
  chatType:       { label: 'Loại chat', description: 'private, group, supergroup, channel.', example: '"private"' },
};

/** Fields per trigger type, in display order. */
const ZALO_MESSAGE = ['content', 'fromName', 'fromId', 'threadId', 'isGroup', 'groupName', 'threadType', 'msgId', 'cliMsgId', 'images', 'images[0]', 'fromPhone', 'timestamp', 'isSelf', 'zaloId'];
const FB_MESSAGE = ['content', 'fromId', 'threadId', 'messageId', 'attachments', 'msgType', 'typeChat', 'isSelf', 'timestamp', 'fbAccountId'];
const TG_MESSAGE = ['content', 'fromName', 'fromId', 'chatId', 'threadId', 'isGroup', 'messageId', 'msgType', 'caption', 'preview', 'attachments', 'fromPhone', 'isSelf', 'timestamp', 'accountId'];
const TGBOT_MESSAGE = ['content', 'fromName', 'fromId', 'chatId', 'chatType', 'chatTitle', 'messageId', 'isSelf', 'timestamp', 'accountId'];

const TRIGGER_FIELDS: Record<string, string[]> = {
  'trigger.message':        ZALO_MESSAGE,
  'trigger.friendRequest':  ['displayName', 'userId', 'phone', 'message', 'zaloId'],
  'trigger.groupEvent':     ['eventType', 'groupId', 'actorName', 'targetNames', 'systemText', 'zaloId'],
  'trigger.reaction':       ['react', 'fromName', 'fromId', 'threadId', 'msgId', 'zaloId'],
  'trigger.labelAssigned':  ['labelText', 'action', 'threadId', 'threadType', 'labelId', 'labelSource', 'labelEmoji', 'labelColor', 'zaloId'],
  'trigger.payment':        ['amount', 'description', 'bankName', 'accountNumber', 'transactionId', 'transactionDate', 'integrationType', 'integrationId', 'raw'],
  'trigger.posWebhook':     ['event', 'entity', 'code', 'status', 'customerName', 'customerPhone', 'total', 'fromPhone', 'data', 'data.<field>', 'integrationType', 'integrationName', 'integrationId'],
  'trigger.webhook':        ['webhookBody', 'body.<field>', 'method', 'query', 'headers', 'rawBody'],
  'trigger.api':            ['eventName', 'payload', 'payload.<field>', 'keyId', 'source', 'accountId', 'receivedAt'],
  // "Chạy thử" gửi dữ liệu giả lập tin nhắn; chạy theo lịch thì không có dữ liệu kích hoạt
  'trigger.manual':         ['content', 'fromName', 'fromId', 'threadId', 'threadType', 'isGroup', 'zaloId', 'timestamp'],
  'trigger.schedule':       [],
  'fb.trigger.message':     FB_MESSAGE,
  'fb.trigger.image':       FB_MESSAGE,
  'fb.trigger.video':       FB_MESSAGE,
  'fb.trigger.file':        FB_MESSAGE,
  'fb.trigger.sticker':     FB_MESSAGE,
  'fb.trigger.reaction':    ['emoji', 'fromId', 'threadId', 'messageId', 'timestamp', 'fbAccountId'],
  'fb.trigger.unsend':      ['messageId', 'threadId', 'fbAccountId'],
  'fb.trigger.groupEvent':  ['groupEventType', 'threadId', 'actorFbId', 'participantId', 'participants', 'fbAccountId'],
  'tg.trigger.message':     TG_MESSAGE,
  'tg.trigger.unsend':      ['chatId', 'messageId', 'threadId', 'accountId', 'timestamp'],
  'tg.trigger.groupEvent':  ['chatId', 'fromId', 'fromName', 'content', 'accountId', 'timestamp'],
  'tgbot.trigger.message':       TGBOT_MESSAGE,
  'tgbot.trigger.command':       TGBOT_MESSAGE,
  'tgbot.trigger.editedMessage': TGBOT_MESSAGE,
  'tgbot.trigger.callback':      ['callbackData', 'callbackQueryId', 'fromName', 'fromId', 'chatId', 'messageId', 'accountId', 'timestamp'],
  'tgbot.trigger.join':          ['eventType', 'chatId', 'chatTitle', 'chatType', 'actorName', 'actorId', 'accountId', 'timestamp'],
  'tgbot.trigger.joinRequest':   ['fromName', 'fromId', 'chatId', 'chatTitle', 'accountId', 'timestamp'],
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
    // Mẫu '<object>.<field>' (body, payload, data): mọi trường con
    if (name.endsWith('.<field>')) return field.startsWith(name.slice(0, -'<field>'.length));
    if (OBJECT_FIELDS.has(name)) return field === name || field.startsWith(`${name}.`);
    return name === field || (name === 'images' && field.startsWith('images['));
  }));
}

// ─── Node outputs (mirror WorkflowEngineService.executeNode return values) ────

export interface OutputDef { path: string; label: string; description?: string; isPattern?: boolean }

// Node tra cứu POS (cùng dạng kết quả cho KiotViet / Haravan / Sapo / Nhanh.vn / Pancake). SĐT + mã đơn trống thì engine
// không tra cứu và trả found = false (services/workflow/posLookupGuard.ts).
const POS_CUSTOMER_OUTPUTS: OutputDef[] = [
  { path: 'found', label: 'Tìm thấy khách (true/false)', description: 'false cả khi SĐT trống (không tra cứu).' },
  { path: 'firstCustomer', label: 'Khách hàng tìm thấy đầu tiên' },
  { path: 'firstCustomer.<field>', label: '1 trường của khách hàng', description: 'Tên trường theo từng nền tảng, VD KiotViet: name, contactNumber, rewardPoint.', isPattern: true },
  { path: 'customers', label: 'Danh sách khách hàng' },
];
const POS_ORDER_OUTPUTS: OutputDef[] = [
  { path: 'found', label: 'Tìm thấy đơn (true/false)', description: 'false cả khi SĐT và mã đơn trống (không tra cứu).' },
  { path: 'order', label: 'Đơn hàng mới nhất' },
  { path: 'order.<field>', label: '1 trường của đơn hàng', description: 'Tên trường theo từng nền tảng, VD KiotViet: code, statusValue, total; Haravan: name, total_price.', isPattern: true },
  { path: 'orders', label: 'Danh sách đơn hàng' },
];
const POS_PRODUCT_OUTPUTS: OutputDef[] = [
  { path: 'found', label: 'Tìm thấy sản phẩm (true/false)' },
  { path: 'products', label: 'Danh sách sản phẩm', description: 'Dùng làm danh sách của "Lặp qua danh sách" để liệt kê từng sản phẩm.' },
  { path: 'products[0].<field>', label: '1 trường của sản phẩm đầu tiên', isPattern: true },
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
  'ai.generateText':     [{ path: 'result', label: 'Nội dung AI trả lời' }, { path: 'model', label: 'Model đã dùng' }, { path: 'totalTokens', label: 'Số token đã dùng' }],
  'ai.classify':         [{ path: 'category', label: 'Nhóm AI phân loại' }, { path: 'input', label: 'Văn bản đã phân loại' }],
  'data.textFormat':     [{ path: 'result', label: 'Văn bản đã ghép' }],
  'data.randomPick':     [{ path: 'result', label: 'Mục được chọn ngẫu nhiên' }],
  'data.dateFormat':     [{ path: 'result', label: 'Ngày giờ đã định dạng' }, { path: 'timestamp', label: 'Timestamp (ms)' }],
  'data.jsonParse':      [{ path: 'data', label: 'Object đã đọc' }, { path: 'data.<field>', label: '1 trường của object', isPattern: true }],
  'output.httpRequest':  [{ path: 'status', label: 'Mã trạng thái HTTP' }, { path: 'data', label: 'Dữ liệu phản hồi' }, { path: 'data.<field>', label: '1 trường của phản hồi', isPattern: true }],
  'zalo.findUser':       [{ path: 'userId', label: 'ID người dùng tìm được' }, { path: 'displayName', label: 'Tên hiển thị' }, { path: 'avatar', label: 'Ảnh đại diện' }, { path: 'isFriend', label: 'Đã là bạn bè' }],
  'zalo.getUserInfo':    [{ path: '<field>', label: '1 trường thông tin người dùng', description: 'VD: displayName, avatar, gender…', isPattern: true }],
  'zalo.getMessageHistory': [{ path: 'messages', label: 'Danh sách tin nhắn' }],
  'sheets.readValues':   [{ path: 'firstRow[0]', label: 'Ô đầu tiên của dòng đầu' }, { path: 'rows', label: 'Tất cả các dòng' }, { path: 'count', label: 'Số dòng' }, { path: 'firstRow', label: 'Dòng đầu tiên' }],
  'logic.forEachContact': [{ path: 'result', label: 'Danh sách ID người nhận (JSON)', description: 'Dán vào "Danh sách hội thoại động" của node gửi tin để gửi hàng loạt.' }, { path: 'count', label: 'Số người nhận' }, { path: 'items', label: 'Danh sách người nhận (ID + tên)' }],
  'logic.forEach':       [{ path: 'count', label: 'Số phần tử trong danh sách' }, { path: 'processed', label: 'Số phần tử đã lặp' }, { path: 'items', label: 'Danh sách phần tử' }],
  'logic.if':            [{ path: 'result', label: 'Kết quả điều kiện (true/false)' }, { path: 'branch', label: 'Nhánh đã chạy' }],
  'logic.switch':        [{ path: 'value', label: 'Giá trị đã so sánh' }, { path: 'matchedHandle', label: 'Nhánh khớp' }],
};

export interface VarNode { id: string; label: string; type: string; config?: Record<string, any> }

interface VarEdge { source: string; target: string; sourceHandle?: string | null; data?: { telegramInline?: boolean } | null }

/**
 * Node đã chạy trước `nodeId` (gợi ý $node.* / $var.*, kiểm tra của AI copilot): mọi node phía trước theo cạnh nối; với
 * node nằm sau cổng "Xong" của "Lặp qua danh sách" thì thêm cả thân vòng lặp (chạy xong trước nhánh Xong — biến ghép
 * trong vòng lặp dùng được ở đây).
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
      label: 'Kết quả chính',
      description: 'Văn bản kết quả (result / text / message) hoặc toàn bộ dữ liệu dạng JSON.',
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

/** `$var.<name>` for "Lưu giá trị vào biến" nodes, the item of "Lặp qua danh sách" nodes (plus the generic pattern). */
export function getVariableVars(nodes: VarNode[]): TemplateVarInfo[] {
  const names = new Set<string>();
  const loopVars: TemplateVarInfo[] = [];
  for (const node of nodes) {
    if (node.type === 'logic.forEach') {
      const item = forEachVariableName(node.config?.itemVariable);
      if (loopVars.some(v => v.key === `$var.${item}`)) continue;
      loopVars.push(
        { key: `$var.${item}`, label: 'Phần tử đang lặp', description: `Phần tử hiện tại của "${node.label || 'Lặp qua danh sách'}" — chỉ có ở các bước nối từ cổng "Mỗi phần tử".`, group: 'variable' },
        { key: `$var.${item}.<field>`, label: '1 trường của phần tử đang lặp', description: 'Thay <field> bằng tên trường, VD $var.item.name.', group: 'variable', isPattern: true },
        { key: `$var.${item}Index`, label: 'Số thứ tự phần tử (từ 1)', description: 'Lượt lặp hiện tại: 1, 2, 3…', group: 'variable' },
      );
      continue;
    }
    const name = node.type === 'logic.setVariable' ? String(node.config?.name ?? '').trim() : '';
    if (name && !name.includes('{{')) names.add(name);
  }
  const vars: TemplateVarInfo[] = [...loopVars, ...[...names].map(name => ({
    key: `$var.${name}`,
    label: `Biến "${name}"`,
    description: 'Giá trị đã lưu bằng node "Lưu giá trị vào biến" ở bước trước.',
    group: 'variable' as const,
  }))];
  vars.push({
    key: '$var.<tên_biến>',
    label: 'Biến tự đặt khác',
    description: 'Thay <tên_biến> bằng tên đã đặt trong node "Lưu giá trị vào biến".',
    group: 'variable',
    isPattern: true,
  });
  return vars;
}

export const DATE_VARS: TemplateVarInfo[] = [
  { key: '$date.now', label: 'Ngày giờ hiện tại', description: 'Theo giờ Việt Nam, dạng dd/MM/yyyy HH:mm:ss.', example: '"13/10/2026 14:30:00"', group: 'date' },
  { key: '$date.today', label: 'Ngày hôm nay', description: 'Theo giờ Việt Nam, dạng dd/MM/yyyy.', example: '"13/10/2026"', group: 'date' },
];

export const ACCOUNT_VARS: TemplateVarInfo[] = [
  { key: '$pageId', label: 'ID tài khoản đang chạy', description: 'Tài khoản đang thực thi workflow (Zalo / Facebook / Telegram).', group: 'account' },
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
