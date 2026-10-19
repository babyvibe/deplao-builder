import React, { useRef } from 'react';
import ipc from '@/lib/ipc';
import {
  AlertIcon, BotIcon, ChartIcon, ChatIcon, CheckIcon, ClipboardListIcon, FileTextIcon, LightningIcon, RocketIcon,
  SparklesIcon, SunIcon, TargetIcon, TerminalIcon, WrenchIcon,
} from '@/components/common/icons';
import { Badge, BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

const NINE_ROUTER_DASHBOARD_URL = 'http://localhost:20128';
const NINE_ROUTER_ISSUE_URL = 'https://github.com/babyvibe/deplao-builder/issues/31';

/**
 * Mở trang khác của app giống bảng "Tất cả tính năng": đổi view rồi báo trang đích mở đúng tab.
 * Trang đích chỉ được tải khi mở lần đầu nên sự kiện chọn tab được gửi thêm một lần cho chắc.
 */
function openAppPage(view: string, eventName: string, detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view } }));
  [80, 600].forEach(delay => {
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(eventName, { detail })), delay);
  });
}

/** Công cụ → Tích hợp → tab "Trợ lý AI" (danh sách trợ lý, nút "+ Tạo trợ lý"). */
const openAIAssistantPage = () => openAppPage('integration', 'nav:integration', { tab: 'ai' });

const FEATURES: { icon: React.ReactNode; name: string; desc: string }[] = [
  { icon: <SparklesIcon className="w-4 h-4 inline" />, name: 'Gợi ý trả lời', desc: 'Đọc các tin gần nhất của hội thoại và gợi ý tối đa 5 câu trả lời ngay trên ô soạn tin.' },
  { icon: <ChatIcon className="w-4 h-4 inline" />, name: 'Hỏi AI trong hội thoại', desc: 'Panel Trợ lý AI cạnh khung chat: hỏi đáp, tóm tắt hội thoại, chèn câu trả lời vào ô chat.' },
  { icon: <LightningIcon className="w-4 h-4 inline" />, name: 'Thiết kế workflow', desc: 'Mô tả nhu cầu bằng tiếng Việt, AI copilot dựng sơ đồ workflow giúp bạn.' },
  { icon: <BotIcon className="w-4 h-4 inline" />, name: 'Chatbot 24/7', desc: 'Node AI trong workflow tự trả lời hoặc phân loại tin nhắn của khách.' },
  { icon: <FileTextIcon className="w-4 h-4 inline" />, name: 'Kiến thức & sản phẩm', desc: 'Nạp File kiến thức, ghim sản phẩm từ POS để AI tư vấn đúng thông tin của shop.' },
  { icon: <ChartIcon className="w-4 h-4 inline" />, name: 'Báo cáo sử dụng', desc: 'Số request và token theo ngày của từng trợ lý; tổng hợp ở Báo cáo → AI.' },
];

/** Một bước trong hướng dẫn cài 9Router. */
function SetupStep({ n, title, tag, done, children }: {
  n: number;
  title: string;
  tag?: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border/60 rounded-xl p-3.5 flex items-start gap-3.5 hover:border-primary/40 transition-colors">
      <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center text-primary font-bold text-sm flex-shrink-0">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-foreground text-xs font-semibold">{title}</span>
          {tag && <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{tag}</span>}
          {done && (
            <span className="text-[10px] text-success bg-success/15 px-1.5 py-0.5 rounded-full inline-flex items-center gap-0.5">
              <CheckIcon className="w-3 h-3" /> xong
            </span>
          )}
        </div>
        <div className="text-muted-foreground text-[11px] leading-relaxed space-y-1.5">{children}</div>
      </div>
    </div>
  );
}

function CommandBox({ command }: { command: string }) {
  return (
    <div className="bg-muted rounded-lg px-3 py-2 border border-border/60">
      <code className="text-foreground text-xs font-mono select-all">{command}</code>
    </div>
  );
}

export function AIAssistantPanel() {
  const nineRouterRef = useRef<HTMLDivElement>(null);

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><BotIcon className="w-4 h-4 inline" /> Trợ lý AI - AI hỗ trợ chat và tự động hoá</SectionTitle>
        <Paragraph>
          Tạo một hoặc nhiều trợ lý AI, mỗi trợ lý có nền tảng, model, API key và <strong className="text-foreground font-semibold">System
          Prompt</strong> (vai trò, phong cách trả lời) riêng. Trợ lý được dùng để gợi ý câu trả lời khi chat, hỏi đáp AI ngay trong hội
          thoại, thiết kế workflow bằng câu lệnh tiếng Việt và trả lời khách tự động 24/7 trong workflow.
        </Paragraph>
        <div className="flex items-start gap-2.5 bg-primary/10 border border-primary/30 rounded-lg px-3 py-2">
          <SparklesIcon className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
          <p className="text-foreground text-xs leading-relaxed">
            Nền tảng hỗ trợ: <strong>OpenAI, Google Gemini, Anthropic Claude, DeepSeek, Grok (xAI), Mistral AI</strong> và các cổng trung
            gian <strong>9Router</strong> (chạy trên máy bạn, có model miễn phí), <strong>OpenRouter</strong> (một API key dùng nhiều model).
          </p>
        </div>
        <button
          type="button"
          onClick={() => nineRouterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className="text-primary hover:underline text-xs font-medium"
        >
          Dùng AI miễn phí với 9Router - xem hướng dẫn ↓
        </button>
      </Card>

      <Card>
        <SectionTitle><ClipboardListIcon className="w-4 h-4 inline" /> Trợ lý AI làm được gì?</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {FEATURES.map(f => (
            <div key={f.name} className="bg-muted rounded-lg p-2.5">
              <p className="text-foreground text-[11px] font-medium">{f.icon} {f.name}</p>
              <p className="text-muted-foreground text-[11px] mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle><WrenchIcon className="w-4 h-4 inline" /> Tạo trợ lý AI</SectionTitle>
        <StepList steps={[
          {
            title: 'Mở trang Trợ lý AI',
            desc: 'Thanh bên <strong class="text-foreground">Công cụ → Tích hợp</strong> → tab <strong class="text-foreground">Trợ lý AI</strong> → <strong class="text-foreground">+ Tạo trợ lý</strong>.',
          },
          {
            title: 'Chọn nền tảng, model và nhập API Key',
            desc: 'Nhập <strong class="text-foreground">Tên trợ lý</strong>, chọn <strong class="text-foreground">Nền tảng AI</strong> rồi chọn lại <strong class="text-foreground">Model</strong> trong danh sách của nền tảng đó, dán <strong class="text-foreground">API Key</strong> (dòng gợi ý dưới ô cho biết lấy key ở đâu). Key được lưu trên máy bạn và mã hoá khi hệ điều hành hỗ trợ.',
          },
          {
            title: 'Viết System Prompt',
            desc: 'Mô tả vai trò, phong cách và quy tắc trả lời (VD: nhân viên tư vấn của shop, trả lời ngắn gọn, thân thiện). Chưa quen viết prompt? Sau khi tạo trợ lý, bấm <strong class="text-foreground">Gợi ý bằng AI</strong> (chọn ngành, mục tiêu, giọng điệu) hoặc <strong class="text-foreground">Cải thiện prompt</strong>.',
          },
          {
            title: 'Tạo và kiểm tra',
            desc: 'Bấm <strong class="text-foreground">Tạo trợ lý</strong> → <strong class="text-foreground">Test kết nối</strong>, rồi trò chuyện thử ở khung <strong class="text-foreground">Chat thử</strong> bên phải. Sửa xong bấm <strong class="text-foreground">Cập nhật</strong>.',
          },
          {
            title: 'Nạp thêm dữ liệu (tuỳ chọn)',
            desc: '<strong class="text-foreground">Liên kết POS</strong>: chọn POS đã kết nối ở Tích hợp, tìm và ghim sản phẩm để AI biết tên, giá, mã, ảnh. <strong class="text-foreground">File kiến thức</strong>: TXT, MD, CSV, JSON, HTML, XML, YAML, LOG - app chỉ lấy phần chữ (khoảng 100 KB mỗi file) đưa vào lời dặn cho AI, không gửi file gốc.',
          },
          {
            title: 'Cài đặt nâng cao',
            desc: 'Temperature (chính xác ↔ sáng tạo), Max tokens (độ dài trả lời), <strong class="text-foreground">Số tin nhắn lịch sử (ngữ cảnh)</strong> (mặc định 30), <strong class="text-foreground">Base URL (tuỳ chọn)</strong> khi dùng proxy / gateway, <strong class="text-foreground">Đặt làm trợ lý mặc định</strong> - dùng khi tài khoản chưa được gán trợ lý riêng.',
          },
        ]} />
        <button
          type="button"
          onClick={openAIAssistantPage}
          className="text-primary hover:underline text-xs font-medium"
        >
          Mở trang Trợ lý AI →
        </button>
      </Card>

      <Card>
        <SectionTitle><ChatIcon className="w-4 h-4 inline" /> Dùng AI khi chat</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Gợi ý AI</strong>: nút <strong class="text-foreground">Gợi ý AI</strong> (biểu tượng robot) trên thanh công cụ ô soạn tin có các tuỳ chọn <strong class="text-foreground">Bật gợi ý AI (toàn bộ)</strong>, <strong class="text-foreground">Tắt ở hội thoại này</strong>, <strong class="text-foreground">Tắt toàn bộ tài khoản này</strong>. Khi mở hội thoại và khi khách nhắn tin mới (Zalo, Telegram), thanh <strong class="text-foreground">Gợi ý AI</strong> hiện các câu gợi ý - bấm một câu để đưa vào ô soạn tin, sửa nếu cần rồi tự bấm gửi (AI không tự gửi).',
          '<strong class="text-foreground">Panel Trợ lý AI</strong>: bấm biểu tượng robot <strong class="text-foreground">Trợ lý AI</strong> trên đầu khung chat (hoặc <strong class="text-foreground">Ctrl+S</strong>, macOS: Cmd+S). Chọn trợ lý rồi hỏi bất kỳ điều gì; khi <strong class="text-foreground">Ngữ cảnh bật</strong>, AI đọc kèm các tin gần nhất của hội thoại (<strong class="text-foreground">Số ngữ cảnh</strong> tối đa 1000 tin). Nút <strong class="text-foreground">Tóm tắt</strong> tóm tắt hội thoại; mỗi câu trả lời có <strong class="text-foreground">Chèn vào chat</strong> và <strong class="text-foreground">Copy</strong>. App nhớ trợ lý đã chọn và lịch sử hỏi đáp theo từng hội thoại.',
          '<strong class="text-foreground">Gán theo tài khoản</strong> (trên trang Trợ lý AI): chọn trợ lý dùng cho <strong class="text-foreground">Gợi ý tin nhắn</strong> của từng tài khoản; để <strong class="text-foreground">Mặc định</strong> thì dùng trợ lý mặc định (chưa đặt thì lấy một trợ lý đang bật).',
        ]} />
      </Card>

      <Card>
        <SectionTitle><LightningIcon className="w-4 h-4 inline" /> AI trong Workflow</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">AI copilot</strong>: trong trình sửa workflow bấm nút <strong class="text-foreground">AI</strong> → <strong class="text-foreground">Trợ lý thiết kế workflow</strong>. Mô tả nhu cầu bằng tiếng Việt, AI hỏi lại chỗ chưa rõ rồi đề xuất sơ đồ có xem trước; bạn chọn áp dụng vào kịch bản và có <strong class="text-foreground">Hoàn tác AI</strong>. Nên chọn trợ lý dùng model mạnh.',
          '<strong class="text-foreground">Node AI</strong>: <strong class="text-foreground">Tạo nội dung bằng AI</strong> (sinh câu trả lời, tóm tắt, viết nội dung) và <strong class="text-foreground">Phân loại văn bản bằng AI</strong> (xếp tin vào danh mục như hỏi giá, đặt hàng, khiếu nại). Ở <strong class="text-foreground">Cách cấu hình AI</strong>, chọn <strong class="text-foreground">Chọn trợ lý AI đã tạo</strong> để dùng prompt, File kiến thức và sản phẩm đã ghim của trợ lý; trợ lý 9Router chỉ dùng được theo cách này.',
          '<strong class="text-foreground">Chatbot trả lời 24/7</strong>: Khi nhận tin nhắn → Tạo nội dung bằng AI → Gửi tin nhắn. Bật <strong class="text-foreground">Gom tin nhắn liên tiếp</strong> 10-15 giây để AI trả lời một lần sau khi khách gõ xong. Kho mẫu có sẵn <strong class="text-foreground">AI tư vấn bán hàng tự động</strong>. Chi tiết xem mục <strong class="text-foreground">Workflow tự động</strong>.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><AlertIcon className="w-4 h-4 inline" /> Lưu ý khi dùng AI</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Chi phí</strong>: mỗi lần gợi ý, hỏi đáp hay node AI chạy là một lần gọi AI, tính theo bảng giá của nhà cung cấp (trừ model miễn phí). Tính năng Gợi ý AI gửi yêu cầu tới AI khi mở hội thoại và khi khách nhắn tin mới - hãy tắt ở hội thoại / tài khoản không cần. Xem token đã dùng ở nút <strong class="text-foreground">Báo cáo</strong> của từng trợ lý hoặc <strong class="text-foreground">Báo cáo → AI</strong>.',
          '<strong class="text-foreground">Dữ liệu gửi đi</strong>: nội dung hội thoại dùng làm ngữ cảnh, System Prompt, phần chữ của File kiến thức và sản phẩm đã ghim được gửi tới nền tảng AI bạn chọn. Không đưa thông tin nhạy cảm vào prompt.',
          '<strong class="text-foreground">Kiểm tra câu trả lời</strong>: AI có thể trả lời sai. Đọc lại gợi ý trước khi gửi; chatbot tự động nên thử bằng <strong class="text-foreground">Mô phỏng</strong> (chế độ này không gọi AI thật, chỉ trả câu mẫu) rồi <strong class="text-foreground">Chạy thử</strong> với một hội thoại nội bộ.',
          'Trợ lý đang tắt (công tắc <strong class="text-foreground">Kích hoạt</strong> ở trang trợ lý) không được dùng cho gợi ý, panel chat hay workflow.',
          'Model cũ đã ngừng hỗ trợ được tự chuyển sang model tương đương hiện hành, không cần cấu hình lại.',
          'Nhân viên dùng các trợ lý do Boss tạo; yêu cầu AI từ máy nhân viên được chạy qua máy Boss.',
        ]} />
      </Card>

      {/* ─── 9Router: dùng AI miễn phí qua cổng trung gian chạy trên máy ───────── */}
      <div ref={nineRouterRef} className="border-t border-border/50 pt-4 space-y-4">
        <div className="flex items-start gap-3">
          <span className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/30 text-primary flex items-center justify-center flex-shrink-0">
            <RocketIcon className="w-4 h-4" />
          </span>
          <div>
            <h3 className="text-foreground font-bold text-base">9Router - dùng AI miễn phí ngay trên máy bạn</h3>
            <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">
              9Router là cổng trung gian (proxy) AI chạy trên máy của bạn tại <strong className="text-foreground">http://localhost:20128</strong>:
              gom nhiều nhà cung cấp AI về một địa chỉ, trong đó có nhiều model miễn phí. Deplao kết nối tới 9Router qua nền
              tảng <strong className="text-foreground">9Router Proxy</strong> của trợ lý AI.
            </p>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <Badge text="Có model FREE" color="bg-success/15 text-success" />
              <Badge text="Chạy trên máy bạn" color="bg-primary/15 text-primary" />
              <Badge text="Nhiều nhà cung cấp" color="bg-info/15 text-info" />
            </div>
          </div>
        </div>

        <Card>
          <SectionTitle><TargetIcon className="w-4 h-4 inline" /> Vì sao dùng 9Router với Deplao?</SectionTitle>
          <BulletList items={[
            '<strong class="text-foreground">Model miễn phí</strong>: danh sách model của 9Router trong Deplao có nhiều model gắn nhãn (free), VD <strong class="text-foreground">Kiro: Claude 4.5 Sonnet (free)</strong>, <strong class="text-foreground">OpenCode: DeepSeek V4 Flash (free)</strong>.',
            '<strong class="text-foreground">Dùng cho mọi tính năng AI</strong>: gợi ý trả lời trong hội thoại, hỏi đáp với AI trong hội thoại, AI tạo workflow bằng câu lệnh, node AI trả lời khách 24/7.',
            '<strong class="text-foreground">Một địa chỉ cho nhiều nhà cung cấp</strong>: kết nối nhà cung cấp trong Dashboard 9Router, phía Deplao chỉ cần một trợ lý trỏ tới 9Router.',
            '<strong class="text-foreground">Tự nhập model</strong>: model chưa có trong danh sách thì chọn <strong class="text-foreground">Custom model - tự nhập...</strong> rồi gõ đúng tên model.',
          ]} />
        </Card>

        <Card>
          <SectionTitle><TerminalIcon className="w-4 h-4 inline" /> Các bước cài 9Router FREE</SectionTitle>
          <div className="space-y-3">
            <SetupStep n={1} title="Mở Terminal" tag="CMD / PowerShell">
              <p>
                Windows: nhấn <strong className="text-foreground">Win + R</strong> → gõ <strong className="text-foreground">cmd</strong> → Enter,
                hoặc chuột phải nút Start → <strong className="text-foreground">Terminal</strong>. macOS / Linux: mở ứng
                dụng <strong className="text-foreground">Terminal</strong>.
              </p>
            </SetupStep>

            <SetupStep n={2} title="Cài đặt 9Router" tag="npm">
              <p>
                Máy cần có Node.js (đi kèm lệnh npm). Copy dòng sau vào Terminal rồi nhấn <strong className="text-foreground">Enter</strong>:
              </p>
              <CommandBox command="npm install -g 9router" />
              <p>Đợi đến khi Terminal báo cài xong (dòng <code className="font-mono">added ... packages</code>).</p>
            </SetupStep>

            <SetupStep n={3} title="Chạy 9Router" tag="mỗi lần dùng">
              <p>Gõ lệnh sau rồi nhấn <strong className="text-foreground">Enter</strong>, giữ cửa sổ Terminal mở trong lúc dùng AI:</p>
              <CommandBox command="9router" />
              <p>
                Lần đầu chạy có thể hơi lâu - đợi đến khi Terminal báo Dashboard đã chạy
                tại <strong className="text-foreground">http://localhost:20128</strong>.
              </p>
            </SetupStep>

            <SetupStep n={4} title="Lấy API key trong Dashboard 9Router" tag="localhost:20128">
              <p>
                Mở <strong className="text-foreground">http://localhost:20128</strong> (nút <strong className="text-foreground">Mở Dashboard
                9Router</strong> ở cuối trang), kết nối nhà cung cấp / model muốn dùng và lấy key ở mục <strong className="text-foreground">API
                Keys</strong>.
              </p>
            </SetupStep>

            <SetupStep n={5} title="Cấu hình trong Deplao" done>
              <p>
                Tạo trợ lý với nền tảng <strong className="text-foreground">9Router Proxy</strong>, chọn model (free), dán API key → <strong className="text-foreground">Tạo
                trợ lý</strong> → <strong className="text-foreground">Test kết nối</strong>. Chi tiết từng ô ở mục bên dưới.
              </p>
            </SetupStep>
          </div>

          <div className="bg-primary/10 border border-primary/30 rounded-lg px-3.5 py-2.5">
            <div className="flex items-start gap-2.5">
              <SunIcon className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-foreground text-[11px] font-semibold">Danh sách model 9Router là danh sách có sẵn trong Deplao</p>
                <p className="text-muted-foreground text-[11px] leading-relaxed mt-0.5">
                  Danh sách này chưa tự đồng bộ theo Dashboard 9Router. Model mới hoặc model không có trong danh sách: chọn <strong className="text-foreground">Custom
                  model - tự nhập...</strong> rồi gõ đúng tên model như trong Dashboard. Gặp lỗi kết nối 9Router?{' '}
                  <button
                    type="button"
                    onClick={() => ipc.shell?.openExternal(NINE_ROUTER_ISSUE_URL)}
                    className="text-primary hover:underline underline-offset-2 inline-flex items-center gap-0.5"
                  >
                    Xem issue #31 →
                  </button>
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle><WrenchIcon className="w-4 h-4 inline" /> Cấu hình trợ lý 9Router trong Deplao</SectionTitle>
          <Paragraph>
            Khi 9Router đang chạy, vào <strong className="text-foreground font-semibold">Công cụ → Tích hợp</strong> → tab <strong className="text-foreground font-semibold">Trợ
            lý AI</strong> → <strong className="text-foreground font-semibold">+ Tạo trợ lý</strong> và điền:
          </Paragraph>
          <BulletList items={[
            '<strong class="text-foreground">Nền tảng AI</strong>: chọn <strong class="text-foreground">9Router Proxy</strong>.',
            '<strong class="text-foreground">Model</strong>: chọn lại model trong danh sách của 9Router (ô Model có thể còn giữ model của nền tảng trước), VD <strong class="text-foreground">Kiro: Claude 4.5 Sonnet (free)</strong> hoặc <strong class="text-foreground">OpenCode: DeepSeek V4 Flash (free)</strong>; model khác chọn <strong class="text-foreground">Custom model - tự nhập...</strong> rồi gõ tên model.',
            '<strong class="text-foreground">API Key</strong>: dán key lấy ở Dashboard 9Router → <strong class="text-foreground">API Keys</strong> (ô này không được để trống). Khi chọn nền tảng 9Router, ngay dưới ô có nút <strong class="text-foreground">Mở Dashboard 9Router</strong>.',
            '<strong class="text-foreground">Base URL (tuỳ chọn)</strong> trong <strong class="text-foreground">Cài đặt nâng cao</strong>: để trống - Deplao tự gọi 9Router tại http://localhost:20128. Chỉ điền khi 9Router chạy ở địa chỉ hoặc cổng khác.',
            'Bấm <strong class="text-foreground">Tạo trợ lý</strong> → <strong class="text-foreground">Test kết nối</strong>. Muốn gợi ý chat dùng luôn trợ lý này, bật <strong class="text-foreground">Đặt làm trợ lý mặc định</strong> hoặc gán ở <strong class="text-foreground">Gán theo tài khoản</strong>.',
          ]} />
        </Card>

        <Card>
          <SectionTitle><SunIcon className="w-4 h-4 inline" /> Mẹo &amp; xử lý lỗi</SectionTitle>
          <BulletList items={[
            '<strong class="text-foreground">9Router phải đang chạy</strong> thì trợ lý 9Router mới trả lời - đóng cửa sổ Terminal là gợi ý, panel chat và node AI dùng trợ lý này không trả lời được nữa.',
            'Muốn khỏi mở tay mỗi lần bật máy: thêm lệnh <strong class="text-foreground">9router</strong> vào chương trình tự khởi động (VD Task Scheduler trên Windows).',
            'Báo lỗi khi Test kết nối: kiểm tra 9Router còn chạy, tên model gõ đúng và model đó đã dùng được trong Dashboard 9Router.',
            'Dashboard 9Router mặc định ở <strong class="text-foreground">http://localhost:20128</strong> khi 9Router đang chạy.',
          ]} />
        </Card>

        <div className="flex justify-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={openAIAssistantPage}
            className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-xs font-medium rounded-lg transition-colors"
          >
            Mở trang Trợ lý AI →
          </button>
          <button
            type="button"
            onClick={() => ipc.shell?.openExternal(NINE_ROUTER_DASHBOARD_URL)}
            className="px-4 py-2 bg-muted hover:bg-accent text-foreground text-xs font-medium rounded-lg transition-colors"
          >
            Mở Dashboard 9Router
          </button>
        </div>
      </div>
    </div>
  );
}
