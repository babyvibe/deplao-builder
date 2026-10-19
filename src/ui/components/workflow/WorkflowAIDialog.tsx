/**
 * WorkflowAIDialog - "Trợ lý thiết kế workflow": the user and the AI analyse the need together in a
 * chat until the proposal is right, then apply it (add to / replace the current workflow).
 *
 * Agent loop per user message (logic in aiCopilot.ts):
 *   system prompt (live node catalogue + current canvas) + conversation → ipc.ai.chatRaw
 *   → reply with a ```deplao-tool``` call   → run the tool locally, send "[KẾT QUẢ CÔNG CỤ]", loop
 *   → reply with a ```deplao-workflow```    → validate like the engine; errors → automatic repair
 *                                              (max MAX_REPAIRS), then show the proposal + preview
 *   → plain text                            → question / advice, the user answers
 * The conversation is kept per workflow (memory + localStorage) so it survives closing the dialog.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import DataAccessor from '../../lib/data/DataAccessor';
import ipc from '../../lib/ipc';
import { Channel, getChannelLabel } from '../../../configs/channelConfig';
import { useAppStore } from '@/store/appStore';
import { useAccountStore, AccountInfo } from '@/store/accountStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import {
  AlertIcon, CheckCircleIcon, ChevronDownIcon, CloseIcon, LightbulbIcon, PlusIcon, SearchIcon,
  SendIcon, SparklesIcon, TagIcon, WrenchIcon,
} from '@/components/common/icons';
import { CONFIG_SCHEMA } from './NodeConfigPanel';
import { NodeIconTile } from './nodeVisuals';
import { getNodeLabel } from './workflowConfig';
import { resolvePickerAccounts } from './ContactPicker';
import CopilotPreview, { primaryModeFor } from './CopilotPreview';
import {
  CanvasEdge, CanvasNode, ContactSearchGroup, CopilotContext, CopilotItem, CopilotSchema,
  MaterializedWorkflow, ProposalMode, ToolCall, ValidationResult,
  buildApiMessages, buildCopilotSystemPrompt, describeNodeDetails, formatContactSearch, formatLabelList,
  formatParseFeedback, formatValidationFeedback, materializeProposal, normalizeTypeList, parseCopilotReply,
  validateProposal,
} from './aiCopilot';

interface WorkflowAIDialogProps {
  workflowId: string;
  currentNodes: CanvasNode[];
  currentEdges: CanvasEdge[];
  channel: Channel;
  pageIds: string[];
  /** `result` is the whole canvas after applying. */
  onApply: (result: MaterializedWorkflow, mode: ProposalMode, title: string) => void;
  onClose: () => void;
}

type AssistantOption = { id: string; name: string; platform?: string; model?: string; isDefault?: boolean; enabled?: boolean };

// ─── Limits ───────────────────────────────────────────────────────────────────

const MAX_STEPS = 8;        // model calls for one user message
const MAX_TOOL_CALLS = 4;   // tool calls for one user message
const MAX_REPAIRS = 2;      // automatic repairs of a broken / invalid proposal
const MAX_TOKENS = 6000;
const TEMPERATURE = 0.3;

// ─── Conversation storage (per workflow) ──────────────────────────────────────

const STORAGE_PREFIX = 'deplao.wfCopilot.';
const ASSISTANT_KEY = 'deplao.wfCopilot.assistant';
const MAX_STORED_ITEMS = 80;
const conversationCache = new Map<string, CopilotItem[]>();

function loadConversation(key: string): CopilotItem[] {
  const cached = conversationCache.get(key);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + key) || 'null');
    if (Array.isArray(parsed?.items)) return parsed.items;
  } catch { /* ignore broken storage */ }
  return [];
}

function saveConversation(key: string, items: CopilotItem[]) {
  conversationCache.set(key, items);
  try {
    let list = items.slice(-MAX_STORED_ITEMS);
    let json = JSON.stringify({ v: 1, items: list });
    while (json.length > 400_000 && list.length > 4) {
      list = list.slice(Math.ceil(list.length / 4));
      json = JSON.stringify({ v: 1, items: list });
    }
    if (list.length) localStorage.setItem(STORAGE_PREFIX + key, json);
    else localStorage.removeItem(STORAGE_PREFIX + key);
  } catch { /* quota: memory copy still works */ }
}

const makeItem = (kind: CopilotItem['kind'], content: string, extra: Partial<CopilotItem> = {}): CopilotItem =>
  ({ id: uuidv4(), kind, content, ts: Date.now(), ...extra });

const accountName = (account: AccountInfo): string =>
  account.full_name || account.display_name || (account as any).username || account.zalo_id;

// ─── Example requests ─────────────────────────────────────────────────────────

const EXAMPLES: Record<string, string[]> = {
  zalo: [
    'Khách nhắn hỏi giá thì AI trả lời tự động; khách muốn đặt hàng thì gắn nhãn "Đặt hàng" và báo cho tôi',
    'Chào mừng thành viên mới vào nhóm Zalo bằng tin nhắn có tên của họ',
    'Mỗi sáng 8h gửi lời chào kèm khuyến mãi cho khách có nhãn VIP',
    'Tự động đồng ý kết bạn và gửi tin nhắn giới thiệu shop',
  ],
  facebook: [
    'Khách nhắn tin vào Page thì AI trả lời dựa trên câu hỏi của khách',
    'Ngoài giờ làm việc (21h - 8h) tự động báo khách là shop sẽ phản hồi sớm',
    'Khách gửi ảnh sản phẩm thì cảm ơn và hẹn nhân viên tư vấn ngay',
  ],
  telegram_user: [
    'Có tin nhắn hỏi giá thì trả lời bảng giá',
    'Chào thành viên mới khi họ vào nhóm Telegram',
    'Khách nhắn ngoài giờ làm việc thì tự động báo giờ hoạt động',
  ],
  telegram_bot: [
    'Bot trả lời lệnh /start bằng menu nút bấm: Xem sản phẩm, Liên hệ, Hỗ trợ',
    'Khách bấm nút "Hỗ trợ" thì gửi thông tin liên hệ và báo cho admin',
    'Bot dùng AI trả lời mọi tin nhắn riêng của khách',
  ],
};
const CANVAS_EXAMPLES = [
  'Giải thích workflow hiện tại đang làm gì',
  'Kiểm tra workflow này có lỗi hoặc chỗ nào nên cải thiện không',
  'Thêm hiệu ứng đang gõ vài giây trước khi gửi tin',
];

// ─── Lightweight markdown (bold, code, lists, headings, {{ vars }}) ─────────

function renderInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\{\{[^}]*\}\})/g).filter(Boolean).map((part, index) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={index} className="wf-md-code">{part.slice(1, -1)}</code>;
    if (part.startsWith('{{') && part.endsWith('}}')) return <code key={index} className="wf-var">{part}</code>;
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function MarkdownLite({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  text.split(/```[^\n`]*\n?([\s\S]*?)```/g).forEach((piece, pieceIndex) => {
    if (pieceIndex % 2 === 1) {
      out.push(<pre key={`pre${pieceIndex}`} className="wf-md-pre">{piece.trim()}</pre>);
      return;
    }
    const state: { para: string[]; list: { ordered: boolean; items: string[] } | null } = { para: [], list: null };
    const flushPara = () => {
      if (!state.para.length) return;
      const lines = state.para;
      out.push(<p key={`p${out.length}`}>{lines.map((line, i) => <React.Fragment key={i}>{i > 0 && <br />}{renderInline(line)}</React.Fragment>)}</p>);
      state.para = [];
    };
    const flushList = () => {
      const list = state.list;
      if (!list) return;
      const items = list.items.map((entry, i) => <li key={i}>{renderInline(entry)}</li>);
      out.push(list.ordered ? <ol key={`l${out.length}`}>{items}</ol> : <ul key={`l${out.length}`}>{items}</ul>);
      state.list = null;
    };
    for (const raw of piece.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); flushList(); continue; }
      const heading = line.match(/^\s*#{1,4}\s+(.*)$/);
      if (heading) { flushPara(); flushList(); out.push(<p key={`h${out.length}`} className="wf-md-h">{renderInline(heading[1])}</p>); continue; }
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const ordered = bullet ? null : line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || ordered) {
        flushPara();
        const isOrdered = !!ordered;
        if (state.list && state.list.ordered !== isOrdered) flushList();
        if (!state.list) state.list = { ordered: isOrdered, items: [] };
        state.list.items.push((bullet || ordered)![1]);
        continue;
      }
      flushList();
      state.para.push(line);
    }
    flushPara();
    flushList();
  });
  return <div className="wf-md">{out}</div>;
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

function StopGlyph() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5" /></svg>;
}

/** Collapsible system row (tool result / automatic check), content visible on demand. */
function EventRow({ icon, label, detail, tone }: { icon: React.ReactNode; label: string; detail?: string; tone?: 'danger' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pl-10">
      <button type="button" className="wf-chat-event" data-tone={tone} onClick={() => detail && setOpen(value => !value)}
        title={detail ? (open ? 'Ẩn chi tiết' : 'Xem chi tiết') : undefined}>
        <span className="wf-chat-event__icon">{icon}</span>
        <span className="truncate">{label}</span>
        {detail && <ChevronDownIcon className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && detail && <pre className="wf-md-pre mt-1.5 !mb-0 !max-h-56">{detail}</pre>}
    </div>
  );
}

function ProposalCard({ item, selected, onSelect }: { item: CopilotItem; selected: boolean; onSelect: () => void }) {
  const proposal = item.proposal!;
  if (item.draft) {
    return (
      <div className="wf-proposal-card mt-2" data-draft="true">
        <p className="text-xs wf-muted">Bản nháp chưa đạt kiểm tra - AI đã tự sửa ở tin nhắn sau.</p>
      </div>
    );
  }
  const shown = proposal.nodes.slice(0, 6);
  const extra = proposal.nodes.length - shown.length;
  const edits = proposal.update.length + proposal.remove.length;
  return (
    <button type="button" className="wf-proposal-card mt-2 w-full text-left" data-selected={String(selected)} onClick={onSelect}>
      <div className="flex items-center gap-2">
        <span className="wf-badge !h-[18px]" data-tone="green">v{item.version}</span>
        <span className="text-[13px] font-semibold wf-text truncate flex-1">{proposal.title || 'Đề xuất workflow'}</span>
        {item.appliedMode && <span className="wf-badge !h-[18px]" data-tone="gray">✓ Đã áp dụng</span>}
      </div>
      {(shown.length > 0 || edits > 0) && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {shown.map(node => (
            <span key={node.id} className="inline-flex items-center gap-1.5 max-w-[11rem] pr-1" title={`${node.label || getNodeLabel(node.type)} · ${node.type}`}>
              <NodeIconTile type={node.type} size="sm" showChannel={false} />
              <span className="text-[11.5px] wf-text-2 truncate">{node.label || getNodeLabel(node.type)}</span>
            </span>
          ))}
          {extra > 0 && <span className="text-[11px] wf-faint">+{extra} node</span>}
          {edits > 0 && <span className="wf-badge !h-[18px]" data-tone="yellow">sửa {edits} node cũ</span>}
        </div>
      )}
      <p className="mt-2 text-[11.5px] font-semibold" style={{ color: 'var(--wf-focus)' }}>
        {selected ? 'Đang xem trước →' : 'Xem trước & áp dụng →'}
      </p>
    </button>
  );
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

export default function WorkflowAIDialog({ workflowId, currentNodes, currentEdges, channel, pageIds, onApply, onClose }: WorkflowAIDialogProps) {
  const theme = useAppStore(s => s.theme);
  const showNotification = useAppStore(s => s.showNotification);
  const accounts = useAccountStore(s => s.accounts);
  const isLight = theme === 'light';
  const conversationKey = workflowId || 'draft';
  const channelLabel = getChannelLabel(channel);

  const [items, setItemsState] = useState<CopilotItem[]>(() => loadConversation(conversationKey));
  const itemsRef = useRef(items);
  const setItems = useCallback((next: CopilotItem[]) => {
    itemsRef.current = next;
    setItemsState(next);
    saveConversation(conversationKey, next);
  }, [conversationKey]);

  const [assistants, setAssistants] = useState<AssistantOption[]>([]);
  const [assistantId, setAssistantId] = useState('');
  const [defaultAssistant, setDefaultAssistant] = useState<{ id: string; name: string } | null>(null);
  const [loadingAssistants, setLoadingAssistants] = useState(true);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const finals = loadConversation(conversationKey).filter(item => item.proposal && !item.draft);
    return finals.length ? finals[finals.length - 1].id : null;
  });
  const runRef = useRef(0);
  /** A confirm dialog of this copilot is open (Esc belongs to it). */
  const confirmOpenRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Context for the prompt / validation ──
  const accountNames = useMemo(() => (pageIds.length
    ? accounts.filter(account => pageIds.includes(account.zalo_id)).map(accountName)
    : []), [accounts, pageIds]);
  const ctx: CopilotContext = useMemo(() => ({
    channel,
    channelLabel,
    schema: CONFIG_SCHEMA as CopilotSchema,
    currentNodes,
    currentEdges,
    accountNames,
    defaultAssistant,
  }), [channel, channelLabel, currentNodes, currentEdges, accountNames, defaultAssistant]);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  // ── Assistants ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [defRes, listRes] = await Promise.all([
          DataAccessor.getDefaultAssistant().catch(() => null),
          DataAccessor.getAssistants().catch(() => null),
        ]);
        if (cancelled) return;
        const list: AssistantOption[] = ((listRes as any)?.assistants || []).filter((a: AssistantOption) => a && a.id && a.enabled !== false);
        const def = (defRes as any)?.assistant;
        setAssistants(list);
        if (def?.id) setDefaultAssistant({ id: def.id, name: def.name || 'Trợ lý mặc định' });
        let remembered = '';
        try { remembered = localStorage.getItem(ASSISTANT_KEY) || ''; } catch { /* ignore */ }
        const pick = list.find(a => a.id === remembered) || list.find(a => a.id === def?.id) || list[0];
        setAssistantId(pick?.id || '');
      } finally {
        if (!cancelled) setLoadingAssistants(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const chooseAssistant = (id: string) => {
    setAssistantId(id);
    try { localStorage.setItem(ASSISTANT_KEY, id); } catch { /* ignore */ }
  };

  // ── Scroll / focus / keyboard ──
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);

  const stop = useCallback(() => {
    if (!busy) return;
    runRef.current++;
    setBusy(false);
    setStatus('');
    setItems([...itemsRef.current, makeItem('error', 'Đã dừng. Bạn có thể nhắn tiếp hoặc gửi lại yêu cầu.')]);
  }, [busy, setItems]);

  const close = useCallback(() => {
    if (busy) runRef.current++;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirmOpenRef.current) return;
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close]);

  const confirm = async (options: Parameters<typeof showConfirm>[0]) => {
    confirmOpenRef.current = true;
    try { return await showConfirm(options); } finally { confirmOpenRef.current = false; }
  };

  // ── Tools ──
  const runTool = async (call: ToolCall): Promise<{ label: string; text: string }> => {
    const context = ctxRef.current;
    switch (call.tool) {
      case 'get_node_details': {
        const types = normalizeTypeList(call.args);
        return { label: `Tra cứu node: ${types.join(', ') || '(trống)'}`, text: describeNodeDetails(call.args, context) };
      }
      case 'search_contacts': {
        const query = String(call.args.query ?? call.args.search ?? call.args.name ?? '').trim();
        const rawType = String(call.args.type || 'all');
        const type = rawType === 'user' || rawType === 'group' ? rawType : 'all';
        const list = resolvePickerAccounts(accountsRef.current, { channel, preferredAccountIds: pageIds }).list.slice(0, 3);
        const groups: ContactSearchGroup[] = [];
        for (const account of list) {
          try {
            const res = await DataAccessor.searchContactsForPicker({ zaloId: account.zalo_id, search: query, type, limit: 8 });
            groups.push({
              account: accountName(account),
              items: (res?.items || []).map(entry => ({ id: entry.id, name: entry.name, type: entry.type })),
              total: res?.total || 0,
              error: res && res.success === false ? res.error || 'không đọc được danh bạ' : undefined,
            });
          } catch (err: any) {
            groups.push({ account: accountName(account), items: [], total: 0, error: err?.message || 'không đọc được danh bạ' });
          }
        }
        return { label: `Tìm hội thoại "${query || 'gần đây'}"${type !== 'all' ? ` (${type === 'group' ? 'nhóm' : 'cá nhân'})` : ''}`, text: formatContactSearch(query, groups) };
      }
      case 'list_labels': {
        try {
          const res = await DataAccessor.getLocalLabels({});
          return { label: 'Đọc danh sách Nhãn Local', text: formatLabelList((res as any)?.labels || []) };
        } catch (err: any) {
          return { label: 'Đọc danh sách Nhãn Local', text: `Không đọc được nhãn: ${err?.message || err}` };
        }
      }
      default:
        return { label: `Công cụ không tồn tại: ${call.tool}`, text: `Công cụ "${call.tool}" không tồn tại. Chỉ có: get_node_details, search_contacts, list_labels.` };
    }
  };

  const callModel = async (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
    if (ipc.ai?.chatRaw) return ipc.ai.chatRaw({ assistantId, messages, maxTokens: MAX_TOKENS, temperature: TEMPERATURE });
    return ipc.ai?.chat(assistantId, messages, false, MAX_TOKENS);
  };

  // ── Agent loop ──
  const run = async (first: CopilotItem) => {
    if (busy) return;
    if (!assistantId) { showNotification('Chọn trợ lý AI trước khi trò chuyện', 'warning'); return; }
    const runId = ++runRef.current;
    let working = [...itemsRef.current, first];
    const push = (...next: CopilotItem[]) => { working = [...working, ...next]; setItems(working); };
    setItems(working);
    setBusy(true);
    setStatus('AI đang phân tích yêu cầu…');
    let toolCalls = 0;
    let repairs = 0;
    let finished = false;
    try {
      for (let step = 0; step < MAX_STEPS && !finished; step++) {
        const context = ctxRef.current;
        const res = await callModel(buildApiMessages(buildCopilotSystemPrompt(context), working));
        if (runId !== runRef.current) return;
        if (!res?.success || !res.result?.trim()) {
          push(makeItem('error', res?.error ? `AI báo lỗi: ${res.error}` : 'AI không trả về nội dung. Thử lại hoặc chọn trợ lý khác.'));
          finished = true;
          break;
        }
        const parsed = parseCopilotReply(res.result);
        const reply = makeItem('assistant', res.result, { display: parsed.text, tokens: res.totalTokens });

        if (parsed.toolCall) {
          reply.toolCall = parsed.toolCall;
          if (toolCalls >= MAX_TOOL_CALLS) {
            push(reply, makeItem('check', '[HỆ THỐNG] Đã hết lượt tra cứu trong lượt này. Dùng thông tin đã có: hỏi lại người dùng hoặc đưa ra đề xuất.', { label: 'Hết lượt tra cứu - AI dùng thông tin đã có' }));
            continue;
          }
          toolCalls++;
          push(reply);
          setStatus('AI đang tra cứu dữ liệu…');
          const result = await runTool(parsed.toolCall);
          if (runId !== runRef.current) return;
          push(makeItem('tool', `[KẾT QUẢ CÔNG CỤ ${parsed.toolCall.tool}]\n${result.text}`, { label: result.label }));
          setStatus('AI đang phân tích kết quả…');
          continue;
        }

        if (parsed.parseError) {
          reply.parseError = parsed.parseError;
          if (repairs < MAX_REPAIRS) {
            repairs++;
            reply.draft = true;
            push(reply, makeItem('check', formatParseFeedback(parsed.parseError), { label: `Đề xuất sai định dạng → AI gửi lại (lần ${repairs}/${MAX_REPAIRS})` }));
            setStatus('AI đang gửi lại đề xuất…');
            continue;
          }
          push(reply);
          finished = true;
          break;
        }

        if (parsed.proposal) {
          reply.proposal = parsed.proposal;
          const validation = validateProposal(parsed.proposal, context, primaryModeFor(parsed.proposal, context));
          if (validation.errors.length && repairs < MAX_REPAIRS) {
            repairs++;
            reply.draft = true;
            push(reply, makeItem('check', formatValidationFeedback(validation), { label: `Kiểm tra: ${validation.errors.length} lỗi → AI tự sửa (lần ${repairs}/${MAX_REPAIRS})` }));
            setStatus(`AI đang sửa ${validation.errors.length} lỗi…`);
            continue;
          }
          reply.version = working.reduce((max, item) => Math.max(max, item.version || 0), 0) + 1;
          push(reply);
          setSelectedId(reply.id);
          finished = true;
          break;
        }

        push(reply);
        finished = true;
      }
      if (!finished) push(makeItem('error', 'AI chưa xong sau nhiều bước tra cứu. Nhắn "tiếp tục" để AI làm tiếp.'));
    } catch (err: any) {
      if (runId === runRef.current) push(makeItem('error', `Lỗi gọi AI: ${err?.message || err}`));
    } finally {
      if (runId === runRef.current) {
        setBusy(false);
        setStatus('');
        setTimeout(() => inputRef.current?.focus(), 30);
      }
    }
  };

  const send = (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = '';
    run(makeItem('user', message));
  };

  const runLatest = useRef(run);
  runLatest.current = run;
  const askFix = useCallback((item: CopilotItem, validation: ValidationResult) => {
    runLatest.current(makeItem('check', formatValidationFeedback(validation), { label: `Nhờ AI sửa ${validation.errors.length} lỗi của v${item.version}` }));
  }, []);

  const apply = useCallback(async (item: CopilotItem, mode: ProposalMode) => {
    const proposal = item.proposal;
    if (!proposal) return;
    const context = ctxRef.current;
    const validation = validateProposal(proposal, context, mode);
    if (validation.errors.length) {
      const ok = await confirm({
        title: 'Đề xuất còn lỗi',
        message: `Còn ${validation.errors.length} lỗi - phần sai sẽ bị bỏ qua khi áp dụng. Có thể bấm "Nhờ AI sửa" để AI sửa trước.`,
        confirmText: 'Vẫn áp dụng',
        variant: 'warning',
      });
      if (!ok) return;
    }
    if (mode === 'replace' && context.currentNodes.length) {
      const ok = await confirm({
        title: 'Thay thế kịch bản hiện tại?',
        message: `${context.currentNodes.length} node trên sơ đồ sẽ được thay bằng đề xuất v${item.version}. Có thể bấm "Hoàn tác" trên sơ đồ ngay sau đó.`,
        confirmText: 'Thay thế',
        variant: 'danger',
      });
      if (!ok) return;
    }
    const result = materializeProposal(proposal, mode, context, uuidv4);
    onApply(result, mode, proposal.title || `Đề xuất v${item.version}`);
    const how = context.currentNodes.length === 0 ? 'đưa vào sơ đồ trống' : mode === 'replace' ? 'thay thế toàn bộ sơ đồ' : 'thêm / sửa trên sơ đồ hiện tại';
    setItems([
      ...itemsRef.current.map(entry => (entry.id === item.id ? { ...entry, appliedMode: mode } : entry)),
      makeItem('note', `[HỆ THỐNG] Người dùng đã áp dụng đề xuất v${item.version} (${how}). Phần "WORKFLOW HIỆN TẠI" đã cập nhật theo.`, {
        label: `Đã áp dụng v${item.version} - ${how}`,
      }),
    ]);
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onApply, onClose, setItems]);

  const newConversation = async () => {
    if (busy) return;
    if (items.length > 2) {
      const ok = await confirm({ title: 'Bắt đầu cuộc trò chuyện mới?', message: 'Nội dung trò chuyện và các đề xuất hiện tại sẽ bị xoá.', confirmText: 'Bắt đầu mới', variant: 'warning' });
      if (!ok) return;
    }
    setItems([]);
    setSelectedId(null);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  // ── Derived ──
  const versions = useMemo(() => items.filter(item => item.proposal && !item.draft && item.version), [items]);
  const selected = useMemo(() => versions.find(item => item.id === selectedId) || versions[versions.length - 1] || null, [versions, selectedId]);
  const totalTokens = useMemo(() => items.reduce((sum, item) => sum + (item.tokens || 0), 0), [items]);
  const assistant = assistants.find(a => a.id === assistantId);
  const examples = [...(currentNodes.length ? CANVAS_EXAMPLES : []), ...(EXAMPLES[channel] || EXAMPLES.zalo)].slice(0, 6);
  const noAssistant = !loadingAssistants && assistants.length === 0;

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  const onInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
    const el = event.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  };

  // ── Render ──
  const renderItem = (item: CopilotItem) => {
    switch (item.kind) {
      case 'user':
        return (
          <div key={item.id} className="flex justify-end pl-12">
            <div className="wf-msg wf-msg--user">{item.content}</div>
          </div>
        );
      case 'assistant': {
        const text = (item.display ?? item.content).trim();
        if (!text && !item.proposal && !item.parseError) return null;
        return (
          <div key={item.id} className="flex gap-2.5 pr-6">
            <span className="wf-copilot-tile w-7 h-7 flex-shrink-0 !rounded-lg mt-0.5"><SparklesIcon className="w-3.5 h-3.5" /></span>
            <div className="min-w-0 flex-1">
              {text && <div className="wf-msg wf-msg--ai"><MarkdownLite text={text} /></div>}
              {item.parseError && !item.draft && (
                <p className="mt-1.5 text-[11.5px]" style={{ color: '#dc2626' }}>Không đọc được đề xuất: {item.parseError}</p>
              )}
              {item.proposal && <ProposalCard item={item} selected={selected?.id === item.id} onSelect={() => setSelectedId(item.id)} />}
            </div>
          </div>
        );
      }
      case 'tool':
        return <EventRow key={item.id} icon={item.label?.startsWith('Đọc') ? <TagIcon className="w-3 h-3" /> : <SearchIcon className="w-3 h-3" />} label={item.label || 'Đã tra cứu'} detail={item.content} />;
      case 'check':
        return <EventRow key={item.id} icon={<WrenchIcon className="w-3 h-3" />} label={item.label || 'Kiểm tra tự động'} detail={item.content} />;
      case 'note':
        return (
          <div key={item.id} className="flex items-center gap-2 py-1">
            <span className="flex-1 h-px" style={{ background: 'var(--wf-panel-border)' }} />
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: '#16a34a' }}>
              <CheckCircleIcon className="w-3.5 h-3.5" /> {item.label || 'Đã áp dụng'}
            </span>
            <span className="flex-1 h-px" style={{ background: 'var(--wf-panel-border)' }} />
          </div>
        );
      case 'error':
        return <EventRow key={item.id} icon={<AlertIcon className="w-3 h-3" />} label={item.content} tone="danger" />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm pointer-events-none" />
      <div className="relative wf-panel border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 'min(1240px, 96vw)', height: 'min(860px, 94vh)' }}>
        {/* Header */}
        <div className="wf-panel__header flex items-center gap-3 px-5 py-3">
          <span className="wf-copilot-tile w-10 h-10 flex-shrink-0"><SparklesIcon className="w-5 h-5" /></span>
          <div className="flex-1 min-w-0">
            <p className="wf-panel__title truncate">Trợ lý thiết kế workflow</p>
            <p className="wf-panel__desc truncate">
              Kênh {channelLabel} · {currentNodes.length ? `${currentNodes.length} node trên sơ đồ` : 'sơ đồ trống'} · trò chuyện để AI phân tích và đề xuất kịch bản
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex flex-col items-end">
              <select value={assistantId} onChange={e => chooseAssistant(e.target.value)} disabled={busy || assistants.length === 0}
                className="wf-select wf-input--sm !w-56" title="Trợ lý AI dùng để thiết kế. Nên chọn model mạnh (GPT-5, Claude, Gemini Pro…) để kết quả chính xác hơn.">
                {assistants.length === 0 && <option value="">{loadingAssistants ? 'Đang tải trợ lý…' : 'Chưa có trợ lý AI'}</option>}
                {assistants.map(a => <option key={a.id} value={a.id}>{a.name}{a.model ? ` · ${a.model}` : ''}</option>)}
              </select>
            </div>
            <button type="button" className="wf-btn" onClick={newConversation} disabled={busy || items.length === 0} title="Xoá cuộc trò chuyện, bắt đầu lại">
              <PlusIcon className="w-3.5 h-3.5" /> Trò chuyện mới
            </button>
            <button type="button" onClick={close} className="wf-icon-btn" title="Đóng (Esc) - cuộc trò chuyện được giữ lại"><CloseIcon className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Chat */}
          <section className="flex-1 min-w-0 flex flex-col">
            <div ref={listRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {items.length === 0 ? (
                <div className="max-w-[34rem] mx-auto pt-4">
                  <div className="flex items-center gap-3">
                    <span className="wf-copilot-tile w-11 h-11"><SparklesIcon className="w-5 h-5" /></span>
                    <div>
                      <p className="text-[15px] font-semibold wf-text">Bạn muốn tự động hoá việc gì?</p>
                      <p className="text-xs wf-muted mt-0.5">Mô tả bằng lời thường - AI sẽ hỏi lại chỗ chưa rõ rồi đề xuất kịch bản.</p>
                    </div>
                  </div>
                  <ol className="wf-copilot-steps mt-4">
                    <li><b>Mô tả nhu cầu</b> - ai nhắn gì, cần trả lời / gắn nhãn / báo cho ai…</li>
                    <li><b>Cùng phân tích</b> - AI hỏi lại, tra cứu node, danh bạ, nhãn thật của bạn.</li>
                    <li><b>Xem trước & áp dụng</b> - thêm vào hoặc thay thế kịch bản hiện tại, có thể hoàn tác.</li>
                  </ol>
                  <p className="wf-section-title mt-5 mb-2">Gợi ý</p>
                  <div className="grid gap-2">
                    {examples.map(example => (
                      <button key={example} type="button" className="wf-suggestion" disabled={busy || !assistantId} onClick={() => send(example)}>
                        <span className="flex-shrink-0 mt-px" style={{ color: '#d97706' }}><LightbulbIcon className="w-4 h-4" /></span>
                        <span>{example}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : items.map(renderItem)}
              {busy && (
                <div className="flex gap-2.5 items-center">
                  <span className="wf-copilot-tile w-7 h-7 flex-shrink-0 !rounded-lg"><SparklesIcon className="w-3.5 h-3.5" /></span>
                  <div className="wf-msg wf-msg--ai !py-2 flex items-center gap-2.5">
                    <span className="wf-typing"><span /><span /><span /></span>
                    <span className="text-xs wf-muted">{status || 'AI đang suy nghĩ…'}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="px-5 pb-4 pt-2">
              {noAssistant && (
                <div className="wf-callout mb-2" data-tone="warn">
                  <AlertIcon className="w-4 h-4" />
                  <span>Chưa có trợ lý AI nào đang bật. Vào <b>Công cụ → Tích hợp → Trợ lý AI</b> để tạo trợ lý (nên dùng model mạnh như GPT-5, Claude, Gemini Pro).</span>
                </div>
              )}
              <div className="wf-composer flex items-end gap-2 pl-3.5 pr-2 py-2">
                <textarea ref={inputRef} value={input} rows={1} onChange={onInputChange} onKeyDown={onInputKeyDown}
                  disabled={noAssistant}
                  placeholder={items.length ? 'Trả lời AI hoặc yêu cầu chỉnh sửa…' : 'VD: Khách hỏi giá thì AI trả lời, khách muốn mua thì gắn nhãn "Đặt hàng"…'}
                  className="flex-1 min-w-0 text-[13px] leading-5 py-1.5 max-h-[168px]" />
                {busy ? (
                  <button type="button" className="wf-btn !h-9 !px-3" onClick={stop} title="Dừng lượt trả lời này"><StopGlyph /> Dừng</button>
                ) : (
                  <button type="button" className="wf-btn wf-btn--primary !h-9 !w-9 !px-0" onClick={() => send()} disabled={!input.trim() || !assistantId} title="Gửi (Enter)">
                    <SendIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[11px] wf-faint flex items-center gap-2">
                <span>Enter để gửi · Shift+Enter xuống dòng</span>
                {assistant && <span className="truncate">· {assistant.name}{assistant.model ? ` (${assistant.model})` : ''}</span>}
                {totalTokens > 0 && <span className="ml-auto flex-shrink-0">{totalTokens.toLocaleString('vi-VN')} token</span>}
              </p>
            </div>
          </section>

          {/* Preview */}
          <aside className="w-[45%] min-w-[360px] max-w-[560px] flex flex-col border-l border-[color:var(--wf-panel-border)]" style={{ background: 'var(--wf-section)' }}>
            <CopilotPreview item={selected} versions={versions} ctx={ctx} isLight={isLight} busy={busy}
              onSelect={setSelectedId} onApply={apply} onAskFix={askFix} />
          </aside>
        </div>
      </div>
    </div>
  );
}
