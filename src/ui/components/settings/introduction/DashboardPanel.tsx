import React from 'react';
import { DashboardIcon, DownloadIcon, InfoIcon, UserIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// Status dot color on the account card (AccountCard): uses color tokens so it works in both the Light and Dark themes.
const STATUS_LEGEND: { dot: string; label: string; desc: string }[] = [
  { dot: 'bg-success', label: tr('Online'), desc: tr('Đang kết nối, nhận tin bình thường') },
  { dot: 'bg-warning animate-pulse', label: tr('Đang kết nối'), desc: tr('App đang kết nối tài khoản') },
  { dot: 'bg-muted-foreground/40', label: tr('Offline'), desc: tr('Đã ngắt kết nối hoặc chưa kết nối') },
  { dot: 'bg-destructive animate-pulse', label: tr('Mất kết nối nhận tin'), desc: tr('Thẻ viền đỏ, có biểu tượng cảnh báo') },
];

export function DashboardPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Dashboard - Quản lý tài khoản', { 0: <DashboardIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Dashboard là trang mở ra đầu tiên khi vào app (mục <0>Dashboard</0> ở thanh bên trái). Mỗi tài khoản Zalo, Facebook, Telegram, Telegram Bot là một thẻ, kèm trạng thái kết nối và các thao tác nhanh.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Thanh công cụ:</strong> số tài khoản; nút <em>Thêm tài khoản</em>; <em>Gộp tài khoản</em> (khi có từ 2 tài khoản); <em>Thêm workspace</em> (mở Cài đặt → Workspace); <em>Hỗ trợ, báo lỗi</em> (mở trang GitHub của Deplao).'),
          tr('<strong class="text-foreground">Tìm kiếm:</strong> ô <em>Tên, SĐT, UID...</em> lọc thẻ theo tên, số điện thoại hoặc UID.'),
          tr('<strong class="text-foreground">Sắp xếp:</strong> kéo thả thẻ để đổi thứ tự - thứ tự này dùng chung với danh sách avatar ở thanh bên trái (ở đó cũng kéo thả được).'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Thẻ tài khoản & trạng thái', { 0: <UserIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {STATUS_LEGEND.map((s) => (
            <div key={s.label} className="flex items-start gap-2 bg-muted rounded-lg px-2.5 py-2">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1 ${s.dot}`} />
              <div className="min-w-0">
                <p className="text-foreground text-[11px] font-medium">{s.label}</p>
                <p className="text-muted-foreground text-[11px] mt-0.5">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Thông tin trên thẻ:</strong> ảnh đại diện kèm biểu tượng kênh và chấm trạng thái, tên, UID (bấm để sao chép), số điện thoại hoặc @username.'),
          tr('<strong class="text-foreground">Nút nhanh:</strong> <em>Chat</em> mở hội thoại của tài khoản; <em>Ngắt kết nối</em> dừng nhận tin (tài khoản chuyển Offline); <em>Kết nối lại</em> để nhận tin trở lại.'),
          tr('<strong class="text-foreground">Menu ⋮:</strong> <em>Cập nhật thông tin</em> (Zalo: số điện thoại · Facebook: tên, ảnh · Telegram: ảnh đại diện), <em>Mở Chat</em>, <em>Copy UID</em>, <em>Xóa tài khoản</em>.'),
          tr('<strong class="text-foreground">Mất kết nối nhận tin:</strong> nút Chat tạm ẩn, thay bằng <em>Reconnect</em> và <em>Quét QR mới</em> (Zalo) hoặc <em>Đăng nhập lại</em> (Facebook, Telegram). Đăng nhập lại đúng tài khoản cũ thì dữ liệu chat được giữ - xem chi tiết ở mục Đa tài khoản.'),
          tr('<strong class="text-foreground">Xóa tài khoản:</strong> gỡ tài khoản khỏi app nhưng giữ tin nhắn, hội thoại và dữ liệu CRM trên máy (mọi kênh); muốn dùng lại thì đăng nhập lại đúng tài khoản đó. Muốn xoá cả dữ liệu, hãy xoá ở Cài đặt → Tài khoản → <em>Xóa</em> → <em>Xoá tất cả dữ liệu</em> (xoá vĩnh viễn, không khôi phục được).'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Xuất dữ liệu ra file', { 0: <DownloadIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Dashboard không có nút xuất dữ liệu. Danh sách được xuất ra file CSV (mở được bằng Excel) ở các màn sau:')}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">CRM → Liên hệ → Xuất CSV:</strong> toàn bộ liên hệ theo bộ lọc đang chọn - tên, biệt danh, số điện thoại, UID, loại, giới tính, sinh nhật, thời điểm tin nhắn cuối, số ghi chú.'),
          tr('<strong class="text-foreground">CRM → Nhóm:</strong> nút <em>Xuất danh sách</em> thành viên của nhóm đang xem.'),
          tr('<strong class="text-foreground">CRM → Chiến dịch:</strong> mở chi tiết một chiến dịch → nút xuất danh sách liên hệ của chiến dịch ra CSV.'),
          tr('<strong class="text-foreground">Báo cáo → Nhân viên → Xuất CSV:</strong> số liệu làm việc của từng nhân viên.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tình huống khác', { 0: <InfoIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Chưa có tài khoản:</strong> Dashboard hiện nút <em>+ Thêm tài khoản</em>, <em>Đăng nhập dành cho nhân viên</em> (nhập địa chỉ máy Boss, tên đăng nhập và mật khẩu do quản lý cấp) và <em>Khôi phục dữ liệu từ Cloudflare</em> (khi chuyển từ máy khác đã bật sao lưu).'),
          tr('<strong class="text-foreground">Máy nhân viên:</strong> chỉ thấy các tài khoản được giao; thẻ chỉ có nút Chat (không ngắt kết nối, xoá hay kéo thả). Chưa được giao tài khoản nào thì hiện <em>Chưa có trang nào được quản lý</em> - liên hệ Boss để được gán.'),
          tr('<strong class="text-foreground">Boss giả lập nhân viên</strong> (từ Cài đặt → Nhân viên): Dashboard hiện nhãn <em>Giả lập: tên nhân viên</em> và chỉ các tài khoản giao cho người đó.'),
          tr('<strong class="text-foreground">Sau khi khôi phục dữ liệu</strong> từ bản sao lưu: Dashboard báo <em>Đã khôi phục dữ liệu</em> - chiến dịch, workflow và lịch đang tạm dừng để không gửi trùng với máy cũ. Chỉ bấm <em>Bật lại tự động hoá</em> khi máy cũ đã tắt hoặc đã ngắt Deplao; kênh nào cần đăng nhập lại thì làm trên thẻ của tài khoản đó.'),
        ]} />
      </Card>
    </div>
  );
}
