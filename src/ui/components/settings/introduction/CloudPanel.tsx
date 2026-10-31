/**
 * Giới thiệu & Hướng dẫn → "Internet & Đám mây": hướng dẫn trang Cài đặt → Internet & Đám mây (kết nối Cloudflare,
 * Địa chỉ Internet, Kho lưu R2 / Google Drive, Đồng bộ dữ liệu, khôi phục + máy dự phòng, Mức sử dụng & chi phí).
 * Câu chữ bám giao diện ở src/ui/components/settings/cloud/**; giá, hạn mức và cổng lấy thẳng từ R2_PRICING,
 * GDRIVE_LIMITS, SINGLE_HOST_PATH_RULES (src/shared/cloud/cloudContracts.ts) để không lệch khi các số này đổi.
 */
import React from 'react';
import {
  AlertIcon,
  CloudIcon,
  DollarIcon,
  DownloadIcon,
  GlobeIcon,
  HardDriveIcon,
  ImageIcon,
  InfoIcon,
  KeyIcon,
  RefreshIcon,
  ShieldIcon,
} from '@/components/common/icons';
import {
  GDRIVE_LIMITS,
  R2_PRICING,
  SINGLE_HOST_PATH_RULES,
  type TunnelServiceId,
} from '../../../../shared/cloud/cloudContracts';
import { Badge, BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

// ─── Định dạng số (kiểu Việt Nam, giống thẻ Kho lưu / Mức sử dụng) ─────────────────────────

const P = R2_PRICING;
const G = GDRIVE_LIMITS;

/** 12400 → "12.400". */
function num(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Đơn giá USD: 0.015 → "0,015", 4.5 → "4,50", 0.36 → "0,36". */
function usd(n: number): string {
  return n.toFixed(n > 0 && n < 0.1 ? 3 : 2).replace('.', ',');
}

/** 1_000_000 → "1 triệu", 400_000_000 → "400 triệu". */
function millions(n: number): string {
  return `${num(n / 1_000_000)} triệu`;
}

/** Byte → "750 GB", "1 TB" (bước 1024 như giao diện). */
function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${String(Number(v.toFixed(1))).replace('.', ',')} ${units[i]}`;
}

function portOf(service: TunnelServiceId): number | undefined {
  return SINGLE_HOST_PATH_RULES.find(r => r.service === service)?.port;
}

// ─── Mảnh HTML cho BulletList / StepList (chuỗi HTML — dùng class, không dùng className) ──────

const CODE_CLASS = 'rounded border border-border px-1 font-mono text-[11px] text-foreground';
const bold = (html: string) => `<strong class="text-foreground">${html}</strong>`;
const mono = (html: string) => `<code class="${CODE_CLASS}">${html}</code>`;

// ─── Mảnh giao diện riêng của trang này ──────────────────────────────────────────────────────

function SubTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-foreground/80 text-xs font-semibold pt-1">{children}</p>;
}

type CalloutTone = 'info' | 'warning' | 'destructive';

const CALLOUT_STYLE: Record<CalloutTone, { box: string; icon: string }> = {
  info: { box: 'border-info/30 bg-info/10', icon: 'text-info' },
  warning: { box: 'border-warning/40 bg-warning/10', icon: 'text-warning' },
  destructive: { box: 'border-destructive/40 bg-destructive/10', icon: 'text-destructive' },
};

function Callout({ tone = 'info', children }: { tone?: CalloutTone; children: React.ReactNode }) {
  const style = CALLOUT_STYLE[tone];
  const Icon = tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${style.box}`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${style.icon}`} />
      <div className="min-w-0 space-y-1 text-xs leading-relaxed text-foreground/90">{children}</div>
    </div>
  );
}

/** Ô nền muted: tên + nhãn phụ + mô tả (HTML). */
function InfoTile({ title, meta, badge, desc }: { title: string; meta?: string; badge?: string; desc: string }) {
  return (
    <div className="bg-muted rounded-lg p-3 space-y-1">
      <p className="flex flex-wrap items-center gap-1.5 text-foreground text-xs font-semibold">
        {title}
        {badge && <Badge text={badge} color="bg-primary/15 text-primary" />}
        {meta && <span className="text-muted-foreground text-[11px] font-normal">{meta}</span>}
      </p>
      <p className="text-muted-foreground text-[11px] leading-relaxed" dangerouslySetInnerHTML={{ __html: desc }} />
    </div>
  );
}

/** Ô nền muted: tên + danh sách gạch đầu dòng (HTML). */
function ListTile({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="bg-muted rounded-lg p-3 space-y-2">
      <p className="text-foreground text-xs font-semibold">{title}</p>
      <BulletList items={items} />
    </div>
  );
}

// ─── Nội dung ────────────────────────────────────────────────────────────────────────────────

const SERVICES: Array<{ title: string; meta: string; desc: string }> = [
  {
    title: 'Nhân viên và API',
    meta: `cổng ${portOf('relay')}`,
    desc: `Nhân viên làm việc từ xa kết nối vào máy chủ; hệ thống ngoài gọi API qua ${mono('&lt;địa chỉ&gt;/api/v1')}.`,
  },
  {
    title: 'Thanh toán, tích hợp',
    meta: `cổng ${portOf('payments')}`,
    desc: `Casso, SePay gửi giao dịch chuyển khoản, phần mềm bán hàng (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS) gửi đơn hàng / khách hàng vào ${mono('/webhook/…')} để chạy workflow “Khi nhận thanh toán” / “Khi phần mềm bán hàng gửi webhook”.`,
  },
  {
    title: 'Webhook workflow',
    meta: `cổng ${portOf('workflow')}`,
    desc: `Website, dịch vụ bên ngoài kích hoạt workflow qua ${mono('/api/workflow/webhook/…')}.`,
  },
];

const MODES: Array<{ title: string; badge?: string; desc: string }> = [
  {
    title: 'Địa chỉ tạm',
    desc: 'Cloudflare Quick Tunnel, không cần tài khoản. Địa chỉ đổi mỗi lần khởi động lại — phải gửi lại cho nhân viên và cập nhật ở Casso / SePay / phần mềm bán hàng. Chỉ nên dùng thử.',
  },
  {
    title: 'Cloudflare tự động',
    badge: 'Khuyên dùng',
    desc: `Cần kết nối Cloudflare và một tên miền đã thêm vào Cloudflare (gói Free là đủ). Chọn ${bold('Tên miền')} + ${bold('Tên máy')} (vd shop → shop.tenmien.vn), xem trước rồi bấm ${bold('Áp dụng')}. Deplao tự tạo tunnel và tên miền con; địa chỉ cố định, mặc định một địa chỉ cho cả ba dịch vụ.`,
  },
  {
    title: 'ngrok',
    desc: 'Dùng tài khoản ngrok của bạn: dán Authtoken và Domain tĩnh (gói miễn phí có một domain tĩnh). Chỉ áp dụng cho Nhân viên và API.',
  },
  {
    title: 'Cloudflare thủ công',
    desc: 'Dành cho người đã tự tạo tunnel trong Cloudflare Zero Trust: dán Tunnel token và Địa chỉ công khai. Chỉ áp dụng cho Nhân viên và API.',
  },
];

const R2_LINES = [
  `${P.freeStorageGbMonth} GB miễn phí mỗi tháng, sau đó ${usd(P.storageUsdPerGbMonth)} USD/GB-tháng`,
  `${bold('Ghi (Class A)')}: ${millions(P.freeClassA)} lượt/tháng miễn phí, sau đó ${usd(P.classAUsdPerMillion)} USD/triệu lượt`,
  `${bold('Đọc (Class B)')}: ${millions(P.freeClassB)} lượt/tháng miễn phí, sau đó ${usd(P.classBUsdPerMillion)} USD/triệu lượt`,
  'Xoá file và tải xuống: miễn phí',
  'Cần: kết nối Cloudflare đủ quyền R2 và đã bật R2 trên tài khoản',
];

const GDRIVE_LINES = [
  '15 GB miễn phí, dùng chung Gmail và Google Photos; thêm dung lượng theo gói Google One',
  `Không tính phí theo lượt đọc / ghi — hạn mức ${millions(G.unitsPerDayPerProject)} đơn vị/ngày cho cả client OAuth`,
  `Tải xuống miễn phí dưới ${bytes(G.egressBytesPerDayPerProject)}/ngày · tải lên tối đa ${bytes(G.uploadBytesPerDayPerUser)}/ngày mỗi tài khoản`,
  'Cần: tài khoản Google (không cần Cloudflare)',
];

const R2_USAGE = [
  `${bold('Phí ước tính tháng này')} và ${bold('dự kiến cả tháng')} (USD, kèm quy đổi ₫ ước tính); còn trong phần miễn phí thì báo "Chưa phát sinh phí". Kỳ tính là tháng dương lịch (giờ UTC).`,
  `${bold('Dung lượng đang lưu')} — tính theo GB-tháng (trung bình dung lượng cao nhất mỗi ngày); ${P.freeStorageGbMonth} GB-tháng miễn phí.`,
  `${bold('Ghi (Class A)')} — mỗi lần đẩy file hoặc một phần file lớn, tạo / hoàn tất tải lên nhiều phần, liệt kê file; ${millions(P.freeClassA)} lượt/tháng miễn phí.`,
  `${bold('Đọc (Class B)')} — mỗi lần tải file về máy hoặc kiểm tra file đã có trên kho; ${millions(P.freeClassB)} lượt/tháng miễn phí.`,
  `${bold('Tải xuống')} — dung lượng tải về; R2 không tính phí, chỉ để biết.`,
  'Số liệu toàn tài khoản cần quyền "Account Analytics: Read" trong token. Đây là ước tính theo bảng giá R2 Standard; số trên hoá đơn Cloudflare mới là chính xác (nút Xem hoá đơn trên Cloudflare).',
];

const GDRIVE_USAGE = [
  'Không tính phí theo lượt dùng (dưới ngưỡng) — bạn chỉ trả gói Google One nếu dùng quá 15 GB.',
  `${bold('Dung lượng tài khoản Google')} — dùng chung Gmail, Drive, Photos.`,
  `${bold('Lượt dùng Drive API hôm nay')} — tính bằng "đơn vị": đọc thông tin ${G.unitsRead}, liệt kê ${G.unitsList}, tải xuống ${G.unitsDownload}, ghi/sửa ${G.unitsEdit}; ngưỡng miễn phí ${millions(G.unitsPerDayPerProject)} đơn vị/ngày cho cả client OAuth (Google báo sẽ tính phí phần vượt từ cuối 2026).`,
  `${bold('Tải xuống hôm nay')} — miễn phí dưới ${bytes(G.egressBytesPerDayPerProject)}/ngày cho cả client OAuth. ${bold('Tải lên hôm nay')} — tối đa ${bytes(G.uploadBytesPerDayPerUser)}/ngày mỗi tài khoản.`,
  '"Hôm nay" tính theo giờ Mỹ – Thái Bình Dương. Google không cho đọc mức dùng của cả client OAuth, nên số lượt và dung lượng tải là của Deplao trên máy này.',
];

export function CloudPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><CloudIcon className="w-4 h-4 inline" /> Internet &amp; Đám mây</SectionTitle>
        <Paragraph>
          Một trang cho mọi thứ cần Internet và đám mây của chính bạn: địa chỉ để nhân viên ở xa, API, cổng thanh toán và
          webhook gọi vào máy; lưu ảnh, file và sao lưu dữ liệu (mã hoá trên máy) lên Cloudflare R2 hoặc Google Drive;
          khôi phục sang máy mới khi cần.
        </Paragraph>
        <BulletList items={[
          `${bold('Ở đâu:')} Cài đặt → Internet &amp; Đám mây. Chỉ có trên máy chủ; máy nhân viên không thấy mục này.`,
          `${bold('Hai phần:')} ${bold('Địa chỉ Internet')} (nhân viên ở xa, API, thanh toán, webhook) và ${bold('Đồng bộ dữ liệu')} (sao lưu tin nhắn, danh bạ, ảnh, file; khôi phục khi đổi máy).`,
          `${bold('Tuỳ chọn, mặc định tắt:')} không bật thì app chạy như cũ, dữ liệu chỉ nằm trên máy. Mọi thứ dùng tài khoản Cloudflare / Google của chính bạn.`,
          `${bold('Chấm đỏ')} cạnh mục Internet &amp; Đám mây = có việc cần xem: token lỗi hoặc thiếu quyền, địa chỉ lỗi, đồng bộ lỗi, hoặc vừa khôi phục và tự động hoá đang tạm dừng.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><KeyIcon className="w-4 h-4 inline" /> Kết nối tài khoản Cloudflare</SectionTitle>
        <Paragraph>
          Cần cho địa chỉ cố định (Cloudflare tự động) và kho Cloudflare R2. Chỉ dùng Địa chỉ tạm, ngrok hoặc kho Google Drive
          thì không cần Cloudflare.
        </Paragraph>
        <StepList steps={[
          {
            title: 'Tạo token',
            desc: `Ở đầu trang, bấm ${bold('Tạo token trên Cloudflare')}: trang Cloudflare mở ra với quyền đã điền sẵn → ${bold('Continue to summary')} → ${bold('Create Token')} → sao chép token.`,
          },
          {
            title: 'Dán token và Account ID',
            desc: `Account ID gồm 32 ký tự, xem ở trang Overview của tên miền trên Cloudflare hoặc trên thanh địa chỉ ${mono('dash.cloudflare.com/&lt;Account ID&gt;')}.`,
          },
          {
            title: 'Bấm Kết nối',
            desc: 'Deplao kiểm tra token, đọc danh sách tên miền và thử quyền của từng tính năng. Token được lưu mã hoá trên máy này.',
          },
        ]} />
        <SubTitle>Token xin những quyền gì (nói dễ hiểu)</SubTitle>
        <BulletList items={[
          `${bold('Cloudflare Tunnel — Edit:')} tạo "đường hầm" nối máy bạn ra Internet cho địa chỉ cố định.`,
          `${bold('DNS — Edit:')} tạo tên miền con (vd shop.tenmien.vn) trỏ vào đường hầm đó.`,
          `${bold('Zone — Read:')} đọc danh sách tên miền bạn đã thêm vào Cloudflare.`,
          `${bold('Workers R2 Storage — Edit:')} tạo kho (bucket) lưu ảnh, file và bản sao dữ liệu.`,
          `${bold('Account Analytics — Read:')} đọc mức dùng R2 của cả tài khoản cho thẻ Mức sử dụng &amp; chi phí; thiếu quyền này thì chỉ đếm được thao tác của Deplao trên máy này.`,
        ]} />
        <SubTitle>Lưu ý</SubTitle>
        <BulletList items={[
          `Deplao chỉ tạo tunnel, tên miền con và bucket có tên ${mono('deplao-…')}; dữ liệu khác trên Cloudflare không bị đụng tới.`,
          'Dùng kho R2 thì phải bật R2 trên tài khoản (Cloudflare → R2 Object Storage). Cloudflare yêu cầu thêm phương thức thanh toán dù chỉ dùng phần miễn phí.',
          `Đã kết nối: nút ${bold('Quản lý')} có Kiểm tra lại token · Đổi token · Mở Cloudflare · Ngắt kết nối. Token thiếu quyền hoặc sắp hết hạn (còn ≤ 14 ngày) được báo ngay dưới tên tài khoản.`,
          'Ngắt kết nối: địa chỉ cố định và đồng bộ lên R2 trên máy này dừng; dữ liệu đã có trên Cloudflare vẫn giữ nguyên.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><GlobeIcon className="w-4 h-4 inline" /> Địa chỉ Internet</SectionTitle>
        <Paragraph>
          Máy tính của bạn không có địa chỉ công khai. Địa chỉ Internet giúp nhân viên ở xa và hệ thống bên ngoài gọi vào
          Deplao mà không cần VPS hay mở cổng router. Đây là nơi duy nhất bật, tắt và đổi địa chỉ — các màn Nhân viên, API,
          Webhook, Tích hợp, Workflow chỉ hiện địa chỉ và dẫn về đây.
        </Paragraph>
        <SubTitle>Ba dịch vụ, mỗi dịch vụ một công tắc riêng</SubTitle>
        <div className="grid gap-2 md:grid-cols-3">
          {SERVICES.map(s => <InfoTile key={s.title} {...s} />)}
        </div>
        <SubTitle>Cách tạo địa chỉ — chọn một</SubTitle>
        <div className="grid gap-2 md:grid-cols-2">
          {MODES.map(m => <InfoTile key={m.title} {...m} />)}
        </div>
        <Callout>
          Ở chế độ ngrok và Cloudflare thủ công, Thanh toán, tích hợp và Webhook workflow vẫn dùng Địa chỉ tạm (đổi mỗi lần
          bật lại). Muốn cả ba dịch vụ có địa chỉ cố định, chọn Cloudflare tự động.
        </Callout>
        <BulletList items={[
          `${bold('Tự bật khi mở app:')} tunnel chạy lại ngay khi mở Deplao. Ở các chế độ khác Cloudflare tự động, chỉ Nhân viên và API tự bật lại, và chỉ khi máy chủ nhân viên (LAN) cũng tự chạy lúc mở app; Thanh toán và Webhook workflow bật lại ở bảng dịch vụ khi cần.`,
          'Địa chỉ chỉ hoạt động khi Deplao đang mở trên máy chủ.',
          'Đổi tên miền / tên máy hoặc đổi cách tạo địa chỉ thì địa chỉ cũ ngừng hoạt động — nhớ cập nhật ở Casso, SePay, phần mềm bán hàng, website và gửi địa chỉ mới cho nhân viên ở xa.',
          `${bold('Nâng cao')} (Cloudflare tự động): tách tên riêng cho từng dịch vụ (shop, shop-pay, shop-hook) · Chuyển sang máy này khi đổi máy chủ · Ngắt máy lạ đang chạy cùng tunnel · Gỡ tunnel và địa chỉ.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><HardDriveIcon className="w-4 h-4 inline" /> Kho lưu: Cloudflare R2 hoặc Google Drive</SectionTitle>
        <Paragraph>
          Kho lưu là nơi đặt ảnh, file và bản sao dữ liệu — chọn ở Đồng bộ dữ liệu → thẻ{' '}
          <strong className="text-foreground">Kho lưu</strong>. Mỗi lúc dùng một kho; Địa chỉ Internet vẫn chạy trên Cloudflare,
          không phụ thuộc kho.
        </Paragraph>
        <div className="grid gap-2 md:grid-cols-2">
          <ListTile title="Cloudflare R2" items={R2_LINES} />
          <ListTile title="Google Drive (Google One)" items={GDRIVE_LINES} />
        </div>
        <BulletList items={[
          `${bold('Đăng nhập Google')} diễn ra trên trình duyệt của máy: bấm Đăng nhập Google ở thẻ Google Drive rồi đồng ý trên trang Google. Deplao chỉ thấy file do chính Deplao tạo (thư mục ${bold('Deplao')} trong Drive của bạn), không đọc được file khác.`,
          `${bold('Nâng cao: dùng client OAuth riêng')} — tạo miễn phí một client "Desktop app" trên Google Cloud theo 4 bước hướng dẫn ngay trong thẻ (bật Google Drive API, quyền drive.file, Publishing status chọn In production — để Testing thì sau 7 ngày phải đăng nhập lại), rồi dán Client ID / Client secret. Hạn mức Drive API mỗi ngày khi đó là của riêng bạn. Bản Deplao không có sẵn client Google chung thì phần này tự mở và là cách để đăng nhập.`,
          `Dùng client riêng thì máy khác muốn khôi phục phải đăng nhập bằng ${bold('cùng client')} đó (Deplao chỉ thấy file do chính client đó tạo).`,
          `${bold('Đổi kho')} chỉ được khi đồng bộ đang tắt và máy không làm máy dự phòng. Sau khi đổi, ảnh, file tải lại từ đầu lên kho mới, dữ liệu tạo bản gốc mới; bản trên kho cũ vẫn giữ — chọn lại kho cũ để khôi phục từ đó. Còn file đã dọn khỏi máy (chỉ nằm trên kho cũ) thì tải về máy trước.`,
          'Ngắt kết nối Google Drive: Deplao thu hồi quyền và xoá đăng nhập trên máy này; file đã lên Drive vẫn giữ.',
        ]} />
        <Callout tone="warning">
          Dung lượng Google dùng chung với Gmail và Google Photos: đầy thì không tải lên được và Gmail có thể không nhận thư —
          nên dùng một tài khoản Google riêng cho sao lưu.
        </Callout>
      </Card>

      <Card>
        <SectionTitle><RefreshIcon className="w-4 h-4 inline" /> Đồng bộ dữ liệu — bật trong 5 bước</SectionTitle>
        <Paragraph>
          Một thiết lập chung cho dữ liệu (tin nhắn, danh bạ, cài đặt…) và ảnh, file của workspace đang mở. Dữ liệu được nén và
          mã hoá ngay trên máy rồi mới tải lên kho của bạn.
        </Paragraph>
        <StepList steps={[
          {
            title: 'Chọn kho lưu',
            desc: `Thẻ ${bold('Kho lưu')}: Cloudflare R2 (đã kết nối Cloudflare đủ quyền) hoặc Google Drive (đã đăng nhập Google).`,
          },
          {
            title: 'Chọn tài khoản và thời gian',
            desc: `${bold('Tài khoản:')} Tất cả (kể cả tài khoản thêm sau) hoặc Chọn tài khoản. ${bold('Thời gian:')} Toàn bộ hoặc Từ ngày — "Từ ngày" giới hạn lịch sử tin và ảnh, file theo thời gian; danh bạ, nhóm, cài đặt của tài khoản được chọn vẫn đồng bộ đủ.`,
          },
          {
            title: 'Chọn chế độ',
            desc: `${bold('Theo giờ:')} đẩy thay đổi mỗi giờ. ${bold('Realtime:')} trễ tối đa 5 giây. Không có thay đổi thì không gọi kho. ${bold('Tắt:')} ngừng đồng bộ, bản đã có vẫn giữ và khôi phục được.`,
          },
          {
            title: 'Kèm ảnh, video, file',
            desc: `Mặc định bật: ảnh, file tải dần lên kho trong nền, có thể kèm ${bold('File chung')} (thư viện media, công việc, file tải lên). Bỏ chọn thì chỉ đồng bộ tin nhắn, danh bạ, cài đặt.`,
          },
          {
            title: 'Bấm Bật đồng bộ',
            desc: `Lần đầu Deplao hỏi ${bold('mật khẩu sao lưu')} (ít nhất 8 ký tự, nhập hai lần, tick ô xác nhận) rồi chụp bản gốc ngay: sao chép DB → lọc theo phạm vi → nén → mã hoá → tải lên. Sau đó chỉ đẩy phần thay đổi.`,
          },
        ]} />
        <Callout tone="destructive">
          <p>
            <strong className="text-foreground">Giữ kỹ mật khẩu sao lưu.</strong> Bản trên kho được mã hoá bằng mật khẩu này;
            máy mới và máy dự phòng phải nhập đúng mật khẩu khi khôi phục. Quên mật khẩu là mất bản trên kho — ghi lại ở nơi
            an toàn.
          </p>
        </Callout>
        <BulletList items={[
          `Đang đồng bộ thì thiết lập thu gọn thành một dòng tóm tắt; bấm ${bold('Thay đổi')} để sửa. Đổi tài khoản / thời gian khi đã có bản trên kho thì Deplao tạo bản gốc mới thay bản cũ (file ảnh đã lên vẫn giữ).`,
          `${bold('Trạng thái:')} Dữ liệu (lần đồng bộ gần nhất, bản trên kho, phạm vi; nút ${bold('Đồng bộ ngay')}, ${bold('Khôi phục…')}) và Ảnh &amp; file (đã lên bao nhiêu file; ${bold('Tạm dừng')} / ${bold('Tiếp tục')}).`,
          'Đổi mật khẩu ở dòng Mật khẩu sao lưu → Đổi mật khẩu; máy dự phòng phải nhập lại mật khẩu mới.',
          'Mỗi workspace của máy chủ có thư mục riêng trên kho; máy nhân viên không tải lên. Cài đặt → Lưu trữ có dòng "Media trên đám mây" để xem nhanh.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><ImageIcon className="w-4 h-4 inline" /> Ảnh, file và phần Nâng cao</SectionTitle>
        <Paragraph>
          Phần <strong className="text-foreground">Nâng cao</strong> ở cuối trang Đồng bộ dữ liệu (mở sẵn, bấm tiêu đề để thu
          gọn) gom các tuỳ chọn ít dùng.
        </Paragraph>
        <BulletList items={[
          `${bold('Mặc định giữ nguyên file trên máy')} — kho chỉ giữ thêm một bản sao.`,
          `${bold('Giải phóng ổ (tuỳ chọn):')} "Xoá bản trên máy của file cũ để giải phóng ổ" chỉ xoá bản trên máy của file đã có trên kho, không mở trong 30 ngày gần đây và khi ổ còn trống dưới 20 GB (hai số này đổi được). Mở lại file thì Deplao tự tải về từ kho.`,
          `${bold('Tải lại toàn bộ file đã dọn')} về máy khi cần (cần đủ chỗ trống trên ổ).`,
          `${bold('Tải ảnh &amp; file:')} số file tải song song, giới hạn băng thông (0 = không giới hạn), "Chỉ chạy từ 22:00 đến 07:00".`,
          `Ngoài ra: ${bold('Máy dự phòng')}, ${bold('Bản sao DB')} trên kho (xem, xoá hẳn bản của máy cũ không dùng nữa) và ${bold('Nhật ký đồng bộ')}.`,
        ]} />
        <SubTitle>Dọn file trên kho — quét trước, xác nhận mới xoá</SubTitle>
        <BulletList items={[
          `Xoá tin trong app không xoá file trên kho. Muốn bớt dung lượng thì bấm ${bold('Dọn file trên R2')} / ${bold('Dọn file trên Google Drive')} (cần đang đồng bộ kèm ảnh, video, file).`,
          'Chọn loại file: của tin đã xoá trong app (mặc định), của tài khoản…, cũ hơn ngày…, ngoài phạm vi lưu hiện tại.',
          `Bấm ${bold('Quét')}: chỉ đếm số file, dung lượng, ví dụ đường dẫn — chưa xoá gì. Kết quả quét dùng được trong 15 phút.`,
          `Bấm ${bold('Xoá … file')} và xác nhận thì mới xoá — không hoàn tác được.`,
          'An toàn mặc định: giữ lại file chỉ còn trên kho (đã dọn khỏi máy) và không xoá bản trên máy; muốn xoá các file này phải tự tick.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><DownloadIcon className="w-4 h-4 inline" /> Khôi phục sang máy mới &amp; máy dự phòng</SectionTitle>
        <Paragraph>
          Đổi máy, cài lại Windows hay máy chủ hỏng: lấy lại dữ liệu từ bản sao trên kho. Trên máy mới cài Deplao, bấm{' '}
          <strong className="text-foreground">Khôi phục dữ liệu từ đám mây</strong> (dòng &quot;Chuyển từ máy khác?&quot; ở
          Dashboard khi chưa có tài khoản, hoặc trong hộp Thêm tài khoản) — dùng được cho cả Cloudflare R2 và Google Drive. Khôi phục
          ngay trên máy đang dùng: bấm <strong className="text-foreground">Khôi phục…</strong> ở phần Trạng thái.
        </Paragraph>
        <StepList steps={[
          {
            title: 'Kết nối kho',
            desc: 'Chọn bản sao nằm ở Cloudflare R2 hay Google Drive. R2: dán token Cloudflare cho máy này (token lưu ở máy cũ không mang sang được). Google Drive: đăng nhập đúng tài khoản Google đã dùng để sao lưu.',
          },
          {
            title: 'Chọn workspace',
            desc: 'Mỗi workspace có một bản, kèm tên máy, lần đồng bộ, dung lượng, phạm vi. Bản do Deplao mới hơn tạo bị khoá — cập nhật app trước.',
          },
          {
            title: 'Nhập mật khẩu sao lưu',
            desc: 'Mật khẩu đặt khi bật đồng bộ trên máy chủ; Deplao giải mã trên máy này, không gửi mật khẩu đi đâu. Có thể chọn khôi phục tới một thời điểm cũ hơn.',
          },
          {
            title: 'Khôi phục dữ liệu',
            desc: 'Dữ liệu của workspace trên máy được thay bằng bản trên kho. Không đóng app trong lúc khôi phục.',
          },
          {
            title: 'Đăng nhập lại kênh',
            desc: 'Lịch sử đã về; đăng nhập lại từng tài khoản (Zalo quét QR, Facebook, Telegram bằng số điện thoại, bot dán lại token). Ảnh, file tự tải từ kho khi mở, hoặc bấm Tải hết media về máy.',
          },
          {
            title: 'Bật lại tự động hoá',
            desc: 'Chiến dịch, workflow và lịch của ứng dụng tạm dừng sau khôi phục để không gửi trùng với máy cũ. Tick "Máy cũ đã tắt hoặc đã ngắt Deplao" rồi bấm Bật lại tự động hoá; đang dùng Cloudflare tự động thì có thể chuyển luôn địa chỉ Internet sang máy này.',
          },
        ]} />
        <SubTitle>Máy dự phòng</SubTitle>
        <BulletList items={[
          `Máy thứ hai cài Deplao, kết nối cùng Cloudflare (hoặc chọn kho Google Drive và đăng nhập cùng tài khoản Google) → Đồng bộ dữ liệu → Nâng cao → Máy dự phòng → ${bold('Dùng máy này theo dõi bản của máy khác…')} → chọn bản sao, nhập mật khẩu sao lưu của máy chủ.`,
          'Máy dự phòng tải đoạn mới mỗi phút; máy chủ thấy máy nào đang theo dõi và trễ bao lâu.',
          `Máy chủ hỏng: trên máy dự phòng bấm ${bold('Chuyển sang máy này')} → đăng nhập lại kênh → bật lại tự động hoá. Chỉ làm khi máy chủ cũ đã hỏng hoặc đã tắt, tránh hai máy cùng gửi tin.`,
        ]} />
        <Callout tone="warning">
          Dữ liệu khôi phục không tự kết nối kênh chat. Dải &quot;Đã khôi phục dữ liệu…&quot; ở đầu trang Internet &amp; Đám mây
          nhắc tự động hoá đang tạm dừng cho tới khi bạn bật lại.
        </Callout>
      </Card>

      <Card>
        <SectionTitle><DollarIcon className="w-4 h-4 inline" /> Mức sử dụng &amp; chi phí</SectionTitle>
        <Paragraph>
          Thẻ Mức sử dụng &amp; chi phí (dưới phần Trạng thái) cho biết kho đang dùng bao nhiêu so với phần miễn phí hoặc ngưỡng
          tính phí, để không bất ngờ khi nhận hoá đơn.
        </Paragraph>
        <BulletList items={[
          'Mỗi mục có thanh % so với phần miễn phí / ngưỡng: chuyển vàng từ 70%, đỏ khi vượt 100%; kèm số dự kiến cuối kỳ theo nhịp dùng hiện tại.',
          `Nút ${bold('Cập nhật')} đọc lại số liệu ngay (tối đa một lần mỗi phút). Nhãn ${bold('máy này')} nghĩa là số chỉ tính Deplao trên máy này, chưa gồm máy khác hay ứng dụng khác.`,
        ]} />
        <div className="grid gap-2 md:grid-cols-2">
          <ListTile title="Cloudflare R2 — tính theo tháng" items={R2_USAGE} />
          <ListTile title="Google Drive — tính theo ngày" items={GDRIVE_USAGE} />
        </div>
      </Card>

      <Card>
        <SectionTitle><ShieldIcon className="w-4 h-4 inline" /> Bảo mật &amp; lưu ý</SectionTitle>
        <BulletList items={[
          'Token Cloudflare, token ngrok / tunnel và mật khẩu sao lưu được lưu mã hoá trên máy chủ; giao diện không hiện lại.',
          'Dữ liệu (tin nhắn, danh bạ…) được mã hoá trên máy trước khi tải lên; ảnh, file nằm trong kho riêng tư của bạn.',
          'Xoá trên kho (Dọn file, xoá bản sao DB của máy cũ) là xoá hẳn, không hoàn tác.',
          'Ngắt kết nối Cloudflare / Google không xoá dữ liệu đã có trên kho.',
          'Chỉ bật dịch vụ địa chỉ Internet đang cần; gọi API từ ngoài vẫn phải có API key.',
          'Sau khôi phục hoặc khi chuyển sang máy dự phòng: chỉ bật lại tự động hoá khi chắc máy cũ đã tắt.',
        ]} />
      </Card>
    </div>
  );
}
