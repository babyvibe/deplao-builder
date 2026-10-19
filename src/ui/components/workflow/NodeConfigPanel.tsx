import React, { useEffect, useRef, useState } from 'react';
import ipc, {buildZaloAuth} from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { CHANNEL } from '@/lib/channelHelper';
import { AI_MODEL_OPTIONS } from '../../../shared/aiModelCatalog';
import PublicAddressCard from '@/components/common/PublicAddressCard';

// ─── Webhook URL field component ─────────────────────────────────────
// Địa chỉ webhook chỉ để xem (mọi cách tạo địa chỉ, PublicAddressCard): bật / tắt / đổi địa chỉ ở
// Cài đặt → Internet & Đám mây → Địa chỉ Internet. Ở đây chỉ còn token + tạo token mới.
function WebhookUrlField({ field, config, workflowId, update }: {
  field: any; config: any; workflowId?: string; update: (key: string, val: any) => void;
}) {
  const [webhookToken, setWebhookToken] = React.useState<string>(config.webhookToken || '');
  React.useEffect(() => {
    setWebhookToken(config.webhookToken || '');
  }, [config.webhookToken]);
  // The field label is rendered by renderField's header row, so the card starts with the URL.
  return (
    <div className="space-y-2">
      {webhookToken ? (
        <div className="wf-card p-3 space-y-2.5">
          <PublicAddressCard
            service="workflow"
            title="Địa chỉ webhook"
            pathSuffix={`/api/workflow/webhook/${webhookToken}`}
            anyMode
            compact
          />
          <div className="flex items-center gap-2 text-xs wf-muted">
            <span className="min-w-0 truncate">Token: <code className="wf-var">{webhookToken.substring(0, 8)}...</code></span>
            <button type="button" onClick={() => {
              // Hướng dẫn nhận webhook: Công cụ → Ứng dụng, API & Webhook → Webhook → Nhận dữ liệu vào.
              const app = useAppStore.getState();
              app.setPluginHubSection('webhooks');
              app.openPluginHub();
            }} className="wf-btn wf-btn--sm wf-btn--ghost ml-auto flex-shrink-0"><BookIcon className="w-3.5 h-3.5" /> Hướng dẫn
            </button>
            <button type="button" onClick={async () => {
              const confirmed = await showConfirm({
                title: 'Tạo token mới?',
                message: 'Token mới sẽ làm URL webhook cũ không còn hoạt động. Các bên thứ 3 đang dùng URL cũ sẽ cần được cập nhật.',
                confirmText: 'Tạo mới',
                variant: 'warning',
              });
              if (!confirmed) return;
              const res = await ipc.workflow?.regenerateWebhookToken?.(workflowId);
              if (res?.success) {
                setWebhookToken(res.token || '');
                update('webhookToken', res.token || '');
              }
            }} className="wf-btn wf-btn--sm wf-btn--ghost flex-shrink-0" title="Tạo token mới nếu URL bị lộ"><RefreshIcon className="w-3.5 h-3.5" /> Regenerate
            </button>
          </div>
        </div>
      ) : (
        <div className="wf-callout" data-tone="warn"><SunIcon className="w-3.5 h-3.5" /><span>Lưu workflow để tạo URL webhook tự động.</span>
        </div>
      )}
      <p className="wf-help">{field.desc}</p>
    </div>
  );
}
import { showConfirm } from '@/components/common/ConfirmDialog';

import { getNodeLabel } from './workflowConfig';
import { CHANNEL_NAME, NodeIconTile, accentStyle, getNodeDescription, getNodeVisual } from './nodeVisuals';
import TemplateVarPopup from './TemplateVarPopup';
import { ContactPickerField } from './ContactPicker';
import { isTriggerType, isVarAvailable, upstreamNodeIds, VarNode } from './templateVars';
import { pluginFieldsFor } from './pluginNodes';
import { AlertIcon, ArrowDownIcon, BellIcon, BellOffIcon, BookIcon, BotIcon, CalendarIcon, ChatIcon, CheckCircleIcon, CheckIcon, ChevronDownIcon, ClipboardIcon, ClipboardListIcon, ClockIcon, CloseIcon, CopyIcon, DatabaseIcon, DiamondIcon, EditIcon, EyeIcon, FilterIcon, FlagIcon, GlobeIcon, HardDriveIcon, HelpCircleIcon, ImageIcon, InboxIcon, InfoIcon, LightbulbIcon, LightningIcon, LinkIcon, MaximizeIcon, MessageSquareIcon, MinimizeIcon, PaletteIcon, PaperclipIcon, PlusIcon, RefreshIcon, SearchIcon, SendIcon, SettingsIcon, ShieldIcon, ShuffleIcon, SlidersIcon, StarIcon, SunIcon, TagIcon, TargetIcon, TrashIcon, UserIcon, UsersIcon } from '@/components/common/icons';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * UI-only types added with the settings panel v2:
 * - 'chips'       multi-select pills, value string[] (missing → [] = "all")
 * - 'choice'      single-select pills/segmented control, same value semantics as 'select'
 * - 'time-window' active-hours editor, value { mode, start, end, days } (see TimeWindowField)
 */
type FieldType = 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'json' | 'multiline' | 'cron' | 'html' | 'info' | 'label-picker' | 'assistant-picker' | 'integration-picker' | 'contact-picker' | 'account-picker' | 'file-picker' | 'case-list' | 'chips' | 'choice' | 'time-window';

interface SelectOption { value: string; label: string }

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: SelectOption[];
  placeholder?: string;
  isWebhookUrl?: boolean;
  hint?: string;
  /** Mô tả rõ ràng cho newbie - hiển thị bên dưới ô nhập */
  desc?: string;
  /** Đưa vào mục "Nâng cao" (luôn nằm cuối, mở sẵn mặc định). Bỏ qua khi đã đặt `section`. */
  advanced?: boolean;
  /**
   * Tên nhóm (thẻ section) chứa field trong bảng cài đặt, vd: 'Phạm vi', 'Người gửi', 'Nội dung'.
   * Các section hiện theo thứ tự field đầu tiên xuất hiện trong schema. Không đặt →
   * 'Cấu hình' (hoặc 'Nâng cao' nếu `advanced`). Icon của section lấy theo tên (SECTION_ICONS).
   */
  section?: string;
  /**
   * Biến gợi ý (tên variable, VD: '$trigger.fromName').
   * Nếu có field này, UI sẽ hiện nút "Chèn biến động" để mở popup
   * danh sách đầy đủ các variable từ templateVars.ts.
   * Xem templateVars.ts để biết tất cả variable khả dụng.
   */
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
   * Dùng khi type === 'contact-picker':
   * - 'single' = chọn 1 (giá trị string, mặc định)
   * - 'multi'  = chọn nhiều (giá trị JSON string array)
   */
  contactMode?: 'single' | 'multi';
  /**
   * Dùng khi type === 'contact-picker':
   * Lọc tài khoản theo kênh (vd: 'telegram_user' → chỉ hiện tài khoản Telegram)
   */
  channel?: string;
  /** Read channel/account from another config field for cross-channel actions. */
  channelFromKey?: string;
  accountIdFromKey?: string;
  /**
   * Dùng khi type === 'file-picker':
   * - 'image' = chỉ chọn ảnh
   * - 'file'  = chọn mọi loại file
   */
  fileType?: 'image' | 'file';
  /** Ẩn field khi config[hideWhenKey] === hideWhenValue */
  hideWhenKey?: string;
  hideWhenValue?: string;
  /** Khi field này thay đổi, xoá các key con này khỏi config (vd: platform → model) */
  clearsKeyOnChange?: string[];
  /** Lọc options theo giá trị field khác: key=field cần check, map=giá_trị→values_được_hiển_thị */
  optionsFilter?: { key: string; map: Record<string, string[]> };
  /** Giá trị tối thiểu cho number input */
  min?: number;
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

// Ô SĐT / mã đơn của các node tra cứu POS. Điều kiện trống → engine không tra cứu, trả found = false
// (services/workflow/posLookupGuard.ts) vì vài nền tảng trả danh sách không lọc.
const POS_PHONE_HINT = 'Mặc định {{ $trigger.fromPhone }} = SĐT đã lưu của người nhắn (Zalo / Telegram, lưu ở Thông tin hội thoại hoặc CRM); khách tự gửi số thì chèn Nội dung tin nhắn.';
const POS_CUSTOMER_EMPTY_NOTE = 'Ô trống → không tra cứu (found = false) để không trả về khách hàng khác.';
const POS_ORDER_EMPTY_NOTE = 'SĐT và mã đơn đều trống → không tra cứu (found = false) để không trả về đơn của khách khác.';

export const CONFIG_SCHEMA: Record<string, Field[]> = {
  'action.forwardCrossChannel': [
    { key: 'sourceChannel', label: 'Kênh tài khoản nguồn', type: 'select', options: [
      { value: '', label: 'Tự lấy từ trigger workflow' },
      { value: 'zalo', label: 'Zalo' }, { value: 'facebook', label: 'Facebook' }, { value: 'telegram_user', label: 'Telegram User' }, { value: 'telegram_bot', label: 'Telegram Bot' },
    ], clearsKeyOnChange: ['sourceAccountId'] },
    { key: 'sourceAccountId', label: 'Tài khoản nguồn', type: 'account-picker', channelFromKey: 'sourceChannel', placeholder: 'Để trống = tài khoản kích hoạt workflow' },
    { key: 'sourceChatId', label: 'Chat nguồn', type: 'text', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'Tin nhắn cần chuyển tiếp', type: 'text', placeholder: '{{ $trigger.messageId }}', desc: 'Dùng ID từ trigger để chuyển tiếp đúng tin vừa nhận.', templateVars: ['$trigger.messageId'] },
    { key: 'targetChannel', label: 'Kênh đích', type: 'select', options: [
      { value: 'zalo', label: 'Zalo' }, { value: 'facebook', label: 'Facebook' }, { value: 'telegram_user', label: 'Telegram User' }, { value: 'telegram_bot', label: 'Telegram Bot' },
    ], clearsKeyOnChange: ['targetAccountId', 'targetChatId'] },
    { key: 'targetAccountId', label: 'Tài khoản gửi ở kênh đích', type: 'account-picker', channelFromKey: 'targetChannel', placeholder: 'Chọn tài khoản đích' },
    { key: 'targetChatId', label: 'Chat nhận', type: 'contact-picker', contactType: 'all', channelFromKey: 'targetChannel', accountIdFromKey: 'targetAccountId', placeholder: 'Chọn chat thuộc tài khoản đích' },
    { key: 'targetThreadType', label: 'Loại chat đích', type: 'select', options: [{ value: '0', label: 'Cá nhân / chat thường' }, { value: '1', label: 'Nhóm (Zalo)' }], desc: 'Chỉ dùng cho Zalo; Telegram và Facebook tự nhận diện chat.', advanced: true },
    { key: 'companionText', label: 'Tin nhắn gửi kèm', type: 'textarea', placeholder: 'Không bắt buộc — được gửi thành tin riêng sau tin gốc', desc: 'Giữ nguyên tin gốc; nội dung này luôn được gửi thành tin nhắn riêng.', advanced: true, templateVars: ['$trigger.content'] },
    { key: 'info', label: 'Quy tắc chuyển tiếp', type: 'info', desc: 'Text, ảnh, video và file đã tải về được gửi lại giữa mọi kênh. Nếu media chưa có file local thì chỉ có thể native-forward trong cùng tài khoản và cùng kênh.' },
  ],
  'trigger.message': [
    {
      key: 'threadType', label: 'Nguồn tin nhắn', type: 'choice', section: 'Phạm vi',
      desc: 'Workflow sẽ lắng nghe tin nhắn từ đâu?',
      options: [
        { value: 'all', label: 'Tất cả (cá nhân + nhóm)' },
        { value: '0',   label: 'Chỉ tin nhắn cá nhân' },
        { value: '1',   label: 'Chỉ tin nhắn nhóm' },
      ],
    },
    {
      key: 'groupId', label: 'Chỉ nhận từ nhóm cụ thể', type: 'contact-picker', contactType: 'group', section: 'Phạm vi',
      placeholder: 'Để trống = tất cả các nhóm',
      desc: 'Chọn một nhóm cụ thể. Để trống = nhận từ tất cả nhóm.',
      advanced: true,
    },
    {
      key: 'excludeThreadIds', label: 'Loại trừ hội thoại / nhóm', type: 'contact-picker', section: 'Phạm vi',
      contactType: 'all', contactMode: 'multi',
      placeholder: 'Để trống = không loại trừ',
      desc: 'Không kích hoạt với các hội thoại hoặc nhóm được chọn.',
    },
    {
      key: 'senderRole', label: 'Vai trò người gửi trong nhóm', type: 'choice', section: 'Người gửi',
      desc: 'Chỉ áp dụng cho tin nhắn nhóm (vai trò lấy từ thông tin nhóm Zalo). Khi chọn khác "Tất cả", tin nhắn cá nhân sẽ không kích hoạt workflow.',
      options: [
        { value: 'all',     label: 'Tất cả' },
        { value: 'owner',   label: 'Trưởng nhóm' },
        { value: 'deputy',  label: 'Phó nhóm' },
        { value: 'admins',  label: 'Trưởng + phó nhóm' },
        { value: 'members', label: 'Thành viên thường' },
      ],
    },
    {
      key: 'fromId', label: 'Chỉ nhận từ người dùng cụ thể', type: 'contact-picker', contactType: 'user', section: 'Người gửi',
      placeholder: 'Để trống = tất cả mọi người',
      desc: 'Chọn một người cụ thể. Để trống = nhận từ tất cả.',
      advanced: true,
    },
    {
      key: 'excludeSenderIds', label: 'Loại trừ người gửi', type: 'contact-picker', section: 'Người gửi',
      contactType: 'user', contactMode: 'multi',
      placeholder: 'Để trống = không loại trừ ai',
      desc: 'Tin nhắn từ những người được chọn sẽ không kích hoạt workflow.',
    },
    {
      key: 'ignoreOwn', label: 'Bỏ qua tin nhắn do mình gửi', type: 'boolean', section: 'Người gửi',
      desc: 'Bật để tránh workflow tự kích hoạt khi tài khoản này tự gửi tin.',
    },
    {
      key: 'onlyOwn', label: 'Chỉ xử lý tin mình tự gửi', type: 'boolean', section: 'Người gửi',
      desc: 'Ngược lại - chỉ chạy với tin nhắn từ chính tài khoản này.',
    },
    {
      key: 'keyword', label: 'Từ khóa kích hoạt', type: 'text', section: 'Nội dung',
      placeholder: 'giá, báo giá, order',
      desc: 'Workflow chỉ chạy khi tin nhắn chứa một trong các từ khóa này. Nhập nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = mọi tin nhắn đều kích hoạt.',
    },
    {
      key: 'keywordMode', label: 'Cách khớp từ khóa', type: 'select', section: 'Nội dung',
      desc: 'Quy tắc áp dụng khi kiểm tra từ khóa trong tin nhắn.',
      options: [
        { value: 'contains_any', label: 'Chứa ít nhất 1 từ khóa (phổ biến nhất)' },
        { value: 'contains_all', label: 'Phải chứa đủ tất cả từ khóa' },
        { value: 'equals',       label: 'Khớp chính xác nguyên câu' },
        { value: 'starts_with',  label: 'Bắt đầu bằng từ khóa' },
        { value: 'regex',        label: 'Regex - biểu thức chính quy (nâng cao)' },
      ],
    },
    {
      key: 'messageTypes', label: 'Loại tin nhắn', type: 'chips', section: 'Nội dung',
      desc: 'Chỉ kích hoạt với các loại tin được chọn, vd. chỉ chọn "Văn bản" để bỏ qua sticker và hình ảnh.',
      options: [
        { value: 'text',    label: 'Văn bản' },
        { value: 'image',   label: 'Hình ảnh' },
        { value: 'sticker', label: 'Sticker' },
        { value: 'file',    label: 'Tệp' },
        { value: 'voice',   label: 'Ghi âm' },
        { value: 'video',   label: 'Video' },
        { value: 'link',    label: 'Liên kết' },
        { value: 'other',   label: 'Khác' },
      ],
    },
    {
      key: 'onlyWhenMentioned', label: 'Chỉ khi được @nhắc tên trong nhóm', type: 'boolean', section: 'Nội dung',
      desc: 'Tin nhắn nhóm chỉ kích hoạt khi @nhắc đến tài khoản này hoặc @Tất cả. Tin nhắn cá nhân không bị ảnh hưởng.',
    },
    {
      key: 'activeHours', label: 'Khung giờ hoạt động', type: 'time-window', section: 'Thời gian & tần suất',
      desc: 'Trong khung giờ: chỉ chạy trong giờ đã chọn. Ngoài khung giờ: chỉ chạy ngoài giờ đó, vd. tự động trả lời ngoài giờ làm việc.',
    },
    {
      key: 'cooldownMinutes', label: 'Giới hạn tần suất (phút)', type: 'number', section: 'Thời gian & tần suất',
      placeholder: '0', min: 0,
      desc: 'Sau khi workflow chạy cho một hội thoại, các tin nhắn tiếp theo từ hội thoại đó bị bỏ qua trong N phút (vd. 60 = tối đa 1 lần mỗi giờ). 0 = tắt. Bộ đếm được đặt lại khi khởi động lại ứng dụng.',
    },
    {
      key: 'debounceSeconds', label: 'Gom tin nhắn liên tiếp (giây)', type: 'number', section: 'Thời gian & tần suất',
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
        { value: 'all',           label: 'Mọi sự kiện nhóm' },
        { value: 'join',          label: 'Thành viên mới tham gia' },
        { value: 'leave',         label: 'Thành viên tự rời nhóm' },
        { value: 'remove_member', label: 'Thành viên bị xóa khỏi nhóm' },
        { value: 'update',        label: 'Thông tin nhóm thay đổi' },
        { value: 'add_admin',     label: 'Thêm quản trị viên mới' },
        { value: 'remove_admin',  label: 'Xóa quyền quản trị viên' },
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
        { value: 'any', label: 'Bất kỳ cảm xúc nào' },
        { value: '1',   label: 'Like' },
        { value: '2',   label: 'Yêu thích' },
        { value: '3',   label: 'Haha' },
        { value: '4',   label: 'Wow' },
        { value: '5',   label: 'Buồn' },
        { value: '6',   label: 'Giận' },
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
        { value: 'any',      label: 'Cả khi gán và khi gỡ nhãn' },
        { value: 'assigned', label: 'Chỉ khi nhãn được gán vào' },
        { value: 'removed',  label: 'Chỉ khi nhãn bị gỡ ra' },
      ],
    },
    {
      key: 'labelSource', label: 'Nguồn nhãn', type: 'select',
      desc: 'Lọc theo loại Nhãn Local hay nhãn Zalo.',
      options: [
        { value: 'any',   label: 'Cả Local và Zalo' },
        { value: 'local', label: 'Chỉ Nhãn Local' },
        { value: 'zalo',  label: 'Chỉ nhãn Zalo' },
      ],
    },
    {
      key: 'labelIds', label: 'Nhãn cần lọc', type: 'label-picker', labelMode: 'multi',
      desc: 'Để trống = kích hoạt với mọi nhãn. Có thể chọn nhiều nhãn - workflow chạy khi bất kỳ nhãn nào được gán/gỡ.',
    },
  ],
  'trigger.telegramCommand': [
    {
      key: 'integrationId', label: 'Chọn Bot Telegram', type: 'integration-picker',
      desc: 'Chọn Bot Telegram đã kết nối trong Settings → Tích hợp.',
    },
    {
      key: 'command', label: 'Lệnh kích hoạt', type: 'text',
      placeholder: '/baocao',
      desc: 'Lệnh mà người dùng gửi cho Bot để kích hoạt workflow. Bắt đầu bằng dấu /. Để trống = mọi tin nhắn đều kích hoạt.',
    },
    {
      key: 'chatIdFilter', label: 'Chỉ nhận từ Chat ID cụ thể', type: 'text',
      placeholder: 'Để trống = nhận từ tất cả',
      desc: 'Nhập Chat ID nếu chỉ muốn nhận lệnh từ một người hoặc nhóm cụ thể.',
      advanced: true,
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
        { value: 'Asia/Ho_Chi_Minh', label: 'Việt Nam (UTC+7)' },
        { value: 'Asia/Bangkok',     label: 'Bangkok (UTC+7)' },
        { value: 'Asia/Singapore',   label: 'Singapore (UTC+8)' },
        { value: 'UTC',              label: 'UTC (chuẩn quốc tế)' },
      ],
      advanced: true,
    },
  ],
  'zalo.sendMessage': [
    {
      key: 'message', label: 'Nội dung tin nhắn', type: 'textarea', section: 'Nội dung',
      placeholder: 'Xin chào {{ $trigger.fromName }}! Mình có thể giúp gì?',
      desc: 'Nội dung tin nhắn gửi đi. Dùng {{ }} để chèn dữ liệu động như tên người dùng.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', section: 'Người nhận',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại để gửi. Nếu không chọn, sẽ dùng hội thoại từ trigger. Bình thường dùng $trigger.threadId; với trigger Webhook dùng $trigger.body.threadId.',
      templateVars: ['$trigger.threadId', '$trigger.body.threadId'],
    },
    {
      key: 'threadIdsExpr', label: 'Danh sách hội thoại động (nâng cao)', type: 'text', section: 'Người nhận',
      placeholder: '{{ $node.Chọn đối tượng nhận tin.result }}',
      desc: 'Nhập danh sách ID hội thoại dạng JSON, hoặc tham chiếu node "Chọn đối tượng nhận tin" để gửi hàng loạt. Ưu tiên hơn trường chọn hội thoại ở trên.',
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select', section: 'Người nhận',
      desc: 'Loại hội thoại đang gửi. Giữ "Tự động" để hệ thống tự nhận biết.',
      options: [
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger - khuyến nghị)' },
        { value: '0', label: 'Cá nhân' },
        { value: '1', label: 'Nhóm' },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: 'Giãn cách gửi tối thiểu (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '1',
      desc: 'Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin trả lời gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. Tránh bắn hàng loạt bị Zalo nghi spam. 0 = gửi ngay. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).',
      advanced: true,
    },
    {
      key: 'sendDelayMaxSeconds', label: 'Giãn cách gửi tối đa (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '3',
      desc: 'Khoảng giãn cách tối đa. Hệ thống chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.',
      advanced: true,
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', section: 'Tùy chọn',
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
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger - khuyến nghị)' },
        { value: '0', label: 'Cá nhân (DM)' },
        { value: '1', label: 'Nhóm' },
      ],
    },
    {
      key: 'delaySeconds', label: 'Chờ bao lâu trước bước tiếp', type: 'select',
      desc: 'Sau khi gửi "đang gõ", workflow sẽ dừng bấy nhiêu giây rồi mới chạy thẻ tiếp theo (thường là Gửi tin nhắn). Giúp tạo cảm giác tự nhiên như người thật đang soạn.',
      options: [
        { value: '1',  label: '1 giây (nhanh)' },
        { value: '3',  label: '3 giây (mặc định)' },
        { value: '5',  label: '5 giây (soạn lâu hơn)' },
        { value: '10', label: '10 giây (rất lâu)' },
      ],
    },
  ],
  'zalo.sendImage': [
    {
      key: 'filePath', label: 'Ảnh cần gửi', type: 'file-picker', fileType: 'image', section: 'Nội dung',
      desc: 'Chọn ảnh từ máy tính để gửi.',
    },
    {
      key: 'message', label: 'Chú thích ảnh (tuỳ chọn)', type: 'text', section: 'Nội dung',
      placeholder: 'Đây là bảng giá mới nhất!',
      desc: 'Dòng chữ hiển thị kèm ảnh. Có thể để trống.',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', section: 'Người nhận',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại để gửi ảnh. Nếu không chọn, sẽ dùng hội thoại từ trigger.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select', section: 'Người nhận',
      desc: 'Loại hội thoại đang gửi.',
      options: [
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger)' },
        { value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: 'Giãn cách gửi tối thiểu (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '1',
      desc: 'Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. 0 = gửi ngay. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).',
      advanced: true,
    },
    {
      key: 'sendDelayMaxSeconds', label: 'Giãn cách gửi tối đa (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '3',
      desc: 'Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.',
      advanced: true,
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', section: 'Tùy chọn',
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi ảnh lỗi.',
      advanced: true,
    },
  ],
  'zalo.sendFile': [
    {
      key: 'filePath', label: 'File cần gửi', type: 'file-picker', fileType: 'file', section: 'Nội dung',
      desc: 'Chọn file từ máy tính để gửi.',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', section: 'Người nhận',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại để gửi file. Nếu không chọn, sẽ dùng hội thoại từ trigger.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select', section: 'Người nhận',
      desc: 'Loại hội thoại đang gửi.',
      options: [
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger)' },
        { value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: 'Giãn cách gửi tối thiểu (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '1',
      desc: 'Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. 0 = gửi ngay. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).',
      advanced: true,
    },
    {
      key: 'sendDelayMaxSeconds', label: 'Giãn cách gửi tối đa (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '3',
      desc: 'Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.',
      advanced: true,
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', section: 'Tùy chọn',
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi file lỗi.',
      advanced: true,
    },
  ],
  'zalo.sendVoice': [
    {
      key: 'filePath', label: 'File âm thanh cần gửi', type: 'file-picker', fileType: 'file', section: 'Nội dung',
      desc: 'Chọn file tin thoại (m4a/mp3) từ máy tính để gửi.',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', section: 'Người nhận',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại để gửi tin thoại. Nếu không chọn, sẽ dùng hội thoại từ trigger.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select', section: 'Người nhận',
      options: [
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger)' },
        { value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: 'Giãn cách gửi tối thiểu (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '1', advanced: true,
      desc: 'Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).',
    },
    {
      key: 'sendDelayMaxSeconds', label: 'Giãn cách gửi tối đa (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '3', advanced: true,
      desc: 'Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.',
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', section: 'Tùy chọn',
      advanced: true,
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi tin thoại lỗi.',
    },
  ],
  'zalo.sendVideo': [
    {
      key: 'filePath', label: 'File video cần gửi', type: 'file-picker', fileType: 'file', section: 'Nội dung',
      desc: 'Chọn file video (mp4) từ máy tính để gửi.',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', section: 'Người nhận',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại để gửi video. Nếu không chọn, sẽ dùng hội thoại từ trigger.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select', section: 'Người nhận',
      options: [
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger)' },
        { value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: 'Giãn cách gửi tối thiểu (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '1', advanced: true,
      desc: 'Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).',
    },
    {
      key: 'sendDelayMaxSeconds', label: 'Giãn cách gửi tối đa (giây)', type: 'number', section: 'Tùy chọn',
      placeholder: '3', advanced: true,
      desc: 'Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.',
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', section: 'Tùy chọn',
      advanced: true,
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi video lỗi.',
    },
  ],
  'zalo.sendSticker': [
    {
      key: 'stickerId', label: 'ID sticker cần gửi', type: 'text',
      placeholder: 'Nhập ID sticker Zalo (số)',
      desc: 'ID của sticker trong bộ sưu tập Zalo. Bạn có thể lấy ID từ thư viện sticker Zalo.',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại để gửi sticker. Nếu không chọn, sẽ dùng hội thoại từ trigger.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      options: [
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger)' },
        { value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' },
      ],
      advanced: true,
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean',
      advanced: true,
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi sticker lỗi.',
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
        { value: 'mute',   label: 'Tắt thông báo' },
        { value: 'unmute', label: 'Bật lại thông báo' },
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
        { value: '{{ $trigger.threadType }}', label: 'Tự động (theo trigger)' },
        { value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' },
      ],
      advanced: true,
    },
  ],
  'zalo.forwardMessage': [
    {
      key: 'message', label: 'Nội dung chuyển tiếp', type: 'textarea',
      placeholder: '{{ $trigger.content }}',
      desc: 'Nội dung tin nhắn sẽ gửi đi. Dùng {{ $trigger.content }} để lấy nội dung từ tin nhắn trigger.',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'msgId', label: 'ID tin nhắn gốc (tham khảo)', type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: 'ID tin nhắn gốc - chỉ để tham chiếu, không dùng cho forward API.',
      templateVars: ['$trigger.msgId'],
      advanced: true,
    },
    {
      key: 'toThreadId', label: 'Chuyển đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: 'ID hội thoại đích',
      desc: 'ID hội thoại nơi tin nhắn sẽ được chuyển đến.',
    },
    {
      key: 'toThreadType', label: 'Loại hội thoại đích', type: 'select',
      options: [{ value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' }],
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
      options: [{ value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' }],
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
        { value: 'LIKE', label: '👍 Like' }, { value: 'HEART', label: '❤️ Yêu thích' },
        { value: 'HAHA', label: '😆 Haha' }, { value: 'WOW', label: '😮 Wow' },
        { value: 'CRY', label: '😢 Buồn' }, { value: 'ANGRY', label: '😡 Giận' },
      ],
    },
    {
      key: 'msgId', label: 'Tin nhắn cần react', type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: 'ID tin nhắn muốn thêm cảm xúc.',
      templateVars: ['$trigger.msgId'], advanced: true,
    },
    {
      key: 'clientMsgId', label: 'Client Message ID', type: 'text',
      placeholder: '{{ $trigger.cliMsgId }}',
      desc: 'Dùng ID gốc của tin nhắn. Hệ thống tự lấy khi workflow được kích hoạt từ tin nhắn Zalo.',
      templateVars: ['$trigger.cliMsgId'], advanced: true,
    },
    {
      key: 'threadId', label: 'Hội thoại chứa tin nhắn', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Cần để Zalo xác định tin nhắn thuộc hội thoại nào.',
      templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: 'Loại hội thoại', type: 'select',
      options: [{ value: '0', label: 'Cá nhân' }, { value: '1', label: 'Nhóm' }],
      placeholder: '{{ $trigger.threadType }}', advanced: true,
    },
  ],
  'zalo.assignLabel': [
    {
      key: 'labelSource', label: 'Loại nhãn', type: 'select',
      desc: 'Chọn Nhãn Local (quản lý trong CRM) hoặc nhãn Zalo (đồng bộ với ứng dụng Zalo).',
      options: [
        { value: 'local', label: 'Nhãn Local (quản lý trong app)' },
        { value: 'zalo',  label: 'Nhãn Zalo (đồng bộ Zalo)' },
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
        { value: 'local', label: 'Nhãn Local (quản lý trong app)' },
        { value: 'zalo',  label: 'Nhãn Zalo (đồng bộ Zalo)' },
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
  'zalo.changeAliasName': [
    {
      key: 'friendId', label: 'Bạn bè cần đổi tên', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.fromId }}',
      desc: 'ID người dùng Zalo muốn đổi tên gợi nhớ. Giữ mặc định để áp dụng cho người gửi tin nhắn.',
      templateVars: ['$trigger.fromId'],
    },
    {
      key: 'alias', label: 'Tên gợi nhớ mới', type: 'text',
      placeholder: 'Nhập tên gợi nhớ (hỗ trợ biến)',
      desc: 'Tên mới sẽ hiển thị trong danh bạ của bạn. Dùng biến để tạo tên động, ví dụ: {{ $trigger.fromName }} - KH VIP',
      templateVars: ['$trigger.fromName', '$trigger.fromId', '$trigger.content'],
    },
  ],
  'logic.if': [
    {
      key: 'left', label: 'Giá trị cần kiểm tra', type: 'text', section: 'Điều kiện',
      placeholder: '{{ $trigger.content }}',
      desc: 'Giá trị bên trái để so sánh. Thường là nội dung tin nhắn hoặc một biến đã lưu.',
      templateVars: ['$trigger.content', '$trigger.fromName', '$trigger.fromId'],
    },
    {
      key: 'operator', label: 'Điều kiện so sánh', type: 'select', section: 'Điều kiện',
      desc: 'Quy tắc so sánh giữa hai giá trị.',
      options: [
        { value: 'contains',     label: 'Có chứa chuỗi' },
        { value: 'not_contains', label: 'Không chứa chuỗi' },
        { value: 'equals',       label: '= Bằng chính xác' },
        { value: 'not_equals',   label: 'Khác' },
        { value: 'starts_with',  label: 'Bắt đầu bằng' },
        { value: 'ends_with',    label: 'Kết thúc bằng' },
        { value: 'greater_than', label: '> Lớn hơn (số)' },
        { value: 'less_than',    label: '< Nhỏ hơn (số)' },
        { value: 'is_empty',     label: 'Rỗng / trống' },
        { value: 'not_empty',    label: 'Không rỗng' },
        { value: 'regex',        label: 'Regex (nâng cao)' },
      ],
    },
    {
      key: 'right', label: 'So sánh với giá trị', type: 'text', section: 'Điều kiện',
      placeholder: 'Nhập từ khóa hoặc giá trị cần so sánh',
      desc: 'Giá trị bên phải. Ví dụ: nếu trái là nội dung tin nhắn thì phải là từ khóa cần tìm.',
    },
  ],
  'logic.switch': [
    {
      key: 'value', label: 'Giá trị để phân nhánh', type: 'text', section: 'Điều kiện',
      placeholder: '{{ $trigger.content }}',
      desc: 'Giá trị này sẽ được so sánh với từng case để quyết định chạy nhánh nào.',
      templateVars: ['$trigger.content', '$trigger.fromId'],
    },
    {
      key: 'cases', label: 'Danh sách các nhánh', type: 'case-list', section: 'Các nhánh',
      desc: 'Mỗi nhánh có giá trị khớp (match) và tên nhánh (label). Nhánh có giá trị khớp sẽ được chạy; tên nhánh là tay cầm nối trên canvas.',
    },
    {
      key: 'defaultLabel', label: 'Nhánh mặc định (không khớp case nào)', type: 'text', section: 'Các nhánh',
      placeholder: 'default',
      desc: 'Nếu không có case nào khớp, workflow chạy theo nhánh có tên này.',
      advanced: true,
    },
  ],
  'logic.wait': [
    {
      key: 'delaySeconds', label: 'Thời gian chờ (giây)', type: 'number',
      desc: 'Tạm dừng workflow trước khi tiếp tục bước tiếp theo (tối đa 5 phút).',
      hint: '5 = 5 giây  •  60 = 1 phút  •  300 = 5 phút (tối đa)',
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
        { value: 'contains',     label: 'Có chứa' }, { value: 'not_contains', label: '⊅ Không chứa' },
        { value: 'is_empty',     label: 'Rỗng' }, { value: 'not_empty',    label: '● Không rỗng' },
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
      placeholder: '{{ $node.<id node>.products }}',
      desc: 'Chèn đúng một biến là danh sách của bước trước (vd. sản phẩm, đơn hàng, tin nhắn), hoặc nhập JSON ["a","b"] / mỗi dòng một mục. Các bước nối từ cổng "Mỗi phần tử" chạy lại cho từng phần tử; cổng "Xong" chạy một lần sau khi lặp hết.',
      templateVars: [],
    },
    {
      key: 'itemVariable', label: 'Tên biến cho từng phần tử', type: 'text',
      placeholder: 'item',
      desc: 'Phần tử đang xét lưu vào {{ $var.item }} (lấy một trường: {{ $var.item.name }}), số thứ tự từ 1 ở {{ $var.itemIndex }}. Chỉ dùng chữ không dấu, số, dấu _.',
    },
    {
      key: 'maxItems', label: 'Tối đa số phần tử', type: 'number', placeholder: '100', min: 1,
      desc: 'Chỉ lặp tối đa bấy nhiêu phần tử đầu (tối đa 100). Mỗi lần chạy workflow có tối đa 1.000 lượt lặp.',
      advanced: true,
    },
  ],
  'logic.forEachContact': [
    {
      key: 'source', label: 'Nguồn đối tượng', type: 'choice', section: 'Nguồn',
      options: [
        { value: 'friends', label: 'Bạn bè (danh bạ Zalo)' },
        { value: 'group_members', label: 'Thành viên nhóm Zalo' },
        { value: 'labels', label: 'Hội thoại theo nhãn (Local)' },
        { value: 'crm_contacts', label: 'Liên hệ CRM' },
      ],
      desc: 'Chọn danh sách người sẽ nhận tin. Nối node này vào node gửi tin rồi đặt trường "Gửi đến hội thoại" thành {{ $node.<tên node này>.result }}.',
    },
    {
      key: 'accountId', label: 'Tài khoản Zalo', type: 'account-picker', channel: 'zalo', section: 'Nguồn',
      placeholder: 'Để trống = tài khoản đang chạy workflow',
      desc: 'Tài khoản chứa danh sách đối tượng cần lấy.',
      advanced: true,
    },
    {
      key: 'groupId', label: 'ID nhóm Zalo', type: 'text', section: 'Nguồn',
      placeholder: 'Nhập ID nhóm (dùng khi nguồn = Thành viên nhóm)',
      desc: 'Chỉ cần điền khi chọn nguồn "Thành viên nhóm Zalo".',
      advanced: true,
    },
    {
      key: 'labelIds', label: 'Nhãn cần lọc', type: 'label-picker', labelMode: 'multi', section: 'Nguồn',
      desc: 'Chỉ lấy hội thoại đã gán các nhãn Local này. Chỉ cần điền khi chọn nguồn "Hội thoại theo nhãn".',
      advanced: true,
    },
    {
      key: 'limit', label: 'Giới hạn số người', type: 'number', section: 'Người nhận',
      placeholder: '500', min: 1,
      desc: 'Số người tối đa sẽ lấy. Giảm để tránh gửi quá nhiều.',
      advanced: true,
    },
    {
      key: 'excludeIds', label: 'Loại trừ người nhận', type: 'contact-picker', section: 'Người nhận',
      contactType: 'all', contactMode: 'multi',
      placeholder: 'Để trống = không loại trừ ai',
      desc: 'Những người/hội thoại này sẽ không nhận tin dù có trong danh sách.',
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
      desc: 'Mỗi dòng là một lựa chọn. Hệ thống chọn ngẫu nhiên 1 nội dung mỗi lần chạy - giúp câu trả lời không bị lặp.',
    },
  ],
  'data.dateFormat': [
    {
      key: 'format', label: 'Định dạng hiển thị ngày giờ', type: 'select',
      desc: 'Chọn cách hiển thị ngày giờ trong kết quả.',
      options: [
	{ value: 'datetime', label: 'Ngày + Giờ (25/03/2026 14:30)' },
	{ value: 'date', label: 'Chỉ ngày (25/03/2026)' },
	{ value: 'time', label: 'Chỉ giờ (14:30)' },
	{ value: 'full', label: 'Đầy đủ (Thứ Tư, 25/3/2026)' },
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
      key: 'url', label: 'Địa chỉ API (URL)', type: 'text', section: 'Kết nối API',
      placeholder: 'https://api.example.com/webhook',
      desc: 'Địa chỉ URL của API hoặc webhook cần gọi. Phải bắt đầu bằng https:// hoặc http://',
    },
    {
      key: 'method', label: 'Phương thức gửi', type: 'select', section: 'Kết nối API',
      desc: 'Cách gửi dữ liệu. POST = gửi dữ liệu lên, GET = lấy dữ liệu về.',
      options: [
        { value: 'POST',   label: 'POST - Gửi dữ liệu (phổ biến nhất cho webhook)' },
        { value: 'GET',    label: 'GET - Lấy dữ liệu từ server' },
        { value: 'PUT',    label: 'PUT - Cập nhật toàn bộ dữ liệu' },
        { value: 'PATCH',  label: 'PATCH - Cập nhật một phần' },
        { value: 'DELETE', label: 'DELETE - Xóa dữ liệu' },
      ],
    },
    {
      key: 'headers', label: 'Headers (xác thực / nâng cao)', type: 'textarea', section: 'Kết nối API',
      placeholder: '{"Authorization": "Bearer your-token"}',
      desc: 'HTTP Headers gửi kèm. Thường dùng để xác thực (Authorization token). Để trống nếu không cần.',
      hint: 'Ví dụ: {"Authorization": "Bearer abc123", "Content-Type": "application/json"}',
      advanced: true,
    },
    {
      key: 'body', label: 'Dữ liệu gửi kèm (Body)', type: 'textarea', section: 'Nội dung',
      placeholder: '{\n  "name": "{{ $trigger.fromName }}",\n  "msg": "{{ $trigger.content }}"\n}',
      desc: 'Nội dung gửi kèm (định dạng JSON). Dùng {{ }} để chèn dữ liệu động. Chỉ cần điền khi dùng POST/PUT/PATCH.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'timeout', label: 'Timeout (mili-giây)', type: 'number', section: 'Tùy chọn',
      desc: 'Nếu API không phản hồi sau thời gian này sẽ bị coi là lỗi. Mặc định 30000 = 30 giây.',
      advanced: true,
    },
    {
      key: 'continueOnError', label: 'Tiếp tục dù gọi API thất bại', type: 'boolean', section: 'Tùy chọn',
      desc: 'Bật nếu muốn workflow vẫn chạy tiếp dù API trả về lỗi.',
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
        { value: 'info',  label: 'Info - Thông tin bình thường' },
        { value: 'warn',  label: 'Warn - Cảnh báo cần chú ý' },
        { value: 'error', label: 'Error - Lỗi nghiêm trọng' },
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
      key: 'aiConfigMode', label: 'Cách cấu hình AI', type: 'select', section: 'Trợ lý AI',
      desc: 'Chọn trợ lý đã tạo sẵn (nhanh, tiện) hoặc tự nhập API key & model thủ công.',
      options: [
        { value: 'assistant', label: 'Chọn trợ lý AI đã tạo' },
        { value: 'manual',    label: 'Cài đặt thủ công (API key, model...)' },
      ],
    },
    {
      key: 'assistantId', label: 'Chọn trợ lý AI', type: 'assistant-picker', section: 'Trợ lý AI',
      desc: 'Chọn trợ lý đã tạo trong Tích hợp → Trợ lý AI. Sẽ dùng API key, model, system prompt từ trợ lý đó.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'manual',
    },
    {
      key: 'platform', label: 'Nền tảng AI', type: 'select', section: 'Trợ lý AI',
      desc: 'Chọn nhà cung cấp AI. Mỗi nền tảng cần API key riêng.',
      options: [
        { value: 'openai',   label: 'OpenAI (ChatGPT)' },
        { value: 'gemini',   label: 'Google Gemini' },
        { value: 'claude',   label: 'Anthropic Claude' },
        { value: 'deepseek', label: 'Deepseek' },
        { value: 'grok',     label: 'Grok (xAI)' },
        { value: 'mistral',  label: 'Mistral AI' },
        { value: 'openrouter', label: 'OpenRouter' },
      ],
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
      clearsKeyOnChange: ['model'],
    },
    {
      key: 'model', label: 'Model AI', type: 'select', section: 'Trợ lý AI',
      desc: 'Chọn model phù hợp với nền tảng đã chọn ở trên.',
      options: [
        // OpenAI
        { value: 'gpt-6-astra',      label: 'GPT-6 Astra - Reasoning, công việc phức tạp (OpenAI)' },
        { value: 'gpt-6.1-sol',      label: 'GPT-6.1 Sol - Cân bằng tốc độ, chất lượng (OpenAI)' },
        { value: 'gpt-6-luna',       label: 'GPT-6 Luna - Nhanh, tiết kiệm (OpenAI)' },
        { value: 'gpt-5.4',          label: 'GPT-5.4 - Flagship mới nhất (OpenAI)' },
        { value: 'gpt-5.4-pro',      label: 'GPT-5.4 Pro - Thông minh nhất (OpenAI)' },
        { value: 'gpt-5.4-mini',     label: 'GPT-5.4 Mini - Code, subagent (OpenAI - khuyến nghị)' },
        { value: 'gpt-5.4-nano',     label: 'GPT-5.4 Nano - Siêu rẻ (OpenAI)' },
        { value: 'gpt-5-mini',       label: 'GPT-5 Mini - Cân bằng, giá tốt (OpenAI)' },
        { value: 'gpt-5-nano',       label: 'GPT-5 Nano - Nhanh, rẻ nhất (OpenAI)' },
        { value: 'gpt-5',            label: 'GPT-5 - Lý luận mạnh (OpenAI)' },
        { value: 'o4-mini',          label: 'o4-mini - Lý luận nhanh (OpenAI)' },
        { value: 'o3',               label: 'o3 - Lý luận mạnh (OpenAI)' },
        { value: 'gpt-4.1',          label: 'GPT-4.1 - Legacy non-reasoning (OpenAI)' },
        // Gemini
        { value: 'gemini-3.5-flash',        label: 'Gemini 3.5 Flash - Mới nhất (Google - khuyến nghị)' },
        { value: 'gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro Preview - Mạnh nhất (Google)' },
        { value: 'gemini-3-flash-preview',  label: 'Gemini 3 Flash Preview - Nhanh (Google)' },
        { value: 'gemini-2.5-pro',          label: 'Gemini 2.5 Pro - Legacy ổn định (Google)' },
        // Claude (Anthropic)
        { value: 'claude-fable-5-1',          label: 'Claude Fable 5.1 - Reasoning dài hạn (Anthropic)' },
        { value: 'claude-opus-5-5',           label: 'Claude Opus 5.5 - Agentic, knowledge work (Anthropic)' },
        { value: 'claude-sonnet-5-5',         label: 'Claude Sonnet 5.5 - Cân bằng (Anthropic)' },
        { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 - Nhanh (Anthropic)' },
        { value: 'claude-4.6-sonnet-20260301',  label: 'Claude 4.6 Sonnet - Mới nhất (Anthropic - khuyến nghị)' },
        { value: 'claude-4.5-sonnet-20260115',  label: 'Claude 4.5 Sonnet - Cân bằng (Anthropic)' },
        { value: 'claude-4.0-haiku-20260101',   label: 'Claude 4.0 Haiku - Nhanh, rẻ (Anthropic)' },
        { value: 'claude-4.0-opus-20260101',    label: 'Claude 4.0 Opus - Mạnh nhất gen 4 (Anthropic)' },
        { value: 'claude-sonnet-4-20250514',    label: 'Claude Sonnet 4 - Legacy (Anthropic)' },
        // Deepseek
        { value: 'deepseek-flash',     label: 'Deepseek Flash - Mới nhất (Deepseek - khuyến nghị)' },
        { value: 'deepseek-v4-pro',    label: 'Deepseek V4 Pro - Thinking, mạnh nhất (Deepseek)' },
        { value: 'deepseek-reasoner',  label: 'Deepseek R1 - Lý luận ổn định (Deepseek)' },
        // Grok
        { value: 'grok-4-fast',      label: 'Grok 4 Fast - Nhanh (xAI - khuyến nghị)' },
        { value: 'grok-4',           label: 'Grok 4 - Flagship (xAI)' },
        { value: 'grok-4-mini',      label: 'Grok 4 Mini - Lý luận, rẻ (xAI)' },
        { value: 'grok-4-mini-fast', label: 'Grok 4 Mini Fast - Siêu nhanh (xAI)' },
        { value: 'grok-3',           label: 'Grok 3 - Legacy ổn định (xAI)' },
        // Mistral
        { value: 'mistral-large-2-latest',  label: 'Mistral Large 2 - Mạnh nhất (Mistral - khuyến nghị)' },
        { value: 'codestral-2-latest',      label: 'Codestral 2 - Code chuyên dụng (Mistral)' },
        { value: 'mistral-small-3-latest',  label: 'Mistral Small 3 - Nhanh, rẻ (Mistral)' },
        { value: 'mistral-medium-latest',   label: 'Mistral Medium - Cân bằng (Mistral)' },
        { value: 'open-mistral-nemo-2',     label: 'Mistral Nemo 2 - Nhẹ (Mistral)' },
        // OpenRouter
        { value: 'openrouter/auto',             label: 'Auto Router - Tự chọn model tốt nhất (OpenRouter - khuyến nghị)' },
        { value: 'openai/gpt-5.4-mini',         label: 'GPT-5.4 Mini - OpenAI qua OpenRouter' },
        { value: 'anthropic/claude-4.6-sonnet', label: 'Claude 4.6 Sonnet - Anthropic qua OpenRouter' },
        { value: 'google/gemini-3.5-flash',     label: 'Gemini 3.5 Flash - Google qua OpenRouter' },
        { value: 'deepseek/deepseek-v4-flash',  label: 'DeepSeek V4 Flash - Rẻ, nhanh (OpenRouter)' },
        { value: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick - Meta, open-source (OpenRouter)' },
        { value: 'qwen/qwen3-max',              label: 'Qwen3 Max - Alibaba (OpenRouter)' },
        { value: 'mistralai/mistral-large-2',   label: 'Mistral Large 2 (OpenRouter)' },
      ],
      optionsFilter: { key: 'platform', map: {
        openai:   ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'o4-mini', 'o3', 'gpt-4.1'],
        gemini:   ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro'],
        claude:   ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-4.6-sonnet-20260301', 'claude-4.5-sonnet-20260115', 'claude-4.0-haiku-20260101', 'claude-4.0-opus-20260101', 'claude-sonnet-4-20250514'],
        deepseek: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-reasoner'],
        grok:     ['grok-4-fast', 'grok-4', 'grok-4-mini', 'grok-4-mini-fast', 'grok-3'],
        mistral:  ['mistral-large-2-latest', 'codestral-2-latest', 'mistral-small-3-latest', 'mistral-medium-latest', 'open-mistral-nemo-2'],
        openrouter: ['openrouter/auto', 'openai/gpt-5.4-mini', 'anthropic/claude-4.6-sonnet', 'google/gemini-3.5-flash', 'deepseek/deepseek-v4-flash', 'meta-llama/llama-4-maverick', 'qwen/qwen3-max', 'mistralai/mistral-large-2'],
      }},
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'apiKey', label: 'API Key', type: 'text', section: 'Trợ lý AI',
      placeholder: 'sk-proj-... / AIza... / sk-ant-... / sk-...',
      desc: 'API key của nền tảng đã chọn. OpenAI: platform.openai.com | Gemini: aistudio.google.com | Claude: console.anthropic.com | Deepseek: platform.deepseek.com | Grok: console.x.ai | Mistral: console.mistral.ai | OpenRouter: openrouter.ai/settings/keys',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'systemPrompt', label: 'Ngữ cảnh / Vai trò của AI', type: 'textarea', section: 'Nội dung',
      placeholder: 'Bạn là nhân viên tư vấn bán hàng của shop [TÊN]. Trả lời ngắn gọn, thân thiện.',
      desc: 'Mô tả vai trò và phong cách trả lời của AI. Không hiển thị với người dùng.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'prompt', label: 'Câu hỏi / Yêu cầu cho AI', type: 'textarea', section: 'Nội dung',
      placeholder: 'Khách hỏi: {{ $trigger.content }}\n\nHãy trả lời ngắn gọn, thân thiện bằng tiếng Việt.',
      desc: 'Nội dung gửi đến AI để nhận câu trả lời. Dùng {{ }} để chèn tin nhắn từ khách hàng.',
      templateVars: ['$trigger.content', '$trigger.fromName', '$trigger.fromId'],
    },
    {
      key: 'chatHistory', label: 'Lịch sử chat (cho AI nhớ ngữ cảnh)', type: 'textarea', section: 'Nội dung',
      placeholder: '{{ $node.GetHistory.messages }}',
      desc: 'Truyền lịch sử hội thoại để AI nhớ ngữ cảnh. Có thể là mảng JSON [{role:"user",content:"..."},...] hoặc lịch sử Zalo từ node "Lấy lịch sử tin nhắn". Để trống nếu không cần nhớ ngữ cảnh.',
      templateVars: ['$node.GetHistory.messages'],
    },
    {
      key: 'maxHistoryMessages', label: 'Số tin nhắn lịch sử tối đa', type: 'number', section: 'Nội dung',
      placeholder: '20', min: 1,
      desc: 'Giới hạn bao nhiêu tin nhắn lịch sử được gửi kèm (để tiết kiệm token). Mặc định 20.',
    },
    {
      key: 'maxTokens', label: 'Độ dài tối đa (tokens)', type: 'number', section: 'Tùy chọn',
      placeholder: '500',
      desc: 'Giới hạn độ dài câu trả lời. 1 token ≈ 0.75 từ. 500 = ~375 từ.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'temperature', label: 'Mức độ sáng tạo (0.0 – 1.0)', type: 'number', section: 'Tùy chọn',
      placeholder: '0.7',
      desc: '0 = trả lời chính xác, ổn định. 1 = sáng tạo, đa dạng hơn. Khuyến nghị 0.7 cho chat bán hàng.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
  ],

  'ai.classify': [
    {
      key: 'aiConfigMode', label: 'Cách cấu hình AI', type: 'select', section: 'Trợ lý AI',
      desc: 'Chọn trợ lý đã tạo sẵn (nhanh, tiện) hoặc tự nhập API key & model thủ công.',
      options: [
        { value: 'assistant', label: 'Chọn trợ lý AI đã tạo' },
        { value: 'manual',    label: 'Cài đặt thủ công (API key, model...)' },
      ],
    },
    {
      key: 'assistantId', label: 'Chọn trợ lý AI', type: 'assistant-picker', section: 'Trợ lý AI',
      desc: 'Chọn trợ lý đã tạo trong Tích hợp → Trợ lý AI. Sẽ dùng API key, model, system prompt từ trợ lý đó.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'manual',
    },
    {
      key: 'platform', label: 'Nền tảng AI', type: 'select', section: 'Trợ lý AI',
      desc: 'Chọn nhà cung cấp AI.',
      options: [
        { value: 'openai',   label: 'OpenAI (ChatGPT)' },
        { value: 'gemini',   label: 'Google Gemini' },
        { value: 'claude',   label: 'Anthropic Claude' },
        { value: 'deepseek', label: 'Deepseek' },
        { value: 'grok',     label: 'Grok (xAI)' },
        { value: 'mistral',  label: 'Mistral AI' },
        { value: 'openrouter', label: 'OpenRouter' },
      ],
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
      clearsKeyOnChange: ['model'],
    },
    {
      key: 'model', label: 'Model AI', type: 'select', section: 'Trợ lý AI',
      desc: 'Chọn model phù hợp với nền tảng đã chọn ở trên.',
      options: [
        { value: 'gpt-6-astra',      label: 'GPT-6 Astra - Reasoning, công việc phức tạp (OpenAI)' },
        { value: 'gpt-6.1-sol',      label: 'GPT-6.1 Sol - Cân bằng tốc độ, chất lượng (OpenAI)' },
        { value: 'gpt-6-luna',       label: 'GPT-6 Luna - Nhanh, tiết kiệm (OpenAI)' },
        { value: 'gpt-5.4-mini',     label: 'GPT-5.4 Mini - Code, subagent (OpenAI - khuyến nghị)' },
        { value: 'gpt-5-mini',       label: 'GPT-5 Mini - Cân bằng, giá tốt (OpenAI)' },
        { value: 'gpt-5.4',          label: 'GPT-5.4 - Flagship (OpenAI)' },
        { value: 'gemini-3.5-flash',        label: 'Gemini 3.5 Flash (Google - khuyến nghị)' },
        { value: 'gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro Preview (Google)' },
        { value: 'gemini-3-flash-preview',  label: 'Gemini 3 Flash Preview (Google)' },
        { value: 'claude-fable-5-1',          label: 'Claude Fable 5.1 - Reasoning dài hạn (Anthropic)' },
        { value: 'claude-opus-5-5',           label: 'Claude Opus 5.5 - Agentic, knowledge work (Anthropic)' },
        { value: 'claude-sonnet-5-5',         label: 'Claude Sonnet 5.5 - Cân bằng (Anthropic)' },
        { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 - Nhanh (Anthropic)' },
        { value: 'claude-4.6-sonnet-20260301',  label: 'Claude 4.6 Sonnet (Anthropic - khuyến nghị)' },
        { value: 'claude-4.0-haiku-20260101',   label: 'Claude 4.0 Haiku - Nhanh (Anthropic)' },
        { value: 'deepseek-flash',     label: 'Deepseek Flash (Deepseek - khuyến nghị)' },
        { value: 'deepseek-v4-pro',    label: 'Deepseek V4 Pro - Thinking (Deepseek)' },
        { value: 'grok-4-fast',      label: 'Grok 4 Fast (xAI - khuyến nghị)' },
        { value: 'grok-4-mini-fast', label: 'Grok 4 Mini Fast - Siêu nhanh (xAI)' },
        { value: 'mistral-large-2-latest', label: 'Mistral Large 2 (Mistral - khuyến nghị)' },
        { value: 'mistral-small-3-latest', label: 'Mistral Small 3 - Nhanh, rẻ (Mistral)' },
        { value: 'openrouter/auto',            label: 'Auto Router (OpenRouter - khuyến nghị)' },
        { value: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash - Rẻ, nhanh (OpenRouter)' },
      ],
      optionsFilter: { key: 'platform', map: {
        openai:   ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-5.4'],
        gemini:   ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'],
        claude:   ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-4.6-sonnet-20260301', 'claude-4.0-haiku-20260101'],
        deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
        grok:     ['grok-4-fast', 'grok-4-mini-fast'],
        mistral:  ['mistral-large-2-latest', 'mistral-small-3-latest'],
        openrouter: ['openrouter/auto', 'deepseek/deepseek-v4-flash'],
      }},
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'apiKey', label: 'API Key', type: 'text', section: 'Trợ lý AI',
      placeholder: 'sk-proj-... / AIza... / sk-ant-... / sk-...',
      desc: 'API key của nền tảng đã chọn.',
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'input', label: 'Văn bản cần phân loại', type: 'text', section: 'Nội dung',
      placeholder: '{{ $trigger.content }}',
      desc: 'Nội dung tin nhắn cần được AI phân loại.',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'categories', label: 'Danh sách danh mục', type: 'text', section: 'Nội dung',
      placeholder: 'hỏi giá, đặt hàng, khiếu nại, hỏi thông tin, khác',
      desc: 'Các danh mục cách nhau bằng dấu phẩy. AI sẽ trả về tên một danh mục phù hợp nhất. Kết quả lưu vào output.category.',
    },
  ],

  // ── Thông báo ─────────────────────────────────────────────────────────────

  'notify.telegram': [
    {
      key: 'integrationId', label: 'Chọn Bot Telegram', type: 'integration-picker',
      desc: 'Chọn Bot Telegram đã kết nối trong Settings → Tích hợp. Nếu chưa có, vào Settings để thêm Bot mới.',
    },
    {
      key: 'botToken', label: 'Bot Token (nếu chưa chọn Bot)', type: 'text',
      placeholder: '7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      desc: 'Hoặc nhập trực tiếp Bot Token. Ưu tiên sử dụng Bot đã kết nối ở trên.',
      advanced: true,
    },
    {
      key: 'chatId', label: 'Chat ID nhận tin', type: 'text',
      placeholder: '-1001234567890  hoặc  123456789',
      desc: 'ID của người dùng hoặc nhóm/kênh nhận thông báo. Dùng @userinfobot để tìm Chat ID của mình.',
    },
    {
      key: 'message', label: 'Nội dung thông báo', type: 'textarea',
      placeholder: '🔔 Tin nhắn mới từ {{ $trigger.fromName }}:\n{{ $trigger.content }}',
      desc: 'Nội dung tin nhắn gửi qua Telegram. Để trống sẽ dùng kết quả văn bản từ node phía trước. Hỗ trợ HTML đơn giản (<b>bold</b>, <i>italic</i>).',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.now'],
    },
    {
      key: 'parseMode', label: 'Định dạng văn bản', type: 'select',
      desc: 'Cách hiển thị văn bản trong tin nhắn Telegram.',
      options: [
        { value: 'HTML',     label: 'HTML - Hỗ trợ <b>bold</b>, <i>italic</i>' },
        { value: 'Markdown', label: 'Markdown - Hỗ trợ **bold**, _italic_' },
        { value: '',         label: 'Plain Text - Không định dạng' },
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

  // ─── Trigger: Webhook phần mềm bán hàng (services/integrations/posWebhook.ts) ─────────
  'trigger.posWebhook': [
    {
      key: 'posWebhookSetup', label: 'Cách nhận webhook', type: 'info', section: 'Nguồn',
      desc: 'Vào Tích hợp → mở kết nối KiotViet / Haravan / Sapo / Nhanh.vn / Pancake → đặt "Khoá xác thực webhook" → dán "Địa chỉ nhận webhook" vào phần cấu hình webhook của phần mềm bán hàng. Webhook thiếu khoá hoặc sai chữ ký bị từ chối, không chạy workflow.',
    },
    {
      key: 'integrationType', label: 'Phần mềm bán hàng', type: 'select', section: 'Nguồn',
      options: [
        { value: 'all',      label: 'Tất cả phần mềm đã kết nối' },
        { value: 'kiotviet', label: 'KiotViet' },
        { value: 'haravan',  label: 'Haravan' },
        { value: 'sapo',     label: 'Sapo' },
        { value: 'nhanh',    label: 'Nhanh.vn' },
        { value: 'pancake',  label: 'Pancake POS' },
      ],
      desc: 'Chỉ chạy với webhook của phần mềm này.',
    },
    {
      key: 'entity', label: 'Loại dữ liệu', type: 'choice', section: 'Bộ lọc',
      options: [
        { value: 'order',     label: 'Đơn hàng' },
        { value: 'invoice',   label: 'Hoá đơn (KiotViet)' },
        { value: 'customer',  label: 'Khách hàng' },
        { value: 'product',   label: 'Sản phẩm' },
        { value: 'inventory', label: 'Tồn kho' },
        { value: 'all',       label: 'Tất cả' },
      ],
      desc: 'Mỗi đơn / khách / sản phẩm trong webhook chạy workflow một lần; nền tảng gửi lại cùng dữ liệu thì bỏ qua.',
    },
    {
      key: 'eventContains', label: 'Tên sự kiện chứa', type: 'text', section: 'Bộ lọc',
      placeholder: 'vd: create, paid, orderAdd (để trống = mọi sự kiện)',
      desc: 'Tên sự kiện của nền tảng ($trigger.event): KiotViet order.update / invoice.update, Haravan & Sapo orders/create / orders/paid / orders/cancelled, Nhanh.vn orderAdd / orderUpdate, Pancake orders. Nhiều từ cách nhau dấu phẩy = khớp một trong các từ.',
    },
    {
      key: 'statusContains', label: 'Trạng thái chứa', type: 'text', section: 'Bộ lọc',
      placeholder: 'vd: Hoàn thành, paid, Giao thành công',
      desc: 'Trạng thái đơn ($trigger.status): KiotViet StatusValue, Haravan / Sapo financial_status / fulfillment_status, Nhanh.vn tên trạng thái, Pancake status_name. Nhiều từ cách nhau dấu phẩy, không phân biệt hoa / thường.',
    },
    {
      key: 'integrationId', label: 'Chỉ một kết nối', type: 'text', advanced: true,
      placeholder: 'Để trống = mọi kết nối của phần mềm đã chọn',
      desc: 'ID kết nối khi có nhiều cửa hàng cùng phần mềm — phần cuối "Địa chỉ nhận webhook" (/webhook/<ID>) ở trang tích hợp.',
    },
  ],

  // ─── Trigger: Public API v1 / plugin ─────────────────────────────────────
  'trigger.api': [
    {
      key: 'eventName', label: 'Tên sự kiện', type: 'text',
      placeholder: 'vd: don_hang_moi',
      desc: 'Hệ thống ngoài hoặc ứng dụng đã cài gọi POST /api/v1/workflows/events/<tên sự kiện> với body { "payload": {...} }. Để trống = nhận mọi sự kiện. Dùng {{ $trigger.payload.<trường> }} trong các bước sau.',
    },
    {
      key: 'requiredKeyId', label: 'Chỉ nhận từ API key (tùy chọn)', type: 'text',
      placeholder: 'ID của API key (Công cụ → Ứng dụng, API & Webhook → API)',
      desc: 'Nếu điền, chỉ key này kích hoạt được workflow.',
      advanced: true,
    },
  ],

  // ─── Trigger: Webhook bên ngoài ──────────────────────────────────────────
  'trigger.webhook': [
    {
      key: 'webhookUrlDisplay', label: 'URL Webhook', type: 'info',
      desc: 'URL này dùng để nhận dữ liệu từ bên thứ 3. Gửi URL này cho đối tác để họ POST dữ liệu vào.',
      isWebhookUrl: true,
    },
    {
      key: 'secretKey', label: 'Secret Key (tùy chọn)', type: 'text',
      placeholder: 'Để trống nếu không cần xác thực',
      desc: 'Nếu có, hệ thống sẽ verify HMAC-SHA256 từ header X-Signature. Dùng để đảm bảo dữ liệu đến từ đúng đối tác.',
    },
    {
      key: 'method', label: 'Phương thức HTTP', type: 'select',
      options: [
        { value: 'POST', label: 'POST' },
        { value: 'GET', label: 'GET' },
        { value: 'PUT', label: 'PUT' },
        { value: 'ANY', label: 'Bất kỳ' },
      ],
      desc: 'Phương thức HTTP mà bên thứ 3 sẽ dùng để gửi dữ liệu.',
    },
    {
      key: 'allowedIps', label: 'Chỉ cho phép IP (tùy chọn)', type: 'text',
      placeholder: 'Để trống = cho phép tất cả. VD: 103.21.244.0, 103.21.245.0',
      desc: 'Giới hạn địa chỉ IP được phép gọi webhook. Cách nhau bằng dấu phẩy.',
      advanced: true,
    },
  ],

  // ─── KiotViet ─────────────────────────────────────────────────────────────
  'kiotviet.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `SĐT để tra cứu khách hàng trong KiotViet. ${POS_PHONE_HINT} ${POS_CUSTOMER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'kiotviet.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `Tìm đơn hàng theo SĐT; có cả mã đơn thì mã đơn được ưu tiên. ${POS_PHONE_HINT} ${POS_ORDER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
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
      desc: 'Từ khóa tìm kiếm - tên sản phẩm hoặc mã SKU trong KiotViet.',
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
      desc: `SĐT để tìm khách hàng trong Haravan. ${POS_PHONE_HINT} ${POS_CUSTOMER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'haravan.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `Tìm đơn hàng theo SĐT; có cả mã đơn thì mã đơn được ưu tiên. ${POS_PHONE_HINT} ${POS_ORDER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
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
      desc: `SĐT để tìm khách hàng trong Sapo. ${POS_PHONE_HINT} ${POS_CUSTOMER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'sapo.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `Tìm đơn hàng theo SĐT; có cả mã đơn (ID số của đơn) thì mã đơn được ưu tiên. ${POS_PHONE_HINT} ${POS_ORDER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
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
  'sapo.getInventory': [
    { key: 'limit', label: 'Số sản phẩm', type: 'number', placeholder: '50', advanced: true },
  ],
  'sapo.createOrder': [
    {
      key: 'order', label: 'Dữ liệu đơn hàng (JSON)', type: 'json',
      hint: '{"line_items":[{"variant_id":"123","quantity":1,"price":"150000"}],"customer":{"phone":"0901234567"},"shipping_address":{"name":"Nguyễn Văn A","address1":"123 Đường ABC","city":"Hồ Chí Minh","phone":"0901234567"}}',
      desc: 'Đối tượng đơn hàng Sapo. Cấu trúc tương tự Haravan/Shopify. line_items bắt buộc.',
    },
  ],

  // ─── Nhanh.vn ────────────────────────────────────────────────────────────
  'nhanh.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `SĐT để tìm khách hàng trong Nhanh.vn. ${POS_PHONE_HINT} ${POS_CUSTOMER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'nhanh.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `Tìm đơn hàng theo SĐT người nhận; có cả mã đơn thì lọc thêm theo mã đơn. ${POS_PHONE_HINT} ${POS_ORDER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
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
      desc: 'Payload hiện tại đang theo builder nội bộ `toNhanh()` - dùng `productList` và có thể kèm `productDetails` để giữ thêm thông tin sản phẩm. Cần verify sâu hơn với docs/account Nhanh thực tế trước khi mở rộng.',
    },
  ],

  // ─── Pancake POS ──────────────────────────────────────────────────────────
  'pancake.lookupCustomer': [
    {
      key: 'phone', label: 'Số điện thoại khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `SĐT để tìm khách hàng trong Pancake POS. ${POS_PHONE_HINT} ${POS_CUSTOMER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'pancake.lookupOrder': [
    {
      key: 'phone', label: 'SĐT khách hàng', type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: `Tìm đơn hàng theo SĐT; có cả mã đơn thì mã đơn được ưu tiên. ${POS_PHONE_HINT} ${POS_ORDER_EMPTY_NOTE}`,
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
    {
      key: 'orderId', label: 'Mã đơn hàng (nếu biết)', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Mã đơn Pancake POS. Ưu tiên hơn SĐT; không có đơn đúng mã này thì tìm theo SĐT (nếu có) hoặc theo chính mã này.',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'pancake.lookupProduct': [
    {
      key: 'keyword', label: 'Tên sản phẩm', type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: 'Tìm sản phẩm theo tên trong Pancake POS (có / không dấu đều được).',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'code', label: 'Mã sản phẩm (tùy chọn)', type: 'text',
      placeholder: 'SP001',
      desc: 'Biết chính xác mã sản phẩm thì tra thẳng theo mã.',
      advanced: true,
    },
    { key: 'limit', label: 'Số kết quả tối đa', type: 'number', placeholder: '10', advanced: true },
  ],
  'pancake.createOrder': [
    {
      key: 'order', label: 'Dữ liệu đơn hàng (JSON)', type: 'json',
      hint: '{"bill_full_name":"Nguyễn Văn A","bill_phone_number":"0901234567","shipping_address":{"full_name":"Nguyễn Văn A","phone_number":"0901234567","address":"123 Đường ABC","commune_name":"Phường Bến Nghé","district_name":"Quận 1","province_name":"Hồ Chí Minh"},"items":[{"variation_id":"123456","quantity":1}],"shipping_fee":30000,"cod":180000,"note":"Đặt hàng qua Zalo"}',
      desc: 'Đơn hàng theo Open API của Pancake POS (cùng dạng với form Tạo đơn hàng trong Tích hợp nhanh). items[].variation_id = id phiên bản lấy từ bước "Pancake: Tra cứu sản phẩm"; cod = tiền thu hộ.',
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
        { value: '2', label: '2 - Hàng nhẹ (thường)' },
        { value: '5', label: '5 - Hàng nặng (thường)' },
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

  // ─── Facebook triggers ──────────────────────────────────────────────────────
  'fb.trigger.message': [
    {
      key: 'threadType', label: 'Nguồn tin nhắn', type: 'choice', section: 'Phạm vi',
      desc: 'Workflow sẽ lắng nghe tin nhắn từ đâu?',
      options: [
        { value: 'all', label: 'Tất cả (cá nhân + nhóm)' },
        { value: '0',   label: 'Chỉ tin nhắn cá nhân' },
        { value: '1',   label: 'Chỉ tin nhắn nhóm' },
      ],
    },
    {
      key: 'groupId', label: 'Chỉ nhận từ nhóm cụ thể', type: 'contact-picker', contactType: 'group', section: 'Phạm vi',
      placeholder: 'Để trống = tất cả các nhóm',
      desc: 'Chọn một nhóm cụ thể để lắng nghe. Để trống = nhận từ tất cả nhóm.',
      advanced: true,
    },
    {
      key: 'threadId', label: 'Chỉ nhận từ hội thoại cụ thể', type: 'contact-picker', contactType: 'all', section: 'Phạm vi',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả hội thoại.',
      advanced: true,
    },
    {
      key: 'excludeThreadIds', label: 'Loại trừ hội thoại / nhóm', type: 'contact-picker', section: 'Phạm vi',
      contactType: 'all', contactMode: 'multi', channel: 'facebook',
      placeholder: 'Để trống = không loại trừ',
      desc: 'Không kích hoạt với các hội thoại hoặc nhóm Facebook được chọn.',
    },
    {
      key: 'fromId', label: 'Chỉ nhận từ người dùng cụ thể', type: 'contact-picker', contactType: 'user', section: 'Người gửi',
      placeholder: 'Để trống = tất cả mọi người',
      desc: 'Chọn một người cụ thể để lắng nghe. Để trống = nhận từ tất cả.',
      advanced: true,
    },
    {
      key: 'excludeSenderIds', label: 'Loại trừ người gửi', type: 'contact-picker', section: 'Người gửi',
      contactType: 'user', contactMode: 'multi', channel: 'facebook',
      placeholder: 'Để trống = không loại trừ ai',
      desc: 'Tin nhắn từ những người được chọn sẽ không kích hoạt workflow.',
    },
    {
      key: 'ignoreOwn', label: 'Bỏ qua tin nhắn do mình gửi', type: 'boolean', section: 'Người gửi',
      desc: 'Bật để tránh workflow tự kích hoạt khi tài khoản này tự gửi tin.',
    },
    {
      key: 'onlyOwn', label: 'Chỉ xử lý tin mình tự gửi', type: 'boolean', section: 'Người gửi',
      desc: 'Ngược lại - chỉ chạy với tin nhắn từ chính tài khoản này.',
    },
    {
      key: 'keyword', label: 'Từ khóa kích hoạt', type: 'text', section: 'Nội dung',
      placeholder: 'giá, báo giá, order',
      desc: 'Workflow chỉ chạy khi tin nhắn chứa một trong các từ khóa này. Nhập nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = mọi tin nhắn đều kích hoạt.',
    },
    {
      key: 'keywordMode', label: 'Cách khớp từ khóa', type: 'select', section: 'Nội dung',
      desc: 'Quy tắc áp dụng khi kiểm tra từ khóa trong tin nhắn.',
      options: [
        { value: 'contains_any', label: 'Chứa ít nhất 1 từ khóa (phổ biến nhất)' },
        { value: 'contains_all', label: 'Phải chứa đủ tất cả từ khóa' },
        { value: 'equals',       label: 'Khớp chính xác nguyên câu' },
        { value: 'starts_with',  label: 'Bắt đầu bằng từ khóa' },
        { value: 'regex',        label: 'Regex - biểu thức chính quy (nâng cao)' },
      ],
    },
    {
      key: 'activeHours', label: 'Khung giờ hoạt động', type: 'time-window', section: 'Thời gian & tần suất',
      desc: 'Trong khung giờ: chỉ chạy trong giờ đã chọn. Ngoài khung giờ: chỉ chạy ngoài giờ đó, vd. tự động trả lời ngoài giờ làm việc.',
    },
    {
      key: 'cooldownMinutes', label: 'Giới hạn tần suất (phút)', type: 'number', section: 'Thời gian & tần suất',
      placeholder: '0', min: 0,
      desc: 'Sau khi workflow chạy cho một hội thoại, các tin nhắn tiếp theo từ hội thoại đó bị bỏ qua trong N phút (vd. 60 = tối đa 1 lần mỗi giờ). 0 = tắt. Bộ đếm được đặt lại khi khởi động lại ứng dụng.',
    },
    {
      key: 'debounceSeconds', label: 'Gom tin nhắn liên tiếp (giây)', type: 'number', section: 'Thời gian & tần suất',
      placeholder: '0',
      desc: 'Chờ N giây sau tin nhắn cuối cùng rồi mới chạy workflow (gom tất cả tin nhắn liên tiếp thành 1 lần xử lý). 0 = chạy ngay mỗi tin.',
      advanced: true,
    },
  ],
  'fb.trigger.image': [
    {
      key: 'threadId', label: 'Chỉ nhận từ hội thoại cụ thể', type: 'contact-picker', contactType: 'all',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.',
      advanced: true,
    },
  ],
  'fb.trigger.video': [
    {
      key: 'threadId', label: 'Chỉ nhận từ hội thoại cụ thể', type: 'contact-picker', contactType: 'all',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.',
      advanced: true,
    },
  ],
  'fb.trigger.file': [
    {
      key: 'threadId', label: 'Chỉ nhận từ hội thoại cụ thể', type: 'contact-picker', contactType: 'all',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.',
      advanced: true,
    },
  ],
  'fb.trigger.sticker': [
    {
      key: 'threadId', label: 'Chỉ nhận từ hội thoại cụ thể', type: 'contact-picker', contactType: 'all',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.',
      advanced: true,
    },
  ],
  'fb.trigger.reaction': [
    {
      key: 'reactionType', label: 'Loại cảm xúc', type: 'select',
      desc: 'Workflow chạy khi tin nhắn nhận được cảm xúc nào?',
      options: [
        { value: 'any', label: 'Bất kỳ cảm xúc nào' },
        { value: '👍',  label: 'Like' },
        { value: '❤️',  label: 'Yêu thích' },
        { value: '😂',  label: 'Haha' },
        { value: '😮',  label: 'Wow' },
        { value: '😢',  label: 'Buồn' },
        { value: '😡',  label: 'Giận' },
      ],
    },
    {
      key: 'threadId', label: 'Chỉ theo dõi hội thoại cụ thể', type: 'contact-picker', contactType: 'all',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'ID hội thoại cụ thể muốn theo dõi. Để trống = tất cả.',
      advanced: true,
    },
  ],
  'fb.trigger.unsend': [
    {
      key: 'threadId', label: 'Chỉ theo dõi hội thoại cụ thể', type: 'contact-picker', contactType: 'all',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'ID hội thoại cụ thể muốn theo dõi sự kiện thu hồi. Để trống = tất cả.',
      advanced: true,
    },
  ],
  'fb.trigger.groupEvent': [
    {
      key: 'eventType', label: 'Sự kiện cần theo dõi', type: 'select',
      desc: 'Chọn loại sự kiện trong nhóm Facebook sẽ kích hoạt workflow.',
      options: [
        { value: 'all',              label: 'Mọi sự kiện nhóm' },
        { value: 'participant_added', label: 'Thành viên mới tham gia' },
        { value: 'participant_left',  label: 'Thành viên rời nhóm' },
      ],
    },
    {
      key: 'threadId', label: 'Chỉ theo dõi nhóm cụ thể', type: 'contact-picker', contactType: 'all',
      placeholder: 'Để trống = theo dõi tất cả nhóm',
      desc: 'Chọn một nhóm Facebook để chỉ lắng nghe sự kiện từ nhóm đó.',
      advanced: true,
    },
  ],

  // ─── Facebook Actions ────────────────────────────────────────────────────
  'fb.action.sendMessage': [
    {
      key: 'message', label: 'Nội dung tin nhắn', type: 'textarea', section: 'Nội dung',
      placeholder: 'Xin chào! Mình có thể giúp gì?',
      desc: 'Nội dung tin nhắn gửi đi. Dùng {{ }} để chèn dữ liệu động.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', section: 'Người nhận',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại Facebook để gửi. Nếu không chọn, sẽ dùng hội thoại từ trigger.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', section: 'Tùy chọn',
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi tin nhắn này gửi lỗi.',
      advanced: true,
    },
  ],
  'fb.action.sendImage': [
    {
      key: 'filePath', label: 'Tệp đính kèm cần gửi', type: 'file-picker', fileType: 'file',
      desc: 'Chọn ảnh, video, audio hoặc file từ máy tính để gửi.',
    },
    {
      key: 'body', label: 'Chú thích (tuỳ chọn)', type: 'text',
      placeholder: 'Cảm ơn bạn đã mua hàng!',
      desc: 'Nội dung văn bản đi kèm ảnh (caption). Để trống nếu chỉ gửi ảnh.',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'Chọn một hoặc nhiều hội thoại Facebook để gửi tệp.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean',
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi tệp lỗi.',
      advanced: true,
    },
  ],
  'fb.action.sendVideo': [
    {
      key: 'filePath', label: 'Video cần gửi', type: 'file-picker', fileType: 'file',
      desc: 'Chọn file video từ máy tính để gửi.',
    },
    {
      key: 'body', label: 'Chú thích (tuỳ chọn)', type: 'text',
      placeholder: 'Xem video giới thiệu sản phẩm!',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      contactMode: 'multi', placeholder: '{{ $trigger.threadId }}', templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', advanced: true,
    },
  ],
  'fb.action.sendFile': [
    {
      key: 'filePath', label: 'File cần gửi', type: 'file-picker', fileType: 'file',
      desc: 'Chọn file (PDF, Excel, ...) từ máy tính để gửi.',
    },
    {
      key: 'body', label: 'Chú thích (tuỳ chọn)', type: 'text',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      contactMode: 'multi', placeholder: '{{ $trigger.threadId }}', templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', advanced: true,
    },
  ],
  'fb.action.sendAudio': [
    {
      key: 'filePath', label: 'File audio cần gửi', type: 'file-picker', fileType: 'file',
      desc: 'Chọn file âm thanh từ máy tính để gửi.',
    },
    {
      key: 'body', label: 'Chú thích (tuỳ chọn)', type: 'text',
    },
    {
      key: 'threadIds', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      contactMode: 'multi', placeholder: '{{ $trigger.threadId }}', templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', advanced: true,
    },
  ],
  'fb.action.addReaction': [
    {
      key: 'emoji', label: 'Biểu tượng cảm xúc', type: 'select',
      desc: 'Chọn emoji reaction để thả vào tin nhắn.',
      options: [
        { value: '👍', label: 'Like' },
        { value: '❤️', label: 'Yêu thích' },
        { value: '😂', label: 'Haha' },
        { value: '😮', label: 'Wow' },
        { value: '😢', label: 'Buồn' },
        { value: '😡', label: 'Giận' },
      ],
    },
    {
      key: 'messageId', label: 'ID tin nhắn cần react', type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: 'ID tin nhắn Facebook muốn thả reaction.',
      templateVars: ['$trigger.messageId'],
      advanced: true,
    },
  ],
  'fb.action.unsend': [
    {
      key: 'messageId', label: 'ID tin nhắn cần thu hồi', type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: 'ID tin nhắn Facebook muốn thu hồi (xóa 2 phía).',
      templateVars: ['$trigger.messageId'],
    },
  ],
  'fb.action.editMessage': [
    {
      key: 'messageId', label: 'ID tin nhắn cần chỉnh sửa', type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: 'ID tin nhắn Facebook muốn chỉnh sửa nội dung.',
      templateVars: ['$trigger.messageId'],
    },
    {
      key: 'text', label: 'Nội dung mới', type: 'textarea',
      placeholder: 'Nhập nội dung mới cho tin nhắn...',
      desc: 'Nội dung sẽ thay thế tin nhắn cũ.',
    },
  ],
  'fb.action.forward': [
    {
      key: 'message', label: 'Nội dung gửi lại', type: 'textarea',
      placeholder: '{{ $trigger.content }}',
      desc: 'Node này chỉ gửi lại văn bản. Dùng “Chuyển tiếp đa kênh” khi cần chuyển cả tin gốc, ảnh, video hoặc file.',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'messageId', label: 'ID tin nhắn gốc (không dùng)', type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: 'Được giữ để tương thích workflow cũ. Node này không có API forward gốc; hãy dùng “Chuyển tiếp đa kênh”.',
      templateVars: ['$trigger.messageId'],
      advanced: true,
    },
    {
      key: 'targetThreadId', label: 'Chuyển đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: 'ID hội thoại đích',
      desc: 'ID hội thoại Facebook nơi tin nhắn sẽ được chuyển đến.',
    },
    {
      key: 'accountId', label: 'Tài khoản Facebook', type: 'text',
      desc: 'Nhập ID tài khoản Facebook để gửi tin nhắn.',
      advanced: true,
      placeholder: '{{ $trigger.fbAccountId }}',
      templateVars: ['$trigger.fbAccountId'],
    },
  ],
  'fb.action.pin': [
    {
      key: 'messageId', label: 'ID tin nhắn cần ghim', type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: 'ID tin nhắn Facebook muốn ghim trong hội thoại.',
      templateVars: ['$trigger.messageId'],
    },
    {
      key: 'threadId', label: 'Trong nhóm', type: 'contact-picker', contactType: 'group',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID nhóm Facebook chứa tin nhắn cần ghim.',
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'fb.action.unpin': [
    {
      key: 'messageId', label: 'ID tin nhắn cần bỏ ghim', type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: 'ID tin nhắn Facebook muốn bỏ ghim.',
      templateVars: ['$trigger.messageId'],
    },
    {
      key: 'threadId', label: 'Trong nhóm', type: 'contact-picker', contactType: 'group',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID nhóm Facebook chứa tin nhắn cần bỏ ghim.',
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'fb.action.createPoll': [
    {
      key: 'question', label: 'Câu hỏi bình chọn', type: 'text',
      placeholder: 'Bạn thích sản phẩm nào nhất?',
      desc: 'Nội dung câu hỏi hiển thị trong poll Facebook.',
    },
    {
      key: 'options', label: 'Các lựa chọn', type: 'multiline',
      placeholder: 'Sản phẩm A\nSản phẩm B\nSản phẩm C',
      desc: 'Mỗi dòng là một lựa chọn. Nhập ít nhất 2 lựa chọn.',
    },
    {
      key: 'threadId', label: 'Tạo trong nhóm', type: 'contact-picker', contactType: 'group',
      placeholder: 'ID nhóm Facebook',
      desc: 'ID nhóm Facebook nơi poll sẽ được tạo.',
    },
  ],
  'fb.action.sendTyping': [
    {
      key: 'threadId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại Facebook cần gửi trạng thái đang gõ.',
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'isTyping', label: 'Trạng thái', type: 'select',
      desc: 'Bật để hiển thị "đang gõ...", tắt để ẩn.',
      options: [
        { value: 'true', label: 'Đang gõ...' },
        { value: 'false', label: 'Ẩn trạng thái' },
      ],
    },
  ],
  'fb.action.markAsRead': [
    {
      key: 'threadId', label: 'Đánh dấu hội thoại', type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: 'ID hội thoại Facebook muốn đánh dấu đã đọc.',
      templateVars: ['$trigger.threadId'],
    },
  ],
  'fb.action.block': [
    {
      key: 'userId', label: 'User ID cần chặn', type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.fromId }}',
      desc: 'ID người dùng Facebook muốn chặn.',
      templateVars: ['$trigger.fromId'],
    },
  ],
  'fb.action.changeName': [
    {
      key: 'threadId', label: 'Nhóm cần đổi tên', type: 'contact-picker', contactType: 'group',
      placeholder: 'ID nhóm Facebook',
      desc: 'ID nhóm Facebook muốn đổi tên.',
    },
    {
      key: 'name', label: 'Tên mới của nhóm', type: 'text',
      placeholder: 'Nhập tên mới cho nhóm',
      desc: 'Tên mới sẽ được đặt cho nhóm Facebook.',
    },
  ],
  'fb.action.changeEmoji': [
    {
      key: 'threadId', label: 'Nhóm cần đổi biểu tượng', type: 'contact-picker', contactType: 'group',
      placeholder: 'ID nhóm Facebook',
      desc: 'ID nhóm Facebook muốn đổi emoji đại diện.',
    },
    {
      key: 'emoji', label: 'Biểu tượng mới', type: 'text',
      placeholder: '😊',
      desc: 'Emoji mới làm biểu tượng đại diện cho nhóm.',
    },
  ],
  'fb.action.changeNickname': [
    {
      key: 'threadId', label: 'Trong nhóm', type: 'contact-picker', contactType: 'group',
      placeholder: 'ID nhóm Facebook',
      desc: 'ID nhóm Facebook chứa thành viên cần đổi biệt danh.',
    },
    {
      key: 'userId', label: 'Thành viên cần đổi biệt danh', type: 'contact-picker', contactType: 'user',
      placeholder: 'ID người dùng',
      desc: 'ID người dùng Facebook muốn đổi biệt danh trong nhóm.',
    },
    {
      key: 'nickname', label: 'Biệt danh mới', type: 'text',
      placeholder: 'Nhập biệt danh mới',
      desc: 'Biệt danh mới trong nhóm cho thành viên này.',
    },
  ],

  // ─── Telegram triggers ──────────────────────────────────────────────────────
  'tg.trigger.message': [
    {
      key: 'chatType', label: 'Nguồn tin nhắn', type: 'choice', section: 'Phạm vi',
      desc: 'Workflow sẽ lắng nghe tin nhắn từ đâu?',
      options: [
        { value: 'all', label: 'Tất cả (cá nhân + nhóm + channel + topic)' },
        { value: 'user', label: 'Chỉ tin nhắn 1-1 (cá nhân)' },
        { value: 'group', label: 'Chỉ tin nhắn nhóm (group/supergroup)' },
        { value: 'channel', label: 'Chỉ tin nhắn kênh (channel)' },
        { value: 'topic', label: 'Chỉ tin nhắn trong topic (forum)' },
      ],
    },
    {
      key: 'chatId', label: 'Chỉ nhận từ hội thoại cụ thể', type: 'contact-picker', section: 'Phạm vi',
      contactType: 'all', channel: 'telegram_user',
      placeholder: 'Để trống = tất cả hội thoại',
      desc: 'Chọn hội thoại Telegram muốn lắng nghe. Để trống = nhận từ tất cả.',
    },
    {
      key: 'excludeThreadIds', label: 'Loại trừ hội thoại / nhóm', type: 'contact-picker', section: 'Phạm vi',
      contactType: 'all', contactMode: 'multi', channel: 'telegram_user',
      placeholder: 'Để trống = không loại trừ',
      desc: 'Không kích hoạt với các hội thoại, nhóm hoặc kênh Telegram được chọn.',
    },
    {
      key: 'fromId', label: 'Chỉ nhận từ người gửi cụ thể', type: 'contact-picker', section: 'Người gửi',
      contactType: 'user', channel: 'telegram_user',
      placeholder: 'Để trống = tất cả',
      desc: 'Chọn người gửi cụ thể. Để trống = nhận từ tất cả.',
      advanced: true,
    },
    {
      key: 'excludeSenderIds', label: 'Loại trừ người gửi', type: 'contact-picker', section: 'Người gửi',
      contactType: 'user', contactMode: 'multi', channel: 'telegram_user',
      placeholder: 'Để trống = không loại trừ ai',
      desc: 'Tin nhắn từ những người được chọn sẽ không kích hoạt workflow.',
    },
    {
      key: 'ignoreOwn', label: 'Bỏ qua tin nhắn do mình gửi', type: 'boolean', section: 'Người gửi',
      desc: 'Bật để tránh workflow tự kích hoạt khi tài khoản tự gửi tin.',
    },
    {
      key: 'keyword', label: 'Từ khóa kích hoạt', type: 'text', section: 'Nội dung',
      placeholder: 'giá, báo giá, order',
      desc: 'Workflow chỉ chạy khi tin nhắn chứa một trong các từ khóa. Nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = mọi tin nhắn.',
    },
    {
      key: 'keywordMode', label: 'Cách khớp từ khóa', type: 'select', section: 'Nội dung',
      desc: 'Quy tắc áp dụng khi kiểm tra từ khóa trong tin nhắn.',
      options: [
        { value: 'contains_any', label: 'Chứa ít nhất 1 từ khóa (phổ biến nhất)' },
        { value: 'contains_all', label: 'Phải chứa đủ tất cả từ khóa' },
        { value: 'exact', label: 'Khớp chính xác nguyên câu' },
        { value: 'starts_with', label: 'Bắt đầu bằng từ khóa' },
      ],
    },
    {
      key: 'activeHours', label: 'Khung giờ hoạt động', type: 'time-window', section: 'Thời gian & tần suất',
      desc: 'Trong khung giờ: chỉ chạy trong giờ đã chọn. Ngoài khung giờ: chỉ chạy ngoài giờ đó, vd. tự động trả lời ngoài giờ làm việc.',
    },
    {
      key: 'cooldownMinutes', label: 'Giới hạn tần suất (phút)', type: 'number', section: 'Thời gian & tần suất',
      placeholder: '0', min: 0,
      desc: 'Sau khi workflow chạy cho một hội thoại, các tin nhắn tiếp theo từ hội thoại đó bị bỏ qua trong N phút (vd. 60 = tối đa 1 lần mỗi giờ). 0 = tắt. Bộ đếm được đặt lại khi khởi động lại ứng dụng.',
    },
    {
      key: 'debounceSeconds', label: 'Chờ gom tin nhắn (giây)', type: 'number', section: 'Thời gian & tần suất',
      placeholder: '0',
      desc: 'Chờ N giây sau tin nhắn cuối rồi mới chạy. 0 = chạy ngay mỗi tin.',
      advanced: true,
    },
  ],
  'tg.trigger.unsend': [
    { key: 'chatId', label: 'Hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: 'Để trống = tất cả' },
  ],
  'tg.trigger.groupEvent': [
    { key: 'chatId', label: 'Nhóm cụ thể', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: 'Để trống = tất cả nhóm' },
    { key: 'eventType', label: 'Loại sự kiện', type: 'select', options: [
      { value: 'all', label: 'Tất cả' },
      { value: 'join', label: 'Thành viên vào nhóm' },
      { value: 'leave', label: 'Thành viên rời nhóm' },
      { value: 'member_join', label: 'Có người mới tham gia' },
      { value: 'member_leave', label: 'Có người rời đi' },
    ]},
  ],

  // ─── Telegram Bot triggers ───────────────────────────────────────────────
  'tgbot.trigger.message': [
    { key: 'chatScope', label: 'Nguồn chat', type: 'select', options: [
      { value: 'all', label: 'Tất cả chat Bot nhận được' },
      { value: 'private', label: 'Chat riêng' },
      { value: 'group', label: 'Nhóm và supergroup' },
      { value: 'channel', label: 'Channel post' },
    ], desc: 'Trong nhóm, Bot có thể không nhận toàn bộ tin nếu Privacy Mode đang bật.' },
    { key: 'chatId', label: 'Chat cụ thể', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: 'Để trống = tất cả chat', templateVars: ['$trigger.chatId'] },
    { key: 'messageTypes', label: 'Loại nội dung', type: 'select', options: [
      { value: 'all', label: 'Mọi loại nội dung' },
      { value: 'text', label: 'Văn bản' },
      { value: 'photo', label: 'Ảnh' },
      { value: 'video', label: 'Video' },
      { value: 'file', label: 'File / tài liệu' },
      { value: 'voice', label: 'Voice' },
      { value: 'sticker', label: 'Sticker' },
      { value: 'location', label: 'Vị trí' },
      { value: 'contact', label: 'Liên hệ' },
      { value: 'poll', label: 'Bình chọn' },
    ] },
    { key: 'keyword', label: 'Từ khóa', type: 'text', placeholder: 'VD: báo giá, hỗ trợ', desc: 'Nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = không lọc.', templateVars: ['$trigger.content'] },
    { key: 'keywordMode', label: 'Cách khớp từ khóa', type: 'select', options: [
      { value: 'contains_any', label: 'Chứa một trong các từ khóa' },
      { value: 'contains_all', label: 'Chứa tất cả từ khóa' },
      { value: 'exact', label: 'Khớp đúng toàn bộ nội dung' },
      { value: 'starts_with', label: 'Bắt đầu bằng từ khóa' },
    ], advanced: true },
    { key: 'fromId', label: 'Chỉ nhận từ Telegram user ID', type: 'text', placeholder: 'Để trống = tất cả user', advanced: true },
    { key: 'ignoreOwn', label: 'Bỏ qua tin do Bot gửi', type: 'boolean', desc: 'Tránh workflow tự kích hoạt bởi tin nhắn Bot vừa gửi.' },
  ],
  'tgbot.trigger.command': [
    { key: 'chatScope', label: 'Nguồn chat', type: 'select', options: [
      { value: 'all', label: 'Mọi chat' }, { value: 'private', label: 'Chat riêng' }, { value: 'group', label: 'Nhóm và supergroup' },
    ] },
    { key: 'chatId', label: 'Chat cụ thể', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: 'Để trống = tất cả chat', templateVars: ['$trigger.chatId'] },
    { key: 'command', label: 'Lệnh chính', type: 'text', placeholder: '/start', desc: 'Để trống = nhận mọi lệnh. Có thể nhập /start hoặc start.' },
    { key: 'aliases', label: 'Lệnh thay thế', type: 'text', placeholder: '/begin, /menu', desc: 'Các lệnh tương đương, cách nhau bằng dấu phẩy.', advanced: true },
    { key: 'argumentContains', label: 'Tham số phải chứa', type: 'text', placeholder: 'VD: premium', desc: 'Chỉ kích hoạt nếu phần sau lệnh có cụm này.', advanced: true },
    { key: 'authorizedUsers', label: 'Chỉ Telegram user ID', type: 'text', placeholder: '123456, 987654', desc: 'Để trống = mọi người. Nhiều ID cách nhau bằng dấu phẩy.', advanced: true },
    { key: 'ignoreOwn', label: 'Bỏ qua lệnh do Bot gửi', type: 'boolean' },
  ],
  'tgbot.trigger.callback': [
    { key: 'chatId', label: 'Chat cụ thể', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: 'Để trống = tất cả chat', templateVars: ['$trigger.chatId'] },
    { key: 'callbackData', label: 'Callback data cần khớp', type: 'text', placeholder: 'Để trống = nhận mọi inline button', desc: 'Chỉ dùng cho callback tùy chỉnh. Nút “Đi đến node” tự chạy nhánh node đã chọn trên canvas.' },
  ],
  'tgbot.trigger.editedMessage': [
    { key: 'chatScope', label: 'Nguồn chat', type: 'select', options: [
      { value: 'all', label: 'Mọi chat' }, { value: 'private', label: 'Chat riêng' }, { value: 'group', label: 'Nhóm và supergroup' }, { value: 'channel', label: 'Channel' },
    ] },
    { key: 'chatId', label: 'Chat cụ thể', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: 'Để trống = tất cả chat' },
    { key: 'keyword', label: 'Nội dung mới chứa', type: 'text', placeholder: 'Để trống = mọi tin được sửa', advanced: true },
    { key: 'keywordMode', label: 'Cách khớp', type: 'select', options: [
      { value: 'contains_any', label: 'Chứa một từ khóa' }, { value: 'contains_all', label: 'Chứa tất cả' }, { value: 'exact', label: 'Khớp chính xác' }, { value: 'starts_with', label: 'Bắt đầu bằng' },
    ], advanced: true },
  ],
  'tgbot.trigger.joinRequest': [
    { key: 'chatId', label: 'Nhóm cụ thể', type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: 'Để trống = mọi nhóm' },
    { key: 'info', label: 'Yêu cầu quyền', type: 'info', desc: 'Bot phải là admin trong nhóm và có quyền mời user. Node này hiện chỉ nhận sự kiện; duyệt/từ chối sẽ được bổ sung cùng action quản trị nhóm.' },
  ],
  'tgbot.trigger.join': [
    { key: 'chatId', label: 'Nhóm cụ thể', type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: 'Để trống = mọi nhóm' },
    { key: 'eventType', label: 'Sự kiện Bot trong nhóm', type: 'select', options: [
      { value: 'all', label: 'Tất cả thay đổi thành viên của Bot' },
      { value: 'added', label: 'Bot được thêm vào nhóm' },
      { value: 'removed', label: 'Bot bị gỡ khỏi nhóm' },
      { value: 'permissions_changed', label: 'Quyền của Bot thay đổi' },
    ], desc: 'Telegram chỉ gửi sự kiện này cho chính Bot. Admin phải thêm Bot bằng @username hoặc link mời; Bot không thể tự thêm mình vào nhóm.' },
  ],

  // ─── Telegram Bot actions ────────────────────────────────────────────────
  'tgbot.action.sendPhoto': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'photoPath', label: 'Ảnh cần gửi', type: 'file-picker', fileType: 'image', desc: 'Chọn ảnh từ máy tính để gửi.' },
    { key: 'caption', label: 'Chú thích', type: 'textarea', placeholder: 'Không bắt buộc', advanced: true, templateVars: ['$trigger.content'] },
  ],
  'tgbot.action.sendVideo': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'videoPath', label: 'Video cần gửi', type: 'file-picker', fileType: 'file', desc: 'Chọn video từ máy tính để gửi.' },
    { key: 'caption', label: 'Chú thích', type: 'textarea', placeholder: 'Không bắt buộc', advanced: true },
  ],
  'tgbot.action.sendFile': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: 'File cần gửi', type: 'file-picker', fileType: 'file' },
    { key: 'caption', label: 'Chú thích', type: 'textarea', placeholder: 'Không bắt buộc', advanced: true },
  ],
  'tgbot.action.forward': [
    { key: 'fromChatId', label: 'Chat nguồn', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'targetChatId', label: 'Chat nhận', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot' },
    { key: 'messageId', label: 'ID tin nhắn', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.editMessage': [
    { key: 'chatId', label: 'Chat chứa tin', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin nhắn', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'text', label: 'Nội dung mới', type: 'textarea', placeholder: 'Nội dung thay thế' },
  ],
  'tgbot.action.deleteMessage': [
    { key: 'chatId', label: 'Chat chứa tin', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin nhắn cần xóa', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.pinMessage': [
    { key: 'chatId', label: 'Nhóm / channel', type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin cần ghim', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.unpinMessage': [
    { key: 'chatId', label: 'Nhóm / channel', type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin cần bỏ ghim', type: 'text', placeholder: 'Để trống = bỏ ghim tin đang ghim', templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.addReaction': [
    { key: 'chatId', label: 'Chat chứa tin', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin nhắn', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'emoji', label: 'Emoji reaction', type: 'text', placeholder: '👍' },
  ],
  'tgbot.action.sendPoll': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'question', label: 'Câu hỏi', type: 'text', placeholder: 'Bạn chọn phương án nào?' },
    { key: 'options', label: 'Các lựa chọn', type: 'multiline', placeholder: 'Lựa chọn 1\nLựa chọn 2', desc: 'Mỗi lựa chọn một dòng.' },
  ],
  'tgbot.action.sendChatAction': [
    { key: 'chatId', label: 'Chat hiển thị trạng thái', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'action', label: 'Trạng thái', type: 'select', options: [
      { value: 'typing', label: 'Đang gõ' }, { value: 'upload_photo', label: 'Đang tải ảnh' }, { value: 'upload_document', label: 'Đang tải file' }, { value: 'record_voice', label: 'Đang thu voice' },
    ] },
  ],
  'tgbot.action.banMember': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: 'Telegram user ID', type: 'text', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
    { key: 'durationMinutes', label: 'Thời gian cấm (phút)', type: 'number', placeholder: '0', desc: '0 = cấm không thời hạn.', advanced: true },
  ],
  'tgbot.action.restrictMember': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: 'Telegram user ID', type: 'text', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
    { key: 'durationMinutes', label: 'Mute trong (phút)', type: 'number', placeholder: '10', min: 1, desc: 'Trong thời gian này user không thể gửi tin.' },
  ],
  'tgbot.action.sendSticker': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'stickerPath', label: 'File sticker (webp)', type: 'file-picker', fileType: 'file', desc: 'Chọn file sticker định dạng webp để gửi.' },
  ],
  'tgbot.action.sendAudio': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'audioPath', label: 'File audio (mp3)', type: 'file-picker', fileType: 'file', desc: 'Chọn file âm thanh để gửi.' },
    { key: 'caption', label: 'Chú thích', type: 'textarea', placeholder: 'Không bắt buộc', advanced: true },
  ],
  'tgbot.action.sendVoice': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'voicePath', label: 'File ghi âm (ogg)', type: 'file-picker', fileType: 'file', desc: 'Chọn file voice note định dạng ogg để gửi.' },
    { key: 'caption', label: 'Chú thích', type: 'textarea', placeholder: 'Không bắt buộc', advanced: true },
  ],
  'tgbot.action.leaveChat': [
    { key: 'chatId', label: 'Chat cần rời', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tgbot.action.sendMenu': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'text', label: 'Nội dung menu', type: 'text', placeholder: 'Chọn một tùy chọn:' },
    { key: 'buttons', label: 'Nút bấm (Inline Keyboard)', type: 'json', hint: '[[{"text":"Mua","callback_data":"mua"},{"text":"Hỗ trợ","callback_data":"hotro"}]]', desc: 'Mảng 2 chiều các nút. Mỗi nút có "text" và "callback_data".' },
  ],
  'tgbot.action.sendForm': [
    { key: 'chatId', label: 'Gửi đến chat', type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'text', label: 'Tiêu đề form', type: 'text', placeholder: 'Vui lòng nhập thông tin:' },
    { key: 'fields', label: 'Các trường form', type: 'json', hint: '[{"label":"Họ tên","field_name":"name","required":true}]', desc: 'Mỗi trường có "label", "field_name" và "required".' },
  ],
  'tgbot.action.answerCallback': [
    { key: 'callbackQueryId', label: 'Callback query ID', type: 'text', placeholder: '{{ $trigger.callbackQueryId }}', templateVars: ['$trigger.callbackQueryId'] },
    { key: 'text', label: 'Nội dung trả lời', type: 'text', placeholder: 'Không bắt buộc', desc: 'Thông báo ngắn hiện lên cho user (popup).' },
    { key: 'showAlert', label: 'Hiện dạng alert (popup)', type: 'boolean', desc: 'Bật để hiện hộp thoại, tắt để hiện thông báo nhỏ.', advanced: true },
  ],

  // ─── Telegram Actions ───────────────────────────────────────────────────────
  'tg.sendMessage': [
    {
      key: 'message', label: 'Nội dung tin nhắn', type: 'textarea', section: 'Nội dung',
      placeholder: 'Xin chào! Mình có thể giúp gì?',
      desc: 'Nội dung tin nhắn gửi đi. Dùng {{ }} để chèn dữ liệu động.',
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.chatId'],
    },
    {
      key: 'chatId', label: 'Gửi đến hội thoại', type: 'contact-picker', section: 'Người nhận',
      contactType: 'all', channel: 'telegram_user',
      placeholder: '{{ $trigger.chatId }}',
      desc: 'Chọn hội thoại Telegram cần gửi tin nhắn.',
      templateVars: ['$trigger.chatId', '$trigger.fromId'],
    },
    {
      key: 'continueOnError', label: 'Tiếp tục workflow dù gửi thất bại', type: 'boolean', section: 'Tùy chọn',
      desc: 'Bật nếu muốn các bước sau vẫn chạy ngay cả khi tin nhắn này gửi lỗi.',
      advanced: true,
    },
  ],
  'tg.sendPhoto': [
    {
      key: 'chatId', label: 'Gửi đến hội thoại', type: 'contact-picker',
      contactType: 'all', channel: 'telegram_user',
      placeholder: '{{ $trigger.chatId }}',
      desc: 'Chọn hội thoại Telegram cần gửi ảnh.',
      templateVars: ['$trigger.chatId'],
    },
    {
      key: 'filePath', label: 'Ảnh cần gửi', type: 'file-picker', fileType: 'image',
      desc: 'Chọn ảnh từ máy tính để gửi.',
    },
    {
      key: 'caption', label: 'Chú thích ảnh', type: 'text',
      placeholder: 'Để trống nếu không cần chú thích',
      desc: 'Chú thích hiển thị dưới ảnh. Dùng {{ }} để chèn dữ liệu động.',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'tg.sendFile': [
    { key: 'chatId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: 'File cần gửi', type: 'file-picker', fileType: 'file', desc: 'Chọn file (PDF, Excel, ...) để gửi.' },
    { key: 'caption', label: 'Chú thích file', type: 'text', advanced: true },
  ],
  'tg.sendVideo': [
    { key: 'chatId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: 'Video cần gửi', type: 'file-picker', fileType: 'file', desc: 'Chọn file video (mp4) để gửi.' },
    { key: 'caption', label: 'Chú thích video', type: 'text', advanced: true },
  ],
  'tg.sendVoice': [
    { key: 'chatId', label: 'Gửi đến hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: 'File ghi âm (ogg)', type: 'file-picker', fileType: 'file', desc: 'Chọn file voice note định dạng ogg để gửi.' },
    { key: 'caption', label: 'Chú thích', type: 'text', advanced: true },
  ],
  'tg.forwardMessage': [
    { key: 'fromChatId', label: 'Từ hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', desc: 'Hội thoại chứa tin nhắn cần chuyển tiếp.' },
    { key: 'toChatId', label: 'Đến hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', desc: 'Hội thoại nhận tin nhắn chuyển tiếp.' },
    { key: 'messageId', label: 'ID tin nhắn', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tg.deleteMessage': [
    { key: 'chatId', label: 'Trong hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin nhắn cần xóa', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tg.editMessage': [
    { key: 'chatId', label: 'Trong hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin nhắn cần sửa', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'text', label: 'Nội dung mới', type: 'textarea', placeholder: 'Nhập nội dung mới...' },
  ],
  'tg.addReaction': [
    { key: 'chatId', label: 'Trong hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin nhắn', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'emoji', label: 'Emoji', type: 'select', options: [
      { value: '👍', label: 'Like 👍' }, { value: '❤️', label: 'Heart ❤️' },
      { value: '🔥', label: 'Fire 🔥' }, { value: '🥰', label: 'Love 🥰' },
      { value: '😮', label: 'Wow 😮' }, { value: '😢', label: 'Sad 😢' },
      { value: '🎉', label: 'Party 🎉' }, { value: '👎', label: 'Dislike 👎' },
    ]},
  ],
  'tg.pinMessage': [
    { key: 'chatId', label: 'Trong hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: 'ID tin nhắn cần ghim', type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tg.sendPoll': [
    { key: 'chatId', label: 'Tạo trong hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'question', label: 'Câu hỏi', type: 'text', placeholder: 'Bạn thích sản phẩm nào nhất?' },
    { key: 'options', label: 'Các lựa chọn', type: 'textarea', placeholder: 'Lựa chọn 1\nLựa chọn 2\nLựa chọn 3', desc: 'Mỗi dòng 1 lựa chọn. Tối thiểu 2.' },
  ],
  'tg.banMember': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: 'Thành viên cần ban', type: 'contact-picker', contactType: 'user', channel: 'telegram_user', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
  ],
  'tg.promoteMember': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: 'Thành viên', type: 'contact-picker', contactType: 'user', channel: 'telegram_user', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
    { key: 'isAdmin', label: 'Quyền admin', type: 'select', options: [
      { value: 'true', label: 'Thăng quyền admin' }, { value: 'false', label: 'Hạ quyền thành viên' },
    ]},
  ],
  'tg.sendSticker': [
    { key: 'chatId', label: 'Gửi đến', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'stickerId', label: 'Sticker ID', type: 'text', desc: 'ID sticker từ Telegram sticker set.' },
    { key: 'accessHash', label: 'Access Hash', type: 'text', advanced: true },
  ],
  'tg.sendTyping': [
    { key: 'chatId', label: 'Hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.markAsRead': [
    { key: 'chatId', label: 'Hội thoại', type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.markTopicAsRead': [
    { key: 'chatId', label: 'Nhóm (channel)', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'topicId', label: 'Topic ID', type: 'text', placeholder: '{{ $trigger.topicId }}', templateVars: ['$trigger.topicId'] },
  ],
  'tg.addMember': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: 'Thành viên cần thêm', type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.removeMember': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: 'Thành viên cần xóa', type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.blockUser': [
    { key: 'userId', label: 'Người cần chặn', type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.unblockUser': [
    { key: 'userId', label: 'Người cần bỏ chặn', type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.changeGroupName': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'name', label: 'Tên mới', type: 'text', placeholder: 'Tên nhóm mới' },
  ],
  'tg.leaveGroup': [
    { key: 'chatId', label: 'Nhóm cần rời', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.exportInviteLink': [
    { key: 'chatId', label: 'Nhóm', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.createForumTopic': [
    { key: 'chatId', label: 'Nhóm Forum', type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'title', label: 'Tên topic', type: 'text', placeholder: 'Tên topic mới' },
  ],
};

// The inline arrays above are retained to read old workflow definitions. The
// editor itself only offers current provider model IDs from the shared catalog.
const CURRENT_AI_MODEL_OPTIONS = Object.entries(AI_MODEL_OPTIONS)
  .filter(([platform]) => platform !== '9router')
  .flatMap(([, options]) => options);
const CURRENT_AI_MODEL_FILTER = Object.fromEntries(
  Object.entries(AI_MODEL_OPTIONS).map(([platform, options]) => [platform, options.map(option => option.value)]),
);
for (const nodeType of ['ai.generateText', 'ai.classify']) {
  const modelField = CONFIG_SCHEMA[nodeType]?.find(field => field.key === 'model');
  if (modelField) {
    modelField.options = CURRENT_AI_MODEL_OPTIONS;
    modelField.optionsFilter = { key: 'platform', map: CURRENT_AI_MODEL_FILTER };
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  node: any;
  nodes?: any[];          // All nodes in the workflow (for node reference picking)
  edges?: any[];          // All edges in the workflow (to compute upstream nodes)
  onConfigChange: (config: Record<string, any>) => void;
  onLabelChange: (label: string) => void;
  onInlineRoutesChange?: (targetNodeIds: string[]) => void;
  onClose: () => void;
  workflowId?: string;
  /** Channel of the workflow (contact picker / variables default to it). */
  workflowChannel?: string;
  /** Accounts the workflow runs for ([] = every account of the channel). */
  workflowPageIds?: string[];
}

// ─── Shared styles ────────────────────────────────────────────────────────────

// Theme-aware `.wf-*` classes (index.css → "Workflow editor (wf-*)"). Do not use
// gray-* / text-foreground here: the light theme remaps those globally.
const inputCls  = 'wf-input';
const selectCls = 'wf-select';
const labelCls  = 'wf-label';
const descCls   = 'wf-help';
/** Button of a full-width segmented control (`wf-seg w-full`). Wrap the label in `<span className="truncate">`. */
const segBtnCls = 'wf-seg__btn flex-1 min-w-0 !h-7 !px-1.5';
/** Field-level pill (choice / chips / day picker) - a little larger than the preset chips. */
const chipCls   = 'wf-chip !h-7 !px-2.5 !text-xs';

type SectionIcon = (props: { className?: string }) => JSX.Element;

const DEFAULT_SECTION  = 'Cấu hình';
const ADVANCED_SECTION = 'Nâng cao';

/** Section card icons, looked up by `Field.section` name (unknown names → SlidersIcon). */
const SECTION_ICONS: Record<string, SectionIcon> = {
  'Phạm vi': TargetIcon,
  'Người gửi': UserIcon,
  'Người nhận': UsersIcon,
  'Nội dung': MessageSquareIcon,
  'Tệp đính kèm': PaperclipIcon,
  'Thời gian & tần suất': ClockIcon,
  'Bộ lọc': FilterIcon,
  'Điều kiện': FilterIcon,
  'Tài khoản': ShieldIcon,
  'Nguồn': DatabaseIcon,
  'Tùy chọn': SlidersIcon,
  [DEFAULT_SECTION]: SlidersIcon,
  [ADVANCED_SECTION]: SettingsIcon,
};

// ─── Sub-components ───────────────────────────────────────────────────────────

/** `{ }` glyph for template-variable affordances. */
function BracesGlyph({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
      <path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
    </svg>
  );
}

function ToggleSwitch({ checked, onChange, label, desc }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="wf-switch-row">
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-medium leading-[1.125rem] wf-text">{label}</span>
        {desc && <span className={`block ${descCls} !mt-0.5`}>{desc}</span>}
      </span>
      <span className="wf-switch mt-px" data-on={String(checked)} aria-hidden="true" />
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
        className={`${inputCls} wf-mono`}
      />
      {human && (
        <div className="wf-callout" data-tone="success">
          <ClockIcon className="w-3.5 h-3.5" />
          <span>{human}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map(p => (
          <button key={p.value} type="button" onClick={() => onChange(p.value)}
            className="wf-chip" data-active={String(value === p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Time window (active hours) ───────────────────────────────────────────────
// Value contract (CONTRACT.md "Active hours"): { mode, start: 'HH:mm', end: 'HH:mm', days }.
// days uses JS getDay() numbering (0 = Chủ nhật); empty = every day. Evaluated in Vietnam time.

type TimeWindowMode = 'always' | 'inside' | 'outside';
interface TimeWindowValue { mode: TimeWindowMode; start: string; end: string; days: number[] }

const TIME_WINDOW_DEFAULTS = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5, 6] };
const TIME_WINDOW_MODES: { value: TimeWindowMode; label: string }[] = [
  { value: 'always',  label: 'Luôn hoạt động' },
  { value: 'inside',  label: 'Trong khung giờ' },
  { value: 'outside', label: 'Ngoài khung giờ' },
];
/** Monday-first display order → getDay() values. */
const TIME_WINDOW_DAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: 'T2', name: 'Thứ 2' },
  { value: 2, short: 'T3', name: 'Thứ 3' },
  { value: 3, short: 'T4', name: 'Thứ 4' },
  { value: 4, short: 'T5', name: 'Thứ 5' },
  { value: 5, short: 'T6', name: 'Thứ 6' },
  { value: 6, short: 'T7', name: 'Thứ 7' },
  { value: 0, short: 'CN', name: 'Chủ nhật' },
];
const TIME_WINDOW_PRESETS: { label: string; start: string; end: string; days: number[] }[] = [
  { label: 'Giờ hành chính', start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5] },
  { label: 'Cả tuần 8h–22h', start: '08:00', end: '22:00', days: [0, 1, 2, 3, 4, 5, 6] },
  { label: 'Ban đêm',        start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
];

function describeTimeWindowDays(days: number[]): string {
  const ordered = TIME_WINDOW_DAYS.filter(d => days.includes(d.value));
  if (ordered.length === 0 || ordered.length === TIME_WINDOW_DAYS.length) return 'mọi ngày';
  const positions = ordered.map(d => TIME_WINDOW_DAYS.indexOf(d));
  const contiguous = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
  if (contiguous && ordered.length >= 3) return `${ordered[0].name} – ${ordered[ordered.length - 1].name}`;
  return ordered.map(d => d.name).join(', ');
}

function describeTimeWindow(v: TimeWindowValue): string {
  const isTime = (t: string) => /^[0-9]{2}:[0-9]{2}$/.test(t);
  if (!isTime(v.start) || !isTime(v.end)) return 'Hãy chọn đủ giờ bắt đầu và giờ kết thúc.';
  const range = v.start === v.end
    ? 'cả ngày'
    : `từ ${v.start} đến ${v.end}${v.start > v.end ? ' (qua đêm)' : ''}`;
  const days = describeTimeWindowDays(v.days);
  return v.mode === 'outside'
    ? `Tạm dừng ${range}, ${days} — thời gian còn lại vẫn chạy.`
    : `Chạy ${range}, ${days}.`;
}

function TimeWindowField({ value, onChange }: { value: unknown; onChange: (next: TimeWindowValue) => void }) {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Partial<TimeWindowValue>;
  const mode: TimeWindowMode = raw.mode === 'inside' || raw.mode === 'outside' ? raw.mode : 'always';
  // Missing values fall back to the defaults, so the first switch away from "always"
  // initialises start/end/days (08:00 – 17:30, Thứ 2 – Thứ 7).
  const current: TimeWindowValue = {
    mode,
    start: typeof raw.start === 'string' ? raw.start : TIME_WINDOW_DEFAULTS.start,
    end: typeof raw.end === 'string' ? raw.end : TIME_WINDOW_DEFAULTS.end,
    days: Array.isArray(raw.days)
      ? raw.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
      : [...TIME_WINDOW_DEFAULTS.days],
  };
  const emit = (patch: Partial<TimeWindowValue>) => onChange({ ...current, ...patch });
  const toggleDay = (day: number) => emit({
    days: current.days.includes(day)
      ? current.days.filter(d => d !== day)
      : [...current.days, day].sort((a, b) => a - b),
  });

  return (
    <div className="space-y-2.5">
      <div className="wf-seg w-full" role="radiogroup">
        {TIME_WINDOW_MODES.map(m => (
          <button key={m.value} type="button" role="radio" aria-checked={mode === m.value}
            onClick={() => { if (m.value !== mode) emit({ mode: m.value }); }}
            className={segBtnCls} data-active={String(mode === m.value)} title={m.label}>
            <span className="truncate">{m.label}</span>
          </button>
        ))}
      </div>

      {mode !== 'always' && (
        <div className="wf-card wf-card--plain p-3 space-y-3">
          <div className="wf-field-grid">
            <label className="block min-w-0">
              <span className="block mb-1 text-[11px] font-medium wf-muted">Từ</span>
              <input type="time" value={current.start} onChange={e => emit({ start: e.target.value })} className={inputCls} />
            </label>
            <label className="block min-w-0">
              <span className="block mb-1 text-[11px] font-medium wf-muted">Đến</span>
              <input type="time" value={current.end} onChange={e => emit({ end: e.target.value })} className={inputCls} />
            </label>
          </div>
          <div>
            <span className="block mb-1.5 text-[11px] font-medium wf-muted">Ngày áp dụng</span>
            <div className="flex flex-wrap gap-1.5">
              {TIME_WINDOW_DAYS.map(d => (
                <button key={d.value} type="button" aria-pressed={current.days.includes(d.value)}
                  onClick={() => toggleDay(d.value)} title={d.name}
                  className={`${chipCls} justify-center min-w-[2.5rem]`} data-active={String(current.days.includes(d.value))}>
                  {d.short}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-[11px] font-medium wf-muted">Mẫu nhanh:</span>
            {TIME_WINDOW_PRESETS.map(p => (
              <button key={p.label} type="button" className="wf-chip"
                onClick={() => emit({ start: p.start, end: p.end, days: [...p.days] })}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode !== 'always' && (
        <p className={`${descCls} flex items-start gap-1.5`}>
          <ClockIcon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{describeTimeWindow(current)} <span className="wf-faint">(giờ Việt Nam)</span></span>
        </p>
      )}
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
    { icon: <LinkIcon className="w-3.5 h-3.5" />, title: 'Liên kết',    action: () => wrap('<a href="https://">','</a>'), cls: '' },
    { icon: '━',  title: 'Đường kẻ',    action: () => insertLine('<hr/>'),    cls: '' },
    { icon: <PaletteIcon className="w-3.5 h-3.5" />, title: 'Màu chữ đỏ',  action: () => wrap('<span style="color:#e11d48">','</span>'), cls: '' },
  ];

  return (
    <div className="wf-card wf-card--plain overflow-hidden transition-colors focus-within:border-[color:var(--wf-focus)]">
      {/* Tab bar (+ toolbar, wraps below the tabs when the panel is narrow) */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5 border-b border-[color:var(--wf-card-border)]">
        <div className="wf-seg flex-shrink-0">
          <button type="button" onClick={() => setTab('edit')}
            className="wf-seg__btn" data-active={String(tab === 'edit')}>
            <EditIcon className="w-3 h-3" /> Soạn thảo
          </button>
          <button type="button" onClick={() => setTab('preview')}
            className="wf-seg__btn" data-active={String(tab === 'preview')}>
            <EyeIcon className="w-3 h-3" /> Xem trước
          </button>
        </div>
        {/* Toolbar - only in edit mode */}
        {tab === 'edit' && (
          <div className="flex flex-wrap items-center gap-0.5">
            {TOOLBAR.map(btn => (
              <button key={btn.title} type="button" title={btn.title} onClick={btn.action}
                className={`wf-icon-btn !w-6 !h-6 text-[11px] ${btn.cls}`}>
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
            className="block w-full bg-transparent px-3 py-2.5 wf-mono leading-relaxed resize-none outline-none text-[color:var(--wf-text)] placeholder:text-[color:var(--wf-faint)]"
          />
          {/* Var chips inside editor */}
          {templateVars && templateVars.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 px-2.5 py-2 border-t border-[color:var(--wf-card-border)]">
              <span className="mr-0.5 text-[10.5px] font-medium wf-faint">Chèn:</span>
              {templateVars.map(v => (
                <button key={v} type="button"
                  onClick={() => { const tag = `{{ ${v} }}`; insertLine(tag); navigator.clipboard.writeText(tag).catch(() => {}); }}
                  title={`Chèn + copy: {{ ${v} }}`}
                  className="rounded text-[11px] leading-5 transition-opacity hover:opacity-75">
                  <code className="wf-var">{v}</code>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Preview - always a white "email" canvas, independent of the app theme */
        <div className="bg-white min-h-[140px] max-h-[360px] overflow-y-auto">
          {value?.trim() ? (
            <div
              className="px-4 py-3 text-sm text-foreground prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: value }}
            />
          ) : (
            <div className="px-4 py-6 text-center text-muted-foreground text-xs italic">
              Chưa có nội dung - hãy soạn thảo trong tab "Soạn thảo"
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
        className={`${sizeClass} rounded-full object-cover flex-shrink-0 ring-1 ring-border`}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }

  // Fallback: initials
  const initials = (account.full_name || account.display_name || account.zalo_id).slice(0, 2).toUpperCase();
  return (
    <div className={`${sizeClass} rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-medium flex-shrink-0 ring-1 ring-border`}>
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
  const zaloOpts = options.filter(o => o.source === CHANNEL.ZALO);

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
    if (activeTab === CHANNEL.ZALO) {
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
    if (activeTab === CHANNEL.ZALO) {
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
      <div className="relative bg-popover border border-border rounded-2xl shadow-2xl w-[680px] max-w-[95vw] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-card/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-teal-500 to-purple-600 flex items-center justify-center">
              <span className="text-xl"><TagIcon className="w-4 h-4" /></span>
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Chọn nhãn</h2>
              <p className="text-xs text-muted-foreground">
                {mode === 'single' ? 'Chọn 1 nhãn' : 'Có thể chọn nhiều nhãn'}
                {selected.length > 0 && ` • Đã chọn: ${selected.length}`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-muted/50 hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* ─── Left: Account Sidebar ─── */}
          <div className="w-60 border-r border-border bg-card/30 flex flex-col">
            <div className="px-3 py-2.5 border-b border-border/50">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
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
                    : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground/80 border border-transparent'
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white text-sm"><ClipboardListIcon className="w-4 h-4 inline" /> </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">Tất cả</div>
                  <div className="text-[10px] text-muted-foreground">
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
                        : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground/80 border border-transparent'
                    }`}
                  >
                    <AccountAvatar account={acc} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {acc.full_name || acc.display_name || acc.zalo_id}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
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
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  Không có tài khoản nào có nhãn {activeTab === 'local' ? 'Local' : 'Zalo'}
                </div>
              )}
            </div>
          </div>

          {/* ─── Right: Labels Panel ─── */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Tabs */}
            <div className="flex bg-card/60 border-b border-border/50">
              <button
                type="button"
                onClick={() => setActiveTab('local')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
                  activeTab === 'local'
                    ? 'border-teal-500 text-teal-400 bg-teal-500/5'
                    : 'border-transparent text-muted-foreground hover:text-foreground/80 hover:bg-muted/30'
                }`}
              >
                <span><HardDriveIcon className="w-4 h-4" /></span>
                <span>Nhãn Local</span>
                {localOpts.length > 0 && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    activeTab === 'local' ? 'bg-teal-500/20 text-teal-400' : 'bg-muted text-muted-foreground'
                  }`}>
                    {localOpts.length}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab(CHANNEL.ZALO)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
                  activeTab === CHANNEL.ZALO
                    ? 'border-purple-500 text-purple-400 bg-purple-500/5'
                    : 'border-transparent text-muted-foreground hover:text-foreground/80 hover:bg-muted/30'
                }`}
              >
                <span>☁️</span>
                <span>Nhãn Zalo</span>
                {zaloOpts.length > 0 && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    activeTab === CHANNEL.ZALO ? 'bg-purple-500/20 text-purple-400' : 'bg-muted text-muted-foreground'
                  }`}>
                    {zaloOpts.length}
                  </span>
                )}
              </button>
            </div>

            {/* Labels List - Single column */}
            <div className="flex-1 overflow-y-auto p-3">
              {filteredLabels.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <span className="text-4xl mb-3 justify-center"><TagIcon className="w-4 h-4" /></span>
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
                            ? 'ring-2 ring-offset-1 ring-offset-background'
                            : 'bg-card/40 border-border/40 hover:border-input hover:bg-card/60'
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
                            <span className="text-[11px] text-muted-foreground">
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
        <div className="flex items-center justify-between px-5 py-4 border-t border-border bg-card/50">
          <div className="text-xs text-muted-foreground">
            {selected.length > 0 ? (
              <span>Đã chọn <span className="text-foreground font-medium">{selected.length}</span> nhãn</span>
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
              className="px-4 py-2 text-xs font-medium text-foreground/80 hover:text-foreground bg-muted hover:bg-accent rounded-lg transition-colors"
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
      <div className="wf-card wf-card--plain flex items-center justify-center gap-2 py-5 text-xs wf-muted">
        <Spinner size={4} />
        Đang tải danh sách nhãn…
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="wf-callout" data-tone="warn">
        <TagIcon className="w-3.5 h-3.5" />
        <div className="min-w-0">
          <div className="wf-callout__title">Chưa có nhãn nào</div>
          <div className="mt-0.5">Vào <b>CRM → Quản lý nhãn</b> để tạo nhãn trước.</div>
        </div>
      </div>
    );
  }

  const removeLabel = (v: string) => {
    onChange(selected.filter(x => x !== v));
  };

  return (
    <div className="wf-card wf-card--plain overflow-hidden">
      {/* ── Selected Labels Display ── */}
      {selected.length > 0 && (
        <div className="px-3 py-2.5 border-b border-[color:var(--wf-card-border)]">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide wf-muted">
              Đã chọn ({selected.length})
            </span>
            <button
              type="button"
              onClick={() => onChange([])}
              className="wf-btn wf-btn--sm wf-btn--ghost wf-btn--danger"
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
      <div className="p-1.5">
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="wf-btn wf-btn--ghost wf-btn--block"
        >
          <PlusIcon className="w-4 h-4" />
          {selected.length > 0 ? 'Thêm nhãn khác' : 'Chọn nhãn'}
        </button>
      </div>

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
        <div className="px-3 py-2 border-t border-[color:var(--wf-card-border)]">
          <p className="text-[11px] text-center wf-faint">
            {mode === 'single' ? 'Chọn 1 nhãn để áp dụng' : 'Có thể chọn nhiều nhãn • Để trống = áp dụng với mọi nhãn'}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Account + Contact Picker Fields ──────────────────────────────────────────

function AccountPickerField({ value, onChange, channel, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  channel?: string;
  placeholder?: string;
}) {
  const { accounts } = useAccountStore();
  const available = channel ? accounts.filter(account => account.channel === channel) : accounts;
  return (
    <select value={value || ''} onChange={event => onChange(event.target.value)} className={selectCls}>
      <option value="">{placeholder || 'Chọn tài khoản'}</option>
      {available.map(account => <option key={account.zalo_id} value={account.zalo_id}>{account.full_name || account.display_name || account.username || account.zalo_id}</option>)}
      {value && !available.some(account => account.zalo_id === value) && <option value={value}>{value}</option>}
    </select>
  );
}

// ─── File Picker Field ────────────────────────────────────────────────────────

function FilePickerField({
  value,
  onChange,
  fileType,
}: {
  value: string;
  onChange: (v: string) => void;
  fileType: 'image' | 'file';
  placeholder?: string;
}) {
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
  const isLocalFile = value && !isUrl;
  const showPreview = fileType === 'image' && value && !previewError;

  return (
    <div className="wf-card wf-card--plain overflow-hidden">
      {/* Preview for images */}
      {showPreview && (
        <div className="p-2.5 border-b border-[color:var(--wf-card-border)]">
          <div className="relative w-full h-36 rounded-lg overflow-hidden bg-[var(--wf-sub)]">
            <img
              src={isUrl ? value : `file://${value}`}
              alt="Preview"
              className="w-full h-full object-contain"
              onError={() => setPreviewError(true)}
            />
          </div>
        </div>
      )}

      {/* Local file selection is the primary workflow. Legacy URL values still
          render below so existing workflows remain readable, but new media
          actions never require the user to type a path or URL. */}
      <div className="p-2">
        <button
          type="button"
          onClick={handleSelectFile}
          className="wf-btn wf-btn--block"
        >
          {fileType === 'image' ? <ImageIcon className="w-4 h-4" /> : <PaperclipIcon className="w-4 h-4" />}
          {value ? `Đổi ${fileType === 'image' ? 'ảnh' : 'tệp'}` : `Chọn ${fileType === 'image' ? 'ảnh' : 'tệp'} từ máy tính`}
        </button>
      </div>

      {/* File info */}
      {value && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-[color:var(--wf-card-border)]">
          {isLocalFile ? (
            <>
              <CheckCircleIcon className="w-4 h-4 flex-shrink-0 text-[#16a34a]" />
              <span className="min-w-0 truncate text-[11px] wf-text-2" title={value}>
                Đã chọn: {value.split(/[\\/]/).pop()}
              </span>
            </>
          ) : isUrl ? (
            <>
              <LinkIcon className="w-4 h-4 flex-shrink-0 text-[color:var(--wf-focus)]" />
              <span className="min-w-0 truncate text-[11px] wf-muted" title={value}>
                URL cũ: {value}
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
              className="wf-btn wf-btn--sm wf-btn--danger ml-auto flex-shrink-0"
            >
              Xóa
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Node Picker Modal ────────────────────────────────────────────────────────

function NodePickerModal({
  open,
  onClose,
  allNodes,
  currentId,
  onInsertOutput,
}: {
  open: boolean;
  onClose: () => void;
  allNodes: { id: string; label: string; type: string; isCurrent: boolean }[];
  currentId?: string;
  onInsertOutput: (nodeId: string) => void;
}) {
  const [search, setSearch] = React.useState('');
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const theme = useAppStore(s => s.theme);
  const isLight = theme === 'light';

  const filtered = search.trim()
    ? allNodes.filter(n =>
        n.label.toLowerCase().includes(search.toLowerCase()) ||
        n.id.toLowerCase().includes(search) ||
        n.type.toLowerCase().includes(search)
      )
    : allNodes;

  const copyRef = (id: string) => {
    const text = `{{ $node.${id}.output }}`;
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1200);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative rounded-2xl shadow-2xl w-[520px] max-w-[95vw] max-h-[80vh] flex flex-col overflow-hidden border ${
        isLight ? 'bg-white border-gray-200' : 'bg-background border-border'
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isLight ? 'border-gray-200' : 'border-border'}`}>
          <div>
            <p className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-foreground'}`}>Chọn dữ liệu từ node</p>
            <p className={`text-xs ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>Click để copy UUID hoặc chèn cú pháp tham chiếu</p>
          </div>
          <button onClick={onClose} className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
            isLight ? 'hover:bg-gray-100 text-muted-foreground' : 'hover:bg-muted text-muted-foreground'
          }`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className={`px-4 py-3 border-b ${isLight ? 'border-gray-200' : 'border-border/50'}`}>
          <div className="relative">
            <svg className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              type="text" placeholder="Tìm theo tên, ID, loại node..."
              value={search} onChange={e => setSearch(e.target.value)}
              className={`w-full pl-10 pr-4 py-2 text-sm rounded-lg border focus:outline-none focus:ring-2 ${
                isLight
                  ? 'bg-white border-gray-200 text-gray-900 placeholder-subtle-foreground focus:ring-blue-500/30'
                  : 'bg-card border-input text-foreground placeholder-subtle-foreground focus:ring-blue-500/30'
              }`}
            />
          </div>
        </div>

        {/* Node list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {filtered.length === 0 ? (
            <div className={`text-center py-8 ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
              <span className="text-3xl block mb-2"><SearchIcon className="w-4 h-4" /></span>
              <p className="text-sm">Không tìm thấy node</p>
            </div>
          ) : (
            filtered.map(n => {
              const isCurrent = n.id === currentId;
              const copied = copiedId === n.id;
              return (
                <div key={n.id} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all ${
                  isCurrent
                    ? isLight ? 'bg-gray-100 border-gray-200' : 'bg-card/60 border-border'
                    : isLight ? 'bg-white border-gray-200 hover:border-gray-300' : 'bg-card/40 border-border/40 hover:border-input'
                }`}>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate flex items-center gap-1.5 ${isLight ? 'text-gray-900' : 'text-foreground'}`}>
                      {n.label}
                      {isCurrent && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                          isLight ? 'bg-gray-200 text-muted-foreground' : 'bg-muted text-muted-foreground'
                        }`}>đang chọn</span>
                      )}
                    </div>
                    <div className={`text-[10px] font-mono truncate mt-0.5 ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
                      {n.id}
                    </div>
                  </div>

                  {/* Copy full reference button */}
                  <button
                    type="button"
                    onClick={() => {
                      copyRef(n.id);
                      onClose();
                    }}
                    title="Copy {{ $node.<ID>.output }}"
                    className={`flex-shrink-0 px-2.5 py-1.5 text-[10px] font-medium rounded-lg transition-colors ${
                      copied
                        ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                        : isLight
                          ? 'bg-cyan-50 text-cyan-700 hover:bg-cyan-100 border border-cyan-200'
                          : 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/30'
                    }`}
                  >
                    {copied ? '✓ Copied' : 'Copy output'}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className={`px-5 py-3 border-t flex items-center justify-between ${isLight ? 'border-gray-200 bg-gray-50' : 'border-border bg-card/50'}`}>
          <span className={`text-[11px] ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
            {filtered.length}/{allNodes.length} node
          </span>
          <button onClick={onClose} className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            isLight ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-muted text-foreground/80 hover:bg-accent'
          }`}>Đóng</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type BotKeyboardButton = {
  id: string;
  text: string;
  action?: 'node' | 'callback' | 'url';
  targetNodeId?: string;
  callbackData?: string;
  url?: string;
};

function newBotKeyboardButton(): BotKeyboardButton {
  return { id: `button_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text: 'Nút mới', action: 'node' };
}

/** Extract only valid in-workflow inline-button targets from persisted config. */
function getInlineTargetNodeIds(keyboard: unknown): string[] {
  if (!keyboard || typeof keyboard !== 'object') return [];
  const value = keyboard as { type?: unknown; rows?: unknown };
  if (value.type !== 'inline' || !Array.isArray(value.rows)) return [];

  const ids = value.rows.flatMap((row: unknown) =>
    (Array.isArray(row) ? row : [row]).flatMap((button: unknown) => {
      if (!button || typeof button !== 'object') return [];
      const candidate = button as { action?: unknown; targetNodeId?: unknown };
      return candidate.action === 'node' && candidate.targetNodeId
        ? [String(candidate.targetNodeId)]
        : [];
    }),
  );
  return [...new Set(ids)];
}

function TelegramBotMessageEditor({
  config, updateConfig, accounts, nodes, currentNodeId, onInlineRoutesChange,
}: {
  config: Record<string, any>;
  updateConfig: (next: Record<string, any>) => void;
  accounts: any[];
  nodes: any[];
  currentNodeId: string;
  onInlineRoutesChange?: (targetNodeIds: string[]) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>('');
  const isLight = useAppStore(s => s.theme) === 'light';
  const keyboard = {
    enabled: false,
    type: 'reply' as 'reply' | 'inline',
    rows: [] as BotKeyboardButton[][],
    resize: true,
    oneTime: false,
    persistent: false,
    ...(config.keyboard || {}),
  };
  const rows: BotKeyboardButton[][] = Array.isArray(keyboard.rows) ? keyboard.rows : [];
  const bots = accounts.filter((account: any) => account.channel === 'telegram_bot');
  const targetNodes = nodes
    .filter((item: any) => item.id !== currentNodeId)
    .map((item: any) => ({ id: item.id, label: item.data?.label || item.label || getNodeLabel(item.data?.type || item.type) }));
  useEffect(() => {
    onInlineRoutesChange?.(getInlineTargetNodeIds(keyboard));
  // The serialized rows are the stable configuration boundary for this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboard.type, keyboard.enabled, JSON.stringify(rows)]);
  const applyConfig = (next: Record<string, any>) => {
    updateConfig(next);
    onInlineRoutesChange?.(getInlineTargetNodeIds(next.keyboard));
  };
  const setKeyboard = (next: Record<string, any>) => applyConfig({ ...config, keyboard: { ...keyboard, ...next } });
  const mutateRows = (mutator: (current: BotKeyboardButton[][]) => BotKeyboardButton[][]) => setKeyboard({ rows: mutator(rows) });
  const previewMarkup = (() => {
    if (!keyboard.enabled || !rows.length) return undefined;
    if (keyboard.type === 'reply') {
      return { keyboard: rows.map(row => row.map(btn => btn.text).filter(Boolean)).filter(row => row.length), resize_keyboard: keyboard.resize !== false, one_time_keyboard: !!keyboard.oneTime, is_persistent: !!keyboard.persistent };
    }
    return {
      inline_keyboard: rows.map(row => row.map(btn => {
        if (btn.action === 'url') return { text: btn.text, url: btn.url || '' };
        return { text: btn.text, callback_data: btn.action === 'node' ? `dlw:n:${btn.id || ''}` : (btn.callbackData || '') };
      }).filter(btn => btn.text && (btn.url || btn.callback_data))).filter(row => row.length),
    };
  })();
  const testSend = async () => {
    if (!config.accountId || !config.testChatId || !config.message) {
      setTestResult('Chọn Bot, Chat thử và nhập nội dung trước khi gửi thử.');
      return;
    }
    setTesting(true); setTestResult('');
    try {
      const result = await ipc.telegram?.sendMessage({
        accountId: config.accountId,
        chatId: config.testChatId,
        text: config.message,
        replyMarkup: previewMarkup,
      });
      setTestResult(result?.success ? 'Đã gửi vào chat thử.' : (result?.error || 'Không thể gửi thử.'));
    } catch (err: any) {
      setTestResult(err?.message || 'Không thể gửi thử.');
    } finally { setTesting(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[13px] font-semibold wf-text">Tin nhắn Telegram Bot</p>
        <p className={`${descCls} !mt-1`}>Để trống phần nút bấm nếu chỉ muốn gửi tin nhắn như workflow hiện tại.</p>
      </div>
      <div>
        <label className={`${labelCls} mb-1.5`}>Bot gửi tin</label>
        <select value={config.accountId || ''} onChange={e => applyConfig({ ...config, accountId: e.target.value })}
          className={selectCls}>
          <option value="">Chọn Telegram Bot</option>
          {bots.map((bot: any) => <option key={bot.zalo_id} value={bot.zalo_id}>{bot.full_name || bot.username || bot.zalo_id}</option>)}
        </select>
      </div>
      <div>
        <label className={`${labelCls} mb-1.5`}>Hội thoại nhận</label>
        <input value={config.chatId ?? ''} onChange={e => applyConfig({ ...config, chatId: e.target.value })}
          placeholder="{{ $trigger.chatId }}" className={inputCls} />
        <p className={descCls}>Giữ <code className="wf-var">{'{{ $trigger.chatId }}'}</code> để trả lời đúng chat vừa kích hoạt workflow.</p>
      </div>
      <div>
        <label className={`${labelCls} mb-1.5`}>Nội dung tin nhắn</label>
        <textarea value={config.message ?? ''} onChange={e => applyConfig({ ...config, message: e.target.value })}
          rows={4} placeholder="Xin chào! Mình có thể giúp gì?" className="wf-textarea" />
      </div>

      <div className="wf-card p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="text-[13px] font-semibold wf-text">Thêm nút tương tác</p><p className={`${descCls} !mt-0.5`}>Bật khi cần menu hoặc chuyển người dùng đến một nhánh node trong canvas.</p></div>
          <button type="button" role="switch" aria-checked={keyboard.enabled} onClick={() => setKeyboard({ enabled: !keyboard.enabled })}
            className="wf-switch mt-0.5" data-on={String(!!keyboard.enabled)} title={keyboard.enabled ? 'Tắt nút tương tác' : 'Bật nút tương tác'} />
        </div>
        {keyboard.enabled && <>
          <div className="wf-seg w-full">
            <button type="button" onClick={() => setKeyboard({ type: 'reply' })} className={segBtnCls} data-active={String(keyboard.type === 'reply')}><span className="truncate">Reply Keyboard</span></button>
            <button type="button" onClick={() => setKeyboard({ type: 'inline' })} className={segBtnCls} data-active={String(keyboard.type === 'inline')}><span className="truncate">Inline Button</span></button>
          </div>
          <p className="text-[11px] leading-4 wf-muted">{keyboard.type === 'reply' ? 'Reply Keyboard gửi chính text của nút như một tin nhắn mới. Hãy dùng trigger tin nhắn để xử lý.' : 'Inline Button nhận callback. Nút “Đi đến node” chỉ chạy node đích và các node nối sau nó khi người dùng bấm.'}</p>
          <div className="space-y-2">
            {rows.map((row, rowIndex) => <div key={rowIndex} className="wf-card wf-card--plain p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-semibold wf-muted">Hàng {rowIndex + 1}</span><button type="button" onClick={() => mutateRows(current => current.filter((_, i) => i !== rowIndex))} className="wf-btn wf-btn--sm wf-btn--ghost wf-btn--danger">Xóa hàng</button></div>
              {row.map((button, buttonIndex) => <div key={button.id} className="wf-card p-2 space-y-1.5">
                <div className="flex items-center gap-1.5"><input value={button.text} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, text: e.target.value } : b) : r))} placeholder="Tên nút" className="wf-input wf-input--sm min-w-0 flex-1" />
                  <button type="button" onClick={() => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.filter((_, bi) => bi !== buttonIndex) : r))} className="wf-icon-btn wf-icon-btn--danger" title="Xóa nút"><CloseIcon className="w-3.5 h-3.5" /></button></div>
                {keyboard.type === 'inline' && <>
                  <select value={button.action || 'node'} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, action: e.target.value as BotKeyboardButton['action'] } : b) : r))} className="wf-select wf-input--sm"><option value="node">Đi đến node</option><option value="callback">Callback tùy chỉnh</option><option value="url">Mở liên kết</option></select>
                  {(button.action || 'node') === 'node' && <select value={button.targetNodeId || ''} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, targetNodeId: e.target.value } : b) : r))} className="wf-select wf-input--sm"><option value="">Chọn node đích</option>{targetNodes.map((target: any) => <option key={target.id} value={target.id}>{target.label}</option>)}</select>}
                  {(button.action || 'node') === 'callback' && <input value={button.callbackData || ''} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, callbackData: e.target.value } : b) : r))} maxLength={64} placeholder="callback_data (tối đa 64 bytes)" className="wf-input wf-input--sm" />}
                  {(button.action || 'node') === 'url' && <input value={button.url || ''} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, url: e.target.value } : b) : r))} placeholder="https://..." className="wf-input wf-input--sm" />}
                </>}
              </div>)}
              <button type="button" onClick={() => mutateRows(current => current.map((r, i) => i === rowIndex ? [...r, newBotKeyboardButton()] : r))} className="wf-btn wf-btn--sm wf-btn--ghost"><PlusIcon className="w-3 h-3" /> Thêm nút cùng hàng</button>
            </div>)}
            <button type="button" onClick={() => mutateRows(current => [...current, [newBotKeyboardButton()]])} className="wf-btn wf-btn--dashed wf-btn--block"><PlusIcon className="w-3.5 h-3.5" /> Thêm hàng nút</button>
          </div>
          {keyboard.type === 'reply' && <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs wf-text-2"><label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-[var(--wf-focus)]" checked={keyboard.resize !== false} onChange={e => setKeyboard({ resize: e.target.checked })} /> Tự co chiều cao</label><label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-[var(--wf-focus)]" checked={!!keyboard.oneTime} onChange={e => setKeyboard({ oneTime: e.target.checked })} /> Ẩn sau một lần bấm</label><label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-[var(--wf-focus)]" checked={!!keyboard.persistent} onChange={e => setKeyboard({ persistent: e.target.checked })} /> Luôn hiển thị</label></div>}
        </>}
      </div>

      <div className="wf-card p-3">
        <p className="mb-2 text-xs font-semibold wf-text">Xem trước</p>
        <div className={`rounded-lg p-3 ${isLight ? 'bg-[#eef3f8]' : 'bg-muted'}`}><div className={`ml-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-sm px-3 py-2 text-xs ${isLight ? 'bg-[#d8ecff] text-foreground' : 'bg-accent text-foreground'}`}>{config.message || 'Nội dung tin nhắn'}</div>
          {keyboard.enabled && rows.length > 0 && <div className={`mt-2 gap-1 ${keyboard.type === 'reply' ? (isLight ? 'rounded-lg bg-white p-2 shadow-sm' : 'rounded-lg bg-muted p-2') : 'flex flex-col'}`}>{rows.map((row, index) => <div key={index} className="flex gap-1">{row.map(button => <span key={button.id} className={`flex-1 rounded px-2 py-1.5 text-center text-[10px] ${isLight ? 'bg-white text-blue-700 border border-blue-200' : 'bg-accent text-[#8fc7ff]'}`}>{button.text || 'Nút'}</span>)}</div>)}</div>}</div>
      </div>
      <div className="wf-card p-3"><p className="text-xs font-semibold wf-text">Gửi thử an toàn</p><p className={`${descCls} !mt-0.5`}>Chỉ gửi vào Chat thử bên dưới, không dùng hội thoại đang kích hoạt workflow.</p><div className="mt-2 flex gap-2"><input value={config.testChatId || ''} onChange={e => applyConfig({ ...config, testChatId: e.target.value })} placeholder="Chat ID thử" className="wf-input min-w-0 flex-1" /><button type="button" disabled={testing} onClick={testSend} className="wf-btn wf-btn--success !h-auto flex-shrink-0">{testing ? 'Đang gửi…' : 'Gửi thử'}</button></div>{testResult && <p className="mt-2 text-[11px]" style={{ color: testResult.startsWith('Đã') ? '#16a34a' : '#d97706' }}>{testResult}</p>}</div>
    </div>
  );
}

export default function NodeConfigPanel({ node, nodes, edges, onConfigChange, onLabelChange, onInlineRoutesChange, onClose, workflowId, workflowChannel, workflowPageIds }: Props) {
  const { accounts } = useAccountStore();
  const [config, setConfig]             = useState<Record<string, any>>(node.config || {});
  const [label, setLabel]               = useState(node.label || '');
  // "Nâng cao" section - open by default (settings panel v2).
  const [showAdvanced, setShowAdvanced] = useState(true);
  /** Per-section collapsed flags (section name → true when collapsed). Every section starts expanded. */
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [panelWidth, setPanelWidth]     = useState(420);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loadedLabelOptions, setLoadedLabelOptions] = useState<LoadedLabelOption[]>([]);
  const [loadingLabelOptions, setLoadingLabelOptions] = useState(false);
  const [assistantList, setAssistantList] = useState<{ id: string; name: string; platform: string; model: string; enabled: boolean }[]>([]);
  const [loadingAssistants, setLoadingAssistants] = useState(false);
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [showTemplatePopup, setShowTemplatePopup] = useState(false);
  const [templatePopupField, setTemplatePopupField] = useState<string>('');
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null);
  const [isUpstreamNodesCollapsed, setIsUpstreamNodesCollapsed] = useState(true);
  const isResizingRef = useRef(false);
  const resizeStartXRef  = useRef(0);
  const resizeStartWRef  = useRef(420);

  const allFields   = CONFIG_SCHEMA[node.type] || pluginFieldsFor(node.type) || [];
  const visual      = getNodeVisual(node.type);
  const defaultLabel = getNodeLabel(node.type);
  const nodeDescription = getNodeDescription(node.type);

  // ── Group fields into titled sections ("sắp xếp thông minh") ──────────────
  // Schema order is kept. `section` wins; otherwise basic fields go to "Cấu hình"
  // and advanced ones to "Nâng cao", which is always rendered last.
  const fieldSections: { name: string; fields: Field[] }[] = [];
  const advancedFields: Field[] = [];
  for (const field of allFields) {
    const name = field.section || (field.advanced ? ADVANCED_SECTION : DEFAULT_SECTION);
    if (name === ADVANCED_SECTION) { advancedFields.push(field); continue; }
    let section = fieldSections.find(s => s.name === name);
    if (!section) { section = { name, fields: [] }; fieldSections.push(section); }
    section.fields.push(field);
  }
  if (advancedFields.length > 0) fieldSections.push({ name: ADVANCED_SECTION, fields: advancedFields });

  useEffect(() => {
    setConfig(node.config || {});
    setLabel(node.label || '');
    setShowAdvanced(true);
    setCollapsedSections({});
  }, [node.id]);

  // Stable account IDs string to prevent useEffect re-runs
  const accountIds = accounts.map(a => a.zalo_id).sort().join(',');

  useEffect(() => {
    const isAudience = node.type === 'logic.forEachContact';
    if (node.type !== 'trigger.labelAssigned' && node.type !== 'zalo.assignLabel' && node.type !== 'zalo.removeLabel' && !isAudience) {
      setLoadedLabelOptions([]);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoadingLabelOptions(true);
      try {
        const opts: LoadedLabelOption[] = [];

        // Load local labels
        const localRes = await DataAccessor.getLocalLabels({});
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
        // (audience source "Hội thoại theo nhãn" only reads Local labels → no Zalo API calls for it)
        const currentAccounts = isAudience ? [] : useAccountStore.getState().accounts;

        for (const acc of currentAccounts) {
          try {
            const auth = buildZaloAuth(acc);
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

  // ── Load Integration list for integration-picker ───────────────────────
  useEffect(() => {
    if (node.type !== 'notify.telegram') return;
    const load = async () => {
      try {
        const res = await ipc.integration?.list();
        if (res?.success) {
          (window as any).__integrationList = res.integrations || [];
        }
      } catch { /* ignore */ }
    };
    load();
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

  // ── Compute upstream/reachable nodes for reference picking ──────────────
  const upstreamNodes = React.useMemo(() => {
    if (!nodes || !edges || !node?.id) return [];

    // Node chạy trước node này (BFS ngược theo cạnh; sau cổng "Xong" của Lặp qua danh sách thì gồm cả thân vòng lặp)
    const nodeMap = new Map(nodes.map((n: any) => [n.id, n]));
    const upstream = upstreamNodeIds(node.id, edges, id => {
      const n: any = nodeMap.get(id);
      return n?.data?.type || n?.type;
    });

    // Map to display info
    return Array.from(upstream)
      .map(id => {
        const n = nodeMap.get(id);
        if (!n) return null;
        const data = n.data || {};
        return {
          id,
          label: data.label || n.label || getNodeLabel(data.type || n.type),
          type: data.type || n.type,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [nodes, edges, node?.id]);

  // ── Variable context: trigger types of the workflow + upstream nodes (with config) ──
  const triggerTypes = React.useMemo(() => {
    const types = (nodes || []).map((n: any) => String(n.data?.type || n.type || '')).filter(isTriggerType);
    return [...new Set(types)];
  }, [nodes]);
  const upstreamVarNodes = React.useMemo<VarNode[]>(() => {
    const byId = new Map((nodes || []).map((n: any) => [n.id, n]));
    return (upstreamNodes as any[]).map(u => ({ id: u.id, label: u.label, type: u.type, config: byId.get(u.id)?.data?.config || {} }));
  }, [upstreamNodes, nodes]);
  /** Field suggestions the workflow's trigger really provides (e.g. no fromName on Facebook). */
  const availableVars = (keys?: string[]) => (keys || []).filter(key => isVarAvailable(key, triggerTypes));

  // ── All nodes for the node picker modal ─────────────────────────────────
  const allNodeList = React.useMemo(() => {
    if (!nodes) return [];
    return nodes
      .map((n: any) => {
        const data = n.data || {};
        const type = data.type || n.type;
        return {
          id: n.id,
          label: data.label || n.label || getNodeLabel(type),
          type,
          isCurrent: n.id === node?.id,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [nodes, node?.id]);

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
      setPanelWidth(Math.max(320, Math.min(760, resizeStartWRef.current + delta)));
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

  /** `hideWhenKey` / `hideWhenValue` rule (hidden fields are not rendered; empty sections are skipped). */
  const isFieldHidden = (field: Field): boolean => {
    if (field.hideWhenKey && field.hideWhenValue) {
      const cur = config[field.hideWhenKey] || '';
      // Nếu chưa có giá trị (old workflow), dùng default = 'assistant'
      const effective = field.hideWhenKey === 'aiConfigMode' && !cur ? 'assistant' : cur;
      if (effective === field.hideWhenValue) return true;
    }
    return false;
  };

  /** Options of a select / choice field after `optionsFilter`. */
  const getFieldOptions = (field: Field): SelectOption[] => {
    let opts = field.options ?? [];
    if (field.optionsFilter) {
      const filterVal = config[field.optionsFilter.key] as string | undefined;
      const allowed = filterVal ? field.optionsFilter.map[filterVal] : null;
      if (allowed) opts = opts.filter(o => allowed.includes(o.value));
    }
    return opts;
  };

  /** select / choice change - also drops the dependent keys listed in `clearsKeyOnChange`. */
  const selectOption = (field: Field, value: string) => {
    const next: Record<string, any> = { ...config, [field.key]: value };
    if (field.clearsKeyOnChange) field.clearsKeyOnChange.forEach(k => { delete next[k]; });
    setConfig(next); onConfigChange(next);
  };

  const renderField = (field: Field) => {
    // ── hideWhen: skip rendering if condition matches ──────────────────────
    if (isFieldHidden(field)) return null;

    // Boolean → switch row. renderSection wraps consecutive rows in one `wf-toggle-list`.
    if (field.type === 'boolean') {
      return (
        <ToggleSwitch key={field.key} checked={!!config[field.key]} onChange={v => update(field.key, v)}
          label={field.label} desc={field.desc} />
      );
    }

    // Plain info → a single callout (label = title, desc = body).
    if (field.type === 'info' && !field.isWebhookUrl) {
      return (
        <div key={field.key} className="wf-callout">
          <InfoIcon className="w-3.5 h-3.5" />
          <div className="min-w-0">
            <div className="wf-callout__title">{field.label}</div>
            {field.desc && <div className="mt-0.5">{field.desc}</div>}
          </div>
        </div>
      );
    }

    const showVarBtn = !!field.templateVars?.length && !(field.htmlToggle && config[field.htmlToggle]);
    const chipsEmpty = field.type === 'chips' && !(Array.isArray(config[field.key]) && config[field.key].length > 0);

    return (
      <div key={field.key}>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <label className={`${labelCls} min-w-0`}>{field.label}</label>
          {(chipsEmpty || showVarBtn) && (
            <div className="flex items-center gap-2 flex-shrink-0">
              {chipsEmpty && <span className="text-[11px] wf-faint">Không chọn = tất cả</span>}
              {showVarBtn && (
                <button
                  type="button"
                  onClick={() => { setTemplatePopupField(field.key); setShowTemplatePopup(true); }}
                  className="wf-var-btn"
                  title="Chèn biến động"
                >
                  <BracesGlyph />
                  Chèn biến
                  {availableVars(field.templateVars).length > 0 && (
                    <span className="opacity-60">{availableVars(field.templateVars).length}</span>
                  )}
                </button>
              )}
            </div>
          )}
        </div>

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
              templateVars={availableVars(field.templateVars)}
            />
          ) : (
            <textarea value={config[field.key] ?? ''} onChange={e => update(field.key, e.target.value)}
              placeholder={field.placeholder} rows={field.type === 'multiline' ? 5 : 3}
              className="wf-textarea" />
          )
        )}
        {field.type === 'select' && (() => {
          const opts = getFieldOptions(field);
          return (
            <select value={config[field.key] ?? opts[0]?.value ?? ''}
              onChange={e => selectOption(field, e.target.value)} className={selectCls}>
              {opts.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          );
        })()}
        {field.type === 'choice' && (() => {
          const opts = getFieldOptions(field);
          // Same as <select value={…}>: React matches the value as a string, and a value that is not an
          // option (e.g. templates storing threadType 'user', or the number 0) shows the first option.
          const raw = config[field.key];
          const active = raw != null && opts.some(o => o.value === String(raw)) ? String(raw) : opts[0]?.value;
          // Like a native <select>, re-picking the current value is a no-op (keeps clearsKeyOnChange keys).
          const pick = (value: string) => { if (value !== active) selectOption(field, value); };
          const maxSegLabel = opts.length <= 2 ? 22 : 15;
          if (opts.length <= 3 && opts.every(o => o.label.length <= maxSegLabel)) {
            return (
              <div className="wf-seg w-full" role="radiogroup" aria-label={field.label}>
                {opts.map(opt => (
                  <button key={opt.value} type="button" role="radio" aria-checked={active === opt.value}
                    onClick={() => pick(opt.value)} title={opt.label}
                    className={segBtnCls} data-active={String(active === opt.value)}>
                    <span className="truncate">{opt.label}</span>
                  </button>
                ))}
              </div>
            );
          }
          return (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={field.label}>
              {opts.map(opt => (
                <button key={opt.value} type="button" role="radio" aria-checked={active === opt.value}
                  onClick={() => pick(opt.value)}
                  className={chipCls} data-active={String(active === opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
          );
        })()}
        {field.type === 'chips' && (() => {
          const selected: string[] = Array.isArray(config[field.key]) ? config[field.key] : [];
          return (
            <div className="flex flex-wrap gap-1.5">
              {(field.options ?? []).map(opt => {
                const isOn = selected.includes(opt.value);
                return (
                  <button key={opt.value} type="button" aria-pressed={isOn}
                    onClick={() => update(field.key, isOn ? selected.filter(v => v !== opt.value) : [...selected, opt.value])}
                    className={chipCls} data-active={String(isOn)}>
                    {isOn && <CheckIcon className="w-3 h-3 -ml-0.5" />}
                    {opt.label}
                  </button>
                );
              })}
            </div>
          );
        })()}
        {field.type === 'time-window' && (
          <TimeWindowField value={config[field.key]} onChange={v => update(field.key, v)} />
        )}
        {field.type === 'number' && (
          <input type="number" value={config[field.key] ?? ''}
            min={field.min} placeholder={field.placeholder}
            onChange={e => {
              const v = Number(e.target.value);
              update(field.key, field.min !== undefined && v < field.min ? field.min : v);
            }} className={inputCls} />
        )}
        {field.type === 'json' && (
          <textarea
            value={typeof config[field.key] === 'string' ? config[field.key] : JSON.stringify(config[field.key] ?? '', null, 2)}
            onChange={e => { try { update(field.key, JSON.parse(e.target.value)); } catch { update(field.key, e.target.value); } }}
            placeholder={field.hint || field.placeholder} rows={4}
            className="wf-textarea wf-mono" />
        )}
        {field.type === 'case-list' && (() => {
          const cases: Array<{ match: string; label: string }> = Array.isArray(config[field.key]) ? config[field.key] : [];
          const setCases = (next: Array<{ match: string; label: string }>) => update(field.key, next);
          return (
            <div className="space-y-2">
              {cases.map((c, idx) => (
                <div key={idx} className="wf-card wf-card--plain p-2.5">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-xs font-semibold wf-text-2">Nhánh {idx + 1}</span>
                    <button
                      type="button"
                      onClick={() => setCases(cases.filter((_, i) => i !== idx))}
                      className="wf-icon-btn wf-icon-btn--danger !w-6 !h-6"
                      title="Xoá nhánh"
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="wf-field-grid">
                    <label className="block min-w-0">
                      <span className="block mb-1 text-[11px] font-medium wf-muted">Khi giá trị khớp</span>
                      <input
                        value={c.match ?? ''}
                        onChange={e => setCases(cases.map((x, i) => i === idx ? { ...x, match: e.target.value } : x))}
                        placeholder="Giá trị khớp (vd: xin chào)"
                        className="wf-input wf-input--sm"
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="block mb-1 text-[11px] font-medium wf-muted">Tên nhánh</span>
                      <input
                        value={c.label ?? ''}
                        onChange={e => setCases(cases.map((x, i) => i === idx ? { ...x, label: e.target.value } : x))}
                        placeholder="Tên nhánh (vd: case_chao)"
                        className="wf-input wf-input--sm"
                      />
                    </label>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCases([...cases, { match: '', label: `case_${cases.length + 1}` }])}
                className="wf-btn wf-btn--dashed wf-btn--block"
              >
                <PlusIcon className="w-3.5 h-3.5" /> Thêm nhánh
              </button>
            </div>
          );
        })()}
        {field.type === 'cron' && (
          <CronField value={config[field.key] ?? ''} onChange={v => update(field.key, v)} placeholder={field.placeholder} />
        )}
        {field.type === 'info' && field.isWebhookUrl && <WebhookUrlField field={field} config={config} workflowId={workflowId} update={update} />}

        {field.type === 'html' && (
          <HtmlEditorField value={config[field.key] ?? ''} onChange={v => update(field.key, v)} placeholder={field.placeholder} />
        )}
        {field.type === 'label-picker' && (() => {
          // Tính mode: dynamic → phụ thuộc labelSource
          const pickerMode: 'single' | 'multi' =
            field.labelMode === 'dynamic'
              ? (config.labelSource === CHANNEL.ZALO ? 'single' : 'multi')
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
          (() => {
            // Kênh: field chéo kênh → theo config; field có kênh riêng → kênh đó; còn lại → kênh của workflow
            const pickerChannel = (field.channelFromKey ? config[field.channelFromKey] : field.channel) || workflowChannel;
            return (
              <ContactPickerField
                value={config[field.key] ?? ''}
                onChange={v => update(field.key, v)}
                contactType={field.contactType || 'all'}
                contactMode={field.contactMode}
                channel={pickerChannel}
                accountId={field.accountIdFromKey ? config[field.accountIdFromKey] : undefined}
                preferredAccountIds={pickerChannel && pickerChannel === workflowChannel ? workflowPageIds : undefined}
                placeholder={field.placeholder}
                templateVars={availableVars(field.templateVars)}
              />
            );
          })()
        )}

        {field.type === 'account-picker' && (
          <AccountPickerField
            value={config[field.key] ?? ''}
            onChange={v => update(field.key, v)}
            channel={field.channelFromKey ? config[field.channelFromKey] : field.channel}
            placeholder={field.placeholder}
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
              <div className="wf-card wf-card--plain flex items-center gap-2 px-3 py-3 text-xs wf-muted">
                <Spinner size={4} />
                Đang tải danh sách trợ lý…
              </div>
            );
          }

          if (enabledList.length === 0) {
            return (
              <div className="wf-callout" data-tone="warn">
                <AlertIcon className="w-3.5 h-3.5" />
                <div className="min-w-0">
                  <div className="wf-callout__title">Chưa có trợ lý AI nào</div>
                  <div className="mt-0.5">Vào <b>Tích hợp → Trợ lý AI</b> để tạo trợ lý trước, sau đó quay lại đây chọn.</div>
                </div>
              </div>
            );
          }

          return (
            <div className="space-y-1.5">
              {enabledList.map(a => {
                const isActive = selected === a.id;
                const PlatformIcon = a.platform === 'openai' ? BotIcon : a.platform === 'gemini' ? DiamondIcon : a.platform === 'deepseek' ? HelpCircleIcon : a.platform === 'grok' ? LightningIcon : BotIcon;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => update(field.key, isActive ? '' : a.id)}
                    className="wf-choice"
                    data-active={String(isActive)}
                  >
                    {/* Tile inherits --wf-accent: node family colour, focus blue when active */}
                    <span className="wf-icon-tile" data-size="sm">
                      <PlatformIcon className="wf-icon-tile__glyph" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="wf-choice__title block truncate">{a.name}</span>
                      <span className="wf-choice__meta block truncate">
                        {a.platform?.toUpperCase()} • {a.model}
                      </span>
                    </span>
                    {isActive && <CheckCircleIcon className="w-[18px] h-[18px] flex-shrink-0 text-[color:var(--wf-focus)]" />}
                  </button>
                );
              })}
            </div>
          );
        })()}

        {/* ── Integration Picker ──────────────────────────────────────── */}
        {field.type === 'integration-picker' && (() => {
          const selected = config[field.key] ?? '';
          // Filter integrations by type hint (e.g., telegram_bot)
          const integrations = (window as any).__integrationList || [];
          const telegramBots = integrations.filter((i: any) => i.type === 'telegram_bot' && i.enabled);

          if (telegramBots.length === 0) {
            return (
              <div className="wf-callout" data-tone="warn">
                <AlertIcon className="w-3.5 h-3.5" />
                <div className="min-w-0">
                  <div className="wf-callout__title">Chưa có Bot Telegram nào</div>
                  <div className="mt-0.5">Vào <b>Settings → Tích hợp</b> để kết nối Bot Telegram trước, sau đó quay lại đây chọn.</div>
                </div>
              </div>
            );
          }

          return (
            <div className="space-y-1.5">
              {telegramBots.map((i: any) => {
                const isActive = selected === i.id;
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => update(field.key, isActive ? '' : i.id)}
                    className="wf-choice"
                    data-active={String(isActive)}
                  >
                    <span className="wf-icon-tile" data-size="sm">
                      <SendIcon className="wf-icon-tile__glyph" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="wf-choice__title block truncate">{i.name}</span>
                      <span className="wf-choice__meta block">Telegram Bot</span>
                    </span>
                    {isActive && <CheckCircleIcon className="w-[18px] h-[18px] flex-shrink-0 text-[color:var(--wf-focus)]" />}
                  </button>
                );
              })}
            </div>
          );
        })()}

        {field.desc && field.type !== 'info' && <p className={descCls}>{field.desc}</p>}
        {field.hint && field.type !== 'json' && (
          <div className="wf-callout mt-2" data-tone="tip">
            <LightbulbIcon className="w-3.5 h-3.5" />
            <span>{field.hint}</span>
          </div>
        )}
      </div>
    );
  };

  // ── Section card: header (icon · title · count · chevron) + fields ───────
  const renderSection = (section: { name: string; fields: Field[] }) => {
    const visible = section.fields.filter(f => !isFieldHidden(f));
    if (visible.length === 0) return null;

    const isAdvanced = section.name === ADVANCED_SECTION;
    const open = isAdvanced ? showAdvanced : !collapsedSections[section.name];
    const toggle = () => {
      if (isAdvanced) setShowAdvanced(p => !p);
      else setCollapsedSections(prev => ({ ...prev, [section.name]: !prev[section.name] }));
    };
    const Icon = SECTION_ICONS[section.name] || SlidersIcon;

    // Consecutive booleans share one toggle list.
    const blocks: React.ReactNode[] = [];
    let toggles: Field[] = [];
    const flushToggles = () => {
      if (toggles.length === 0) return;
      blocks.push(<div key={`toggles:${toggles[0].key}`} className="wf-toggle-list">{toggles.map(f => renderField(f))}</div>);
      toggles = [];
    };
    for (const field of visible) {
      if (field.type === 'boolean') { toggles.push(field); continue; }
      flushToggles();
      blocks.push(renderField(field));
    }
    flushToggles();

    return (
      <section key={section.name} className="wf-section">
        <button type="button" onClick={toggle} aria-expanded={open} className="wf-section__head"
          title={open ? 'Thu gọn mục này' : 'Mở mục này'}>
          <span className="wf-section__icon"><Icon className="w-3.5 h-3.5" /></span>
          <span className="wf-section__title">{section.name}</span>
          <span className="wf-section__meta">{visible.length} mục</span>
          <ChevronDownIcon className={`w-4 h-4 flex-shrink-0 wf-faint transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
        {open && <div className="wf-section__body">{blocks}</div>}
      </section>
    );
  };

  // ── Shared inner content ─────────────────────────────────────────────────
  const formContent = (
    <>
      {allFields.length === 0 && node.type !== 'tgbot.action.sendMessage' && (
        <div className="wf-empty">
          <span className="wf-icon-tile" style={accentStyle('#16a34a')}>
            <CheckCircleIcon className="wf-icon-tile__glyph" />
          </span>
          <p className="mt-1 text-[13px] font-semibold wf-text">Node này không cần cấu hình thêm</p>
          <p className="text-xs wf-muted">Chỉ cần kết nối với các node khác là đủ.</p>
        </div>
      )}

      {node.type === 'tgbot.action.sendMessage' && (
        <TelegramBotMessageEditor
          config={config}
          updateConfig={next => { setConfig(next); onConfigChange(next); }}
          accounts={accounts}
          nodes={nodes || []}
          currentNodeId={node.id}
          onInlineRoutesChange={onInlineRoutesChange}
        />
      )}

      {fieldSections.map(renderSection)}
    </>
  );

  const footer = (
    <div className="wf-panel__footer px-5 py-3 flex-shrink-0">
      <div className="space-y-2.5">
        {/* ── Template variables toolbar ── */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 min-w-0 text-xs font-semibold wf-text-2">
            <span className="inline-flex items-center justify-center w-5 h-5 flex-shrink-0 rounded-md bg-[var(--wf-var-bg)] text-[color:var(--wf-var-fg)]">
              <BracesGlyph />
            </span>
            <span className="truncate">Biến động</span>
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => setShowNodePicker(true)}
              className="wf-btn wf-btn--sm"
              title="Copy {{ $node.<id>.output }} của một node"
            >
              <PlusIcon className="w-3 h-3" /> Output node
            </button>
            <button
              type="button"
              onClick={() => { setTemplatePopupField(''); setShowTemplatePopup(true); }}
              className="wf-btn wf-btn--sm wf-btn--primary"
            >
              <BracesGlyph /> Chèn biến
            </button>
          </div>
        </div>
        <p className="text-[11px] leading-4 wf-muted">
          Dùng <code className="wf-var">{'{{ }}'}</code> để chèn dữ liệu động: trigger, ngày giờ, output node khác.
        </p>

        {/* ── Node references ── */}
        {upstreamNodes.length > 0 && (
          <div className="wf-card">
            <button
              type="button"
              onClick={() => setIsUpstreamNodesCollapsed(collapsed => !collapsed)}
              aria-expanded={!isUpstreamNodesCollapsed}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
              title={isUpstreamNodesCollapsed ? 'Mở dữ liệu từ node phía trước' : 'Thu gọn dữ liệu từ node phía trước'}
            >
              <span className="flex items-center gap-1.5 min-w-0 text-xs font-semibold wf-text-2">
                <span className="truncate">Dữ liệu từ node phía trước</span>
                <span className="font-medium wf-faint">({upstreamNodes.length})</span>
              </span>
              <ChevronDownIcon className={`w-4 h-4 flex-shrink-0 wf-faint transition-transform ${isUpstreamNodesCollapsed ? '' : 'rotate-180'}`} />
            </button>
            {!isUpstreamNodesCollapsed && (
              <div className="px-1.5 pb-2 border-t border-[color:var(--wf-card-border)]">
                <div className="flex flex-col gap-0.5 pt-1.5 max-h-52 overflow-y-auto">
                  {upstreamNodes.map(n => {
                    const copied = copiedNodeId === n.id;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(`{{ $node.${n.id}.output }}`).catch(()=>{});
                          setCopiedNodeId(n.id);
                          setTimeout(() => setCopiedNodeId(null), 1000);
                        }}
                        title={`Copy {{ $node.${n.id}.output }}`}
                        className="group w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-lg text-left transition-colors hover:bg-[var(--wf-hover)]"
                      >
                        <NodeIconTile type={n.type} size="sm" showChannel={false} />
                        <span className="flex-1 min-w-0 truncate text-xs font-medium wf-text">{n.label}</span>
                        {copied
                          ? <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 text-[#16a34a]" />
                          : <CopyIcon className="w-3.5 h-3.5 flex-shrink-0 wf-faint group-hover:text-[color:var(--wf-text)]" />}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 px-1.5 text-[10.5px] wf-faint">Bấm để copy <code className="wf-var">{'{{ $node.<UUID>.output }}'}</code></p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Node Picker Modal */}
      {showNodePicker && (
        <NodePickerModal
          open={showNodePicker}
          onClose={() => setShowNodePicker(false)}
          allNodes={allNodeList}
          currentId={node?.id}
          onInsertOutput={(nodeId) => {
            const text = `{{ $node.${nodeId}.output }}`;
            navigator.clipboard.writeText(text).catch(() => {});
            // Focus current active field - user can paste
          }}
        />
      )}

      {/* Template Variable Popup */}
      <TemplateVarPopup
        open={showTemplatePopup}
        onClose={() => setShowTemplatePopup(false)}
        triggerTypes={triggerTypes}
        upstreamNodes={upstreamVarNodes}
        suggestedKeys={allFields.find(f => f.key === templatePopupField)?.templateVars}
        fieldLabel={templatePopupField ? allFields.find(f => f.key === templatePopupField)?.label : undefined}
        onSelect={(varKey) => {
          const tag = `{{ ${varKey} }}`;
          if (templatePopupField) {
            // Insert into specific field
            appendVar(templatePopupField, tag);
          } else {
            // No specific field - just copy to clipboard
            navigator.clipboard.writeText(tag).catch(() => {});
          }
        }}
      />
    </div>
  );

  const headerBtns = (
    <div className="flex items-center gap-0.5 flex-shrink-0 -mr-1.5">
      {/* Fullscreen toggle */}
      <button type="button" onClick={() => setIsFullscreen(f => !f)} title={isFullscreen ? 'Thu nhỏ (Esc)' : 'Mở rộng toàn màn hình'}
        className="wf-icon-btn">
        {isFullscreen ? <MinimizeIcon className="w-4 h-4" /> : <MaximizeIcon className="w-4 h-4" />}
      </button>
      {/* Close */}
      <button type="button" onClick={onClose} title="Đóng" className="wf-icon-btn">
        <CloseIcon className="w-4 h-4" />
      </button>
    </div>
  );

  // ── Header: node identity + inline-editable display name ────────────────
  const isRenamed = !!label.trim() && label !== defaultLabel;
  const header = (
    <div className="wf-panel__header px-5 pt-4 pb-3 flex-shrink-0" style={accentStyle(visual.accent)}>
      <div className="flex items-center gap-3">
        <NodeIconTile type={node.type} size="lg" />
        <div className="flex-1 min-w-0">
          {/* Eyebrow: family · channel (10px uppercase, node accent colour) */}
          <div className="wf-node__eyebrow">
            <span className="flex-shrink-0">{visual.familyLabel}</span>
            {visual.channel && (
              <>
                <span className="flex-shrink-0" aria-hidden="true">·</span>
                <span className="min-w-0 truncate">{CHANNEL_NAME[visual.channel]}</span>
              </>
            )}
          </div>
          {/* Tên hiển thị (was a form field): same state + handler, now edited in place */}
          <input
            value={label}
            onChange={e => { setLabel(e.target.value); onLabelChange(e.target.value); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder={defaultLabel}
            title="Nhấn để đổi tên hiển thị trên sơ đồ"
            aria-label="Tên hiển thị trên sơ đồ"
            spellCheck={false}
            className="wf-title-input"
          />
        </div>
        {headerBtns}
      </div>
      {nodeDescription && <p className="wf-panel__desc mt-2.5">{nodeDescription}</p>}
      {isRenamed && <p className="mt-1 text-[11px] wf-muted">Loại: {defaultLabel}</p>}
    </div>
  );

  // ── Fullscreen modal ─────────────────────────────────────────────────────
  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) setIsFullscreen(false); }}>
        <div className="wf-panel border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          style={{ width: 'min(53.75rem, 92vw)', height: 'min(90vh, 56.25rem)', ...accentStyle(visual.accent) }}>
          {header}
          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="max-w-2xl w-full mx-auto space-y-4">
              {formContent}
            </div>
          </div>
          {footer}
        </div>
      </div>
    );
  }

  // ── Normal sidebar panel (resizable) ────────────────────────────────────
  return (
    <div className="wf-panel relative border-l flex flex-col h-full overflow-hidden flex-shrink-0"
      style={{ width: panelWidth, ...accentStyle(visual.accent) }}>

      {/* ← Drag-resize handle on left edge: invisible 6px hit area, 2px line on hover */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="group absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-10"
        title="Kéo để thay đổi chiều rộng">
        <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--wf-focus)] opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {header}

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {formContent}
      </div>

      {footer}
    </div>
  );
}
