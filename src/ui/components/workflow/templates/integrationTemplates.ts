import { DEFAULT_CONFIGS } from '../workflowConfig';
import { WorkflowTemplate } from './workflowTemplates';

// ── Integration Templates ──────────────────────────────────────────────────────
// Các workflow mẫu kết hợp với tích hợp: KiotViet, Haravan, Sapo, Nhanh.vn,
// GHN, GHTK, Casso/SePay (payment trigger), Google Sheets, Telegram.
// Không sửa workflowTemplates.ts — file này chỉ chứa các template MỚI.
// ──────────────────────────────────────────────────────────────────────────────

export const INTEGRATION_TEMPLATES: WorkflowTemplate[] = [

  // ━━━━━ 1. Nhận tiền → Gửi tin cảm ơn ngay ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-confirm-simple',
    name: 'Nhận tiền → Gửi tin cảm ơn ngay',
    description:
      'Khi Casso hoặc SePay (VietQR) ghi nhận giao dịch chuyển khoản mới, tự động gửi tin nhắn cảm ơn kèm số tiền và nội dung chuyển khoản đến khách hàng.',
    category: 'tich-hop',
    tags: ['thanh toán', 'casso', 'sepay', 'vietqr', 'cảm ơn', 'tự động'],
    icon: '💳',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: 'Nhận thanh toán (Casso/SePay)',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 0, descContains: '' },
      },
      {
        id: 'n2', type: 'zalo.sendTyping', label: 'Hiệu ứng đang gõ',
        position: { x: 300, y: 210 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 },
      },
      {
        id: 'n3', type: 'zalo.sendMessage', label: 'Gửi tin cảm ơn + số tiền',
        position: { x: 300, y: 360 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '✅ Đã nhận thanh toán!\n\n' +
            '💰 Số tiền: {{ $trigger.amount | formatVND }}\n' +
            '📝 Nội dung: {{ $trigger.description }}\n\n' +
            'Cảm ơn bạn đã tin tưởng! Đơn hàng sẽ được xử lý ngay 🙏',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 2. Nhận tiền → Tìm đơn KiotViet → Báo khách ━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-confirm-kiotviet',
    name: 'Nhận tiền → Tìm đơn KiotViet → Báo khách',
    description:
      'Khi nhận được thanh toán qua Casso/SePay, tự động tra đơn hàng trong KiotViet. Nếu tìm thấy đơn, gửi thông tin đơn hàng cho khách; nếu không tìm thấy, gửi thông báo đã nhận tiền và hẹn xác nhận sau.',
    category: 'tich-hop',
    tags: ['thanh toán', 'kiotviet', 'tra đơn', 'casso', 'sepay', 'tự động'],
    icon: '🏪',
    difficulty: 'medium',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: 'Nhận thanh toán',
        position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 10000 },
      },
      {
        id: 'n2', type: 'kiotviet.lookupOrder', label: 'Tra đơn KiotViet',
        position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: 'Tìm thấy đơn?',
        position: { x: 350, y: 360 },
        config: { left: '{{ $node.n2.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: 'Gửi thông tin đơn hàng',
        position: { x: 100, y: 530 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '✅ Đã nhận thanh toán {{ $trigger.amount | formatVND }}!\n\n' +
            '📦 Đơn hàng: #{{ $node.n2.order.code }}\n' +
            '🛒 Tổng tiền: {{ $node.n2.order.total | formatVND }}\n' +
            '📌 Trạng thái: {{ $node.n2.order.statusValue }}\n\n' +
            'Đơn của bạn đang được xử lý, sẽ giao trong 2–3 ngày làm việc 🚚',
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: 'Xác nhận nhận tiền (chưa có đơn)',
        position: { x: 600, y: 530 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '✅ Đã nhận {{ $trigger.amount | formatVND }} từ bạn!\n\n' +
            '⏳ Hệ thống chưa ghép được đơn hàng — bộ phận CSKH sẽ liên hệ xác nhận trong vòng 15 phút.',
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

  // ━━━━━ 3. Tra cứu đơn hàng KiotViet theo SĐT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-lookup-order-kiotviet',
    name: 'Tra cứu đơn hàng KiotViet qua Zalo',
    description:
      'Khách nhắn từ khoá "đơn hàng" (hoặc "kiểm tra đơn") → bot tự động tra đơn hàng mới nhất trong KiotViet theo SĐT Zalo và trả về trạng thái, tổng tiền, ngày giao dự kiến.',
    category: 'tich-hop',
    tags: ['kiotviet', 'tra đơn', 'trạng thái', 'CSKH', 'zalo'],
    icon: '📦',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] },
      },
      {
        id: 'n2', type: 'logic.if', label: 'Có chứa "đơn hàng"?',
        position: { x: 300, y: 210 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'đơn hàng' },
      },
      {
        id: 'n3', type: 'kiotviet.lookupOrder', label: 'Tra đơn KiotViet',
        position: { x: 150, y: 380 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n4', type: 'logic.if', label: 'Tìm thấy đơn?',
        position: { x: 150, y: 530 },
        config: { left: '{{ $node.n3.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: 'Gửi thông tin đơn hàng',
        position: { x: 0, y: 700 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '📦 Thông tin đơn hàng mới nhất:\n\n' +
            '🔖 Mã đơn: #{{ $node.n3.order.code }}\n' +
            '📌 Trạng thái: {{ $node.n3.order.statusValue }}\n' +
            '💰 Tổng tiền: {{ $node.n3.order.total | formatVND }}\n' +
            '📅 Ngày tạo: {{ $node.n3.order.createdDate }}\n\n' +
            'Bạn cần hỗ trợ thêm gì không ạ? 😊',
        },
      },
      {
        id: 'n6', type: 'zalo.sendMessage', label: 'Không tìm thấy đơn',
        position: { x: 310, y: 700 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '😥 Xin lỗi, mình chưa tìm thấy đơn hàng nào liên kết với số điện thoại này.\n\n' +
            'Vui lòng liên hệ hotline hoặc gửi mã đơn hàng để được hỗ trợ nhanh hơn nhé!',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true',  target: 'n5' },
      { id: 'e5', source: 'n4', sourceHandle: 'false', target: 'n6' },
    ],
  },

  // ━━━━━ 4. Hỏi giá → Tra sản phẩm KiotViet → Báo giá ━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-lookup-product-price',
    name: 'Hỏi giá → Tra sản phẩm KiotViet',
    description:
      'Khi khách nhắn hỏi "giá" hoặc tên sản phẩm, bot tự động tìm sản phẩm trong KiotViet và trả về danh sách giá bán, tình trạng tồn kho.',
    category: 'tich-hop',
    tags: ['kiotviet', 'sản phẩm', 'báo giá', 'tồn kho', 'bán hàng'],
    icon: '🏷️',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] },
      },
      {
        id: 'n2', type: 'logic.if', label: 'Có chứa "giá"?',
        position: { x: 300, y: 210 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'giá' },
      },
      {
        id: 'n3', type: 'kiotviet.lookupProduct', label: 'Tìm sản phẩm KiotViet',
        position: { x: 150, y: 380 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupProduct'], keyword: '{{ $trigger.content }}', limit: 5 },
      },
      {
        id: 'n4', type: 'data.textFormat', label: 'Định dạng danh sách giá',
        position: { x: 150, y: 530 },
        config: {
          template:
            '🏷️ Kết quả tìm kiếm "{{ $trigger.content }}":\n\n' +
            '{{ $node.n3.products | map("• " + _.name + " — " + _.basePrice + "đ (còn " + _.onHand + ")") | join("\n") }}\n\n' +
            '_Nhắn tên sản phẩm cụ thể để đặt hàng nhé!_',
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: 'Gửi bảng giá',
        position: { x: 150, y: 680 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n4.output }}' },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 5. Tra vận đơn GHN từ tin nhắn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-tracking-ghn',
    name: 'Tra vận đơn GHN từ tin nhắn Zalo',
    description:
      'Khách nhắn "vận đơn" hoặc "theo dõi đơn" → bot gửi trạng thái vận chuyển từ GHN Express theo mã vận đơn trong tin nhắn. Phù hợp cho shop có hệ thống giao hàng qua GHN.',
    category: 'tich-hop',
    tags: ['GHN', 'vận đơn', 'giao hàng', 'theo dõi', 'trạng thái'],
    icon: '🚚',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] },
      },
      {
        id: 'n2', type: 'logic.if', label: 'Có chứa "vận đơn"?',
        position: { x: 300, y: 210 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'vận đơn' },
      },
      {
        id: 'n3', type: 'ghn.getTracking', label: 'Tra trạng thái GHN',
        position: { x: 150, y: 380 },
        config: {
          ...DEFAULT_CONFIGS['ghn.getTracking'],
          orderCode: '{{ $trigger.content | extractOrderCode }}',
        },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: 'Gửi trạng thái vận đơn',
        position: { x: 150, y: 540 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '🚚 Thông tin vận đơn GHN:\n\n' +
            '📌 Mã vận đơn: {{ $node.n3.order.order_code }}\n' +
            '📦 Trạng thái: {{ $node.n3.order.status }}\n' +
            '📍 Vị trí hiện tại: {{ $node.n3.order.current_warehouse_address }}\n' +
            '📅 Dự kiến giao: {{ $node.n3.order.leadtime }}\n\n' +
            '_Cần hỗ trợ thêm gì không ạ? 😊_',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 6. Ghi nhật ký thanh toán vào Google Sheets ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-sheet-log',
    name: 'Ghi nhật ký giao dịch vào Google Sheets',
    description:
      'Mỗi khi nhận được thanh toán qua Casso hoặc SePay, tự động thêm một dòng vào Google Sheets (ngày giờ, số tiền, nội dung, người gửi) và gửi thông báo nhanh qua Telegram.',
    category: 'tich-hop',
    tags: ['thanh toán', 'google sheets', 'nhật ký', 'casso', 'sepay', 'kế toán'],
    icon: '📊',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: 'Nhận thanh toán',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 1000 },
      },
      {
        id: 'n2', type: 'sheets.appendRow', label: 'Ghi vào Google Sheets',
        position: { x: 300, y: 220 },
        config: {
          ...DEFAULT_CONFIGS['sheets.appendRow'],
          sheetName: 'GiaoDich',
          values:
            '{{ $trigger.when }}\t{{ $trigger.amount }}\t{{ $trigger.description }}\t{{ $trigger.fromAccount }}\t{{ $trigger.toAccount }}',
        },
      },
      {
        id: 'n3', type: 'notify.telegram', label: 'Thông báo Telegram',
        position: { x: 300, y: 380 },
        config: {
          ...DEFAULT_CONFIGS['notify.telegram'],
          message:
            '💰 *Giao dịch mới*\n\n' +
            'Số tiền: `{{ $trigger.amount | formatVND }}`\n' +
            'Nội dung: `{{ $trigger.description }}`\n' +
            'Từ TK: `{{ $trigger.fromAccount }}`\n' +
            'Thời gian: `{{ $trigger.when }}`',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 7. Cảnh báo nhận tiền lớn → Telegram ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-alert-big',
    name: 'Cảnh báo khi nhận thanh toán lớn',
    description:
      'Khi nhận giao dịch có giá trị ≥ 5.000.000 VNĐ, ngay lập tức gửi cảnh báo qua Telegram và tự động trả lời cảm ơn kèm thông tin xác nhận đến người chuyển khoản.',
    category: 'tich-hop',
    tags: ['cảnh báo', 'thanh toán lớn', 'telegram', 'casso', 'vip', 'kế toán'],
    icon: '🚨',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: 'Nhận thanh toán ≥ 5 triệu',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 5000000 },
      },
      {
        id: 'n2', type: 'notify.telegram', label: 'Cảnh báo Telegram',
        position: { x: 150, y: 220 },
        config: {
          ...DEFAULT_CONFIGS['notify.telegram'],
          message:
            '🚨 *THANH TOÁN LỚN!*\n\n' +
            '💰 Số tiền: `{{ $trigger.amount | formatVND }}`\n' +
            '📝 Nội dung: `{{ $trigger.description }}`\n' +
            '🏦 Từ TK: `{{ $trigger.fromAccount }}`\n' +
            '⏰ Thời gian: `{{ $trigger.when }}`',
        },
      },
      {
        id: 'n3', type: 'zalo.sendMessage', label: 'Gửi cảm ơn VIP',
        position: { x: 450, y: 220 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '🌟 Cảm ơn bạn đã tin tưởng!\n\n' +
            '✅ Đã nhận thanh toán {{ $trigger.amount | formatVND }} thành công.\n\n' +
            '🎁 Với đơn hàng đặc biệt này, bạn sẽ được hưởng ưu đãi VIP. ' +
            'Nhân viên sẽ liên hệ để tư vấn và xác nhận đơn hàng sớm nhất!',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n1', target: 'n3' },
    ],
  },

  // ━━━━━ 8. Tra điểm tích luỹ khách hàng KiotViet ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-loyalty-points',
    name: 'Tra điểm tích luỹ KiotViet',
    description:
      'Khách nhắn "điểm" hoặc "tích điểm" → bot tra điểm tích luỹ và lịch sử mua hàng trong KiotViet theo SĐT Zalo, gửi thông tin trực tiếp vào cuộc chat.',
    category: 'tich-hop',
    tags: ['kiotviet', 'tích điểm', 'loyalty', 'khách hàng', 'lịch sử mua hàng'],
    icon: '⭐',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] },
      },
      {
        id: 'n2', type: 'logic.if', label: 'Có chứa "điểm"?',
        position: { x: 300, y: 210 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'điểm' },
      },
      {
        id: 'n3', type: 'kiotviet.lookupCustomer', label: 'Tra thông tin khách hàng',
        position: { x: 150, y: 380 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupCustomer'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: 'Gửi thông tin điểm tích luỹ',
        position: { x: 150, y: 550 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '⭐ Thông tin tích điểm của bạn:\n\n' +
            '👤 Tên: {{ $node.n3.firstCustomer.name }}\n' +
            '📞 SĐT: {{ $node.n3.firstCustomer.contactNumber }}\n' +
            '⭐ Điểm hiện tại: {{ $node.n3.firstCustomer.rewardPoint }} điểm\n' +
            '💰 Tổng chi tiêu: {{ $node.n3.firstCustomer.totalInvoiced | formatVND }}\n\n' +
            '🎁 Mỗi 1.000đ chi tiêu = 1 điểm. Tích đủ 500 điểm để đổi quà nhé! 😊',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 9. Nhận tiền → Lấy giao dịch → Báo cáo cuối ngày ━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-daily-revenue-report',
    name: 'Báo cáo doanh thu cuối ngày qua Telegram',
    description:
      'Mỗi ngày lúc 18:00, tự động lấy danh sách giao dịch trong ngày từ Casso/SePay, tính tổng doanh thu và gửi báo cáo tóm tắt vào nhóm Telegram quản lý.',
    category: 'tich-hop',
    tags: ['báo cáo', 'doanh thu', 'casso', 'telegram', 'lịch', 'kế toán'],
    icon: '📈',
    difficulty: 'medium',
    nodes: [
      {
        id: 'n1', type: 'trigger.schedule', label: 'Mỗi ngày lúc 18:00',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.schedule'], cron: '0 18 * * *' },
      },
      {
        id: 'n2', type: 'payment.getTransactions', label: 'Lấy giao dịch hôm nay',
        position: { x: 300, y: 220 },
        config: { ...DEFAULT_CONFIGS['payment.getTransactions'], limit: 100 },
      },
      {
        id: 'n3', type: 'data.textFormat', label: 'Tổng hợp doanh thu',
        position: { x: 300, y: 380 },
        config: {
          template:
            '📈 *Báo cáo doanh thu {{ $now | formatDate("DD/MM/YYYY") }}*\n\n' +
            '💰 Tổng thu: `{{ $node.n2.transactions | sumBy("amount") | formatVND }}`\n' +
            '📋 Số GD: `{{ $node.n2.transactions.length }}` giao dịch\n' +
            '⬆️ Cao nhất: `{{ $node.n2.transactions | maxBy("amount") | formatVND }}`\n\n' +
            '— _Deplao AutoReport_ 🤖',
        },
      },
      {
        id: 'n4', type: 'notify.telegram', label: 'Gửi báo cáo Telegram',
        position: { x: 300, y: 540 },
        config: {
          ...DEFAULT_CONFIGS['notify.telegram'],
          message: '{{ $node.n3.output }}',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 10. Nhận tiền → Gán nhãn Zalo "Đã thanh toán" ━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-payment-label-zalo',
    name: 'Nhận tiền → Gán nhãn "Đã thanh toán" Zalo',
    description:
      'Khi nhận được thanh toán, tự động tra khách hàng trong KiotViet. Nếu tìm thấy, gán nhãn "Đã thanh toán" vào hội thoại Zalo tương ứng để phân loại và quản lý dễ dàng hơn.',
    category: 'tich-hop',
    tags: ['thanh toán', 'nhãn', 'kiotviet', 'phân loại', 'CRM', 'zalo'],
    icon: '🏷️',
    difficulty: 'medium',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: 'Nhận thanh toán',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 1000 },
      },
      {
        id: 'n2', type: 'kiotviet.lookupCustomer', label: 'Tra khách KiotViet',
        position: { x: 300, y: 220 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupCustomer'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: 'Tìm thấy khách?',
        position: { x: 300, y: 380 },
        config: { left: '{{ $node.n2.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n4', type: 'zalo.assignLabel', label: 'Gán nhãn "Đã thanh toán"',
        position: { x: 150, y: 550 },
        config: { ...DEFAULT_CONFIGS['zalo.assignLabel'], labelName: 'Đã thanh toán' },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: 'Xác nhận đã nhận tiền',
        position: { x: 450, y: 550 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '✅ Giao dịch {{ $trigger.amount | formatVND }} đã được ghi nhận!\n\n' +
            '📝 Nội dung: {{ $trigger.description }}\n\n' +
            'Cảm ơn bạn, đơn hàng sẽ được xử lý ngay! 🙏',
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

  // ━━━━━ 11. Nhận tiền → Tạo đơn GHN tự động ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-create-ghn-after-payment',
    name: 'Nhận tiền → Tạo đơn vận chuyển GHN',
    description:
      'Luồng đầu cuối: nhận thanh toán Casso/SePay → tra đơn KiotViet → nếu tìm thấy đơn chưa giao thì tự động tạo đơn vận chuyển GHN Express và gửi mã vận đơn cho khách qua Zalo.',
    category: 'tich-hop',
    tags: ['ghn', 'kiotviet', 'thanh toán', 'vận chuyển', 'tự động', 'end-to-end'],
    icon: '🏭',
    difficulty: 'advanced',
    nodes: [
      {
        id: 'n1', type: 'trigger.payment', label: 'Nhận thanh toán',
        position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'], minAmount: 10000 },
      },
      {
        id: 'n2', type: 'kiotviet.lookupOrder', label: 'Tra đơn KiotViet',
        position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n3', type: 'logic.if', label: 'Tìm thấy đơn?',
        position: { x: 350, y: 360 },
        config: { left: '{{ $node.n2.found }}', operator: 'equals', right: 'true' },
      },
      {
        id: 'n4', type: 'ghn.createOrder', label: 'Tạo đơn GHN Express',
        position: { x: 150, y: 530 },
        config: {
          ...DEFAULT_CONFIGS['ghn.createOrder'],
          order: JSON.stringify({
            to_name: '{{ $node.n2.order.customerName }}',
            to_phone: '{{ $node.n2.order.customerMobile }}',
            to_address: '{{ $node.n2.order.usingPrice }}',
            cod_amount: 0,
            weight: 500,
            service_type_id: 2,
          }),
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: 'Gửi mã vận đơn',
        position: { x: 150, y: 700 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '🚚 Đơn hàng của bạn đã được tạo vận chuyển!\n\n' +
            '📦 Mã đơn KiotViet: #{{ $node.n2.order.code }}\n' +
            '🔖 Mã vận đơn GHN: {{ $node.n4.orderCode }}\n\n' +
            'Nhắn "vận đơn {{ $node.n4.orderCode }}" để tra cứu trạng thái giao hàng 🙂',
        },
      },
      {
        id: 'n6', type: 'zalo.sendMessage', label: 'Báo chưa có đơn',
        position: { x: 550, y: 530 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '✅ Đã nhận tiền {{ $trigger.amount | formatVND }}!\n\n' +
            '⏳ Chưa tìm thấy đơn hàng tương ứng. Nhân viên sẽ xác nhận và tạo vận đơn trong 30 phút.',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n3', sourceHandle: 'false', target: 'n6' },
    ],
  },

  // ━━━━━ 12. Tra cứu đơn hàng Haravan qua Zalo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-haravan-lookup-order',
    name: 'Tra cứu đơn hàng Haravan qua Zalo',
    description:
      'Khách nhắn "đơn Haravan" hoặc "check đơn" → bot tra đơn hàng mới nhất trong Haravan theo SĐT Zalo và gửi lại thông tin: mã đơn, tổng tiền, trạng thái và địa chỉ giao hàng.',
    category: 'tich-hop',
    tags: ['haravan', 'đơn hàng', 'tra cứu', 'CSKH', 'e-commerce'],
    icon: '🛍️',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] },
      },
      {
        id: 'n2', type: 'logic.if', label: 'Chứa "haravan" hoặc "check đơn"?',
        position: { x: 300, y: 210 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'haravan' },
      },
      {
        id: 'n3', type: 'haravan.lookupOrder', label: 'Tra đơn Haravan',
        position: { x: 150, y: 380 },
        config: { ...DEFAULT_CONFIGS['haravan.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: 'Gửi thông tin đơn Haravan',
        position: { x: 150, y: 540 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '🛍️ Đơn hàng Haravan gần nhất của bạn:\n\n' +
            '🔖 Mã đơn: {{ $node.n3.order.name }}\n' +
            '💰 Tổng tiền: {{ $node.n3.order.total_price | formatVND }}\n' +
            '📌 Trạng thái: {{ $node.n3.order.financial_status }}\n' +
            '🚚 Giao hàng: {{ $node.n3.order.fulfillment_status }}\n' +
            '📍 Địa chỉ: {{ $node.n3.order.shipping_address.address1 }}, {{ $node.n3.order.shipping_address.city }}\n\n' +
            'Cần hỗ trợ gì thêm không ạ? 😊',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 13. AI phân loại → Tra đơn hoặc Báo giá ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-ai-order-classify',
    name: 'AI phân loại ý định → Tra đơn / Báo giá',
    description:
      'Dùng AI để phân loại ý định khách hàng từ tin nhắn: nếu "hỏi giá" → tra sản phẩm KiotViet, nếu "tra đơn" → tra đơn hàng KiotViet, nếu "khác" → trả lời chung. Tự động hoá hoàn toàn CSKH cơ bản.',
    category: 'tich-hop',
    tags: ['AI', 'phân loại', 'kiotviet', 'ý định', 'NLP', 'CSKH nâng cao'],
    icon: '🤖',
    difficulty: 'advanced',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn',
        position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] },
      },
      {
        id: 'n2', type: 'ai.classify', label: 'AI phân loại ý định',
        position: { x: 350, y: 200 },
        config: {
          ...DEFAULT_CONFIGS['ai.classify'],
          categories: 'hỏi giá, tra đơn hàng, hỗ trợ khác',
          input: '{{ $trigger.content }}',
        },
      },
      {
        id: 'n3', type: 'logic.if', label: 'Ý định: tra đơn?',
        position: { x: 350, y: 360 },
        config: { left: '{{ $node.n2.category }}', operator: 'equals', right: 'tra đơn hàng' },
      },
      {
        id: 'n4', type: 'kiotviet.lookupOrder', label: 'Tra đơn KiotViet',
        position: { x: 100, y: 530 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: 'Gửi thông tin đơn',
        position: { x: 100, y: 700 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '📦 Đơn hàng mới nhất của bạn:\n\n' +
            'Mã đơn: #{{ $node.n4.order.code }}\n' +
            'Trạng thái: {{ $node.n4.order.statusValue }}\n' +
            'Tổng tiền: {{ $node.n4.order.total | formatVND }}',
        },
      },
      {
        id: 'n6', type: 'logic.if', label: 'Ý định: hỏi giá?',
        position: { x: 600, y: 530 },
        config: { left: '{{ $node.n2.category }}', operator: 'equals', right: 'hỏi giá' },
      },
      {
        id: 'n7', type: 'kiotviet.lookupProduct', label: 'Tìm sản phẩm',
        position: { x: 500, y: 700 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupProduct'], keyword: '{{ $trigger.content }}', limit: 3 },
      },
      {
        id: 'n8', type: 'zalo.sendMessage', label: 'Gửi bảng giá',
        position: { x: 500, y: 860 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '🏷️ Sản phẩm phù hợp:\n\n' +
            '{{ $node.n7.products | map("• " + _.name + ": " + _.basePrice + "đ") | join("\n") }}\n\n' +
            'Bạn muốn đặt sản phẩm nào ạ?',
        },
      },
      {
        id: 'n9', type: 'ai.generateText', label: 'AI trả lời tổng quát',
        position: { x: 800, y: 700 },
        config: {
          ...DEFAULT_CONFIGS['ai.generateText'],
          systemPrompt: 'Bạn là trợ lý CSKH chuyên nghiệp, thân thiện. Trả lời ngắn gọn, đúng trọng tâm.',
          prompt: '{{ $trigger.content }}',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true',  target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n3', sourceHandle: 'false', target: 'n6' },
      { id: 'e6', source: 'n6', sourceHandle: 'true',  target: 'n7' },
      { id: 'e7', source: 'n7', target: 'n8' },
      { id: 'e8', source: 'n6', sourceHandle: 'false', target: 'n9' },
    ],
  },

  // ━━━━━ 14. Tra đơn hàng Nhanh.vn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-nhanh-lookup-order',
    name: 'Tra đơn hàng Nhanh.vn qua Zalo',
    description:
      'Khách nhắn "đơn nhanh" hoặc mã vận đơn → bot tra trạng thái đơn hàng trên hệ thống Nhanh.vn và gửi phản hồi ngay lập tức. Phù hợp cho shop bán lẻ dùng Nhanh.vn.',
    category: 'tich-hop',
    tags: ['nhanh.vn', 'đơn hàng', 'tra cứu', 'CSKH', 'bán lẻ'],
    icon: '⚡',
    difficulty: 'easy',
    nodes: [
      {
        id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] },
      },
      {
        id: 'n2', type: 'logic.if', label: 'Chứa "nhanh" hoặc mã đơn?',
        position: { x: 300, y: 210 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'nhanh' },
      },
      {
        id: 'n3', type: 'nhanh.lookupOrder', label: 'Tra đơn Nhanh.vn',
        position: { x: 150, y: 380 },
        config: { ...DEFAULT_CONFIGS['nhanh.lookupOrder'], phone: '{{ $trigger.fromPhone }}' },
      },
      {
        id: 'n4', type: 'zalo.sendMessage', label: 'Gửi thông tin đơn hàng',
        position: { x: 150, y: 550 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '⚡ Đơn hàng Nhanh.vn mới nhất:\n\n' +
            '🔖 Mã đơn: {{ $node.n3.order.id }}\n' +
            '💰 Tổng tiền: {{ $node.n3.order.calcTotalMoney | formatVND }}\n' +
            '📌 Trạng thái: {{ $node.n3.order.statusName }}\n' +
            '📅 Ngày tạo: {{ $node.n3.order.createdDateTime }}\n\n' +
            'Bạn cần hỗ trợ thêm gì không? 🙏',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 15. Kiểm tra tồn kho Sapo → Cảnh báo hết hàng ━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-int-sapo-stock-alert',
    name: 'Cảnh báo sắp hết hàng (Sapo)',
    description:
      'Mỗi buổi sáng lúc 8:00, tra cứu tồn kho sản phẩm trong Sapo. Nếu phát hiện sản phẩm tồn kho dưới ngưỡng cho phép, gửi cảnh báo ngay qua Telegram và nhóm Zalo quản lý kho.',
    category: 'tich-hop',
    tags: ['sapo', 'tồn kho', 'cảnh báo', 'quản lý kho', 'telegram', 'lịch'],
    icon: '📉',
    difficulty: 'medium',
    nodes: [
      {
        id: 'n1', type: 'trigger.schedule', label: 'Mỗi sáng lúc 8:00',
        position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.schedule'], cron: '0 8 * * *' },
      },
      {
        id: 'n2', type: 'sapo.lookupProduct', label: 'Tra tồn kho Sapo',
        position: { x: 300, y: 220 },
        config: { ...DEFAULT_CONFIGS['sapo.lookupProduct'], keyword: '', limit: 50 },
      },
      {
        id: 'n3', type: 'logic.if', label: 'Có sản phẩm < 5 cái?',
        position: { x: 300, y: 380 },
        config: {
          left: '{{ $node.n2.products | filter(_.onHand < 5) | length }}',
          operator: 'greaterThan',
          right: '0',
        },
      },
      {
        id: 'n4', type: 'notify.telegram', label: 'Cảnh báo tồn kho Telegram',
        position: { x: 150, y: 550 },
        config: {
          ...DEFAULT_CONFIGS['notify.telegram'],
          message:
            '📉 *Cảnh báo sắp hết hàng!*\n\n' +
            '{{ $node.n2.products | filter(_.onHand < 5) | map("⚠️ " + _.name + ": còn " + _.onHand + " cái") | join("\n") }}\n\n' +
            '⏰ Kiểm tra ngay: ' + new Date().toLocaleDateString('vi-VN'),
        },
      },
      {
        id: 'n5', type: 'zalo.sendMessage', label: 'Báo nhóm quản lý kho',
        position: { x: 450, y: 550 },
        config: {
          ...DEFAULT_CONFIGS['zalo.sendMessage'],
          message:
            '⚠️ Cảnh báo tồn kho!\n\n' +
            '{{ $node.n2.products | filter(_.onHand < 5) | map("• " + _.name + ": còn " + _.onHand) | join("\n") }}\n\n' +
            'Vui lòng kiểm tra và bổ sung hàng sớm nhé!',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'true', target: 'n5' },
    ],
  },
];

