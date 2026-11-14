/**
 * Introduction & Guide → "Internet & Cloud" (Internet & Cloud): guide to the Settings → Internet & Cloud page (Cloudflare connection,
 * Internet address, R2 / Google Drive storage, Data sync, restore + standby machine, Usage & cost).
 * The wording follows the UI in src/ui/components/settings/cloud/**; prices, limits and ports are taken directly from R2_PRICING,
 * GDRIVE_LIMITS, SINGLE_HOST_PATH_RULES (src/shared/cloud/cloudContracts.ts) so they do not drift when those numbers change.
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
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// ─── Number formatting (Vietnamese style, same as the Storage / Usage cards) ─────────────────────────

const P = R2_PRICING;
const G = GDRIVE_LIMITS;

/** 12400 → "12.400". */
function num(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** USD unit price: 0.015 → "0,015", 4.5 → "4,50", 0.36 → "0,36". */
function usd(n: number): string {
  return n.toFixed(n > 0 && n < 0.1 ? 3 : 2).replace('.', ',');
}

/** 1_000_000 → "1 triệu" (1 million), 400_000_000 → "400 triệu" (400 million). */
function millions(n: number): string {
  return tr('{{v1}} triệu', { v1: num(n / 1_000_000) });
}

/** Bytes → "750 GB", "1 TB" (steps of 1024, as in the UI). */
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

// ─── HTML pieces for BulletList / StepList (HTML strings: use class, not className) ──────

const CODE_CLASS = 'rounded border border-border px-1 font-mono text-[11px] text-foreground';
const bold = (html: string) => `<strong class="text-foreground">${html}</strong>`;
const mono = (html: string) => `<code class="${CODE_CLASS}">${html}</code>`;

// ─── This page's own UI pieces ──────────────────────────────────────────────────────

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

/** Muted box: name + secondary label + description (HTML). */
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

/** Muted box: name + bullet list (HTML). */
function ListTile({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="bg-muted rounded-lg p-3 space-y-2">
      <p className="text-foreground text-xs font-semibold">{title}</p>
      <BulletList items={items} />
    </div>
  );
}

// ─── Content ────────────────────────────────────────────────────────────────────────────────

const SERVICES: Array<{ title: string; meta: string; desc: string }> = [
  {
    title: tr('Nhân viên và API'),
    meta: tr('cổng {{v1}}', { v1: portOf('relay') }),
    desc: tr('Nhân viên làm việc từ xa kết nối vào máy chủ; hệ thống ngoài gọi API qua {{v1}}.', { v1: mono(tr('&lt;địa chỉ&gt;/api/v1')) }),
  },
  {
    title: tr('Thanh toán, tích hợp'),
    meta: tr('cổng {{v1}}', { v1: portOf('payments') }),
    desc: tr('Casso, SePay gửi giao dịch chuyển khoản, phần mềm bán hàng (KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS) gửi đơn hàng / khách hàng vào {{v1}} để chạy workflow “Khi nhận thanh toán” / “Khi phần mềm bán hàng gửi webhook”.', { v1: mono('/webhook/…') }),
  },
  {
    title: tr('Webhook workflow'),
    meta: tr('cổng {{v1}}', { v1: portOf('workflow') }),
    desc: tr('Website, dịch vụ bên ngoài kích hoạt workflow qua {{v1}}.', { v1: mono('/api/workflow/webhook/…') }),
  },
];

const MODES: Array<{ title: string; badge?: string; desc: string }> = [
  {
    title: tr('Địa chỉ tạm'),
    desc: tr('Cloudflare Quick Tunnel, không cần tài khoản. Địa chỉ đổi mỗi lần khởi động lại — phải gửi lại cho nhân viên và cập nhật ở Casso / SePay / phần mềm bán hàng. Chỉ nên dùng thử.'),
  },
  {
    title: tr('Cloudflare tự động'),
    badge: tr('Khuyên dùng'),
    desc: tr('Cần kết nối Cloudflare và một tên miền đã thêm vào Cloudflare (gói Free là đủ). Chọn {{v1}} + {{v2}} (vd shop → shop.tenmien.vn), xem trước rồi bấm {{v3}}. Deplao tự tạo tunnel và tên miền con; địa chỉ cố định, mặc định một địa chỉ cho cả ba dịch vụ.', { v1: bold(tr('Tên miền')), v2: bold(tr('Tên máy')), v3: bold(tr('Áp dụng')) }),
  },
  {
    title: 'ngrok',
    desc: tr('Dùng tài khoản ngrok của bạn: dán Authtoken và Domain tĩnh (gói miễn phí có một domain tĩnh). Chỉ áp dụng cho Nhân viên và API.'),
  },
  {
    title: tr('Cloudflare thủ công'),
    desc: tr('Dành cho người đã tự tạo tunnel trong Cloudflare Zero Trust: dán Tunnel token và Địa chỉ công khai. Chỉ áp dụng cho Nhân viên và API.'),
  },
];

const R2_LINES = [
  tr('{{freeStorageGbMonth}} GB miễn phí mỗi tháng, sau đó {{v1}} USD/GB-tháng', { freeStorageGbMonth: P.freeStorageGbMonth, v1: usd(P.storageUsdPerGbMonth) }),
  tr('{{v1}}: {{v2}} lượt/tháng miễn phí, sau đó {{v3}} USD/triệu lượt', { v1: bold('Ghi (Class A)'), v2: millions(P.freeClassA), v3: usd(P.classAUsdPerMillion) }),
  tr('{{v1}}: {{v2}} lượt/tháng miễn phí, sau đó {{v3}} USD/triệu lượt', { v1: bold(tr('Đọc (Class B)')), v2: millions(P.freeClassB), v3: usd(P.classBUsdPerMillion) }),
  tr('Xoá file và tải xuống: miễn phí'),
  tr('Cần: kết nối Cloudflare đủ quyền R2 và đã bật R2 trên tài khoản'),
];

const GDRIVE_LINES = [
  tr('15 GB miễn phí, dùng chung Gmail và Google Photos; thêm dung lượng theo gói Google One'),
  tr('Không tính phí theo lượt đọc / ghi — hạn mức {{v1}} đơn vị/ngày cho cả client OAuth', { v1: millions(G.unitsPerDayPerProject) }),
  tr('Tải xuống miễn phí dưới {{v1}}/ngày · tải lên tối đa {{v2}}/ngày mỗi tài khoản', { v1: bytes(G.egressBytesPerDayPerProject), v2: bytes(G.uploadBytesPerDayPerUser) }),
  tr('Cần: tài khoản Google (không cần Cloudflare)'),
];

const R2_USAGE = [
  tr('{{v1}} và {{v2}} (USD, kèm quy đổi ₫ ước tính); còn trong phần miễn phí thì báo "Chưa phát sinh phí". Kỳ tính là tháng dương lịch (giờ UTC).', { v1: bold(tr('Phí ước tính tháng này')), v2: bold(tr('dự kiến cả tháng')) }),
  tr('{{v1}} — tính theo GB-tháng (trung bình dung lượng cao nhất mỗi ngày); {{freeStorageGbMonth}} GB-tháng miễn phí.', { v1: bold(tr('Dung lượng đang lưu')), freeStorageGbMonth: P.freeStorageGbMonth }),
  tr('{{v1}} — mỗi lần đẩy file hoặc một phần file lớn, tạo / hoàn tất tải lên nhiều phần, liệt kê file; {{v2}} lượt/tháng miễn phí.', { v1: bold('Ghi (Class A)'), v2: millions(P.freeClassA) }),
  tr('{{v1}} — mỗi lần tải file về máy hoặc kiểm tra file đã có trên kho; {{v2}} lượt/tháng miễn phí.', { v1: bold(tr('Đọc (Class B)')), v2: millions(P.freeClassB) }),
  tr('{{v1}} — dung lượng tải về; R2 không tính phí, chỉ để biết.', { v1: bold(tr('Tải xuống')) }),
  tr('Số liệu toàn tài khoản cần quyền "Account Analytics: Read" trong token. Đây là ước tính theo bảng giá R2 Standard; số trên hoá đơn Cloudflare mới là chính xác (nút Xem hoá đơn trên Cloudflare).'),
];

const GDRIVE_USAGE = [
  tr('Không tính phí theo lượt dùng (dưới ngưỡng) — bạn chỉ trả gói Google One nếu dùng quá 15 GB.'),
  tr('{{v1}} — dùng chung Gmail, Drive, Photos.', { v1: bold(tr('Dung lượng tài khoản Google')) }),
  tr('{{v1}} — tính bằng "đơn vị": đọc thông tin {{unitsRead}}, liệt kê {{unitsList}}, tải xuống {{unitsDownload}}, ghi/sửa {{unitsEdit}}; ngưỡng miễn phí {{v2}} đơn vị/ngày cho cả client OAuth (Google báo sẽ tính phí phần vượt từ cuối 2026).', { v1: bold(tr('Lượt dùng Drive API hôm nay')), unitsRead: G.unitsRead, unitsList: G.unitsList, unitsDownload: G.unitsDownload, unitsEdit: G.unitsEdit, v2: millions(G.unitsPerDayPerProject) }),
  tr('{{v1}} — miễn phí dưới {{v2}}/ngày cho cả client OAuth. {{v3}} — tối đa {{v4}}/ngày mỗi tài khoản.', { v1: bold(tr('Tải xuống hôm nay')), v2: bytes(G.egressBytesPerDayPerProject), v3: bold(tr('Tải lên hôm nay')), v4: bytes(G.uploadBytesPerDayPerUser) }),
  tr('"Hôm nay" tính theo giờ Mỹ – Thái Bình Dương. Google không cho đọc mức dùng của cả client OAuth, nên số lượt và dung lượng tải là của Deplao trên máy này.'),
];

export function CloudPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Internet & Cloud', { 0: <CloudIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Một trang cho mọi thứ cần Internet và Cloud của chính bạn: địa chỉ để nhân viên ở xa, API, cổng thanh toán và webhook gọi vào máy; lưu ảnh, file và sao lưu dữ liệu (mã hoá trên máy) lên Cloudflare R2 hoặc Google Drive; khôi phục sang máy mới khi cần.')}
        </Paragraph>
        <BulletList items={[
          tr('{{v1}} Cài đặt → Internet &amp; Cloud. Chỉ có trên máy chủ; máy nhân viên không thấy mục này.', { v1: bold(tr('Ở đâu:')) }),
          tr('{{v1}} {{v2}} (nhân viên ở xa, API, thanh toán, webhook) và {{v3}} (sao lưu tin nhắn, danh bạ, ảnh, file; khôi phục khi đổi máy).', { v1: bold(tr('Hai phần:')), v2: bold(tr('Địa chỉ Internet')), v3: bold(tr('Đồng bộ dữ liệu')) }),
          tr('{{v1}} không bật thì app chạy như cũ, dữ liệu chỉ nằm trên máy. Mọi thứ dùng tài khoản Cloudflare / Google của chính bạn.', { v1: bold(tr('Tuỳ chọn, mặc định tắt:')) }),
          tr('{{v1}} cạnh mục Internet &amp; Cloud = có việc cần xem: token lỗi hoặc thiếu quyền, địa chỉ lỗi, đồng bộ lỗi, hoặc vừa khôi phục và tự động hoá đang tạm dừng.', { v1: bold(tr('Chấm đỏ')) }),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Kết nối tài khoản Cloudflare', { 0: <KeyIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Cần cho địa chỉ cố định (Cloudflare tự động) và kho Cloudflare R2. Chỉ dùng Địa chỉ tạm, ngrok hoặc kho Google Drive thì không cần Cloudflare.')}
        </Paragraph>
        <StepList steps={[
          {
            title: tr('Tạo token'),
            desc: tr('Ở đầu trang, bấm {{v1}}: trang Cloudflare mở ra với quyền đã điền sẵn → {{v2}} → {{v3}} → sao chép token.', { v1: bold(tr('Tạo token trên Cloudflare')), v2: bold('Continue to summary'), v3: bold('Create Token') }),
          },
          {
            title: tr('Dán token và Account ID'),
            desc: tr('Account ID gồm 32 ký tự, xem ở trang Overview của tên miền trên Cloudflare hoặc trên thanh địa chỉ {{v1}}.', { v1: mono('dash.cloudflare.com/&lt;Account ID&gt;') }),
          },
          {
            title: tr('Bấm Kết nối'),
            desc: tr('Deplao kiểm tra token, đọc danh sách tên miền và thử quyền của từng tính năng. Token được lưu mã hoá trên máy này.'),
          },
        ]} />
        <SubTitle>{tr('Token xin những quyền gì (nói dễ hiểu)')}</SubTitle>
        <BulletList items={[
          tr('{{v1}} tạo "đường hầm" nối máy bạn ra Internet cho địa chỉ cố định.', { v1: bold('Cloudflare Tunnel — Edit:') }),
          tr('{{v1}} tạo tên miền con (vd shop.tenmien.vn) trỏ vào đường hầm đó.', { v1: bold('DNS — Edit:') }),
          tr('{{v1}} đọc danh sách tên miền bạn đã thêm vào Cloudflare.', { v1: bold('Zone — Read:') }),
          tr('{{v1}} tạo kho (bucket) lưu ảnh, file và bản sao dữ liệu.', { v1: bold('Workers R2 Storage — Edit:') }),
          tr('{{v1}} đọc mức dùng R2 của cả tài khoản cho thẻ Mức sử dụng &amp; chi phí; thiếu quyền này thì chỉ đếm được thao tác của Deplao trên máy này.', { v1: bold('Account Analytics — Read:') }),
        ]} />
        <SubTitle>{tr('Lưu ý')}</SubTitle>
        <BulletList items={[
          tr('Deplao chỉ tạo tunnel, tên miền con và bucket có tên {{v1}}; dữ liệu khác trên Cloudflare không bị đụng tới.', { v1: mono('deplao-…') }),
          tr('Dùng kho R2 thì phải bật R2 trên tài khoản (Cloudflare → R2 Object Storage). Cloudflare yêu cầu thêm phương thức thanh toán dù chỉ dùng phần miễn phí.'),
          tr('Đã kết nối: nút {{v1}} có Kiểm tra lại token · Đổi token · Mở Cloudflare · Ngắt kết nối. Token thiếu quyền hoặc sắp hết hạn (còn ≤ 14 ngày) được báo ngay dưới tên tài khoản.', { v1: bold(tr('Quản lý')) }),
          tr('Ngắt kết nối: địa chỉ cố định và đồng bộ lên R2 trên máy này dừng; dữ liệu đã có trên Cloudflare vẫn giữ nguyên.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Địa chỉ Internet', { 0: <GlobeIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Máy tính của bạn không có địa chỉ công khai. Địa chỉ Internet giúp nhân viên ở xa và hệ thống bên ngoài gọi vào Deplao mà không cần VPS hay mở cổng router. Đây là nơi duy nhất bật, tắt và đổi địa chỉ — các màn Nhân viên, API, Webhook, Tích hợp, Workflow chỉ hiện địa chỉ và dẫn về đây.')}
        </Paragraph>
        <SubTitle>{tr('Ba dịch vụ, mỗi dịch vụ một công tắc riêng')}</SubTitle>
        <div className="grid gap-2 md:grid-cols-3">
          {SERVICES.map(s => <InfoTile key={s.title} {...s} />)}
        </div>
        <SubTitle>{tr('Cách tạo địa chỉ — chọn một')}</SubTitle>
        <div className="grid gap-2 md:grid-cols-2">
          {MODES.map(m => <InfoTile key={m.title} {...m} />)}
        </div>
        <Callout>
          {tr('Ở chế độ ngrok và Cloudflare thủ công, Thanh toán, tích hợp và Webhook workflow vẫn dùng Địa chỉ tạm (đổi mỗi lần bật lại). Muốn cả ba dịch vụ có địa chỉ cố định, chọn Cloudflare tự động.')}
        </Callout>
        <BulletList items={[
          tr('{{v1}} tunnel chạy lại ngay khi mở Deplao. Ở các chế độ khác Cloudflare tự động, chỉ Nhân viên và API tự bật lại, và chỉ khi máy chủ nhân viên (LAN) cũng tự chạy lúc mở app; Thanh toán và Webhook workflow bật lại ở bảng dịch vụ khi cần.', { v1: bold(tr('Tự bật khi mở app:')) }),
          tr('Địa chỉ chỉ hoạt động khi Deplao đang mở trên máy chủ.'),
          tr('Đổi tên miền / tên máy hoặc đổi cách tạo địa chỉ thì địa chỉ cũ ngừng hoạt động — nhớ cập nhật ở Casso, SePay, phần mềm bán hàng, website và gửi địa chỉ mới cho nhân viên ở xa.'),
          tr('{{v1}} (Cloudflare tự động): tách tên riêng cho từng dịch vụ (shop, shop-pay, shop-hook) · Chuyển sang máy này khi đổi máy chủ · Ngắt máy lạ đang chạy cùng tunnel · Gỡ tunnel và địa chỉ.', { v1: bold(tr('Nâng cao')) }),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Kho lưu: Cloudflare R2 hoặc Google Drive', { 0: <HardDriveIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Kho lưu là nơi đặt ảnh, file và bản sao dữ liệu — chọn ở Đồng bộ dữ liệu → thẻ <0>Kho lưu</0>. Mỗi lúc dùng một kho; Địa chỉ Internet vẫn chạy trên Cloudflare, không phụ thuộc kho.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <div className="grid gap-2 md:grid-cols-2">
          <ListTile title="Cloudflare R2" items={R2_LINES} />
          <ListTile title="Google Drive (Google One)" items={GDRIVE_LINES} />
        </div>
        <BulletList items={[
          tr('{{v1}} diễn ra trên trình duyệt của máy: bấm Đăng nhập Google ở thẻ Google Drive rồi đồng ý trên trang Google. Deplao chỉ thấy file do chính Deplao tạo (thư mục {{v2}} trong Drive của bạn), không đọc được file khác.', { v1: bold(tr('Đăng nhập Google')), v2: bold('Deplao') }),
          tr('{{v1}} — tạo miễn phí một client "Desktop app" trên Google Cloud theo 4 bước hướng dẫn ngay trong thẻ (bật Google Drive API, quyền drive.file, Publishing status chọn In production — để Testing thì sau 7 ngày phải đăng nhập lại), rồi dán Client ID / Client secret. Hạn mức Drive API mỗi ngày khi đó là của riêng bạn. Bản Deplao không có sẵn client Google chung thì phần này tự mở và là cách để đăng nhập.', { v1: bold(tr('Nâng cao: dùng client OAuth riêng')) }),
          tr('Dùng client riêng thì máy khác muốn khôi phục phải đăng nhập bằng {{v1}} đó (Deplao chỉ thấy file do chính client đó tạo).', { v1: bold(tr('cùng client')) }),
          tr('{{v1}} chỉ được khi đồng bộ đang tắt và máy không làm máy dự phòng. Sau khi đổi, ảnh, file tải lại từ đầu lên kho mới, dữ liệu tạo bản gốc mới; bản trên kho cũ vẫn giữ — chọn lại kho cũ để khôi phục từ đó. Còn file đã dọn khỏi máy (chỉ nằm trên kho cũ) thì tải về máy trước.', { v1: bold(tr('Đổi kho')) }),
          tr('Ngắt kết nối Google Drive: Deplao thu hồi quyền và xoá đăng nhập trên máy này; file đã lên Drive vẫn giữ.'),
        ]} />
        <Callout tone="warning">
          {tr('Dung lượng Google dùng chung với Gmail và Google Photos: đầy thì không tải lên được và Gmail có thể không nhận thư — nên dùng một tài khoản Google riêng cho sao lưu.')}
        </Callout>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Đồng bộ dữ liệu — bật trong 5 bước', { 0: <RefreshIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Một thiết lập chung cho dữ liệu (tin nhắn, danh bạ, cài đặt…) và ảnh, file của workspace đang mở. Dữ liệu được nén và mã hoá ngay trên máy rồi mới tải lên kho của bạn.')}
        </Paragraph>
        <StepList steps={[
          {
            title: tr('Chọn kho lưu'),
            desc: tr('Thẻ {{v1}}: Cloudflare R2 (đã kết nối Cloudflare đủ quyền) hoặc Google Drive (đã đăng nhập Google).', { v1: bold(tr('Kho lưu')) }),
          },
          {
            title: tr('Chọn tài khoản và thời gian'),
            desc: tr('{{v1}} Tất cả (kể cả tài khoản thêm sau) hoặc Chọn tài khoản. {{v2}} Toàn bộ hoặc Từ ngày — "Từ ngày" giới hạn lịch sử tin và ảnh, file theo thời gian; danh bạ, nhóm, cài đặt của tài khoản được chọn vẫn đồng bộ đủ.', { v1: bold(tr('Tài khoản:')), v2: bold(tr('Thời gian:')) }),
          },
          {
            title: tr('Chọn chế độ'),
            desc: tr('{{v1}} đẩy thay đổi mỗi giờ. {{v2}} trễ tối đa 5 giây. Không có thay đổi thì không gọi kho. {{v3}} ngừng đồng bộ, bản đã có vẫn giữ và khôi phục được.', { v1: bold(tr('Theo giờ:')), v2: bold('Realtime:'), v3: bold(tr('Tắt:')) }),
          },
          {
            title: tr('Kèm ảnh, video, file'),
            desc: tr('Mặc định bật: ảnh, file tải dần lên kho trong nền, có thể kèm {{v1}} (thư viện media, công việc, file tải lên). Bỏ chọn thì chỉ đồng bộ tin nhắn, danh bạ, cài đặt.', { v1: bold('File chung') }),
          },
          {
            title: tr('Bấm Bật đồng bộ'),
            desc: tr('Lần đầu Deplao hỏi {{v1}} (ít nhất 8 ký tự, nhập hai lần, tick ô xác nhận) rồi chụp bản gốc ngay: sao chép DB → lọc theo phạm vi → nén → mã hoá → tải lên. Sau đó chỉ đẩy phần thay đổi. Bản gốc mới (khoảng mỗi ngày) chỉ tự chụp khi máy rảnh, đang cắm sạc và không ngay lúc máy vừa thức dậy; bấm {{v2}} để chụp luôn.', { v1: bold(tr('mật khẩu sao lưu')), v2: bold(tr('Đồng bộ ngay')) }),
          },
        ]} />
        <Callout tone="destructive">
          <p>
            {trx('<0>Giữ kỹ mật khẩu sao lưu.</0> Bản trên kho được mã hoá bằng mật khẩu này; máy mới và máy dự phòng phải nhập đúng mật khẩu khi khôi phục. Quên mật khẩu là mất bản trên kho — ghi lại ở nơi an toàn.', { 0: <strong className="text-foreground" /> })}
          </p>
        </Callout>
        <BulletList items={[
          tr('Đang đồng bộ thì thiết lập thu gọn thành một dòng tóm tắt; bấm {{v1}} để sửa. Đổi tài khoản / thời gian khi đã có bản trên kho thì Deplao tạo bản gốc mới thay bản cũ (file ảnh đã lên vẫn giữ).', { v1: bold(tr('Thay đổi')) }),
          tr('{{v1}} Dữ liệu (lần đồng bộ gần nhất, bản trên kho, phạm vi; nút {{v2}}, {{v3}}) và Ảnh &amp; file (đã lên bao nhiêu file; {{v4}} / {{v5}}).', { v1: bold(tr('Trạng thái:')), v2: bold(tr('Đồng bộ ngay')), v3: bold(tr('Khôi phục…')), v4: bold(tr('Tạm dừng')), v5: bold(tr('Tiếp tục')) }),
          tr('Đổi mật khẩu ở dòng Mật khẩu sao lưu → Đổi mật khẩu; máy dự phòng phải nhập lại mật khẩu mới.'),
          tr('Mỗi workspace của máy chủ có thư mục riêng trên kho; máy nhân viên không tải lên. Cài đặt → Lưu trữ có dòng "Media trên đám mây" để xem nhanh.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Ảnh, file và phần Nâng cao', { 0: <ImageIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Phần <0>Nâng cao</0> ở cuối trang Đồng bộ dữ liệu (mở sẵn, bấm tiêu đề để thu gọn) gom các tuỳ chọn ít dùng.', { 0: <strong className="text-foreground" /> })}
        </Paragraph>
        <BulletList items={[
          tr('{{v1}} — kho chỉ giữ thêm một bản sao.', { v1: bold(tr('Mặc định giữ nguyên file trên máy')) }),
          tr('{{v1}} "Xoá bản trên máy của file cũ để giải phóng ổ" chỉ xoá bản trên máy của file đã có trên kho, không mở trong 30 ngày gần đây và khi ổ còn trống dưới 20 GB (hai số này đổi được). Mở lại file thì Deplao tự tải về từ kho.', { v1: bold(tr('Giải phóng ổ (tuỳ chọn):')) }),
          tr('{{v1}} về máy khi cần (cần đủ chỗ trống trên ổ).', { v1: bold(tr('Tải lại toàn bộ file đã dọn')) }),
          tr('{{v1}} số file tải song song, giới hạn băng thông (0 = không giới hạn), "Chỉ chạy từ 22:00 đến 07:00".', { v1: bold(tr('Tải ảnh &amp; file:')) }),
          tr('Ngoài ra: {{v1}}, {{v2}} trên kho (xem, xoá hẳn bản của máy cũ không dùng nữa) và {{v3}}.', { v1: bold(tr('Máy dự phòng')), v2: bold(tr('Bản sao DB')), v3: bold(tr('Nhật ký đồng bộ')) }),
        ]} />
        <SubTitle>{tr('Dọn file trên kho — quét trước, xác nhận mới xoá')}</SubTitle>
        <BulletList items={[
          tr('Xoá tin trong app không xoá file trên kho. Muốn bớt dung lượng thì bấm {{v1}} / {{v2}} (cần đang đồng bộ kèm ảnh, video, file).', { v1: bold(tr('Dọn file trên R2')), v2: bold(tr('Dọn file trên Google Drive')) }),
          tr('Chọn loại file: của tin đã xoá trong app (mặc định), của tài khoản…, cũ hơn ngày…, ngoài phạm vi lưu hiện tại.'),
          tr('Bấm {{v1}}: chỉ đếm số file, dung lượng, ví dụ đường dẫn — chưa xoá gì. Kết quả quét dùng được trong 15 phút.', { v1: bold(tr('Quét')) }),
          tr('Bấm {{v1}} và xác nhận thì mới xoá — không hoàn tác được.', { v1: bold(tr('Xoá … file')) }),
          tr('An toàn mặc định: giữ lại file chỉ còn trên kho (đã dọn khỏi máy) và không xoá bản trên máy; muốn xoá các file này phải tự tick.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Khôi phục sang máy mới & máy dự phòng', { 0: <DownloadIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Đổi máy, cài lại Windows hay máy chủ hỏng: lấy lại dữ liệu từ bản sao trên kho. Trên máy mới cài Deplao, bấm <0>Khôi phục dữ liệu từ đám mây</0> (dòng "Chuyển từ máy khác?" ở Dashboard khi chưa có tài khoản, hoặc trong hộp Thêm tài khoản) — dùng được cho cả Cloudflare R2 và Google Drive. Khôi phục ngay trên máy đang dùng: bấm <1>Khôi phục…</1> ở phần Trạng thái.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
        </Paragraph>
        <StepList steps={[
          {
            title: tr('Kết nối kho'),
            desc: tr('Chọn bản sao nằm ở Cloudflare R2 hay Google Drive. R2: dán token Cloudflare cho máy này (token lưu ở máy cũ không mang sang được). Google Drive: đăng nhập đúng tài khoản Google đã dùng để sao lưu.'),
          },
          {
            title: tr('Chọn workspace'),
            desc: tr('Mỗi workspace có một bản, kèm tên máy, lần đồng bộ, dung lượng, phạm vi. Bản do Deplao mới hơn tạo bị khoá — cập nhật app trước.'),
          },
          {
            title: tr('Nhập mật khẩu sao lưu'),
            desc: tr('Mật khẩu đặt khi bật đồng bộ trên máy chủ; Deplao giải mã trên máy này, không gửi mật khẩu đi đâu. Có thể chọn khôi phục tới một thời điểm cũ hơn.'),
          },
          {
            title: tr('Khôi phục dữ liệu'),
            desc: tr('Dữ liệu của workspace trên máy được thay bằng bản trên kho. Không đóng app trong lúc khôi phục.'),
          },
          {
            title: tr('Đăng nhập lại kênh'),
            desc: tr('Lịch sử đã về; đăng nhập lại từng tài khoản (Zalo quét QR, Facebook, Telegram bằng số điện thoại, bot dán lại token). Ảnh, file tự tải từ kho khi mở, hoặc bấm Tải hết media về máy.'),
          },
          {
            title: tr('Bật lại tự động hoá'),
            desc: tr('Chiến dịch, workflow và lịch của ứng dụng tạm dừng sau khôi phục để không gửi trùng với máy cũ. Tick "Máy cũ đã tắt hoặc đã ngắt Deplao" rồi bấm Bật lại tự động hoá; đang dùng Cloudflare tự động thì có thể chuyển luôn địa chỉ Internet sang máy này.'),
          },
        ]} />
        <SubTitle>{tr('Máy dự phòng')}</SubTitle>
        <BulletList items={[
          tr('Máy thứ hai cài Deplao, kết nối cùng Cloudflare (hoặc chọn kho Google Drive và đăng nhập cùng tài khoản Google) → Đồng bộ dữ liệu → Nâng cao → Máy dự phòng → {{v1}} → chọn bản sao, nhập mật khẩu sao lưu của máy chủ.', { v1: bold(tr('Dùng máy này theo dõi bản của máy khác…')) }),
          tr('Máy dự phòng tải đoạn mới mỗi phút; máy chủ thấy máy nào đang theo dõi và trễ bao lâu.'),
          tr('Máy chủ hỏng: trên máy dự phòng bấm {{v1}} → đăng nhập lại kênh → bật lại tự động hoá. Chỉ làm khi máy chủ cũ đã hỏng hoặc đã tắt, tránh hai máy cùng gửi tin.', { v1: bold(tr('Chuyển sang máy này')) }),
        ]} />
        <Callout tone="warning">
          {tr('Dữ liệu khôi phục không tự kết nối kênh chat. Dải "Đã khôi phục dữ liệu…" ở đầu trang Internet & Cloud nhắc tự động hoá đang tạm dừng cho tới khi bạn bật lại.')}
        </Callout>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Mức sử dụng & chi phí', { 0: <DollarIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Thẻ Mức sử dụng & chi phí (dưới phần Trạng thái) cho biết kho đang dùng bao nhiêu so với phần miễn phí hoặc ngưỡng tính phí, để không bất ngờ khi nhận hoá đơn.')}
        </Paragraph>
        <BulletList items={[
          tr('Mỗi mục có thanh % so với phần miễn phí / ngưỡng: chuyển vàng từ 70%, đỏ khi vượt 100%; kèm số dự kiến cuối kỳ theo nhịp dùng hiện tại.'),
          tr('Nút {{v1}} đọc lại số liệu ngay (tối đa một lần mỗi phút). Nhãn {{v2}} nghĩa là số chỉ tính Deplao trên máy này, chưa gồm máy khác hay ứng dụng khác.', { v1: bold(tr('Cập nhật')), v2: bold(tr('máy này')) }),
        ]} />
        <div className="grid gap-2 md:grid-cols-2">
          <ListTile title={tr('Cloudflare R2 — tính theo tháng')} items={R2_USAGE} />
          <ListTile title={tr('Google Drive — tính theo ngày')} items={GDRIVE_USAGE} />
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Bảo mật & lưu ý', { 0: <ShieldIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Token Cloudflare, token ngrok / tunnel và mật khẩu sao lưu được lưu mã hoá trên máy chủ; giao diện không hiện lại.'),
          tr('Dữ liệu (tin nhắn, danh bạ…) được mã hoá trên máy trước khi tải lên; ảnh, file nằm trong kho riêng tư của bạn.'),
          tr('Xoá trên kho (Dọn file, xoá bản sao DB của máy cũ) là xoá hẳn, không hoàn tác.'),
          tr('Ngắt kết nối Cloudflare / Google không xoá dữ liệu đã có trên kho.'),
          tr('Chỉ bật dịch vụ địa chỉ Internet đang cần; gọi API từ ngoài vẫn phải có API key.'),
          tr('Sau khôi phục hoặc khi chuyển sang máy dự phòng: chỉ bật lại tự động hoá khi chắc máy cũ đã tắt.'),
        ]} />
      </Card>
    </div>
  );
}
