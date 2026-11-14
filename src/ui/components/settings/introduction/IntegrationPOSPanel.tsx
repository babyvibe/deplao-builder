import React from 'react';
import { AlertIcon, CheckCircleIcon, ClipboardListIcon, EditIcon, LightbulbIcon, LightningIcon, MenuIcon, PinIcon, PluginIcon, RepeatIcon, SearchIcon, ShoppingCartIcon, StoreIcon, UserIcon, WebhookIcon, WrenchIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Tip box: semantic colors should work in both Light and Dark themes. */
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
      <LightbulbIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
      <p className="text-xs leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

interface Platform {
  icon: React.ReactNode;
  name: string;
  /** Field name exactly as in the "Thông tin xác thực" (Credentials) form. */
  fields: string[];
  hint: React.ReactNode;
  /** Webhook auth key (the "… (không bắt buộc)" (optional) field) and how the platform sends the key / signature - services/integrations/posWebhook.ts. */
  webhook: string;
}

const PLATFORMS: Platform[] = [
  {
    icon: <ShoppingCartIcon className="w-4 h-4" />, name: 'KiotViet',
    fields: ['Client ID', 'Client Secret', tr('Tên gian hàng (Retailer)')],
    hint: <>{trx('Client ID / Client Secret lấy trong trang quản trị KiotViet; tên gian hàng dạng <0>myshop</0>. Ô tuỳ chọn <1>Branch ID mặc định</1> là chi nhánh nhận đơn khi tạo đơn trong hội thoại.', { 0: <em />, 1: <strong className="text-foreground" /> })}</>,
    webhook: tr('KiotViet không có màn hình quản trị webhook: bấm <strong class="text-foreground">Đăng ký webhook tự động</strong> trong trang KiotViet — Deplao tự tạo Secret, lưu vào ô <strong class="text-foreground">Webhook Secret</strong> và đăng ký các sự kiện đã chọn. Webhook đăng ký bằng công cụ khác thì dán đúng Secret (chuỗi Base64) đã dùng. KiotViet ký bằng header X-Hub-Signature.'),
  },
  {
    icon: <StoreIcon className="w-4 h-4" />, name: 'Haravan',
    fields: [tr('Private Token (khuyên dùng)'), tr('hoặc API Key + Password (cách cũ)'), tr('Tên shop (chỉ cần với API Key + Password)')],
    hint: <>{trx('Chỉ cần một trong hai cách: <0>Private Token</0> (Haravan → Ứng dụng → Ứng dụng riêng, khuyên dùng), hoặc <1>API Key + Password</1> kiểu cũ. Dùng Private Token thì để trống các ô còn lại. Ô tên shop (<2>myshop</2> hoặc <3>myshop.myharavan.com</3>) chỉ cần với cách cũ.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" />, 2: <em />, 3: <em /> })}</>,
    webhook: tr('Ô <strong class="text-foreground">Mã xác thực webhook</strong> = mã xác thực ở Cài đặt → Thông báo → Webhook (webhook do app đăng ký: Client Secret của app); Haravan ký bằng header X-Haravan-Hmacsha256.'),
  },
  {
    icon: <CheckCircleIcon className="w-4 h-4" />, name: 'Sapo',
    fields: [tr('Tên cửa hàng'), 'API Key', 'API Secret'],
    hint: <>{trx('Dùng <0>ứng dụng riêng</0>: Sapo Web → Ứng dụng → Ứng dụng riêng → Tạo ứng dụng riêng, cấp quyền Khách hàng, Đơn hàng, Sản phẩm rồi chép API Key + API Secret. Tên cửa hàng: <1>myshop</1> hoặc <2>myshop.mysapo.net</2>. Ô Access Token OAuth không bắt buộc — để trống.', { 0: <strong className="text-foreground" />, 1: <em />, 2: <em /> })}</>,
    webhook: tr('Bấm <strong class="text-foreground">Đăng ký webhook tự động</strong> trong trang Sapo để Deplao tạo webhook cho các topic đã chọn. Sapo ký webhook (header X-Sapo-Hmac-Sha256) bằng <strong class="text-foreground">API Secret</strong> của ứng dụng riêng — đã nhập API Secret thì để trống ô Khoá xác thực webhook.'),
  },
  {
    icon: <LightningIcon className="w-4 h-4" />, name: 'Nhanh.vn',
    fields: ['App ID', 'Business ID', 'Access Token v3'],
    hint: <>{tr('Thông tin ứng dụng Open API của Nhanh.vn; Access Token lấy tại open.nhanh.vn → Ứng dụng của tôi.')}</>,
    webhook: tr('Ô <strong class="text-foreground">Webhooks verify token</strong> = token tự đặt trong phần Webhooks của ứng dụng Nhanh.vn (Nhanh.vn gửi ở header Authorization).'),
  },
  {
    icon: <MenuIcon className="w-4 h-4" />, name: 'Pancake POS',
    fields: ['API Key (api_key)', 'Shop ID'],
    hint: <>{tr('API key Open API của Pancake POS và mã shop Pancake.')}</>,
    webhook: tr('Ô <strong class="text-foreground">Khoá webhook X-API-KEY</strong> = chuỗi bí mật tự đặt; khi cấu hình webhook Pancake, thêm Request Header X-API-KEY bằng đúng chuỗi đó.'),
  },
];

const CHAT_ACTIONS = [
  { icon: <UserIcon className="w-4 h-4" />, name: tr('Tra cứu khách hàng'), desc: tr('Theo số điện thoại: tên, SĐT, địa chỉ, số đơn / tổng đã mua (khi nền tảng có dữ liệu).') },
  { icon: <ClipboardListIcon className="w-4 h-4" />, name: tr('Tra cứu đơn hàng'), desc: tr('Theo SĐT hoặc mã đơn: trạng thái, sản phẩm, tổng tiền, phí ship, mã vận đơn (nếu có).') },
  { icon: <SearchIcon className="w-4 h-4" />, name: tr('Tìm sản phẩm'), desc: tr('Theo tên hoặc mã (tuỳ nền tảng): giá bán, tồn kho.') },
  { icon: <EditIcon className="w-4 h-4" />, name: tr('Tạo đơn hàng'), desc: tr('Nhập khách và địa chỉ giao (bắt buộc), chọn sản phẩm, phí ship, giảm giá, cách thanh toán, ghi chú → đơn tạo thẳng trên POS.') },
];

export function IntegrationPOSPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Tích hợp POS / Bán hàng', { 0: <ShoppingCartIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Kết nối Deplao với phần mềm bán hàng để tra cứu khách hàng, đơn hàng, sản phẩm và tạo đơn ngay bên cạnh hội thoại — không phải mở thêm trang quản trị. Các bước tra cứu, tạo đơn cũng có sẵn trong Workflow; phần mềm bán hàng gửi webhook (đơn mới, đổi trạng thái…) thì workflow tự chạy.')}
        </Paragraph>
        <Tip>
          {trx('Màn hình kết nối: thanh điều hướng bên trái → <0>Công cụ</0> → <1>Tích hợp</1> → tab <2>POS / Bán hàng</2>.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" />, 2: <strong className="text-foreground" /> })}
        </Tip>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Nền tảng hỗ trợ & thông tin cần nhập', { 0: <ClipboardListIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="space-y-2">
          {PLATFORMS.map(p => (
            <div key={p.name} className="rounded-lg bg-muted p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">{p.icon} {p.name}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {p.fields.map(f => (
                  <span key={f} className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-foreground">{f}</span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{p.hint}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Cách kết nối', { 0: <WrenchIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <StepList steps={[
          { title: tr('Mở Công cụ → Tích hợp'), desc: tr('Trên thanh điều hướng bên trái bấm <strong class="text-foreground">Công cụ</strong> → <strong class="text-foreground">Tích hợp</strong>, chọn tab <strong class="text-foreground">POS / Bán hàng</strong>.') },
          { title: tr('Chọn nền tảng'), desc: tr('Bấm vào thẻ KiotViet, Haravan, Sapo, Nhanh.vn hoặc Pancake POS.') },
          { title: tr('Nhập thông tin rồi bấm Kết nối'), desc: tr('Điền các ô ở phần <strong class="text-foreground">Thông tin xác thực</strong> (xem bảng trên), bấm <strong class="text-foreground">Kết nối</strong> để lưu.') },
          { title: tr('Bấm Test kết nối'), desc: tr('Thành công thì thẻ nền tảng chuyển sang <strong class="text-foreground">Đã kết nối</strong>. Mới lưu mà chưa test thành công, thẻ hiện <strong class="text-foreground">Chưa xác nhận</strong> và nền tảng chưa có trong bảng Tích hợp nhanh của hội thoại.') },
          { title: tr('Bật / tạm tắt khi cần'), desc: tr('Dùng công tắc <strong class="text-foreground">Kích hoạt</strong> ở góc trên trang nền tảng; đổi xong bấm <strong class="text-foreground">Cập nhật</strong> để lưu.') },
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Nhận webhook — tự chạy workflow khi có đơn', { 0: <WebhookIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Trigger <0>Khi phần mềm bán hàng gửi webhook</0> (nhóm Kích hoạt của Workflow) chạy khi KiotViet, Haravan, Sapo, Nhanh.vn hoặc Pancake POS báo đơn hàng, hoá đơn, khách hàng, sản phẩm, tồn kho — lọc được theo phần mềm, loại dữ liệu, tên sự kiện và trạng thái. Deplao chỉ nhận webhook xác thực đúng khoá.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <StepList steps={[
          { title: tr('Bật địa chỉ nhận'), desc: tr('Cài đặt → Internet &amp; Cloud → Địa chỉ Internet → bật <strong class="text-foreground">Thanh toán, tích hợp</strong> (chỉ chạy khi Deplao đang mở trên máy Boss).') },
          { title: tr('KiotViet / Sapo: Đăng ký webhook tự động'), desc: tr('Trang nền tảng → mục <strong class="text-foreground">Đăng ký webhook tự động</strong> → chọn sự kiện → <strong class="text-foreground">Đăng ký webhook</strong>. Deplao tạo webhook trỏ về địa chỉ nhận (KiotViet: tự tạo và lưu Secret) — không cần bước 3, 4.') },
          { title: tr('Nền tảng khác: đặt khoá xác thực webhook'), desc: tr('Haravan / Nhanh.vn / Pancake: trang nền tảng → ô khoá webhook (bảng dưới) → <strong class="text-foreground">Cập nhật</strong>. Làm bước này TRƯỚC khi bật webhook bên phần mềm bán hàng.') },
          { title: tr('Dán địa chỉ vào phần mềm bán hàng'), desc: tr('Sao chép <strong class="text-foreground">Địa chỉ nhận webhook</strong> trong trang nền tảng, dán vào phần cấu hình webhook của phần mềm bán hàng, dùng cùng khoá.') },
          { title: tr('Tạo workflow'), desc: tr('Kéo trigger <strong class="text-foreground">Khi phần mềm bán hàng gửi webhook</strong>, chọn phần mềm và loại dữ liệu, nối các bước xử lý.') },
        ]} />
        <div className="space-y-2">
          {PLATFORMS.map(p => (
            <p key={p.name} className="text-[11px] leading-relaxed text-muted-foreground">
              <strong className="text-foreground">{p.name}:</strong> <span dangerouslySetInnerHTML={{ __html: p.webhook }} />
            </p>
          ))}
        </div>
        <BulletList items={[
          tr('Thiếu khoá hoặc sai chữ ký → Deplao trả lỗi 401 và không chạy workflow; mục <strong class="text-foreground">Bảo mật webhook</strong> trong trang nền tảng hiện lần nhận / từ chối gần nhất. KiotViet ngừng gửi tới địa chỉ trả lỗi 4xx, Nhanh.vn tắt webhook khi lỗi kéo dài — vì vậy đặt khoá trong Deplao trước khi đăng ký / bật webhook.'),
          tr('Mỗi đơn / khách / sản phẩm chạy workflow một lần; nền tảng gửi lại đúng dữ liệu đó (khi mạng lỗi) thì bỏ qua.'),
          tr('Địa chỉ tạm (đổi mỗi lần khởi động lại Deplao): sau mỗi lần mở lại phải đăng ký lại — KiotViet / Sapo bấm <strong class="text-foreground">Đăng ký webhook</strong> (webhook cũ của Deplao được thay), nền tảng khác dán lại địa chỉ. Cloudflare tự động cho địa chỉ cố định.'),
          tr('Biến dùng ở bước sau: <code class="font-mono text-foreground">{{ $trigger.code }}</code>, <code class="font-mono text-foreground">{{ $trigger.status }}</code>, <code class="font-mono text-foreground">{{ $trigger.customerName }}</code>, <code class="font-mono text-foreground">{{ $trigger.customerPhone }}</code>, <code class="font-mono text-foreground">{{ $trigger.total }}</code>, <code class="font-mono text-foreground">{{ $trigger.event }}</code> và trường gốc <code class="font-mono text-foreground">{{ $trigger.data.&lt;trường&gt; }}</code>. <code class="font-mono text-foreground">{{ $trigger.fromPhone }}</code> = SĐT khách nên bước tra cứu POS, “Tìm user bằng số điện thoại” dùng được ngay.'),
          tr('Webhook không gắn với hội thoại nào → bước gửi tin phải chọn người nhận (vd. “Tìm user bằng số điện thoại” rồi gửi tới user đó) hoặc gửi vào nhóm nội bộ / Telegram.'),
          tr('Nền tảng không gửi tên sự kiện: thêm <code class="font-mono text-foreground">?event=&lt;tên&gt;</code> vào cuối địa chỉ nhận (vd. <code class="font-mono text-foreground">…/webhook/&lt;id&gt;?event=orders/paid</code>) để lọc theo tên sự kiện.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Dùng ngay trong hội thoại — Tích hợp nhanh', { 0: <PluginIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {CHAT_ACTIONS.map(a => (
            <div key={a.name} className="rounded-lg bg-muted p-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">{a.icon} {a.name}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{a.desc}</p>
            </div>
          ))}
        </div>
        <BulletList items={[
          tr('Mở bảng <strong class="text-foreground">Tích hợp nhanh</strong> bằng nút hình mắt xích trên thanh tiêu đề hội thoại, hoặc nút <strong class="text-foreground">⋯ Thêm tính năng</strong> trên thanh công cụ ô soạn tin → <strong class="text-foreground">Tích hợp nhanh</strong>.'),
          tr('Cột trái chỉ hiện nền tảng đã kết nối và đang bật; chọn nền tảng rồi chọn thao tác. Nút <strong class="text-foreground">+</strong> mở trang Tích hợp để thêm nền tảng.'),
          tr('Hội thoại đã có số điện thoại (lưu trong thông tin liên hệ) thì ô SĐT được điền sẵn; form tạo đơn điền sẵn tên và SĐT khách.'),
          tr('Rê chuột vào một thao tác, bấm biểu tượng ghim và chọn icon để ghim ra thanh công cụ ô soạn tin — lần sau bấm một lần là mở đúng thao tác. Chuột phải nút đã ghim để <strong class="text-foreground">Đổi icon</strong> hoặc <strong class="text-foreground">Xóa ghim</strong>.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Dùng trong Workflow', { 0: <RepeatIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Nhóm <0>POS / Bán hàng</0> trong bảng node có các bước cho từng nền tảng (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake): Tra cứu khách hàng, Tra cứu đơn hàng, Tra cứu sản phẩm, Tạo đơn hàng (vd. “KiotViet: Tra cứu đơn hàng”, “Pancake: Tạo đơn hàng”); Sapo có thêm “Sapo: Tra cứu tồn kho”. Bước Tạo đơn hàng cần nhập dữ liệu đơn dạng JSON theo mẫu có sẵn trong ô — tạo đơn thủ công thì dùng Tích hợp nhanh cho dễ.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('Ô SĐT của bước tra cứu mặc định là <strong class="text-foreground">SĐT người gửi</strong> (<code class="font-mono text-foreground">{{ $trigger.fromPhone }}</code>) = số đã lưu của người nhắn (lưu ở Thông tin hội thoại hoặc CRM; Zalo, Telegram). Khách chưa lưu số thì ô trống: bước tra cứu <strong class="text-foreground">không hỏi</strong> phần mềm bán hàng và báo không tìm thấy (found = false) — tránh trả lời khách bằng đơn / thông tin của người khác.'),
          tr('Kết quả dùng ở bước sau: <code class="font-mono text-foreground">found</code> (tìm thấy hay không), <code class="font-mono text-foreground">order</code> / <code class="font-mono text-foreground">firstCustomer</code> (bản ghi đầu), <code class="font-mono text-foreground">orders</code> / <code class="font-mono text-foreground">products</code> (danh sách — liệt kê bằng node Lặp qua danh sách).'),
          tr('<strong class="text-foreground">Kho mẫu → Tích hợp POS &amp; Thanh toán</strong> có sẵn: tra đơn KiotViet / Haravan / Nhanh.vn, tra điểm tích luỹ, báo giá sản phẩm, tra vận đơn GHN, báo nhóm khi có tiền vào, ghi giao dịch vào Google Sheets, cảnh báo tồn kho Sapo.'),
        ]} />
        <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted p-3">
          <p className="text-[11px] font-semibold text-foreground">{trx('<0/> Ví dụ: khách nhắn số điện thoại → tự gửi đơn gần nhất', { 0: <PinIcon className="w-4 h-4 inline" /> })}</p>
          <BulletList items={[
            tr('<strong class="text-foreground">Khi nhận tin nhắn</strong> — <em>Từ khóa kích hoạt</em>: <code class="font-mono text-foreground">^0\\d{9}$</code>, <em>Cách khớp từ khóa</em>: Regex → chỉ chạy khi tin nhắn là số điện thoại 10 số.'),
            tr('<strong class="text-foreground">KiotViet: Tra cứu đơn hàng</strong> (hoặc Haravan / Sapo / Nhanh.vn / Pancake) — ô <em>SĐT khách hàng</em>: bấm <em>Chèn biến</em> → Nội dung tin nhắn.'),
            tr('<strong class="text-foreground">Rẽ nhánh Đúng/Sai (IF)</strong> — kiểm tra có tìm thấy đơn không.'),
            tr('<strong class="text-foreground">Gửi tin nhắn</strong> — nhánh Đúng gửi mã đơn, trạng thái, tổng tiền; nhánh Sai nhờ khách kiểm tra lại số đặt hàng.'),
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Lưu ý', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Mỗi lần tra cứu, Deplao hỏi trực tiếp phần mềm bán hàng nên luôn thấy số liệu mới nhất; dữ liệu bán hàng không được đồng bộ về Deplao — webhook chỉ dùng để kích hoạt workflow.'),
          tr('Máy nhân viên: Tích hợp nhanh và Test kết nối chạy trên máy Boss (kết nối và khoá API nằm ở Boss) — nhân viên cần quyền <strong class="text-foreground">Tích hợp</strong>; mất kết nối tới Boss thì không tra cứu được.'),
          tr('Tài khoản / ứng dụng dùng để kết nối cần đủ quyền với khách hàng, đơn hàng, sản phẩm — thiếu quyền thì tra cứu báo lỗi.'),
          tr('Sapo: ô mã đơn cần <strong class="text-foreground">ID số của đơn</strong> (xem trong địa chỉ trang chi tiết đơn trên Sapo).'),
          tr('Sửa kết nối: chỉ nhập ô cần đổi — ô bí mật để trống sẽ giữ giá trị cũ — rồi bấm <strong class="text-foreground">Cập nhật</strong> và <strong class="text-foreground">Test kết nối</strong> lại.'),
          tr('Nền tảng báo giới hạn tần suất gọi thì đợi ít phút rồi thử lại.'),
        ]} />
      </Card>
    </div>
  );
}
