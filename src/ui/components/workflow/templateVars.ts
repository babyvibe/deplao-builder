import { CalendarIcon, LinkIcon, PackageIcon, SendIcon, UserIcon } from '@/components/common/icons';
/**
 * Template Variable definitions for Workflow Node Config.
 * Mỗi variable là một từ khoá mà người dùng có thể chèn vào config field
 * bằng cú pháp {{ $trigger.fromName }} hoặc {{ $node.[label].output }}.
 *
 * File này là single source of truth cho tất cả template variables -
 * nếu thêm variable mới ở engine, phải thêm vào đây để UI hiển thị.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TemplateVarInfo {
  /** Cú pháp đầy đủ, VD: '$trigger.fromName' */
  key: string;
  /** Tên hiển thị ngắn gọn, VD: 'Tên người gửi' */
  label: string;
  /** Mô tả chi tiết - hiển thị trong popup */
  description: string;
  /** Nhóm để phân loại trong popup */
  group: TemplateVarGroup;
  /** Chỉ áp dụng cho các node type này. null = tất cả node */
  nodeTypes?: string[];
  /** Ví dụ giá trị (nếu có thể tính trước) */
  example?: string;
}

export type TemplateVarGroup =
  | 'trigger'       // Dữ liệu từ event kích hoạt (tin nhắn, sự kiện...)
  | 'date'          // Ngày giờ hiện tại
  | 'variable'      // Biến do người dùng đặt (logic.setVariable)
  | 'node'          // Output từ node khác (dùng NodePicker)
  | 'page'          // Thông tin tài khoản Zalo
  ;

export const TEMPLATE_VAR_GROUP_LABELS: Record<TemplateVarGroup, string> = {
  trigger:   '📩 Dữ liệu kích hoạt (Trigger)',
  date:      '📅 Ngày giờ',
  variable:  '📦 Biến (Variable)',
  node:      '🔗 Output từ node khác',
  page:      '👤 Thông tin tài khoản',
};

// ─── Definitions ──────────────────────────────────────────────────────────────

/**
 * Danh sách tất cả template variables có sẵn trong workflow engine.
 * Đây là source of truth - UI popup sẽ đọc từ đây.
 *
 * Khi thêm variable mới trong WorkflowEngineService.ts (flattenTriggerData, renderTemplate),
 * phải thêm vào đây để người dùng thấy được trong UI.
 */
export const TEMPLATE_VARS: TemplateVarInfo[] = [
  // ── Trigger: message ────────────────────────────────────────────────────
  {
    key: '$trigger.content',
    label: 'Nội dung tin nhắn',
    description: 'Toàn bộ nội dung văn bản của tin nhắn đã kích hoạt workflow. VD: "SPX011", "Xin chào", ...',
    group: 'trigger',
    example: '"SPX011"',
  },
  {
    key: '$trigger.fromId',
    label: 'ID người gửi',
    description: 'Mã định danh Zalo của người đã gửi tin nhắn. Dùng để gửi reply hoặc tra cứu thông tin.',
    group: 'trigger',
    example: '"12345678"',
  },
  {
    key: '$trigger.fromName',
    label: 'Tên người gửi',
    description: 'Tên hiển thị (display name) của người đã gửi tin nhắn kích hoạt workflow.',
    group: 'trigger',
    example: '"Nguyễn Văn A"',
  },
  {
    key: '$trigger.fromPhone',
    label: 'Số điện thoại người gửi',
    description: 'Số điện thoại của người gửi (nếu có trong danh bạ Zalo).',
    group: 'trigger',
    example: '"0901234567"',
  },
  {
    key: '$trigger.threadId',
    label: 'ID hội thoại',
    description: 'Mã định danh của hội thoại chứa tin nhắn. Dùng để gửi tin nhắn reply đúng hội thoại.',
    group: 'trigger',
    example: '"987654"',
  },
  {
    key: '$trigger.threadType',
    label: 'Loại hội thoại (0/1)',
    description: '0 = hội thoại cá nhân, 1 = hội thoại nhóm. Thường dùng trong select option.',
    group: 'trigger',
    example: '"0"',
  },
  {
    key: '$trigger.isGroup',
    label: 'Có phải nhóm không (true/false)',
    description: 'true nếu tin nhắn đến từ nhóm, false nếu là chat cá nhân.',
    group: 'trigger',
    example: '"false"',
  },
  {
    key: '$trigger.msgId',
    label: 'ID tin nhắn',
    description: 'Mã định danh duy nhất của tin nhắn đã kích hoạt workflow. Dùng để reaction, thu hồi...',
    group: 'trigger',
    example: '"msg_abc123"',
  },
  {
    key: '$trigger.groupName',
    label: 'Tên nhóm',
    description: 'Tên của nhóm Zalo nếu tin nhắn đến từ nhóm.',
    group: 'trigger',
    example: '"Nhóm bán hàng"',
  },
  {
    key: '$trigger.timestamp',
    label: 'Thời gian gửi (timestamp ms)',
    description: 'Thời điểm tin nhắn được gửi, tính bằng mili giây từ epoch.',
    group: 'trigger',
    example: '"1775251200000"',
  },
  {
    key: '$trigger.zaloId',
    label: 'Zalo ID tài khoản nhận',
    description: 'Mã Zalo của tài khoản đã nhận được tin nhắn này (tài khoản của bạn).',
    group: 'trigger',
    example: '"999999"',
  },
  // Trigger: images (từ message có ảnh)
  {
    key: '$trigger.images',
    label: 'Danh sách URL ảnh (mảng)',
    description: 'Mảng chứa URL các ảnh đính kèm trong tin nhắn (nếu có).',
    group: 'trigger',
    example: '["https://...jpg"]',
  },

  // ── Trigger: friendRequest ──────────────────────────────────────────────
  {
    key: '$trigger.userId',
    label: 'ID người dùng (lời mời kết bạn)',
    description: 'Mã Zalo của người gửi lời mời kết bạn. Dùng để tự động chấp nhận/từ chối.',
    group: 'trigger',
    example: '"12345678"',
  },
  {
    key: '$trigger.displayName',
    label: 'Tên người gửi lời mời',
    description: 'Tên hiển thị của người gửi lời mời kết bạn.',
    group: 'trigger',
    example: '"Lê Thị B"',
  },

  // ── Trigger: groupEvent ─────────────────────────────────────────────────
  {
    key: '$trigger.groupId',
    label: 'ID nhóm (sự kiện)',
    description: 'Mã định danh của nhóm nơi sự kiện xảy ra.',
    group: 'trigger',
  },
  {
    key: '$trigger.eventType',
    label: 'Loại sự kiện nhóm',
    description: 'Loại sự kiện: join, leave, remove_member, update, add_admin, remove_admin.',
    group: 'trigger',
    example: '"join"',
  },
  {
    key: '$trigger.actorName',
    label: 'Người thực hiện (sự kiện nhóm)',
    description: 'Tên của người đã thực hiện hành động (VD: mời thành viên, xoá thành viên...).',
    group: 'trigger',
  },
  {
    key: '$trigger.targetNames',
    label: 'Người bị tác động (sự kiện nhóm)',
    description: 'Tên của (các) thành viên bị ảnh hưởng bởi sự kiện.',
    group: 'trigger',
  },
  {
    key: '$trigger.systemText',
    label: 'Nội dung hệ thống (sự kiện nhóm)',
    description: 'Nội dung mô tả sự kiện do Zalo tạo (VD: "A đã thêm B vào nhóm").',
    group: 'trigger',
  },

  // ── Trigger: reaction ───────────────────────────────────────────────────
  {
    key: '$trigger.react',
    label: 'Loại reaction (1-6)',
    description: 'Mã cảm xúc: 1=Like, 2=Yêu thích, 3=Haha, 4=Wow, 5=Buồn, 6=Giận.',
    group: 'trigger',
    example: '"1"',
  },

  // ── Trigger: payment ────────────────────────────────────────────────────
  {
    key: '$trigger.amount',
    label: 'Số tiền thanh toán',
    description: 'Số tiền của giao dịch thanh toán từ webhook Casso/SePay.',
    group: 'trigger',
    example: '"239000"',
  },
  {
    key: '$trigger.description',
    label: 'Nội dung chuyển khoản',
    description: 'Nội dung tin nhắn chuyển khoản từ webhook ngân hàng.',
    group: 'trigger',
    example: '"Thanh toán đơn SPX011"',
  },
  {
    key: '$trigger.bankName',
    label: 'Tên ngân hàng',
    description: 'Tên ngân hàng thực hiện giao dịch.',
    group: 'trigger',
  },
  {
    key: '$trigger.transactionId',
    label: 'Mã giao dịch',
    description: 'Mã giao dịch duy nhất từ ngân hàng.',
    group: 'trigger',
  },

  // ── Trigger: webhook ────────────────────────────────────────────────────
  {
    key: '$trigger.body',
    label: 'Toàn bộ dữ liệu webhook (JSON)',
    description: 'Toàn bộ nội dung JSON mà bên thứ 3 gửi đến. Dùng $trigger.body.field để lấy 1 trường cụ thể.',
    group: 'trigger',
    example: '{"orderId":"ORD123","customer":{...}}',
  },
  {
    key: '$trigger.body.<field>',
    label: '1 trường bất kỳ trong webhook',
    description: 'Truy cập 1 trường cụ thể từ JSON. VD: $trigger.body.orderId, $trigger.body.customer.name. Hỗ trợ nested object với dấu chấm.',
    group: 'trigger',
    example: '$trigger.body.orderId → "ORD123"',
  },
  {
    key: '$trigger.method',
    label: 'Phương thức HTTP',
    description: 'Phương thức HTTP mà bên thứ 3 dùng để gửi webhook (POST, GET, PUT...).',
    group: 'trigger',
    example: '"POST"',
  },
  {
    key: '$trigger.headers',
    label: 'Headers của request webhook',
    description: 'Toàn bộ HTTP headers từ request của bên thứ 3.',
    group: 'trigger',
    example: '{"content-type":"application/json"}',
  },
  {
    key: '$trigger.query',
    label: 'Query string params',
    description: 'Các tham số trên URL (sau dấu ?). VD: ?source=web → $trigger.query.source = "web".',
    group: 'trigger',
    example: '{"source":"web"}',
  },

  // ── Date / Time ─────────────────────────────────────────────────────────
  {
    key: '$date.now',
    label: 'Thời gian hiện tại (vi-VN)',
    description: 'Ngày giờ hiện tại theo định dạng Việt Nam (dd/MM/yyyy HH:mm:ss).',
    group: 'date',
    example: '"13/06/2026 14:30:00"',
  },
  {
    key: '$date.today',
    label: 'Ngày hiện tại (vi-VN)',
    description: 'Ngày hiện tại theo định dạng Việt Nam (dd/MM/yyyy).',
    group: 'date',
    example: '"13/06/2026"',
  },

  // ── Page / Account ──────────────────────────────────────────────────────
  {
    key: '$pageId',
    label: 'Zalo ID tài khoản đang xử lý',
    description: 'Mã Zalo của tài khoản đang thực thi workflow này.',
    group: 'page',
    example: '"999999"',
  },

  // ── Variable ────────────────────────────────────────────────────────────
  {
    key: '$var.<tên_biến>',
    label: 'Biến tự đặt (logic.setVariable)',
    description: 'Giá trị của biến đã được lưu bằng node logic.setVariable ở bước trước. Thay <tên_biến> bằng tên bạn đã đặt.',
    group: 'variable',
    example: '{{ $var.customerName }}',
  },
];

/** Map để tra cứu nhanh: key → TemplateVarInfo */
export const TEMPLATE_VAR_MAP = new Map<string, TemplateVarInfo>(
  TEMPLATE_VARS.map(v => [v.key, v])
);

/**
 * Lấy danh sách template variables phù hợp với 1 node type cụ thể.
 * @param nodeType Loại node hiện tại (VD: 'zalo.sendMessage')
 * @returns Danh sách variable đã lọc theo nodeTypes
 */
export function getTemplateVarsForNode(nodeType?: string): TemplateVarInfo[] {
  if (!nodeType) return TEMPLATE_VARS;
  return TEMPLATE_VARS.filter(v => !v.nodeTypes || v.nodeTypes.includes(nodeType));
}

/**
 * Lấy variables theo nhóm (trigger, date, variable, page)
 */
export function getTemplateVarsByGroup(nodeType?: string): Map<TemplateVarGroup, TemplateVarInfo[]> {
  const vars = getTemplateVarsForNode(nodeType);
  const grouped = new Map<TemplateVarGroup, TemplateVarInfo[]>();
  for (const v of vars) {
    const list = grouped.get(v.group) || [];
    list.push(v);
    grouped.set(v.group, list);
  }
  return grouped;
}

/**
 * Lấy danh sách node labels từ danh sách node workflow để hiển thị
 * dưới dạng $node.<label>.output và $node.<label>.data.field
 */
export function getNodeOutputVars(
  allNodes: { id: string; label: string; type: string }[],
  currentId?: string
): TemplateVarInfo[] {
  return allNodes
    .filter(n => n.id !== currentId)
    .map(n => ({
      key: `$node.${n.label}.output`,
      label: `Output từ "${n.label}"`,
      description: `Toàn bộ dữ liệu đầu ra của node "${n.label}" (${n.type}). Dùng .data.field để lấy trường cụ thể.`,
      group: 'node' as TemplateVarGroup,
    }));
}
