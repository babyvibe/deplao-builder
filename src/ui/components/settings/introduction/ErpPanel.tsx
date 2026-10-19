import React from 'react';
import { BarChartIcon, BellIcon, BriefcaseIcon, CalendarIcon, CheckIcon, FileTextIcon, FolderIcon, InboxIcon, LightbulbIcon, LockIcon } from '@/components/common/icons';
import { Badge, BulletList, Card, Paragraph, SectionTitle } from './introUi';

export function ErpPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <span className="text-primary leading-none mt-0.5"><FolderIcon className="w-6 h-6" /></span>
          <div>
            <SectionTitle>ERP quản trị nội bộ — Quản lý công việc</SectionTitle>
            <Paragraph>
              Giao việc, lịch làm việc, ghi chú nội bộ, nhân sự (chấm công, nghỉ phép) và báo cáo vận hành ngay trong Deplao, dùng chung giữa Boss và nhân viên.
              Mở ở <strong className="text-foreground">Công cụ → Quản lý công việc</strong> trên thanh bên trái, hoặc tìm trong <strong className="text-foreground">Tất cả tính năng</strong> trên thanh tiêu đề.
            </Paragraph>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <Badge text="Của tôi" color="bg-primary/15 text-primary" />
          <Badge text="Task" color="bg-primary/15 text-primary" />
          <Badge text="Lịch" color="bg-info/15 text-info" />
          <Badge text="Note" color="bg-success/15 text-success" />
          <Badge text="Nhân sự" color="bg-warning/15 text-warning" />
          <Badge text="Báo cáo" color="bg-muted text-muted-foreground" />
        </div>
        <Paragraph>
          Nhân viên cần được bật module <strong className="text-foreground">ERP</strong> ở Cài đặt → Nhân viên mới thấy mục này; thay đổi task, lịch, note, chấm công,
          nghỉ phép cập nhật ngay giữa Boss và nhân viên.
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle><InboxIcon className="w-4 h-4 inline" /> Của tôi — việc cần làm của bạn</SectionTitle>
        <BulletList items={[
          'Tổng quan công việc theo khoảng thời gian: Hôm nay, Hôm qua, 7 / 14 ngày qua, 1 tháng qua hoặc tự chọn ngày.',
          'Thẻ đếm <strong class="text-foreground">Cần làm, Đang làm, Đã hoàn thành, Quá hạn</strong>; Boss / quản lý thấy thêm "Chờ xem xét", nhân viên thấy "Sự kiện trong kỳ".',
          'Danh sách task trong giai đoạn (task quá hạn lên đầu), <strong class="text-foreground">Lịch của tôi</strong> với nút "Thêm sự kiện" và khung <strong class="text-foreground">Ưu tiên xử lý</strong> cho việc đã quá hạn.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><CheckIcon className="w-4 h-4 inline" /> Task &amp; giao việc</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Bảng Kanban 5 cột:</strong> Cần làm → Đang làm → Xem xét → Hoàn thành → Huỷ. Kéo thả thẻ để đổi trạng thái (chuyển sang Huỷ sẽ hỏi xác nhận).',
          '<strong class="text-foreground">+ Thêm task</strong> ở cuối mỗi cột; <strong class="text-foreground">+ Tạo dự án</strong> để gom task theo dự án.',
          'Lọc theo dự án, người thực hiện (cả Boss), mức ưu tiên (Thấp / Bình thường / Cao / Khẩn cấp) và hạn chót; bấm "Xóa lọc" để bỏ lọc.',
          'Mở một task để chỉnh dự án, trạng thái, độ ưu tiên, hạn hoàn thành, <strong class="text-foreground">Người thực hiện</strong>, <strong class="text-foreground">Người theo dõi</strong>, nội dung (tiêu đề, danh sách, màu chữ, chèn ảnh) và tệp đính kèm → <strong class="text-foreground">Lưu task</strong>.',
          'Người được giao nhận thông báo; thẻ task trên bảng hiện ảnh người thực hiện và người theo dõi.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><CalendarIcon className="w-4 h-4 inline" /> Lịch làm việc</SectionTitle>
        <BulletList items={[
          'Xem theo <strong class="text-foreground">Tuần / Tháng / Danh sách</strong>, có nút "Hôm nay", chọn tháng hoặc nhảy tới ngày bất kỳ.',
          '<strong class="text-foreground">+ Sự kiện</strong> hoặc nhấp đúp vào một ngày để tạo nhanh (mặc định 9:00–10:00): tiêu đề, giờ bắt đầu, giờ kết thúc (tuỳ chọn), địa điểm, ghi chú.',
          'Bấm vào sự kiện để xem, Sửa hoặc Xoá; ngày có nhiều sự kiện hiện "Xem thêm".',
          'Đang chat với khách? Nút <strong class="text-foreground">+</strong> cạnh ô tìm kiếm hội thoại → <strong class="text-foreground">Thêm lịch hẹn</strong> (Lịch hẹn / Cuộc họp / Nhắc việc, có thể gắn với hội thoại đang mở) hoặc <strong class="text-foreground">Ghi chú nhanh</strong> — lưu thẳng vào Quản lý công việc.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><FileTextIcon className="w-4 h-4 inline" /> Note — ghi chú &amp; tài liệu nội bộ</SectionTitle>
        <BulletList items={[
          'Sắp xếp theo <strong class="text-foreground">thư mục</strong> (tạo, đổi tên, xoá — note trong thư mục bị xoá chuyển về thư mục gốc) và tìm nhanh bằng ô "Tìm note...".',
          'Soạn bằng Markdown, chuyển qua lại <strong class="text-foreground">Preview / Sửa</strong>; nội dung tự lưu khi bạn gõ.',
          'Mặc định <strong class="text-foreground">Riêng tư</strong>. Nút Chia sẻ: "Toàn workspace" (mọi người cùng xem) hoặc "Tuỳ chọn" từng người với quyền Xem / Sửa; người được chia sẻ nhận thông báo.',
          '<strong class="text-foreground">Lịch sử phiên bản</strong> để xem và khôi phục bản cũ của note.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><BriefcaseIcon className="w-4 h-4 inline" /> Nhân sự — hồ sơ, chấm công, nghỉ phép</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Nhân sự:</strong> danh sách kèm phòng ban, chức vụ, số điện thoại và "Biểu đồ cây theo role". Tài khoản đăng nhập dùng chung với Cài đặt → Nhân viên; ERP chỉ bổ sung hồ sơ nội bộ (phòng ban, chức vụ, role ERP, SĐT, email).',
          '<strong class="text-foreground">Phòng ban / Chức vụ:</strong> danh mục để gán nhanh cho hồ sơ nhân sự.',
          '<strong class="text-foreground">Chấm công:</strong> bấm Check-in / Check-out mỗi ngày và xem lại lịch sử; Boss / quản lý xem được cả người khác, lọc theo nhân sự, phòng ban, chức vụ, khoảng ngày.',
          '<strong class="text-foreground">Nghỉ phép:</strong> bấm "+ Tạo đơn" (nghỉ phép năm, nghỉ ốm, nghỉ không lương, khác); đơn hiện ở mục "Đơn chờ duyệt" của Boss để Duyệt / Từ chối, người gửi nhận kết quả qua thông báo.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><LockIcon className="w-4 h-4 inline" /> Vai trò &amp; quyền trong ERP</SectionTitle>
        <Paragraph>
          Boss luôn là <strong className="text-foreground">Owner</strong>. Nhân viên được bật module ERP có role mặc định <strong className="text-foreground">Member</strong>;
          đổi role ở Nhân sự → sửa nhân sự → "Role ERP".
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Member:</strong> tạo / cập nhật task, tự nhận việc, lịch cá nhân, note, chấm công, xin nghỉ phép.',
          '<strong class="text-foreground">Manager:</strong> như Member, cộng thêm giao việc cho người khác, sửa / xoá mọi task, tạo dự án, sửa hồ sơ và xem chấm công của người khác.',
          '<strong class="text-foreground">Admin / Owner:</strong> toàn quyền, quản lý phòng ban, chức vụ, xoá dự án và xem tab Báo cáo.',
          '<strong class="text-foreground">Guest:</strong> chỉ xem.',
          'Cần ngoại lệ? Trong hồ sơ nhân sự, mục <strong class="text-foreground">Quyền action ERP</strong> cho phép ghi đè từng quyền: Kế thừa role / Cho phép riêng / Chặn riêng. Quyền luôn được kiểm tra trên máy Boss.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><BellIcon className="w-4 h-4 inline" /> Thông báo &amp; báo cáo</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Chuông Thông báo ERP</strong> trên thanh tiêu đề: được giao task, task sắp đến hạn (trong 1 giờ tới), task quá hạn (mỗi sáng), note được chia sẻ, kết quả đơn nghỉ phép… Có nút "Đọc hết" và "Xoá hết".',
          '<strong class="text-foreground">Tab Báo cáo</strong> (Owner / Admin): task quá hạn, chưa phân công, sắp đến hạn, đơn nghỉ chờ duyệt, ai chưa check-in hôm nay, ai thiếu hồ sơ ERP; biểu đồ trạng thái, độ ưu tiên, xu hướng task và lịch, chấm công theo ngày.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><LightbulbIcon className="w-4 h-4 inline" /> Khi nào nên dùng?</SectionTitle>
        <BulletList items={[
          'Ghi lại lịch hẹn, ghi chú ngay khi đang chat với khách rồi theo dõi tiếp trong cùng một app.',
          'Boss cần nhìn được <strong class="text-foreground">ai đang làm gì, việc nào sắp quá hạn, ai chưa chấm công</strong>.',
          'Đội nhóm muốn dùng chung một nơi cho task, lịch, tài liệu và nhân sự: chat + CRM + workflow + ERP trong một desktop app.',
        ]} />
      </Card>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground px-1">
        <BarChartIcon className="w-4 h-4 flex-shrink-0" />
        <span>Báo cáo hiệu suất chat của nhân viên (tin gửi, phản hồi, giờ online) nằm ở trang Báo cáo → Nhân viên.</span>
      </div>
    </div>
  );
}
