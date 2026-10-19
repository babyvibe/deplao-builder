import React from 'react';
import { AlertIcon, GlobeIcon, InboxIcon, KeyIcon, RefreshIcon, SparklesIcon, UserPlusIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

/** Hộp nổi bật một dòng (màu theo token, không dùng màu cứng). */
function Highlight({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 bg-primary/10 border border-primary/30 rounded-lg px-3 py-2">
      <SparklesIcon className="text-primary w-4 h-4 flex-shrink-0 mt-0.5" />
      <p className="text-foreground text-xs font-medium leading-relaxed">{children}</p>
    </div>
  );
}

/** Khối hướng dẫn đăng nhập của một kênh. */
function ChannelLogin({ title, note, items }: { title: string; note: string; items: string[] }) {
  return (
    <div className="bg-muted rounded-lg p-3 space-y-2">
      <p className="text-foreground text-xs font-semibold">
        {title} <span className="text-muted-foreground font-normal">· {note}</span>
      </p>
      <BulletList items={items} />
    </div>
  );
}

export function MultiAccountPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><UserPlusIcon className="w-4 h-4 inline" /> Thêm tài khoản Zalo, Facebook, Telegram</SectionTitle>
        <Paragraph>
          Deplao cho phép đăng nhập <strong className="text-foreground font-semibold">không giới hạn tài khoản</strong> Zalo (cá nhân / Business),
          Facebook (Messenger), Telegram (tài khoản cá nhân) và Telegram Bot trong một giao diện. Mỗi tài khoản có phiên đăng nhập riêng
          (Zalo, Facebook gắn được proxy riêng) và hoạt động độc lập với nhau.
        </Paragraph>
        <StepList steps={[
          { title: 'Mở hộp "Thêm tài khoản"', desc: 'Bấm <strong class="text-foreground">Thêm tài khoản</strong> trên Dashboard, hoặc nút <strong class="text-foreground">+</strong> (viền nét đứt) dưới danh sách avatar ở thanh bên trái.' },
          { title: 'Chọn kênh', desc: '<strong class="text-foreground">Zalo cá nhân</strong> (QR Code hoặc Cookie) · <strong class="text-foreground">Facebook cá nhân</strong> (tài khoản hoặc Cookie) · <strong class="text-foreground">Telegram</strong> (số điện thoại) · <strong class="text-foreground">Telegram Bot</strong> (Bot Token).' },
          { title: 'Chọn proxy (Zalo, Facebook)', desc: 'Ở bước <em>Chọn Proxy (tuỳ chọn)</em>: chọn proxy đã lưu rồi bấm <em>Test ngay</em>, hoặc chọn <em>Không dùng proxy</em> để kết nối trực tiếp. Telegram không có bước này.' },
          { title: 'Đăng nhập', desc: 'Làm theo hướng dẫn từng kênh ở mục bên dưới. Xong, tài khoản hiện trên Dashboard và thanh bên trái, tin nhắn mới bắt đầu về.' },
          { title: 'Dùng tiếp những lần sau', desc: 'Phiên đăng nhập được lưu trên máy: mở app là tự kết nối lại, không phải đăng nhập lại (trừ khi phiên hết hạn). Khi mất mạng, app tự thử kết nối lại.' },
          { title: 'Chuyển tài khoản', desc: 'Bấm avatar ở thanh bên trái, hoặc giữ <strong class="text-foreground">Ctrl</strong> và nhấn <strong class="text-foreground">Tab</strong> để chọn rồi thả Ctrl (Shift+Tab: đi ngược, Esc: huỷ). Ở màn Chat, nút ☰ trên cùng thanh bên mở danh sách tài khoản đầy đủ kèm ô tìm kiếm.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle><KeyIcon className="w-4 h-4 inline" /> Cách đăng nhập từng kênh</SectionTitle>
        <div className="space-y-2">
          <ChannelLogin title="Zalo" note="tài khoản cá nhân, kể cả Zalo Business" items={[
            '<strong class="text-foreground">Quét mã QR</strong> (khuyên dùng): mở Zalo trên điện thoại → quét mã → xác nhận đăng nhập trên điện thoại. Mã hết hạn sau 1 phút, bấm <em>Làm mới QR</em> để lấy mã mới.',
            '<strong class="text-foreground">Cookies / IMEI</strong> (nâng cao): dán khối Auth JSON (gồm imei, cookies, userAgent) lấy từ công cụ trích xuất cookie trên trình duyệt.',
            'Không cần và không lưu mật khẩu Zalo.',
          ]} />
          <ChannelLogin title="Facebook" note="Messenger cá nhân" items={[
            '<strong class="text-foreground">Đăng nhập tài khoản</strong> (khuyên dùng): nhập email / tên người dùng và mật khẩu Facebook, rồi làm bước xác minh nếu Facebook yêu cầu - mã 6 số từ ứng dụng xác thực, mã SMS / WhatsApp / email, mã dự phòng, captcha, thử thách trong <em>cửa sổ xác minh</em>, hoặc đồng ý trên thiết bị khác (app tự đi tiếp khi bạn đồng ý). Muốn đổi cách xác minh: <em>Thử cách xác minh khác</em>.',
            'App chưa hỗ trợ xác minh bằng tài khoản Google: hãy thêm ứng dụng xác thực hoặc SMS làm xác thực hai lớp cho Facebook, hoặc dùng tab <em>Cookie</em>.',
            '<strong class="text-foreground">Cookie</strong>: dán chuỗi cookie Facebook lấy từ trình duyệt (bấm <em>Xem hướng dẫn lấy Cookie Facebook</em>). Cookie hết hạn khi bạn đăng xuất Facebook trên trình duyệt, lâu không hoạt động hoặc khi Facebook nghi ngờ bất thường.',
            'Mật khẩu chỉ dùng lúc đăng nhập, app không lưu lại. Với cách đăng nhập tài khoản, app tự quản lý phiên - không phải tự thay cookie.',
          ]} />
          <ChannelLogin title="Telegram" note="tài khoản cá nhân" items={[
            'Chọn mã quốc gia (mặc định +84), nhập số điện thoại → <em>Gửi mã OTP</em>.',
            'Nhập mã 5 chữ số được gửi vào ứng dụng Telegram của bạn → <em>Xác nhận</em>.',
            'Tài khoản có bật xác thực 2 lớp: nhập thêm mật khẩu cloud (cloud password) của Telegram.',
          ]} />
          <ChannelLogin title="Telegram Bot" note="kết nối bằng Bot Token" items={[
            'Trong Telegram, mở <strong class="text-foreground">@BotFather</strong> → gửi lệnh <strong class="text-foreground">/newbot</strong> → làm theo hướng dẫn và copy Bot Token.',
            'Dán token → <em>Kiểm tra Token</em> → <em>Kết nối Bot</em>.',
            'Bot chỉ thấy tin nhắn từ lúc khách bấm "Start", không có lịch sử cũ. Dùng bot trong nhóm: tắt Privacy Mode ở BotFather để bot thấy hết tin nhắn.',
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle><GlobeIcon className="w-4 h-4 inline" /> Proxy riêng cho từng tài khoản</SectionTitle>
        <Highlight>Mỗi tài khoản Zalo / Facebook gắn được một proxy riêng - tách IP giữa các tài khoản.</Highlight>
        <Paragraph>
          Dùng khi cần tách IP cho từng tài khoản, dùng proxy của công ty, hoặc đăng nhập tài khoản từ vùng địa lý khác.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Tạo proxy:</strong> Cài đặt → Proxy → <em>Thêm proxy</em> → nhập Tên proxy, Giao thức (HTTP · HTTPS · SOCKS4 · SOCKS5), Host / IP, Port, Username / Password nếu có → <em>Lưu proxy</em>. Bấm <em>Test kết nối</em> để kiểm tra.',
          '<strong class="text-foreground">Gán khi đăng nhập:</strong> ở bước <em>Chọn Proxy (tuỳ chọn)</em>, chọn proxy → <em>Test ngay</em> → <em>Tiếp tục với proxy</em>. Proxy lỗi thì đăng nhập sẽ thất bại - sửa proxy hoặc tiếp tục không dùng proxy.',
          '<strong class="text-foreground">Đổi proxy:</strong> đăng nhập lại tài khoản đó và chọn proxy khác ở bước Chọn Proxy.',
          '<strong class="text-foreground">Theo dõi:</strong> Cài đặt → Proxy hiện số tài khoản đang dùng mỗi proxy và mục <em>Tài khoản đang dùng proxy</em>. Xoá một proxy sẽ gỡ proxy đó khỏi mọi tài khoản đang dùng.',
          'Telegram hiện chưa có bước chọn proxy.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><InboxIcon className="w-4 h-4 inline" /> Chế độ Gộp tài khoản (Gộp trang)</SectionTitle>
        <Highlight>Xem và trả lời tin nhắn của nhiều tài khoản Zalo, Facebook, Telegram trong một danh sách hội thoại - không phải chuyển qua lại.</Highlight>
        <BulletList items={[
          '<strong class="text-foreground">Bật:</strong> Dashboard → <em>Gộp tài khoản</em> (hiện khi có từ 2 tài khoản) → chọn tài khoản (mặc định chọn tất cả, tối thiểu 2) → <em>Vào chế độ gộp</em>. App mở màn Chat với danh sách hội thoại chung, mới nhất ở trên.',
          '<strong class="text-foreground">Lọc theo tài khoản:</strong> thanh bên trái hiện biểu tượng "tất cả tài khoản" và avatar từng tài khoản đã gộp (kèm số hội thoại chưa đọc) - bấm một avatar để chỉ xem hội thoại của tài khoản đó, bấm lại để bỏ lọc.',
          '<strong class="text-foreground">Trả lời đúng tài khoản:</strong> mỗi hội thoại có avatar nhỏ của tài khoản sở hữu và biểu tượng kênh; bấm vào hội thoại là app tự chuyển sang đúng tài khoản đó.',
          '<strong class="text-foreground">Bộ lọc dùng chung:</strong> Tất cả · Chưa đọc · Nhãn và menu ⋮ (Khác, Tin đánh dấu, lọc theo Kênh) áp dụng cho mọi tài khoản đã gộp; nhãn trùng tên giữa các tài khoản được gộp thành một.',
          '<strong class="text-foreground">Tìm kiếm:</strong> tìm theo tên / biệt danh trên toàn bộ hội thoại đã gộp; khi nhập số điện thoại, app hỏi chọn tài khoản để tra cứu.',
          '<strong class="text-foreground">Thoát:</strong> bấm <em>Đang Gộp tài khoản</em> trên Dashboard, hoặc nút × cạnh biểu tượng "tất cả tài khoản" ở thanh bên trái.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><RefreshIcon className="w-4 h-4 inline" /> Mất kết nối, hết phiên: đăng nhập lại</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Dấu hiệu:</strong> thẻ tài khoản trên Dashboard viền đỏ kèm biểu tượng cảnh báo; avatar ở thanh bên trái chuyển xám (chưa kết nối) hoặc có dấu <strong class="text-foreground">!</strong> đỏ. Facebook hết phiên còn hiện thông báo "đã hết phiên đăng nhập".',
          '<strong class="text-foreground">Thử trước:</strong> bấm <em>Reconnect</em> trên thẻ để kết nối lại bằng phiên đang lưu.',
          '<strong class="text-foreground">Zalo:</strong> nếu vẫn lỗi, bấm <em>Quét QR mới</em> (mở hộp Thêm tài khoản) → chọn Zalo và quét bằng đúng tài khoản Zalo đó.',
          '<strong class="text-foreground">Facebook, Telegram:</strong> bấm <em>Đăng nhập lại</em> → mở thẳng bước đăng nhập của kênh đó; Facebook chọn sẵn proxy đang dùng. Facebook không còn nút "Cập nhật cookie" - hết phiên thì đăng nhập lại (bằng tài khoản hoặc cookie mới).',
          'Đăng nhập lại bằng <strong class="text-foreground">đúng tài khoản cũ</strong> thì hội thoại, tin nhắn và dữ liệu CRM được giữ nguyên - không cần xoá tài khoản rồi thêm lại.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><AlertIcon className="w-4 h-4 inline" /> Lưu ý quan trọng</SectionTitle>
        <BulletList items={[
          'Zalo: dùng tài khoản cá nhân (kể cả Zalo Business) đang hoạt động bình thường; tài khoản bị Zalo khoá hoặc hạn chế tính năng có thể không đăng nhập hoặc không gửi tin được.',
          'Deplao đăng nhập Zalo theo kiểu Zalo Web: Zalo trên điện thoại và Zalo PC vẫn dùng song song bình thường, nhưng sau khi đăng nhập vào Deplao thì không đăng nhập thêm Zalo Web (chat.zalo.me) cho cùng tài khoản được.',
          'App không lưu mật khẩu Zalo, Facebook, Telegram - chỉ giữ phiên đăng nhập trên máy này.',
          'Gửi hàng loạt (chiến dịch, workflow) càng nhiều thao tác, nội dung càng dài và delay càng ngắn thì càng dễ bị đánh dấu spam - hãy giãn cách và tuân thủ quy định của từng nền tảng.',
          'Facebook: đồng bộ lịch sử tin nhắn và quét dữ liệu gửi nhiều yêu cầu, vẫn có rủi ro bị checkpoint (Facebook yêu cầu xác minh hoặc tạm khoá) - chỉ tải khoảng thời gian cần thiết, nên dùng tài khoản phụ để quét dữ liệu.',
          'Gộp tài khoản: tài khoản chưa kết nối vẫn nằm trong danh sách gộp (avatar xám) nhưng không nhận tin mới cho tới khi kết nối lại.',
          'Chuyển sang máy mới: nếu máy cũ đã bật Đồng bộ dữ liệu (Cài đặt → Internet &amp; Đám mây), ở máy mới bấm <em>Khôi phục dữ liệu từ Cloudflare</em> trong hộp Thêm tài khoản để lấy lại dữ liệu từ bản sao trên Cloudflare R2 hoặc Google Drive, rồi đăng nhập lại các kênh được yêu cầu.',
        ]} />
      </Card>
    </div>
  );
}
