// Node type configurations: default configs, labels, descriptions
import { CHANNEL } from '@/lib/channelHelper';

type ChannelTag = 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot' | 'both';
type NodeGroupItem = { type: string; label: string; desc: string; channel?: ChannelTag };
type NodeGroup = { label: string; color: string; items: NodeGroupItem[] };

export const NODE_GROUPS: NodeGroup[] = [
  {
    label: 'Kích hoạt',
    color: 'bg-violet-500',
    items: [
      // Zalo triggers
      { type: 'trigger.message',        label: 'Khi nhận tin nhắn',             desc: 'Kích hoạt khi có tin nhắn mới (cá nhân hoặc nhóm) - Zalo', channel: CHANNEL.ZALO },
      { type: 'trigger.friendRequest', label: 'Khi có lời mời kết bạn',      desc: 'Kích hoạt khi ai đó gửi lời mời kết bạn đến bạn', channel: CHANNEL.ZALO },
      { type: 'trigger.groupEvent',    label: 'Khi có sự kiện nhóm',         desc: 'Kích hoạt khi thành viên vào/rời nhóm, thay đổi admin...', channel: CHANNEL.ZALO },
      { type: 'trigger.reaction',      label: 'Khi có người react tin nhắn', desc: 'Kích hoạt khi ai đó thả cảm xúc vào tin nhắn', channel: CHANNEL.ZALO },
      { type: 'trigger.labelAssigned', label: 'Khi gán hoặc gỡ nhãn',       desc: 'Kích hoạt khi Nhãn Local/Zalo được gán hoặc gỡ khỏi hội thoại', channel: CHANNEL.ZALO },
      { type: 'trigger.schedule',      label: 'Chạy theo lịch hẹn',          desc: 'Tự động kích hoạt theo lịch (hàng ngày, hàng giờ...)', channel: 'both' },
      { type: 'trigger.manual',        label: 'Chạy thủ công',               desc: 'Kích hoạt bằng tay từ giao diện, dùng để test workflow', channel: 'both' },
      { type: 'trigger.payment',       label: 'Khi nhận thanh toán',         desc: 'Kích hoạt khi nhận webhook thanh toán từ Casso / SePay (VietQR)', channel: 'both' },
      { type: 'trigger.webhook',       label: 'Webhook bên ngoài',           desc: 'Kích hoạt khi nhận dữ liệu từ webhook bên thứ 3 gửi sang', channel: 'both' },
      // Telegram triggers (the legacy `trigger.telegramCommand` integration is
      // intentionally not shown here; native Telegram Bot workflows use the
      // dedicated Bot triggers below).
      { type: 'tg.trigger.message',    label: 'Khi nhận tin nhắn Telegram',  desc: 'Kích hoạt khi có tin nhắn mới trên Telegram (cá nhân hoặc nhóm)', channel: 'telegram_user' },
      { type: 'tg.trigger.unsend',     label: 'Khi thu hồi tin nhắn Telegram', desc: 'Kích hoạt khi tin nhắn bị thu hồi trên Telegram', channel: 'telegram_user' },
      { type: 'tg.trigger.groupEvent', label: 'Sự kiện nhóm Telegram',       desc: 'Kích hoạt khi thành viên vào/rời nhóm Telegram', channel: 'telegram_user' },
      // Telegram Bot triggers belong with every other workflow entry point.
      // Keep the Bot group below action-only, otherwise users can mistake an
      // event node for an action that sends something.
      { type: 'tgbot.trigger.message',   label: 'Khi Bot nhận tin nhắn',      desc: 'Kích hoạt khi Bot nhận tin mới; có thể lọc chat, nội dung và người gửi', channel: 'telegram_bot' },
      { type: 'tgbot.trigger.command',   label: 'Khi user gửi lệnh cho Bot',  desc: 'Kích hoạt khi nhận /command; có thể lọc lệnh, tham số và quyền user', channel: 'telegram_bot' },
      { type: 'tgbot.trigger.callback',  label: 'Khi user nhấn nút Bot',     desc: 'Kích hoạt khi user nhấn Inline Button tùy chỉnh', channel: 'telegram_bot' },
      { type: 'tgbot.trigger.join',      label: 'Bot được thêm/gỡ nhóm',     desc: 'Kích hoạt khi trạng thái hoặc quyền của chính Bot trong nhóm thay đổi', channel: 'telegram_bot' },
      { type: 'tgbot.trigger.editedMessage', label: 'Khi tin nhắn Bot bị sửa', desc: 'Kích hoạt khi user sửa tin nhắn trong chat Bot nhận được', channel: 'telegram_bot' },
      { type: 'tgbot.trigger.joinRequest', label: 'Khi có yêu cầu vào nhóm', desc: 'Kích hoạt khi user gửi join request tới nhóm có Bot admin', channel: 'telegram_bot' },
      // Facebook triggers
      { type: 'fb.trigger.message',    label: 'Khi nhận tin nhắn',           desc: 'Kích hoạt khi có tin nhắn mới trên Facebook Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.image',      label: 'Khi nhận tin nhắn ảnh',       desc: 'Kích hoạt khi nhận được tin nhắn chứa ảnh trên Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.video',      label: 'Khi nhận tin nhắn video',     desc: 'Kích hoạt khi nhận được tin nhắn video trên Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.file',       label: 'Khi nhận tin nhắn file',      desc: 'Kích hoạt khi nhận được tin nhắn file trên Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.sticker',    label: 'Khi nhận sticker',             desc: 'Kích hoạt khi nhận được sticker trên Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.reaction',   label: 'Khi có reaction',             desc: 'Kích hoạt khi ai đó thả cảm xúc vào tin nhắn Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.unsend',     label: 'Khi thu hồi tin nhắn',        desc: 'Kích hoạt khi ai đó thu hồi tin nhắn trên Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.groupEvent', label: 'Khi có sự kiện nhóm',         desc: 'Kích hoạt khi thành viên vào/rời nhóm Facebook', channel: CHANNEL.FACEBOOK },
    ],
  },
  {
    label: 'Hành động',
    color: 'bg-blue-600',
    items: [
      { type: 'action.forwardCrossChannel', label: 'Chuyển tiếp đa kênh',    desc: 'Gửi lại tin gốc sang Zalo, Facebook, Telegram User hoặc Telegram Bot', channel: 'both' },
      { type: 'fb.action.sendMessage',    label: 'Gửi tin nhắn',              desc: 'Gửi tin nhắn văn bản đến hội thoại Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.sendImage',      label: 'Gửi tệp đính kèm',          desc: 'Gửi ảnh, video, audio hoặc file vào hội thoại Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.addReaction',    label: 'Thả reaction',               desc: 'Thả emoji reaction vào tin nhắn Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.unsend',         label: 'Thu hồi tin nhắn',          desc: 'Thu hồi tin nhắn đã gửi trên Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.editMessage',    label: 'Chỉnh sửa tin nhắn',        desc: 'Chỉnh sửa nội dung tin nhắn đã gửi', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.forward',        label: 'Gửi lại nội dung',          desc: 'Gửi lại văn bản; dùng Chuyển tiếp đa kênh để chuyển cả media', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.pin',            label: 'Ghim tin nhắn',             desc: 'Ghim tin nhắn trong hội thoại Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.unpin',          label: 'Bỏ ghim tin nhắn',          desc: 'Bỏ ghim tin nhắn trong hội thoại Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.createPoll',     label: 'Tạo bình chọn',             desc: 'Tạo cuộc bình chọn trong nhóm Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.sendTyping',     label: 'Hiệu ứng đang gõ',          desc: 'Hiển thị trạng thái đang gõ trên Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.markAsRead',     label: 'Đánh dấu đã đọc',           desc: 'Đánh dấu hội thoại Facebook đã đọc', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.block',          label: 'Chặn người dùng',           desc: 'Chặn người dùng trên Facebook Messenger', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.changeName',     label: 'Đổi tên nhóm',              desc: 'Đổi tên nhóm Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.changeEmoji',    label: 'Đổi biểu tượng nhóm',       desc: 'Đổi emoji đại diện cho nhóm Facebook', channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.changeNickname', label: 'Đổi biệt danh thành viên',  desc: 'Đổi nickname của thành viên trong nhóm Facebook', channel: CHANNEL.FACEBOOK },
      // Telegram User actions
      { type: 'tg.sendMessage',     label: 'Gửi tin nhắn',              desc: 'Gửi tin nhắn văn bản đến hội thoại Telegram', channel: 'telegram_user' },
      { type: 'tg.sendPhoto',       label: 'Gửi ảnh',                   desc: 'Chọn ảnh từ máy tính để gửi đến hội thoại Telegram', channel: 'telegram_user' },
      { type: 'tg.sendFile',        label: 'Gửi file đính kèm',         desc: 'Gửi file (PDF, Excel, ...) đến hội thoại Telegram', channel: 'telegram_user' },
      { type: 'tg.forwardMessage',  label: 'Chuyển tiếp tin nhắn',      desc: 'Chuyển tiếp tin nhắn sang hội thoại Telegram khác', channel: 'telegram_user' },
      { type: 'tg.deleteMessage',   label: 'Xóa tin nhắn',              desc: 'Xóa tin nhắn trong hội thoại Telegram', channel: 'telegram_user' },
      { type: 'tg.editMessage',     label: 'Chỉnh sửa tin nhắn',        desc: 'Chỉnh sửa nội dung tin nhắn đã gửi trên Telegram', channel: 'telegram_user' },
      { type: 'tg.addReaction',     label: 'Thả reaction',              desc: 'Thả emoji reaction vào tin nhắn Telegram', channel: 'telegram_user' },
      { type: 'tg.pinMessage',      label: 'Ghim tin nhắn',             desc: 'Ghim tin nhắn trong hội thoại Telegram', channel: 'telegram_user' },
      { type: 'tg.sendPoll',        label: 'Tạo bình chọn',             desc: 'Tạo cuộc bình chọn (poll) trong nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.sendSticker',     label: 'Gửi sticker',               desc: 'Gửi sticker từ sticker set đến hội thoại Telegram', channel: 'telegram_user' },
      { type: 'tg.sendTyping',      label: 'Hiệu ứng đang gõ',         desc: 'Hiển thị trạng thái đang gõ trên Telegram', channel: 'telegram_user' },
      { type: 'tg.banMember',       label: 'Khỏi thành viên',           desc: 'Khỏi (ban) thành viên khỏi nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.promoteMember',   label: 'Thăng quyền thành viên',    desc: 'Thăng/hạ quyền admin cho thành viên trong nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.addMember',       label: 'Thêm thành viên',           desc: 'Thêm thành viên vào nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.removeMember',    label: 'Xóa thành viên',            desc: 'Xóa thành viên khỏi nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.markAsRead',      label: 'Đánh dấu đã đọc',          desc: 'Đánh dấu tin nhắn đã đọc trong hội thoại Telegram', channel: 'telegram_user' },
      { type: 'tg.markTopicAsRead', label: 'Đánh dấu topic đã đọc',   desc: 'Đánh dấu forum topic đã đọc trong nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.blockUser',       label: 'Chặn người dùng',          desc: 'Chặn người dùng trên Telegram', channel: 'telegram_user' },
      { type: 'tg.unblockUser',     label: 'Bỏ chặn người dùng',       desc: 'Bỏ chặn người dùng trên Telegram', channel: 'telegram_user' },
      { type: 'tg.changeGroupName', label: 'Đổi tên nhóm',             desc: 'Đổi tên nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.leaveGroup',      label: 'Rời nhóm',                 desc: 'Rời khỏi nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.exportInviteLink', label: 'Lấy link mời',             desc: 'Lấy link邀请 tham gia nhóm Telegram', channel: 'telegram_user' },
      { type: 'tg.createForumTopic', label: 'Tạo topic mới',            desc: 'Tạo topic mới trong nhóm Telegram Forum', channel: 'telegram_user' },
      // Telegram Bot actions
      { type: 'tgbot.action.sendMessage', label: 'Gửi tin nhắn / Keyboard', desc: 'Gửi text, Reply Keyboard hoặc Inline Button từ Bot', channel: 'telegram_bot' },
      { type: 'tgbot.action.sendPhoto',   label: 'Gửi ảnh',                  desc: 'Chọn ảnh từ máy tính, kèm chú thích tùy chọn', channel: 'telegram_bot' },
      { type: 'tgbot.action.sendVideo',   label: 'Gửi video',                desc: 'Chọn video từ máy tính để gửi', channel: 'telegram_bot' },
      { type: 'tgbot.action.sendFile',    label: 'Gửi file đính kèm',        desc: 'Gửi tài liệu, PDF hoặc file khác', channel: 'telegram_bot' },
      { type: 'tgbot.action.forward',     label: 'Chuyển tiếp tin nhắn',     desc: 'Chuyển tiếp một tin từ chat nguồn sang chat khác', channel: 'telegram_bot' },
      { type: 'tgbot.action.editMessage', label: 'Sửa tin nhắn',             desc: 'Sửa nội dung tin Bot đã gửi', channel: 'telegram_bot' },
      { type: 'tgbot.action.deleteMessage', label: 'Xóa tin nhắn',           desc: 'Xóa tin nhắn; Bot cần quyền phù hợp trong nhóm', channel: 'telegram_bot' },
      { type: 'tgbot.action.pinMessage',  label: 'Ghim tin nhắn',            desc: 'Ghim tin nhắn; chỉ chạy khi Bot có quyền ghim', channel: 'telegram_bot' },
      { type: 'tgbot.action.unpinMessage', label: 'Bỏ ghim tin nhắn',        desc: 'Bỏ ghim một tin hoặc tin đang ghim', channel: 'telegram_bot' },
      { type: 'tgbot.action.addReaction', label: 'Thả reaction',             desc: 'Thả emoji vào một tin nhắn nếu chat cho phép', channel: 'telegram_bot' },
      { type: 'tgbot.action.sendPoll',    label: 'Tạo bình chọn',            desc: 'Gửi poll không ẩn danh vào chat', channel: 'telegram_bot' },
      { type: 'tgbot.action.sendChatAction', label: 'Hiển thị đang gõ',      desc: 'Hiển thị typing/uploading trong lúc Bot xử lý', channel: 'telegram_bot' },
      { type: 'tgbot.action.banMember',   label: 'Cấm thành viên',           desc: 'Cấm user khỏi nhóm; Bot phải là admin có quyền hạn chế', channel: 'telegram_bot' },
      { type: 'tgbot.action.restrictMember', label: 'Hạn chế thành viên',    desc: 'Mute hoặc giới hạn quyền gửi tin của thành viên', channel: 'telegram_bot' },
      // Zalo actions
      { type: 'zalo.sendMessage',        label: 'Gửi tin nhắn',               desc: 'Gửi tin nhắn văn bản đến hội thoại', channel: CHANNEL.ZALO },
      { type: 'zalo.sendTyping',         label: 'Hiệu ứng đang gõ + chờ',    desc: 'Hiển thị "đang gõ..." rồi chờ vài giây trước bước tiếp', channel: CHANNEL.ZALO },
      { type: 'zalo.sendImage',          label: 'Gửi ảnh',                    desc: 'Chọn ảnh từ máy tính để gửi', channel: CHANNEL.ZALO },
      { type: 'zalo.sendFile',           label: 'Gửi file đính kèm',          desc: 'Gửi file (PDF, Excel, ...) đến hội thoại', channel: CHANNEL.ZALO },
      { type: 'zalo.findUser',           label: 'Tìm user bằng số điện thoại',desc: 'Tra cứu tài khoản Zalo theo SĐT để lấy User ID', channel: CHANNEL.ZALO },
      { type: 'zalo.getUserInfo',        label: 'Lấy thông tin người dùng',   desc: 'Lấy tên, avatar, giới tính... từ User ID Zalo', channel: CHANNEL.ZALO },
      { type: 'zalo.acceptFriendRequest',label: 'Chấp nhận lời mời kết bạn',  desc: 'Tự động chấp nhận lời mời kết bạn từ người dùng', channel: CHANNEL.ZALO },
      { type: 'zalo.rejectFriendRequest',label: 'Từ chối lời mời kết bạn',    desc: 'Tự động từ chối lời mời kết bạn', channel: CHANNEL.ZALO },
      { type: 'zalo.sendFriendRequest',  label: 'Gửi lời mời kết bạn',       desc: 'Chủ động gửi lời mời kết bạn đến User ID', channel: CHANNEL.ZALO },
      { type: 'zalo.addToGroup',         label: 'Thêm thành viên vào nhóm',   desc: 'Thêm user vào một nhóm Zalo cụ thể', channel: CHANNEL.ZALO },
      { type: 'zalo.removeFromGroup',    label: 'Xóa thành viên khỏi nhóm',   desc: 'Xóa user ra khỏi nhóm Zalo', channel: CHANNEL.ZALO },
      { type: 'zalo.setMute',            label: 'Tắt/bật thông báo',          desc: 'Tắt hoặc bật lại thông báo cho hội thoại', channel: CHANNEL.ZALO },
      { type: 'zalo.forwardMessage',     label: 'Chuyển tiếp tin nhắn',       desc: 'Chuyển tiếp tin nhắn sang hội thoại khác', channel: CHANNEL.ZALO },
      { type: 'zalo.undoMessage',        label: 'Thu hồi tin nhắn',           desc: 'Thu hồi (xóa 2 phía) một tin nhắn đã gửi', channel: CHANNEL.ZALO },
      { type: 'zalo.createPoll',         label: 'Tạo bình chọn trong nhóm',   desc: 'Tạo cuộc bình chọn (poll) trong nhóm Zalo', channel: CHANNEL.ZALO },
      { type: 'zalo.getMessageHistory',  label: 'Lấy lịch sử tin nhắn',       desc: 'Lấy N tin nhắn gần nhất từ hội thoại', channel: CHANNEL.ZALO },
      { type: 'zalo.addReaction',        label: 'Thêm cảm xúc vào tin nhắn',  desc: 'Thả like, yêu thích, haha... vào tin nhắn', channel: CHANNEL.ZALO },
      { type: 'zalo.assignLabel',        label: 'Gắn nhãn hội thoại',         desc: 'Gắn Nhãn Local hoặc Zalo cho hội thoại', channel: CHANNEL.ZALO },
      { type: 'zalo.removeLabel',        label: 'Gỡ nhãn hội thoại',          desc: 'Gỡ Nhãn Local hoặc Zalo khỏi hội thoại', channel: CHANNEL.ZALO },
      { type: 'zalo.changeAliasName',    label: 'Đổi tên gợi nhớ',           desc: 'Đổi tên gợi nhớ (biệt danh) cho bạn bè trong danh bạ Zalo', channel: CHANNEL.ZALO },
    ],
  },
  {
    label: 'Điều kiện & Logic',
    color: 'bg-amber-500',
    items: [
      { type: 'logic.if',          label: 'Rẽ nhánh Đúng/Sai (IF)',  desc: 'Kiểm tra điều kiện rồi chạy nhánh Đúng hoặc Sai' },
      { type: 'logic.switch',      label: 'Phân nhiều nhánh (Switch)',desc: 'So sánh giá trị với nhiều trường hợp rồi chạy nhánh tương ứng' },
      { type: 'logic.wait',        label: 'Tạm dừng chờ N giây',     desc: 'Dừng workflow trong vài giây trước khi tiếp tục' },
      { type: 'logic.setVariable', label: 'Lưu giá trị vào biến',    desc: 'Lưu dữ liệu để dùng ở các bước sau (VD: tên, số điện thoại...)' },
      { type: 'logic.stopIf',      label: 'Dừng workflow nếu...',     desc: 'Dừng toàn bộ workflow nếu điều kiện đúng' },
      { type: 'logic.forEach',     label: 'Lặp qua danh sách',       desc: 'Lặp từng phần tử trong mảng dữ liệu và chạy bước tiếp cho mỗi phần tử' },
    ],
  },
  {
    label: 'Xử lý dữ liệu',
    color: 'bg-teal-500',
    items: [
      { type: 'data.textFormat',  label: 'Ghép nội dung văn bản',   desc: 'Soạn nội dung bằng mẫu với biến động (VD: tên, ngày...)' },
      { type: 'data.randomPick',  label: 'Chọn ngẫu nhiên 1 mục',   desc: 'Chọn random 1 nội dung từ danh sách, tránh câu trả lời bị lặp' },
      { type: 'data.dateFormat',  label: 'Định dạng ngày giờ',       desc: 'Chuyển đổi ngày/giờ sang định dạng dễ đọc (VD: 25/03/2026)' },
      { type: 'data.jsonParse',   label: 'Đọc dữ liệu JSON',        desc: 'Chuyển chuỗi JSON thành object để đọc các trường bên trong' },
    ],
  },
  {
    label: 'Google Sheets',
    color: 'bg-green-600',
    items: [
      { type: 'sheets.appendRow',   label: 'Ghi thêm dòng mới',      desc: 'Thêm 1 hàng dữ liệu mới vào cuối bảng tính Google Sheets' },
      { type: 'sheets.readValues',  label: 'Đọc dữ liệu từ Sheet',   desc: 'Đọc giá trị các ô từ Google Sheets để dùng ở bước sau' },
      { type: 'sheets.updateCell',  label: 'Cập nhật ô trong Sheet',  desc: 'Ghi đè giá trị vào một ô cụ thể trong bảng tính' },
    ],
  },
  {
    label: 'Trí tuệ nhân tạo (AI)',
    color: 'bg-violet-600',
    items: [
      { type: 'ai.generateText', label: 'Tạo nội dung bằng AI',   desc: 'Dùng ChatGPT, Gemini, Deepseek, Grok... để sinh câu trả lời' },
      { type: 'ai.classify',     label: 'Phân loại văn bản bằng AI',desc: 'AI tự phân loại tin nhắn vào danh mục (hỏi giá, khiếu nại...)' },
    ],
  },
  {
    label: 'Gửi thông báo',
    color: 'bg-orange-500',
    items: [
      { type: 'notify.telegram', label: 'Gửi tin qua Telegram',     desc: 'Gửi thông báo đến Telegram Bot khi có sự kiện mới' },
      { type: 'notify.discord',  label: 'Gửi tin vào Discord',      desc: 'Gửi thông báo vào kênh Discord qua Webhook' },
      { type: 'notify.email',    label: 'Gửi Email tự động',        desc: 'Gửi email qua SMTP (Gmail, Outlook...) khi có sự kiện' },
      { type: 'notify.notion',   label: 'Ghi vào Notion Database',  desc: 'Tự động tạo trang mới trong Notion Database' },
    ],
  },
  {
    label: 'Đầu ra & API',
    color: 'bg-rose-500',
    items: [
      { type: 'output.httpRequest', label: 'Gọi API bên ngoài (HTTP)',desc: 'Gửi request HTTP đến API / webhook bên ngoài' },
      { type: 'output.log',         label: 'Ghi log gỡ lỗi',         desc: 'Ghi nội dung vào lịch sử chạy để debug, kiểm tra dữ liệu' },
    ],
  },
  {
    label: 'POS / Bán hàng',
    color: 'bg-orange-600',
    items: [
      { type: 'kiotviet.lookupCustomer', label: 'KiotViet: Tra cứu khách hàng', desc: 'Tìm thông tin khách hàng KiotViet theo số điện thoại' },
      { type: 'kiotviet.lookupOrder',    label: 'KiotViet: Tra cứu đơn hàng',   desc: 'Tìm đơn hàng KiotViet theo mã đơn hoặc SĐT' },
      { type: 'kiotviet.lookupProduct',  label: 'KiotViet: Tra cứu sản phẩm',   desc: 'Tìm sản phẩm KiotViet theo tên hoặc mã SKU' },
      { type: 'kiotviet.createOrder',    label: 'KiotViet: Tạo đơn hàng',       desc: 'Tạo đơn hàng mới trong KiotViet' },
      { type: 'haravan.lookupCustomer',  label: 'Haravan: Tra cứu khách hàng',  desc: 'Tìm thông tin khách hàng Haravan theo số điện thoại' },
      { type: 'haravan.lookupOrder',     label: 'Haravan: Tra cứu đơn hàng',    desc: 'Tìm đơn hàng Haravan theo mã đơn hoặc SĐT' },
      { type: 'haravan.lookupProduct',   label: 'Haravan: Tra cứu sản phẩm',    desc: 'Tìm sản phẩm Haravan theo tên' },
      { type: 'haravan.createOrder',     label: 'Haravan: Tạo đơn hàng',        desc: 'Tạo đơn hàng mới trong Haravan' },
      { type: 'sapo.lookupCustomer',     label: 'Sapo: Tra cứu khách hàng',     desc: 'Tìm thông tin khách hàng Sapo theo số điện thoại' },
      { type: 'sapo.lookupOrder',        label: 'Sapo: Tra cứu đơn hàng',       desc: 'Tìm đơn hàng Sapo theo mã đơn hoặc SĐT' },
      { type: 'sapo.lookupProduct',      label: 'Sapo: Tra cứu sản phẩm',       desc: 'Tìm sản phẩm Sapo theo tên' },
      { type: 'sapo.getInventory',       label: 'Sapo: Tra cứu tồn kho',        desc: 'Lấy tồn kho sản phẩm từ Sapo' },
      { type: 'sapo.createOrder',        label: 'Sapo: Tạo đơn hàng',           desc: 'Tạo đơn hàng mới trong Sapo' },
      { type: 'nhanh.lookupCustomer',    label: 'Nhanh.vn: Tra cứu khách hàng', desc: 'Tìm thông tin khách hàng Nhanh.vn theo số điện thoại' },
      { type: 'nhanh.lookupOrder',       label: 'Nhanh.vn: Tra cứu đơn hàng',  desc: 'Tìm đơn hàng Nhanh.vn theo mã đơn hoặc SĐT' },
      { type: 'nhanh.lookupProduct',     label: 'Nhanh.vn: Tra cứu sản phẩm',  desc: 'Tìm sản phẩm trong Nhanh.vn theo tên hoặc mã' },
      { type: 'nhanh.createOrder',       label: 'Nhanh.vn: Tạo đơn hàng',      desc: 'Tạo đơn hàng mới trong Nhanh.vn' },
      { type: 'pancake.lookupCustomer',  label: 'Pancake: Tra cứu khách hàng', desc: 'Tìm thông tin khách hàng Pancake theo số điện thoại' },
      { type: 'pancake.lookupOrder',     label: 'Pancake: Tra cứu đơn hàng',   desc: 'Tìm đơn hàng Pancake theo mã đơn hoặc SĐT' },
      { type: 'pancake.lookupProduct',   label: 'Pancake: Tra cứu sản phẩm',   desc: 'Tìm sản phẩm Pancake theo tên hoặc mã' },
      { type: 'pancake.createOrder',     label: 'Pancake: Tạo đơn hàng',       desc: 'Tạo đơn hàng mới trong Pancake POS' },
    ],
  },
  {
    label: 'Thanh toán',
    color: 'bg-emerald-600',
    items: [
      { type: 'payment.getTransactions', label: 'Lấy lịch sử giao dịch',       desc: 'Lấy danh sách giao dịch từ Casso hoặc SePay (VietQR)' },
    ],
  },
  {
    label: 'Vận chuyển',
    color: 'bg-cyan-600',
    items: [
      { type: 'ghn.createOrder',   label: 'GHN: Tạo đơn vận chuyển',   desc: 'Tạo đơn giao hàng qua GHN Express' },
      { type: 'ghn.getTracking',   label: 'GHN: Tra cứu vận đơn',       desc: 'Lấy trạng thái vận đơn GHN theo mã đơn' },
      { type: 'ghn.getProvinces',  label: 'GHN: Danh sách tỉnh/thành',  desc: 'Lấy danh sách tỉnh/thành chuẩn từ master-data GHN' },
      { type: 'ghn.getDistricts',  label: 'GHN: Danh sách quận/huyện',  desc: 'Lấy danh sách quận/huyện theo ProvinceID GHN' },
      { type: 'ghn.getWards',      label: 'GHN: Danh sách phường/xã',   desc: 'Lấy danh sách phường/xã theo DistrictID GHN' },
      { type: 'ghn.getServices',   label: 'GHN: Dịch vụ khả dụng',      desc: 'Lấy danh sách dịch vụ GHN theo quận gửi / quận nhận' },
      { type: 'ghtk.createOrder',  label: 'GHTK: Tạo đơn vận chuyển',  desc: 'Tạo đơn giao hàng qua GHTK' },
      { type: 'ghtk.getTracking',  label: 'GHTK: Tra cứu vận đơn',      desc: 'Lấy trạng thái vận đơn GHTK theo mã tracking' },
    ],
  },
];

const ALL_NODE_GROUPS: NodeGroup[] = NODE_GROUPS;

export const DEFAULT_CONFIGS: Record<string, Record<string, any>> = {
  'trigger.message':       { threadType: 'all', keyword: '', keywordMode: 'contains_any', ignoreOwn: true, debounceSeconds: 0 },
  'trigger.friendRequest': {},
  'trigger.groupEvent':    { groupId: '', eventType: 'all' },
  'trigger.reaction':      { reactionType: 'any', threadId: '' },
  'trigger.labelAssigned': { action: 'any', labelSource: 'any', labelIds: [] },
  'trigger.telegramCommand': { integrationId: '', command: '', chatIdFilter: '' },
  'tgbot.trigger.message': { accountId: '', chatId: '', chatScope: 'all', messageTypes: 'all', keyword: '', keywordMode: 'contains_any', fromId: '', ignoreOwn: true },
  'tgbot.trigger.command': { accountId: '', chatId: '', chatScope: 'all', command: '', aliases: '', argumentContains: '', authorizedUsers: '', ignoreOwn: true },
  'tgbot.trigger.join': { accountId: '', chatId: '', eventType: 'all' },
  'tgbot.trigger.callback': { accountId: '', callbackData: '' },
  'tgbot.trigger.editedMessage': { accountId: '', chatId: '', chatScope: 'all', keyword: '', keywordMode: 'contains_any' },
  'tgbot.trigger.joinRequest': { accountId: '', chatId: '' },
  'tgbot.action.sendMessage': {
    accountId: '',
    chatId: '{{ $trigger.chatId }}',
    message: '',
    keyboard: { enabled: false, type: 'reply', rows: [], resize: true, oneTime: false, persistent: false },
    testChatId: '',
  },
  'tgbot.action.sendPhoto': { accountId: '', chatId: '{{ $trigger.chatId }}', photoPath: '', caption: '' },
  'tgbot.action.sendVideo': { accountId: '', chatId: '{{ $trigger.chatId }}', videoPath: '', caption: '' },
  'tgbot.action.sendFile': { accountId: '', chatId: '{{ $trigger.chatId }}', filePath: '', caption: '' },
  'tgbot.action.forward': { accountId: '', fromChatId: '{{ $trigger.chatId }}', targetChatId: '', messageId: '{{ $trigger.messageId }}' },
  'tgbot.action.editMessage': { accountId: '', chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}', text: '' },
  'tgbot.action.deleteMessage': { accountId: '', chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}' },
  'tgbot.action.pinMessage': { accountId: '', chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}' },
  'tgbot.action.unpinMessage': { accountId: '', chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}' },
  'tgbot.action.addReaction': { accountId: '', chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}', emoji: '👍' },
  'tgbot.action.sendPoll': { accountId: '', chatId: '{{ $trigger.chatId }}', question: '', options: 'Có\nKhông' },
  'tgbot.action.sendChatAction': { accountId: '', chatId: '{{ $trigger.chatId }}', action: 'typing' },
  'tgbot.action.banMember': { accountId: '', chatId: '{{ $trigger.chatId }}', userId: '{{ $trigger.fromId }}', durationMinutes: 0 },
  'tgbot.action.restrictMember': { accountId: '', chatId: '{{ $trigger.chatId }}', userId: '{{ $trigger.fromId }}', durationMinutes: 10 },
  'tg.trigger.message':    { chatType: 'all', chatId: '', keyword: '', keywordMode: 'contains_any', ignoreOwn: true, fromId: '', debounceSeconds: 0 },
  'tg.trigger.unsend':     { chatId: '' },
  'tg.trigger.groupEvent': { chatId: '', eventType: 'all' },
  'trigger.schedule':      { cronExpression: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh' },
  'trigger.manual':        {},
  'action.forwardCrossChannel': {
    sourceChannel: '', sourceAccountId: '', sourceChatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}',
    targetChannel: 'zalo', targetAccountId: '', targetChatId: '', targetThreadType: '0', companionText: '',
  },
  'zalo.sendMessage':      { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', message: '', sendDelayMinSeconds: 1, sendDelayMaxSeconds: 3 },
  'zalo.sendTyping':       { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', delaySeconds: 3 },
  'zalo.sendImage':        { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', filePath: '', message: '', sendDelayMinSeconds: 1, sendDelayMaxSeconds: 3 },
  'zalo.sendFile':         { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', filePath: '', sendDelayMinSeconds: 1, sendDelayMaxSeconds: 3 },
  'zalo.findUser':         { phone: '{{ $trigger.fromPhone }}' },
  'zalo.getUserInfo':      { userId: '{{ $trigger.fromId }}' },
  'zalo.acceptFriendRequest': { userId: '{{ $trigger.userId }}' },
  'zalo.rejectFriendRequest': { userId: '{{ $trigger.userId }}' },
  'zalo.sendFriendRequest': { userId: '', message: '' },
  'zalo.addToGroup':       { userId: '{{ $trigger.userId }}', groupId: '' },
  'zalo.removeFromGroup':  { userId: '', groupId: '' },
  'zalo.setMute':          { threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}', action: 'mute', duration: 0 },
  'zalo.forwardMessage':   { msgId: '{{ $trigger.msgId }}', toThreadId: '', toThreadType: '0' },
  'zalo.undoMessage':      { msgId: '', threadId: '{{ $trigger.threadId }}', threadType: '{{ $trigger.threadType }}' },
  'zalo.createPoll':       { groupId: '', question: '', options: 'Có\nKhông', allowMultiple: false, expireTime: 0 },
  'zalo.getMessageHistory':{ threadId: '{{ $trigger.threadId }}', count: 20 },
  'zalo.addReaction':      { msgId: '{{ $trigger.msgId }}', reactionType: '1' },
  // Quản lý nhãn
  'zalo.assignLabel':      { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] },
  'zalo.removeLabel':      { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] },
  'zalo.changeAliasName':  { friendId: '{{ $trigger.fromId }}', alias: '' },
  'logic.if':              { left: '{{ $trigger.content }}', operator: 'contains', right: '' },
  'logic.switch':          { value: '{{ $trigger.content }}', cases: [], defaultLabel: 'default' },
  'logic.wait':            { delaySeconds: 3 },
  'logic.setVariable':     { name: '', value: '' },
  'logic.stopIf':          { left: '', operator: 'equals', right: '' },
  'logic.forEach':         { array: '[]', itemVariable: 'item' },
  'data.textFormat':       { template: '' },
  'data.randomPick':       { options: '' },
  'data.dateFormat':       { format: 'datetime' },
  'data.jsonParse':        { input: '' },
  'output.httpRequest':    { method: 'POST', url: '', headers: '', body: '', timeout: 10000 },
  'output.log':            { message: '', level: 'info' },
  // Google Sheets
  'sheets.appendRow':   { spreadsheetId: '', sheetName: 'Sheet1', values: '', serviceAccountPath: '' },
  'sheets.readValues':  { spreadsheetId: '', range: 'Sheet1!A1:Z100', serviceAccountPath: '' },
  'sheets.updateCell':  { spreadsheetId: '', range: 'Sheet1!A1', value: '', serviceAccountPath: '' },
  // AI
  'ai.generateText': { aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini', systemPrompt: 'Bạn là trợ lý tư vấn bán hàng chuyên nghiệp.', prompt: '{{ $trigger.content }}', maxTokens: 300, temperature: 0.7 },
  'ai.classify':     { aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.4-mini', categories: 'hỏi giá, đặt hàng, khiếu nại, khác', input: '{{ $trigger.content }}' },
  // Notify
  'notify.telegram': { botToken: '', chatId: '', message: '' },
  'notify.discord':  { webhookUrl: '', message: '', username: 'DepLao Bot' },
  'notify.email':    { smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUser: '', smtpPass: '', to: '', subject: '', body: '' },
  'notify.notion':   { apiKey: '', databaseId: '', properties: '{"Tên": {"title": [{"text": {"content": "{{ $trigger.fromName }}"}}]}}' },
  // Trigger: payment
  'trigger.payment': { integrationId: '', minAmount: 0, descContains: '' },
  'trigger.webhook':   { webhookToken: '', secretKey: '', method: 'POST', allowedIps: '' },
  'kiotviet.lookupCustomer': { phone: '{{ $trigger.fromPhone }}' },
  'kiotviet.lookupOrder':    { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'kiotviet.lookupProduct':  { keyword: '{{ $trigger.content }}', limit: 10 },
  'kiotviet.createOrder':    { branchId: '', customerId: '', orderDetails: '[]', discount: 0, note: '' },
  'haravan.lookupCustomer':  { phone: '{{ $trigger.fromPhone }}' },
  'haravan.lookupOrder':     { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'haravan.lookupProduct':   { keyword: '{{ $trigger.content }}', limit: 10 },
  'haravan.createOrder':     { order: '{"line_items":[{"variant_id":"","quantity":1,"price":""}],"customer":{"phone":""}}' },
  'sapo.lookupCustomer':     { phone: '{{ $trigger.fromPhone }}' },
  'sapo.lookupOrder':        { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'sapo.lookupProduct':      { keyword: '{{ $trigger.content }}', limit: 10 },
  'sapo.getInventory':       { limit: 50 },
  'sapo.createOrder':        { order: '{"line_items":[{"variant_id":"","quantity":1,"price":""}],"customer":{"phone":""}}' },
  'nhanh.lookupCustomer':    { phone: '{{ $trigger.fromPhone }}' },
  'nhanh.lookupOrder':       { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'nhanh.lookupProduct':     { keyword: '{{ $trigger.content }}', code: '', limit: 10 },
  'nhanh.createOrder':       { order: '{"customerName":"","customerMobile":"","productList":{"123":1},"productDetails":[{"productId":"123","quantity":1,"price":0}],"paymentMethod":"COD"}' },
  'pancake.lookupCustomer':  { phone: '{{ $trigger.fromPhone }}' },
  'pancake.lookupOrder':     { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'pancake.lookupProduct':   { keyword: '{{ $trigger.content }}', code: '', limit: 10 },
  'pancake.createOrder':     { order: '{"customer":{"name":"","phone":""},"items":[{"productId":"","quantity":1,"unitPrice":0}],"paymentMethod":"cod"}' },
  // Payment actions
  'payment.getTransactions': { integrationId: '', limit: 20 },
  // Vận chuyển
  'ghn.createOrder':  { integrationId: '', toName: '', toPhone: '', toAddress: '', toDistrictId: '', toWardCode: '', weight: 500, serviceTypeId: '2', codAmount: 0, order: '{}' },
  'ghn.getTracking':  { integrationId: '', orderCode: '' },
  'ghn.getProvinces': { integrationId: '' },
  'ghn.getDistricts': { integrationId: '', provinceId: '' },
  'ghn.getWards':     { integrationId: '', districtId: '' },
  'ghn.getServices':  { integrationId: '', fromDistrict: '', toDistrict: '' },
  'ghtk.createOrder': { integrationId: '', order: '{}' },
  'ghtk.getTracking': { integrationId: '', trackingCode: '' },
  // Facebook
  'fb.trigger.message':    { threadId: '', keyword: '', keywordMode: 'contains_any', threadType: 'all', ignoreOwn: true, onlyOwn: false, fromId: '', groupId: '', debounceSeconds: 0 },
  'fb.trigger.image':      { threadId: '' },
  'fb.trigger.video':      { threadId: '' },
  'fb.trigger.file':       { threadId: '' },
  'fb.trigger.sticker':    { threadId: '' },
  'fb.trigger.reaction':   { threadId: '', reactionType: 'any' },
  'fb.trigger.unsend':     { threadId: '' },
  'fb.trigger.groupEvent': { threadId: '', eventType: 'all' },
  'fb.action.sendMessage': { threadId: '{{ $trigger.threadId }}', message: '' },
  'fb.action.addReaction': { messageId: '{{ $trigger.messageId }}', emoji: '👍' },
  'fb.action.sendImage':   { threadId: '{{ $trigger.threadId }}', filePath: '', body: '' },
  'fb.action.unsend':      { messageId: '' },
  'fb.action.editMessage': { messageId: '', text: '' },
  'fb.action.forward':     { messageId: '', targetThreadId: '' },
  'fb.action.pin':         { messageId: '', threadId: '{{ $trigger.threadId }}' },
  'fb.action.unpin':       { messageId: '', threadId: '{{ $trigger.threadId }}' },
  'fb.action.createPoll':  { threadId: '', question: '', options: 'Có\nKhông' },
  'fb.action.sendTyping':  { threadId: '{{ $trigger.threadId }}', isTyping: true },
  'fb.action.markAsRead':  { threadId: '{{ $trigger.threadId }}' },
  'fb.action.block':       { userId: '' },
  'fb.action.changeName':  { threadId: '', name: '' },
  'fb.action.changeEmoji': { threadId: '', emoji: '' },
  'fb.action.changeNickname': { threadId: '', userId: '', nickname: '' },
  // Telegram actions
  'tg.sendMessage':     { chatId: '{{ $trigger.chatId }}', message: '', continueOnError: false },
  'tg.sendPhoto':       { chatId: '{{ $trigger.chatId }}', filePath: '', caption: '' },
  'tg.sendFile':        { chatId: '{{ $trigger.chatId }}', filePath: '', caption: '' },
  'tg.forwardMessage':  { fromChatId: '', toChatId: '', messageId: '{{ $trigger.messageId }}' },
  'tg.deleteMessage':   { chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}' },
  'tg.editMessage':     { chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}', text: '' },
  'tg.addReaction':     { chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}', emoji: '👍' },
  'tg.pinMessage':      { chatId: '{{ $trigger.chatId }}', messageId: '{{ $trigger.messageId }}' },
  'tg.sendPoll':        { chatId: '{{ $trigger.chatId }}', question: '', options: 'Có\nKhông' },
  'tg.sendSticker':     { chatId: '{{ $trigger.chatId }}', stickerId: '', accessHash: '' },
  'tg.sendTyping':      { chatId: '{{ $trigger.chatId }}' },
  'tg.banMember':       { chatId: '{{ $trigger.chatId }}', userId: '' },
  'tg.promoteMember':   { chatId: '{{ $trigger.chatId }}', userId: '', isAdmin: true },
  'tg.addMember':       { chatId: '{{ $trigger.chatId }}', userId: '' },
  'tg.removeMember':    { chatId: '{{ $trigger.chatId }}', userId: '' },
  'tg.markAsRead':      { chatId: '{{ $trigger.chatId }}' },
  'tg.markTopicAsRead': { chatId: '{{ $trigger.chatId }}', topicId: '{{ $trigger.topicId }}' },
  'tg.blockUser':       { userId: '{{ $trigger.senderId }}' },
  'tg.unblockUser':     { userId: '{{ $trigger.senderId }}' },
  'tg.changeGroupName': { chatId: '{{ $trigger.chatId }}', name: '' },
  'tg.leaveGroup':      { chatId: '{{ $trigger.chatId }}' },
  'tg.exportInviteLink':{ chatId: '{{ $trigger.chatId }}' },
  'tg.createForumTopic':{ chatId: '{{ $trigger.chatId }}', title: '' },
};

/** Map: nodeType → friendly Vietnamese label (auto-built from NODE_GROUPS) */
export const NODE_LABEL_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const group of ALL_NODE_GROUPS) {
    for (const item of group.items) {
      map[item.type] = item.label;
    }
  }
  return map;
})();

/** Get friendly Vietnamese label for a node type. Falls back to the raw type if not found. */
export function getNodeLabel(type: string): string {
  return NODE_LABEL_MAP[type] || type;
}

export function nodeTypeGroup(type: string): string {
  if (type.startsWith('trigger.')) return 'trigger';
  if (type.startsWith('zalo.'))    return 'action';
  if (type.startsWith('fb.'))      return 'action';
  if (type.startsWith('tg.'))      return 'action';
  if (type.startsWith('logic.'))   return 'logic';
  if (type.startsWith('data.'))    return 'data';
  if (type.startsWith('sheets.'))  return 'integration';
  if (type.startsWith('ai.'))      return 'integration';
  if (type.startsWith('notify.'))  return 'integration';
  if (type.startsWith('output.'))  return 'output';
  // POS / Shipping / Payment
  if (type.startsWith('kiotviet.') || type.startsWith('haravan.') ||
      type.startsWith('sapo.')     ||
      type.startsWith('nhanh.')    || type.startsWith('pancake.')) return 'integration';
  if (type.startsWith('payment.') || type.startsWith('ghn.') || type.startsWith('ghtk.')) return 'integration';
  return 'action';
}

export const GROUP_COLORS: Record<string, string> = {
  trigger:     '#7c3aed',
  action:      '#2563eb',
  logic:       '#d97706',
  data:        '#0d9488',
  integration: '#16a34a',
  output:      '#e11d48',
};
