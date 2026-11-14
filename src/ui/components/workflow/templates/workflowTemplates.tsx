import React from 'react';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIGS } from '../nodes/workflowConfig';
import { Channel } from '../../../../configs/channels/channelConfig';
import { AwardIcon, BellIcon, BookIcon, BookmarkIcon, BotIcon, BrainIcon, CalendarIcon, ChartIcon, ChatIcon, CheckIcon, ClipboardListIcon, ClockIcon, CreditCardIcon, CrownIcon, DollarIcon, EditIcon, FileTextIcon, GiftIcon, HardDriveIcon, HomeIcon, ImageIcon, InboxIcon, KeyIcon, LightningIcon, LinkIcon, MaximizeIcon, MegaphoneIcon, MinimizeIcon, PackageIcon, PinIcon, PluginIcon, RefreshIcon, RocketIcon, SendIcon, SettingsIcon, ShieldIcon, ShoppingCartIcon, ShuffleIcon, SmartphoneIcon, StarIcon, TagIcon, TargetIcon, TrendingUpIcon, TruckIcon, UserCheckIcon, UserIcon, UsersIcon, WaveIcon, WifiIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';


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
  /** Telegram Bot inline-button route (dashed); generated on install from the keyboard, templates do not list them. */
  data?: { telegramInline?: boolean };
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  icon: string | React.ReactNode;
  difficulty: 'easy' | 'medium' | 'advanced';
  channel?: Channel;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
}

export type TemplateCategory =
  | 'ban-hang'       // Sales & customer care
  | 'quan-ly'        // Management & Operations
  | 'marketing'      // Marketing & Promotion
  | 'thong-bao'      // Notifications & Integrations
  | 'ai'             // AI & Smart
  | 'nang-cao'       // Advanced
  | 'tich-hop'
  | 'webhook';      // POS & Payment integrations

export const TEMPLATE_CATEGORIES: { key: TemplateCategory; label: string; icon: React.ReactNode; color: string }[] = [
  { key: 'ban-hang',   label: tr('Bán hàng & CSKH'),           icon: <ShoppingCartIcon className="w-4 h-4" />, color: 'bg-blue-500' },
  { key: 'quan-ly',    label: tr('Quản lý & Vận hành'),         icon: <ClipboardListIcon className="w-4 h-4" />, color: 'bg-amber-500' },
  { key: 'marketing',  label: tr('Marketing & Tiếp thị'),       icon: <MegaphoneIcon className="w-4 h-4" />, color: 'bg-pink-500' },
  { key: 'thong-bao',  label: tr('Thông báo & Tích hợp'),       icon: <BellIcon className="w-4 h-4" />, color: 'bg-green-500' },
  { key: 'ai',         label: tr('AI & Thông minh'),             icon: <BotIcon className="w-4 h-4" />, color: 'bg-violet-500' },
  { key: 'nang-cao',   label: tr('Nâng cao'),                    icon: <SettingsIcon className="w-4 h-4" />, color: 'bg-rose-500' },
  { key: 'tich-hop',   label: tr('Tích hợp POS & Thanh toán'),  icon: <PluginIcon className="w-4 h-4" />, color: 'bg-teal-600' },
  { key: 'webhook',    label: tr('Webhooks'),                    icon: <LinkIcon className="w-4 h-4" />, color: 'bg-cyan-600' },
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

/** Deep-remap all string values (nested arrays stay arrays: Telegram Bot keyboard rows are arrays of arrays). */
function remapValue(val: any, idMap: Record<string, string>): any {
  if (typeof val === 'string') return remapNodeRefs(val, idMap);
  if (Array.isArray(val)) return val.map(item => remapValue(item, idMap));
  if (val && typeof val === 'object') {
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(val)) result[key] = remapValue(item, idMap);
    return result;
  }
  return val;
}

function remapConfigRefs(config: Record<string, any>, idMap: Record<string, string>): Record<string, any> {
  return remapValue(config || {}, idMap);
}

/**
 * Telegram Bot inline buttons of a sendMessage node: point at the new node ids, and get button ids unique to this install
 * (a button press is routed by its id; two workflows installed from one template must not share them).
 */
function remapKeyboard(config: Record<string, any>, idMap: Record<string, string>): Record<string, any> {
  const keyboard = config?.keyboard;
  if (!keyboard || typeof keyboard !== 'object' || !Array.isArray(keyboard.rows)) return config;
  const rows = keyboard.rows.map((row: any) => (Array.isArray(row) ? row : [row]).map((button: any) => {
    if (!button || typeof button !== 'object') return button;
    const next = { ...button, id: `btn_${uuidv4().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}` };
    if (next.targetNodeId) next.targetNodeId = idMap[next.targetNodeId] || next.targetNodeId;
    return next;
  }));
  return { ...config, keyboard: { ...keyboard, rows } };
}

/** Inline "go to node" buttons as dashed route edges (drawn the same way by the editor and the AI copilot). */
function inlineRouteEdges(nodes: TemplateNode[]): TemplateEdge[] {
  const ids = new Set(nodes.map(n => n.id));
  const edges: TemplateEdge[] = [];
  for (const node of nodes) {
    const keyboard = node.config?.keyboard;
    if (node.type !== 'tgbot.action.sendMessage' || !keyboard?.enabled || keyboard.type !== 'inline' || !Array.isArray(keyboard.rows)) continue;
    const targets = new Set<string>(keyboard.rows.flat()
      .filter((button: any) => button && (button.action || 'node') === 'node' && button.targetNodeId)
      .map((button: any) => String(button.targetNodeId)));
    for (const target of targets) {
      if (target === node.id || !ids.has(target)) continue;
      edges.push({ id: `telegram-inline:${node.id}:${target}`, source: node.id, sourceHandle: 'default', target, data: { telegramInline: true } });
    }
  }
  return edges;
}

export function instantiateTemplate(tpl: WorkflowTemplate): {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
} {
  const idMap: Record<string, string> = {};
  tpl.nodes.forEach(n => { idMap[n.id] = uuidv4(); });

  const nodes = tpl.nodes.map(n => {
    const config = remapConfigRefs(n.config, idMap);
    return {
      ...n,
      id: idMap[n.id],
      config: n.type === 'tgbot.action.sendMessage' ? remapKeyboard(config, idMap) : config,
    };
  });

  const edges: TemplateEdge[] = tpl.edges
    .filter(e => !e.data?.telegramInline)
    .map(e => ({
      id: uuidv4(),
      source: idMap[e.source] || e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: idMap[e.target] || e.target,
    }));

  return { nodes, edges: [...edges, ...inlineRouteEdges(nodes)] };
}

// ── Templates ──────────────────────────────────────────────────────────────────

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ━━━━━ 1. Auto-reply to messages ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-auto-reply-basic',
    name: tr('Tự động trả lời tin nhắn'),
    description: tr('Khi nhận tin nhắn mới, tự động gửi lại một câu trả lời cố định. Phù hợp làm thông báo "đã nhận tin" hoặc giới thiệu nhanh.'),
    category: 'ban-hang',
    tags: [tr('trả lời'), tr('tự động'), tr('tin nhắn'), tr('cơ bản')],
    icon: <ChatIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 250, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'zalo.sendTyping', label: tr('Hiệu ứng đang gõ'), position: { x: 250, y: 220 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('Gửi câu trả lời'), position: { x: 250, y: 360 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('Cảm ơn bạn đã nhắn tin! Mình sẽ phản hồi trong thời gian sớm nhất 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 2. Reply by keyword ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-keyword-reply',
    name: tr('Trả lời theo từ khoá'),
    description: tr('Phân nhánh theo nội dung tin nhắn: nếu chứa "giá" → gửi bảng giá, nếu chứa "địa chỉ" → gửi vị trí, còn lại → trả lời mặc định.'),
    category: 'ban-hang',
    tags: [tr('từ khoá'), tr('rẽ nhánh'), tr('bảng giá'), 'CSKH'],
    icon: <KeyIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có chứa "giá"?'), position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('giá') } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('Gửi bảng giá'), position: { x: 100, y: 380 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('📋 Bảng giá sản phẩm:\n\n• Gói A: 199k/tháng\n• Gói B: 399k/tháng\n• Gói C: 799k/tháng\n\nBạn quan tâm gói nào ạ?') } },
      { id: 'n4', type: 'logic.if', label: tr('Có chứa "địa chỉ"?'), position: { x: 600, y: 380 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('địa chỉ') } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Gửi địa chỉ'), position: { x: 400, y: 560 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('📍 Địa chỉ cửa hàng:\n123 Nguyễn Huệ, Q.1, TP.HCM\n\n⏰ Giờ mở cửa: 8h - 21h hàng ngày') } },
      { id: 'n6', type: 'zalo.sendMessage', label: tr('Trả lời mặc định'), position: { x: 750, y: 560 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('Cảm ơn bạn đã liên hệ! Nhắn "giá" để xem bảng giá, hoặc "địa chỉ" để biết nơi mua hàng nhé 😊') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'false', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
      { id: 'e5', source: 'n4', sourceHandle: 'false', target: 'n6' },
    ],
  },

  // ━━━━━ 3. Accept friend request + welcome ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-auto-accept-friend',
    name: tr('Tự động chấp nhận kết bạn & chào mừng'),
    description: tr('Tự động chấp nhận lời mời kết bạn, chờ 2 giây rồi gửi tin nhắn chào mừng. Tăng tốc tiếp cận khách hàng mới.'),
    category: 'ban-hang',
    tags: [tr('kết bạn'), tr('chào mừng'), tr('tự động')],
    icon: <UserCheckIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: tr('Khi có lời mời kết bạn'), position: { x: 250, y: 80 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: tr('Chấp nhận kết bạn'), position: { x: 250, y: 230 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'logic.wait', label: tr('Chờ 2 giây'), position: { x: 250, y: 370 },
        config: { delaySeconds: 2 } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi lời chào'), position: { x: 250, y: 510 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: tr('Xin chào! 👋 Cảm ơn bạn đã kết bạn.\n\nMình có thể giúp gì cho bạn ạ?') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 4. Forward important messages to Telegram ━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-forward-telegram',
    name: tr('Chuyển tiếp tin nhắn → Telegram'),
    description: tr('Nhận tin nhắn từ Zalo, lọc theo từ khoá quan trọng ("gấp", "khiếu nại"...) rồi forward sang Telegram Bot để đội ngũ xử lý ngay.'),
    category: 'thong-bao',
    tags: ['telegram', tr('chuyển tiếp'), tr('thông báo'), tr('khẩn cấp')],
    icon: <SmartphoneIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'gấp,khẩn,khiếu nại', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn nội dung thông báo'), position: { x: 300, y: 220 },
        config: { template: tr('🚨 *TIN NHẮN QUAN TRỌNG*\n\n👤 Từ: {{ $trigger.fromName }}\n💬 Nội dung: {{ $trigger.content }}\n⏰ Lúc: {{ $trigger.timestamp }}') } },
      { id: 'n3', type: 'notify.telegram', label: tr('Gửi qua Telegram'), position: { x: 300, y: 380 },
        config: { botToken: '', chatId: '', message: '{{ $node.n2.output }}' } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log'), position: { x: 300, y: 530 },
        config: { message: tr('Đã forward tin nhắn quan trọng từ {{ $trigger.fromName }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 5. AI answers sales advice ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-sales-advisor',
    name: tr('AI tư vấn bán hàng tự động'),
    description: tr('Dùng AI (ChatGPT/Gemini/Deepseek) để tự động trả lời tư vấn sản phẩm. AI sẽ trả lời chuyên nghiệp, tự nhiên theo prompt bạn cài đặt.'),
    category: 'ai',
    tags: ['AI', 'ChatGPT', tr('tư vấn'), tr('bán hàng')],
    icon: <BotIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'logic.stopIf', label: tr('Bỏ qua nếu rỗng'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'equals', right: '' } },
      { id: 'n3', type: 'zalo.sendTyping', label: tr('Hiệu ứng đang gõ'), position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 3 } },
      { id: 'n4', type: 'ai.generateText', label: tr('AI tạo câu trả lời'), position: { x: 300, y: 480 },
        config: {
          aiConfigMode: 'assistant', assistantId: '',
          prompt: 'Bạn là trợ lý tư vấn bán hàng chuyên nghiệp, thân thiện. Trả lời ngắn gọn, đúng trọng tâm. Nếu không biết, hãy nói sẽ chuyển cho nhân viên hỗ trợ.\n\nTin nhắn của khách: {{ $trigger.content }}',
        } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Gửi câu trả lời AI'), position: { x: 300, y: 630 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n4.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 6. AI classifies messages + applies labels ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-classify-label',
    name: tr('AI phân loại & tự động gắn nhãn'),
    description: tr('AI phân loại tin nhắn vào các danh mục (hỏi giá, đặt hàng, khiếu nại...) rồi tự động gắn nhãn tương ứng cho hội thoại. Giúp quản lý khách hàng hiệu quả.'),
    category: 'ai',
    tags: ['AI', tr('phân loại'), tr('nhãn'), 'CRM'],
    icon: <TagIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'ai.classify', label: tr('AI phân loại tin nhắn'), position: { x: 300, y: 200 },
        config: {
          aiConfigMode: 'assistant', assistantId: '',
          categories: [tr('hỏi giá'), tr('đặt hàng'), tr('khiếu nại'), tr('hỗ trợ kỹ thuật'), tr('khác')].join(', '),
          input: '{{ $trigger.content }}',
        } },
      { id: 'n3', type: 'logic.switch', label: tr('Phân nhánh theo loại'), position: { x: 300, y: 370 },
        config: {
          value: '{{ $node.n2.category }}',
          cases: [{ match: tr('hỏi giá'), label: tr('hỏi giá') }, { match: tr('đặt hàng'), label: tr('đặt hàng') }, { match: tr('khiếu nại'), label: tr('khiếu nại') }],
          defaultLabel: tr('khác'),
        } },
      { id: 'n4', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Hỏi giá"'), position: { x: 0, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n5', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Đặt hàng"'), position: { x: 250, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n6', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Khiếu nại"'), position: { x: 500, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n7', type: 'output.log', label: tr('Log kết quả'), position: { x: 300, y: 720 },
        config: { message: tr('Phân loại: {{ $node.n2.output }} — Từ: {{ $trigger.fromName }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: tr('hỏi giá'), target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: tr('đặt hàng'), target: 'n5' },
      { id: 'e5', source: 'n3', sourceHandle: tr('khiếu nại'), target: 'n6' },
      { id: 'e6', source: 'n4', target: 'n7' },
      { id: 'e7', source: 'n5', target: 'n7' },
      { id: 'e8', source: 'n6', target: 'n7' },
    ],
  },

  // ━━━━━ 7. Log orders to Google Sheets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-order-to-sheets',
    name: tr('Ghi đơn hàng vào Google Sheets'),
    description: tr('Khi nhận tin nhắn chứa "đặt hàng", tự động lấy thông tin người gửi và ghi vào Google Sheets. Quản lý đơn hàng không cần thao tác tay.'),
    category: 'quan-ly',
    tags: ['Google Sheets', tr('đơn hàng'), 'CRM', tr('quản lý')],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận "đặt hàng"'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'đặt hàng,mua hàng,đặt mua,order', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.getUserInfo', label: tr('Lấy thông tin KH'), position: { x: 300, y: 200 },
        config: { userId: '{{ $trigger.fromId }}' } },
      { id: 'n3', type: 'data.textFormat', label: tr('Chuẩn bị dữ liệu'), position: { x: 300, y: 350 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.content }}\t{{ $trigger.timestamp }}' } },
      { id: 'n4', type: 'sheets.appendRow', label: tr('Ghi vào Google Sheets'), position: { x: 300, y: 500 },
        config: { spreadsheetId: '', sheetName: tr('Đơn hàng'), values: '{{ $node.n3.output }}', serviceAccountPath: '' } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Xác nhận đơn hàng'), position: { x: 300, y: 650 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('✅ Đã nhận đơn hàng của bạn!\n\nMình sẽ xác nhận và liên hệ lại trong 15 phút nhé. Cảm ơn bạn! 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 8. Daily reminders via group ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-daily-reminder',
    name: tr('Gửi nhắc nhở hàng ngày trong nhóm'),
    description: tr('Chạy tự động theo lịch (VD: 8h sáng mỗi ngày), gửi tin nhắn nhắc nhở vào nhóm Zalo. Dùng cho checkin, nhắc họp, nhắc deadline...'),
    category: 'quan-ly',
    tags: [tr('lịch hẹn'), tr('nhóm'), tr('nhắc nhở'), tr('hàng ngày')],
    icon: <ClockIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Mỗi ngày lúc 8h sáng'), position: { x: 300, y: 80 },
        config: { cronExpression: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.dateFormat', label: tr('Lấy ngày hôm nay'), position: { x: 300, y: 230 },
        config: { format: 'date' } },
      { id: 'n3', type: 'data.textFormat', label: tr('Soạn nội dung'), position: { x: 300, y: 380 },
        config: { template: tr('🌅 Chào buổi sáng!\n\n📅 Hôm nay {{ $node.n2.output }}\n\n📋 Nhắc nhở:\n• Kiểm tra tin nhắn mới\n• Cập nhật tiến độ công việc\n• Báo cáo cuối ngày\n\nChúc mọi người một ngày làm việc hiệu quả! 💪') } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi vào nhóm'), position: { x: 300, y: 530 },
        config: { threadId: '', threadType: '2', message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 9. Auto react + thank you when a heart is reacted ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-reaction-thanks',
    name: tr('Tự động cảm ơn khi được react'),
    description: tr('Khi ai đó react (thả cảm xúc) tin nhắn của bạn, tự động gửi lời cảm ơn. Tạo ấn tượng tốt, tăng tương tác.'),
    category: 'marketing',
    tags: ['react', tr('cảm xúc'), tr('tương tác'), tr('cảm ơn')],
    icon: '❤️',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.reaction', label: tr('Khi có người react'), position: { x: 300, y: 80 },
        config: { reactionType: 'any', threadId: '' } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 1 giây'), position: { x: 300, y: 230 },
        config: { delaySeconds: 1 } },
      { id: 'n3', type: 'data.randomPick', label: tr('Chọn ngẫu nhiên câu cảm ơn'), position: { x: 300, y: 370 },
        config: { options: tr('Cảm ơn bạn nhé! 😊\nThank you! 🙏\nVui quá, cảm ơn bạn! ❤️\nHehe cảm ơn nha! 😄\nCảm ơn bạn đã quan tâm! 🌟') } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi lời cảm ơn'), position: { x: 300, y: 510 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 10. New group member → greeting + label ━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-group-welcome',
    name: tr('Chào thành viên mới vào nhóm'),
    description: tr('Khi có thành viên mới tham gia nhóm Zalo, tự động gửi tin nhắn chào mừng ngay trong nhóm.'),
    category: 'quan-ly',
    tags: [tr('nhóm'), tr('chào mừng'), tr('thành viên')],
    icon: <StarIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.groupEvent', label: tr('Thành viên vào nhóm'), position: { x: 300, y: 80 },
        config: { groupId: '', eventType: 'join' } },
      { id: 'n2', type: 'zalo.sendMessage', label: tr('Gửi lời chào nhóm'), position: { x: 300, y: 250 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '1', message: tr('🎉 Chào mừng {{ $trigger.memberNames }} đã gia nhập nhóm!\n\nHãy giới thiệu bản thân và đọc nội quy nhóm nhé 😊') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ 11. Bulk send to a list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-bulk-message-sheets',
    name: tr('Gửi tin nhắn hàng loạt cho khách'),
    description: tr('Chọn nhóm khách (theo Nhãn Local) rồi gửi một tin nhắn chung cho tất cả. Hệ thống tự giãn cách giữa các tin để tránh bị khoá tài khoản.'),
    category: 'marketing',
    tags: [tr('hàng loạt'), tr('nhãn'), 'marketing', tr('khách hàng')],
    icon: <SendIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: tr('Chạy thủ công'), position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'logic.forEachContact', label: tr('Chọn nhóm khách'), position: { x: 300, y: 200 },
        config: { source: 'labels', labelIds: [], limit: 500 } },
      { id: 'n3', type: 'data.textFormat', label: tr('Soạn nội dung'), position: { x: 300, y: 360 },
        config: { template: tr('Xin chào! 👋\n\n🎁 Chúng tôi có chương trình ưu đãi đặc biệt dành riêng cho bạn. Nhắn "ưu đãi" để biết thêm chi tiết nhé!') } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi tin nhắn'), position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n3.output }}', threadIdsExpr: '{{ $node.n2.result }}', sendDelayMinSeconds: 5, sendDelayMaxSeconds: 8 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 12. Apply a label when a specific keyword is received ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-keyword-label',
    name: tr('Gán nhãn theo từ khoá tin nhắn'),
    description: tr('Tự động gắn nhãn cho hội thoại dựa trên nội dung tin nhắn. VD: chứa "giá" → gắn nhãn "Quan tâm giá", chứa "lỗi" → gắn nhãn "Cần hỗ trợ".'),
    category: 'quan-ly',
    tags: [tr('nhãn'), tr('từ khoá'), tr('phân loại'), 'CRM'],
    icon: <TagIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Chứa "giá" hoặc "bao nhiêu"?'), position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('giá') } },
      { id: 'n3', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Quan tâm giá"'), position: { x: 100, y: 380 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n4', type: 'logic.if', label: tr('Chứa "lỗi" hoặc "hỗ trợ"?'), position: { x: 550, y: 380 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('lỗi') } },
      { id: 'n5', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Cần hỗ trợ"'), position: { x: 550, y: 550 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'false', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
    ],
  },

  // ━━━━━ 13. Multi-channel: Zalo → Discord + Email ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-multi-channel-notify',
    name: tr('Thông báo đa kênh (Discord + Email)'),
    description: tr('Nhận tin nhắn quan trọng trên Zalo, đồng thời gửi thông báo vào Discord Webhook và Email để không bỏ lỡ bất kỳ yêu cầu nào.'),
    category: 'thong-bao',
    tags: ['discord', 'email', tr('đa kênh'), 'webhook'],
    icon: <BellIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn nội dung'), position: { x: 300, y: 200 },
        config: { template: tr('📩 Tin nhắn mới từ {{ $trigger.fromName }}:\n{{ $trigger.content }}') } },
      { id: 'n3', type: 'notify.discord', label: tr('Gửi vào Discord'), position: { x: 100, y: 380 },
        config: { webhookUrl: '', message: '{{ $node.n2.output }}', username: 'Zalo Bot' } },
      { id: 'n4', type: 'notify.email', label: tr('Gửi Email thông báo'), position: { x: 500, y: 380 },
        config: { ...DEFAULT_CONFIGS['notify.email'], subject: tr('Tin nhắn mới từ {{ $trigger.fromName }}'), body: '{{ $node.n2.output }}' } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Phản hồi khách'), position: { x: 300, y: 560 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('Cảm ơn bạn! Mình đã nhận tin và sẽ phản hồi sớm nhất 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
      { id: 'e4', source: 'n2', target: 'n5' },
    ],
  },

  // ━━━━━ 14. Call external API/Webhook ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-webhook-integration',
    name: tr('Gọi Webhook / API khi nhận tin'),
    description: tr('Khi nhận tin nhắn, tự động gọi API/Webhook bên ngoài (CRM, ERP...) để đồng bộ dữ liệu. Rồi trả kết quả về cho khách.'),
    category: 'nang-cao',
    tags: ['API', 'webhook', tr('tích hợp'), 'HTTP'],
    icon: <LinkIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'data.textFormat', label: tr('Tạo request body'), position: { x: 300, y: 200 },
        config: { template: '{"from": "{{ $trigger.fromName }}", "message": "{{ $trigger.content }}", "threadId": "{{ $trigger.threadId }}"}' } },
      { id: 'n3', type: 'output.httpRequest', label: tr('Gọi API bên ngoài'), position: { x: 300, y: 370 },
        config: { method: 'POST', url: 'https://your-api.com/webhook', headers: '{"Content-Type": "application/json"}', body: '{{ $node.n2.output }}', timeout: 10000 } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log kết quả'), position: { x: 300, y: 530 },
        config: { message: 'API response: {{ $node.n3.output }}', level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 15. Log new customer info to Notion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-notion-crm',
    name: tr('Lưu khách hàng mới vào Notion'),
    description: tr('Khi chấp nhận lời mời kết bạn, tự động lấy thông tin và tạo trang mới trong Notion Database. Biến Notion thành CRM đơn giản.'),
    category: 'thong-bao',
    tags: ['Notion', 'CRM', tr('kết bạn'), 'database'],
    icon: <EditIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: tr('Khi có lời mời kết bạn'), position: { x: 300, y: 60 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: tr('Chấp nhận kết bạn'), position: { x: 300, y: 210 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'zalo.getUserInfo', label: tr('Lấy thông tin'), position: { x: 300, y: 360 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n4', type: 'notify.notion', label: tr('Ghi vào Notion'), position: { x: 300, y: 510 },
        config: {
          apiKey: '', databaseId: '',
          properties: tr('{"Tên": {"title": [{"text": {"content": "{{ $trigger.displayName }}"}}]}, "Nguồn": {"select": {"name": "Zalo"}}, "Ngày": {"date": {"start": "{{ $date.now }}"}}}'),
        } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Chào khách'), position: { x: 300, y: 660 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: tr('Chào bạn! 👋 Cảm ơn đã kết bạn. Mình có thể giúp gì cho bạn?') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 16. After-hours customer care ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-off-hours-reply',
    name: tr('Trả lời tự động ngoài giờ làm việc'),
    description: tr('Tự động nhận diện tin nhắn ngoài giờ hành chính (sau 18h hoặc cuối tuần) rồi gửi tin nhắn thông báo sẽ phản hồi vào ngày làm việc tiếp theo.'),
    category: 'ban-hang',
    tags: [tr('ngoài giờ'), 'CSKH', tr('tự động'), tr('thời gian')],
    icon: <MinimizeIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'data.dateFormat', label: tr('Lấy giờ hiện tại'), position: { x: 300, y: 200 },
        config: { format: 'time' } },
      { id: 'n3', type: 'logic.if', label: tr('Ngoài giờ làm việc?'), position: { x: 300, y: 350 },
        config: { left: '{{ $node.n2.output }}', operator: 'greater_than', right: '18:00' } },
      { id: 'n4', type: 'zalo.sendTyping', label: tr('Hiệu ứng đang gõ'), position: { x: 100, y: 520 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Thông báo ngoài giờ'), position: { x: 100, y: 670 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('🌙 Xin chào! Hiện tại đã ngoài giờ làm việc.\n\n⏰ Giờ hỗ trợ: 8h - 18h (T2 - T7)\n\nMình sẽ phản hồi bạn sớm nhất vào ngày làm việc tiếp theo nhé! 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  ADD NEW TEMPLATES: time-based care, follow-up, nurturing
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ━━━━━ 17. Label "Đã mua" (bought) → care after 2 days ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-post-purchase-care',
    name: tr('Chăm sóc sau mua hàng (2 ngày)'),
    description: tr('Khi gắn nhãn "Đã mua hàng" cho khách, tự động chờ 2 ngày rồi gửi tin nhắn hỏi thăm trải nghiệm sản phẩm. Tăng hài lòng & giữ chân khách.'),
    category: 'ban-hang',
    tags: [tr('chăm sóc'), tr('sau mua hàng'), tr('nhãn'), 'follow-up', 'nurturing'],
    icon: <GiftIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: tr('Khi gắn nhãn "Đã mua"'), position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 2 ngày (172800s)'), position: { x: 300, y: 210 },
        config: { delaySeconds: 172800 } },
      { id: 'n3', type: 'zalo.sendTyping', label: tr('Hiệu ứng đang gõ'), position: { x: 300, y: 350 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2, threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi tin hỏi thăm'), position: { x: 300, y: 490 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('Xin chào! 😊\n\nMình muốn hỏi thăm bạn đã nhận được hàng chưa ạ? Sản phẩm dùng có ổn không?\n\nNếu cần hỗ trợ gì, cứ nhắn mình nhé! 🙏') } },
      { id: 'n5', type: 'output.log', label: tr('Ghi log'), position: { x: 300, y: 630 },
        config: { message: tr('Đã gửi tin chăm sóc sau mua cho thread {{ $trigger.threadId }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 18. Follow up customers who have not replied after 4 hours ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-followup-4h',
    name: tr('Follow-up sau 4 giờ chưa phản hồi'),
    description: tr('Khi gắn nhãn "Chờ phản hồi", hệ thống sẽ chờ 4 giờ rồi tự động gửi tin nhắn nhắc nhở nhẹ nhàng. Không để mất khách vì quên trả lời.'),
    category: 'ban-hang',
    tags: ['follow-up', tr('nhắc nhở'), tr('nhãn'), tr('chờ phản hồi'), tr('4 giờ')],
    icon: '⏳',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: tr('Khi gắn nhãn "Chờ phản hồi"'), position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 4 giờ (14400s)'), position: { x: 300, y: 210 },
        config: { delaySeconds: 14400 } },
      { id: 'n3', type: 'data.randomPick', label: tr('Chọn ngẫu nhiên câu nhắc'), position: { x: 300, y: 360 },
        config: { options: tr('Chào bạn! Mình gửi tin nhắn trước đó, không biết bạn đã xem chưa ạ? 😊\nHi bạn! Mình muốn hỏi thăm, bạn có cần tư vấn thêm không ạ? 🙏\nXin chào! Mình vẫn sẵn sàng hỗ trợ bạn nếu cần nhé! 💪\nBạn ơi, mình có thông tin muốn chia sẻ thêm. Bạn có rảnh không ạ? 😄') } },
      { id: 'n4', type: 'zalo.sendTyping', label: tr('Hiệu ứng đang gõ'), position: { x: 300, y: 500 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2, threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Gửi tin follow-up'), position: { x: 300, y: 640 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 19. 3-step care sequence: 1h → 1 day → 3 days ━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-nurture-sequence-3step',
    name: tr('Chuỗi chăm sóc 3 bước (1h → 1 ngày → 3 ngày)'),
    description: tr('Khi gắn nhãn "Khách mới", tự động gửi 3 tin nhắn chăm sóc theo lịch: sau 1 giờ gửi chào, sau 1 ngày gửi giới thiệu, sau 3 ngày gửi ưu đãi.'),
    category: 'ban-hang',
    tags: [tr('chuỗi'), 'nurturing', tr('3 bước'), tr('chăm sóc'), 'drip'],
    icon: <InboxIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: tr('Khi gắn nhãn "Khách mới"'), position: { x: 300, y: 50 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      // Step 1: after 1 hour
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 1 giờ'), position: { x: 300, y: 180 },
        config: { delaySeconds: 3600 } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('📩 Bước 1: Chào & giới thiệu'), position: { x: 300, y: 310 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('Chào bạn! 👋\n\nCảm ơn bạn đã quan tâm đến sản phẩm của mình. Mình xin giới thiệu nhanh:\n\n✅ Sản phẩm chất lượng cao\n✅ Giá cả hợp lý\n✅ Hỗ trợ 24/7\n\nBạn muốn tìm hiểu thêm về sản phẩm nào ạ?') } },
      // Step 2: after 1 day
      { id: 'n4', type: 'logic.wait', label: tr('Chờ 1 ngày'), position: { x: 300, y: 450 },
        config: { delaySeconds: 86400 } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('📩 Bước 2: Chia sẻ giá trị'), position: { x: 300, y: 580 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('Hi bạn! 😊\n\n📖 Mình muốn chia sẻ thêm một vài điều thú vị:\n\n🔹 Hơn 1000+ khách hàng hài lòng\n🔹 Đánh giá 5⭐ trên các nền tảng\n🔹 Chính sách đổi trả 30 ngày\n\nBạn có câu hỏi gì không? Mình giải đáp ngay!') } },
      // Step 3: after 3 days
      { id: 'n6', type: 'logic.wait', label: tr('Chờ 3 ngày'), position: { x: 300, y: 720 },
        config: { delaySeconds: 259200 } },
      { id: 'n7', type: 'zalo.sendMessage', label: tr('📩 Bước 3: Ưu đãi đặc biệt'), position: { x: 300, y: 860 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('🎉 Tin vui dành riêng cho bạn!\n\n🎁 Ưu đãi GIẢM 20% cho đơn hàng đầu tiên!\n⏰ Chỉ áp dụng trong 48 giờ tới\n\n👉 Nhắn "ĐẶT HÀNG" để mình hỗ trợ ngay nhé!\n\nCảm ơn bạn đã đồng hành 🙏') } },
      { id: 'n8', type: 'output.log', label: tr('Hoàn thành chuỗi'), position: { x: 300, y: 990 },
        config: { message: tr('Hoàn thành chuỗi chăm sóc 3 bước cho {{ $trigger.threadId }}'), level: 'info' } },
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

  // ━━━━━ 20. Send a message when the VIP label is applied ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-label-vip-notify',
    name: tr('Chào đón khách VIP khi gắn nhãn'),
    description: tr('Khi gắn nhãn "VIP" cho khách, tự động gửi tin nhắn chào đón đặc biệt và thông báo quyền lợi VIP. Tạo ấn tượng tốt.'),
    category: 'ban-hang',
    tags: ['VIP', tr('nhãn'), tr('chào đón'), 'CSKH', tr('ưu đãi')],
    icon: <CrownIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: tr('Khi gắn nhãn "VIP"'), position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 3 giây'), position: { x: 300, y: 200 },
        config: { delaySeconds: 3 } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('Gửi chào đón VIP'), position: { x: 300, y: 340 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('👑 Chào mừng bạn trở thành Khách VIP!\n\n🎁 Quyền lợi dành riêng cho bạn:\n• Giảm 15% mọi đơn hàng\n• Ưu tiên xử lý đơn nhanh hơn\n• Tư vấn 1-1 riêng biệt\n• Quà tặng vào dịp đặc biệt\n\nCảm ơn bạn đã tin tưởng! ❤️') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 21. Send the product menu when asked "sản phẩm" (product) / "menu" ━━━━━━━━━━━━━━━━
  {
    id: 'tpl-send-product-menu',
    name: tr('Gửi menu/catalogue khi được hỏi'),
    description: tr('Khi khách nhắn "sản phẩm", "menu", "catalogue"... tự động gửi ảnh menu và tin nhắn mô tả sản phẩm. Tiết kiệm thời gian giới thiệu.'),
    category: 'ban-hang',
    tags: ['menu', tr('sản phẩm'), 'catalogue', tr('ảnh'), tr('giới thiệu')],
    icon: '📸',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi hỏi về sản phẩm'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'sản phẩm,menu,catalogue,catalog,danh mục', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.sendTyping', label: tr('Hiệu ứng đang gõ'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('Gửi danh mục SP'), position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('📋 Danh mục sản phẩm:\n\n🔹 Nhóm A — Sản phẩm cơ bản\n  • SP1: 199k | SP2: 299k | SP3: 399k\n\n🔹 Nhóm B — Sản phẩm cao cấp\n  • SP4: 599k | SP5: 799k | SP6: 999k\n\n🔹 Combo tiết kiệm\n  • Combo 1: 499k (tiết kiệm 30%)\n  • Combo 2: 899k (tiết kiệm 40%)\n\n👉 Nhắn mã SP (VD: "SP1") để xem chi tiết nhé!') } },
      { id: 'n4', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Quan tâm SP"'), position: { x: 300, y: 490 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 22. Send order confirmation + status tag ━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-order-confirm-tag',
    name: tr('Xác nhận đơn + gắn nhãn trạng thái'),
    description: tr('Khi nhận tin "đặt hàng", tự động gửi xác nhận, gắn nhãn "Đang xử lý", ghi log đơn hàng. Quản lý pipeline bán hàng hiệu quả.'),
    category: 'ban-hang',
    tags: [tr('đặt hàng'), tr('xác nhận'), tr('nhãn'), 'pipeline', tr('trạng thái')],
    icon: <CheckIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận "đặt hàng"'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'đặt hàng,order,mua,đặt mua', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Đang xử lý"'), position: { x: 300, y: 200 },
        config: { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n3', type: 'zalo.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi xác nhận đơn'), position: { x: 300, y: 480 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('✅ Đã nhận yêu cầu đặt hàng!\n\n📋 Để hoàn tất, bạn vui lòng gửi:\n1️⃣ Tên sản phẩm & số lượng\n2️⃣ Họ tên người nhận\n3️⃣ Số điện thoại\n4️⃣ Địa chỉ giao hàng\n\nMình sẽ xác nhận ngay sau khi nhận thông tin! 🙏') } },
      { id: 'n5', type: 'output.log', label: tr('Ghi log đơn mới'), position: { x: 300, y: 620 },
        config: { message: tr('Đơn hàng mới từ {{ $trigger.fromName }} ({{ $trigger.threadId }}): {{ $trigger.content }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 23. Label → review reminder after 7 days ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-review-reminder-7d',
    name: tr('Nhắc khách đánh giá sau 7 ngày'),
    description: tr('Khi gắn nhãn "Đã giao hàng", chờ 7 ngày rồi tự động gửi tin nhắn nhờ khách đánh giá sản phẩm. Thu thập feedback tự động.'),
    category: 'marketing',
    tags: [tr('đánh giá'), 'review', tr('7 ngày'), 'feedback', tr('nhãn')],
    icon: <StarIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: tr('Khi gắn nhãn "Đã giao"'), position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 7 ngày'), position: { x: 300, y: 200 },
        config: { delaySeconds: 604800 } },
      { id: 'n3', type: 'zalo.sendTyping', label: tr('Hiệu ứng gõ'), position: { x: 300, y: 340 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2, threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi nhờ đánh giá'), position: { x: 300, y: 480 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('Xin chào! 😊\n\nBạn đã sử dụng sản phẩm được 1 tuần rồi. Bạn cảm thấy thế nào ạ?\n\n⭐ Nếu hài lòng, mình rất vui nếu bạn dành 1 phút chia sẻ trải nghiệm nhé!\n\n🎁 Đánh giá ngay → Nhận voucher giảm 10% cho lần mua tiếp theo!\n\nCảm ơn bạn rất nhiều 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 24. Send offers to customers with a specific label ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-label-promo-send',
    name: tr('Gửi ưu đãi theo nhãn khách hàng'),
    description: tr('Khi gắn nhãn "Ưu đãi tháng 3" (hoặc nhãn tuỳ chọn), tự động gửi ngay tin nhắn khuyến mãi đã soạn sẵn. Dùng cho chiến dịch promo nhanh.'),
    category: 'marketing',
    tags: [tr('ưu đãi'), tr('nhãn'), tr('khuyến mãi'), tr('chiến dịch'), 'promo'],
    icon: <TargetIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: tr('Khi gắn nhãn promo'), position: { x: 300, y: 60 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 5 giây'), position: { x: 300, y: 200 },
        config: { delaySeconds: 5 } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('Gửi ưu đãi'), position: { x: 300, y: 340 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('🔥 ƯU ĐÃI ĐẶC BIỆT!\n\n🎁 Giảm ngay 30% cho tất cả sản phẩm\n📅 Áp dụng: Từ nay đến cuối tháng\n🏷️ Mã: SALE30\n\n👉 Nhắn "MUA" để đặt hàng ngay!\n\n⚡ Số lượng có hạn — Ai nhanh được trước!') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 25. Re-engagement campaign: message silent customers again ━━━━━━━━━━━━━━━━
  {
    id: 'tpl-reengagement-campaign',
    name: tr('Re-engagement: Nhắn lại khách im lặng'),
    description: tr('Nhắn lại khách hàng cũ trong CRM để gợi lại quan tâm. Chọn nội dung ngẫu nhiên và gửi hàng loạt, tự giãn cách để tránh spam.'),
    category: 'marketing',
    tags: ['re-engagement', tr('khách cũ'), 'CRM', tr('chiến dịch'), tr('khôi phục')],
    icon: <RefreshIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: tr('Chạy thủ công'), position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'logic.forEachContact', label: tr('Chọn khách cũ (CRM)'), position: { x: 300, y: 200 },
        config: { source: 'crm_contacts', limit: 500 } },
      { id: 'n3', type: 'data.randomPick', label: tr('Chọn nội dung ngẫu nhiên'), position: { x: 300, y: 360 },
        config: { options: tr('Chào bạn! 👋 Lâu rồi không gặp, bạn khoẻ không? Mình có nhiều sản phẩm mới muốn giới thiệu nhé!\nHi bạn! 😊 Bạn đã bỏ lỡ nhiều ưu đãi hấp dẫn. Nhắn "ƯU ĐÃI" để xem ngay!\nXin chào bạn! Cảm ơn đã từng tin tưởng. Mình có quà đặc biệt dành cho bạn — nhắn "QUÀ" nhé! 🎁') } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi tin re-engage'), position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n3.output }}', threadIdsExpr: '{{ $node.n2.result }}', sendDelayMinSeconds: 5, sendDelayMaxSeconds: 8 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 26. Create a weekly survey poll in the group ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-weekly-poll',
    name: tr('Tạo poll khảo sát nhóm hàng tuần'),
    description: tr('Mỗi thứ Hai tự động tạo bình chọn trong nhóm Zalo để khảo sát ý kiến thành viên. Tăng tương tác nhóm.'),
    category: 'marketing',
    tags: ['poll', tr('bình chọn'), tr('nhóm'), tr('hàng tuần'), tr('khảo sát')],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Thứ Hai lúc 9h sáng'), position: { x: 300, y: 60 },
        config: { cronExpression: '0 9 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'zalo.createPoll', label: tr('Tạo bình chọn'), position: { x: 300, y: 220 },
        config: { groupId: '', question: tr('📊 Bạn muốn chủ đề chia sẻ tuần này là gì?'), options: tr('Tips bán hàng\nCông nghệ mới\nSức khoẻ & đời sống\nKỹ năng mềm\nKhác (comment bên dưới)'), allowMultiple: false, expireTime: 0 } },
      { id: 'n3', type: 'output.log', label: tr('Ghi log'), position: { x: 300, y: 370 },
        config: { message: tr('Đã tạo poll khảo sát tuần mới'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 27. Track members leaving the group → notify admin ━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-group-leave-alert',
    name: tr('Thông báo khi thành viên rời nhóm'),
    description: tr('Khi có thành viên rời nhóm, tự động gửi thông báo vào nhóm admin hoặc Telegram để theo dõi.'),
    category: 'quan-ly',
    tags: [tr('nhóm'), tr('rời nhóm'), tr('theo dõi'), tr('thông báo'), 'admin'],
    icon: '🚪',
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.groupEvent', label: tr('Thành viên rời nhóm'), position: { x: 300, y: 60 },
        config: { groupId: '', eventType: 'leave' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn nội dung báo cáo'), position: { x: 300, y: 210 },
        config: { template: tr('🚪 Thành viên rời nhóm\n\n👤 {{ $trigger.memberNames }}\n🏠 Nhóm: {{ $trigger.groupId }}\n⏰ Lúc: {{ $date.now }}\n\nCó thể cần follow-up?') } },
      { id: 'n3', type: 'notify.telegram', label: tr('Báo qua Telegram'), position: { x: 300, y: 370 },
        config: { botToken: '', chatId: '', message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ 28. End-of-day summary report via Telegram ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-daily-report-telegram',
    name: tr('Báo cáo cuối ngày qua Telegram'),
    description: tr('Mỗi ngày lúc 18h, tự động lấy dữ liệu từ Google Sheets (doanh số, đơn hàng...) và gửi báo cáo tổng hợp vào Telegram.'),
    category: 'quan-ly',
    tags: [tr('báo cáo'), tr('cuối ngày'), 'Telegram', 'Google Sheets', tr('tổng hợp')],
    icon: <TrendingUpIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Mỗi ngày lúc 18h'), position: { x: 300, y: 50 },
        config: { cronExpression: '0 18 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.dateFormat', label: tr('Lấy ngày hôm nay'), position: { x: 300, y: 190 },
        config: { format: 'date' } },
      { id: 'n3', type: 'sheets.readValues', label: tr('Đọc dữ liệu báo cáo'), position: { x: 300, y: 330 },
        config: { spreadsheetId: '', range: 'BaoCao!A1:D10', serviceAccountPath: '' } },
      { id: 'n4', type: 'data.textFormat', label: tr('Soạn báo cáo'), position: { x: 300, y: 480 },
        config: { template: tr('📊 *BÁO CÁO CUỐI NGÀY*\n📅 {{ $node.n2.output }}\n\n━━━━━━━━━━━━\n📦 Đơn hàng mới: Xem Sheet\n💰 Doanh thu: Xem Sheet\n👥 Khách mới: Xem Sheet\n💬 Tin nhắn xử lý: Xem Sheet\n━━━━━━━━━━━━\n\n✅ Hoàn thành ngày làm việc!') } },
      { id: 'n5', type: 'notify.telegram', label: tr('Gửi qua Telegram'), position: { x: 300, y: 630 },
        config: { botToken: '', chatId: '', message: '{{ $node.n4.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 29. Leave management: message "nghỉ" → log to Sheets + notify group ━━
  {
    id: 'tpl-leave-request',
    name: tr('Quản lý xin nghỉ phép qua Zalo'),
    description: tr('Nhân viên nhắn "nghỉ [ngày] [lý do]", hệ thống tự động ghi vào Google Sheets và thông báo trong nhóm quản lý.'),
    category: 'quan-ly',
    tags: [tr('nghỉ phép'), tr('nhân sự'), 'Google Sheets', tr('quản lý'), tr('nhóm')],
    icon: <EditIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhắn "nghỉ..."'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'nghỉ,xin nghỉ,ngày nghỉ', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Chuẩn bị dữ liệu'), position: { x: 300, y: 200 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.content }}\t{{ $trigger.timestamp }}' } },
      { id: 'n3', type: 'sheets.appendRow', label: tr('Ghi vào Sheet nghỉ phép'), position: { x: 100, y: 370 },
        config: { spreadsheetId: '', sheetName: 'NghiPhep', values: '{{ $node.n2.output }}', serviceAccountPath: '' } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Thông báo nhóm QL'), position: { x: 500, y: 370 },
        config: { threadId: '', threadType: '2', message: tr('📋 Yêu cầu nghỉ phép mới:\n\n👤 {{ $trigger.fromName }}\n💬 {{ $trigger.content }}\n⏰ {{ $trigger.timestamp }}\n\nAdmin phê duyệt bằng cách reply "OK" hoặc "Từ chối".') } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Phản hồi người xin'), position: { x: 300, y: 530 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('✅ Đã nhận yêu cầu nghỉ phép của bạn!\n\nQuản lý sẽ xem xét và phản hồi sớm nhé. 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
      { id: 'e4', source: 'n3', target: 'n5' },
    ],
  },

  // ━━━━━ 30. Update order status when a label is applied → notify customer ━━━━━━━━━━━
  {
    id: 'tpl-order-status-update',
    name: tr('Thông báo KH khi cập nhật trạng thái đơn'),
    description: tr('Khi gắn nhãn "Đang giao" / "Đã giao" / "Hoàn thành", tự động gửi tin nhắn cập nhật trạng thái cho khách hàng.'),
    category: 'quan-ly',
    tags: [tr('đơn hàng'), tr('trạng thái'), tr('nhãn'), tr('cập nhật'), tr('thông báo')],
    icon: <PackageIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.labelAssigned', label: tr('Khi gắn nhãn trạng thái'), position: { x: 300, y: 50 },
        config: { action: 'assigned', labelSource: 'any', labelIds: [] } },
      { id: 'n2', type: 'logic.switch', label: tr('Nhãn nào?'), position: { x: 300, y: 200 },
        config: {
          value: '{{ $trigger.labelText }}',
          cases: [{ match: 'Đang giao', label: tr('Đang giao') }, { match: 'Đã giao', label: tr('Đã giao') }, { match: 'Hoàn thành', label: tr('Hoàn thành') }],
          defaultLabel: tr('Khác'),
        } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('🚚 Thông báo đang giao'), position: { x: 0, y: 400 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('🚚 Đơn hàng của bạn đang được vận chuyển!\n\nDự kiến giao trong 1-3 ngày. Bạn vui lòng để ý điện thoại nhé!\n\nCảm ơn bạn! 🙏') } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('📬 Thông báo đã giao'), position: { x: 300, y: 400 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('📬 Đơn hàng đã được giao!\n\nBạn kiểm tra hàng và phản hồi cho mình nếu có vấn đề gì nhé.\n\n⭐ Đừng quên đánh giá sản phẩm để nhận ưu đãi lần sau! 🎁') } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('✅ Thông báo hoàn thành'), position: { x: 600, y: 400 },
        config: { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: tr('✅ Đơn hàng đã hoàn thành!\n\nCảm ơn bạn đã mua sắm. Hẹn gặp lại! ❤️\n\n🔖 Mã giảm giá cho lần sau: THANKYOU10') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: tr('Đang giao'), target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: tr('Đã giao'), target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: tr('Hoàn thành'), target: 'n5' },
    ],
  },

  // ━━━━━ 31. Summarize new messages → send to Telegram hourly ━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-hourly-summary-telegram',
    name: tr('Tổng hợp tin nhắn mỗi giờ → Telegram'),
    description: tr('Mỗi giờ 1 lần, tự động gửi tóm tắt số lượng tin nhắn mới vào nhóm Telegram để team theo dõi. Không bỏ lỡ tin nhắn nào.'),
    category: 'thong-bao',
    tags: [tr('tổng hợp'), tr('hàng giờ'), 'Telegram', 'monitoring', tr('theo dõi')],
    icon: <WifiIcon className="w-4 h-4" />,
    difficulty: 'easy',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Mỗi giờ 1 lần'), position: { x: 300, y: 60 },
        config: { cronExpression: '0 * * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.dateFormat', label: tr('Lấy giờ hiện tại'), position: { x: 300, y: 200 },
        config: { format: 'datetime' } },
      { id: 'n3', type: 'data.textFormat', label: tr('Soạn tóm tắt'), position: { x: 300, y: 340 },
        config: { template: tr('⏰ Cập nhật lúc {{ $node.n2.output }}\n\n📊 Tình trạng hệ thống: ✅ Hoạt động\n💬 Các workflow đang chạy bình thường\n\n— Gửi tự động bởi Deplao Bot') } },
      { id: 'n4', type: 'notify.telegram', label: tr('Gửi Telegram'), position: { x: 300, y: 480 },
        config: { botToken: '', chatId: '', message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 32. Alert on sensitive keywords / spam ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-spam-alert',
    name: tr('Cảnh báo tin nhắn nhạy cảm / spam'),
    description: tr('Phát hiện từ khoá nhạy cảm (lừa đảo, spam, quảng cáo...) trong tin nhắn nhóm, gửi cảnh báo ngay cho admin qua Telegram.'),
    category: 'thong-bao',
    tags: ['spam', tr('cảnh báo'), tr('nhạy cảm'), 'admin', 'an ninh'],
    icon: <BellIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Lọc từ khoá nhạy cảm'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'lừa đảo,scam,spam,hack,virus,đầu tư lãi suất,kiếm tiền online', keywordMode: 'contains_any', threadType: 'group' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn cảnh báo'), position: { x: 300, y: 200 },
        config: { template: tr('🚨 *CẢNH BÁO TIN NHẮN NHẠY CẢM*\n\n👤 Người gửi: {{ $trigger.fromName }}\n🏠 Nhóm: {{ $trigger.threadId }}\n💬 Nội dung: {{ $trigger.content }}\n⏰ Lúc: {{ $trigger.timestamp }}\n\n⚠️ Cần kiểm tra ngay!') } },
      { id: 'n3', type: 'notify.telegram', label: tr('Alert Telegram admin'), position: { x: 100, y: 380 },
        config: { botToken: '', chatId: '', message: '{{ $node.n2.output }}' } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log sự cố'), position: { x: 500, y: 380 },
        config: { message: 'SPAM ALERT: {{ $trigger.fromName }} — {{ $trigger.content }}', level: 'warning' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
    ],
  },

  // ━━━━━ 33. Sync new customers → Sheets + Telegram ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-new-customer-sync',
    name: tr('Đồng bộ khách mới → Sheets + Telegram'),
    description: tr('Khi chấp nhận kết bạn, tự động ghi thông tin khách vào Google Sheets VÀ gửi thông báo vào Telegram. Không bỏ sót khách nào.'),
    category: 'thong-bao',
    tags: [tr('đồng bộ'), tr('khách mới'), 'Google Sheets', 'Telegram', 'CRM'],
    icon: <RefreshIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: tr('Khi có lời mời kết bạn'), position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: tr('Chấp nhận kết bạn'), position: { x: 300, y: 190 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'data.textFormat', label: tr('Chuẩn bị data'), position: { x: 300, y: 330 },
        config: { template: '{{ $trigger.displayName }}\t{{ $trigger.userId }}\t{{ $date.now }}' } },
      { id: 'n4', type: 'sheets.appendRow', label: tr('Ghi vào Sheets'), position: { x: 100, y: 490 },
        config: { spreadsheetId: '', sheetName: 'KhachMoi', values: '{{ $node.n3.output }}', serviceAccountPath: '' } },
      { id: 'n5', type: 'notify.telegram', label: tr('Thông báo Telegram'), position: { x: 500, y: 490 },
        config: { botToken: '', chatId: '', message: tr('👤 Khách mới kết bạn!\n\nTên: {{ $trigger.displayName }}\nID: {{ $trigger.userId }}\nLúc: {{ $date.now }}') } },
      { id: 'n6', type: 'zalo.sendMessage', label: tr('Chào khách'), position: { x: 300, y: 640 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: tr('Xin chào! 👋 Cảm ơn bạn đã kết bạn.\nMình có thể giúp gì cho bạn ạ?') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n3', target: 'n5' },
      { id: 'e5', source: 'n4', target: 'n6' },
    ],
  },

  // ━━━━━ 34. AI FAQ Bot: answers common questions ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-faq-bot',
    name: tr('AI FAQ Bot — Tự động trả lời câu hỏi thường gặp'),
    description: tr('Cung cấp bộ FAQ trong system prompt, AI sẽ tự trả lời chính xác dựa trên thông tin bạn cung cấp. Không cần viết từng câu trả lời.'),
    category: 'ai',
    tags: ['AI', 'FAQ', tr('câu hỏi'), tr('tự động'), tr('hỗ trợ')],
    icon: '❓',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], threadType: 'user', ignoreOwn: true } },
      { id: 'n2', type: 'logic.stopIf', label: tr('Bỏ qua nếu rỗng'), position: { x: 300, y: 190 },
        config: { left: '{{ $trigger.content }}', operator: 'equals', right: '' } },
      { id: 'n3', type: 'zalo.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 330 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 2 } },
      { id: 'n4', type: 'ai.generateText', label: tr('AI trả lời từ FAQ'), position: { x: 300, y: 470 },
        config: {
          aiConfigMode: 'assistant', assistantId: '',
          prompt: 'Trả lời DỰA TRÊN FAQ bên dưới. Nếu câu hỏi ngoài FAQ, nói "Mình sẽ chuyển cho nhân viên hỗ trợ nhé!".\n\n--- FAQ ---\nQ: Giờ mở cửa?\nA: 8h - 21h hàng ngày (T2-CN)\n\nQ: Phí ship bao nhiêu?\nA: Miễn phí ship đơn từ 300k. Dưới 300k phí ship 25k.\n\nQ: Đổi trả như thế nào?\nA: Đổi trả trong 7 ngày, sản phẩm còn nguyên tem mác.\n\nQ: Thanh toán bằng gì?\nA: Chuyển khoản, COD, hoặc ví MoMo/ZaloPay.\n\nQ: Bao lâu nhận hàng?\nA: Nội thành 1-2 ngày, tỉnh khác 3-5 ngày.\n\nCâu hỏi của khách: {{ $trigger.content }}',
        } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Gửi câu trả lời'), position: { x: 300, y: 620 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: '{{ $node.n4.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ 35. AI summarizes a conversation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-conversation-summary',
    name: tr('AI tóm tắt cuộc hội thoại'),
    description: tr('Chạy thủ công để lấy 20 tin nhắn gần nhất, dùng AI tóm tắt nội dung chính và gửi kết quả. Tiết kiệm thời gian review hội thoại dài.'),
    category: 'ai',
    tags: ['AI', tr('tóm tắt'), tr('hội thoại'), 'review', tr('lịch sử')],
    icon: <FileTextIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: tr('Chạy thủ công'), position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'zalo.getMessageHistory', label: tr('Lấy 20 tin nhắn gần nhất'), position: { x: 300, y: 190 },
        config: { threadId: '{{ $trigger.threadId }}', count: 20 } },
      { id: 'n3', type: 'ai.generateText', label: tr('AI tóm tắt'), position: { x: 300, y: 340 },
        config: {
          aiConfigMode: 'assistant', assistantId: '',
          prompt: 'Bạn là trợ lý phân tích hội thoại. Hãy tóm tắt cuộc trò chuyện bằng tiếng Việt, nêu rõ:\n1. Chủ đề chính\n2. Các yêu cầu/vấn đề của khách\n3. Trạng thái (đã giải quyết / cần follow-up)\n4. Action items cần làm\n\nTóm tắt cuộc hội thoại sau:\n\n{{ $node.n2.output }}',
        } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log tóm tắt'), position: { x: 300, y: 490 },
        config: { message: tr('📑 TÓM TẮT HỘI THOẠI:\n{{ $node.n3.output }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 36. AI writes marketing content automatically ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-ai-marketing-content',
    name: tr('AI soạn nội dung marketing'),
    description: tr('Chạy thủ công, nhập chủ đề sản phẩm → AI tự soạn bài viết marketing hấp dẫn để gửi cho khách hoặc đăng nhóm.'),
    category: 'ai',
    tags: ['AI', 'marketing', 'content', tr('bài viết'), tr('sáng tạo')],
    icon: '✍️',
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhắn "viết [chủ đề]"'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'viết,soạn,tạo bài', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.sendTyping', label: tr('AI đang soạn bài...'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 5 } },
      { id: 'n3', type: 'ai.generateText', label: tr('AI soạn bài marketing'), position: { x: 300, y: 350 },
        config: {
          aiConfigMode: 'assistant', assistantId: '',
          prompt: 'Bạn là chuyên gia viết content marketing. Viết bài ngắn gọn, hấp dẫn, có emoji. Format:\n- Tiêu đề bắt mắt\n- 3-4 bullet points lợi ích\n- Call-to-action rõ ràng\n- Tạo cảm giác urgency\n\nViết bài marketing về: {{ $trigger.content }}',
        } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi bài đã soạn'), position: { x: 300, y: 500 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('✍️ Bài marketing AI đã soạn:\n\n{{ $node.n3.output }}') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 37. Forward messages with images → archive ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-forward-archive',
    name: tr('Chuyển tiếp & lưu trữ tin nhắn quan trọng'),
    description: tr('Khi nhận tin nhắn chứa từ khoá quan trọng, tự động chuyển tiếp sang chat lưu trữ và ghi log. Không mất tin nhắn quan trọng.'),
    category: 'nang-cao',
    tags: [tr('chuyển tiếp'), tr('lưu trữ'), 'backup', tr('quan trọng')],
    icon: <HardDriveIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi có từ khoá quan trọng'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'], keyword: 'hợp đồng,thanh toán,chuyển khoản,hoá đơn,invoice', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'zalo.forwardMessage', label: tr('Chuyển tiếp tin nhắn'), position: { x: 300, y: 200 },
        config: { msgId: '{{ $trigger.msgId }}', toThreadId: '', toThreadType: '0' } },
      { id: 'n3', type: 'data.textFormat', label: tr('Soạn log'), position: { x: 300, y: 350 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.content }}\t{{ $trigger.threadId }}\t{{ $trigger.timestamp }}' } },
      { id: 'n4', type: 'sheets.appendRow', label: tr('Ghi vào Sheets lưu trữ'), position: { x: 300, y: 500 },
        config: { spreadsheetId: '', sheetName: 'LuuTru', values: '{{ $node.n3.output }}', serviceAccountPath: '' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ 38. Combined workflow: friend request → label → 3-day care ━━━━━━━━
  {
    id: 'tpl-friend-tag-nurture',
    name: tr('Kết bạn → Gắn nhãn → Chăm sóc sau 3 ngày'),
    description: tr('Trọn bộ: Chấp nhận kết bạn → Gửi chào → Gắn nhãn "Lead mới" → Chờ 3 ngày → Gửi tin follow-up giới thiệu sản phẩm.'),
    category: 'nang-cao',
    tags: [tr('kết bạn'), tr('nhãn'), tr('chăm sóc'), 'follow-up', tr('trọn bộ')],
    icon: <RocketIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.friendRequest', label: tr('Khi có lời mời kết bạn'), position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'zalo.acceptFriendRequest', label: tr('Chấp nhận'), position: { x: 300, y: 180 },
        config: { userId: '{{ $trigger.userId }}' } },
      { id: 'n3', type: 'logic.wait', label: tr('Chờ 3 giây'), position: { x: 300, y: 310 },
        config: { delaySeconds: 3 } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi chào mừng'), position: { x: 300, y: 440 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: tr('Xin chào! 👋 Cảm ơn bạn đã kết bạn.\n\nMình chuyên cung cấp [tên sản phẩm/dịch vụ]. Bạn cần tư vấn gì cứ nhắn mình nhé! 😊') } },
      { id: 'n5', type: 'zalo.assignLabel', label: tr('Gắn nhãn "Lead mới"'), position: { x: 300, y: 580 },
        config: { threadId: '{{ $trigger.userId }}', labelSource: 'local', labelIds: [] } },
      { id: 'n6', type: 'logic.wait', label: tr('Chờ 3 ngày'), position: { x: 300, y: 720 },
        config: { delaySeconds: 259200 } },
      { id: 'n7', type: 'zalo.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 860 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', delaySeconds: 3 } },
      { id: 'n8', type: 'zalo.sendMessage', label: tr('Follow-up giới thiệu'), position: { x: 300, y: 1000 },
        config: { threadId: '{{ $trigger.userId }}', threadType: '0', message: tr('Hi bạn! 😊 Mấy ngày trước bạn có kết bạn với mình.\n\n🎁 Mình muốn chia sẻ:\n• Sản phẩm bán chạy nhất tháng này\n• Ưu đãi giảm 15% cho khách mới\n\n👉 Nhắn "TƯ VẤN" để mình hỗ trợ chi tiết nhé!') } },
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

  // ━━━━━ 39. Conditional workflow: different replies per thread type ━━━━━━━━━━
  {
    id: 'tpl-reply-by-thread-type',
    name: tr('Trả lời khác nhau: Chat riêng vs Nhóm'),
    description: tr('Cùng 1 tin nhắn, nhưng trả lời khác nhau tuỳ theo đến từ chat riêng hay nhóm. Chat riêng → tư vấn 1:1, nhóm → trả lời ngắn gọn + mời inbox.'),
    category: 'nang-cao',
    tags: [tr('rẽ nhánh'), tr('nhóm'), tr('cá nhân'), tr('điều kiện'), tr('thông minh')],
    icon: <ShuffleIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Là chat riêng?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.threadType }}', operator: 'equals', right: '0' } },
      { id: 'n3', type: 'zalo.sendTyping', label: tr('Đang gõ (riêng)'), position: { x: 80, y: 370 },
        config: { ...DEFAULT_CONFIGS['zalo.sendTyping'], delaySeconds: 3 } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Trả lời chi tiết 1:1'), position: { x: 80, y: 510 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('Cảm ơn bạn đã nhắn tin! 😊\n\nMình sẽ tư vấn chi tiết cho bạn. Bạn đang quan tâm đến sản phẩm/dịch vụ nào ạ?\n\n📋 Nhắn "MENU" để xem danh mục\n💰 Nhắn "GIÁ" để xem bảng giá\n📍 Nhắn "ĐỊA CHỈ" để biết nơi mua') } },
      { id: 'n5', type: 'zalo.sendMessage', label: tr('Trả lời ngắn gọn (nhóm)'), position: { x: 520, y: 370 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], message: tr('Cảm ơn bạn! Để được tư vấn chi tiết hơn, bạn inbox riêng cho mình nhé! 📩') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: 'false', target: 'n5' },
    ],
  },

  // ━━━━━ 40. Schedule messages to send in advance ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-scheduled-broadcast',
    name: tr('Lập lịch gửi broadcast cho khách'),
    description: tr('Đặt lịch gửi tin nhắn quảng cáo vào khung giờ vàng (11h trưa thứ 3 & thứ 5) cho nhóm khách theo nhãn. Tự giãn cách giữa các tin để tránh spam.'),
    category: 'nang-cao',
    tags: [tr('lập lịch'), 'broadcast', tr('khung giờ vàng'), tr('tự động'), tr('chiến dịch')],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'medium',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('T3 & T5 lúc 11h'), position: { x: 300, y: 50 },
        config: { cronExpression: '0 11 * * 2,4', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'logic.forEachContact', label: tr('Chọn nhóm khách'), position: { x: 300, y: 200 },
        config: { source: 'labels', labelIds: [], limit: 500 } },
      { id: 'n3', type: 'data.randomPick', label: tr('Chọn nội dung ngẫu nhiên'), position: { x: 300, y: 360 },
        config: { options: tr('🌟 Khám phá bộ sưu tập mới nhất! Nhắn "XEM" để biết thêm.\n🔥 Flash Sale hôm nay! Giảm đến 50% — chỉ duy nhất hôm nay!\n🎁 Quà tặng bất ngờ cho 10 khách hàng đầu tiên reply tin này!') } },
      { id: 'n4', type: 'zalo.sendMessage', label: tr('Gửi broadcast'), position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['zalo.sendMessage'], threadId: '', threadType: '0', message: '{{ $node.n3.output }}', threadIdsExpr: '{{ $node.n2.result }}', sendDelayMinSeconds: 5, sendDelayMaxSeconds: 8 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FACEBOOK TEMPLATES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // ━━━━━ FB 1. Auto-reply to Facebook messages ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-auto-reply',
    name: tr('FB: Tự động trả lời tin nhắn'),
    description: tr('Khi nhận tin nhắn mới trên Facebook Messenger, tự động gửi lại câu trả lời. Hiển thị hiệu ứng đang gõ trước khi gửi để tạo cảm giác tự nhiên.'),
    category: 'ban-hang',
    tags: ['facebook', tr('trả lời'), tr('tự động'), 'messenger', tr('cơ bản')],
    icon: <ChatIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 250, y: 80 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.sendTyping', label: tr('Hiệu ứng đang gõ'), position: { x: 250, y: 220 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'], isTyping: true } },
      { id: 'n3', type: 'logic.wait', label: tr('Chờ 2 giây'), position: { x: 250, y: 360 },
        config: { delaySeconds: 2 } },
      { id: 'n4', type: 'fb.action.sendMessage', label: tr('Gửi câu trả lời'), position: { x: 250, y: 500 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('Cảm ơn bạn đã nhắn tin! Đội ngũ support sẽ phản hồi bạn trong thời gian sớm nhất. 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 2. Auto reaction + reply by keyword ━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-keyword-reply',
    name: tr('FB: Reaction + Trả lời theo từ khoá'),
    description: tr('Thả reaction vào tin nhắn của khách, sau đó phân tích nội dung để trả lời: hỏi "giá" → gửi bảng giá, hỏi "địa chỉ" → gửi chỉ đường, còn lại → trả lời mặc định.'),
    category: 'ban-hang',
    tags: ['facebook', tr('từ khoá'), 'reaction', tr('rẽ nhánh'), 'CSKH'],
    icon: <KeyIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.addReaction', label: tr('Thả 👍 reaction'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '👍' } },
      { id: 'n3', type: 'logic.if', label: tr('Chứa "giá"?'), position: { x: 350, y: 360 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('giá') } },
      { id: 'n4', type: 'logic.if', label: tr('Chứa "địa chỉ"?'), position: { x: 350, y: 500 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('địa chỉ') } },
      { id: 'n5', type: 'fb.action.sendMessage', label: tr('Gửi bảng giá'), position: { x: 50, y: 650 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📋 Bảng giá sản phẩm:\n\n• Gói Cơ bản: 199k/tháng\n• Gói Nâng cao: 399k/tháng\n• Gói Pro: 799k/tháng\n\nBạn muốn tư vấn gói nào ạ?') } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Gửi địa chỉ'), position: { x: 350, y: 650 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📍 Địa chỉ của chúng tôi:\n\n123 Đường ABC, Phường XYZ, Quận 1, TP.HCM\n\n🕐 Giờ mở cửa: 8:00 - 22:00 (T2-CN)\n\n📱 Google Maps: https://maps.app.goo.gl/...') } },
      { id: 'n7', type: 'fb.action.sendMessage', label: tr('Trả lời chung'), position: { x: 650, y: 650 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('Cảm ơn bạn đã quan tâm! Bạn cần hỗ trợ gì thêm không ạ? 😊') } },
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

  // ━━━━━ FB 3. Send a welcome message to the group ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-group-welcome',
    name: tr('FB: Chào mừng thành viên mới vào nhóm'),
    description: tr('Khi có tin nhắn mới từ thành viên trong nhóm Facebook, tự động gửi tin nhắn chào mừng kèm nội quy nhóm và hướng dẫn.'),
    category: 'ban-hang',
    tags: ['facebook', tr('nhóm'), tr('chào mừng'), tr('nội quy'), tr('tự động')],
    icon: <WaveIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.groupEvent', label: tr('Có thành viên vào nhóm'), position: { x: 250, y: 80 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.groupEvent'], eventType: 'participant_added' } },
      { id: 'n3', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 250, y: 370 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n4', type: 'fb.action.sendMessage', label: tr('Gửi chào mừng'), position: { x: 250, y: 510 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🎉 Chào mừng bạn đến với nhóm!\n\n📌 Nội quy nhóm:\n1. Không spam quảng cáo\n2. Tôn trọng các thành viên\n3. Đúng chủ đề thảo luận\n\n💬 Hãy giới thiệu bản thân để mọi người làm quen nhé!') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 4. Mark as read + reaction + reply ━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-mark-read-reply',
    name: tr('FB: Đánh dấu đã đọc và trả lời AI'),
    description: tr('Đánh dấu đã đọc tin nhắn Facebook, thả reaction, sau đó dùng AI để tạo câu trả lời thông minh dựa trên nội dung tin nhắn.'),
    category: 'ai',
    tags: ['facebook', 'AI', tr('thông minh'), tr('tự động'), 'CSKH'],
    icon: <BotIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: tr('Đánh dấu đã đọc'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'fb.action.addReaction', label: tr('Reaction 👍'), position: { x: 300, y: 350 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '👍' } },
      { id: 'n4', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 500 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n5', type: 'ai.classify', label: tr('Phân loại nội dung'), position: { x: 300, y: 650 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], input: '{{ $trigger.content }}' } },
      { id: 'n6', type: 'ai.generateText', label: tr('AI sinh câu trả lời'), position: { x: 300, y: 800 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Khách hàng vừa gửi tin nhắn: "{{ $trigger.content }}"\nPhân loại: {{ $node.n5.output }}\n\nHãy trả lời một cách thân thiện, chuyên nghiệp bằng tiếng Việt.' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: tr('Gửi câu trả lời'), position: { x: 300, y: 960 },
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

  // ━━━━━ FB 5. Schedule bulk messages ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-scheduled-broadcast',
    name: tr('FB: Gửi khuyến mãi định kỳ vào nhóm'),
    description: tr('Đặt lịch gửi tin khuyến mãi vào nhóm/chat Messenger mỗi ngày. Chọn nhóm nhận tin trong cài đặt node "Gửi tin".'),
    category: 'marketing',
    tags: ['facebook', tr('lập lịch'), tr('khuyến mãi'), 'marketing'],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('08:00 mỗi ngày'), position: { x: 300, y: 50 },
        config: { cronExpression: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn nội dung'), position: { x: 300, y: 200 },
        config: { template: tr('🌞 Chào bạn!\n\nChương trình khuyến mãi hôm nay:\n• Giảm 20% tất cả sản phẩm\n• Miễn phí giao hàng nội thành\n\nLH: 0123.456.789 để đặt ngay!') } },
      { id: 'n3', type: 'fb.action.sendMessage', label: tr('Gửi tin vào nhóm'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], threadId: '', message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // ━━━━━ FB 6. Forward messages to an internal group ━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-forward-to-group',
    name: tr('FB: Chuyển tiếp tin nhắn vào nhóm nội bộ'),
    description: tr('Khi khách hàng gửi tin nhắn chứa từ khoá "hỗ trợ" hoặc "khiếu nại", tự động chuyển tiếp tin nhắn đó vào nhóm nội bộ để CSDL xử lý.'),
    category: 'ban-hang',
    tags: ['facebook', tr('chuyển tiếp'), tr('nội bộ'), 'CSKH', tr('xử lý')],
    icon: <SendIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Cần hỗ trợ?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('hỗ trợ, khiếu nại, complaint, support') } },
      { id: 'n3', type: 'fb.action.forward', label: tr('Forward vào nhóm'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n4', type: 'fb.action.sendMessage', label: tr('Gửi xác nhận'), position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📩 Yêu cầu của bạn đã được chuyển đến đội ngũ hỗ trợ. Chúng tôi sẽ phản hồi sớm nhất!\n\nThời gian xử lý dự kiến: 30 phút.') } },
      { id: 'n5', type: 'fb.action.addReaction', label: tr('Reaction ✅'), position: { x: 300, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '✅' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ━━━━━ FB 7. Create a poll in the group on a schedule ━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-weekly-poll',
    name: tr('FB: Bình chọn định kỳ trong nhóm'),
    description: tr('Vào mỗi thứ Hai hàng tuần, tự động tạo bình chọn (poll) trong nhóm Facebook để khảo sát ý kiến thành viên.'),
    category: 'quan-ly',
    tags: ['facebook', tr('bình chọn'), tr('nhóm'), tr('định kỳ'), tr('lịch')],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Thứ Hai 09:00'), position: { x: 250, y: 80 },
        config: { cronExpression: '0 9 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'fb.action.createPoll', label: tr('Tạo poll tuần này'), position: { x: 250, y: 240 },
        config: { ...DEFAULT_CONFIGS['fb.action.createPoll'], question: tr('📅 Chủ đề thảo luận tuần này?'), options: tr('Sản phẩm mới\nChăm sóc khách hàng\nMarketing\nKhác') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // ━━━━━ FB 8. Block spam ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-block-spam',
    name: tr('FB: Tự động chặn spam'),
    description: tr('Khi nhận tin nhắn chứa nội dung spam (link lạ, quảng cáo), tự động chặn người gửi trên Messenger và ghi log.'),
    category: 'quan-ly',
    tags: ['facebook', tr('chặn'), 'spam', tr('bảo mật'), tr('tự động')],
    icon: <ShieldIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có link lạ?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: 'http://, https://, bit.ly, t.me' } },
      { id: 'n3', type: 'fb.action.block', label: tr('Chặn người dùng'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.block'], userId: '{{ $trigger.fromId }}' } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log spam'), position: { x: 300, y: 520 },
        config: { message: tr('Đã chặn spam: {{ $trigger.fromName }} ({{ $trigger.fromId }}) — nội dung: {{ $trigger.content }}'), level: 'warning' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 9. Pin important messages ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-pin-important',
    name: tr('FB: Ghim tin nhắn quan trọng'),
    description: tr('Khi phát hiện tin nhắn chứa từ khoá "đơn hàng", "mã đơn" hoặc "order", tự động ghim tin nhắn đó trong hội thoại.'),
    category: 'ban-hang',
    tags: ['facebook', 'ghim', tr('quan trọng'), tr('đơn hàng'), tr('tự động')],
    icon: <PinIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Chứa mã đơn hàng?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('đơn hàng, mã đơn, order, #DH') } },
      { id: 'n3', type: 'fb.action.pin', label: tr('Ghim tin nhắn'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.pin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n4', type: 'fb.action.sendMessage', label: tr('Xác nhận đã ghim'), position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📌 Đã ghim tin nhắn chứa mã đơn hàng. Chúng tôi sẽ xử lý sớm nhất!') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // ━━━━━ FB 10. Multi-branch sales advice ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-sales-consultant',
    name: tr('FB: Tư vấn bán hàng đa nhánh'),
    description: tr('Phân loại tin nhắn theo ý định: hỏi giá → gửi bảng giá, muốn đặt hàng → gửi form, cần hỗ trợ → chuyển tiếp CSKH. Mỗi nhánh có reaction và theo dõi riêng.'),
    category: 'ban-hang',
    tags: ['facebook', tr('bán hàng'), tr('tư vấn'), tr('phân luồng'), 'CSKH'],
    icon: <ShoppingCartIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: tr('Đánh dấu đã đọc'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'fb.action.addReaction', label: tr('Thả reaction 👀'), position: { x: 350, y: 340 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '👀' } },
      { id: 'n4', type: 'logic.if', label: tr('Hỏi giá?'), position: { x: 350, y: 480 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('giá|bảng giá|bao nhiêu') } },
      { id: 'n5', type: 'fb.action.sendMessage', label: tr('Gửi bảng giá'), position: { x: 30, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📋 **Bảng giá sản phẩm:**\n\n🥇 Gói Cơ bản: 199k/tháng\n🥈 Gói Nâng cao: 399k/tháng\n🥉 Gói Pro: 799k/tháng\n\n💝 Đặt ngay hôm nay giảm thêm 10%!\n👉 Reply "ĐẶT" để mua ngay.') } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Xác nhận đặt hàng'), position: { x: 350, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🎉 Cảm ơn bạn đã quan tâm!\n\nĐể đặt hàng, bạn vui lòng cho mình biết:\n1️⃣ Sản phẩm/mã sp bạn muốn mua\n2️⃣ Số lượng\n3️⃣ Địa chỉ nhận hàng\n4️⃣ SĐT liên hệ\n\nMình sẽ báo giá & gửi link thanh toán ngay!') } },
      { id: 'n7', type: 'fb.action.forward', label: tr('Forward cho CSKH'), position: { x: 670, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n8', type: 'fb.action.sendMessage', label: tr('Trả lời mặc định'), position: { x: 350, y: 810 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('Xin chào! 👋\n\nMình có thể giúp gì cho bạn hôm nay?\n\n💬 Nhắn "GIÁ" để xem bảng giá\n📦 Nhắn "ĐẶT" để đặt hàng\n🆘 Nhắn "HỖ TRỢ" nếu cần giúp đỡ') } },
      { id: 'n9', type: 'logic.if', label: tr('Đặt hàng?'), position: { x: 350, y: 660 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('đặt|mua|order|ship') } },
      { id: 'n10', type: 'logic.if', label: tr('Cần hỗ trợ?'), position: { x: 350, y: 840 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('hỗ trợ|lỗi|không được') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
      { id: 'e5', source: 'n4', sourceHandle: 'false', target: 'n9' },
      { id: 'e6', source: 'n9', sourceHandle: 'true', target: 'n6' },
      { id: 'e7', source: 'n9', sourceHandle: 'false', target: 'n10' },
      { id: 'e8', source: 'n10', sourceHandle: 'true', target: 'n7' },
      { id: 'e9', source: 'n10', sourceHandle: 'false', target: 'n8' },
    ],
  },

  // ━━━━━ FB 11. Survey questions + AI response ━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-survey-feedback',
    name: tr('FB: Khảo sát ý kiến khách hàng + AI tổng hợp'),
    description: tr('Sau khi tương tác, gửi khảo sát NPS, nhận câu trả lời, dùng AI phân tích cảm xúc (tích cực/tiêu cực), phản hồi phù hợp và lưu log.'),
    category: 'marketing',
    tags: ['facebook', tr('khảo sát'), 'AI', tr('phản hồi'), 'NPS'],
    icon: <ClipboardListIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Tin nhắn sau CSKH'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: tr('Đánh dấu đã đọc'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'logic.if', label: tr('Khảo sát?'), position: { x: 300, y: 350 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('hài lòng, đánh giá, survey, NPS, feedback') } },
      { id: 'n4', type: 'ai.classify', label: tr('Phân loại cảm xúc'), position: { x: 300, y: 510 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], categories: [tr('tích cực'), tr('tiêu cực'), tr('trung lập')].join(', '), input: '{{ $trigger.content }}' } },
      { id: 'n5', type: 'logic.switch', label: tr('Theo cảm xúc'), position: { x: 300, y: 670 },
        config: { value: '{{ $node.n4.category }}', cases: [{ match: tr('tích cực'), label: 'VUI' }, { match: tr('tiêu cực'), label: tr('BUỒN') }], defaultLabel: tr('THƯỜNG') } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Cảm ơn (tích cực)'), position: { x: 30, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🥰 Cảm ơn bạn rất nhiều vì phản hồi tích cực! \n\nChúng tôi rất vui khi được phục vụ bạn. Hãy giới thiệu chúng tôi đến bạn bè nhé! ❤️') } },
      { id: 'n7', type: 'fb.action.sendMessage', label: tr('Xin lỗi (tiêu cực)'), position: { x: 300, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('😔 Chúng tôi rất tiếc vì trải nghiệm chưa tốt của bạn. \n\nCho mình thêm thông tin chi tiết để cải thiện nhé? Hoặc bạn có thể gọi hotline 1900xxxx để được hỗ trợ ngay.') } },
      { id: 'n8', type: 'fb.action.addReaction', label: tr('Reaction 💙'), position: { x: 570, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '💙' } },
      { id: 'n9', type: 'output.log', label: tr('Ghi log đánh giá'), position: { x: 300, y: 990 },
        config: { message: tr('Feedback từ {{ $trigger.fromName }}: {{ $trigger.content }} — cảm xúc: {{ $node.n4.output }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', sourceHandle: 'VUI', target: 'n6' },
      { id: 'e6', source: 'n5', sourceHandle: tr('BUỒN'), target: 'n7' },
      { id: 'e7', source: 'n5', sourceHandle: tr('THƯỜNG'), target: 'n8' },
      { id: 'e8', source: 'n8', target: 'n9' },
    ],
  },

  // ━━━━━ FB 12. Process orders with Set Variable + Log ━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-order-processor',
    name: tr('FB: Xử lý đơn hàng tự động'),
    description: tr('Khi khách gửi mã đơn hàng, lưu vào biến, kiểm tra trạng thái, tạo nội dung trả lời động bằng textFormat, gửi phản hồi và ghim để theo dõi.'),
    category: 'quan-ly',
    tags: ['facebook', tr('đơn hàng'), tr('xử lý'), tr('biến'), tr('tự động')],
    icon: <PackageIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có mã đơn?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: '#DH[0-9]+' } },
      { id: 'n3', type: 'logic.setVariable', label: tr('Lưu mã đơn'), position: { x: 300, y: 360 },
        config: { name: 'orderCode', value: '{{ $trigger.content }}' } },
      { id: 'n4', type: 'data.textFormat', label: tr('Soạn nội dung xác nhận'), position: { x: 300, y: 520 },
        config: { template: tr('✅ **Xác nhận đã nhận đơn hàng**\n\nMã đơn: {{ $var.orderCode }}\nKhách hàng: {{ $trigger.fromName }}\nThời gian: {{ $date.now }}\n\n📌 Đơn hàng đang được xử lý. Bạn sẽ nhận thông báo khi có cập nhật!') } },
      { id: 'n5', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Gửi xác nhận'), position: { x: 300, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n4.output }}' } },
      { id: 'n7', type: 'fb.action.pin', label: tr('Ghim tin nhắn'), position: { x: 300, y: 960 },
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

  // ━━━━━ FB 13. Call HTTP webhook + send the result ━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-webhook-notify',
    name: tr('FB: Webhook + thông báo kết quả'),
    description: tr('Khi nhận tin, gọi API bên ngoài (webhook CRM), kiểm tra kết quả trả về, rẽ nhánh nếu lỗi/thành công, gửi phản hồi kết quả cho khách.'),
    category: 'thong-bao',
    tags: ['facebook', 'webhook', 'API', 'HTTP', tr('thông báo')],
    icon: <LinkIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n3', type: 'output.httpRequest', label: tr('Gọi CRM API'), position: { x: 300, y: 360 },
        config: { method: 'POST', url: 'https://your-crm.com/api/check', headers: 'Content-Type: application/json\nAuthorization: Bearer YOUR_TOKEN', body: '{"senderId":"{{ $trigger.fromId }}","name":"{{ $trigger.fromName }}","message":"{{ $trigger.content }}"}', timeout: 10000 } },
      { id: 'n4', type: 'logic.if', label: tr('Thành công?'), position: { x: 300, y: 520 },
        config: { left: '{{ $node.n3.statusCode }}', operator: 'equals', right: '200' } },
      { id: 'n5', type: 'fb.action.sendMessage', label: tr('Thông báo OK'), position: { x: 80, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('✅ Đã cập nhật thông tin của bạn vào hệ thống CRM.\nMã tra cứu: {{ $node.n3.body }}') } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Thông báo lỗi'), position: { x: 520, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('❌ Rất tiếc, hệ thống đang gặp sự cố. Vui lòng thử lại sau hoặc liên hệ 1900xxxx.') } },
      { id: 'n7', type: 'output.log', label: tr('Ghi log webhook'), position: { x: 300, y: 840 },
        config: { message: tr('Webhook từ {{ $trigger.fromId }} — status: {{ $node.n3.statusCode }} — body: {{ $node.n3.body }}'), level: 'info' } },
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

  // ━━━━━ FB 14. Send product images + close the order ━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-image-catalog',
    name: tr('FB: Gửi ảnh catalogue + chốt đơn'),
    description: tr('Khi khách hỏi về sản phẩm, gửi ảnh kèm mô tả, dùng logic rẽ nhánh để hỏi màu sắc/size, gửi ảnh tương ứng, chốt đơn.'),
    category: 'ban-hang',
    tags: ['facebook', tr('ảnh'), 'catalogue', tr('bán hàng'), tr('chốt đơn')],
    icon: <ImageIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Hỏi sản phẩm'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n3', type: 'fb.action.markAsRead', label: tr('Đã đọc'), position: { x: 300, y: 350 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n4', type: 'logic.if', label: tr('Hỏi áo?'), position: { x: 300, y: 500 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('áo|t-shirt|t shirt|tee') } },
      { id: 'n5', type: 'fb.action.sendImage', label: tr('Gửi ảnh áo'), position: { x: 30, y: 670 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendImage'], filePath: '', message: tr('👕 **Áo thun Unisex**\n• Chất liệu: Cotton 100%\n• Màu: Trắng/Đen/Xanh\n• Giá: 199k\n\nReply "MUA" để đặt hàng!') } },
      { id: 'n6', type: 'fb.action.sendImage', label: tr('Gửi ảnh quần'), position: { x: 300, y: 670 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendImage'], filePath: '', message: tr('👖 **Quần Jeans Slim Fit**\n• Chất liệu: Denim cao cấp\n• Size: S/M/L/XL\n• Giá: 349k\n\nReply "MUA" để đặt hàng!') } },
      { id: 'n7', type: 'fb.action.sendMessage', label: tr('Gửi phụ kiện'), position: { x: 570, y: 670 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🧢 **Phụ kiện hot:**\n• Túi tote: 299k\n• Mũ lưỡi trai: 99k\n• Ví da: 199k\n\nBạn quan tâm món nào ạ?') } },
      { id: 'n8', type: 'fb.action.sendMessage', label: tr('Hướng dẫn'), position: { x: 300, y: 830 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('Xin chào! 👋 Cảm ơn bạn đã quan tâm.\n\n📌 Hiện shop có:\n👕 Áo thun — 199k\n👖 Quần Jeans — 349k\n🧢 Phụ kiện — từ 99k\n\nReply tên sản phẩm để xem ảnh và giá nhé!') } },
      { id: 'n9', type: 'fb.action.addReaction', label: tr('Reaction ❤️'), position: { x: 300, y: 970 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '❤️' } },
      { id: 'n10', type: 'logic.if', label: tr('Hỏi quần?'), position: { x: 300, y: 660 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('quần|jean|trousers') } },
      { id: 'n11', type: 'logic.if', label: tr('Hỏi phụ kiện?'), position: { x: 300, y: 820 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('phụ kiện|túi|mũ|ví') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
      { id: 'e5', source: 'n4', sourceHandle: 'false', target: 'n10' },
      { id: 'e6', source: 'n10', sourceHandle: 'true', target: 'n6' },
      { id: 'e7', source: 'n10', sourceHandle: 'false', target: 'n11' },
      { id: 'e8', source: 'n11', sourceHandle: 'true', target: 'n7' },
      { id: 'e9', source: 'n11', sourceHandle: 'false', target: 'n8' },
      { id: 'e10', source: 'n8', target: 'n9' },
    ],
  },

  // ━━━━━ FB 15. Automatic forward + pin + unpin ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-forward-resolve',
    name: tr('FB: Forward xử lý + bỏ ghim tự động'),
    description: tr('Khi khách báo đã xong, forward tin nhắn vào nhóm xử lý nội bộ, ghim để theo dõi, chờ xác nhận hoàn thành rồi tự động bỏ ghim.'),
    category: 'quan-ly',
    tags: ['facebook', 'forward', 'ghim', tr('xử lý'), tr('nội bộ')],
    icon: <RefreshIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Báo "xong" / "done"?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('xong, done, ok, cảm ơn, giải quyết') } },
      { id: 'n3', type: 'fb.action.unpin', label: tr('Bỏ ghim tin nhắn'), position: { x: 550, y: 370 },
        config: { ...DEFAULT_CONFIGS['fb.action.unpin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n4', type: 'fb.action.sendMessage', label: tr('Cảm ơn + bỏ ghim'), position: { x: 550, y: 520 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📌 Đã bỏ ghim. Cảm ơn bạn, mọi vấn đề đã được giải quyết! Nếu cần hỗ trợ thêm, bạn cứ nhắn mình nhé. 😊') } },
      { id: 'n5', type: 'logic.if', label: tr('Cần xử lý nội bộ?'), position: { x: 50, y: 370 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('cần hỗ trợ, giúp, fix, lỗi, problem') } },
      { id: 'n6', type: 'fb.action.forward', label: tr('Forward nội bộ'), position: { x: 50, y: 540 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n7', type: 'fb.action.pin', label: tr('Ghim để theo dõi'), position: { x: 50, y: 700 },
        config: { ...DEFAULT_CONFIGS['fb.action.pin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n8', type: 'fb.action.sendMessage', label: tr('Thông báo đã tiếp nhận'), position: { x: 50, y: 850 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📩 Yêu cầu của bạn đã được ghi nhận và chuyển đến team hỗ trợ. Chúng tôi sẽ giải quyết trong thời gian sớm nhất!\n\n📌 Tin nhắn đã được ghim để dễ theo dõi.') } },
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

  // ━━━━━ FB 16. Smart AI customer care ━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-ai-smart-care',
    name: tr('FB: AI chăm sóc khách hàng thông minh'),
    description: tr('Khi khách nhắn tin, AI phân loại cảm xúc (tích cực/tiêu cực/gấp), đánh dấu đã đọc, rẽ nhánh theo từng trạng thái — phản hồi phù hợp cho từng tình huống. Ghi log để phân tích sau.'),
    category: 'ai',
    tags: ['facebook', 'AI', tr('cảm xúc'), 'sentiment', tr('chăm sóc'), 'CSKH', tr('phân loại')],
    icon: <BrainIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: tr('Đánh dấu đã đọc'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'ai.classify', label: tr('Phân loại cảm xúc'), position: { x: 350, y: 360 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], categories: [tr('tích cực'), tr('tiêu cực'), tr('cần hỗ trợ gấp'), 'spam'].join(', '), input: '{{ $trigger.content }}' } },
      { id: 'n4', type: 'logic.switch', label: tr('Rẽ nhánh theo cảm xúc'), position: { x: 350, y: 520 },
        config: { value: '{{ $node.n3.category }}', cases: [{ match: tr('tích cực'), label: 'VUI' }, { match: tr('tiêu cực'), label: tr('BUỒN') }, { match: tr('cần hỗ trợ gấp'), label: tr('GẤP') }], defaultLabel: 'SPAM' } },
      { id: 'n5', type: 'fb.action.addReaction', label: tr('Reaction 😍'), position: { x: 30, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.addReaction'], messageId: '{{ $trigger.messageId }}', emoji: '😍' } },
      { id: 'n6', type: 'fb.action.sendTyping', label: tr('Đang gõ... (vui)'), position: { x: 30, y: 830 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n7', type: 'fb.action.sendMessage', label: tr('Trả lời tích cực'), position: { x: 30, y: 960 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🥰 Cảm ơn bạn rất nhiều vì tình cảm! \n\nChúng tôi luôn nỗ lực mang đến trải nghiệm tốt nhất. Bạn cần tụi mình hỗ trợ gì thêm không ạ? ❤️') } },
      { id: 'n8', type: 'fb.action.sendMessage', label: tr('Trả lời tiêu cực'), position: { x: 350, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('😔 Mình xin lỗi vì trải nghiệm không tốt của bạn. \n\nCho mình biết thêm chi tiết để khắc phục ngay nhé? Hoặc bạn gọi hotline 1900xxxx để được ưu tiên xử lý. Mình sẽ cải thiện ngay!') } },
      { id: 'n9', type: 'fb.action.forward', label: tr('Forward gấp cho CSKH'), position: { x: 670, y: 690 },
        config: { ...DEFAULT_CONFIGS['fb.action.forward'], messageId: '{{ $trigger.messageId }}', targetThreadId: '' } },
      { id: 'n10', type: 'fb.action.sendMessage', label: tr('Đã tiếp nhận gấp'), position: { x: 670, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🚨 Yêu cầu của bạn đã được chuyển đến team hỗ trợ khẩn cấp! Chúng tôi sẽ phản hồi trong vòng 5 phút.\n\nVui lòng chờ trong giây lát... ⏳') } },
      { id: 'n11', type: 'output.log', label: tr('Ghi log cảm xúc'), position: { x: 350, y: 1060 },
        config: { message: tr('[AI CARE] {{ $trigger.fromName }} ({{ $trigger.fromId }}) — cảm xúc: {{ $node.n3.output }} — nội dung: {{ $trigger.content }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'VUI', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
      { id: 'e7', source: 'n4', sourceHandle: tr('BUỒN'), target: 'n8' },
      { id: 'e8', source: 'n4', sourceHandle: tr('GẤP'), target: 'n9' },
      { id: 'e9', source: 'n9', target: 'n10' },
      { id: 'e10', source: 'n7', target: 'n11' },
      { id: 'e11', source: 'n8', target: 'n11' },
      { id: 'e12', source: 'n10', target: 'n11' },
    ],
  },

  // ━━━━━ FB 17. AI writes sales ad content ━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-ai-ad-copy',
    name: tr('FB: AI viết nội dung quảng cáo'),
    description: tr('Khi khách hỏi về sản phẩm, AI tự động soạn nội dung quảng cáo hấp dẫn, kèm emoji và kêu gọi hành động, lưu biến để dùng lại. Phù hợp cho page bán hàng mỹ phẩm, thời trang, F&B.'),
    category: 'ai',
    tags: ['facebook', 'AI', tr('quảng cáo'), 'content', 'marketing', tr('bán hàng')],
    icon: '✍️',
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Hỏi về sản phẩm'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có từ khoá sản phẩm?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('áo, quần, giày, túi, mỹ phẩm, đồ ăn, thức uống, combo') } },
      { id: 'n3', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n4', type: 'logic.setVariable', label: tr('Lưu câu hỏi gốc'), position: { x: 300, y: 510 },
        config: { name: 'userQuery', value: '{{ $trigger.content }}' } },
      { id: 'n5', type: 'ai.generateText', label: tr('AI soạn nội dung bán hàng'), position: { x: 300, y: 660 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Bạn là chuyên viên tư vấn bán hàng xuất sắc. Khách hàng hỏi: "{{ $var.userQuery }}". Hãy trả lời chuyên nghiệp, hấp dẫn:\n1. Giới thiệu sản phẩm nổi bật\n2. Nêu lợi ích & giá cả\n3. Kèm emoji phù hợp\n4. Kêu gọi hành động (Đặt ngay, Inbox để biết thêm)\nTrả lời bằng tiếng Việt, tự nhiên, thân thiện.' } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Gửi câu trả lời AI'), position: { x: 300, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n5.output }}' } },
      { id: 'n7', type: 'fb.action.addReaction', label: tr('Reaction 💛'), position: { x: 300, y: 960 },
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

  // ━━━━━ FB 18. AI suggests products by preference ━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-ai-product-recommend',
    name: tr('FB: AI gợi ý sản phẩm theo sở thích'),
    description: tr('AI phân tích tin nhắn của khách để hiểu sở thích, phân loại danh mục, từ đó gợi ý sản phẩm phù hợp. Có rẽ nhánh theo từng ngành hàng và ghim tin nhắn đề xuất.'),
    category: 'ai',
    tags: ['facebook', 'AI', tr('gợi ý'), tr('sản phẩm'), 'recommend', tr('bán hàng')],
    icon: <TargetIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khách hỏi gợi ý'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'fb.action.markAsRead', label: tr('Đã đọc'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.markAsRead'] } },
      { id: 'n3', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 350, y: 350 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n4', type: 'ai.classify', label: tr('Phân loại sở thích'), position: { x: 350, y: 510 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], categories: [tr('thời trang nam'), tr('thời trang nữ'), tr('mỹ phẩm'), tr('đồ ăn'), tr('đồ uống'), tr('công nghệ'), tr('khác')].join(', '), input: '{{ $trigger.content }}' } },
      { id: 'n5', type: 'logic.switch', label: tr('Chọn danh mục gợi ý'), position: { x: 350, y: 670 },
        config: { value: '{{ $node.n4.category }}', cases: [{ match: tr('thời trang nam'), label: 'NAM' }, { match: tr('thời trang nữ'), label: tr('NỮ') }, { match: tr('mỹ phẩm'), label: tr('MỸ PHẨM') }, { match: tr('đồ ăn'), label: tr('ĐỒ ĂN') }, { match: tr('đồ uống'), label: tr('ĐỒ UỐNG') }, { match: tr('công nghệ'), label: 'CN' }], defaultLabel: tr('KHÁC') } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Gợi ý thời trang nam'), position: { x: 30, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('👔 **Gợi ý cho bạn:**\n\n1️⃣ Áo sơ mi công sở — 299k\n2️⃣ Quần tây cao cấp — 399k\n3️⃣ Giày da lười — 599k\n4️⃣ Đồng hồ thể thao — 499k\n\n🔥 Combo "Dân công sở": Áo + Quần + Giày = 999k (tiết kiệm 298k)\n\n👉 Reply "MUA" để đặt hàng ngay!') } },
      { id: 'n7', type: 'fb.action.sendMessage', label: tr('Gợi ý thời trang nữ'), position: { x: 210, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('👗 **Gợi ý cho bạn:**\n\n1️⃣ Đầm suông công sở — 399k\n2️⃣ Chân váy bút chì — 299k\n3️⃣ Áo blouse — 249k\n4️⃣ Túi xách thời trang — 499k\n\n🔥 Bộ sưu tập Hè mới nhất — Giảm 20%\n\n👉 Reply "MUA" để xem chi tiết!') } },
      { id: 'n8', type: 'fb.action.sendMessage', label: tr('Gợi ý mỹ phẩm'), position: { x: 390, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('💄 **Gợi ý làm đẹp:**\n\n1️⃣ Kem chống nắng SPF50+ — 199k\n2️⃣ Serum Vitamin C — 349k\n3️⃣ Son môi lì — 149k\n4️⃣ Set skincare cơ bản — 499k\n\n✨ Tặng kèm mặt nạ khi mua set!\n\n👉 Reply "MUA" để đặt ngay!') } },
      { id: 'n9', type: 'fb.action.sendMessage', label: tr('Gợi ý đồ ăn'), position: { x: 570, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🍕 **Thực đơn hot hôm nay:**\n\n1️⃣ Burger bò phô mai — 89k\n2️⃣ Mỳ ý sốt bò bằm — 79k\n3️⃣ Pizza hải sản — 159k\n4️⃣ Salad Caesar — 59k\n\n🎁 Combo 2 người: 199k (tiết kiệm 49k)\n\n👉 Reply "ĐẶT" để giao hàng!') } },
      { id: 'n10', type: 'fb.action.sendMessage', label: tr('Gợi ý đồ uống'), position: { x: 750, y: 840 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('☕ **Thức uống hot trend:**\n\n1️⃣ Trà sữa trân châu — 39k\n2️⃣ Cà phê muối — 35k\n3️⃣ Matcha latte — 45k\n4️⃣ Nước ép cam — 30k\n\n🎉 Mua 2 tặng 1 (T2-T4 hàng tuần)\n\n👉 Reply "GỌI" để order giao tận nơi!') } },
      { id: 'n11', type: 'fb.action.sendMessage', label: tr('Gợi ý công nghệ'), position: { x: 350, y: 1000 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('📱 **Công nghệ bán chạy:**\n\n1️⃣ Tai nghe Bluetooth — 599k\n2️⃣ Sạc dự phòng 20000mAh — 399k\n3️⃣ Loa mini không dây — 499k\n4️⃣ Chuột gaming — 299k\n\n💥 Flash sale 12h: Giảm thêm 10%\n\n👉 Reply "MUA" để đặt cọc!') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', sourceHandle: 'NAM', target: 'n6' },
      { id: 'e6', source: 'n5', sourceHandle: tr('NỮ'), target: 'n7' },
      { id: 'e7', source: 'n5', sourceHandle: tr('MỸ PHẨM'), target: 'n8' },
      { id: 'e8', source: 'n5', sourceHandle: tr('ĐỒ ĂN'), target: 'n9' },
      { id: 'e9', source: 'n5', sourceHandle: tr('ĐỒ UỐNG'), target: 'n10' },
      { id: 'e10', source: 'n5', sourceHandle: 'CN', target: 'n11' },
    ],
  },

  // ━━━━━ FB 19. Confirm order + send payment link ━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-payment-confirm',
    name: tr('FB: Xác nhận đơn hàng & gửi link thanh toán'),
    description: tr('Khi khách xác nhận mua hàng, lưu thông tin đơn hàng vào biến, soạn nội dung xác nhận, gửi tin nhắn kèm link thanh toán, ghim hoá đơn và forward vào nhóm nội bộ.'),
    category: 'tich-hop',
    tags: ['facebook', tr('thanh toán'), tr('đơn hàng'), 'POS', tr('hoá đơn'), tr('chốt đơn')],
    icon: <CreditCardIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Khách nói "MUA"'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có ý định mua?'), position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('mua, đặt, order, thanh toán, chuyển khoản, mua ngay') } },
      { id: 'n3', type: 'logic.setVariable', label: tr('Lưu mã đơn hàng'), position: { x: 350, y: 360 },
        config: { name: 'orderId', value: 'DH{{ $trigger.timestamp }}' } },
      { id: 'n4', type: 'data.textFormat', label: tr('Soạn nội dung xác nhận'), position: { x: 350, y: 520 },
        config: { template: tr('✅ **XÁC NHẬN ĐƠN HÀNG**\n\n━━━━━━━━━━━━━━━━\n🧾 Mã đơn: {{ $var.orderId }}\n👤 Khách: {{ $trigger.fromName }}\n📱 ID: {{ $trigger.fromId }}\n📝 Nội dung: {{ $trigger.content }}\n⏰ Thời gian: {{ $date.now }}\n━━━━━━━━━━━━━━━━\n\n💳 **Vui lòng thanh toán:**\n• Chuyển khoản: 1903xxxxxx\n• Ngân hàng: Techcombank\n• Nội dung: {{ $var.orderId }}\n• Số tiền: (nhập số tiền)\n\n📸 Reply ảnh biên lai sau khi chuyển khoản!') } },
      { id: 'n5', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 350, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Gửi xác nhận + link TT'), position: { x: 350, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n4.output }}' } },
      { id: 'n7', type: 'fb.action.pin', label: tr('Ghim hoá đơn'), position: { x: 350, y: 960 },
        config: { ...DEFAULT_CONFIGS['fb.action.pin'], messageId: '{{ $trigger.messageId }}' } },
      { id: 'n8', type: 'output.httpRequest', label: tr('Gửi lên POS'), position: { x: 350, y: 1100 },
        config: { method: 'POST', url: 'https://your-pos.com/api/orders', headers: 'Content-Type: application/json\nAuthorization: Bearer POS_SECRET', body: '{"orderId":"{{ $var.orderId }}","customer":"{{ $trigger.fromName }}","customerId":"{{ $trigger.fromId }}","message":"{{ $trigger.content }}","channel":"facebook"}', timeout: 10000 } },
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

  // ━━━━━ FB 20. New product poll + AI analysis ━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-poll-ai-analysis',
    name: tr('FB: Bình chọn sản phẩm + AI phân tích'),
    description: tr('Tạo bình chọn trong nhóm Facebook để khảo sát sản phẩm yêu thích, AI tự động phân tích kết quả và gửi báo cáo vào nhóm. Chọn cùng một nhóm ở cả 3 bước Tạo bình chọn, Nhắc và Công bố.'),
    category: 'marketing',
    tags: ['facebook', tr('bình chọn'), 'poll', 'AI', tr('phân tích'), tr('khảo sát'), tr('nhóm')],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Lịch: 9h sáng thứ 2'), position: { x: 350, y: 50 },
        config: { cronExpression: '0 9 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'fb.action.createPoll', label: tr('Tạo bình chọn'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['fb.action.createPoll'], threadId: '', question: tr('🌟 Sản phẩm mới nào bạn thích nhất?'), options: tr('Áo thun họa tiết mới\nQuần jeans rách gối\nSet đồ đôi cặp\nTúi tote da bò\nKhác (comment bên dưới)') } },
      { id: 'n3', type: 'logic.wait', label: tr('Chờ 24h'), position: { x: 350, y: 360 },
        config: { delaySeconds: 86400 } },
      { id: 'n4', type: 'fb.action.sendMessage', label: tr('Nhắc bình chọn lần cuối'), position: { x: 350, y: 500 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], threadId: '', message: tr('⏰ **Còn 2h nữa là kết thúc bình chọn sản phẩm mới!**\n\n👉 Nếu bạn chưa bình chọn, hãy nhanh tay lên nhóm để vote ngay nhé! Kết quả sẽ được công bố vào tối nay. 🎉') } },
      { id: 'n5', type: 'logic.wait', label: tr('Chờ thêm 2h'), position: { x: 350, y: 640 },
        config: { delaySeconds: 7200 } },
      { id: 'n6', type: 'ai.generateText', label: tr('AI phân tích kết quả'), position: { x: 350, y: 790 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Bạn là chuyên gia phân tích dữ liệu. Cuộc bình chọn sản phẩm mới trong nhóm Facebook vừa kết thúc. Hãy tạo bài viết công bố kết quả hấp dẫn:\n\n🎉 Chào mừng kết quả\n🥇 Sản phẩm đứng nhất + cảm xúc\n📊 Tổng quan lượt vote\n💬 Lời kêu gọi (cảm ơn, hứa hẹn ra mắt)\n\nTrả lời bằng tiếng Việt, vui vẻ, kèm emoji.' } },
      { id: 'n7', type: 'fb.action.sendMessage', label: tr('Công bố kết quả'), position: { x: 350, y: 940 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], threadId: '', message: tr('📊 **KẾT QUẢ BÌNH CHỌN SẢN PHẨM MỚI** 🎉\n\n{{ $node.n6.output }}') } },
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

  // ━━━━━ FB 21. Automatic table / appointment booking ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-booking-auto',
    name: tr('FB: Đặt bàn / lịch hẹn tự động'),
    description: tr('Khi khách gửi tin nhắn đặt lịch (bàn nhà hàng, lịch hẹn spa, khám bệnh...), AI phân tích thông tin, xác nhận tự động, gửi nhắc lịch sau 1 giờ. Dành cho F&B, spa, phòng khám.'),
    category: 'tich-hop',
    tags: ['facebook', tr('đặt bàn'), tr('lịch hẹn'), 'F&B', 'spa', tr('nhà hàng'), 'POS'],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Tin đặt lịch'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có từ khoá đặt lịch?'), position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('đặt bàn, đặt lịch, book, hẹn, reservation, đặt chỗ') } },
      { id: 'n3', type: 'logic.setVariable', label: tr('Lưu mã đặt chỗ'), position: { x: 350, y: 360 },
        config: { name: 'bookingCode', value: 'BK{{ $trigger.timestamp }}' } },
      { id: 'n4', type: 'data.textFormat', label: tr('Soạn xác nhận đặt chỗ'), position: { x: 350, y: 520 },
        config: { template: tr('✅ **XÁC NHẬN ĐẶT CHỖ**\n━━━━━━━━━━━━━━\n📋 Mã đặt chỗ: {{ $var.bookingCode }}\n👤 Khách: {{ $trigger.fromName }}\n📝 Yêu cầu: {{ $trigger.content }}\n⏰ Xác nhận lúc: {{ $date.now }}\n━━━━━━━━━━━━━━\n\n📌 Vui lòng đến trước 15 phút. Liên hệ 1900xxxx nếu cần thay đổi.\n🔔 Chúng tôi sẽ nhắc bạn sau 1 giờ.') } },
      { id: 'n5', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 350, y: 680 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Gửi xác nhận'), position: { x: 350, y: 820 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: '{{ $node.n4.output }}' } },
      { id: 'n7', type: 'output.httpRequest', label: tr('Ghi lên POS/lịch'), position: { x: 350, y: 960 },
        config: { method: 'POST', url: 'https://your-pos.com/api/bookings', headers: 'Content-Type: application/json\nAuthorization: Bearer POS_KEY', body: '{"bookingId":"{{ $var.bookingCode }}","customer":"{{ $trigger.fromName }}","customerId":"{{ $trigger.fromId }}","request":"{{ $trigger.content }}","channel":"facebook"}', timeout: 10000 } },
      { id: 'n8', type: 'logic.wait', label: tr('Chờ 1 giờ nhắc lịch'), position: { x: 350, y: 1100 },
        config: { delaySeconds: 3600 } },
      { id: 'n9', type: 'fb.action.sendMessage', label: tr('Nhắc lịch hẹn'), position: { x: 350, y: 1240 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('⏰ **NHẮC LỊCH HẸN**\n\nXin chào {{ $trigger.fromName }}! 👋\n\nĐây là lời nhắc từ chúng tôi về lịch hẹn của bạn:\n📋 Mã: {{ $var.bookingCode }}\n📝 Nội dung: {{ $trigger.content }}\n\n🚗 Nếu bạn cần thay đổi hoặc huỷ, vui lòng reply tin nhắn này hoặc gọi 1900xxxx trước 30 phút.\n\nHân hạnh phục vụ bạn! ❤️') } },
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

  // ━━━━━ FB 22. Send discount codes + track orders ━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: 'tpl-fb-discount-track',
    name: tr('FB: Gửi mã giảm giá & theo dõi đơn hàng'),
    description: tr('Khi khách yêu cầu mã giảm giá, chọn ngẫu nhiên từ danh sách ưu đãi, lưu mã vào biến, gửi kèm hướng dẫn sử dụng. Tích hợp webhook POS để ghi nhận lượt phát mã.'),
    category: 'ban-hang',
    tags: ['facebook', tr('mã giảm giá'), tr('khuyến mãi'), tr('ưu đãi'), tr('theo dõi'), 'POS'],
    icon: <GiftIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'facebook',
    nodes: [
      { id: 'n1', type: 'fb.trigger.message', label: tr('Hỏi mã giảm giá'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['fb.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Yêu cầu mã giảm?'), position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('giảm giá, mã giảm, voucher, coupon, khuyến mãi, ưu đãi, sale, discount') } },
      { id: 'n3', type: 'data.randomPick', label: tr('Chọn mã giảm ngẫu nhiên'), position: { x: 350, y: 360 },
        config: { options: tr('SALE15 — Giảm 15% đơn từ 500k\nSALE20 — Giảm 20% đơn từ 1tr\nFREESHIP — Miễn phí vận chuyển\nWELCOME10 — Giảm 10k cho khách mới\nCOMBO30 — Giảm 30k set combo') } },
      { id: 'n4', type: 'logic.setVariable', label: tr('Lưu mã đã gửi'), position: { x: 350, y: 510 },
        config: { name: 'sentVoucher', value: '{{ $node.n3.output }}' } },
      { id: 'n5', type: 'fb.action.sendTyping', label: tr('Đang gõ...'), position: { x: 350, y: 660 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendTyping'] } },
      { id: 'n6', type: 'fb.action.sendMessage', label: tr('Gửi mã giảm giá'), position: { x: 350, y: 800 },
        config: { ...DEFAULT_CONFIGS['fb.action.sendMessage'], message: tr('🎉 **MÃ GIẢM GIÁ ĐẶC BIỆT DÀNH CHO BẠN!**\n\n━━━━━━━━━━━━━━━━\n🔖 Mã: **{{ $var.sentVoucher }}**\n━━━━━━━━━━━━━━━━\n\n📌 **Hướng dẫn:**\n1️⃣ Nhắn "MUA" để chọn sản phẩm\n2️⃣ Nhập mã ở phần ghi chú đơn hàng\n3️⃣ Hoặc gửi lại mã này khi thanh toán\n\n⏳ Mã có hiệu lực đến hết tháng này!\n👉 Nhanh tay kẻo lỡ ưu đãi bạn nhé! 🔥') } },
      { id: 'n7', type: 'output.httpRequest', label: tr('Ghi nhận lên POS'), position: { x: 350, y: 950 },
        config: { method: 'POST', url: 'https://your-pos.com/api/vouchers/claim', headers: 'Content-Type: application/json\nAuthorization: Bearer POS_KEY', body: '{"voucher":"{{ $var.sentVoucher }}","customerId":"{{ $trigger.fromId }}","customerName":"{{ $trigger.fromName }}","channel":"facebook"}', timeout: 10000 } },
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

  // 14. Webhook with an account → send a Zalo message
  {
    id: 'tpl-webhook-account-send',
    name: tr('Webhook có tài khoản → Gửi tin nhắn Zalo'),
    description: tr('Nhận webhook với threadId (người nhận), message (nội dung) và accountId (tài khoản Zalo gửi). Validate params trước khi gửi, nếu thiếu sẽ báo lỗi.'),
    category: 'webhook',
    tags: ['webhook', 'API', tr('tích hợp'), tr('gửi tin'), tr('tài khoản')],
    icon: <SendIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    nodes: [
      { id: 'n1', type: 'trigger.webhook', label: tr('Webhook bên ngoài'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.webhook'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có đủ params không?'), position: { x: 300, y: 220 },
        config: { left: '{{ $trigger.body.threadId }}', operator: 'equals', right: '' } },
      { id: 'n3', type: 'zalo.sendMessage', label: tr('Gửi tin nhắn'), position: { x: 150, y: 400 },
        config: { threadId: '{{ $trigger.body.threadId }}', threadType: '0', message: '{{ $trigger.body.message }}' } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log thành công'), position: { x: 150, y: 570 },
        config: { message: tr('Đã gửi tin qua acc đến threadId: {{ $trigger.body.threadId }}, nội dung: {{ $trigger.body.message }}'), level: 'info' } },
      { id: 'n5', type: 'output.log', label: tr('Ghi log lỗi'), position: { x: 500, y: 400 },
        config: { message: tr('Webhook thiếu params: threadId={{ $trigger.body.threadId }}'), level: 'error' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'false', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n2', sourceHandle: 'true', target: 'n5' },
    ],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TELEGRAM TEMPLATES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // TG-1. Auto-reply to Telegram messages
  {
    id: 'tpl-tg-auto-reply',
    name: tr('Tự động trả lời tin nhắn Telegram'),
    description: tr('Khi nhận tin nhắn mới trên Telegram, tự động gửi lại câu trả lời. Phù hợp làm thông báo "đã nhận tin" hoặc CSKH cơ bản.'),
    category: 'ban-hang',
    tags: ['telegram', tr('trả lời'), tr('tự động'), tr('cơ bản')],
    icon: <ChatIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn Telegram'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'tg.sendMessage', label: tr('Gửi câu trả lời'), position: { x: 300, y: 250 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Cảm ơn bạn đã nhắn tin! Mình sẽ phản hồi trong thời gian sớm nhất 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // TG-2. Reply by Telegram keyword
  {
    id: 'tpl-tg-keyword-reply',
    name: tr('Trả lời theo từ khoá (Telegram)'),
    description: tr('Phân nhánh theo nội dung tin nhắn Telegram: "giá" → bảng giá, "địa chỉ" → vị trí, còn lại → trả lời mặc định.'),
    category: 'ban-hang',
    tags: ['telegram', tr('từ khoá'), tr('rẽ nhánh'), 'CSKH'],
    icon: <KeyIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có chứa "giá"?'), position: { x: 350, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('giá') } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi bảng giá'), position: { x: 100, y: 380 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('📋 Bảng giá sản phẩm:\n\n• Gói A: 199k/tháng\n• Gói B: 399k/tháng\n• Gói C: 799k/tháng\n\nBạn quan tâm gói nào ạ?') } },
      { id: 'n4', type: 'logic.if', label: tr('Có chứa "địa chỉ"?'), position: { x: 600, y: 380 },
        config: { left: '{{ $trigger.content }}', operator: 'contains', right: tr('địa chỉ') } },
      { id: 'n5', type: 'tg.sendMessage', label: tr('Gửi địa chỉ'), position: { x: 400, y: 560 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('📍 Địa chỉ cửa hàng:\n123 Nguyễn Huệ, Q.1, TP.HCM\n\n⏰ Giờ mở cửa: 8h - 21h hàng ngày') } },
      { id: 'n6', type: 'tg.sendMessage', label: tr('Trả lời mặc định'), position: { x: 750, y: 560 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Cảm ơn bạn đã liên hệ! Nhắn "giá" để xem bảng giá, hoặc "địa chỉ" để biết nơi mua hàng nhé 😊') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'false', target: 'n4' },
      { id: 'e4', source: 'n4', sourceHandle: 'true', target: 'n5' },
      { id: 'e5', source: 'n4', sourceHandle: 'false', target: 'n6' },
    ],
  },

  // TG-3. Welcome new members joining a Telegram group
  {
    id: 'tpl-tg-group-welcome',
    name: tr('Chào mừng thành viên mới (Telegram)'),
    description: tr('Khi có thành viên mới vào nhóm Telegram, tự động gửi lời chào trong nhóm.'),
    category: 'quan-ly',
    tags: ['telegram', tr('nhóm'), tr('chào mừng'), tr('tự động')],
    icon: <WaveIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.groupEvent', label: tr('Thành viên mới vào nhóm'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.groupEvent'], eventType: 'member_join' } },
      { id: 'n2', type: 'tg.sendMessage', label: tr('Chào mừng'), position: { x: 300, y: 250 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('👋 Chào mừng {{ $trigger.fromName }} đã tham gia nhóm!\n\nNếu cần hỗ trợ, hãy nhắn tin trực tiếp nhé.') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // TG-4. Forward important messages to a Telegram Bot
  {
    id: 'tpl-tg-forward-alert',
    name: tr('Chuyển tiếp tin khẩn cấp → Telegram Bot'),
    description: tr('Lọc tin nhắn Telegram chứa từ khoá quan trọng ("gấp", "khiếu nại"...) rồi chuyển tiếp sang kênh Telegram Bot để đội ngũ xử lý.'),
    category: 'thong-bao',
    tags: ['telegram', tr('chuyển tiếp'), tr('thông báo'), tr('khẩn cấp')],
    icon: <SmartphoneIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'gấp,khẩn,khiếu nại', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn nội dung thông báo'), position: { x: 300, y: 220 },
        config: { template: tr('🚨 TIN NHẮN QUAN TRỌNG\n\n👤 Từ: {{ $trigger.fromName }}\n💬 Nội dung: {{ $trigger.content }}\n⏰ Lúc: {{ $trigger.timestamp }}') } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi thông báo'), position: { x: 300, y: 380 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], chatId: '', message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // TG-5. Classify messages with AI (Telegram)
  {
    id: 'tpl-tg-ai-classify',
    name: tr('Phân loại tin nhắn Telegram bằng AI'),
    description: tr('Dùng AI phân loại tin nhắn Telegram thành các nhóm (hỏi giá, đặt hàng, khiếu nại...) rồi trả lời tự động.'),
    category: 'ai',
    tags: ['telegram', 'AI', tr('phân loại'), tr('tự động')],
    icon: <BrainIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'ai.classify', label: tr('AI phân loại'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], input: '{{ $trigger.content }}', categories: [tr('hỏi giá'), tr('đặt hàng'), tr('khiếu nại'), tr('hỗ trợ'), tr('khác')].join(', ') } },
      { id: 'n3', type: 'logic.switch', label: tr('Xử lý theo loại'), position: { x: 350, y: 380 },
        config: { value: '{{ $node.n2.category }}', cases: [{ match: tr('hỏi giá'), label: tr('hỏi giá') }, { match: tr('đặt hàng'), label: tr('đặt hàng') }, { match: tr('khiếu nại'), label: tr('khiếu nại') }], defaultLabel: tr('khác') } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Trả lời hỏi giá'), position: { x: 50, y: 560 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('💰 Dạ đây là bảng giá của shop:\n• Sản phẩm A: 199k\n• Sản phẩm B: 299k\nBạn quan tâm sản phẩm nào ạ?') } },
      { id: 'n5', type: 'tg.sendMessage', label: tr('Trả lời đặt hàng'), position: { x: 250, y: 560 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('🛒 Dạ shop đã ghi nhận yêu cầu đặt hàng. Bạn vui lòng cung cấp:\n1. Tên sản phẩm\n2. Số lượng\n3. Địa chỉ giao hàng') } },
      { id: 'n6', type: 'tg.sendMessage', label: tr('Trả lời khiếu nại'), position: { x: 450, y: 560 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('😔 Dạ shop rất tiếc về trải nghiệm của bạn. Vui lòng mô tả chi tiết vấn đề để shop hỗ trợ kịp thời nhé!') } },
      { id: 'n7', type: 'tg.sendMessage', label: tr('Trả lời mặc định'), position: { x: 650, y: 560 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Cảm ơn bạn đã liên hệ! Shop sẽ phản hồi trong thời gian sớm nhất 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: tr('hỏi giá'), target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: tr('đặt hàng'), target: 'n5' },
      { id: 'e5', source: 'n3', sourceHandle: tr('khiếu nại'), target: 'n6' },
      { id: 'e6', source: 'n3', sourceHandle: tr('khác'), target: 'n7' },
    ],
  },

  // TG-6. Send product file / catalog
  {
    id: 'tpl-tg-send-catalog',
    name: tr('Gửi catalog sản phẩm (Telegram)'),
    description: tr('Khi khách nhắn "catalog" hoặc "menu", tự động gửi file PDF catalog sản phẩm qua Telegram.'),
    category: 'ban-hang',
    tags: ['telegram', 'catalog', 'file', tr('bán hàng')],
    icon: <FileTextIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'catalog,menu,sản phẩm', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'tg.sendFile', label: tr('Gửi catalog PDF'), position: { x: 300, y: 250 },
        config: { ...DEFAULT_CONFIGS['tg.sendFile'], filePath: '', caption: tr('📦 Đây là catalog sản phẩm mới nhất của shop!') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // TG-7. Poll in a Telegram group
  {
    id: 'tpl-tg-group-poll',
    name: tr('Tạo bình chọn trong nhóm (Telegram)'),
    description: tr('Tạo cuộc bình chọn (poll) trong nhóm Telegram theo lịch hoặc khi nhận lệnh.'),
    category: 'quan-ly',
    tags: ['telegram', 'poll', tr('bình chọn'), tr('nhóm')],
    icon: <TargetIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Chạy theo lịch'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.schedule'], cronExpression: '0 9 * * 1' } },
      { id: 'n2', type: 'tg.sendPoll', label: tr('Tạo bình chọn'), position: { x: 300, y: 250 },
        config: { ...DEFAULT_CONFIGS['tg.sendPoll'], chatId: '', question: tr('Bạn thích sản phẩm nào nhất tuần này?'), options: tr('Sản phẩm A\nSản phẩm B\nSản phẩm C') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // TG-8. Pin important messages
  {
    id: 'tpl-tg-pin-important',
    name: tr('Tự động ghim tin nhắn quan trọng (Telegram)'),
    description: tr('Khi nhận tin nhắn chứa từ khoá quan trọng ("thông báo", "quy định"...), tự động ghim trong hội thoại Telegram.'),
    category: 'quan-ly',
    tags: ['telegram', 'ghim', tr('quản lý'), tr('tự động')],
    icon: <PinIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'thông báo,quy định,quan trọng', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'tg.pinMessage', label: tr('Ghim tin nhắn'), position: { x: 300, y: 250 },
        config: { ...DEFAULT_CONFIGS['tg.pinMessage'] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // TG-9. Daily report via Telegram
  {
    id: 'tpl-tg-daily-report',
    name: tr('Báo cáo hàng ngày qua Telegram'),
    description: tr('Mỗi ngày gửi báo cáo tóm tắt qua Telegram. Có thể kết nối với Google Sheets để lấy dữ liệu.'),
    category: 'thong-bao',
    tags: ['telegram', tr('báo cáo'), tr('lịch'), tr('hàng ngày')],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('Chạy hàng ngày'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['trigger.schedule'], cronExpression: '0 18 * * *' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn báo cáo'), position: { x: 300, y: 250 },
        config: { template: tr('📊 BÁO CÁO NGÀY {{ $date.today }}\n\n✅ Công việc hoàn thành: ...\n⏳ Đang xử lý: ...\n📌 Kế hoạch ngày mai: ...') } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi báo cáo'), position: { x: 300, y: 420 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], chatId: '', message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // TG-10. AI sales assistant on Telegram
  {
    id: 'tpl-tg-ai-sales',
    name: tr('AI trợ lý bán hàng (Telegram)'),
    description: tr('Dùng AI trả lời câu hỏi khách hàng trên Telegram. AI sẽ tư vấn sản phẩm dựa trên nội dung tin nhắn.'),
    category: 'ai',
    tags: ['telegram', 'AI', tr('tư vấn'), tr('bán hàng')],
    icon: <BotIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'ai.generateText', label: tr('AI tư vấn'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Bạn là trợ lý tư vấn bán hàng chuyên nghiệp. Trả lời ngắn gọn, thân thiện, bằng tiếng Việt. Nếu khách hỏi giá, gợi ý sản phẩm phù hợp.\n\nTin nhắn của khách: {{ $trigger.content }}' } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi trả lời AI'), position: { x: 350, y: 380 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // TG-11. Block spam in a Telegram group
  {
    id: 'tpl-tg-block-spam',
    name: tr('Chặn spam trong nhóm (Telegram)'),
    description: tr('Tự động ban thành viên gửi tin nhắn chứa từ khoá spam ("casino", "crypto", "kiếm tiền online"...).'),
    category: 'quan-ly',
    tags: ['telegram', 'spam', 'ban', tr('nhóm'), tr('an toàn')],
    icon: <ShieldIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn nhóm'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'casino,crypto,kiếm tiền online,đầu tư', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'tg.deleteMessage', label: tr('Xóa tin nhắn spam'), position: { x: 300, y: 250 },
        config: { ...DEFAULT_CONFIGS['tg.deleteMessage'] } },
      { id: 'n3', type: 'tg.banMember', label: tr('Ban thành viên'), position: { x: 300, y: 420 },
        config: { ...DEFAULT_CONFIGS['tg.banMember'] } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Thông báo nhóm'), position: { x: 300, y: 590 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('🚫 Đã xóa tin nhắn spam và ban thành viên vi phạm.') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // TG-12. Webhook → send a Telegram message
  {
    id: 'tpl-tg-webhook-send',
    name: tr('Webhook → Gửi tin nhắn Telegram'),
    description: tr('Nhận dữ liệu từ webhook bên ngoài (POS, CRM...) rồi gửi tin nhắn Telegram đến người nhận được chỉ định.'),
    category: 'webhook',
    tags: ['telegram', 'webhook', 'API', tr('tích hợp')],
    icon: <LinkIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'trigger.webhook', label: tr('Webhook bên ngoài'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['trigger.webhook'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có chatId không?'), position: { x: 300, y: 220 },
        config: { left: '{{ $trigger.body.chatId }}', operator: 'equals', right: '' } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi tin Telegram'), position: { x: 150, y: 400 },
        config: { chatId: '{{ $trigger.body.chatId }}', message: '{{ $trigger.body.message }}' } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log lỗi'), position: { x: 500, y: 400 },
        config: { message: tr('Webhook thiếu chatId'), level: 'error' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'false', target: 'n3' },
      { id: 'e3', source: 'n2', sourceHandle: 'true', target: 'n4' },
    ],
  },

  // TG-13. Log orders to Google Sheets (Telegram)
  {
    id: 'tpl-tg-order-to-sheets',
    name: tr('TG: Ghi đơn hàng vào Google Sheets'),
    description: tr('Khi nhận tin nhắn Telegram chứa "đặt hàng", tự động ghi thông tin vào Google Sheets và xác nhận đơn.'),
    category: 'quan-ly',
    tags: ['telegram', 'Google Sheets', tr('đơn hàng'), 'CRM'],
    icon: <ChartIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận "đặt hàng"'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'đặt hàng,mua hàng,order', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Chuẩn bị dữ liệu'), position: { x: 300, y: 200 },
        config: { template: '{{ $trigger.fromName }}\t{{ $trigger.content }}\t{{ $trigger.chatId }}\t{{ $trigger.timestamp }}' } },
      { id: 'n3', type: 'sheets.appendRow', label: tr('Ghi vào Google Sheets'), position: { x: 300, y: 360 },
        config: { spreadsheetId: '', sheetName: tr('Đơn hàng'), values: '{{ $node.n2.output }}', serviceAccountPath: '' } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Xác nhận đơn hàng'), position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('✅ Đã nhận đơn hàng của bạn!\n\nMình sẽ xác nhận và liên hệ lại trong 15 phút nhé. Cảm ơn bạn! 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // TG-14. Auto reaction + thank you when reacted to (Telegram)
  {
    id: 'tpl-tg-reaction-thanks',
    name: tr('TG: Tự động cảm ơn khi được react'),
    description: tr('Khi ai đó react tin nhắn Telegram của bạn, tự động gửi lời cảm ơn ngẫu nhiên.'),
    category: 'marketing',
    tags: ['telegram', 'react', tr('cảm ơn'), tr('tương tác')],
    icon: '❤️',
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 80 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'tg.addReaction', label: tr('Thả ❤️ reaction'), position: { x: 300, y: 230 },
        config: { ...DEFAULT_CONFIGS['tg.addReaction'], emoji: '❤️' } },
      { id: 'n3', type: 'data.randomPick', label: tr('Chọn câu cảm ơn'), position: { x: 300, y: 380 },
        config: { options: tr('Cảm ơn bạn nhé! 😊\nThank you! 🙏\nVui quá, cảm ơn bạn! ❤️\nCảm ơn bạn đã quan tâm! 🌟') } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Gửi lời cảm ơn'), position: { x: 300, y: 530 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // TG-15. Bulk send from Google Sheets (Telegram)
  {
    id: 'tpl-tg-bulk-sheets',
    name: tr('TG: Gửi tin ưu đãi vào nhóm'),
    description: tr('Soạn tin ưu đãi và gửi vào nhóm/chat Telegram khi bạn chạy thủ công. Chọn nhóm nhận tin trong cài đặt node "Gửi tin".'),
    category: 'marketing',
    tags: ['telegram', tr('ưu đãi'), 'marketing', tr('nhóm')],
    icon: <SendIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'trigger.manual', label: tr('Chạy thủ công'), position: { x: 300, y: 50 },
        config: {} },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn tin'), position: { x: 300, y: 200 },
        config: { template: tr('Xin chào! 👋\n\n🎁 Chúng tôi có chương trình ưu đãi đặc biệt dành riêng cho bạn. Nhắn "ưu đãi" để biết thêm chi tiết nhé!') } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi tin vào nhóm'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], chatId: '', message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // TG-16. Multi-channel alerts: Telegram → Discord + Email
  {
    id: 'tpl-tg-multi-notify',
    name: tr('TG: Thông báo đa kênh (Discord + Email)'),
    description: tr('Nhận tin nhắn Telegram quan trọng, đồng thời gửi thông báo vào Discord Webhook và Email.'),
    category: 'thong-bao',
    tags: ['telegram', 'discord', 'email', tr('đa kênh')],
    icon: <BellIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'quan trọng,gấp,khiếu nại', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn nội dung'), position: { x: 300, y: 200 },
        config: { template: tr('📩 Tin nhắn quan trọng từ {{ $trigger.fromName }}:\n{{ $trigger.content }}') } },
      { id: 'n3', type: 'notify.discord', label: tr('Gửi vào Discord'), position: { x: 100, y: 380 },
        config: { webhookUrl: '', message: '{{ $node.n2.output }}', username: 'Telegram Alert' } },
      { id: 'n4', type: 'notify.email', label: tr('Gửi Email'), position: { x: 500, y: 380 },
        config: { ...DEFAULT_CONFIGS['notify.email'], subject: tr('🚨 Tin nhắn khẩn từ Telegram'), body: '{{ $node.n2.output }}' } },
      { id: 'n5', type: 'tg.sendMessage', label: tr('Phản hồi khách'), position: { x: 300, y: 560 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Cảm ơn bạn! Mình đã nhận tin và sẽ phản hồi sớm nhất 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n2', target: 'n4' },
      { id: 'e4', source: 'n2', target: 'n5' },
    ],
  },

  // TG-17. Auto-reply outside working hours (Telegram)
  {
    id: 'tpl-tg-off-hours',
    name: tr('TG: Trả lời tự động ngoài giờ'),
    description: tr('Tự động phát hiện tin nhắn Telegram ngoài giờ hành chính (sau 18h) và gửi thông báo sẽ phản hồi ngày hôm sau.'),
    category: 'ban-hang',
    tags: ['telegram', tr('ngoài giờ'), 'CSKH', tr('tự động')],
    icon: <MinimizeIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], ignoreOwn: true } },
      { id: 'n2', type: 'data.dateFormat', label: tr('Lấy giờ hiện tại'), position: { x: 300, y: 200 },
        config: { format: 'time' } },
      { id: 'n3', type: 'logic.if', label: tr('Ngoài giờ làm việc?'), position: { x: 300, y: 350 },
        config: { left: '{{ $node.n2.output }}', operator: 'greater_than', right: '18:00' } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Thông báo ngoài giờ'), position: { x: 100, y: 520 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('🌙 Xin chào! Hiện tại đã ngoài giờ làm việc.\n\n⏰ Giờ hỗ trợ: 8h - 18h (T2 - T7)\n\nMình sẽ phản hồi bạn sớm nhất vào ngày làm việc tiếp theo nhé! 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
    ],
  },

  // TG-18. After-sales care (Telegram)
  {
    id: 'tpl-tg-post-purchase',
    name: tr('TG: Chăm sóc sau mua hàng (2 ngày)'),
    description: tr('Gõ #damua vào hội thoại của khách (tin của bạn), sau 2 ngày tự gửi tin hỏi thăm trải nghiệm sản phẩm.'),
    category: 'ban-hang',
    tags: ['telegram', tr('chăm sóc'), 'sau mua', 'follow-up'],
    icon: <GiftIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi bạn gõ #damua cho khách'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: '#damua', keywordMode: 'starts_with', ignoreOwn: false } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 2 ngày'), position: { x: 300, y: 210 },
        config: { delaySeconds: 172800 } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi tin hỏi thăm'), position: { x: 300, y: 370 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Xin chào! 😊\n\nMình muốn hỏi thăm bạn đã nhận được hàng chưa ạ? Sản phẩm dùng có ổn không?\n\nNếu cần hỗ trợ gì, cứ nhắn mình nhé! 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // TG-19. Follow up after 4 hours without a reply (Telegram)
  {
    id: 'tpl-tg-followup-4h',
    name: tr('TG: Follow-up sau 4 giờ chưa phản hồi'),
    description: tr('Khi gắn nhãn "Chờ phản hồi" trên Telegram, chờ 4 giờ rồi tự động gửi tin nhắc nhở nhẹ nhàng.'),
    category: 'ban-hang',
    tags: ['telegram', 'follow-up', tr('nhắc nhở'), tr('4 giờ')],
    icon: '⏳',
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi bạn gõ #cho cho khách'), position: { x: 300, y: 60 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: '#cho', keywordMode: 'starts_with', ignoreOwn: false } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 4 giờ'), position: { x: 300, y: 210 },
        config: { delaySeconds: 14400 } },
      { id: 'n3', type: 'data.randomPick', label: tr('Chọn câu nhắc'), position: { x: 300, y: 360 },
        config: { options: tr('Chào bạn! Mình gửi tin nhắn trước đó, không biết bạn đã xem chưa ạ? 😊\nHi bạn! Mình muốn hỏi thăm, bạn có cần tư vấn thêm không ạ? 🙏\nBạn ơi, mình vẫn sẵn sàng hỗ trợ bạn nếu cần nhé! 💪') } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Gửi tin follow-up'), position: { x: 300, y: 510 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // TG-20. 3-step care sequence (Telegram)
  {
    id: 'tpl-tg-nurture-3step',
    name: tr('TG: Chuỗi chăm sóc 3 bước (1h → 1 ngày → 3 ngày)'),
    description: tr('Khi gắn nhãn "Khách mới" trên Telegram, tự động gửi 3 tin nhắn chăm sóc theo lịch.'),
    category: 'ban-hang',
    tags: ['telegram', tr('chuỗi'), 'nurturing', tr('3 bước'), 'drip'],
    icon: <InboxIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi bạn gõ #khachmoi cho khách'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: '#khachmoi', keywordMode: 'starts_with', ignoreOwn: false } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 1 giờ'), position: { x: 300, y: 180 },
        config: { delaySeconds: 3600 } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('📩 Bước 1: Chào & giới thiệu'), position: { x: 300, y: 310 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Chào bạn! 👋\n\nCảm ơn bạn đã quan tâm đến sản phẩm của mình. Mình xin giới thiệu nhanh:\n\n✅ Sản phẩm chất lượng cao\n✅ Giá cả hợp lý\n✅ Hỗ trợ 24/7\n\nBạn muốn tìm hiểu thêm về sản phẩm nào ạ?') } },
      { id: 'n4', type: 'logic.wait', label: tr('Chờ 1 ngày'), position: { x: 300, y: 450 },
        config: { delaySeconds: 86400 } },
      { id: 'n5', type: 'tg.sendMessage', label: tr('📩 Bước 2: Chia sẻ giá trị'), position: { x: 300, y: 580 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Hi bạn! 😊\n\n📖 Mình muốn chia sẻ thêm:\n\n🔹 Hơn 1000+ khách hàng hài lòng\n🔹 Đánh giá 5⭐ trên các nền tảng\n🔹 Chính sách đổi trả 30 ngày\n\nBạn có câu hỏi gì không?') } },
      { id: 'n6', type: 'logic.wait', label: tr('Chờ 3 ngày'), position: { x: 300, y: 720 },
        config: { delaySeconds: 259200 } },
      { id: 'n7', type: 'tg.sendMessage', label: tr('📩 Bước 3: Ưu đãi đặc biệt'), position: { x: 300, y: 860 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('🎉 Tin vui dành riêng cho bạn!\n\n🎁 Ưu đãi GIẢM 20% cho đơn hàng đầu tiên!\n⏰ Chỉ áp dụng trong 48 giờ tới\n\n👉 Nhắn "ĐẶT HÀNG" để mình hỗ trợ ngay nhé!') } },
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

  // TG-21. Multi-branch sales advice (Telegram)
  {
    id: 'tpl-tg-sales-consultant',
    name: tr('TG: Tư vấn bán hàng đa nhánh'),
    description: tr('Phân loại tin nhắn Telegram: hỏi giá → bảng giá, muốn đặt → form đặt hàng, cần hỗ trợ → chuyển tiếp CSKH.'),
    category: 'ban-hang',
    tags: ['telegram', tr('bán hàng'), tr('tư vấn'), tr('phân luồng'), 'CSKH'],
    icon: <ShoppingCartIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 350, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'tg.addReaction', label: tr('Thả 👀 reaction'), position: { x: 350, y: 200 },
        config: { ...DEFAULT_CONFIGS['tg.addReaction'], emoji: '👀' } },
      { id: 'n3', type: 'logic.if', label: tr('Hỏi giá?'), position: { x: 350, y: 350 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('giá|bảng giá|bao nhiêu') } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Gửi bảng giá'), position: { x: 30, y: 530 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('📋 Bảng giá sản phẩm:\n\n🥇 Gói Cơ bản: 199k/tháng\n🥈 Gói Nâng cao: 399k/tháng\n🥉 Gói Pro: 799k/tháng\n\n💝 Đặt ngay hôm nay giảm thêm 10%!') } },
      { id: 'n5', type: 'tg.sendMessage', label: tr('Xác nhận đặt hàng'), position: { x: 350, y: 530 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('🎉 Cảm ơn bạn đã quan tâm!\n\nĐể đặt hàng, vui lòng cho mình biết:\n1️⃣ Sản phẩm muốn mua\n2️⃣ Số lượng\n3️⃣ Địa chỉ nhận hàng\n4️⃣ SĐT liên hệ') } },
      { id: 'n6', type: 'tg.sendMessage', label: tr('Trả lời mặc định'), position: { x: 670, y: 530 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('Xin chào! 👋\n\nMình có thể giúp gì cho bạn?\n\n💬 Nhắn "GIÁ" để xem bảng giá\n📦 Nhắn "ĐẶT" để đặt hàng\n🆘 Nhắn "HỖ TRỢ" nếu cần giúp đỡ') } },
      { id: 'n7', type: 'logic.if', label: tr('Đặt hàng?'), position: { x: 350, y: 520 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: tr('đặt|mua|order|ship') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'true', target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: 'false', target: 'n7' },
      { id: 'e5', source: 'n7', sourceHandle: 'true', target: 'n5' },
      { id: 'e6', source: 'n7', sourceHandle: 'false', target: 'n6' },
    ],
  },

  // TG-22. Survey + AI sentiment analysis (Telegram)
  {
    id: 'tpl-tg-survey-ai',
    name: tr('TG: Khảo sát ý kiến + AI phân tích'),
    description: tr('Gửi khảo sát NPS qua Telegram, dùng AI phân tích cảm xúc (tích cực/tiêu cực) và phản hồi phù hợp.'),
    category: 'marketing',
    tags: ['telegram', tr('khảo sát'), 'AI', tr('phân tích'), 'NPS'],
    icon: <ClipboardListIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Tin nhắn phản hồi'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'ai.classify', label: tr('Phân loại cảm xúc'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['ai.classify'], categories: [tr('tích cực'), tr('tiêu cực'), tr('trung lập')].join(', '), input: '{{ $trigger.content }}' } },
      { id: 'n3', type: 'logic.switch', label: tr('Theo cảm xúc'), position: { x: 300, y: 370 },
        config: { value: '{{ $node.n2.category }}', cases: [{ match: tr('tích cực'), label: 'VUI' }, { match: tr('tiêu cực'), label: tr('BUỒN') }], defaultLabel: tr('THƯỜNG') } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Cảm ơn (tích cực)'), position: { x: 30, y: 540 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('🥰 Cảm ơn bạn rất nhiều vì phản hồi tích cực!\n\nChúng tôi rất vui khi được phục vụ bạn! ❤️') } },
      { id: 'n5', type: 'tg.sendMessage', label: tr('Xin lỗi (tiêu cực)'), position: { x: 300, y: 540 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('😔 Chúng tôi rất tiếc vì trải nghiệm chưa tốt.\n\nCho mình thêm thông tin chi tiết để cải thiện nhé? Hoặc gọi hotline 1900xxxx.') } },
      { id: 'n6', type: 'tg.addReaction', label: tr('Reaction 💙'), position: { x: 570, y: 540 },
        config: { ...DEFAULT_CONFIGS['tg.addReaction'], emoji: '💙' } },
      { id: 'n7', type: 'output.log', label: tr('Ghi log'), position: { x: 300, y: 700 },
        config: { message: tr('Feedback từ {{ $trigger.fromName }}: {{ $trigger.content }} — cảm xúc: {{ $node.n2.output }}'), level: 'info' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', sourceHandle: 'VUI', target: 'n4' },
      { id: 'e4', source: 'n3', sourceHandle: tr('BUỒN'), target: 'n5' },
      { id: 'e5', source: 'n3', sourceHandle: tr('THƯỜNG'), target: 'n6' },
      { id: 'e6', source: 'n6', target: 'n7' },
    ],
  },

  // TG-23. Process orders with variables (Telegram)
  {
    id: 'tpl-tg-order-processor',
    name: tr('TG: Xử lý đơn hàng tự động'),
    description: tr('Khi khách gửi mã đơn hàng qua Telegram, lưu vào biến, tạo nội dung xác nhận động và ghim để theo dõi.'),
    category: 'quan-ly',
    tags: ['telegram', tr('đơn hàng'), tr('xử lý'), tr('biến'), tr('tự động')],
    icon: <PackageIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Có mã đơn?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'regex', right: '#DH[0-9]+' } },
      { id: 'n3', type: 'logic.setVariable', label: tr('Lưu mã đơn'), position: { x: 300, y: 360 },
        config: { name: 'orderCode', value: '{{ $trigger.content }}' } },
      { id: 'n4', type: 'data.textFormat', label: tr('Soạn xác nhận'), position: { x: 300, y: 520 },
        config: { template: tr('✅ Xác nhận đã nhận đơn hàng\n\nMã đơn: {{ $var.orderCode }}\nKhách hàng: {{ $trigger.fromName }}\n\n📌 Đơn hàng đang được xử lý!') } },
      { id: 'n5', type: 'tg.sendMessage', label: tr('Gửi xác nhận'), position: { x: 300, y: 680 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: '{{ $node.n4.output }}' } },
      { id: 'n6', type: 'tg.pinMessage', label: tr('Ghim tin nhắn'), position: { x: 300, y: 840 },
        config: { ...DEFAULT_CONFIGS['tg.pinMessage'] } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
      { id: 'e5', source: 'n5', target: 'n6' },
    ],
  },

  // TG-24. Scheduled broadcast from Google Sheets (Telegram)
  {
    id: 'tpl-tg-scheduled-broadcast',
    name: tr('TG: Gửi khuyến mãi định kỳ vào nhóm'),
    description: tr('Đặt lịch gửi tin khuyến mãi vào nhóm/chat Telegram mỗi ngày. Chọn nhóm nhận tin trong cài đặt node "Gửi tin".'),
    category: 'marketing',
    tags: ['telegram', tr('lập lịch'), tr('khuyến mãi'), 'marketing'],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('08:00 mỗi ngày'), position: { x: 300, y: 50 },
        config: { cronExpression: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'data.textFormat', label: tr('Soạn nội dung'), position: { x: 300, y: 200 },
        config: { template: tr('🌞 Chào bạn!\n\nChương trình khuyến mãi hôm nay:\n• Giảm 20% tất cả sản phẩm\n• Miễn phí giao hàng\n\nLH: 0123.456.789 để đặt ngay!') } },
      { id: 'n3', type: 'tg.sendMessage', label: tr('Gửi tin vào nhóm'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], chatId: '', message: '{{ $node.n2.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  },

  // TG-25. Forward to an internal group (Telegram)
  {
    id: 'tpl-tg-forward-internal',
    name: tr('TG: Chuyển tiếp tin vào nhóm nội bộ'),
    description: tr('Khi khách Telegram gửi tin chứa "hỗ trợ" hoặc "khiếu nại", tự động chuyển tiếp vào nhóm nội bộ để xử lý.'),
    category: 'ban-hang',
    tags: ['telegram', tr('chuyển tiếp'), tr('nội bộ'), 'CSKH'],
    icon: <SendIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'logic.if', label: tr('Cần hỗ trợ?'), position: { x: 300, y: 200 },
        config: { left: '{{ $trigger.content }}', operator: 'contains_any', right: tr('hỗ trợ, khiếu nại, complaint, support') } },
      { id: 'n3', type: 'tg.forwardMessage', label: tr('Forward vào nhóm'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['tg.forwardMessage'], fromChatId: '{{ $trigger.chatId }}', toChatId: '' } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Gửi xác nhận'), position: { x: 300, y: 520 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('📩 Yêu cầu của bạn đã được chuyển đến đội ngũ hỗ trợ. Chúng tôi sẽ phản hồi sớm nhất!\n\nThời gian xử lý dự kiến: 30 phút.') } },
      { id: 'n5', type: 'tg.addReaction', label: tr('Reaction ✅'), position: { x: 300, y: 680 },
        config: { ...DEFAULT_CONFIGS['tg.addReaction'], emoji: '✅' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', sourceHandle: 'true', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // TG-26. AI marks as read + smart reply (Telegram)
  {
    id: 'tpl-tg-mark-read-ai',
    name: tr('TG: Đánh dấu đã đọc + AI trả lời'),
    description: tr('Đánh dấu đã đọc tin nhắn Telegram, thả reaction, sau đó dùng AI tạo câu trả lời thông minh.'),
    category: 'ai',
    tags: ['telegram', 'AI', tr('đã đọc'), 'reaction', tr('thông minh')],
    icon: <BotIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'tg.addReaction', label: tr('Reaction 👍'), position: { x: 300, y: 200 },
        config: { ...DEFAULT_CONFIGS['tg.addReaction'], emoji: '👍' } },
      { id: 'n3', type: 'ai.generateText', label: tr('AI sinh câu trả lời'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['ai.generateText'], prompt: 'Khách hàng vừa gửi tin nhắn: "{{ $trigger.content }}"\n\nHãy trả lời một cách thân thiện, chuyên nghiệp bằng tiếng Việt.' } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Gửi câu trả lời'), position: { x: 300, y: 530 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: '{{ $node.n3.output }}' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // TG-27. Call an external API when a message arrives (Telegram)
  {
    id: 'tpl-tg-api-integration',
    name: tr('TG: Gọi API bên ngoài khi nhận tin'),
    description: tr('Khi nhận tin nhắn Telegram, gọi API/CRM bên ngoài để đồng bộ dữ liệu rồi trả kết quả cho khách.'),
    category: 'nang-cao',
    tags: ['telegram', 'API', 'webhook', tr('tích hợp'), 'HTTP'],
    icon: <LinkIcon className="w-4 h-4" />,
    difficulty: 'advanced',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'] } },
      { id: 'n2', type: 'data.textFormat', label: tr('Tạo request body'), position: { x: 300, y: 200 },
        config: { template: '{"from": "{{ $trigger.fromName }}", "chatId": "{{ $trigger.chatId }}", "message": "{{ $trigger.content }}"}' } },
      { id: 'n3', type: 'output.httpRequest', label: tr('Gọi API'), position: { x: 300, y: 370 },
        config: { method: 'POST', url: 'https://your-api.com/webhook', headers: '{"Content-Type": "application/json"}', body: '{{ $node.n2.output }}', timeout: 10000 } },
      { id: 'n4', type: 'tg.sendMessage', label: tr('Phản hồi khách'), position: { x: 300, y: 540 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], message: tr('✅ Đã xử lý yêu cầu của bạn!\n\nKết quả: {{ $node.n3.output }}') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },

  // TG-28. Send product images when a customer asks (Telegram)
  {
    id: 'tpl-tg-send-product-image',
    name: tr('TG: Gửi ảnh sản phẩm theo từ khoá'),
    description: tr('Khi khách nhắn tên sản phẩm trên Telegram, tự động gửi ảnh kèm mô tả và giá.'),
    category: 'ban-hang',
    tags: ['telegram', tr('ảnh'), tr('sản phẩm'), tr('bán hàng')],
    icon: <ImageIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'sản phẩm,sp,product', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'tg.sendPhoto', label: tr('Gửi ảnh sản phẩm'), position: { x: 300, y: 220 },
        config: { ...DEFAULT_CONFIGS['tg.sendPhoto'], filePath: '', caption: tr('📦 Sản phẩm hot nhất tuần!\n\n💰 Giá: 299.000đ\n⭐ Đánh giá: 4.8/5\n\nNhắn "ĐẶT" để mua ngay!') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // TG-29. Weekly meeting reminder (Telegram)
  {
    id: 'tpl-tg-weekly-meeting',
    name: tr('TG: Nhắc nhở họp hàng tuần'),
    description: tr('Gửi tin nhắn nhắc nhở họp vào nhóm Telegram mỗi thứ Hai lúc 8:30 sáng.'),
    category: 'quan-ly',
    tags: ['telegram', tr('nhắc nhở'), tr('họp'), tr('hàng tuần')],
    icon: <CalendarIcon className="w-4 h-4" />,
    difficulty: 'easy',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'trigger.schedule', label: tr('T2 8:30 sáng'), position: { x: 300, y: 80 },
        config: { cronExpression: '30 8 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      { id: 'n2', type: 'tg.sendMessage', label: tr('Nhắc họp'), position: { x: 300, y: 250 },
        config: { ...DEFAULT_CONFIGS['tg.sendMessage'], chatId: '', message: tr('📋 NHẮC NHỞ HỌP\n\n⏰ Thời gian: 9:00 sáng nay\n📍 Địa điểm: Phòng họp A\n📌 Chủ đề: Báo cáo tuần\n\nMọi người vui lòng đúng giờ nhé! 🙏') } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  },

  // TG-30. Auto-delete spam messages after 1 minute (Telegram)
  {
    id: 'tpl-tg-auto-delete-spam',
    name: tr('TG: Tự động xoá tin nhắn spam'),
    description: tr('Phát hiện tin nhắn spam trong nhóm Telegram (quảng cáo, link lạ) và tự động xoá sau 1 phút.'),
    category: 'quan-ly',
    tags: ['telegram', 'spam', tr('xoá'), tr('nhóm'), tr('an toàn')],
    icon: <ShieldIcon className="w-4 h-4" />,
    difficulty: 'medium',
    channel: 'telegram_user' as Channel,
    nodes: [
      { id: 'n1', type: 'tg.trigger.message', label: tr('Khi nhận tin nhắn nhóm'), position: { x: 300, y: 50 },
        config: { ...DEFAULT_CONFIGS['tg.trigger.message'], keyword: 'http://,https://,bit.ly,t.me/,quảng cáo', keywordMode: 'contains_any' } },
      { id: 'n2', type: 'logic.wait', label: tr('Chờ 1 phút'), position: { x: 300, y: 200 },
        config: { delaySeconds: 60 } },
      { id: 'n3', type: 'tg.deleteMessage', label: tr('Xoá tin nhắn spam'), position: { x: 300, y: 360 },
        config: { ...DEFAULT_CONFIGS['tg.deleteMessage'] } },
      { id: 'n4', type: 'output.log', label: tr('Ghi log'), position: { x: 300, y: 520 },
        config: { message: tr('Đã xoá spam từ {{ $trigger.fromName }}: {{ $trigger.content }}'), level: 'warning' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
    ],
  },
];
