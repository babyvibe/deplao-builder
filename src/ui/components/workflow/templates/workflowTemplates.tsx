import React from 'react';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIGS } from '../workflowConfig';import { AwardIcon, BellIcon, BookIcon, BookmarkIcon, BotIcon, BrainIcon, CalendarIcon, ChartIcon, ChatIcon, CheckIcon, ClipboardListIcon, ClockIcon, CreditCardIcon, CrownIcon, DollarIcon, EditIcon, FileTextIcon, GiftIcon, HardDriveIcon, HomeIcon, ImageIcon, InboxIcon, KeyIcon, LightningIcon, LinkIcon, MaximizeIcon, MegaphoneIcon, MinimizeIcon, PackageIcon, PinIcon, PluginIcon, RefreshIcon, RocketIcon, SendIcon, SettingsIcon, ShieldIcon, ShoppingCartIcon, ShuffleIcon, SmartphoneIcon, StarIcon, TagIcon, TargetIcon, TrendingUpIcon, TruckIcon, UserCheckIcon, UserIcon, UsersIcon, WaveIcon, WifiIcon } from '@/components/common/icons';


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
  icon: string | React.ReactNode;
  difficulty: 'easy' | 'medium' | 'advanced';
  channel?: 'zalo' | 'facebook';
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
  | 'tich-hop'
  | 'webhook';      // Tích hợp POS & Thanh toán

export const TEMPLATE_CATEGORIES: { key: TemplateCategory; label: string; icon: React.ReactNode; color: string }[] = [
  { key: 'ban-hang',   label: 'Bán hàng & CSKH',           icon: <ShoppingCartIcon className="w-4 h-4" />, color: 'bg-blue-500' },
  { key: 'quan-ly',    label: 'Quản lý & Vận hành',         icon: <ClipboardListIcon className="w-4 h-4" />, color: 'bg-amber-500' },
  { key: 'marketing',  label: 'Marketing & Tiếp thị',       icon: <MegaphoneIcon className="w-4 h-4" />, color: 'bg-pink-500' },
  { key: 'thong-bao',  label: 'Thông báo & Tích hợp',       icon: <BellIcon className="w-4 h-4" />, color: 'bg-green-500' },
  { key: 'ai',         label: 'AI & Thông minh',             icon: <BotIcon className="w-4 h-4" />, color: 'bg-violet-500' },
  { key: 'nang-cao',   label: 'Nâng cao',                    icon: <SettingsIcon className="w-4 h-4" />, color: 'bg-rose-500' },
  { key: 'tich-hop',   label: 'Tích hợp POS & Thanh toán',  icon: <PluginIcon className="w-4 h-4" />, color: 'bg-teal-600' },
  { key: 'webhook',    label: 'Webhooks',                    icon: <LinkIcon className="w-4 h-4" />, color: 'bg-cyan-600' },
];

// ── Helper: generate fresh IDs when installing ─────────────────────────────────

/** Deep-clone a template and assign fresh UUIDs to all nodes/edges while keeping internal references intact */
/** Remap $node.xxx references in a string to use new UUIDs */
function remapNodeRefs(str: string, idMap: Record<string, string>): string {
  return str.replace(/\$node\.([\w-]+)\./g, (match, nodeRef) => {
    if (idMap[nodeRef]) return `$node.${idMap[nodeRef]}.`;
    return match;
  });
}

/** Deep-remap all string values in a config object */
function remapConfigRefs(config: Record<string, any>, idMap: Record<string, string>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(config)) {
    if (typeof val === 'string') {
      result[key] = remapNodeRefs(val, idMap);
    } else if (Array.isArray(val)) {
      result[key] = val.map(item =>
        typeof item === 'string' ? remapNodeRefs(item, idMap)
        : item && typeof item === 'object' ? remapConfigRefs(item, idMap)
        : item
      );
    } else if (val && typeof val === 'object') {
      result[key] = remapConfigRefs(val, idMap);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function instantiateTemplate(tpl: WorkflowTemplate): {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
} {
  const idMap: Record<string, string> = {};
  tpl.nodes.forEach(n => { idMap[n.id] = uuidv4(); });

  const nodes = tpl.nodes.map(n => ({
    ...n,
    id: idMap[n.id],
    config: remapConfigRefs(n.config, idMap),
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
    icon: <ChatIcon className="w-4 h-4" />,
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
    icon: <KeyIcon className="w-4 h-4" />,
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
    icon: <UserCheckIcon className="w-4 h-4" />,
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
    icon: <SmartphoneIcon className="w-4 h-4" />,
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
    icon: <BotIcon className="w-4 h-4" />,
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
          aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini',
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
    icon: <TagIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'ai.classify', label: 'AI phân loại tin nhắn', position: { x: 300, y: 200 },
        config: {
          aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini',
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
    icon: <ChartIcon className="w-4 h-4" />,
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
    icon: <ClockIcon className="w-4 h-4" />,
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
    icon: <StarIcon className="w-4 h-4" />,
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
    icon: <SendIcon className="w-4 h-4" />,
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
    icon: <TagIcon className="w-4 h-4" />,
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
    icon: <BellIcon className="w-4 h-4" />,
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
    icon: <LinkIcon className="w-4 h-4" />,
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
    icon: <EditIcon className="w-4 h-4" />,
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
    icon: <MinimizeIcon className="w-4 h-4" />,
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
    icon: <GiftIcon className="w-4 h-4" />,
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
    icon: <InboxIcon className="w-4 h-4" />,
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
    icon: <CrownIcon className="w-4 h-4" />,
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
    icon: <CheckIcon className="w-4 h-4" />,
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
    icon: <StarIcon className="w-4 h-4" />,
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
    icon: <TargetIcon className="w-4 h-4" />,
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
    icon: <RefreshIcon className="w-4 h-4" />,
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
    icon: <ChartIcon className="w-4 h-4" />,
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
    icon: <TrendingUpIcon className="w-4 h-4" />,
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
    icon: <EditIcon className="w-4 h-4" />,
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
    icon: <PackageIcon className="w-4 h-4" />,
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
    icon: <WifiIcon className="w-4 h-4" />,
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
    icon: <BellIcon className="w-4 h-4" />,
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
    icon: <RefreshIcon className="w-4 h-4" />,
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
          aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini',
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
    icon: <FileTextIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: 'Chạy thủ công', position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'zalo.getMessageHistory', label: 'Lấy 20 tin nhắn gần nhất', position: { x: 300, y: 190 },
        config: { threadId: '{{ $trigger.threadId }}', count: 20 } },
      { id: 'n3', type: 'ai.generateText', label: 'AI tóm tắt', position: { x: 300, y: 340 },
        config: {
          aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini',
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
          aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini',
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
    icon: <HardDriveIcon className="w-4 h-4" />,
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
    icon: <RocketIcon className="w-4 h-4" />,
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
    icon: <ShuffleIcon className="w-4 h-4" />,
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
    icon: <CalendarIcon className="w-4 h-4" />,
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FACEBOOK TEMPLATES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ━━━━━ FB 1. Tự động trả lời tin nhắn Facebook ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-auto-reply',
    name: 'FB: Tự động trả lời tin nhắn',
    description: 'Khi nhận tin nhắn mới trên Facebook Messenger, tự động gửi lại câu trả lời. Hiển thị hiệu ứng đang gõ trước khi gửi để tạo cảm giác tự nhiên.',
    category: 'ban-hang',
    tags: ['facebook', 'trả lời', 'tự động', 'messenger', 'cơ bản'],
    icon: <ChatIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 250, y: 80 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.sendTyping', label: 'Hiệu ứng đang gõ', position: { x: 250, y: 220 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'], isTyping: true } },
      { id: 'n3', type: 'logic.wait', label: 'Chờ 2 giây', position: { x: 250, y: 360 },
        config: { delaySeconds: 2 } },
      { id: 'n4', type: 'fb.action.sendMessage', label: 'Gửi câu trả lời', position: { x: 250, y: 500 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: 'Cảm ơn bạn đã nhắn tin! Đội ngũ support sẽ phản hồi bạn trong thời gian sớm nhất. 🙏' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 2. Auto Reaction + Trả lời theo từ khoá ━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-keyword-reply',
    name: 'FB: Reaction + Trả lời theo từ khoá',
    description: 'Thả reaction vào tin nhắn của khách, sau đó phân tích nội dung để trả lời: hỏi "giá" → gửi bảng giá, hỏi "địa chỉ" → gửi chỉ đường, còn lại → trả lời mặc định.',
    category: 'ban-hang',
    tags: ['facebook', 'từ khoá', 'reaction', 'rẽ nhánh', 'CSKH'],
    icon: <KeyIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.addReaction', label: 'Thả 👍 reaction', position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '👍' } },
      { id: 'n3', type: 'logic.if', label: 'Chứa "giá"?', position: { x: 350, y: 360 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'giá' } },
      { id: 'n4', type: 'logic.if', label: 'Chứa "địa chỉ"?', position: { x: 350, y: 500 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'địa chỉ' } },
      { id: 'n5', type: 'fb.action.sendMessage', label: 'Gửi bảng giá', position: { x: 50, y: 650 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📋 Bảng giá sản phẩm:\n\n• Gói Cơ bản: 199k/tháng\n• Gói Nâng cao: 399k/tháng\n• Gói Pro: 799k/tháng\n\nBạn muốn tư vấn gói nào ạ?' } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Gửi địa chỉ', position: { x: 350, y: 650 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📍 Địa chỉ của chúng tôi:\n\n123 Đường ABC, Phường XYZ, Quận 1, TP.HCM\n\n🕐 Giờ mở cửa: 8:00 - 22:00 (T2-CN)\n\n📱 Google Maps: https://maps.app.goo.gl/...' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: 'Trả lời chung', position: { x: 650, y: 650 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: 'Cảm ơn bạn đã quan tâm! Bạn cần hỗ trợ gì thêm không ạ? 😊' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n5' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n4' },
      { id: 'e5', source: 'n4', sourceHandle: 'true', target: 'n6' },
      { id: 'e6', source: 'n4', sourceHandle: 'false', target: 'n7' },
    ],
  },

  // ━━━━━ FB 3. Gửi tin nhắn chào mừng vào nhóm ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-group-welcome',
    name: 'FB: Chào mừng thành viên mới vào nhóm',
    description: 'Khi có tin nhắn mới từ thành viên trong nhóm Facebook, tự động gửi tin nhắn chào mừng kèm nội quy nhóm và hướng dẫn.',
    category: 'ban-hang',
    tags: ['facebook', 'nhóm', 'chào mừng', 'nội quy', 'tự động'],
    icon: <WaveIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Tin nhắn mới trong nhóm', position: { x: 250, y: 80 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Tin nhắn đầu từ user?', position: { x: 250, y: 220 },
        config: { left: '{{ $trigger.isFirstMessage }}', operator: 'equals', right: 'true' } },
      { id: 'n3', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 250, y: 370 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n4', type: 'fb.action.sendMessage', label: 'Gửi chào mừng', position: { x: 250, y: 510 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🎉 Chào mừng bạn đến với nhóm!\n\n📌 Nội quy nhóm:\n1. Không spam quảng cáo\n2. Tôn trọng các thành viên\n3. Đúng chủ đề thảo luận\n\n💬 Hãy giới thiệu bản thân để mọi người làm quen nhé!' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 4. Đánh dấu đã đọc + Reaction + Reply ━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-mark-read-reply',
    name: 'FB: Đánh dấu đã đọc và trả lời AI',
    description: 'Đánh dấu đã đọc tin nhắn Facebook, thả reaction, sau đó dùng AI để tạo câu trả lời thông minh dựa trên nội dung tin nhắn.',
    category: 'ai',
    tags: ['facebook', 'AI', 'thông minh', 'tự động', 'CSKH'],
    icon: <BotIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: 'Đánh dấu đã đọc', position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'fb.action.addReaction', label: 'Reaction 👍', position: { x: 300, y: 350 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '👍' } },
      { id: 'n4', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 500 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n5', type: 'ai.classify', label: 'Phân loại nội dung', position: { x: 300, y: 650 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], input: '{{ $trigger.content }}' } },
      { id: 'n6', type: 'ai.generateText', label: 'AI sinh câu trả lời', position: { x: 300, y: 800 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Khách hàng vừa gửi tin nhắn: "{{ $trigger.content }}"\nPhân loại: {{ $node.n5.output }}\n\nHãy trả lời một cách thân thiện, chuyên nghiệp bằng tiếng Việt.' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: 'Gửi câu trả lời', position: { x: 300, y: 960 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n6.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
    ],
  },

  // ━━━━━ FB 5. Lập lịch gửi tin nhắn hàng loạt ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-scheduled-broadcast',
    name: 'FB: Gửi tin theo lịch từ Google Sheets',
    description: 'Đọc danh sách người nhận từ Google Sheets và gửi tin nhắn hàng loạt trên Messenger vào khung giờ cố định mỗi ngày.',
    category: 'marketing',
    tags: ['facebook', 'lập lịch', 'broadcast', 'marketing', 'sheets'],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: '08:00 mỗi ngày', position: { x: 300, y: 50 },
        config: { cronExpression: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'sheets.readValues', label: 'Đọc DS từ Sheets', position: { x: 300, y: 200 },
        config: { spreadsheetId: '', range: 'DSGui!A2:C100', serviceAccountPath: '' } },
      { id: 'n3', type: 'data.textFormat', label: 'Soạn nội dung', position: { x: 300, y: 360 },
        config: { template: '🌞 Chào bạn!\n\nChương trình khuyến mãi hôm nay:\n• Giảm 20% tất cả sản phẩm\n• Miễn phí giao hàng nội thành\n\nLH: 0123.456.789 để đặt ngay!' } },
      { id: 'n4', type: 'logic.forEach', label: 'Gửi từng người', position: { x: 300, y: 520 },
        config: { array: '{{ $node.n2.output }}', itemVariable: 'kh' } },
      { id: 'n5', type: 'fb.action.sendMessage', label: 'Gửi tin', position: { x: 300, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n3.output }}' } },
      { id: 'n6', type: 'logic.wait', label: 'Chờ 10s', position: { x: 300, y: 830 },
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

  // ━━━━━ FB 6. Forward tin nhắn sang nhóm nội bộ ━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-forward-to-group',
    name: 'FB: Chuyển tiếp tin nhắn vào nhóm nội bộ',
    description: 'Khi khách hàng gửi tin nhắn chứa từ khoá "hỗ trợ" hoặc "khiếu nại", tự động chuyển tiếp tin nhắn đó vào nhóm nội bộ để CSDL xử lý.',
    category: 'ban-hang',
    tags: ['facebook', 'chuyển tiếp', 'nội bộ', 'CSKH', 'xử lý'],
    icon: <SendIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Cần hỗ trợ?', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'hỗ trợ, khiếu nại, complaint, support' } },
      { id: 'n3', type: 'fb.action.forward', label: 'Forward vào nhóm', position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n4', type: 'fb.action.sendMessage', label: 'Gửi xác nhận', position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📩 Yêu cầu của bạn đã được chuyển đến đội ngũ hỗ trợ. Chúng tôi sẽ phản hồi sớm nhất!\n\nThời gian xử lý dự kiến: 30 phút.' } },
      { id: 'n5', type: 'fb.action.addReaction', label: 'Reaction ✅', position: { x: 300, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '✅' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ FB 7. Tạo bình chọn trong nhóm theo lịch ━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-weekly-poll',
    name: 'FB: Bình chọn định kỳ trong nhóm',
    description: 'Vào mỗi thứ Hai hàng tuần, tự động tạo bình chọn (poll) trong nhóm Facebook để khảo sát ý kiến thành viên.',
    category: 'quan-ly',
    tags: ['facebook', 'bình chọn', 'nhóm', 'định kỳ', 'lịch'],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: 'Thứ Hai 09:00', position: { x: 250, y: 80 },
        config: { cronExpression: '0 9 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'fb.action.createPoll', label: 'Tạo poll tuần này', position: { x: 250, y: 240 },
        config: { ...DEFAULT_CONFIGS['fb.action.createPoll'], question: '📅 Chủ đề thảo luận tuần này?', options: 'Sản phẩm mới\nChăm sóc khách hàng\nMarketing\nKhác' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ FB 8. Chặn Spam ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-block-spam',
    name: 'FB: Tự động chặn spam',
    description: 'Khi nhận tin nhắn chứa nội dung spam (link lạ, quảng cáo), tự động chặn người gửi trên Messenger và ghi log.',
    category: 'quan-ly',
    tags: ['facebook', 'chặn', 'spam', 'bảo mật', 'tự động'],
    icon: <ShieldIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Có link lạ?', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'http://, https://, bit.ly, t.me' } },
      { id: 'n3', type: 'fb.action.block', label: 'Chặn người dùng', position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.block'], userId: '{{ $trigger.fromId }}' } },
      { id: 'n4', type: 'output.log', label: 'Ghi log spam', position: { x: 300, y: 520 },
        config: { message: 'Đã chặn spam: {{ $trigger.fromName }} ({{ $trigger.fromId }}) — nội dung: {{ $trigger.content }}', level: 'warning' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 9. Ghim tin nhắn quan trọng ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-pin-important',
    name: 'FB: Ghim tin nhắn quan trọng',
    description: 'Khi phát hiện tin nhắn chứa từ khoá "đơn hàng", "mã đơn" hoặc "order", tự động ghim tin nhắn đó trong hội thoại.',
    category: 'ban-hang',
    tags: ['facebook', 'ghim', 'quan trọng', 'đơn hàng', 'tự động'],
    icon: <PinIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Chứa mã đơn hàng?', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'đơn hàng, mã đơn, order, #DH' } },
      { id: 'n3', type: 'fb.action.pin', label: 'Ghim tin nhắn', position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.pin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n4', type: 'fb.action.sendMessage', label: 'Xác nhận đã ghim', position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📌 Đã ghim tin nhắn chứa mã đơn hàng. Chúng tôi sẽ xử lý sớm nhất!' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 10. Tư vấn bán hàng đa nhánh ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-sales-consultant',
    name: 'FB: Tư vấn bán hàng đa nhánh',
    description: 'Phân loại tin nhắn theo ý định: hỏi giá → gửi bảng giá, muốn đặt hàng → gửi form, cần hỗ trợ → chuyển tiếp CSKH. Mỗi nhánh có reaction và theo dõi riêng.',
    category: 'ban-hang',
    tags: ['facebook', 'bán hàng', 'tư vấn', 'phân luồng', 'CSKH'],
    icon: <ShoppingCartIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: 'Đánh dấu đã đọc', position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'fb.action.addReaction', label: 'Thả reaction 👀', position: { x: 350, y: 340 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '👀' } },
      { id: 'n4', type: 'logic.switch', label: 'Phân loại ý định', position: { x: 350, y: 480 },
        config: { value: '{{ $trigger.content }}', cases: [['giá, bảng giá, bao nhiêu', 'GIÁ'], ['đặt, mua, order, ship', 'ĐẶT'], ['hỗ trợ, lỗi, không được', 'HỖ TRỢ']], defaultLabel: 'KHÁC' } },
      { id: 'n5', type: 'fb.action.sendMessage', label: 'Gửi bảng giá', position: { x: 30, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📋 **Bảng giá sản phẩm:**\n\n🥇 Gói Cơ bản: 199k/tháng\n🥈 Gói Nâng cao: 399k/tháng\n🥉 Gói Pro: 799k/tháng\n\n💝 Đặt ngay hôm nay giảm thêm 10%!\n👉 Reply "ĐẶT" để mua ngay.' } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Xác nhận đặt hàng', position: { x: 350, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🎉 Cảm ơn bạn đã quan tâm!\n\nĐể đặt hàng, bạn vui lòng cho mình biết:\n1️⃣ Sản phẩm/mã sp bạn muốn mua\n2️⃣ Số lượng\n3️⃣ Địa chỉ nhận hàng\n4️⃣ SĐT liên hệ\n\nMình sẽ báo giá & gửi link thanh toán ngay!' } },
      { id: 'n7', type: 'fb.action.forward', label: 'Forward cho CSKH', position: { x: 670, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n8', type: 'fb.action.sendMessage', label: 'Trả lời mặc định', position: { x: 350, y: 810 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: 'Xin chào! 👋\n\nMình có thể giúp gì cho bạn hôm nay?\n\n💬 Nhắn "GIÁ" để xem bảng giá\n📦 Nhắn "ĐẶT" để đặt hàng\n🆘 Nhắn "HỖ TRỢ" nếu cần giúp đỡ' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },        { id: 'e5', source: 'n4', target: 'n6' },
      { id: 'e6', source: 'n4', target: 'n7' },
      { id: 'e7', source: 'n4', target: 'n8' },
    ],
  },

  // ━━━━━ FB 11. Đặt câu hỏi khảo sát + phản hồi AI ━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-survey-feedback',
    name: 'FB: Khảo sát ý kiến khách hàng + AI tổng hợp',
    description: 'Sau khi tương tác, gửi khảo sát NPS, nhận câu trả lời, dùng AI phân tích cảm xúc (tích cực/tiêu cực), phản hồi phù hợp và lưu log.',
    category: 'marketing',
    tags: ['facebook', 'khảo sát', 'AI', 'phản hồi', 'NPS'],
    icon: <ClipboardListIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Tin nhắn sau CSKH', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: 'Đánh dấu đã đọc', position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'logic.if', label: 'Khảo sát?', position: { x: 300, y: 350 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: 'hài lòng, đánh giá, survey, NPS, feedback' } },
      { id: 'n4', type: 'ai.classify', label: 'Phân loại cảm xúc', position: { x: 300, y: 510 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], categories: 'tích cực, tiêu cực, trung lập', input: '{{ $trigger.content }}' } },
      { id: 'n5', type: 'logic.switch', label: 'Theo cảm xúc', position: { x: 300, y: 670 },
        config: { value: '{{ $node.n4.output }}', cases: [['tích cực', 'VUI'], ['tiêu cực', 'BUỒN']], defaultLabel: 'THƯỜNG' } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Cảm ơn (tích cực)', position: { x: 30, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🥰 Cảm ơn bạn rất nhiều vì phản hồi tích cực! \n\nChúng tôi rất vui khi được phục vụ bạn. Hãy giới thiệu chúng tôi đến bạn bè nhé! ❤️' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: 'Xin lỗi (tiêu cực)', position: { x: 300, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '😔 Chúng tôi rất tiếc vì trải nghiệm chưa tốt của bạn. \n\nCho mình thêm thông tin chi tiết để cải thiện nhé? Hoặc bạn có thể gọi hotline 1900xxxx để được hỗ trợ ngay.' } },
      { id: 'n8', type: 'fb.action.addReaction', label: 'Reaction 💙', position: { x: 570, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '💙' } },
      { id: 'n9', type: 'output.log', label: 'Ghi log đánh giá', position: { x: 300, y: 990 },
        config: { message: 'Feedback từ {{ $trigger.fromName }}: {{ $trigger.content }} — cảm xúc: {{ $node.n4.output }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n5', target: 'n7' },
      { id: 'e7', source: 'n5', target: 'n8' },
      { id: 'e8', source: 'n8', target: 'n9' },
    ],
  },

  // ━━━━━ FB 12. Xử lý đơn hàng với Set Variable + Log ━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-order-processor',
    name: 'FB: Xử lý đơn hàng tự động',
    description: 'Khi khách gửi mã đơn hàng, lưu vào biến, kiểm tra trạng thái, tạo nội dung trả lời động bằng textFormat, gửi phản hồi và ghim để theo dõi.',
    category: 'quan-ly',
    tags: ['facebook', 'đơn hàng', 'xử lý', 'biến', 'tự động'],
    icon: <PackageIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Có mã đơn?', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches', right: '#DH[0-9]+' } },
      { id: 'n3', type: 'logic.setVariable', label: 'Lưu mã đơn', position: { x: 300, y: 360 },
        config: { name: 'orderCode', value: '{{ $trigger.content }}' } },
      { id: 'n4', type: 'data.textFormat', label: 'Soạn nội dung xác nhận', position: { x: 300, y: 520 },
        config: { template: '✅ **Xác nhận đã nhận đơn hàng**\n\nMã đơn: {{ $node.n3.output }}\nKhách hàng: {{ $trigger.fromName }}\nThời gian: {{ $now }}\n\n📌 Đơn hàng đang được xử lý. Bạn sẽ nhận thông báo khi có cập nhật!' } },
      { id: 'n5', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Gửi xác nhận', position: { x: 300, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n4.output }}' } },
      { id: 'n7', type: 'fb.action.pin', label: 'Ghim tin nhắn', position: { x: 300, y: 960 },
        config: { ...DEFAULT_CONFIGS['fb.action.pin'], messageId: '{{ $trigger.messageId }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
    ],
  },

  // ━━━━━ FB 13. Gọi HTTP webhook + gửi kết quả ━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-webhook-notify',
    name: 'FB: Webhook + thông báo kết quả',
    description: 'Khi nhận tin, gọi API bên ngoài (webhook CRM), kiểm tra kết quả trả về, rẽ nhánh nếu lỗi/thành công, gửi phản hồi kết quả cho khách.',
    category: 'thong-bao',
    tags: ['facebook', 'webhook', 'API', 'HTTP', 'thông báo'],
    icon: <LinkIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n3', type: 'output.httpRequest', label: 'Gọi CRM API', position: { x: 300, y: 360 },
        config: { method: 'POST', url: 'https://your-crm.com/api/check', headers: 'Content-Type: application/json\nAuthorization: Bearer YOUR_TOKEN', body: '{"phone":"{{ $trigger.fromPhone }}","message":"{{ $trigger.content }}"}', timeout: 10000 } },
      { id: 'n4', type: 'logic.if', label: 'Thành công?', position: { x: 300, y: 520 },
        config: { left: '{{ $node.n3.statusCode }}', operator: 'equals', right: '200' } },
      { id: 'n5', type: 'fb.action.sendMessage', label: 'Thông báo OK', position: { x: 80, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '✅ Đã cập nhật thông tin của bạn vào hệ thống CRM.\nMã tra cứu: {{ $node.n3.body }}' } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Thông báo lỗi', position: { x: 520, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '❌ Rất tiếc, hệ thống đang gặp sự cố. Vui lòng thử lại sau hoặc liên hệ 1900xxxx.' } },
      { id: 'n7', type: 'output.log', label: 'Ghi log webhook', position: { x: 300, y: 840 },
        config: { message: 'Webhook từ {{ $trigger.fromId }} — status: {{ $node.n3.statusCode }} — body: {{ $node.n3.body }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
      { id: 'e5', source: 'n4', sourceHandle: 'false', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n5', target: 'n7' },
    ],
  },

  // ━━━━━ FB 14. Gửi ảnh sản phẩm + chốt đơn ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-image-catalog',
    name: 'FB: Gửi ảnh catalogue + chốt đơn',
    description: 'Khi khách hỏi về sản phẩm, gửi ảnh kèm mô tả, dùng logic rẽ nhánh để hỏi màu sắc/size, gửi ảnh tương ứng, chốt đơn.',
    category: 'ban-hang',
    tags: ['facebook', 'ảnh', 'catalogue', 'bán hàng', 'chốt đơn'],
    icon: <ImageIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Hỏi sản phẩm', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n3', type: 'fb.action.markAsRead', label: 'Đã đọc', position: { x: 300, y: 350 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n4', type: 'logic.switch', label: 'Hỏi sp nào?', position: { x: 300, y: 500 },
        config: { value: '{{ $trigger.content }}', cases: [['áo, áo thun, t-shirt', 'ÁO'], ['quần, jean, trousers', 'QUẦN'], ['phụ kiện, túi, mũ', 'PK']], defaultLabel: 'KHÁC' } },
      { id: 'n5', type: 'fb.action.sendImage', label: 'Gửi ảnh áo', position: { x: 30, y: 670 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendImage'], filePath: '', message: '👕 **Áo thun Unisex**\n• Chất liệu: Cotton 100%\n• Màu: Trắng/Đen/Xanh\n• Giá: 199k\n\nReply "MUA" để đặt hàng!' } },
      { id: 'n6', type: 'fb.action.sendImage', label: 'Gửi ảnh quần', position: { x: 300, y: 670 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendImage'], filePath: '', message: '👖 **Quần Jeans Slim Fit**\n• Chất liệu: Denim cao cấp\n• Size: S/M/L/XL\n• Giá: 349k\n\nReply "MUA" để đặt hàng!' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: 'Gửi phụ kiện', position: { x: 570, y: 670 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🧢 **Phụ kiện hot:**\n• Túi tote: 299k\n• Mũ lưỡi trai: 99k\n• Ví da: 199k\n\nBạn quan tâm món nào ạ?' } },
      { id: 'n8', type: 'fb.action.sendMessage', label: 'Hướng dẫn', position: { x: 300, y: 830 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: 'Xin chào! 👋 Cảm ơn bạn đã quan tâm.\n\n📌 Hiện shop có:\n👕 Áo thun — 199k\n👖 Quần Jeans — 349k\n🧢 Phụ kiện — từ 99k\n\nReply tên sản phẩm để xem ảnh và giá nhé!' } },
      { id: 'n9', type: 'fb.action.addReaction', label: 'Reaction ❤️', position: { x: 300, y: 970 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '❤️' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n4', target: 'n6' },
      { id: 'e6', source: 'n4', target: 'n7' },
      { id: 'e7', source: 'n4', target: 'n8' },
      { id: 'e8', source: 'n8', target: 'n9' },
    ],
  },

  // ━━━━━ FB 15. Forward + Pin + Unpin tự động ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-forward-resolve',
    name: 'FB: Forward xử lý + bỏ ghim tự động',
    description: 'Khi khách báo đã xong, forward tin nhắn vào nhóm xử lý nội bộ, ghim để theo dõi, chờ xác nhận hoàn thành rồi tự động bỏ ghim.',
    category: 'quan-ly',
    tags: ['facebook', 'forward', 'ghim', 'xử lý', 'nội bộ'],
    icon: <RefreshIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Báo "xong" / "done"?', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'xong, done, ok, cảm ơn, giải quyết' } },
      { id: 'n3', type: 'fb.action.unpin', label: 'Bỏ ghim tin nhắn', position: { x: 550, y: 370 },
        config: { ...DEFAULT_CONFIGS['fb.action.unpin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n4', type: 'fb.action.sendMessage', label: 'Cảm ơn + bỏ ghim', position: { x: 550, y: 520 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📌 Đã bỏ ghim. Cảm ơn bạn, mọi vấn đề đã được giải quyết! Nếu cần hỗ trợ thêm, bạn cứ nhắn mình nhé. 😊' } },
      { id: 'n5', type: 'logic.if', label: 'Cần xử lý nội bộ?', position: { x: 50, y: 370 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'cần hỗ trợ, giúp, fix, lỗi, problem' } },
      { id: 'n6', type: 'fb.action.forward', label: 'Forward nội bộ', position: { x: 50, y: 540 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n7', type: 'fb.action.pin', label: 'Ghim để theo dõi', position: { x: 50, y: 700 },
        config: { ...DEFAULT_CONFIGS['fb.action.pin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n8', type: 'fb.action.sendMessage', label: 'Thông báo đã tiếp nhận', position: { x: 50, y: 850 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📩 Yêu cầu của bạn đã được ghi nhận và chuyển đến team hỗ trợ. Chúng tôi sẽ giải quyết trong thời gian sớm nhất!\n\n📌 Tin nhắn đã được ghim để dễ theo dõi.' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: 'false', target: 'n5' },
      { id: 'e5', source: 'n5', sourceHandle: 'true', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n7', target: 'n8' },
    ],
  },

  // ━━━━━ FB 16. AI chăm sóc khách hàng thông minh ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-ai-smart-care',
    name: 'FB: AI chăm sóc khách hàng thông minh',
    description: 'Khi khách nhắn tin, AI phân loại cảm xúc (tích cực/tiêu cực/gấp), đánh dấu đã đọc, rẽ nhánh theo từng trạng thái — phản hồi phù hợp cho từng tình huống. Ghi log để phân tích sau.',
    category: 'ai',
    tags: ['facebook', 'AI', 'cảm xúc', 'sentiment', 'chăm sóc', 'CSKH', 'phân loại'],
    icon: <BrainIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khi nhận tin nhắn', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: 'Đánh dấu đã đọc', position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'ai.classify', label: 'Phân loại cảm xúc', position: { x: 350, y: 360 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], categories: 'tích cực, tiêu cực, cần hỗ trợ gấp, spam', input: '{{ $trigger.content }}' } },
      { id: 'n4', type: 'logic.switch', label: 'Rẽ nhánh theo cảm xúc', position: { x: 350, y: 520 },
        config: { value: '{{ $node.n3.output }}', cases: [['tích cực', 'VUI'], ['tiêu cực', 'BUỒN'], ['cần hỗ trợ gấp', 'GẤP']], defaultLabel: 'SPAM' } },
      { id: 'n5', type: 'fb.action.addReaction', label: 'Reaction 😍', position: { x: 30, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '😍' } },
      { id: 'n6', type: 'fb.action.sendTyping', label: 'Đang gõ... (vui)', position: { x: 30, y: 830 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n7', type: 'fb.action.sendMessage', label: 'Trả lời tích cực', position: { x: 30, y: 960 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🥰 Cảm ơn bạn rất nhiều vì tình cảm! \n\nChúng tôi luôn nỗ lực mang đến trải nghiệm tốt nhất. Bạn cần tụi mình hỗ trợ gì thêm không ạ? ❤️' } },
      { id: 'n8', type: 'fb.action.sendMessage', label: 'Trả lời tiêu cực', position: { x: 350, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '😔 Mình xin lỗi vì trải nghiệm không tốt của bạn. \n\nCho mình biết thêm chi tiết để khắc phục ngay nhé? Hoặc bạn gọi hotline 1900xxxx để được ưu tiên xử lý. Mình sẽ cải thiện ngay!' } },
      { id: 'n9', type: 'fb.action.forward', label: 'Forward gấp cho CSKH', position: { x: 670, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n10', type: 'fb.action.sendMessage', label: 'Đã tiếp nhận gấp', position: { x: 670, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🚨 Yêu cầu của bạn đã được chuyển đến team hỗ trợ khẩn cấp! Chúng tôi sẽ phản hồi trong vòng 5 phút.\n\nVui lòng chờ trong giây lát... ⏳' } },
      { id: 'n11', type: 'output.log', label: 'Ghi log cảm xúc', position: { x: 350, y: 1060 },
        config: { message: '[AI CARE] {{ $trigger.fromName }} ({{ $trigger.fromId }}) — cảm xúc: {{ $node.n3.output }} — nội dung: {{ $trigger.content }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n4', target: 'n8' },
      { id: 'e8', source: 'n4', target: 'n9' },
      { id: 'e9', source: 'n9', target: 'n10' },
      { id: 'e10', source: 'n7', target: 'n11' },
      { id: 'e11', source: 'n8', target: 'n11' },
      { id: 'e12', source: 'n10', target: 'n11' },
    ],
  },

  // ━━━━━ FB 17. AI tạo nội dung quảng cáo bán hàng ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-ai-ad-copy',
    name: 'FB: AI viết nội dung quảng cáo',
    description: 'Khi khách hỏi về sản phẩm, AI tự động soạn nội dung quảng cáo hấp dẫn, kèm emoji và kêu gọi hành động, lưu biến để dùng lại. Phù hợp cho page bán hàng mỹ phẩm, thời trang, F&B.',
    category: 'ai',
    tags: ['facebook', 'AI', 'quảng cáo', 'content', 'marketing', 'bán hàng'],
    icon: '✍️',
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Hỏi về sản phẩm', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Có từ khoá sản phẩm?', position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'áo, quần, giày, túi, mỹ phẩm, đồ ăn, thức uống, combo' } },
      { id: 'n3', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n4', type: 'logic.setVariable', label: 'Lưu câu hỏi gốc', position: { x: 300, y: 510 },
        config: { name: 'userQuery', value: '{{ $trigger.content }}' } },
      { id: 'n5', type: 'ai.generateText', label: 'AI soạn nội dung bán hàng', position: { x: 300, y: 660 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Bạn là chuyên viên tư vấn bán hàng xuất sắc. Khách hàng hỏi: "{{ $node.n4.output }}". Hãy trả lời chuyên nghiệp, hấp dẫn:\n1. Giới thiệu sản phẩm nổi bật\n2. Nêu lợi ích & giá cả\n3. Kèm emoji phù hợp\n4. Kêu gọi hành động (Đặt ngay, Inbox để biết thêm)\nTrả lời bằng tiếng Việt, tự nhiên, thân thiện.' } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Gửi câu trả lời AI', position: { x: 300, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n5.output }}' } },
      { id: 'n7', type: 'fb.action.addReaction', label: 'Reaction 💛', position: { x: 300, y: 960 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '💛' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
    ],
  },

  // ━━━━━ FB 18. AI đề xuất sản phẩm theo sở thích ━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-ai-product-recommend',
    name: 'FB: AI gợi ý sản phẩm theo sở thích',
    description: 'AI phân tích tin nhắn của khách để hiểu sở thích, phân loại danh mục, từ đó gợi ý sản phẩm phù hợp. Có rẽ nhánh theo từng ngành hàng và ghim tin nhắn đề xuất.',
    category: 'ai',
    tags: ['facebook', 'AI', 'gợi ý', 'sản phẩm', 'recommend', 'bán hàng'],
    icon: <TargetIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khách hỏi gợi ý', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: 'Đã đọc', position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 350, y: 350 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n4', type: 'ai.classify', label: 'Phân loại sở thích', position: { x: 350, y: 510 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], categories: 'thời trang nam, thời trang nữ, mỹ phẩm, đồ ăn, đồ uống, công nghệ, khác', input: '{{ $trigger.content }}' } },
      { id: 'n5', type: 'logic.switch', label: 'Chọn danh mục gợi ý', position: { x: 350, y: 670 },
        config: { value: '{{ $node.n4.output }}', cases: [['thời trang nam', 'NAM'], ['thời trang nữ', 'NỮ'], ['mỹ phẩm', 'MỸ PHẨM'], ['đồ ăn', 'ĐỒ ĂN'], ['đồ uống', 'ĐỒ UỐNG'], ['công nghệ', 'CN']], defaultLabel: 'KHÁC' } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Gợi ý thời trang nam', position: { x: 30, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '👔 **Gợi ý cho bạn:**\n\n1️⃣ Áo sơ mi công sở — 299k\n2️⃣ Quần tây cao cấp — 399k\n3️⃣ Giày da lười — 599k\n4️⃣ Đồng hồ thể thao — 499k\n\n🔥 Combo "Dân công sở": Áo + Quần + Giày = 999k (tiết kiệm 298k)\n\n👉 Reply "MUA" để đặt hàng ngay!' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: 'Gợi ý thời trang nữ', position: { x: 210, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '👗 **Gợi ý cho bạn:**\n\n1️⃣ Đầm suông công sở — 399k\n2️⃣ Chân váy bút chì — 299k\n3️⃣ Áo blouse — 249k\n4️⃣ Túi xách thời trang — 499k\n\n🔥 Bộ sưu tập Hè mới nhất — Giảm 20%\n\n👉 Reply "MUA" để xem chi tiết!' } },
      { id: 'n8', type: 'fb.action.sendMessage', label: 'Gợi ý mỹ phẩm', position: { x: 390, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '💄 **Gợi ý làm đẹp:**\n\n1️⃣ Kem chống nắng SPF50+ — 199k\n2️⃣ Serum Vitamin C — 349k\n3️⃣ Son môi lì — 149k\n4️⃣ Set skincare cơ bản — 499k\n\n✨ Tặng kèm mặt nạ khi mua set!\n\n👉 Reply "MUA" để đặt ngay!' } },
      { id: 'n9', type: 'fb.action.sendMessage', label: 'Gợi ý đồ ăn', position: { x: 570, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🍕 **Thực đơn hot hôm nay:**\n\n1️⃣ Burger bò phô mai — 89k\n2️⃣ Mỳ ý sốt bò bằm — 79k\n3️⃣ Pizza hải sản — 159k\n4️⃣ Salad Caesar — 59k\n\n🎁 Combo 2 người: 199k (tiết kiệm 49k)\n\n👉 Reply "ĐẶT" để giao hàng!' } },
      { id: 'n10', type: 'fb.action.sendMessage', label: 'Gợi ý đồ uống', position: { x: 750, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '☕ **Thức uống hot trend:**\n\n1️⃣ Trà sữa trân châu — 39k\n2️⃣ Cà phê muối — 35k\n3️⃣ Matcha latte — 45k\n4️⃣ Nước ép cam — 30k\n\n🎉 Mua 2 tặng 1 (T2-T4 hàng tuần)\n\n👉 Reply "GỌI" để order giao tận nơi!' } },
      { id: 'n11', type: 'fb.action.sendMessage', label: 'Gợi ý công nghệ', position: { x: 350, y: 1000 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📱 **Công nghệ bán chạy:**\n\n1️⃣ Tai nghe Bluetooth — 599k\n2️⃣ Sạc dự phòng 20000mAh — 399k\n3️⃣ Loa mini không dây — 499k\n4️⃣ Chuột gaming — 299k\n\n💥 Flash sale 12h: Giảm thêm 10%\n\n👉 Reply "MUA" để đặt cọc!' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n5', target: 'n7' },
      { id: 'e7', source: 'n5', target: 'n8' },
      { id: 'e8', source: 'n5', target: 'n9' },
      { id: 'e9', source: 'n5', target: 'n10' },
      { id: 'e10', source: 'n5', target: 'n11' },
    ],
  },

  // ━━━━━ FB 19. Xác nhận đơn hàng + gửi link thanh toán ━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-payment-confirm',
    name: 'FB: Xác nhận đơn hàng & gửi link thanh toán',
    description: 'Khi khách xác nhận mua hàng, lưu thông tin đơn hàng vào biến, soạn nội dung xác nhận, gửi tin nhắn kèm link thanh toán, ghim hoá đơn và forward vào nhóm nội bộ.',
    category: 'tich-hop',
    tags: ['facebook', 'thanh toán', 'đơn hàng', 'POS', 'hoá đơn', 'chốt đơn'],
    icon: <CreditCardIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Khách nói "MUA"', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Có ý định mua?', position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'mua, đặt, order, thanh toán, chuyển khoản, mua ngay' } },
      { id: 'n3', type: 'logic.setVariable', label: 'Lưu mã đơn hàng', position: { x: 350, y: 360 },
        config: { name: 'orderId', value: 'DH{{ $now | date:YYYYMMDDHHmmss }}' } },
      { id: 'n4', type: 'data.textFormat', label: 'Soạn nội dung xác nhận', position: { x: 350, y: 520 },
        config: { template: '✅ **XÁC NHẬN ĐƠN HÀNG**\n\n━━━━━━━━━━━━━━━━\n🧾 Mã đơn: {{ $node.n3.output }}\n👤 Khách: {{ $trigger.fromName }}\n📱 ID: {{ $trigger.fromId }}\n📝 Nội dung: {{ $trigger.content }}\n⏰ Thời gian: {{ $now }}\n━━━━━━━━━━━━━━━━\n\n💳 **Vui lòng thanh toán:**\n• Chuyển khoản: 1903xxxxxx\n• Ngân hàng: Techcombank\n• Nội dung: {{ $node.n3.output }}\n• Số tiền: (nhập số tiền)\n\n📸 Reply ảnh biên lai sau khi chuyển khoản!' } },
      { id: 'n5', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 350, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Gửi xác nhận + link TT', position: { x: 350, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n4.output }}' } },
      { id: 'n7', type: 'fb.action.pin', label: 'Ghim hoá đơn', position: { x: 350, y: 960 },
        config: { ...DEFAULT_CONFIGS['fb.action.pin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n8', type: 'output.httpRequest', label: 'Gửi lên POS', position: { x: 350, y: 1100 },
        config: { method: 'POST', url: 'https://your-pos.com/api/orders', headers: 'Content-Type: application/json\nAuthorization: Bearer POS_SECRET', body: '{"orderId":"{{ $node.n3.output }}","customer":"{{ $trigger.fromName }}","customerId":"{{ $trigger.fromId }}","message":"{{ $trigger.content }}","channel":"facebook"}', timeout: 10000 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n7', target: 'n8' },
    ],
  },

  // ━━━━━ FB 20. Bình chọn sản phẩm mới + AI phân tích ━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-poll-ai-analysis',
    name: 'FB: Bình chọn sản phẩm + AI phân tích',
    description: 'Tạo bình chọn trong nhóm Facebook để khảo sát sản phẩm yêu thích, AI tự động phân tích kết quả và gửi báo cáo vào nhóm.',
    category: 'marketing',
    tags: ['facebook', 'bình chọn', 'poll', 'AI', 'phân tích', 'khảo sát', 'nhóm'],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: 'Lịch: 9h sáng thứ 2', position: { x: 350, y: 50 },
        config: { cronExpression: '0 9 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'fb.action.createPoll', label: 'Tạo bình chọn', position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.createPoll'], threadId: '', question: '🌟 Sản phẩm mới nào bạn thích nhất?', options: 'Áo thun họa tiết mới\nQuần jeans rách gối\nSet đồ đôi cặp\nTúi tote da bò\nKhác (comment bên dưới)' } },
      { id: 'n3', type: 'logic.wait', label: 'Chờ 24h', position: { x: 350, y: 360 },
        config: { delaySeconds: 86400 } },
      { id: 'n4', type: 'fb.action.sendMessage', label: 'Nhắc bình chọn lần cuối', position: { x: 350, y: 500 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '⏰ **Còn 2h nữa là kết thúc bình chọn sản phẩm mới!**\n\n👉 Nếu bạn chưa bình chọn, hãy nhanh tay lên nhóm để vote ngay nhé! Kết quả sẽ được công bố vào tối nay. 🎉' } },
      { id: 'n5', type: 'logic.wait', label: 'Chờ thêm 2h', position: { x: 350, y: 640 },
        config: { delaySeconds: 7200 } },
      { id: 'n6', type: 'ai.generateText', label: 'AI phân tích kết quả', position: { x: 350, y: 790 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Bạn là chuyên gia phân tích dữ liệu. Cuộc bình chọn sản phẩm mới trong nhóm Facebook vừa kết thúc. Hãy tạo bài viết công bố kết quả hấp dẫn:\n\n🎉 Chào mừng kết quả\n🥇 Sản phẩm đứng nhất + cảm xúc\n📊 Tổng quan lượt vote\n💬 Lời kêu gọi (cảm ơn, hứa hẹn ra mắt)\n\nTrả lời bằng tiếng Việt, vui vẻ, kèm emoji.' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: 'Công bố kết quả', position: { x: 350, y: 940 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '📊 **KẾT QUẢ BÌNH CHỌN SẢN PHẨM MỚI** 🎉\n\n{{ $node.n6.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
    ],
  },

  // ━━━━━ FB 21. Đặt bàn/lịch hẹn tự động ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-booking-auto',
    name: 'FB: Đặt bàn / lịch hẹn tự động',
    description: 'Khi khách gửi tin nhắn đặt lịch (bàn nhà hàng, lịch hẹn spa, khám bệnh...), AI phân tích thông tin, xác nhận tự động, gửi nhắc lịch sau 1 giờ. Dành cho F&B, spa, phòng khám.',
    category: 'tich-hop',
    tags: ['facebook', 'đặt bàn', 'lịch hẹn', 'F&B', 'spa', 'nhà hàng', 'POS'],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Tin đặt lịch', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Có từ khoá đặt lịch?', position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'đặt bàn, đặt lịch, book, hẹn, reservation, đặt chỗ' } },
      { id: 'n3', type: 'logic.setVariable', label: 'Lưu mã đặt chỗ', position: { x: 350, y: 360 },
        config: { name: 'bookingCode', value: 'BK{{ $now | date:YYYYMMDDHHmmss }}' } },
      { id: 'n4', type: 'data.textFormat', label: 'Soạn xác nhận đặt chỗ', position: { x: 350, y: 520 },
        config: { template: '✅ **XÁC NHẬN ĐẶT CHỖ**\n━━━━━━━━━━━━━━\n📋 Mã đặt chỗ: {{ $node.n3.output }}\n👤 Khách: {{ $trigger.fromName }}\n📝 Yêu cầu: {{ $trigger.content }}\n⏰ Xác nhận lúc: {{ $now }}\n━━━━━━━━━━━━━━\n\n📌 Vui lòng đến trước 15 phút. Liên hệ 1900xxxx nếu cần thay đổi.\n🔔 Chúng tôi sẽ nhắc bạn sau 1 giờ.' } },
      { id: 'n5', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 350, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Gửi xác nhận', position: { x: 350, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n4.output }}' } },
      { id: 'n7', type: 'output.httpRequest', label: 'Ghi lên POS/lịch', position: { x: 350, y: 960 },
        config: { method: 'POST', url: 'https://your-pos.com/api/bookings', headers: 'Content-Type: application/json\nAuthorization: Bearer POS_KEY', body: '{"bookingId":"{{ $node.n3.output }}","customer":"{{ $trigger.fromName }}","customerId":"{{ $trigger.fromId }}","request":"{{ $trigger.content }}","channel":"facebook"}', timeout: 10000 } },
      { id: 'n8', type: 'logic.wait', label: 'Chờ 1 giờ nhắc lịch', position: { x: 350, y: 1100 },
        config: { delaySeconds: 3600 } },
      { id: 'n9', type: 'fb.action.sendMessage', label: 'Nhắc lịch hẹn', position: { x: 350, y: 1240 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '⏰ **NHẮC LỊCH HẸN**\n\nXin chào {{ $trigger.fromName }}! 👋\n\nĐây là lời nhắc từ chúng tôi về lịch hẹn của bạn:\n📋 Mã: {{ $node.n3.output }}\n📝 Nội dung: {{ $trigger.content }}\n\n🚗 Nếu bạn cần thay đổi hoặc huỷ, vui lòng reply tin nhắn này hoặc gọi 1900xxxx trước 30 phút.\n\nHân hạnh phục vụ bạn! ❤️' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n7', target: 'n8' },
      { id: 'e8', source: 'n8', target: 'n9' },
    ],
  },

  // ━━━━━ FB 22. Gửi mã giảm giá + theo dõi đơn ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-discount-track',
    name: 'FB: Gửi mã giảm giá & theo dõi đơn hàng',
    description: 'Khi khách yêu cầu mã giảm giá, chọn ngẫu nhiên từ danh sách ưu đãi, lưu mã vào biến, gửi kèm hướng dẫn sử dụng. Tích hợp webhook POS để ghi nhận lượt phát mã.',
    category: 'ban-hang',
    tags: ['facebook', 'mã giảm giá', 'khuyến mãi', 'ưu đãi', 'theo dõi', 'POS'],
    icon: <GiftIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: 'Hỏi mã giảm giá', position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: 'Yêu cầu mã giảm?', position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'matches_any', right: 'giảm giá, mã giảm, voucher, coupon, khuyến mãi, ưu đãi, sale, discount' } },
      { id: 'n3', type: 'data.randomPick', label: 'Chọn mã giảm ngẫu nhiên', position: { x: 350, y: 360 },
        config: { options: 'SALE15 — Giảm 15% đơn từ 500k\nSALE20 — Giảm 20% đơn từ 1tr\nFREESHIP — Miễn phí vận chuyển\nWELCOME10 — Giảm 10k cho khách mới\nCOMBO30 — Giảm 30k set combo' } },
      { id: 'n4', type: 'logic.setVariable', label: 'Lưu mã đã gửi', position: { x: 350, y: 510 },
        config: { name: 'sentVoucher', value: '{{ $node.n3.output }}' } },
      { id: 'n5', type: 'fb.action.sendTyping', label: 'Đang gõ...', position: { x: 350, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: 'Gửi mã giảm giá', position: { x: 350, y: 800 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '🎉 **MÃ GIẢM GIÁ ĐẶC BIỆT DÀNH CHO BẠN!**\n\n━━━━━━━━━━━━━━━━\n🔖 Mã: **{{ $node.n4.output }}**\n━━━━━━━━━━━━━━━━\n\n📌 **Hướng dẫn:**\n1️⃣ Nhắn "MUA" để chọn sản phẩm\n2️⃣ Nhập mã ở phần ghi chú đơn hàng\n3️⃣ Hoặc gửi lại mã này khi thanh toán\n\n⏳ Mã có hiệu lực đến hết tháng này!\n👉 Nhanh tay kẻo lỡ ưu đãi bạn nhé! 🔥' } },
      { id: 'n7', type: 'output.httpRequest', label: 'Ghi nhận lên POS', position: { x: 350, y: 950 },
        config: { method: 'POST', url: 'https://your-pos.com/api/vouchers/claim', headers: 'Content-Type: application/json\nAuthorization: Bearer POS_KEY', body: '{"voucher":"{{ $node.n4.output }}","customerId":"{{ $trigger.fromId }}","customerName":"{{ $trigger.fromName }}","channel":"facebook"}', timeout: 10000 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
    ],
  },

  // 14. Webhook có tài khoản → Gửi tin nhắn Zalo
  {
    id: 'tpl-webhook-account-send',
    name: 'Webhook có tài khoản → Gửi tin nhắn Zalo',
    description: 'Nhận webhook với threadId (người nhận), message (nội dung) và accountId (tài khoản Zalo gửi). Validate params trước khi gửi, nếu thiếu sẽ báo lỗi.',
    category: 'webhook',
    tags: ['webhook', 'API', 'tích hợp', 'gửi tin', 'tài khoản'],
    icon: <SendIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.webhook', label: 'Webhook bên ngoài', position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.webhook'] } },
      { id: 'n2', type: 'logic.if', label: 'Có đủ params không?', position: { x: 300, y: 220 },
        config: { left: '{{ $trigger.body.threadId }}', operator: 'equals', right: '' } },
      { id: 'n3', type: 'zalo.sendMessage', label: 'Gửi tin nhắn', position: { x: 150, y: 400 },
        config: { threadId: '{{ $trigger.body.threadId }}', threadType: '0', message: '{{ $trigger.body.message }}' } },
      { id: 'n4', type: 'output.log', label: 'Ghi log thành công', position: { x: 150, y: 570 },
        config: { message: 'Đã gửi tin qua acc đến threadId: {{ $trigger.body.threadId }}, nội dung: {{ $trigger.body.message }}', level: 'info' } },
      { id: 'n5', type: 'output.log', label: 'Ghi log lỗi', position: { x: 500, y: 400 },
        config: { message: 'Webhook thiếu params: threadId={{ $trigger.body.threadId }}', level: 'error' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'false', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: 'true', target: 'n5' },
    ],
  },
];

