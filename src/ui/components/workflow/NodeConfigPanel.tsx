import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { getNodeLabel } from './workflowConfig';
import GroupAvatar from '@/components/common/GroupAvatar';

// ─── Types ────────────────────────────────────────────────────────────────────

type FieldType = 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'json' | 'multiline' | 'cron' | 'html' | 'label-picker' | 'assistant-picker' | 'contact-picker' | 'file-picker';

interface SelectOption { value: string; label: string }

interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: SelectOption[];
  placeholder?: string;
  hint?: string;
  /** Mô tả rõ ràng cho newbie — hiển thị bên dưới ô nhập */
  desc?: string;
  /** Ẩn trong mục "Nâng cao" (collapsed mặc định) */
  advanced?: boolean;
  /** Biến gợi ý — click để chèn vào ô */
  templateVars?: string[];
  /** Key của field boolean dùng để bật HTML editor (vd: 'isHtml') */
  htmlToggle?: string;
  /**
   * Dùng khi type === 'label-picker':
   * - 'single'  = chọn 1 nhãn (Zalo giới hạn 1 nhãn / hội thoại)
   * - 'multi'   = chọn nhiều nhãn (Local)
   * - 'dynamic' = tự động: single khi labelSource='zalo', multi khi 'local'
   */
  labelMode?: 'single' | 'multi' | 'dynamic';
  /**
   * Dùng khi type === 'contact-picker':
   * - 'user'  = chỉ hiển thị liên hệ cá nhân
   * - 'group' = chỉ hiển thị nhóm
   * - 'all'   = hiển thị cả liên hệ và nhóm
   */
  contactType?: 'user' | 'group' | 'all';
  /**
   * Dùng khi type === 'file-picker':
   * - 'image' = chỉ chọn ảnh
   * - 'file'  = chọn mọi loại file
   */
  fileType?: 'image' | 'file';
  /** Ẩn field khi config[hideWhenKey] === hideWhenValue */
  hideWhenKey?: string;
  hideWhenValue?: string;
}

interface LoadedLabelOption {
  value: string;
  label: string;
  source: 'local' | 'zalo';
  color?: string;        // Label color hex
  textColor?: string;    // Text color for contrast
  emoji?: string;        // Emoji icon
  name?: string;         // Clean name without emoji
  pageIds?: string[];    // For local labels: which pages it's applied to
  pageId?: string;       // For zalo labels: which account it belongs to
  pageName?: string;     // Account display name
}

// ─── Cron helpers ─────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: '8h sáng mỗi ngày',  value: '0 8 * * *'    },
  { label: 'Mỗi giờ',           value: '0 * * * *'    },
  { label: 'Mỗi 30 phút',       value: '*/30 * * * *' },
  { label: 'Mỗi thứ Hai 8h',    value: '0 8 * * 1'    },
  { label: 'Đầu tháng 8h',      value: '0 8 1 * *'    },
  { label: 'Mỗi đêm 0h',        value: '0 0 * * *'    },
];

function cronToHuman(expr: string): string {
  const map: Record<string, string> = {
    '0 8 * * *':    'Mỗi ngày lúc 8:00 sáng',
    '0 * * * *':    'Mỗi giờ một lần',
    '*/30 * * * *': 'Mỗi 30 phút',
    '0 8 * * 1':    'Mỗi thứ Hai lúc 8:00',
    '0 8 1 * *':    'Ngày đầu tháng lúc 8:00',
    '0 0 * * *':    'Mỗi đêm lúc 0:00',
  };
  return map[expr.trim()] || '';
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const CONFIG_SCHEMA: Record<string, Field[]> = {
  'trigger.message': [
    {
      key: 'threadType', label: 'Nguồn tin nhắn', type: 'select',
      desc: 'Workflow sẽ lắng nghe tin nhắn từ đâu?',
      options: [
        { value: 'all', label: '📩 Tất cả (cá nhân + nhóm)' },
        { value: '0',   label: '👤 Chỉ tin nhắn cá nhân' },
        { value: '1',   label: '👥 Chỉ tin nhắn nhóm' },
      ],
    },
    {
      key: 'keyword', label: 'Từ khóa kích hoạt', type: 'text',
      placeholder: 'giá, báo giá, order',
      desc: 'Workflow chỉ chạy khi tin nhắn chứa một trong các từ khóa này. Nhập nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = mọi tin nhắn đều kích hoạt.',
    },
    {
      key: 'keywordMode', label: 'Cách khớp từ khóa', type: 'select',
      desc: 'Quy tắc áp dụng khi kiểm tra từ khóa trong tin nhắn.',
      options: [
        { value: 'contains_any', label: 'Chứa ít nhất 1 từ khóa (phổ biến nhất)' },
        { value: 'contains_all', label: 'Phải chứa đủ tất cả từ khóa' },
        { value: 'equals',       label: 'Khớp chính xác nguyên câu' },
        { value: 'starts_with',  label: 'Bắt đầu bằng từ khóa' },
        { value: 'regex',        label: '🔬 Regex — biểu thức chính quy (nâng cao)' },
      ],
    },
    {
      key: 'ignoreOwn', label: 'Bỏ qua tin nhắn do mình gửi', type: 'boolean',
      desc: 'Bật để tránh workflow tự kích hoạt khi tài khoản này tự gửi tin.',
    },
    {
      key: 'onlyOwn', label: 'Chỉ xử lý tin mình tự gửi', type: 'boolean',
      desc: 'Ngược lại — chỉ chạy với tin nhắn từ chính tài khoản này.',
    },
    {
      key: 'fromId', label: 'Chỉ nhận từ người dùng cụ thể', type: 'contact-picker', contactType: 'user',
      placeholder: 'Để trống = tất cả mọi người',
      desc: 'Chọn một người cụ thể. Để trống = nhận từ tất cả.',
      advanced: true,
    },
    {
      key: 'groupId', label: 'Chỉ nhận từ nhóm cụ thể', type: 'contact-picker', contactType: 'group',
      placeholder: 'Để trống = tất cả các nhóm',
      desc: 'Chọn một nhóm cụ thể. Để trống = nhận từ tất cả nhóm.',
      advanced: true,
    },
    {
      key: 'debounceSeconds', label: '⏳ Gom tin nhắn liên tiếp (giây)', type: 'number',
      placeholder: '0',
      desc: 'Chờ N giây sau tin nhắn cuối cùng rồi mới chạy workflow (gom tất cả tin nhắn liên tiếp thành 1 lần xử lý). 0 = chạy ngay mỗi tin. Khuyến nghị 10-15s khi dùng AI trả lời tự động, tránh AI phản hồi từng tin khi khách gõ liên tục.',
      advanced: true,
    },
  ],
  'trigger.friendRequest': [],
  'trigger.groupEvent': [
    {
      key: 'eventType', label: 'Sự kiện cần theo dõi', type: 'select',
      desc: 'Chọn loại sự kiện trong nhóm sẽ kích hoạt workflow.',
      options: [
        { value: 'all',           label: '🔔 Mọi sự kiện nhóm' },
        { value: 'join',          label: '➕ Thành viên mới tham gia' },
        { value: 'leave',         label: '➖ Thành viên tự rời nhóm' },
        { value: 'remove_member', label: '🚫 Thành viên bị xóa khỏi nhóm' },
        { value: 'update',        label: '✏️ Thông tin nhóm thay đổi' },
        { value: 'add_admin',     label: '⭐ Thêm quản trị viên mới' },
        { value: 'remove_admin',  label: '🔻 Xóa quyền quản trị viên' },
      ],
    },
    {
      key: 'groupId', label: 'Chỉ theo dõi nhóm cụ thể', type: 'contact-picker', contactType: 'group',
      placeholder: 'Để trống = theo dõi tất cả nhóm',
      desc: 'Chọn một nhóm để chỉ lắng nghe sự kiện từ nhóm đó.',
      advanced: true,
    },
  ],
  'trigger.reaction': [
    {
      key: 'reactionType', label: 'Loại cảm xúc', type: 'select',
      desc: 'Workflow chạy khi tin nhắn nhận được cảm xúc nào?',
      options: [
        { value: 'any', label: '💬 Bất kỳ cảm xúc nào' },
        { value: '1',   label: '👍 Like' },
        { value: '2',   label: '❤️ Yêu thích' },
        { value: '3',   label: '😂 Haha' },
        { value: '4',   label: '😮 Wow' },
        { value: '5',   label: '😢 Buồn' },
        { value: '6',   label: '😡 Giận' },
      ],
    },
    {
      key: 'threadId', label: 'Chỉ theo dõi hội thoại cụ thể', type: 'text',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'Nhập Thread ID nếu chỉ muốn theo dõi cảm xúc trong một hội thoại nhất định.',
      advanced: true,
    },
  ],
  'trigger.labelAssigned': [
    {
      key: 'action', label: 'Khi nào kích hoạt?', type: 'select',
      desc: 'Chọn thời điểm workflow chạy.',
      options: [
        { value: 'any',      label: '🔄 Cả khi gán và khi gỡ nhãn' },
        { value: 'assigned', label: '🏷️ Chỉ khi nhãn được gán vào' },
        { value: 'removed',  label: '🗑️ Chỉ khi nhãn bị gỡ ra' },
      ],
    },
    {
      key: 'labelSource', label: 'Nguồn nhãn', type: 'select',
      desc: 'Lọc theo loại Nhãn Local hay nhãn Zalo.',
      options: [
        { value: 'any',   label: '🔄 Cả Local và Zalo' },
        { value: 'local', label: '🏷️ Chỉ Nhãn Local' },
        { value: 'zalo',  label: '🏷️ Chỉ nhãn Zalo' },
      ],
    },
    {
      key: 'labelIds', label: 'Nhãn cần lọc', type: 'label-picker', labelMode: 'multi',
      desc: 'Để trống = kích hoạt với mọi nhãn. Có thể chọn nhiều nhãn — workflow chạy khi bất kỳ nhãn nào được gán/gỡ.',
    },
  ],
  'trigger.schedule': [
    {
      key: 'cronExpression', label: 'Lịch chạy tự động', type: 'cron',
      placeholder: '0 8 * * *',
      desc: 'Đặt lịch để workflow tự động chạy theo thời gian. Chọn mẫu có sẵn hoặc nhập tùy chỉnh.',
    },
    {
      key: 'timezone', label: 'Múi giờ', type: 'select',
      desc: 'Múi giờ dùng để tính thời gian chạy.',
      options: [
        { value: 'Asia/Ho_Chi_Minh', label: '🇻🇳 Việt Nam (UTC+7)' },
        { value: 'Asia/Bangkok',     label: '🇹🇭 Bangkok (UTC+7)' },
        { value: 'Asia/Singapore',   label: '🇸🇬 Singapore (UTC+8)' },
        { value: 'UTC',              label: '🌍 UTC (chuẩn quốc tế)' },
      ],
      advanced: true,
    },
  ],
  'zalo.sendMessage': [
    {
      key: 'message', label: 'Nội dung tin nhắn', type: 'textarea',
      placeholder: 'Xin chào {{ $trigger.fromName }}! Mình có thể giúp gì?',
      desc: 'Nội dung tin nhắn gửi đi. Dùng {{ }} để chèn dữ liệu động như tên người dùng.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'threadId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại nhận tin. Giữ mặc định để tự động reply lại người vừa nhắn.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      desc: 'Loại hội thoại đang gửi. Giữ "Tự động" để hệ thống tự nhận biết.',
      options: [
        { value: '{{ $trigger.threadType }}', label: '🔄 Tự động (theo trigger — khuyến nghị)' },
        { value: '0', label: '👤 Cá nhân' },
        { value: '1', label: '👥 Nhóm' },
      ],
      advanced: true,
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean',
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi tin nhắn này gửi lỗi.',
      advanced: true,
    },
  ],
  'zalo.sendTyping': [
    {
      key: 'threadId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại cần gửi sự kiện "đang gõ". Giữ mặc định để tự động nhận từ trigger.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      desc: 'Cá nhân (DM) hoặc nhóm. Chọn "Tự động" để lấy từ trigger.',
      options: [
        { value: '{{ $trigger.threadType }}', label: '🔄 Tự động (theo trigger — khuyến nghị)' },
        { value: '0', label: '👤 Cá nhân (DM)' },
        { value: '1', label: '👥 Nhóm' },
      ],
    },
    {
      key: 'delaySeconds', label: 'Chờ bao lâu trước bước tiếp', type: 'select',
      desc: 'Sau khi gửi "đang gõ", workflow sẽ dừng bấy nhiêu giây rồi mới chạy thẻ tiếp theo (thường là Gửi tin nhắn). Giúp tạo cảm giác tự nhiên như người thật đang soạn.',
      options: [
        { value: '1',  label: '⚡ 1 giây (nhanh)' },
        { value: '3',  label: '💬 3 giây (mặc định)' },
        { value: '5',  label: '✍️ 5 giây (soạn lâu hơn)' },
        { value: '10', label: '🕐 10 giây (rất lâu)' },
      ],
    },
  ],
  'zalo.sendImage': [
    {
      key: 'filePath', label: 'Ảnh cần gửi', type: 'file-picker', fileType: 'image',
      placeholder: 'C:\\Images\\banner.jpg  hoặc  https://example.com/img.png',
      desc: 'Chọn ảnh từ máy tính hoặc nhập link URL ảnh trực tiếp (https://...).',
    },
    {
      key: 'message', label: 'Chú thích ảnh (tuỳ chọn)', type: 'text',
      placeholder: 'Đây là bảng giá mới nhất!',
      desc: 'Dòng chữ hiển thị kèm ảnh. Có thể để trống.',
    },
    {
      key: 'threadId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại nhận ảnh.', templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      desc: 'Loại hội thoại đang gửi.',
      options: [
        { value: '{{ $trigger.threadType }}', label: '🔄 Tự động (theo trigger)' },
        { value: '0', label: '👤 Cá nhân' }, { value: '1', label: '👥 Nhóm' },
      ],
      advanced: true,
    },
  ],
  'zalo.sendFile': [
    {
      key: 'filePath', label: 'File cần gửi', type: 'file-picker', fileType: 'file',
      placeholder: 'C:\\Documents\\BangGia.pdf',
      desc: 'Chọn file từ máy tính để gửi.',
    },
    {
      key: 'threadId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại nhận file.', templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      desc: 'Loại hội thoại đang gửi.',
      options: [
        { value: '{{ $trigger.threadType }}', label: '🔄 Tự động (theo trigger)' },
        { value: '0', label: '👤 Cá nhân' }, { value: '1', label: '👥 Nhóm' },
      ],
      advanced: true,
    },
  ],
  'zalo.findUser': [
    {
      key: 'phone', label: 'Số điện thoại cần tìm', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}  hoặc  0901234567',
      desc: 'Nhập số điện thoại để tìm tài khoản Zalo. Kết quả chứa User ID để dùng ở bước sau.',
      templateVars: ['$trigger.fromPhone'],
    },
  ],
  'zalo.getUserInfo': [
    {
      key: 'userId', label: 'User ID cần lấy thông tin', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.fromId }}',
      desc: 'ID người dùng Zalo. Kết quả gồm tên, avatar, giới tính... dùng được ở các bước sau.',
      templateVars: ['$trigger.fromId', '$trigger.userId'],
    },
  ],
  'zalo.acceptFriendRequest': [
    {
      key: 'userId', label: 'Chấp nhận kết bạn từ', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: 'User ID người gửi lời mời. Thường dùng {{ $trigger.userId }} khi kết hợp trigger "Lời mời kết bạn".',
      templateVars: ['$trigger.userId'],
    },
  ],
  'zalo.rejectFriendRequest': [
    {
      key: 'userId', label: 'Từ chối kết bạn từ', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: 'User ID của người gửi lời mời kết bạn cần từ chối.',
      templateVars: ['$trigger.userId'],
    },
  ],
  'zalo.sendFriendRequest': [
    {
      key: 'userId', label: 'Gửi lời mời đến User ID', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $node.FindUser.userId }}',
      desc: 'User ID người muốn kết bạn. Thường lấy từ bước "Tìm user theo SĐT" phía trước.',
      templateVars: ['$node.FindUser.userId'],
    },
    {
      key: 'message', label: 'Lời nhắn kèm theo', type: 'text',
      placeholder: 'Mình là X, muốn kết bạn để trao đổi thêm!',
      desc: 'Nội dung hiển thị kèm theo lời mời. Nên giới thiệu bản thân ngắn gọn.',
    },
  ],
  'zalo.addToGroup': [
    {
      key: 'userId', label: 'Thêm người dùng', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: 'User ID của người muốn thêm vào nhóm.',
      templateVars: ['$trigger.userId', '$trigger.fromId'],
    },
    {
      key: 'groupId', label: 'Vào nhóm (Group ID)', type: 'contact-picker', contactType: 'group',
      placeholder: 'ID nhóm Zalo',
      desc: 'ID nhóm Zalo đích. Xem Group ID trong phần thông tin nhóm.',
    },
  ],
  'zalo.removeFromGroup': [
    {
      key: 'userId', label: 'Xóa người dùng', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: 'User ID của thành viên cần xóa khỏi nhóm.',
      templateVars: ['$trigger.userId'],
    },
    {
      key: 'groupId', label: 'Khỏi nhóm (Group ID)', type: 'contact-picker', contactType: 'group',
      placeholder: 'ID nhóm Zalo',
      desc: 'ID của nhóm Zalo cần xóa thành viên.',
    },
  ],
  'zalo.setMute': [
    {
      key: 'action', label: 'Hành động', type: 'select',
      desc: 'Tắt hoặc bật lại thông báo cho hội thoại.',
      options: [
        { value: 'mute',   label: '🔕 Tắt thông báo' },
        { value: 'unmute', label: '🔔 Bật lại thông báo' },
      ],
    },
    {
      key: 'duration', label: 'Thời gian tắt (giây)', type: 'number',
      desc: 'Tắt thông báo trong bao lâu. Nhập 0 để tắt vĩnh viễn.',
      hint: '3600 = 1 giờ  •  86400 = 1 ngày  •  0 = mãi mãi',
    },
    {
      key: 'threadId', label: 'ID hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại cần tắt thông báo.', templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      options: [
        { value: '{{ $trigger.threadType }}', label: '🔄 Tự động (theo trigger)' },
        { value: '0', label: '👤 Cá nhân' }, { value: '1', label: '👥 Nhóm' },
      ],
      advanced: true,
    },
  ],
  'zalo.forwardMessage': [
    {
      key: 'msgId', label: 'Tin nhắn cần chuyển tiếp', type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: 'ID tin nhắn muốn chuyển tiếp. Dùng {{ $trigger.msgId }} để chuyển tiếp tin nhắn vừa nhận.',
      templateVars: ['$trigger.msgId'],
    },
    {
      key: 'toThreadId', label: 'Chuyển đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: 'ID hội thoại đích',
      desc: 'ID hội thoại nơi tin nhắn sẽ được chuyển đến.',
    },
    {
      key: 'toThreadType', label: 'Loại hội thoại đích', type: 'select',
      options: [{ value: '0', label: '👤 Cá nhân' }, { value: '1', label: '👥 Nhóm' }],
      advanced: true,
    },
  ],
  'zalo.undoMessage': [
    {
      key: 'msgId', label: 'Tin nhắn cần thu hồi', type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: 'ID tin nhắn muốn thu hồi (xóa khỏi cả hai phía cuộc trò chuyện).',
      templateVars: ['$trigger.msgId'],
    },
    {
      key: 'threadId', label: 'Thuộc hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại chứa tin nhắn cần thu hồi.', templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      options: [{ value: '0', label: '👤 Cá nhân' }, { value: '1', label: '👥 Nhóm' }],
      advanced: true,
    },
  ],
  'zalo.createPoll': [
    {
      key: 'question', label: 'Câu hỏi bình chọn', type: 'text',
      placeholder: 'Bạn thích sản phẩm nào nhất?',
      desc: 'Nội dung câu hỏi hiển thị trong poll.',
    },
    {
      key: 'options', label: 'Các lựa chọn', type: 'multiline',
      placeholder: 'Sản phẩm A\nSản phẩm B\nSản phẩm C',
      desc: 'Mỗi dòng là một lựa chọn. Nhập ít nhất 2 lựa chọn.',
    },
    {
      key: 'allowMultiple', label: 'Cho phép chọn nhiều đáp án', type: 'boolean',
      desc: 'Bật để thành viên có thể tick nhiều lựa chọn cùng lúc.',
    },
    {
      key: 'groupId', label: 'Đăng trong nhóm (Group ID)', type: 'contact-picker', contactType: 'group',
      placeholder: 'ID nhóm Zalo', desc: 'ID nhóm nơi poll sẽ được tạo.', advanced: true,
    },
    {
      key: 'expireTime', label: 'Thời gian kết thúc (giây)', type: 'number',
      desc: 'Poll tự đóng sau bao nhiêu giây. Nhập 0 để không giới hạn.',
      hint: '86400 = 1 ngày  •  604800 = 1 tuần  •  0 = không giới hạn',
      advanced: true,
    },
  ],
  'zalo.getMessageHistory': [
    {
      key: 'count', label: 'Số tin nhắn cần lấy', type: 'number',
      desc: 'Lấy bao nhiêu tin nhắn gần nhất từ hội thoại (tối đa thường là 50).',
    },
    {
      key: 'threadId', label: 'Lịch sử của hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại cần lấy lịch sử. Kết quả dùng được ở các bước sau.',
      templateVars: ['$trigger.threadId'], advanced: true,
    },
  ],
  'zalo.addReaction': [
    {
      key: 'reactionType', label: 'Loại cảm xúc', type: 'select',
      desc: 'Cảm xúc sẽ được thêm vào tin nhắn.',
      options: [
        { value: '1', label: '👍 Like' }, { value: '2', label: '❤️ Yêu thích' },
        { value: '3', label: '😂 Haha' }, { value: '4', label: '😮 Wow' },
        { value: '5', label: '😢 Buồn' }, { value: '6', label: '😡 Giận' },
      ],
    },
    {
      key: 'msgId', label: 'Tin nhắn cần react', type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: 'ID tin nhắn muốn thêm cảm xúc.',
      templateVars: ['$trigger.msgId'], advanced: true,
    },
  ],
  'zalo.assignLabel': [
    {
      key: 'labelSource', label: 'Loại nhãn', type: 'select',
      desc: 'Chọn Nhãn Local (quản lý trong CRM) hoặc nhãn Zalo (đồng bộ với ứng dụng Zalo).',
      options: [
        { value: 'local', label: '🏷️ Nhãn Local (quản lý trong app)' },
        { value: 'zalo',  label: '🏷️ Nhãn Zalo (đồng bộ Zalo)' },
      ],
    },
    {
      key: 'labelIds', label: 'Chọn nhãn cần gắn', type: 'label-picker', labelMode: 'dynamic',
      desc: 'Nhãn Zalo: chỉ được gắn 1 nhãn mỗi hội thoại. Nhãn Local: có thể chọn nhiều nhãn cùng lúc.',
    },
    {
      key: 'threadId', label: 'Gắn nhãn cho hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại cần gắn nhãn. Giữ mặc định để gắn cho hội thoại đang xử lý.',
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'zalo.removeLabel': [
    {
      key: 'labelSource', label: 'Loại nhãn', type: 'select',
      desc: 'Chọn loại nhãn cần gỡ.',
      options: [
        { value: 'local', label: '🏷️ Nhãn Local (quản lý trong app)' },
        { value: 'zalo',  label: '🏷️ Nhãn Zalo (đồng bộ Zalo)' },
      ],
    },
    {
      key: 'labelIds', label: 'Chọn nhãn cần gỡ', type: 'label-picker', labelMode: 'dynamic',
      desc: 'Nhãn Zalo: chỉ gỡ 1 nhãn mỗi lần. Nhãn Local: có thể gỡ nhiều nhãn cùng lúc.',
    },
    {
      key: 'threadId', label: 'Gỡ nhãn khỏi hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại cần gỡ nhãn.',
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'logic.if': [
    {
      key: 'left', label: 'Giá trị cần kiểm tra', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Giá trị bên trái để so sánh. Thường là nội dung tin nhắn hoặc một biến đã lưu.',
      templateVars: ['$trigger.content', '$trigger.fromName', '$trigger.fromId'],
    },
    {
      key: 'operator', label: 'Điều kiện so sánh', type: 'select',
      desc: 'Quy tắc so sánh giữa hai giá trị.',
      options: [
        { value: 'contains',     label: '⊇ Có chứa chuỗi' },
        { value: 'not_contains', label: '⊅ Không chứa chuỗi' },
        { value: 'equals',       label: '= Bằng chính xác' },
        { value: 'not_equals',   label: '≠ Khác' },
        { value: 'starts_with',  label: '↳ Bắt đầu bằng' },
        { value: 'ends_with',    label: '↲ Kết thúc bằng' },
        { value: 'greater_than', label: '> Lớn hơn (số)' },
        { value: 'less_than',    label: '< Nhỏ hơn (số)' },
        { value: 'is_empty',     label: '○ Rỗng / trống' },
        { value: 'not_empty',    label: '● Không rỗng' },
        { value: 'regex',        label: '🔬 Regex (nâng cao)' },
      ],
    },
    {
      key: 'right', label: 'So sánh với giá trị', type: 'text',
      placeholder: 'Nhập từ khóa hoặc giá trị cần so sánh',
      desc: 'Giá trị bên phải. Ví dụ: nếu trái là nội dung tin nhắn thì phải là từ khóa cần tìm.',
    },
  ],
  'logic.switch': [
    {
      key: 'value', label: 'Giá trị để phân nhánh', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Giá trị này sẽ được so sánh với từng case để quyết định chạy nhánh nào.',
      templateVars: ['$trigger.content', '$trigger.fromId'],
    },
    {
      key: 'cases', label: 'Danh sách các nhánh', type: 'json',
      hint: '[{"match":"xin chào","label":"case_chao"},{"match":"giá","label":"case_gia"}]',
      desc: 'Mỗi case có "match" (giá trị khớp) và "label" (tên nhánh). Nhánh đúng sẽ được chạy.',
    },
    {
      key: 'defaultLabel', label: 'Nhánh mặc định (không khớp case nào)', type: 'text',
      placeholder: 'default',
      desc: 'Nếu không có case nào khớp, workflow chạy theo nhánh có tên này.',
      advanced: true,
    },
  ],
  'logic.wait': [
    {
      key: 'delaySeconds', label: 'Thời gian chờ (giây)', type: 'number',
      desc: 'Tạm dừng workflow trước khi tiếp tục bước tiếp theo.',
      hint: '5 = 5 giây  •  60 = 1 phút  •  3600 = 1 giờ',
    },
  ],
  'logic.setVariable': [
    {
      key: 'name', label: 'Tên biến', type: 'text',
      placeholder: 'tenKhachHang',
      desc: 'Đặt tên cho biến (không dấu, không khoảng trắng). Dùng ở bước sau: {{ $var.tenKhachHang }}',
    },
    {
      key: 'value', label: 'Giá trị lưu vào biến', type: 'text',
      placeholder: '{{ $trigger.fromName }}',
      desc: 'Giá trị sẽ được lưu. Có thể là text cố định hoặc dữ liệu động từ trigger/node khác.',
      templateVars: ['$trigger.fromName', '$trigger.fromId', '$trigger.content'],
    },
  ],
  'logic.stopIf': [
    {
      key: 'left', label: 'Giá trị kiểm tra', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Nếu điều kiện này đúng → workflow dừng ngay tại đây, không chạy tiếp.',
      templateVars: ['$trigger.content', '$trigger.fromId'],
    },
    {
      key: 'operator', label: 'Điều kiện để dừng', type: 'select',
      desc: 'Nếu thoả mãn điều kiện này, workflow sẽ dừng.',
      options: [
        { value: 'equals',       label: '= Bằng' }, { value: 'not_equals',   label: '≠ Khác' },
        { value: 'contains',     label: '⊇ Có chứa' }, { value: 'not_contains', label: '⊅ Không chứa' },
        { value: 'is_empty',     label: '○ Rỗng' }, { value: 'not_empty',    label: '● Không rỗng' },
      ],
    },
    {
      key: 'right', label: 'So sánh với', type: 'text',
      placeholder: 'giá trị so sánh',
      desc: 'Giá trị dùng để so sánh với bên trái.',
    },
  ],
  'logic.forEach': [
    {
      key: 'array', label: 'Danh sách cần lặp qua', type: 'text',
      placeholder: '{{ $node.GetHistory.messages }}',
      desc: 'Một mảng dữ liệu. Workflow lặp qua từng phần tử và chạy các bước tiếp theo cho mỗi phần tử.',
      templateVars: ['$node.GetHistory.messages'],
    },
    {
      key: 'itemVariable', label: 'Tên biến cho từng phần tử', type: 'text',
      placeholder: 'item',
      desc: 'Trong mỗi vòng lặp, phần tử hiện tại lưu vào biến này. Dùng {{ $var.item }} ở bước trong vòng lặp.',
    },
  ],
  'data.textFormat': [
    {
      key: 'template', label: 'Mẫu nội dung', type: 'textarea',
      placeholder: 'Xin chào {{ $trigger.fromName }}!\nHôm nay là {{ $date.today }}.',
      desc: 'Soạn nội dung với biến động. Dùng {{ }} để chèn dữ liệu từ trigger hoặc bước trước.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$date.today', '$date.now'],
    },
  ],
  'data.randomPick': [
    {
      key: 'options', label: 'Danh sách nội dung', type: 'multiline',
      placeholder: 'Xin chào bạn!\nChào mừng đến với shop!\nHi! Mình có thể giúp gì?',
      desc: 'Mỗi dòng là một lựa chọn. Hệ thống chọn ngẫu nhiên 1 nội dung mỗi lần chạy — giúp câu trả lời không bị lặp.',
    },
  ],
  'data.dateFormat': [
    {
      key: 'format', label: 'Định dạng hiển thị ngày giờ', type: 'select',
      desc: 'Chọn cách hiển thị ngày giờ trong kết quả.',
      options: [
        { value: 'datetime', label: '📅 Ngày + Giờ   (25/03/2026 14:30)' },
        { value: 'date',     label: '📆 Chỉ ngày      (25/03/2026)' },
        { value: 'time',     label: '🕐 Chỉ giờ       (14:30)' },
        { value: 'full',     label: '🗓️ Đầy đủ        (Thứ Tư, 25/3/2026)' },
      ],
    },
    {
      key: 'date', label: 'Ngày giờ cần format', type: 'text',
      placeholder: 'Để trống = lấy thời gian hiện tại',
      desc: 'Nhập timestamp hoặc để trống để dùng thời gian hiện tại.',
      templateVars: ['$trigger.timestamp'], advanced: true,
    },
  ],
  'data.jsonParse': [
    {
      key: 'input', label: 'Chuỗi JSON cần đọc', type: 'text',
      placeholder: '{{ $node.HttpRequest.responseBody }}',
      desc: 'Chuyển chuỗi JSON thành object để đọc các trường bên trong. Thường dùng sau bước "HTTP Request".',
      templateVars: ['$node.HttpRequest.responseBody'],
    },
  ],
  'output.httpRequest': [
    {
      key: 'url', label: 'Địa chỉ API (URL)', type: 'text',
      placeholder: 'https://api.example.com/webhook',
      desc: 'Địa chỉ URL của API hoặc webhook cần gọi. Phải bắt đầu bằng https:// hoặc http://',
    },
    {
      key: 'method', label: 'Phương thức gửi', type: 'select',
      desc: 'Cách gửi dữ liệu. POST = gửi dữ liệu lên, GET = lấy dữ liệu về.',
      options: [
        { value: 'POST',   label: 'POST — Gửi dữ liệu (phổ biến nhất cho webhook)' },
        { value: 'GET',    label: 'GET — Lấy dữ liệu từ server' },
        { value: 'PUT',    label: 'PUT — Cập nhật toàn bộ dữ liệu' },
        { value: 'PATCH',  label: 'PATCH — Cập nhật một phần' },
        { value: 'DELETE', label: 'DELETE — Xóa dữ liệu' },
      ],
    },
    {
      key: 'body', label: 'Dữ liệu gửi kèm (Body)', type: 'textarea',
      placeholder: '{\n  "name": "{{ $trigger.fromName }}",\n  "msg": "{{ $trigger.content }}"\n}',
      desc: 'Nội dung gửi kèm (định dạng JSON). Dùng {{ }} để chèn dữ liệu động. Chỉ cần điền khi dùng POST/PUT/PATCH.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: 'Tiếp tục dù gọi API thất bại', type: 'boolean',
      desc: 'Bật nếu muốn workflow vẫn chạy tiếp dù API trả về lỗi.',
    },
    {
      key: 'headers', label: 'Headers (xác thực / nâng cao)', type: 'textarea',
      placeholder: '{"Authorization": "Bearer your-token"}',
      desc: 'HTTP Headers gửi kèm. Thường dùng để xác thực (Authorization token). Để trống nếu không cần.',
      hint: 'Ví dụ: {"Authorization": "Bearer abc123", "Content-Type": "application/json"}',
      advanced: true,
    },
    {
      key: 'timeout', label: 'Timeout (mili-giây)', type: 'number',
      desc: 'Nếu API không phản hồi sau thời gian này sẽ bị coi là lỗi. Mặc định 30000 = 30 giây.',
      advanced: true,
    },
  ],
  'output.log': [
    {
      key: 'message', label: 'Nội dung cần ghi log', type: 'text',
      placeholder: 'Đã nhận tin từ {{ $trigger.fromName }}: {{ $trigger.content }}',
      desc: 'Nội dung ghi vào lịch sử chạy để debug. Hữu ích khi cần kiểm tra dữ liệu ở giữa workflow.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId'],
    },
    {
      key: 'level', label: 'Mức độ log', type: 'select',
      desc: 'Phân loại mức độ thông điệp.',
      options: [
        { value: 'info',  label: 'ℹ️ Info — Thông tin bình thường' },
        { value: 'warn',  label: '⚠️ Warn — Cảnh báo cần chú ý' },
        { value: 'error', label: '❌ Error — Lỗi nghiêm trọng' },
      ],
    },
  ],

  // ── Google Sheets ────────────────────────────────────────────────────────

  'sheets.appendRow': [
    {
      key: 'spreadsheetId', label: 'ID bảng tính (Spreadsheet ID)', type: 'text',
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      desc: 'Lấy từ URL của Google Sheet: docs.google.com/spreadsheets/d/[ ID NÀY ]/edit',
    },
    {
      key: 'sheetName', label: 'Tên trang tính (Sheet)', type: 'text',
      placeholder: 'Sheet1',
      desc: 'Tên tab trang tính cần ghi dữ liệu vào. Mặc định là "Sheet1".',
    },
    {
      key: 'values', label: 'Dữ liệu cần ghi (mảng JSON)', type: 'textarea',
      placeholder: '["{{ $trigger.fromName }}", "{{ $trigger.content }}", "{{ $date.today }}"]',
      desc: 'Mỗi phần tử trong mảng là một ô trong hàng mới. Dùng {{ }} để chèn dữ liệu động.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.today', '$date.now'],
    },
    {
      key: 'serviceAccountPath', label: 'Đường dẫn file Service Account JSON', type: 'text',
      placeholder: 'C:\\credentials\\google-service-account.json',
      desc: 'Tải file JSON từ Google Cloud Console → Service Accounts → Keys. Chia sẻ sheet với email trong file JSON đó.',
    },
  ],

  'sheets.readValues': [
    {
      key: 'spreadsheetId', label: 'ID bảng tính (Spreadsheet ID)', type: 'text',
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      desc: 'Lấy từ URL của Google Sheet: docs.google.com/spreadsheets/d/[ ID NÀY ]/edit',
    },
    {
      key: 'range', label: 'Vùng dữ liệu cần đọc', type: 'text',
      placeholder: 'Sheet1!A1:E100',
      desc: 'Phạm vi ô cần đọc theo cú pháp TênSheet!CộtDòng. Ví dụ: Sheet1!A1:E100 đọc 100 dòng đầu.',
      hint: 'Sheet1!A:D = toàn bộ cột A đến D  •  Sheet1!A2:E = bỏ qua hàng tiêu đề',
    },
    {
      key: 'serviceAccountPath', label: 'Đường dẫn file Service Account JSON', type: 'text',
      placeholder: 'C:\\credentials\\google-service-account.json',
      desc: 'File xác thực Google Cloud. Kết quả đọc được lưu vào output.rows để dùng ở bước sau.',
    },
  ],

  'sheets.updateCell': [
    {
      key: 'spreadsheetId', label: 'ID bảng tính (Spreadsheet ID)', type: 'text',
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      desc: 'Lấy từ URL của Google Sheet.',
    },
    {
      key: 'range', label: 'Vị trí ô cần cập nhật', type: 'text',
      placeholder: 'Sheet1!B2',
      desc: 'Ô cụ thể cần ghi giá trị. Ví dụ: Sheet1!B2 = sheet "Sheet1", cột B, dòng 2.',
    },
    {
      key: 'value', label: 'Giá trị mới', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Giá trị sẽ được ghi vào ô. Có thể là text cố định hoặc biến động.',
      templateVars: ['$trigger.content', '$trigger.fromName', '$date.today'],
    },
    {
      key: 'serviceAccountPath', label: 'Đường dẫn file Service Account JSON', type: 'text',
      placeholder: 'C:\\credentials\\google-service-account.json',
      desc: 'File xác thực Google Cloud.',
    },
  ],

  // ── AI & Đa nền tảng ─────────────────────────────────────────────────────

  'ai.generateText': [
    {
      key: 'aiConfigMode', label: 'Cách cấu hình AI', type: 'select',
      desc: 'Chọn trợ lý đã tạo sẵn (nhanh, tiện) hoặc tự nhập API key & model thủ công.',
      options: [
        { value: 'assistant', label: '🤖 Chọn trợ lý AI đã tạo' },
        { value: 'manual',    label: '⚙️ Cài đặt thủ công (API key, model...)' },
      ],
    },
    {
      key: 'assistantId', label: '🤖 Chọn trợ lý AI', type: 'assistant-picker',
      desc: 'Chọn trợ lý đã tạo trong Tích hợp → Trợ lý AI. Sẽ dùng API key, model, system prompt từ trợ lý đó.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'manual',
    },
    {
      key: 'platform', label: 'Nền tảng AI', type: 'select',
      desc: 'Chọn nhà cung cấp AI. Mỗi nền tảng cần API key riêng.',
      options: [
        { value: 'openai',   label: '🤖 OpenAI (ChatGPT)' },
        { value: 'gemini',   label: '💎 Google Gemini' },
        { value: 'claude',   label: '🟠 Anthropic Claude' },
        { value: 'deepseek', label: '🔮 Deepseek' },
        { value: 'grok',     label: '⚡ Grok (xAI)' },
        { value: 'mistral',  label: '🌀 Mistral AI' },
      ],
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'apiKey', label: 'API Key', type: 'text',
      placeholder: 'sk-proj-... / AIza... / sk-ant-... / sk-...',
      desc: 'API key của nền tảng đã chọn. OpenAI: platform.openai.com | Gemini: aistudio.google.com | Claude: console.anthropic.com | Deepseek: platform.deepseek.com | Grok: console.x.ai | Mistral: console.mistral.ai',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'systemPrompt', label: 'Ngữ cảnh / Vai trò của AI', type: 'textarea',
      placeholder: 'Bạn là nhân viên tư vấn bán hàng của shop [TÊN]. Trả lời ngắn gọn, thân thiện.',
      desc: 'Mô tả vai trò và phong cách trả lời của AI. Không hiển thị với người dùng.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'prompt', label: 'Câu hỏi / Yêu cầu cho AI', type: 'textarea',
      placeholder: 'Khách hỏi: {{ $trigger.content }}\n\nHãy trả lời ngắn gọn, thân thiện bằng tiếng Việt.',
      desc: 'Nội dung gửi đến AI để nhận câu trả lời. Dùng {{ }} để chèn tin nhắn từ khách hàng.',
      templateVars: ['$trigger.content', '$trigger.fromName', '$trigger.fromId'],
    },
    {
      key: 'chatHistory', label: 'Lịch sử chat (cho AI nhớ ngữ cảnh)', type: 'textarea',
      placeholder: '{{ $node.GetHistory.messages }}',
      desc: 'Truyền lịch sử hội thoại để AI nhớ ngữ cảnh. Có thể là mảng JSON [{role:"user",content:"..."},...] hoặc lịch sử Zalo từ node "Lấy lịch sử tin nhắn". Để trống nếu không cần nhớ ngữ cảnh.',
      templateVars: ['$node.GetHistory.messages'],
    },
    {
      key: 'maxHistoryMessages', label: 'Số tin nhắn lịch sử tối đa', type: 'number',
      desc: 'Giới hạn bao nhiêu tin nhắn lịch sử được gửi kèm (để tiết kiệm token). Mặc định 10.',
      advanced: true,
    },
    {
      key: 'model', label: 'Model AI', type: 'select',
      desc: 'Chọn model AI. Danh sách bao gồm tất cả các nền tảng — chọn model phù hợp với nền tảng đã chọn ở trên.',
      options: [
        // OpenAI
        { value: 'gpt-5.4',          label: '🤖 GPT-5.4 — Flagship mới nhất (OpenAI)' },
        { value: 'gpt-5.4-pro',      label: '🤖 GPT-5.4 Pro — Thông minh nhất (OpenAI)' },
        { value: 'gpt-5.4-mini',     label: '🤖 GPT-5.4 Mini — Code, subagent (OpenAI — khuyến nghị)' },
        { value: 'gpt-5.4-nano',     label: '🤖 GPT-5.4 Nano — Siêu rẻ (OpenAI)' },
        { value: 'gpt-5-mini',       label: '🤖 GPT-5 Mini — Cân bằng, giá tốt (OpenAI)' },
        { value: 'gpt-5-nano',       label: '🤖 GPT-5 Nano — Nhanh, rẻ nhất (OpenAI)' },
        { value: 'gpt-5',            label: '🤖 GPT-5 — Lý luận mạnh (OpenAI)' },
        { value: 'o4-mini',          label: '🤖 o4-mini — Lý luận nhanh (OpenAI)' },
        { value: 'o3',               label: '🤖 o3 — Lý luận mạnh (OpenAI)' },
        { value: 'gpt-4.1',          label: '🤖 GPT-4.1 — Legacy non-reasoning (OpenAI)' },
        // Gemini
        { value: 'gemini-3.1-pro',   label: '💎 Gemini 3.1 Pro — Mạnh nhất (Google — khuyến nghị)' },
        { value: 'gemini-3.1-flash', label: '💎 Gemini 3.1 Flash — Nhanh (Google)' },
        { value: 'gemini-3.0-flash', label: '💎 Gemini 3.0 Flash — Rẻ (Google)' },
        { value: 'gemini-3.0-flash-lite', label: '💎 Gemini 3.0 Flash Lite — Siêu rẻ (Google)' },
        { value: 'gemini-2.5-pro',   label: '💎 Gemini 2.5 Pro — Legacy ổn định (Google)' },
        // Claude (Anthropic)
        { value: 'claude-4.6-sonnet-20260301',  label: '🟠 Claude 4.6 Sonnet — Mới nhất (Anthropic — khuyến nghị)' },
        { value: 'claude-4.5-sonnet-20260115',  label: '🟠 Claude 4.5 Sonnet — Cân bằng (Anthropic)' },
        { value: 'claude-4.0-haiku-20260101',   label: '🟠 Claude 4.0 Haiku — Nhanh, rẻ (Anthropic)' },
        { value: 'claude-4.0-opus-20260101',    label: '🟠 Claude 4.0 Opus — Mạnh nhất gen 4 (Anthropic)' },
        { value: 'claude-sonnet-4-20250514',    label: '🟠 Claude Sonnet 4 — Legacy (Anthropic)' },
        // Deepseek
        { value: 'deepseek-chat-v3.2',    label: '🔮 Deepseek V3.2 — Mới nhất (Deepseek — khuyến nghị)' },
        { value: 'deepseek-chat-v3.1',    label: '🔮 Deepseek V3.1 — Cân bằng (Deepseek)' },
        { value: 'deepseek-reasoner-r1.5',label: '🔮 Deepseek R1.5 — Lý luận mới nhất (Deepseek)' },
        { value: 'deepseek-reasoner',     label: '🔮 Deepseek R1 — Lý luận ổn định (Deepseek)' },
        // Grok
        { value: 'grok-4-fast',      label: '⚡ Grok 4 Fast — Nhanh (xAI — khuyến nghị)' },
        { value: 'grok-4',           label: '⚡ Grok 4 — Flagship (xAI)' },
        { value: 'grok-4-mini',      label: '⚡ Grok 4 Mini — Lý luận, rẻ (xAI)' },
        { value: 'grok-4-mini-fast', label: '⚡ Grok 4 Mini Fast — Siêu nhanh (xAI)' },
        { value: 'grok-3',           label: '⚡ Grok 3 — Legacy ổn định (xAI)' },
        // Mistral
        { value: 'mistral-large-2-latest',  label: '🌀 Mistral Large 2 — Mạnh nhất (Mistral — khuyến nghị)' },
        { value: 'codestral-2-latest',      label: '🌀 Codestral 2 — Code chuyên dụng (Mistral)' },
        { value: 'mistral-small-3-latest',  label: '🌀 Mistral Small 3 — Nhanh, rẻ (Mistral)' },
        { value: 'mistral-medium-latest',   label: '🌀 Mistral Medium — Cân bằng (Mistral)' },
        { value: 'open-mistral-nemo-2',     label: '🌀 Mistral Nemo 2 — Nhẹ (Mistral)' },
      ],
      advanced: true,
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'maxTokens', label: 'Độ dài tối đa (tokens)', type: 'number',
      desc: 'Giới hạn độ dài câu trả lời. 1 token ≈ 0.75 từ. 300 = ~200 từ là đủ cho chat.',
      advanced: true,
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'temperature', label: 'Mức độ sáng tạo (0.0 – 1.0)', type: 'number',
      desc: '0 = trả lời chính xác, ổn định. 1 = sáng tạo, đa dạng hơn. Khuyến nghị 0.7 cho chat bán hàng.',
      advanced: true,
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
  ],

  'ai.classify': [
    {
      key: 'aiConfigMode', label: 'Cách cấu hình AI', type: 'select',
      desc: 'Chọn trợ lý đã tạo sẵn (nhanh, tiện) hoặc tự nhập API key & model thủ công.',
      options: [
        { value: 'assistant', label: '🤖 Chọn trợ lý AI đã tạo' },
        { value: 'manual',    label: '⚙️ Cài đặt thủ công (API key, model...)' },
      ],
    },
    {
      key: 'assistantId', label: '🤖 Chọn trợ lý AI', type: 'assistant-picker',
      desc: 'Chọn trợ lý đã tạo trong Tích hợp → Trợ lý AI. Sẽ dùng API key, model, system prompt từ trợ lý đó.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'manual',
    },
    {
      key: 'platform', label: 'Nền tảng AI', type: 'select',
      desc: 'Chọn nhà cung cấp AI.',
      options: [
        { value: 'openai',   label: '🤖 OpenAI (ChatGPT)' },
        { value: 'gemini',   label: '💎 Google Gemini' },
        { value: 'claude',   label: '🟠 Anthropic Claude' },
        { value: 'deepseek', label: '🔮 Deepseek' },
        { value: 'grok',     label: '⚡ Grok (xAI)' },
        { value: 'mistral',  label: '🌀 Mistral AI' },
      ],
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'input', label: 'Văn bản cần phân loại', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Nội dung tin nhắn cần được AI phân loại.',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'categories', label: 'Danh sách danh mục', type: 'text',
      placeholder: 'hỏi giá, đặt hàng, khiếu nại, hỏi thông tin, khác',
      desc: 'Các danh mục cách nhau bằng dấu phẩy. AI sẽ trả về tên một danh mục phù hợp nhất. Kết quả lưu vào output.category.',
    },
    {
      key: 'apiKey', label: 'API Key', type: 'text',
      placeholder: 'sk-proj-... / AIza... / sk-ant-... / sk-...',
      desc: 'API key của nền tảng đã chọn.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'model', label: 'Model AI', type: 'select',
      desc: 'Chọn model phù hợp với nền tảng đã chọn ở trên.',
      options: [
        { value: 'gpt-5.4-mini',     label: '🤖 GPT-5.4 Mini — Code, subagent (OpenAI)' },
        { value: 'gpt-5-mini',       label: '🤖 GPT-5 Mini — Cân bằng, giá tốt (OpenAI)' },
        { value: 'gemini-3.1-flash', label: '💎 Gemini 3.1 Flash (Google)' },
        { value: 'gemini-3.0-flash', label: '💎 Gemini 3.0 Flash (Google)' },
        { value: 'claude-4.6-sonnet-20260301',  label: '🟠 Claude 4.6 Sonnet (Anthropic)' },
        { value: 'claude-4.0-haiku-20260101',   label: '🟠 Claude 4.0 Haiku — Nhanh (Anthropic)' },
        { value: 'deepseek-chat-v3.2',    label: '🔮 Deepseek V3.2 (Deepseek)' },
        { value: 'grok-4-mini-fast', label: '⚡ Grok 4 Mini Fast (xAI)' },
        { value: 'grok-4-mini',      label: '⚡ Grok 4 Mini (xAI)' },
        { value: 'mistral-small-3-latest', label: '🌀 Mistral Small 3 (Mistral)' },
        { value: 'mistral-large-2-latest', label: '🌀 Mistral Large 2 (Mistral)' },
      ],
      advanced: true,
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
  ],

  // ── Thông báo ─────────────────────────────────────────────────────────────

  'notify.telegram': [
    {
      key: 'botToken', label: 'Bot Token', type: 'text',
      placeholder: '7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      desc: 'Token của Telegram Bot. Tạo bot miễn phí qua @BotFather trên Telegram → /newbot → sao chép token.',
    },
    {
      key: 'chatId', label: 'Chat ID nhận tin', type: 'text',
      placeholder: '-1001234567890  hoặc  123456789',
      desc: 'ID của người dùng hoặc nhóm/kênh nhận thông báo. Dùng @userinfobot để tìm Chat ID của mình.',
    },
    {
      key: 'message', label: 'Nội dung thông báo', type: 'textarea',
      placeholder: '🔔 Tin nhắn mới từ {{ $trigger.fromName }}:\n{{ $trigger.content }}',
      desc: 'Nội dung tin nhắn gửi qua Telegram. Hỗ trợ HTML đơn giản (<b>bold</b>, <i>italic</i>).',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.now'],
    },
    {
      key: 'parseMode', label: 'Định dạng văn bản', type: 'select',
      desc: 'Cách hiển thị văn bản trong tin nhắn Telegram.',
      options: [
        { value: 'HTML',     label: 'HTML — Hỗ trợ <b>bold</b>, <i>italic</i>' },
        { value: 'Markdown', label: 'Markdown — Hỗ trợ **bold**, _italic_' },
        { value: '',         label: 'Plain Text — Không định dạng' },
      ],
      advanced: true,
    },
  ],

  'notify.discord': [
    {
      key: 'webhookUrl', label: 'Discord Webhook URL', type: 'text',
      placeholder: 'https://discord.com/api/webhooks/123456789/xxxx',
      desc: 'Vào kênh Discord → Settings → Integrations → Webhooks → New Webhook → sao chép URL.',
    },
    {
      key: 'message', label: 'Nội dung thông báo', type: 'textarea',
      placeholder: '📩 **{{ $trigger.fromName }}** vừa nhắn:\n> {{ $trigger.content }}',
      desc: 'Nội dung gửi vào kênh Discord. Hỗ trợ định dạng Markdown (**bold**, *italic*, > quote).',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.now'],
    },
    {
      key: 'username', label: 'Tên hiển thị của bot', type: 'text',
      placeholder: 'DepLao Bot',
      desc: 'Tên sẽ hiển thị khi gửi tin vào kênh Discord.',
      advanced: true,
    },
    {
      key: 'avatarUrl', label: 'Avatar URL (tuỳ chọn)', type: 'text',
      placeholder: 'https://example.com/avatar.png',
      desc: 'Link ảnh đại diện hiển thị khi bot gửi tin. Để trống = dùng avatar mặc định của webhook.',
      advanced: true,
    },
  ],

  'notify.email': [
    {
      key: 'to', label: 'Gửi đến email', type: 'text',
      placeholder: 'you@gmail.com  hoặc  a@gmail.com, b@gmail.com',
      desc: 'Địa chỉ email nhận. Nhiều email cách nhau bằng dấu phẩy.',
      templateVars: ['$trigger.fromName'],
    },
    {
      key: 'subject', label: 'Tiêu đề email', type: 'text',
      placeholder: '🔔 Tin nhắn mới từ {{ $trigger.fromName }}',
      desc: 'Tiêu đề hiển thị trong hộp thư.',
      templateVars: ['$trigger.fromName', '$date.today'],
    },
    {
      key: 'isHtml', label: 'Nội dung dạng HTML', type: 'boolean',
      desc: 'Bật để soạn thảo và xem trước nội dung email dạng HTML.',
    },
    {
      key: 'body', label: 'Nội dung email', type: 'textarea',
      placeholder: 'Bạn có tin nhắn mới từ {{ $trigger.fromName }}:\n\n{{ $trigger.content }}\n\nGửi lúc: {{ $date.now }}',
      desc: 'Nội dung email. Khi bật HTML ở trên, soạn thảo trực tiếp và xem trước ngay.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.now'],
      htmlToggle: 'isHtml',
    },
    {
      key: 'smtpHost', label: 'SMTP Host', type: 'text',
      placeholder: 'smtp.gmail.com',
      desc: 'Máy chủ gửi mail. Gmail: smtp.gmail.com | Outlook: smtp-mail.outlook.com',
      advanced: true,
    },
    {
      key: 'smtpPort', label: 'SMTP Port', type: 'number',
      desc: 'Cổng kết nối. Gmail dùng 587 (TLS) hoặc 465 (SSL).',
      hint: '587 = TLS (phổ biến)  •  465 = SSL  •  25 = không mã hóa (không khuyến nghị)',
      advanced: true,
    },
    {
      key: 'smtpUser', label: 'Tài khoản email', type: 'text',
      placeholder: 'youremail@gmail.com',
      desc: 'Email đăng nhập SMTP. Với Gmail, cần bật "App Password" trong cài đặt bảo mật.',
      advanced: true,
    },
    {
      key: 'smtpPass', label: 'Mật khẩu / App Password', type: 'text',
      placeholder: 'xxxx xxxx xxxx xxxx',
      desc: 'Mật khẩu email hoặc App Password (Gmail). Tạo App Password tại myaccount.google.com → Security → App passwords.',
      advanced: true,
    },
  ],

  'notify.notion': [
    {
      key: 'databaseId', label: 'ID Database Notion', type: 'text',
      placeholder: '1a2b3c4d5e6f7g8h9i0j',
      desc: 'Lấy từ URL của Notion database: notion.so/[workspace]/[ ID NÀY ]?v=...',
    },
    {
      key: 'apiKey', label: 'Notion API Key (Integration Token)', type: 'text',
      placeholder: 'secret_xxxxxxxxxxxx',
      desc: 'Tạo integration tại notion.so/my-integrations → Copy token. Sau đó share database với integration đó.',
    },
    {
      key: 'properties', label: 'Thuộc tính trang (JSON)', type: 'json',
      hint: '{"Tên": {"title": [{"text": {"content": "{{ $trigger.fromName }}"}}]}, "Nội dung": {"rich_text": [{"text": {"content": "{{ $trigger.content }}"}}]}}',
      desc: 'Dữ liệu trang theo cấu trúc Notion API. Xem tài liệu Notion API để biết cách định nghĩa từng loại trường.',
    },
  ],

  // ─── Trigger: Thanh toán ──────────────────────────────────────────────────
  'trigger.payment': [
    {
      key: 'minAmount', label: 'Số tiền tối thiểu (VNĐ)', type: 'number',
      placeholder: '0',
      desc: 'Chỉ kích hoạt khi số tiền nhận được ≥ giá trị này. Để 0 = nhận tất cả.',
    },
    {
      key: 'descContains', label: 'Nội dung CK chứa từ khóa', type: 'text',
      placeholder: 'DH, ORDER, ... (để trống = nhận tất cả)',
      desc: 'Lọc theo nội dung chuyển khoản. VD: "DH" → chỉ nhận CK có nội dung chứa "DH".',
      templateVars: ['$trigger.description'],
    },
    {
      key: 'integrationId', label: 'Tài khoản thanh toán cụ thể', type: 'text',
      placeholder: 'Để trống = nhận từ tất cả tài khoản Casso/SePay (VietQR)',
      desc: 'Nhập ID tích hợp nếu muốn lọc chỉ một tài khoản cụ thể.',
      advanced: true,
    },
  ],

  // ─── KiotViet ─────────────────────────────────────────────────────────────
  'kiotviet.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: 'SĐT để tra cứu khách hàng trong KiotViet. Thường dùng SĐT Zalo của người nhắn tin.',
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'kiotviet.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: 'Tìm đơn hàng theo SĐT. Nếu có cả orderId thì orderId được ưu tiên.',
      templateVars: ['$trigger.fromPhone'],
    },
    {
      key: 'orderId', label: 'Mã đơn hàng (nếu biết)', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Mã đơn hàng KiotViet. Ưu tiên hơn SĐT nếu điền vào đây.',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'kiotviet.lookupProduct': [
    {
      key: 'keyword', label: 'Tên hoặc mã SKU sản phẩm', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Từ khóa tìm kiếm — tên sản phẩm hoặc mã SKU trong KiotViet.',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'code', label: 'Mã SKU chính xác (tùy chọn)', type: 'text',
      placeholder: 'SP001',
      desc: 'Nếu biết chính xác mã SKU, điền vào đây để kết quả chính xác hơn.',
      advanced: true,
    },
    { key: 'limit', label: 'Số kết quả tối đa', type: 'number', placeholder: '10', advanced: true },
  ],
  'kiotviet.createOrder': [
    {
      key: 'branchId', label: 'ID Chi nhánh (branchId)', type: 'number',
      placeholder: '1',
      desc: 'ID chi nhánh KiotViet nơi tạo đơn. Xem trong KiotViet Admin → Chi nhánh.',
    },
    {
      key: 'customerId', label: 'ID Khách hàng (customerId)', type: 'text',
      placeholder: '{{ $node.KiotViet_Tra_Cứu_Khách.firstCustomer.id }}',
      desc: 'ID khách hàng từ bước tra cứu khách hàng. Để trống nếu tạo đơn khách vãng lai.',
      templateVars: ['$trigger.fromName'],
    },
    {
      key: 'orderDetails', label: 'Danh sách sản phẩm (JSON)', type: 'json',
      hint: '[{"productId": 123, "quantity": 1, "price": 150000}, {"productId": 456, "quantity": 2, "price": 80000}]',
      desc: 'Mảng sản phẩm. Mỗi item cần: productId (int), quantity (int), price (số tiền VNĐ). productId lấy từ bước tra cứu sản phẩm.',
    },
    {
      key: 'discount', label: 'Giảm giá trực tiếp (VNĐ)', type: 'number',
      placeholder: '0', advanced: true,
    },
    {
      key: 'note', label: 'Ghi chú đơn hàng', type: 'text',
      placeholder: 'Ghi chú từ khách: {{ $trigger.content }}',
      templateVars: ['$trigger.content', '$trigger.fromName'],
      advanced: true,
    },
  ],

  // ─── Haravan ──────────────────────────────────────────────────────────────
  'haravan.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: 'SĐT để tìm khách hàng trong Haravan.',
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'haravan.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone'],
    },
    {
      key: 'orderId', label: 'Mã đơn hàng (Order ID)', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'ID đơn hàng Haravan (số nguyên). Ưu tiên hơn SĐT.',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'haravan.lookupProduct': [
    {
      key: 'keyword', label: 'Tên sản phẩm', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Tìm sản phẩm theo tên trong Haravan.',
      templateVars: ['$trigger.content'],
    },
    { key: 'limit', label: 'Số kết quả tối đa', type: 'number', placeholder: '10', advanced: true },
  ],
  'haravan.createOrder': [
    {
      key: 'order', label: 'Dữ liệu đơn hàng (JSON)', type: 'json',
      hint: '{"line_items":[{"variant_id":"123","quantity":1,"price":"150000"}],"customer":{"phone":"0901234567"},"shipping_address":{"name":"Nguyễn Văn A","address1":"123 Đường ABC","city":"Hà Nội","phone":"0901234567"}}',
      desc: 'Toàn bộ đối tượng đơn hàng theo Haravan API. line_items là bắt buộc. variant_id lấy từ bước tra cứu sản phẩm (product.variants[0].id).',
    },
  ],

  // ─── Sapo ─────────────────────────────────────────────────────────────────
  'sapo.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'sapo.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone'],
    },
    {
      key: 'orderId', label: 'Mã đơn hàng', type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'sapo.lookupProduct': [
    {
      key: 'keyword', label: 'Tên sản phẩm', type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
    },
    { key: 'limit', label: 'Số kết quả tối đa', type: 'number', placeholder: '10', advanced: true },
  ],
  'sapo.createOrder': [
    {
      key: 'order', label: 'Dữ liệu đơn hàng (JSON)', type: 'json',
      hint: '{"line_items":[{"variant_id":"123","quantity":1,"price":"150000"}],"customer":{"phone":"0901234567"},"shipping_address":{"name":"Nguyễn Văn A","address1":"123 Đường ABC","city":"Hồ Chí Minh","phone":"0901234567"}}',
      desc: 'Đối tượng đơn hàng Sapo. Cấu trúc tương tự Haravan/Shopify. line_items bắt buộc.',
    },
  ],

  // ─── iPOS ─────────────────────────────────────────────────────────────────
  'ipos.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'ipos.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone'],
    },
    {
      key: 'orderId', label: 'Mã đơn / hóa đơn', type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'ipos.lookupProduct': [
    {
      key: 'keyword', label: 'Tên sản phẩm / món ăn', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Tìm sản phẩm hoặc món ăn trong iPOS.',
      templateVars: ['$trigger.content'],
    },
    { key: 'limit', label: 'Số kết quả tối đa', type: 'number', placeholder: '10', advanced: true },
  ],
  'ipos.createOrder': [
    {
      key: 'order', label: 'Dữ liệu đơn hàng (JSON)', type: 'json',
      hint: '{"invoice":{"details":[{"productId":"123","quantity":2,"price":50000}],"customerName":"Nguyễn Văn A","customerPhone":"0901234567","paymentMethod":"CASH","note":"Ít đường"}}',
      desc: 'Payload hiện tại đang theo builder nội bộ `toIPOS()` — wrapper `invoice` chứa `details[]`, thông tin khách và paymentMethod. Cần verify lại với account iPOS thật nếu mở rộng tiếp.',
    },
  ],

  // ─── Nhanh.vn ────────────────────────────────────────────────────────────
  'nhanh.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'nhanh.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone'],
    },
    {
      key: 'orderId', label: 'Mã đơn hàng', type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'nhanh.lookupProduct': [
    {
      key: 'keyword', label: 'Tên sản phẩm', type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'code', label: 'Mã sản phẩm (tùy chọn)', type: 'text',
      placeholder: 'SP001',
      advanced: true,
    },
    { key: 'limit', label: 'Số kết quả tối đa', type: 'number', placeholder: '10', advanced: true },
  ],
  'nhanh.createOrder': [
    {
      key: 'order', label: 'Dữ liệu đơn hàng (JSON)', type: 'json',
      hint: '{"customerName":"Nguyễn Văn A","customerMobile":"0901234567","customerAddress":"123 Đường ABC, Hà Nội","productList":{"123":1},"productDetails":[{"productId":"123","quantity":1,"price":150000}],"paymentMethod":"COD","description":"Đặt hàng qua Zalo"}',
      desc: 'Payload hiện tại đang theo builder nội bộ `toNhanh()` — dùng `productList` và có thể kèm `productDetails` để giữ thêm thông tin sản phẩm. Cần verify sâu hơn với docs/account Nhanh thực tế trước khi mở rộng.',
    },
  ],

  // ─── Payment: Lấy giao dịch ───────────────────────────────────────────────
  'payment.getTransactions': [
    {
      key: 'integrationType', label: 'Nền tảng thanh toán', type: 'select',
      options: [
        { value: 'casso', label: 'Casso' },
        { value: 'sepay', label: 'SePay (VietQR)' },
      ],
      desc: 'Chọn nền tảng để lấy lịch sử giao dịch.',
    },
    {
      key: 'limit', label: 'Số giao dịch tối đa', type: 'number',
      placeholder: '20',
      desc: 'Số giao dịch gần nhất cần lấy.',
    },
    {
      key: 'fromDate', label: 'Từ ngày (tùy chọn)', type: 'text',
      placeholder: '2024-01-01', advanced: true,
    },
    {
      key: 'toDate', label: 'Đến ngày (tùy chọn)', type: 'text',
      placeholder: '2024-12-31', advanced: true,
    },
  ],

  // ─── GHN Express ─────────────────────────────────────────────────────────
  'ghn.createOrder': [
    {
      key: 'toName', label: 'Tên người nhận', type: 'text',
      placeholder: '{{ $trigger.fromName }}',
      desc: 'Họ tên người nhận hàng.',
      templateVars: ['$trigger.fromName'],
    },
    {
      key: 'toPhone', label: 'SĐT người nhận', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone'],
    },
    {
      key: 'toAddress', label: 'Địa chỉ giao hàng', type: 'text',
      placeholder: '123 Đường ABC, Phường XYZ',
      desc: 'Địa chỉ chi tiết (không bao gồm tỉnh/quận).',
    },
    {
      key: 'toDistrictId', label: 'ID Quận/Huyện (GHN)', type: 'number',
      placeholder: '1442',
      desc: 'Lấy từ API GHN: /master-data/district. VD: 1442 = Quận 1 HCM.',
    },
    {
      key: 'toWardCode', label: 'Mã Phường/Xã (GHN)', type: 'text',
      placeholder: '20314',
      desc: 'Lấy từ API GHN: /master-data/ward. VD: 20314 = Phường Bến Nghé.',
    },
    {
      key: 'weight', label: 'Trọng lượng (gram)', type: 'number',
      placeholder: '500',
      desc: 'Trọng lượng gói hàng tính bằng gram.',
    },
    {
      key: 'serviceTypeId', label: 'Loại dịch vụ', type: 'select',
      options: [
        { value: '2', label: '2 — Hàng nhẹ (thường)' },
        { value: '5', label: '5 — Hàng nặng (thường)' },
      ],
      desc: 'Loại dịch vụ GHN.',
      advanced: true,
    },
    {
      key: 'codAmount', label: 'Tiền thu hộ COD (VNĐ)', type: 'number',
      placeholder: '0',
      desc: '0 nếu không thu tiền mặt khi giao.',
      advanced: true,
    },
    {
      key: 'order', label: 'Tham số nâng cao (JSON)', type: 'json',
      hint: '{"insurance_value": 150000, "length": 20, "width": 15, "height": 10, "note": "Giao giờ hành chính"}',
      desc: 'Tham số tuỳ chọn bổ sung theo GHN API v2. Các trường trên sẽ ghi đè vào JSON này.',
      advanced: true,
    },
  ],
  'ghn.getTracking': [
    {
      key: 'orderCode', label: 'Mã vận đơn GHN', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Mã đơn GHN (order_code) để tra cứu trạng thái.',
      templateVars: ['$trigger.content'],
    },
  ],
  'ghn.getProvinces': [],
  'ghn.getDistricts': [
    {
      key: 'provinceId', label: 'Province ID', type: 'number',
      placeholder: '201',
      desc: 'ProvinceID do GHN cung cấp từ API Get Province.',
    },
  ],
  'ghn.getWards': [
    {
      key: 'districtId', label: 'District ID', type: 'number',
      placeholder: '1442',
      desc: 'DistrictID do GHN cung cấp từ API Get District.',
    },
  ],
  'ghn.getServices': [
    {
      key: 'fromDistrict', label: 'From District', type: 'number',
      placeholder: '1447',
      desc: 'Quận lấy hàng (from_district) theo docs GHN Available Services.',
    },
    {
      key: 'toDistrict', label: 'To District', type: 'number',
      placeholder: '1442',
      desc: 'Quận giao hàng (to_district) theo docs GHN Available Services.',
    },
  ],

  // ─── GHTK ─────────────────────────────────────────────────────────────────
  'ghtk.createOrder': [
    {
      key: 'order', label: 'Dữ liệu đơn hàng GHTK (JSON)', type: 'json',
      hint: '{"order":{"id":"DH001","pick_name":"Cửa hàng ABC","pick_address":"123 Lê Lợi","pick_province":"Hồ Chí Minh","pick_district":"Quận 1","pick_ward":"Phường Bến Nghé","pick_tel":"0909123456","name":"Nguyễn Văn A","address":"456 Nguyễn Huệ","province":"Hà Nội","district":"Quận Hoàn Kiếm","ward":"Phường Hàng Bài","tel":"0901234567","weight":500,"value":150000,"transport":"road","pick_money":150000},"products":[{"name":"Áo thun","weight":0.5,"quantity":1,"price":150000}]}',
      desc: 'Đối tượng đơn hàng GHTK. Bao gồm order (thông tin giao) và products (danh sách hàng). Xem docs GHTK để biết đầy đủ các trường.',
    },
  ],
  'ghtk.getTracking': [
    {
      key: 'trackingCode', label: 'Mã tracking GHTK', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Mã tracking (label) để tra cứu trạng thái vận đơn GHTK.',
      templateVars: ['$trigger.content'],
    },
  ],
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  node: any;
  onConfigChange: (config: Record<string, any>) => void;
  onLabelChange: (label: string) => void;
  onClose: () => void;
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputCls  = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors';
const selectCls = 'w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors cursor-pointer [&>option]:bg-gray-800 [&>option]:text-white';
const labelCls  = 'text-xs font-semibold text-gray-300 block mb-1';
const descCls   = 'text-[11px] text-gray-500 mt-1.5 leading-relaxed';
const hintCls   = 'text-[11px] text-blue-400/80 mt-1 leading-relaxed';

// ─── Sub-components ───────────────────────────────────────────────────────────

function TemplateVarChips({ vars, onInsert }: { vars: string[]; onInsert: (v: string) => void }) {
  const [copiedVar, setCopiedVar] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = (v: string) => {
    const text = `{{ ${v} }}`;
    // Insert into field
    onInsert(text);
    // Copy to clipboard
    navigator.clipboard.writeText(text).catch(() => {});
    // Show feedback
    setCopiedVar(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopiedVar(null), 1500);
  };

  return (
    <div className="flex flex-wrap gap-1 mt-2">
      <span className="text-[11px] text-gray-600 self-center mr-0.5">Chèn &amp; copy:</span>
      {vars.map(v => {
        const copied = copiedVar === v;
        return (
          <button
            key={v} type="button"
            onClick={() => handleClick(v)}
            title={`Click để chèn + copy: {{ ${v} }}`}
            className={`text-[11px] px-1.5 py-0.5 rounded-md border transition-all duration-150 font-mono flex items-center gap-0.5
              ${copied
                ? 'bg-green-500/20 border-green-500/50 text-green-400'
                : 'bg-blue-500/10 border-blue-500/25 text-blue-400 hover:bg-blue-500/20 hover:border-blue-400/50'
              }`}
          >
            {copied ? (
              <><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>copy!</>
            ) : (
              <>{v}<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-0.5 opacity-50"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ToggleSwitch({ checked, onChange, label, desc }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string;
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="w-full flex items-start gap-3 text-left">
      <div className={`mt-0.5 w-8 h-[18px] rounded-full flex-shrink-0 transition-colors relative ${checked ? 'bg-blue-600' : 'bg-gray-700'}`}>
        <span className={`absolute top-[2px] w-[14px] h-[14px] bg-white rounded-full shadow transition-all ${checked ? 'left-[18px]' : 'left-[2px]'}`} />
      </div>
      <div className="min-w-0">
        <p className={`text-sm font-medium transition-colors leading-tight ${checked ? 'text-white' : 'text-gray-400'}`}>{label}</p>
        {desc && <p className={`${descCls} mt-0.5`}>{desc}</p>}
      </div>
    </button>
  );
}

function CronField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const human = value ? cronToHuman(value) : '';
  return (
    <div className="space-y-2">
      <input
        value={value ?? ''} onChange={e => onChange(e.target.value)}
        placeholder={placeholder || '0 8 * * *'}
        className={`${inputCls} font-mono`}
      />
      {human && (
        <p className="text-[11px] text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg px-2.5 py-1.5">
          ⏰ {human}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map(p => (
          <button key={p.value} type="button" onClick={() => onChange(p.value)}
            className={`text-[11px] px-2 py-1 rounded-lg border transition-colors
              ${value === p.value
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
              }`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function HtmlEditorField({ value, onChange, placeholder, templateVars }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  templateVars?: string[];
}) {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const wrap = (open: string, close: string) => {
    const el = textareaRef.current;
    if (!el) { onChange(value + open + close); return; }
    const start = el.selectionStart;
    const end   = el.selectionEnd;
    const sel   = value.slice(start, end);
    const newVal = value.slice(0, start) + open + sel + close + value.slice(end);
    onChange(newVal);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = sel ? start + open.length + sel.length : start + open.length;
      el.setSelectionRange(cursor, cursor);
    });
  };

  const insertLine = (html: string) => {
    const el = textareaRef.current;
    if (!el) { onChange(value + '\n' + html); return; }
    const pos = el.selectionStart;
    const newVal = value.slice(0, pos) + html + value.slice(pos);
    onChange(newVal);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos + html.length, pos + html.length); });
  };

  const TOOLBAR = [
    { icon: 'B',  title: 'In đậm',      action: () => wrap('<b>','</b>'),     cls: 'font-bold' },
    { icon: 'I',  title: 'In nghiêng',  action: () => wrap('<i>','</i>'),     cls: 'italic' },
    { icon: 'U',  title: 'Gạch chân',   action: () => wrap('<u>','</u>'),     cls: 'underline' },
    { icon: 'S',  title: 'Gạch ngang',  action: () => wrap('<s>','</s>'),     cls: 'line-through' },
    { icon: 'H1', title: 'Tiêu đề',     action: () => wrap('<h2>','</h2>'),   cls: '' },
    { icon: 'P',  title: 'Đoạn văn',    action: () => wrap('<p>','</p>'),     cls: '' },
    { icon: '↵',  title: 'Xuống dòng',  action: () => insertLine('<br/>'),    cls: '' },
    { icon: '≡',  title: 'Danh sách',   action: () => insertLine('<ul>\n  <li>Mục 1</li>\n  <li>Mục 2</li>\n</ul>'), cls: '' },
    { icon: '🔗', title: 'Liên kết',    action: () => wrap('<a href="https://">','</a>'), cls: '' },
    { icon: '━',  title: 'Đường kẻ',    action: () => insertLine('<hr/>'),    cls: '' },
    { icon: '🎨', title: 'Màu chữ đỏ',  action: () => wrap('<span style="color:#e11d48">','</span>'), cls: '' },
  ];

  return (
    <div className="border border-gray-700 rounded-xl overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-stretch bg-gray-800/80 border-b border-gray-700">
        <button type="button" onClick={() => setTab('edit')}
          className={`px-3 py-1.5 text-[11px] font-medium transition-colors border-r border-gray-700
            ${tab === 'edit' ? 'text-white bg-gray-700/80' : 'text-gray-500 hover:text-gray-300'}`}>
          ✏️ Soạn thảo
        </button>
        <button type="button" onClick={() => setTab('preview')}
          className={`px-3 py-1.5 text-[11px] font-medium transition-colors border-r border-gray-700
            ${tab === 'preview' ? 'text-white bg-gray-700/80' : 'text-gray-500 hover:text-gray-300'}`}>
          👁 Xem trước
        </button>
        {/* Toolbar — only in edit mode */}
        {tab === 'edit' && (
          <div className="flex items-center gap-0.5 px-1.5 flex-1 overflow-x-auto scrollbar-none">
            {TOOLBAR.map(btn => (
              <button key={btn.icon} type="button" title={btn.title} onClick={btn.action}
                className={`flex-shrink-0 text-[11px] w-6 h-6 flex items-center justify-center rounded hover:bg-gray-600 text-gray-400 hover:text-white transition-colors ${btn.cls}`}>
                {btn.icon}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Editor */}
      {tab === 'edit' ? (
        <div>
          <textarea
            ref={textareaRef}
            value={value ?? ''}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder || '<p>Xin chào <b>{{ $trigger.fromName }}</b>,</p>\n<p>{{ $trigger.content }}</p>'}
            rows={8}
            spellCheck={false}
            className="w-full bg-gray-800/50 px-3 py-2.5 text-[12px] text-white placeholder-gray-600 focus:outline-none resize-none font-mono leading-relaxed"
          />
          {/* Var chips inside editor */}
          {templateVars && templateVars.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 pb-2 border-t border-gray-700/50 pt-1.5 bg-gray-800/30">
              <span className="text-[9px] text-gray-600 self-center mr-0.5">Chèn:</span>
              {templateVars.map(v => (
                <button key={v} type="button"
                  onClick={() => { const tag = `{{ ${v} }}`; insertLine(tag); navigator.clipboard.writeText(tag).catch(() => {}); }}
                  title={`Chèn + copy: {{ ${v} }}`}
                  className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 border border-blue-500/25 text-blue-400 hover:bg-blue-500/20 font-mono transition-colors">
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Preview */
        <div className="bg-white min-h-[140px] max-h-[360px] overflow-y-auto">
          {value?.trim() ? (
            <div
              className="px-4 py-3 text-sm text-gray-800 prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: value }}
            />
          ) : (
            <div className="px-4 py-6 text-center text-gray-400 text-xs italic">
              Chưa có nội dung — hãy soạn thảo trong tab "Soạn thảo"
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Label Picker ─────────────────────────────────────────────────────────────

// Helper component for account avatar
function AccountAvatar({ account, size = 'sm' }: { account: { avatar_url?: string; full_name?: string; display_name?: string; zalo_id: string }; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-5 h-5 text-[8px]',
    md: 'w-8 h-8 text-[10px]',
    lg: 'w-10 h-10 text-xs',
  };
  const sizeClass = sizeClasses[size];
  
  if (account.avatar_url) {
    return (
      <img
        src={account.avatar_url}
        alt={account.full_name || account.display_name || account.zalo_id}
        className={`${sizeClass} rounded-full object-cover flex-shrink-0 ring-1 ring-gray-600`}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  
  // Fallback: initials
  const initials = (account.full_name || account.display_name || account.zalo_id).slice(0, 2).toUpperCase();
  return (
    <div className={`${sizeClass} rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-medium flex-shrink-0 ring-1 ring-gray-600`}>
      {initials}
    </div>
  );
}

// Format phone number for display (no masking)
function formatPhoneDisplay(phone?: string): string {
  if (!phone) return '';
  return phone;
}

// Helper to get contrasting text color
function getContrastColor(hex: string | undefined): string {
  if (!hex) return '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#1f2937' : '#ffffff';
}

// ─── Label Picker Modal ───────────────────────────────────────────────────────

function LabelPickerModal({
  open,
  onClose,
  options,
  selected,
  onChange,
  mode,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  options: LoadedLabelOption[];
  selected: string[];
  onChange: (v: string[]) => void;
  mode: 'single' | 'multi';
  accounts: { zalo_id: string; full_name: string; display_name?: string; phone?: string; avatar_url: string }[];
}) {
  const [activeTab, setActiveTab] = React.useState<'local' | 'zalo'>('local');
  const [selectedAccountId, setSelectedAccountId] = React.useState<string>('all');

  const localOpts = options.filter(o => o.source === 'local');
  const zaloOpts = options.filter(o => o.source === 'zalo');

  // Build account lookup map
  const accountMap = React.useMemo(() => {
    const map = new Map<string, typeof accounts[0]>();
    accounts.forEach(a => map.set(a.zalo_id, a));
    return map;
  }, [accounts]);

  // Get accounts that have labels (show all accounts for Zalo if any labels exist)
  const accountsWithLabels = React.useMemo(() => {
    const currentOpts = activeTab === 'local' ? localOpts : zaloOpts;
    
    // For Zalo: show all accounts that have labels
    if (activeTab === 'zalo') {
      const pageIds = new Set<string>();
      currentOpts.forEach(o => {
        if (o.pageId) pageIds.add(o.pageId);
      });
      
      // If no pageId set on labels, show all accounts
      if (pageIds.size === 0 && currentOpts.length > 0) {
        return accounts.map(acc => ({
          ...acc,
          labelCount: currentOpts.length, // All labels available for all accounts
        }));
      }
      
      return accounts.filter(a => pageIds.has(a.zalo_id)).map(acc => ({
        ...acc,
        labelCount: currentOpts.filter(o => o.pageId === acc.zalo_id).length,
      }));
    }
    
    // For Local: filter by pageIds
    const pageIds = new Set<string>();
    currentOpts.forEach(o => {
      if (o.pageIds) o.pageIds.forEach(p => pageIds.add(p));
    });

    return accounts.filter(a => pageIds.has(a.zalo_id)).map(acc => ({
      ...acc,
      labelCount: currentOpts.filter(o => o.pageIds?.includes(acc.zalo_id)).length,
    }));
  }, [activeTab, localOpts, zaloOpts, accounts]);

  // Filter labels by selected account
  const filteredLabels = React.useMemo(() => {
    const currentOpts = activeTab === 'local' ? localOpts : zaloOpts;
    
    // Show all if 'all' selected
    if (selectedAccountId === 'all') return currentOpts;
    
    // For Zalo: filter by pageId, but include labels without pageId
    if (activeTab === 'zalo') {
      return currentOpts.filter(o => !o.pageId || o.pageId === selectedAccountId);
    }
    
    // For Local: filter by pageIds
    return currentOpts.filter(o => o.pageIds?.includes(selectedAccountId));
  }, [activeTab, localOpts, zaloOpts, selectedAccountId]);

  // Reset account filter when switching tabs
  React.useEffect(() => {
    setSelectedAccountId('all');
  }, [activeTab]);

  // Auto-select tab based on which has options
  React.useEffect(() => {
    if (localOpts.length === 0 && zaloOpts.length > 0) setActiveTab('zalo');
    else if (localOpts.length > 0) setActiveTab('local');
  }, [localOpts.length, zaloOpts.length]);

  const toggle = (v: string) => {
    if (mode === 'single') {
      onChange(selected.includes(v) ? [] : [v]);
    } else {
      if (selected.includes(v)) onChange(selected.filter(x => x !== v));
      else onChange([...selected, v]);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      {/* Modal */}
      <div className="relative bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[680px] max-w-[95vw] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 bg-gray-800/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500 to-purple-600 flex items-center justify-center">
              <span className="text-xl">🏷️</span>
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Chọn nhãn</h2>
              <p className="text-xs text-gray-400">
                {mode === 'single' ? 'Chọn 1 nhãn' : 'Có thể chọn nhiều nhãn'}
                {selected.length > 0 && ` • Đã chọn: ${selected.length}`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-gray-700/50 hover:bg-gray-600 flex items-center justify-center text-gray-400 hover:text-white transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* ─── Left: Account Sidebar ─── */}
          <div className="w-60 border-r border-gray-700 bg-gray-800/30 flex flex-col">
            <div className="px-3 py-2.5 border-b border-gray-700/50">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide font-medium">
                Tài khoản
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {/* All accounts option */}
              <button
                type="button"
                onClick={() => setSelectedAccountId('all')}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all ${
                  selectedAccountId === 'all'
                    ? 'bg-blue-500/20 border border-blue-500/40 text-blue-300'
                    : 'hover:bg-gray-700/50 text-gray-400 hover:text-gray-300 border border-transparent'
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white text-sm">
                  📋
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">Tất cả</div>
                  <div className="text-[10px] text-gray-500">
                    {(activeTab === 'local' ? localOpts : zaloOpts).length} nhãn
                  </div>
                </div>
              </button>

              {/* Individual accounts */}
              {accountsWithLabels.map(acc => {
                const isActive = selectedAccountId === acc.zalo_id;
                return (
                  <button
                    key={acc.zalo_id}
                    type="button"
                    onClick={() => setSelectedAccountId(acc.zalo_id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-all ${
                      isActive
                        ? 'bg-purple-500/20 border border-purple-500/40 text-purple-300'
                        : 'hover:bg-gray-700/50 text-gray-400 hover:text-gray-300 border border-transparent'
                    }`}
                  >
                    <AccountAvatar account={acc} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {acc.full_name || acc.display_name || acc.zalo_id}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                        {acc.phone && <span>{formatPhoneDisplay(acc.phone)}</span>}
                        <span>•</span>
                        <span>{acc.labelCount} nhãn</span>
                      </div>
                    </div>
                    {isActive && (
                      <div className="w-2 h-2 rounded-full bg-purple-400" />
                    )}
                  </button>
                );
              })}

              {accountsWithLabels.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-gray-500">
                  Không có tài khoản nào có nhãn {activeTab === 'local' ? 'Local' : 'Zalo'}
                </div>
              )}
            </div>
          </div>

          {/* ─── Right: Labels Panel ─── */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Tabs */}
            <div className="flex bg-gray-800/60 border-b border-gray-700/50">
              <button
                type="button"
                onClick={() => setActiveTab('local')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
                  activeTab === 'local'
                    ? 'border-teal-500 text-teal-400 bg-teal-500/5'
                    : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-700/30'
                }`}
              >
                <span>💾</span>
                <span>Nhãn Local</span>
                {localOpts.length > 0 && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    activeTab === 'local' ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-700 text-gray-500'
                  }`}>
                    {localOpts.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('zalo')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
                  activeTab === 'zalo'
                    ? 'border-purple-500 text-purple-400 bg-purple-500/5'
                    : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-700/30'
                }`}
              >
                <span>☁️</span>
                <span>Nhãn Zalo</span>
                {zaloOpts.length > 0 && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    activeTab === 'zalo' ? 'bg-purple-500/20 text-purple-400' : 'bg-gray-700 text-gray-500'
                  }`}>
                    {zaloOpts.length}
                  </span>
                )}
              </button>
            </div>

            {/* Labels List - Single column */}
            <div className="flex-1 overflow-y-auto p-3">
              {filteredLabels.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                  <span className="text-4xl mb-3">🏷️</span>
                  <p className="text-sm">Không có nhãn nào</p>
                  <p className="text-xs mt-1">
                    {selectedAccountId !== 'all' 
                      ? 'Tài khoản này chưa có nhãn'
                      : activeTab === 'local' ? 'Chưa có nhãn Local' : 'Chưa có nhãn Zalo'}
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filteredLabels.map(opt => {
                    const isSelected = selected.includes(opt.value);
                    const bgColor = opt.color || '#6b7280';
                    const textColor = opt.textColor || getContrastColor(bgColor);
                    // For Zalo: use pageId, for Local: use first pageIds
                    const accId = opt.pageId || (opt.pageIds && opt.pageIds[0]);
                    const acc = accId ? accountMap.get(accId) : undefined;

                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => toggle(opt.value)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                          isSelected
                            ? 'ring-2 ring-offset-1 ring-offset-gray-900'
                            : 'bg-gray-800/40 border-gray-700/40 hover:border-gray-600 hover:bg-gray-800/60'
                        }`}
                        style={isSelected ? {
                          backgroundColor: `${bgColor}15`,
                          borderColor: `${bgColor}60`,
                          '--tw-ring-color': bgColor,
                        } as React.CSSProperties : undefined}
                      >
                        {/* Checkbox */}
                        <span
                          className={`w-5 h-5 ${mode === 'single' ? 'rounded-full' : 'rounded-md'} border-2 flex items-center justify-center flex-shrink-0 transition-all`}
                          style={isSelected ? {
                            backgroundColor: bgColor,
                            borderColor: bgColor,
                            color: textColor,
                          } : { borderColor: '#4b5563' }}
                        >
                          {isSelected && (
                            mode === 'single' ? (
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: textColor }} />
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            )
                          )}
                        </span>

                        {/* Label badge */}
                        <span
                          className="text-xs px-2.5 py-1 rounded-md font-medium shadow-sm"
                          style={{ backgroundColor: bgColor, color: textColor }}
                        >
                          {opt.emoji || '🏷️'} {opt.name}
                        </span>

                        {/* Account info - show when viewing all (for both Local and Zalo) */}
                        {selectedAccountId === 'all' && acc && (
                          <div className="flex items-center gap-2 ml-auto">
                            <AccountAvatar account={acc} size="sm" />
                            <span className="text-[11px] text-gray-400">
                              {acc.full_name || acc.display_name || acc.zalo_id}
                            </span>
                          </div>
                        )}

                        {/* Selected indicator */}
                        {isSelected && !acc && (
                          <svg className="w-5 h-5 flex-shrink-0 ml-auto" style={{ color: bgColor }} fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-700 bg-gray-800/50">
          <div className="text-xs text-gray-500">
            {selected.length > 0 ? (
              <span>Đã chọn <span className="text-white font-medium">{selected.length}</span> nhãn</span>
            ) : (
              <span>{mode === 'single' ? 'Chọn 1 nhãn' : 'Chọn nhãn để áp dụng'}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="px-3 py-2 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
              >
                Xóa tất cả
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-white bg-gradient-to-r from-teal-500 to-purple-600 hover:from-teal-400 hover:to-purple-500 rounded-lg transition-all shadow-lg"
            >
              Xác nhận
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Label Picker Field (Main) ────────────────────────────────────────────────

function LabelPickerField({
  value,
  onChange,
  options,
  loading,
  mode,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: LoadedLabelOption[];
  loading: boolean;
  mode: 'single' | 'multi';
}) {
  const { accounts } = useAccountStore();
  const selected = Array.isArray(value) ? value : [];
  const [showModal, setShowModal] = React.useState(false);

  // Build account lookup map
  const accountMap = React.useMemo(() => {
    const map = new Map<string, typeof accounts[0]>();
    accounts.forEach(a => map.set(a.zalo_id, a));
    return map;
  }, [accounts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-gray-400 text-xs">
        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        Đang tải danh sách nhãn…
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-4 text-center">
        <div className="text-xl mb-2">🏷️</div>
        <p className="text-yellow-400 text-xs font-medium">Chưa có nhãn nào</p>
        <p className="text-yellow-400/70 text-[11px] mt-1">Vào <b>CRM → Quản lý nhãn</b> để tạo nhãn trước.</p>
      </div>
    );
  }

  const removeLabel = (v: string) => {
    onChange(selected.filter(x => x !== v));
  };

  return (
    <div className="border border-gray-700 rounded-xl overflow-hidden bg-gray-800/30">
      {/* ── Selected Labels Display ── */}
      {selected.length > 0 && (
        <div className="px-3 py-3 border-b border-gray-700/50 bg-gray-800/40">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-gray-500 uppercase tracking-wide font-medium">
              Đã chọn ({selected.length})
            </span>
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[10px] text-gray-500 hover:text-red-400 transition-colors"
            >
              Xóa tất cả
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selected.map(v => {
              const opt = options.find(o => o.value === v);
              const bgColor = opt?.color || '#6b7280';
              const textColor = opt?.textColor || getContrastColor(bgColor);
              const acc = opt?.pageId ? accountMap.get(opt.pageId) : undefined;

              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-1.5 text-[11px] pl-1.5 pr-1.5 py-1 rounded-lg font-medium shadow-sm"
                  style={{ backgroundColor: bgColor, color: textColor }}
                  title={acc ? `${acc.full_name || acc.display_name || acc.zalo_id}${acc.phone ? ` • ${acc.phone}` : ''}` : undefined}
                >
                  {acc && (
                    <span className="flex-shrink-0">
                      {acc.avatar_url ? (
                        <img
                          src={acc.avatar_url}
                          alt=""
                          className="w-4 h-4 rounded-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <span className="w-4 h-4 rounded-full bg-black/20 flex items-center justify-center text-[6px]">
                          {(acc.full_name || acc.display_name || acc.zalo_id).slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="text-xs">{opt?.emoji || '🏷️'}</span>
                  <span>{opt?.name || v}</span>
                  <button
                    type="button"
                    onClick={() => removeLabel(v)}
                    className="w-4 h-4 flex items-center justify-center rounded hover:bg-black/20 transition-colors"
                    title="Bỏ chọn"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Open Modal Button ── */}
      <button
        type="button"
        onClick={() => setShowModal(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gray-800/50 hover:bg-gray-700/50 text-gray-300 hover:text-white transition-all"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        <span className="text-xs font-medium">
          {selected.length > 0 ? 'Thêm nhãn khác' : 'Chọn nhãn'}
        </span>
      </button>

      {/* ── Modal ── */}
      <LabelPickerModal
        open={showModal}
        onClose={() => setShowModal(false)}
        options={options}
        selected={selected}
        onChange={onChange}
        mode={mode}
        accounts={accounts}
      />

      {/* ── Footer hint ── */}
      {selected.length === 0 && (
        <div className="px-3 py-2 bg-gray-800/30 border-t border-gray-700/50">
          <p className="text-[10px] text-gray-500 text-center">
            {mode === 'single' ? 'Chọn 1 nhãn để áp dụng' : 'Có thể chọn nhiều nhãn • Để trống = áp dụng với mọi nhãn'}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Contact Picker Modal ─────────────────────────────────────────────────────

interface ContactItem {
  id: string;
  name: string;
  alias?: string;  // Tên gợi nhớ
  avatar?: string;
  type: 'user' | 'group';
  accountId: string;
  accountName: string;
}

function ContactPickerModal({
  open,
  onClose,
  contactType,
  value,
  onChange,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  contactType: 'user' | 'group' | 'all';
  value: string;
  onChange: (v: string) => void;
  accounts: { zalo_id: string; full_name: string; display_name?: string; phone?: string; avatar_url: string; cookies: string; imei: string; user_agent: string }[];
}) {
  const [selectedAccountId, setSelectedAccountId] = React.useState<string>(accounts[0]?.zalo_id || '');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [contacts, setContacts] = React.useState<ContactItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [filterTab, setFilterTab] = React.useState<'all' | 'user' | 'group'>('all');
  const theme = useAppStore(s => s.theme);
  const groupInfoCache = useAppStore(s => s.groupInfoCache);
  const isLight = theme === 'light';

  // Load contacts when account changes
  React.useEffect(() => {
    if (!open || !selectedAccountId) return;
    
    const loadContacts = async () => {
      setLoading(true);
      setError(null);
      const items: ContactItem[] = [];
      const acc = accounts.find(a => a.zalo_id === selectedAccountId);
      if (!acc) {
        setLoading(false);
        setError('Không tìm thấy tài khoản');
        return;
      }
      
      let hasError = false;
      let errorMsg = '';
      
      // Load contacts from database - includes both users and groups
      try {
        const contactsRes = await ipc.db?.getContacts(selectedAccountId);
        const contactsList = contactsRes?.contacts || [];
        contactsList.forEach((c: any) => {
          if (!c.contact_id) return;
          
          // Check contact_type from DB
          const isGroup = c.contact_type === 'group';
          
          // Filter based on contactType prop
          if (contactType === 'user' && isGroup) return;
          if (contactType === 'group' && !isGroup) return;
          
          items.push({
            id: c.contact_id,
            // Tên gợi nhớ (alias) hiển thị trước, sau đó là display_name, zalo_name
            name: c.alias || c.display_name || c.zalo_name || (isGroup ? `Nhóm ${c.contact_id}` : `User ${c.contact_id}`),
            alias: c.alias || undefined,
            avatar: c.avatar_url,
            type: isGroup ? 'group' : 'user',
            accountId: acc.zalo_id,
            accountName: acc.full_name || acc.display_name || acc.zalo_id,
          });
        });
      } catch (err: any) {
        console.warn('[ContactPicker] Failed to load contacts from DB:', err);
      }
      
      // Load groups from API - requires active connection (as backup if not in DB)
      if (contactType === 'group' || contactType === 'all') {
        try {
          const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
          const groupsRes = await ipc.zalo?.getGroups(auth);
          
          // Check for API error
          if (groupsRes?.error) {
            hasError = true;
            errorMsg = groupsRes.error;
            console.warn('[ContactPicker] Groups API error:', groupsRes.error);
          } else {
            const groups = groupsRes?.response?.gridInfoMap || {};
            const existingIds = new Set(items.map(i => i.id));
            
            Object.entries(groups).forEach(([groupId, groupInfo]: [string, any]) => {
              // Skip if already loaded from DB
              if (existingIds.has(groupId)) return;
              
              items.push({
                id: groupId,
                name: groupInfo?.name || `Nhóm ${groupId}`,
                avatar: groupInfo?.avatar || groupInfo?.avt,
                type: 'group',
                accountId: acc.zalo_id,
                accountName: acc.full_name || acc.display_name || acc.zalo_id,
              });
            });
          }
        } catch (err: any) {
          hasError = true;
          errorMsg = err?.message || 'Không thể tải danh sách nhóm';
          console.warn('[ContactPicker] Failed to load groups:', err);
        }
      }
      
      setContacts(items);
      
      // Only show error if we got no results AND there was an error
      if (items.length === 0 && hasError) {
        setError(errorMsg || 'Tài khoản chưa kết nối. Vui lòng kết nối lại.');
      } else if (hasError && contactType === 'group') {
        // For group-only picker, show error even if we have some cached data
        setError('Không thể tải nhóm mới. Tài khoản có thể chưa kết nối.');
      } else {
        setError(null);
      }
      
      setLoading(false);
    };
    
    loadContacts();
  }, [open, selectedAccountId, contactType, accounts]);

  // Filter contacts by search and tab
  const filteredContacts = React.useMemo(() => {
    let result = contacts;
    
    // Filter by tab (only when contactType is 'all')
    if (contactType === 'all' && filterTab !== 'all') {
      result = result.filter(c => c.type === filterTab);
    }
    
    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(c => 
        c.name.toLowerCase().includes(q) || 
        c.id.includes(q) ||
        (c.alias && c.alias.toLowerCase().includes(q))
      );
    }
    
    return result;
  }, [contacts, searchQuery, filterTab, contactType]);

  // Count by type
  const userCount = contacts.filter(c => c.type === 'user').length;
  const groupCount = contacts.filter(c => c.type === 'group').length;

  const handleSelect = (contact: ContactItem) => {
    onChange(contact.id);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      {/* Modal */}
      <div className={`relative rounded-2xl shadow-2xl w-[600px] max-w-[95vw] max-h-[80vh] flex flex-col overflow-hidden border ${
        isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${
          isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800/50 border-gray-700'
        }`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <span className="text-xl">{contactType === 'group' ? '👥' : contactType === 'user' ? '👤' : '📇'}</span>
            </div>
            <div>
              <h2 className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-white'}`}>
                {contactType === 'group' ? 'Chọn nhóm' : contactType === 'user' ? 'Chọn liên hệ' : 'Chọn liên hệ / nhóm'}
              </h2>
              <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                Chọn từ danh bạ Zalo
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              isLight ? 'bg-gray-100 hover:bg-gray-200 text-gray-500' : 'bg-gray-700/50 hover:bg-gray-600 text-gray-400 hover:text-white'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Account Sidebar */}
          <div className={`w-48 border-r flex flex-col ${
            isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800/30 border-gray-700'
          }`}>
            <div className={`px-3 py-2.5 border-b ${isLight ? 'border-gray-200' : 'border-gray-700/50'}`}>
              <span className={`text-[10px] uppercase tracking-wide font-medium ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                Tài khoản
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {accounts.map(acc => {
                const isActive = selectedAccountId === acc.zalo_id;
                return (
                  <button
                    key={acc.zalo_id}
                    type="button"
                    onClick={() => setSelectedAccountId(acc.zalo_id)}
                    className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-all ${
                      isActive
                        ? isLight 
                          ? 'bg-blue-50 border border-blue-200 text-blue-700'
                          : 'bg-blue-500/20 border border-blue-500/40 text-blue-300'
                        : isLight
                          ? 'hover:bg-gray-100 text-gray-700 border border-transparent'
                          : 'hover:bg-gray-700/50 text-gray-400 hover:text-gray-300 border border-transparent'
                    }`}
                  >
                    {acc.avatar_url ? (
                      <img src={acc.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-[10px] font-medium flex-shrink-0">
                        {(acc.full_name || acc.zalo_id).slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {acc.full_name || acc.display_name || acc.zalo_id}
                      </div>
                      {acc.phone && (
                        <div className={`text-[10px] ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                          {acc.phone}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Contacts List */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Search */}
            <div className={`px-4 py-3 border-b ${isLight ? 'border-gray-200' : 'border-gray-700/50'}`}>
              <div className="relative">
                <svg className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-gray-400' : 'text-gray-500'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
                <input
                  type="text"
                  placeholder="Tìm kiếm..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className={`w-full pl-10 pr-4 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 ${
                    isLight
                      ? 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-blue-500/30 focus:border-blue-500'
                      : 'bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500/30 focus:border-blue-500'
                  }`}
                />
              </div>
            </div>

            {/* Filter tabs - only show when contactType is 'all' */}
            {contactType === 'all' && (
              <div className={`flex border-b ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700/50 bg-gray-800/50'}`}>
                <button
                  type="button"
                  onClick={() => setFilterTab('all')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-all border-b-2 ${
                    filterTab === 'all'
                      ? isLight
                        ? 'border-blue-500 text-blue-600 bg-blue-50/50'
                        : 'border-blue-500 text-blue-400 bg-blue-500/5'
                      : isLight
                        ? 'border-transparent text-gray-500 hover:text-gray-700'
                        : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <span>📋</span>
                  <span>Tất cả</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    filterTab === 'all' 
                      ? isLight ? 'bg-blue-100 text-blue-600' : 'bg-blue-500/20 text-blue-400'
                      : isLight ? 'bg-gray-200 text-gray-500' : 'bg-gray-700 text-gray-500'
                  }`}>{contacts.length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab('user')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-all border-b-2 ${
                    filterTab === 'user'
                      ? isLight
                        ? 'border-green-500 text-green-600 bg-green-50/50'
                        : 'border-green-500 text-green-400 bg-green-500/5'
                      : isLight
                        ? 'border-transparent text-gray-500 hover:text-gray-700'
                        : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <span>👤</span>
                  <span>Cá nhân</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    filterTab === 'user'
                      ? isLight ? 'bg-green-100 text-green-600' : 'bg-green-500/20 text-green-400'
                      : isLight ? 'bg-gray-200 text-gray-500' : 'bg-gray-700 text-gray-500'
                  }`}>{userCount}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setFilterTab('group')}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-all border-b-2 ${
                    filterTab === 'group'
                      ? isLight
                        ? 'border-purple-500 text-purple-600 bg-purple-50/50'
                        : 'border-purple-500 text-purple-400 bg-purple-500/5'
                      : isLight
                        ? 'border-transparent text-gray-500 hover:text-gray-700'
                        : 'border-transparent text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <span>👥</span>
                  <span>Nhóm</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    filterTab === 'group'
                      ? isLight ? 'bg-purple-100 text-purple-600' : 'bg-purple-500/20 text-purple-400'
                      : isLight ? 'bg-gray-200 text-gray-500' : 'bg-gray-700 text-gray-500'
                  }`}>{groupCount}</span>
                </button>
              </div>
            )}

            {/* List */}
            <div className="flex-1 overflow-y-auto p-3">
              {/* Error message */}
              {error && (
                <div className={`mb-3 px-3 py-2.5 rounded-lg flex items-start gap-2 ${
                  isLight ? 'bg-amber-50 border border-amber-200' : 'bg-amber-500/10 border border-amber-500/30'
                }`}>
                  <svg className={`w-4 h-4 flex-shrink-0 mt-0.5 ${isLight ? 'text-amber-500' : 'text-amber-400'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                  </svg>
                  <div>
                    <p className={`text-xs font-medium ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                      {error}
                    </p>
                    <p className={`text-[10px] mt-0.5 ${isLight ? 'text-amber-600' : 'text-amber-400/70'}`}>
                      Hãy chọn tài khoản khác hoặc nhập ID thủ công.
                    </p>
                  </div>
                </div>
              )}
              
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <svg className={`animate-spin w-6 h-6 ${isLight ? 'text-gray-400' : 'text-gray-500'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                </div>
              ) : filteredContacts.length === 0 && !error ? (
                <div className={`text-center py-12 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                  <span className="text-4xl mb-3 block">{contactType === 'group' ? '👥' : '👤'}</span>
                  <p className="text-sm">Không tìm thấy</p>
                </div>
              ) : filteredContacts.length === 0 && error ? (
                <div className={`text-center py-8 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                  <span className="text-3xl mb-2 block">📭</span>
                  <p className="text-xs">Không có dữ liệu</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredContacts.map(contact => {
                    return (
                    <button
                      key={`${contact.type}-${contact.id}`}
                      type="button"
                      onClick={() => handleSelect(contact)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                        value === contact.id
                          ? isLight
                            ? 'bg-blue-50 border-blue-200 ring-2 ring-blue-500/30'
                            : 'bg-blue-500/15 border-blue-500/40 ring-2 ring-blue-500/30'
                          : isLight
                            ? 'bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                            : 'bg-gray-800/40 border-gray-700/40 hover:border-gray-600 hover:bg-gray-800/60'
                      }`}
                    >
                      {/* Avatar - use GroupAvatar for groups, like CRM */}
                      {contact.type === 'group' ? (
                        <GroupAvatar
                          avatarUrl={contact.avatar}
                          groupInfo={(groupInfoCache[selectedAccountId] || {})[contact.id]}
                          name={contact.name}
                          size="sm"
                        />
                      ) : contact.avatar ? (
                        <img 
                          src={contact.avatar} 
                          alt="" 
                          className="w-9 h-9 rounded-full object-cover flex-shrink-0"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                            const fallback = (e.target as HTMLImageElement).nextElementSibling;
                            if (fallback) (fallback as HTMLElement).style.display = 'flex';
                          }}
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                          {(contact.name || 'U').charAt(0).toUpperCase()}
                        </div>
                      )}
                      {/* Hidden fallback for user avatar error */}
                      {contact.type === 'user' && contact.avatar && (
                        <div 
                          className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                          style={{ display: 'none' }}
                        >
                          {(contact.name || 'U').charAt(0).toUpperCase()}
                        </div>
                      )}

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-sm font-medium truncate ${isLight ? 'text-gray-900' : 'text-white'}`}>
                            {contact.name}
                          </span>
                        </div>
                        <div className={`text-[11px] flex items-center gap-2 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                            contact.type === 'group'
                              ? isLight ? 'bg-purple-100 text-purple-700' : 'bg-purple-500/20 text-purple-400'
                              : isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-500/20 text-blue-400'
                          }`}>
                            {contact.type === 'group' ? '👥 Nhóm' : '👤 Cá nhân'}
                          </span>
                          <span className="truncate">ID: {contact.id}</span>
                        </div>
                      </div>

                      {/* Selected indicator */}
                      {value === contact.id && (
                        <svg className="w-5 h-5 flex-shrink-0 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={`flex items-center justify-between px-5 py-4 border-t ${
          isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800/50 border-gray-700'
        }`}>
          <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
            {filteredContacts.length} {contactType === 'group' ? 'nhóm' : contactType === 'user' ? 'liên hệ' : 'mục'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2 text-xs font-medium rounded-lg transition-colors ${
                isLight 
                  ? 'text-gray-700 bg-gray-100 hover:bg-gray-200'
                  : 'text-gray-300 bg-gray-700 hover:bg-gray-600'
              }`}
            >
              Đóng
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Contact Picker Field ─────────────────────────────────────────────────────

function ContactPickerField({
  value,
  onChange,
  contactType,
  placeholder,
  templateVars,
}: {
  value: string;
  onChange: (v: string) => void;
  contactType: 'user' | 'group' | 'all';
  placeholder?: string;
  templateVars?: string[];
}) {
  const { accounts } = useAccountStore();
  const [showModal, setShowModal] = React.useState(false);
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';


  return (
    <div className={`border rounded-xl overflow-hidden ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-800/30'}`}>
      {/* Current value display */}
      <div className="flex items-center gap-2 p-2">
        <input
          type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder || 'Nhập ID hoặc chọn từ danh bạ'}
          className={`flex-1 px-2 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-2 ${
            isLight
              ? 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-blue-500/30'
              : 'bg-gray-900/50 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500/30'
          }`}
        />
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
            isLight
              ? 'bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200'
              : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          Chọn
        </button>
      </div>

      {/* Template vars */}
      {templateVars && templateVars.length > 0 && (
        <div className={`px-3 py-2 border-t ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700/50 bg-gray-800/50'}`}>
          <div className={`text-[10px] mb-1.5 ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>
            Hoặc dùng biến:
          </div>
          <div className="flex flex-wrap gap-1">
            {templateVars.map(v => (
              <button
                key={v}
                type="button"
                onClick={() => onChange(`{{ ${v} }}`)}
                className={`px-2 py-1 text-[10px] font-mono rounded transition-colors ${
                  value === `{{ ${v} }}`
                    ? isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-500/30 text-blue-300'
                    : isLight ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                {`{{ ${v} }}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Modal */}
      <ContactPickerModal
        open={showModal}
        onClose={() => setShowModal(false)}
        contactType={contactType}
        value={value}
        onChange={onChange}
        accounts={accounts}
      />
    </div>
  );
}

// ─── File Picker Field ────────────────────────────────────────────────────────

function FilePickerField({
  value,
  onChange,
  fileType,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  fileType: 'image' | 'file';
  placeholder?: string;
}) {
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';
  const [previewError, setPreviewError] = React.useState(false);

  const handleSelectFile = async () => {
    try {
      const filters = fileType === 'image' 
        ? [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
        : [{ name: 'All Files', extensions: ['*'] }];
      
      const result = await ipc.file?.openDialog({ filters });
      
      if (result?.success && !result.canceled && result.filePaths?.[0]) {
        onChange(result.filePaths[0]);
        setPreviewError(false);
      }
    } catch (err) {
      console.warn('[FilePicker] Error selecting file:', err);
    }
  };

  const isUrl = value?.startsWith('http://') || value?.startsWith('https://');
  const isLocalFile = value && !isUrl && value.includes('\\');
  const showPreview = fileType === 'image' && value && !previewError;

  return (
    <div className={`border rounded-xl overflow-hidden ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-800/30'}`}>
      {/* Preview for images */}
      {showPreview && (
        <div className={`p-3 border-b ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/50'}`}>
          <div className="relative w-full h-32 rounded-lg overflow-hidden bg-gray-900/20">
            <img
              src={isUrl ? value : `file://${value}`}
              alt="Preview"
              className="w-full h-full object-contain"
              onError={() => setPreviewError(true)}
            />
          </div>
        </div>
      )}

      {/* Input and buttons */}
      <div className="flex items-center gap-2 p-2">
        <input
          type="text"
          value={value || ''}
          onChange={e => {
            onChange(e.target.value);
            setPreviewError(false);
          }}
          placeholder={placeholder || (fileType === 'image' ? 'Chọn ảnh hoặc nhập URL' : 'Chọn file từ máy tính')}
          className={`flex-1 px-2 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-2 ${
            isLight
              ? 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:ring-blue-500/30'
              : 'bg-gray-900/50 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500/30'
          }`}
        />
        <button
          type="button"
          onClick={handleSelectFile}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
            isLight
              ? 'bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200'
              : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {fileType === 'image' ? (
              <>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </>
            ) : (
              <>
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                <polyline points="13 2 13 9 20 9"/>
              </>
            )}
          </svg>
          Chọn {fileType === 'image' ? 'ảnh' : 'file'}
        </button>
      </div>

      {/* File info */}
      {value && (
        <div className={`px-3 py-2 border-t flex items-center gap-2 ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700/50 bg-gray-800/50'}`}>
          {isLocalFile ? (
            <>
              <svg className={`w-4 h-4 flex-shrink-0 ${isLight ? 'text-green-600' : 'text-green-400'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <span className={`text-[10px] truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
                File: {value.split('\\').pop()}
              </span>
            </>
          ) : isUrl ? (
            <>
              <svg className={`w-4 h-4 flex-shrink-0 ${isLight ? 'text-blue-600' : 'text-blue-400'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              <span className={`text-[10px] truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
                URL: {value}
              </span>
            </>
          ) : null}
          
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange('');
                setPreviewError(false);
              }}
              className={`ml-auto text-[10px] px-2 py-1 rounded transition-colors ${
                isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-500/20'
              }`}
            >
              Xóa
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function NodeConfigPanel({ node, onConfigChange, onLabelChange, onClose }: Props) {
  const { accounts } = useAccountStore();
  const [config, setConfig]             = useState<Record<string, any>>(node.config || {});
  const [label, setLabel]               = useState(node.label || '');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [panelWidth, setPanelWidth]     = useState(320);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loadedLabelOptions, setLoadedLabelOptions] = useState<LoadedLabelOption[]>([]);
  const [loadingLabelOptions, setLoadingLabelOptions] = useState(false);
  const [assistantList, setAssistantList] = useState<{ id: string; name: string; platform: string; model: string; enabled: boolean }[]>([]);
  const [loadingAssistants, setLoadingAssistants] = useState(false);
  const isResizingRef = useRef(false);
  const resizeStartXRef  = useRef(0);
  const resizeStartWRef  = useRef(320);

  const allFields   = CONFIG_SCHEMA[node.type] || [];
  const basicFields = allFields.filter(f => !f.advanced);
  const advFields   = allFields.filter(f =>  f.advanced);

  useEffect(() => {
    setConfig(node.config || {});
    setLabel(node.label || '');
    setShowAdvanced(false);
  }, [node.id]);

  // Stable account IDs string to prevent useEffect re-runs
  const accountIds = accounts.map(a => a.zalo_id).sort().join(',');

  useEffect(() => {
    if (node.type !== 'trigger.labelAssigned' && node.type !== 'zalo.assignLabel' && node.type !== 'zalo.removeLabel') {
      setLoadedLabelOptions([]);
      return;
    }
    
    let cancelled = false;
    const load = async () => {
      setLoadingLabelOptions(true);
      try {
        const opts: LoadedLabelOption[] = [];

        // Load local labels
        const localRes = await ipc.db?.getLocalLabels({});
        const locals = localRes?.labels || [];
        locals.forEach((l: any) => {
          if (!l?.id) return;
          const name = l.name || `Label #${l.id}`;
          const emoji = l.emoji || '🏷️';
          const pageIds = l.page_ids ? l.page_ids.split(',').filter(Boolean) : [];
          opts.push({
            value: `local:${l.id}`,
            label: `${emoji} ${name} (Local)`,
            source: 'local',
            color: l.color || '#14b8a6',
            textColor: l.text_color || '#ffffff',
            emoji,
            name,
            pageIds,
          });
        });

        // Fetch Zalo labels directly from API for each account
        const currentAccounts = useAccountStore.getState().accounts;
        
        for (const acc of currentAccounts) {
          try {
            const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
            const res = await ipc.zalo?.getLabels({ auth });
            
            const labels = res?.response?.labelData || [];
            labels.forEach((l: any) => {
              if (l?.id === undefined || l?.id === null) return;
              const text = l.text || `Label #${l.id}`;
              const emoji = l.emoji || '🏷️';
              opts.push({
                value: `zalo:${acc.zalo_id}:${l.id}`,
                label: `${emoji} ${text} (Zalo - ${acc.full_name || acc.zalo_id})`,
                source: 'zalo',
                color: l.color || '#a855f7',
                emoji,
                name: text,
                pageId: acc.zalo_id,
                pageName: acc.full_name || acc.zalo_id,
              });
            });
          } catch (err: any) {
            console.warn(`[LabelPicker] Account ${acc.zalo_id} error:`, err?.message || err);
            // Continue with other accounts
          }
        }

        const unique = new Map<string, LoadedLabelOption>();
        opts.forEach(o => {
          if (!unique.has(o.value)) unique.set(o.value, o);
        });
        
        if (!cancelled) setLoadedLabelOptions(Array.from(unique.values()));
      } finally {
        if (!cancelled) setLoadingLabelOptions(false);
      }
    };

    load().catch(() => {
      if (!cancelled) setLoadingLabelOptions(false);
    });

    return () => {
      cancelled = true;
    };
  }, [node.type, accountIds]); // Use stable accountIds string instead of accounts array

  // ── Load AI assistant list for assistant-picker ─────────────────────────
  useEffect(() => {
    if (node.type !== 'ai.generateText' && node.type !== 'ai.classify') {
      setAssistantList([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoadingAssistants(true);
      try {
        const res = await ipc.ai?.listAssistants();
        if (!cancelled && res?.success) {
          setAssistantList(
            (res.assistants || []).map((a: any) => ({
              id: a.id,
              name: a.name || 'Chưa đặt tên',
              platform: a.platform || '',
              model: a.model || '',
              enabled: a.enabled !== false,
            })),
          );
        }
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoadingAssistants(false); }
    };
    load();
    return () => { cancelled = true; };
  }, [node.type]);

  // ── Backward compat: default aiConfigMode for ai.generateText / ai.classify ──
  useEffect(() => {
    if (node.type !== 'ai.generateText' && node.type !== 'ai.classify') return;
    if (!config.aiConfigMode) {
      const mode = 'assistant';
      const next = { ...config, aiConfigMode: mode };
      setConfig(next);
      onConfigChange(next);
    }
  }, [node.type, config.aiConfigMode]);

  // ── Auto-select first enabled assistant when list loads ─────────────────
  useEffect(() => {
    if (node.type !== 'ai.generateText' && node.type !== 'ai.classify') return;
    if (config.aiConfigMode !== 'assistant') return;
    if (config.assistantId) return; // already selected
    if (loadingAssistants) return;
    const enabledList = assistantList.filter(a => a.enabled);
    if (enabledList.length > 0) {
      const next = { ...config, assistantId: enabledList[0].id };
      setConfig(next);
      onConfigChange(next);
    }
  }, [node.type, config.aiConfigMode, assistantList, loadingAssistants]);

  // ── Drag-resize logic ────────────────────────────────────────────────────
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current  = true;
    resizeStartXRef.current  = e.clientX;
    resizeStartWRef.current  = panelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      // dragging LEFT increases panel width; dragging RIGHT decreases
      const delta = resizeStartXRef.current - ev.clientX;
      setPanelWidth(Math.max(280, Math.min(720, resizeStartWRef.current + delta)));
    };
    const onUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ── Escape key to exit fullscreen ───────────────────────────────────────
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  const update = (key: string, value: any) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    onConfigChange(next);
  };

  const appendVar = (key: string, v: string) => update(key, (config[key] ?? '') + v);

  const renderField = (field: Field) => {
    // ── hideWhen: skip rendering if condition matches ──────────────────────
    if (field.hideWhenKey && field.hideWhenValue) {
      const cur = config[field.hideWhenKey] || '';
      // Nếu chưa có giá trị (old workflow), dùng default = 'assistant'
      const effective = field.hideWhenKey === 'aiConfigMode' && !cur ? 'assistant' : cur;
      if (effective === field.hideWhenValue) return null;
    }

    const isBool = field.type === 'boolean';
    return (
      <div key={field.key} className={isBool ? 'bg-gray-800/40 border border-gray-700/50 rounded-xl px-3 py-2.5' : ''}>
        {!isBool && <label className={labelCls}>{field.label}</label>}

        {field.type === 'text' && (
          <input value={config[field.key] ?? ''} onChange={e => update(field.key, e.target.value)}
            placeholder={field.placeholder} className={inputCls} />
        )}
        {(field.type === 'textarea' || field.type === 'multiline') && (
          field.htmlToggle && config[field.htmlToggle] ? (
            <HtmlEditorField
              value={config[field.key] ?? ''}
              onChange={v => update(field.key, v)}
              placeholder={field.placeholder}
              templateVars={field.templateVars}
            />
          ) : (
            <textarea value={config[field.key] ?? ''} onChange={e => update(field.key, e.target.value)}
              placeholder={field.placeholder} rows={field.type === 'multiline' ? 5 : 3}
              className={`${inputCls} resize-none`} />
          )
        )}
        {field.type === 'select' && (
          <select value={config[field.key] ?? field.options?.[0]?.value ?? ''}
            onChange={e => update(field.key, e.target.value)} className={selectCls}>
            {field.options?.map(opt => (
              <option key={opt.value} value={opt.value} className="bg-gray-800 text-white">{opt.label}</option>
            ))}
          </select>
        )}
        {field.type === 'number' && (
          <input type="number" value={config[field.key] ?? 0}
            onChange={e => update(field.key, Number(e.target.value))} className={inputCls} />
        )}
        {field.type === 'boolean' && (
          <ToggleSwitch checked={!!config[field.key]} onChange={v => update(field.key, v)}
            label={field.label} desc={field.desc} />
        )}
        {field.type === 'json' && (
          <textarea
            value={typeof config[field.key] === 'string' ? config[field.key] : JSON.stringify(config[field.key] ?? '', null, 2)}
            onChange={e => { try { update(field.key, JSON.parse(e.target.value)); } catch { update(field.key, e.target.value); } }}
            placeholder={field.hint || field.placeholder} rows={4}
            className={`${inputCls} resize-none font-mono text-xs`} />
        )}
        {field.type === 'cron' && (
          <CronField value={config[field.key] ?? ''} onChange={v => update(field.key, v)} placeholder={field.placeholder} />
        )}
        {field.type === 'html' && (
          <HtmlEditorField value={config[field.key] ?? ''} onChange={v => update(field.key, v)} placeholder={field.placeholder} />
        )}
        {field.type === 'label-picker' && (() => {
          // Tính mode: dynamic → phụ thuộc labelSource
          const pickerMode: 'single' | 'multi' =
            field.labelMode === 'dynamic'
              ? (config.labelSource === 'zalo' ? 'single' : 'multi')
              : (field.labelMode === 'single' ? 'single' : 'multi');
          
          // Pass ALL labels to picker - user can switch tabs Local/Zalo in modal
          // labelSource only affects mode (single for zalo, multi for local)
          return (
            <LabelPickerField
              value={Array.isArray(config[field.key]) ? config[field.key] : []}
              onChange={v => update(field.key, v)}
              options={loadedLabelOptions}
              loading={loadingLabelOptions}
              mode={pickerMode}
            />
          );
        })()}

        {/* ── Contact Picker ───────────────────────────────────────────── */}
        {field.type === 'contact-picker' && (
          <ContactPickerField
            value={config[field.key] ?? ''}
            onChange={v => update(field.key, v)}
            contactType={field.contactType || 'all'}
            placeholder={field.placeholder}
            templateVars={field.templateVars}
          />
        )}

        {/* ── File Picker ──────────────────────────────────────────────── */}
        {field.type === 'file-picker' && (
          <FilePickerField
            value={config[field.key] ?? ''}
            onChange={v => update(field.key, v)}
            fileType={field.fileType || 'file'}
            placeholder={field.placeholder}
          />
        )}

        {/* ── Assistant Picker ─────────────────────────────────────────── */}
        {field.type === 'assistant-picker' && (() => {
          const selected = config[field.key] ?? '';
          const enabledList = assistantList.filter(a => a.enabled);

          if (loadingAssistants) {
            return (
              <div className="flex items-center gap-2 py-3 text-gray-400 text-xs">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Đang tải danh sách trợ lý…
              </div>
            );
          }

          if (enabledList.length === 0) {
            return (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-3 py-3 text-xs">
                <p className="text-yellow-400 font-medium">⚠️ Chưa có trợ lý AI nào</p>
                <p className="text-yellow-400/70 mt-1">Vào <b>Tích hợp → Trợ lý AI</b> để tạo trợ lý trước, sau đó quay lại đây chọn.</p>
              </div>
            );
          }

          return (
            <div className="space-y-1.5">
              {enabledList.map(a => {
                const isActive = selected === a.id;
                const platformIcon = a.platform === 'openai' ? '🤖' : a.platform === 'gemini' ? '💎' : a.platform === 'deepseek' ? '🔮' : a.platform === 'grok' ? '⚡' : '🤖';
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => update(field.key, isActive ? '' : a.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                      isActive
                        ? 'bg-blue-600/20 border-blue-500/60 ring-1 ring-blue-500/30'
                        : 'bg-gray-800/60 border-gray-700/50 hover:border-gray-600 hover:bg-gray-800'
                    }`}
                  >
                    <span className="text-lg flex-shrink-0">{platformIcon}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${isActive ? 'text-blue-300' : 'text-gray-200'}`}>
                        {a.name}
                      </p>
                      <p className="text-[10px] text-gray-500 truncate">
                        {a.platform?.toUpperCase()} • {a.model}
                      </p>
                    </div>
                    {isActive && (
                      <svg className="w-5 h-5 text-blue-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })()}

        {field.desc && !isBool && <p className={descCls}>{field.desc}</p>}
        {field.hint && field.type !== 'json' && <p className={hintCls}>💡 {field.hint}</p>}
        {field.templateVars?.length && !isBool && !(field.htmlToggle && config[field.htmlToggle]) && (
          <TemplateVarChips vars={field.templateVars} onInsert={v => appendVar(field.key, v)} />
        )}
      </div>
    );
  };

  // ── Shared inner content ─────────────────────────────────────────────────
  const formContent = (
    <>
      {/* Tên hiển thị */}
      <div>
        <label className={labelCls}>Tên hiển thị</label>
        <input value={label}
          onChange={e => { setLabel(e.target.value); onLabelChange(e.target.value); }}
          className={inputCls} placeholder={getNodeLabel(node.type)} />
        <p className={descCls}>Tên gợi nhớ hiển thị trên node trong sơ đồ workflow.</p>
      </div>

      {allFields.length > 0 && <div className="border-t border-gray-700/50" />}

      {allFields.length === 0 && (
        <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl px-4 py-5 text-center">
          <div className="text-2xl mb-2">✅</div>
          <p className="text-gray-300 text-xs font-medium">Node này không cần cấu hình thêm</p>
          <p className="text-gray-600 text-[11px] mt-1">Chỉ cần kết nối với các node khác là đủ.</p>
        </div>
      )}

      {basicFields.map(renderField)}

      {advFields.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowAdvanced(p => !p)}
            className="w-full flex items-center gap-2 py-1.5 text-gray-500 hover:text-gray-300 transition-colors text-xs">
            <div className="flex-1 h-px bg-gray-700/60" />
            <span className="flex items-center gap-1.5 flex-shrink-0">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              {showAdvanced ? 'Ẩn bớt' : `${advFields.length} tùy chọn nâng cao`}
            </span>
            <div className="flex-1 h-px bg-gray-700/60" />
          </button>
          {showAdvanced && <div className="space-y-4 mt-2">{advFields.map(renderField)}</div>}
        </div>
      )}
    </>
  );

  const footer = (
    <div className="px-4 py-3 border-t border-gray-700/60 flex-shrink-0">
      <div className="bg-gray-800/60 rounded-xl px-3 py-2">
        <p className="text-[11px] text-gray-500 font-medium mb-1.5">Cú pháp chèn biến động</p>
        <div className="flex flex-wrap gap-1">
          {['$trigger.fromName','$trigger.content','$trigger.threadId','$date.today'].map(v => (
            <code key={v}
              onClick={() => { navigator.clipboard.writeText(`{{${v}}}`).catch(()=>{}); }}
              title={`Click để copy: {{${v}}}`}
              className="text-[9px] text-blue-400 bg-blue-500/10 px-1 py-0.5 rounded font-mono cursor-pointer hover:bg-blue-500/20 transition-colors select-all">
              {`{{${v}}}`}
            </code>
          ))}
        </div>
        <p className="text-[9px] text-gray-600 mt-1.5">Click để copy vào clipboard</p>
      </div>
    </div>
  );

  const headerBtns = (
    <div className="flex items-center gap-1 flex-shrink-0">
      {/* Fullscreen toggle */}
      <button onClick={() => setIsFullscreen(f => !f)} title={isFullscreen ? 'Thu nhỏ (Esc)' : 'Mở rộng toàn màn hình'}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
        {isFullscreen ? (
          /* Compress icon */
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/>
            <path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>
          </svg>
        ) : (
          /* Expand icon */
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
            <path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
          </svg>
        )}
      </button>
      {/* Close */}
      <button onClick={onClose} title="Đóng"
        className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );

  // ── Fullscreen modal ─────────────────────────────────────────────────────
  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) setIsFullscreen(false); }}>
        <div className="bg-gray-900 border border-gray-700/60 rounded-2xl shadow-2xl flex flex-col"
          style={{ width: 'min(860px, 92vw)', height: 'min(90vh, 900px)' }}>
          {/* Header */}
          <div className="px-5 py-3.5 border-b border-gray-700/60 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base">⚙️</span>
              <div className="min-w-0">
                <p className="text-white text-sm font-semibold truncate">{node.label || getNodeLabel(node.type)}</p>
                <p className="text-gray-500 text-[11px]">{getNodeLabel(node.type)}</p>
              </div>
            </div>
            {headerBtns}
          </div>
          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {formContent}
          </div>
          {footer}
        </div>
      </div>
    );
  }

  // ── Normal sidebar panel (resizable) ────────────────────────────────────
  return (
    <div className="relative bg-gray-900 border-l border-gray-700/60 flex flex-col h-full overflow-hidden flex-shrink-0"
      style={{ width: panelWidth }}>

      {/* ← Drag-resize handle on left edge */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize group z-10 hover:bg-blue-500/40 transition-colors"
        title="Kéo để thay đổi chiều rộng">
        {/* Visual indicator on hover */}
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-10 rounded-full bg-gray-600 group-hover:bg-blue-400 transition-colors mx-auto" style={{ marginLeft: '0.125rem' }} />
      </div>

      {/* Header */}
      <div className="pl-4 pr-3 py-3 border-b border-gray-700/60 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">⚙️</span>
          <div className="min-w-0">
            <p className="text-white text-sm font-semibold truncate leading-tight">{node.label || getNodeLabel(node.type)}</p>
            <p className="text-gray-600 text-[11px] truncate">{getNodeLabel(node.type)}</p>
          </div>
        </div>
        {headerBtns}
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {formContent}
      </div>

      {footer}
    </div>
  );
}
