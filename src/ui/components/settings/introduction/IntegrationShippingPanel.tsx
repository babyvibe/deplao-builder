import React from 'react';
import { AlertIcon, ClipboardListIcon, DollarIcon, LightbulbIcon, MapPinIcon, PackageIcon, PinIcon, PluginIcon, RepeatIcon, SearchIcon, TruckIcon, WrenchIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

/** Hộp gợi ý — màu ngữ nghĩa nên đúng cả theme Sáng / Tối. */
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
      <LightbulbIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
      <p className="text-xs leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

const CARRIERS: { icon: React.ReactNode; name: string; fields: string[]; hint: React.ReactNode }[] = [
  {
    icon: <PackageIcon className="w-4 h-4" />, name: 'GHN Express',
    fields: ['Token GHN', 'Shop ID', 'Môi trường'],
    hint: <>Lấy Token và Shop ID trong tài khoản GHN. Phần <strong className="text-foreground">Cài đặt → Môi trường</strong>: <em>Production</em> (mặc định) cho đơn thật, <em>Sandbox (test)</em> khi dùng Token môi trường thử nghiệm của GHN. Test kết nối thành công sẽ báo số shop trong tài khoản.</>,
  },
  {
    icon: <TruckIcon className="w-4 h-4" />, name: 'GHTK (Giao Hàng Tiết Kiệm)',
    fields: ['Token GHTK'],
    hint: <>API Token trong tài khoản GHTK. Test kết nối thành công sẽ hiện số dư tài khoản GHTK.</>,
  },
];

const CHAT_ACTIONS = [
  { icon: <SearchIcon className="w-4 h-4" />, name: 'Tra cứu vận đơn', desc: 'GHN: nhập Mã vận đơn GHN; GHTK: nhập Mã tracking GHTK → trạng thái hiện tại của đơn.' },
  { icon: <DollarIcon className="w-4 h-4" />, name: 'Tính phí vận chuyển', desc: 'Ước tính phí ship. GHN: ID quận nhận, trọng lượng (gram), loại dịch vụ; GHTK: tỉnh/TP, quận/huyện nhận, trọng lượng.' },
  { icon: <MapPinIcon className="w-4 h-4" />, name: 'Danh sách tỉnh / quận / phường (GHN)', desc: 'Xem ID địa chỉ theo chuẩn GHN để điền khi tính phí hoặc tạo đơn GHN.' },
  { icon: <TruckIcon className="w-4 h-4" />, name: 'Dịch vụ khả dụng (GHN)', desc: 'Các gói dịch vụ GHN giữa quận gửi và quận nhận.' },
];

export function IntegrationShippingPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><TruckIcon className="w-4 h-4 inline" /> Tích hợp vận chuyển — GHN, GHTK</SectionTitle>
        <Paragraph>
          Kết nối tài khoản GHN Express hoặc Giao Hàng Tiết Kiệm (GHTK) để tra trạng thái vận đơn và ước tính phí ship ngay
          trong hội thoại khi khách hỏi; dùng Workflow để tự trả lời tình trạng đơn hoặc tạo đơn giao hàng.
        </Paragraph>
        <Tip>
          Tạo đơn vận chuyển làm trong Workflow (bước <strong className="text-foreground">GHN: Tạo đơn vận chuyển</strong> /{' '}
          <strong className="text-foreground">GHTK: Tạo đơn vận chuyển</strong>); bảng Tích hợp nhanh trong hội thoại dùng để tra cứu và tính phí.
        </Tip>
      </Card>

      <Card>
        <SectionTitle><ClipboardListIcon className="w-4 h-4 inline" /> Đơn vị hỗ trợ &amp; thông tin cần nhập</SectionTitle>
        <div className="space-y-2">
          {CARRIERS.map(c => (
            <div key={c.name} className="rounded-lg bg-muted p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">{c.icon} {c.name}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {c.fields.map(f => (
                  <span key={f} className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-foreground">{f}</span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{c.hint}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle><WrenchIcon className="w-4 h-4 inline" /> Cách kết nối</SectionTitle>
        <StepList steps={[
          { title: 'Lấy Token', desc: 'Đăng nhập tài khoản GHN / GHTK, lấy Token API (GHN lấy thêm Shop ID).' },
          { title: 'Mở Công cụ → Tích hợp', desc: 'Chọn tab <strong class="text-foreground">Vận chuyển</strong> → bấm <strong class="text-foreground">GHN Express</strong> hoặc <strong class="text-foreground">GHTK</strong>.' },
          { title: 'Nhập thông tin rồi bấm Kết nối', desc: 'Dán Token (GHN: thêm Shop ID và chọn Môi trường), bấm <strong class="text-foreground">Kết nối</strong> để lưu.' },
          { title: 'Bấm Test kết nối', desc: 'Thành công thì thẻ chuyển sang <strong class="text-foreground">Đã kết nối</strong> và đơn vị vận chuyển xuất hiện trong bảng Tích hợp nhanh của hội thoại.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle><PluginIcon className="w-4 h-4 inline" /> Trong hội thoại — Tích hợp nhanh</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {CHAT_ACTIONS.map(a => (
            <div key={a.name} className="rounded-lg bg-muted p-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">{a.icon} {a.name}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{a.desc}</p>
            </div>
          ))}
        </div>
        <Paragraph>
          Mở bằng nút <strong className="text-foreground">Tích hợp nhanh</strong> (hình mắt xích) trên thanh tiêu đề hội thoại →
          chọn GHN / GHTK → chọn thao tác. Thao tác hay dùng (vd. Tra cứu vận đơn) ghim được ra thanh công cụ ô soạn tin.
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle><RepeatIcon className="w-4 h-4 inline" /> Dùng trong Workflow</SectionTitle>
        <Paragraph>
          Nhóm <strong className="text-foreground">Vận chuyển</strong> trong bảng node có: GHN: Tạo đơn vận chuyển, GHN: Tra cứu vận
          đơn, GHN: Danh sách tỉnh/thành, quận/huyện, phường/xã, GHN: Dịch vụ khả dụng, GHTK: Tạo đơn vận chuyển, GHTK: Tra cứu vận đơn.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">GHN: Tạo đơn vận chuyển</strong> — điền Tên người nhận, SĐT người nhận, Địa chỉ giao hàng, ID Quận/Huyện (GHN), Mã Phường/Xã (GHN), Trọng lượng (gram); phần Nâng cao có Loại dịch vụ và Tiền thu hộ COD. Bước này trả về mã vận đơn để gửi cho khách.',
          '<strong class="text-foreground">GHTK: Tạo đơn vận chuyển</strong> — nhập dữ liệu đơn dạng JSON theo mẫu gợi ý trong ô (người gửi, người nhận, khối lượng, tiền thu hộ, danh sách hàng).',
        ]} />
        <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted p-3">
          <p className="text-[11px] font-semibold text-foreground"><PinIcon className="w-4 h-4 inline" /> Ví dụ: khách gửi mã vận đơn → tự trả trạng thái</p>
          <BulletList items={[
            '<strong class="text-foreground">Khi nhận tin nhắn</strong> — đặt <em>Từ khóa kích hoạt</em> và <em>Cách khớp từ khóa</em> (Bắt đầu bằng từ khóa, hoặc Regex theo dạng mã của shop) để chỉ chạy khi khách gửi mã vận đơn.',
            '<strong class="text-foreground">GHN: Tra cứu vận đơn</strong> (hoặc <strong class="text-foreground">GHTK: Tra cứu vận đơn</strong>) — ô mã vận đơn: bấm <em>Chèn biến</em> → Nội dung tin nhắn.',
            '<strong class="text-foreground">Gửi tin nhắn</strong> — gửi lại trạng thái đơn cho khách.',
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle><AlertIcon className="w-4 h-4 inline" /> Lưu ý</SectionTitle>
        <BulletList items={[
          'Phí trong Tích hợp nhanh là ước tính; phí thực tế theo cân nặng, kích thước và dịch vụ khi giao.',
          'ID tỉnh / quận và mã phường của GHN là mã riêng của GHN — tra trong các danh sách GHN, không dùng mã hành chính khác.',
          'Token môi trường thử nghiệm chỉ chạy với Môi trường <strong class="text-foreground">Sandbox (test)</strong>; khi giao thật chọn <strong class="text-foreground">Production</strong>.',
          'Báo lỗi xác thực: lấy Token mới, dán lại, bấm <strong class="text-foreground">Cập nhật</strong> rồi <strong class="text-foreground">Test kết nối</strong>.',
          'Tắt <strong class="text-foreground">Kích hoạt</strong> thì các bước GHN / GHTK trong workflow báo lỗi chưa kết nối.',
        ]} />
      </Card>
    </div>
  );
}
