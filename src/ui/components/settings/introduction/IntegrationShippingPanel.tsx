import React from 'react';
import { AlertIcon, ClipboardListIcon, DollarIcon, LightbulbIcon, MapPinIcon, PackageIcon, PinIcon, PluginIcon, RepeatIcon, SearchIcon, TruckIcon, WrenchIcon } from '@/components/common/icons';
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

const CARRIERS: { icon: React.ReactNode; name: string; fields: string[]; hint: React.ReactNode }[] = [
  {
    icon: <PackageIcon className="w-4 h-4" />, name: 'GHN Express',
    fields: ['Token GHN', 'Shop ID', tr('Môi trường')],
    hint: <>{trx('Lấy Token và Shop ID trong tài khoản GHN. Phần <0>Cài đặt → Môi trường</0>: <1>Production</1> (mặc định) cho đơn thật, <2>Sandbox (test)</2> khi dùng Token môi trường thử nghiệm của GHN. Test kết nối thành công sẽ báo số shop trong tài khoản.', { 0: <strong className="text-foreground" />, 1: <em />, 2: <em /> })}</>,
  },
  {
    icon: <TruckIcon className="w-4 h-4" />, name: tr('GHTK (Giao Hàng Tiết Kiệm)'),
    fields: ['Token GHTK', tr('Mã shop (X-Client-Source)')],
    hint: <>{tr('API Token lấy trong trang khách hàng GHTK (Thông tin shop → Cấu hình API). Ô Mã shop không bắt buộc: điền mã shop GHTK (vd S308157) khi GHTK yêu cầu header X-Client-Source.')}</>,
  },
];

const CHAT_ACTIONS = [
  { icon: <SearchIcon className="w-4 h-4" />, name: tr('Tra cứu vận đơn'), desc: tr('GHN: nhập Mã vận đơn GHN; GHTK: nhập Mã tracking GHTK → trạng thái hiện tại của đơn.') },
  { icon: <DollarIcon className="w-4 h-4" />, name: tr('Tính phí vận chuyển'), desc: tr('Ước tính phí ship. GHN: ID quận và mã phường nhận (mã cũ của GHN), trọng lượng (gram), loại dịch vụ; GHTK: tỉnh/TP và phường/xã nơi lấy, nơi nhận, trọng lượng.') },
  { icon: <MapPinIcon className="w-4 h-4" />, name: tr('Danh sách tỉnh / quận / phường (GHN)'), desc: tr('Địa chỉ mới (34 tỉnh, phường/xã): tên dùng khi tạo đơn. Địa chỉ cũ (tỉnh / quận / phường): ID dùng khi tính phí và xem dịch vụ.') },
  { icon: <TruckIcon className="w-4 h-4" />, name: tr('Dịch vụ khả dụng (GHN)'), desc: tr('Các gói dịch vụ GHN giữa quận gửi và quận nhận.') },
];

export function IntegrationShippingPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Tích hợp vận chuyển — GHN, GHTK', { 0: <TruckIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Kết nối tài khoản GHN Express hoặc Giao Hàng Tiết Kiệm (GHTK) để tra trạng thái vận đơn và ước tính phí ship ngay trong hội thoại khi khách hỏi; dùng Workflow để tự trả lời tình trạng đơn hoặc tạo đơn giao hàng.')}
        </Paragraph>
        <Tip>
          {trx('Tạo đơn vận chuyển làm trong Workflow (bước <0>GHN: Tạo đơn vận chuyển</0> / <1>GHTK: Tạo đơn vận chuyển</1>); bảng Tích hợp nhanh trong hội thoại dùng để tra cứu và tính phí.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Tip>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Đơn vị hỗ trợ & thông tin cần nhập', { 0: <ClipboardListIcon className="w-4 h-4 inline" /> })}</SectionTitle>
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
        <SectionTitle>{trx('<0/> Cách kết nối', { 0: <WrenchIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <StepList steps={[
          { title: tr('Lấy Token'), desc: tr('Đăng nhập tài khoản GHN / GHTK, lấy Token API (GHN lấy thêm Shop ID).') },
          { title: tr('Mở Công cụ → Tích hợp'), desc: tr('Chọn tab <strong class="text-foreground">Vận chuyển</strong> → bấm <strong class="text-foreground">GHN Express</strong> hoặc <strong class="text-foreground">GHTK</strong>.') },
          { title: tr('Nhập thông tin rồi bấm Kết nối'), desc: tr('Dán Token (GHN: thêm Shop ID và chọn Môi trường), bấm <strong class="text-foreground">Kết nối</strong> để lưu.') },
          { title: tr('Bấm Test kết nối'), desc: tr('Thành công thì thẻ chuyển sang <strong class="text-foreground">Đã kết nối</strong> và đơn vị vận chuyển xuất hiện trong bảng Tích hợp nhanh của hội thoại.') },
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Trong hội thoại — Tích hợp nhanh', { 0: <PluginIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {CHAT_ACTIONS.map(a => (
            <div key={a.name} className="rounded-lg bg-muted p-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">{a.icon} {a.name}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{a.desc}</p>
            </div>
          ))}
        </div>
        <Paragraph>
          {trx('Mở bằng nút <0>Tích hợp nhanh</0> (hình mắt xích) trên thanh tiêu đề hội thoại → chọn GHN / GHTK → chọn thao tác. Thao tác hay dùng (vd. Tra cứu vận đơn) ghim được ra thanh công cụ ô soạn tin.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Dùng trong Workflow', { 0: <RepeatIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Nhóm <0>Vận chuyển</0> trong bảng node có: GHN: Tạo đơn vận chuyển, GHN: Tra cứu vận đơn, GHN: Danh sách tỉnh/thành, quận/huyện, phường/xã, GHN: Dịch vụ khả dụng, GHTK: Tạo đơn vận chuyển, GHTK: Tra cứu vận đơn.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">GHN: Tạo đơn vận chuyển</strong>: điền Tên người nhận, SĐT người nhận, Địa chỉ giao hàng (số nhà, tên đường), Phường/Xã nhận, Tỉnh/Thành phố nhận, Nội dung hàng hoá, Trọng lượng (gram). Phần Nâng cao có Quận/Huyện (chỉ địa chỉ cũ), Loại dịch vụ, Tiền thu hộ COD, Ghi chú giao hàng, Người trả phí ship. Bước này trả về mã vận đơn để gửi cho khách.'),
          tr('<strong class="text-foreground">GHTK: Tạo đơn vận chuyển</strong>: nhập dữ liệu đơn dạng JSON theo mẫu gợi ý trong ô (người gửi, người nhận, khối lượng, tiền thu hộ, danh sách hàng). GHTK bắt buộc phường/xã, quận/huyện không bắt buộc.'),
        ]} />
        <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted p-3">
          <p className="text-[11px] font-semibold text-foreground">{trx('<0/> Ví dụ: khách gửi mã vận đơn → tự trả trạng thái', { 0: <PinIcon className="w-4 h-4 inline" /> })}</p>
          <BulletList items={[
            tr('<strong class="text-foreground">Khi nhận tin nhắn</strong> — đặt <em>Từ khóa kích hoạt</em> và <em>Cách khớp từ khóa</em> (Bắt đầu bằng từ khóa, hoặc Regex theo dạng mã của shop) để chỉ chạy khi khách gửi mã vận đơn.'),
            tr('<strong class="text-foreground">GHN: Tra cứu vận đơn</strong> (hoặc <strong class="text-foreground">GHTK: Tra cứu vận đơn</strong>) — ô mã vận đơn: bấm <em>Chèn biến</em> → Nội dung tin nhắn.'),
            tr('<strong class="text-foreground">Gửi tin nhắn</strong> — gửi lại trạng thái đơn cho khách.'),
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Lưu ý', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Phí trong Tích hợp nhanh là ước tính; phí thực tế theo cân nặng, kích thước và dịch vụ khi giao.'),
          tr('Tạo đơn GHN theo tên phường/xã và tỉnh: địa chỉ mới sau 01/07/2025 không cần quận/huyện. ID quận và mã phường dùng khi tính phí là mã riêng của GHN: tra trong danh sách cũ của GHN, không dùng mã hành chính khác.'),
          tr('Token môi trường thử nghiệm chỉ chạy với Môi trường <strong class="text-foreground">Sandbox (test)</strong>; khi giao thật chọn <strong class="text-foreground">Production</strong>.'),
          tr('Báo lỗi xác thực: lấy Token mới, dán lại, bấm <strong class="text-foreground">Cập nhật</strong> rồi <strong class="text-foreground">Test kết nối</strong>.'),
          tr('Tắt <strong class="text-foreground">Kích hoạt</strong> thì các bước GHN / GHTK trong workflow báo lỗi chưa kết nối.'),
        ]} />
      </Card>
    </div>
  );
}
