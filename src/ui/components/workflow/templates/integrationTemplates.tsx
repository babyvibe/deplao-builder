import { DEFAULT_CONFIGS } from '../nodes/workflowConfig';
import { WorkflowTemplate } from './workflowTemplates';
import { BellIcon, BotIcon, ChartIcon, CreditCardIcon, LightningIcon, PackageIcon, ShoppingCartIcon, StarIcon, TagIcon, TrendingDownIcon, TruckIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';


// ── Integration Templates ──────────────────────────────────────────────────────
// Sample workflows that combine integrations: KiotViet, Haravan, Nhanh.vn, Sapo, GHN, Casso/SePay (payment trigger),
// Google Sheets, Telegram. Only use engine syntax that actually runs (checked in src/__tests__/integrations/integrationTemplates.test.ts):
//  - {{ }} holds ONE variable only ($trigger.*, $node.<id>.*, $var.*, $date.*), with no filter ("| formatVND"…) or arithmetic;
//  - $trigger.* uses exactly the trigger's fields (payment has amount, description, bankName, accountNumber, transactionId,
//    transactionDate…, no threadId / sender phone number);
//  - payment / appointment triggers have no conversation → only send to a preset target (internal Zalo group, Telegram, Sheets);
//  - listing many rows (products, stock) = "Lặp qua danh sách" (loop over list) + "Lưu giá trị vào biến" (save value to variable), send at the "Xong" (done) gate.
// ──────────────────────────────────────────────────────────────────────────────

/** Personal message trigger (order / points info is not sent to the group), filtered by keyword. */
function privateMessageTrigger(keyword: string, extra: Record<string, any> = {}) {
  return { ...DEFAULT_CONFIGS['trigger.message'], threadType: '0', keyword, keywordMode: 'contains_any', ...extra };
}

const ORDER_KEYWORDS = tr('đơn hàng, don hang, kiểm tra đơn, kiem tra don, check đơn, check don');

const NO_SAVED_PHONE_REPLY =
  tr('😥 Mình chưa tìm thấy đơn hàng theo số điện thoại bạn đã lưu với shop.\n\nBạn gửi giúp mình số điện thoại đặt hàng hoặc mã đơn để shop kiểm tra nhé!', {  });

export const INTEGRATION_TEMPLATES: WorkflowTemplate[] = [

  // ━━━━━ 1. Payment received → notify internal Zalo group ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-notify-group',
    name: tr('Nhận tiền → Báo nhóm Zalo nội bộ'),
    description:
      tr('Khi Casso hoặc SePay báo có chuyển khoản mới, gửi ngay số tiền, nội dung chuyển khoản, ngân hàng và mã giao dịch vào nhóm Zalo nội bộ để nhân viên đối chiếu, xác nhận đơn. Giao dịch không gắn với hội thoại nào → chọn nhóm nhận ở bước "Báo nhóm nội bộ" và tài khoản Zalo gửi khi cài mẫu.'),
    category: 'tich-hop',
    tags: [tr('thanh toán'), 'casso', 'sepay', 'vietqr', tr('thông báo'), tr('nhóm nội bộ')],
    icon: <CreditCardIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: tr('Nhận thanh toán (Casso/SePay)'),
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'] },
      },
      {
        id: 'n2', type: 'zalo.sendMessage', label: tr('Báo nhóm nội bộ (chọn nhóm)'),
        position: { x: 300, y: 220 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          threadId: '', threadIds: '', threadType: '1',
          message:
            tr('💰 Có tiền vào!\n\nSố tiền: {{ $trigger.amount }}đ\nNội dung CK: {{ $trigger.description }}\nNgân hàng: {{ $trigger.bankName }} - TK {{ $trigger.accountNumber }}\nMã GD: {{ $trigger.transactionId }}\nThời gian: {{ $trigger.transactionDate }}\n\n👉 Đối chiếu nội dung chuyển khoản để xác nhận đơn cho khách.', {  }),
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 2. Log payments to Google Sheets ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-sheet-log',
    name: tr('Ghi nhật ký giao dịch vào Google Sheets'),
    description:
      tr('Mỗi giao dịch Casso / SePay mới được ghi thành một dòng Google Sheets (thời gian, số tiền, nội dung, ngân hàng, số tài khoản, mã giao dịch) và báo nhanh qua Telegram. Điền ID bảng tính, file Service Account và Bot Telegram trước khi bật.'),
    category: 'tich-hop',
    tags: [tr('thanh toán'), 'google sheets', tr('nhật ký'), 'casso', 'sepay', tr('kế toán')],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: tr('Nhận thanh toán'),
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 1000 },
      },
      {
        id: 'n2', type: 'sheets.appendRow', label: tr('Ghi vào Google Sheets'),
        position: { x: 300, y: 220 },
        config: {
          ...DEFAULT_CONFIGS['sheets.appendRow'],
          sheetName: 'GiaoDich',
          values:
            '["{{ $trigger.transactionDate }}", "{{ $trigger.amount }}", "{{ $trigger.description }}", ' +
            '"{{ $trigger.bankName }}", "{{ $trigger.accountNumber }}", "{{ $trigger.transactionId }}"]',
        },
      },
      {
        id: 'n3', type: 'notify.telegram', label: tr('Thông báo Telegram'),
        position: { x: 300, y: 380 },
        config: {
          ...DEFAULT_CONFIGS['notify.telegram'],
          message:
            tr('💰 Giao dịch mới\n\nSố tiền: {{ $trigger.amount }}đ\nNội dung: {{ $trigger.description }}\nNgân hàng: {{ $trigger.bankName }} - TK {{ $trigger.accountNumber }}\nThời gian: {{ $trigger.transactionDate }}', {  }),
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 3. Large payment alert → Telegram ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-alert-big',
    name: tr('Cảnh báo khi nhận thanh toán lớn'),
    description:
      tr('Giao dịch từ 5.000.000đ trở lên → gửi cảnh báo ngay qua Telegram cho quản lý kèm số tiền, nội dung chuyển khoản, ngân hàng và thời gian. Đổi ngưỡng ở bước "Nhận thanh toán ≥ 5 triệu".'),
    category: 'tich-hop',
    tags: [tr('cảnh báo'), tr('thanh toán lớn'), 'telegram', 'casso', 'sepay', tr('kế toán')],
    icon: <BellIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: tr('Nhận thanh toán ≥ 5 triệu'),
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 5000000 },
      },
      {
        id: 'n2', type: 'notify.telegram', label: tr('Cảnh báo Telegram'),
        position: { x: 300, y: 220 },
        config: {
          ...DEFAULT_CONFIGS['notify.telegram'],
          message:
            tr('🚨 THANH TOÁN LỚN!\n\n💰 Số tiền: {{ $trigger.amount }}đ\n📝 Nội dung: {{ $trigger.description }}\n🏦 {{ $trigger.bankName }} - TK {{ $trigger.accountNumber }}\n🧾 Mã GD: {{ $trigger.transactionId }}\n⏰ Thời gian: {{ $trigger.transactionDate }}', {  }),
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 4. KiotViet order lookup by phone ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-lookup-order-kiotviet',
    name: tr('Tra cứu đơn hàng KiotViet qua Zalo'),
    description:
      tr('Khách nhắn riêng "đơn hàng" / "kiểm tra đơn" → bot tra đơn mới nhất trong KiotViet theo SĐT đã lưu của khách (Thông tin hội thoại / CRM) và trả mã đơn, trạng thái, tổng tiền. Khách chưa lưu SĐT hoặc không có đơn → nhờ khách gửi SĐT đặt hàng / mã đơn.'),
    category: 'tich-hop',
    tags: ['kiotviet', tr('tra đơn'), tr('trạng thái'), 'CSKH', 'zalo'],
    icon: <PackageIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: tr('Khách hỏi đơn hàng'),
        position: { x: 300, y: 60 },
        config: privateMessageTrigger(ORDER_KEYWORDS),
      },
      {
        id: 'n2', type: 'kiotviet.lookupOrder', label: tr('Tra đơn KiotViet'),
        position: { x: 300, y: 210 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: tr('Tìm thấy đơn?'),
        position: { x: 300, y: 360 },
        config: { left: '{{ $node.n2.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi thông tin đơn hàng'),
        position: { x: 100, y: 530 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            tr('📦 Đơn hàng mới nhất của bạn:\n\n🔖 Mã đơn: {{ $node.n2.order.code }}\n📌 Trạng thái: {{ $node.n2.order.statusValue }}\n💰 Tổng tiền: {{ $node.n2.order.total }}đ\n📅 Ngày tạo: {{ $node.n2.order.createdDate }}\n\nBạn cần hỗ trợ thêm gì không ạ? 😊', {  }),
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: tr('Không tìm thấy đơn'),
        position: { x: 500, y: 530 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: NO_SAVED_PHONE_REPLY },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 5. Price question → AI gets product name → KiotViet lookup → quote ━━━━━━━━━━━━━
  {
    id: 'tpl-int-lookup-product-price',
    name: tr('Hỏi giá → Tra sản phẩm KiotViet'),
    description:
      tr('Khách hỏi giá → AI lấy tên sản phẩm trong câu hỏi → tìm trong KiotViet → gửi MỘT tin liệt kê tối đa 5 sản phẩm kèm giá bán (dùng "Lặp qua danh sách"). Chọn trợ lý AI ở bước "AI lấy tên sản phẩm" trước khi bật.'),
    category: 'tich-hop',
    tags: ['kiotviet', tr('sản phẩm'), tr('báo giá'), 'AI', tr('bán hàng')],
    icon: <TagIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: tr('Khách hỏi giá'),
        position: { x: 300, y: 50 },
        config: {
          ...DEFAULT_CONFIGS['trigger.message'],
          keyword: 'giá, báo giá, bao gia, bao nhiêu tiền, bao nhieu tien, gia bao nhieu',
          keywordMode: 'contains_any',
        },
      },
      {
        id: 'n2', type: 'ai.generateText', label: tr('AI lấy tên sản phẩm'),
        position: { x: 300, y: 190 },
        config: {
          aiConfigMode: 'assistant', assistantId: '',
          prompt:
            'Tin nhắn của khách: "{{ $trigger.content }}"\n\n' +
            'Chỉ trả lời đúng tên sản phẩm khách đang hỏi giá, ngắn gọn (vd: áo thun trắng), không thêm chữ nào khác. ' +
            'Không có tên sản phẩm thì trả lời: KHONG_RO',
        },
      },
      {
        id: 'n3', type: 'kiotviet.lookupProduct', label: tr('Tìm sản phẩm KiotViet'),
        position: { x: 300, y: 330 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupProduct'], keyword: '{{ $node.n2.result }}', limit: 5 },
      },
      {
        id: 'n4', type: 'logic.if', label: tr('Có sản phẩm?'),
        position: { x: 300, y: 470 },
        config: { left: '{{ $node.n3.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n5', type: 'logic.forEach', label: tr('Từng sản phẩm'),
        position: { x: 120, y: 620 },
        config: { ...DEFAULT_CONFIGS['logic.forEach'], array: '{{ $node.n3.products }}', itemVariable: 'item', maxItems: 5 },
      },
      {
        id: 'n6', type: 'logic.setVariable', label: tr('Thêm vào bảng giá'),
        position: { x: 0, y: 780 },
        config: { name: 'bangGia', value: '{{ $var.bangGia }}\n• {{ $var.item.name }}: {{ $var.item.basePrice }}đ' },
      },
      {
        id: 'n7', type: 'zalo.sendMessage', label: tr('Gửi bảng giá'),
        position: { x: 260, y: 780 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message: tr('🏷️ Giá sản phẩm bạn hỏi:\n{{ $var.bangGia }}\n\nBạn muốn đặt sản phẩm nào ạ? 😊'),
        },
      },
      {
        id: 'n8', type: 'zalo.sendMessage', label: tr('Hỏi lại tên sản phẩm'),
        position: { x: 520, y: 620 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message: tr('Dạ bạn cho mình xin tên sản phẩm cụ thể để shop báo giá nhé! 😊'),
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true',    target: 'n5' },
      { id: 'e5', source: 'n5', sourceHandle: 'default', target: 'n6' },
      { id: 'e6', source: 'n5', sourceHandle: 'done',    target: 'n7' },
      { id: 'e7', source: 'n4', sourceHandle: 'false',   target: 'n8' },
    ],
  },

  // ━━━━━ 6. GHN shipment lookup from a message ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-tracking-ghn',
    name: tr('Tra vận đơn GHN từ tin nhắn Zalo'),
    description:
      tr('Khách nhắn riêng đúng mã vận đơn GHN (chữ + số, vd GAPN9X3K) → bot trả trạng thái vận chuyển và thời điểm cập nhật từ GHN Express. Mã sai hoặc không tra được → nhờ khách kiểm tra lại mã.'),
    category: 'tich-hop',
    tags: ['GHN', tr('vận đơn'), tr('giao hàng'), tr('theo dõi'), tr('trạng thái')],
    icon: <TruckIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: tr('Khách gửi mã vận đơn'),
        position: { x: 300, y: 60 },
        // The whole message is one 6-14 character code with both letters and digits (does not catch phone numbers / normal sentences)
        config: privateMessageTrigger('^(?=.*\\d)(?=.*[a-z])[a-z0-9]{6,14}$', { keywordMode: 'regex' }),
      },
      {
        id: 'n2', type: 'ghn.getTracking', label: tr('Tra trạng thái GHN'),
        position: { x: 300, y: 210 },
        config: { ...DEFAULT_CONFIGS['ghn.getTracking'], orderCode: '{{ $trigger.content }}', continueOnError: true },
      },
      {
        id: 'n3', type: 'logic.if', label: tr('Tra được vận đơn?'),
        position: { x: 300, y: 360 },
        config: { left: '{{ $node.n2.status }}', operator: 'not_empty', right: '' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi trạng thái vận đơn'),
        position: { x: 100, y: 520 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            tr('🚚 Vận đơn GHN {{ $node.n2.orderCode }}\n\n📦 Trạng thái: {{ $node.n2.status }}\n🕒 Cập nhật lúc: {{ $node.n2.updatedDate }}\n\nCần hỗ trợ thêm gì không ạ? 😊', {  }),
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: tr('Không tra được'),
        position: { x: 500, y: 520 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message: tr('Mình chưa tra được vận đơn "{{ $trigger.content }}" trên GHN. Bạn kiểm tra lại mã giúp mình nhé!'),
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 7. KiotViet customer points lookup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-loyalty-points',
    name: tr('Tra điểm tích luỹ KiotViet'),
    description:
      tr('Khách nhắn riêng "tích điểm" / "xem điểm" → bot tra khách hàng KiotViet theo SĐT đã lưu của khách và gửi điểm hiện tại, tổng chi tiêu. Khách chưa lưu SĐT hoặc không có trong KiotViet → nhờ khách gửi SĐT mua hàng.'),
    category: 'tich-hop',
    tags: ['kiotviet', tr('tích điểm'), 'loyalty', tr('khách hàng')],
    icon: <StarIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: tr('Khách hỏi điểm'),
        position: { x: 300, y: 60 },
        config: privateMessageTrigger(tr('tích điểm, tich diem, xem điểm, xem diem, điểm tích lũy, diem tich luy')),
      },
      {
        id: 'n2', type: 'kiotviet.lookupCustomer', label: tr('Tra khách hàng KiotViet'),
        position: { x: 300, y: 210 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupCustomer'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: tr('Tìm thấy khách?'),
        position: { x: 300, y: 360 },
        config: { left: '{{ $node.n2.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi điểm tích luỹ'),
        position: { x: 100, y: 520 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            tr('⭐ Thông tin tích điểm của bạn:\n\n👤 Tên: {{ $node.n2.firstCustomer.name }}\n⭐ Điểm hiện tại: {{ $node.n2.firstCustomer.rewardPoint }} điểm\n💰 Tổng chi tiêu: {{ $node.n2.firstCustomer.totalInvoiced }}đ\n\nCảm ơn bạn đã ủng hộ shop! 😊', {  }),
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: tr('Chưa có thông tin khách'),
        position: { x: 500, y: 520 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message: tr('Mình chưa tìm thấy tài khoản tích điểm theo số điện thoại bạn đã lưu với shop. Bạn gửi giúp mình số điện thoại mua hàng nhé!'),
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 8. Haravan order lookup via Zalo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-haravan-lookup-order',
    name: tr('Tra cứu đơn hàng Haravan qua Zalo'),
    description:
      tr('Khách nhắn riêng "đơn hàng" / "check đơn" → bot tra đơn mới nhất trong Haravan theo SĐT đã lưu của khách và gửi mã đơn, tổng tiền, trạng thái thanh toán / giao hàng, địa chỉ giao. Chưa lưu SĐT hoặc không có đơn → nhờ khách gửi SĐT / mã đơn.'),
    category: 'tich-hop',
    tags: ['haravan', tr('đơn hàng'), tr('tra cứu'), 'CSKH', 'e-commerce'],
    icon: <ShoppingCartIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: tr('Khách hỏi đơn hàng'),
        position: { x: 300, y: 60 },
        config: privateMessageTrigger(ORDER_KEYWORDS),
      },
      {
        id: 'n2', type: 'haravan.lookupOrder', label: tr('Tra đơn Haravan'),
        position: { x: 300, y: 210 },
        config: { ...DEFAULT_CONFIGS['haravan.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: tr('Tìm thấy đơn?'),
        position: { x: 300, y: 360 },
        config: { left: '{{ $node.n2.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi thông tin đơn Haravan'),
        position: { x: 100, y: 530 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            tr('🛍️ Đơn hàng gần nhất của bạn:\n\n🔖 Mã đơn: {{ $node.n2.order.name }}\n💰 Tổng tiền: {{ $node.n2.order.total_price }}đ\n📌 Thanh toán: {{ $node.n2.order.financial_status }}\n🚚 Giao hàng: {{ $node.n2.order.fulfillment_status }}\n📍 Địa chỉ: {{ $node.n2.order.shipping_address.address1 }}, {{ $node.n2.order.shipping_address.city }}\n\nCần hỗ trợ gì thêm không ạ? 😊', {  }),
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: tr('Không tìm thấy đơn'),
        position: { x: 500, y: 530 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: NO_SAVED_PHONE_REPLY },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 9. AI classifies → KiotViet order lookup or AI reply ━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-ai-order-classify',
    name: tr('AI phân loại ý định → Tra đơn / AI trả lời'),
    description:
      tr('AI phân loại tin nhắn riêng của khách: hỏi về đơn hàng → tra đơn KiotViet theo SĐT đã lưu và gửi trạng thái (không có đơn thì nhờ khách gửi SĐT / mã đơn); câu hỏi khác → trợ lý AI trả lời (dùng kiến thức và sản phẩm đã ghim của trợ lý). Chọn trợ lý AI ở 2 bước AI trước khi bật.'),
    category: 'tich-hop',
    tags: ['AI', tr('phân loại'), 'kiotviet', tr('ý định'), tr('CSKH nâng cao')],
    icon: <BotIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn riêng'),
        position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: '0', debounceSeconds: 10 },
      },
      {
        id: 'n2', type: 'ai.classify', label: tr('AI phân loại ý định'),
        position: { x: 350, y: 200 },
        config: { aiConfigMode: 'assistant', assistantId: '', categories: [tr('tra đơn hàng'), tr('khác')].join(', '), input: '{{ $trigger.content }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: tr('Hỏi về đơn hàng?'),
        position: { x: 350, y: 350 },
        config: { left: '{{ $node.n2.category }}', operator: 'equals', right: tr('tra đơn hàng') },
      },
      {
        id: 'n4', type: 'kiotviet.lookupOrder', label: tr('Tra đơn KiotViet'),
        position: { x: 120, y: 500 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n5', type: 'logic.if', label: tr('Tìm thấy đơn?'),
        position: { x: 120, y: 650 },
        config: { left: '{{ $node.n4.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n6', type: 'zalo.sendMessage', label: tr('Gửi thông tin đơn'),
        position: { x: 0, y: 800 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            tr('📦 Đơn hàng mới nhất của bạn:\n\nMã đơn: {{ $node.n4.order.code }}\nTrạng thái: {{ $node.n4.order.statusValue }}\nTổng tiền: {{ $node.n4.order.total }}đ', {  }),
        },
      },
      {
        id: 'n7', type: 'zalo.sendMessage', label: tr('Không tìm thấy đơn'),
        position: { x: 260, y: 800 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: NO_SAVED_PHONE_REPLY },
      },
      {
        id: 'n8', type: 'ai.generateText', label: tr('AI trả lời'),
        position: { x: 600, y: 500 },
        config: {
          aiConfigMode: 'assistant', assistantId: '',
          prompt:
            'Bạn là nhân viên chăm sóc khách hàng của shop, trả lời ngắn gọn, thân thiện, đúng trọng tâm. ' +
            'Không chắc thông tin thì hẹn khách chờ nhân viên kiểm tra.\n\nTin nhắn của khách: {{ $trigger.content }}',
        },
      },
      {
        id: 'n9', type: 'zalo.sendMessage', label: tr('Gửi câu trả lời AI'),
        position: { x: 600, y: 650 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n8.result }}' },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', sourceHandle: 'true',  target: 'n6' },
      { id: 'e6', source: 'n5', sourceHandle: 'false', target: 'n7' },
      { id: 'e7', source: 'n3', sourceHandle: 'false', target: 'n8' },
      { id: 'e8', source: 'n8', target: 'n9' },
    ],
  },

  // ━━━━━ 10. Nhanh.vn order lookup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-nhanh-lookup-order',
    name: tr('Tra đơn hàng Nhanh.vn qua Zalo'),
    description:
      tr('Khách nhắn riêng "đơn hàng" / "kiểm tra đơn" → bot tra đơn mới nhất trên Nhanh.vn theo SĐT đã lưu của khách và gửi mã đơn, tổng tiền, trạng thái. Chưa lưu SĐT hoặc không có đơn → nhờ khách gửi SĐT / mã đơn.'),
    category: 'tich-hop',
    tags: ['nhanh.vn', tr('đơn hàng'), tr('tra cứu'), 'CSKH', tr('bán lẻ')],
    icon: <LightningIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: tr('Khách hỏi đơn hàng'),
        position: { x: 300, y: 60 },
        config: privateMessageTrigger(ORDER_KEYWORDS),
      },
      {
        id: 'n2', type: 'nhanh.lookupOrder', label: tr('Tra đơn Nhanh.vn'),
        position: { x: 300, y: 210 },
        config: { ...DEFAULT_CONFIGS['nhanh.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: tr('Tìm thấy đơn?'),
        position: { x: 300, y: 360 },
        config: { left: '{{ $node.n2.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi thông tin đơn hàng'),
        position: { x: 100, y: 530 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            tr('⚡ Đơn hàng mới nhất của bạn:\n\n🔖 Mã đơn: {{ $node.n2.order.id }}\n💰 Tổng tiền: {{ $node.n2.order.calcTotalMoney }}đ\n📌 Trạng thái: {{ $node.n2.order.statusName }}\n📅 Ngày tạo: {{ $node.n2.order.createdDateTime }}\n\nBạn cần hỗ trợ thêm gì không? 🙏', {  }),
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: tr('Không tìm thấy đơn'),
        position: { x: 500, y: 530 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: NO_SAVED_PHONE_REPLY },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 11. Sapo stock check → low stock alert ━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-sapo-stock-alert',
    name: tr('Cảnh báo sắp hết hàng (Sapo)'),
    description:
      tr('Mỗi sáng 8:00 lấy tồn kho 50 sản phẩm trên Sapo, lặp qua từng phiên bản, gom các phiên bản còn dưới 5 cái thành một danh sách rồi gửi MỘT cảnh báo qua Telegram (không có phiên bản nào sắp hết thì không gửi). Đổi ngưỡng ở bước "Còn dưới 5?".'),
    category: 'tich-hop',
    tags: ['sapo', tr('tồn kho'), tr('cảnh báo'), tr('quản lý kho'), 'telegram', tr('lịch')],
    icon: <TrendingDownIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      {
        id: 'n1', type: 'trigger.schedule', label: tr('Mỗi sáng lúc 8:00'),
        position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.schedule'], cronExpression: '0 8 * * *' },
      },
      {
        id: 'n2', type: 'sapo.getInventory', label: tr('Lấy tồn kho Sapo'),
        position: { x: 300, y: 190 },
        config: { ...DEFAULT_CONFIGS['sapo.getInventory'], limit: 50 },
      },
      {
        id: 'n3', type: 'logic.forEach', label: tr('Từng phiên bản sản phẩm'),
        position: { x: 300, y: 330 },
        config: { ...DEFAULT_CONFIGS['logic.forEach'], array: '{{ $node.n2.items }}', itemVariable: 'item', maxItems: 100 },
      },
      {
        id: 'n4', type: 'logic.if', label: tr('Còn dưới 5?'),
        position: { x: 100, y: 480 },
        config: { left: '{{ $var.item.inventory_quantity }}', operator: 'less_than', right: '5' },
      },
      {
        id: 'n5', type: 'logic.setVariable', label: tr('Thêm vào danh sách sắp hết'),
        position: { x: 100, y: 630 },
        config: {
          name: 'sapHetHang',
          value: '{{ $var.sapHetHang }}\n⚠️ {{ $var.item.product_title }} ({{ $var.item.variant_title }}): còn {{ $var.item.inventory_quantity }}',
        },
      },
      {
        id: 'n6', type: 'logic.if', label: tr('Có sản phẩm sắp hết?'),
        position: { x: 500, y: 480 },
        config: { left: '{{ $var.sapHetHang }}', operator: 'not_empty', right: '' },
      },
      {
        id: 'n7', type: 'notify.telegram', label: tr('Cảnh báo tồn kho Telegram'),
        position: { x: 500, y: 630 },
        config: {
          ...DEFAULT_CONFIGS['notify.telegram'],
          message: tr('📉 Sản phẩm sắp hết hàng (Sapo):{{ $var.sapHetHang }}\n\nKiểm tra và nhập thêm hàng nhé!'),
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'default', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true',    target: 'n5' },
      { id: 'e5', source: 'n3', sourceHandle: 'done',    target: 'n6' },
      { id: 'e6', source: 'n6', sourceHandle: 'true',    target: 'n7' },
    ],
  },
];
