import React from 'react';
import ipc from '@/lib/ipc';
import {
  AwardIcon, BotIcon, BriefcaseIcon, CampaignIcon, ChartIcon, ClipboardListIcon, CloudIcon, CoffeeIcon,
  ExternalLinkIcon, GlobeIcon, HeartIcon, HomeIcon, InboxIcon, LayoutIcon, LightningIcon, LockIcon,
  MegaphoneIcon, MonitorIcon, PaletteIcon, PhoneIcon, PluginIcon, RefreshIcon, ShoppingCartIcon,
  SmartphoneIcon, SparklesIcon, StoreIcon, TargetIcon, TerminalIcon, UsersIcon,
} from '@/components/common/icons';
import { Badge, BulletList, Card, SectionTitle } from './introUi';

const RELEASES_URL = 'https://github.com/babyvibe/deplao-builder/releases';

type InfoItem = { icon: React.ReactNode; title: string; desc: string };

// Theo README "🎯 Phù hợp với ai?"
const TARGET_USERS: InfoItem[] = [
  { icon: <HomeIcon className="w-5 h-5" />, title: 'Doanh nghiệp vừa và nhỏ (SME)', desc: 'Nhiều nhân viên cùng xử lý inbox của nhiều tài khoản Zalo, Facebook, Telegram; giao tài khoản cho từng người và theo dõi hiệu suất qua báo cáo.' },
  { icon: <MegaphoneIcon className="w-5 h-5" />, title: 'Marketing Agency / Freelancer Marketing', desc: 'Quản lý tài khoản của nhiều khách hàng (tách riêng bằng workspace), chạy chiến dịch gửi tin, quét thành viên nhóm để tìm khách mới, tự động chăm sóc khách tiềm năng.' },
  { icon: <ShoppingCartIcon className="w-5 h-5" />, title: 'Shop online / Thương mại điện tử', desc: 'Chốt đơn, chăm sóc khách qua Zalo, Facebook, Telegram; tra cứu và tạo đơn POS ngay khi đang chat, kết nối vận chuyển GHN, GHTK và thanh toán Sepay, Casso.' },
  { icon: <PhoneIcon className="w-5 h-5" />, title: 'Sales & Telesales', desc: 'Theo dõi khách bằng nhãn, ghi chú nội bộ, lịch hẹn; lọc và sắp xếp theo tin nhắn gần nhất; dùng workflow để tự gửi tin nhắc lại (follow-up).' },
  { icon: <AwardIcon className="w-5 h-5" />, title: 'Trung tâm đào tạo / Giáo dục', desc: 'Gửi thông báo lịch học, nhắc học viên, chăm sóc phụ huynh hàng loạt; phân nhóm theo lớp / khoá học bằng nhãn.' },
  { icon: <HeartIcon className="w-5 h-5" />, title: 'Phòng khám / Spa / Làm đẹp', desc: 'Nhắc lịch hẹn và chăm sóc sau dịch vụ bằng workflow; lọc khách có sinh nhật hôm nay / tuần này trong CRM để gửi lời chúc, kéo khách quay lại.' },
  { icon: <CoffeeIcon className="w-5 h-5" />, title: 'F&B / Nhà hàng / Quán ăn', desc: 'Gửi ưu đãi theo dịp, gom khách thân thiết bằng nhãn; nhận đặt bàn qua tin nhắn và tự xác nhận khi khách chuyển khoản (Sepay, Casso).' },
  { icon: <UsersIcon className="w-5 h-5" />, title: 'Đội nhóm bán hàng nhiều người', desc: 'Boss cấp tài khoản nhân viên, giao từng tài khoản chat và phân quyền từng module; nhân viên kết nối qua mạng LAN hoặc Internet, Boss theo dõi hiệu suất từng người.' },
  { icon: <BriefcaseIcon className="w-5 h-5" />, title: 'Đại lý / Nhà phân phối', desc: 'Gửi bảng giá, sản phẩm mới cho mạng lưới đại lý bằng chiến dịch hoặc workflow; phân nhóm đại lý theo khu vực bằng nhãn.' },
  { icon: <SmartphoneIcon className="w-5 h-5" />, title: 'Content Creator / KOC / KOL', desc: 'Gom tin nhắn từ người theo dõi về một chỗ, dùng AI trả lời câu hỏi thường gặp 24/7, chăm sóc người theo dõi thành khách mua hàng.' },
  { icon: <TerminalIcon className="w-5 h-5" />, title: 'Đội kỹ thuật / Tích hợp hệ thống', desc: 'Nối Zalo, Facebook, Telegram vào website, n8n hay phần mềm riêng qua Public API, webhook hoặc ứng dụng tự viết chạy ngay trong Deplao.' },
];

// Theo README "✨ Điểm nổi bật"
const HIGHLIGHTS: InfoItem[] = [
  { icon: <UsersIcon className="w-4 h-4" />, title: 'Đa tài khoản, đa kênh', desc: 'Zalo, Facebook, Telegram, Telegram Bot - không giới hạn tài khoản' },
  { icon: <InboxIcon className="w-4 h-4" />, title: 'Hộp thư tập trung', desc: 'Gộp hội thoại của nhiều tài khoản vào một danh sách' },
  { icon: <RefreshIcon className="w-4 h-4" />, title: 'Đồng bộ tin nhắn cũ', desc: 'Zalo từ điện thoại, Facebook Messenger theo khoảng thời gian' },
  { icon: <CampaignIcon className="w-4 h-4" />, title: 'CRM & Chiến dịch', desc: 'Liên hệ, nhãn, ghi chú, quét thành viên nhóm, gửi tin hàng loạt' },
  { icon: <LightningIcon className="w-4 h-4" />, title: 'Workflow tự động hoá', desc: 'Kéo-thả hoặc nhờ AI copilot, chạy thử ở chế độ Mô phỏng' },
  { icon: <BotIcon className="w-4 h-4" />, title: 'Trợ lý AI', desc: 'Gợi ý trả lời, hỏi đáp trong khung chat, trả lời khách 24/7' },
  { icon: <StoreIcon className="w-4 h-4" />, title: 'Tích hợp bán hàng', desc: 'POS, vận chuyển, thanh toán, Google Sheets, Email, HTTP…' },
  { icon: <PluginIcon className="w-4 h-4" />, title: 'Ứng dụng & Public API', desc: 'Gần 300 API, webhook, ứng dụng tự phát triển' },
  { icon: <CloudIcon className="w-4 h-4" />, title: 'Internet & Đám mây', desc: 'Địa chỉ cố định qua Cloudflare, sao lưu lên R2 / Google Drive' },
  { icon: <ChartIcon className="w-4 h-4" />, title: 'Báo cáo & phân tích', desc: 'Tin nhắn, liên hệ, nhãn, nhân viên, chiến dịch, workflow, AI' },
  { icon: <ClipboardListIcon className="w-4 h-4" />, title: 'Quản lý công việc (ERP)', desc: 'Công việc, lịch làm việc, ghi chú nội bộ' },
  { icon: <BriefcaseIcon className="w-4 h-4" />, title: 'Workspace Boss ↔ nhân viên', desc: 'Kết nối LAN / Internet, phân quyền, theo dõi hiệu suất' },
  { icon: <PaletteIcon className="w-4 h-4" />, title: 'Giao diện Sáng / Tối', desc: 'Đổi trên thanh trên cùng hoặc Cài đặt → Giao diện' },
  { icon: <GlobeIcon className="w-4 h-4" />, title: 'Proxy riêng từng tài khoản', desc: 'Chọn proxy ngay trước khi đăng nhập' },
  { icon: <LockIcon className="w-4 h-4" />, title: 'Dữ liệu lưu trên máy bạn', desc: 'Tin nhắn, danh bạ, CRM, ảnh / video nằm trên máy' },
];

export function OverviewPanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
          <BotIcon className="w-5 h-5" />
        </span>
        <div>
          <h3 className="text-foreground font-bold text-base">Deplao</h3>
          <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">
            Phần mềm desktop quản lý nhiều tài khoản <strong className="text-foreground">Zalo</strong> (cá nhân / Business),{' '}
            <strong className="text-foreground">Facebook</strong> (Messenger), <strong className="text-foreground">Telegram</strong> (tài khoản cá nhân)
            và <strong className="text-foreground">Telegram Bot</strong> trong một ứng dụng. Tích hợp CRM, chiến dịch gửi tin, Workflow tự động,
            Trợ lý AI, POS - vận chuyển - thanh toán và quản lý công việc nội bộ, giúp đội bán hàng, chăm sóc khách hàng và marketing làm việc tập trung.
          </p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            <Badge text="Desktop App" color="bg-primary/15 text-primary" />
            <Badge text="Windows · macOS · Linux" color="bg-muted text-muted-foreground" />
            <Badge text="Dữ liệu lưu trên máy bạn" color="bg-success/15 text-success" />
            <Badge text="Mã nguồn mở (MIT)" color="bg-muted text-muted-foreground" />
          </div>
        </div>
      </div>

      <Card>
        <SectionTitle><TargetIcon className="w-4 h-4 inline" /> Ứng dụng được xây dựng cho ai?</SectionTitle>
        <div className="space-y-2">
          {TARGET_USERS.map((item, i) => (
            <div key={i} className="flex gap-2.5 bg-muted rounded-lg p-2.5">
              <span className="flex-shrink-0 mt-0.5 text-foreground/80">{item.icon}</span>
              <div>
                <p className="text-foreground text-[11px] font-semibold">{item.title}</p>
                <p className="text-muted-foreground text-[11px] mt-0.5 leading-relaxed">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle><SparklesIcon className="w-4 h-4 inline" /> Tính năng nổi bật</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {HIGHLIGHTS.map((f, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 bg-muted rounded-lg px-3 py-2 ${i === HIGHLIGHTS.length - 1 && HIGHLIGHTS.length % 2 === 1 ? 'col-span-2' : ''}`}
            >
              <span className="text-primary flex-shrink-0 mt-0.5">{f.icon}</span>
              <div className="min-w-0">
                <p className="text-foreground text-xs font-medium">{f.title}</p>
                <p className="text-muted-foreground text-[11px] mt-0.5 leading-relaxed">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle><LayoutIcon className="w-4 h-4 inline" /> Các khu vực chính trong app</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Thanh bên trái:</strong> avatar các tài khoản (bấm để chuyển tài khoản, nút <strong class="text-foreground">+</strong> để thêm) và các mục Dashboard · Chat · CRM · Báo cáo · Công cụ · Cài đặt.',
          '<strong class="text-foreground">Công cụ:</strong> Workflow, Tích hợp, Quản lý công việc (ERP) và Ứng dụng, API &amp; Webhook.',
          '<strong class="text-foreground">Thanh trên cùng:</strong> nút <em>Tất cả tính năng</em> để tìm và mở nhanh mọi trang (có thể ẩn / hiện từng mục trên thanh bên), đồng bộ tin nhắn cũ Zalo / Facebook, đổi giao diện Sáng / Tối.',
          '<strong class="text-foreground">Cài đặt:</strong> Hội thoại, Giao diện, Thông báo, Tài khoản, Proxy, Bảo mật, Nhân viên, Workspace, Lưu trữ, Internet &amp; Đám mây, Giới thiệu, Log phiên bản, Nhật ký.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><MonitorIcon className="w-4 h-4 inline" /> Yêu cầu hệ thống &amp; vận hành</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Windows 10 / 11</strong> (64-bit) - bộ cài <strong class="text-foreground">.exe</strong>',
          '<strong class="text-foreground">macOS</strong> - chip Apple Silicon (M1 trở lên) hoặc Intel, bộ cài <strong class="text-foreground">.dmg</strong>',
          '<strong class="text-foreground">Ubuntu / Linux</strong> - file <strong class="text-foreground">.AppImage</strong> (cấp quyền chạy bằng <em>chmod +x</em>) hoặc gói <strong class="text-foreground">.deb</strong>',
          'RAM tối thiểu: <strong class="text-foreground">4 GB</strong> (đề xuất 8 GB trở lên)',
          'Ổ đĩa còn nhiều dung lượng trống: tin nhắn, ảnh, video lưu trên máy và tăng dần theo thời gian (chuyển thư mục dữ liệu sang ổ khác ở Cài đặt → Lưu trữ)',
          'Kết nối Internet ổn định để nhận tin nhắn theo thời gian thực',
          'Để app chạy liên tục <strong class="text-foreground">24/7</strong> nếu dùng workflow, chiến dịch hoặc cho nhân viên kết nối vào máy Boss. Nút × trên thanh tiêu đề chỉ ẩn app xuống khay hệ thống (vẫn nhận tin); muốn tắt hẳn: chuột phải vào biểu tượng Deplao ở khay hệ thống → <em>Thoát hoàn toàn</em>.',
          'Bộ cài chưa ký chứng chỉ nên lần đầu mở có thể bị cảnh báo: Windows chọn <em>More info</em> → <em>Run anyway</em>; macOS chuột phải → <em>Open</em> (hoặc System Settings → Privacy &amp; Security → <em>Open Anyway</em>).',
        ]} />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => ipc.shell?.openExternal(RELEASES_URL)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-muted hover:bg-accent text-foreground text-xs font-medium rounded-lg transition-colors"
          >
            <ExternalLinkIcon className="w-3.5 h-3.5" /> Tải bộ cài / xem tất cả phiên bản
          </button>
        </div>
      </Card>
    </div>
  );
}
