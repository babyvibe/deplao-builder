/**
 * Giới thiệu & Hướng dẫn → "Ứng dụng, API & Webhook": hướng dẫn trang Công cụ → Ứng dụng, API & Webhook (Public API v1,
 * API key, nhật ký, sự kiện realtime, webhook nhận vào / gửi ra, Ứng dụng + SDK / CLI). Câu chữ bám giao diện ở
 * src/ui/components/plugins/** và src/ui/components/settings/api/**. Trong giao diện luôn gọi là "Ứng dụng".
 */
import React from 'react';
import {
  ActivityIcon,
  AlertIcon,
  GlobeIcon,
  InfoIcon,
  KeyIcon,
  PackageIcon,
  PluginIcon,
  ServerIcon,
  ShieldIcon,
  TerminalIcon,
  WebhookIcon,
  WrenchIcon,
} from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

// ─── Mảnh HTML cho BulletList / StepList (chuỗi HTML — dùng class, không dùng className) ──────

const CODE_CLASS = 'rounded border border-border px-1 font-mono text-[11px] text-foreground';
const bold = (html: string) => `<strong class="text-foreground">${html}</strong>`;
const mono = (html: string) => `<code class="${CODE_CLASS}">${html}</code>`;

// ─── Mảnh giao diện riêng của trang này ──────────────────────────────────────────────────────

function SubTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-foreground/80 text-xs font-semibold pt-1">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className={CODE_CLASS}>{children}</code>;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre rounded-lg border border-border bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

function Callout({ tone = 'info', children }: { tone?: 'info' | 'warning'; children: React.ReactNode }) {
  const box = tone === 'info' ? 'border-info/30 bg-info/10' : 'border-warning/40 bg-warning/10';
  const Icon = tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${box}`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tone === 'info' ? 'text-info' : 'text-warning'}`} />
      <div className="min-w-0 space-y-1 text-xs leading-relaxed text-foreground/90">{children}</div>
    </div>
  );
}

/** Ô nền muted: tên + nhãn phụ + mô tả (HTML). */
function InfoTile({ title, meta, desc }: { title: string; meta?: string; desc: string }) {
  return (
    <div className="bg-muted rounded-lg p-3 space-y-1">
      <p className="flex flex-wrap items-center gap-1.5 text-foreground text-xs font-semibold">
        {title}
        {meta && <span className="text-muted-foreground text-[11px] font-normal">{meta}</span>}
      </p>
      <p className="text-muted-foreground text-[11px] leading-relaxed" dangerouslySetInnerHTML={{ __html: desc }} />
    </div>
  );
}

// ─── Nội dung ────────────────────────────────────────────────────────────────────────────────

const CURL_EXAMPLE = 'curl -H "Authorization: Bearer dpk_xxx" http://127.0.0.1:9900/api/v1/accounts';

const CLI_EXAMPLE = [
  'node packages/plugin-cli/bin/deplao-plugin.js create my-app --runtime web',
  'node packages/plugin-cli/bin/deplao-plugin.js validate my-app',
  'node packages/plugin-cli/bin/deplao-plugin.js pack my-app --out my-app.zip',
].join('\n');

const PLUGIN_PLACES: Array<{ title: string; desc: string }> = [
  { title: 'Trang riêng', desc: 'Mở bằng nút Mở trên ô ứng dụng, hoặc từ bảng Tất cả tính năng.' },
  { title: 'Panel trong màn chat', desc: 'Bấm biểu tượng ứng dụng trên thanh tiêu đề hội thoại.' },
  { title: 'Nút trong ô soạn tin', desc: 'Thêm nút thao tác ngay ở ô soạn tin của khung chat.' },
  { title: 'Cài đặt riêng', desc: 'Bấm vào ô ứng dụng → tab Cài đặt; ô bí mật được lưu mã hoá.' },
  { title: 'Node workflow', desc: 'Kéo vào kịch bản trong trang Workflow.' },
  { title: 'Chạy định kỳ', desc: 'Việc chạy nền theo lịch do ứng dụng đặt.' },
];

export function AppsApiPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><PluginIcon className="w-4 h-4 inline" /> Ứng dụng, API &amp; Webhook</SectionTitle>
        <Paragraph>
          Một trang gom mọi cách mở Deplao ra bên ngoài: cài thêm Ứng dụng chạy ngay trong Deplao; cho website, phần mềm bán
          hàng, n8n… đọc dữ liệu và gửi tin qua API; nhận và gửi dữ liệu bằng webhook.
        </Paragraph>
        <BulletList items={[
          `${bold('Ở đâu:')} thanh điều hướng bên trái → ${bold('Công cụ')} → ${bold('Ứng dụng, API &amp; Webhook')} (hoặc tìm trong bảng Tất cả tính năng). Chỉ có trên máy chủ; máy nhân viên không chạy API.`,
          `Ba thẻ: ${bold('Ứng dụng')} (cài, mở, quản lý ứng dụng) · ${bold('API')} (server, API key, nhật ký, nâng cao) · ${bold('Webhook')} (nhận dữ liệu vào, gửi sự kiện ra ngoài).`,
          `Nút ${bold('Tài liệu API')} và ${bold('Tài liệu phát triển ứng dụng')} ở đầu trang mở tài liệu trong trình duyệt (API server tự bật nếu đang tắt).`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><KeyIcon className="w-4 h-4 inline" /> Public API v1</SectionTitle>
        <Paragraph>
          API là &quot;cửa&quot; để phần mềm khác làm việc với Deplao như một người dùng: đọc hội thoại, gửi tin, cập nhật khách
          hàng, chạy workflow… Mỗi hệ thống dùng một <strong className="text-foreground">API key</strong> riêng — giống mật
          khẩu, kèm danh sách <strong className="text-foreground">quyền (scope)</strong> cho biết key được làm gì.
        </Paragraph>
        <BulletList items={[
          `${bold('Gần 300 thao tác:')} tài khoản, chat Zalo / Facebook / Telegram, nhóm, nhãn, danh bạ, CRM, workflow, tích hợp, ERP, AI, báo cáo, media, nhân viên.`,
          `${bold('Chạy ngay trên máy cài Deplao')}, cổng mặc định ${mono('9900')} (chung server với kết nối nhân viên). ${bold('Mặc định tắt')} cho tới khi bạn bật; mọi lời gọi đều cần API key do bạn tạo.`,
          `${bold('Đi đúng luồng của app:')} tin gửi bằng API vẫn hiện trong khung chat, được lưu và kích hoạt workflow như khi bạn tự gửi.`,
          `Gửi key trong header ${mono('Authorization: Bearer dpk_…')} (hoặc ${mono('X-Api-Key')}).`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><ServerIcon className="w-4 h-4 inline" /> Bật API và tạo API key</SectionTitle>
        <StepList steps={[
          {
            title: 'Bật server',
            desc: `Thẻ ${bold('API')} → tab ${bold('Tổng quan')} → mục API server → ${bold('Bật server')}. Máy chạy bot / worker 24/7 thì bật thêm "Tự bật server khi mở app".`,
          },
          {
            title: 'Tạo API key',
            desc: `Tab ${bold('API key')} → ${bold('Tạo API key')}: đặt tên (vd Website, n8n), chọn ${bold('Quyền')} (mẫu nhanh Chỉ đọc · Chat bot · Đồng bộ CRM · Toàn quyền, hoặc tick từng quyền), ${bold('Tài khoản được dùng')}, ${bold('IP được phép')} (IP hoặc dải CIDR, để trống = mọi IP), ${bold('Hết hạn')} (30 ngày, 90 ngày, 1 năm hoặc không hết hạn). Tuỳ chọn: giới hạn request/phút (0 = không giới hạn), vai trò ERP, ghi chú.`,
          },
          {
            title: 'Sao chép key ngay',
            desc: `Key dạng ${mono('dpk_…')} ${bold('chỉ hiện một lần')} — sao chép và cất ở nơi an toàn. Lỡ mất key thì thu hồi và tạo key mới.`,
          },
          {
            title: 'Gọi thử',
            desc: 'Chạy lệnh bên dưới (thay dpk_xxx bằng key của bạn); nhận về danh sách tài khoản là key đã dùng được.',
          },
          {
            title: 'Xem tài liệu',
            desc: `Bấm ${bold('Mở tài liệu API')}: trang ${mono('http://127.0.0.1:9900/docs')} có hướng dẫn, danh sách endpoint, nút thử gọi và lệnh curl. File ${mono('/api/v1/openapi.json')} nhập thẳng vào Postman / Insomnia hoặc dùng để sinh SDK.`,
          },
        ]} />
        <CodeBlock>{CURL_EXAMPLE}</CodeBlock>
      </Card>

      <Card>
        <SectionTitle><GlobeIcon className="w-4 h-4 inline" /> Gọi API từ đâu?</SectionTitle>
        <BulletList items={[
          `${bold('Trên máy này:')} ${mono('http://127.0.0.1:9900/api/v1')}`,
          `${bold('Trong mạng LAN:')} ${mono('http://&lt;IP máy chủ&gt;:9900/api/v1')} — tab Tổng quan hiện sẵn địa chỉ để sao chép.`,
          `${bold('Từ Internet')} (server, n8n, Make… ở ngoài): bật dịch vụ ${bold('Nhân viên và API')} ở ${bold('Cài đặt → Internet &amp; Đám mây → Địa chỉ Internet')}, rồi gọi ${mono('&lt;địa chỉ&gt;/api/v1')}. Mục "Truy cập từ xa" ở tab Tổng quan chỉ hiện địa chỉ này để sao chép; đây cũng là địa chỉ nhân viên làm việc từ xa dùng.`,
          'Địa chỉ tạm đổi mỗi lần khởi động lại; hệ thống chạy lâu dài nên dùng địa chỉ cố định (Cloudflare tự động).',
        ]} />
        <Callout>
          API và webhook chạy trong Deplao trên máy chủ: tắt Deplao hoặc tắt máy thì API, webhook nhận vào và gửi ra đều
          ngừng cho tới khi mở lại.
        </Callout>
      </Card>

      <Card>
        <SectionTitle><ActivityIcon className="w-4 h-4 inline" /> Nhật ký, giám sát &amp; sự kiện realtime</SectionTitle>
        <BulletList items={[
          `${bold('Nhật ký:')} 200 request gần nhất, lọc theo key — ai gọi (key, nhân viên hay ứng dụng), endpoint, kết quả, thời gian xử lý, IP. Không lưu nội dung request; mặc định giữ 7 ngày.`,
          `${bold('Thống kê 24h')} cho từng key ở tab API key; tab Tổng quan có mục Giám sát 5 phút gần nhất (request/phút, lỗi, kết nối realtime, IP bị tạm chặn).`,
          `${bold('Sự kiện realtime')} (tin nhắn mới, kết bạn, thanh toán…) cho key có quyền nhận sự kiện: Socket.IO cho app / worker giữ kết nối lâu, SSE cho script và server, polling cho cron, serverless, Google Apps Script.`,
          'Hệ thống mất kết nối vẫn lấy bù được sự kiện: mặc định giữ 7 ngày, tối đa 50.000 sự kiện.',
          `Tab ${bold('Nâng cao')}: giới hạn do bạn tự đặt (mặc định không giới hạn request), dung lượng body / file tối đa, số thao tác chạy song song, thời gian giữ nhật ký và sự kiện, các tuỳ chọn bảo mật.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><WebhookIcon className="w-4 h-4 inline" /> Webhook: nhận dữ liệu vào, gửi sự kiện ra</SectionTitle>
        <div className="grid gap-2 md:grid-cols-2">
          <InfoTile
            title="Nhận dữ liệu vào"
            meta="Hệ thống khác → Deplao"
            desc={`Casso, SePay gửi giao dịch chuyển khoản, KiotViet / Haravan / Sapo / Nhanh.vn / Pancake POS gửi đơn hàng (xác thực bằng khoá webhook đặt ở trang tích hợp) vào ${mono('&lt;địa chỉ&gt;/webhook/&lt;loại&gt;')}; website, Zapier, Make… kích hoạt workflow có trigger "Webhook bên ngoài" qua ${mono('&lt;địa chỉ&gt;/api/workflow/webhook/&lt;token&gt;')}. Cần bật địa chỉ "Thanh toán, tích hợp" / "Webhook workflow" ở Cài đặt → Internet &amp; Đám mây; chỉ dùng trong LAN thì không cần.`}
          />
          <InfoTile
            title="Gửi sự kiện ra ngoài"
            meta="Deplao → URL của bạn"
            desc={`Bấm ${bold('Thêm webhook')}: tên, URL nhận (https://, hoặc http:// trong mạng nội bộ), chọn sự kiện (hoặc Mọi sự kiện) và tài khoản → Tạo webhook. ${bold('Secret chỉ hiện một lần')} — dùng để kiểm tra chữ ký.`}
          />
        </div>
        <BulletList items={[
          `Mỗi lần gửi kèm chữ ký ${mono('X-Deplao-Signature')} (HMAC SHA-256 tạo bằng secret) để server của bạn chắc chắn dữ liệu do Deplao gửi; cách kiểm tra xem ở nút Tài liệu webhook.`,
          'Gửi lỗi thì tự thử lại sau 30 giây, 2 phút, 10 phút, 1 giờ, 6 giờ; lỗi 100 lần liên tiếp thì webhook tự tắt — sửa server nhận rồi bật lại.',
          `${bold('Gửi thử')}, ${bold('Lịch sử gửi')} (thành công / thất bại / đang chờ thử lại) và ${bold('Gửi lại')} từng lần.`,
          'Webhook gửi ra vẫn chạy khi API server tắt; chỉ dừng khi tắt công tắc "Cho phép gọi API". Webhook do API key hoặc ứng dụng tự đăng ký cũng hiện ở đây để bạn quản lý.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><PackageIcon className="w-4 h-4 inline" /> Ứng dụng: thêm tính năng ngay trong Deplao</SectionTitle>
        <Paragraph>
          Ứng dụng là phần mở rộng do nhà cung cấp hoặc chính bạn làm, cài vào là dùng ngay trong Deplao. (Trong tài liệu kỹ
          thuật, ứng dụng được gọi là plugin.)
        </Paragraph>
        <SubTitle>Ứng dụng có thể thêm</SubTitle>
        <div className="grid gap-2 md:grid-cols-2">
          {PLUGIN_PLACES.map(p => <InfoTile key={p.title} {...p} />)}
        </div>
        <Paragraph>
          Ứng dụng cũng có thể mở API riêng cho hệ thống ngoài gọi, dạng <Code>/api/v1/plugins/&lt;mã ứng dụng&gt;/…</Code>{' '}
          (xem trong chi tiết ứng dụng → mục API cho hệ thống ngoài).
        </Paragraph>
        <SubTitle>Ba loại ứng dụng</SubTitle>
        <BulletList items={[
          `${bold('Chỉ giao diện:')} chỉ có giao diện chạy trong Deplao, không chạy code nền.`,
          `${bold('Chạy trên máy:')} có phần chạy nền trên máy này, trong tiến trình riêng tách khỏi Deplao.`,
          `${bold('Dịch vụ ngoài:')} phần xử lý chạy trên server của nhà cung cấp; Deplao gọi tới qua HTTPS có chữ ký.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><WrenchIcon className="w-4 h-4 inline" /> Cài và quản lý ứng dụng</SectionTitle>
        <StepList steps={[
          {
            title: 'Cài ứng dụng',
            desc: `Thẻ ${bold('Ứng dụng')} → ${bold('Cài ứng dụng')} → chọn file ${mono('.zip')} nhà cung cấp gửi. Ứng dụng đang phát triển ở dạng thư mục thì dùng nút ${bold('Phát triển ứng dụng')} → ${bold('Thêm thư mục đang phát triển')}.`,
          },
          {
            title: 'Duyệt quyền',
            desc: `Màn cài hiện loại ứng dụng, các quyền ứng dụng xin (quyền rủi ro tô đỏ), cảnh báo nếu ứng dụng chạy code trên máy và README. Chọn ${bold('Tài khoản ứng dụng được dùng')} (tất cả hoặc vài tài khoản) rồi bấm ${bold('Cài và bật')}.`,
          },
          {
            title: 'Dùng và quản lý',
            desc: `Bấm ${bold('Mở')} để vào trang của ứng dụng. Bấm vào ô ứng dụng để xem chi tiết: Giới thiệu (có ở đâu trong Deplao, được phép gì, tài khoản nào), Cài đặt, Nhật ký, công tắc bật / tắt, Tải lại, Gỡ ứng dụng.`,
          },
          {
            title: 'Cập nhật',
            desc: 'Cài file .zip có phiên bản mới hơn; quyền mới (nhãn "mới") phải duyệt lại.',
          },
        ]} />
        <BulletList items={[
          'Ứng dụng chỉ làm được trong phạm vi quyền đã duyệt và trên các tài khoản được cấp — mọi lời gọi đi qua API v1 với cùng bước kiểm tra quyền, và hiện trong Nhật ký API.',
          'Ứng dụng loại Dịch vụ ngoài: khi cài, Deplao hiện một lần API key và secret ký request để cấu hình ở server của ứng dụng.',
          'Ứng dụng lỗi nhiều lần liên tiếp sẽ bị Deplao tự tắt (trạng thái "Tắt do lỗi") — xem tab Nhật ký, sửa xong bật lại.',
          `Nút bánh răng ${bold('Giới hạn chung cho ứng dụng')}: số ứng dụng bật cùng lúc (mặc định 10 — ứng dụng chạy nền tốn RAM) và request/phút cho mỗi ứng dụng.`,
          'Gỡ ứng dụng: Deplao hỏi giữ hay xoá dữ liệu riêng của ứng dụng (giữ để cài lại sau). Gỡ ứng dụng dạng thư mục không xoá thư mục code của bạn.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><TerminalIcon className="w-4 h-4 inline" /> Tự làm ứng dụng (cho lập trình viên)</SectionTitle>
        <Paragraph>
          Ứng dụng là một web app (HTML/CSS/JS thuần, React, Vue, Svelte…) gọi Deplao qua <Code>deplao.*</Code>; cần xử lý nền
          thì thêm backend Node chạy trên máy hoặc để server riêng của bạn xử lý. Nút{' '}
          <strong className="text-foreground">Phát triển ứng dụng</strong> mở ngăn hướng dẫn, tài liệu và bảng tra nhanh SDK.
        </Paragraph>
        <StepList steps={[
          {
            title: 'Tạo khung ứng dụng',
            desc: `Lệnh ${mono('create')}, chọn runtime ${mono('web')} (chỉ giao diện), ${mono('local')} (chạy nền trên máy) hoặc ${mono('remote')} (server riêng).`,
          },
          {
            title: 'Chạy thử trong Deplao',
            desc: `${bold('Thêm thư mục đang phát triển')}, chọn thư mục có ${mono('deplao-plugin.json')}; sửa code xong bấm Tải lại trong chi tiết ứng dụng.`,
          },
          {
            title: 'Kiểm tra',
            desc: `Lệnh ${mono('validate')} báo lỗi manifest và liệt kê các quyền ứng dụng xin.`,
          },
          {
            title: 'Đóng gói',
            desc: `Lệnh ${mono('pack')} tạo file .zip để khách cài ở thẻ Ứng dụng.`,
          },
        ]} />
        <CodeBlock>{CLI_EXAMPLE}</CodeBlock>
        <BulletList items={[
          `Bộ công cụ nằm trong thư mục ${mono('packages/')} của mã nguồn Deplao: SDK ${mono('@deplao/plugin-sdk')} và CLI ${mono('deplao-plugin')} (chạy bằng Node.js). Ứng dụng mẫu ở ${mono('examples/plugins')}.`,
          'Ứng dụng gọi Deplao bằng chính API v1: tên hàm trong SDK trùng tên thao tác (operationId) trong tài liệu API.',
          'Script, CSS, font từ CDN bị chặn để bảo mật — build ra file tĩnh và đóng gói kèm ứng dụng.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><ShieldIcon className="w-4 h-4 inline" /> An toàn khi mở Deplao ra bên ngoài</SectionTitle>
        <BulletList items={[
          `${bold('Giữ API key như mật khẩu:')} không gửi qua chat, không đặt trong website công khai. Mỗi hệ thống một key, chỉ cấp quyền và tài khoản cần thiết, đặt IP được phép nếu server gọi có IP cố định, đặt hạn dùng.`,
          `Quyền ${bold('admin')} (Toàn quyền) gồm cả quản lý nhân viên và cài đặt — chỉ cấp cho hệ thống bạn hoàn toàn tin tưởng.`,
          `${bold('Thu hồi key không dùng nữa')} (tab API key → Thu hồi). Nghi lộ key: tab Tổng quan → Khẩn cấp → ${bold('Thu hồi tất cả API key')} rồi tạo lại; công tắc ${bold('Cho phép gọi API')} chặn toàn bộ API ngay (trả lỗi 503), không ảnh hưởng nhân viên.`,
          'IP thử key sai liên tục (20 lần/phút) bị tạm chặn 10 phút; key đúng không bị ảnh hưởng.',
          'Giữ kín secret của webhook, luôn kiểm tra chữ ký và dùng URL https.',
          `${bold('Chỉ cài ứng dụng từ nguồn bạn tin cậy')} và đọc kỹ quyền trước khi bấm Cài — ứng dụng chạy trên máy chạy code trên máy bạn. Tắt hoặc gỡ ứng dụng không dùng nữa.`,
          'Chỉ bật địa chỉ Internet khi cần gọi từ ngoài. Trang tài liệu mặc định ai cũng xem được (chỉ mô tả endpoint, không có dữ liệu); muốn bắt buộc key khi xem từ xa thì tắt "Tài liệu công khai" ở tab Nâng cao.',
        ]} />
      </Card>
    </div>
  );
}
