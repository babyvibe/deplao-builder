import React from 'react';
import {
  AlertIcon, CalendarIcon, CampaignIcon, ChatIcon, ClockIcon, CloudIcon, DatabaseIcon, EditIcon, GiftIcon,
  HardDriveIcon, ImageIcon, InfoIcon, SearchIcon, ShieldIcon, ShuffleIcon, TagIcon, TrendingUpIcon, UserPlusIcon,
  UsersIcon,
} from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

/** Ô nhỏ trong lưới 2 cột: biểu tượng + tiêu đề + mô tả ngắn. */
function Tile({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="bg-muted rounded-lg px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-foreground text-[11px] font-semibold">{icon}{title}</p>
      <p className="text-muted-foreground text-[11px] mt-0.5 leading-relaxed">{desc}</p>
    </div>
  );
}

/** Khung ghi chú: info = đường dẫn / mẹo, warning = lưu ý an toàn. */
function Note({ tone = 'info', title, children }: { tone?: 'info' | 'warning'; title?: React.ReactNode; children: React.ReactNode }) {
  const box = tone === 'warning' ? 'bg-warning/10 border-warning/30' : 'bg-primary/10 border-primary/20';
  const head = tone === 'warning' ? 'text-warning' : 'text-primary';
  return (
    <div className={`border rounded-lg px-3 py-2 space-y-1.5 ${box}`}>
      {title && <p className={`flex items-center gap-1.5 text-[11px] font-semibold ${head}`}>{title}</p>}
      <div className="text-foreground/80 text-[11px] leading-relaxed">{children}</div>
    </div>
  );
}

export function CrmPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><UsersIcon className="w-4 h-4 inline" /> CRM & Khách hàng - Tổng quan</SectionTitle>
        <Paragraph>
          CRM gom khách hàng của từng tài khoản (bạn bè, người chưa kết bạn và các nhóm) vào một nơi để
          <strong className="text-foreground"> lọc, gắn nhãn, ghi chú, chăm sóc theo dịp</strong> và
          <strong className="text-foreground"> gửi chiến dịch hàng loạt</strong> có giãn cách.
        </Paragraph>
        <Note title={<><InfoIcon className="w-3.5 h-3.5" /> Cách mở</>}>
          Thanh bên trái → <strong className="text-foreground">CRM</strong>, hoặc nút <strong className="text-foreground">Tất cả tính năng</strong> trên
          thanh trên cùng → nhóm CRM. Chọn tài khoản cần làm việc ở góc phải phía trên; biểu tượng biểu đồ bên cạnh mở trang Báo cáo.
        </Note>
        <BulletList items={[
          '<strong class="text-foreground">Zalo:</strong> Tìm kiếm · Liên hệ · Nhóm · Lời mời · Chiến dịch · Lịch sử',
          '<strong class="text-foreground">Telegram (tài khoản cá nhân và Bot):</strong> Liên hệ · Nhóm · Chiến dịch · Lịch sử',
          '<strong class="text-foreground">Facebook:</strong> Liên hệ · Quét dữ liệu · Lịch sử quét · Thống kê',
          '<strong class="text-foreground">Tìm kiếm</strong> (Zalo): nhập số điện thoại để tìm người dùng và gửi kết bạn; bên dưới có danh sách Gợi ý kết bạn',
          '<strong class="text-foreground">Lời mời</strong> (Zalo): lời mời kết bạn Nhận được / Đã gửi - chấp nhận, từ chối hoặc huỷ; chấm đỏ báo có lời mời mới',
        ]} />
      </Card>

      <Card>
        <SectionTitle><SearchIcon className="w-4 h-4 inline" /> Danh sách liên hệ & bộ lọc</SectionTitle>
        <Paragraph>
          Tab <strong className="text-foreground">Liên hệ</strong> liệt kê bạn bè, người chưa kết bạn và nhóm của tài khoản đang chọn,
          kèm nhãn, giới tính, sinh nhật, số điện thoại và ngày nhắn tin gần nhất.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Tìm kiếm:</strong> theo tên, biệt danh, số điện thoại hoặc UID',
          '<strong class="text-foreground">Nhãn:</strong> lọc theo một hoặc nhiều Nhãn Local; tài khoản Zalo có thêm tab nhãn Zalo',
          '<strong class="text-foreground">Loại:</strong> Bạn bè · Chưa là bạn bè · Nhóm · Có SĐT · Có ghi chú (Bạn bè / Chưa là bạn bè chỉ có ở Zalo)',
          '<strong class="text-foreground">Giới tính</strong> và <strong class="text-foreground">Sinh nhật</strong> (Zalo): Nam · Nữ · Không xác định; Hôm nay · Tuần này · Tháng này · Có ngày sinh · Chưa có',
          '<strong class="text-foreground">Sắp xếp:</strong> Tên A → Z, Tên Z → A, Tin nhắn gần nhất',
          'Mọi bộ lọc áp dụng trên <strong class="text-foreground">toàn bộ danh sách</strong> (không chỉ trang đang xem): số liên hệ và phân trang tính theo kết quả lọc',
          '<strong class="text-foreground">Thao tác:</strong> Xuất CSV toàn bộ liên hệ khớp bộ lọc và tìm kiếm đang chọn (mở được bằng Excel); Thêm liên hệ theo SĐT (Zalo)',
          '<strong class="text-foreground">Chọn nhiều:</strong> tick từng dòng hoặc nút Trang này → thanh thao tác: Thêm vào chiến dịch · Nhãn Local · Khác → Nhãn Zalo, Rời nhóm đã chọn (Zalo)',
          'Bấm một dòng để mở hồ sơ, bấm ảnh đại diện để xem nhanh, biểu tượng tin nhắn để chat ngay',
        ]} />
      </Card>

      <Card>
        <SectionTitle><EditIcon className="w-4 h-4 inline" /> Hồ sơ khách hàng & ghi chú nội bộ</SectionTitle>
        <Paragraph>
          Bấm một liên hệ để mở panel hồ sơ bên phải, gồm 2 tab <strong className="text-foreground">Nhãn/Ghi chú</strong> và
          <strong className="text-foreground"> Lịch sử gửi tin</strong>.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Thông tin liên hệ:</strong> bấm Sửa để nhập Điện thoại, Giới tính, Sinh nhật (mọi kênh). Với Zalo, số điện thoại, giới tính, ngày sinh được lấy từ hồ sơ Zalo khi có',
          '<strong class="text-foreground">Ghi chú nội bộ:</strong> thêm, sửa, xoá ghi chú cho từng khách (khách không nhìn thấy), mỗi ghi chú kèm thời gian. Nhóm Zalo có thêm tab Zalo để xem ghi chú của nhóm (chỉ đọc)',
          '<strong class="text-foreground">Nhãn:</strong> chọn Nhãn Local (gắn được nhiều nhãn) và Nhãn Zalo (1 nhãn, bấm Lưu nhãn)',
          '<strong class="text-foreground">Lịch sử gửi tin:</strong> các lần chiến dịch đã gửi cho khách, trạng thái Đã gửi / Thất bại kèm lỗi',
          '<strong class="text-foreground">Đồng bộ:</strong> khi thêm tài khoản Zalo, app tự tải danh sách bạn bè, nhãn, tin nhắn nhanh và nhóm (bảng Đang khởi tạo tài khoản); tên và ảnh đại diện Zalo bị cũ hoặc lỗi được tự làm mới khi mở CRM',
          '<strong class="text-foreground">Thêm liên hệ theo SĐT</strong> (Zalo, menu Thao tác): dán danh sách số (mỗi dòng 1 số) → Tra cứu → gắn nhãn tuỳ chọn → Thêm vào liên hệ',
        ]} />
        <Note tone="warning" title={<><AlertIcon className="w-3.5 h-3.5" /> Giới hạn tra cứu số điện thoại</>}>
          Zalo hạn chế tìm kiếm số điện thoại theo ngày: nên tra tối đa 30 số mỗi giờ và không quá 100–200 số mỗi ngày.
        </Note>
      </Card>

      <Card>
        <SectionTitle><TagIcon className="w-4 h-4 inline" /> Nhãn Zalo & Nhãn Local</SectionTitle>
        <Paragraph>
          Hai loại nhãn dùng song song để phân nhóm khách, lọc danh sách và chọn người nhận chiến dịch.
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-muted rounded-lg p-2.5 space-y-1.5">
            <p className="flex items-center gap-1.5 text-foreground text-[11px] font-semibold"><CloudIcon className="w-3.5 h-3.5" /> Nhãn Zalo</p>
            <BulletList items={[
              'Đồng bộ hai chiều với Zalo: gán trong app thì hiện trên Zalo điện thoại và ngược lại',
              'Mỗi hội thoại chỉ gắn được 1 nhãn Zalo',
              'Số lượng nhãn do Zalo giới hạn',
              'Chỉ có ở tài khoản Zalo',
            ]} />
          </div>
          <div className="bg-muted rounded-lg p-2.5 space-y-1.5">
            <p className="flex items-center gap-1.5 text-foreground text-[11px] font-semibold"><HardDriveIcon className="w-3.5 h-3.5" /> Nhãn Local (khuyến nghị)</p>
            <BulletList items={[
              'Không giới hạn số nhãn; một hội thoại gắn được nhiều nhãn',
              'Dùng chung cho nhiều tài khoản Zalo, Facebook, Telegram',
              'Tuỳ chỉnh màu, emoji, thứ tự, phím tắt',
              'Chỉ có trong Deplao, không hiện trên điện thoại',
            ]} />
          </div>
        </div>
        <BulletList items={[
          '<strong class="text-foreground">Quản lý:</strong> Cài đặt → Hội thoại → Quản lý nhãn. Tab Local: Thêm nhãn, chọn tài khoản dùng nhãn, bật / tắt, kéo để sắp xếp, Sao chép toàn bộ Nhãn Local từ tài khoản này sang tài khoản khác',
          '<strong class="text-foreground">Tab Zalo</strong> (chọn đúng 1 tài khoản đang kết nối): sửa, xoá, thêm nhãn và lưu thẳng lên Zalo; Đồng bộ về Local để chép nhãn Zalo thành Nhãn Local (Thêm vào hoặc Thay thế hoàn toàn)',
          '<strong class="text-foreground">Gắn nhãn:</strong> trong hồ sơ liên hệ, chọn nhiều liên hệ → Nhãn Local / Khác → Nhãn Zalo, hoặc ngay trên khung chat',
          '<strong class="text-foreground">Tự động hoá:</strong> Workflow có trigger Khi gán hoặc gỡ nhãn và hành động Gắn nhãn hội thoại (Zalo)',
        ]} />
      </Card>

      <Card>
        <SectionTitle><GiftIcon className="w-4 h-4 inline" /> Chăm sóc khách theo giới tính, sinh nhật & tương tác cuối</SectionTitle>
        <Paragraph>
          Kết hợp bộ lọc của tab Liên hệ với chiến dịch để <strong className="text-foreground">gửi đúng người, đúng dịp</strong>:
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={<GiftIcon className="w-3.5 h-3.5" />} title="Chúc mừng sinh nhật"
            desc="Sinh nhật → Hôm nay (hoặc Tuần này) → gửi lời chúc kèm ưu đãi, chèn {name} để gọi tên khách." />
          <Tile icon={<CalendarIcon className="w-3.5 h-3.5" />} title="Ưu đãi tháng sinh"
            desc="Đầu tháng lọc Sinh nhật → Tháng này để gửi quà cho khách sinh trong tháng." />
          <Tile icon={<UsersIcon className="w-3.5 h-3.5" />} title="Theo giới tính"
            desc="Dịp 8/3, 20/10 lọc Giới tính → Nữ; dịp dành cho nam lọc Nam." />
          <Tile icon={<ClockIcon className="w-3.5 h-3.5" />} title="Kéo lại khách cũ"
            desc="Sắp xếp Tin nhắn gần nhất: cột Tin nhắn cho biết lần nhắn cuối, khách lâu chưa tương tác nằm cuối danh sách." />
        </div>
        <Note title={<><InfoIcon className="w-3.5 h-3.5" /> Cách dùng</>}>
          CRM → Liên hệ → chọn bộ lọc (Sinh nhật, Giới tính, Nhãn, Loại) → tick Trang này hoặc từng người →
          <strong className="text-foreground"> Thêm vào chiến dịch</strong> → chọn chiến dịch có sẵn hoặc Tạo mới → mở chiến dịch và bấm Bắt đầu.
          Bộ lọc Giới tính / Sinh nhật chỉ có với tài khoản Zalo. Trong chiến dịch, Thêm liên hệ → Theo nhãn chọn người nhận theo nhãn trên toàn bộ danh sách liên hệ.
        </Note>
      </Card>

      <Card>
        <SectionTitle><UsersIcon className="w-4 h-4 inline" /> Nhóm & thành viên nhóm</SectionTitle>
        <Paragraph>
          Tab <strong className="text-foreground">Nhóm</strong> của Zalo có 2 phần: <strong className="text-foreground">Thành viên nhóm</strong> và
          <strong className="text-foreground"> Quét thành viên</strong> (xem mục bên dưới).
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Danh sách nhóm</strong> lấy từ hội thoại; menu ⋮ → Tải toàn bộ nhóm từ Zalo (đồng bộ nhóm và chi tiết thành viên, có tiến độ) hoặc Join nhóm theo link',
          'Chọn một nhóm → <strong class="text-foreground">Tải thông tin thành viên</strong>: tên, UID, số điện thoại (nếu có), vai trò Trưởng nhóm / Phó nhóm; Tìm thành viên, Chọn tất cả, Xuất danh sách (CSV)',
          'Chọn thành viên → <strong class="text-foreground">Thêm vào chiến dịch</strong> hoặc <strong class="text-foreground">Thêm vào liên hệ</strong> (kèm gắn nhãn tuỳ chọn)',
          '<strong class="text-foreground">Telegram:</strong> tab Nhóm liệt kê nhóm, siêu nhóm, diễn đàn đã đồng bộ để chọn thành viên đưa vào chiến dịch Telegram; Telegram Bot không có danh sách thành viên đầy đủ',
        ]} />
      </Card>

      <Card>
        <SectionTitle><SearchIcon className="w-4 h-4 inline" /> Quét thành viên nhóm (Zalo)</SectionTitle>
        <Paragraph>
          Lấy danh sách thành viên của nhóm Zalo từ link mời, <strong className="text-foreground">kể cả nhóm đã ẩn danh sách thành viên</strong> hoặc
          <strong className="text-foreground"> nhóm bạn đang chờ duyệt</strong>. Kết quả (tên, ảnh đại diện, UID) được lưu vào CRM để kết bạn,
          nhắn tin hoặc mời vào nhóm qua chiến dịch.
        </Paragraph>
        <StepList steps={[
          { title: 'Dán link nhóm', desc: 'CRM → Nhóm → <strong class="text-foreground">Quét thành viên</strong>, dán link nhóm Zalo (dạng https://zalo.me/g/…) hoặc Group ID dạng số.' },
          { title: 'Tham gia nếu chưa là thành viên', desc: 'Bấm <strong class="text-foreground">Tham gia</strong>; kết quả hiện ngay bên dưới: Đã tham gia, Đã là thành viên, Đang chờ duyệt hoặc Nhóm đã đủ thành viên. Nhóm bật duyệt thành viên sẽ nhận yêu cầu chờ duyệt - đang chờ duyệt là quét được, không cần đợi admin.' },
          { title: 'Quét', desc: 'Bấm <strong class="text-foreground">Quét</strong>. Xong sẽ báo số thành viên và lưu vào tab Thành viên nhóm (nút Xem trong tab Thành viên).' },
          { title: 'Dùng kết quả', desc: 'Chọn thành viên → <strong class="text-foreground">Thêm vào chiến dịch</strong> (kết bạn, nhắn tin, mời vào nhóm) hoặc <strong class="text-foreground">Thêm vào liên hệ</strong>.' },
        ]} />
        <Note tone="warning" title={<><AlertIcon className="w-3.5 h-3.5" /> Lưu ý</>}>
          <BulletList items={[
            'Với nhóm chưa tham gia, cần ít nhất ở trạng thái chờ duyệt; nhóm tắt chế độ chờ duyệt thì không quét được',
            'UID thành viên không dùng chung được giữa các tài khoản (chính sách của Zalo) - hãy quét bằng chính tài khoản sẽ gửi chiến dịch',
            'Nút Chia sẻ gửi nhóm lên kho Nhóm chung của cộng đồng (chờ admin duyệt); Khám phá kho nhóm chung để tìm nhóm có sẵn theo danh mục',
            'Quét và gửi ở mức vừa phải để tài khoản Zalo không bị hạn chế',
          ]} />
        </Note>
      </Card>

      <Card>
        <SectionTitle><DatabaseIcon className="w-4 h-4 inline" /> Quét dữ liệu Facebook</SectionTitle>
        <Paragraph>
          Với tài khoản Facebook, CRM có tab <strong className="text-foreground">Quét dữ liệu</strong>: mỗi phiên quét là một tab
          (đổi tên, lưu trữ được), dữ liệu được giữ lại để xem tiếp.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Loại quét:</strong> Thành viên nhóm · Nhóm theo từ khóa · Fanpage theo từ khóa · Bình luận bài viết · Bài viết theo từ khóa',
          'Nhập link hoặc từ khoá (thành viên nhóm và bình luận nhập được nhiều link cùng lúc); bộ lọc tuỳ loại: năm, gần đây, công khai, sắp xếp / lọc bình luận, chỉ bình luận có SĐT',
          'Kết quả xem dạng bảng và <strong class="text-foreground">Xuất Excel</strong>; tab Lịch sử quét ghi lại từng lần quét, tab Thống kê tổng hợp số dữ liệu và tỷ lệ thành công',
        ]} />
        <Note tone="warning" title={<><AlertIcon className="w-3.5 h-3.5" /> Nên dùng tài khoản phụ</>}>
          Facebook có thể phát hiện việc quét dữ liệu; tài khoản chính dễ bị đăng xuất, checkpoint hoặc mất ổn định.
        </Note>
      </Card>

      <Card>
        <SectionTitle><CampaignIcon className="w-4 h-4 inline" /> Chiến dịch gửi hàng loạt</SectionTitle>
        <Paragraph>
          CRM → <strong className="text-foreground">Chiến dịch</strong>: gửi tin nhắn, kết bạn hoặc mời vào nhóm cho cả danh sách khách,
          chạy nền theo hàng đợi có giãn cách và giới hạn mỗi ngày.
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={<ChatIcon className="w-3.5 h-3.5" />} title="Tin nhắn"
            desc="Chữ, ảnh, nhiều biến thể nội dung; gửi cho từng người hoặc vào nhóm." />
          <Tile icon={<UserPlusIcon className="w-3.5 h-3.5" />} title="Kết bạn"
            desc="Lời mời kết bạn kèm lời nhắn, chèn được {name}." />
          <Tile icon={<UsersIcon className="w-3.5 h-3.5" />} title="Mời vào nhóm"
            desc="Mời vào một hoặc nhiều nhóm đã chọn (chỉ mời được bạn bè)." />
          <Tile icon={<ShuffleIcon className="w-3.5 h-3.5" />} title="Hỗn hợp"
            desc="Tick nhiều hành động (Tin nhắn, Kết bạn, Mời nhóm), chạy lần lượt cho mỗi người." />
        </div>
        <BulletList items={[
          '<strong class="text-foreground">Zalo:</strong> đủ 4 loại chiến dịch',
          '<strong class="text-foreground">Telegram và Telegram Bot:</strong> loại Tin nhắn (không có định dạng chữ kiểu Zalo); chọn người nhận từ danh bạ, nhãn Local, UID hoặc thành viên nhóm (không có Theo SĐT và nhãn Zalo); Bot chỉ gửi được tới chat bot đã biết hoặc nhóm bot đang tham gia',
          '<strong class="text-foreground">Facebook:</strong> chưa hỗ trợ chiến dịch',
        ]} />
        <StepList steps={[
          { title: 'Tạo chiến dịch', desc: 'Chiến dịch → <strong class="text-foreground">Tạo mới</strong>: đặt Tên, chọn Loại (Hỗn hợp: tick các Hành động).' },
          { title: 'Soạn nội dung', desc: 'Nội dung 1, 2… (nút +) là các biến thể: <strong class="text-foreground">Random</strong> = mỗi người nhận ngẫu nhiên 1 biến thể, <strong class="text-foreground">Tất cả</strong> = nhận lần lượt mọi nội dung. Chèn biến {name} (tên người nhận), {userId}; Zalo có thanh định dạng (đậm, nghiêng, gạch chân, gạch ngang, 4 màu, cỡ chữ) và tuỳ chọn Tag toàn nhóm khi gửi vào nhóm; đính kèm ảnh tuỳ chọn.' },
          { title: 'Giãn cách & lịch chạy', desc: 'Delay giữa các liên hệ (2-3m, 3-5m, 5-10m, 10-15m hoặc Tùy chỉnh khoảng - tối thiểu 30 giây), Delay giữa các tin nhắn (khi 1 người nhận nhiều tin), Giới hạn/ngày và Giờ bắt đầu chạy (mặc định 08:00).' },
          { title: 'Thêm liên hệ', desc: 'Bước Thêm liên hệ: Thủ công · Theo nhãn · Theo SĐT (chỉ Zalo - tra số ra tài khoản lúc gửi) · Theo UID · Bạn bè · Nhóm · Theo thành viên nhóm. Có thể thêm sau bằng nút Thêm liên hệ, hoặc từ tab Liên hệ / Nhóm qua nút Thêm vào chiến dịch.' },
          { title: 'Chạy', desc: 'Mở chiến dịch → <strong class="text-foreground">Bắt đầu</strong>. Tạm dừng / Tiếp tục bất cứ lúc nào; nút Sửa và Thêm liên hệ trong màn chi tiết chỉ hiện khi chiến dịch đang Nháp hoặc Tạm dừng.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle><ImageIcon className="w-4 h-4 inline" /> Xem trước như khung chat & Ảnh kèm chữ</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Xem trước</strong> bên phải form tạo / sửa: hiện tin như trên máy người nhận (biến {name} thay bằng tên mẫu), đúng thứ tự chữ / ảnh sẽ gửi; chuyển qua lại giữa các biến thể',
          'Màn chi tiết có mục <strong class="text-foreground">Nội dung gửi</strong>: từng bước mỗi liên hệ sẽ nhận (Bước 1, Bước 2…), các biến thể, lời nhắn kết bạn và nhóm sẽ mời',
          '<strong class="text-foreground">Ảnh kèm chữ</strong> (khi một nội dung có cả chữ và ảnh): Gửi trước → Chữ trước / Ảnh trước, hoặc tick Gộp ảnh + chữ thành 1 tin',
          'Gộp trên Zalo: chữ thành mô tả của ảnh - chỉ khi có đúng 1 ảnh jpg / png / webp và chữ không giữ định dạng. Telegram: chữ thành chú thích, nhiều ảnh gửi thành album; chữ dài hơn 1024 ký tự thì gửi riêng',
          'Không gộp được thì app tự gửi riêng theo thứ tự đã chọn (xem trước ghi rõ lý do). Đổi tuỳ chọn ngay ở màn chi tiết khi chiến dịch đang Nháp hoặc Tạm dừng',
        ]} />
      </Card>

      <Card>
        <SectionTitle><TrendingUpIcon className="w-4 h-4 inline" /> Theo dõi tiến độ realtime</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Danh sách chiến dịch:</strong> tìm theo tên, lọc Nháp · Đang chạy · Tạm dừng · Hoàn thành; mỗi thẻ có thanh tiến độ đã gửi / tổng và số lỗi',
          '<strong class="text-foreground">Menu ⋯</strong> trên thẻ: Bắt đầu / Tạm dừng / Tiếp tục, Nhân bản (Chỉ clone template hoặc Clone giống hệt kèm danh sách khách), Xóa chiến dịch',
          '<strong class="text-foreground">Màn chi tiết:</strong> giãn cách, giờ chạy mỗi ngày, giới hạn/ngày; 4 ô Tổng liên hệ · Đã gửi · Đang chờ · Lỗi và thanh Đã xử lý x/y (kèm Hôm nay a/b khi có giới hạn) cập nhật ngay khi gửi',
          '<strong class="text-foreground">Danh sách liên hệ</strong> của chiến dịch: tìm tên / UID / SĐT, lọc Tất cả · Chờ gửi · Đã gửi · Lỗi, xem lỗi và giờ gửi từng người, xuất CSV',
          '<strong class="text-foreground">Hỗn hợp:</strong> người nhận có hành động lỗi (vd đã nhắn tin nhưng kết bạn lỗi) hiện <strong class="text-foreground">Gửi một phần</strong> kèm hành động lỗi và có bộ lọc Lỗi một phần; mọi hành động đều lỗi thì hiện Lỗi',
          '<strong class="text-foreground">Tab Lịch sử:</strong> nhật ký gửi của mọi chiến dịch, lọc theo chiến dịch, khoảng ngày, trạng thái, loại gửi (Tin nhắn / Kết bạn / Mời nhóm); bấm một dòng để xem chi tiết; Xuất CSV',
          'Gửi hết danh sách thì chiến dịch tự chuyển Hoàn thành; tỷ lệ gửi thành công và phản hồi xem ở Báo cáo → Chiến dịch',
        ]} />
      </Card>

      <Card>
        <SectionTitle><ShieldIcon className="w-4 h-4 inline" /> Giãn cách & an toàn khi gửi</SectionTitle>
        <Note tone="warning" title={<><AlertIcon className="w-3.5 h-3.5" /> Cảnh báo trong form tạo chiến dịch</>}>
          Hành động càng nhiều, nội dung càng dài và delay càng ngắn thì nguy cơ bị đánh dấu spam càng cao.
          Cân nhắc kỹ khi cấu hình và luôn tuân thủ nguyên tắc cộng đồng của nền tảng.
        </Note>
        <BulletList items={[
          'Giữa hai liên hệ, app chờ một khoảng ngẫu nhiên trong Delay đã chọn, tối thiểu 30 giây; một người nhận nhiều tin thì các tin cách nhau theo Delay giữa các tin nhắn (mặc định gửi liên tiếp khoảng 1 giây)',
          '<strong class="text-foreground">Giới hạn/ngày:</strong> đủ số liên hệ trong ngày thì tạm dừng và chạy tiếp từ Giờ bắt đầu chạy hôm sau; nếu giờ bắt đầu đã qua trong ngày, chiến dịch chạy ngay',
          'Các chiến dịch đang chạy của cùng một tài khoản dùng chung một hàng đợi. Thanh trạng thái cuối trang CRM hiện Queue đang chạy, Hạn mức (60 lượt/giờ mỗi tài khoản, hồi dần 1 lượt mỗi phút) và lần gửi cuối',
          'Chiến dịch Zalo chỉ gửi khi tài khoản đang kết nối; chiến dịch đang chạy tự chạy tiếp khi mở lại app',
          'Mời vào nhóm chỉ mời được người đã là bạn bè; mục Mã lỗi thường gặp trong form giúp tra nguyên nhân khi mời nhóm thất bại',
        ]} />
      </Card>
    </div>
  );
}
