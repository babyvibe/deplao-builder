import { DEFAULT_CONFIGS } from '../nodes/workflowConfig';
import type { WorkflowTemplate } from './workflowTemplates';
import { BotIcon, BrainIcon, CalendarIcon, ChartIcon, ChatIcon, CreditCardIcon, InboxIcon, KeyIcon, LockIcon, ShieldIcon, ShoppingCartIcon, TruckIcon, UserCheckIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';


// ── Telegram Bot templates ─────────────────────────────────────────────────────
// Workflows for a Telegram Bot account (channel 'telegram_bot'), checked by src/__tests__/workflow/workflowTemplates.test.ts:
//  - replies go to {{ $trigger.chatId }}, the chat that triggered the workflow. Payment / POS / schedule triggers have no chat:
//    their send nodes keep chatId empty and the user picks a group or channel;
//  - inline "go to node" buttons only set targetNodeId: instantiateTemplate gives them fresh ids and draws the dashed routes;
//  - a staff-only command checks {{ $trigger.fromId }} with "in_list" against Telegram IDs the shop fills in. The list starts
//    empty, so nobody can read customer data until the shop adds its staff.
// ──────────────────────────────────────────────────────────────────────────────

/** Reply-keyboard menu of "/start". "Trả lời theo nút menu" (answer by menu button) matches the same texts: one tr() each. */
const MENU = {
  products: tr('🛍 Sản phẩm'),
  prices: tr('💰 Bảng giá'),
  order: tr('📦 Tra đơn'),
  contact: tr('☎️ Liên hệ'),
};

/** Switch branch names (= handles of the edges) of the menu answers. */
const MENU_BRANCH = {
  products: tr('Sản phẩm'),
  prices: tr('Bảng giá'),
  order: tr('Tra đơn'),
  contact: tr('Liên hệ'),
};

const PRICE_LIST = tr('💰 Bảng giá:\n\n• Sản phẩm A: 150.000đ\n• Sản phẩm B: 250.000đ\n• Sản phẩm C: 390.000đ\n\nĐơn từ 500.000đ được miễn phí giao hàng.');
const CONTACT_INFO = tr('☎️ Liên hệ shop:\n\n• Hotline: 0900 000 000\n• Địa chỉ: (điền địa chỉ shop)\n• Giờ mở cửa: 8:00 - 21:00 hằng ngày');

/** Bot text message, by default to the chat that triggered the workflow (chatId '' = the user picks a group / channel). */
function botMessage(message: string, extra: Record<string, any> = {}) {
  const base = DEFAULT_CONFIGS['tgbot.action.sendMessage'];
  return { ...base, keyboard: { ...base.keyboard }, message, ...extra };
}

/** Reply keyboard: each button sends its own text back as a message. */
function replyKeyboard(rows: string[][]) {
  return {
    enabled: true, type: 'reply', resize: true, oneTime: false, persistent: true,
    rows: rows.map((row, r) => row.map((text, b) => ({ id: `btn_menu_${r}_${b}`, text }))),
  };
}

export const TELEGRAM_BOT_TEMPLATES: WorkflowTemplate[] = [

  // ━━━━━ 1. /start: greeting + menu keyboard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-start-menu',
    name: tr('/start: chào khách và hiện menu nút'),
    description: tr('Khách bấm Bắt đầu (/start) trong chat riêng → Bot chào theo tên và hiện bàn phím menu 4 nút. Cài thêm mẫu "Trả lời theo nút menu" để Bot trả lời từng nút.'),
    category: 'ban-hang',
    tags: ['telegram bot', '/start', 'menu', tr('chào khách'), tr('bàn phím')],
    icon: <BotIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.command', label: tr('Khách gửi /start'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.command'], command: 'start', chatScope: 'private' } },
      { id: 'n2', type: 'tgbot.action.sendMessage', label: tr('Chào khách + menu nút'), position: { x: 300, y: 240 },
        config: botMessage(tr('👋 Chào {{ $trigger.fromName }}! Mình là trợ lý của shop.\n\nBạn chọn mục cần xem ở menu bên dưới nhé.'), {
          keyboard: replyKeyboard([[MENU.products, MENU.prices], [MENU.order, MENU.contact]]),
        }) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 2. Answer by menu button ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-menu-replies',
    name: tr('Trả lời theo nút menu'),
    description: tr('Khách bấm một nút của menu /start (Sản phẩm, Bảng giá, Tra đơn, Liên hệ) → Bot gửi câu trả lời của nút đó. Sửa nội dung từng câu trả lời cho đúng shop của bạn.'),
    category: 'ban-hang',
    tags: ['telegram bot', 'menu', tr('trả lời'), tr('bàn phím')],
    icon: <ChatIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.message', label: tr('Khách bấm nút menu'), position: { x: 400, y: 60 },
        config: {
          ...DEFAULT_CONFIGS['tgbot.trigger.message'], chatScope: 'private', messageTypes: 'text',
          keyword: [MENU.products, MENU.prices, MENU.order, MENU.contact].join(', '), keywordMode: 'exact',
        } },
      { id: 'n2', type: 'logic.switch', label: tr('Nút nào?'), position: { x: 400, y: 220 },
        config: {
          value: '{{ $trigger.content }}',
          cases: [
            { match: MENU.products, label: MENU_BRANCH.products },
            { match: MENU.prices, label: MENU_BRANCH.prices },
            { match: MENU.order, label: MENU_BRANCH.order },
            { match: MENU.contact, label: MENU_BRANCH.contact },
          ],
          defaultLabel: 'default',
        } },
      { id: 'n3', type: 'tgbot.action.sendMessage', label: tr('Trả lời: Sản phẩm'), position: { x: 0, y: 420 },
        config: botMessage(tr('🛍 Sản phẩm của shop:\n\n• Sản phẩm A\n• Sản phẩm B\n• Sản phẩm C\n\nBạn cần tư vấn mẫu nào cứ nhắn mình nhé!')) },
      { id: 'n4', type: 'tgbot.action.sendMessage', label: tr('Trả lời: Bảng giá'), position: { x: 270, y: 420 },
        config: botMessage(PRICE_LIST) },
      { id: 'n5', type: 'tgbot.action.sendMessage', label: tr('Trả lời: Tra đơn'), position: { x: 540, y: 420 },
        config: botMessage(tr('📦 Bạn gửi giúp mình mã đơn hoặc số điện thoại đặt hàng, nhân viên sẽ kiểm tra và trả lời ngay.')) },
      { id: 'n6', type: 'tgbot.action.sendMessage', label: tr('Trả lời: Liên hệ'), position: { x: 810, y: 420 },
        config: botMessage(CONTACT_INFO) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: MENU_BRANCH.products, target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: MENU_BRANCH.prices, target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: MENU_BRANCH.order, target: 'n5' },
      { id: 'e5', source: 'n2', sourceHandle: MENU_BRANCH.contact, target: 'n6' },
    ],
  },

  // ━━━━━ 3. /menu: message with inline buttons, one branch per button ━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-inline-menu',
    name: tr('/menu: tin nhắn có nút bấm inline'),
    description: tr('Khách gõ /menu → Bot gửi tin có nút Bảng giá, Liên hệ, Gặp nhân viên. Mỗi nút chạy một nhánh; "Gặp nhân viên" báo vào nhóm nhân viên (chọn nhóm ở bước cuối).'),
    category: 'ban-hang',
    tags: ['telegram bot', 'inline', tr('nút bấm'), 'menu', tr('nhân viên')],
    icon: <InboxIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.command', label: tr('Khách gửi /menu'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.command'], command: 'menu', chatScope: 'private' } },
      { id: 'n2', type: 'tgbot.action.sendMessage', label: tr('Tin có nút inline'), position: { x: 300, y: 200 },
        config: botMessage(tr('Chào {{ $trigger.fromName }}, bạn cần xem gì? Bấm một nút bên dưới nhé 👇'), {
          keyboard: {
            enabled: true, type: 'inline', resize: true, oneTime: false, persistent: false,
            rows: [
              [{ id: 'btn_prices', text: tr('💰 Xem bảng giá'), action: 'node', targetNodeId: 'n3' }],
              [{ id: 'btn_contact', text: tr('☎️ Liên hệ'), action: 'node', targetNodeId: 'n4' }],
              [{ id: 'btn_staff', text: tr('🙋 Gặp nhân viên'), action: 'node', targetNodeId: 'n5' }],
            ],
          },
        }) },
      { id: 'n3', type: 'tgbot.action.sendMessage', label: tr('Gửi bảng giá'), position: { x: 0, y: 380 },
        config: botMessage(PRICE_LIST) },
      { id: 'n4', type: 'tgbot.action.sendMessage', label: tr('Gửi thông tin liên hệ'), position: { x: 300, y: 380 },
        config: botMessage(CONTACT_INFO) },
      { id: 'n5', type: 'tgbot.action.sendMessage', label: tr('Báo khách chờ nhân viên'), position: { x: 600, y: 380 },
        config: botMessage(tr('🙋 Mình đã báo nhân viên, bạn chờ một chút nhé. Bạn có thể nhắn thêm nhu cầu ngay tại đây.')) },
      { id: 'n6', type: 'tgbot.action.sendMessage', label: tr('Báo nhóm nhân viên (chọn nhóm)'), position: { x: 600, y: 540 },
        config: botMessage(tr('🙋 Khách {{ $trigger.fromName }} (Telegram ID {{ $trigger.fromId }}) muốn gặp nhân viên.\n👉 Trả lời khách trong hộp thư Deplao.'), { chatId: '' }) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n5', target: 'n6' },
    ],
  },

  // ━━━━━ 4. AI assistant in private chats ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-ai-assistant',
    name: tr('Trợ lý AI trả lời chat riêng của Bot'),
    description: tr('Khách nhắn riêng cho Bot → Bot hiện "đang gõ", AI soạn câu trả lời rồi gửi. Gom tin nhắn liên tiếp trong 10 giây thành một lần trả lời. Chọn trợ lý AI trước khi bật.'),
    category: 'ai',
    tags: ['telegram bot', 'AI', tr('trợ lý'), tr('tự động trả lời')],
    icon: <BrainIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.message', label: tr('Khách nhắn riêng cho Bot'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.message'], chatScope: 'private', messageTypes: 'text', debounceSeconds: 10 } },
      { id: 'n2', type: 'tgbot.action.sendChatAction', label: tr('Hiện "đang gõ"'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['tgbot.action.sendChatAction'], action: 'typing' } },
      { id: 'n3', type: 'ai.generateText', label: tr('AI soạn câu trả lời'), position: { x: 300, y: 340 },
        config: {
          ...DEFAULT_CONFIGS['ai.generateText'],
          prompt: 'Bạn là trợ lý bán hàng của shop trên Telegram. Trả lời ngắn gọn, thân thiện, bằng ngôn ngữ khách đang dùng. Nếu không chắc chắn, nói sẽ chuyển nhân viên hỗ trợ.\n\nTin nhắn của khách: {{ $trigger.content }}',
        } },
      { id: 'n4', type: 'tgbot.action.sendMessage', label: tr('Gửi câu trả lời AI'), position: { x: 300, y: 480 },
        config: botMessage('{{ $node.n3.result }}') },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 5. Forward customer messages to the staff group ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-support-forward',
    name: tr('Chuyển tin khách vào nhóm nhân viên'),
    description: tr('Mọi tin khách nhắn riêng cho Bot được chuyển tiếp vào nhóm Telegram của nhân viên để cả nhóm cùng theo dõi. Trả lời khách ngay trong hộp thư Deplao. Chọn nhóm nhận trước khi bật.'),
    category: 'ban-hang',
    tags: ['telegram bot', 'CSKH', tr('chuyển tiếp'), tr('nhóm nội bộ')],
    icon: <UsersIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.message', label: tr('Khách nhắn riêng cho Bot'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.message'], chatScope: 'private' } },
      { id: 'n2', type: 'tgbot.action.forward', label: tr('Chuyển vào nhóm nhân viên (chọn nhóm)'), position: { x: 300, y: 240 },
        config: { ...DEFAULT_CONFIGS['tgbot.action.forward'], targetChatId: '' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 6. Staff: /donhang <phone> → latest KiotViet order ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-staff-order-lookup',
    name: tr('Nhân viên tra đơn KiotViet bằng /donhang'),
    description: tr('Nhân viên gõ /donhang kèm SĐT khách → Bot trả đơn mới nhất trong KiotViet. Chỉ Telegram ID có trong danh sách mới tra được: điền ID nhân viên ở bước "Là nhân viên?". Người khác nhận lại ID của mình để gửi quản lý.'),
    category: 'tich-hop',
    tags: ['telegram bot', 'kiotviet', tr('tra đơn'), tr('nhân viên')],
    icon: <KeyIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.command', label: tr('Nhân viên gõ /donhang SĐT'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.command'], command: 'donhang', aliases: 'dh' } },
      { id: 'n2', type: 'logic.if', label: tr('Là nhân viên? (điền Telegram ID)'), position: { x: 300, y: 190 },
        // Empty list = nobody: customer orders stay private until the shop lists its staff
        config: { left: '{{ $trigger.fromId }}', operator: 'in_list', right: '' } },
      { id: 'n3', type: 'kiotviet.lookupOrder', label: tr('Tra đơn KiotViet theo SĐT'), position: { x: 100, y: 340 },
        config: { ...DEFAULT_CONFIGS['kiotviet.lookupOrder'], phone: '{{ $trigger.args }}', continueOnError: true } },
      { id: 'n4', type: 'logic.if', label: tr('Tìm thấy đơn?'), position: { x: 100, y: 490 },
        config: { left: '{{ $node.n3.found }}', operator: 'equals', right: 'true' } },
      { id: 'n5', type: 'tgbot.action.sendMessage', label: tr('Gửi thông tin đơn'), position: { x: -100, y: 650 },
        config: botMessage(tr('📦 Đơn mới nhất của {{ $node.n3.customer.name }} ({{ $trigger.args }}):\n\n🔖 Mã đơn: {{ $node.n3.order.code }}\n📌 Trạng thái: {{ $node.n3.order.statusValue }}\n💰 Tổng tiền: {{ $node.n3.order.total }}đ\n📅 Ngày tạo: {{ $node.n3.order.createdDate }}')) },
      { id: 'n6', type: 'tgbot.action.sendMessage', label: tr('Không tìm thấy đơn'), position: { x: 300, y: 650 },
        config: botMessage(tr('Không tìm thấy đơn KiotViet của SĐT "{{ $trigger.args }}". Gõ đúng dạng: /donhang 0901234567')) },
      { id: 'n7', type: 'tgbot.action.sendMessage', label: tr('Báo không có quyền'), position: { x: 560, y: 340 },
        config: botMessage(tr('Lệnh /donhang chỉ dành cho nhân viên. Telegram ID của bạn là {{ $trigger.fromId }}, gửi ID này cho quản lý để được thêm quyền.')) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'false', target: 'n7' },
      { id: 'e4', source: 'n3', target: 'n4' },
      { id: 'e5', source: 'n4', sourceHandle: 'true', target: 'n5' },
      { id: 'e6', source: 'n4', sourceHandle: 'false', target: 'n6' },
    ],
  },

  // ━━━━━ 7. /vandon <code>: GHN tracking ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-tracking-ghn',
    name: tr('/vandon: khách tra vận đơn GHN'),
    description: tr('Khách gõ /vandon kèm mã vận đơn GHN → Bot trả trạng thái và thời điểm cập nhật. Mã sai thì Bot hướng dẫn gõ lại.'),
    category: 'tich-hop',
    tags: ['telegram bot', 'GHN', tr('vận đơn'), tr('giao hàng')],
    icon: <TruckIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.command', label: tr('Khách gõ /vandon mã'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.command'], command: 'vandon' } },
      { id: 'n2', type: 'ghn.getTracking', label: tr('Tra trạng thái GHN'), position: { x: 300, y: 210 },
        config: { ...DEFAULT_CONFIGS['ghn.getTracking'], orderCode: '{{ $trigger.args }}', continueOnError: true } },
      { id: 'n3', type: 'logic.if', label: tr('Tra được vận đơn?'), position: { x: 300, y: 360 },
        config: { left: '{{ $node.n2.status }}', operator: 'not_empty', right: '' } },
      { id: 'n4', type: 'tgbot.action.sendMessage', label: tr('Gửi trạng thái vận đơn'), position: { x: 100, y: 520 },
        config: botMessage(tr('🚚 Vận đơn GHN {{ $node.n2.orderCode }}\n\n📦 Trạng thái: {{ $node.n2.status }}\n🕒 Cập nhật lúc: {{ $node.n2.updatedDate }}\n\nCần hỗ trợ thêm gì không ạ? 😊')) },
      { id: 'n5', type: 'tgbot.action.sendMessage', label: tr('Không tra được'), position: { x: 500, y: 520 },
        config: botMessage(tr('Mình chưa tra được vận đơn "{{ $trigger.args }}". Gõ /vandon kèm mã vận đơn GHN, ví dụ: /vandon GAPN9X3K')) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 8. Welcome new group members ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-welcome-member',
    name: tr('Chào thành viên mới vào nhóm'),
    description: tr('Có người vào nhóm Telegram → Bot chào theo tên ngay trong nhóm. Bot cần là admin của nhóm để nhận sự kiện này.'),
    category: 'quan-ly',
    tags: ['telegram bot', tr('nhóm'), tr('chào mừng'), tr('thành viên')],
    icon: <UserCheckIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.memberUpdate', label: tr('Thành viên mới vào nhóm'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.memberUpdate'], eventType: 'joined', ignoreBots: true } },
      { id: 'n2', type: 'tgbot.action.sendMessage', label: tr('Chào trong nhóm'), position: { x: 300, y: 240 },
        config: botMessage(tr('🎉 Chào mừng {{ $trigger.memberName }} đến với {{ $trigger.chatTitle }}!\n\nBạn xem tin ghim để nắm nội quy nhóm nhé.')) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 9. Approve join requests + rules in private ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-approve-join',
    name: tr('Tự duyệt yêu cầu vào nhóm và nhắn nội quy'),
    description: tr('Có người xin vào nhóm (link mời cần duyệt) → Bot nhắn riêng nội quy rồi duyệt. Bot cần là admin có quyền thêm thành viên.'),
    category: 'quan-ly',
    tags: ['telegram bot', tr('nhóm'), tr('duyệt thành viên'), tr('nội quy')],
    icon: <ShieldIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.joinRequest', label: tr('Có người xin vào nhóm'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.joinRequest'] } },
      // Telegram lets the bot write to the requester only while the request is pending: message first, then approve
      { id: 'n2', type: 'tgbot.action.sendMessage', label: tr('Nhắn riêng nội quy'), position: { x: 300, y: 200 },
        config: botMessage(tr('👋 Chào {{ $trigger.fromName }}, cảm ơn bạn đã xin vào nhóm {{ $trigger.chatTitle }}!\n\nNội quy nhóm:\n1. Tôn trọng các thành viên\n2. Không gửi link quảng cáo\n3. Hỏi đáp đúng chủ đề\n\nMình duyệt cho bạn ngay đây.'), {
          chatId: '{{ $trigger.fromId }}', continueOnError: true,
        }) },
      { id: 'n3', type: 'tgbot.action.approveJoinRequest', label: tr('Duyệt vào nhóm'), position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['tgbot.action.approveJoinRequest'], decision: 'approve' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 10. Block link spam in groups ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-anti-link-spam',
    name: tr('Chặn link spam trong nhóm'),
    description: tr('Thành viên gửi link vào nhóm → Bot xoá tin, khoá chat người đó 10 phút và nhắc nội quy. Điền Telegram ID của admin để bỏ qua. Bot cần là admin có quyền xoá tin và hạn chế thành viên.'),
    category: 'quan-ly',
    tags: ['telegram bot', tr('nhóm'), 'spam', tr('kiểm duyệt')],
    icon: <LockIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.message', label: tr('Tin có link trong nhóm'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.message'], chatScope: 'group', keyword: 'http://, https://, t.me/, www.', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'logic.stopIf', label: tr('Bỏ qua admin (điền Telegram ID)'), position: { x: 300, y: 190 },
        config: { left: '{{ $trigger.fromId }}', operator: 'in_list', right: '' } },
      { id: 'n3', type: 'tgbot.action.deleteMessage', label: tr('Xoá tin có link'), position: { x: 300, y: 330 },
        config: { ...DEFAULT_CONFIGS['tgbot.action.deleteMessage'] } },
      { id: 'n4', type: 'tgbot.action.restrictMember', label: tr('Khoá chat 10 phút'), position: { x: 300, y: 470 },
        // Telegram refuses to restrict an admin or the group owner: the warning is still sent
        config: { ...DEFAULT_CONFIGS['tgbot.action.restrictMember'], durationMinutes: 10, continueOnError: true } },
      { id: 'n5', type: 'tgbot.action.sendMessage', label: tr('Nhắc nội quy'), position: { x: 300, y: 610 },
        config: botMessage(tr('⚠️ {{ $trigger.fromName }} ơi, nhóm không cho gửi link. Tin của bạn đã bị xoá và bạn tạm thời không gửi được tin trong 10 phút.')) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 11. Payment received → Telegram group ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-payment-notify',
    name: tr('Nhận tiền → Báo nhóm Telegram'),
    description: tr('Casso hoặc SePay báo có chuyển khoản → Bot gửi số tiền, nội dung, ngân hàng và mã giao dịch vào nhóm Telegram. Chọn nhóm nhận ở bước gửi tin.'),
    category: 'tich-hop',
    tags: ['telegram bot', tr('thanh toán'), 'casso', 'sepay', tr('nhóm nội bộ')],
    icon: <CreditCardIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'trigger.payment', label: tr('Nhận thanh toán (Casso/SePay)'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.payment'] } },
      { id: 'n2', type: 'tgbot.action.sendMessage', label: tr('Báo nhóm Telegram (chọn nhóm)'), position: { x: 300, y: 240 },
        config: botMessage(tr('💰 Có tiền vào!\n\nSố tiền: {{ $trigger.amount }}đ\nNội dung CK: {{ $trigger.description }}\nNgân hàng: {{ $trigger.bankName }} - TK {{ $trigger.accountNumber }}\nMã GD: {{ $trigger.transactionId }}\nThời gian: {{ $trigger.transactionDate }}\n\n👉 Đối chiếu nội dung chuyển khoản để xác nhận đơn cho khách.'), { chatId: '' }) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 12. New POS order → Telegram group ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-pos-new-order',
    name: tr('Đơn mới từ phần mềm bán hàng → Báo nhóm Telegram'),
    description: tr('Haravan, Sapo hoặc Nhanh.vn báo có đơn mới → Bot gửi mã đơn, khách, tổng tiền vào nhóm Telegram. Chọn nhóm nhận ở bước gửi tin.'),
    category: 'tich-hop',
    tags: ['telegram bot', tr('đơn hàng'), 'webhook', 'haravan', 'sapo', 'nhanh.vn'],
    icon: <ShoppingCartIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'trigger.posWebhook', label: tr('Phần mềm bán hàng báo đơn mới'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.posWebhook'], entity: 'order', eventContains: 'create, orderAdd' } },
      { id: 'n2', type: 'tgbot.action.sendMessage', label: tr('Báo nhóm Telegram (chọn nhóm)'), position: { x: 300, y: 240 },
        config: botMessage(tr('🛒 Đơn mới từ {{ $trigger.integrationName }}\n\n🔖 Mã đơn: {{ $trigger.code }}\n👤 Khách: {{ $trigger.customerName }} - {{ $trigger.customerPhone }}\n💰 Tổng tiền: {{ $trigger.total }}đ\n📌 Trạng thái: {{ $trigger.status }}'), { chatId: '' }) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 13. Morning post to a group / channel ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-scheduled-post',
    name: tr('Đăng tin mỗi sáng lên nhóm / kênh'),
    description: tr('8 giờ sáng mỗi ngày, Bot đăng tin ưu đãi lên nhóm hoặc kênh Telegram. Sửa nội dung, giờ đăng và chọn nhóm / kênh nhận trước khi bật. Đăng lên kênh thì Bot cần là admin của kênh.'),
    category: 'marketing',
    tags: ['telegram bot', tr('lịch hẹn'), tr('kênh'), tr('ưu đãi')],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('8:00 mỗi ngày'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.schedule'], cronExpression: '0 8 * * *' } },
      { id: 'n2', type: 'tgbot.action.sendMessage', label: tr('Đăng tin (chọn nhóm / kênh)'), position: { x: 300, y: 240 },
        config: botMessage(tr('☀️ Chào buổi sáng! Hôm nay {{ $date.today }}.\n\n🔥 Ưu đãi trong ngày: (điền nội dung ưu đãi)\n👉 Nhắn riêng cho Bot để đặt hàng nhé!'), { chatId: '' }) },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 14. Weekly poll ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-weekly-poll',
    name: tr('Bình chọn hằng tuần trong nhóm'),
    description: tr('17 giờ thứ Sáu hằng tuần, Bot gửi bình chọn vào nhóm để hỏi khách muốn shop bán gì tiếp. Sửa câu hỏi, lựa chọn và chọn nhóm trước khi bật.'),
    category: 'marketing',
    tags: ['telegram bot', tr('bình chọn'), tr('khảo sát'), tr('lịch hẹn')],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('17:00 thứ Sáu'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.schedule'], cronExpression: '0 17 * * 5' } },
      { id: 'n2', type: 'tgbot.action.sendPoll', label: tr('Gửi bình chọn (chọn nhóm)'), position: { x: 300, y: 240 },
        config: {
          ...DEFAULT_CONFIGS['tgbot.action.sendPoll'], chatId: '',
          question: tr('Tuần sau bạn muốn shop mở bán gì?'),
          options: tr('Áo thun\nQuần jean\nPhụ kiện\nGiày dép'),
        } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 15. Leave groups added by strangers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bot-leave-unknown-group',
    name: tr('Bot tự rời nhóm lạ'),
    description: tr('Ai đó thêm Bot vào nhóm → nếu người thêm không phải quản lý, Bot chào rồi rời nhóm. Điền Telegram ID của quản lý ở bước "Người thêm là quản lý?".'),
    category: 'quan-ly',
    tags: ['telegram bot', tr('nhóm'), tr('bảo mật'), 'spam'],
    icon: <ShieldIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_bot',
    nodes: [
      { id: 'n1', type: 'tgbot.trigger.join', label: tr('Bot được thêm vào nhóm'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tgbot.trigger.join'], eventType: 'added' } },
      { id: 'n2', type: 'logic.if', label: tr('Người thêm là quản lý? (điền Telegram ID)'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.actorId }}', operator: 'in_list', right: '' } },
      { id: 'n3', type: 'tgbot.action.sendMessage', label: tr('Chào trước khi rời'), position: { x: 450, y: 350 },
        config: botMessage(tr('Bot này chỉ phục vụ nhóm của shop nên xin phép rời nhóm. Cảm ơn bạn!'), { continueOnError: true }) },
      { id: 'n4', type: 'tgbot.action.leaveChat', label: tr('Rời nhóm'), position: { x: 450, y: 490 },
        config: { ...DEFAULT_CONFIGS['tgbot.action.leaveChat'] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'false', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },
];
