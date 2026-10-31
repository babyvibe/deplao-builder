/**
 * aiCopilot.ts - logic of the AI workflow copilot (the chat in WorkflowAIDialog).
 *
 * Pure (no React / IPC), unit-tested in src/__tests__/workflow/workflowAiCopilot.test.ts:
 * - buildCopilotSystemPrompt: role, step-by-step method, reply protocol, engine rules, design tips,
 *   the variables each trigger really provides, the node catalogue generated from the live
 *   CONFIG_SCHEMA / DEFAULT_CONFIGS / NODE_GROUPS (always current) and the current canvas.
 * - parseCopilotReply: a reply = text + at most one ```deplao-workflow``` proposal or one
 *   ```deplao-tool``` call; tolerant to the usual mistakes of weaker models (```json fences, smart
 *   quotes, comments, trailing commas, unfenced JSON, cut-off blocks).
 * - validateProposal / formatValidationFeedback: checks a proposal the way the engine will run it,
 *   so the dialog can send precise errors back for an automatic repair.
 * - materializeProposal: the whole canvas after applying a proposal ("append" = add / edit on the
 *   current diagram, "replace" = new diagram): ids, {{ $node.<id>… }} and inline-button references
 *   remapped, default configs merged, new nodes laid out.
 * - buildApiMessages: conversation → chat messages (old proposals compacted, same roles merged).
 */
import { NODE_GROUPS, DEFAULT_CONFIGS, getNodeLabel } from '../nodes/workflowConfig';
import { NODE_OUTPUTS, getTriggerVars, isTriggerType, isVarAvailable, upstreamNodeIds } from '../editor/templateVars';
import { AUTO_LAYOUT_SPACING, computeAutoLayout } from '../editor/autoLayout';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of NodeConfigPanel's Field (the schema is injected so this module stays pure). */
export interface SchemaField {
  key: string;
  label: string;
  type: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  desc?: string;
  hint?: string;
  advanced?: boolean;
  hideWhenKey?: string;
  hideWhenValue?: string;
  templateVars?: string[];
  contactType?: string;
  contactMode?: string;
  min?: number;
}

export type CopilotSchema = Record<string, SchemaField[]>;

export interface CanvasNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, any>;
  position?: { x: number; y: number };
}

export interface CanvasEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  data?: any;
}

export type ProposalMode = 'append' | 'replace';

export interface ProposalNode { id: string; type: string; label?: string; config: Record<string, any> }
export interface ProposalEdge { source: string; target: string; sourceHandle: string }
export interface ProposalUpdate { id: string; label?: string; config: Record<string, any> }

export interface AIProposal {
  mode: ProposalMode;
  title?: string;
  summary?: string;
  /** New nodes (replace: the whole workflow). */
  nodes: ProposalNode[];
  /** New edges (replace: all edges). */
  edges: ProposalEdge[];
  /** append only: changes to nodes already on the canvas (config is merged). */
  update: ProposalUpdate[];
  /** append only: ids of canvas nodes to delete. */
  remove: string[];
  /** append only: canvas edges to delete (sourceHandle optional). */
  removeEdges: Array<{ source: string; target: string; sourceHandle?: string }>;
}

export interface CopilotContext {
  channel: string;
  channelLabel: string;
  schema: CopilotSchema;
  currentNodes: CanvasNode[];
  currentEdges: CanvasEdge[];
  /** Accounts the workflow runs for (display names). */
  accountNames?: string[];
  /** Filled into AI nodes left without an assistant. */
  defaultAssistant?: { id: string; name: string } | null;
}

export interface ToolCall { tool: string; args: Record<string, any> }

export interface ParsedReply {
  /** Reply text without the protocol block (shown in the chat). */
  text: string;
  proposal?: AIProposal;
  toolCall?: ToolCall;
  /** A protocol block was present but could not be read. */
  parseError?: string;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

// ─── Small helpers ────────────────────────────────────────────────────────────

/** Lowercase, no Vietnamese accents (đ → d). */
export function foldAscii(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function clip(text: unknown, max: number): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const asId = (value: unknown): string => String(value ?? '').trim();

// ─── Catalogue ────────────────────────────────────────────────────────────────

type CatalogItem = { type: string; label: string; desc: string; channel?: string; group: string };

const ALL_ITEMS: CatalogItem[] = NODE_GROUPS.flatMap(group =>
  group.items.map(item => ({ ...item, group: group.label })));
const ITEM_BY_TYPE = new Map(ALL_ITEMS.map(item => [item.type, item]));

/** Same filter as the node palette: generic nodes + nodes of the workflow channel. */
export function isNodeAllowedForChannel(item: { channel?: string }, channel: string): boolean {
  if (!channel) return true;
  return !item.channel || item.channel === 'both' || item.channel === channel;
}

export function getAllowedNodeTypes(channel: string): Set<string> {
  return new Set(ALL_ITEMS.filter(item => isNodeAllowedForChannel(item, channel)).map(item => item.type));
}

/** Nodes described in full in the system prompt; the others get one line + get_node_details. */
const CORE_BY_CHANNEL: Record<string, string[]> = {
  zalo: ['trigger.message', 'trigger.friendRequest', 'trigger.groupEvent', 'zalo.sendMessage', 'zalo.sendTyping', 'zalo.sendImage', 'zalo.assignLabel', 'zalo.acceptFriendRequest', 'logic.forEachContact'],
  facebook: ['fb.trigger.message', 'fb.action.sendMessage', 'fb.action.sendImage', 'fb.action.sendTyping'],
  telegram_user: ['tg.trigger.message', 'tg.trigger.groupEvent', 'tg.sendMessage', 'tg.sendPhoto', 'tg.sendTyping'],
  telegram_bot: ['tgbot.trigger.message', 'tgbot.trigger.command', 'tgbot.trigger.callback', 'tgbot.action.sendMessage', 'tgbot.action.sendPhoto', 'tgbot.action.answerCallback'],
};
const CORE_GENERIC = [
  'trigger.schedule', 'trigger.manual', 'logic.if', 'logic.switch', 'logic.wait', 'logic.setVariable', 'logic.stopIf',
  'ai.generateText', 'ai.classify', 'data.textFormat', 'data.randomPick',
];

/** Node types edited by a dedicated editor instead of CONFIG_SCHEMA fields. */
const CUSTOM_CONFIG_DOCS: Record<string, { keys: string[]; doc: string }> = {
  'tgbot.action.sendMessage': {
    keys: ['accountId', 'chatId', 'message', 'keyboard'],
    doc: [
      '  • accountId (ID Bot) — để trống = Bot đang chạy workflow.',
      '  • chatId (văn bản) — mặc định "{{ $trigger.chatId }}" = trả lời đúng chat vừa kích hoạt.',
      '  • message (văn bản*) — nội dung tin nhắn, dùng được {{ biến }}.',
      '  • keyboard (object, tuỳ chọn) — bàn phím nút bấm: {"enabled": true, "type": "inline" | "reply", "rows": [[{"id": "b1", "text": "Tên nút", "action": "node" | "callback" | "url", "targetNodeId": "<id node đích>", "callbackData": "<dữ liệu>", "url": "https://…"}]], "resize": true, "oneTime": false, "persistent": false}',
      '    - "inline" = nút nằm dưới tin nhắn. action "node": khi khách bấm, chạy node targetNodeId (KHÔNG nối cạnh thường tới node đích - cạnh thường chạy ngay không chờ bấm); "callback": gửi callbackData tới trigger tgbot.trigger.callback; "url": mở link.',
      '    - "reply" = bàn phím thay khung gõ; khách bấm = gửi đúng chữ trên nút như 1 tin nhắn (bắt bằng tgbot.trigger.message + keyword). Chỉ dùng action "node"/"callback"/"url" với "inline".',
    ].join('\n'),
  },
};

/** Extra guidance per node type (engine behaviour that the field list does not show). */
const KEYWORD_NOTE = 'Ghi chú: keyword = nhiều từ cách nhau dấu phẩy, KHÔNG phân biệt hoa/thường nhưng CÓ phân biệt dấu → thêm cả biến thể không dấu (VD "giá, gia").';
const DEBOUNCE_NOTE = ' Trả lời bằng AI → đặt debounceSeconds 10-15 để gom các tin khách gõ liên tiếp.';
const NODE_NOTES: Record<string, string> = {
  'trigger.message': KEYWORD_NOTE + DEBOUNCE_NOTE,
  'fb.trigger.message': KEYWORD_NOTE + DEBOUNCE_NOTE,
  'tg.trigger.message': KEYWORD_NOTE + DEBOUNCE_NOTE,
  'tgbot.trigger.message': KEYWORD_NOTE,
  'trigger.schedule': 'Ghi chú: cron 5 trường "phút giờ ngày tháng thứ" theo giờ Việt Nam, VD "0 8 * * *" = 8:00 mỗi ngày, "30 17 * * 1-5" = 17:30 thứ 2-6. Không có dữ liệu $trigger → node gửi tin PHẢI chỉ định người nhận.',
  'trigger.posWebhook': 'Ghi chú: chỉ chạy với webhook đã xác thực khoá (người dùng đặt "Khoá xác thực webhook" ở trang Tích hợp). Mỗi đơn / khách / sản phẩm chạy một lần: {{ $trigger.code }}, {{ $trigger.status }}, {{ $trigger.customerName }}, {{ $trigger.customerPhone }}, {{ $trigger.total }}, trường gốc {{ $trigger.data.<trường> }}. Không có hội thoại → node gửi tin PHẢI chỉ định người nhận (VD zalo.findUser theo {{ $trigger.customerPhone }} rồi gửi tới {{ $node.<id>.userId }}).',
  'ai.generateText': 'Ghi chú: giữ aiConfigMode "assistant", để trống assistantId (hệ thống tự điền trợ lý mặc định). prompt = lời dặn cho AI, thường chứa {{ $trigger.content }}; câu trả lời của AI = {{ $node.<id>.result }}.',
  'ai.classify': 'Ghi chú: giữ aiConfigMode "assistant", để trống assistantId. categories = các nhóm ngắn gọn cách nhau dấu phẩy; {{ $node.<id>.category }} = ĐÚNG NGUYÊN VĂN 1 tên nhóm → logic.switch phải dùng match trùng y hệt tên nhóm.',
  'logic.if': 'Ghi chú: so sánh phân biệt hoa/thường. Lọc tin nhắn theo từ khoá thì dùng keyword của trigger thay vì logic.if.',
  'logic.switch': 'Ghi chú: so khớp CHÍNH XÁC từng ký tự (phân biệt hoa/thường và dấu).',
  'logic.forEachContact': 'Ghi chú: {{ $node.<id>.result }} = danh sách ID người nhận → đặt vào threadIdsExpr của node gửi tin để gửi hàng loạt; node gửi tự giãn cách từng người nhận (tối thiểu 5 giây, mặc định 5-10 giây; sendDelayMinSeconds / sendDelayMaxSeconds lớn hơn thì chậm hơn).',
  'logic.forEach': 'Ghi chú: array = ĐÚNG MỘT biến danh sách, VD "{{ $node.<id>.products }}". Các node nối từ cổng "default" chạy lại cho từng phần tử với {{ $var.item }} / {{ $var.item.<trường> }} / {{ $var.itemIndex }} (từ 1); node nối từ cổng "done" chạy một lần sau khi lặp xong. Muốn gửi MỘT tin liệt kê: trong vòng lặp dùng logic.setVariable value "{{ $var.<tên> }}\\n• {{ $var.item.name }}", rồi ở nhánh "done" gửi {{ $var.<tên> }}. Tối đa maxItems (≤ 100) phần tử.',
  'logic.wait': 'Ghi chú: tối đa 300 giây.',
};

const HANDLE_DOCS: Record<string, string> = {
  'logic.if': 'Cổng ra: "true" (điều kiện đúng) và "false" (điều kiện sai).',
  'logic.switch': 'Cổng ra: mỗi nhánh dùng đúng "label" của nhánh trong config.cases; không khớp nhánh nào → config.defaultLabel (mặc định "default").',
  'logic.forEach': 'Cổng ra: "default" (chạy cho từng phần tử) và "done" (chạy một lần sau khi lặp xong).',
  'output.log': 'Không có cổng ra (node cuối).',
};

/** AI nodes: fields of the "manual API key" mode are never filled by the copilot. */
function isManualAiField(field: SchemaField): boolean {
  return (field.hideWhenKey === 'aiConfigMode' && field.hideWhenValue === 'assistant') || field.key === 'apiKey';
}

function docFields(type: string, schema: CopilotSchema): SchemaField[] {
  return (schema[type] || []).filter(field => field.type !== 'info' && !isManualAiField(field));
}

function fieldTypeDoc(field: SchemaField): string {
  switch (field.type) {
    case 'text': case 'textarea': case 'multiline': case 'html': return 'văn bản, dùng được {{ biến }}';
    case 'select': case 'choice': return 'chọn 1';
    case 'chips': return 'mảng, chọn nhiều; [] = tất cả';
    case 'number': return field.min !== undefined ? `số ≥ ${field.min}` : 'số';
    case 'boolean': return 'true/false';
    case 'json': return 'JSON';
    case 'cron': return 'cron 5 trường, VD "0 8 * * *"';
    case 'contact-picker':
      return field.contactMode === 'multi'
        ? 'chuỗi mảng JSON ID, VD "[\\"123\\",\\"456\\"]"; để trống = hội thoại kích hoạt; tra ID bằng search_contacts'
        : 'ID hội thoại / người dùng / nhóm hoặc {{ biến }}; tra ID bằng search_contacts';
    case 'account-picker': return 'ID tài khoản; để trống = tài khoản đang chạy workflow';
    case 'label-picker': return 'mảng ID nhãn "local:<id>" (tra bằng list_labels)';
    case 'file-picker': return 'đường dẫn file trên máy - để trống, người dùng tự chọn';
    case 'time-window': return 'object {"mode":"always|inside|outside","start":"HH:mm","end":"HH:mm","days":[0-6]} (0 = Chủ nhật)';
    case 'case-list': return 'mảng [{"match":"giá trị khớp","label":"tên_nhánh"}]';
    case 'assistant-picker': return 'ID trợ lý AI - để trống';
    case 'integration-picker': return 'ID tích hợp - để trống, người dùng chọn sau';
    default: return field.type;
  }
}

function optionsDoc(options: { value: string; label: string }[]): string {
  const shown = options.length > 14 ? options.slice(0, 8) : options;
  const list = shown.map(opt => `"${opt.value}"=${clip(opt.label, 40)}`).join(', ');
  return options.length > shown.length ? `${list}, … (${options.length} lựa chọn - giữ mặc định)` : list;
}

/** Full description of one node type: config fields, allowed values, defaults, handles, outputs. */
export function describeNode(type: string, schema: CopilotSchema): string {
  const item = ITEM_BY_TYPE.get(type);
  const lines: string[] = [`### ${type} — ${item?.label || getNodeLabel(type)}`];
  if (item?.desc) lines.push(`Mô tả: ${item.desc}`);
  const defaults = DEFAULT_CONFIGS[type] || {};
  const custom = CUSTOM_CONFIG_DOCS[type];
  const fields = docFields(type, schema);
  if (custom) {
    lines.push('Cấu hình:', custom.doc);
  } else if (fields.length) {
    lines.push('Cấu hình:');
    for (const field of fields) {
      let line = `  • ${field.key} (${fieldTypeDoc(field)}): ${clip(field.label, 70)}`;
      if (field.options?.length) line += ` — giá trị: ${optionsDoc(field.options)}`;
      const def = defaults[field.key];
      if (def !== undefined && def !== '' && !(Array.isArray(def) && def.length === 0)) line += ` — mặc định ${clip(JSON.stringify(def), 120)}`;
      if (field.hideWhenKey) line += ` — bỏ qua khi ${field.hideWhenKey}="${field.hideWhenValue}"`;
      if (field.desc) line += `. ${clip(field.desc, 170)}`;
      lines.push(line);
    }
  } else if (Object.keys(defaults).length) {
    lines.push('Cấu hình:');
    for (const [key, value] of Object.entries(defaults)) {
      lines.push(`  • ${key} — mặc định ${clip(JSON.stringify(value), 160)}`);
    }
  } else {
    lines.push('Cấu hình: không cần ({}).');
  }
  if (NODE_NOTES[type]) lines.push(NODE_NOTES[type]);
  if (HANDLE_DOCS[type]) lines.push(HANDLE_DOCS[type]);
  const outputs = NODE_OUTPUTS[type];
  if (outputs?.length) {
    lines.push(`Kết quả cho node sau: ${outputs.map(out => `{{ $node.<id>.${out.path} }} = ${out.label}`).join('; ')}.`);
  }
  return lines.join('\n');
}

/** Accepts ["a","b"], "a, b" or {types|type|nodes}. */
export function normalizeTypeList(value: unknown): string[] {
  const raw = isPlainObject(value) ? (value.types ?? value.type ?? value.nodes ?? value.names) : value;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/);
  return [...new Set(list.map(item => String(item ?? '').trim()).filter(Boolean))].slice(0, 12);
}

/** Tool get_node_details. */
export function describeNodeDetails(args: unknown, ctx: CopilotContext): string {
  const allowed = getAllowedNodeTypes(ctx.channel);
  const types = normalizeTypeList(args);
  if (types.length === 0) return 'Thiếu tham số "types" (mảng type node), VD {"types": ["zalo.sendImage"]}.';
  return types.map(type => {
    if (!ITEM_BY_TYPE.has(type)) {
      const tail = type.split('.').pop() || type;
      const close = ALL_ITEMS.filter(item => allowed.has(item.type) && item.type.toLowerCase().includes(tail.toLowerCase()))
        .slice(0, 5).map(item => item.type);
      return `### ${type}\nKHÔNG TỒN TẠI.${close.length ? ` Có thể bạn cần: ${close.join(', ')}.` : ''} Chỉ dùng type trong danh mục.`;
    }
    const note = allowed.has(type) ? '' : `\n(Node này không thuộc kênh ${ctx.channelLabel} - KHÔNG dùng.)`;
    return describeNode(type, ctx.schema) + note;
  }).join('\n\n');
}

function compactNodeLine(item: CatalogItem, schema: CopilotSchema): string {
  const custom = CUSTOM_CONFIG_DOCS[item.type];
  const fields = docFields(item.type, schema);
  const keys = custom ? custom.keys : fields.length ? fields.map(field => field.key) : Object.keys(DEFAULT_CONFIGS[item.type] || {});
  return `- ${item.type} — ${item.label}: ${clip(item.desc, 100)}${keys.length ? ` [${keys.join(', ')}]` : ''}`;
}

function triggerFieldNames(type: string): string[] {
  return getTriggerVars([type]).map(v => v.key.replace(/^\$trigger\./, ''));
}

function variablesDoc(channel: string, triggerTypes: string[]): string {
  const lines: string[] = [];
  if (triggerTypes.length) {
    const vars = getTriggerVars(triggerTypes);
    lines.push(vars.length
      ? `Trigger trên sơ đồ (${triggerTypes.join(', ')}) cung cấp:`
      : `Trigger trên sơ đồ (${triggerTypes.join(', ')}) KHÔNG có dữ liệu $trigger.`);
    for (const v of vars) lines.push(`- {{ ${v.key} }} — ${v.label}`);
  } else {
    lines.push('Sơ đồ chưa có trigger.');
  }
  const triggers = ALL_ITEMS.filter(item => isTriggerType(item.type) && isNodeAllowedForChannel(item, channel) && !triggerTypes.includes(item.type));
  if (triggers.length) {
    lines.push('Biến $trigger của các trigger khác (đề xuất trigger nào thì CHỈ dùng biến của trigger đó):');
    for (const item of triggers) {
      const names = triggerFieldNames(item.type);
      lines.push(`- ${item.type}: ${names.length ? names.join(', ') : 'không có dữ liệu'}`);
    }
  }
  lines.push(
    'Biến khác:',
    '- {{ $node.<id>.<trường> }} — kết quả của node chạy TRƯỚC (xem "Kết quả cho node sau" của từng node); {{ $node.<id>.output }} = kết quả chính dạng văn bản. <id> = id node (VD n2).',
    '- {{ $var.<tên> }} — giá trị đã lưu bằng node logic.setVariable (config.name = <tên>) ở bước trước; trong vòng lặp logic.forEach: {{ $var.item }}, {{ $var.item.<trường> }}, {{ $var.itemIndex }}.',
    '- {{ $date.now }} (dd/MM/yyyy HH:mm:ss), {{ $date.today }} (dd/MM/yyyy) — giờ Việt Nam.',
    '- {{ $pageId }} — ID tài khoản đang chạy workflow.',
    'KHÔNG TỒN TẠI (cấm dùng): $prev, $vars, $input, $json, $item, biến thiếu dấu $ (VD {{ trigger.content }}), phép tính / bộ lọc trong {{ }}.',
  );
  return lines.join('\n');
}

function shortenStrings(value: any, max: number): any {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map(item => shortenStrings(item, max));
  if (isPlainObject(value)) {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) out[key] = shortenStrings(item, max);
    return out;
  }
  return value;
}

/** Current canvas as compact JSON (long texts shortened first, then cut). */
export function compactWorkflow(nodes: CanvasNode[], edges: CanvasEdge[], maxChars = 14000): string {
  if (!nodes.length) return '(Trống - chưa có node nào trên sơ đồ.)';
  const build = (shorten: number) => JSON.stringify({
    nodes: nodes.map(node => ({
      id: node.id,
      type: node.type,
      label: node.label || getNodeLabel(node.type),
      config: shorten ? shortenStrings(node.config || {}, shorten) : (node.config || {}),
    })),
    edges: edges.filter(edge => !edge.data?.telegramInline).map(edge => ({
      source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle || 'default',
    })),
  });
  let json = build(0);
  if (json.length > maxChars) json = build(240);
  if (json.length > maxChars) json = build(60);
  return json.length > maxChars ? `${json.slice(0, maxChars)}… (đã cắt bớt)` : json;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const EXAMPLE_NODES: Record<string, { trigger: ProposalNode; send: ProposalNode }> = {
  zalo: {
    trigger: { id: 'n1', type: 'trigger.message', label: 'Khách hỏi giá', config: { threadType: '0', keyword: 'giá, gia, bao nhiêu, bao nhieu', keywordMode: 'contains_any', ignoreOwn: true, debounceSeconds: 10 } },
    send: { id: 'n3', type: 'zalo.sendMessage', label: 'Gửi trả lời', config: { message: '{{ $node.n2.result }}' } },
  },
  facebook: {
    trigger: { id: 'n1', type: 'fb.trigger.message', label: 'Khách hỏi giá', config: { threadType: '0', keyword: 'giá, gia, bao nhiêu, bao nhieu', keywordMode: 'contains_any', ignoreOwn: true, debounceSeconds: 10 } },
    send: { id: 'n3', type: 'fb.action.sendMessage', label: 'Gửi trả lời', config: { message: '{{ $node.n2.result }}' } },
  },
  telegram_user: {
    trigger: { id: 'n1', type: 'tg.trigger.message', label: 'Khách hỏi giá', config: { chatType: 'user', keyword: 'giá, gia, bao nhiêu, bao nhieu', keywordMode: 'contains_any', ignoreOwn: true, debounceSeconds: 10 } },
    send: { id: 'n3', type: 'tg.sendMessage', label: 'Gửi trả lời', config: { message: '{{ $node.n2.result }}' } },
  },
  telegram_bot: {
    trigger: { id: 'n1', type: 'tgbot.trigger.message', label: 'Khách hỏi giá', config: { chatScope: 'private', keyword: 'giá, gia, bao nhiêu, bao nhieu', keywordMode: 'contains_any', ignoreOwn: true } },
    send: { id: 'n3', type: 'tgbot.action.sendMessage', label: 'Gửi trả lời', config: { message: '{{ $node.n2.result }}' } },
  },
};

function examplesDoc(channel: string): string {
  const example = EXAMPLE_NODES[channel] || EXAMPLE_NODES.zalo;
  const first = {
    mode: 'replace',
    title: 'AI trả lời khách hỏi giá',
    summary: 'Khách nhắn có chữ "giá" thì AI soạn câu trả lời và gửi lại ngay trong hội thoại.',
    nodes: [
      example.trigger,
      { id: 'n2', type: 'ai.generateText', label: 'AI soạn trả lời', config: { aiConfigMode: 'assistant', prompt: 'Khách hỏi: {{ $trigger.content }}\nTrả lời ngắn gọn, thân thiện bằng tiếng Việt; mời khách để lại SĐT nếu muốn đặt hàng.' } },
      example.send,
    ],
    edges: [{ source: 'n1', target: 'n2', sourceHandle: 'default' }, { source: 'n2', target: 'n3', sourceHandle: 'default' }],
  };
  const second = {
    mode: 'append',
    title: 'Chờ 3 giây trước khi gửi',
    summary: 'Chèn bước chờ 3 giây giữa "AI soạn trả lời" và "Gửi trả lời", sửa lời dặn AI.',
    nodes: [{ id: 'n1', type: 'logic.wait', label: 'Chờ 3 giây', config: { delaySeconds: 3 } }],
    edges: [{ source: 'a2', target: 'n1', sourceHandle: 'default' }, { source: 'n1', target: 'a3', sourceHandle: 'default' }],
    removeEdges: [{ source: 'a2', target: 'a3' }],
    update: [{ id: 'a2', config: { prompt: 'Khách hỏi: {{ $trigger.content }}\nTrả lời lịch sự, xưng "shop", tối đa 3 câu.' } }],
  };
  return `Ví dụ 1 - người dùng: "khách hỏi giá thì AI trả lời giúp tôi" (sơ đồ trống):
**Phân tích**
- Mục tiêu: khách hỏi giá được AI trả lời ngay.
- Kích hoạt: tin nhắn cá nhân có chữ "giá" / "bao nhiêu".
- Luồng: Nhận tin → AI soạn câu trả lời → Gửi trả lời.
- Giả định: chỉ tin nhắn cá nhân; gom tin trong 10 giây.
\`\`\`deplao-workflow
${JSON.stringify(first)}
\`\`\`
**Sau khi áp dụng**: kiểm tra trợ lý AI trong node "AI soạn trả lời", bấm Lưu và bật workflow.

Ví dụ 2 - người dùng: "chờ 3 giây rồi mới gửi, và bảo AI trả lời lịch sự hơn" (sơ đồ đang có a1 → a2 → a3 như ví dụ 1):
\`\`\`deplao-workflow
${JSON.stringify(second)}
\`\`\``;
}

export function buildCopilotSystemPrompt(ctx: CopilotContext): string {
  const allowed = ALL_ITEMS.filter(item => isNodeAllowedForChannel(item, ctx.channel));
  const allowedTypes = new Set(allowed.map(item => item.type));
  const coreTypes = [...(CORE_BY_CHANNEL[ctx.channel] || []), ...CORE_GENERIC].filter(type => allowedTypes.has(type));
  const coreDocs = coreTypes.map(type => describeNode(type, ctx.schema)).join('\n\n');
  const groups = new Map<string, CatalogItem[]>();
  for (const item of allowed) {
    if (coreTypes.includes(item.type)) continue;
    groups.set(item.group, [...(groups.get(item.group) || []), item]);
  }
  const compactDocs = [...groups.entries()]
    .map(([group, items]) => `## ${group}\n${items.map(item => compactNodeLine(item, ctx.schema)).join('\n')}`)
    .join('\n\n');
  const triggerTypes = [...new Set(ctx.currentNodes.map(node => node.type).filter(isTriggerType))];
  const accounts = ctx.accountNames?.length ? ctx.accountNames.join(', ') : `mọi tài khoản ${ctx.channelLabel}`;
  const assistant = ctx.defaultAssistant?.name ? `"${ctx.defaultAssistant.name}" (tự điền vào node AI)` : 'chưa có - nhắc người dùng chọn trợ lý trong node AI';

  return `# VAI TRÒ
Bạn là "Kiến trúc sư Workflow" của Deplao - phần mềm CRM nhắn tin đa kênh (Zalo, Facebook, Telegram). Bạn trò chuyện với người dùng để hiểu nhu cầu, cùng phân tích rồi thiết kế workflow tự động chạy trên kênh ${ctx.channelLabel}. Người dùng thường là chủ shop / nhân viên bán hàng, không rành kỹ thuật: trả lời bằng tiếng Việt, ngắn gọn, thân thiện, tránh thuật ngữ; luôn giải thích bằng lời thường workflow sẽ làm gì.

# BỐI CẢNH
- Kênh của workflow: ${ctx.channelLabel} (mã "${ctx.channel}"). CHỈ dùng node trong DANH MỤC NODE bên dưới - danh mục đã lọc đúng kênh này.
- Workflow chạy cho: ${accounts}.
- Trợ lý AI mặc định cho node AI: ${assistant}.
- Workflow = đúng 1 node kích hoạt (trigger) + các node xử lý nối với nhau bằng cạnh (edge). Khi sự kiện xảy ra, engine chạy trigger rồi đi theo cạnh tới từng node sau.

# CÁCH LÀM VIỆC (BẮT BUỘC - suy nghĩ kỹ theo đúng thứ tự)
Bước 1 - Hiểu yêu cầu. Tự xác định: (a) sự kiện nào bắt đầu; (b) áp dụng cho ai / hội thoại nào (cá nhân, nhóm, khách cụ thể…); (c) điều kiện lọc hoặc rẽ nhánh; (d) các hành động theo thứ tự; (e) kết quả người dùng mong muốn.
Bước 2 - Thiếu thông tin QUAN TRỌNG không thể đoán hợp lý (gửi cho ai, nội dung chính, chạy lúc nào…) → hỏi lại TỐI ĐA 3 câu ngắn, mỗi câu kèm 2-3 lựa chọn gợi ý (A/B/C) và KHÔNG xuất đề xuất trong lượt đó. Thông tin phụ (câu chữ, thời gian chờ…) thì tự chọn mặc định hợp lý và ghi vào "Giả định". Người dùng nói "cứ làm", "làm luôn", "tuỳ bạn" → đề xuất ngay.
Bước 3 - Phác thảo luồng bằng lời: Bước 1 → Bước 2 → … (nêu rõ nhánh Đúng/Sai hoặc từng nhánh Switch).
Bước 4 - Ánh xạ mỗi bước sang ĐÚNG 1 node trong danh mục. Node chỉ có ở phần "tóm tắt" → gọi get_node_details trước khi dùng. Không có node phù hợp → nói thật và đề xuất cách gần nhất (VD gọi API ngoài bằng output.httpRequest). TUYỆT ĐỐI không bịa type node, tên trường hay giá trị.
Bước 5 - Điền cấu hình: chỉ dùng trường có trong mô tả node; trường "chọn 1" phải đúng giá trị trong danh sách. Viết sẵn nội dung tin nhắn tiếng Việt tự nhiên, lịch sự, có biến động khi hợp lý (VD chào bằng tên khách). Cần ID thật (hội thoại, nhóm, nhãn) → dùng công cụ để tra, không bịa.
Bước 6 - Tự rà DANH SÁCH KIỂM TRA, sửa hết lỗi rồi mới xuất.
Bước 7 - Trả lời theo ĐỊNH DẠNG TRẢ LỜI.
Người dùng chỉ hỏi, nhờ giải thích hoặc góp ý workflow hiện tại → trả lời bằng văn bản; chỉ xuất đề xuất khi cần thay đổi sơ đồ.

# ĐỊNH DẠNG TRẢ LỜI
Mỗi lượt gồm văn bản cho người dùng và TỐI ĐA 1 khối giao thức (deplao-workflow HOẶC deplao-tool).

(A) Hỏi lại / tư vấn / giải thích: chỉ viết văn bản.

(B) Đề xuất workflow - viết đúng mẫu:
**Phân tích**
- Mục tiêu: …
- Kích hoạt: …
- Luồng: Bước 1 → Bước 2 → …
- Giả định: …
rồi đúng 1 khối \`\`\`deplao-workflow … \`\`\`, rồi **Sau khi áp dụng**: những việc người dùng cần tự làm (chọn ảnh/file, kiểm tra nội dung, Lưu và bật workflow…).

Khối deplao-workflow là JSON:
{
  "mode": "append" hoặc "replace",
  "title": "Tên ngắn của kịch bản",
  "summary": "1-2 câu mô tả",
  "nodes": [{"id": "n1", "type": "<type trong danh mục>", "label": "Tên hiển thị ngắn", "config": {}}],
  "edges": [{"source": "n1", "target": "n2", "sourceHandle": "default"}],
  "update": [{"id": "<id node CŨ>", "label": "…", "config": {"<chỉ trường cần đổi>": "…"}}],
  "remove": ["<id node CŨ cần xoá>"],
  "removeEdges": [{"source": "<id>", "target": "<id>"}]
}
- "replace" = đề xuất là TOÀN BỘ workflow mới, thay hết sơ đồ hiện tại (muốn giữ node cũ thì đưa lại node đó với ĐÚNG id cũ). Dùng khi sơ đồ trống hoặc người dùng muốn làm lại từ đầu.
- "append" = THÊM / SỬA trên sơ đồ hiện tại: "nodes" + "edges" là phần MỚI (cạnh nối từ/tới node cũ bằng id cũ); "update" sửa node cũ (chỉ ghi trường cần đổi); "remove" xoá node cũ (cạnh của nó tự xoá); "removeEdges" xoá cạnh cũ. update / remove / removeEdges không bắt buộc - bỏ đi nếu không dùng.
- Node mới đặt id "n1", "n2"… không trùng id node cũ. Không cần "position" - hệ thống tự sắp xếp.
- Người dùng muốn chỉnh đề xuất CHƯA áp dụng → gửi lại khối ĐẦY ĐỦ đã sửa (không gửi phần chênh lệch).
- JSON hợp lệ: nháy kép, không chú thích, không dấu phẩy thừa, xuống dòng trong chuỗi viết \\n.

(C) Cần tra cứu: viết 1 câu ngắn rồi đúng 1 khối, sau đó DỪNG chờ kết quả (hệ thống gửi lại "[KẾT QUẢ CÔNG CỤ]"):
\`\`\`deplao-tool
{"tool": "get_node_details", "args": {"types": ["zalo.sendImage"]}}
\`\`\`

# CÔNG CỤ (mỗi lượt gọi 1 công cụ)
- get_node_details {"types": ["type1", "type2"]} → cấu hình đầy đủ (trường, giá trị hợp lệ, mặc định, cổng ra, kết quả) của node chỉ có trong phần tóm tắt.
- search_contacts {"query": "tên / SĐT / ID", "type": "user" | "group" | "all"} → hội thoại, nhóm thật (tên + ID) của tài khoản trong workflow, để điền threadIds, groupId, fromId…
- list_labels {} → danh sách Nhãn Local (giá trị "local:<id>" + tên) để điền labelIds.
Chỉ gọi khi thật sự cần; đã có kết quả thì dùng luôn, không gọi lặp lại.

# QUY TẮC CỦA ENGINE (vi phạm → hệ thống trả đề xuất về để sửa)
1. Đúng 1 trigger (type bắt đầu bằng "trigger." hoặc có ".trigger."). Trigger không có cạnh đi vào. Sơ đồ đã có trigger mà dùng "append" → KHÔNG thêm trigger mới (muốn đổi trigger: "remove" trigger cũ rồi thêm trigger mới, hoặc dùng "replace").
2. Mọi node khác phải có cạnh đi vào (từ trigger hoặc node trước). Không vòng lặp, không nối node vào chính nó.
3. sourceHandle: logic.if dùng "true" (Đúng) / "false" (Sai); logic.switch dùng đúng "label" của từng nhánh trong config.cases, nhánh còn lại dùng config.defaultLabel (mặc định "default"); logic.forEach dùng "default" (chạy cho từng phần tử) / "done" (sau khi lặp xong); mọi node khác dùng "default". output.log là node cuối, không nối tiếp.
4. Một node có nhiều cạnh ra thì tất cả các nhánh đều chạy. Muốn các bước chạy theo thứ tự thì nối thành chuỗi.
5. Node gửi tin để TRỐNG người nhận (threadIds / chatId…) = trả lời đúng hội thoại vừa kích hoạt - cách dùng phổ biến nhất. Chỉ điền ID khi gửi tới nơi khác (VD báo cho nhóm nhân viên).
6. Biến {{ … }} chỉ được thay trong trường văn bản cấp 1 của config.
7. Trường cần người dùng tự chọn (file ảnh, tài khoản, tích hợp) → để trống và nhắc trong "Sau khi áp dụng".

# KINH NGHIỆM THIẾT KẾ
- Lọc theo từ khoá: dùng "keyword" của trigger (không cần thêm logic.if để lọc lại).
- Trả lời bằng AI: trigger tin nhắn (debounceSeconds 10-15) → ai.generateText (prompt chứa {{ $trigger.content }}) → node gửi tin với nội dung "{{ $node.<id>.result }}".
- Phân loại ý định khách: ai.classify → logic.switch (value "{{ $node.<id>.category }}", mỗi case match trùng nguyên văn 1 tên nhóm) → mỗi nhánh 1 hành động.
- Giống người thật, tránh bị coi là spam: hiệu ứng đang gõ hoặc logic.wait vài giây trước khi gửi; gửi hàng loạt thì giãn cách 3-8 giây.
- Chạy theo lịch / gửi hàng loạt (Zalo): trigger.schedule → logic.forEachContact (chọn người nhận) → node gửi tin có "threadIdsExpr": "{{ $node.<id>.result }}".
- Chèn bước vào giữa 2 node cũ A → B: "removeEdges" A→B, thêm node mới, cạnh A→mới và mới→B.
- Giờ làm việc / chống làm phiền: dùng activeHours, cooldownMinutes của trigger (nếu trigger có các trường này).
- Báo cho chủ shop / nhân viên: node gửi tin tới hội thoại hoặc nhóm nội bộ (tra ID bằng search_contacts) hoặc node trong nhóm "Gửi thông báo".
- Đặt label ngắn gọn, nói rõ việc node làm: "Chào khách mới", "AI trả lời", "Gắn nhãn Đặt hàng".

# BIẾN ĐỘNG (chèn bằng {{ … }} trong trường văn bản)
${variablesDoc(ctx.channel, triggerTypes)}

# DANH SÁCH KIỂM TRA (tự rà trước khi xuất)
[ ] Đúng 1 trigger; "append" trên sơ đồ đã có trigger thì không thêm trigger.
[ ] Mọi type có trong danh mục; mọi trường config có trong mô tả node đó; giá trị "chọn 1" nằm trong danh sách.
[ ] Mọi cạnh trỏ tới id có thật; sourceHandle đúng loại node; node mới nào cũng có cạnh đi vào; không vòng lặp.
[ ] Biến {{ }} có thật với trigger đang dùng; {{ $node.<id>… }} trỏ tới node chạy TRƯỚC node đang dùng nó.
[ ] Nội dung tin nhắn đầy đủ, tự nhiên, đúng chính tả tiếng Việt.

# DANH MỤC NODE - KÊNH ${ctx.channelLabel.toUpperCase()}
## Node dùng nhiều (mô tả đầy đủ)
${coreDocs}

## Các node khác (tóm tắt: type — tên: mô tả [trường cấu hình]) - gọi get_node_details trước khi dùng
${compactDocs}

# WORKFLOW HIỆN TẠI TRÊN SƠ ĐỒ
${compactWorkflow(ctx.currentNodes, ctx.currentEdges)}

# VÍ DỤ (minh hoạ định dạng)
${examplesDoc(ctx.channel)}`;
}

// ─── Reply parsing ────────────────────────────────────────────────────────────

/** JSON.parse with fixes for common LLM mistakes (smart quotes, comments, trailing commas, raw newlines). */
export function lenientJsonParse(raw: string): any {
  const text = String(raw ?? '').trim().replace(/^\uFEFF/, '');
  try { return JSON.parse(text); } catch { /* repair below */ }
  let out = '';
  let inString = false;
  let closeQuote = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      if (ch === '\\') { out += ch + (next ?? ''); i++; continue; }
      if (ch === closeQuote) { inString = false; out += '"'; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch === '"') { out += '\\"'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === '\u201C' || ch === '\u201D') {
      inString = true;
      closeQuote = ch === '"' ? '"' : '\u201D';
      out += '"';
      continue;
    }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(out);
}

function normalizeToolCall(value: any): ToolCall | null {
  if (!isPlainObject(value)) return null;
  const tool = value.tool ?? value.name ?? value.function;
  if (typeof tool !== 'string' || !tool.trim()) return null;
  let args = value.args ?? value.arguments ?? value.params ?? value.input ?? {};
  if (typeof args === 'string') { try { args = lenientJsonParse(args); } catch { args = { query: args }; } }
  return { tool: tool.trim(), args: isPlainObject(args) ? args : {} };
}

function parseConfig(value: unknown): Record<string, any> {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { const parsed = lenientJsonParse(value); if (isPlainObject(parsed)) return parsed; } catch { /* ignore */ }
  }
  return {};
}

export function normalizeProposal(value: any): AIProposal | null {
  if (!isPlainObject(value)) return null;
  const source = isPlainObject(value.workflow) ? { ...value.workflow, ...value } : value;
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : null;
  const rawUpdate = source.update ?? source.updates ?? source.updateNodes ?? source.modify;
  const rawRemove = source.remove ?? source.removeNodes ?? source.delete ?? source.deleteNodes;
  if (!rawNodes && !Array.isArray(rawUpdate) && !Array.isArray(rawRemove)) return null;

  const nodes: ProposalNode[] = (rawNodes || [])
    .filter(isPlainObject)
    .map((node: any, index: number) => ({
      id: asId(node.id) || `n${index + 1}`,
      type: asId(node.type),
      label: typeof node.label === 'string' && node.label.trim() ? node.label.trim() : undefined,
      config: parseConfig(node.config),
    }));
  const edges: ProposalEdge[] = (Array.isArray(source.edges) ? source.edges : [])
    .filter(isPlainObject)
    .map((edge: any) => ({
      source: asId(edge.source ?? edge.from),
      target: asId(edge.target ?? edge.to),
      sourceHandle: edge.sourceHandle != null && String(edge.sourceHandle).trim() ? String(edge.sourceHandle).trim() : 'default',
    }));
  const update: ProposalUpdate[] = (Array.isArray(rawUpdate) ? rawUpdate : [])
    .filter(isPlainObject)
    .map((item: any) => ({
      id: asId(item.id),
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined,
      config: parseConfig(item.config),
    }))
    .filter((item: ProposalUpdate) => item.id);
  const remove: string[] = (Array.isArray(rawRemove) ? rawRemove : [])
    .map((item: any) => asId(isPlainObject(item) ? item.id : item))
    .filter(Boolean);
  const removeEdges = (Array.isArray(source.removeEdges) ? source.removeEdges : [])
    .filter(isPlainObject)
    .map((edge: any) => ({
      source: asId(edge.source ?? edge.from),
      target: asId(edge.target ?? edge.to),
      ...(edge.sourceHandle != null && String(edge.sourceHandle).trim() ? { sourceHandle: String(edge.sourceHandle).trim() } : {}),
    }))
    .filter((edge: { source: string; target: string }) => edge.source && edge.target);
  const mode: ProposalMode = ['replace', 'overwrite', 'full'].includes(foldAscii(source.mode)) ? 'replace' : 'append';
  return {
    mode,
    title: typeof source.title === 'string' ? source.title.trim() : undefined,
    summary: typeof source.summary === 'string' ? source.summary.trim() : undefined,
    nodes,
    edges,
    update,
    remove,
    removeEdges,
  };
}

const BLOCK_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const OPEN_PROTOCOL_RE = /```[^\n`]*deplao-(workflow|tool)[^\n`]*\n[\s\S]*$/;

export function parseCopilotReply(raw: string): ParsedReply {
  const text = String(raw ?? '');
  const blocks: Array<{ info: string; body: string; full: string }> = [];
  BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK_RE.exec(text))) blocks.push({ info: match[1].trim().toLowerCase(), body: match[2], full: match[0] });

  const without = (block: string) => text.replace(block, '').replace(/\n{3,}/g, '\n\n').trim();

  const toolBlock = blocks.find(block => block.info.includes('deplao-tool'));
  if (toolBlock) {
    try {
      const call = normalizeToolCall(lenientJsonParse(toolBlock.body));
      return call
        ? { text: without(toolBlock.full), toolCall: call }
        : { text: without(toolBlock.full), parseError: 'Khối deplao-tool thiếu "tool".' };
    } catch (err: any) {
      return { text: without(toolBlock.full), parseError: `Khối deplao-tool không phải JSON hợp lệ (${err?.message || err}).` };
    }
  }

  const workflowBlock = blocks.find(block => block.info.includes('deplao-workflow'))
    || blocks.find(block => (block.info === 'json' || block.info === '') && /"(nodes|update|remove)"\s*:/.test(block.body));
  if (workflowBlock) {
    try {
      const parsed = lenientJsonParse(workflowBlock.body);
      const proposal = normalizeProposal(parsed);
      if (proposal) return { text: without(workflowBlock.full), proposal };
      const call = normalizeToolCall(parsed);
      if (call) return { text: without(workflowBlock.full), toolCall: call };
      return { text: without(workflowBlock.full), parseError: 'Khối deplao-workflow thiếu mảng "nodes".' };
    } catch (err: any) {
      return { text: without(workflowBlock.full), parseError: `Khối deplao-workflow không phải JSON hợp lệ (${err?.message || err}).` };
    }
  }

  // A protocol block that was opened but never closed (reply cut by the token limit)
  const open = text.match(OPEN_PROTOCOL_RE);
  if (open) {
    return {
      text: text.slice(0, open.index).trim(),
      parseError: `Khối deplao-${open[1]} bị cắt ngang (thiếu \`\`\` đóng) - câu trả lời quá dài.`,
    };
  }

  // Unfenced JSON (weaker models): the outermost {...} holding "nodes"
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start && /"nodes"\s*:/.test(text.slice(start, end + 1))) {
    try {
      const proposal = normalizeProposal(lenientJsonParse(text.slice(start, end + 1)));
      if (proposal) return { text: (text.slice(0, start) + text.slice(end + 1)).trim(), proposal };
    } catch { /* plain text */ }
  }
  return { text: text.trim() };
}

// ─── Final graph (shared by validation and materialisation) ───────────────────

type NodeOrigin = 'existing' | 'updated' | 'new';

interface GraphNode {
  id: string;
  type: string;
  label: string;
  config: Record<string, any>;
  origin: NodeOrigin;
  /** Config keys written by the proposal (these are validated). */
  proposedConfig?: Record<string, any>;
  position?: { x: number; y: number };
}

interface GraphEdge { id?: string; source: string; target: string; sourceHandle: string; data?: any; origin: 'existing' | 'new' }

interface FinalGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  removedIds: string[];
}

/** "true"/"false" for IF, whatever the model wrote (Đúng / yes / true…). */
function canonicalHandle(sourceType: string | undefined, handle: string | null | undefined): string {
  const value = String(handle ?? '').trim() || 'default';
  if (sourceType === 'logic.if') {
    const folded = foldAscii(value);
    if (['true', 'yes', 'dung', 'co', '1'].includes(folded)) return 'true';
    if (['false', 'no', 'sai', 'khong', '0'].includes(folded)) return 'false';
  }
  return value;
}

/** Final graph in the proposal's id space (new nodes keep "n1", "n2"…). */
function buildFinalGraph(proposal: AIProposal, ctx: CopilotContext, mode: ProposalMode): FinalGraph {
  const current = new Map(ctx.currentNodes.map(node => [node.id, node]));
  const nodes: GraphNode[] = [];
  const removed = new Set<string>();

  if (mode === 'append') {
    proposal.remove.forEach(id => { if (current.has(id)) removed.add(id); });
    const updates = new Map<string, ProposalUpdate>();
    proposal.update.forEach(item => {
      const previous = updates.get(item.id);
      updates.set(item.id, previous ? { id: item.id, label: item.label ?? previous.label, config: { ...previous.config, ...item.config } } : item);
    });
    for (const node of ctx.currentNodes) {
      if (removed.has(node.id)) continue;
      const update = updates.get(node.id);
      nodes.push({
        id: node.id,
        type: node.type,
        label: update?.label || node.label || getNodeLabel(node.type),
        config: update ? { ...(node.config || {}), ...update.config } : (node.config || {}),
        origin: update ? 'updated' : 'existing',
        proposedConfig: update?.config,
        position: node.position,
      });
    }
    const taken = new Set(nodes.map(node => node.id));
    for (const node of proposal.nodes) {
      if (taken.has(node.id) || removed.has(node.id)) continue; // collision: reported by validation
      taken.add(node.id);
      nodes.push({ id: node.id, type: node.type, label: node.label || getNodeLabel(node.type), config: node.config, origin: 'new', proposedConfig: node.config });
    }
  } else {
    const taken = new Set<string>();
    for (const node of proposal.nodes) {
      if (taken.has(node.id)) continue;
      taken.add(node.id);
      const old = current.get(node.id);
      if (old && old.type === node.type) {
        nodes.push({
          id: node.id, type: node.type, label: node.label || old.label || getNodeLabel(node.type),
          config: { ...(old.config || {}), ...node.config }, origin: 'updated', proposedConfig: node.config, position: old.position,
        });
      } else {
        nodes.push({ id: node.id, type: node.type, label: node.label || getNodeLabel(node.type), config: node.config, origin: 'new', proposedConfig: node.config });
      }
    }
    ctx.currentNodes.forEach(node => { if (!taken.has(node.id)) removed.add(node.id); });
  }

  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges: GraphEdge[] = [];
  if (mode === 'append') {
    const dropped = (edge: CanvasEdge) => proposal.removeEdges.some(rm =>
      rm.source === edge.source && rm.target === edge.target
      && (!rm.sourceHandle || canonicalHandle(byId.get(edge.source)?.type, rm.sourceHandle) === (edge.sourceHandle || 'default')));
    for (const edge of ctx.currentEdges) {
      if (removed.has(edge.source) || removed.has(edge.target) || dropped(edge)) continue;
      edges.push({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle || 'default', data: edge.data, origin: 'existing' });
    }
  }
  for (const edge of proposal.edges) {
    edges.push({ source: edge.source, target: edge.target, sourceHandle: canonicalHandle(byId.get(edge.source)?.type, edge.sourceHandle), origin: 'new' });
  }
  return { nodes, edges, removedIds: [...removed] };
}

/** Telegram Bot inline buttons that run a node of the workflow. */
function inlineRoutes(node: { type: string; config: Record<string, any> }): Array<{ buttonText: string; targetNodeId: string }> {
  if (node.type !== 'tgbot.action.sendMessage') return [];
  const keyboard = node.config?.keyboard;
  if (!isPlainObject(keyboard) || keyboard.type !== 'inline' || !Array.isArray(keyboard.rows)) return [];
  return keyboard.rows.flatMap((row: unknown) => (Array.isArray(row) ? row : [row]))
    .filter((button: any) => isPlainObject(button) && (button.action || 'node') === 'node' && asId(button.targetNodeId))
    .map((button: any) => ({ buttonText: String(button.text || ''), targetNodeId: asId(button.targetNodeId) }));
}

function validHandles(node: { type: string; config: Record<string, any> }): string[] | null {
  if (node.type === 'logic.if') return ['true', 'false'];
  if (node.type === 'logic.forEach') return ['default', 'done'];
  if (node.type === 'logic.switch') {
    const cases = Array.isArray(node.config?.cases) ? node.config.cases : [];
    const labels = cases.map((c: any, i: number) => String((Array.isArray(c) ? c[1] : c?.label) || i)).filter(Boolean);
    return [...labels, String(node.config?.defaultLabel || 'default')];
  }
  if (node.type === 'output.log') return [];
  return null; // only "default"
}

function hasCycle(ids: string[], edges: Array<{ source: string; target: string }>): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) adjacency.set(edge.source, [...(adjacency.get(edge.source) || []), edge.target]);
  const state = new Map<string, number>(); // 1 = on the stack, 2 = done
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of adjacency.get(id) || []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return ids.some(id => visit(id));
}

function collectStrings(value: any, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, out));
  else if (isPlainObject(value)) Object.values(value).forEach(item => collectStrings(item, out));
  return out;
}

const TEMPLATE_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

// ─── Validation ───────────────────────────────────────────────────────────────

/** Checks the proposal as it would be applied with `mode` (default: the proposal's mode). */
export function validateProposal(proposal: AIProposal, ctx: CopilotContext, mode: ProposalMode = proposal.mode): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed = getAllowedNodeTypes(ctx.channel);
  const currentIds = new Set(ctx.currentNodes.map(node => node.id));
  const graph = buildFinalGraph(proposal, ctx, mode);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const name = (id: string) => {
    const node = byId.get(id) || ctx.currentNodes.find(item => item.id === id);
    return `Node "${id}"${node ? ` (${node.type})` : ''}`;
  };

  if (!proposal.nodes.length && !proposal.update.length && !proposal.remove.length && !proposal.removeEdges.length) {
    errors.push('Đề xuất không có thay đổi nào (nodes / update / remove trống).');
  }
  if (mode === 'replace' && (proposal.update.length || proposal.remove.length || proposal.removeEdges.length)) {
    warnings.push('"replace" bỏ qua update / remove / removeEdges - đề xuất phải chứa toàn bộ workflow.');
  }

  // Ids of new nodes
  const seen = new Set<string>();
  for (const node of proposal.nodes) {
    if (seen.has(node.id)) errors.push(`Id "${node.id}" bị trùng - mỗi node một id riêng.`);
    else if (mode === 'append' && currentIds.has(node.id)) errors.push(`Id "${node.id}" trùng node đang có trên sơ đồ - node mới dùng id khác (n1, n2…); muốn sửa node cũ thì dùng "update".`);
    seen.add(node.id);
  }

  // update / remove targets
  if (mode === 'append') {
    for (const item of proposal.update) {
      if (!currentIds.has(item.id)) errors.push(`"update" trỏ tới node "${item.id}" không có trên sơ đồ.`);
      if (proposal.remove.includes(item.id)) errors.push(`Node "${item.id}" vừa "update" vừa "remove".`);
    }
    for (const id of proposal.remove) if (!currentIds.has(id)) warnings.push(`"remove" trỏ tới node "${id}" không có trên sơ đồ (bỏ qua).`);
    for (const rm of proposal.removeEdges) {
      if (!ctx.currentEdges.some(edge => edge.source === rm.source && edge.target === rm.target)) {
        warnings.push(`"removeEdges" ${rm.source} → ${rm.target}: không có cạnh này trên sơ đồ (bỏ qua).`);
      }
    }
  }

  // Types + config of new / updated nodes
  for (const node of graph.nodes) {
    if (node.origin === 'existing') continue;
    const label = name(node.id);
    if (node.origin === 'new') {
      if (!node.type) { errors.push(`${label}: thiếu "type".`); continue; }
      if (!ITEM_BY_TYPE.has(node.type)) { errors.push(`${label}: type "${node.type}" không tồn tại - chỉ dùng type trong danh mục (gọi get_node_details nếu chưa chắc).`); continue; }
      if (!allowed.has(node.type)) { errors.push(`${label}: node này không thuộc kênh ${ctx.channelLabel}.`); continue; }
    }
    const proposed = node.proposedConfig || {};
    const fields = (ctx.schema[node.type] || []).filter(field => field.type !== 'info');
    if (fields.length && !CUSTOM_CONFIG_DOCS[node.type]) {
      const keys = new Set(fields.map(field => field.key));
      const defaults = DEFAULT_CONFIGS[node.type] || {};
      const unknown = Object.keys(proposed).filter(key => !keys.has(key) && !(key in defaults));
      if (unknown.length) warnings.push(`${label}: trường không có trong cấu hình: ${unknown.join(', ')} (sẽ bị bỏ qua). Trường hợp lệ: ${[...keys].join(', ')}.`);
      for (const field of fields) {
        const value = proposed[field.key];
        if (value === undefined || value === null || value === '') continue;
        if ((field.type === 'select' || field.type === 'choice') && field.options?.length) {
          const text = String(value);
          if (!text.includes('{{') && !field.options.some(opt => opt.value === text)) {
            errors.push(`${label}: "${field.key}" = ${JSON.stringify(value)} không hợp lệ. Giá trị hợp lệ: ${field.options.slice(0, 20).map(opt => JSON.stringify(opt.value)).join(', ')}.`);
          }
        }
        if (field.type === 'number' && typeof value !== 'number' && !(typeof value === 'string' && (/^-?\d+(\.\d+)?$/.test(value.trim()) || value.includes('{{')))) {
          errors.push(`${label}: "${field.key}" phải là số.`);
        }
        if (field.type === 'boolean' && typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
          errors.push(`${label}: "${field.key}" phải là true hoặc false.`);
        }
        if (field.type === 'chips' && !Array.isArray(value)) errors.push(`${label}: "${field.key}" phải là mảng.`);
        if (field.type === 'cron' && String(value).trim().split(/\s+/).length !== 5) {
          errors.push(`${label}: "${field.key}" phải là cron 5 trường, VD "0 8 * * *".`);
        }
      }
    }
    if (node.type === 'logic.switch' && !(Array.isArray(node.config.cases) && node.config.cases.length)) {
      errors.push(`${label}: cần "cases" dạng [{"match":"…","label":"…"}].`);
    }
    if (node.type === 'logic.forEachContact') {
      const source = node.config.source || 'friends';
      if (source === 'group_members' && !asId(node.config.groupId)) warnings.push(`${label}: nguồn "group_members" cần "groupId" (tra bằng search_contacts type "group").`);
      if (source === 'labels' && !(Array.isArray(node.config.labelIds) && node.config.labelIds.length)) warnings.push(`${label}: nguồn "labels" cần "labelIds" (tra bằng list_labels).`);
    }
  }

  // Triggers
  const triggers = graph.nodes.filter(node => isTriggerType(node.type));
  if (triggers.length === 0) errors.push('Workflow chưa có node kích hoạt (trigger).');
  if (triggers.length > 1) {
    const old = triggers.filter(node => node.origin !== 'new').map(node => node.id);
    errors.push(mode === 'append' && old.length
      ? `Sơ đồ đã có trigger (${old.join(', ')}) - "append" không được thêm trigger mới; nối node mới vào sau node đang có (hoặc "remove" trigger cũ).`
      : `Có ${triggers.length} trigger - chỉ được 1.`);
  }

  // New edges
  const normalEdges = graph.edges.filter(edge => !edge.data?.telegramInline);
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges.filter(item => item.origin === 'new')) {
    const label = `Cạnh ${edge.source} → ${edge.target}`;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source) { errors.push(`${label}: không có node "${edge.source}"${graph.removedIds.includes(edge.source) ? ' (đã bị xoá)' : ''}.`); continue; }
    if (!target) { errors.push(`${label}: không có node "${edge.target}"${graph.removedIds.includes(edge.target) ? ' (đã bị xoá)' : ''}.`); continue; }
    if (edge.source === edge.target) { errors.push(`${label}: node không được nối vào chính nó.`); continue; }
    if (isTriggerType(target.type)) errors.push(`${label}: không được nối vào trigger.`);
    const handles = validHandles(source);
    if (handles === null && edge.sourceHandle !== 'default') errors.push(`${label}: ${source.type} chỉ có sourceHandle "default".`);
    if (handles && handles.length === 0) errors.push(`${label}: ${source.type} là node cuối, không nối tiếp được.`);
    if (handles && handles.length && !handles.includes(edge.sourceHandle)) {
      errors.push(`${label}: sourceHandle "${edge.sourceHandle}" không hợp lệ cho ${source.type}. Dùng: ${handles.map(h => `"${h}"`).join(', ')}.`);
    }
    const key = `${edge.source}|${edge.sourceHandle}|${edge.target}`;
    if (edgeKeys.has(key)) warnings.push(`${label}: cạnh bị lặp (bỏ bớt).`);
    edgeKeys.add(key);
  }
  const validEdges = normalEdges.filter(edge => byId.has(edge.source) && byId.has(edge.target) && edge.source !== edge.target);
  if (hasCycle(graph.nodes.map(node => node.id), validEdges)) errors.push('Có vòng lặp giữa các node - engine không hỗ trợ.');

  // Telegram Bot inline buttons
  const inlineTargets = new Set<string>();
  for (const node of graph.nodes) {
    if (node.origin === 'existing') {
      inlineRoutes(node).forEach(route => inlineTargets.add(route.targetNodeId));
      continue;
    }
    const keyboard = node.config?.keyboard;
    if (node.type === 'tgbot.action.sendMessage' && isPlainObject(keyboard) && keyboard.type === 'reply' && Array.isArray(keyboard.rows)
      && keyboard.rows.flat().some((button: any) => isPlainObject(button) && (button.action === 'node' || button.targetNodeId))) {
      warnings.push(`${name(node.id)}: nút chạy node ("action":"node") chỉ hoạt động với keyboard "inline".`);
    }
    for (const route of inlineRoutes(node)) {
      if (!byId.has(route.targetNodeId)) { errors.push(`${name(node.id)}: nút "${route.buttonText}" trỏ tới node "${route.targetNodeId}" không có.`); continue; }
      inlineTargets.add(route.targetNodeId);
      if (normalEdges.some(edge => edge.source === node.id && edge.target === route.targetNodeId)) {
        warnings.push(`${name(node.id)}: đã có cạnh thường tới "${route.targetNodeId}" - node đó sẽ chạy ngay, không chờ khách bấm nút "${route.buttonText}".`);
      }
    }
  }

  // Nodes without an incoming edge
  const incoming = new Set([...validEdges.map(edge => edge.target), ...inlineTargets]);
  for (const node of graph.nodes) {
    if (isTriggerType(node.type) || incoming.has(node.id)) continue;
    if (node.origin === 'new') errors.push(`${name(node.id)} chưa có cạnh đi vào - nối từ trigger hoặc node trước.`);
    else if (ctx.currentEdges.some(edge => edge.target === node.id && !edge.data?.telegramInline)) {
      warnings.push(`${name(node.id)} không còn cạnh đi vào sau thay đổi - node này sẽ không chạy.`);
    }
  }

  // Template variables in the proposed config
  const triggerTypes = [...new Set(triggers.map(node => node.type))];
  const labelToId = new Map(graph.nodes.map(node => [node.label, node.id]));
  for (const node of graph.nodes) {
    if (!node.proposedConfig) continue;
    const where = name(node.id);
    let ancestors: Set<string> | null = null;
    for (const text of collectStrings(node.proposedConfig)) {
      TEMPLATE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TEMPLATE_RE.exec(text))) {
        const expr = m[1].trim();
        if (!expr) continue;
        if (/^\$(prev|vars|input|json|item)\b/.test(expr)) { errors.push(`${where}: {{ ${expr} }} không tồn tại (dùng $node.<id>.… hoặc $var.<tên>).`); continue; }
        if (/^(trigger|node|var|date|pageId)\b/.test(expr)) { errors.push(`${where}: {{ ${expr} }} thiếu dấu $ ở đầu.`); continue; }
        if (/\|\||\?\?|[|()]|\s[+*/-]\s/.test(expr)) { errors.push(`${where}: {{ ${expr} }} - trong {{ }} chỉ được 1 biến, không có phép tính / bộ lọc.`); continue; }
        if (expr.startsWith('$trigger.')) {
          if (triggerTypes.length && !isVarAvailable(expr, triggerTypes)) {
            const available = triggerTypes.flatMap(triggerFieldNames).join(', ');
            errors.push(`${where}: trigger ${triggerTypes.join(', ')} không có {{ ${expr} }}. Có: ${available || 'không có biến $trigger'}.`);
          }
        } else if (expr.startsWith('$node.')) {
          const rest = expr.slice(6);
          const dot = rest.indexOf('.');
          const ref = dot === -1 ? rest : rest.slice(0, dot);
          if (dot === -1 || !rest.slice(dot + 1).trim()) { errors.push(`${where}: {{ ${expr} }} thiếu tên trường (VD {{ $node.${ref}.result }}).`); continue; }
          const refId = byId.has(ref) ? ref : labelToId.get(ref);
          if (!refId) { errors.push(`${where}: {{ ${expr} }} trỏ tới node "${ref}" không có trong workflow.`); continue; }
          if (refId === node.id) { errors.push(`${where}: {{ ${expr} }} trỏ tới chính node này.`); continue; }
          // Node phía trước; sau cổng "Xong" của Lặp qua danh sách thì gồm cả thân vòng lặp
          ancestors = ancestors || upstreamNodeIds(node.id, validEdges, id => byId.get(id)?.type);
          if (!ancestors.has(refId) && !inlineTargets.has(node.id)) {
            errors.push(`${where}: {{ ${expr} }} - node "${ref}" không chạy TRƯỚC node này (không nằm trên đường đi tới nó).`);
          }
        } else if (!/^\$(var\.\S|date\.(now|today)$|pageId$)/.test(expr)) {
          errors.push(`${where}: biến {{ ${expr} }} không tồn tại.`);
        }
      }
    }
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function formatValidationFeedback(result: ValidationResult): string {
  const lines = ['[KIỂM TRA TỰ ĐỘNG] Đề xuất vừa rồi chưa chạy được. Lỗi cần sửa:'];
  result.errors.forEach((error, index) => lines.push(`${index + 1}. ${error}`));
  if (result.warnings.length) {
    lines.push('Lưu ý thêm:');
    result.warnings.forEach(warning => lines.push(`- ${warning}`));
  }
  lines.push('Sửa TẤT CẢ lỗi rồi gửi lại khối deplao-workflow ĐẦY ĐỦ (giữ nguyên phần đúng), giải thích ngắn gọn.');
  return lines.join('\n');
}

export function formatParseFeedback(parseError: string): string {
  return `[KIỂM TRA TỰ ĐỘNG] ${parseError}\nGửi lại đúng định dạng: 1 khối \`\`\`deplao-workflow (hoặc \`\`\`deplao-tool) chứa JSON hợp lệ. Viết NGẮN GỌN - bỏ bớt phần giải thích để khối JSON không bị cắt.`;
}

// ─── Materialise ──────────────────────────────────────────────────────────────

export interface MaterializedWorkflow {
  /** The whole canvas after applying. */
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  addedIds: string[];
  updatedIds: string[];
  removedIds: string[];
}

function coerceConfig(type: string, config: Record<string, any>, schema: CopilotSchema): Record<string, any> {
  const fields = schema[type] || [];
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(config || {})) {
    const field = fields.find(entry => entry.key === key);
    if (field?.type === 'boolean' && (value === 'true' || value === 'false')) out[key] = value === 'true';
    else if (field?.type === 'number' && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) out[key] = Number(value);
    else if (field?.type === 'contact-picker' && field.contactMode === 'multi' && Array.isArray(value)) out[key] = value.length ? JSON.stringify(value.map(String)) : '';
    else if (field?.type === 'chips' && typeof value === 'string') out[key] = value.split(',').map(item => item.trim()).filter(Boolean);
    else out[key] = value;
  }
  return out;
}

function remapNodeRefs(value: any, idMap: Record<string, string>): any {
  if (typeof value === 'string') {
    return value.replace(/(\$node\.)([^.\s}]+)(\.)/g, (whole, prefix, ref, dot) => (idMap[ref] ? `${prefix}${idMap[ref]}${dot}` : whole));
  }
  if (Array.isArray(value)) return value.map(item => remapNodeRefs(item, idMap));
  if (isPlainObject(value)) {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) out[key] = remapNodeRefs(item, idMap);
    return out;
  }
  return value;
}

const BUTTON_ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

/** Inline keyboard: targetNodeId remapped, every button gets a valid unique id (callback route). */
function fixKeyboard(config: Record<string, any>, idMap: Record<string, string>, newId: () => string): Record<string, any> {
  const keyboard = config.keyboard;
  if (!isPlainObject(keyboard) || !Array.isArray(keyboard.rows)) return config;
  const used = new Set<string>();
  const rows = keyboard.rows.map((row: unknown) => (Array.isArray(row) ? row : [row]).filter(isPlainObject).map((button: any) => {
    let id = asId(button.id);
    if (!BUTTON_ID_RE.test(id) || used.has(id)) id = `btn_${newId().replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}`;
    used.add(id);
    const next: Record<string, any> = { ...button, id, text: String(button.text || 'Nút'), action: button.action || 'node' };
    if (next.targetNodeId) next.targetNodeId = idMap[asId(next.targetNodeId)] || asId(next.targetNodeId);
    return next;
  }));
  return { ...config, keyboard: { enabled: true, ...keyboard, rows } };
}

function fillAssistant(type: string, config: Record<string, any>, ctx: CopilotContext): Record<string, any> {
  if ((type === 'ai.generateText' || type === 'ai.classify') && ctx.defaultAssistant?.id
    && (config.aiConfigMode || 'assistant') === 'assistant' && !asId(config.assistantId)) {
    return { ...config, assistantId: ctx.defaultAssistant.id };
  }
  return config;
}

/**
 * The whole canvas after applying `proposal` with `mode`. Invalid parts are dropped (unknown /
 * other-channel node types, edges to missing nodes, self loops, edges into a trigger, duplicates).
 * append: canvas nodes keep their place, new nodes are laid out as one block on the right.
 * replace: the result is laid out again (nodes kept from the canvas start from their position).
 */
export function materializeProposal(
  proposal: AIProposal,
  mode: ProposalMode,
  ctx: CopilotContext,
  newId: () => string,
): MaterializedWorkflow {
  const allowed = getAllowedNodeTypes(ctx.channel);
  const graph = buildFinalGraph(proposal, ctx, mode);
  const kept = graph.nodes.filter(node => node.origin !== 'new' || allowed.has(node.type));
  const originOf = new Map<string, NodeOrigin>();

  const idMap: Record<string, string> = {};
  for (const node of kept) if (node.origin === 'new') idMap[node.id] = newId();
  const resolve = (id: string) => idMap[id] || id;

  const nodes: CanvasNode[] = kept.map(node => {
    originOf.set(resolve(node.id), node.origin);
    const original = ctx.currentNodes.find(item => item.id === node.id);
    if (node.origin === 'existing' && original) return { ...original, label: original.label || node.label, config: original.config || {} };
    const base = node.origin === 'new'
      ? { ...(DEFAULT_CONFIGS[node.type] || {}), ...coerceConfig(node.type, node.proposedConfig || {}, ctx.schema) }
      : { ...(original?.config || {}), ...coerceConfig(node.type, node.proposedConfig || {}, ctx.schema) };
    const config = fixKeyboard(remapNodeRefs(fillAssistant(node.type, base, ctx), idMap), idMap, newId);
    return { id: resolve(node.id), type: node.type, label: node.label, config, position: node.position || { x: 0, y: 0 } };
  });
  const finalIds = new Set(nodes.map(node => node.id));
  const typeOf = new Map(nodes.map(node => [node.id, node.type]));
  // Senders whose keyboard may have changed: their inline-route edges are regenerated
  const changedSenders = new Set(nodes
    .filter(node => node.type === 'tgbot.action.sendMessage' && (mode === 'replace' || originOf.get(node.id) !== 'existing'))
    .map(node => node.id));

  const edges: CanvasEdge[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const source = resolve(edge.source);
    const target = resolve(edge.target);
    const inline = !!edge.data?.telegramInline;
    if (!finalIds.has(source) || !finalIds.has(target) || source === target) continue;
    if (inline && changedSenders.has(source)) continue;
    if (!inline && isTriggerType(typeOf.get(target) || '')) continue;
    const key = `${source}|${edge.sourceHandle}|${target}|${inline ? 'inline' : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge.origin === 'existing'
      ? { id: edge.id, source, target, sourceHandle: edge.sourceHandle, data: edge.data }
      : { id: newId(), source, target, sourceHandle: edge.sourceHandle });
  }
  for (const node of nodes) {
    if (!changedSenders.has(node.id)) continue;
    for (const target of new Set(inlineRoutes({ type: node.type, config: node.config || {} }).map(route => route.targetNodeId))) {
      if (!finalIds.has(target) || target === node.id) continue;
      edges.push({ id: `telegram-inline:${node.id}:${target}`, source: node.id, target, sourceHandle: 'default', data: { telegramInline: true } });
    }
  }

  const addedIds = nodes.filter(node => originOf.get(node.id) === 'new').map(node => node.id);
  const updatedIds = nodes.filter(node => originOf.get(node.id) === 'updated').map(node => node.id);
  const layoutEdges = edges.filter(edge => !edge.data?.telegramInline)
    .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle || 'default' }));

  if (mode === 'replace') {
    const positions = computeAutoLayout(
      nodes.map(node => ({ id: node.id, position: node.position || { x: 0, y: 0 }, data: { type: node.type, config: node.config } })),
      layoutEdges,
    );
    return {
      nodes: nodes.map(node => ({ ...node, position: positions[node.id] || node.position })),
      edges, addedIds, updatedIds, removedIds: graph.removedIds,
    };
  }

  // append: lay out the new nodes as one block, right of the current diagram
  const added = new Set(addedIds);
  if (added.size) {
    const block = nodes.filter(node => added.has(node.id));
    const positions = computeAutoLayout(
      block.map(node => ({ id: node.id, position: { x: 0, y: 0 }, data: { type: node.type, config: node.config } })),
      layoutEdges.filter(edge => added.has(edge.source) && added.has(edge.target)),
    );
    const placed = Object.values(positions);
    const minX = placed.length ? Math.min(...placed.map(p => p.x)) : 0;
    const minY = placed.length ? Math.min(...placed.map(p => p.y)) : 0;
    const others = nodes.filter(node => !added.has(node.id) && node.position);
    const anchorEdge = layoutEdges.find(edge => added.has(edge.target) && !added.has(edge.source));
    const anchor = anchorEdge ? others.find(node => node.id === anchorEdge.source) : undefined;
    const offsetX = others.length
      ? Math.max(...others.map(node => node.position!.x)) + AUTO_LAYOUT_SPACING.nodeWidth + AUTO_LAYOUT_SPACING.componentGap
      : 100;
    const offsetY = anchor?.position
      ? anchor.position.y + AUTO_LAYOUT_SPACING.nodeHeight + AUTO_LAYOUT_SPACING.layerGap
      : others.length ? Math.min(...others.map(node => node.position!.y)) : 100;
    for (const node of block) {
      const p = positions[node.id] || { x: 0, y: 0 };
      node.position = { x: Math.round(p.x - minX + offsetX), y: Math.round(p.y - minY + offsetY) };
    }
  }
  return { nodes, edges, addedIds, updatedIds, removedIds: graph.removedIds };
}

// ─── Conversation → API messages ──────────────────────────────────────────────

export type CopilotItemKind = 'user' | 'assistant' | 'tool' | 'check' | 'note' | 'error';

export interface CopilotItem {
  id: string;
  kind: CopilotItemKind;
  /** Text sent to the model (assistant: the raw reply). 'error' items are UI-only. */
  content: string;
  ts: number;
  /** assistant: reply text without the protocol block. */
  display?: string;
  proposal?: AIProposal;
  toolCall?: ToolCall;
  parseError?: string;
  /** assistant: proposal that failed the checks and was repaired automatically afterwards. */
  draft?: boolean;
  /** assistant: proposal number shown to the user (v1, v2…). */
  version?: number;
  appliedMode?: ProposalMode;
  tokens?: number;
  /** tool / check / note: short label for the UI. */
  label?: string;
}

const FENCE_RE = /```[^\n`]*\n[\s\S]*?```/g;

/** System prompt + conversation: old proposals compacted, old tool results shortened, same roles merged. */
export function buildApiMessages(
  systemPrompt: string,
  items: CopilotItem[],
  maxItems = 40,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  let recent = items.filter(item => item.kind !== 'error' && item.content.trim()).slice(-maxItems);
  while (recent.length && recent[0].kind === 'assistant') recent = recent.slice(1);
  let lastProposal = -1;
  let lastUser = -1;
  recent.forEach((item, index) => {
    if (item.kind === 'assistant' && item.proposal) lastProposal = index;
    if (item.kind === 'user') lastUser = index;
  });
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: systemPrompt }];
  recent.forEach((item, index) => {
    const role: 'user' | 'assistant' = item.kind === 'assistant' ? 'assistant' : 'user';
    let content = item.content;
    if (item.kind === 'assistant' && item.proposal && index !== lastProposal) {
      content = content.replace(FENCE_RE, block => (/"(nodes|update|remove)"\s*:/.test(block)
        ? `\`\`\`deplao-workflow\n(đề xuất ${item.version ? `v${item.version}` : 'cũ'} - đã lược bớt)\n\`\`\``
        : block));
    }
    if (item.kind === 'tool') {
      const limit = index < lastUser ? 1500 : 9000;
      if (content.length > limit) content = `${content.slice(0, limit)}\n…(đã lược bớt)`;
    }
    const last = out[out.length - 1];
    if (last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  });
  return out;
}

// ─── Tool results ─────────────────────────────────────────────────────────────

export const COPILOT_TOOLS = ['get_node_details', 'search_contacts', 'list_labels'] as const;

export interface ContactSearchGroup {
  account: string;
  items: Array<{ id: string; name: string; type: string }>;
  total: number;
  error?: string;
}

export function formatContactSearch(query: string, groups: ContactSearchGroup[]): string {
  if (!groups.length) return 'Không có tài khoản nào để tìm.';
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`Tài khoản "${group.account}":`);
    if (group.error) { lines.push(`  (lỗi: ${group.error})`); continue; }
    if (!group.items.length) { lines.push(`  không có hội thoại nào khớp "${query}".`); continue; }
    for (const item of group.items) lines.push(`  - ${item.name} | id: ${item.id} | ${item.type === 'group' ? 'nhóm' : 'cá nhân'}`);
    if (group.total > group.items.length) lines.push(`  … còn ${group.total - group.items.length} kết quả khác - hỏi người dùng tên cụ thể hơn nếu chưa đúng.`);
  }
  return lines.join('\n');
}

export function formatLabelList(labels: Array<{ id: any; name?: string; emoji?: string }>): string {
  const valid = labels.filter(label => label && label.id !== undefined && label.id !== null && String(label.id) !== '');
  if (!valid.length) return 'Chưa có Nhãn Local nào. Nhắc người dùng tạo nhãn trong CRM rồi chọn trong node sau khi áp dụng.';
  const shown = valid.slice(0, 80);
  return [
    'Nhãn Local (dùng giá trị trong ngoặc kép cho labelIds):',
    ...shown.map(label => `- "local:${label.id}" — ${label.emoji ? `${label.emoji} ` : ''}${label.name || `Nhãn #${label.id}`}`),
    ...(valid.length > shown.length ? [`… và ${valid.length - shown.length} nhãn khác.`] : []),
  ].join('\n');
}
