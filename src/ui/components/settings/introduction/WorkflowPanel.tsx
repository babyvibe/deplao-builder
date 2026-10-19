import React from 'react';
import {
  AlertIcon, BotIcon, ClipboardListIcon, FilterIcon, LightningIcon, PlayIcon, PluginIcon,
  SendIcon, SlidersIcon, SparklesIcon, TargetIcon,
} from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

/** Một nhóm tên node, ghi đúng như trong bảng "Kéo node vào sơ đồ" của trình sửa workflow. */
function NodeChips({ title, items, note }: { title: string; items: string[]; note?: string }) {
  return (
    <div className="bg-muted/50 border border-border/50 rounded-lg px-2.5 py-2">
      <p className="text-foreground text-[11px] font-semibold">{title}</p>
      <div className="flex flex-wrap gap-1 mt-1.5">
        {items.map(item => (
          <span key={item} className="text-[11px] leading-4 text-foreground/80 bg-card border border-border/60 rounded-md px-1.5 py-0.5">
            {item}
          </span>
        ))}
      </div>
      {note && <p className="text-muted-foreground text-[11px] leading-relaxed mt-1.5">{note}</p>}
    </div>
  );
}

// Danh sách lấy theo nhóm "Kích hoạt" / "Hành động" của bảng node (lọc theo kênh của workflow).
const TRIGGERS: { title: string; items: string[] }[] = [
  { title: 'Mọi kênh', items: ['Chạy theo lịch hẹn', 'Chạy thủ công', 'Khi nhận thanh toán', 'Khi phần mềm bán hàng gửi webhook', 'Webhook bên ngoài', 'Khi API/ứng dụng gọi'] },
  { title: 'Zalo', items: ['Khi nhận tin nhắn', 'Khi có lời mời kết bạn', 'Khi có sự kiện nhóm', 'Khi có người react tin nhắn', 'Khi gán hoặc gỡ nhãn'] },
  {
    title: 'Facebook',
    items: ['Khi nhận tin nhắn', 'Khi nhận tin nhắn ảnh', 'Khi nhận tin nhắn video', 'Khi nhận tin nhắn file', 'Khi nhận sticker', 'Khi có reaction', 'Khi thu hồi tin nhắn', 'Khi có sự kiện nhóm'],
  },
  { title: 'Telegram (Cá nhân)', items: ['Khi nhận tin nhắn Telegram', 'Khi thu hồi tin nhắn Telegram', 'Sự kiện nhóm Telegram'] },
  {
    title: 'Telegram (Bot)',
    items: ['Khi Bot nhận tin nhắn', 'Khi user gửi lệnh cho Bot', 'Khi user nhấn nút Bot', 'Bot được thêm/gỡ nhóm', 'Khi tin nhắn Bot bị sửa', 'Khi có yêu cầu vào nhóm'],
  },
];

const ACTIONS: { title: string; items: string[]; note?: string }[] = [
  {
    title: 'Mọi kênh',
    items: ['Chuyển tiếp đa kênh'],
    note: 'Gửi lại tin gốc (chữ, ảnh, video, file đã tải về) sang Zalo, Facebook, Telegram User hoặc Telegram Bot.',
  },
  {
    title: 'Zalo',
    items: [
      'Gửi tin nhắn', 'Hiệu ứng đang gõ + chờ', 'Gửi ảnh', 'Gửi file đính kèm', 'Tìm user bằng số điện thoại',
      'Lấy thông tin người dùng', 'Chấp nhận lời mời kết bạn', 'Từ chối lời mời kết bạn', 'Gửi lời mời kết bạn',
      'Thêm thành viên vào nhóm', 'Xóa thành viên khỏi nhóm', 'Tắt/bật thông báo', 'Chuyển tiếp tin nhắn',
      'Thu hồi tin nhắn', 'Tạo bình chọn trong nhóm', 'Lấy lịch sử tin nhắn', 'Thêm cảm xúc vào tin nhắn',
      'Gắn nhãn hội thoại', 'Gỡ nhãn hội thoại', 'Đổi tên gợi nhớ',
    ],
  },
  {
    title: 'Facebook',
    items: [
      'Gửi tin nhắn', 'Gửi tệp đính kèm', 'Thả reaction', 'Thu hồi tin nhắn', 'Chỉnh sửa tin nhắn', 'Gửi lại nội dung',
      'Ghim tin nhắn', 'Bỏ ghim tin nhắn', 'Tạo bình chọn', 'Hiệu ứng đang gõ', 'Đánh dấu đã đọc', 'Chặn người dùng',
      'Đổi tên nhóm', 'Đổi biểu tượng nhóm', 'Đổi biệt danh thành viên',
    ],
    note: 'Gửi tệp đính kèm dùng cho ảnh, video, audio và file. Gửi lại nội dung chỉ gửi lại phần chữ - muốn chuyển cả media hãy dùng Chuyển tiếp đa kênh.',
  },
  {
    title: 'Telegram (Cá nhân)',
    items: [
      'Gửi tin nhắn', 'Gửi ảnh', 'Gửi file đính kèm', 'Gửi sticker', 'Chuyển tiếp tin nhắn', 'Chỉnh sửa tin nhắn',
      'Xóa tin nhắn', 'Ghim tin nhắn', 'Thả reaction', 'Tạo bình chọn', 'Hiệu ứng đang gõ', 'Đánh dấu đã đọc',
      'Đánh dấu topic đã đọc', 'Chặn người dùng', 'Bỏ chặn người dùng', 'Thêm thành viên', 'Xóa thành viên',
      'Cấm thành viên', 'Thăng quyền thành viên', 'Đổi tên nhóm', 'Rời nhóm', 'Lấy link mời', 'Tạo topic mới',
    ],
  },
  {
    title: 'Telegram (Bot)',
    items: [
      'Gửi tin nhắn / Keyboard', 'Gửi ảnh', 'Gửi video', 'Gửi file đính kèm', 'Chuyển tiếp tin nhắn', 'Sửa tin nhắn',
      'Xóa tin nhắn', 'Ghim tin nhắn', 'Bỏ ghim tin nhắn', 'Thả reaction', 'Tạo bình chọn', 'Hiển thị đang gõ',
      'Cấm thành viên', 'Hạn chế thành viên',
    ],
    note: 'Gửi tin nhắn / Keyboard: bật Thêm nút tương tác để gắn Reply Keyboard (bấm nút = gửi chữ trên nút như một tin nhắn mới) hoặc Inline Button (Đi đến node - chạy một nhánh khác trên sơ đồ, dây nét đứt; Callback tùy chỉnh; Mở liên kết). Thao tác trong nhóm cần Bot là admin có quyền phù hợp.',
  },
];

export function WorkflowPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><LightningIcon className="w-4 h-4 inline" /> Workflow tự động - không cần viết code</SectionTitle>
        <Paragraph>
          Workflow là kịch bản tự động dạng sơ đồ kéo-thả: một <strong className="text-foreground font-semibold">Kích hoạt</strong> (có
          tin nhắn, đến giờ hẹn, có webhook...) nối tới các bước <strong className="text-foreground font-semibold">điều kiện, xử lý và
          hành động</strong> (gửi tin, gắn nhãn, hỏi AI, ghi Google Sheets...). Workflow đang bật tự chạy nền mỗi khi có sự kiện, miễn là
          Deplao đang mở. Mở tại thanh bên <strong className="text-foreground font-semibold">Công cụ → Workflow (n8n)</strong> (hoặc
          nút <strong className="text-foreground font-semibold">Tất cả tính năng</strong> → Workflow).
        </Paragraph>
        <StepList steps={[
          {
            title: 'Tạo workflow',
            desc: 'Bấm <strong class="text-foreground">Tạo workflow</strong> → chọn kênh <strong class="text-foreground">Zalo</strong>, <strong class="text-foreground">Facebook</strong>, <strong class="text-foreground">Telegram (Cá nhân)</strong> hoặc <strong class="text-foreground">Telegram (Bot)</strong>. Mỗi workflow dùng cho một kênh, bảng node chỉ hiện node hợp với kênh đó. Có thể bắt đầu từ <strong class="text-foreground">Kho mẫu</strong> hoặc <strong class="text-foreground">Nhập JSON</strong>.',
          },
          {
            title: 'Chọn tài khoản áp dụng',
            desc: 'Dùng ô tài khoản trên thanh công cụ của trình sửa. Không chọn tài khoản nào = workflow chạy cho <strong class="text-foreground">tất cả</strong> tài khoản của kênh đó.',
          },
          {
            title: 'Kéo thả và cấu hình node',
            desc: 'Kéo node từ bảng bên trái (có ô <strong class="text-foreground">Tìm node...</strong>) vào sơ đồ, nối các node bằng dây, bấm vào node để mở bảng cài đặt. Nút <strong class="text-foreground">Chèn biến</strong> đưa dữ liệu động vào nội dung: tên khách, nội dung tin, kết quả của bước trước...',
          },
          {
            title: 'Sắp xếp sơ đồ',
            desc: 'Bấm <strong class="text-foreground">Sắp xếp tự động</strong> để dàn node theo luồng (nút <strong class="text-foreground">Hoàn tác</strong> hiện khoảng 10 giây sau đó). Muốn xóa dây: chọn dây rồi bấm ✕ hoặc phím Del.',
          },
          {
            title: 'Lưu, thử rồi mới bật',
            desc: 'Bấm <strong class="text-foreground">Lưu</strong> → <strong class="text-foreground">Mô phỏng</strong> để xem kịch bản chạy ra sao mà không gửi tin thật → bật công tắc trên thẻ workflow ở danh sách (hoặc công tắc <strong class="text-foreground">Bật/Tắt</strong> trong trình sửa rồi bấm Lưu).',
          },
        ]} />
      </Card>

      <Card>
        <SectionTitle><SparklesIcon className="w-4 h-4 inline" /> AI copilot - tạo workflow bằng câu lệnh tiếng Việt</SectionTitle>
        <Paragraph>
          Trong trình sửa, bấm nút <strong className="text-foreground font-semibold">AI</strong> để mở <strong className="text-foreground font-semibold">Trợ
          lý thiết kế workflow</strong>, rồi mô tả việc cần tự động hoá bằng lời thường. VD: “Khách nhắn hỏi giá thì AI trả lời tự động;
          khách muốn đặt hàng thì gắn nhãn Đặt hàng và báo cho tôi”.
        </Paragraph>
        <BulletList items={[
          'AI hỏi lại chỗ chưa rõ, tự tra cứu node, danh bạ và Nhãn Local thật của bạn, rồi đưa ra <strong class="text-foreground">bản đề xuất</strong> (v1, v2...) kèm xem trước node mới / sửa / giữ nguyên.',
          'Bấm <strong class="text-foreground">Thêm vào kịch bản</strong>, <strong class="text-foreground">Áp dụng thay đổi</strong> hoặc <strong class="text-foreground">Thay thế kịch bản</strong> để đưa đề xuất lên sơ đồ; đề xuất còn lỗi thì bấm <strong class="text-foreground">Nhờ AI sửa</strong>. Sau khi áp dụng có nút <strong class="text-foreground">Hoàn tác AI</strong> (khoảng 30 giây) - nhớ bấm <strong class="text-foreground">Lưu</strong>.',
          'Có thể nhờ AI giải thích hoặc rà lỗi workflow đang mở. Cuộc trò chuyện được giữ riêng cho từng workflow; bấm <strong class="text-foreground">Trò chuyện mới</strong> để bắt đầu lại.',
          'Cần ít nhất một trợ lý AI đang bật (<strong class="text-foreground">Công cụ → Tích hợp → Trợ lý AI</strong>). Nên chọn trợ lý dùng model mạnh để đề xuất chính xác hơn.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><PlayIcon className="w-4 h-4 inline" /> Mô phỏng và Chạy thử</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Mô phỏng</strong>: nhập tên khách và tin nhắn mẫu, bấm <strong class="text-foreground">Chạy mô phỏng</strong> → xem workflow trả lời gì trên khung điện thoại giả lập và đi nhánh nào (<strong class="text-foreground">Xem luồng chạy</strong>). <strong class="text-foreground">Không gửi tin thật, không gọi API / AI thật</strong> - bước AI chỉ trả về câu mẫu, phân loại AI luôn ra “khác”.',
          'Mô phỏng chạy theo <strong class="text-foreground">bản đã lưu</strong> - sửa xong hãy bấm <strong class="text-foreground">Lưu</strong> trước khi mô phỏng.',
          '<strong class="text-foreground">Chạy thử</strong> (trong trình sửa hoặc trên thẻ ở danh sách): chạy thật một lần ngay, các bước gửi tin sẽ <strong class="text-foreground">gửi thật</strong>. Workflow Zalo có bước gửi tin sẽ hỏi tài khoản gửi, nội dung tin thử và người nhận trong danh bạ.',
          'Kích hoạt <strong class="text-foreground">Chạy thủ công</strong> dành cho workflow chỉ chạy khi bạn bấm Chạy thử.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><TargetIcon className="w-4 h-4 inline" /> Kích hoạt (Trigger) - workflow chạy khi nào?</SectionTitle>
        <Paragraph>
          Mỗi workflow bắt đầu từ một node trong nhóm <strong className="text-foreground font-semibold">Kích hoạt</strong>. Bảng node chỉ
          hiện kích hoạt của kênh đang dùng và các kích hoạt dùng chung:
        </Paragraph>
        <div className="space-y-2">
          {TRIGGERS.map(group => <NodeChips key={group.title} title={group.title} items={group.items} />)}
        </div>
        <BulletList items={[
          '<strong class="text-foreground">Chạy theo lịch hẹn</strong>: chọn mẫu (8h sáng mỗi ngày, mỗi giờ, mỗi 30 phút, thứ Hai 8h, đầu tháng 8h, mỗi đêm 0h) hoặc tự nhập lịch cron; múi giờ mặc định Việt Nam.',
          '<strong class="text-foreground">Khi gán hoặc gỡ nhãn</strong>: chọn chạy khi gán, khi gỡ hoặc cả hai; lọc theo Nhãn Local / nhãn Zalo và theo từng nhãn.',
          '<strong class="text-foreground">Webhook bên ngoài</strong>: URL riêng được tạo khi bấm Lưu, có Secret Key (kiểm tra chữ ký) và giới hạn IP. <strong class="text-foreground">Khi nhận thanh toán</strong>: nhận giao dịch Casso / SePay đã kết nối ở Tích hợp, lọc số tiền tối thiểu và nội dung chuyển khoản. <strong class="text-foreground">Khi phần mềm bán hàng gửi webhook</strong>: KiotViet / Haravan / Sapo / Nhanh.vn / Pancake POS báo đơn hàng, khách hàng, sản phẩm, tồn kho — chỉ webhook xác thực đúng khoá đặt ở trang tích hợp; lọc theo phần mềm, loại dữ liệu, tên sự kiện, trạng thái. Muốn các loại này nhận dữ liệu từ Internet, bật địa chỉ ở <strong class="text-foreground">Cài đặt → Internet &amp; Đám mây → Địa chỉ Internet</strong>.',
          '<strong class="text-foreground">Khi API/ứng dụng gọi</strong>: phần mềm khác (qua Public API, quản lý ở <strong class="text-foreground">Công cụ → Ứng dụng, API &amp; Webhook</strong>) hoặc ứng dụng đã cài gửi sự kiện để kích hoạt workflow; lọc được theo tên sự kiện.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><FilterIcon className="w-4 h-4 inline" /> Bộ lọc của kích hoạt tin nhắn</SectionTitle>
        <Paragraph>Bấm vào node kích hoạt tin nhắn để giới hạn khi nào workflow chạy:</Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Phạm vi</strong>: tất cả / chỉ tin cá nhân / chỉ tin nhóm (Telegram có thêm kênh và topic), chỉ một nhóm hoặc hội thoại cụ thể, <strong class="text-foreground">Loại trừ hội thoại / nhóm</strong>.',
          '<strong class="text-foreground">Người gửi</strong>: chỉ một người cụ thể, <strong class="text-foreground">Loại trừ người gửi</strong>, <strong class="text-foreground">Bỏ qua tin nhắn do mình gửi</strong> (bật sẵn, tránh workflow tự kích hoạt lại chính nó). Zalo có thêm <strong class="text-foreground">Vai trò người gửi trong nhóm</strong>: Trưởng nhóm, Phó nhóm, Trưởng + phó nhóm hoặc Thành viên thường.',
          '<strong class="text-foreground">Nội dung</strong>: <strong class="text-foreground">Từ khóa kích hoạt</strong> (nhiều từ cách nhau bằng dấu phẩy, không phân biệt hoa / thường; chứa ít nhất 1 từ, chứa đủ tất cả, khớp nguyên câu, bắt đầu bằng...). Zalo có thêm <strong class="text-foreground">Loại tin nhắn</strong> (văn bản, hình ảnh, sticker, tệp, ghi âm, video, liên kết) và <strong class="text-foreground">Chỉ khi được @nhắc tên trong nhóm</strong> (tính cả @Tất cả).',
          '<strong class="text-foreground">Thời gian &amp; tần suất</strong> (Zalo, Facebook, Telegram cá nhân): <strong class="text-foreground">Khung giờ hoạt động</strong> - chỉ chạy trong giờ hoặc ngoài giờ (VD tự trả lời ngoài giờ làm việc); <strong class="text-foreground">Giới hạn tần suất (phút)</strong> - mỗi hội thoại chạy tối đa 1 lần trong N phút, bộ đếm đặt lại khi khởi động lại app; <strong class="text-foreground">Gom tin nhắn liên tiếp</strong> - chờ N giây sau tin cuối rồi xử lý một lần (nên đặt 10-15 giây khi dùng AI trả lời).',
          '<strong class="text-foreground">Telegram (Bot)</strong>: lọc theo nguồn chat, chat cụ thể, loại nội dung, từ khóa; riêng <strong class="text-foreground">Khi user gửi lệnh cho Bot</strong> lọc được lệnh chính, lệnh thay thế, tham số và danh sách Telegram user ID được phép.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><SendIcon className="w-4 h-4 inline" /> Hành động theo kênh</SectionTitle>
        <Paragraph>
          Nhóm <strong className="text-foreground font-semibold">Hành động</strong> chỉ hiện node của kênh workflow đang dùng. Node gửi tin
          mặc định trả lời đúng hội thoại vừa kích hoạt; muốn gửi nơi khác thì chọn ở ô người nhận
          (VD <strong className="text-foreground font-semibold">Gửi đến hội thoại</strong>).
        </Paragraph>
        <div className="space-y-2">
          {ACTIONS.map(group => <NodeChips key={group.title} title={group.title} items={group.items} note={group.note} />)}
        </div>
      </Card>

      <Card>
        <SectionTitle><SlidersIcon className="w-4 h-4 inline" /> Điều kiện, vòng lặp &amp; dữ liệu - chạy thực tế ra sao</SectionTitle>
        <Paragraph>Các node dưới đây dùng được ở mọi kênh:</Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Rẽ nhánh Đúng/Sai (IF)</strong>: so sánh một giá trị (thường là nội dung tin): có chứa, không chứa, bằng, khác, bắt đầu / kết thúc bằng, lớn hơn / nhỏ hơn (số), rỗng, Regex → chạy nhánh <strong class="text-foreground">Đúng</strong> hoặc <strong class="text-foreground">Sai</strong>. So sánh chữ có phân biệt hoa / thường; muốn bắt nhiều cách viết hãy dùng Regex (không phân biệt hoa / thường).',
          '<strong class="text-foreground">Phân nhiều nhánh (Switch)</strong>: so giá trị với từng nhánh, phải <strong class="text-foreground">khớp chính xác</strong> từng chữ; không khớp nhánh nào thì chạy nhánh mặc định. Hay đặt sau <strong class="text-foreground">Phân loại văn bản bằng AI</strong> - đặt giá trị các nhánh đúng y tên danh mục.',
          '<strong class="text-foreground">Tạm dừng chờ N giây</strong> (tối đa 5 phút mỗi lần chờ), <strong class="text-foreground">Lưu giá trị vào biến</strong> (dùng lại ở bước sau), <strong class="text-foreground">Dừng workflow nếu...</strong> (dừng ngay khi điều kiện đúng).',
          '<strong class="text-foreground">Chọn đối tượng nhận tin</strong>: lấy danh sách người nhận từ Bạn bè (danh bạ Zalo), Thành viên nhóm Zalo, Hội thoại theo nhãn (Local) hoặc Liên hệ CRM - mặc định tối đa 500 người, có <strong class="text-foreground">Loại trừ người nhận</strong>. Nối sang node <strong class="text-foreground">Gửi tin nhắn</strong> (Zalo) và đặt ô <strong class="text-foreground">Danh sách hội thoại động (nâng cao)</strong> bằng kết quả của node này để gửi hàng loạt.',
          '<strong class="text-foreground">Lặp qua danh sách</strong>: chọn một danh sách của bước trước (VD sản phẩm, đơn hàng tra được, tồn kho). Các bước nối từ cổng <strong class="text-foreground">Mỗi phần tử</strong> chạy lại cho từng phần tử (node mới mặc định tối đa 20, chỉnh được tới 100) với <code class="font-mono text-foreground">{{ $var.item }}</code>, một trường <code class="font-mono text-foreground">{{ $var.item.name }}</code>, số thứ tự <code class="font-mono text-foreground">{{ $var.itemIndex }}</code>; cổng <strong class="text-foreground">Xong</strong> chạy một lần sau khi lặp hết. Muốn gửi <strong class="text-foreground">một</strong> tin liệt kê: trong vòng lặp dùng Lưu giá trị vào biến để nối thêm dòng, rồi gửi biến đó ở nhánh Xong. Lịch sử chạy ghi từng lượt lặp. Gửi tin cho nhiều người vẫn nên dùng Chọn đối tượng nhận tin.',
          '<strong class="text-foreground">Xử lý dữ liệu</strong>: Ghép nội dung văn bản, Chọn ngẫu nhiên 1 mục (tránh câu trả lời bị lặp), Định dạng ngày giờ, Đọc dữ liệu JSON.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><BotIcon className="w-4 h-4 inline" /> AI trong workflow</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Tạo nội dung bằng AI</strong>: sinh câu trả lời, tóm tắt, viết nội dung theo yêu cầu; có thể truyền lịch sử chat (VD kết quả node Lấy lịch sử tin nhắn) để AI nhớ ngữ cảnh.',
          '<strong class="text-foreground">Phân loại văn bản bằng AI</strong>: AI xếp tin nhắn vào một trong các danh mục bạn liệt kê (VD: hỏi giá, đặt hàng, khiếu nại, khác) rồi trả về tên danh mục - nối tiếp Phân nhiều nhánh (Switch) để xử lý từng loại.',
          '<strong class="text-foreground">Cách cấu hình AI</strong>: <strong class="text-foreground">Chọn trợ lý AI đã tạo</strong> (khuyên dùng - dùng luôn model, prompt, File kiến thức và sản phẩm đã ghim của trợ lý; trợ lý 9Router chỉ dùng được theo cách này) hoặc <strong class="text-foreground">Cài đặt thủ công</strong> (tự chọn nền tảng, model và nhập API key).',
          '<strong class="text-foreground">Chatbot trả lời 24/7</strong> (VD với Zalo): Khi nhận tin nhắn (bật Gom tin nhắn liên tiếp 10-15 giây) → Hiệu ứng đang gõ + chờ → Tạo nội dung bằng AI → Gửi tin nhắn với kết quả của node AI (nút Chèn biến). Câu trả lời của trợ lý được tách thành nhiều tin ngắn và có thể kèm ảnh sản phẩm nếu dữ liệu có link ảnh. Kho mẫu có sẵn <strong class="text-foreground">AI tư vấn bán hàng tự động</strong> và <strong class="text-foreground">AI phân loại &amp; tự động gắn nhãn</strong>.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><PluginIcon className="w-4 h-4 inline" /> Google Sheets, thông báo &amp; kết nối ngoài</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Google Sheets</strong>: Ghi thêm dòng mới, Đọc dữ liệu từ Sheet, Cập nhật ô trong Sheet - cần file Service Account JSON của Google Cloud và chia sẻ Sheet cho email ghi trong file đó.',
          '<strong class="text-foreground">Gửi thông báo</strong>: Gửi tin qua Telegram (chọn Bot đã kết nối ở <strong class="text-foreground">Công cụ → Tích hợp → Tin nhắn</strong>; để trống nội dung = dùng văn bản của node phía trước), Gửi tin vào Discord (Webhook URL), Gửi Email tự động (SMTP - Gmail cần App Password), Ghi vào Notion Database.',
          '<strong class="text-foreground">Đầu ra &amp; API</strong>: Gọi API bên ngoài (HTTP) - GET / POST / PUT / PATCH / DELETE tới API hoặc webhook của hệ thống khác; Ghi log gỡ lỗi - ghi dữ liệu giữa chừng vào Lịch sử chạy để kiểm tra.',
          '<strong class="text-foreground">POS / Bán hàng, Thanh toán, Vận chuyển</strong>: tra cứu khách hàng / đơn hàng / sản phẩm và tạo đơn trên KiotViet, Haravan, Sapo, Nhanh.vn, Pancake (Sapo có thêm tra tồn kho); lấy lịch sử giao dịch Casso / SePay; tạo đơn và tra vận đơn GHN, GHTK. Cần kết nối trước ở <strong class="text-foreground">Công cụ → Tích hợp</strong>. Ô SĐT mặc định là SĐT đã lưu của người nhắn (<code class="font-mono text-foreground">{{ $trigger.fromPhone }}</code>); trống (khách chưa lưu số) thì bước tra cứu không chạy và báo không tìm thấy, tránh trả lời bằng đơn của khách khác.',
          '<strong class="text-foreground">Khi nhận thanh toán</strong> không gắn với hội thoại nào (không biết ai chuyển) → gửi thông báo vào nơi chọn sẵn: nhóm Zalo nội bộ, Telegram, Google Sheets. Mẫu trong Kho mẫu → Tích hợp POS &amp; Thanh toán làm sẵn theo cách này.',
          '<strong class="text-foreground">Khi phần mềm bán hàng gửi webhook</strong> cũng không gắn với hội thoại: có SĐT khách (<code class="font-mono text-foreground">{{ $trigger.customerPhone }}</code>, cũng là <code class="font-mono text-foreground">{{ $trigger.fromPhone }}</code>) → “Tìm user bằng số điện thoại” rồi gửi tới user đó, hoặc báo nhóm nội bộ. Mã đơn, trạng thái, tổng tiền: <code class="font-mono text-foreground">{{ $trigger.code }}</code>, <code class="font-mono text-foreground">{{ $trigger.status }}</code>, <code class="font-mono text-foreground">{{ $trigger.total }}</code>; trường gốc: <code class="font-mono text-foreground">{{ $trigger.data.&lt;trường&gt; }}</code>.',
          '<strong class="text-foreground">Ứng dụng đã cài</strong> có thể thêm node riêng - hiện thành nhóm <strong class="text-foreground">Ứng dụng · ...</strong> trong bảng node.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><ClipboardListIcon className="w-4 h-4 inline" /> Lịch sử chạy, Kho mẫu &amp; quản lý</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Lịch sử chạy</strong> (thanh dưới sơ đồ, bấm để mở): 30 lần chạy gần nhất với trạng thái, thời lượng, nguồn kích hoạt. Mở từng lần để xem node nào thành công / lỗi / bị bỏ qua, thông báo lỗi, <strong class="text-foreground">Đầu vào</strong> và <strong class="text-foreground">Đầu ra</strong> của từng node.',
          'Thống kê lượt chạy, lỗi và tỷ lệ thành công ở <strong class="text-foreground">Báo cáo → Workflow</strong>.',
          '<strong class="text-foreground">Kho mẫu</strong>: lọc theo nhóm (Bán hàng &amp; CSKH, Marketing &amp; Tiếp thị, AI &amp; Thông minh, Tích hợp POS &amp; Thanh toán, Webhooks...) và theo kênh → <strong class="text-foreground">Xem trước</strong> → <strong class="text-foreground">Cài đặt</strong> (đặt tên, chọn tài khoản). Workflow cài từ mẫu ở trạng thái <strong class="text-foreground">TẮT</strong> để bạn kiểm tra trước.',
          'Danh sách workflow: tìm theo tên / mô tả, lọc theo tài khoản và kênh. Mỗi thẻ có công tắc bật/tắt, Chạy thử, Xuất JSON, Nhân bản sang tài khoản khác (workflow Zalo, Facebook), Chỉnh sửa, Xóa (xóa cả lịch sử chạy). Khi lọc đúng 1 tài khoản sẽ có nút <strong class="text-foreground">Clone tất cả</strong> để chép mọi workflow sang tài khoản khác.',
          '<strong class="text-foreground">Nhập JSON</strong> / <strong class="text-foreground">Xuất</strong> để sao lưu hoặc chia sẻ workflow giữa các máy.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><AlertIcon className="w-4 h-4 inline" /> Lưu ý khi dùng Workflow</SectionTitle>
        <BulletList items={[
          'Workflow chạy trên chính máy đang mở Deplao. Bấm ✕ chỉ ẩn app xuống khay hệ thống, workflow vẫn chạy; chọn <strong class="text-foreground">Thoát hoàn toàn</strong> ở biểu tượng khay hoặc tắt máy thì workflow dừng. Muốn chạy 24/7, để máy và app luôn bật, Internet ổn định.',
          'Workflow mới tạo, cài từ Kho mẫu hay nhập từ file đều ở trạng thái <strong class="text-foreground">Tắt</strong>. Luôn <strong class="text-foreground">Mô phỏng</strong> trước khi bật; nhớ rằng <strong class="text-foreground">Chạy thử</strong> là gửi tin thật.',
          'Chống spam: các node gửi tin Zalo xếp hàng theo từng tài khoản và giãn cách ngẫu nhiên giữa các lần gửi (node mới mặc định 1-3 giây, chỉnh ở <strong class="text-foreground">Giãn cách gửi tối thiểu / tối đa</strong>).',
          'Một node gửi cho nhiều người nhận (Zalo, Facebook) chờ ngẫu nhiên giữa từng người nhận: tối thiểu 5 giây, mặc định 5-10 giây (Giãn cách gửi đặt cao hơn thì theo khoảng đó); tin trả lời tự động của cùng tài khoản vẫn chen vào giữa đợt gửi. Tắt hoặc xoá workflow khi đang gửi thì các người nhận còn lại không được gửi. Gửi số lượng lớn vẫn nên dùng <strong class="text-foreground">CRM → Chiến dịch</strong> (tối thiểu 30 giây giữa hai liên hệ, giới hạn theo giờ và theo ngày).',
          'Dùng Chọn ngẫu nhiên 1 mục, Hiệu ứng đang gõ + chờ và Giới hạn tần suất để tin trả lời tự nhiên, không lặp lại liên tục.',
          'Sau khi khôi phục dữ liệu sang máy mới (<strong class="text-foreground">Cài đặt → Internet &amp; Đám mây</strong>), workflow tạm dừng cho tới khi bạn bấm <strong class="text-foreground">Bật lại tự động hoá</strong> - tránh hai máy cùng gửi.',
          'Hãy tuân thủ điều khoản của Zalo, Facebook, Telegram; không dùng workflow để gửi tin rác.',
        ]} />
      </Card>
    </div>
  );
}
