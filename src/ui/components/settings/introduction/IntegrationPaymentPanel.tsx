import React from 'react';
import { AlertIcon, ClipboardListIcon, CreditCardIcon, DollarIcon, GlobeIcon, LightbulbIcon, PinIcon, RepeatIcon, WrenchIcon } from '@/components/common/icons';
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

const PLATFORMS: { icon: React.ReactNode; name: string; fields: { label: string; optional?: boolean }[]; hint: string }[] = [
  {
    icon: <CreditCardIcon className="w-4 h-4" />, name: 'Casso',
    fields: [{ label: tr('API Key') }, { label: tr('Secret Key (webhook)'), optional: true }],
    hint: tr('Tạo API Key trong trang quản trị Casso. Test kết nối thành công sẽ hiện tên tài khoản Casso.'),
  },
  {
    icon: <DollarIcon className="w-4 h-4" />, name: 'SePay',
    fields: [{ label: tr('API Key') }, { label: tr('Webhook Secret'), optional: true }],
    hint: tr('Tạo API Key trong trang quản trị SePay. Test kết nối thành công sẽ hiện tên tài khoản SePay.'),
  },
];

export function IntegrationPaymentPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Tích hợp thanh toán — tự nhận biết chuyển khoản', { 0: <CreditCardIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Kết nối Casso hoặc SePay (VietQR) để Deplao nhận thông báo ngay khi tài khoản ngân hàng có giao dịch mới. Mỗi thông báo kích hoạt các workflow có bước <0>Khi nhận thanh toán</0> — tự báo cho nhân viên, ghi sổ Google Sheets… thay vì ngồi soát sao kê.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <Tip>
          {trx('Casso / SePay gửi thông báo qua Internet về máy bạn, nên cần bật địa chỉ <0>Thanh toán, tích hợp</0> ở Cài đặt → Internet & Cloud → Địa chỉ Internet.', { 0: <strong className="text-foreground" /> })}
        </Tip>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Nền tảng hỗ trợ', { 0: <ClipboardListIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="space-y-2">
          {PLATFORMS.map(p => (
            <div key={p.name} className="rounded-lg bg-muted p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">{p.icon} {p.name}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {p.fields.map(f => (
                  <span key={f.label} className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-foreground">
                    {f.label}{f.optional && <span className="text-muted-foreground"> {tr('· có thể để trống')}</span>}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{p.hint}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Địa chỉ Internet để nhận thông báo', { 0: <GlobeIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Deplao chạy trên máy bạn, còn Casso / SePay ở trên Internet nên cần một địa chỉ Internet trỏ về máy. Mọi cấu hình địa chỉ nằm ở một chỗ: <0>Cài đặt → Internet & Cloud → Địa chỉ Internet</0>, mục <1>Cách tạo địa chỉ</1>:', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Cloudflare tự động</strong> (khuyên dùng, cần kết nối tài khoản Cloudflare có tên miền): địa chỉ cố định, không đổi khi khởi động lại — chỉ dán vào Casso / SePay một lần. Bật <strong class="text-foreground">Tự bật khi mở app</strong> để mở Deplao là nhận được ngay.'),
          tr('<strong class="text-foreground">Địa chỉ tạm</strong>: không cần tài khoản (dạng https://….trycloudflare.com) nhưng đổi mỗi lần khởi động lại — phải dán lại vào Casso / SePay. Chỉ nên dùng thử.'),
          tr('<strong class="text-foreground">ngrok</strong> / <strong class="text-foreground">Cloudflare thủ công</strong>: chỉ áp dụng cho Nhân viên và API; địa chỉ nhận thanh toán vẫn là địa chỉ tạm.'),
          tr('Trong bảng địa chỉ của từng dịch vụ, bật dòng <strong class="text-foreground">Thanh toán, tích hợp</strong>. Trừ Cloudflare tự động, dòng này không tự bật khi mở app — mở lại Deplao thì bật lại.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Cách kết nối', { 0: <WrenchIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <StepList steps={[
          { title: tr('Kết nối Casso hoặc SePay'), desc: tr('<strong class="text-foreground">Công cụ → Tích hợp</strong> → tab <strong class="text-foreground">Thanh toán</strong> → chọn <strong class="text-foreground">Casso</strong> hoặc <strong class="text-foreground">SePay</strong>. Dán API Key, bấm <strong class="text-foreground">Kết nối</strong> rồi <strong class="text-foreground">Test kết nối</strong>.') },
          { title: tr('Bật địa chỉ nhận'), desc: tr('Ngay trong trang Casso / SePay, mục <strong class="text-foreground">Địa chỉ nhận webhook</strong>: thẻ báo <strong class="text-foreground">Chưa bật</strong> thì bấm <strong class="text-foreground">Bật ở Cài đặt →</strong> và bật dòng <strong class="text-foreground">Thanh toán, tích hợp</strong>.') },
          { title: tr('Sao chép đúng địa chỉ'), desc: tr('Quay lại trang Casso / SePay, bấm nút sao chép ở thẻ <strong class="text-foreground">Địa chỉ nhận webhook của Casso</strong> (hoặc SePay). Địa chỉ này đã gồm đường dẫn riêng <code class="font-mono text-foreground">/webhook/…</code> của kết nối; đừng dùng dòng “URL local” (chỉ dùng trong máy).') },
          { title: tr('Dán vào Casso / SePay'), desc: tr('Trong trang quản trị Casso / SePay, mở phần cấu hình webhook, dán địa chỉ vừa chép làm địa chỉ nhận rồi lưu.') },
          { title: tr('Chạy thử'), desc: tr('Tạo và bật một workflow có bước <strong class="text-foreground">Khi nhận thanh toán</strong> (ví dụ bên dưới), chuyển khoản thử một khoản nhỏ rồi xem <strong class="text-foreground">Lịch sử chạy</strong> của workflow. Góc phải trang Tích hợp phải báo <strong class="text-foreground">Đang nhận webhook</strong>.') },
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Dùng trong Workflow & hội thoại', { 0: <RepeatIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Khi nhận thanh toán</strong> (nhóm Kích hoạt): chạy mỗi khi có giao dịch; lọc được theo <em>Số tiền tối thiểu (VNĐ)</em> và <em>Nội dung CK chứa từ khóa</em>. Dữ liệu chèn vào các bước sau (nút <em>Chèn biến</em>): Số tiền, Nội dung chuyển khoản, Ngân hàng, Số tài khoản, Mã giao dịch, Thời gian giao dịch.'),
          tr('<strong class="text-foreground">Lấy lịch sử giao dịch</strong> (nhóm Thanh toán): lấy các giao dịch gần nhất từ Casso hoặc SePay để dùng ở bước sau.'),
          tr('Trong hội thoại: <strong class="text-foreground">Tích hợp nhanh</strong> (nút mắt xích trên thanh tiêu đề) → Casso / SePay → <strong class="text-foreground">Lịch sử giao dịch</strong> để xem nhanh giao dịch gần nhất khi khách báo đã chuyển khoản.'),
        ]} />
        <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted p-3">
          <p className="text-[11px] font-semibold text-foreground">{trx('<0/> Ví dụ: có tiền vào → ghi sổ + báo nhóm nội bộ', { 0: <PinIcon className="w-4 h-4 inline" /> })}</p>
          <BulletList items={[
            tr('<strong class="text-foreground">Khi nhận thanh toán</strong> — vd. <em>Nội dung CK chứa từ khóa</em> “DH” để chỉ bắt chuyển khoản cho đơn hàng.'),
            tr('<strong class="text-foreground">Ghi thêm dòng mới</strong> (Google Sheets) — thời gian, số tiền, nội dung chuyển khoản.'),
            tr('<strong class="text-foreground">Gửi tin qua Telegram</strong> hoặc <strong class="text-foreground">Gửi tin nhắn</strong> vào nhóm Zalo nội bộ (chọn ở ô <em>Gửi đến hội thoại</em>) — báo số tiền và nội dung vừa nhận.'),
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Lưu ý', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Deplao phải đang mở và địa chỉ <strong class="text-foreground">Thanh toán, tích hợp</strong> đang chạy thì mới nhận được thông báo.'),
          tr('Thông báo chuyển khoản không cho biết khách nào trên Zalo / Facebook. Bước <strong class="text-foreground">Gửi tin nhắn</strong> sau “Khi nhận thanh toán” phải chọn sẵn hội thoại nhận (vd. nhóm nội bộ).'),
          tr('Dùng địa chỉ tạm: mỗi lần mở lại Deplao phải bật lại địa chỉ và dán địa chỉ mới vào Casso / SePay. Muốn cố định, dùng Cloudflare tự động.'),
          tr('Mỗi kết nối có đường dẫn riêng; xoá kết nối rồi tạo lại thì đường dẫn đổi — nhớ dán lại vào Casso / SePay.'),
          tr('Máy nhân viên không cấu hình địa chỉ Internet — địa chỉ nhận thanh toán do máy chủ quản lý.'),
          tr('Không thấy workflow chạy? Kiểm tra: trang Tích hợp báo “Đang nhận webhook”, địa chỉ trong Casso / SePay khớp địa chỉ đang hiện, workflow đã bật.'),
        ]} />
      </Card>
    </div>
  );
}
