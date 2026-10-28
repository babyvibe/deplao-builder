import React from 'react';
import {
  AlertIcon, CalendarIcon, ChartIcon, ChatIcon, ClipboardIcon, ClockIcon, CreditCardIcon, EditIcon, FileTextIcon,
  FolderIcon, ImageIcon, InfoIcon, LightningIcon, PaperclipIcon, PinIcon, ReplyIcon, SearchIcon, SendIcon,
  SettingsIcon, ShareIcon, ShieldIcon, SmileIcon, TagIcon, UserIcon, WaveIcon,
} from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle } from './introUi';

/** Chữ đậm trong chuỗi HTML của BulletList. */
const b = (text: string) => `<strong class="text-foreground">${text}</strong>`;
/** Phím tắt trong chuỗi HTML của BulletList. */
const kbd = (keys: string) =>
  `<kbd class="px-1 rounded border border-border bg-muted text-foreground font-mono text-[10px]">${keys}</kbd>`;

/** Khung lưu ý màu theo trạng thái (token ngữ nghĩa, đúng cả theme Sáng / Tối). */
function Callout({ tone, icon, title, children }: {
  tone: 'info' | 'warning';
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  const toneClass = tone === 'warning'
    ? 'bg-warning/10 border-warning/30 text-warning'
    : 'bg-primary/10 border-primary/30 text-primary';
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${toneClass}`}>
      <span className="flex-shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        {children && <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

const COMPOSER_FEATURES: { icon: React.ReactNode; feat: string; desc: string }[] = [
  { icon: <EditIcon className="w-4 h-4 inline" />, feat: 'Định dạng chữ', desc: 'Đậm, nghiêng, gạch chân, gạch ngang, cỡ chữ, màu chữ (Zalo)' },
  { icon: <ImageIcon className="w-4 h-4 inline" />, feat: 'Ảnh và album', desc: 'Chọn từ thư viện / máy tính, dán Ctrl+V hoặc kéo-thả; gửi nhiều ảnh một lần' },
  { icon: <PaperclipIcon className="w-4 h-4 inline" />, feat: 'Video và file', desc: 'Chọn từ Thư viện Media hoặc máy tính' },
  { icon: <WaveIcon className="w-4 h-4 inline" />, feat: 'Tin thoại', desc: 'Bấm Ghi âm giọng nói, bấm lần nữa để dừng và gửi' },
  { icon: <SmileIcon className="w-4 h-4 inline" />, feat: 'Emoji và sticker', desc: 'Sticker Zalo (gợi ý sticker khi gõ chữ); Telegram có bảng Emoji · Sticker · GIF' },
  { icon: <ReplyIcon className="w-4 h-4 inline" />, feat: 'Trả lời', desc: 'Trích dẫn một tin cụ thể; Esc để bỏ trích dẫn' },
  { icon: <span className="font-semibold">@</span>, feat: 'Nhắc tên', desc: 'Gõ @ trong nhóm để chọn thành viên, có cả @all' },
  { icon: <ChartIcon className="w-4 h-4 inline" />, feat: 'Bình chọn', desc: 'Tạo poll trong nhóm; Zalo có thêm thời hạn, chọn nhiều, ẩn danh' },
  { icon: <FileTextIcon className="w-4 h-4 inline" />, feat: 'Ghi chú', desc: 'Ghi chú nhóm Zalo (ghim đầu hội thoại) và ghi chú local nội bộ' },
  { icon: <ClockIcon className="w-4 h-4 inline" />, feat: 'Nhắc hẹn (Zalo)', desc: 'Tiêu đề, biểu tượng, màu, giờ hẹn, lặp hằng ngày / tuần / tháng' },
  { icon: <ClipboardIcon className="w-4 h-4 inline" />, feat: 'Danh thiếp (Zalo)', desc: 'Gửi danh thiếp; gõ SĐT trong ô soạn tin, app gợi ý gửi kèm danh thiếp' },
  { icon: <CreditCardIcon className="w-4 h-4 inline" />, feat: 'Thẻ ngân hàng (Zalo)', desc: 'Chọn ngân hàng, số tài khoản, tên chủ tài khoản; lưu sẵn thẻ hay dùng' },
];

export function MessagingPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><ChatIcon className="w-4 h-4 inline" /> Hộp thư tập trung - Danh sách hội thoại</SectionTitle>
        <Paragraph>
          Mục Chat gom hội thoại của mọi tài khoản Zalo, Facebook (Messenger), Telegram cá nhân và Telegram Bot.
          Muốn xử lý nhiều tài khoản trong cùng một danh sách, bật chế độ Gộp trang (xem mục Đa tài khoản).
        </Paragraph>
        <BulletList items={[
          `${b('Bộ lọc:')} Tất cả · Chưa đọc · Nhãn (Nhãn Local hoặc Nhãn Zalo; chọn nhiều nhãn theo kiểu "Tất cả nhãn đã chọn" hoặc "Có chứa 1 trong số nhãn"). Bấm ${b('Tất cả')} là bỏ mọi bộ lọc đang bật (kể cả các bộ lọc của menu ⋮) và về danh sách đầy đủ.`,
          `${b('Menu ⋮ cạnh bộ lọc:')} thư mục ${b('Khác (lưu trữ)')} (hội thoại ít quan trọng — không phát âm thanh, không hiện thông báo, không tính vào số chưa đọc; hội thoại Telegram đã lưu trữ cũng nằm ở đây), lọc ${b('Chưa trả lời')} và ${b('Theo khoảng ngày')} (chọn Từ – Đến ngày của tin cuối; dùng kèm các bộ lọc khác), ${b('Tin đánh dấu')}, ${b('Tự động đánh dấu đã đọc')}, ${b('Đánh dấu đã trả lời hàng loạt')} và lọc theo ${b('Kênh')} (Zalo · Facebook · Telegram · Telegram Bot). Bộ lọc đang bật hiện thành nhãn dưới thanh bộ lọc — bấm ✕ để bỏ từng cái; bấm lại Khác (lưu trữ) / Chưa trả lời trong menu cũng là bỏ.`,
          `${b('Đã trả lời / Chưa trả lời:')} theo tin nhắn cuối của hội thoại — của bạn (gửi từ app hay máy khác) là đã trả lời (biểu tượng mũi tên trả lời), của khách là chưa trả lời; thông báo hệ thống, bản tin OA không tính. Bộ lọc Chưa trả lời chỉ gồm hội thoại 1:1, đã đọc hay chưa đều tính.`,
          `${b('Đã đọc trên Zalo / Facebook / Telegram:')} mở hội thoại (bấm trong danh sách, bấm thông báo, phím Tab, Chat nhanh) là báo đã đọc lên nền tảng; đang chat thì tin mới cũng được báo — khi hội thoại đang hiện, cửa sổ đang mở và bạn có thao tác chuột / phím trong 1 phút (bỏ máy đi thì báo khi bạn quay lại). Đang ở trang khác (Tổng quan, CRM, Cài đặt…) thì tin mới vẫn là chưa đọc. Telegram Bot không có trạng thái đã đọc.`,
          `${b('Thông báo tin nhắn trong app:')} tin mới hiện thành thẻ ở góc trên bên phải (ảnh và tên tài khoản, tên hội thoại, tin tối đa 2 dòng) trong 2 giây, tối đa 3 thẻ; bấm thẻ để mở hội thoại, ✕ để tắt nhanh, rê chuột để giữ lại. Không hiện với hội thoại đã tắt thông báo, ở thư mục Khác, đang mở, hoặc tin tải lại / đồng bộ lại. Bật / tắt từng tài khoản hoặc tất cả (cả tài khoản thêm sau): chuông trên thanh tiêu đề → ⚙, Cài đặt → Thông báo, hoặc dưới mỗi tài khoản ở Cài đặt → Tài khoản.`,
          `${b('Đánh dấu đã trả lời hàng loạt')} (menu ⋮ → Tự động): chọn thời gian tin nhắn cuối, xem trước số hội thoại chưa trả lời rồi đánh dấu đã trả lời mà không cần gửi tin (chỉ trong app). Khách nhắn tiếp thì hội thoại tự chuyển lại Chưa trả lời.`,
          `${b('Tự động đánh dấu đã đọc')} (menu ⋮ → Tự động): đánh dấu đã đọc hàng loạt các hội thoại chưa đọc theo thời gian tin nhắn cuối (Tất cả · Hôm nay · 7 ngày qua · 30 ngày qua · Cũ hơn 7 ngày · Tuỳ chọn), có thể gồm cả Khác (lưu trữ) và đồng bộ "đã đọc" lên Zalo, Facebook, Telegram. Xem trước số hội thoại rồi bấm Bắt đầu; đóng popup vẫn chạy nền.`,
          `${b('Chuột phải vào hội thoại:')} Đánh dấu đã đọc / chưa đọc · Đánh dấu đã trả lời / chưa trả lời (hội thoại 1:1) · Tắt thông báo (Trong 1 giờ · Trong 4 giờ · Cho đến 8:00 AM · Cho đến khi được mở lại) · Ghim (đồng bộ Zalo / Telegram) hoặc Ghim trong app · Ẩn hội thoại bằng mã PIN (Zalo) · Chuyển vào Khác (lưu trữ) / Đưa về danh sách chính · Mời vào nhóm · Xóa hội thoại (chỉ xoá trên app này).`,
          `${b('Nút "+" (Thao tác nhanh)')} cạnh ô tìm kiếm: chọn tài khoản rồi tạo nhóm Zalo / Telegram / Messenger, tham gia nhóm bằng link (xem trước nhóm trước khi vào), thêm bạn Zalo theo số điện thoại hoặc thêm liên hệ Telegram. Mục "Công việc của tôi" có Thêm lịch hẹn và Ghi chú nhanh (khi được dùng Quản lý công việc).`,
          'Hội thoại ghim luôn nằm đầu danh sách; My Documents của Zalo luôn ở trên cùng như trên Zalo.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><SearchIcon className="w-4 h-4 inline" /> Tìm kiếm hội thoại và tin nhắn</SectionTitle>
        <BulletList items={[
          `${b('Ô "Tìm kiếm..."')} (${kbd('Ctrl+K')}): tìm liên hệ theo tên, biệt danh, số điện thoại — gõ không dấu vẫn ra (gõ "nguyen" tìm được "Nguyễn", "duc" tìm được "Đức"). Tin nhắn cũng tìm không dấu và tìm được khi đang gõ dở ("don ha" ra "Đơn hàng"); từ 2 ký tự trở lên mới tìm trong tin nhắn. Kết quả chia tab Tất cả · Liên hệ · Tin nhắn; bấm một tin để mở đúng chỗ đó trong hội thoại.`,
          `${b('Tra số điện thoại Zalo:')} nhập SĐT để tìm người dùng Zalo, kết bạn hoặc nhắn tin ngay. Khi Gộp trang, app hỏi dùng tài khoản nào để tra.`,
          `${b('Tìm người dùng Telegram:')} nhập @tên_người_dùng.`,
          `${b('Tìm trong hội thoại:')} biểu tượng kính lúp ở đầu khung chat (${kbd('Ctrl+F')}); ${kbd('Enter')} / ${kbd('Shift+Enter')} để tới kết quả tiếp theo / trước đó.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><EditIcon className="w-4 h-4 inline" /> Soạn và gửi tin nhắn</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {COMPOSER_FEATURES.map((f) => (
            <div key={f.feat} className="bg-muted rounded-lg px-2.5 py-2">
              <p className="text-foreground text-[11px] font-medium">{f.icon} {f.feat}</p>
              <p className="text-muted-foreground text-[11px] mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
        <BulletList items={[
          `${b('Nút ⋯ (Thêm tính năng)')} trên thanh công cụ: Tạo bình chọn, Ghi chú, Tạo nhắc hẹn, Tích hợp nhanh (tra cứu đơn, sản phẩm, vận chuyển…).`,
          `${b('Phím tắt:')} ${kbd('Enter')} gửi, ${kbd('Shift+Enter')} xuống dòng, ${kbd('Ctrl+B')} / ${kbd('Ctrl+I')} / ${kbd('Ctrl+U')} định dạng. Bấm biểu tượng bàn phím cuối thanh công cụ để xem đủ phím tắt (Tab chuyển hội thoại, ${kbd('Ctrl+P')} ghim trong app, ${kbd('Ctrl+N')} ghi chú nội bộ…).`,
          'Đang soạn dở mà chuyển sang hội thoại khác: nội dung nháp và trích dẫn được giữ riêng cho từng hội thoại.',
          'Nút nào kênh không hỗ trợ sẽ tự ẩn — định dạng chữ, danh thiếp, thẻ ngân hàng, nhắc hẹn chỉ có ở Zalo; Messenger không có sticker.',
          'Gợi ý AI trên thanh công cụ và Trợ lý AI ở đầu khung chat: xem mục Trợ lý AI. Ứng dụng đã cài (Công cụ → Ứng dụng, API &amp; Webhook) có thể thêm nút vào thanh công cụ và panel riêng trong khung chat.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><LightningIcon className="w-4 h-4 inline" /> Tin nhắn nhanh</SectionTitle>
        <Paragraph>
          Lưu sẵn các mẫu tin hay dùng, gõ{' '}
          <code className="px-1 rounded border border-border bg-muted text-foreground font-mono">/</code>
          {' '}ở đầu ô soạn tin để gọi ra theo từ khoá — đỡ gõ lại cùng một nội dung mỗi ngày.
        </Paragraph>
        <BulletList items={[
          `${b('Dùng:')} gõ / và vài chữ của từ khoá hoặc nội dung → chọn bằng ↑ ↓ → ${kbd('Enter')} hoặc ${kbd('Tab')} để chèn. Hoặc bấm nút ⚡ "Tin nhắn nhanh" trên thanh công cụ.`,
          `${b('Kèm ảnh / video:')} mẫu Local gửi được nhiều ảnh và video cùng nội dung (ảnh / video gửi trước, chữ gửi sau).`,
          `${b('Hai chế độ với Zalo:')} Local — lưu trong Deplao, không bị Zalo giới hạn số lượng; Zalo — lưu trên Zalo, dùng được cả trên điện thoại nhưng có thể bị giới hạn nếu không dùng gói trả phí của Zalo. Facebook và Telegram dùng Local.`,
          `${b('Quản lý tập trung:')} Cài đặt → Hội thoại → Tin nhắn nhanh — thêm / sửa / xoá, lưu một mẫu cho nhiều tài khoản cùng lúc, sao chép tin nhắn nhanh từ tài khoản này sang tài khoản khác.`,
          'Khi chat với bot trên Telegram, gõ / sẽ hiện danh sách lệnh của bot thay cho tin nhắn nhanh.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><SettingsIcon className="w-4 h-4 inline" /> Menu tin nhắn và thả cảm xúc</SectionTitle>
        <Paragraph>Chuột phải vào tin nhắn để mở menu — các mục hiện ra tuỳ loại tin và kênh.</Paragraph>
        <BulletList items={[
          `${b('Thả cảm xúc:')} bấm hoặc giữ chuột trên nút 👍 dưới tin nhắn để mở thanh cảm xúc dạng dọc (tự mở lên / xuống theo chỗ trống); bấm lại cảm xúc của mình để gỡ. Zalo, Facebook có 6 cảm xúc quen thuộc; Telegram có đủ bộ cảm xúc của hội thoại (cuộn trong thanh, hoặc menu chuột phải → nút mở rộng).`,
          `${b('Trả lời · Chuyển tiếp · Sao chép')}, Sao chép link, Copy hình ảnh, Mở trong thư mục, Lưu về máy.`,
          `${b('Chọn tin nhắn:')} chọn nhiều tin (hoặc giữ chuột kéo qua nhiều tin) để Sao chép hoặc Chuyển tiếp một lần.`,
          `${b('Thêm vào lịch · Lưu vào ghi chú')} (khi được dùng Quản lý công việc): tạo lịch hẹn từ tin, ngày giờ tự đọc trong tin ("Mai 9h" thành 9:00 ngày mai), ghi chú là nội dung tin kèm người gửi; nhắc trước thì chuông trên thanh tiêu đề báo "15 phút nữa tới lịch hẹn", tới giờ hiện popup nhắc như nhắc hẹn Zalo, bấm Mở hội thoại để về đúng tin. Chọn nhiều tin thì thanh dưới cũng có hai nút này.`,
          `${b('Tạo lịch hẹn')} ngay dưới tin có ngày giờ sắp tới ("mai 9h", "20 phút nữa", "thứ 6", "20/11"), như Zalo: bấm là điền sẵn ngày giờ theo tin; tin chỉ có ngày thì bạn chọn giờ. Nút tự ẩn khi đã qua giờ hẹn.`,
          `${b('Thu hồi tin nhắn')} của bạn; trưởng / phó nhóm có thêm Xoá tin nhắn của thành viên. Ngoài ra có Xóa (chỉ mình tôi) và Xóa vĩnh viễn khỏi app.`,
          `${b('Sửa tin nhắn')} đã gửi: có ở Telegram. Tin Telegram bạn gửi có thêm dòng "Đã xem" cho biết ai đã xem (trong nhóm) hoặc xem lúc nào (chat riêng).`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><ShareIcon className="w-4 h-4 inline" /> Chuyển tiếp tin nhắn</SectionTitle>
        <BulletList items={[
          'Chuột phải vào tin → Chuyển tiếp, hoặc chọn nhiều tin rồi bấm Chuyển tiếp.',
          `Trong hộp chuyển tiếp: thêm lời nhắn kèm, chọn ${b('Tài khoản gửi')}, tìm người nhận theo tên / SĐT / ID hoặc theo tab Gần nhất · Bạn bè · Nhóm · Nhãn; chọn nhiều người nhận rồi bấm ${b('Chuyển tiếp (n)')}.`,
          'Zalo: chuyển tiếp đúng mọi loại tin — chữ có định dạng, link, danh thiếp, sticker, tin thoại, video, album, cả ảnh chưa tải về máy.',
          'Không chuyển tiếp được cuộc gọi, bình chọn, thẻ thông báo, bản tin OA, tin hệ thống — app tự bỏ qua và báo cho bạn.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><ShieldIcon className="w-4 h-4 inline" /> Zalo: trạng thái truy cập, tự xoá tin, hội thoại ẩn, sản phẩm</SectionTitle>
        <BulletList items={[
          `${b('Trạng thái truy cập')} (Zalo 1:1): bấm avatar trên đầu khung chat hoặc mở chi tiết hội thoại → "Trực tuyến", "Truy cập 14:05" hoặc "Đã ẩn trạng thái truy cập" (theo Zalo, hỏi lại tối đa mỗi phút). Dòng dưới tên trên đầu khung chat nhắc lại trạng thái đã biết.`,
          `${b('Tự xoá tin nhắn')} (Zalo): chi tiết hội thoại hoặc Quản lý nhóm → Tắt · 1 ngày · 7 ngày · 14 ngày. Zalo xoá tin trên điện thoại và Zalo PC của mọi người; ${b('Deplao vẫn giữ nguyên tin trên máy này')}. Đồng hồ cạnh tên hội thoại và cạnh giờ của tin có hẹn tự xoá. Tin gửi từ Deplao vào hội thoại đang bật (trừ sticker) cũng tự xoá trên Zalo. Tin đã quá hạn: đồng hồ gạch chéo và "(đã tự xoá trên Zalo)" — nội dung vẫn còn trong Deplao.`,
          `${b('Hội thoại ẩn')} (Zalo, dùng chung mã PIN với app Zalo): chuột phải → Ẩn hội thoại (mã PIN), lần đầu đặt PIN 4 số. Kính lúp của ô tìm kiếm màu đỏ = tài khoản có hội thoại ẩn; gõ đúng 4 số PIN vào ô tìm kiếm thì danh sách chỉ còn các hội thoại ẩn — bấm kính lúp đỏ hoặc ✕ ở dòng "Hội thoại ẩn" để ẩn lại. Tự ẩn lại khi khoá app, đổi tài khoản hoặc 5 phút không thao tác. Hội thoại ẩn không phát âm thanh, không thông báo, không tính chưa đọc. Quên mã PIN: Cài đặt → Tài khoản → Quyền riêng tư Zalo → "Quên mã PIN? Đặt lại" (hỏi 2 lần, khoá màn hình đang bật thì nhập lại mật khẩu; Zalo có thể xoá tin của các hội thoại đang ẩn trên điện thoại, Deplao vẫn giữ). Đổi / xoá mã PIN trên điện thoại: bấm kính lúp đỏ để Deplao đọc lại từ Zalo — xoá PIN thì các hội thoại hiện lại như thường.`,
          `${b('Gửi sản phẩm')} (tài khoản Zalo Business): nút túi hàng trên thanh soạn tin → chọn danh mục, chọn sản phẩm (chọn nhiều thì gửi cách nhau 2 giây) → gửi link sản phẩm kèm tên và giá. Bấm Quản lý để thêm / sửa / xoá danh mục và sản phẩm (tối đa 5 ảnh).`,
          `${b('Quyền riêng tư Zalo')}: Cài đặt → Tài khoản, dòng Quyền riêng tư Zalo ngay dưới tài khoản Zalo (ngày sinh, trạng thái truy cập, "Đã xem", ai được nhắn tin / gọi điện, nguồn kết bạn); dòng Hội thoại ẩn bên dưới để đặt / đổi / đặt lại mã PIN.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><PinIcon className="w-4 h-4 inline" /> Tin ghim, Tin đánh dấu và My Documents</SectionTitle>
        <Callout tone="info" icon={<InfoIcon className="w-4 h-4" />} title="Ghim không giới hạn trong app">
          Zalo chỉ đồng bộ tối đa 3 tin ghim mỗi hội thoại. Ghim thêm thì tin vẫn được ghim trên máy này nhưng không đồng bộ lên Zalo.
        </Callout>
        <BulletList items={[
          `${b('Ghim tin nhắn:')} chuột phải vào tin → Ghim tin nhắn. Thanh ghim nằm đầu khung chat: bấm để nhảy tới tin gốc, bấm +n để xem tất cả.`,
          `${b('Bảng tin nhóm')} (nhóm Zalo): nút ở đầu khung chat hoặc trong thông tin nhóm, gom Tin ghim · Ghi chú · Bình chọn của nhóm.`,
          `${b('Tin đánh dấu:')} chuột phải vào tin → Đánh dấu tin nhắn; xem lại ở menu ⋮ → Tin đánh dấu (xếp theo ngày, bấm để mở đúng tin). Dùng cho mọi kênh; khi Gộp trang hiện tin đánh dấu của các tài khoản đang gộp.`,
          `${b('My Documents')} (Zalo, "Cloud của tôi"): hội thoại lưu trữ riêng của tài khoản, luôn ở đầu danh sách. Chuột phải vào tin → Lưu vào My Documents để lưu bản sao — xem được cả trên Zalo điện thoại và máy tính.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><TagIcon className="w-4 h-4 inline" /> Gắn nhãn hội thoại</SectionTitle>
        <BulletList items={[
          `${b('Nhãn Local:')} hàng nhãn ngay trên ô soạn tin — bấm để gắn / gỡ. Ẩn / hiện bằng nút nhãn trên thanh công cụ hoặc ${kbd('Ctrl+T')}. Dùng được cho mọi kênh.`,
          `${b('Nhãn Zalo:')} bấm "Nhãn Zalo" dưới tên hội thoại ở đầu khung chat để gán; đồng bộ với Zalo.`,
          `${b('Lọc theo nhãn:')} tab Nhãn trong danh sách hội thoại. Với Nhãn Zalo có nút Cập nhật (lấy nhãn mới nhất từ Zalo) và Chỉnh sửa nhãn.`,
          `${b('Quản lý nhãn:')} Cài đặt → Hội thoại → Quản lý nhãn.`,
        ]} />
      </Card>

      <Card>
        <SectionTitle><CalendarIcon className="w-4 h-4 inline" /> Mốc ngày, bộ sưu tập ảnh và nhảy tới tin</SectionTitle>
        <BulletList items={[
          'Mốc ngày giữa các tin ("Hôm nay", "Hôm qua", "5 ngày trước, 12-10"…); khi cuộn, nhãn ngày nổi ở đầu khung chat cho biết bạn đang xem ngày nào.',
          'Cuộn lên đầu để xem tin cũ hơn: Telegram cá nhân và Facebook tự tải thêm từ máy chủ; tin Zalo cũ lấy bằng Đồng bộ tin nhắn từ điện thoại (xem mục Đồng bộ tin nhắn cũ).',
          'Bấm vào ảnh để mở bộ sưu tập ảnh của hội thoại: ← / → xem ảnh cũ hơn / mới hơn, phóng to / thu nhỏ, Copy hình ảnh, Lưu ảnh, Mở trong trình duyệt.',
          'Nhảy tới tin gốc: bấm thanh ghim, phần trích dẫn, kết quả tìm kiếm hoặc một Tin đánh dấu.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><FolderIcon className="w-4 h-4 inline" /> Kho media và file</SectionTitle>
        <BulletList items={[
          `${b('Panel thông tin hội thoại')} (nút bên phải đầu khung chat, ${kbd('Ctrl+I')}): Ảnh/Video · File · Link đã chia sẻ, Xem tất cả, tải về, mở thư mục.`,
          `${b('Thư viện Media')} khi bấm Gửi ảnh / Gửi file / Gửi video: chia thư mục, Yêu thích, chọn phạm vi một trang hoặc Tất cả trang, tìm trong thư viện; "Upload vào…" để lưu file vào thư viện, "Chọn từ Máy tính" để gửi thẳng; chọn nhiều file rồi bấm Gửi.`,
          'Zalo chỉ giữ ảnh / video trên máy chủ một thời gian: file đã hết hạn hiện "Ảnh đã hết hạn" / "Video đã hết hạn" kèm nút Thử tải lại.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><UserIcon className="w-4 h-4 inline" /> Thông tin liên hệ và nhóm</SectionTitle>
        <Paragraph>Bấm nút Thông tin hội thoại (bên phải đầu khung chat) hoặc Ctrl+I. Các mục hiện theo kênh và quyền của bạn trong nhóm.</Paragraph>
        <BulletList items={[
          `${b('Liên hệ:')} sửa tên gợi nhớ (Zalo: đồng bộ lên Zalo; kênh khác: lưu trong app), số điện thoại, sinh nhật, giới tính; Tắt thông báo, Ghim, Tạo nhóm; Nhóm chung, Chặn tin nhắn và cuộc gọi, Báo xấu, Xoá khỏi danh sách bạn bè, Xoá lịch sử trò chuyện (chỉ xoá trên thiết bị này).`,
          `${b('Nhóm:')} đổi tên nhóm, Thêm thành viên (kênh Telegram: Mời người theo dõi), Quản lý nhóm, Chờ duyệt vào nhóm (Zalo, cho trưởng / phó nhóm), Chủ đề (nhóm Telegram có chủ đề), Bảng tin nhóm (Zalo), Báo xấu, Rời nhóm.`,
          `${b('Quản lý nhóm Zalo:')} quyền của thành viên, chế độ phê duyệt thành viên mới, link tham gia nhóm.`,
          `${b('Thành viên:')} danh sách đầy đủ (gồm cả thành viên đã quét ở CRM / thu thập từ Telegram), tìm không dấu, Tải thêm thành viên, nút Tải lại thành viên từ Zalo / Telegram. Nhãn vai trò: ${b('Trưởng nhóm')} (Zalo: trưởng nhóm · Telegram: người tạo) và ${b('Phó nhóm')} (Zalo: phó nhóm · Telegram: quản trị viên).`,
          'Trưởng / phó nhóm bấm ⋯ cạnh một thành viên để: Xem thông tin, Đặt làm phó nhóm / Xóa phó nhóm, Chặn khỏi nhóm, Xóa khỏi nhóm.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><SendIcon className="w-4 h-4 inline" /> Riêng cho Telegram</SectionTitle>
        <BulletList items={[
          `${b('Nút "+" cạnh ô tìm kiếm:')} Nhóm mới, Kênh mới (công khai hoặc riêng tư), Tham gia nhóm bằng link, Thêm liên hệ Telegram (SĐT hoặc @tên người dùng), Danh bạ (trạng thái, nhắn tin), Cuộc gọi (nhật ký, tab Gọi nhỡ).`,
          `${b('Quản lý nhóm / kênh')} (trong thông tin hội thoại): mô tả, Riêng tư / Công khai, link mời (sao chép, tạo link mới), ký tên bài đăng và nhóm thảo luận (kênh), tự xoá tin nhắn, xoá nhóm / kênh — tuỳ quyền của bạn.`,
          `${b('Bảng Emoji · Sticker · GIF')} (nút Sticker · GIF trên thanh công cụ) đồng bộ với tài khoản: bộ đã thêm, gần đây, yêu thích, GIF đã lưu; tìm bộ sticker / GIF; bấm sticker trong chat để xem và thêm cả bộ.`,
          `${b('Xem trước link:')} thẻ link hiện tên trang, tiêu đề, mô tả; link có video (TikTok…) phát ngay trong thẻ — tự phát không tiếng, bật tiếng tại chỗ. Video trong chat từ 10 MB trở xuống tự tải, lớn hơn thì bấm để tải rồi phát.`,
          'Cảm xúc đủ bộ và đồng bộ 2 chiều; nhóm có chủ đề hiện danh sách Chủ đề; chat với bot: gõ / để xem lệnh của bot.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><AlertIcon className="w-4 h-4 inline" /> Hạn chế cần lưu ý</SectionTitle>
        <Callout tone="warning" icon={<AlertIcon className="w-4 h-4" />} title="Chưa nghe / gọi thoại, video trong Deplao">
          Cuộc gọi Zalo và Messenger chưa được hỗ trợ. Với Telegram, Deplao chỉ hiện nhật ký cuộc gọi và báo khi có cuộc gọi đến
          (để từ chối hoặc mở hội thoại) — hãy nghe máy trên điện thoại hoặc Telegram Desktop.
        </Callout>
        <BulletList items={[
          'Ghim tin Zalo: mỗi hội thoại chỉ đồng bộ tối đa 3 tin ghim lên Zalo.',
          'Facebook: hội thoại mã hoá đầu cuối không tải được tin cũ (Facebook không cho thiết bị mới đọc) — chỉ có tin nhận khi Deplao đang chạy.',
          'Zalo: ảnh / video cũ có thể đã hết hạn trên máy chủ Zalo và không xem lại được.',
          'Telegram Bot: không có trạng thái "đã đọc", và Telegram không cho bot tải lại lịch sử chat cũ.',
          'Xóa hội thoại / Xoá lịch sử trò chuyện trong Deplao chỉ xoá trên máy này, không xoá trên Zalo, Facebook, Telegram.',
        ]} />
      </Card>
    </div>
  );
}
