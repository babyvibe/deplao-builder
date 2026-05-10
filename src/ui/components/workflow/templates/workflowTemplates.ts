import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIGS } from '../workflowConfig';

// ── Template types ─────────────────────────────────────────────────────────────

export interface TemplateNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, any>;
}

export interface TemplateEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  icon: string;
  difficulty: 'easy' | 'medium' | 'advanced';
  nodes: TemplateNode[];
  edges: TemplateEdge[];
}

export type TemplateCategory =
  | 'ban-hang'       // Bán hàng & CSKH
  | 'quan-ly'        // Quản lý & Vận hành
  | 'marketing'      // Marketing & Tiếp thị
  | 'thong-bao'      // Thông báo & Tích hợp
  | 'ai'             // AI & Thông minh
  | 'nang-cao'       // Nâng cao
  | 'tich-hop';      // Tích hợp POS & Thanh toán

export const TEMPLATE_CATEGORIES: { key: TemplateCategory; label: string; icon: string; color: string }[] = [
  { key: 'ban-hang',   label: 'Bán hàng & CSKH',           icon: '🛒', color: 'bg-blue-500' },
  { key: 'quan-ly',    label: 'Quản lý & Vận hành',         icon: '📋', color: 'bg-amber-500' },
  { key: 'marketing',  label: 'Marketing & Tiếp thị',       icon: '📣', color: 'bg-pink-500' },
  { key: 'thong-bao',  label: 'Thông báo & Tích hợp',       icon: '🔔', color: 'bg-green-500' },
  { key: 'ai',         label: 'AI & Thông minh',             icon: '🤖', color: 'bg-violet-500' },
  { key: 'nang-cao',   label: 'Nâng cao',                    icon: '⚙️', color: 'bg-rose-500' },
  { key: 'tich-hop',   label: 'Tích hợp POS & Thanh toán',  icon: '🔌', color: 'bg-teal-600' },
];

// ── Helper: generate fresh IDs when installing ─────────────────────────────────

/** Deep-clone a template and assign fresh UUIDs to all nodes/edges while keeping internal references intact */
export function instantiateTemplate(tpl: WorkflowTemplate): {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
} {
  const idMap: Record<string, string> = {};
  tpl.nodes.forEach(n => { idMap[n.id] = uuidv4(); });

  const nodes = tpl.nodes.map(n => ({
    ...n,
    id: idMap[n.id],
    config: { ...n.config },
  }));

  const edges = tpl.edges.map(e => ({
    id: uuidv4(),
    source: idMap[e.source] || e.source,
    sourceHandle: e.sourceHandle ?? null,
    target: idMap[e.target] || e.target,
  }));

  return { nodes, edges };
}

// ── Templates ──────────────────────────────────────────────────────────────────

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ━━━━━ 1. Tự động trả lời tin nhắn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-auto-reply-basic',
    name: 'Tự động trả lời tin nhắn',
    description: 'Khi nhận tin nhắn mới, tự động gửi lại một câu trả lời cố định. Phù hợp làm thông báo "đã nhận tin" hoặc giới thiệu nhanh.',
    category: 'ban-hang',
    tags: ['trả lời', 'tự động', 'tin nhắn', 'cơ bản'],
    icon: '💬',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 250, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'zalo.sendTyping', label: 'Hiệu ứng đang gõ', position: { x: 250, y: 220 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n3', type: 'zalo.sendMessage', label: 'Gửi câu trả lời', position: { x: 250, y: 360 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: 'Cảm ơn bạn đã nhắn tin! Mình sẽ phản hồi trong thời gian sớm nhất 🙏' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 2. Trả lời theo từ khoá ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-keyword-reply',
    name: 'Trả lời theo từ khoá',
    description: 'Phân nhánh theo nội dung tin nhắn: nếu chứa "giá" → gửi bảng giá, nếu chứa "địa chỉ" → gửi vị trí, còn lại → trả lời mặc định.',
    category: 'ban-hang',
    tags: ['từ khoá', 'rẽ nhánh', 'bảng giá', 'CSKH'],
    icon: '🔑',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Có chứa "giá"?', position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'giá' } },
      { id: 'n3', type: 'zalo.sendMessage', label: 'Gửi bảng giá', position: { x: 100, y: 380 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '📋 Bảng giá sản phẩm:\n\n• Gói A: 199k/tháng\n• Gói B: 399k/tháng\n• Gói C: 799k/tháng\n\nBạn quan tâm gói nào ạ?' } },
      { id: 'n4', type: 'logic.if', label: 'Có chứa "địa chỉ"?', position: { x: 600, y: 380 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'địa chỉ' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Gửi địa chỉ', position: { x: 400, y: 560 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '📍 Địa chỉ cửa hàng:\n123 Nguyễn Huệ, Q.1, TP.HCM\n\n⏰ Giờ mở cửa: 8h - 21h hàng ngày' } },
      { id: 'n6', type: 'zalo.sendMessage', label: 'Trả lời mặc định', position: { x: 750, y: 560 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: 'Cảm ơn bạn đã liên hệ! Nhắn "giá" để xem bảng giá, hoặc "địa chỉ" để biết nơi mua hàng nhé 😊' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'false', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
      { id: 'e5', source: 'n4', sourceHandle: 'false', target: 'n6' },
    ],
  },

  // ━━━━━ 3. Chấp nhận kết bạn + Chào mừng ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-auto-accept-friend',
    name: 'Tự động chấp nhận kết bạn & chào mừng',
    description: 'Tự động chấp nhận lời mời kết bạn, chờ 2 giây rồi gửi tin nhắn chào mừng. Tăng tốc tiếp cận khách hàng mới.',
    category: 'ban-hang',
    tags: ['kết bạn', 'chào mừng', 'tự động'],
    icon: '🤝',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: 'Khi có lời mời kết bạn', position: { x: 250, y: 80 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: 'Chấp nhận kết bạn', position: { x: 250, y: 230 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'logic.wait', label: 'Chờ 2 giây', position: { x: 250, y: 370 },
        config: { delaySeconds: 2 } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi lời chào', position: { x: 250, y: 510 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: 'Xin chào! 👋 Cảm ơn bạn đã kết bạn.\n\nMình có thể giúp gì cho bạn ạ?' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 4. Chuyển tiếp tin nhắn quan trọng sang Telegram ━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-forward-telegram',
    name: 'Chuyển tiếp tin nhắn → Telegram',
    description: 'Nhận tin nhắn từ Zalo, lọc theo từ khoá quan trọng ("gấp", "khiếu nại"...) rồi forward sang Telegram Bot để đội ngũ xử lý ngay.',
    category: 'thong-bao',
    tags: ['telegram', 'chuyển tiếp', 'thông báo', 'khẩn cấp'],
    icon: '📲',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'gấp,khẩn,khiếu nại', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'data.textFormat', label: 'Soạn nội dung thông báo', position: { x: 300, y: 220 },
        config: { template: '🚨 *TIN NHẮN QUAN TRỌNG*\n\n👤 Từ: {{ $trigger.fromName }}\n💬 Nội dung: {{ $trigger.content }}\n⏰ Lúc: {{ $trigger.timestamp }}' } },
      { id: 'n3', type: 'notify.telegram', label: 'Gửi qua Telegram', position: { x: 300, y: 380 },
        config: { botToken: '', chatId: '', message: '{{ $node.n2.output }}' } },
      { id: 'n4', type: 'output.log', label: 'Ghi log', position: { x: 300, y: 530 },
        config: { message: 'Đã forward tin nhắn quan trọng từ {{ $trigger.fromName }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 5. AI trả lời tư vấn bán hàng ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-sales-advisor',
    name: 'AI tư vấn bán hàng tự động',
    description: 'Dùng AI (ChatGPT/Gemini/Deepseek) để tự động trả lời tư vấn sản phẩm. AI sẽ trả lời chuyên nghiệp, tự nhiên theo prompt bạn cài đặt.',
    category: 'ai',
    tags: ['AI', 'ChatGPT', 'tư vấn', 'bán hàng'],
    icon: '🤖',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'logic.stopIf', label: 'Bỏ qua nếu rỗng', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'equals', right: '' } },
      { id: 'n3', type: 'zalo.sendTyping', label: 'Hiệu ứng đang gõ', position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 3 } },
      { id: 'n4', type: 'ai.generateText', label: 'AI tạo câu trả lời', position: { x: 300, y: 480 },
        config: {
          platform: 'openai', apiKey: '', model: 'gpt-4o-mini',
          systemPrompt: 'Bạn là trợ lý tư vấn bán hàng chuyên nghiệp, thân thiện. Trả lời ngắn gọn, đúng trọng tâm. Nếu không biết, hãy nói sẽ chuyển cho nhân viên hỗ trợ.',
          prompt: '{{ $trigger.content }}',
          maxTokens: 300, temperature: 0.7,
        } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Gửi câu trả lời AI', position: { x: 300, y: 630 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n4.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 6. AI phân loại tin nhắn + gắn nhãn ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-classify-label',
    name: 'AI phân loại & tự động gắn nhãn',
    description: 'AI phân loại tin nhắn vào các danh mục (hỏi giá, đặt hàng, khiếu nại...) rồi tự động gắn nhãn tương ứng cho hội thoại. Giúp quản lý khách hàng hiệu quả.',
    category: 'ai',
    tags: ['AI', 'phân loại', 'nhãn', 'CRM'],
    icon: '🏷️',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'ai.classify', label: 'AI phân loại tin nhắn', position: { x: 300, y: 200 },
        config: {
          platform: 'openai', apiKey: '', model: 'gpt-4o-mini',
          categories: 'hỏi giá, đặt hàng, khiếu nại, hỗ trợ kỹ thuật, khác',
          input: '{{ $trigger.content }}',
        } },
      { id: 'n3', type: 'logic.switch', label: 'Phân nhánh theo loại', position: { x: 300, y: 370 },
        config: {
          value: '{{ $node.n2.output }}',
          cases: [
            { label: 'hỏi giá', value: 'hỏi giá' },
            { label: 'đặt hàng', value: 'đặt hàng' },
            { label: 'khiếu nại', value: 'khiếu nại' },
          ],
          defaultLabel: 'khác',
        } },
      { id: 'n4', type: 'zalo.assignLabel', label: 'Gắn nhãn "Hỏi giá"', position: { x: 0, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n5', type: 'zalo.assignLabel', label: 'Gắn nhãn "Đặt hàng"', position: { x: 250, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n6', type: 'zalo.assignLabel', label: 'Gắn nhãn "Khiếu nại"', position: { x: 500, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n7', type: 'output.log', label: 'Log kết quả', position: { x: 300, y: 720 },
        config: { message: 'Phân loại: {{ $node.n2.output }} — Từ: {{ $trigger.fromName }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'case-0', target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'case-1', target: 'n5' },
      { id: 'e5', source: 'n3', sourceHandle: 'case-2', target: 'n6' },
      { id: 'e6', source: 'n4', target: 'n7' },
      { id: 'e7', source: 'n5', target: 'n7' },
      { id: 'e8', source: 'n6', target: 'n7' },
    ],
  },

  // ━━━━━ 7. Ghi đơn hàng vào Google Sheets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-order-to-sheets',
    name: 'Ghi đơn hàng vào Google Sheets',
    description: 'Khi nhận tin nhắn chứa "đặt hàng", tự động lấy thông tin người gửi và ghi vào Google Sheets. Quản lý đơn hàng không cần thao tác tay.',
    category: 'quan-ly',
    tags: ['Google Sheets', 'đơn hàng', 'CRM', 'quản lý'],
    icon: '📊',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận "đặt hàng"', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'đặt hàng,mua hàng,đặt mua,order', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.getUserInfo', label: 'Lấy thông tin KH', position: { x: 300, y: 200 },
        config: { userId: '{{ $trigger.fromId }}' } },
      { id: 'n3', type: 'data.textFormat', label: 'Chuẩn bị dữ liệu', position: { x: 300, y: 350 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.content }}\t{{ $trigger.timestamp }}' } },
      { id: 'n4', type: 'sheets.appendRow', label: 'Ghi vào Google Sheets', position: { x: 300, y: 500 },
        config: { spreadsheetId: '', sheetName: 'Đơn hàng', values: '{{ $node.n3.output }}', serviceAccountPath: '' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Xác nhận đơn hàng', position: { x: 300, y: 650 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '✅ Đã nhận đơn hàng của bạn!\n\nMình sẽ xác nhận và liên hệ lại trong 15 phút nhé. Cảm ơn bạn! 🙏' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 8. Nhắc nhở hàng ngày qua nhóm ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-daily-reminder',
    name: 'Gửi nhắc nhở hàng ngày trong nhóm',
    description: 'Chạy tự động theo lịch (VD: 8h sáng mỗi ngày), gửi tin nhắn nhắc nhở vào nhóm Zalo. Dùng cho checkin, nhắc họp, nhắc deadline...',
    category: 'quan-ly',
    tags: ['lịch hẹn', 'nhóm', 'nhắc nhở', 'hàng ngày'],
    icon: '⏰',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: 'Mỗi ngày lúc 8h sáng', position: { x: 300, y: 80 },
        config: { cronExpression: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.dateFormat', label: 'Lấy ngày hôm nay', position: { x: 300, y: 230 },
        config: { format: 'date' } },
      { id: 'n3', type: 'data.textFormat', label: 'Soạn nội dung', position: { x: 300, y: 380 },
        config: { template: '🌅 Chào buổi sáng!\n\n📅 Hôm nay {{ $node.n2.output }}\n\n📋 Nhắc nhở:\n• Kiểm tra tin nhắn mới\n• Cập nhật tiến độ công việc\n• Báo cáo cuối ngày\n\nChúc mọi người một ngày làm việc hiệu quả! 💪' } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi vào nhóm', position: { x: 300, y: 530 },
        config: { threadId: '', threadType: '2', message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 9. Auto React + Cảm ơn khi được thả tim ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-reaction-thanks',
    name: 'Tự động cảm ơn khi được react',
    description: 'Khi ai đó react (thả cảm xúc) tin nhắn của bạn, tự động gửi lời cảm ơn. Tạo ấn tượng tốt, tăng tương tác.',
    category: 'marketing',
    tags: ['react', 'cảm xúc', 'tương tác', 'cảm ơn'],
    icon: '❤️',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.reaction', label: 'Khi có người react', position: { x: 300, y: 80 },
        config: { reactionType: 'any', threadId: '' } },
      { id: 'n2', type: 'logic.wait', label: 'Chờ 1 giây', position: { x: 300, y: 230 },
        config: { delaySeconds: 1 } },
      { id: 'n3', type: 'data.randomPick', label: 'Chọn ngẫu nhiên câu cảm ơn', position: { x: 300, y: 370 },
        config: { options: 'Cảm ơn bạn nhé! 😊\nThank you! 🙏\nVui quá, cảm ơn bạn! ❤️\nHehe cảm ơn nha! 😄\nCảm ơn bạn đã quan tâm! 🌟' } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi lời cảm ơn', position: { x: 300, y: 510 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 10. Thành viên mới vào nhóm → Chào + Gắn nhãn ━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-group-welcome',
    name: 'Chào thành viên mới vào nhóm',
    description: 'Khi có thành viên mới tham gia nhóm Zalo, tự động gửi tin nhắn chào mừng và gắn nhãn "Thành viên mới".',
    category: 'quan-ly',
    tags: ['nhóm', 'chào mừng', 'thành viên', 'nhãn'],
    icon: '🎉',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.groupEvent', label: 'Thành viên vào nhóm', position: { x: 300, y: 80 },
        config: { groupId: '', eventType: 'join' } },
      { id: 'n2', type: 'zalo.sendMessage', label: 'Gửi lời chào nhóm', position: { x: 300, y: 250 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '2', message: '🎉 Chào mừng {{ $trigger.memberName }} đã gia nhập nhóm!\n\nHãy giới thiệu bản thân và đọc nội quy nhóm nhé 😊' } },
      { id: 'n3', type: 'zalo.assignLabel', label: 'Gắn nhãn "Thành viên mới"', position: { x: 300, y: 420 },
        config: { threadId: '{{ $trigger.memberId }}', labelSource: 'local', labelIds: [] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 11. Gửi tin nhắn hàng loạt theo danh sách ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bulk-message-sheets',
    name: 'Gửi tin nhắn hàng loạt từ Google Sheets',
    description: 'Đọc danh sách khách hàng (tên + ID) từ Google Sheets, rồi lặp qua từng dòng để gửi tin nhắn cá nhân hoá. Phù hợp cho chiến dịch marketing.',
    category: 'marketing',
    tags: ['hàng loạt', 'Google Sheets', 'marketing', 'cá nhân hoá'],
    icon: '📨',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: 'Chạy thủ công', position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'sheets.readValues', label: 'Đọc danh sách KH', position: { x: 300, y: 200 },
        config: { spreadsheetId: '', range: 'KhachHang!A2:C100', serviceAccountPath: '' } },
      { id: 'n3', type: 'logic.forEach', label: 'Lặp từng khách', position: { x: 300, y: 360 },
        config: { array: '{{ $node.n2.output }}', itemVariable: 'customer' } },
      { id: 'n4', type: 'data.textFormat', label: 'Soạn tin cá nhân', position: { x: 300, y: 520 },
        config: { template: 'Xin chào {{ $item.customer[0] }}! 👋\n\n🎁 Chúng tôi có chương trình ưu đãi đặc biệt dành riêng cho bạn. Nhắn "ưu đãi" để biết thêm chi tiết nhé!' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Gửi tin nhắn', position: { x: 300, y: 680 },
        config: { threadId: '{{ $item.customer[1] }}', threadType: '0', message: '{{ $node.n4.output }}' } },
      { id: 'n6', type: 'logic.wait', label: 'Chờ 5s (tránh spam)', position: { x: 300, y: 830 },
        config: { delaySeconds: 5 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
    ],
  },

  // ━━━━━ 12. Gán nhãn khi nhận được từ khoá cụ thể ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-keyword-label',
    name: 'Gán nhãn theo từ khoá tin nhắn',
    description: 'Tự động gắn nhãn cho hội thoại dựa trên nội dung tin nhắn. VD: chứa "giá" → gắn nhãn "Quan tâm giá", chứa "lỗi" → gắn nhãn "Cần hỗ trợ".',
    category: 'quan-ly',
    tags: ['nhãn', 'từ khoá', 'phân loại', 'CRM'],
    icon: '🏷️',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Chứa "giá" hoặc "bao nhiêu"?', position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'giá' } },
      { id: 'n3', type: 'zalo.assignLabel', label: 'Gắn nhãn "Quan tâm giá"', position: { x: 100, y: 380 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n4', type: 'logic.if', label: 'Chứa "lỗi" hoặc "hỗ trợ"?', position: { x: 550, y: 380 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'lỗi' } },
      { id: 'n5', type: 'zalo.assignLabel', label: 'Gắn nhãn "Cần hỗ trợ"', position: { x: 550, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'false', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
    ],
  },

  // ━━━━━ 13. Đa kênh: Zalo → Discord + Email ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-multi-channel-notify',
    name: 'Thông báo đa kênh (Discord + Email)',
    description: 'Nhận tin nhắn quan trọng trên Zalo, đồng thời gửi thông báo vào Discord Webhook và Email để không bỏ lỡ bất kỳ yêu cầu nào.',
    category: 'thong-bao',
    tags: ['discord', 'email', 'đa kênh', 'webhook'],
    icon: '🔔',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'data.textFormat', label: 'Soạn nội dung', position: { x: 300, y: 200 },
        config: { template: '📩 Tin nhắn mới từ {{ $trigger.fromName }}:\n{{ $trigger.content }}' } },
      { id: 'n3', type: 'notify.discord', label: 'Gửi vào Discord', position: { x: 100, y: 380 },
        config: { webhookUrl: '', message: '{{ $node.n2.output }}', username: 'Zalo Bot' } },
      { id: 'n4', type: 'notify.email', label: 'Gửi Email thông báo', position: { x: 500, y: 380 },
        config: { ...DEFAULT_CONFIGS['notify.email'], subject: 'Tin nhắn mới từ {{ $trigger.fromName }}', body: '{{ $node.n2.output }}' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Phản hồi khách', position: { x: 300, y: 560 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: 'Cảm ơn bạn! Mình đã nhận tin và sẽ phản hồi sớm nhất 🙏' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
      { id: 'e4', source: 'n2', target: 'n5' },
    ],
  },

  // ━━━━━ 14. Gọi API/Webhook bên ngoài ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-webhook-integration',
    name: 'Gọi Webhook / API khi nhận tin',
    description: 'Khi nhận tin nhắn, tự động gọi API/Webhook bên ngoài (CRM, ERP...) để đồng bộ dữ liệu. Rồi trả kết quả về cho khách.',
    category: 'nang-cao',
    tags: ['API', 'webhook', 'tích hợp', 'HTTP'],
    icon: '🔗',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'data.textFormat', label: 'Tạo request body', position: { x: 300, y: 200 },
        config: { template: '{"from": "{{ $trigger.fromName }}", "message": "{{ $trigger.content }}", "threadId": "{{ $trigger.threadId }}"}' } },
      { id: 'n3', type: 'output.httpRequest', label: 'Gọi API bên ngoài', position: { x: 300, y: 370 },
        config: { method: 'POST', url: 'https://your-api.com/webhook', headers: '{"Content-Type": "application/json"}', body: '{{ $node.n2.output }}', timeout: 10000 } },
      { id: 'n4', type: 'output.log', label: 'Ghi log kết quả', position: { x: 300, y: 530 },
        config: { message: 'API response: {{ $node.n3.output }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 15. Ghi thông tin khách mới vào Notion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-notion-crm',
    name: 'Lưu khách hàng mới vào Notion',
    description: 'Khi chấp nhận lời mời kết bạn, tự động lấy thông tin và tạo trang mới trong Notion Database. Biến Notion thành CRM đơn giản.',
    category: 'thong-bao',
    tags: ['Notion', 'CRM', 'kết bạn', 'database'],
    icon: '📝',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: 'Khi có lời mời kết bạn', position: { x: 300, y: 60 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: 'Chấp nhận kết bạn', position: { x: 300, y: 210 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'zalo.getUserInfo', label: 'Lấy thông tin', position: { x: 300, y: 360 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n4', type: 'notify.notion', label: 'Ghi vào Notion', position: { x: 300, y: 510 },
        config: {
          apiKey: '', databaseId: '',
          properties: '{"Tên": {"title": [{"text": {"content": "{{ $trigger.fromName }}"}}]}, "Nguồn": {"select": {"name": "Zalo"}}, "Ngày": {"date": {"start": "{{ $trigger.timestamp }}"}}}',
        } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Chào khách', position: { x: 300, y: 660 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: 'Chào bạn! 👋 Cảm ơn đã kết bạn. Mình có thể giúp gì cho bạn?' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 16. Chăm sóc khách hàng ngoài giờ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-off-hours-reply',
    name: 'Trả lời tự động ngoài giờ làm việc',
    description: 'Tự động nhận diện tin nhắn ngoài giờ hành chính (sau 18h hoặc cuối tuần) rồi gửi tin nhắn thông báo sẽ phản hồi vào ngày làm việc tiếp theo.',
    category: 'ban-hang',
    tags: ['ngoài giờ', 'CSKH', 'tự động', 'thời gian'],
    icon: '🌙',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'data.dateFormat', label: 'Lấy giờ hiện tại', position: { x: 300, y: 200 },
        config: { format: 'time' } },
      { id: 'n3', type: 'logic.if', label: 'Ngoài giờ làm việc?', position: { x: 300, y: 350 },
        config: { left: '{{ $node.n2.output }}', operator: 'greater_than', right: '18:00' } },
      { id: 'n4', type: 'zalo.sendTyping', label: 'Hiệu ứng đang gõ', position: { x: 100, y: 520 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Thông báo ngoài giờ', position: { x: 100, y: 670 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '🌙 Xin chào! Hiện tại đã ngoài giờ làm việc.\n\n⏰ Giờ hỗ trợ: 8h - 18h (T2 - T7)\n\nMình sẽ phản hồi bạn sớm nhất vào ngày làm việc tiếp theo nhé! 🙏' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  THÊM MẪU MỚI — Chăm sóc theo thời gian, follow-up, nurturing
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ━━━━━ 17. Gắn nhãn "Đã mua" → Chăm sóc sau 2 ngày ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-post-purchase-care',
    name: 'Chăm sóc sau mua hàng (2 ngày)',
    description: 'Khi gắn nhãn "Đã mua hàng" cho khách, tự động chờ 2 ngày rồi gửi tin nhắn hỏi thăm trải nghiệm sản phẩm. Tăng hài lòng & giữ chân khách.',
    category: 'ban-hang',
    tags: ['chăm sóc', 'sau mua hàng', 'nhãn', 'follow-up', 'nurturing'],
    icon: '🎁',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: 'Khi gắn nhãn "Đã mua"', position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: 'Chờ 2 ngày (172800s)', position: { x: 300, y: 210 },
        config: { delaySeconds: 172800 } },
      { id: 'n3', type: 'zalo.sendTyping', label: 'Hiệu ứng đang gõ', position: { x: 300, y: 350 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2, threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi tin hỏi thăm', position: { x: 300, y: 490 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: 'Xin chào! 😊\n\nMình muốn hỏi thăm bạn đã nhận được hàng chưa ạ? Sản phẩm dùng có ổn không?\n\nNếu cần hỗ trợ gì, cứ nhắn mình nhé! 🙏' } },
      { id: 'n5', type: 'output.log', label: 'Ghi log', position: { x: 300, y: 630 },
        config: { message: 'Đã gửi tin chăm sóc sau mua cho thread {{ $trigger.threadId }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 18. Follow-up khách chưa phản hồi sau 4 giờ ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-followup-4h',
    name: 'Follow-up sau 4 giờ chưa phản hồi',
    description: 'Khi gắn nhãn "Chờ phản hồi", hệ thống sẽ chờ 4 giờ rồi tự động gửi tin nhắn nhắc nhở nhẹ nhàng. Không để mất khách vì quên trả lời.',
    category: 'ban-hang',
    tags: ['follow-up', 'nhắc nhở', 'nhãn', 'chờ phản hồi', '4 giờ'],
    icon: '⏳',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: 'Khi gắn nhãn "Chờ phản hồi"', position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: 'Chờ 4 giờ (14400s)', position: { x: 300, y: 210 },
        config: { delaySeconds: 14400 } },
      { id: 'n3', type: 'data.randomPick', label: 'Chọn ngẫu nhiên câu nhắc', position: { x: 300, y: 360 },
        config: { options: 'Chào bạn! Mình gửi tin nhắn trước đó, không biết bạn đã xem chưa ạ? 😊\nHi bạn! Mình muốn hỏi thăm, bạn có cần tư vấn thêm không ạ? 🙏\nXin chào! Mình vẫn sẵn sàng hỗ trợ bạn nếu cần nhé! 💪\nBạn ơi, mình có thông tin muốn chia sẻ thêm. Bạn có rảnh không ạ? 😄' } },
      { id: 'n4', type: 'zalo.sendTyping', label: 'Hiệu ứng đang gõ', position: { x: 300, y: 500 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2, threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Gửi tin follow-up', position: { x: 300, y: 640 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 19. Chuỗi chăm sóc 3 bước: 1h → 1 ngày → 3 ngày ━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-nurture-sequence-3step',
    name: 'Chuỗi chăm sóc 3 bước (1h → 1 ngày → 3 ngày)',
    description: 'Khi gắn nhãn "Khách mới", tự động gửi 3 tin nhắn chăm sóc theo lịch: sau 1 giờ gửi chào, sau 1 ngày gửi giới thiệu, sau 3 ngày gửi ưu đãi.',
    category: 'ban-hang',
    tags: ['chuỗi', 'nurturing', '3 bước', 'chăm sóc', 'drip'],
    icon: '📬',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: 'Khi gắn nhãn "Khách mới"', position: { x: 300, y: 50 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      // Bước 1: Sau 1 giờ
      { id: 'n2', type: 'logic.wait', label: 'Chờ 1 giờ', position: { x: 300, y: 180 },
        config: { delaySeconds: 3600 } },
      { id: 'n3', type: 'zalo.sendMessage', label: '📩 Bước 1: Chào & giới thiệu', position: { x: 300, y: 310 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: 'Chào bạn! 👋\n\nCảm ơn bạn đã quan tâm đến sản phẩm của mình. Mình xin giới thiệu nhanh:\n\n✅ Sản phẩm chất lượng cao\n✅ Giá cả hợp lý\n✅ Hỗ trợ 24/7\n\nBạn muốn tìm hiểu thêm về sản phẩm nào ạ?' } },
      // Bước 2: Sau 1 ngày
      { id: 'n4', type: 'logic.wait', label: 'Chờ 1 ngày', position: { x: 300, y: 450 },
        config: { delaySeconds: 86400 } },
      { id: 'n5', type: 'zalo.sendMessage', label: '📩 Bước 2: Chia sẻ giá trị', position: { x: 300, y: 580 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: 'Hi bạn! 😊\n\n📖 Mình muốn chia sẻ thêm một vài điều thú vị:\n\n🔹 Hơn 1000+ khách hàng hài lòng\n🔹 Đánh giá 5⭐ trên các nền tảng\n🔹 Chính sách đổi trả 30 ngày\n\nBạn có câu hỏi gì không? Mình giải đáp ngay!' } },
      // Bước 3: Sau 3 ngày
      { id: 'n6', type: 'logic.wait', label: 'Chờ 3 ngày', position: { x: 300, y: 720 },
        config: { delaySeconds: 259200 } },
      { id: 'n7', type: 'zalo.sendMessage', label: '📩 Bước 3: Ưu đãi đặc biệt', position: { x: 300, y: 860 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '🎉 Tin vui dành riêng cho bạn!\n\n🎁 Ưu đãi GIẢM 20% cho đơn hàng đầu tiên!\n⏰ Chỉ áp dụng trong 48 giờ tới\n\n👉 Nhắn "ĐẶT HÀNG" để mình hỗ trợ ngay nhé!\n\nCảm ơn bạn đã đồng hành 🙏' } },
      { id: 'n8', type: 'output.log', label: 'Hoàn thành chuỗi', position: { x: 300, y: 990 },
        config: { message: 'Hoàn thành chuỗi chăm sóc 3 bước cho {{ $trigger.threadId }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n7', target: 'n8' },
    ],
  },

  // ━━━━━ 20. Gửi tin nhắn khi gắn nhãn VIP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-label-vip-notify',
    name: 'Chào đón khách VIP khi gắn nhãn',
    description: 'Khi gắn nhãn "VIP" cho khách, tự động gửi tin nhắn chào đón đặc biệt và thông báo quyền lợi VIP. Tạo ấn tượng tốt.',
    category: 'ban-hang',
    tags: ['VIP', 'nhãn', 'chào đón', 'CSKH', 'ưu đãi'],
    icon: '👑',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: 'Khi gắn nhãn "VIP"', position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: 'Chờ 3 giây', position: { x: 300, y: 200 },
        config: { delaySeconds: 3 } },
      { id: 'n3', type: 'zalo.sendMessage', label: 'Gửi chào đón VIP', position: { x: 300, y: 340 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '👑 Chào mừng bạn trở thành Khách VIP!\n\n🎁 Quyền lợi dành riêng cho bạn:\n• Giảm 15% mọi đơn hàng\n• Ưu tiên xử lý đơn nhanh hơn\n• Tư vấn 1-1 riêng biệt\n• Quà tặng vào dịp đặc biệt\n\nCảm ơn bạn đã tin tưởng! ❤️' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 21. Gửi menu sản phẩm khi hỏi "sản phẩm" / "menu" ━━━━━━━━━━━━━━━━
  {
    id: 'tpl-send-product-menu',
    name: 'Gửi menu/catalogue khi được hỏi',
    description: 'Khi khách nhắn "sản phẩm", "menu", "catalogue"... tự động gửi ảnh menu và tin nhắn mô tả sản phẩm. Tiết kiệm thời gian giới thiệu.',
    category: 'ban-hang',
    tags: ['menu', 'sản phẩm', 'catalogue', 'ảnh', 'giới thiệu'],
    icon: '📸',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi hỏi về sản phẩm', position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'sản phẩm,menu,catalogue,catalog,danh mục', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.sendTyping', label: 'Hiệu ứng đang gõ', position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n3', type: 'zalo.sendMessage', label: 'Gửi danh mục SP', position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '📋 Danh mục sản phẩm:\n\n🔹 Nhóm A — Sản phẩm cơ bản\n  • SP1: 199k | SP2: 299k | SP3: 399k\n\n🔹 Nhóm B — Sản phẩm cao cấp\n  • SP4: 599k | SP5: 799k | SP6: 999k\n\n🔹 Combo tiết kiệm\n  • Combo 1: 499k (tiết kiệm 30%)\n  • Combo 2: 899k (tiết kiệm 40%)\n\n👉 Nhắn mã SP (VD: "SP1") để xem chi tiết nhé!' } },
      { id: 'n4', type: 'zalo.assignLabel', label: 'Gắn nhãn "Quan tâm SP"', position: { x: 300, y: 490 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 22. Nhắn xác nhận đơn hàng + gắn tag trạng thái ━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-order-confirm-tag',
    name: 'Xác nhận đơn + gắn nhãn trạng thái',
    description: 'Khi nhận tin "đặt hàng", tự động gửi xác nhận, gắn nhãn "Đang xử lý", ghi log đơn hàng. Quản lý pipeline bán hàng hiệu quả.',
    category: 'ban-hang',
    tags: ['đặt hàng', 'xác nhận', 'nhãn', 'pipeline', 'trạng thái'],
    icon: '✅',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận "đặt hàng"', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'đặt hàng,order,mua,đặt mua', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.assignLabel', label: 'Gắn nhãn "Đang xử lý"', position: { x: 300, y: 200 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n3', type: 'zalo.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi xác nhận đơn', position: { x: 300, y: 480 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '✅ Đã nhận yêu cầu đặt hàng!\n\n📋 Để hoàn tất, bạn vui lòng gửi:\n1️⃣ Tên sản phẩm & số lượng\n2️⃣ Họ tên người nhận\n3️⃣ Số điện thoại\n4️⃣ Địa chỉ giao hàng\n\nMình sẽ xác nhận ngay sau khi nhận thông tin! 🙏' } },
      { id: 'n5', type: 'output.log', label: 'Ghi log đơn mới', position: { x: 300, y: 620 },
        config: { message: 'Đơn hàng mới từ {{ $trigger.fromName }} ({{ $trigger.threadId }}): {{ $trigger.content }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 23. Gắn nhãn → Nhắc review sau 7 ngày ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-review-reminder-7d',
    name: 'Nhắc khách đánh giá sau 7 ngày',
    description: 'Khi gắn nhãn "Đã giao hàng", chờ 7 ngày rồi tự động gửi tin nhắn nhờ khách đánh giá sản phẩm. Thu thập feedback tự động.',
    category: 'marketing',
    tags: ['đánh giá', 'review', '7 ngày', 'feedback', 'nhãn'],
    icon: '⭐',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: 'Khi gắn nhãn "Đã giao"', position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: 'Chờ 7 ngày', position: { x: 300, y: 200 },
        config: { delaySeconds: 604800 } },
      { id: 'n3', type: 'zalo.sendTyping', label: 'Hiệu ứng gõ', position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2, threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi nhờ đánh giá', position: { x: 300, y: 480 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: 'Xin chào! 😊\n\nBạn đã sử dụng sản phẩm được 1 tuần rồi. Bạn cảm thấy thế nào ạ?\n\n⭐ Nếu hài lòng, mình rất vui nếu bạn dành 1 phút chia sẻ trải nghiệm nhé!\n\n🎁 Đánh giá ngay → Nhận voucher giảm 10% cho lần mua tiếp theo!\n\nCảm ơn bạn rất nhiều 🙏' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 24. Gửi ưu đãi cho khách gắn nhãn cụ thể ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-label-promo-send',
    name: 'Gửi ưu đãi theo nhãn khách hàng',
    description: 'Khi gắn nhãn "Ưu đãi tháng 3" (hoặc nhãn tuỳ chọn), tự động gửi ngay tin nhắn khuyến mãi đã soạn sẵn. Dùng cho chiến dịch promo nhanh.',
    category: 'marketing',
    tags: ['ưu đãi', 'nhãn', 'khuyến mãi', 'chiến dịch', 'promo'],
    icon: '🎯',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: 'Khi gắn nhãn promo', position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: 'Chờ 5 giây', position: { x: 300, y: 200 },
        config: { delaySeconds: 5 } },
      { id: 'n3', type: 'zalo.sendMessage', label: 'Gửi ưu đãi', position: { x: 300, y: 340 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '🔥 ƯU ĐÃI ĐẶC BIỆT!\n\n🎁 Giảm ngay 30% cho tất cả sản phẩm\n📅 Áp dụng: Từ nay đến cuối tháng\n🏷️ Mã: SALE30\n\n👉 Nhắn "MUA" để đặt hàng ngay!\n\n⚡ Số lượng có hạn — Ai nhanh được trước!' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 25. Chiến dịch re-engagement — Nhắn lại KH im lặng ━━━━━━━━━━━━━━━━
  {
    id: 'tpl-reengagement-campaign',
    name: 'Re-engagement: Nhắn lại khách im lặng',
    description: 'Đọc danh sách khách "im lặng" từ Google Sheets (KH chưa nhắn >30 ngày), gửi tin nhắn gợi lại quan tâm. Khôi phục khách hàng cũ.',
    category: 'marketing',
    tags: ['re-engagement', 'khách cũ', 'Google Sheets', 'chiến dịch', 'khôi phục'],
    icon: '🔄',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: 'Chạy thủ công', position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'sheets.readValues', label: 'Đọc DS khách im lặng', position: { x: 300, y: 190 },
        config: { spreadsheetId: '', range: 'KhachImLang!A2:B100', serviceAccountPath: '' } },
      { id: 'n3', type: 'logic.forEach', label: 'Lặp từng khách', position: { x: 300, y: 340 },
        config: { array: '{{ $node.n2.output }}', itemVariable: 'kh' } },
      { id: 'n4', type: 'data.randomPick', label: 'Chọn nội dung ngẫu nhiên', position: { x: 300, y: 490 },
        config: { options: 'Chào {{ $item.kh[0] }}! 👋 Lâu rồi không gặp, bạn khoẻ không? Mình có nhiều sản phẩm mới muốn giới thiệu nhé!\nHi {{ $item.kh[0] }}! 😊 Bạn đã bỏ lỡ nhiều ưu đãi hấp dẫn. Nhắn "ƯU ĐÃI" để xem ngay!\nXin chào {{ $item.kh[0] }}! Cảm ơn bạn đã từng tin tưởng. Mình có quà đặc biệt dành cho bạn — nhắn "QUÀ" nhé! 🎁' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Gửi tin re-engage', position: { x: 300, y: 640 },
        config: { threadId: '{{ $item.kh[1] }}', threadType: '0', message: '{{ $node.n4.output }}' } },
      { id: 'n6', type: 'logic.wait', label: 'Chờ 10s (tránh spam)', position: { x: 300, y: 790 },
        config: { delaySeconds: 10 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
    ],
  },

  // ━━━━━ 26. Tạo poll khảo sát trong nhóm hàng tuần ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-weekly-poll',
    name: 'Tạo poll khảo sát nhóm hàng tuần',
    description: 'Mỗi thứ Hai tự động tạo bình chọn trong nhóm Zalo để khảo sát ý kiến thành viên. Tăng tương tác nhóm.',
    category: 'marketing',
    tags: ['poll', 'bình chọn', 'nhóm', 'hàng tuần', 'khảo sát'],
    icon: '📊',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: 'Thứ Hai lúc 9h sáng', position: { x: 300, y: 60 },
        config: { cronExpression: '0 9 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'zalo.createPoll', label: 'Tạo bình chọn', position: { x: 300, y: 220 },
        config: { groupId: '', question: '📊 Bạn muốn chủ đề chia sẻ tuần này là gì?', options: 'Tips bán hàng\nCông nghệ mới\nSức khoẻ & đời sống\nKỹ năng mềm\nKhác (comment bên dưới)', allowMultiple: false, expireTime: 0 } },
      { id: 'n3', type: 'output.log', label: 'Ghi log', position: { x: 300, y: 370 },
        config: { message: 'Đã tạo poll khảo sát tuần mới', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 27. Theo dõi thành viên rời nhóm → Thông báo admin ━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-group-leave-alert',
    name: 'Thông báo khi thành viên rời nhóm',
    description: 'Khi có thành viên rời nhóm, tự động gửi thông báo vào nhóm admin hoặc Telegram để theo dõi.',
    category: 'quan-ly',
    tags: ['nhóm', 'rời nhóm', 'theo dõi', 'thông báo', 'admin'],
    icon: '🚪',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.groupEvent', label: 'Thành viên rời nhóm', position: { x: 300, y: 60 },
        config: { groupId: '', eventType: 'leave' } },
      { id: 'n2', type: 'data.textFormat', label: 'Soạn nội dung báo cáo', position: { x: 300, y: 210 },
        config: { template: '🚪 Thành viên rời nhóm\n\n👤 {{ $trigger.memberName }}\n🏠 Nhóm: {{ $trigger.threadId }}\n⏰ Lúc: {{ $trigger.timestamp }}\n\nCó thể cần follow-up?' } },
      { id: 'n3', type: 'notify.telegram', label: 'Báo qua Telegram', position: { x: 300, y: 370 },
        config: { botToken: '', chatId: '', message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 28. Báo cáo tổng hợp cuối ngày qua Telegram ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-daily-report-telegram',
    name: 'Báo cáo cuối ngày qua Telegram',
    description: 'Mỗi ngày lúc 18h, tự động lấy dữ liệu từ Google Sheets (doanh số, đơn hàng...) và gửi báo cáo tổng hợp vào Telegram.',
    category: 'quan-ly',
    tags: ['báo cáo', 'cuối ngày', 'Telegram', 'Google Sheets', 'tổng hợp'],
    icon: '📈',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: 'Mỗi ngày lúc 18h', position: { x: 300, y: 50 },
        config: { cronExpression: '0 18 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.dateFormat', label: 'Lấy ngày hôm nay', position: { x: 300, y: 190 },
        config: { format: 'date' } },
      { id: 'n3', type: 'sheets.readValues', label: 'Đọc dữ liệu báo cáo', position: { x: 300, y: 330 },
        config: { spreadsheetId: '', range: 'BaoCao!A1:D10', serviceAccountPath: '' } },
      { id: 'n4', type: 'data.textFormat', label: 'Soạn báo cáo', position: { x: 300, y: 480 },
        config: { template: '📊 *BÁO CÁO CUỐI NGÀY*\n📅 {{ $node.n2.output }}\n\n━━━━━━━━━━━━\n📦 Đơn hàng mới: Xem Sheet\n💰 Doanh thu: Xem Sheet\n👥 Khách mới: Xem Sheet\n💬 Tin nhắn xử lý: Xem Sheet\n━━━━━━━━━━━━\n\n✅ Hoàn thành ngày làm việc!' } },
      { id: 'n5', type: 'notify.telegram', label: 'Gửi qua Telegram', position: { x: 300, y: 630 },
        config: { botToken: '', chatId: '', message: '{{ $node.n4.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 29. Quản lý nghỉ phép — Nhắn "nghỉ" → ghi Sheets + thông báo nhóm ━━
  {
    id: 'tpl-leave-request',
    name: 'Quản lý xin nghỉ phép qua Zalo',
    description: 'Nhân viên nhắn "nghỉ [ngày] [lý do]", hệ thống tự động ghi vào Google Sheets và thông báo trong nhóm quản lý.',
    category: 'quan-ly',
    tags: ['nghỉ phép', 'nhân sự', 'Google Sheets', 'quản lý', 'nhóm'],
    icon: '📝',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhắn "nghỉ..."', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'nghỉ,xin nghỉ,ngày nghỉ', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'data.textFormat', label: 'Chuẩn bị dữ liệu', position: { x: 300, y: 200 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.content }}\t{{ $trigger.timestamp }}' } },
      { id: 'n3', type: 'sheets.appendRow', label: 'Ghi vào Sheet nghỉ phép', position: { x: 100, y: 370 },
        config: { spreadsheetId: '', sheetName: 'NghiPhep', values: '{{ $node.n2.output }}', serviceAccountPath: '' } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Thông báo nhóm QL', position: { x: 500, y: 370 },
        config: { threadId: '', threadType: '2', message: '📋 Yêu cầu nghỉ phép mới:\n\n👤 {{ $trigger.fromName }}\n💬 {{ $trigger.content }}\n⏰ {{ $trigger.timestamp }}\n\nAdmin phê duyệt bằng cách reply "OK" hoặc "Từ chối".' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Phản hồi người xin', position: { x: 300, y: 530 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '✅ Đã nhận yêu cầu nghỉ phép của bạn!\n\nQuản lý sẽ xem xét và phản hồi sớm nhé. 🙏' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
      { id: 'e4', source: 'n3', target: 'n5' },
    ],
  },

  // ━━━━━ 30. Cập nhật trạng thái đơn khi gắn nhãn → Thông báo KH ━━━━━━━━━━━
  {
    id: 'tpl-order-status-update',
    name: 'Thông báo KH khi cập nhật trạng thái đơn',
    description: 'Khi gắn nhãn "Đang giao" / "Đã giao" / "Hoàn thành", tự động gửi tin nhắn cập nhật trạng thái cho khách hàng.',
    category: 'quan-ly',
    tags: ['đơn hàng', 'trạng thái', 'nhãn', 'cập nhật', 'thông báo'],
    icon: '📦',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: 'Khi gắn nhãn trạng thái', position: { x: 300, y: 50 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.switch', label: 'Nhãn nào?', position: { x: 300, y: 200 },
        config: {
          value: '{{ $trigger.labelText }}',
          cases: [
            { label: 'Đang giao', value: 'Đang giao' },
            { label: 'Đã giao', value: 'Đã giao' },
            { label: 'Hoàn thành', value: 'Hoàn thành' },
          ],
          defaultLabel: 'Khác',
        } },
      { id: 'n3', type: 'zalo.sendMessage', label: '🚚 Thông báo đang giao', position: { x: 0, y: 400 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '🚚 Đơn hàng của bạn đang được vận chuyển!\n\nDự kiến giao trong 1-3 ngày. Bạn vui lòng để ý điện thoại nhé!\n\nCảm ơn bạn! 🙏' } },
      { id: 'n4', type: 'zalo.sendMessage', label: '📬 Thông báo đã giao', position: { x: 300, y: 400 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '📬 Đơn hàng đã được giao!\n\nBạn kiểm tra hàng và phản hồi cho mình nếu có vấn đề gì nhé.\n\n⭐ Đừng quên đánh giá sản phẩm để nhận ưu đãi lần sau! 🎁' } },
      { id: 'n5', type: 'zalo.sendMessage', label: '✅ Thông báo hoàn thành', position: { x: 600, y: 400 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '✅ Đơn hàng đã hoàn thành!\n\nCảm ơn bạn đã mua sắm. Hẹn gặp lại! ❤️\n\n🔖 Mã giảm giá cho lần sau: THANKYOU10' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'case-0', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'case-1', target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: 'case-2', target: 'n5' },
    ],
  },

  // ━━━━━ 31. Tổng hợp tin nhắn mới → Gửi Telegram hàng giờ ━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-hourly-summary-telegram',
    name: 'Tổng hợp tin nhắn mỗi giờ → Telegram',
    description: 'Mỗi giờ 1 lần, tự động gửi tóm tắt số lượng tin nhắn mới vào nhóm Telegram để team theo dõi. Không bỏ lỡ tin nhắn nào.',
    category: 'thong-bao',
    tags: ['tổng hợp', 'hàng giờ', 'Telegram', 'monitoring', 'theo dõi'],
    icon: '📡',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: 'Mỗi giờ 1 lần', position: { x: 300, y: 60 },
        config: { cronExpression: '0 * * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.dateFormat', label: 'Lấy giờ hiện tại', position: { x: 300, y: 200 },
        config: { format: 'datetime' } },
      { id: 'n3', type: 'data.textFormat', label: 'Soạn tóm tắt', position: { x: 300, y: 340 },
        config: { template: '⏰ Cập nhật lúc {{ $node.n2.output }}\n\n📊 Tình trạng hệ thống: ✅ Hoạt động\n💬 Các workflow đang chạy bình thường\n\n— Gửi tự động bởi Deplao Bot' } },
      { id: 'n4', type: 'notify.telegram', label: 'Gửi Telegram', position: { x: 300, y: 480 },
        config: { botToken: '', chatId: '', message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 32. Alert từ khoá nhạy cảm / spam ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-spam-alert',
    name: 'Cảnh báo tin nhắn nhạy cảm / spam',
    description: 'Phát hiện từ khoá nhạy cảm (lừa đảo, spam, quảng cáo...) trong tin nhắn nhóm, gửi cảnh báo ngay cho admin qua Telegram.',
    category: 'thong-bao',
    tags: ['spam', 'cảnh báo', 'nhạy cảm', 'admin', 'an ninh'],
    icon: '🚨',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Lọc từ khoá nhạy cảm', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'lừa đảo,scam,spam,hack,virus,đầu tư lãi suất,kiếm tiền online', keywordMode: 'contains_any', threadType: 'group' } },
      { id: 'n2', type: 'data.textFormat', label: 'Soạn cảnh báo', position: { x: 300, y: 200 },
        config: { template: '🚨 *CẢNH BÁO TIN NHẮN NHẠY CẢM*\n\n👤 Người gửi: {{ $trigger.fromName }}\n🏠 Nhóm: {{ $trigger.threadId }}\n💬 Nội dung: {{ $trigger.content }}\n⏰ Lúc: {{ $trigger.timestamp }}\n\n⚠️ Cần kiểm tra ngay!' } },
      { id: 'n3', type: 'notify.telegram', label: 'Alert Telegram admin', position: { x: 100, y: 380 },
        config: { botToken: '', chatId: '', message: '{{ $node.n2.output }}' } },
      { id: 'n4', type: 'output.log', label: 'Ghi log sự cố', position: { x: 500, y: 380 },
        config: { message: 'SPAM ALERT: {{ $trigger.fromName }} — {{ $trigger.content }}', level: 'warning' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
    ],
  },

  // ━━━━━ 33. Đồng bộ KH mới → Sheets + Telegram ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-new-customer-sync',
    name: 'Đồng bộ khách mới → Sheets + Telegram',
    description: 'Khi chấp nhận kết bạn, tự động ghi thông tin khách vào Google Sheets VÀ gửi thông báo vào Telegram. Không bỏ sót khách nào.',
    category: 'thong-bao',
    tags: ['đồng bộ', 'khách mới', 'Google Sheets', 'Telegram', 'CRM'],
    icon: '🔄',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: 'Khi có lời mời kết bạn', position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: 'Chấp nhận kết bạn', position: { x: 300, y: 190 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'data.textFormat', label: 'Chuẩn bị data', position: { x: 300, y: 330 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.userId }}\t{{ $trigger.timestamp }}' } },
      { id: 'n4', type: 'sheets.appendRow', label: 'Ghi vào Sheets', position: { x: 100, y: 490 },
        config: { spreadsheetId: '', sheetName: 'KhachMoi', values: '{{ $node.n3.output }}', serviceAccountPath: '' } },
      { id: 'n5', type: 'notify.telegram', label: 'Thông báo Telegram', position: { x: 500, y: 490 },
        config: { botToken: '', chatId: '', message: '👤 Khách mới kết bạn!\n\nTên: {{ $trigger.fromName }}\nID: {{ $trigger.userId }}\nLúc: {{ $trigger.timestamp }}' } },
      { id: 'n6', type: 'zalo.sendMessage', label: 'Chào khách', position: { x: 300, y: 640 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: 'Xin chào! 👋 Cảm ơn bạn đã kết bạn.\nMình có thể giúp gì cho bạn ạ?' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n3', target: 'n5' },
      { id: 'e5', source: 'n4', target: 'n6' },
    ],
  },

  // ━━━━━ 34. AI FAQ Bot — Trả lời câu hỏi thường gặp ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-faq-bot',
    name: 'AI FAQ Bot — Tự động trả lời câu hỏi thường gặp',
    description: 'Cung cấp bộ FAQ trong system prompt, AI sẽ tự trả lời chính xác dựa trên thông tin bạn cung cấp. Không cần viết từng câu trả lời.',
    category: 'ai',
    tags: ['AI', 'FAQ', 'câu hỏi', 'tự động', 'hỗ trợ'],
    icon: '❓',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'logic.stopIf', label: 'Bỏ qua nếu rỗng', position: { x: 300, y: 190 },
        config: { left: '{{ $trigger.content }}', operator: 'equals', right: '' } },
      { id: 'n3', type: 'zalo.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 330 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n4', type: 'ai.generateText', label: 'AI trả lời từ FAQ', position: { x: 300, y: 470 },
        config: {
          platform: 'openai', apiKey: '', model: 'gpt-4o-mini',
          systemPrompt: 'Bạn là trợ lý hỗ trợ khách hàng. Trả lời DỰA TRÊN FAQ bên dưới. Nếu câu hỏi ngoài FAQ, nói "Mình sẽ chuyển cho nhân viên hỗ trợ nhé!".\n\n--- FAQ ---\nQ: Giờ mở cửa?\nA: 8h - 21h hàng ngày (T2-CN)\n\nQ: Phí ship bao nhiêu?\nA: Miễn phí ship đơn từ 300k. Dưới 300k phí ship 25k.\n\nQ: Đổi trả như thế nào?\nA: Đổi trả trong 7 ngày, sản phẩm còn nguyên tem mác.\n\nQ: Thanh toán bằng gì?\nA: Chuyển khoản, COD, hoặc ví MoMo/ZaloPay.\n\nQ: Bao lâu nhận hàng?\nA: Nội thành 1-2 ngày, tỉnh khác 3-5 ngày.',
          prompt: '{{ $trigger.content }}',
          maxTokens: 250, temperature: 0.3,
        } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Gửi câu trả lời', position: { x: 300, y: 620 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n4.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 35. AI tóm tắt cuộc hội thoại ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-conversation-summary',
    name: 'AI tóm tắt cuộc hội thoại',
    description: 'Chạy thủ công để lấy 20 tin nhắn gần nhất, dùng AI tóm tắt nội dung chính và gửi kết quả. Tiết kiệm thời gian review hội thoại dài.',
    category: 'ai',
    tags: ['AI', 'tóm tắt', 'hội thoại', 'review', 'lịch sử'],
    icon: '📑',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: 'Chạy thủ công', position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'zalo.getMessageHistory', label: 'Lấy 20 tin nhắn gần nhất', position: { x: 300, y: 190 },
        config: { threadId: '{{ $trigger.threadId }}', count: 20 } },
      { id: 'n3', type: 'ai.generateText', label: 'AI tóm tắt', position: { x: 300, y: 340 },
        config: {
          platform: 'openai', apiKey: '', model: 'gpt-4o-mini',
          systemPrompt: 'Bạn là trợ lý phân tích hội thoại. Hãy tóm tắt cuộc trò chuyện bằng tiếng Việt, nêu rõ:\n1. Chủ đề chính\n2. Các yêu cầu/vấn đề của khách\n3. Trạng thái (đã giải quyết / cần follow-up)\n4. Action items cần làm',
          prompt: 'Tóm tắt cuộc hội thoại sau:\n\n{{ $node.n2.output }}',
          maxTokens: 500, temperature: 0.3,
        } },
      { id: 'n4', type: 'output.log', label: 'Ghi log tóm tắt', position: { x: 300, y: 490 },
        config: { message: '📑 TÓM TẮT HỘI THOẠI:\n{{ $node.n3.output }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 36. AI soạn nội dung marketing tự động ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-marketing-content',
    name: 'AI soạn nội dung marketing',
    description: 'Chạy thủ công, nhập chủ đề sản phẩm → AI tự soạn bài viết marketing hấp dẫn để gửi cho khách hoặc đăng nhóm.',
    category: 'ai',
    tags: ['AI', 'marketing', 'content', 'bài viết', 'sáng tạo'],
    icon: '✍️',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhắn "viết [chủ đề]"', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'viết,soạn,tạo bài', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.sendTyping', label: 'AI đang soạn bài...', position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 5 } },
      { id: 'n3', type: 'ai.generateText', label: 'AI soạn bài marketing', position: { x: 300, y: 350 },
        config: {
          platform: 'openai', apiKey: '', model: 'gpt-4o-mini',
          systemPrompt: 'Bạn là chuyên gia viết content marketing. Viết bài ngắn gọn, hấp dẫn, có emoji. Format:\n- Tiêu đề bắt mắt\n- 3-4 bullet points lợi ích\n- Call-to-action rõ ràng\n- Tạo cảm giác urgency',
          prompt: 'Viết bài marketing về: {{ $trigger.content }}',
          maxTokens: 400, temperature: 0.8,
        } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi bài đã soạn', position: { x: 300, y: 500 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '✍️ Bài marketing AI đã soạn:\n\n{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 37. Chuyển tiếp tin nhắn có ảnh → Lưu trữ ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-forward-archive',
    name: 'Chuyển tiếp & lưu trữ tin nhắn quan trọng',
    description: 'Khi nhận tin nhắn chứa từ khoá quan trọng, tự động chuyển tiếp sang chat lưu trữ và ghi log. Không mất tin nhắn quan trọng.',
    category: 'nang-cao',
    tags: ['chuyển tiếp', 'lưu trữ', 'backup', 'quan trọng'],
    icon: '💾',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi có từ khoá quan trọng', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'hợp đồng,thanh toán,chuyển khoản,hoá đơn,invoice', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.forwardMessage', label: 'Chuyển tiếp tin nhắn', position: { x: 300, y: 200 },
        config: { msgId: '{{ $trigger.msgId }}', toThreadId: '', toThreadType: '0' } },
      { id: 'n3', type: 'data.textFormat', label: 'Soạn log', position: { x: 300, y: 350 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.content }}\t{{ $trigger.threadId }}\t{{ $trigger.timestamp }}' } },
      { id: 'n4', type: 'sheets.appendRow', label: 'Ghi vào Sheets lưu trữ', position: { x: 300, y: 500 },
        config: { spreadsheetId: '', sheetName: 'LuuTru', values: '{{ $node.n3.output }}', serviceAccountPath: '' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 38. Workflow kết hợp: Kết bạn → Gắn nhãn → Chăm sóc 3 ngày ━━━━━━━━
  {
    id: 'tpl-friend-tag-nurture',
    name: 'Kết bạn → Gắn nhãn → Chăm sóc sau 3 ngày',
    description: 'Trọn bộ: Chấp nhận kết bạn → Gửi chào → Gắn nhãn "Lead mới" → Chờ 3 ngày → Gửi tin follow-up giới thiệu sản phẩm.',
    category: 'nang-cao',
    tags: ['kết bạn', 'nhãn', 'chăm sóc', 'follow-up', 'trọn bộ'],
    icon: '🚀',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: 'Khi có lời mời kết bạn', position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: 'Chấp nhận', position: { x: 300, y: 180 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'logic.wait', label: 'Chờ 3 giây', position: { x: 300, y: 310 },
        config: { delaySeconds: 3 } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Gửi chào mừng', position: { x: 300, y: 440 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: 'Xin chào! 👋 Cảm ơn bạn đã kết bạn.\n\nMình chuyên cung cấp [tên sản phẩm/dịch vụ]. Bạn cần tư vấn gì cứ nhắn mình nhé! 😊' } },
      { id: 'n5', type: 'zalo.assignLabel', label: 'Gắn nhãn "Lead mới"', position: { x: 300, y: 580 },
        config: { threadId: '{{ $trigger.userId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n6', type: 'logic.wait', label: 'Chờ 3 ngày', position: { x: 300, y: 720 },
        config: { delaySeconds: 259200 } },
      { id: 'n7', type: 'zalo.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 860 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', delaySeconds: 3 } },
      { id: 'n8', type: 'zalo.sendMessage', label: 'Follow-up giới thiệu', position: { x: 300, y: 1000 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: 'Hi bạn! 😊 Mấy ngày trước bạn có kết bạn với mình.\n\n🎁 Mình muốn chia sẻ:\n• Sản phẩm bán chạy nhất tháng này\n• Ưu đãi giảm 15% cho khách mới\n\n👉 Nhắn "TƯ VẤN" để mình hỗ trợ chi tiết nhé!' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n7', target: 'n8' },
    ],
  },

  // ━━━━━ 39. Workflow điều kiện: Trả lời khác nhau theo loại thread ━━━━━━━━━━
  {
    id: 'tpl-reply-by-thread-type',
    name: 'Trả lời khác nhau: Chat riêng vs Nhóm',
    description: 'Cùng 1 tin nhắn, nhưng trả lời khác nhau tuỳ theo đến từ chat riêng hay nhóm. Chat riêng → tư vấn 1:1, nhóm → trả lời ngắn gọn + mời inbox.',
    category: 'nang-cao',
    tags: ['rẽ nhánh', 'nhóm', 'cá nhân', 'điều kiện', 'thông minh'],
    icon: '🔀',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Là chat riêng?', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.threadType }}', operator: 'equals', right: '0' } },
      { id: 'n3', type: 'zalo.sendTyping', label: 'Đang gõ (riêng)', position: { x: 80, y: 370 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 3 } },
      { id: 'n4', type: 'zalo.sendMessage', label: 'Trả lời chi tiết 1:1', position: { x: 80, y: 510 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: 'Cảm ơn bạn đã nhắn tin! 😊\n\nMình sẽ tư vấn chi tiết cho bạn. Bạn đang quan tâm đến sản phẩm/dịch vụ nào ạ?\n\n📋 Nhắn "MENU" để xem danh mục\n💰 Nhắn "GIÁ" để xem bảng giá\n📍 Nhắn "ĐỊA CHỈ" để biết nơi mua' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Trả lời ngắn gọn (nhóm)', position: { x: 520, y: 370 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: 'Cảm ơn bạn! Để được tư vấn chi tiết hơn, bạn inbox riêng cho mình nhé! 📩' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 40. Lập lịch gửi tin nhắn đặt trước ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-scheduled-broadcast',
    name: 'Lập lịch gửi tin nhắn broadcast',
    description: 'Đặt lịch gửi tin nhắn quảng cáo vào khung giờ vàng (11h trưa thứ 3 & thứ 5). Đọc danh sách KH từ Sheets và gửi tự động.',
    category: 'nang-cao',
    tags: ['lập lịch', 'broadcast', 'khung giờ vàng', 'tự động', 'chiến dịch'],
    icon: '📅',
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: 'T3 & T5 lúc 11h', position: { x: 300, y: 50 },
        config: { cronExpression: '0 11 * * 2,4', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'sheets.readValues', label: 'Đọc DS khách hàng', position: { x: 300, y: 190 },
        config: { spreadsheetId: '', range: 'DSGui!A2:C200', serviceAccountPath: '' } },
      { id: 'n3', type: 'data.randomPick', label: 'Chọn nội dung ngẫu nhiên', position: { x: 300, y: 340 },
        config: { options: '🌟 Khám phá bộ sưu tập mới nhất! Nhắn "XEM" để biết thêm.\n🔥 Flash Sale hôm nay! Giảm đến 50% — chỉ duy nhất hôm nay!\n🎁 Quà tặng bất ngờ cho 10 khách hàng đầu tiên reply tin này!' } },
      { id: 'n4', type: 'logic.forEach', label: 'Lặp gửi từng người', position: { x: 300, y: 490 },
        config: { array: '{{ $node.n2.output }}', itemVariable: 'kh' } },
      { id: 'n5', type: 'zalo.sendMessage', label: 'Gửi broadcast', position: { x: 300, y: 640 },
        config: { threadId: '{{ $item.kh[1] }}', threadType: '0', message: 'Chào {{ $item.kh[0] }}! 👋\n\n{{ $node.n3.output }}' } },
      { id: 'n6', type: 'logic.wait', label: 'Delay 8s giữa tin', position: { x: 300, y: 790 },
        config: { delaySeconds: 8 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
    ],
  },
];

