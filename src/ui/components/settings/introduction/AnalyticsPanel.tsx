import React from 'react';
import {
  BotIcon, CalendarIcon, CampaignIcon, ChartIcon, ChatIcon, ClockIcon, FolderIcon, InfoIcon, LightningIcon,
  SendIcon, SlidersIcon, TagIcon, TrendingUpIcon, UserCheckIcon, UserIcon, UsersIcon,
} from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Metric tile in the 2-column grid: icon + metric name + short description. */
function Tile({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="bg-muted rounded-lg px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-foreground text-[11px] font-semibold">{icon}{title}</p>
      <p className="text-muted-foreground text-[11px] mt-0.5 leading-relaxed">{desc}</p>
    </div>
  );
}

/** Note box (path, how the numbers are calculated). */
function Note({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border border-primary/20 bg-primary/10 rounded-lg px-3 py-2 space-y-1.5">
      {title && <p className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">{title}</p>}
      <div className="text-foreground/80 text-[11px] leading-relaxed">{children}</div>
    </div>
  );
}

export function AnalyticsPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Báo cáo & Phân tích', { 0: <TrendingUpIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Trang Báo cáo tổng hợp hoạt động của các tài khoản thành số liệu và biểu đồ, chia 8 tab:<0> Tổng quan, Tin nhắn, Liên hệ, Nhãn, Nhân viên, Chiến dịch, Workflow, AI</0> - giúp đánh giá tốc độ chăm sóc khách, hiệu quả chiến dịch và tự động hoá.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <Note title={<>{trx('<0/> Cách mở', { 0: <InfoIcon className="w-3.5 h-3.5" /> })}</>}>
          {trx('Thanh bên trái → <0>Báo cáo</0>; trong CRM bấm biểu tượng biểu đồ ở góc phải; hoặc nút<1> Tất cả tính năng</1> → nhóm Báo cáo để mở thẳng từng tab. Nút ? (Hướng dẫn báo cáo) giải thích cách tính của tab đang xem, nút Làm mới tải lại số liệu mới nhất.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Bộ lọc dữ liệu', { 0: <SlidersIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Tài khoản:</strong> chọn một, nhiều tài khoản hoặc Tất cả tài khoản (rê chuột vào một dòng → Chỉ chọn). Lựa chọn được ghi nhớ; lần đầu mặc định là tài khoản đang mở'),
          tr('<strong class="text-foreground">Gộp nhiều tài khoản:</strong> số liệu được cộng lại, tỷ lệ % và trung bình tính lại từ tổng (không lấy trung bình các %); tab Tổng quan có thêm bảng Theo tài khoản'),
          tr('<strong class="text-foreground">Thời gian:</strong> Hôm nay · Hôm qua · 7 ngày · 30 ngày · 90 ngày · Tuỳ chọn (từ ngày → đến ngày). Mặc định 7 ngày'),
          tr('<strong class="text-foreground">Loại hội thoại:</strong> Tất cả · Cá nhân (chat 1-1) · Nhóm - áp dụng cho các số liệu tin nhắn'),
          tr('Không có bộ lọc theo kênh riêng - chọn đúng tài khoản cần xem ở bộ lọc Tài khoản'),
          tr('Tài khoản nào không tải được thì báo cáo vẫn hiện phần còn lại, kèm cảnh báo ghi rõ tài khoản bị thiếu'),
        ]} />
        <Note title={<>{trx('<0/> Cách chia ngày', { 0: <CalendarIcon className="w-3.5 h-3.5" /> })}</>}>
          <BulletList items={[
            tr('Báo cáo chia theo <strong class="text-foreground">ngày lịch trên giờ máy tính</strong>: Hôm nay = từ 00:00 hôm nay đến hiện tại; Hôm qua = trọn ngày hôm qua'),
            tr('7 / 30 / 90 ngày = hôm nay cùng 6 / 29 / 89 ngày trước, tính từ 00:00; mỗi điểm trên biểu đồ là một ngày (00:00–23:59), điểm cuối là hôm nay'),
            tr('Khoảng từ 2 ngày trở xuống vẽ theo giờ, dài hơn vẽ theo ngày; Tuỳ chọn lấy trọn các ngày đã chọn (không chọn được ngày tương lai)'),
          ]} />
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab Tổng quan', { 0: <ChartIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>{tr('Các chỉ số chính trên một màn hình:')}</Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={<ChatIcon className="w-3.5 h-3.5" />} title={tr('Tin nhắn hôm nay')} desc={tr('Gửi · nhận, tăng / giảm so với hôm qua')} />
          <Tile icon={<SendIcon className="w-3.5 h-3.5" />} title={tr('Tổng tin nhắn (kỳ)')} desc={tr('Gửi · nhận trong khoảng thời gian đã chọn')} />
          <Tile icon={<UsersIcon className="w-3.5 h-3.5" />} title={tr('Liên hệ')} desc={tr('Tổng liên hệ, kèm số bạn bè')} />
          <Tile icon={<UsersIcon className="w-3.5 h-3.5" />} title={tr('Nhóm')} desc={tr('Số nhóm đã lưu')} />
          <Tile icon={<CampaignIcon className="w-3.5 h-3.5" />} title={tr('Chiến dịch')} desc={tr('Tổng số và số đang chạy')} />
          <Tile icon={<UserCheckIcon className="w-3.5 h-3.5" />} title={tr('Lời mời KB')} desc={tr('Lời mời kết bạn gửi · nhận trong kỳ')} />
          <Tile icon={<LightningIcon className="w-3.5 h-3.5" />} title={tr('Workflow chạy')} desc={tr('Số lượt chạy và % thành công')} />
          <Tile icon={<BotIcon className="w-3.5 h-3.5" />} title={tr('AI requests')} desc={tr('Số request và tokens (toàn ứng dụng)')} />
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Tin nhắn theo giờ / N ngày qua:</strong> biểu đồ Gửi · Nhận'),
          tr('<strong class="text-foreground">Tăng trưởng liên hệ:</strong> số hội thoại 1-1 theo ngày — mỗi hội thoại tính một lần, vào ngày có tin nhắn đầu tiên trong khoảng thời gian đang chọn'),
          tr('<strong class="text-foreground">Chi tiết theo từng nhãn:</strong> số lượt gắn Nhãn Local trong kỳ'),
          tr('<strong class="text-foreground">Theo tài khoản</strong> (khi chọn từ 2 tài khoản): tin nhắn, gửi, nhận, hôm nay, liên hệ, bạn bè, nhóm và tỷ trọng tin nhắn của từng tài khoản'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab Tin nhắn', { 0: <ChatIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">KPI:</strong> Hôm nay · Tổng tin nhắn (kỳ) · TB/ngày · Tỷ lệ gửi (% tin bạn gửi trên tổng)'),
          tr('<strong class="text-foreground">Thời gian phản hồi:</strong> TB phản hồi · Trung vị · Nhanh nhất · Chậm nhất · số hội thoại có phản hồi - đo từ lúc khách nhắn đến lúc bạn trả lời'),
          tr('<strong class="text-foreground">Phân bổ thời gian phản hồi:</strong> &lt; 1 phút, 1–5 phút, 5–15 phút … &gt; 24 giờ, kèm % tin được phản hồi trong 15 phút'),
          tr('<strong class="text-foreground">Thời gian phản hồi TB theo giờ trong ngày:</strong> chỉ ra giờ trả lời nhanh nhất và chậm nhất'),
          tr('<strong class="text-foreground">Lượng tin nhắn:</strong> Gửi · Nhận · Tổng theo giờ hoặc theo ngày'),
          tr('<strong class="text-foreground">Heatmap giờ cao điểm:</strong> lưới Thứ 2 → Chủ nhật × 24 giờ, ô càng đậm càng nhiều tin - tìm khung giờ khách nhắn nhiều nhất'),
        ]} />
        <Note title={<>{trx('<0/> Cách đo thời gian phản hồi', { 0: <ClockIcon className="w-3.5 h-3.5" /> })}</>}>
          {tr('Chỉ tính chat 1-1 và các lần trả lời trong vòng 7 ngày (bỏ qua hội thoại bị bỏ quên); mục này ẩn khi chọn loại hội thoại Nhóm.')}
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab Liên hệ', { 0: <UsersIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">KPI:</strong> Tổng liên hệ · Bạn bè · Nhóm · Đã gắn tag (kèm số chưa gắn)'),
          tr('<strong class="text-foreground">Tăng trưởng liên hệ:</strong> số hội thoại 1-1 theo ngày, tính vào ngày có tin nhắn đầu tiên trong kỳ'),
          tr('<strong class="text-foreground">Phân loại liên hệ:</strong> biểu đồ tròn Bạn bè · Người lạ · Nhóm'),
          tr('<strong class="text-foreground">Lời mời kết bạn:</strong> số Đã gửi / Đã nhận trong kỳ và biểu đồ theo ngày'),
          tr('Số liên hệ, bạn bè, nhóm là tổng hiện có (không theo khoảng thời gian) và cộng theo từng tài khoản: một người là liên hệ của 2 tài khoản được tính 2 lần'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab Nhãn', { 0: <TagIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Chỉ thống kê <strong class="text-foreground">Nhãn Local</strong> (nhãn tạo trong app), không gồm nhãn Zalo'),
          tr('<strong class="text-foreground">KPI:</strong> Tổng lượt gắn nhãn trong kỳ · Số nhãn sử dụng · TB/ngày'),
          tr('<strong class="text-foreground">Lượt gắn nhãn theo ngày</strong> và <strong class="text-foreground">Chi tiết theo từng nhãn</strong> (mỗi thanh mang màu của nhãn) - xem nhãn nào được dùng nhiều'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab Nhân viên', { 0: <UserIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Dành cho chủ (Boss) theo dõi hiệu suất từng nhân viên trong khoảng thời gian đã chọn. Cần có nhân viên trong <0>Cài đặt → Nhân viên</0>.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={<UsersIcon className="w-3.5 h-3.5" />} title={tr('Nhân viên')} desc={tr('Số nhân viên và số đang hoạt động')} />
          <Tile icon={<ChatIcon className="w-3.5 h-3.5" />} title={tr('Tổng tin gửi')} desc={tr('Tin nhân viên đã gửi trong kỳ')} />
          <Tile icon={<FolderIcon className="w-3.5 h-3.5" />} title={tr('Hội thoại xử lý')} desc={tr('Số hội thoại khác nhau đã xử lý')} />
          <Tile icon={<ClockIcon className="w-3.5 h-3.5" />} title={tr('TB phản hồi')} desc={tr('Thời gian phản hồi trung bình của team')} />
          <Tile icon={<ClockIcon className="w-3.5 h-3.5" />} title={tr('Tổng giờ online')} desc={tr('Kèm số giờ trung bình mỗi nhân viên')} />
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Bộ lọc Nhân viên:</strong> chọn một hoặc nhiều người để so sánh (ảnh, tên, vai trò Boss / Nhân viên), Tất cả để xem cả team'),
          tr('So sánh tin nhắn &amp; hội thoại; Phân bổ tin nhắn và Phân bổ giờ online (biểu đồ tròn)'),
          tr('Tin nhắn theo ngày và Giờ online theo ngày, mỗi nhân viên một màu'),
          tr('Xếp hạng tốc độ phản hồi, Phân bổ thời gian phản hồi (&lt;1m … &gt;24h), Hoạt động theo giờ'),
          tr('So sánh đa chiều (radar): tin gửi, hội thoại, giờ online, tốc độ phản hồi - cần ít nhất 2 nhân viên có dữ liệu'),
          tr('Bảng chi tiết nhân viên có cột Hiệu suất; nút Xuất CSV để gửi báo cáo'),
        ]} />
        <Note title={<>{trx('<0/> Cách tính', { 0: <InfoIcon className="w-3.5 h-3.5" /> })}</>}>
          {tr('Giờ online tính theo phiên đăng nhập của nhân viên (phiên kéo dài qua nhiều ngày được chia đúng theo từng ngày) và không tách theo tài khoản. Khi lọc tài khoản, tin gửi, hội thoại, thời gian phản hồi và hoạt động theo giờ chỉ tính trên các tài khoản đã chọn.')}
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab Chiến dịch', { 0: <CampaignIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">KPI:</strong> Tổng chiến dịch · Đã gửi (kèm Gửi thành công %) · Đã nhận % · Đã xem % · Phản hồi % · Lỗi'),
          tr('<strong class="text-foreground">Đã nhận</strong>: Zalo, Facebook báo đã nhận (Telegram không có). <strong class="text-foreground">Đã xem</strong>: có báo đã xem hoặc khách đã trả lời. <strong class="text-foreground">Phản hồi</strong>: khách nhắn lại sau tin chiến dịch (bỏ tin hệ thống). Tỷ lệ trên số đã gửi, cộng trên mọi chiến dịch'),
          tr('<strong class="text-foreground">Top chiến dịch (theo số gửi):</strong> so sánh Đã gửi · Đã xem · Phản hồi · Lỗi của 10 chiến dịch gửi nhiều nhất'),
          tr('<strong class="text-foreground">Chi tiết chiến dịch:</strong> trạng thái, Tổng, Đã gửi, Đã nhận, Đã xem, Phản hồi, Lỗi; thêm cột Tài khoản khi chọn nhiều tài khoản'),
          tr('Tab này tính trên mọi chiến dịch của tài khoản, không phụ thuộc khoảng thời gian'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab Workflow', { 0: <LightningIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">KPI:</strong> Tổng lượt chạy · Thành công · Lỗi · Tỷ lệ thành công · TB thời gian chạy'),
          tr('<strong class="text-foreground">Lượt chạy theo ngày</strong> (thành công / lỗi) và <strong class="text-foreground">Phân bổ kết quả</strong> - phát hiện sự cố nhanh'),
          tr('<strong class="text-foreground">Top Workflows:</strong> xếp hạng theo lượt chạy, kèm tỷ lệ thành công'),
          tr('Workflow gắn với nhiều tài khoản đã chọn chỉ được tính một lần'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tab AI', { 0: <BotIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">KPI:</strong> Tổng requests · Tổng tokens · Prompt tokens · Completion tokens'),
          tr('<strong class="text-foreground">AI usage theo ngày</strong> (cột = requests, đường = tokens) và <strong class="text-foreground">Phân bổ theo Model</strong>'),
          tr('<strong class="text-foreground">Chi tiết theo Model</strong> (requests, tokens, TB tokens/request) và <strong class="text-foreground">theo AI Assistant</strong> - xem trợ lý nào dùng nhiều token nhất'),
          tr('Số liệu AI tính trên toàn ứng dụng, bộ lọc tài khoản không áp dụng'),
        ]} />
      </Card>
    </div>
  );
}
