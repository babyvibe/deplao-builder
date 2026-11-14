import React from 'react';
import { AlertIcon, InfoIcon, MessageCircleIcon, RefreshIcon, SendIcon, SmartphoneIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Bold text inside the HTML string of BulletList / StepList. */
const b = (text: string) => `<strong class="text-foreground">${text}</strong>`;

/** Note box colored by status (semantic tokens, correct in both Light and Dark themes). */
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
        <SectionTitle>{trx('<0/> Đồng bộ tin nhắn cũ - Khi nào cần?', { 0: <RefreshIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Tin nhắn mới tự về Deplao khi app đang chạy, không cần làm gì thêm. Chỉ khi cần xem lại tin nhắn cũ chưa có trong app (ví dụ tin từ trước khi bạn đăng nhập tài khoản vào Deplao) mới dùng tính năng đồng bộ — mỗi kênh một cách:')}
        </Paragraph>
        <BulletList items={[
          tr('{{v1}} lấy lịch sử từ Zalo trên điện thoại — nút {{v2}}.', { v1: b('Zalo:'), v2: b(tr('Đồng bộ tin nhắn từ điện thoại')) }),
          tr('{{v1}} tải lịch sử Messenger — nút {{v2}}. Chỉ dùng khi thật sự cần vì có rủi ro checkpoint.', { v1: b('Facebook:'), v2: b(tr('Đồng bộ tin nhắn Facebook')) }),
          tr('{{v1}} cuộn lên trong hội thoại là tự tải thêm tin cũ (xem cuối trang).', { v1: b(tr('Telegram cá nhân:')) }),
        ]} />
        <Callout tone="info" icon={<InfoIcon className="w-4 h-4" />} title={tr('Tìm nút đồng bộ ở đâu?')}>
          {tr('Hai nút nằm trên thanh trên cùng, chỉ hiện khi bạn đang mở tài khoản Zalo / Facebook tương ứng (hoặc khi Gộp trang có tài khoản đó). Đồng bộ chạy trên máy đang đăng nhập tài khoản — máy nhân viên không có hai nút này.')}
        </Callout>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Zalo - Đồng bộ tin nhắn từ điện thoại', { 0: <SmartphoneIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Lấy tin nhắn trên Zalo điện thoại trong khoảng thời gian bạn chọn và ghép vào đúng các hội thoại trên Deplao. Đây là cách lấy tin nhắn Zalo cũ về app (thay cho nút "Tải tin nhắn cũ" trước đây).')}
        </Paragraph>
        <StepList steps={[
          {
            title: tr('Mở popup đồng bộ'),
            desc: tr('Mở tài khoản Zalo, bấm biểu tượng điện thoại {{v1}} trên thanh trên cùng. Khi Gộp trang có nhiều tài khoản Zalo: chọn ở ô {{v2}}.', { v1: b(tr('Đồng bộ tin nhắn từ điện thoại')), v2: b(tr('Tài khoản Zalo cần đồng bộ')) }),
          },
          {
            title: tr('Chọn khoảng thời gian'),
            desc: tr('{{v1}} (mặc định) · {{v2}} (từ ngày → đến ngày) · {{v3}} — toàn bộ lịch sử trên điện thoại, có thể mất nhiều thời gian với tài khoản nhiều tin nhắn.', { v1: b(tr('1 tuần gần nhất')), v2: b(tr('Chọn ngày')), v3: b(tr('Toàn bộ')) }),
          },
          {
            title: tr('Bấm "Bắt đầu đồng bộ" rồi xác nhận trên điện thoại'),
            desc: tr('Mở Zalo trên điện thoại, chọn {{v1}} ở yêu cầu đồng bộ tin nhắn (thiết bị "Web"). Nên xác nhận ngay — để quá khoảng 3 phút thì yêu cầu hết hạn, phải bấm đồng bộ lại.', { v1: b(tr('Đồng ý')) }),
          },
          {
            title: tr('Giữ Zalo mở trên điện thoại tới khi xong'),
            desc: tr('Popup hiện từng bước: Xác nhận trên điện thoại → Điện thoại chuẩn bị dữ liệu → Tải dữ liệu về máy → Giải mã → Ghép tin nhắn vào hội thoại. Bấm {{v1}} để chạy nền, {{v2}} để dừng.', { v1: b(tr('Ẩn')), v2: b(tr('Huỷ đồng bộ')) }),
          },
        ]} />
        <BulletList items={[
          tr('{{v1}} báo số Tin nhắn mới và số Hội thoại đã ghép. Tin đã có hoặc loại tin không hỗ trợ được bỏ qua; tin ngoài khoảng thời gian không được tải.', { v1: b(tr('Kết quả:')) }),
          tr('Tin được ghép vào đúng hội thoại sẵn có; hội thoại chỉ có trên điện thoại được tạo mới kèm tên và ảnh đại diện. Hội thoại không còn truy cập được (đã xoá, đã rời nhóm) thì không nhập được.'),
          tr('Gồm tin chữ, ảnh, video, file, sticker, tin thoại, danh thiếp, vị trí, bản tin của tài khoản OA…'),
          tr('Ảnh / video cũ có thể đã hết hạn trên máy chủ Zalo: tin vẫn được nhập nhưng hiện "Ảnh đã hết hạn" / "Video đã hết hạn" (có nút Thử tải lại).'),
          tr('Đồng bộ lại bao nhiêu lần cũng được — tin đã có sẽ được bỏ qua, nên chọn khoảng thời gian chồng lên lần trước cũng không sao.'),
        ]} />
        <Callout tone="warning" icon={<AlertIcon className="w-4 h-4" />} title={tr('Điều kiện để đồng bộ được')}>
          <BulletList items={[
            tr('Tài khoản Zalo đang online trên Deplao.'),
            tr('Điện thoại có Zalo của chính tài khoản đó, có mạng và mở Zalo trong suốt quá trình. Điện thoại tạm dừng thì app báo — mở lại Zalo để tiếp tục; chờ quá lâu (khoảng 30 phút) phiên sẽ tự dừng.'),
            tr('Mỗi tài khoản chạy một phiên đồng bộ một lúc. Nếu Zalo trên điện thoại đang khôi phục dữ liệu, hãy thử lại sau.'),
          ]} />
        </Callout>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Facebook - Đồng bộ lịch sử Messenger', { 0: <MessageCircleIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {tr('Tải tin nhắn Messenger trong khoảng thời gian bạn chọn cho mọi hội thoại có hoạt động trong khoảng đó — tải lần lượt từng trang tới hết khoảng, không giới hạn số tin, chạy nền và huỷ được.')}
        </Paragraph>
        <Callout tone="warning" icon={<AlertIcon className="w-4 h-4" />} title={tr('Không cần tin nhắn cũ thì đừng tải')}>
          {trx('Tin nhắn mới vẫn tự về khi Deplao đang chạy — không cần đồng bộ. Tải lịch sử gửi nhiều yêu cầu tới Facebook: Deplao đã giãn nhịp như người dùng thật (nghỉ ngẫu nhiên giữa các trang, nghỉ giải lao sau mỗi 30–50 trang, tối đa khoảng 240 trang mỗi giờ, tự dừng khi Facebook có dấu hiệu hạn chế) nhưng <0>vẫn có rủi ro bị checkpoint</0> — Facebook yêu cầu xác minh hoặc tạm khoá tài khoản. Hãy chọn khoảng thời gian ngắn nhất đủ dùng.', { 0: <strong className="text-foreground" /> })}
        </Callout>
        <StepList steps={[
          {
            title: tr('Mở popup đồng bộ'),
            desc: tr('Mở tài khoản Facebook, bấm nút {{v1}} (mũi tên vòng) trên thanh trên cùng. Có nhiều tài khoản Facebook: chọn ở ô {{v2}}.', { v1: b(tr('Đồng bộ tin nhắn Facebook')), v2: b(tr('Tài khoản Facebook cần đồng bộ')) }),
          },
          {
            title: tr('Chọn khoảng thời gian'),
            desc: tr('{{v1}} (mặc định) · {{v2}} · {{v3}}. "Toàn bộ" lâu nhất, gửi nhiều yêu cầu nhất và rủi ro checkpoint cao nhất — chỉ chọn khi thật sự cần.', { v1: b(tr('1 tuần gần nhất')), v2: b(tr('Chọn ngày')), v3: b(tr('Toàn bộ')) }),
          },
          {
            title: tr('Xác nhận rủi ro rồi bắt đầu'),
            desc: tr('Đọc cảnh báo, tích {{v1}} (lượt tải nào cũng phải tích lại) → bấm {{v2}}.', { v1: b(tr('Tôi hiểu rủi ro và vẫn muốn tải')), v2: b(tr('Bắt đầu đồng bộ')) }),
          },
          {
            title: tr('Theo dõi hoặc để chạy nền'),
            desc: tr('Popup hiện hội thoại đang tải, lý do và thời gian đang nghỉ (đếm ngược), số Tin mới / Hội thoại. Bấm {{v1}} để chạy nền, {{v2}} để dừng — tin đã tải vẫn được giữ.', { v1: b(tr('Ẩn')), v2: b(tr('Huỷ đồng bộ')) }),
          },
        ]} />
        <BulletList items={[
          tr('Tải nhiều có thể mất vài giờ. Tin đã có được bỏ qua; tin mẫu của Trang trước đây hiện rỗng được sửa lại.'),
          tr('Hội thoại mã hoá đầu cuối không tải được tin cũ (Facebook không cho thiết bị mới đọc) — chỉ có tin nhận khi Deplao đang chạy.'),
          tr('Khi Facebook có dấu hiệu hạn chế, yêu cầu xác minh hoặc phiên hết hạn, đồng bộ tự dừng để bảo vệ tài khoản và tạm ngưng tải lịch sử khoảng 30 phút.'),
          tr('Tài khoản Facebook phải đang kết nối. Nếu báo có hội thoại Facebook chưa trả lời, bấm Đồng bộ lại để thử tiếp.'),
          tr('Cuộn lên đầu một hội thoại Facebook cũng tải thêm tin cũ — dùng chung nhịp tải an toàn ở trên.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle><SendIcon className="w-4 h-4 inline" /> Telegram</SectionTitle>
        <BulletList items={[
          tr('{{v1}} cuộn lên đầu hội thoại là tự tải thêm tin cũ từ Telegram. Muốn lấy nhanh nhiều tin, bấm biểu tượng tải xuống {{v2}} ở đầu khung chat và nhập số tin (tối đa 5.000).', { v1: b(tr('Tài khoản Telegram cá nhân:')), v2: b(tr('Tải tin nhắn từ Telegram')) }),
          tr('Nút {{v1}} trên thanh trên cùng tải lại tin nhắn của cả tài khoản ở nền; hội thoại tự cập nhật.', { v1: b(tr('Đồng bộ hội thoại và tin nhắn Telegram')) }),
          tr('{{v1}} Telegram không cho bot tải lại lịch sử chat tuỳ ý — bot chỉ nhận các tin còn trong hàng đợi.', { v1: b('Telegram Bot:') }),
        ]} />
      </Card>
    </div>
  );
}
