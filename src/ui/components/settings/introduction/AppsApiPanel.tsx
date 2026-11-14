/**
 * Introduction & Guide → "Ứng dụng, API & Webhook" (Apps, API & Webhook): guide to the Tools → Apps, API & Webhook page (Public API v1,
 * API keys, logs, realtime events, incoming / outgoing webhooks, Apps + SDK / CLI). The wording follows the UI in
 * src/ui/components/plugins/** and src/ui/components/settings/api/**. The UI always calls it "Ứng dụng" (Apps).
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
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// ─── HTML pieces for BulletList / StepList (HTML strings: use class, not className) ──────

const CODE_CLASS = 'rounded border border-border px-1 font-mono text-[11px] text-foreground';
const bold = (html: string) => `<strong class="text-foreground">${html}</strong>`;
const mono = (html: string) => `<code class="${CODE_CLASS}">${html}</code>`;

// ─── This page's own UI pieces ──────────────────────────────────────────────────────

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

/** Muted box: name + secondary label + description (HTML). */
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

// ─── Content ────────────────────────────────────────────────────────────────────────────────

const CURL_EXAMPLE = 'curl -H "Authorization: Bearer dpk_xxx" http://127.0.0.1:9900/api/v1/accounts';

const CLI_EXAMPLE = [
  'node packages/plugin-cli/bin/deplao-plugin.js create my-app --runtime web',
  'node packages/plugin-cli/bin/deplao-plugin.js validate my-app',
  'node packages/plugin-cli/bin/deplao-plugin.js pack my-app --out my-app.zip',
].join('\n');

const PLUGIN_PLACES: Array<{ title: string; desc: string }> = [
  { title: tr('Trang riêng'), desc: tr('Mở bằng nút Mở trên ô ứng dụng, hoặc từ bảng Tất cả tính năng.') },
  { title: tr('Panel trong màn chat'), desc: tr('Bấm biểu tượng ứng dụng trên thanh tiêu đề hội thoại.') },
  { title: tr('Nút trong ô soạn tin'), desc: tr('Thêm nút thao tác ngay ở ô soạn tin của khung chat.') },
  { title: tr('Cài đặt riêng'), desc: tr('Bấm vào ô ứng dụng → tab Cài đặt; ô bí mật được lưu mã hoá.') },
  { title: tr('Node workflow'), desc: tr('Kéo vào kịch bản trong trang Workflow.') },
  { title: tr('Chạy định kỳ'), desc: tr('Việc chạy nền theo lịch do ứng dụng đặt.') },
];

export function AppsApiPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Ứng dụng, API & Webhook', { 0: <PluginIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Một trang gom mọi cách mở Deplao ra bên ngoài: cài thêm Ứng dụng chạy ngay trong Deplao; cho website, phần mềm bán hàng, n8n… đọc dữ liệu và gửi tin qua API; nhận và gửi dữ liệu bằng webhook.')}
        </Paragraph>
        <BulletList items={[
          tr('{{v1}} thanh điều hướng bên trái → {{v2}} → {{v3}} (hoặc tìm trong bảng Tất cả tính năng). Chỉ có trên máy chủ; máy nhân viên không chạy API.', { v1: bold(tr('Ở đâu:')), v2: bold(tr('Công cụ')), v3: bold(tr('Ứng dụng, API &amp; Webhook')) }),
          tr('Ba thẻ: {{v1}} (cài, mở, quản lý ứng dụng) · {{v2}} (server, API key, nhật ký, nâng cao) · {{v3}} (nhận dữ liệu vào, gửi sự kiện ra ngoài).', { v1: bold(tr('Ứng dụng')), v2: bold('API'), v3: bold('Webhook') }),
          tr('Nút {{v1}} và {{v2}} ở đầu trang mở tài liệu trong trình duyệt (API server tự bật nếu đang tắt).', { v1: bold(tr('Tài liệu API')), v2: bold(tr('Tài liệu phát triển ứng dụng')) }),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Public API v1', { 0: <KeyIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('API là "cửa" để phần mềm khác làm việc với Deplao như một người dùng: đọc hội thoại, gửi tin, cập nhật khách hàng, chạy workflow… Mỗi hệ thống dùng một <0>API key</0> riêng — giống mật khẩu, kèm danh sách <1>quyền (scope)</1> cho biết key được làm gì.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('{{v1}} tài khoản, chat Zalo / Facebook / Telegram, nhóm, nhãn, danh bạ, CRM, workflow, tích hợp, ERP, AI, báo cáo, media, nhân viên.', { v1: bold(tr('Gần 300 thao tác:')) }),
          tr('{{v1}}, cổng mặc định {{v2}} (chung server với kết nối nhân viên). {{v3}} cho tới khi bạn bật; mọi lời gọi đều cần API key do bạn tạo.', { v1: bold(tr('Chạy ngay trên máy cài Deplao')), v2: mono('9900'), v3: bold(tr('Mặc định tắt')) }),
          tr('{{v1}} tin gửi bằng API vẫn hiện trong khung chat, được lưu và kích hoạt workflow như khi bạn tự gửi.', { v1: bold(tr('Đi đúng luồng của app:')) }),
          tr('Gửi key trong header {{v1}} (hoặc {{v2}}).', { v1: mono('Authorization: Bearer dpk_…'), v2: mono('X-Api-Key') }),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Bật API và tạo API key', { 0: <ServerIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <StepList steps={[
          {
            title: tr('Bật server'),
            desc: tr('Thẻ {{v1}} → tab {{v2}} → mục API server → {{v3}}. Máy chạy bot / worker 24/7 thì bật thêm "Tự bật server khi mở app".', { v1: bold('API'), v2: bold(tr('Tổng quan')), v3: bold(tr('Bật server')) }),
          },
          {
            title: tr('Tạo API key'),
            desc: tr('Tab {{v1}} → {{v2}}: đặt tên (vd Website, n8n), chọn {{v3}} (mẫu nhanh Chỉ đọc · Chat bot · Đồng bộ CRM · Toàn quyền, hoặc tick từng quyền), {{v4}}, {{v5}} (IP hoặc dải CIDR, để trống = mọi IP), {{v6}} (30 ngày, 90 ngày, 1 năm hoặc không hết hạn). Tuỳ chọn: giới hạn request/phút (0 = không giới hạn), vai trò ERP, ghi chú.', { v1: bold('API key'), v2: bold(tr('Tạo API key')), v3: bold(tr('Quyền')), v4: bold(tr('Tài khoản được dùng')), v5: bold(tr('IP được phép')), v6: bold(tr('Hết hạn')) }),
          },
          {
            title: tr('Sao chép key ngay'),
            desc: tr('Key dạng {{v1}} {{v2}} — sao chép và cất ở nơi an toàn. Lỡ mất key thì thu hồi và tạo key mới.', { v1: mono('dpk_…'), v2: bold(tr('chỉ hiện một lần')) }),
          },
          {
            title: tr('Gọi thử'),
            desc: tr('Chạy lệnh bên dưới (thay dpk_xxx bằng key của bạn); nhận về danh sách tài khoản là key đã dùng được.'),
          },
          {
            title: tr('Xem tài liệu'),
            desc: tr('Bấm {{v1}}: trang {{v2}} có hướng dẫn, danh sách endpoint, nút thử gọi và lệnh curl. File {{v3}} nhập thẳng vào Postman / Insomnia hoặc dùng để sinh SDK.', { v1: bold(tr('Mở tài liệu API')), v2: mono('http://127.0.0.1:9900/docs'), v3: mono('/api/v1/openapi.json') }),
          },
        ]} />
        <CodeBlock>{CURL_EXAMPLE}</CodeBlock>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Gọi API từ đâu?', { 0: <GlobeIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          `${bold(tr('Trên máy này:'))} ${mono('http://127.0.0.1:9900/api/v1')}`,
          tr('{{v1}} {{v2}} — tab Tổng quan hiện sẵn địa chỉ để sao chép.', { v1: bold(tr('Trong mạng LAN:')), v2: mono(tr('http://&lt;IP máy chủ&gt;:9900/api/v1')) }),
          tr('{{v1}} (server, n8n, Make… ở ngoài): bật dịch vụ {{v2}} ở {{v3}}, rồi gọi {{v4}}. Mục "Truy cập từ xa" ở tab Tổng quan chỉ hiện địa chỉ này để sao chép; đây cũng là địa chỉ nhân viên làm việc từ xa dùng.', { v1: bold(tr('Từ Internet')), v2: bold(tr('Nhân viên và API')), v3: bold(tr('Cài đặt → Internet &amp; Cloud → Địa chỉ Internet')), v4: mono(tr('&lt;địa chỉ&gt;/api/v1')) }),
          tr('Địa chỉ tạm đổi mỗi lần khởi động lại; hệ thống chạy lâu dài nên dùng địa chỉ cố định (Cloudflare tự động).'),
        ]} />
        <Callout>
          {tr('API và webhook chạy trong Deplao trên máy chủ: tắt Deplao hoặc tắt máy thì API, webhook nhận vào và gửi ra đều ngừng cho tới khi mở lại.')}
        </Callout>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Nhật ký, giám sát & sự kiện realtime', { 0: <ActivityIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('{{v1}} 200 request gần nhất, lọc theo key — ai gọi (key, nhân viên hay ứng dụng), endpoint, kết quả, thời gian xử lý, IP. Không lưu nội dung request; mặc định giữ 7 ngày.', { v1: bold(tr('Nhật ký:')) }),
          tr('{{v1}} cho từng key ở tab API key; tab Tổng quan có mục Giám sát 5 phút gần nhất (request/phút, lỗi, kết nối realtime, IP bị tạm chặn).', { v1: bold(tr('Thống kê 24h')) }),
          tr('{{v1}} (tin nhắn mới, kết bạn, thanh toán…) cho key có quyền nhận sự kiện: Socket.IO cho app / worker giữ kết nối lâu, SSE cho script và server, polling cho cron, serverless, Google Apps Script.', { v1: bold(tr('Sự kiện realtime')) }),
          tr('Hệ thống mất kết nối vẫn lấy bù được sự kiện: mặc định giữ 7 ngày, tối đa 50.000 sự kiện.'),
          tr('Tab {{v1}}: giới hạn do bạn tự đặt (mặc định không giới hạn request), dung lượng body / file tối đa, số thao tác chạy song song, thời gian giữ nhật ký và sự kiện, các tuỳ chọn bảo mật.', { v1: bold(tr('Nâng cao')) }),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Webhook: nhận dữ liệu vào, gửi sự kiện ra', { 0: <WebhookIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="grid gap-2 md:grid-cols-2">
          <InfoTile
            title={tr('Nhận dữ liệu vào')}
            meta={tr('Hệ thống khác → Deplao')}
            desc={tr('Casso, SePay gửi giao dịch chuyển khoản, KiotViet / Haravan / Sapo / Nhanh.vn / Pancake POS gửi đơn hàng (xác thực bằng khoá webhook đặt ở trang tích hợp) vào {{v1}}; website, Zapier, Make… kích hoạt workflow có trigger "Webhook bên ngoài" qua {{v2}}. Cần bật địa chỉ "Thanh toán, tích hợp" / "Webhook workflow" ở Cài đặt → Internet &amp; Cloud; chỉ dùng trong LAN thì không cần.', { v1: mono(tr('&lt;địa chỉ&gt;/webhook/&lt;loại&gt;')), v2: mono(tr('&lt;địa chỉ&gt;/api/workflow/webhook/&lt;token&gt;')) })}
          />
          <InfoTile
            title={tr('Gửi sự kiện ra ngoài')}
            meta={tr('Deplao → URL của bạn')}
            desc={tr('Bấm {{v1}}: tên, URL nhận (https://, hoặc http:// trong mạng nội bộ), chọn sự kiện (hoặc Mọi sự kiện) và tài khoản → Tạo webhook. {{v2}} — dùng để kiểm tra chữ ký.', { v1: bold(tr('Thêm webhook')), v2: bold(tr('Secret chỉ hiện một lần')) })}
          />
        </div>
        <BulletList items={[
          tr('Mỗi lần gửi kèm chữ ký {{v1}} (HMAC SHA-256 tạo bằng secret) để server của bạn chắc chắn dữ liệu do Deplao gửi; cách kiểm tra xem ở nút Tài liệu webhook.', { v1: mono('X-Deplao-Signature') }),
          tr('Gửi lỗi thì tự thử lại sau 30 giây, 2 phút, 10 phút, 1 giờ, 6 giờ; lỗi 100 lần liên tiếp thì webhook tự tắt — sửa server nhận rồi bật lại.'),
          tr('{{v1}}, {{v2}} (thành công / thất bại / đang chờ thử lại) và {{v3}} từng lần.', { v1: bold(tr('Gửi thử')), v2: bold(tr('Lịch sử gửi')), v3: bold(tr('Gửi lại')) }),
          tr('Webhook gửi ra vẫn chạy khi API server tắt; chỉ dừng khi tắt công tắc "Cho phép gọi API". Webhook do API key hoặc ứng dụng tự đăng ký cũng hiện ở đây để bạn quản lý.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Ứng dụng: thêm tính năng ngay trong Deplao', { 0: <PackageIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Ứng dụng là phần mở rộng do nhà cung cấp hoặc chính bạn làm, cài vào là dùng ngay trong Deplao. (Trong tài liệu kỹ thuật, ứng dụng được gọi là plugin.)')}
        </Paragraph>
        <SubTitle>{tr('Ứng dụng có thể thêm')}</SubTitle>
        <div className="grid gap-2 md:grid-cols-2">
          {PLUGIN_PLACES.map(p => <InfoTile key={p.title} {...p} />)}
        </div>
        <Paragraph>
          {tr('Ứng dụng cũng có thể mở API riêng cho hệ thống ngoài gọi, dạng')} <Code>{tr('/api/v1/plugins/<mã ứng dụng>/…')}</Code>{tr(' (xem trong chi tiết ứng dụng → mục API cho hệ thống ngoài).')}
        </Paragraph>
        <SubTitle>{tr('Ba loại ứng dụng')}</SubTitle>
        <BulletList items={[
          tr('{{v1}} chỉ có giao diện chạy trong Deplao, không chạy code nền.', { v1: bold(tr('Chỉ giao diện:')) }),
          tr('{{v1}} có phần chạy nền trên máy này, trong tiến trình riêng tách khỏi Deplao.', { v1: bold(tr('Chạy trên máy:')) }),
          tr('{{v1}} phần xử lý chạy trên server của nhà cung cấp; Deplao gọi tới qua HTTPS có chữ ký.', { v1: bold(tr('Dịch vụ ngoài:')) }),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Cài và quản lý ứng dụng', { 0: <WrenchIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <StepList steps={[
          {
            title: tr('Cài ứng dụng'),
            desc: tr('Thẻ {{v1}} → {{v2}} → chọn file {{v3}} nhà cung cấp gửi. Ứng dụng đang phát triển ở dạng thư mục thì dùng nút {{v4}} → {{v5}}.', { v1: bold(tr('Ứng dụng')), v2: bold(tr('Cài ứng dụng')), v3: mono('.zip'), v4: bold(tr('Phát triển ứng dụng')), v5: bold(tr('Thêm thư mục đang phát triển')) }),
          },
          {
            title: tr('Duyệt quyền'),
            desc: tr('Màn cài hiện loại ứng dụng, các quyền ứng dụng xin (quyền rủi ro tô đỏ), cảnh báo nếu ứng dụng chạy code trên máy và README. Chọn {{v1}} (tất cả hoặc vài tài khoản) rồi bấm {{v2}}.', { v1: bold(tr('Tài khoản ứng dụng được dùng')), v2: bold(tr('Cài và bật')) }),
          },
          {
            title: tr('Dùng và quản lý'),
            desc: tr('Bấm {{v1}} để vào trang của ứng dụng. Bấm vào ô ứng dụng để xem chi tiết: Giới thiệu (có ở đâu trong Deplao, được phép gì, tài khoản nào), Cài đặt, Nhật ký, công tắc bật / tắt, Tải lại, Gỡ ứng dụng.', { v1: bold(tr('Mở')) }),
          },
          {
            title: tr('Cập nhật'),
            desc: tr('Cài file .zip có phiên bản mới hơn; quyền mới (nhãn "mới") phải duyệt lại.'),
          },
        ]} />
        <BulletList items={[
          tr('Ứng dụng chỉ làm được trong phạm vi quyền đã duyệt và trên các tài khoản được cấp — mọi lời gọi đi qua API v1 với cùng bước kiểm tra quyền, và hiện trong Nhật ký API.'),
          tr('Ứng dụng loại Dịch vụ ngoài: khi cài, Deplao hiện một lần API key và secret ký request để cấu hình ở server của ứng dụng.'),
          tr('Ứng dụng lỗi nhiều lần liên tiếp sẽ bị Deplao tự tắt (trạng thái "Tắt do lỗi") — xem tab Nhật ký, sửa xong bật lại.'),
          tr('Nút bánh răng {{v1}}: số ứng dụng bật cùng lúc (mặc định 10 — ứng dụng chạy nền tốn RAM) và request/phút cho mỗi ứng dụng.', { v1: bold(tr('Giới hạn chung cho ứng dụng')) }),
          tr('Gỡ ứng dụng: Deplao hỏi giữ hay xoá dữ liệu riêng của ứng dụng (giữ để cài lại sau). Gỡ ứng dụng dạng thư mục không xoá thư mục code của bạn.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tự làm ứng dụng (cho lập trình viên)', { 0: <TerminalIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Ứng dụng là một web app (HTML/CSS/JS thuần, React, Vue, Svelte…) gọi Deplao qua')} <Code>deplao.*</Code>{trx('; cần xử lý nền thì thêm backend Node chạy trên máy hoặc để server riêng của bạn xử lý. Nút <0>Phát triển ứng dụng</0> mở ngăn hướng dẫn, tài liệu và bảng tra nhanh SDK.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <StepList steps={[
          {
            title: tr('Tạo khung ứng dụng'),
            desc: tr('Lệnh {{v1}}, chọn runtime {{v2}} (chỉ giao diện), {{v3}} (chạy nền trên máy) hoặc {{v4}} (server riêng).', { v1: mono('create'), v2: mono('web'), v3: mono('local'), v4: mono('remote') }),
          },
          {
            title: tr('Chạy thử trong Deplao'),
            desc: tr('{{v1}}, chọn thư mục có {{v2}}; sửa code xong bấm Tải lại trong chi tiết ứng dụng.', { v1: bold(tr('Thêm thư mục đang phát triển')), v2: mono('deplao-plugin.json') }),
          },
          {
            title: tr('Kiểm tra'),
            desc: tr('Lệnh {{v1}} báo lỗi manifest và liệt kê các quyền ứng dụng xin.', { v1: mono('validate') }),
          },
          {
            title: tr('Đóng gói'),
            desc: tr('Lệnh {{v1}} tạo file .zip để khách cài ở thẻ Ứng dụng.', { v1: mono('pack') }),
          },
        ]} />
        <CodeBlock>{CLI_EXAMPLE}</CodeBlock>
        <BulletList items={[
          tr('Bộ công cụ nằm trong thư mục {{v1}} của mã nguồn Deplao: SDK {{v2}} và CLI {{v3}} (chạy bằng Node.js). Ứng dụng mẫu ở {{v4}}.', { v1: mono('packages/'), v2: mono('@deplao/plugin-sdk'), v3: mono('deplao-plugin'), v4: mono('examples/plugins') }),
          tr('Ứng dụng gọi Deplao bằng chính API v1: tên hàm trong SDK trùng tên thao tác (operationId) trong tài liệu API.'),
          tr('Script, CSS, font từ CDN bị chặn để bảo mật — build ra file tĩnh và đóng gói kèm ứng dụng.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> An toàn khi mở Deplao ra bên ngoài', { 0: <ShieldIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('{{v1}} không gửi qua chat, không đặt trong website công khai. Mỗi hệ thống một key, chỉ cấp quyền và tài khoản cần thiết, đặt IP được phép nếu server gọi có IP cố định, đặt hạn dùng.', { v1: bold(tr('Giữ API key như mật khẩu:')) }),
          tr('Quyền {{v1}} (Toàn quyền) gồm cả quản lý nhân viên và cài đặt — chỉ cấp cho hệ thống bạn hoàn toàn tin tưởng.', { v1: bold('admin') }),
          tr('{{v1}} (tab API key → Thu hồi). Nghi lộ key: tab Tổng quan → Khẩn cấp → {{v2}} rồi tạo lại; công tắc {{v3}} chặn toàn bộ API ngay (trả lỗi 503), không ảnh hưởng nhân viên.', { v1: bold(tr('Thu hồi key không dùng nữa')), v2: bold(tr('Thu hồi tất cả API key')), v3: bold(tr('Cho phép gọi API')) }),
          tr('IP thử key sai liên tục (20 lần/phút) bị tạm chặn 10 phút; key đúng không bị ảnh hưởng.'),
          tr('Giữ kín secret của webhook, luôn kiểm tra chữ ký và dùng URL https.'),
          tr('{{v1}} và đọc kỹ quyền trước khi bấm Cài — ứng dụng chạy trên máy chạy code trên máy bạn. Tắt hoặc gỡ ứng dụng không dùng nữa.', { v1: bold(tr('Chỉ cài ứng dụng từ nguồn bạn tin cậy')) }),
          tr('Chỉ bật địa chỉ Internet khi cần gọi từ ngoài. Trang tài liệu mặc định ai cũng xem được (chỉ mô tả endpoint, không có dữ liệu); muốn bắt buộc key khi xem từ xa thì tắt "Tài liệu công khai" ở tab Nâng cao.'),
        ]} />
      </Card>
    </div>
  );
}
