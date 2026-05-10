/**
 * AIAssistantDetailPage.tsx
 * Trang chi tiết trợ lý AI — tạo mới / chỉnh sửa.
 * Layout: cấu hình bên trái, chat preview bên phải.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import {showConfirm} from "@/components/common/ConfirmDialog";
import PromptWizardModal from './PromptWizardModal';

// ─── Constants ────────────────────────────────────────────────────────────────

const PLATFORMS = [
  { value: 'openai',   label: 'OpenAI',         icon: '🤖', color: 'bg-green-600' },
  { value: 'gemini',   label: 'Google Gemini',   icon: '✨', color: 'bg-blue-600' },
  { value: 'claude',   label: 'Anthropic Claude',icon: '🟠', color: 'bg-amber-600' },
  { value: 'deepseek', label: 'DeepSeek',        icon: '🔮', color: 'bg-purple-600' },
  { value: 'grok',     label: 'Grok (xAI)',      icon: '⚡', color: 'bg-orange-600' },
  { value: 'mistral',  label: 'Mistral AI',      icon: '🌀', color: 'bg-sky-600' },
] as const;

const MODELS_BY_PLATFORM: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-5.4',       label: 'GPT-5.4 (flagship mới nhất)' },
    { value: 'gpt-5.4-pro',   label: 'GPT-5.4 Pro (thông minh, chính xác nhất)' },
    { value: 'gpt-5.4-mini',  label: 'GPT-5.4 Mini (code, subagent — khuyên dùng)' },
    { value: 'gpt-5.4-nano',  label: 'GPT-5.4 Nano (siêu rẻ, đơn giản)' },
    { value: 'gpt-5-mini',    label: 'GPT-5 Mini (cân bằng, giá tốt)' },
    { value: 'gpt-5-nano',    label: 'GPT-5 Nano (nhanh, rẻ nhất)' },
    { value: 'gpt-5',         label: 'GPT-5 (lý luận mạnh)' },
    { value: 'o4-mini',       label: 'o4-mini (lý luận nhanh)' },
    { value: 'o3',            label: 'o3 (lý luận mạnh)' },
    { value: 'o3-mini',       label: 'o3-mini (lý luận)' },
    { value: 'gpt-4.1',       label: 'GPT-4.1 (legacy, non-reasoning thông minh)' },
  ],
  gemini: [
    { value: 'gemini-3.1-pro',        label: 'Gemini 3.1 Pro (mạnh nhất — khuyên dùng)' },
    { value: 'gemini-3.1-flash',      label: 'Gemini 3.1 Flash (nhanh, cân bằng)' },
    { value: 'gemini-3.0-flash',      label: 'Gemini 3.0 Flash (nhanh, rẻ)' },
    { value: 'gemini-3.0-flash-lite', label: 'Gemini 3.0 Flash Lite (siêu rẻ)' },
    { value: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro (legacy, ổn định)' },
    { value: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (legacy)' },
  ],
  claude: [
    { value: 'claude-4.6-sonnet-20260301',  label: 'Claude 4.6 Sonnet (mới nhất — khuyên dùng)' },
    { value: 'claude-4.5-sonnet-20260115',  label: 'Claude 4.5 Sonnet (cân bằng)' },
    { value: 'claude-4.0-haiku-20260101',   label: 'Claude 4.0 Haiku (nhanh, rẻ)' },
    { value: 'claude-4.0-opus-20260101',    label: 'Claude 4.0 Opus (mạnh nhất gen 4)' },
    { value: 'claude-sonnet-4-20250514',    label: 'Claude Sonnet 4 (legacy, ổn định)' },
    { value: 'claude-3-5-haiku-20241022',   label: 'Claude 3.5 Haiku (legacy)' },
  ],
  deepseek: [
    { value: 'deepseek-chat-v3.2',   label: 'DeepSeek V3.2 (mới nhất — khuyên dùng)' },
    { value: 'deepseek-chat-v3.1',   label: 'DeepSeek V3.1 (cân bằng)' },
    { value: 'deepseek-chat',        label: 'DeepSeek V3 (legacy, ổn định)' },
    { value: 'deepseek-reasoner-r1.5', label: 'DeepSeek R1.5 (lý luận mới nhất)' },
    { value: 'deepseek-reasoner',    label: 'DeepSeek R1 (lý luận, ổn định)' },
  ],
  grok: [
    { value: 'grok-4',           label: 'Grok 4 (flagship mạnh nhất)' },
    { value: 'grok-4-fast',      label: 'Grok 4 Fast (nhanh — khuyên dùng)' },
    { value: 'grok-4-mini',      label: 'Grok 4 Mini (lý luận, rẻ)' },
    { value: 'grok-4-mini-fast', label: 'Grok 4 Mini Fast (siêu nhanh, rẻ)' },
    { value: 'grok-3',           label: 'Grok 3 (legacy, ổn định)' },
  ],
  mistral: [
    { value: 'mistral-large-2-latest',  label: 'Mistral Large 2 (mạnh nhất — khuyên dùng)' },
    { value: 'codestral-2-latest',      label: 'Codestral 2 (code chuyên dụng)' },
    { value: 'mistral-small-3-latest',  label: 'Mistral Small 3 (nhanh, rẻ)' },
    { value: 'mistral-medium-latest',   label: 'Mistral Medium (cân bằng)' },
    { value: 'open-mistral-nemo-2',     label: 'Mistral Nemo 2 (mở, nhẹ)' },
    { value: 'mistral-large-latest',    label: 'Mistral Large (legacy)' },
  ],
};

interface AIFile {
  id: number;
  assistantId: string;
  fileName: string;
  fileSize: number;
  contentText: string;
  createdAt: number;
}

interface POSIntegration {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  segments?: Array<{ type: 'text' | 'image'; content: any }>; // Parsed structured JSON segments
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface UsageStat {
  day: string;
  assistant_name: string;
  assistant_id: string;
  platform: string;
  model: string;
  request_count: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
}

// ─── POS product normalizer (image + core fields per platform) ───────────────

function normalizeForAI(raw: any, platform: string) {
  let image: string;
  if (platform === 'kiotviet') {
    image = raw.images?.[0]?.url || raw.image || '';
  } else if (platform === 'haravan') {
    image = raw.image?.src || raw.images?.[0]?.src || raw.featured_image || '';
  } else if (platform === 'sapo') {
    image = raw.image?.src || raw.images?.[0]?.src || '';
  } else if (platform === 'ipos') {
    image = raw.image_url || raw.image || raw.thumbnail || '';
  } else if (platform === 'nhanh') {
    image = raw.images?.avatar || raw.image || raw.imageUrl || raw.smallImage
      || (typeof raw.images?.[0] === 'string' ? raw.images[0] : '') || '';
  } else if (platform === 'pancake') {
    const nested = raw.product_info || raw.product || raw.item || {};
    image = raw.image || raw.image_url || raw.imageUrl || raw.avatar
      || raw.images?.[0]?.url || raw.images?.[0]?.src
      || (typeof raw.images?.[0] === 'string' ? raw.images[0] : '')
      || nested.image || nested.image_url || nested.images?.[0]?.url || '';
  } else {
    image = raw.image || raw.image_url || raw.imageUrl || raw.thumbnail || '';
  }
  const nested = raw.product_info || raw.product || raw.item || {};
  const id = String(raw.variation_id || raw.id || raw.productId || raw.product_id
    || raw.item_id || raw.sku || raw.code || Math.random());
  const name = raw.name || raw.fullName || raw.title || raw.productName
    || raw.product_name || nested.name || nested.title || '';
  const price = raw.prices?.retail || raw.basePrice || raw.price || raw.retailPrice
    || raw.retail_price || raw.final_price || nested.price || nested.basePrice || 0;
  const code = raw.code || raw.sku || raw.barcode || raw.productCode || nested.code || nested.sku || '';
  return { ...raw, _id: id, _name: name, _price: Number(price) || 0, _code: code, _image: image };
}

// ─── Parse structured AI JSON response (text/image segments) ─────────────────

function parseStructuredResponse(raw: string): Array<{ type: 'text' | 'image'; content: any }> | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every((item: any) => item && (item.type === 'text' || item.type === 'image') && item.content !== undefined)) {
      return parsed;
    }
  } catch {
    try {
      const jsonMatch = trimmed.match(/\[[\s\S]*]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length > 0 &&
            parsed.every((item: any) => item && (item.type === 'text' || item.type === 'image') && item.content !== undefined)) {
          return parsed;
        }
      }
    } catch {}
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  assistantId: string | null; // null = create new
  onBack: () => void;
}

export default function AIAssistantDetailPage({ assistantId, onBack }: Props) {
  const { showNotification } = useAppStore();

  // Form state
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState('gpt-5.4-mini');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [posIntegrationId, setPosIntegrationId] = useState('');
  const [maxTokens, setMaxTokens] = useState(1000);
  const [temperature, setTemperature] = useState(0.7);
  const [contextMessageCount, setContextMessageCount] = useState(30);
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);

  // Files
  const [files, setFiles] = useState<AIFile[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);

  // POS integrations (for dropdown)
  const [posIntegrations, setPosIntegrations] = useState<POSIntegration[]>([]);

  // UI state
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(assistantId);

  // Chat preview state
  const [showChatPanel, setShowChatPanel] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // POS products state
  const [posProducts, setPosProducts] = useState<any[]>([]);
  const [posProductsLoading, setPosProductsLoading] = useState(false);
  const [posSearchQuery, setPosSearchQuery] = useState('');
  const [posPage, setPosPage] = useState(1);
  const [posHasNext, setPosHasNext] = useState(false);
  const [posTotal, setPosTotal] = useState<number | undefined>(undefined);
  const [selectedPosIds, setSelectedPosIds] = useState<Set<string>>(new Set());
  const [pinnedProducts, setPinnedProducts] = useState<any[]>([]);

  // Usage report state
  const [usageStats, setUsageStats] = useState<UsageStat[]>([]);
  const [usageLogs, setUsageLogs] = useState<any[]>([]);
  const [showReport, setShowReport] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  // Expandable prompt/response in chat
  const [expandedMsgIdx, setExpandedMsgIdx] = useState<number | null>(null);

  // Prompt wizard
  const [showPromptWizard, setShowPromptWizard] = useState(false);

  // ─── Load existing assistant + POS integrations ──────────────────────────

  const loadData = useCallback(async () => {
    // Load POS integrations for dropdown
    try {
      const res = await ipc.integration?.list();
      if (res?.success) {
        const posTypes = ['kiotviet', 'haravan', 'sapo', 'ipos', 'nhanh', 'pancake'];
        setPosIntegrations(
          (res.integrations || []).filter((i: any) => posTypes.includes(i.type) && i.enabled)
        );
      }
    } catch {}

    // Load existing assistant
    if (assistantId) {
      try {
        const res = await ipc.ai?.getAssistant(assistantId);
        if (res?.success && res.assistant) {
          const a = res.assistant;
          console.log('[AIAssistantDetailPage] loaded assistant:', {
            id: a.id, name: a.name,
            posIntegrationId: a.posIntegrationId,
            pinnedProductsJsonLen: a.pinnedProductsJson?.length,
            pinnedProductsJsonPreview: a.pinnedProductsJson?.substring(0, 200),
          });
          setName(a.name || '');
          setPlatform(a.platform || 'openai');
          setApiKey(a.apiKey || '');
          setModel(a.model || 'gpt-5.4-mini');
          setSystemPrompt(a.systemPrompt || '');
          setPosIntegrationId(a.posIntegrationId || '');
          try { setPinnedProducts(JSON.parse(a.pinnedProductsJson || '[]')); } catch { setPinnedProducts([]); }
          setMaxTokens(a.maxTokens || 1000);
          setTemperature(a.temperature ?? 0.7);
          setContextMessageCount(a.contextMessageCount || 30);
          setEnabled(a.enabled !== false);
          setIsDefault(!!a.isDefault);
        }
      } catch {}

      // Load files
      try {
        const res = await ipc.ai?.getFiles(assistantId);
        if (res?.success) setFiles(res.files || []);
      } catch {}
    }
  }, [assistantId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-set first model when platform changes
  useEffect(() => {
    const models = MODELS_BY_PLATFORM[platform];
    if (models?.length && !models.find(m => m.value === model)) {
      setModel(models[0].value);
    }
  }, [platform]);

  // Auto-scroll chat
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatMessages]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!name.trim()) { showNotification('Vui lòng nhập tên trợ lý', 'error'); return; }
    if (!apiKey && !savedId) { showNotification('Vui lòng nhập API Key', 'error'); return; }

    setSaving(true);
    setTestResult(null);
    try {
      const payload: any = {
        id: savedId || undefined,
        name: name.trim(),
        platform,
        apiKey: apiKey || '***',
        model,
        systemPrompt: systemPrompt.trim(),
        posIntegrationId: posIntegrationId || null,
        pinnedProductsJson: JSON.stringify(pinnedProducts),
        maxTokens,
        temperature,
        contextMessageCount,
        enabled,
        isDefault,
      };
      console.log('[AIAssistantDetailPage] saving payload:', {
        id: payload.id,
        posIntegrationId: payload.posIntegrationId,
        pinnedProductsJsonLen: payload.pinnedProductsJson?.length,
        pinnedProductsCount: pinnedProducts.length,
        pinnedProductsJsonPreview: payload.pinnedProductsJson?.substring(0, 200),
      });
      const res = await ipc.ai?.saveAssistant(payload);
      if (res?.success && res.id) {
        setSavedId(res.id);
        showNotification('✅ Đã lưu trợ lý AI!', 'success');
      } else {
        showNotification('❌ Lưu thất bại: ' + (res?.error || ''), 'error');
      }
    } catch (e: any) {
      showNotification('❌ Lỗi: ' + e.message, 'error');
    }
    setSaving(false);
  };

  const handleTest = async () => {
    if (!savedId) { showNotification('Lưu trước khi test', 'warning'); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await ipc.ai?.testAssistant(savedId);
      setTestResult({ success: !!res?.success, message: res?.message || 'Không có phản hồi' });
    } catch (e: any) {
      setTestResult({ success: false, message: e.message });
    }
    setTesting(false);
  };

  const handleDelete = async () => {
    if (!savedId) { onBack(); return; }
    const ok = await showConfirm({
      title: 'Xóa trợ lý AI',
      message: 'Xóa trợ lý AI này? Dữ liệu sẽ mất hoàn toàn.. Thao tác không thể hoàn tác.',
      confirmText: 'Xoá',
      variant: 'danger',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await ipc.ai?.deleteAssistant(savedId);
      onBack();
    } catch (e: any) {
      showNotification('Lỗi xóa: ' + e.message, 'error');
    }
    setDeleting(false);
  };

  const handleUploadFile = async () => {
    if (!savedId) { showNotification('Lưu trợ lý trước khi upload file', 'warning'); return; }
    try {
      const res = await ipc.file?.openDialog({
        title: 'Chọn file kiến thức',
        filters: [
          { name: 'Văn bản', extensions: ['txt', 'md', 'csv', 'json', 'html', 'xml', 'yml', 'yaml', 'log'] },
          { name: 'Tất cả', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      });
      if (!res?.filePaths?.length) return;

      setUploadingFile(true);
      for (const fp of res.filePaths) {
        await ipc.ai?.uploadFile(savedId, fp);
      }
      const filesRes = await ipc.ai?.getFiles(savedId);
      if (filesRes?.success) setFiles(filesRes.files || []);
      showNotification('✅ Đã tải file lên', 'success');
    } catch (e: any) {
      showNotification('❌ Lỗi upload: ' + e.message, 'error');
    }
    setUploadingFile(false);
  };

  const handleRemoveFile = async (fileId: number) => {
    try {
      await ipc.ai?.removeFile(fileId);
      setFiles(prev => prev.filter(f => f.id !== fileId));
    } catch {}
  };

  // ─── POS product handlers ───────────────────────────────────────────────

  const posIntegrationType = posIntegrations.find(p => p.id === posIntegrationId)?.type || '';

  const handleSearchPosProducts = useCallback(async (query: string, page: number) => {
    if (!posIntegrationId) return;
    setPosProductsLoading(true);
    try {
      const PAGE_SIZE = 20;
      const action = query.trim() ? 'lookupProduct' : 'getProducts';
      const params: Record<string, any> = { limit: PAGE_SIZE, page };
      if (query.trim()) params.keyword = query.trim();

      let res = await ipc.integration?.execute(posIntegrationId, action, params);
      if (action === 'getProducts' && !res?.success) {
        res = await ipc.integration?.execute(posIntegrationId, 'lookupProduct', { limit: PAGE_SIZE, page });
      }

      if (res?.success && res.data) {
        const rawData = res.data;
        const rawList: any[] = rawData?.products ?? rawData?.data ?? (Array.isArray(rawData) ? rawData : []);
        setPosProducts(rawList.map(p => normalizeForAI(p, posIntegrationType)));
        const backendHasNext = rawData?.hasNext;
        setPosHasNext(typeof backendHasNext === 'boolean' ? backendHasNext : rawList.length >= PAGE_SIZE);
        const tot = rawData?.total;
        setPosTotal(tot != null && tot !== '' ? Number(tot) : undefined);
      } else {
        showNotification('❌ ' + (res?.error || 'Không tải được sản phẩm'), 'error');
        setPosProducts([]);
      }
    } catch (e: any) {
      showNotification('❌ Lỗi: ' + e.message, 'error');
      setPosProducts([]);
    }
    setPosProductsLoading(false);
  }, [posIntegrationId, posIntegrationType, showNotification]);

  const handlePinProducts = (products: any[]) => {
    if (products.length === 0) return;
    const newPinned = products.map(p => ({
      id: p._id || p.id || '',
      name: p._name || p.name || p.productName || p.title || '',
      price: p._price || p.price || p.basePrice || 0,
      code: p._code || p.code || p.sku || '',
      image: p._image || p.image || p.image_url || '',
    }));
    setPinnedProducts(prev => {
      const existIds = new Set(prev.map((x: any) => x.id));
      const toAdd = newPinned.filter(x => !existIds.has(x.id));
      return [...prev, ...toAdd];
    });
    showNotification(`✅ Đã ghim ${newPinned.length} sản phẩm cho AI`, 'success');
  };

  const handleUnpinProduct = (productId: string) => {
    setPinnedProducts(prev => prev.filter((p: any) => p.id !== productId));
  };

  const handleUnpinAll = () => {
    setPinnedProducts([]);
    showNotification('Đã xóa tất cả sản phẩm đã ghim', 'info');
  };

  // ─── Chat preview handlers ──────────────────────────────────────────────

  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || !savedId || chatLoading) return;

    const userMsg: ChatMsg = { role: 'user', content: text };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);

    try {
      const allMsgs = [...chatMessages, userMsg];
      const res = await ipc.ai?.chat(savedId, allMsgs, true);
      if (res?.success && res.result) {
        const segments = parseStructuredResponse(res.result);
        setChatMessages(prev => [...prev, {
          role: 'assistant',
          content: res.result!,
          segments: segments || undefined,
          promptTokens: (res as any).promptTokens || 0,
          completionTokens: (res as any).completionTokens || 0,
          totalTokens: (res as any).totalTokens || 0,
        }]);
      } else {
        setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ ${res?.error || 'Không có phản hồi'}` }]);
      }
    } catch (e: any) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `❌ Lỗi: ${e.message}` }]);
    }
    setChatLoading(false);
    setTimeout(() => chatInputRef.current?.focus(), 100);
  }, [chatInput, savedId, chatLoading, chatMessages]);

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  };

  const currentPlatform = PLATFORMS.find(p => p.value === platform) || PLATFORMS[0];
  const currentModels = MODELS_BY_PLATFORM[platform] || [];

  function formatFileSize(bytes: number) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  const loadReport = useCallback(async () => {
    if (!savedId) return;
    setReportLoading(true);
    try {
      const [statsRes, logsRes] = await Promise.all([
        ipc.ai?.getUsageStats({ assistantId: savedId, days: 30 }),
        ipc.ai?.getUsageLogs({ assistantId: savedId, limit: 50 }),
      ]);
      if (statsRes?.success) setUsageStats(statsRes.stats || []);
      if (logsRes?.success) setUsageLogs(logsRes.logs || []);
    } catch {}
    setReportLoading(false);
  }, [savedId]);

  useEffect(() => { if (showReport && savedId) loadReport(); }, [showReport, savedId, loadReport]);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-900">
      {/* Header */}
      <div className="px-6 py-3 border-b border-gray-700 flex-shrink-0 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <div className={`w-9 h-9 rounded-lg ${currentPlatform.color} flex items-center justify-center text-lg`}>
          {currentPlatform.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-white truncate">
            {savedId ? name || 'Chỉnh sửa trợ lý' : 'Tạo trợ lý AI mới'}
          </h1>
          <p className="text-xs text-gray-400">{currentPlatform.label} — {model}</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer flex-shrink-0">
          <span className="text-xs text-gray-400">Kích hoạt</span>
          <div className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-600'}`}
            onClick={() => setEnabled(!enabled)}>
            <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-5' : ''}`}/>
          </div>
        </label>
        <button
          onClick={() => { setShowChatPanel(!showChatPanel); if (!showChatPanel) setShowReport(false); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors flex-shrink-0 border ${
            showChatPanel
              ? 'bg-blue-600/20 text-blue-400 border-blue-600/40'
              : 'text-gray-400 hover:text-white border-gray-600 hover:border-gray-500'
          }`}
          title={showChatPanel ? 'Ẩn chat thử' : 'Hiện chat thử'}
        >
          💬 Chat thử
        </button>
        {savedId && (
          <button
            onClick={() => { setShowReport(!showReport); if (!showReport) setShowChatPanel(false); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors flex-shrink-0 border ${
              showReport
                ? 'bg-purple-600/20 text-purple-400 border-purple-600/40'
                : 'text-gray-400 hover:text-white border-gray-600 hover:border-gray-500'
            }`}
            title="Báo cáo sử dụng"
          >
            📊 Báo cáo
          </button>
        )}
      </div>

      {/* Split body: config left, chat preview right */}
      <div className="flex-1 flex overflow-hidden">
        {/* ─── LEFT: Config ─────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 min-w-0">

          {/* Basic info */}
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-2">📝 Thông tin cơ bản</h2>
            <div className="space-y-3 bg-gray-800 rounded-xl p-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Tên trợ lý *</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)}
                  placeholder="VD: Trợ lý bán hàng..."
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"/>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Nền tảng AI</label>
                  <select value={platform} onChange={e => setPlatform(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                    {PLATFORMS.map(p => (
                      <option key={p.value} value={p.value}>{p.icon} {p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Model</label>
                  <select value={model} onChange={e => setModel(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                    {currentModels.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* API Key */}
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-2">🔑 API Key</h2>
            <div className="bg-gray-800 rounded-xl p-4">
              <div className="relative">
                <input type={showApiKey ? 'text' : 'password'}
                  value={apiKey} onChange={e => setApiKey(e.target.value)}
                  placeholder={savedId ? '••••••••  (để trống = giữ cũ)' : 'Nhập API Key...'}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 pr-10"/>
                <button type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white text-sm"
                  onClick={() => setShowApiKey(!showApiKey)}>
                  {showApiKey ? '🙈' : '👁'}
                </button>
              </div>
              <p className="text-[10px] text-gray-500 mt-1.5">
                {platform === 'openai' && 'Lấy tại: platform.openai.com/api-keys'}
                {platform === 'gemini' && 'Lấy tại: aistudio.google.com/apikey'}
                {platform === 'claude' && 'Lấy tại: console.anthropic.com/settings/keys'}
                {platform === 'deepseek' && 'Lấy tại: platform.deepseek.com/api-keys'}
                {platform === 'grok' && 'Lấy tại: console.x.ai'}
                {platform === 'mistral' && 'Lấy tại: console.mistral.ai/api-keys'}
              </p>
            </div>
          </div>

          {/* System prompt */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-300">💬 System Prompt</h2>
              <div className="flex items-center gap-1.5">
                {systemPrompt.trim().length > 20 && (
                  <button onClick={() => setShowPromptWizard(true)}
                    className="px-2.5 py-1 text-[10px] rounded-lg bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-600/30 transition-colors">
                    ✨ Cải thiện prompt
                  </button>
                )}
                <button onClick={() => setShowPromptWizard(true)}
                  className="px-2.5 py-1 text-[10px] rounded-lg bg-gradient-to-r from-blue-600/20 to-purple-600/20 text-blue-400 hover:from-blue-600/30 hover:to-purple-600/30 border border-blue-600/30 transition-colors font-medium">
                  ✨ Gợi ý bằng AI
                </button>
              </div>
            </div>
            <div className="bg-gray-800 rounded-xl p-4">
              <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
                rows={10}
                placeholder="VD: Bạn là trợ lý bán hàng chuyên nghiệp..."
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y min-h-[80px]"/>
            </div>
          </div>

          {/* POS Integration */}
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-2">🛒 Liên kết POS</h2>
            <div className="bg-gray-800 rounded-xl p-4 space-y-3">
              <select value={posIntegrationId} onChange={e => {
                setPosIntegrationId(e.target.value);
                setPosProducts([]);
                setPosPage(1);
                setPosSearchQuery('');
                setSelectedPosIds(new Set());
              }} className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                <option value="">— Bạn chưa liên kết POS —</option>
                {posIntegrations.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                ))}
              </select>

              {posIntegrationId && (
                <div className="space-y-2">
                  {/* Search + Load */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={posSearchQuery}
                      onChange={e => setPosSearchQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { setPosPage(1); handleSearchPosProducts(posSearchQuery, 1); } }}
                      placeholder="Tìm theo tên, mã sản phẩm..."
                      className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() => { setPosPage(1); handleSearchPosProducts(posSearchQuery, 1); }}
                      disabled={posProductsLoading}
                      className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors disabled:opacity-50 flex-shrink-0">
                      {posProductsLoading ? '⏳' : '🔍 Tải'}
                    </button>
                  </div>

                  {/* Product list */}
                  {posProducts.length > 0 && (
                    <>
                      {/* Select all / count */}
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => {
                            if (selectedPosIds.size === posProducts.length) {
                              setSelectedPosIds(new Set());
                            } else {
                              setSelectedPosIds(new Set(posProducts.map(p => p._id)));
                            }
                          }}
                          className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
                          {selectedPosIds.size === posProducts.length ? '☑ Bỏ chọn tất cả' : '☐ Chọn tất cả trang này'}
                        </button>
                        <span className="text-[10px] text-gray-500">
                          {selectedPosIds.size > 0 ? `${selectedPosIds.size} đã chọn · ` : ''}
                          {posTotal != null ? `~${posTotal} SP` : `${posProducts.length} SP`}
                        </span>
                      </div>

                      {/* Product rows */}
                      <div className="space-y-1 max-h-64 overflow-y-auto pr-0.5">
                        {posProducts.map((p) => {
                          const isSelected = selectedPosIds.has(p._id);
                          return (
                            <div
                              key={p._id}
                              onClick={() => setSelectedPosIds(prev => {
                                const next = new Set(prev);
                                if (next.has(p._id)) next.delete(p._id); else next.add(p._id);
                                return next;
                              })}
                              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors border ${
                                isSelected ? 'bg-blue-600/10 border-blue-500/30' : 'bg-gray-700/30 border-transparent hover:bg-gray-700/50'
                              }`}
                            >
                              {/* Checkbox */}
                              <div className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[9px] ${
                                isSelected ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-500'
                              }`}>
                                {isSelected && '✓'}
                              </div>
                              {/* Image */}
                              <div className="w-8 h-8 rounded bg-gray-600 flex-shrink-0 overflow-hidden border border-gray-500/30 flex items-center justify-center text-xs">
                                {p._image
                                  ? <img src={p._image} alt="" className="w-full h-full object-cover"
                                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}/>
                                  : '📦'}
                              </div>
                              {/* Info */}
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-white truncate">{p._name || '—'}</p>
                                <p className="text-[10px] text-gray-500 truncate">{p._code}</p>
                              </div>
                              <span className="text-[11px] text-green-400 flex-shrink-0 font-medium">
                                {p._price ? p._price.toLocaleString('vi-VN') + 'đ' : ''}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Pagination */}
                      {(posPage > 1 || posHasNext) && (
                        <div className="flex items-center justify-between gap-2 text-[10px] text-gray-400">
                          <button
                            onClick={() => { const p = Math.max(1, posPage - 1); setPosPage(p); handleSearchPosProducts(posSearchQuery, p); }}
                            disabled={posPage <= 1 || posProductsLoading}
                            className="px-2.5 py-1 rounded bg-gray-700 border border-gray-600 disabled:opacity-40 hover:border-blue-500/40">
                            ← Trang trước
                          </button>
                          <span>Trang {posPage}</span>
                          <button
                            onClick={() => { const p = posPage + 1; setPosPage(p); handleSearchPosProducts(posSearchQuery, p); }}
                            disabled={!posHasNext || posProductsLoading}
                            className="px-2.5 py-1 rounded bg-gray-700 border border-gray-600 disabled:opacity-40 hover:border-blue-500/40">
                            Trang sau →
                          </button>
                        </div>
                      )}

                      {/* Pin to AI */}
                      <button
                        onClick={() => {
                          const toAdd = selectedPosIds.size > 0
                            ? posProducts.filter(p => selectedPosIds.has(p._id))
                            : posProducts;
                          handlePinProducts(toAdd);
                        }}
                        className="w-full py-2 text-xs bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg transition-colors border border-blue-600/30 font-medium">
                        📌 Ghim {selectedPosIds.size > 0 ? `${selectedPosIds.size} SP đã chọn` : `${posProducts.length} SP trang này`} cho AI
                      </button>
                    </>
                  )}

                  {/* ── Pinned products ── */}
                  {pinnedProducts.length > 0 && (
                    <div className="bg-gray-900/50 rounded-xl border border-green-700/30 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-green-400">📌 Sản phẩm đã ghim cho AI ({pinnedProducts.length})</p>
                        <button onClick={handleUnpinAll} className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors">Xóa tất cả</button>
                      </div>
                      <div className="space-y-1 max-h-48 overflow-y-auto pr-0.5">
                        {pinnedProducts.map((p: any) => (
                          <div key={p.id} className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-2 py-1.5 group">
                            <div className="w-7 h-7 rounded bg-gray-700 flex-shrink-0 overflow-hidden border border-gray-600/30 flex items-center justify-center text-[10px]">
                              {p.image
                                ? <img src={p.image} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                : '📦'}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] text-white truncate">{p.name || '—'}</p>
                              <p className="text-[10px] text-gray-500">{p.code}</p>
                            </div>
                            <span className="text-[10px] text-green-400 flex-shrink-0">{p.price ? Number(p.price).toLocaleString('vi-VN') + 'đ' : ''}</span>
                            <button onClick={() => handleUnpinProduct(p.id)}
                              className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0 text-xs opacity-0 group-hover:opacity-100">✕</button>
                          </div>
                        ))}
                      </div>
                      <p className="text-[10px] text-gray-500">💡 AI sẽ dùng danh sách này khi tư vấn. Nhớ bấm <strong className="text-gray-400">Lưu</strong> để áp dụng.</p>
                    </div>
                  )}

                  <p className="text-[10px] text-gray-500">
                    Tìm & ghim sản phẩm để AI biết thông tin khi tư vấn. Bấm ✕ để hủy sản phẩm đã ghim.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Knowledge base files */}
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-2">📚 File kiến thức</h2>
            <div className="bg-gray-800 rounded-xl p-4 space-y-2">
              <p className="text-[10px] text-gray-500 leading-relaxed">
                ℹ️ File được <strong className="text-gray-400">trích xuất nội dung text</strong> và lưu tại máy. Khi AI trả lời, nội dung text sẽ được nạp vào system prompt — <strong className="text-gray-400">không gửi file gốc lên AI</strong>. Hỗ trợ: TXT, MD, CSV, JSON, HTML, XML, YAML, LOG (tối đa ~100KB text/file).
              </p>
              {files.length > 0 && (
                <div className="space-y-1.5">
                  {files.map(f => (
                    <div key={f.id} className="flex items-center gap-2 bg-gray-700/50 rounded-lg px-3 py-2">
                      <span className="text-sm">📄</span>
                      <span className="text-xs text-white flex-1 truncate">{f.fileName}</span>
                      <span className="text-[10px] text-gray-500 flex-shrink-0">{formatFileSize(f.fileSize)}</span>
                      {f.contentText ? (
                        <span className="text-[10px] text-green-500 flex-shrink-0">✅</span>
                      ) : (
                        <span className="text-[10px] text-yellow-500 flex-shrink-0">⚠️</span>
                      )}
                      <button onClick={() => handleRemoveFile(f.id)}
                        className="text-gray-500 hover:text-red-400 transition-colors flex-shrink-0 text-xs">✕</button>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={handleUploadFile} disabled={uploadingFile || !savedId}
                className="w-full py-2 border-2 border-dashed border-gray-600 hover:border-blue-500 rounded-lg text-xs text-gray-400 hover:text-blue-400 transition-colors disabled:opacity-50">
                {uploadingFile ? '⏳ Đang tải...' : savedId ? '📎 Chọn file để tải lên' : '💾 Lưu trợ lý trước'}
              </button>
            </div>
          </div>

          {/* Advanced settings */}
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-2">⚙️ Cài đặt nâng cao</h2>
            <div className="bg-gray-800 rounded-xl p-4 space-y-4">
              {/* Temperature */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-400">Temperature</label>
                  <span className="text-xs text-white font-mono">{temperature.toFixed(1)}</span>
                </div>
                <input type="range" min="0" max="2" step="0.1" value={temperature}
                  onChange={e => setTemperature(parseFloat(e.target.value))}
                  className="w-full accent-blue-500"/>
                <div className="flex justify-between text-[10px] text-gray-500">
                  <span>Chính xác (0)</span><span>Sáng tạo (2)</span>
                </div>
              </div>

              {/* Max tokens */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">Max tokens</label>
                <input type="number" min={50} max={8000} step={50} value={maxTokens}
                  onChange={e => setMaxTokens(Math.max(50, parseInt(e.target.value) || 1000))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"/>
              </div>

              {/* Context message count */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">Số tin nhắn lịch sử (ngữ cảnh)</label>
                <input type="number" min={1} max={100} step={1} value={contextMessageCount}
                  onChange={e => setContextMessageCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 30)))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"/>
                <p className="text-[10px] text-gray-500 mt-1">
                  Số tin nhắn gần nhất được nạp làm ngữ cảnh cho AI khi gợi ý và trả lời. Mặc định 30.
                </p>
              </div>

              {/* Default toggle */}
              <label className="flex items-center gap-3 cursor-pointer py-1">
                <div className={`relative w-10 h-5 rounded-full transition-colors ${isDefault ? 'bg-blue-600' : 'bg-gray-600'}`}
                  onClick={() => setIsDefault(!isDefault)}>
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${isDefault ? 'translate-x-5' : ''}`}/>
                </div>
                <div>
                  <span className="text-sm text-white">Đặt làm trợ lý mặc định</span>
                  <p className="text-[10px] text-gray-500">Dùng khi tài khoản chưa được gán trợ lý riêng</p>
                </div>
              </label>
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`p-3 rounded-lg text-sm ${testResult.success
              ? 'bg-green-900/30 border border-green-700 text-green-300'
              : 'bg-red-900/30 border border-red-700 text-red-300'}`}>
              {testResult.message}
            </div>
          )}
        </div>

        {/* ─── RIGHT: Chat Preview (collapsible) ───────────────────── */}
        {showChatPanel && (
        <div className="w-[320px] flex-shrink-0 border-l border-gray-700 flex flex-col bg-gray-900">
          {/* Chat header */}
          <div className="px-4 py-3 border-b border-gray-700 flex-shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">💬 Chat thử</h3>
              {chatMessages.length > 0 && (
                <button onClick={() => setChatMessages([])}
                  className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
                  🗑️ Xóa
                </button>
              )}
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5">
              {savedId ? 'Trò chuyện trực tiếp để kiểm tra trợ lý' : 'Lưu trợ lý trước để chat thử'}
            </p>
          </div>

          {/* Chat messages */}
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
            {chatMessages.length === 0 && savedId && (
              <div className="text-center py-10">
                <div className="text-3xl mb-2">{currentPlatform.icon}</div>
                <p className="text-xs text-gray-500">Gửi tin nhắn để test trợ lý AI</p>
              </div>
            )}
            {!savedId && (
              <div className="text-center py-10">
                <div className="text-3xl mb-2">💾</div>
                <p className="text-xs text-gray-500">Lưu trợ lý trước để có thể chat thử</p>
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-200 border border-gray-700'
                }`}>
                  {/* Render structured segments (text + images) or plain text */}
                  {msg.segments && msg.segments.length > 0 ? (
                    <div className="space-y-2">
                      {msg.segments.map((seg, si) => (
                        seg.type === 'image' && Array.isArray(seg.content) ? (
                          <div key={si} className="flex flex-wrap gap-1.5">
                            {seg.content.map((url: string, ui: number) => (
                              <img key={ui} src={url} alt="" className="max-w-full max-h-40 rounded-lg object-cover border border-gray-600/30"
                                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            ))}
                          </div>
                        ) : seg.type === 'text' && seg.content ? (
                          <div key={si} className="whitespace-pre-wrap break-words">{seg.content}</div>
                        ) : null
                      ))}
                    </div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  )}
                  {msg.role === 'assistant' && !msg.content.startsWith('❌') && (
                    <div className="mt-1.5 pt-1.5 border-t border-gray-700/50 space-y-1">
                      {/* Token details */}
                      {(msg.totalTokens || 0) > 0 && (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] font-mono">
                          <span className="text-blue-400">Prompt: {msg.promptTokens?.toLocaleString()} tk</span>
                          <span className="text-green-400">Response: {msg.completionTokens?.toLocaleString()} tk</span>
                          <span className="text-gray-500">Tổng: {msg.totalTokens?.toLocaleString()} tk</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => {
                          const textToCopy = msg.segments
                            ? msg.segments.filter(s => s.type === 'text').map(s => s.content).join('\n')
                            : msg.content;
                          navigator.clipboard.writeText(textToCopy);
                        }}
                          className="text-[10px] px-2 py-0.5 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors">
                          📋 Copy
                        </button>
                        <button onClick={() => setExpandedMsgIdx(expandedMsgIdx === i ? null : i)}
                          className="text-[10px] px-2 py-0.5 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors">
                          {expandedMsgIdx === i ? '🔽 Ẩn chi tiết' : '▶ Chi tiết'}
                        </button>
                      </div>
                      {expandedMsgIdx === i && (
                        <div className="mt-1 p-2 rounded bg-gray-900 border border-gray-700 text-[10px] space-y-1 max-h-40 overflow-y-auto">
                          <p className="text-gray-500 font-semibold">Prompt đã gửi:</p>
                          <pre className="text-gray-400 whitespace-pre-wrap break-all text-[9px]">
                            {chatMessages.slice(0, i).map(m => `[${m.role}] ${m.content}`).join('\n')}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}/>
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}/>
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}/>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Chat input */}
          {savedId && (
            <div className="px-3 pb-3 pt-1 flex-shrink-0">
              <div className="flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
                <textarea ref={chatInputRef}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={handleChatKeyDown}
                  placeholder="Nhập tin nhắn thử..."
                  rows={1}
                  className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 resize-none outline-none max-h-20 overflow-y-auto"
                  style={{ minHeight: '24px' }}
                />
                <button onClick={handleChatSend} disabled={chatLoading || !chatInput.trim()}
                  className="w-7 h-7 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center text-white transition-colors flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
        )}

        {/* ─── RIGHT: Usage Report Panel ───────────────────────────── */}
        {showReport && savedId && (
        <div className="w-[420px] flex-shrink-0 border-l border-gray-700 flex flex-col bg-gray-900">
          <div className="px-4 py-3 border-b border-gray-700 flex-shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">📊 Báo cáo sử dụng</h3>
              <button onClick={() => loadReport()} className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
                🔄 Tải lại
              </button>
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5">Token sử dụng theo ngày (30 ngày gần nhất)</p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {reportLoading ? (
              <div className="flex items-center justify-center h-20">
                <svg className="animate-spin w-5 h-5 text-purple-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              </div>
            ) : (
              <>
                {/* Summary */}
                {usageStats.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-gray-800 rounded-lg p-2.5 text-center">
                      <p className="text-lg font-bold text-white">{usageStats.reduce((s, r) => s + r.request_count, 0).toLocaleString()}</p>
                      <p className="text-[10px] text-gray-500">Tổng requests</p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-2.5 text-center">
                      <p className="text-lg font-bold text-blue-400">{usageStats.reduce((s, r) => s + r.total_prompt_tokens, 0).toLocaleString()}</p>
                      <p className="text-[10px] text-gray-500">Prompt tokens</p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-2.5 text-center">
                      <p className="text-lg font-bold text-green-400">{usageStats.reduce((s, r) => s + r.total_completion_tokens, 0).toLocaleString()}</p>
                      <p className="text-[10px] text-gray-500">Response tokens</p>
                    </div>
                  </div>
                )}

                {/* Daily breakdown */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-400 mb-2">Theo ngày</h4>
                  {usageStats.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-4">Chưa có dữ liệu sử dụng</p>
                  ) : (
                    <div className="space-y-1">
                      {usageStats.map((s, i) => (
                        <div key={i} className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-3 py-2">
                          <span className="text-[11px] text-gray-400 font-mono w-20 flex-shrink-0">{s.day}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-[10px]">
                              <span className="text-white font-medium">{s.request_count} req</span>
                              <span className="text-blue-400">{s.total_prompt_tokens.toLocaleString()} in</span>
                              <span className="text-green-400">{s.total_completion_tokens.toLocaleString()} out</span>
                              <span className="text-gray-500">= {s.total_tokens.toLocaleString()} tk</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Recent logs */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-400 mb-2">Lịch sử gần nhất</h4>
                  {usageLogs.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-4">Chưa có lịch sử</p>
                  ) : (
                    <div className="space-y-1.5">
                      {usageLogs.map((log: any, i: number) => (
                        <details key={i} className="bg-gray-800/60 rounded-lg overflow-hidden group">
                          <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-800 transition-colors">
                            <span className="text-[10px] text-gray-500 font-mono flex-shrink-0">
                              {new Date(log.created_at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                            </span>
                            <span className="text-[10px] text-gray-400 flex-1 truncate">{log.model}</span>
                            <span className="text-[10px] text-blue-400 flex-shrink-0">{log.prompt_tokens}→</span>
                            <span className="text-[10px] text-green-400 flex-shrink-0">←{log.completion_tokens}</span>
                          </summary>
                          <div className="px-3 pb-2 space-y-1.5">
                            <div>
                              <p className="text-[9px] text-gray-500 font-semibold">Prompt:</p>
                              <pre className="text-[9px] text-gray-400 whitespace-pre-wrap break-all bg-gray-900/50 rounded p-1.5 max-h-24 overflow-y-auto">{log.prompt_text?.substring(0, 500)}</pre>
                            </div>
                            <div>
                              <p className="text-[9px] text-gray-500 font-semibold">Response:</p>
                              <pre className="text-[9px] text-gray-300 whitespace-pre-wrap break-all bg-gray-900/50 rounded p-1.5 max-h-24 overflow-y-auto">{log.response_text?.substring(0, 500)}</pre>
                            </div>
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-gray-700 flex-shrink-0 flex items-center gap-3">
        {savedId && (
          <button onClick={handleDelete} disabled={deleting}
            className="px-3 py-2 text-sm rounded-lg text-red-400 hover:bg-red-900/30 border border-red-800/40 transition-colors">
            {deleting ? 'Đang xóa...' : '🗑️ Xóa'}
          </button>
        )}
        <div className="flex-1"/>
        {savedId && (
          <button onClick={handleTest} disabled={testing}
            className="px-4 py-2 text-sm rounded-lg bg-gray-700 hover:bg-gray-600 text-white transition-colors">
            {testing ? '⏳ Đang test...' : '🔍 Test kết nối'}
          </button>
        )}
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors">
          {saving ? 'Đang lưu...' : savedId ? '💾 Cập nhật' : '✨ Tạo trợ lý'}
        </button>
      </div>

      {/* Prompt Wizard Modal */}
      <PromptWizardModal
        open={showPromptWizard}
        onClose={() => setShowPromptWizard(false)}
        onApply={(prompt) => setSystemPrompt(prompt)}
        assistantId={savedId}
        currentPrompt={systemPrompt}
      />
    </div>
  );
}
