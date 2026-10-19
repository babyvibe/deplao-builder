import React from 'react';
import { AlertIcon, InfoIcon, MessageCircleIcon, RefreshIcon, SendIcon, SmartphoneIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

/** Chữ đậm trong chuỗi HTML của BulletList / StepList. */
const b = (text: string) => `<strong class="text-foreground">${text}</strong>`;

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
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        {children && <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

export function HistorySyncPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><RefreshIcon className="w-4 h-4 inline" /> Đồng bộ tin nhắn cũ - Khi nào cần?</SectionTitle>
        <Paragraph>
          Tin nhắn mới tự về Deplao khi app đang chạy, không cần làm gì thêm. Chỉ khi cần xem lại tin nhắn cũ chưa có trong app
          (ví dụ tin từ trước khi bạn đăng nhập tài khoản vào Deplao) mới dùng tính năng đồng bộ — mỗi kênh một cách:
        </Paragraph>
        <BulletList items={[
          `${b('Zalo:')} lấy lịch sử từ Zalo trên điện thoại — nút ${b('Đồng bộ tin nhắn từ điện thoại')}.`,
          `${b('Facebook:')} tải lịch sử Messenger — nút ${b('Đồng bộ tin nhắn Facebook')}. Chỉ dùng khi thật sự cần vì có rủi ro checkpoint.`,
          `${b('Telegram cá nhân:')} cuộn lên trong hội thoại là tự tải thêm tin cũ (xem cuối trang).`,
        ]} />
        <Callout tone="info" icon={<InfoIcon className="w-4 h-4" />} title="Tìm nút đồng bộ ở đâu?">
          Hai nút nằm trên thanh trên cùng, chỉ hiện khi bạn đang mở tài khoản Zalo / Facebook tương ứng (hoặc khi Gộp trang có tài khoản đó).
          Đồng bộ chạy trên máy đang đăng nhập tài khoản — máy nhân viên không có hai nút này.
        </Callout>
      </Card>

      <Card>
        <SectionTitle><SmartphoneIcon className="w-4 h-4 inline" /> Zalo - Đồng bộ tin nhắn từ điện thoại</SectionTitle>
        <Paragraph>
          Lấy tin nhắn trên Zalo điện thoại trong khoảng thời gian bạn chọn và ghép vào đúng các hội thoại trên Deplao.
          Đây là cách lấy tin nhắn Zalo cũ về app (thay cho nút "Tải tin nhắn cũ" trước đây).
        </Paragraph>
        <StepList steps={[
          {
            title: 'Mở popup đồng bộ',
            desc: `Mở tài khoản Zalo, bấm biểu tượng điện thoại ${b('Đồng bộ tin nhắn từ điện thoại')} trên thanh trên cùng. Khi Gộp trang có nhiều tài khoản Zalo: chọn ở ô ${b('Tài khoản Zalo cần đồng bộ')}.`,
          },
          {
            title: 'Chọn khoảng thời gian',
            desc: `${b('1 tuần gần nhất')} (mặc định) · ${b('Chọn ngày')} (từ ngày → đến ngày) · ${b('Toàn bộ')} — toàn bộ lịch sử trên điện thoại, có thể mất nhiều thời gian với tài khoản nhiều tin nhắn.`,
          },
          {
            title: 'Bấm "Bắt đầu đồng bộ" rồi xác nhận trên điện thoại',
            desc: `Mở Zalo trên điện thoại, chọn ${b('Đồng ý')} ở yêu cầu đồng bộ tin nhắn (thiết bị "Web"). Nên xác nhận ngay — để quá khoảng 3 phút thì yêu cầu hết hạn, phải bấm đồng bộ lại.`,
          },
          {
            title: 'Giữ Zalo mở trên điện thoại tới khi xong',
            desc: `Popup hiện từng bước: Xác nhận trên điện thoại → Điện thoại chuẩn bị dữ liệu → Tải dữ liệu về máy → Giải mã → Ghép tin nhắn vào hội thoại. Bấm ${b('Ẩn')} để chạy nền, ${b('Huỷ đồng bộ')} để dừng.`,
          },
        ]} />
        <BulletList items={[
          `${b('Kết quả:')} báo số Tin nhắn mới và số Hội thoại đã ghép. Tin đã có hoặc loại tin không hỗ trợ được bỏ qua; tin ngoài khoảng thời gian không được tải.`,
          'Tin được ghép vào đúng hội thoại sẵn có; hội thoại chỉ có trên điện thoại được tạo mới kèm tên và ảnh đại diện. Hội thoại không còn truy cập được (đã xoá, đã rời nhóm) thì không nhập được.',
          'Gồm tin chữ, ảnh, video, file, sticker, tin thoại, danh thiếp, vị trí, bản tin của tài khoản OA…',
          'Ảnh / video cũ có thể đã hết hạn trên máy chủ Zalo: tin vẫn được nhập nhưng hiện "Ảnh đã hết hạn" / "Video đã hết hạn" (có nút Thử tải lại).',
          'Đồng bộ lại bao nhiêu lần cũng được — tin đã có sẽ được bỏ qua, nên chọn khoảng thời gian chồng lên lần trước cũng không sao.',
        ]} />
        <Callout tone="warning" icon={<AlertIcon className="w-4 h-4" />} title="Điều kiện để đồng bộ được">
          <BulletList items={[
            'Tài khoản Zalo đang online trên Deplao.',
            'Điện thoại có Zalo của chính tài khoản đó, có mạng và mở Zalo trong suốt quá trình. Điện thoại tạm dừng thì app báo — mở lại Zalo để tiếp tục; chờ quá lâu (khoảng 30 phút) phiên sẽ tự dừng.',
            'Mỗi tài khoản chạy một phiên đồng bộ một lúc. Nếu Zalo trên điện thoại đang khôi phục dữ liệu, hãy thử lại sau.',
          ]} />
        </Callout>
      </Card>

      <Card>
        <SectionTitle><MessageCircleIcon className="w-4 h-4 inline" /> Facebook - Đồng bộ lịch sử Messenger</SectionTitle>
        <Paragraph>
          Tải tin nhắn Messenger trong khoảng thời gian bạn chọn cho mọi hội thoại có hoạt động trong khoảng đó — tải lần lượt
          từng trang tới hết khoảng, không giới hạn số tin, chạy nền và huỷ được.
        </Paragraph>
        <Callout tone="warning" icon={<AlertIcon className="w-4 h-4" />} title="Không cần tin nhắn cũ thì đừng tải">
          Tin nhắn mới vẫn tự về khi Deplao đang chạy — không cần đồng bộ. Tải lịch sử gửi nhiều yêu cầu tới Facebook: Deplao đã giãn
          nhịp như người dùng thật (nghỉ ngẫu nhiên giữa các trang, nghỉ giải lao sau mỗi 30–50 trang, tối đa khoảng 240 trang mỗi giờ,
          tự dừng khi Facebook có dấu hiệu hạn chế) nhưng <strong className="text-foreground">vẫn có rủi ro bị checkpoint</strong> —
          Facebook yêu cầu xác minh hoặc tạm khoá tài khoản. Hãy chọn khoảng thời gian ngắn nhất đủ dùng.
        </Callout>
        <StepList steps={[
          {
            title: 'Mở popup đồng bộ',
            desc: `Mở tài khoản Facebook, bấm nút ${b('Đồng bộ tin nhắn Facebook')} (mũi tên vòng) trên thanh trên cùng. Có nhiều tài khoản Facebook: chọn ở ô ${b('Tài khoản Facebook cần đồng bộ')}.`,
          },
          {
            title: 'Chọn khoảng thời gian',
            desc: `${b('1 tuần gần nhất')} (mặc định) · ${b('Chọn ngày')} · ${b('Toàn bộ')}. "Toàn bộ" lâu nhất, gửi nhiều yêu cầu nhất và rủi ro checkpoint cao nhất — chỉ chọn khi thật sự cần.`,
          },
          {
            title: 'Xác nhận rủi ro rồi bắt đầu',
            desc: `Đọc cảnh báo, tích ${b('Tôi hiểu rủi ro và vẫn muốn tải')} (lượt tải nào cũng phải tích lại) → bấm ${b('Bắt đầu đồng bộ')}.`,
          },
          {
            title: 'Theo dõi hoặc để chạy nền',
            desc: `Popup hiện hội thoại đang tải, lý do và thời gian đang nghỉ (đếm ngược), số Tin mới / Hội thoại. Bấm ${b('Ẩn')} để chạy nền, ${b('Huỷ đồng bộ')} để dừng — tin đã tải vẫn được giữ.`,
          },
        ]} />
        <BulletList items={[
          'Tải nhiều có thể mất vài giờ. Tin đã có được bỏ qua; tin mẫu của Trang trước đây hiện rỗng được sửa lại.',
          'Hội thoại mã hoá đầu cuối không tải được tin cũ (Facebook không cho thiết bị mới đọc) — chỉ có tin nhận khi Deplao đang chạy.',
          'Khi Facebook có dấu hiệu hạn chế, yêu cầu xác minh hoặc phiên hết hạn, đồng bộ tự dừng để bảo vệ tài khoản và tạm ngưng tải lịch sử khoảng 30 phút.',
          'Tài khoản Facebook phải đang kết nối. Nếu báo có hội thoại Facebook chưa trả lời, bấm Đồng bộ lại để thử tiếp.',
          'Cuộn lên đầu một hội thoại Facebook cũng tải thêm tin cũ — dùng chung nhịp tải an toàn ở trên.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><SendIcon className="w-4 h-4 inline" /> Telegram</SectionTitle>
        <BulletList items={[
          `${b('Tài khoản Telegram cá nhân:')} cuộn lên đầu hội thoại là tự tải thêm tin cũ từ Telegram. Muốn lấy nhanh nhiều tin, bấm biểu tượng tải xuống ${b('Tải tin nhắn từ Telegram')} ở đầu khung chat và nhập số tin (tối đa 5.000).`,
          `Nút ${b('Đồng bộ hội thoại và tin nhắn Telegram')} trên thanh trên cùng tải lại tin nhắn của cả tài khoản ở nền; hội thoại tự cập nhật.`,
          `${b('Telegram Bot:')} Telegram không cho bot tải lại lịch sử chat tuỳ ý — bot chỉ nhận các tin còn trong hàng đợi.`,
        ]} />
      </Card>
    </div>
  );
}
