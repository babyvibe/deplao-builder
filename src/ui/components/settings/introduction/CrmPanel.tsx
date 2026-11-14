import React from 'react';
import {
  AlertIcon, CalendarIcon, CampaignIcon, ChatIcon, ClockIcon, CloudIcon, DatabaseIcon, EditIcon, GiftIcon,
  HardDriveIcon, ImageIcon, InfoIcon, SearchIcon, ShieldIcon, ShuffleIcon, TagIcon, TrendingUpIcon, UserPlusIcon,
  UsersIcon,
} from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Small tile in the 2-column grid: icon + title + short description. */
function Tile({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="bg-muted rounded-lg px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-foreground text-[11px] font-semibold">{icon}{title}</p>
      <p className="text-muted-foreground text-[11px] mt-0.5 leading-relaxed">{desc}</p>
    </div>
  );
}

/** Note box: info = path / tip, warning = safety notice. */
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
        <SectionTitle>{trx('<0/> CRM & Khách hàng - Tổng quan', { 0: <UsersIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('CRM gom khách hàng của từng tài khoản (bạn bè, người chưa kết bạn và các nhóm) vào một nơi để<0> lọc, gắn nhãn, ghi chú, chăm sóc theo dịp</0> và<1> gửi chiến dịch hàng loạt</1> có giãn cách.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <Note title={<>{trx('<0/> Cách mở', { 0: <InfoIcon className="w-3.5 h-3.5" /> })}</>}>
          {trx('Thanh bên trái → <0>CRM</0>, hoặc nút <1>Tất cả tính năng</1> trên thanh trên cùng → nhóm CRM. Chọn tài khoản cần làm việc ở góc phải phía trên; biểu tượng biểu đồ bên cạnh mở trang Báo cáo.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Note>
        <BulletList items={[
          tr('<strong class="text-foreground">Zalo:</strong> Tìm kiếm · Liên hệ · Nhóm · Lời mời · Chiến dịch · Lịch sử'),
          tr('<strong class="text-foreground">Telegram (tài khoản cá nhân và Bot):</strong> Liên hệ · Nhóm · Chiến dịch · Lịch sử'),
          tr('<strong class="text-foreground">Facebook:</strong> Liên hệ · Quét dữ liệu · Lịch sử quét · Thống kê'),
          tr('<strong class="text-foreground">Tìm kiếm</strong> (Zalo): nhập số điện thoại để tìm người dùng và gửi kết bạn; bên dưới có danh sách Gợi ý kết bạn'),
          tr('<strong class="text-foreground">Lời mời</strong> (Zalo): lời mời kết bạn Nhận được / Đã gửi - chấp nhận, từ chối hoặc huỷ; chấm đỏ báo có lời mời mới'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Danh sách liên hệ & bộ lọc', { 0: <SearchIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Tab <0>Liên hệ</0> liệt kê bạn bè, người chưa kết bạn và nhóm của tài khoản đang chọn, kèm nhãn, giới tính, sinh nhật, số điện thoại và ngày nhắn tin gần nhất.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Tìm kiếm:</strong> theo tên, biệt danh, số điện thoại hoặc UID'),
          tr('<strong class="text-foreground">Nhãn:</strong> lọc theo một hoặc nhiều Nhãn Local; tài khoản Zalo có thêm tab nhãn Zalo'),
          tr('<strong class="text-foreground">Loại:</strong> Bạn bè · Chưa là bạn bè · Nhóm · Có SĐT · Có ghi chú (Bạn bè / Chưa là bạn bè chỉ có ở Zalo)'),
          tr('<strong class="text-foreground">Giới tính</strong> và <strong class="text-foreground">Sinh nhật</strong> (Zalo): Nam · Nữ · Không xác định; Hôm nay · Tuần này · Tháng này · Có ngày sinh · Chưa có'),
          tr('<strong class="text-foreground">Sắp xếp:</strong> Tên A → Z, Tên Z → A, Tin nhắn gần nhất'),
          tr('Mọi bộ lọc áp dụng trên <strong class="text-foreground">toàn bộ danh sách</strong> (không chỉ trang đang xem): số liên hệ và phân trang tính theo kết quả lọc'),
          tr('<strong class="text-foreground">Thao tác:</strong> Xuất CSV toàn bộ liên hệ khớp bộ lọc và tìm kiếm đang chọn (mở được bằng Excel); Thêm liên hệ theo SĐT (Zalo)'),
          tr('<strong class="text-foreground">Chọn nhiều:</strong> tick từng dòng hoặc nút Trang này → thanh thao tác: Thêm vào chiến dịch · Nhãn Local · Khác → Nhãn Zalo, Rời nhóm đã chọn (Zalo)'),
          tr('Bấm một dòng để mở hồ sơ, bấm ảnh đại diện để xem nhanh, biểu tượng tin nhắn để chat ngay'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Hồ sơ khách hàng & ghi chú nội bộ', { 0: <EditIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Bấm một liên hệ để mở panel hồ sơ bên phải, gồm 2 tab <0>Nhãn/Ghi chú</0> và<1> Lịch sử gửi tin</1>.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Thông tin liên hệ:</strong> bấm Sửa để nhập Điện thoại, Giới tính, Sinh nhật (mọi kênh). Với Zalo, số điện thoại, giới tính, ngày sinh được lấy từ hồ sơ Zalo khi có'),
          tr('<strong class="text-foreground">Ghi chú nội bộ:</strong> thêm, sửa, xoá ghi chú cho từng khách (khách không nhìn thấy), mỗi ghi chú kèm thời gian. Nhóm Zalo có thêm tab Zalo để xem ghi chú của nhóm (chỉ đọc)'),
          tr('<strong class="text-foreground">Nhãn:</strong> chọn Nhãn Local (gắn được nhiều nhãn) và Nhãn Zalo (1 nhãn, bấm Lưu nhãn)'),
          tr('<strong class="text-foreground">Lịch sử gửi tin:</strong> các lần chiến dịch đã gửi cho khách, trạng thái Đã gửi / Thất bại kèm lỗi'),
          tr('<strong class="text-foreground">Đồng bộ:</strong> khi thêm tài khoản Zalo, app tự tải danh sách bạn bè, nhãn, tin nhắn nhanh và nhóm (bảng Đang khởi tạo tài khoản); tên và ảnh đại diện Zalo bị cũ hoặc lỗi được tự làm mới khi mở CRM'),
          tr('<strong class="text-foreground">Thêm liên hệ theo SĐT</strong> (Zalo, menu Thao tác): dán danh sách số (mỗi dòng 1 số) → Tra cứu → gắn nhãn tuỳ chọn → Thêm vào liên hệ'),
        ]} />
        <Note tone="warning" title={<>{trx('<0/> Giới hạn tra cứu số điện thoại', { 0: <AlertIcon className="w-3.5 h-3.5" /> })}</>}>
          {tr('Zalo hạn chế tìm kiếm số điện thoại theo ngày: nên tra tối đa 30 số mỗi giờ và không quá 100–200 số mỗi ngày.')}
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Nhãn Zalo & Nhãn Local', { 0: <TagIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Hai loại nhãn dùng song song để phân nhóm khách, lọc danh sách và chọn người nhận chiến dịch.')}
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-muted rounded-lg p-2.5 space-y-1.5">
            <p className="flex items-center gap-1.5 text-foreground text-[11px] font-semibold">{trx('<0/> Nhãn Zalo', { 0: <CloudIcon className="w-3.5 h-3.5" /> })}</p>
            <BulletList items={[
              tr('Đồng bộ hai chiều với Zalo: gán trong app thì hiện trên Zalo điện thoại và ngược lại'),
              tr('Mỗi hội thoại chỉ gắn được 1 nhãn Zalo'),
              tr('Số lượng nhãn do Zalo giới hạn'),
              tr('Chỉ có ở tài khoản Zalo'),
            ]} />
          </div>
          <div className="bg-muted rounded-lg p-2.5 space-y-1.5">
            <p className="flex items-center gap-1.5 text-foreground text-[11px] font-semibold">{trx('<0/> Nhãn Local (khuyến nghị)', { 0: <HardDriveIcon className="w-3.5 h-3.5" /> })}</p>
            <BulletList items={[
              tr('Không giới hạn số nhãn; một hội thoại gắn được nhiều nhãn'),
              tr('Dùng chung cho nhiều tài khoản Zalo, Facebook, Telegram'),
              tr('Tuỳ chỉnh màu, emoji, thứ tự, phím tắt'),
              tr('Chỉ có trong Deplao, không hiện trên điện thoại'),
            ]} />
          </div>
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Quản lý:</strong> Cài đặt → Hội thoại → Quản lý nhãn. Tab Local: Thêm nhãn, chọn tài khoản dùng nhãn, bật / tắt, kéo để sắp xếp, Sao chép toàn bộ Nhãn Local từ tài khoản này sang tài khoản khác'),
          tr('<strong class="text-foreground">Tab Zalo</strong> (chọn đúng 1 tài khoản đang kết nối): sửa, xoá, thêm nhãn và lưu thẳng lên Zalo; Đồng bộ về Local để chép nhãn Zalo thành Nhãn Local (Thêm vào hoặc Thay thế hoàn toàn)'),
          tr('<strong class="text-foreground">Gắn nhãn:</strong> trong hồ sơ liên hệ, chọn nhiều liên hệ → Nhãn Local / Khác → Nhãn Zalo, hoặc ngay trên khung chat'),
          tr('<strong class="text-foreground">Tự động hoá:</strong> Workflow có trigger Khi gán hoặc gỡ nhãn và hành động Gắn nhãn hội thoại (Zalo)'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Chăm sóc khách theo giới tính, sinh nhật & tương tác cuối', { 0: <GiftIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Kết hợp bộ lọc của tab Liên hệ với chiến dịch để <0>gửi đúng người, đúng dịp</0>:', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={<GiftIcon className="w-3.5 h-3.5" />} title={tr('Chúc mừng sinh nhật')}
            desc={tr('Sinh nhật → Hôm nay (hoặc Tuần này) → gửi lời chúc kèm ưu đãi, chèn {name} để gọi tên khách.')} />
          <Tile icon={<CalendarIcon className="w-3.5 h-3.5" />} title={tr('Ưu đãi tháng sinh')}
            desc={tr('Đầu tháng lọc Sinh nhật → Tháng này để gửi quà cho khách sinh trong tháng.')} />
          <Tile icon={<UsersIcon className="w-3.5 h-3.5" />} title={tr('Theo giới tính')}
            desc={tr('Dịp 8/3, 20/10 lọc Giới tính → Nữ; dịp dành cho nam lọc Nam.')} />
          <Tile icon={<ClockIcon className="w-3.5 h-3.5" />} title={tr('Kéo lại khách cũ')}
            desc={tr('Sắp xếp Tin nhắn gần nhất: cột Tin nhắn cho biết lần nhắn cuối, khách lâu chưa tương tác nằm cuối danh sách.')} />
        </div>
        <Note title={<>{trx('<0/> Cách dùng', { 0: <InfoIcon className="w-3.5 h-3.5" /> })}</>}>
          {trx('CRM → Liên hệ → chọn bộ lọc (Sinh nhật, Giới tính, Nhãn, Loại) → tick Trang này hoặc từng người →<0> Thêm vào chiến dịch</0> → chọn chiến dịch có sẵn hoặc Tạo mới → mở chiến dịch và bấm Bắt đầu. Bộ lọc Giới tính / Sinh nhật chỉ có với tài khoản Zalo. Trong chiến dịch, Thêm liên hệ → Theo nhãn chọn người nhận theo nhãn trên toàn bộ danh sách liên hệ.', { 0: <strong className="text-foreground" /> })}
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Nhóm & thành viên nhóm', { 0: <UsersIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Tab <0>Nhóm</0> của Zalo có 2 phần: <1>Thành viên nhóm</1> và<2> Quét thành viên</2> (xem mục bên dưới).', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" />, 2: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Danh sách nhóm</strong> lấy từ hội thoại; menu ⋮ → Tải toàn bộ nhóm từ Zalo (đồng bộ nhóm và chi tiết thành viên, có tiến độ) hoặc Join nhóm theo link'),
          tr('Chọn một nhóm → <strong class="text-foreground">Tải thông tin thành viên</strong>: tên, UID, số điện thoại (nếu có), vai trò Trưởng nhóm / Phó nhóm; Tìm thành viên, Chọn tất cả, Xuất danh sách (CSV)'),
          tr('Chọn thành viên → <strong class="text-foreground">Thêm vào chiến dịch</strong> hoặc <strong class="text-foreground">Thêm vào liên hệ</strong> (kèm gắn nhãn tuỳ chọn)'),
          tr('<strong class="text-foreground">Telegram:</strong> tab Nhóm liệt kê nhóm, siêu nhóm, diễn đàn đã đồng bộ để chọn thành viên đưa vào chiến dịch Telegram; Telegram Bot không có danh sách thành viên đầy đủ'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Quét thành viên nhóm (Zalo)', { 0: <SearchIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Lấy danh sách thành viên của nhóm Zalo từ link mời, <0>kể cả nhóm đã ẩn danh sách thành viên</0> hoặc<1> nhóm bạn đang chờ duyệt</1>. Kết quả (tên, ảnh đại diện, UID) được lưu vào CRM để kết bạn, nhắn tin hoặc mời vào nhóm qua chiến dịch.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <StepList steps={[
          { title: tr('Dán link nhóm'), desc: tr('CRM → Nhóm → <strong class="text-foreground">Quét thành viên</strong>, dán link nhóm Zalo (dạng https://zalo.me/g/…) hoặc Group ID dạng số.') },
          { title: tr('Tham gia nếu chưa là thành viên'), desc: tr('Bấm <strong class="text-foreground">Tham gia</strong>; kết quả hiện ngay bên dưới: Đã tham gia, Đã là thành viên, Đang chờ duyệt hoặc Nhóm đã đủ thành viên. Nhóm bật duyệt thành viên sẽ nhận yêu cầu chờ duyệt - đang chờ duyệt là quét được, không cần đợi admin.') },
          { title: tr('Quét'), desc: tr('Bấm <strong class="text-foreground">Quét</strong>. Lần đầu app hỏi bạn có đồng ý gửi phiên đăng nhập Zalo lên máy chủ Deplao không (xem lưu ý). Xong sẽ báo số thành viên và lưu vào tab Thành viên nhóm (nút Xem trong tab Thành viên).') },
          { title: tr('Dùng kết quả'), desc: tr('Chọn thành viên → <strong class="text-foreground">Thêm vào chiến dịch</strong> (kết bạn, nhắn tin, mời vào nhóm) hoặc <strong class="text-foreground">Thêm vào liên hệ</strong>.') },
        ]} />
        <Note tone="warning" title={<>{trx('<0/> Lưu ý', { 0: <AlertIcon className="w-3.5 h-3.5" /> })}</>}>
          <BulletList items={[
            tr('<strong class="text-foreground">Quét qua máy chủ Deplao, cần bạn đồng ý:</strong> để giữ kín cách quét, việc quét chạy trên deplaoapp.com nên app gửi phiên đăng nhập Zalo (cookie + IMEI) của tài khoản lên đó. Mặc định tắt; app hỏi trước khi gửi, không đồng ý thì không gửi gì. Bật / tắt bằng công tắc <strong class="text-foreground">Quét qua máy chủ Deplao</strong> ở đầu tab Quét thành viên. Máy chủ không lưu cookie, chỉ ghi ID tài khoản, ID nhóm, IP, thời gian. Áp dụng cả cho nút Tải thông tin thành viên và nút Quét đủ trong panel thành viên của hội thoại nhóm'),
            tr('Với nhóm chưa tham gia, cần ít nhất ở trạng thái chờ duyệt; nhóm tắt chế độ chờ duyệt thì không quét được'),
            tr('UID thành viên không dùng chung được giữa các tài khoản (chính sách của Zalo) - hãy quét bằng chính tài khoản sẽ gửi chiến dịch'),
            tr('Nút Chia sẻ gửi nhóm lên kho Nhóm chung của cộng đồng (chờ admin duyệt); Khám phá kho nhóm chung để tìm nhóm có sẵn theo danh mục'),
            tr('Quét và gửi ở mức vừa phải để tài khoản Zalo không bị hạn chế'),
          ]} />
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Quét dữ liệu Facebook', { 0: <DatabaseIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Với tài khoản Facebook, CRM có tab <0>Quét dữ liệu</0>: mỗi phiên quét là một tab (đổi tên, lưu trữ được), dữ liệu được giữ lại để xem tiếp.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Loại quét:</strong> Thành viên nhóm · Nhóm theo từ khóa · Fanpage theo từ khóa · Bình luận bài viết · Bài viết theo từ khóa'),
          tr('Nhập link hoặc từ khoá (thành viên nhóm và bình luận nhập được nhiều link cùng lúc); bộ lọc tuỳ loại: năm, gần đây, công khai, sắp xếp / lọc bình luận, chỉ bình luận có SĐT'),
          tr('Kết quả xem dạng bảng và <strong class="text-foreground">Xuất Excel</strong>; tab Lịch sử quét ghi lại từng lần quét, tab Thống kê tổng hợp số dữ liệu và tỷ lệ thành công'),
        ]} />
        <Note tone="warning" title={<>{trx('<0/> Nên dùng tài khoản phụ', { 0: <AlertIcon className="w-3.5 h-3.5" /> })}</>}>
          {tr('Facebook có thể phát hiện việc quét dữ liệu; tài khoản chính dễ bị đăng xuất, checkpoint hoặc mất ổn định.')}
        </Note>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Chiến dịch gửi hàng loạt', { 0: <CampaignIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('CRM → <0>Chiến dịch</0>: gửi tin nhắn, kết bạn hoặc mời vào nhóm cho cả danh sách khách, chạy nền theo hàng đợi có giãn cách và giới hạn mỗi ngày.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={<ChatIcon className="w-3.5 h-3.5" />} title={tr('Tin nhắn')}
            desc={tr('Chữ, ảnh, nhiều biến thể nội dung; gửi cho từng người hoặc vào nhóm.')} />
          <Tile icon={<UserPlusIcon className="w-3.5 h-3.5" />} title={tr('Kết bạn')}
            desc={tr('Lời mời kết bạn kèm lời nhắn, chèn được {name}.')} />
          <Tile icon={<UsersIcon className="w-3.5 h-3.5" />} title={tr('Mời vào nhóm')}
            desc={tr('Mời vào một hoặc nhiều nhóm đã chọn (chỉ mời được bạn bè).')} />
          <Tile icon={<ShuffleIcon className="w-3.5 h-3.5" />} title={tr('Hỗn hợp')}
            desc={tr('Tick nhiều hành động (Tin nhắn, Kết bạn, Mời nhóm), chạy lần lượt cho mỗi người.')} />
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Zalo:</strong> đủ 4 loại chiến dịch'),
          tr('<strong class="text-foreground">Telegram và Telegram Bot:</strong> loại Tin nhắn (không có định dạng chữ kiểu Zalo); chọn người nhận từ danh bạ, nhãn Local, UID hoặc thành viên nhóm (không có Theo SĐT và nhãn Zalo); Bot chỉ gửi được tới chat bot đã biết hoặc nhóm bot đang tham gia'),
          tr('<strong class="text-foreground">Facebook:</strong> chưa hỗ trợ chiến dịch'),
        ]} />
        <StepList steps={[
          { title: tr('Tạo chiến dịch'), desc: tr('Chiến dịch → <strong class="text-foreground">Tạo mới</strong>: đặt Tên, chọn Loại (Hỗn hợp: tick các Hành động).') },
          { title: tr('Soạn nội dung'), desc: tr('Nội dung 1, 2… (nút +) là các biến thể: <strong class="text-foreground">Random</strong> = mỗi người nhận ngẫu nhiên 1 biến thể, <strong class="text-foreground">Tất cả</strong> = nhận lần lượt mọi nội dung. Chèn biến {name} (tên người nhận), {userId}; Zalo có thanh định dạng (đậm, nghiêng, gạch chân, gạch ngang, 4 màu, cỡ chữ) và tuỳ chọn Tag toàn nhóm khi gửi vào nhóm; đính kèm ảnh tuỳ chọn.') },
          { title: tr('Giãn cách & lịch chạy'), desc: tr('Delay giữa các liên hệ (2-3m, 3-5m, 5-10m, 10-15m hoặc Tùy chỉnh khoảng - tối thiểu 30 giây), Delay giữa các tin nhắn (khi 1 người nhận nhiều tin), Giới hạn/ngày, Giờ bắt đầu chạy (mặc định 08:00) và Tự dừng khi lỗi (mặc định Tắt).') },
          { title: tr('Thêm liên hệ'), desc: tr('Bước Thêm liên hệ: Thủ công · Theo nhãn · Theo SĐT (chỉ Zalo - tra số ra tài khoản lúc gửi) · Theo UID · Bạn bè · Nhóm · Theo thành viên nhóm. Có thể thêm sau bằng nút Thêm liên hệ, hoặc từ tab Liên hệ / Nhóm qua nút Thêm vào chiến dịch.') },
          { title: tr('Chạy'), desc: tr('Mở chiến dịch → <strong class="text-foreground">Bắt đầu</strong>. Tạm dừng / Tiếp tục bất cứ lúc nào; nút Sửa và Thêm liên hệ trong màn chi tiết chỉ hiện khi chiến dịch đang Nháp hoặc Tạm dừng.') },
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Xem trước như khung chat & Ảnh kèm chữ', { 0: <ImageIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Xem trước</strong> bên phải form tạo / sửa: hiện tin như trên máy người nhận (biến {name} thay bằng tên mẫu), đúng thứ tự chữ / ảnh sẽ gửi; chuyển qua lại giữa các biến thể'),
          tr('Màn chi tiết có mục <strong class="text-foreground">Nội dung gửi</strong>: từng bước mỗi liên hệ sẽ nhận (Bước 1, Bước 2…), các biến thể, lời nhắn kết bạn và nhóm sẽ mời'),
          tr('<strong class="text-foreground">Ảnh kèm chữ</strong> (khi một nội dung có cả chữ và ảnh): Gửi trước → Chữ trước / Ảnh trước, hoặc tick Gộp ảnh + chữ thành 1 tin'),
          tr('Gộp trên Zalo: chữ thành mô tả của ảnh - chỉ khi có đúng 1 ảnh jpg / png / webp và chữ không giữ định dạng. Telegram: chữ thành chú thích, nhiều ảnh gửi thành album; chữ dài hơn 1024 ký tự thì gửi riêng'),
          tr('Không gộp được thì app tự gửi riêng theo thứ tự đã chọn (xem trước ghi rõ lý do). Đổi tuỳ chọn ngay ở màn chi tiết khi chiến dịch đang Nháp hoặc Tạm dừng'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Theo dõi tiến độ realtime', { 0: <TrendingUpIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Danh sách chiến dịch:</strong> tìm theo tên, lọc Nháp · Đang chạy · Tạm dừng · Hoàn thành; mỗi thẻ có thanh tiến độ đã gửi / tổng và số lỗi'),
          tr('<strong class="text-foreground">Menu ⋯</strong> trên thẻ: Bắt đầu / Tạm dừng / Tiếp tục, Nhân bản (Chỉ clone template hoặc Clone giống hệt kèm danh sách khách), Xóa chiến dịch'),
          tr('<strong class="text-foreground">Nhân bản sang nhiều tài khoản:</strong> ở ô Tài khoản nhận bản sao chọn một hay nhiều tài khoản cùng kênh (tìm theo tên, SĐT), mỗi tài khoản nhận một bản nháp. Mã người nhận và nhóm chỉ dùng được ở tài khoản gốc, nên tài khoản khác chỉ nhận người nhận có SĐT (Zalo) và cần chọn lại nhóm mời'),
          tr('<strong class="text-foreground">Màn chi tiết:</strong> giãn cách, giờ chạy mỗi ngày, giới hạn/ngày; 4 ô Tổng liên hệ · Đã gửi · Đang chờ · Lỗi và thanh Đã xử lý x/y (kèm Hôm nay a/b khi có giới hạn) cập nhật ngay khi gửi'),
          tr('<strong class="text-foreground">Danh sách liên hệ</strong> của chiến dịch: tìm tên / UID / SĐT, lọc Tất cả · Chờ gửi · Đã gửi · Lỗi, xem lỗi và giờ gửi từng người, xuất CSV'),
          tr('<strong class="text-foreground">Hiệu quả tin đã gửi:</strong> Đã nhận · Đã xem · Đã phản hồi (kèm %), nút Cập nhật; mỗi người nhận hiện mức cao nhất đã đạt. Lọc <strong class="text-foreground">Đã phản hồi · Đã xem, chưa phản hồi · Chưa xem · Chưa nhận</strong>, rồi bấm <strong class="text-foreground">Tạo chiến dịch từ N liên hệ</strong> để gửi tiếp đúng nhóm khách (chiến dịch nháp, chép nội dung để bạn sửa). Đã xem tính cả khách đã trả lời; Zalo chỉ báo đã xem khi người nhận bật trạng thái Đã xem, Telegram không báo đã nhận, Deplao cần đang mở để nhận các báo này'),
          tr('<strong class="text-foreground">Hỗn hợp:</strong> người nhận có hành động lỗi (vd đã nhắn tin nhưng kết bạn lỗi) hiện <strong class="text-foreground">Gửi một phần</strong> kèm hành động lỗi và có bộ lọc Lỗi một phần; mọi hành động đều lỗi thì hiện Lỗi'),
          tr('<strong class="text-foreground">Tab Lịch sử:</strong> nhật ký gửi của mọi chiến dịch, lọc theo chiến dịch, khoảng ngày, trạng thái, loại gửi (Tin nhắn / Kết bạn / Mời nhóm); bấm một dòng để xem chi tiết; Xuất CSV'),
          tr('Gửi hết danh sách thì chiến dịch tự chuyển Hoàn thành; so sánh các chiến dịch (đã nhận, đã xem, phản hồi) ở Báo cáo → Chiến dịch'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Giãn cách & an toàn khi gửi', { 0: <ShieldIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Note tone="warning" title={<>{trx('<0/> Cảnh báo trong form tạo chiến dịch', { 0: <AlertIcon className="w-3.5 h-3.5" /> })}</>}>
          {tr('Hành động càng nhiều, nội dung càng dài và delay càng ngắn thì nguy cơ bị đánh dấu spam càng cao. Cân nhắc kỹ khi cấu hình và luôn tuân thủ nguyên tắc cộng đồng của nền tảng.')}
        </Note>
        <BulletList items={[
          tr('Giữa hai liên hệ, app chờ một khoảng ngẫu nhiên trong Delay đã chọn, tối thiểu 30 giây; một người nhận nhiều tin thì các tin cách nhau theo Delay giữa các tin nhắn (mặc định gửi liên tiếp khoảng 1 giây)'),
          tr('<strong class="text-foreground">Giới hạn/ngày:</strong> đủ số liên hệ trong ngày thì tạm dừng và chạy tiếp từ Giờ bắt đầu chạy hôm sau; nếu giờ bắt đầu đã qua trong ngày, chiến dịch chạy ngay'),
          tr('<strong class="text-foreground">Tự dừng khi lỗi</strong> (Tắt · 3 · 5 · 10 · 20, mặc định Tắt): đủ số liên hệ lỗi liên tiếp (tài khoản bị chặn, bị giới hạn, mất phiên…) thì chiến dịch chuyển <strong class="text-foreground">Tự dừng</strong>, màn chi tiết ghi lý do và lỗi cuối, app báo cho bạn. Kiểm tra tài khoản rồi bấm Tiếp tục (đếm lại từ 0). Gửi được một liên hệ là đếm lại; đủ giới hạn/ngày không tính là lỗi. Gửi cho người lạ (vd thành viên nhóm quét được) hay gặp người chặn tin người lạ, nên chọn 10 hoặc 20'),
          tr('Tuỳ chọn của Tự dừng khi lỗi: <strong class="text-foreground">Chỉ tính người lạ</strong> (Zalo) - bạn bè và nhóm gửi được hay lỗi đều không tính, vì Zalo chặn spam theo tin nhắn cho người lạ; <strong class="text-foreground">Mai gửi tiếp</strong> - dừng tới Giờ bắt đầu chạy hôm sau rồi tự gửi tiếp (bị chặn spam thường mở lại sau một ngày), bấm Tiếp tục để gửi ngay'),
          tr('Các chiến dịch đang chạy của cùng một tài khoản dùng chung một hàng đợi. Thanh trạng thái cuối trang CRM hiện Queue đang chạy, Hạn mức (60 lượt/giờ mỗi tài khoản, hồi dần 1 lượt mỗi phút) và lần gửi cuối'),
          tr('Chiến dịch Zalo chỉ gửi khi tài khoản đang kết nối; chiến dịch đang chạy tự chạy tiếp khi mở lại app'),
          tr('Mời vào nhóm chỉ mời được người đã là bạn bè; mục Mã lỗi thường gặp trong form giúp tra nguyên nhân khi mời nhóm thất bại'),
        ]} />
      </Card>
    </div>
  );
}
