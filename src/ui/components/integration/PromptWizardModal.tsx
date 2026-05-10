/**
 * PromptWizardModal.tsx
 * Wizard popup sinh prompt AI cho hệ thống trợ lý — step-by-step hoặc nhanh.
 * Trigger: nút "✨ Gợi ý bằng AI" trong phần System Prompt.
 */
import React, { useState, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';

// ─── Data: Industries ──────────────────────────────────────────────────────────

const INDUSTRIES = [
  { key: 'fashion',       icon: '👗', label: 'Thời trang',       desc: 'Quần áo, giày dép, phụ kiện' },
  { key: 'cosmetics',     icon: '💄', label: 'Mỹ phẩm',         desc: 'Skincare, makeup, chăm sóc da' },
  { key: 'fnb',           icon: '🍜', label: 'F&B',             desc: 'Nhà hàng, quán cafe, đồ uống' },
  { key: 'education',     icon: '📚', label: 'Giáo dục',        desc: 'Khóa học, đào tạo, trung tâm' },
  { key: 'realestate',    icon: '🏠', label: 'Bất động sản',    desc: 'Mua bán, cho thuê, dự án' },
  { key: 'spa',           icon: '💆', label: 'Spa / Thẩm mỹ',  desc: 'Chăm sóc sắc đẹp, thẩm mỹ viện' },
  { key: 'health',        icon: '🏥', label: 'Sức khỏe',        desc: 'Phòng khám, TPCN, thiết bị y tế' },
  { key: 'tech',          icon: '💻', label: 'Công nghệ',       desc: 'Phần mềm, SaaS, điện thoại' },
  { key: 'ecommerce',     icon: '🛒', label: 'E-commerce',      desc: 'Bán hàng online đa ngành' },
  { key: 'insurance',     icon: '🛡️', label: 'Bảo hiểm',       desc: 'Bảo hiểm nhân thọ, phi nhân thọ' },
  { key: 'automotive',    icon: '🚗', label: 'Ô tô / Xe máy',  desc: 'Mua bán, sửa chữa, phụ tùng' },
  { key: 'travel',        icon: '✈️', label: 'Du lịch',         desc: 'Tour, khách sạn, visa' },
] as const;

// ─── Data: Goals ───────────────────────────────────────────────────────────────

const GOALS = [
  { key: 'sales',        icon: '💰', label: 'Bán hàng (chốt đơn)',          desc: 'Tư vấn → chốt đơn → upsell' },
  { key: 'consult',      icon: '💡', label: 'Tư vấn sản phẩm',              desc: 'Giải đáp thắc mắc, so sánh SP' },
  { key: 'support',      icon: '🎧', label: 'Chăm sóc khách hàng',         desc: 'Hỗ trợ sau bán, xử lý khiếu nại' },
  { key: 'marketing',    icon: '📢', label: 'Seeding / Marketing',          desc: 'Gieo mầm, tạo nhu cầu, remarketing' },
  { key: 'internal',     icon: '🏢', label: 'Hỗ trợ nội bộ',               desc: 'Trả lời nhân viên, FAQ nội bộ' },
  { key: 'booking',      icon: '📅', label: 'Đặt lịch hẹn',                desc: 'Booking, nhắc lịch, confirm' },
] as const;

// ─── Data: Tones ───────────────────────────────────────────────────────────────

const TONES = [
  { key: 'friendly',      icon: '😊', label: 'Thân thiện',      desc: 'Gần gũi, dễ thương' },
  { key: 'professional',  icon: '👔', label: 'Chuyên nghiệp',   desc: 'Lịch sự, nghiêm túc' },
  { key: 'humorous',      icon: '😄', label: 'Hài hước',        desc: 'Vui vẻ, dí dỏm' },
  { key: 'concise',       icon: '⚡', label: 'Ngắn gọn',        desc: 'Đi thẳng vào vấn đề' },
  { key: 'detailed',      icon: '📋', label: 'Chi tiết',        desc: 'Giải thích kỹ, từng bước' },
  { key: 'personalized',  icon: '💖', label: 'Cá nhân hoá',     desc: 'Gọi tên, nhớ sở thích' },
] as const;

// ─── Data: Prompt Templates Library ────────────────────────────────────────────

const PROMPT_TEMPLATES = [
  {
    id: 'cosmetics-sales',
    icon: '💄',
    label: 'Chatbot chốt đơn mỹ phẩm',
    desc: 'Tư vấn skincare, chốt đơn, upsell combo',
    industry: 'cosmetics',
    prompt: `Bạn là chuyên gia tư vấn mỹ phẩm & skincare.

🎯 VAI TRÒ: Tư vấn viên bán hàng chuyên nghiệp, am hiểu về da và sản phẩm chăm sóc da.

🧠 CONTEXT: Bạn đang tư vấn cho khách hàng qua Zalo. Khách thường hỏi về tình trạng da, so sánh sản phẩm, giá cả.

🗣️ TONE: Thân thiện, gần gũi nhưng chuyên nghiệp. Gọi khách là "chị/em" hoặc "bạn".

📋 QUY TẮC:
1. Hỏi tình trạng da trước khi tư vấn sản phẩm
2. Gợi ý combo/set phù hợp để tăng giá trị đơn
3. Nhắc chính sách ưu đãi khi chốt đơn
4. Kết thúc bằng CTA rõ ràng (đặt hàng, inbox SĐT)
5. Trả lời ngắn gọn, chia nhỏ thông tin

❌ KHÔNG ĐƯỢC:
- Chê sản phẩm đối thủ
- Cam kết kết quả chữa bệnh
- Trả lời quá dài (max 3-4 dòng/tin nhắn)
- Bỏ qua câu hỏi của khách`,
  },
  {
    id: 'course-consult',
    icon: '📚',
    label: 'Chatbot tư vấn khóa học',
    desc: 'Tư vấn chương trình, học phí, đăng ký',
    industry: 'education',
    prompt: `Bạn là tư vấn viên giáo dục chuyên nghiệp.

🎯 VAI TRÒ: Tư vấn khóa học, giải đáp thắc mắc, hỗ trợ đăng ký.

🧠 CONTEXT: Khách hàng quan tâm đến khóa học và cần được tư vấn lộ trình phù hợp.

🗣️ TONE: Chuyên nghiệp, nhiệt tình, truyền cảm hứng.

📋 QUY TẮC:
1. Hỏi mục tiêu học tập, trình độ hiện tại
2. Gợi ý khóa học phù hợp với từng đối tượng
3. Chia sẻ feedback học viên cũ khi phù hợp
4. Nhắc ưu đãi/deadline đăng ký nếu có
5. Kết thúc bằng CTA đặt lịch tư vấn chi tiết

❌ KHÔNG ĐƯỢC:
- Hứa hẹn kết quả 100%
- So sánh trực tiếp với trung tâm khác
- Bỏ qua ngân sách/thời gian của khách`,
  },
  {
    id: 'ecom-support',
    icon: '🛒',
    label: 'Chatbot CSKH e-commerce',
    desc: 'Hỗ trợ đơn hàng, đổi trả, khiếu nại',
    industry: 'ecommerce',
    prompt: `Bạn là nhân viên chăm sóc khách hàng chuyên nghiệp.

🎯 VAI TRÒ: Hỗ trợ khách hàng sau mua — tra đơn, đổi trả, xử lý khiếu nại.

🧠 CONTEXT: Khách liên hệ qua Zalo về đơn hàng đã mua. Cần xử lý nhanh, chính xác.

🗣️ TONE: Lịch sự, kiên nhẫn, đồng cảm.

📋 QUY TẮC:
1. Xin mã đơn hàng/SĐT để tra cứu trước
2. Giải thích rõ chính sách đổi trả, hoàn tiền
3. Nếu không giải quyết được → chuyển cho bộ phận phụ trách
4. Luôn xin lỗi khi khách gặp vấn đề
5. Follow-up xác nhận đã xử lý xong

❌ KHÔNG ĐƯỢC:
- Đổ lỗi cho khách
- Hứa bồi thường khi chưa được duyệt
- Tranh luận với khách hàng`,
  },
  {
    id: 'realestate-sales',
    icon: '🏠',
    label: 'Chatbot bán bất động sản',
    desc: 'Tư vấn dự án, giá, tiến độ, booking',
    industry: 'realestate',
    prompt: `Bạn là chuyên viên tư vấn bất động sản chuyên nghiệp.

🎯 VAI TRÒ: Tư vấn dự án, giá bán, chính sách thanh toán, hỗ trợ booking.

🧠 CONTEXT: Khách hàng quan tâm dự án BĐS, cần thông tin chi tiết và lịch tham quan.

🗣️ TONE: Chuyên nghiệp, đáng tin cậy, tạo cảm giác urgency nhẹ.

📋 QUY TẮC:
1. Hỏi nhu cầu: ở hay đầu tư, ngân sách, khu vực
2. Giới thiệu dự án phù hợp với highlight chính
3. Nhắc giá trị tăng, tiềm năng khu vực
4. Gợi ý đặt lịch tham quan thực tế
5. Follow-up bằng tài liệu chi tiết

❌ KHÔNG ĐƯỢC:
- Cam kết lợi nhuận cụ thể
- Cung cấp thông tin chưa xác minh
- Ép khách quyết định`,
  },
  {
    id: 'upsell-general',
    icon: '🚀',
    label: 'Chatbot upsell / cross-sell',
    desc: 'Tăng giá trị đơn hàng, gợi ý sản phẩm liên quan',
    industry: 'ecommerce',
    prompt: `Bạn là trợ lý bán hàng thông minh chuyên upsell/cross-sell.

🎯 VAI TRÒ: Gợi ý sản phẩm liên quan, combo, phiên bản cao cấp hơn một cách tự nhiên.

🧠 CONTEXT: Khách đã mua hoặc đang xem sản phẩm. Bạn cần gợi ý thêm sản phẩm bổ trợ.

🗣️ TONE: Thân thiện, tự nhiên, không ép buộc.

📋 QUY TẮC:
1. Khen chọn lựa của khách trước
2. Gợi ý sản phẩm bổ trợ "đi kèm hoàn hảo"
3. Nêu lý do vì sao nên mua combo
4. Nhắc ưu đãi khi mua combo (nếu có)
5. Tôn trọng nếu khách từ chối

❌ KHÔNG ĐƯỢC:
- Push quá 2 lần nếu khách đã từ chối
- Gợi ý sản phẩm không liên quan
- Tạo cảm giác bị ép mua`,
  },
  {
    id: 'spa-booking',
    icon: '💆',
    label: 'Chatbot đặt lịch Spa',
    desc: 'Tư vấn dịch vụ, giá, đặt lịch hẹn',
    industry: 'spa',
    prompt: `Bạn là lễ tân spa chuyên nghiệp.

🎯 VAI TRÒ: Tư vấn dịch vụ, báo giá, đặt lịch hẹn cho khách.

🧠 CONTEXT: Khách liên hệ qua Zalo muốn tìm hiểu dịch vụ spa và đặt lịch.

🗣️ TONE: Nhẹ nhàng, thân thiện, tạo cảm giác thư giãn.

📋 QUY TẮC:
1. Hỏi nhu cầu: dịch vụ quan tâm, thời gian rảnh
2. Giới thiệu gói phù hợp, highlight combo tiết kiệm
3. Gợi ý khung giờ đẹp còn trống
4. Nhắc khách đến trước 10 phút
5. Gửi xác nhận lịch hẹn rõ ràng

❌ KHÔNG ĐƯỢC:
- Tư vấn y khoa khi không có chuyên môn
- Cam kết kết quả điều trị
- Quên xác nhận lại lịch hẹn`,
  },
] as const;

// ─── Data: Improve options ─────────────────────────────────────────────────────

const IMPROVE_OPTIONS = [
  { key: 'close-deal',    icon: '💰', label: 'Tăng tỉ lệ chốt đơn' },
  { key: 'natural',       icon: '💬', label: 'Trả lời tự nhiên hơn' },
  { key: 'shorter',       icon: '⚡', label: 'Ngắn gọn hơn' },
  { key: 'detailed',      icon: '📋', label: 'Chi tiết hơn' },
  { key: 'friendly',      icon: '😊', label: 'Thân thiện hơn' },
  { key: 'professional',  icon: '👔', label: 'Chuyên nghiệp hơn' },
  { key: 'add-upsell',    icon: '🚀', label: 'Thêm kỹ năng upsell' },
  { key: 'add-objection', icon: '🛡️', label: 'Xử lý từ chối tốt hơn' },
] as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

type WizardTab = 'create' | 'library';
type WizardStep = 1 | 2 | 3 | 4 | 5;

interface PromptResult {
  full: string;
  role?: string;
  context?: string;
  tone?: string;
  rules?: string;
  constraints?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (prompt: string) => void;
  /** ID trợ lý đã lưu — cần để gọi ipc.ai.chat */
  assistantId: string | null;
  /** Prompt hiện tại (nếu có) → dùng cho "Cải thiện" */
  currentPrompt?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function PromptWizardModal({ open, onClose, onApply, assistantId, currentPrompt }: Props) {
  const { showNotification } = useAppStore();

  // Tab: create wizard | library
  const [tab, setTab] = useState<WizardTab>('create');

  // Wizard state
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedIndustry, setSelectedIndustry] = useState<string>('');
  const [customIndustry, setCustomIndustry] = useState('');
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [selectedTones, setSelectedTones] = useState<string[]>([]);
  const [extraInfo, setExtraInfo] = useState({
    products: '',
    price: '',
    usp: '',
    policy: '',
    insight: '',
  });
  // Structured product lines: name + price + note per row
  const [productLines, setProductLines] = useState<{ name: string; price: string; note: string }[]>([
    { name: '', price: '', note: '' },
  ]);
  const [industrySearch, setIndustrySearch] = useState('');

  // Result state
  const [result, setResult] = useState<PromptResult | null>(null);
  const [editablePrompt, setEditablePrompt] = useState('');
  const [generating, setGenerating] = useState(false);

  // When opened with existing prompt, pre-populate for improve mode
  React.useEffect(() => {
    if (open && currentPrompt && currentPrompt.trim().length > 20) {
      setEditablePrompt(currentPrompt);
      setResult(parsePromptResult(currentPrompt));
    }
  }, [open, currentPrompt]);

  // Improve mode
  const [showImprove, setShowImprove] = useState(false);
  const [improveLoading, setImproveLoading] = useState(false);

  // Chat refine mode
  const [showChatRefine, setShowChatRefine] = useState(false);
  const [chatRefineInput, setChatRefineInput] = useState('');
  const [chatRefineLoading, setChatRefineLoading] = useState(false);
  const [chatRefineHistory, setChatRefineHistory] = useState<{ role: string; content: string }[]>([]);

  // Quick mode
  const [quickIndustry, setQuickIndustry] = useState('');
  const [quickGoal, setQuickGoal] = useState('');

  // Library preview
  const [previewTemplate, setPreviewTemplate] = useState<typeof PROMPT_TEMPLATES[number] | null>(null);

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const getIndustryLabel = () => {
    if (selectedIndustry === 'custom') return customIndustry || 'Ngành khác';
    return INDUSTRIES.find(i => i.key === selectedIndustry)?.label || selectedIndustry;
  };

  const callAI = useCallback(async (messages: { role: string; content: string }[]): Promise<string> => {
    if (!assistantId) throw new Error('Chưa lưu trợ lý — hãy lưu trước để dùng tính năng này');
    const res = await ipc.ai?.chat(assistantId, messages);
    if (!res?.success || !res.result) throw new Error(res?.error || 'Không có phản hồi từ AI');
    return res.result;
  }, [assistantId]);

  const buildMasterPrompt = useCallback(() => {
    const industry = getIndustryLabel();
    const goals = selectedGoals.map(g => GOALS.find(x => x.key === g)?.label).filter(Boolean).join(', ');
    const tones = selectedTones.map(t => TONES.find(x => x.key === t)?.label).filter(Boolean).join(', ');

    // Format structured product lines
    const filledProducts = productLines.filter(p => p.name.trim());
    const productListText = filledProducts.length > 0
      ? filledProducts.map((p, i) => {
          let line = `${i + 1}. ${p.name.trim()}`;
          if (p.price.trim()) line += ` — Giá: ${p.price.trim()}`;
          if (p.note.trim()) line += ` (${p.note.trim()})`;
          return line;
        }).join('\n')
      : '';

    const extra = [
      extraInfo.products && `Sản phẩm/dịch vụ chính: ${extraInfo.products}`,
      productListText && `Danh sách sản phẩm chi tiết:\n${productListText}`,
      extraInfo.price && `Mức giá chung: ${extraInfo.price}`,
      extraInfo.usp && `Điểm khác biệt (USP): ${extraInfo.usp}`,
      extraInfo.policy && `Chính sách: ${extraInfo.policy}`,
      extraInfo.insight && `Insight khách hàng: ${extraInfo.insight}`,
    ].filter(Boolean).join('\n');

    return `Bạn là chuyên gia thiết kế prompt cho AI chatbot bán hàng/CSKH trên Zalo.

Dựa vào thông tin sau, hãy tạo 1 prompt hoàn chỉnh bằng tiếng Việt cho chatbot:

- Ngành: ${industry}
- Mục tiêu: ${goals || 'Bán hàng chung'}
- Phong cách/Tone: ${tones || 'Thân thiện'}
${extra ? `- Thông tin bổ sung:\n${extra}` : ''}

Yêu cầu output prompt gồm các phần rõ ràng:
1. 🎯 Vai trò AI (Role) — 1-2 câu mô tả vai trò
2. 🧠 Context — bối cảnh hoạt động${filledProducts.length > 0 ? '. QUAN TRỌNG: Phải đính kèm nguyên danh sách sản phẩm chi tiết (tên, giá, ghi chú) vào phần Context hoặc tạo section riêng "📦 Danh sách sản phẩm" để AI biết chính xác sản phẩm khi tư vấn' : ''}
3. 🗣️ Tone guideline — phong cách trả lời
4. 📋 Quy tắc trả lời (Instructions) — 5-7 quy tắc cụ thể, thực tế
5. ❌ Những điều không được làm (Constraints) — 3-5 ràng buộc

Prompt phải:
- Viết bằng tiếng Việt tự nhiên
- Cụ thể cho ngành "${industry}"
- Có thể copy & dùng ngay
- Mỗi phần có emoji đầu dòng tương ứng
- Không dùng markdown heading (#), chỉ dùng emoji + text
- Tổng độ dài khoảng 200-400 từ`;
  }, [selectedIndustry, customIndustry, selectedGoals, selectedTones, extraInfo, productLines]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    setGenerating(true);
    setResult(null);
    try {
      const masterPrompt = buildMasterPrompt();
      const response = await callAI([
        { role: 'user', content: masterPrompt },
      ]);
      const parsed = parsePromptResult(response);
      setResult(parsed);
      setEditablePrompt(parsed.full);
      setStep(5);
    } catch (e: any) {
      showNotification('❌ ' + e.message, 'error');
    }
    setGenerating(false);
  };

  const handleQuickGenerate = async () => {
    if (!quickIndustry.trim()) { showNotification('Nhập ngành nghề', 'warning'); return; }
    setGenerating(true);
    setResult(null);
    try {
      const prompt = `Bạn là chuyên gia thiết kế prompt cho AI chatbot trên Zalo.

Tạo nhanh 1 prompt hoàn chỉnh bằng tiếng Việt cho chatbot:
- Ngành: ${quickIndustry}
- Mục tiêu: ${quickGoal || 'Bán hàng + tư vấn'}

Output gồm: Vai trò, Context, Tone, Quy tắc (5 điểm), Ràng buộc (3 điểm).
Viết tự nhiên, cụ thể, dùng emoji, có thể copy dùng ngay. Không dùng markdown heading.`;
      const response = await callAI([{ role: 'user', content: prompt }]);
      const parsed = parsePromptResult(response);
      setResult(parsed);
      setEditablePrompt(parsed.full);
      setTab('create');
      setStep(5);
    } catch (e: any) {
      showNotification('❌ ' + e.message, 'error');
    }
    setGenerating(false);
  };

  const handleRegenerate = async () => {
    setGenerating(true);
    try {
      const masterPrompt = buildMasterPrompt();
      const response = await callAI([
        { role: 'user', content: masterPrompt },
        { role: 'assistant', content: editablePrompt },
        { role: 'user', content: 'Hãy tạo lại prompt với cách tiếp cận khác, sáng tạo hơn, nhưng vẫn giữ đúng ngành và mục tiêu.' },
      ]);
      const parsed = parsePromptResult(response);
      setResult(parsed);
      setEditablePrompt(parsed.full);
    } catch (e: any) {
      showNotification('❌ ' + e.message, 'error');
    }
    setGenerating(false);
  };

  const handleImprove = async (optionKey: string) => {
    const option = IMPROVE_OPTIONS.find(o => o.key === optionKey);
    if (!option) return;
    setImproveLoading(true);
    try {
      const response = await callAI([
        { role: 'user', content: `Đây là prompt hiện tại của chatbot:\n\n${editablePrompt}\n\nHãy cải thiện prompt này theo hướng: "${option.label}"\n\nGiữ nguyên cấu trúc (Vai trò, Context, Tone, Quy tắc, Ràng buộc) nhưng nâng cấp nội dung. Output là prompt hoàn chỉnh đã cải thiện, không giải thích thêm.` },
      ]);
      const parsed = parsePromptResult(response);
      setResult(parsed);
      setEditablePrompt(parsed.full);
      setShowImprove(false);
      showNotification('✅ Đã cải thiện prompt!', 'success');
    } catch (e: any) {
      showNotification('❌ ' + e.message, 'error');
    }
    setImproveLoading(false);
  };

  const handleChatRefineSend = async () => {
    const text = chatRefineInput.trim();
    if (!text || chatRefineLoading) return;

    const newHistory = [...chatRefineHistory, { role: 'user', content: text }];
    setChatRefineHistory(newHistory);
    setChatRefineInput('');
    setChatRefineLoading(true);

    try {
      const messages = [
        { role: 'user', content: `Đây là prompt hiện tại:\n\n${editablePrompt}\n\nTôi muốn chỉnh sửa prompt này qua hội thoại. Khi tôi yêu cầu thay đổi, hãy trả về prompt hoàn chỉnh đã sửa (không giải thích, chỉ trả prompt).` },
        { role: 'assistant', content: 'Ok, tôi sẽ giúp bạn chỉnh sửa prompt. Bạn muốn thay đổi gì?' },
        ...newHistory,
      ];
      const response = await callAI(messages);
      setChatRefineHistory(prev => [...prev, { role: 'assistant', content: response }]);

      // If the response looks like a full prompt (has role/rules/constraints), update editable
      if (response.length > 100 && (response.includes('Vai trò') || response.includes('🎯') || response.includes('Quy tắc'))) {
        const parsed = parsePromptResult(response);
        setResult(parsed);
        setEditablePrompt(parsed.full);
      }
    } catch (e: any) {
      setChatRefineHistory(prev => [...prev, { role: 'assistant', content: `❌ ${e.message}` }]);
    }
    setChatRefineLoading(false);
  };

  const handleAutoFillExtra = async () => {
    setGenerating(true);
    try {
      const industry = getIndustryLabel();
      const response = await callAI([
        { role: 'user', content: `Tôi có shop bán hàng ngành "${industry}". Hãy gợi ý cho tôi:\n1. Mô tả chung sản phẩm (1-2 dòng)\n2. Mức giá phổ biến (nhiều dòng nếu cần)\n3. USP phổ biến ngành này (nhiều dòng)\n4. Chính sách phổ biến (nhiều dòng)\n5. Insight khách hàng (nhiều dòng)\n6. Danh sách 3-5 sản phẩm tiêu biểu với tên, giá, ghi chú ngắn\n\nTrả về format JSON:\n{"products":"...","price":"...","usp":"...","policy":"...","insight":"...","productLines":[{"name":"...","price":"...","note":"..."}]}\nChỉ trả JSON, không giải thích.` },
      ]);
      try {
        const jsonMatch = response.match(/\{[\s\S]*}/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          setExtraInfo({
            products: data.products || '',
            price: data.price || '',
            usp: data.usp || '',
            policy: data.policy || '',
            insight: data.insight || '',
          });
          if (Array.isArray(data.productLines) && data.productLines.length > 0) {
            setProductLines([
              ...data.productLines.map((p: any) => ({
                name: p.name || '',
                price: p.price || '',
                note: p.note || '',
              })),
              { name: '', price: '', note: '' },
            ]);
          }
          showNotification('✅ AI đã gợi ý thông tin!', 'success');
        }
      } catch {
        showNotification('⚠️ Không parse được gợi ý, hãy nhập thủ công', 'warning');
      }
    } catch (e: any) {
      showNotification('❌ ' + e.message, 'error');
    }
    setGenerating(false);
  };

  const handleApply = () => {
    onApply(editablePrompt);
    showNotification('✅ Đã áp dụng prompt!', 'success');
    onClose();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(editablePrompt);
    showNotification('📋 Đã copy prompt!', 'success');
  };

  const resetWizard = () => {
    setStep(1);
    setSelectedIndustry('');
    setCustomIndustry('');
    setSelectedGoals([]);
    setSelectedTones([]);
    setExtraInfo({ products: '', price: '', usp: '', policy: '', insight: '' });
    setProductLines([{ name: '', price: '', note: '' }]);
    setResult(null);
    setEditablePrompt('');
    setShowImprove(false);
    setShowChatRefine(false);
    setChatRefineHistory([]);
    setIndustrySearch('');
  };

  // Parse AI response into sections
  const parsePromptResult = (text: string): PromptResult => {
    const sections: PromptResult = { full: text.trim() };
    // Try to extract sections by emoji markers
    const roleMatch = text.match(/🎯[^🧠❌📋🗣️]*/s);
    const ctxMatch = text.match(/🧠[^🎯❌📋🗣️]*/s);
    const toneMatch = text.match(/🗣️[^🎯❌📋🧠]*/s);
    const rulesMatch = text.match(/📋[^🎯❌🗣️🧠]*/s);
    const constraintMatch = text.match(/❌[^🎯📋🗣️🧠]*/s);
    if (roleMatch) sections.role = roleMatch[0].trim();
    if (ctxMatch) sections.context = ctxMatch[0].trim();
    if (toneMatch) sections.tone = toneMatch[0].trim();
    if (rulesMatch) sections.rules = rulesMatch[0].trim();
    if (constraintMatch) sections.constraints = constraintMatch[0].trim();
    return sections;
  };

  // Toggle multi-select
  const toggleMulti = (arr: string[], key: string) =>
    arr.includes(key) ? arr.filter(k => k !== key) : [...arr, key];

  // Filter industries
  const filteredIndustries = industrySearch
    ? INDUSTRIES.filter(i => i.label.toLowerCase().includes(industrySearch.toLowerCase()) || i.desc.toLowerCase().includes(industrySearch.toLowerCase()))
    : INDUSTRIES;

  if (!open) return null;

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[780px] max-h-[88vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* ─ Header ─ */}
        <div className="px-5 py-3 border-b border-gray-700 flex items-center gap-3 flex-shrink-0">
          <span className="text-xl">✨</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-white">Gợi ý Prompt bằng AI</h2>
            <p className="text-[10px] text-gray-500">Tạo prompt chuyên nghiệp trong vài phút — không cần biết viết prompt</p>
          </div>
          {/* Tab switcher */}
          <div className="flex items-center bg-gray-800 rounded-lg p-0.5 gap-0.5 flex-shrink-0">
            <button onClick={() => { setTab('create'); if (step === 5 && !result) setStep(1); }}
              className={`px-3 py-1 rounded-md text-xs transition-colors ${tab === 'create' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              🎨 Tạo mới
            </button>
            <button onClick={() => setTab('library')}
              className={`px-3 py-1 rounded-md text-xs transition-colors ${tab === 'library' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
              📚 Thư viện
            </button>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-800">✕</button>
        </div>

        {/* ─ Body ─ */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'create' && step < 5 && (
            <div className="p-5">
              {/* Quick mode bar */}
              <div className="mb-4 p-3 bg-gray-800/60 rounded-xl border border-gray-700/50">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs">⚡</span>
                  <span className="text-xs font-medium text-gray-300">Chế độ nhanh — 1 click ra prompt</span>
                </div>
                <div className="flex items-center gap-2">
                  <input type="text" value={quickIndustry} onChange={e => setQuickIndustry(e.target.value)}
                    placeholder="VD: Bán mỹ phẩm, spa, bất động sản..."
                    className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"/>
                  <input type="text" value={quickGoal} onChange={e => setQuickGoal(e.target.value)}
                    placeholder="Mục tiêu (tuỳ chọn)"
                    className="w-40 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"/>
                  <button onClick={handleQuickGenerate} disabled={generating || !assistantId}
                    className="px-3 py-1.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white text-xs font-medium rounded-lg transition-all disabled:opacity-50 flex-shrink-0 whitespace-nowrap">
                    {generating ? '⏳' : '⚡'} Tạo nhanh
                  </button>
                </div>
                {!assistantId && (
                  <p className="text-[10px] text-amber-400 mt-1.5">⚠️ Lưu trợ lý AI trước để sử dụng tính năng gợi ý (cần API Key hoạt động)</p>
                )}
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 border-t border-gray-700"/>
                <span className="text-[10px] text-gray-500">hoặc wizard chi tiết</span>
                <div className="flex-1 border-t border-gray-700"/>
              </div>

              {/* Step indicator */}
              <div className="flex items-center gap-1 mb-4">
                {([1, 2, 3, 4] as WizardStep[]).map(s => (
                  <React.Fragment key={s}>
                    <button onClick={() => { if (s < step || (s === step)) setStep(s); }}
                      className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all ${
                        s === step ? 'bg-blue-600 text-white scale-110' : s < step ? 'bg-blue-600/30 text-blue-400 cursor-pointer hover:bg-blue-600/50' : 'bg-gray-700 text-gray-500'
                      }`}>{s}</button>
                    {s < 4 && <div className={`flex-1 h-0.5 rounded ${s < step ? 'bg-blue-600/50' : 'bg-gray-700'}`}/>}
                  </React.Fragment>
                ))}
              </div>

              {/* ─── Step 1: Industry ─── */}
              {step === 1 && (
                <div>
                  <h3 className="text-sm font-semibold text-white mb-1">🧱 Bước 1: Chọn ngành nghề</h3>
                  <p className="text-[10px] text-gray-500 mb-3">Chọn ngành để AI tạo prompt phù hợp nhất</p>
                  <input type="text" value={industrySearch} onChange={e => setIndustrySearch(e.target.value)}
                    placeholder="🔍 Tìm ngành..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 mb-3"/>
                  <div className="grid grid-cols-3 gap-2 max-h-[260px] overflow-y-auto pr-1">
                    {filteredIndustries.map(ind => (
                      <button key={ind.key} onClick={() => setSelectedIndustry(ind.key)}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          selectedIndustry === ind.key
                            ? 'bg-blue-600/20 border-blue-500 ring-1 ring-blue-500/50'
                            : 'bg-gray-800/60 border-gray-700 hover:border-gray-600 hover:bg-gray-800'
                        }`}>
                        <span className="text-xl">{ind.icon}</span>
                        <p className="text-xs font-medium text-white mt-1">{ind.label}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">{ind.desc}</p>
                      </button>
                    ))}
                    {/* Custom */}
                    <button onClick={() => setSelectedIndustry('custom')}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        selectedIndustry === 'custom'
                          ? 'bg-blue-600/20 border-blue-500 ring-1 ring-blue-500/50'
                          : 'bg-gray-800/60 border-gray-700 hover:border-gray-600 hover:bg-gray-800'
                      }`}>
                      <span className="text-xl">✏️</span>
                      <p className="text-xs font-medium text-white mt-1">Khác</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">Tự nhập ngành</p>
                    </button>
                  </div>
                  {selectedIndustry === 'custom' && (
                    <input type="text" value={customIndustry} onChange={e => setCustomIndustry(e.target.value)}
                      placeholder="Nhập tên ngành nghề..."
                      autoFocus
                      className="w-full mt-3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"/>
                  )}
                </div>
              )}

              {/* ─── Step 2: Goals ─── */}
              {step === 2 && (
                <div>
                  <h3 className="text-sm font-semibold text-white mb-1">🎯 Bước 2: Mục tiêu sử dụng AI</h3>
                  <p className="text-[10px] text-gray-500 mb-3">Có thể chọn nhiều mục tiêu</p>
                  <div className="grid grid-cols-2 gap-2">
                    {GOALS.map(g => (
                      <button key={g.key} onClick={() => setSelectedGoals(toggleMulti(selectedGoals, g.key))}
                        className={`p-3 rounded-xl border text-left transition-all flex items-start gap-3 ${
                          selectedGoals.includes(g.key)
                            ? 'bg-blue-600/20 border-blue-500 ring-1 ring-blue-500/50'
                            : 'bg-gray-800/60 border-gray-700 hover:border-gray-600 hover:bg-gray-800'
                        }`}>
                        <span className="text-xl flex-shrink-0">{g.icon}</span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-white">{g.label}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">{g.desc}</p>
                        </div>
                        {selectedGoals.includes(g.key) && <span className="text-blue-400 text-sm flex-shrink-0 ml-auto">✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── Step 3: Tone ─── */}
              {step === 3 && (
                <div>
                  <h3 className="text-sm font-semibold text-white mb-1">🗣️ Bước 3: Phong cách trả lời</h3>
                  <p className="text-[10px] text-gray-500 mb-3">Chọn nhiều để phối hợp phong cách → tạo tone prompt</p>
                  <div className="grid grid-cols-3 gap-2">
                    {TONES.map(t => (
                      <button key={t.key} onClick={() => setSelectedTones(toggleMulti(selectedTones, t.key))}
                        className={`p-3 rounded-xl border text-center transition-all ${
                          selectedTones.includes(t.key)
                            ? 'bg-blue-600/20 border-blue-500 ring-1 ring-blue-500/50'
                            : 'bg-gray-800/60 border-gray-700 hover:border-gray-600 hover:bg-gray-800'
                        }`}>
                        <span className="text-xl">{t.icon}</span>
                        <p className="text-xs font-medium text-white mt-1">{t.label}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">{t.desc}</p>
                        {selectedTones.includes(t.key) && <span className="text-blue-400 text-xs mt-1 block">✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── Step 4: Extra info ─── */}
              {step === 4 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-sm font-semibold text-white">📝 Bước 4: Thông tin bổ sung</h3>
                    <button onClick={handleAutoFillExtra} disabled={generating || !assistantId}
                      className="text-[10px] px-2.5 py-1 rounded-lg bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-600/30 transition-colors disabled:opacity-50">
                      {generating ? '⏳ Đang gợi ý...' : '🤖 Tôi chưa có → AI tự đề xuất'}
                    </button>
                  </div>
                  <p className="text-[10px] text-gray-500 mb-3">Tuỳ chọn — thêm thông tin để prompt chính xác hơn. Không cần POS hay file, nhập trực tiếp tại đây.</p>
                  <div className="space-y-4">

                    {/* Product overview */}
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Mô tả chung về sản phẩm/dịch vụ</label>
                      <textarea value={extraInfo.products} onChange={e => setExtraInfo({ ...extraInfo, products: e.target.value })}
                        rows={2}
                        placeholder="VD: Shop chuyên skincare Hàn Quốc, chủ yếu kem dưỡng, serum, tẩy trang cho da dầu mụn..."
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y min-h-[48px]"/>
                    </div>

                    {/* Structured product lines */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-[10px] text-gray-400 flex items-center gap-1">
                          📦 Danh sách sản phẩm chi tiết
                          <span className="text-[9px] text-gray-600">(sẽ đính kèm vào prompt)</span>
                        </label>
                        <span className="text-[9px] text-gray-600">{productLines.filter(p => p.name.trim()).length} sản phẩm</span>
                      </div>
                      <div className="bg-gray-800/80 rounded-xl border border-gray-700/50 overflow-hidden">
                        {/* Table header */}
                        <div className="grid grid-cols-[1fr_140px_1fr_32px] gap-1.5 px-3 py-1.5 bg-gray-800 border-b border-gray-700/50">
                          <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide">Tên sản phẩm</span>
                          <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide">Giá</span>
                          <span className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide">Ghi chú (mô tả, SKU...)</span>
                          <span/>
                        </div>
                        {/* Product rows */}
                        <div className="max-h-[200px] overflow-y-auto">
                          {productLines.map((line, idx) => (
                            <div key={idx} className="grid grid-cols-[1fr_140px_1fr_32px] gap-1.5 px-3 py-1 items-center border-b border-gray-800/50 last:border-b-0 hover:bg-gray-700/20 transition-colors">
                              <input type="text" value={line.name}
                                onChange={e => { const arr = [...productLines]; arr[idx] = { ...arr[idx], name: e.target.value }; setProductLines(arr); }}
                                placeholder={`SP ${idx + 1}...`}
                                className="bg-transparent border-0 text-xs text-white placeholder-gray-600 focus:outline-none py-1"/>
                              <input type="text" value={line.price}
                                onChange={e => { const arr = [...productLines]; arr[idx] = { ...arr[idx], price: e.target.value }; setProductLines(arr); }}
                                placeholder="299k"
                                className="bg-transparent border-0 text-xs text-green-400 placeholder-gray-600 focus:outline-none py-1 font-mono"/>
                              <input type="text" value={line.note}
                                onChange={e => { const arr = [...productLines]; arr[idx] = { ...arr[idx], note: e.target.value }; setProductLines(arr); }}
                                placeholder="VD: Chiết xuất tự nhiên, best seller..."
                                className="bg-transparent border-0 text-xs text-gray-400 placeholder-gray-600 focus:outline-none py-1"/>
                              <button onClick={() => { if (productLines.length > 1) setProductLines(productLines.filter((_, i) => i !== idx)); }}
                                className="w-6 h-6 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-900/20 transition-colors text-[10px]"
                                title="Xóa dòng">✕</button>
                            </div>
                          ))}
                        </div>
                        {/* Add row button */}
                        <button onClick={() => setProductLines([...productLines, { name: '', price: '', note: '' }])}
                          className="w-full px-3 py-1.5 text-[10px] text-gray-500 hover:text-blue-400 hover:bg-gray-700/30 transition-colors border-t border-gray-700/30 flex items-center justify-center gap-1">
                          + Thêm sản phẩm
                        </button>
                      </div>
                      <p className="text-[9px] text-gray-600 mt-1">💡 Nhập tên + giá → AI sẽ biết chính xác sản phẩm để tư vấn. Không cần file hay POS.</p>
                    </div>

                    {/* Price + USP row */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1">Mức giá chung</label>
                        <textarea value={extraInfo.price} onChange={e => setExtraInfo({ ...extraInfo, price: e.target.value })}
                          rows={2}
                          placeholder="VD: Skincare: 199k-599k&#10;Combo tiết kiệm: 399k (2 sản phẩm)&#10;Freeship đơn từ 500k"
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y min-h-[56px]"/>
                      </div>
                      <div>
                        <label className="block text-[10px] text-gray-400 mb-1">Điểm khác biệt (USP)</label>
                        <textarea value={extraInfo.usp} onChange={e => setExtraInfo({ ...extraInfo, usp: e.target.value })}
                          rows={2}
                          placeholder="VD: Chiết xuất tự nhiên 100%&#10;Cam kết hoàn tiền nếu không hiệu quả&#10;Nhập khẩu chính hãng Hàn Quốc"
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y min-h-[56px]"/>
                      </div>
                    </div>

                    {/* Policy */}
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Chính sách (ship, đổi trả, bảo hành...)</label>
                      <textarea value={extraInfo.policy} onChange={e => setExtraInfo({ ...extraInfo, policy: e.target.value })}
                        rows={2}
                        placeholder="VD: Freeship đơn 500k, đổi trả 7 ngày&#10;Bảo hành 12 tháng&#10;COD toàn quốc"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y min-h-[56px]"/>
                    </div>

                    {/* Customer insight */}
                    <div>
                      <label className="block text-[10px] text-gray-400 mb-1">Insight khách hàng</label>
                      <textarea value={extraInfo.insight} onChange={e => setExtraInfo({ ...extraInfo, insight: e.target.value })}
                        rows={3}
                        placeholder="VD: Khách thường so sánh giá với hàng Trung Quốc, cần chứng minh chất lượng&#10;Phần lớn là nữ 25-35 tuổi, quan tâm thành phần&#10;Hay hỏi 'dùng bao lâu có kết quả?'"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y min-h-[72px]"/>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── Step 5: Result ─── */}
          {tab === 'create' && step === 5 && result && (
            <div className="p-5 space-y-4">
              {/* Prompt preview - editable */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-white">📄 Prompt đã tạo</h3>
                  <span className="text-[10px] text-gray-500">{editablePrompt.length} ký tự</span>
                </div>
                <textarea value={editablePrompt} onChange={e => setEditablePrompt(e.target.value)}
                  rows={10}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-xs text-gray-200 leading-relaxed focus:outline-none focus:border-blue-500 resize-y font-mono"/>
              </div>

              {/* Breakdown sections */}
              {(result.role || result.context || result.tone || result.rules || result.constraints) && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-400 mb-2">Phân tích chi tiết</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {result.role && (
                      <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
                        <p className="text-[10px] font-semibold text-blue-400 mb-1">🎯 Vai trò AI</p>
                        <p className="text-[10px] text-gray-400 leading-relaxed whitespace-pre-wrap">{result.role.replace(/^🎯\s*/, '').substring(0, 200)}</p>
                      </div>
                    )}
                    {result.context && (
                      <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
                        <p className="text-[10px] font-semibold text-green-400 mb-1">🧠 Context</p>
                        <p className="text-[10px] text-gray-400 leading-relaxed whitespace-pre-wrap">{result.context.replace(/^🧠\s*/, '').substring(0, 200)}</p>
                      </div>
                    )}
                    {result.tone && (
                      <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
                        <p className="text-[10px] font-semibold text-purple-400 mb-1">🗣️ Tone</p>
                        <p className="text-[10px] text-gray-400 leading-relaxed whitespace-pre-wrap">{result.tone.replace(/^🗣️\s*/, '').substring(0, 200)}</p>
                      </div>
                    )}
                    {result.constraints && (
                      <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
                        <p className="text-[10px] font-semibold text-red-400 mb-1">❌ Ràng buộc</p>
                        <p className="text-[10px] text-gray-400 leading-relaxed whitespace-pre-wrap">{result.constraints.replace(/^❌\s*/, '').substring(0, 200)}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Improve panel */}
              {showImprove && (
                <div className="bg-gray-800/60 rounded-xl p-4 border border-purple-600/30">
                  <h4 className="text-xs font-semibold text-purple-400 mb-2">✨ Cải thiện prompt</h4>
                  <p className="text-[10px] text-gray-500 mb-3">Chọn hướng cải thiện — AI sẽ viết lại prompt</p>
                  <div className="grid grid-cols-2 gap-2">
                    {IMPROVE_OPTIONS.map(opt => (
                      <button key={opt.key} onClick={() => handleImprove(opt.key)} disabled={improveLoading}
                        className="flex items-center gap-2 p-2 rounded-lg bg-gray-700/50 hover:bg-gray-700 border border-gray-600 hover:border-purple-500/50 transition-colors text-left disabled:opacity-50">
                        <span className="text-sm">{opt.icon}</span>
                        <span className="text-[10px] text-gray-300">{opt.label}</span>
                      </button>
                    ))}
                  </div>
                  {improveLoading && (
                    <div className="flex items-center gap-2 mt-3 text-[10px] text-purple-400">
                      <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                      Đang cải thiện prompt...
                    </div>
                  )}
                </div>
              )}

              {/* Chat refine panel */}
              {showChatRefine && (
                <div className="bg-gray-800/60 rounded-xl border border-blue-600/30 overflow-hidden">
                  <div className="px-4 py-2 border-b border-gray-700/50">
                    <h4 className="text-xs font-semibold text-blue-400">💬 Chỉnh sửa bằng hội thoại</h4>
                    <p className="text-[10px] text-gray-500">Chat với AI để tinh chỉnh prompt</p>
                  </div>
                  <div className="max-h-40 overflow-y-auto p-3 space-y-2">
                    {chatRefineHistory.length === 0 && (
                      <p className="text-[10px] text-gray-600 text-center py-2">VD: "Prompt này hơi cứng", "Thêm phần xử lý từ chối"</p>
                    )}
                    {chatRefineHistory.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] rounded-lg px-3 py-1.5 text-[10px] ${
                          msg.role === 'user' ? 'bg-blue-600/30 text-blue-200' : 'bg-gray-700 text-gray-300'
                        }`}>
                          <span className="whitespace-pre-wrap">{msg.content.substring(0, 500)}</span>
                        </div>
                      </div>
                    ))}
                    {chatRefineLoading && (
                      <div className="flex justify-start">
                        <div className="bg-gray-700 rounded-lg px-3 py-1.5 flex items-center gap-1">
                          <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}/>
                          <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}/>
                          <span className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}/>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="px-3 pb-3 flex items-center gap-2">
                    <input type="text" value={chatRefineInput} onChange={e => setChatRefineInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatRefineSend(); } }}
                      placeholder="Nhập yêu cầu chỉnh sửa..."
                      className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-[10px] text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"/>
                    <button onClick={handleChatRefineSend} disabled={chatRefineLoading || !chatRefineInput.trim()}
                      className="w-7 h-7 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center text-white transition-colors flex-shrink-0">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── Library tab ─── */}
          {tab === 'library' && !previewTemplate && (
            <div className="p-5">
              <p className="text-[10px] text-gray-500 mb-3">Chọn template có sẵn — preview → áp dụng ngay</p>
              <div className="grid grid-cols-2 gap-2">
                {PROMPT_TEMPLATES.map(tpl => (
                  <button key={tpl.id} onClick={() => setPreviewTemplate(tpl)}
                    className="p-3 rounded-xl bg-gray-800/60 border border-gray-700 hover:border-blue-500/50 hover:bg-gray-800 transition-all text-left">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-lg">{tpl.icon}</span>
                      <span className="text-xs font-medium text-white">{tpl.label}</span>
                    </div>
                    <p className="text-[10px] text-gray-500">{tpl.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Library preview */}
          {tab === 'library' && previewTemplate && (
            <div className="p-5 space-y-3">
              <button onClick={() => setPreviewTemplate(null)} className="text-[10px] text-gray-500 hover:text-white transition-colors flex items-center gap-1">
                ← Quay lại thư viện
              </button>
              <div className="flex items-center gap-2">
                <span className="text-xl">{previewTemplate.icon}</span>
                <div>
                  <h3 className="text-sm font-semibold text-white">{previewTemplate.label}</h3>
                  <p className="text-[10px] text-gray-500">{previewTemplate.desc}</p>
                </div>
              </div>
              <div className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
                <pre className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap font-sans">{previewTemplate.prompt}</pre>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { onApply(previewTemplate.prompt); showNotification('✅ Đã áp dụng template!', 'success'); onClose(); }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors">
                  ✅ Áp dụng
                </button>
                <button onClick={() => { navigator.clipboard.writeText(previewTemplate.prompt); showNotification('📋 Đã copy!', 'success'); }}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded-lg transition-colors">
                  📋 Copy
                </button>
                <button onClick={() => {
                  setEditablePrompt(previewTemplate.prompt);
                  setResult(parsePromptResult(previewTemplate.prompt));
                  setTab('create');
                  setStep(5);
                }}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded-lg transition-colors">
                  ✏️ Chỉnh sửa
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ─ Footer ─ */}
        <div className="px-5 py-3 border-t border-gray-700 flex items-center gap-2 flex-shrink-0">
          {tab === 'create' && step < 5 && (
            <>
              {step > 1 && (
                <button onClick={() => setStep((step - 1) as WizardStep)}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">
                  ← Quay lại
                </button>
              )}
              <div className="flex-1"/>
              <span className="text-[10px] text-gray-600">Bước {step}/4</span>
              {step < 4 && (
                <button onClick={() => setStep((step + 1) as WizardStep)}
                  disabled={step === 1 && !selectedIndustry}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50">
                  Tiếp theo →
                </button>
              )}
              {step === 4 && (
                <button onClick={handleGenerate} disabled={generating || !assistantId}
                  className="px-4 py-1.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white text-xs font-medium rounded-lg transition-all disabled:opacity-50">
                  {generating ? '⏳ Đang tạo...' : '✨ Tạo prompt'}
                </button>
              )}
            </>
          )}

          {tab === 'create' && step === 5 && result && (
            <>
              <button onClick={resetWizard} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">
                🔄 Làm lại từ đầu
              </button>
              <div className="flex-1"/>
              <button onClick={() => setShowChatRefine(!showChatRefine)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${showChatRefine ? 'bg-blue-600/20 text-blue-400 border-blue-600/40' : 'text-gray-400 hover:text-white border-gray-600'}`}>
                💬 Chat chỉnh sửa
              </button>
              <button onClick={() => setShowImprove(!showImprove)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${showImprove ? 'bg-purple-600/20 text-purple-400 border-purple-600/40' : 'text-gray-400 hover:text-white border-gray-600'}`}>
                ✨ Cải thiện
              </button>
              <button onClick={handleRegenerate} disabled={generating}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-600 rounded-lg transition-colors disabled:opacity-50">
                {generating ? '⏳' : '🔄'} Tạo lại
              </button>
              <button onClick={handleCopy} className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors">
                📋 Copy
              </button>
              <button onClick={handleApply}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors">
                ✅ Áp dụng
              </button>
            </>
          )}

          {tab === 'library' && !previewTemplate && (
            <div className="flex-1 text-center text-[10px] text-gray-600">{PROMPT_TEMPLATES.length} templates có sẵn</div>
          )}
        </div>
      </div>
    </div>
  );
}

