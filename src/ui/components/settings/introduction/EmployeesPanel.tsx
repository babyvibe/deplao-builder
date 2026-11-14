import React from 'react';
import { BotIcon, ChartIcon, ChatIcon, ClipboardListIcon, CrownIcon, FolderIcon, GlobeIcon, HomeIcon, LightningIcon, LinkIcon, LockIcon, RefreshIcon, SettingsIcon, SmartphoneIcon, TrendingUpIcon, UsersIcon } from '@/components/common/icons';
import { Badge, BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** The items in the "Quyền dùng" (Usage permissions) row (Settings → Employees, under each employee's name; same names as EMPLOYEE_MODULES). */
const MODULES = [
  { icon: <ChatIcon className="w-4 h-4" />, mod: tr('Tin nhắn'), desc: tr('Đọc, trả lời tin') },
  { icon: <UsersIcon className="w-4 h-4" />, mod: tr('Bạn bè'), desc: tr('Danh bạ, lời mời kết bạn') },
  { icon: <ChartIcon className="w-4 h-4" />, mod: tr('Khách hàng'), desc: tr('CRM, nhãn, chiến dịch') },
  { icon: <ClipboardListIcon className="w-4 h-4" />, mod: tr('Công việc'), desc: tr('Việc, lịch, ghi chú') },
  { icon: <LightningIcon className="w-4 h-4" />, mod: tr('Tự động hoá'), desc: 'Workflow' },
  { icon: <LinkIcon className="w-4 h-4" />, mod: tr('Tích hợp'), desc: tr('POS, vận chuyển, thanh toán') },
  { icon: <TrendingUpIcon className="w-4 h-4" />, mod: tr('Báo cáo'), desc: tr('Thống kê') },
  { icon: <BotIcon className="w-4 h-4" />, mod: tr('Trợ lý AI'), desc: tr('Gợi ý, trả lời tự động') },
];

export function EmployeesPanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-primary leading-none mt-0.5"><UsersIcon className="w-8 h-8" /></span>
        <div>
          <h3 className="text-foreground font-bold text-base">{tr('Cài đặt nhân viên & Workspace')}</h3>
          <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">
            {tr('Nhiều nhân viên cùng xử lý tin nhắn từ máy riêng — tài khoản và dữ liệu vẫn nằm trên máy Boss, phân quyền theo từng module và từng tài khoản.')}
          </p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            <Badge text="Boss" color="bg-primary/15 text-primary" />
            <Badge text={tr('Nhân viên')} color="bg-success/15 text-success" />
            <Badge text={tr('LAN / Internet')} color="bg-info/15 text-info" />
            <Badge text={tr('Workspace')} color="bg-muted text-muted-foreground" />
          </div>
        </div>
      </div>

      <Card>
        <SectionTitle>{trx('<0/> Mô hình hoạt động', { 0: <HomeIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Máy <0>Boss</0> (máy chủ) đăng nhập các tài khoản Zalo, Facebook, Telegram và giữ toàn bộ dữ liệu. Nhân viên cài Deplao trên máy riêng, đăng nhập bằng tài khoản Boss cấp và kết nối tới máy Boss qua<1> mạng nội bộ (LAN)</1> hoặc <2>Internet</2>.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" />, 2: <strong className="text-foreground" /> })}
        </Paragraph>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: <CrownIcon className="w-4 h-4" />, label: 'Boss', desc: tr('Toàn quyền: tài khoản, nhân viên, phân quyền, bật kết nối và địa chỉ Internet.') },
            { icon: <SmartphoneIcon className="w-4 h-4" />, label: tr('Nhân viên'), desc: tr('Chỉ thấy module và tài khoản được giao, làm việc từ máy riêng qua LAN hoặc Internet.') },
          ].map((r, i) => (
            <div key={i} className="bg-muted rounded-lg p-3 space-y-1">
              <p className="text-foreground text-xs font-semibold flex items-center gap-1.5">{r.icon} {r.label}</p>
              <p className="text-muted-foreground text-[11px] leading-relaxed">{r.desc}</p>
            </div>
          ))}
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Không sao chép cả dữ liệu:</strong> máy nhân viên đọc hội thoại, tin nhắn, khách hàng trực tiếp từ máy Boss khi cần; chỉ giữ bộ nhớ đệm ảnh / file (tự dọn khi quá 2 GB, xem ở Cài đặt → Lưu trữ).'),
          tr('<strong class="text-foreground">Realtime hai chiều:</strong> tin mới, tin sửa, thu hồi / xoá và cảm xúc hiện ngay trên cả máy Boss lẫn máy nhân viên.'),
          tr('<strong class="text-foreground">Ảnh lấy từ máy Boss:</strong> ảnh Zalo máy Boss chưa lưu (tin đồng bộ lịch sử, Boss tắt máy lúc nhận) thì Boss tự tải về khi nhân viên mở xem, link Zalo hết hạn vẫn còn ảnh.'),
          tr('<strong class="text-foreground">Zalo, Facebook, Telegram đều chạy qua máy Boss:</strong> nhân viên gửi tin, thả cảm xúc, thao tác nhóm… như bình thường; thêm, đăng nhập lại hay xoá tài khoản chỉ làm trên máy Boss.'),
          tr('<strong class="text-foreground">Biết ai đã trả lời:</strong> tin do nhân viên gửi có ảnh đại diện nhỏ của nhân viên bên cạnh (rê chuột để xem "Gửi bởi: …").'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Thiết lập từng bước', { 0: <SettingsIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <StepList steps={[
          {
            title: tr('Boss tạo tài khoản nhân viên'),
            desc: tr('Vào <strong class="text-foreground">Cài đặt → Nhân viên → Thêm nhân viên</strong>: nhập tên hiển thị (tên đăng nhập tự gợi ý, mật khẩu tạo sẵn), chọn tài khoản chat và mục được dùng → <strong class="text-foreground">Tạo nhân viên</strong>. Bấm <strong class="text-foreground">Sao chép</strong> để gửi thông tin đăng nhập cho nhân viên.'),
          },
          {
            title: tr('Boss bật kết nối'),
            desc: tr('Cùng trang, mục <strong class="text-foreground">Kết nối</strong>: bật <strong class="text-foreground">Cho nhân viên kết nối</strong> và "Tự bật khi mở app". Dòng "Cùng mạng (LAN)" hiện địa chỉ dạng 192.168.1.10:9900, bấm vào để sao chép gửi nhân viên cùng mạng.'),
          },
          {
            title: tr('(Tuỳ chọn) Mở cho nhân viên ở xa'),
            desc: tr('Vào <strong class="text-foreground">Cài đặt → Internet &amp; Cloud → Địa chỉ Internet</strong>, chọn cách tạo địa chỉ, bật dòng <strong class="text-foreground">Nhân viên và API</strong>. Địa chỉ (https://…) hiện ở dòng "Qua Internet" của mục Kết nối. Công tắc ở bước 2 vẫn phải bật.'),
          },
          {
            title: tr('Nhân viên đăng nhập'),
            desc: tr('Trên máy nhân viên: Dashboard → <strong class="text-foreground">Đăng nhập dành cho nhân viên</strong> (khi máy chưa có tài khoản nào), hoặc <strong class="text-foreground">Cài đặt → Workspace → Thêm workspace</strong> → loại "Remote (Nhân viên)". Nhập địa chỉ Boss (IP + Port, hoặc địa chỉ Internet), tên đăng nhập, mật khẩu → Đăng nhập.'),
          },
          {
            title: tr('Bắt đầu làm việc'),
            desc: tr('Thanh tiêu đề máy nhân viên hiện "Online - tên nhân viên" cùng nút <strong class="text-foreground">Ngắt kết nối</strong> / <strong class="text-foreground">Kết nối lại</strong>; nhân viên chỉ thấy module và tài khoản được giao.'),
          },
        ]} />
        <Paragraph>
          {trx('Mẹo: mỗi nhân viên là một thẻ; bấm dòng <0>Tài khoản chat</0>, <1>Quyền dùng</1>, <2>Nhóm</2> hay <3>Hồ sơ & mật khẩu</3> ngay dưới tên để sửa tại chỗ. Giả lập, đăng xuất, khoá, xoá nằm ở nút <4>⋯</4>. Nhóm (VD: CSKH, Kho) chọn hoặc tạo nhanh ngay lúc thêm nhân viên, hoặc ở dòng <5>Nhóm</5> của từng người (đổi tên, xoá nhóm cũng ở đó).', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" />, 2: <strong className="text-foreground" />, 3: <strong className="text-foreground" />, 4: <strong className="text-foreground" />, 5: <strong className="text-foreground" /> })}
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Kết nối LAN hay Internet?', { 0: <GlobeIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {[
            {
              icon: <HomeIcon className="w-4 h-4" />,
              mode: 'LAN — cùng mạng nội bộ',
              desc: tr('Nhanh, ổn định, không đi qua Internet. Nhân viên nhập IP:cổng của máy Boss. Nên đặt IP tĩnh cho máy Boss để địa chỉ không đổi sau mỗi lần khởi động lại.'),
            },
            {
              icon: <GlobeIcon className="w-4 h-4" />,
              mode: 'Internet — làm việc từ xa',
              desc: tr('Không cần mở cổng router, IP tĩnh hay VPS. Địa chỉ chỉ được tạo và bật / tắt ở Cài đặt → Internet & Cloud → Địa chỉ Internet; trang Nhân viên chỉ hiển thị lại.'),
            },
          ].map((m, i) => (
            <div key={i} className="bg-muted rounded-lg p-3 space-y-1">
              <p className="text-foreground text-[11px] font-semibold flex items-center gap-1.5">{m.icon} {m.mode}</p>
              <p className="text-muted-foreground text-[11px] leading-relaxed">{m.desc}</p>
            </div>
          ))}
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Địa chỉ tạm:</strong> không cần tài khoản nhưng đổi mỗi lần khởi động lại — phải gửi lại cho nhân viên. Chỉ nên dùng thử.'),
          tr('<strong class="text-foreground">Cloudflare tự động (khuyên dùng):</strong> kết nối tài khoản Cloudflare có tên miền (gói Free là đủ) để có địa chỉ cố định; nhân viên chỉ cần nhập một lần.'),
          tr('<strong class="text-foreground">ngrok / Cloudflare thủ công:</strong> dùng tài khoản ngrok hoặc tunnel Cloudflare do bạn tự quản lý.'),
          tr('Khi địa chỉ đổi, trang Nhân viên hiện thông báo <strong class="text-foreground">"Địa chỉ cho nhân viên đã đổi"</strong> kèm nút Sao chép. Nhân viên đang nối qua LAN được báo và tự chuyển; nhân viên ở xa dán địa chỉ mới vào ô <strong class="text-foreground">Kết nối lại</strong> trên thanh tiêu đề.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Tự kết nối lại, không lỡ tin', { 0: <RefreshIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Mất mạng hoặc máy Boss khởi động lại: máy nhân viên tự kết nối lại và <strong class="text-foreground">nhận bù các sự kiện bị lỡ</strong>; trong lúc chờ vẫn giữ dữ liệu đang xem (thanh tiêu đề báo "Đang khôi phục…" hoặc "Offline").'),
          tr('Địa chỉ tạm của Boss đã đổi: bấm <strong class="text-foreground">Kết nối lại</strong> → dán địa chỉ mới → "Kết nối địa chỉ mới", không cần nhập lại mật khẩu. Nếu Boss vừa báo địa chỉ mới, chỉ cần bấm <strong class="text-foreground">Dùng</strong>.'),
          tr('Phiên đăng nhập của nhân viên có hạn 7 ngày; hết hạn hoặc bị thu hồi thì bấm Kết nối lại và nhập mật khẩu.'),
          tr('Máy Boss phải mở Deplao và có Internet. Bật "Tự bật khi mở app" (mục Kết nối) để nhân viên tự nối lại ngay khi Boss mở app.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Phân quyền & bảo mật', { 0: <LockIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Khi tạo nhân viên, hoặc ở dòng <0>Quyền dùng</0> / <1>Tài khoản chat</1> dưới tên, Boss tick từng mục được dùng và chọn đúng các tài khoản được giao. Máy Boss kiểm tra quyền ở mọi thao tác (đọc, gửi tin, tải file), kể cả khi nhân viên làm việc từ xa.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <div className="grid grid-cols-2 gap-1.5">
          {MODULES.map((p, i) => (
            <div key={i} className="flex items-center gap-2 bg-muted rounded-lg px-2.5 py-2">
              <span className="text-muted-foreground flex-shrink-0">{p.icon}</span>
              <div>
                <p className="text-foreground text-[11px] font-medium">{p.mod}</p>
                <p className="text-muted-foreground text-[10px]">{p.desc}</p>
              </div>
            </div>
          ))}
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Quyền trong Cài đặt:</strong> "Quản lý tài khoản" (xem / xoá tài khoản) và "Quản lý nhân viên" chỉ nên cấp cho người tin cậy. Giao diện, Thông báo, Lưu trữ, Giới thiệu, Log phiên bản luôn mở; trang Internet &amp; Cloud chỉ có trên máy Boss.'),
          tr('<strong class="text-foreground">Đổi quyền hoặc tài khoản được giao:</strong> áp dụng ngay trên máy nhân viên đang online; trang không còn quyền sẽ tự chuyển về Dashboard.'),
          tr('<strong class="text-foreground">Khoá, xoá, đổi mật khẩu hoặc "Đăng xuất khỏi máy nhân viên"</strong> (nút ⋯) → phiên đăng nhập bị thu hồi ngay, nhân viên đang online bị ngắt kèm lý do.'),
          tr('<strong class="text-foreground">Đăng xuất tất cả nhân viên</strong> (mục Bảo mật cuối trang): dùng khi nghi lộ tài khoản, mọi máy nhân viên kể cả đang offline phải đăng nhập lại.'),
          tr('<strong class="text-foreground">Giả lập nhân viên:</strong> nút ⋯ → "Giả lập nhân viên này" cho Boss thấy đúng giao diện của người đó (thanh tiêu đề hiện "Đang giả lập: …"); bấm Thoát giả lập để quay lại.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Theo dõi hiệu suất nhân viên', { 0: <ChartIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Mở <0>Báo cáo → Nhân viên</0> và chọn khoảng thời gian ở đầu trang.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Chỉ số tổng:</strong> số nhân viên, tổng tin gửi, hội thoại xử lý, thời gian phản hồi trung bình, tổng giờ online.'),
          tr('<strong class="text-foreground">So sánh:</strong> tin nhắn &amp; hội thoại từng người, tin nhắn và giờ online theo ngày, xếp hạng tốc độ phản hồi, biểu đồ radar, hoạt động theo giờ trong ngày.'),
          tr('<strong class="text-foreground">Lọc nhân viên:</strong> chọn một vài người hoặc "Tất cả"; bảng chi tiết có nút <strong class="text-foreground">Xuất CSV</strong>.'),
          tr('Trang Cài đặt → Nhân viên ghi ngay dưới tên ai đang online, từ IP nào, đã nối bao lâu (hoặc lần vào cuối).'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Workspace — tách riêng dữ liệu', { 0: <FolderIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Mỗi workspace có cơ sở dữ liệu, thư mục ảnh / file, tài khoản và cài đặt riêng — dùng để tách từng cửa hàng, công ty, hoặc vừa làm Boss vừa đăng nhập làm nhân viên ở nơi khác trên cùng một máy. Tối đa 5 workspace.')}
        </Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Local (Boss / Standalone):</strong> chạy trực tiếp trên máy này, đăng nhập tài khoản và có thể bật kết nối cho nhân viên.'),
          tr('<strong class="text-foreground">Remote (Nhân viên):</strong> nối tới máy Boss bằng địa chỉ + tài khoản nhân viên, có tuỳ chọn "Tự động kết nối khi mở app".'),
          tr('Quản lý ở <strong class="text-foreground">Cài đặt → Workspace</strong>: Thêm workspace, Chuyển, Chỉnh sửa, Xoá. Từ 2 workspace trở lên, thanh tiêu đề có nút chọn workspace để chuyển nhanh, kèm số tin chưa đọc ở workspace khác.'),
          tr('Xoá workspace Local là <strong class="text-foreground">xoá vĩnh viễn</strong> dữ liệu của nó; xoá workspace Remote chỉ ngắt kết nối tới Boss. Workspace mặc định không xoá được.'),
          tr('Chuyển dữ liệu sang ổ khác (D:, E:…): <strong class="text-foreground">Cài đặt → Lưu trữ → Chọn thư mục khác</strong> — dữ liệu được sao chép sang và áp dụng ngay. Máy nhân viên chỉ có bộ nhớ đệm nên không cần chuyển.'),
        ]} />
      </Card>
    </div>
  );
}
