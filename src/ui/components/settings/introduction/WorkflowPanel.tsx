import React from 'react';
import {
  AlertIcon, BotIcon, ClipboardListIcon, FilterIcon, LightningIcon, PlayIcon, PluginIcon,
  SendIcon, SlidersIcon, SparklesIcon, TargetIcon,
} from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** A group of node names, written exactly as in the "Kéo node vào sơ đồ" (Drag nodes onto the canvas) table of the workflow editor. */
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

// List taken from the "Kích hoạt" (Triggers) / "Hành động" (Actions) groups of the node table (filtered by the workflow's channel).
const TRIGGERS: { title: string; items: string[] }[] = [
  { title: tr('Mọi kênh'), items: [tr('Chạy theo lịch hẹn'), tr('Chạy thủ công'), tr('Khi nhận thanh toán'), tr('Khi phần mềm bán hàng gửi webhook'), tr('Webhook bên ngoài'), tr('Khi API/ứng dụng gọi')] },
  { title: 'Zalo', items: [tr('Khi nhận tin nhắn'), tr('Khi có lời mời kết bạn'), tr('Khi có sự kiện nhóm'), tr('Khi có người react tin nhắn'), tr('Khi gán hoặc gỡ nhãn')] },
  {
    title: 'Facebook Messenger',
    items: [tr('Khi nhận tin nhắn'), tr('Khi nhận tin nhắn ảnh'), tr('Khi nhận tin nhắn video'), tr('Khi nhận tin nhắn file'), tr('Khi nhận sticker'), tr('Khi có reaction'), tr('Khi thu hồi tin nhắn'), tr('Khi có sự kiện nhóm')],
  },
  { title: tr('Telegram (Cá nhân)'), items: [tr('Khi nhận tin nhắn Telegram'), tr('Khi thu hồi tin nhắn Telegram'), tr('Sự kiện nhóm Telegram')] },
  {
    title: 'Telegram (Bot)',
    items: [tr('Khi Bot nhận tin nhắn'), tr('Khi user gửi lệnh cho Bot'), tr('Khi user nhấn nút Bot'), tr('Bot được thêm/gỡ nhóm'), tr('Khi tin nhắn Bot bị sửa'), tr('Khi có yêu cầu vào nhóm'), tr('Khi thành viên vào/rời nhóm')],
  },
];

const ACTIONS: { title: string; items: string[]; note?: string }[] = [
  {
    title: tr('Mọi kênh'),
    items: [tr('Chuyển tiếp đa kênh')],
    note: tr('Gửi lại tin gốc (chữ, ảnh, video, file đã tải về) sang Zalo, Facebook, Telegram User hoặc Telegram Bot.'),
  },
  {
    title: 'Zalo',
    items: [
      tr('Gửi tin nhắn'), tr('Hiệu ứng đang gõ + chờ'), tr('Gửi ảnh'), tr('Gửi file đính kèm'), tr('Tìm user bằng số điện thoại'),
      tr('Lấy thông tin người dùng'), tr('Chấp nhận lời mời kết bạn'), tr('Từ chối lời mời kết bạn'), tr('Gửi lời mời kết bạn'),
      tr('Thêm thành viên vào nhóm'), tr('Xóa thành viên khỏi nhóm'), tr('Tắt/bật thông báo'), tr('Chuyển tiếp tin nhắn'),
      tr('Thu hồi tin nhắn'), tr('Tạo bình chọn trong nhóm'), tr('Lấy lịch sử tin nhắn'), tr('Thêm cảm xúc vào tin nhắn'),
      tr('Gắn nhãn hội thoại'), tr('Gỡ nhãn hội thoại'), tr('Đổi tên gợi nhớ'),
    ],
  },
  {
    title: 'Facebook Messenger',
    items: [
      tr('Gửi tin nhắn'), tr('Gửi tệp đính kèm'), tr('Thả reaction'), tr('Thu hồi tin nhắn'), tr('Chỉnh sửa tin nhắn'), tr('Gửi lại nội dung'),
      tr('Ghim tin nhắn'), tr('Bỏ ghim tin nhắn'), tr('Tạo bình chọn'), tr('Hiệu ứng đang gõ'), tr('Đánh dấu đã đọc'), tr('Chặn người dùng'),
      tr('Đổi tên nhóm'), tr('Đổi biểu tượng nhóm'), tr('Đổi biệt danh thành viên'),
    ],
    note: tr('Gửi tệp đính kèm dùng cho ảnh, video, audio và file. Gửi lại nội dung chỉ gửi lại phần chữ - muốn chuyển cả media hãy dùng Chuyển tiếp đa kênh.'),
  },
  {
    title: tr('Telegram (Cá nhân)'),
    items: [
      tr('Gửi tin nhắn'), tr('Gửi ảnh'), tr('Gửi file đính kèm'), tr('Gửi sticker'), tr('Chuyển tiếp tin nhắn'), tr('Chỉnh sửa tin nhắn'),
      tr('Xóa tin nhắn'), tr('Ghim tin nhắn'), tr('Thả reaction'), tr('Tạo bình chọn'), tr('Hiệu ứng đang gõ'), tr('Đánh dấu đã đọc'),
      tr('Đánh dấu topic đã đọc'), tr('Chặn người dùng'), tr('Bỏ chặn người dùng'), tr('Thêm thành viên'), tr('Xóa thành viên'),
      tr('Cấm thành viên'), tr('Thăng quyền thành viên'), tr('Đổi tên nhóm'), tr('Rời nhóm'), tr('Lấy link mời'), tr('Tạo topic mới'),
    ],
  },
  {
    title: 'Telegram (Bot)',
    items: [
      tr('Gửi tin nhắn / Keyboard'), tr('Gửi ảnh'), tr('Gửi video'), tr('Gửi file đính kèm'), tr('Chuyển tiếp tin nhắn'), tr('Sửa tin nhắn'),
      tr('Xóa tin nhắn'), tr('Ghim tin nhắn'), tr('Bỏ ghim tin nhắn'), tr('Thả reaction'), tr('Tạo bình chọn'), tr('Hiển thị đang gõ'),
      tr('Cấm thành viên'), tr('Bỏ cấm thành viên'), tr('Hạn chế thành viên'), tr('Duyệt yêu cầu vào nhóm'), tr('Rời nhóm'),
    ],
    note: tr('Gửi tin nhắn / Keyboard: bật Thêm nút tương tác để gắn Reply Keyboard (bấm nút = gửi chữ trên nút như một tin nhắn mới) hoặc Inline Button (Đi đến node - chạy một nhánh khác trên sơ đồ, dây nét đứt; Callback tùy chỉnh; Mở liên kết). Thao tác trong nhóm cần Bot là admin có quyền phù hợp.'),
  },
];

export function WorkflowPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>{trx('<0/> Workflow tự động - không cần viết code', { 0: <LightningIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Workflow là kịch bản tự động dạng sơ đồ kéo-thả: một <0>Kích hoạt</0> (có tin nhắn, đến giờ hẹn, có webhook...) nối tới các bước <1>điều kiện, xử lý và hành động</1> (gửi tin, gắn nhãn, hỏi AI, ghi Google Sheets...). Workflow đang bật tự chạy nền mỗi khi có sự kiện, miễn là Deplao đang mở. Mở tại thanh bên <2>Công cụ → Workflow (n8n)</2> (hoặc nút <3>Tất cả tính năng</3> → Workflow).', { 0: <strong className="text-foreground font-semibold" />, 1: <strong className="text-foreground font-semibold" />, 2: <strong className="text-foreground font-semibold" />, 3: <strong className="text-foreground font-semibold" /> })}
        </Paragraph>
        <StepList steps={[
          {
            title: tr('Tạo workflow'),
            desc: tr('Bấm <strong class="text-foreground">Tạo workflow</strong> → chọn kênh <strong class="text-foreground">Zalo</strong>, <strong class="text-foreground">Facebook Messenger</strong>, <strong class="text-foreground">Telegram (Cá nhân)</strong> hoặc <strong class="text-foreground">Telegram (Bot)</strong>. Mỗi workflow dùng cho một kênh, bảng node chỉ hiện node hợp với kênh đó. Có thể bắt đầu từ <strong class="text-foreground">Kho mẫu</strong> hoặc <strong class="text-foreground">Nhập JSON</strong>.'),
          },
          {
            title: tr('Chọn tài khoản áp dụng'),
            desc: tr('Dùng ô tài khoản trên thanh công cụ của trình sửa. Không chọn tài khoản nào = workflow chạy cho <strong class="text-foreground">tất cả</strong> tài khoản của kênh đó.'),
          },
          {
            title: tr('Kéo thả và cấu hình node'),
            desc: tr('Kéo node từ bảng bên trái (có ô <strong class="text-foreground">Tìm node...</strong>) vào sơ đồ, nối các node bằng dây, bấm vào node để mở bảng cài đặt. Nút <strong class="text-foreground">Chèn biến</strong> đưa dữ liệu động vào nội dung: tên khách, nội dung tin, kết quả của bước trước...'),
          },
          {
            title: tr('Sắp xếp sơ đồ'),
            desc: tr('Bấm <strong class="text-foreground">Sắp xếp tự động</strong> để dàn node theo luồng (nút <strong class="text-foreground">Hoàn tác</strong> hiện khoảng 10 giây sau đó). Muốn xóa dây: chọn dây rồi bấm ✕ hoặc phím Del.'),
          },
          {
            title: tr('Lưu, thử rồi mới bật'),
            desc: tr('Bấm <strong class="text-foreground">Lưu</strong> → <strong class="text-foreground">Mô phỏng</strong> để xem kịch bản chạy ra sao mà không gửi tin thật → bật công tắc trên thẻ workflow ở danh sách (hoặc công tắc <strong class="text-foreground">Bật/Tắt</strong> trong trình sửa rồi bấm Lưu).'),
          },
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> AI copilot - tạo workflow bằng câu lệnh tiếng Việt', { 0: <SparklesIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Trong trình sửa, bấm nút <0>AI</0> để mở <1>Trợ lý thiết kế workflow</1>, rồi mô tả việc cần tự động hoá bằng lời thường. VD: “Khách nhắn hỏi giá thì AI trả lời tự động; khách muốn đặt hàng thì gắn nhãn Đặt hàng và báo cho tôi”.', { 0: <strong className="text-foreground font-semibold" />, 1: <strong className="text-foreground font-semibold" /> })}
        </Paragraph>
        <BulletList items={[
          tr('AI hỏi lại chỗ chưa rõ, tự tra cứu node, danh bạ và Nhãn Local thật của bạn, rồi đưa ra <strong class="text-foreground">bản đề xuất</strong> (v1, v2...) kèm xem trước node mới / sửa / giữ nguyên.'),
          tr('Bấm <strong class="text-foreground">Thêm vào kịch bản</strong>, <strong class="text-foreground">Áp dụng thay đổi</strong> hoặc <strong class="text-foreground">Thay thế kịch bản</strong> để đưa đề xuất lên sơ đồ; đề xuất còn lỗi thì bấm <strong class="text-foreground">Nhờ AI sửa</strong>. Sau khi áp dụng có nút <strong class="text-foreground">Hoàn tác AI</strong> (khoảng 30 giây) - nhớ bấm <strong class="text-foreground">Lưu</strong>.'),
          tr('Có thể nhờ AI giải thích hoặc rà lỗi workflow đang mở. Cuộc trò chuyện được giữ riêng cho từng workflow; bấm <strong class="text-foreground">Trò chuyện mới</strong> để bắt đầu lại.'),
          tr('Cần ít nhất một trợ lý AI đang bật (<strong class="text-foreground">Công cụ → Tích hợp → Trợ lý AI</strong>). Nên chọn trợ lý dùng model mạnh để đề xuất chính xác hơn.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Mô phỏng và Chạy thử', { 0: <PlayIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Mô phỏng</strong>: nhập tên khách và tin nhắn mẫu, bấm <strong class="text-foreground">Chạy mô phỏng</strong> → xem workflow trả lời gì trên khung điện thoại giả lập và đi nhánh nào (<strong class="text-foreground">Xem luồng chạy</strong>). <strong class="text-foreground">Không gửi tin thật, không gọi API / AI thật</strong> - bước AI chỉ trả về câu mẫu, phân loại AI luôn ra “khác”.'),
          tr('Mô phỏng chạy theo <strong class="text-foreground">bản đã lưu</strong> - sửa xong hãy bấm <strong class="text-foreground">Lưu</strong> trước khi mô phỏng.'),
          tr('<strong class="text-foreground">Chạy thử</strong> (trong trình sửa hoặc trên thẻ ở danh sách): chạy thật một lần ngay, các bước gửi tin sẽ <strong class="text-foreground">gửi thật</strong>. Workflow Zalo có bước gửi tin sẽ hỏi tài khoản gửi, nội dung tin thử và người nhận trong danh bạ.'),
          tr('Kích hoạt <strong class="text-foreground">Chạy thủ công</strong> dành cho workflow chỉ chạy khi bạn bấm Chạy thử.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Kích hoạt (Trigger) - workflow chạy khi nào?', { 0: <TargetIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Mỗi workflow bắt đầu từ một node trong nhóm <0>Kích hoạt</0>. Bảng node chỉ hiện kích hoạt của kênh đang dùng và các kích hoạt dùng chung:', { 0: <strong className="text-foreground font-semibold" /> })}
        </Paragraph>
        <div className="space-y-2">
          {TRIGGERS.map(group => <NodeChips key={group.title} title={group.title} items={group.items} />)}
        </div>
        <BulletList items={[
          tr('<strong class="text-foreground">Chạy theo lịch hẹn</strong>: chọn mẫu (8h sáng mỗi ngày, mỗi giờ, mỗi 30 phút, thứ Hai 8h, đầu tháng 8h, mỗi đêm 0h) hoặc tự nhập lịch cron; múi giờ mặc định Việt Nam.'),
          tr('<strong class="text-foreground">Khi gán hoặc gỡ nhãn</strong>: chọn chạy khi gán, khi gỡ hoặc cả hai; lọc theo Nhãn Local / nhãn Zalo và theo từng nhãn.'),
          tr('<strong class="text-foreground">Webhook bên ngoài</strong>: URL riêng được tạo khi bấm Lưu, có Secret Key (kiểm tra chữ ký) và giới hạn IP. <strong class="text-foreground">Khi nhận thanh toán</strong>: nhận giao dịch Casso / SePay đã kết nối ở Tích hợp, lọc số tiền tối thiểu và nội dung chuyển khoản. <strong class="text-foreground">Khi phần mềm bán hàng gửi webhook</strong>: KiotViet / Haravan / Sapo / Nhanh.vn / Pancake POS báo đơn hàng, khách hàng, sản phẩm, tồn kho — chỉ webhook xác thực đúng khoá đặt ở trang tích hợp; lọc theo phần mềm, loại dữ liệu, tên sự kiện, trạng thái. Muốn các loại này nhận dữ liệu từ Internet, bật địa chỉ ở <strong class="text-foreground">Cài đặt → Internet &amp; Cloud → Địa chỉ Internet</strong>.'),
          tr('<strong class="text-foreground">Khi API/ứng dụng gọi</strong>: phần mềm khác (qua Public API, quản lý ở <strong class="text-foreground">Công cụ → Ứng dụng, API &amp; Webhook</strong>) hoặc ứng dụng đã cài gửi sự kiện để kích hoạt workflow; lọc được theo tên sự kiện.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Bộ lọc của kích hoạt tin nhắn', { 0: <FilterIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>{tr('Bấm vào node kích hoạt tin nhắn để giới hạn khi nào workflow chạy:')}</Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Phạm vi</strong>: tất cả / chỉ tin cá nhân / chỉ tin nhóm (Telegram có thêm kênh và topic), chỉ một nhóm hoặc hội thoại cụ thể, <strong class="text-foreground">Chat / nhóm áp dụng</strong>: tất cả, chỉ các chat / nhóm đã chọn, hoặc trừ các chat / nhóm đã chọn.'),
          tr('<strong class="text-foreground">Người gửi</strong>: chỉ một người cụ thể, <strong class="text-foreground">Loại trừ người gửi</strong>, <strong class="text-foreground">Bỏ qua tin nhắn do mình gửi</strong> (bật sẵn, tránh workflow tự kích hoạt lại chính nó). Zalo có thêm <strong class="text-foreground">Vai trò người gửi trong nhóm</strong>: Trưởng nhóm, Phó nhóm, Trưởng + phó nhóm hoặc Thành viên thường.'),
          tr('<strong class="text-foreground">Nội dung</strong>: <strong class="text-foreground">Từ khóa kích hoạt</strong> (nhiều từ cách nhau bằng dấu phẩy, không phân biệt hoa / thường; chứa ít nhất 1 từ, chứa đủ tất cả, khớp nguyên câu, bắt đầu bằng...). Zalo có thêm <strong class="text-foreground">Loại tin nhắn</strong> (văn bản, hình ảnh, sticker, tệp, ghi âm, video, liên kết) và <strong class="text-foreground">Chỉ khi được @nhắc tên trong nhóm</strong> (tính cả @Tất cả).'),
          tr('<strong class="text-foreground">Thời gian &amp; tần suất</strong> (Zalo, Facebook, Telegram cá nhân): <strong class="text-foreground">Khung giờ hoạt động</strong> - chỉ chạy trong giờ hoặc ngoài giờ (VD tự trả lời ngoài giờ làm việc); <strong class="text-foreground">Giới hạn tần suất (phút)</strong> - mỗi hội thoại chạy tối đa 1 lần trong N phút, bộ đếm đặt lại khi khởi động lại app; <strong class="text-foreground">Gom tin nhắn liên tiếp</strong> - chờ N giây sau tin cuối rồi xử lý một lần (nên đặt 10-15 giây khi dùng AI trả lời).'),
          tr('<strong class="text-foreground">Telegram (Bot)</strong>: lọc theo nguồn chat, chat cụ thể, loại nội dung, từ khóa; có Giới hạn tần suất và Gom tin nhắn liên tiếp. <strong class="text-foreground">Bỏ qua lệnh /...</strong> (bật sẵn) để lệnh như /start chỉ chạy workflow <strong class="text-foreground">Khi user gửi lệnh cho Bot</strong>, khách không nhận 2 câu trả lời. Kích hoạt lệnh lọc được lệnh chính, lệnh thay thế, tham số và danh sách Telegram user ID được phép; phần khách gõ sau lệnh là <code class="font-mono text-foreground">{{ $trigger.args }}</code>.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Hành động theo kênh', { 0: <SendIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>
          {trx('Nhóm <0>Hành động</0> chỉ hiện node của kênh workflow đang dùng. Node gửi tin mặc định trả lời đúng hội thoại vừa kích hoạt; muốn gửi nơi khác thì chọn ở ô người nhận (VD <1>Gửi đến hội thoại</1>).', { 0: <strong className="text-foreground font-semibold" />, 1: <strong className="text-foreground font-semibold" /> })}
        </Paragraph>
        <div className="space-y-2">
          {ACTIONS.map(group => <NodeChips key={group.title} title={group.title} items={group.items} note={group.note} />)}
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Điều kiện, vòng lặp & dữ liệu - chạy thực tế ra sao', { 0: <SlidersIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <Paragraph>{tr('Các node dưới đây dùng được ở mọi kênh:')}</Paragraph>
        <BulletList items={[
          tr('<strong class="text-foreground">Rẽ nhánh Đúng/Sai (IF)</strong>: so sánh một giá trị (thường là nội dung tin): có chứa, chứa một trong các từ, không chứa, bằng, khác, là một trong các giá trị, bắt đầu / kết thúc bằng, lớn hơn / nhỏ hơn (số, giờ), rỗng, Regex → chạy nhánh <strong class="text-foreground">Đúng</strong> hoặc <strong class="text-foreground">Sai</strong>. <strong class="text-foreground">Là một trong các giá trị</strong> so nguyên giá trị với danh sách cách nhau dấu phẩy (VD Telegram ID nhân viên); danh sách trống thì không ai qua. Chứa một trong các từ, Là một trong các giá trị và Regex không phân biệt hoa / thường, các điều kiện khác có phân biệt.'),
          tr('<strong class="text-foreground">Phân nhiều nhánh (Switch)</strong>: so giá trị với từng nhánh, khớp chính xác trước, sau đó bỏ qua hoa / thường và dấu câu ở hai đầu ("Hỏi giá." vẫn vào nhánh "hỏi giá"); không khớp nhánh nào thì chạy nhánh mặc định. Hay đặt sau <strong class="text-foreground">Phân loại văn bản bằng AI</strong> - đặt giá trị các nhánh đúng tên danh mục.'),
          tr('<strong class="text-foreground">Tạm dừng chờ N giây</strong> (tối đa 5 phút mỗi lần chờ), <strong class="text-foreground">Lưu giá trị vào biến</strong> (dùng lại ở bước sau), <strong class="text-foreground">Dừng workflow nếu...</strong> (dừng ngay khi điều kiện đúng).'),
          tr('<strong class="text-foreground">Chọn đối tượng nhận tin</strong>: lấy danh sách người nhận từ Bạn bè (danh bạ Zalo), Thành viên nhóm Zalo, Hội thoại theo nhãn (Local) hoặc Liên hệ CRM - mặc định tối đa 500 người, có <strong class="text-foreground">Loại trừ người nhận</strong>. Nối sang node <strong class="text-foreground">Gửi tin nhắn</strong> (Zalo) và đặt ô <strong class="text-foreground">Danh sách hội thoại động (nâng cao)</strong> bằng kết quả của node này để gửi hàng loạt.'),
          tr('<strong class="text-foreground">Lặp qua danh sách</strong>: chọn một danh sách của bước trước (VD sản phẩm, đơn hàng tra được, tồn kho). Các bước nối từ cổng <strong class="text-foreground">Mỗi phần tử</strong> chạy lại cho từng phần tử (node mới mặc định tối đa 20, chỉnh được tới 100) với <code class="font-mono text-foreground">{{ $var.item }}</code>, một trường <code class="font-mono text-foreground">{{ $var.item.name }}</code>, số thứ tự <code class="font-mono text-foreground">{{ $var.itemIndex }}</code>; cổng <strong class="text-foreground">Xong</strong> chạy một lần sau khi lặp hết. Muốn gửi <strong class="text-foreground">một</strong> tin liệt kê: trong vòng lặp dùng Lưu giá trị vào biến để nối thêm dòng, rồi gửi biến đó ở nhánh Xong. Lịch sử chạy ghi từng lượt lặp. Gửi tin cho nhiều người vẫn nên dùng Chọn đối tượng nhận tin.'),
          tr('<strong class="text-foreground">Xử lý dữ liệu</strong>: Ghép nội dung văn bản, Chọn ngẫu nhiên 1 mục (tránh câu trả lời bị lặp), Định dạng ngày giờ, Đọc dữ liệu JSON.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> AI trong workflow', { 0: <BotIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Tạo nội dung bằng AI</strong>: sinh câu trả lời, tóm tắt, viết nội dung theo yêu cầu; có thể truyền lịch sử chat (VD kết quả node Lấy lịch sử tin nhắn) để AI nhớ ngữ cảnh.'),
          tr('<strong class="text-foreground">Phân loại văn bản bằng AI</strong>: AI xếp tin nhắn vào một trong các danh mục bạn liệt kê (VD: hỏi giá, đặt hàng, khiếu nại, khác) rồi trả về đúng tên danh mục, kể cả khi AI trả lời kèm dấu câu hay chữ hoa - nối tiếp Phân nhiều nhánh (Switch) để xử lý từng loại. Kết quả có thêm Khớp danh mục (true/false) để biết AI trả lời ngoài danh sách.'),
          tr('<strong class="text-foreground">Cách cấu hình AI</strong>: <strong class="text-foreground">Chọn trợ lý AI đã tạo</strong> (khuyên dùng - dùng luôn model, prompt, File kiến thức và sản phẩm đã ghim của trợ lý; trợ lý 9Router chỉ dùng được theo cách này) hoặc <strong class="text-foreground">Cài đặt thủ công</strong> (tự chọn nền tảng, model và nhập API key).'),
          tr('<strong class="text-foreground">Chatbot trả lời 24/7</strong> (VD với Zalo): Khi nhận tin nhắn (bật Gom tin nhắn liên tiếp 10-15 giây) → Hiệu ứng đang gõ + chờ → Tạo nội dung bằng AI → Gửi tin nhắn với kết quả của node AI (nút Chèn biến). Câu trả lời của trợ lý được tách thành nhiều tin ngắn và có thể kèm ảnh sản phẩm nếu dữ liệu có link ảnh. Kho mẫu có sẵn <strong class="text-foreground">AI tư vấn bán hàng tự động</strong> và <strong class="text-foreground">AI phân loại &amp; tự động gắn nhãn</strong>.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Google Sheets, thông báo & kết nối ngoài', { 0: <PluginIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Google Sheets</strong>: Ghi thêm dòng mới, Đọc dữ liệu từ Sheet, Cập nhật ô trong Sheet - cần file Service Account JSON của Google Cloud và chia sẻ Sheet cho email ghi trong file đó.'),
          tr('<strong class="text-foreground">Gửi thông báo</strong>: Gửi tin qua Telegram (chọn Bot đã thêm ở mục Tài khoản, hoặc Bot ở <strong class="text-foreground">Công cụ → Tích hợp → Tin nhắn</strong>; để trống nội dung = dùng văn bản của node phía trước), Gửi tin vào Discord (Webhook URL), Gửi Email tự động (SMTP - Gmail cần App Password; luôn kiểm tra chứng chỉ, chỉ tắt cho máy chủ mail nội bộ tự ký), Ghi vào Notion Database.'),
          tr('<strong class="text-foreground">Đầu ra &amp; API</strong>: Gọi API bên ngoài (HTTP) - GET / POST / PUT / PATCH / DELETE tới API hoặc webhook của hệ thống khác; Ghi log gỡ lỗi - ghi dữ liệu giữa chừng vào Lịch sử chạy để kiểm tra.'),
          tr('<strong class="text-foreground">POS / Bán hàng, Thanh toán, Vận chuyển</strong>: tra cứu khách hàng / đơn hàng / sản phẩm và tạo đơn trên KiotViet, Haravan, Sapo, Nhanh.vn, Pancake (Sapo có thêm tra tồn kho); lấy lịch sử giao dịch Casso / SePay; tạo đơn và tra vận đơn GHN, GHTK. Cần kết nối trước ở <strong class="text-foreground">Công cụ → Tích hợp</strong>. Ô SĐT mặc định là SĐT đã lưu của người nhắn (<code class="font-mono text-foreground">{{ $trigger.fromPhone }}</code>); trống (khách chưa lưu số) thì bước tra cứu không chạy và báo không tìm thấy, tránh trả lời bằng đơn của khách khác.'),
          tr('<strong class="text-foreground">Khi nhận thanh toán</strong> không gắn với hội thoại nào (không biết ai chuyển) → gửi thông báo vào nơi chọn sẵn: nhóm Zalo nội bộ, Telegram, Google Sheets. Mẫu trong Kho mẫu → Tích hợp POS &amp; Thanh toán làm sẵn theo cách này.'),
          tr('<strong class="text-foreground">Khi phần mềm bán hàng gửi webhook</strong> cũng không gắn với hội thoại: có SĐT khách (<code class="font-mono text-foreground">{{ $trigger.customerPhone }}</code>, cũng là <code class="font-mono text-foreground">{{ $trigger.fromPhone }}</code>) → “Tìm user bằng số điện thoại” rồi gửi tới user đó, hoặc báo nhóm nội bộ. Mã đơn, trạng thái, tổng tiền: <code class="font-mono text-foreground">{{ $trigger.code }}</code>, <code class="font-mono text-foreground">{{ $trigger.status }}</code>, <code class="font-mono text-foreground">{{ $trigger.total }}</code>; trường gốc: <code class="font-mono text-foreground">{{ $trigger.data.&lt;trường&gt; }}</code>.'),
          tr('<strong class="text-foreground">Ứng dụng đã cài</strong> có thể thêm node riêng - hiện thành nhóm <strong class="text-foreground">Ứng dụng · ...</strong> trong bảng node.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Lịch sử chạy, Kho mẫu & quản lý', { 0: <ClipboardListIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Lịch sử chạy</strong> (thanh dưới sơ đồ, bấm để mở): 30 lần chạy gần nhất với trạng thái, thời lượng, nguồn kích hoạt. Mở từng lần để xem node nào thành công / lỗi / bị bỏ qua, thông báo lỗi, <strong class="text-foreground">Đầu vào</strong> và <strong class="text-foreground">Đầu ra</strong> của từng node.'),
          tr('Thống kê lượt chạy, lỗi và tỷ lệ thành công ở <strong class="text-foreground">Báo cáo → Workflow</strong>.'),
          tr('<strong class="text-foreground">Kho mẫu</strong>: lọc theo nhóm (Bán hàng &amp; CSKH, Marketing &amp; Tiếp thị, AI &amp; Thông minh, Tích hợp POS &amp; Thanh toán, Webhooks...) và theo kênh (Zalo, Facebook, Telegram, Telegram Bot) → <strong class="text-foreground">Xem trước</strong> → <strong class="text-foreground">Cài đặt</strong> (đặt tên, chọn tài khoản đúng kênh của mẫu). Workflow cài từ mẫu ở trạng thái <strong class="text-foreground">TẮT</strong> để bạn kiểm tra trước.'),
          tr('Mẫu <strong class="text-foreground">Telegram Bot</strong>: menu /start, tin có nút inline, trợ lý AI chat riêng, chuyển tin khách vào nhóm nhân viên, /vandon tra vận đơn GHN, nhân viên tra đơn KiotViet bằng /donhang, chào thành viên mới, tự duyệt người xin vào nhóm, chặn link spam, báo tiền về / đơn mới vào nhóm, đăng tin và bình chọn theo lịch. Mẫu cần nhóm nhận thì chọn nhóm ở bước gửi tin; bước "điền Telegram ID" chưa cho ai qua cho tới khi bạn điền.'),
          tr('Danh sách workflow: tìm theo tên / mô tả, lọc theo tài khoản và kênh. Mỗi thẻ có công tắc bật/tắt, Chạy thử, Xuất JSON, Nhân bản sang tài khoản khác (workflow Zalo, Facebook), Chỉnh sửa, Xóa (xóa cả lịch sử chạy). Khi lọc đúng 1 tài khoản sẽ có nút <strong class="text-foreground">Clone tất cả</strong> để chép mọi workflow sang tài khoản khác.'),
          tr('<strong class="text-foreground">Nhập JSON</strong> / <strong class="text-foreground">Xuất</strong> để sao lưu hoặc chia sẻ workflow giữa các máy.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Lưu ý khi dùng Workflow', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Workflow chạy trên chính máy đang mở Deplao. Bấm ✕ chỉ ẩn app xuống khay hệ thống, workflow vẫn chạy; chọn <strong class="text-foreground">Thoát hoàn toàn</strong> ở biểu tượng khay hoặc tắt máy thì workflow dừng. Muốn chạy 24/7, để máy và app luôn bật, Internet ổn định.'),
          tr('Workflow mới tạo, cài từ Kho mẫu hay nhập từ file đều ở trạng thái <strong class="text-foreground">Tắt</strong>. Luôn <strong class="text-foreground">Mô phỏng</strong> trước khi bật; nhớ rằng <strong class="text-foreground">Chạy thử</strong> là gửi tin thật.'),
          tr('Workflow áp dụng cho nhiều tài khoản trả lời bằng đúng tài khoản nhận tin. Tài khoản của workflow mất kết nối thì node báo lỗi, không tự gửi bằng tài khoản khác. Node gửi lỗi (VD khách đã chặn Bot) được ghi lỗi trong Lịch sử chạy và dừng workflow, trừ khi bật <strong class="text-foreground">Tiếp tục workflow dù gửi thất bại</strong>.'),
          tr('Chống spam: các node gửi tin Zalo xếp hàng theo từng tài khoản và giãn cách ngẫu nhiên giữa các lần gửi (node mới mặc định 1-3 giây, chỉnh ở <strong class="text-foreground">Giãn cách gửi tối thiểu / tối đa</strong>).'),
          tr('Một node gửi cho nhiều người nhận (Zalo, Facebook) chờ ngẫu nhiên giữa từng người nhận: tối thiểu 5 giây, mặc định 5-10 giây (Giãn cách gửi đặt cao hơn thì theo khoảng đó); tin trả lời tự động của cùng tài khoản vẫn chen vào giữa đợt gửi. Tắt hoặc xoá workflow khi đang gửi thì các người nhận còn lại không được gửi. Gửi số lượng lớn vẫn nên dùng <strong class="text-foreground">CRM → Chiến dịch</strong> (tối thiểu 30 giây giữa hai liên hệ, giới hạn theo giờ và theo ngày).'),
          tr('Dùng Chọn ngẫu nhiên 1 mục, Hiệu ứng đang gõ + chờ và Giới hạn tần suất để tin trả lời tự nhiên, không lặp lại liên tục.'),
          tr('Sau khi khôi phục dữ liệu sang máy mới (<strong class="text-foreground">Cài đặt → Internet &amp; Cloud</strong>), workflow tạm dừng cho tới khi bạn bấm <strong class="text-foreground">Bật lại tự động hoá</strong> - tránh hai máy cùng gửi.'),
          tr('Hãy tuân thủ điều khoản của Zalo, Facebook, Telegram; không dùng workflow để gửi tin rác.'),
        ]} />
      </Card>
    </div>
  );
}
