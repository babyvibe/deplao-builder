import React from 'react';
import { BarChartIcon, BellIcon, BriefcaseIcon, CalendarIcon, CheckIcon, FileTextIcon, FolderIcon, InboxIcon, LightbulbIcon, LockIcon } from '@/components/common/icons';
import { Badge, BulletList, Card, Paragraph, SectionTitle } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export function ErpPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <span className="text-primary leading-none mt-0.5"><FolderIcon className="w-6 h-6" /></span>
          <div>
            <SectionTitle>{tr('ERP quản trị nội bộ — Quản lý công việc')}</SectionTitle>
            <Paragraph>
              {trx('Giao việc, lịch làm việc, ghi chú nội bộ, nhân sự (chấm công, nghỉ phép) và báo cáo vận hành ngay trong Deplao, dùng chung giữa Boss và nhân viên. Mở ở <0>Công cụ → Quản lý công việc</0> trên thanh bên trái, hoặc tìm trong <1>Tất cả tính năng</1> trên thanh tiêu đề.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
            </Paragraph>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <Badge text={tr('Của tôi')} color="bg-primary/15 text-primary" />
          <Badge text={tr('Task')} color="bg-primary/15 text-primary" />
          <Badge text={tr('Lịch')} color="bg-info/15 text-info" />
          <Badge text={tr('Note')} color="bg-success/15 text-success" />
          <Badge text={tr('Nhân sự')} color="bg-warning/15 text-warning" />
          <Badge text={tr('Báo cáo')} color="bg-muted text-muted-foreground" />
        </div>
        <Paragraph>
          {trx('Nhân viên cần được bật module <0>ERP</0> ở Cài đặt → Nhân viên mới thấy mục này; thay đổi task, lịch, note, chấm công, nghỉ phép cập nhật ngay giữa Boss và nhân viên.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Của tôi — việc cần làm của bạn', { 0: <InboxIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Tổng quan công việc theo khoảng thời gian: Hôm nay, Hôm qua, 7 / 14 ngày qua, 1 tháng qua hoặc tự chọn ngày.'),
          tr('Thẻ đếm <strong class="text-foreground">Cần làm, Đang làm, Đã hoàn thành, Quá hạn</strong>; Boss / quản lý thấy thêm "Chờ xem xét", nhân viên thấy "Sự kiện trong kỳ".'),
          tr('Danh sách task trong giai đoạn (task quá hạn lên đầu), <strong class="text-foreground">Lịch của tôi</strong> với nút "Thêm sự kiện" và khung <strong class="text-foreground">Ưu tiên xử lý</strong> cho việc đã quá hạn.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Task & giao việc', { 0: <CheckIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Bảng Kanban 5 cột:</strong> Cần làm → Đang làm → Xem xét → Hoàn thành → Huỷ. Kéo thả thẻ để đổi trạng thái (chuyển sang Huỷ sẽ hỏi xác nhận).'),
          tr('<strong class="text-foreground">+ Thêm task</strong> ở cuối mỗi cột; <strong class="text-foreground">+ Tạo dự án</strong> để gom task theo dự án.'),
          tr('Lọc theo dự án, người thực hiện (cả Boss), mức ưu tiên (Thấp / Bình thường / Cao / Khẩn cấp) và hạn chót; bấm "Xóa lọc" để bỏ lọc.'),
          tr('Mở một task để chỉnh dự án, trạng thái, độ ưu tiên, hạn hoàn thành, <strong class="text-foreground">Người thực hiện</strong>, <strong class="text-foreground">Người theo dõi</strong>, nội dung (tiêu đề, danh sách, màu chữ, chèn ảnh) và tệp đính kèm → <strong class="text-foreground">Lưu task</strong>.'),
          tr('Người được giao nhận thông báo; thẻ task trên bảng hiện ảnh người thực hiện và người theo dõi.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Lịch làm việc', { 0: <CalendarIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Xem theo <strong class="text-foreground">Tuần / Tháng / Danh sách</strong>, có nút "Hôm nay", chọn tháng hoặc nhảy tới ngày bất kỳ.'),
          tr('<strong class="text-foreground">+ Sự kiện</strong> hoặc nhấp đúp vào một ngày để tạo nhanh (mặc định 9:00–10:00): tiêu đề, giờ bắt đầu, giờ kết thúc (tuỳ chọn), địa điểm, ghi chú, <strong class="text-foreground">Nhắc trước</strong> (chọn nhiều mốc: Đúng giờ, 5 phút, 15 phút, 30 phút, 1 giờ, 1 ngày; mặc định 15 phút + đúng giờ).'),
          tr('Bấm vào sự kiện để xem, Sửa hoặc Xoá (lịch thêm từ tin nhắn có thêm Mở hội thoại); ngày có nhiều sự kiện hiện "Xem thêm".'),
          tr('Đang chat với khách? Nút <strong class="text-foreground">+</strong> cạnh ô tìm kiếm hội thoại → <strong class="text-foreground">Thêm lịch hẹn</strong> (Lịch hẹn / Cuộc họp / Nhắc việc, có thể gắn với hội thoại đang mở) hoặc <strong class="text-foreground">Ghi chú nhanh</strong> — lưu thẳng vào Quản lý công việc.'),
          tr('Từ tin nhắn: tin có ngày giờ sắp tới ("mai 9h", "20 phút nữa", "thứ 6", "20/11 14:00") hiện nút <strong class="text-foreground">Tạo lịch hẹn</strong> ngay dưới tin, bấm là điền sẵn ngày giờ (tin chỉ có ngày thì bạn chọn giờ). Hoặc chuột phải một tin (hoặc chọn nhiều tin) → <strong class="text-foreground">Tạo task</strong> / <strong class="text-foreground">Thêm vào lịch</strong> / <strong class="text-foreground">Lưu vào ghi chú</strong>. Ngày giờ tính từ lúc tin được gửi, ghi chú là nội dung tin, lịch gắn với hội thoại và đúng tin đó. Tạo task: chữ và ảnh của tin thành nội dung task, ngày giờ trong tin thành hạn hoàn thành.'),
          tr('Nhắc trước (15 phút, 1 giờ…): chuông trên thanh tiêu đề rung và hiện <strong class="text-foreground">15 phút nữa tới lịch hẹn</strong> (đếm ngược tới giờ hẹn), đang dùng app thì có thêm thông báo nổi; thông báo nằm trong chuông như thông báo thường, bấm vào là đã đọc và mở hội thoại của lịch (không có thì mở Lịch).'),
          tr('Chuông → tab <strong class="text-foreground">Lịch sắp tới</strong>: lịch của bạn trong 7 ngày tới (đang diễn ra, còn bao lâu, mốc nhắc của từng lịch); bấm lịch để mở hội thoại của lịch hoặc trang Lịch.'),
          tr('Đúng giờ hẹn: popup <strong class="text-foreground">Đến giờ hẹn!</strong> như nhắc hẹn Zalo, có nhạc, ghi chú và nút Mở hội thoại (về đúng tin) hoặc Xem lịch; app đang ở nền thì có thêm thông báo của Windows / macOS. Chỉ nhắc lịch của bạn (người tạo hoặc được mời); lịch đã qua lâu (máy tắt lúc tới giờ) chỉ báo "Đã lỡ lịch".'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Note — ghi chú & tài liệu nội bộ', { 0: <FileTextIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Sắp xếp theo <strong class="text-foreground">thư mục</strong> (tạo, đổi tên, xoá — note trong thư mục bị xoá chuyển về thư mục gốc) và tìm nhanh bằng ô "Tìm note...".'),
          tr('Soạn bằng Markdown, chuyển qua lại <strong class="text-foreground">Preview / Sửa</strong>; nội dung tự lưu khi bạn gõ.'),
          tr('Mặc định <strong class="text-foreground">Riêng tư</strong>. Nút Chia sẻ: "Toàn workspace" (mọi người cùng xem) hoặc "Tuỳ chọn" từng người với quyền Xem / Sửa; người được chia sẻ nhận thông báo.'),
          tr('<strong class="text-foreground">Lịch sử phiên bản</strong> để xem và khôi phục bản cũ của note.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Nhân sự — hồ sơ, chấm công, nghỉ phép', { 0: <BriefcaseIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Nhân sự:</strong> danh sách kèm phòng ban, chức vụ, số điện thoại và "Biểu đồ cây theo role". Tài khoản đăng nhập dùng chung với Cài đặt → Nhân viên; ERP chỉ bổ sung hồ sơ nội bộ (phòng ban, chức vụ, role ERP, SĐT, email).'),
          tr('<strong class="text-foreground">Phòng ban / Chức vụ:</strong> danh mục để gán nhanh cho hồ sơ nhân sự.'),
          tr('<strong class="text-foreground">Chấm công:</strong> bấm Check-in / Check-out mỗi ngày và xem lại lịch sử; Boss / quản lý xem được cả người khác, lọc theo nhân sự, phòng ban, chức vụ, khoảng ngày.'),
          tr('<strong class="text-foreground">Nghỉ phép:</strong> bấm "+ Tạo đơn" (nghỉ phép năm, nghỉ ốm, nghỉ không lương, khác); đơn hiện ở mục "Đơn chờ duyệt" của Boss để Duyệt / Từ chối, người gửi nhận kết quả qua thông báo.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Vai trò & quyền trong ERP', { 0: <LockIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Boss luôn là <0>Owner</0>. Nhân viên được bật module ERP có role mặc định <1>Member</1>; đổi role ở Nhân sự → sửa nhân sự → "Role ERP".', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Member:</strong> tạo / cập nhật task, tự nhận việc, lịch cá nhân, note, chấm công, xin nghỉ phép.'),
          tr('<strong class="text-foreground">Manager:</strong> như Member, cộng thêm giao việc cho người khác, sửa / xoá mọi task, tạo dự án, sửa hồ sơ và xem chấm công của người khác.'),
          tr('<strong class="text-foreground">Admin / Owner:</strong> toàn quyền, quản lý phòng ban, chức vụ, xoá dự án và xem tab Báo cáo.'),
          tr('<strong class="text-foreground">Guest:</strong> chỉ xem.'),
          tr('Cần ngoại lệ? Trong hồ sơ nhân sự, mục <strong class="text-foreground">Quyền action ERP</strong> cho phép ghi đè từng quyền: Kế thừa role / Cho phép riêng / Chặn riêng. Quyền luôn được kiểm tra trên máy Boss.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Thông báo & báo cáo', { 0: <BellIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Chuông Thông báo ERP</strong> trên thanh tiêu đề: được giao task, task sắp đến hạn (trong 1 giờ tới), task quá hạn (mỗi sáng), note được chia sẻ, kết quả đơn nghỉ phép… Có nút "Đọc hết" và "Xoá hết".'),
          tr('<strong class="text-foreground">Thông báo qua Zalo</strong> (tab Cài đặt, Owner / Admin): chọn một tài khoản Zalo của cửa hàng và loại thông báo, nhân viên nhận thêm tin Zalo theo SĐT trong hồ sơ Nhân sự. Gửi lần lượt cách nhau 5 - 10 giây, mỗi người tối đa 30 tin/ngày; bấm "Gửi thử" để kiểm tra từng người. Nhân viên nên kết bạn Zalo với tài khoản gửi để tin không bị chặn.'),
          tr('<strong class="text-foreground">Tab Báo cáo</strong> (Owner / Admin): task quá hạn, chưa phân công, sắp đến hạn, đơn nghỉ chờ duyệt, ai chưa check-in hôm nay, ai thiếu hồ sơ ERP; biểu đồ trạng thái, độ ưu tiên, xu hướng task và lịch, chấm công theo ngày.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Khi nào nên dùng?', { 0: <LightbulbIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Ghi lại lịch hẹn, ghi chú ngay khi đang chat với khách rồi theo dõi tiếp trong cùng một app.'),
          tr('Boss cần nhìn được <strong class="text-foreground">ai đang làm gì, việc nào sắp quá hạn, ai chưa chấm công</strong>.'),
          tr('Đội nhóm muốn dùng chung một nơi cho task, lịch, tài liệu và nhân sự: chat + CRM + workflow + ERP trong một desktop app.'),
        ]} />
      </Card>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1">
        <BarChartIcon className="w-4 h-4 flex-shrink-0" />
        <span>{tr('Báo cáo hiệu suất chat của nhân viên (tin gửi, phản hồi, giờ online) nằm ở trang Báo cáo → Nhân viên.')}</span>
      </div>
    </div>
  );
}
