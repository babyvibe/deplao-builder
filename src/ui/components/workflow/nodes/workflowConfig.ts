// Node type configurations: default configs, labels, descriptions
// Relative import (not the @/ alias) so the main process can also import the node catalog (Public API v1).
import { CHANNEL } from '../../../lib/channels/channelHelper';
import { tr } from '../../../../shared/i18n';

type ChannelTag = 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot' | 'both';
type NodeGroupItem = { type: string; label: string; desc: string; channel?: ChannelTag };
type NodeGroup = { label: string; color: string; items: NodeGroupItem[] };

export const NODE_GROUPS: NodeGroup[] = [
  {
    label: tr('Kích hoạt'),
    color: 'bg-violet-500',
    items: [
      // Zalo triggers
      { type: 'trigger.message',        label: tr('Khi nhận tin nhắn'),             desc: tr('Kích hoạt khi có tin nhắn mới (cá nhân hoặc nhóm) - Zalo'), channel: CHANNEL.ZALO },
      { type: 'trigger.friendRequest', label: tr('Khi có lời mời kết bạn'),      desc: tr('Kích hoạt khi ai đó gửi lời mời kết bạn đến bạn'), channel: CHANNEL.ZALO },
      { type: 'trigger.groupEvent',    label: tr('Khi có sự kiện nhóm'),         desc: tr('Kích hoạt khi thành viên vào/rời nhóm, thay đổi admin...'), channel: CHANNEL.ZALO },
      { type: 'trigger.reaction',      label: tr('Khi có người react tin nhắn'), desc: tr('Kích hoạt khi ai đó thả cảm xúc vào tin nhắn'), channel: CHANNEL.ZALO },
      { type: 'trigger.labelAssigned', label: tr('Khi gán hoặc gỡ nhãn'),       desc: tr('Kích hoạt khi Nhãn Local/Zalo được gán hoặc gỡ khỏi hội thoại'), channel: CHANNEL.ZALO },
      { type: 'trigger.schedule',      label: tr('Chạy theo lịch hẹn'),          desc: tr('Tự động kích hoạt theo lịch (hàng ngày, hàng giờ...)'), channel: 'both' },
      { type: 'trigger.manual',        label: tr('Chạy thủ công'),               desc: tr('Kích hoạt bằng tay từ giao diện, dùng để test workflow'), channel: 'both' },
      { type: 'trigger.payment',       label: tr('Khi nhận thanh toán'),         desc: tr('Kích hoạt khi nhận webhook thanh toán từ Casso / SePay (VietQR)'), channel: 'both' },
      { type: 'trigger.posWebhook',    label: tr('Khi phần mềm bán hàng gửi webhook'), desc: tr('Kích hoạt khi KiotViet / Haravan / Sapo / Nhanh.vn / Pancake POS gửi đơn hàng, khách hàng, sản phẩm… (chỉ webhook đã xác thực khoá)'), channel: 'both' },
      { type: 'trigger.webhook',       label: tr('Webhook bên ngoài'),           desc: tr('Kích hoạt khi nhận dữ liệu từ webhook bên thứ 3 gửi sang'), channel: 'both' },
      { type: 'trigger.api',           label: tr('Khi API/ứng dụng gọi'),        desc: tr('Kích hoạt khi hệ thống ngoài hoặc ứng dụng đã cài gọi POST /api/v1/workflows/events/{tên sự kiện}'), channel: 'both' },
      // Telegram triggers (the legacy `trigger.telegramCommand` integration is
      // intentionally not shown here; native Telegram Bot workflows use the
      // dedicated Bot triggers below).
      { type: 'tg.trigger.message',    label: tr('Khi nhận tin nhắn Telegram'),  desc: tr('Kích hoạt khi có tin nhắn mới trên Telegram (cá nhân hoặc nhóm)'), channel: 'telegram_user' },
      { type: 'tg.trigger.unsend',     label: tr('Khi thu hồi tin nhắn Telegram'), desc: tr('Kích hoạt khi tin nhắn bị thu hồi trên Telegram'), channel: 'telegram_user' },
      { type: 'tg.trigger.groupEvent', label: tr('Sự kiện nhóm Telegram'),       desc: tr('Kích hoạt khi thành viên vào/rời nhóm Telegram'), channel: 'telegram_user' },
      // Telegram Bot triggers belong with every other workflow entry point.
      // Keep the Bot group below action-only, otherwise users can mistake an
      // event node for an action that sends something.
      { type: 'tgbot.trigger.message',   label: tr('Khi Bot nhận tin nhắn'),      desc: tr('Kích hoạt khi Bot nhận tin mới; có thể lọc chat, nội dung và người gửi'), channel: 'telegram_bot' },
      { type: 'tgbot.trigger.command',   label: tr('Khi user gửi lệnh cho Bot'),  desc: tr('Kích hoạt khi nhận /command; có thể lọc lệnh, tham số và quyền user'), channel: 'telegram_bot' },
      { type: 'tgbot.trigger.callback',  label: tr('Khi user nhấn nút Bot'),     desc: tr('Kích hoạt khi user nhấn Inline Button tùy chỉnh'), channel: 'telegram_bot' },
      { type: 'tgbot.trigger.join',      label: tr('Bot được thêm/gỡ nhóm'),     desc: tr('Kích hoạt khi trạng thái hoặc quyền của chính Bot trong nhóm thay đổi'), channel: 'telegram_bot' },
      { type: 'tgbot.trigger.editedMessage', label: tr('Khi tin nhắn Bot bị sửa'), desc: tr('Kích hoạt khi user sửa tin nhắn trong chat Bot nhận được'), channel: 'telegram_bot' },
      { type: 'tgbot.trigger.joinRequest', label: tr('Khi có yêu cầu vào nhóm'), desc: tr('Kích hoạt khi user gửi join request tới nhóm có Bot admin'), channel: 'telegram_bot' },
      { type: 'tgbot.trigger.memberUpdate', label: tr('Khi thành viên vào/rời nhóm'), desc: tr('Kích hoạt khi có người vào, rời hoặc bị xoá khỏi nhóm có Bot làm admin'), channel: 'telegram_bot' },
      // Facebook triggers
      { type: 'fb.trigger.message',    label: tr('Khi nhận tin nhắn'),           desc: tr('Kích hoạt khi có tin nhắn mới trên Facebook Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.image',      label: tr('Khi nhận tin nhắn ảnh'),       desc: tr('Kích hoạt khi nhận được tin nhắn chứa ảnh trên Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.video',      label: tr('Khi nhận tin nhắn video'),     desc: tr('Kích hoạt khi nhận được tin nhắn video trên Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.file',       label: tr('Khi nhận tin nhắn file'),      desc: tr('Kích hoạt khi nhận được tin nhắn file trên Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.sticker',    label: tr('Khi nhận sticker'),             desc: tr('Kích hoạt khi nhận được sticker trên Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.reaction',   label: tr('Khi có reaction'),             desc: tr('Kích hoạt khi ai đó thả cảm xúc vào tin nhắn Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.unsend',     label: tr('Khi thu hồi tin nhắn'),        desc: tr('Kích hoạt khi ai đó thu hồi tin nhắn trên Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.trigger.groupEvent', label: tr('Khi có sự kiện nhóm'),         desc: tr('Kích hoạt khi thành viên vào/rời nhóm Facebook'), channel: CHANNEL.FACEBOOK },
    ],
  },
  {
    label: tr('Hành động'),
    color: 'bg-blue-600',
    items: [
      { type: 'action.forwardCrossChannel', label: tr('Chuyển tiếp đa kênh'),    desc: tr('Gửi lại tin gốc sang Zalo, Facebook, Telegram User hoặc Telegram Bot'), channel: 'both' },
      { type: 'fb.action.sendMessage',    label: tr('Gửi tin nhắn'),              desc: tr('Gửi tin nhắn văn bản đến hội thoại Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.sendImage',      label: tr('Gửi tệp đính kèm'),          desc: tr('Gửi ảnh, video, audio hoặc file vào hội thoại Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.addReaction',    label: tr('Thả reaction'),               desc: tr('Thả emoji reaction vào tin nhắn Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.unsend',         label: tr('Thu hồi tin nhắn'),          desc: tr('Thu hồi tin nhắn đã gửi trên Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.editMessage',    label: tr('Chỉnh sửa tin nhắn'),        desc: tr('Chỉnh sửa nội dung tin nhắn đã gửi'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.forward',        label: tr('Gửi lại nội dung'),          desc: tr('Gửi lại văn bản; dùng Chuyển tiếp đa kênh để chuyển cả media'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.pin',            label: tr('Ghim tin nhắn'),             desc: tr('Ghim tin nhắn trong hội thoại Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.unpin',          label: tr('Bỏ ghim tin nhắn'),          desc: tr('Bỏ ghim tin nhắn trong hội thoại Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.createPoll',     label: tr('Tạo bình chọn'),             desc: tr('Tạo cuộc bình chọn trong nhóm Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.sendTyping',     label: tr('Hiệu ứng đang gõ'),          desc: tr('Hiển thị trạng thái đang gõ trên Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.markAsRead',     label: tr('Đánh dấu đã đọc'),           desc: tr('Đánh dấu hội thoại Facebook đã đọc'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.block',          label: tr('Chặn người dùng'),           desc: tr('Chặn người dùng trên Facebook Messenger'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.changeName',     label: tr('Đổi tên nhóm'),              desc: tr('Đổi tên nhóm Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.changeEmoji',    label: tr('Đổi biểu tượng nhóm'),       desc: tr('Đổi emoji đại diện cho nhóm Facebook'), channel: CHANNEL.FACEBOOK },
      { type: 'fb.action.changeNickname', label: tr('Đổi biệt danh thành viên'),  desc: tr('Đổi nickname của thành viên trong nhóm Facebook'), channel: CHANNEL.FACEBOOK },
      // Telegram User actions
      { type: 'tg.sendMessage',     label: tr('Gửi tin nhắn'),              desc: tr('Gửi tin nhắn văn bản đến hội thoại Telegram'), channel: 'telegram_user' },
      { type: 'tg.sendPhoto',       label: tr('Gửi ảnh'),                   desc: tr('Chọn ảnh từ máy tính để gửi đến hội thoại Telegram'), channel: 'telegram_user' },
      { type: 'tg.sendFile',        label: tr('Gửi file đính kèm'),         desc: tr('Gửi file (PDF, Excel, ...) đến hội thoại Telegram'), channel: 'telegram_user' },
      { type: 'tg.forwardMessage',  label: tr('Chuyển tiếp tin nhắn'),      desc: tr('Chuyển tiếp tin nhắn sang hội thoại Telegram khác'), channel: 'telegram_user' },
      { type: 'tg.deleteMessage',   label: tr('Xóa tin nhắn'),              desc: tr('Xóa tin nhắn trong hội thoại Telegram'), channel: 'telegram_user' },
      { type: 'tg.editMessage',     label: tr('Chỉnh sửa tin nhắn'),        desc: tr('Chỉnh sửa nội dung tin nhắn đã gửi trên Telegram'), channel: 'telegram_user' },
      { type: 'tg.addReaction',     label: tr('Thả reaction'),              desc: tr('Thả emoji reaction vào tin nhắn Telegram'), channel: 'telegram_user' },
      { type: 'tg.pinMessage',      label: tr('Ghim tin nhắn'),             desc: tr('Ghim tin nhắn trong hội thoại Telegram'), channel: 'telegram_user' },
      { type: 'tg.sendPoll',        label: tr('Tạo bình chọn'),             desc: tr('Tạo cuộc bình chọn (poll) trong nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.sendSticker',     label: tr('Gửi sticker'),               desc: tr('Gửi sticker từ sticker set đến hội thoại Telegram'), channel: 'telegram_user' },
      { type: 'tg.sendTyping',      label: tr('Hiệu ứng đang gõ'),         desc: tr('Hiển thị trạng thái đang gõ trên Telegram'), channel: 'telegram_user' },
      { type: 'tg.banMember',       label: tr('Cấm thành viên'),            desc: tr('Cấm (ban) thành viên khỏi nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.promoteMember',   label: tr('Thăng quyền thành viên'),    desc: tr('Thăng/hạ quyền admin cho thành viên trong nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.addMember',       label: tr('Thêm thành viên'),           desc: tr('Thêm thành viên vào nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.removeMember',    label: tr('Xóa thành viên'),            desc: tr('Xóa thành viên khỏi nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.markAsRead',      label: tr('Đánh dấu đã đọc'),          desc: tr('Đánh dấu tin nhắn đã đọc trong hội thoại Telegram'), channel: 'telegram_user' },
      { type: 'tg.markTopicAsRead', label: tr('Đánh dấu topic đã đọc'),   desc: tr('Đánh dấu forum topic đã đọc trong nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.blockUser',       label: tr('Chặn người dùng'),          desc: tr('Chặn người dùng trên Telegram'), channel: 'telegram_user' },
      { type: 'tg.unblockUser',     label: tr('Bỏ chặn người dùng'),       desc: tr('Bỏ chặn người dùng trên Telegram'), channel: 'telegram_user' },
      { type: 'tg.changeGroupName', label: tr('Đổi tên nhóm'),             desc: tr('Đổi tên nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.leaveGroup',      label: tr('Rời nhóm'),                 desc: tr('Rời khỏi nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.exportInviteLink', label: tr('Lấy link mời'),             desc: tr('Lấy link mời tham gia nhóm Telegram'), channel: 'telegram_user' },
      { type: 'tg.createForumTopic', label: tr('Tạo topic mới'),            desc: tr('Tạo topic mới trong nhóm Telegram Forum'), channel: 'telegram_user' },
      // Telegram Bot actions
      { type: 'tgbot.action.sendMessage', label: tr('Gửi tin nhắn / Keyboard'), desc: tr('Gửi text, Reply Keyboard hoặc Inline Button từ Bot'), channel: 'telegram_bot' },
      { type: 'tgbot.action.sendPhoto',   label: tr('Gửi ảnh'),                  desc: tr('Chọn ảnh từ máy tính, kèm chú thích tùy chọn'), channel: 'telegram_bot' },
      { type: 'tgbot.action.sendVideo',   label: tr('Gửi video'),                desc: tr('Chọn video từ máy tính để gửi'), channel: 'telegram_bot' },
      { type: 'tgbot.action.sendFile',    label: tr('Gửi file đính kèm'),        desc: tr('Gửi tài liệu, PDF hoặc file khác'), channel: 'telegram_bot' },
      { type: 'tgbot.action.forward',     label: tr('Chuyển tiếp tin nhắn'),     desc: tr('Chuyển tiếp một tin từ chat nguồn sang chat khác'), channel: 'telegram_bot' },
      { type: 'tgbot.action.editMessage', label: tr('Sửa tin nhắn'),             desc: tr('Sửa nội dung tin Bot đã gửi'), channel: 'telegram_bot' },
      { type: 'tgbot.action.deleteMessage', label: tr('Xóa tin nhắn'),           desc: tr('Xóa tin nhắn; Bot cần quyền phù hợp trong nhóm'), channel: 'telegram_bot' },
      { type: 'tgbot.action.pinMessage',  label: tr('Ghim tin nhắn'),            desc: tr('Ghim tin nhắn; chỉ chạy khi Bot có quyền ghim'), channel: 'telegram_bot' },
      { type: 'tgbot.action.unpinMessage', label: tr('Bỏ ghim tin nhắn'),        desc: tr('Bỏ ghim một tin hoặc tin đang ghim'), channel: 'telegram_bot' },
      { type: 'tgbot.action.addReaction', label: tr('Thả reaction'),             desc: tr('Thả emoji vào một tin nhắn nếu chat cho phép'), channel: 'telegram_bot' },
      { type: 'tgbot.action.sendPoll',    label: tr('Tạo bình chọn'),            desc: tr('Gửi poll không ẩn danh vào chat'), channel: 'telegram_bot' },
      { type: 'tgbot.action.sendChatAction', label: tr('Hiển thị đang gõ'),      desc: tr('Hiển thị typing/uploading trong lúc Bot xử lý'), channel: 'telegram_bot' },
      { type: 'tgbot.action.banMember',   label: tr('Cấm thành viên'),           desc: tr('Cấm user khỏi nhóm; Bot phải là admin có quyền hạn chế'), channel: 'telegram_bot' },
      { type: 'tgbot.action.restrictMember', label: tr('Hạn chế thành viên'),    desc: tr('Mute hoặc giới hạn quyền gửi tin của thành viên'), channel: 'telegram_bot' },
      { type: 'tgbot.action.unbanMember',   label: tr('Bỏ cấm thành viên'),      desc: tr('Gỡ lệnh cấm để user vào lại nhóm bằng link mời'), channel: 'telegram_bot' },
      { type: 'tgbot.action.approveJoinRequest', label: tr('Duyệt yêu cầu vào nhóm'), desc: tr('Duyệt hoặc từ chối người xin vào nhóm; Bot cần quyền mời thành viên'), channel: 'telegram_bot' },
      { type: 'tgbot.action.leaveChat',     label: tr('Rời nhóm'),               desc: tr('Bot tự rời khỏi nhóm hoặc kênh'), channel: 'telegram_bot' },
      // Zalo actions
      { type: 'zalo.sendMessage',        label: tr('Gửi tin nhắn'),               desc: tr('Gửi tin nhắn văn bản đến hội thoại'), channel: CHANNEL.ZALO },
      { type: 'zalo.sendTyping',         label: tr('Hiệu ứng đang gõ + chờ'),    desc: tr('Hiển thị "đang gõ..." rồi chờ vài giây trước bước tiếp'), channel: CHANNEL.ZALO },
      { type: 'zalo.sendImage',          label: tr('Gửi ảnh'),                    desc: tr('Chọn ảnh từ máy tính để gửi'), channel: CHANNEL.ZALO },
      { type: 'zalo.sendFile',           label: tr('Gửi file đính kèm'),          desc: tr('Gửi file (PDF, Excel, ...) đến hội thoại'), channel: CHANNEL.ZALO },
      { type: 'zalo.findUser',           label: tr('Tìm user bằng số điện thoại'),desc: tr('Tra cứu tài khoản Zalo theo SĐT để lấy User ID'), channel: CHANNEL.ZALO },
      { type: 'zalo.getUserInfo',        label: tr('Lấy thông tin người dùng'),   desc: tr('Lấy tên, avatar, giới tính... từ User ID Zalo'), channel: CHANNEL.ZALO },
      { type: 'zalo.acceptFriendRequest',label: tr('Chấp nhận lời mời kết bạn'),  desc: tr('Tự động chấp nhận lời mời kết bạn từ người dùng'), channel: CHANNEL.ZALO },
      { type: 'zalo.rejectFriendRequest',label: tr('Từ chối lời mời kết bạn'),    desc: tr('Tự động từ chối lời mời kết bạn'), channel: CHANNEL.ZALO },
      { type: 'zalo.sendFriendRequest',  label: tr('Gửi lời mời kết bạn'),       desc: tr('Chủ động gửi lời mời kết bạn đến User ID'), channel: CHANNEL.ZALO },
      { type: 'zalo.addToGroup',         label: tr('Thêm thành viên vào nhóm'),   desc: tr('Thêm user vào một nhóm Zalo cụ thể'), channel: CHANNEL.ZALO },
      { type: 'zalo.removeFromGroup',    label: tr('Xóa thành viên khỏi nhóm'),   desc: tr('Xóa user ra khỏi nhóm Zalo'), channel: CHANNEL.ZALO },
      { type: 'zalo.setMute',            label: tr('Tắt/bật thông báo'),          desc: tr('Tắt hoặc bật lại thông báo cho hội thoại'), channel: CHANNEL.ZALO },
      { type: 'zalo.forwardMessage',     label: tr('Chuyển tiếp tin nhắn'),       desc: tr('Chuyển tiếp tin nhắn sang hội thoại khác'), channel: CHANNEL.ZALO },
      { type: 'zalo.undoMessage',        label: tr('Thu hồi tin nhắn'),           desc: tr('Thu hồi (xóa 2 phía) một tin nhắn đã gửi'), channel: CHANNEL.ZALO },
      { type: 'zalo.createPoll',         label: tr('Tạo bình chọn trong nhóm'),   desc: tr('Tạo cuộc bình chọn (poll) trong nhóm Zalo'), channel: CHANNEL.ZALO },
      { type: 'zalo.getMessageHistory',  label: tr('Lấy lịch sử tin nhắn'),       desc: tr('Lấy N tin nhắn gần nhất từ hội thoại'), channel: CHANNEL.ZALO },
      { type: 'zalo.addReaction',        label: tr('Thêm cảm xúc vào tin nhắn'),  desc: tr('Thả like, yêu thích, haha... vào tin nhắn'), channel: CHANNEL.ZALO },
      { type: 'zalo.assignLabel',        label: tr('Gắn nhãn hội thoại'),         desc: tr('Gắn Nhãn Local hoặc Zalo cho hội thoại'), channel: CHANNEL.ZALO },
      { type: 'zalo.removeLabel',        label: tr('Gỡ nhãn hội thoại'),          desc: tr('Gỡ Nhãn Local hoặc Zalo khỏi hội thoại'), channel: CHANNEL.ZALO },
      { type: 'zalo.changeAliasName',    label: tr('Đổi tên gợi nhớ'),           desc: tr('Đổi tên gợi nhớ (biệt danh) cho bạn bè trong danh bạ Zalo'), channel: CHANNEL.ZALO },
    ],
  },
  {
    label: tr('Điều kiện & Logic'),
    color: 'bg-amber-500',
    items: [
      { type: 'logic.if',          label: tr('Rẽ nhánh Đúng/Sai (IF)'),  desc: tr('Kiểm tra điều kiện rồi chạy nhánh Đúng hoặc Sai') },
      { type: 'logic.switch',      label: tr('Phân nhiều nhánh (Switch)'),desc: tr('So sánh giá trị với nhiều trường hợp rồi chạy nhánh tương ứng') },
      { type: 'logic.wait',        label: tr('Tạm dừng chờ N giây'),     desc: tr('Dừng workflow trong vài giây trước khi tiếp tục') },
      { type: 'logic.setVariable', label: tr('Lưu giá trị vào biến'),    desc: tr('Lưu dữ liệu để dùng ở các bước sau (VD: tên, số điện thoại...)') },
      { type: 'logic.stopIf',      label: tr('Dừng workflow nếu...'),     desc: tr('Dừng toàn bộ workflow nếu điều kiện đúng') },
      { type: 'logic.forEach',     label: tr('Lặp qua danh sách'),       desc: tr('Chạy các bước nối từ cổng "Mỗi phần tử" cho từng phần tử (tối đa 100, dùng {{ $var.item }}); cổng "Xong" chạy một lần sau đó') },
      { type: 'logic.forEachContact', label: tr('Chọn đối tượng nhận tin'), desc: tr('Lấy danh sách bạn bè / thành viên nhóm / nhãn / CRM liên hệ để gửi tin hàng loạt') },
    ],
  },
  {
    label: tr('Xử lý dữ liệu'),
    color: 'bg-teal-500',
    items: [
      { type: 'data.textFormat',  label: tr('Ghép nội dung văn bản'),   desc: tr('Soạn nội dung bằng mẫu với biến động (VD: tên, ngày...)') },
      { type: 'data.randomPick',  label: tr('Chọn ngẫu nhiên 1 mục'),   desc: tr('Chọn random 1 nội dung từ danh sách, tránh câu trả lời bị lặp') },
      { type: 'data.dateFormat',  label: tr('Định dạng ngày giờ'),       desc: tr('Chuyển đổi ngày/giờ sang định dạng dễ đọc (VD: 25/03/2026)') },
      { type: 'data.jsonParse',   label: tr('Đọc dữ liệu JSON'),        desc: tr('Chuyển chuỗi JSON thành object để đọc các trường bên trong') },
    ],
  },
  {
    label: 'Google Sheets',
    color: 'bg-green-600',
    items: [
      { type: 'sheets.appendRow',   label: tr('Ghi thêm dòng mới'),      desc: tr('Thêm 1 hàng dữ liệu mới vào cuối bảng tính Google Sheets') },
      { type: 'sheets.readValues',  label: tr('Đọc dữ liệu từ Sheet'),   desc: tr('Đọc giá trị các ô từ Google Sheets để dùng ở bước sau') },
      { type: 'sheets.updateCell',  label: tr('Cập nhật ô trong Sheet'),  desc: tr('Ghi đè giá trị vào một ô cụ thể trong bảng tính') },
    ],
  },
  {
    label: tr('Trí tuệ nhân tạo (AI)'),
    color: 'bg-violet-600',
    items: [
      { type: 'ai.generateText', label: tr('Tạo nội dung bằng AI'),   desc: tr('Dùng ChatGPT, Gemini, Deepseek, Grok... để sinh câu trả lời') },
      { type: 'ai.classify',     label: tr('Phân loại văn bản bằng AI'),desc: tr('AI tự phân loại tin nhắn vào danh mục (hỏi giá, khiếu nại...)') },
    ],
  },
  {
    label: tr('Gửi thông báo'),
    color: 'bg-orange-500',
    items: [
      { type: 'notify.telegram', label: tr('Gửi tin qua Telegram'),     desc: tr('Gửi thông báo đến Telegram Bot khi có sự kiện mới') },
      { type: 'notify.discord',  label: tr('Gửi tin vào Discord'),      desc: tr('Gửi thông báo vào kênh Discord qua Webhook') },
      { type: 'notify.email',    label: tr('Gửi Email tự động'),        desc: tr('Gửi email qua SMTP (Gmail, Outlook...) khi có sự kiện') },
      { type: 'notify.notion',   label: tr('Ghi vào Notion Database'),  desc: tr('Tự động tạo trang mới trong Notion Database') },
    ],
  },
  {
    label: tr('Đầu ra & API'),
    color: 'bg-rose-500',
    items: [
      { type: 'output.httpRequest', label: tr('Gọi API bên ngoài (HTTP)'),desc: tr('Gửi request HTTP đến API / webhook bên ngoài') },
      { type: 'output.log',         label: tr('Ghi log gỡ lỗi'),         desc: tr('Ghi nội dung vào lịch sử chạy để debug, kiểm tra dữ liệu') },
    ],
  },
  {
    label: tr('POS / Bán hàng'),
    color: 'bg-orange-600',
    items: [
      { type: 'kiotviet.lookupCustomer', label: tr('KiotViet: Tra cứu khách hàng'), desc: tr('Tìm thông tin khách hàng KiotViet theo số điện thoại') },
      { type: 'kiotviet.lookupOrder',    label: tr('KiotViet: Tra cứu đơn hàng'),   desc: tr('Tìm đơn hàng KiotViet theo mã đơn hoặc SĐT') },
      { type: 'kiotviet.lookupProduct',  label: tr('KiotViet: Tra cứu sản phẩm'),   desc: tr('Tìm sản phẩm KiotViet theo tên hoặc mã SKU') },
      { type: 'kiotviet.createOrder',    label: tr('KiotViet: Tạo đơn hàng'),       desc: tr('Tạo đơn hàng mới trong KiotViet') },
      { type: 'haravan.lookupCustomer',  label: tr('Haravan: Tra cứu khách hàng'),  desc: tr('Tìm thông tin khách hàng Haravan theo số điện thoại') },
      { type: 'haravan.lookupOrder',     label: tr('Haravan: Tra cứu đơn hàng'),    desc: tr('Tìm đơn hàng Haravan theo mã đơn hoặc SĐT') },
      { type: 'haravan.lookupProduct',   label: tr('Haravan: Tra cứu sản phẩm'),    desc: tr('Tìm sản phẩm Haravan theo tên') },
      { type: 'haravan.createOrder',     label: tr('Haravan: Tạo đơn hàng'),        desc: tr('Tạo đơn hàng mới trong Haravan') },
      { type: 'sapo.lookupCustomer',     label: tr('Sapo: Tra cứu khách hàng'),     desc: tr('Tìm thông tin khách hàng Sapo theo số điện thoại') },
      { type: 'sapo.lookupOrder',        label: tr('Sapo: Tra cứu đơn hàng'),       desc: tr('Tìm đơn hàng Sapo theo mã đơn hoặc SĐT') },
      { type: 'sapo.lookupProduct',      label: tr('Sapo: Tra cứu sản phẩm'),       desc: tr('Tìm sản phẩm Sapo theo tên') },
      { type: 'sapo.getInventory',       label: tr('Sapo: Tra cứu tồn kho'),        desc: tr('Lấy tồn kho sản phẩm từ Sapo') },
      { type: 'sapo.createOrder',        label: tr('Sapo: Tạo đơn hàng'),           desc: tr('Tạo đơn hàng mới trong Sapo') },
      { type: 'nhanh.lookupCustomer',    label: tr('Nhanh.vn: Tra cứu khách hàng'), desc: tr('Tìm thông tin khách hàng Nhanh.vn theo số điện thoại') },
      { type: 'nhanh.lookupOrder',       label: tr('Nhanh.vn: Tra cứu đơn hàng'),  desc: tr('Tìm đơn hàng Nhanh.vn theo mã đơn hoặc SĐT') },
      { type: 'nhanh.lookupProduct',     label: tr('Nhanh.vn: Tra cứu sản phẩm'),  desc: tr('Tìm sản phẩm trong Nhanh.vn theo tên hoặc mã') },
      { type: 'nhanh.createOrder',       label: tr('Nhanh.vn: Tạo đơn hàng'),      desc: tr('Tạo đơn hàng mới trong Nhanh.vn') },
      { type: 'pancake.lookupCustomer',  label: tr('Pancake: Tra cứu khách hàng'), desc: tr('Tìm thông tin khách hàng Pancake theo số điện thoại') },
      { type: 'pancake.lookupOrder',     label: tr('Pancake: Tra cứu đơn hàng'),   desc: tr('Tìm đơn hàng Pancake theo mã đơn hoặc SĐT') },
      { type: 'pancake.lookupProduct',   label: tr('Pancake: Tra cứu sản phẩm'),   desc: tr('Tìm sản phẩm Pancake theo tên hoặc mã') },
      { type: 'pancake.createOrder',     label: tr('Pancake: Tạo đơn hàng'),       desc: tr('Tạo đơn hàng mới trong Pancake POS') },
    ],
  },
  {
    label: tr('Thanh toán'),
    color: 'bg-emerald-600',
    items: [
      { type: 'payment.getTransactions', label: tr('Lấy lịch sử giao dịch'),       desc: tr('Lấy danh sách giao dịch từ Casso hoặc SePay (VietQR)') },
    ],
  },
  {
    label: tr('Vận chuyển'),
    color: 'bg-cyan-600',
    items: [
      { type: 'ghn.createOrder',   label: tr('GHN: Tạo đơn vận chuyển'),   desc: tr('Tạo đơn giao hàng qua GHN Express') },
      { type: 'ghn.getTracking',   label: tr('GHN: Tra cứu vận đơn'),       desc: tr('Lấy trạng thái vận đơn GHN theo mã đơn') },
      { type: 'ghn.getProvinces',  label: tr('GHN: Danh sách tỉnh/thành'),  desc: tr('Lấy danh sách tỉnh/thành chuẩn từ master-data GHN') },
      { type: 'ghn.getDistricts',  label: tr('GHN: Danh sách quận/huyện'),  desc: tr('Lấy danh sách quận/huyện theo ProvinceID GHN') },
      { type: 'ghn.getWards',      label: tr('GHN: Danh sách phường/xã'),   desc: tr('Lấy danh sách phường/xã theo DistrictID GHN') },
      { type: 'ghn.getServices',   label: tr('GHN: Dịch vụ khả dụng'),      desc: tr('Lấy danh sách dịch vụ GHN theo quận gửi / quận nhận') },
      { type: 'ghtk.createOrder',  label: tr('GHTK: Tạo đơn vận chuyển'),  desc: tr('Tạo đơn giao hàng qua GHTK') },
      { type: 'ghtk.getTracking',  label: tr('GHTK: Tra cứu vận đơn'),      desc: tr('Lấy trạng thái vận đơn GHTK theo mã tracking') },
    ],
  },
];

const ALL_NODE_GROUPS: NodeGroup[] = NODE_GROUPS;

/**
 * Chat allow / deny lists of the message triggers ('' = off, an id in both lists is excluded). Apps detect support
 * through API v1 listWorkflowNodeTypes: its `defaults` are these configs, so `includeThreadIds` is listed there.
 */
const THREAD_LISTS = { includeThreadIds: '', excludeThreadIds: '' };

export const DEFAULT_CONFIGS: Record<string, Record<string, any>> = {
  'trigger.message':       { threadType: 'all', ...THREAD_LISTS, keyword: '', keywordMode: 'contains_any', ignoreOwn: true, debounceSeconds: 0 },
  'trigger.friendRequest': {},
  'trigger.groupEvent':    { groupId: '', eventType: 'all' },
  'trigger.reaction':      { reactionType: 'any', threadId: '' },
  'trigger.labelAssigned': { action: 'any', labelSource: 'any', labelIds: [] },
  'trigger.telegramCommand': { integrationId: '', command: '', chatIdFilter: '' },
  'tgbot.trigger.message': { accountId: '', chatId: '', chatScope: 'all', ...THREAD_LISTS, messageTypes: 'all', keyword: '', keywordMode: 'contains_any', fromId: '', ignoreOwn: true, ignoreCommands: true },
  'tgbot.trigger.command': { accountId: '', chatId: '', chatScope: 'all', ...THREAD_LISTS, command: '', aliases: '', argumentContains: '', authorizedUsers: '', ignoreOwn: true },
  'tgbot.trigger.join': { accountId: '', chatId: '', eventType: 'all' },
  'tgbot.trigger.callback': { accountId: '', callbackData: '' },
  'tgbot.trigger.editedMessage': { accountId: '', chatId: '', chatScope: 'all', keyword: '', keywordMode: 'contains_any' },
  'tgbot.trigger.joinRequest': { accountId: '', chatId: '' },
  'tgbot.trigger.memberUpdate': { accountId: '', chatId: '', eventType: 'joined', ignoreBots: true },
  'tgbot.action.unbanMember': { accountId: '', chatId: '{{ $trigger.chatId }}', userId: '' },
  'tgbot.action.approveJoinRequest': { accountId: '', chatId: '{{ $trigger.chatId }}', userId: '{{ $trigger.fromId }}', decision: 'approve' },
  'tgbot.action.leaveChat': { accountId: '', chatId: '{{ $trigger.chatId }}' },
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
  'tgbot.action.sendPoll': { accountId: '', chatId: '{{ $trigger.chatId }}', question: '', options: tr('Có\nKhông') },
  'tgbot.action.sendChatAction': { accountId: '', chatId: '{{ $trigger.chatId }}', action: 'typing' },
  'tgbot.action.banMember': { accountId: '', chatId: '{{ $trigger.chatId }}', userId: '{{ $trigger.fromId }}', durationMinutes: 0 },
  'tgbot.action.restrictMember': { accountId: '', chatId: '{{ $trigger.chatId }}', userId: '{{ $trigger.fromId }}', durationMinutes: 10 },
  'tg.trigger.message':    { chatType: 'all', chatId: '', ...THREAD_LISTS, keyword: '', keywordMode: 'contains_any', ignoreOwn: true, fromId: '', debounceSeconds: 0 },
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
  'zalo.createPoll':       { groupId: '', question: '', options: tr('Có\nKhông'), allowMultiple: false, expireTime: 0 },
  'zalo.getMessageHistory':{ threadId: '{{ $trigger.threadId }}', count: 20 },
  'zalo.addReaction':      {
    msgId: '{{ $trigger.msgId }}',
    clientMsgId: '{{ $trigger.cliMsgId }}',
    threadId: '{{ $trigger.threadId }}',
    threadType: '{{ $trigger.threadType }}',
    reactionType: 'LIKE',
  },
  // Label management
  'zalo.assignLabel':      { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] },
  'zalo.removeLabel':      { threadId: '{{ $trigger.threadId }}', labelSource: 'local', labelIds: [] },
  'zalo.changeAliasName':  { friendId: '{{ $trigger.fromId }}', alias: '' },
  'logic.if':              { left: '{{ $trigger.content }}', operator: 'contains', right: '' },
  'logic.switch':          { value: '{{ $trigger.content }}', cases: [], defaultLabel: 'default' },
  'logic.wait':            { delaySeconds: 3 },
  'logic.setVariable':     { name: '', value: '' },
  'logic.stopIf':          { left: '', operator: 'equals', right: '' },
  'logic.forEach':         { array: '', itemVariable: 'item', maxItems: 20 },
  'logic.forEachContact':  { source: 'friends', groupId: '', labelIds: [], limit: 50, excludeIds: '' },
  'data.textFormat':       { template: '' },
  'data.randomPick':       { options: '' },
  'data.dateFormat':       { format: 'datetime', date: '', locale: 'vi-VN' },
  'data.jsonParse':        { input: '' },
  'output.httpRequest':    { method: 'POST', url: '', headers: '', body: '', timeout: 10000 },
  'output.log':            { message: '', level: 'info' },
  // Google Sheets
  'sheets.appendRow':   { spreadsheetId: '', sheetName: 'Sheet1', values: '', serviceAccountPath: '' },
  'sheets.readValues':  { spreadsheetId: '', range: 'Sheet1!A1:Z100', serviceAccountPath: '' },
  'sheets.updateCell':  { spreadsheetId: '', range: 'Sheet1!A1', value: '', serviceAccountPath: '' },
  // AI
  'ai.generateText': { aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.6-luna', systemPrompt: 'Bạn là trợ lý tư vấn bán hàng chuyên nghiệp.', prompt: '{{ $trigger.content }}', maxTokens: 300, temperature: 0.7 },
  'ai.classify':     { aiConfigMode: 'assistant', assistantId: '', platform: 'openai', apiKey: '', model: 'gpt-5.6-luna', categories: 'hỏi giá, đặt hàng, khiếu nại, khác', input: '{{ $trigger.content }}' },
  // Notify
  'notify.telegram': { botAccountId: '', botToken: '', chatId: '', message: '' },
  'notify.discord':  { webhookUrl: '', message: '', username: 'DepLao Bot' },
  'notify.email':    { smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUser: '', smtpPass: '', to: '', subject: '', body: '', allowInvalidCert: false },
  'notify.notion':   { apiKey: '', databaseId: '', properties: '{"Tên": {"title": [{"text": {"content": "{{ $trigger.fromName }}"}}]}}' },
  // Trigger: payment
  'trigger.payment': { integrationId: '', minAmount: 0, descContains: '' },
  // Trigger: POS software webhook (services/integrations/posWebhook.ts), an empty field = no filter
  'trigger.posWebhook': { integrationType: 'all', integrationId: '', entity: 'order', eventContains: '', statusContains: '' },
  'trigger.webhook':   { webhookToken: '', secretKey: '', method: 'POST', allowedIps: '' },
  'trigger.api':       { eventName: '', requiredKeyId: '' },
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
  'nhanh.createOrder':       { order: '{"info":{"type":1},"channel":{"appOrderId":"","sourceName":"deplaoapp"},"shippingAddress":{"name":"","mobile":"","address":"","locationVersion":"v2"},"products":[{"id":0,"price":0,"quantity":1}]}' },
  'pancake.lookupCustomer':  { phone: '{{ $trigger.fromPhone }}' },
  'pancake.lookupOrder':     { phone: '{{ $trigger.fromPhone }}', orderId: '' },
  'pancake.lookupProduct':   { keyword: '{{ $trigger.content }}', code: '', limit: 10 },
  'pancake.createOrder':     { order: '{"bill_full_name":"","bill_phone_number":"","shipping_address":{"full_name":"","phone_number":"","address":""},"items":[{"variation_id":"","quantity":1}],"shipping_fee":0,"cod":0,"note":""}' },
  // Payment actions
  'payment.getTransactions': { integrationId: '', limit: 20 },
  // Shipping
  'ghn.createOrder':  { integrationId: '', toName: '', toPhone: '', toAddress: '', toWardName: '', toProvinceName: '', toDistrictName: '', toDistrictId: '', toWardCode: '', content: '', weight: 500, serviceTypeId: '2', codAmount: 0, requiredNote: 'CHOXEMHANGKHONGTHU', paymentTypeId: '1', order: '{}' },
  'ghn.getTracking':  { integrationId: '', orderCode: '' },
  'ghn.getProvinces': { integrationId: '' },
  'ghn.getDistricts': { integrationId: '', provinceId: '' },
  'ghn.getWards':     { integrationId: '', districtId: '' },
  'ghn.getServices':  { integrationId: '', fromDistrict: '', toDistrict: '' },
  'ghtk.createOrder': { integrationId: '', order: '{}' },
  'ghtk.getTracking': { integrationId: '', trackingCode: '' },
  // Facebook
  'fb.trigger.message':    { threadId: '', keyword: '', keywordMode: 'contains_any', threadType: 'all', ...THREAD_LISTS, ignoreOwn: true, onlyOwn: false, fromId: '', groupId: '', debounceSeconds: 0 },
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
  'fb.action.createPoll':  { threadId: '', question: '', options: tr('Có\nKhông') },
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
  'tg.sendPoll':        { chatId: '{{ $trigger.chatId }}', question: '', options: tr('Có\nKhông') },
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

/** Node labels of the enabled plugins (pluginNodes.ts fills them when the editor loads the list). */
export const PLUGIN_NODE_LABELS: Record<string, string> = {};

/** Get friendly Vietnamese label for a node type. Falls back to the raw type if not found. */
export function getNodeLabel(type: string): string {
  return NODE_LABEL_MAP[type] || PLUGIN_NODE_LABELS[type] || type;
}

export function nodeTypeGroup(type: string): string {
  // Channel triggers (fb.trigger.*, tg.trigger.*, tgbot.trigger.*) are triggers too, not actions
  if (type.startsWith('trigger.') || type.includes('.trigger.')) return 'trigger';
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
