// Node type configurations: default configs, labels, descriptions
type NodeGroupItem = { type: string; label: string; desc: string };
type NodeGroup = { label: string; color: string; items: NodeGroupItem[] };

export const WORKFLOW_UNSUPPORTED_NODE_PREFIXES = ['fb.'] as const;

export function isUnsupportedWorkflowNodeType(type: string): boolean {
  return WORKFLOW_UNSUPPORTED_NODE_PREFIXES.some(prefix => type.startsWith(prefix));
}

export const NODE_GROUPS: NodeGroup[] = [
  {
    label: 'Kích hoạt',
    color: 'bg-violet-500',
    items: [
      { type: 'trigger.message',       label: 'Khi nhận tin nhắn',           desc: 'Kích hoạt khi có tin nhắn mới (cá nhân hoặc nhóm)' },
      { type: 'trigger.friendRequest', label: 'Khi có lời mời kết bạn',      desc: 'Kích hoạt khi ai đó gửi lời mời kết bạn đến bạn' },
      { type: 'trigger.groupEvent',    label: 'Khi có sự kiện nhóm',         desc: 'Kích hoạt khi thành viên vào/rời nhóm, thay đổi admin...' },
      { type: 'trigger.reaction',      label: 'Khi có người react tin nhắn', desc: 'Kích hoạt khi ai đó thả cảm xúc vào tin nhắn' },
      { type: 'trigger.labelAssigned', label: 'Khi gán hoặc gỡ nhãn',       desc: 'Kích hoạt khi Nhãn Local/Zalo được gán hoặc gỡ khỏi hội thoại' },
      { type: 'trigger.schedule',      label: 'Chạy theo lịch hẹn',          desc: 'Tự động kích hoạt theo lịch (hàng ngày, hàng giờ...)' },
      { type: 'trigger.manual',        label: 'Chạy thủ công',               desc: 'Kích hoạt bằng tay từ giao diện, dùng để test workflow' },
      { type: 'trigger.payment',       label: 'Khi nhận thanh toán',         desc: 'Kích hoạt khi nhận webhook thanh toán từ Casso / SePay (VietQR)' },
    ],
  },
  {
    label: 'Thao tác',
    color: 'bg-blue-500',
    items: [
      { type: 'zalo.sendMessage',        label: 'Gửi tin nhắn',               desc: 'Gửi tin nhắn văn bản đến hội thoại' },
      { type: 'zalo.sendTyping',         label: 'Hiệu ứng đang gõ + chờ',    desc: 'Hiển thị "đang gõ..." rồi chờ vài giây trước bước tiếp' },
      { type: 'zalo.sendImage',          label: 'Gửi ảnh',                    desc: 'Gửi ảnh từ file trên máy hoặc URL ảnh trực tiếp' },
      { type: 'zalo.sendFile',           label: 'Gửi file đính kèm',          desc: 'Gửi file (PDF, Excel, ...) đến hội thoại' },
      { type: 'zalo.findUser',           label: 'Tìm user bằng số điện thoại',desc: 'Tra cứu tài khoản Zalo theo SĐT để lấy User ID' },
      { type: 'zalo.getUserInfo',        label: 'Lấy thông tin người dùng',   desc: 'Lấy tên, avatar, giới tính... từ User ID Zalo' },
      { type: 'zalo.acceptFriendRequest',label: 'Chấp nhận lời mời kết bạn',  desc: 'Tự động chấp nhận lời mời kết bạn từ người dùng' },
      { type: 'zalo.rejectFriendRequest',label: 'Từ chối lời mời kết bạn',    desc: 'Tự động từ chối lời mời kết bạn' },
      { type: 'zalo.sendFriendRequest',  label: 'Gửi lời mời kết bạn',       desc: 'Chủ động gửi lời mời kết bạn đến User ID' },
      { type: 'zalo.addToGroup',         label: 'Thêm thành viên vào nhóm',   desc: 'Thêm user vào một nhóm Zalo cụ thể' },
      { type: 'zalo.removeFromGroup',    label: 'Xóa thành viên khỏi nhóm',   desc: 'Xóa user ra khỏi nhóm Zalo' },
      { type: 'zalo.setMute',            label: 'Tắt/bật thông báo',          desc: 'Tắt hoặc bật lại thông báo cho hội thoại' },
      { type: 'zalo.forwardMessage',     label: 'Chuyển tiếp tin nhắn',       desc: 'Chuyển tiếp tin nhắn sang hội thoại khác' },
      { type: 'zalo.undoMessage',        label: 'Thu hồi tin nhắn',           desc: 'Thu hồi (xóa 2 phía) một tin nhắn đã gửi' },
      { type: 'zalo.createPoll',         label: 'Tạo bình chọn trong nhóm',   desc: 'Tạo cuộc bình chọn (poll) trong nhóm Zalo' },
      { type: 'zalo.getMessageHistory',  label: 'Lấy lịch sử tin nhắn',       desc: 'Lấy N tin nhắn gần nhất từ hội thoại' },
      { type: 'zalo.addReaction',        label: 'Thêm cảm xúc vào tin nhắn',  desc: 'Thả like, yêu thích, haha... vào tin nhắn' },
      { type: 'zalo.assignLabel',        label: 'Gắn nhãn hội thoại',         desc: 'Gắn Nhãn Local hoặc Zalo cho hội thoại' },
      { type: 'zalo.removeLabel',        label: 'Gỡ nhãn hội thoại',          desc: 'Gỡ Nhãn Local hoặc Zalo khỏi hội thoại' },
    ],
  },
  {
    label: 'Điều kiện & Logic',
    color: 'bg-amber-500',
    items: [
      { type: 'logic.if',          label: 'Rẽ nhánh Đúng/Sai (IF)',  desc: 'Kiểm tra điều kiện rồi chạy nhánh Đúng hoặc Sai' },
      { type: 'logic.switch',      label: 'Phân nhiều nhánh (Switch)',desc: 'So sánh giá trị với nhiều trường hợp rồi chạy nhánh tương ứng' },
      { type: 'logic.wait',        label: 'Tạm dừng chờ N giây',     desc: 'Dừng workflow trong vài giây trước khi tiếp tục' },
      { type: 'logic.setVariable', label: 'Lưu giá trị vào biến',    desc: 'Lưu dữ liệu để dùng ở các bước sau (VD: tên, số điện thoại...)' },
      { type: 'logic.stopIf',      label: 'Dừng workflow nếu...',     desc: 'Dừng toàn bộ workflow nếu điều kiện đúng' },
      { type: 'logic.forEach',     label: 'Lặp qua danh sách',       desc: 'Lặp từng phần tử trong mảng dữ liệu và chạy bước tiếp cho mỗi phần tử' },
    ],
  },
  {
    label: 'Xử lý dữ liệu',
    color: 'bg-teal-500',
    items: [
      { type: 'data.textFormat',  label: 'Ghép nội dung văn bản',   desc: 'Soạn nội dung bằng mẫu với biến động (VD: tên, ngày...)' },
      { type: 'data.randomPick',  label: 'Chọn ngẫu nhiên 1 mục',   desc: 'Chọn random 1 nội dung từ danh sách, tránh câu trả lời bị lặp' },
      { type: 'data.dateFormat',  label: 'Định dạng ngày giờ',       desc: 'Chuyển đổi ngày/giờ sang định dạng dễ đọc (VD: 25/03/2026)' },
      { type: 'data.jsonParse',   label: 'Đọc dữ liệu JSON',        desc: 'Chuyển chuỗi JSON thành object để đọc các trường bên trong' },
    ],
  },
  {
    label: 'Google Sheets',
    color: 'bg-green-600',
    items: [
      { type: 'sheets.appendRow',   label: 'Ghi thêm dòng mới',      desc: 'Thêm 1 hàng dữ liệu mới vào cuối bảng tính Google Sheets' },
      { type: 'sheets.readValues',  label: 'Đọc dữ liệu từ Sheet',   desc: 'Đọc giá trị các ô từ Google Sheets để dùng ở bước sau' },
      { type: 'sheets.updateCell',  label: 'Cập nhật ô trong Sheet',  desc: 'Ghi đè giá trị vào một ô cụ thể trong bảng tính' },
    ],
  },
  {
    label: 'Trí tuệ nhân tạo (AI)',
    color: 'bg-violet-600',
    items: [
      { type: 'ai.generateText', label: 'Tạo nội dung bằng AI',   desc: 'Dùng ChatGPT, Gemini, Deepseek, Grok... để sinh câu trả lời' },
      { type: 'ai.classify',     label: 'Phân loại văn bản bằng AI',desc: 'AI tự phân loại tin nhắn vào danh mục (hỏi giá, khiếu nại...)' },
    ],
  },
  {
    label: 'Gửi thông báo',
    color: 'bg-orange-500',
    items: [
      { type: 'notify.telegram', label: 'Gửi tin qua Telegram',     desc: 'Gửi thông báo đến Telegram Bot khi có sự kiện mới' },
      { type: 'notify.discord',  label: 'Gửi tin vào Discord',      desc: 'Gửi thông báo vào kênh Discord qua Webhook' },
      { type: 'notify.email',    label: 'Gửi Email tự động',        desc: 'Gửi email qua SMTP (Gmail, Outlook...) khi có sự kiện' },
      { type: 'notify.notion',   label: 'Ghi vào Notion Database',  desc: 'Tự động tạo trang mới trong Notion Database' },
    ],
  },
  {
    label: 'Đầu ra & API',
    color: 'bg-rose-500',
    items: [
      { type: 'output.httpRequest', label: 'Gọi API bên ngoài (HTTP)',desc: 'Gửi request HTTP đến API / webhook bên ngoài' },
      { type: 'output.log',         label: 'Ghi log gỡ lỗi',         desc: 'Ghi nội dung vào lịch sử chạy để debug, kiểm tra dữ liệu' },
    ],
  },
  {
    label: 'POS / Bán hàng',
    color: 'bg-orange-600',
    items: [
      { type: 'kiotviet.lookupCustomer', label: 'KiotViet: Tra cứu khách hàng', desc: 'Tìm thông tin khách hàng KiotViet theo số điện thoại' },
      { type: 'kiotviet.lookupOrder',    label: 'KiotViet: Tra cứu đơn hàng',   desc: 'Tìm đơn hàng KiotViet theo mã đơn hoặc SĐT' },
      { type: 'kiotviet.lookupProduct',  label: 'KiotViet: Tra cứu sản phẩm',   desc: 'Tìm sản phẩm KiotViet theo tên hoặc mã SKU' },
      { type: 'kiotviet.createOrder',    label: 'KiotViet: Tạo đơn hàng',       desc: 'Tạo đơn hàng mới trong KiotViet' },
      { type: 'haravan.lookupCustomer',  label: 'Haravan: Tra cứu khách hàng',  desc: 'Tìm thông tin khách hàng Haravan theo số điện thoại' },
      { type: 'haravan.lookupOrder',     label: 'Haravan: Tra cứu đơn hàng',    desc: 'Tìm đơn hàng Haravan theo mã đơn hoặc SĐT' },
      { type: 'haravan.lookupProduct',   label: 'Haravan: Tra cứu sản phẩm',    desc: 'Tìm sản phẩm Haravan theo tên' },
      { type: 'haravan.createOrder',     label: 'Haravan: Tạo đơn hàng',        desc: 'Tạo đơn hàng mới trong Haravan' },
      { type: 'sapo.lookupCustomer',     label: 'Sapo: Tra cứu khách hàng',     desc: 'Tìm thông tin khách hàng Sapo theo số điện thoại' },
      { type: 'sapo.lookupOrder',        label: 'Sapo: Tra cứu đơn hàng',       desc: 'Tìm đơn hàng Sapo theo mã đơn hoặc SĐT' },
      { type: 'sapo.lookupProduct',      label: 'Sapo: Tra cứu sản phẩm',       desc: 'Tìm sản phẩm Sapo theo tên' },
      { type: 'sapo.createOrder',        label: 'Sapo: Tạo đơn hàng',           desc: 'Tạo đơn hàng mới trong Sapo' },
      { type: 'ipos.lookupCustomer',     label: 'iPOS: Tra cứu khách hàng',     desc: 'Tìm thông tin khách hàng iPOS theo số điện thoại' },
      { type: 'ipos.lookupOrder',        label: 'iPOS: Tra cứu đơn/hóa đơn',   desc: 'Tìm đơn hàng / hóa đơn iPOS theo mã hoặc SĐT' },
      { type: 'ipos.lookupProduct',      label: 'iPOS: Tra cứu sản phẩm/món',   desc: 'Tìm sản phẩm hoặc món ăn trong iPOS' },
      { type: 'ipos.createOrder',        label: 'iPOS: Tạo đơn hàng',           desc: 'Tạo đơn hàng mới trong iPOS' },
      { type: 'nhanh.lookupCustomer',    label: 'Nhanh.vn: Tra cứu khách hàng', desc: 'Tìm thông tin khách hàng Nhanh.vn theo số điện thoại' },
      { type: 'nhanh.lookupOrder',       label: 'Nhanh.vn: Tra cứu đơn hàng',  desc: 'Tìm đơn hàng Nhanh.vn theo mã đơn hoặc SĐT' },
      { type: 'nhanh.lookupProduct',     label: 'Nhanh.vn: Tra cứu sản phẩm',  desc: 'Tìm sản phẩm trong Nhanh.vn theo tên hoặc mã' },
      { type: 'nhanh.createOrder',       label: 'Nhanh.vn: Tạo đơn hàng',      desc: 'Tạo đơn hàng mới trong Nhanh.vn' },
      { type: 'pancake.lookupCustomer',  label: 'Pancake: Tra cứu khách hàng', desc: 'Tìm thông tin khách hàng Pancake theo số điện thoại' },
      { type: 'pancake.lookupOrder',     label: 'Pancake: Tra cứu đơn hàng',   desc: 'Tìm đơn hàng Pancake theo mã đơn hoặc SĐT' },
      { type: 'pancake.lookupProduct',   label: 'Pancake: Tra cứu sản phẩm',   desc: 'Tìm sản phẩm Pancake theo tên hoặc mã' },
      { type: 'pancake.createOrder',     label: 'Pancake: Tạo đơn hàng',       desc: 'Tạo đơn hàng mới trong Pancake POS' },
    ],
  },
  {
    label: 'Thanh toán',
    color: 'bg-emerald-600',
    items: [
      { type: 'payment.getTransactions', label: 'Lấy lịch sử giao dịch',       desc: 'Lấy danh sách giao dịch từ Casso hoặc SePay (VietQR)' },
    ],
  },
  {
    label: 'Vận chuyển',
    color: 'bg-cyan-600',
    items: [
      { type: 'ghn.createOrder',   label: 'GHN: Tạo đơn vận chuyển',   desc: 'Tạo đơn giao hàng qua GHN Express' },
      { type: 'ghn.getTracking',   label: 'GHN: Tra cứu vận đơn',       desc: 'Lấy trạng thái vận đơn GHN theo mã đơn' },
      { type: 'ghn.getProvinces',  label: 'GHN: Danh sách tỉnh/thành',  desc: 'Lấy danh sách tỉnh/thành chuẩn từ master-data GHN' },
      { type: 'ghn.getDistricts',  label: 'GHN: Danh sách quận/huyện',  desc: 'Lấy danh sách quận/huyện theo ProvinceID GHN' },
      { type: 'ghn.getWards',      label: 'GHN: Danh sách phường/xã',   desc: 'Lấy danh sách phường/xã theo DistrictID GHN' },
      { type: 'ghn.getServices',   label: 'GHN: Dịch vụ khả dụng',      desc: 'Lấy danh sách dịch vụ GHN theo quận gửi / quận nhận' },
      { type: 'ghtk.createOrder',  label: 'GHTK: Tạo đơn vận chuyển',  desc: 'Tạo đơn giao hàng qua GHTK' },
      { type: 'ghtk.getTracking',  label: 'GHTK: Tra cứu vận đơn',      desc: 'Lấy trạng thái vận đơn GHTK theo mã tracking' },
    ],
  },
];

const HIDDEN_NODE_GROUPS: NodeGroup[] = [
  {
    label: 'Facebook',
    color: 'bg-blue-600',
    items: [
      { type: 'fb.trigger.message',    label: 'FB: Khi nhận tin nhắn nhóm', desc: 'Kích hoạt khi có tin nhắn mới trong nhóm Facebook' },
      { type: 'fb.action.sendMessage', label: 'FB: Gửi tin nhắn',           desc: 'Gửi tin nhắn văn bản vào nhóm Facebook' },
      { type: 'fb.action.addReaction', label: 'FB: Thả reaction',            desc: 'Thả emoji reaction vào tin nhắn Facebook' },
      { type: 'fb.action.sendImage',   label: 'FB: Gửi ảnh/file',           desc: 'Upload và gửi file/ảnh vào nhóm Facebook' },
    ],
  },
];

const ALL_NODE_GROUPS: NodeGroup[] = [...NODE_GROUPS, ...HIDDEN_NODE_GROUPS];

export const DEFAULT_CONFIGS: Record<string, Record<string, any>> = {
  'trigger.message':       { threadType: 'all', keyword: '', keywordMode: 'contains_any', ignoreOwn: true, debounceSeconds: 0 },
  'trigger.friendRequest': {},
  'trigger.groupEvent':    { groupId: '', eventType: 'all' },
  'trigger.reaction':      { reactionType: 'any', threadId: '' },
  'trigger.labelAssigned': { action: 'any', labelSource: 'any', labelIds: [] },
  'trigger.schedule':      { cronExpression: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' },
  'trigger.manual':        {},
  'zalo.sendMessage':      { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '' },
  'zalo.sendTyping':       { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', delaySeconds: 3 },
  'zalo.sendImage':        { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', filePath: '', message: '' },
  'zalo.sendFile':         { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', filePath: '' },
  'zalo.findUser':         { phone: '{{ $trigger.fromPhone }}' },
  'zalo.getUserInfo':      { userId: '{{ $trigger.fromId }}' },
  'zalo.acceptFriendRequest': { userId: '{{ $trigger.userId }}' },
  'zalo.rejectFriendRequest': { userId: '{{ $trigger.userId }}' },
  'zalo.sendFriendRequest': { userId: '', message: '' },
  'zalo.addToGroup':       { userId: '{{ $trigger.userId }}', groupId: '' },
  'zalo.removeFromGroup':  { userId: '', groupId: '' },
  'zalo.setMute':          { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', action: 'mute', duration: 0 },
  'zalo.forwardMessage':   { msgId: '{{ $trigger.msgId }}', toThreadId: '', toThreadType: '0' },
  'zalo.undoMessage':      { msgId: '', threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' },
  'zalo.createPoll':       { groupId: '', question: '', options: 'Có\nKhông', allowMultiple: false, expireTime: 0 },
  'zalo.getMessageHistory':{ threadId: '{{ $trigger.threadId }}', count: 20 },
  'zalo.addReaction':      { msgId: '{{ $trigger.msgId }}', reactionType: '1' },
  // Quản lý nhãn
  'zalo.assignLabel':      { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] },
  'zalo.removeLabel':      { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] },
  'logic.if':              { left: '{{ $trigger.content }}', operator: 'contains', right: '' },
  'logic.switch':          { value: '{{ $trigger.content }}', cases: [], defaultLabel: 'default' },
  'logic.wait':            { delaySeconds: 3 },
  'logic.setVariable':     { name: '', value: '' },
  'logic.stopIf':          { left: '', operator: 'equals', right: '' },
  'logic.forEach':         { array: '[]', itemVariable: 'item' },
  'data.textFormat':       { template: '' },
  'data.randomPick':       { options: '' },
  'data.dateFormat':       { format: 'datetime' },
  'data.jsonParse':        { input: '' },
  'output.httpRequest':    { method: 'POST', url: '', headers: '', body: '', timeout: 10000 },
  'output.log':            { message: '', level: 'info' },
  // Google Sheets
  'sheets.appendRow':   { spreadsheetId: '', sheetName: 'Sheet1', values: '', serviceAccountPath: '' },
  'sheets.readValues':  { spreadsheetId: '', range: 'Sheet1!A1:Z100', serviceAccountPath: '' },
  'sheets.updateCell':  { spreadsheetId: '', range: 'Sheet1!A1', value: '', serviceAccountPath: '' },
  // AI
  'ai.generateText': { aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini', systemPrompt: 'Bạn là trợ lý tư vấn bán hàng chuyên nghiệp.', prompt: '{{ $trigger.content }}', maxTokens: 300, temperature: 0.7 },
  'ai.classify':     { aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini', categories: 'hỏi giá, đặt hàng, khiếu nại, khác', input: '{{ $trigger.content }}' },
  // Notify
  'notify.telegram': { botToken: '', chatId: '', message: '' },
  'notify.discord':  { webhookUrl: '', message: '', username: 'DepLao Bot' },
  'notify.email':    { smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUser: '', smtpPass: '', to: '', subject: '', body: '' },
  'notify.notion':   { apiKey: '', databaseId: '', properties: '{"Tên": {"title": [{"text": {"content": "{{ $trigger.fromName }}"}}]}}' },
  // Trigger: payment
  'trigger.payment': { integrationId: '', minAmount: 0, descContains: '' },
  'kiotviet.lookupCustomer': { phone: '{{ $trigger.fromPhone }}' },
  'kiotviet.lookupOrder':    { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'kiotviet.lookupProduct':  { keyword: '{{ $trigger.content }}', limit: 10 },
  'kiotviet.createOrder':    { branchId: '', customerId: '', orderDetails: '[]', discount: 0, note: '' },
  'haravan.lookupCustomer':  { phone: '{{ $trigger.fromPhone }}' },
  'haravan.lookupOrder':     { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'haravan.lookupProduct':   { keyword: '{{ $trigger.content }}', limit: 10 },
  'haravan.createOrder':     { order: '{"line_items":[{"variant_id":"","quantity":1,"price":""}],"customer":{"phone":""}}' },
  'sapo.lookupCustomer':     { phone: '{{ $trigger.fromPhone }}' },
  'sapo.lookupOrder':        { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'sapo.lookupProduct':      { keyword: '{{ $trigger.content }}', limit: 10 },
  'sapo.createOrder':        { order: '{"line_items":[{"variant_id":"","quantity":1,"price":""}],"customer":{"phone":""}}' },
  'ipos.lookupCustomer':     { phone: '{{ $trigger.fromPhone }}' },
  'ipos.lookupOrder':        { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'ipos.lookupProduct':      { keyword: '{{ $trigger.content }}', limit: 10 },
  'ipos.createOrder':        { order: '{"invoice":{"details":[{"productId":"","quantity":1,"price":0}],"customerName":"","customerPhone":"","paymentMethod":"CASH"}}' },
  'nhanh.lookupCustomer':    { phone: '{{ $trigger.fromPhone }}' },
  'nhanh.lookupOrder':       { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'nhanh.lookupProduct':     { keyword: '{{ $trigger.content }}', code: '', limit: 10 },
  'nhanh.createOrder':       { order: '{"customerName":"","customerMobile":"","productList":{"123":1},"productDetails":[{"productId":"123","quantity":1,"price":0}],"paymentMethod":"COD"}' },
  'pancake.lookupCustomer':  { phone: '{{ $trigger.fromPhone }}' },
  'pancake.lookupOrder':     { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'pancake.lookupProduct':   { keyword: '{{ $trigger.content }}', code: '', limit: 10 },
  'pancake.createOrder':     { order: '{"customer":{"name":"","phone":""},"items":[{"productId":"","quantity":1,"unitPrice":0}],"paymentMethod":"cod"}' },
  // Payment actions
  'payment.getTransactions': { integrationId: '', limit: 20 },
  // Vận chuyển
  'ghn.createOrder':  { integrationId: '', toName: '', toPhone: '', toAddress: '', toDistrictId: '', toWardCode: '', weight: 500, serviceTypeId: '2', codAmount: 0, order: '{}' },
  'ghn.getTracking':  { integrationId: '', orderCode: '' },
  'ghn.getProvinces': { integrationId: '' },
  'ghn.getDistricts': { integrationId: '', provinceId: '' },
  'ghn.getWards':     { integrationId: '', districtId: '' },
  'ghn.getServices':  { integrationId: '', fromDistrict: '', toDistrict: '' },
  'ghtk.createOrder': { integrationId: '', order: '{}' },
  'ghtk.getTracking': { integrationId: '', trackingCode: '' },
  // Facebook
  'fb.trigger.message':    { accountId: '', threadId: '', keyword: '', keywordMode: 'contains_any' },
  'fb.action.sendMessage': { accountId: '', threadId: '{{ $trigger.threadId }}', message: '' },
  'fb.action.addReaction': { accountId: '', messageId: '{{ $trigger.messageId }}', emoji: '👍' },
  'fb.action.sendImage':   { accountId: '', threadId: '{{ $trigger.threadId }}', filePath: '' },
};

/** Map: nodeType → friendly Vietnamese label (auto-built from NODE_GROUPS) */
export const NODE_LABEL_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const group of ALL_NODE_GROUPS) {
    for (const item of group.items) {
      map[item.type] = item.label;
    }
  }
  return map;
})();

/** Get friendly Vietnamese label for a node type. Falls back to the raw type if not found. */
export function getNodeLabel(type: string): string {
  return NODE_LABEL_MAP[type] || type;
}

export function nodeTypeGroup(type: string): string {
  if (type.startsWith('trigger.')) return 'trigger';
  if (type.startsWith('zalo.'))    return 'action';
  if (type.startsWith('logic.'))   return 'logic';
  if (type.startsWith('data.'))    return 'data';
  if (type.startsWith('sheets.'))  return 'integration';
  if (type.startsWith('ai.'))      return 'integration';
  if (type.startsWith('notify.'))  return 'integration';
  if (type.startsWith('output.'))  return 'output';
  // POS / Shipping / Payment
  if (type.startsWith('kiotviet.') || type.startsWith('haravan.') ||
      type.startsWith('sapo.')     || type.startsWith('ipos.')    ||
      type.startsWith('nhanh.')    || type.startsWith('pancake.')) return 'integration';
  if (type.startsWith('payment.') || type.startsWith('ghn.') || type.startsWith('ghtk.')) return 'integration';
  if (isUnsupportedWorkflowNodeType(type)) return 'integration';
  return 'action';
}

export const GROUP_COLORS: Record<string, string> = {
  trigger:     '#7c3aed',
  action:      '#2563eb',
  logic:       '#d97706',
  data:        '#0d9488',
  integration: '#16a34a',
  output:      '#e11d48',
};

