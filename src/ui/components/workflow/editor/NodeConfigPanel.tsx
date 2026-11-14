import React, { useEffect, useRef, useState } from 'react';
import ipc, {buildZaloAuth} from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { AI_MODEL_OPTIONS } from '../../../../shared/ai/aiModelCatalog';
import PublicAddressCard from '@/components/common/cloud/PublicAddressCard';

// ─── Webhook URL field component ─────────────────────────────────────
// The webhook address is view-only (all the ways to create an address, PublicAddressCard): turn it on / off / change it in
// Settings → Internet & Cloud → Internet address. Only the token and creating a new token are here.
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
            title={tr('Địa chỉ webhook')}
            pathSuffix={`/api/workflow/webhook/${webhookToken}`}
            anyMode
            compact
          />
          <div className="flex items-center gap-2 text-xs wf-muted">
            <span className="min-w-0 truncate">{trx('Token: <0>{{v1}}...</0>', { 0: <code className="wf-var" />, v1: webhookToken.substring(0, 8) })}</span>
            <button type="button" onClick={() => {
              // Webhook setup guide: Tools → Apps, API & Webhook → Webhook → Receive incoming data.
              const app = useAppStore.getState();
              app.setPluginHubSection('webhooks');
              app.openPluginHub();
            }} className="wf-btn wf-btn--sm wf-btn--ghost ml-auto flex-shrink-0">{trx('<0/> Hướng dẫn', { 0: <BookIcon className="w-3.5 h-3.5" /> })}
            </button>
            <button type="button" onClick={async () => {
              const confirmed = await showConfirm({
                title: tr('Tạo token mới?'),
                message: tr('Token mới sẽ làm URL webhook cũ không còn hoạt động. Các bên thứ 3 đang dùng URL cũ sẽ cần được cập nhật.'),
                confirmText: tr('Tạo mới'),
                variant: 'warning',
              });
              if (!confirmed) return;
              const res = await ipc.workflow?.regenerateWebhookToken?.(workflowId);
              if (res?.success) {
                setWebhookToken(res.token || '');
                update('webhookToken', res.token || '');
              }
            }} className="wf-btn wf-btn--sm wf-btn--ghost flex-shrink-0" title={tr('Tạo token mới nếu URL bị lộ')}>{trx('<0/> Regenerate', { 0: <RefreshIcon className="w-3.5 h-3.5" /> })}
            </button>
          </div>
        </div>
      ) : (
        <div className="wf-callout" data-tone="warn"><SunIcon className="w-3.5 h-3.5" /><span>{tr('Lưu workflow để tạo URL webhook tự động.')}</span>
        </div>
      )}
      <p className="wf-help">{field.desc}</p>
    </div>
  );
}
import { showConfirm } from '@/components/common/ConfirmDialog';

import { getNodeLabel } from '../nodes/workflowConfig';
import { CHANNEL_NAME, NodeIconTile, accentStyle, getNodeDescription, getNodeVisual } from '../nodes/nodeVisuals';
import TemplateVarPopup from './TemplateVarPopup';
import { ContactPickerField } from './ContactPicker';
import { ThreadScopeField } from './ThreadScopeField';
import { isTriggerType, isVarAvailable, upstreamNodeIds, VarNode } from './templateVars';
import { pluginFieldsFor } from '../nodes/pluginNodes';
import { AlertIcon, ArrowDownIcon, BellIcon, BellOffIcon, BookIcon, BotIcon, CalendarIcon, ChatIcon, CheckCircleIcon, CheckIcon, ChevronDownIcon, ClipboardIcon, ClipboardListIcon, ClockIcon, CloseIcon, CopyIcon, DatabaseIcon, DiamondIcon, EditIcon, EyeIcon, FilterIcon, FlagIcon, GlobeIcon, HardDriveIcon, HelpCircleIcon, ImageIcon, InboxIcon, InfoIcon, LightbulbIcon, LightningIcon, LinkIcon, MaximizeIcon, MessageSquareIcon, MinimizeIcon, PaletteIcon, PaperclipIcon, PlusIcon, RefreshIcon, SearchIcon, SendIcon, SettingsIcon, ShieldIcon, ShuffleIcon, SlidersIcon, StarIcon, SunIcon, TagIcon, TargetIcon, TrashIcon, UserIcon, UsersIcon } from '@/components/common/icons';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * UI-only types added with the settings panel v2:
 * - 'chips'       multi-select pills, value string[] (missing → [] = "all")
 * - 'choice'      single-select pills/segmented control, same value semantics as 'select'
 * - 'time-window' active-hours editor, value { mode, start, end, days } (see TimeWindowField)
 * - 'thread-scope' chats of a message trigger: Tất cả / only / except, writes includeThreadIds + excludeThreadIds
 *                 (see ThreadScopeField; `contactType` / `channel` as for 'contact-picker')
 */
type FieldType = 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'json' | 'multiline' | 'cron' | 'html' | 'info' | 'label-picker' | 'assistant-picker' | 'integration-picker' | 'contact-picker' | 'account-picker' | 'file-picker' | 'case-list' | 'chips' | 'choice' | 'time-window' | 'thread-scope';

interface SelectOption { value: string; label: string }

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: SelectOption[];
  placeholder?: string;
  isWebhookUrl?: boolean;
  hint?: string;
  /** Clear description for beginners - shown below the input */
  desc?: string;
  /** Puts the field in the "Nâng cao" (Advanced) group (always last, open by default). Ignored when `section` is set. */
  advanced?: boolean;
  /**
   * Name of the group (section card) that holds the field in the settings table, e.g. 'Phạm vi', 'Người gửi', 'Nội dung'.
   * Sections appear in the order their first field shows up in the schema. Not set →
   * 'Cấu hình' (or 'Nâng cao' if `advanced`). The section icon is picked by name (SECTION_ICONS).
   */
  section?: string;
  /**
   * Suggested variable (variable name, e.g. '$trigger.fromName').
   * If this field is set, the UI shows a "Chèn biến động" (insert dynamic variable) button that opens the full
   * list of variables from templateVars.ts.
   * See templateVars.ts for all available variables.
   */
  templateVars?: string[];
  /** Key of the boolean field that turns on the HTML editor (e.g. 'isHtml') */
  htmlToggle?: string;
  /**
   * Used when type === 'assistant-picker': if set, adds a first "không chọn" (none) option with this label (value '').
   * App nodes use it for "để trống = ứng dụng tự quyết định" (empty = the app decides); built-in nodes leave it unset (they keep auto-picking the first assistant).
   */
  emptyLabel?: string;
  /**
   * Used when type === 'label-picker':
   * - 'single'  = pick 1 label (Zalo allows 1 label per conversation)
   * - 'multi'   = pick several labels (Local)
   * - 'dynamic' = automatic: single when labelSource='zalo', multi when 'local'
   */
  labelMode?: 'single' | 'multi' | 'dynamic';
  /**
   * Used when type === 'contact-picker':
   * - 'user'  = show personal contacts only
   * - 'group' = show groups only
   * - 'all'   = show both contacts and groups
   */
  contactType?: 'user' | 'group' | 'all';
  /**
   * Used when type === 'contact-picker':
   * - 'single' = pick 1 (string value, default)
   * - 'multi'  = pick several (JSON string array value)
   */
  contactMode?: 'single' | 'multi';
  /**
   * Used when type === 'contact-picker':
   * Filters accounts by channel (e.g. 'telegram_user' → shows only Telegram accounts)
   */
  channel?: string;
  /** Read channel/account from another config field for cross-channel actions. */
  channelFromKey?: string;
  accountIdFromKey?: string;
  /**
   * Used when type === 'file-picker':
   * - 'image' = pick images only
   * - 'file'  = pick any file type
   */
  fileType?: 'image' | 'file';
  /** Hides the field when config[hideWhenKey] === hideWhenValue */
  hideWhenKey?: string;
  hideWhenValue?: string;
  /** When this field changes, remove these child keys from config (e.g. platform → model) */
  clearsKeyOnChange?: string[];
  /** Filters options by another field's value: key = the field to check, map = value → options to show */
  optionsFilter?: { key: string; map: Record<string, string[]> };
  /** Minimum value for the number input */
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
  { label: tr('8h sáng mỗi ngày'),  value: '0 8 * * *'    },
  { label: tr('Mỗi giờ'),           value: '0 * * * *'    },
  { label: tr('Mỗi 30 phút'),       value: '*/30 * * * *' },
  { label: tr('Mỗi thứ Hai 8h'),    value: '0 8 * * 1'    },
  { label: tr('Đầu tháng 8h'),      value: '0 8 1 * *'    },
  { label: tr('Mỗi đêm 0h'),        value: '0 0 * * *'    },
];

function cronToHuman(expr: string): string {
  const map: Record<string, string> = {
    '0 8 * * *':    tr('Mỗi ngày lúc 8:00 sáng'),
    '0 * * * *':    tr('Mỗi giờ một lần'),
    '*/30 * * * *': tr('Mỗi 30 phút'),
    '0 8 * * 1':    tr('Mỗi thứ Hai lúc 8:00'),
    '0 8 1 * *':    tr('Ngày đầu tháng lúc 8:00'),
    '0 0 * * *':    tr('Mỗi đêm lúc 0:00'),
  };
  return map[expr.trim()] || '';
}

// ─── Schema ───────────────────────────────────────────────────────────────────

// Phone / order code fields of the POS lookup nodes. An empty condition → the engine does not look up and returns found = false
// (services/workflow/posLookupGuard.ts) because some platforms return unfiltered lists.
const POS_PHONE_HINT = tr('Mặc định {{ $trigger.fromPhone }} = SĐT đã lưu của người nhắn (Zalo / Telegram, lưu ở Thông tin hội thoại hoặc CRM); khách tự gửi số thì chèn Nội dung tin nhắn.');
const POS_CUSTOMER_EMPTY_NOTE = tr('Ô trống → không tra cứu (found = false) để không trả về khách hàng khác.');
const POS_ORDER_EMPTY_NOTE = tr('SĐT và mã đơn đều trống → không tra cứu (found = false) để không trả về đơn của khách khác.');

export const CONFIG_SCHEMA: Record<string, Field[]> = {
  'action.forwardCrossChannel': [
    { key: 'sourceChannel', label: tr('Kênh tài khoản nguồn'), type: 'select', options: [
      { value: '', label: tr('Tự lấy từ trigger workflow') },
      { value: 'zalo', label: 'Zalo' }, { value: 'facebook', label: 'Facebook' }, { value: 'telegram_user', label: tr('Telegram User') }, { value: 'telegram_bot', label: 'Telegram Bot' },
    ], clearsKeyOnChange: ['sourceAccountId'] },
    { key: 'sourceAccountId', label: tr('Tài khoản nguồn'), type: 'account-picker', channelFromKey: 'sourceChannel', placeholder: tr('Để trống = tài khoản kích hoạt workflow') },
    { key: 'sourceChatId', label: tr('Chat nguồn'), type: 'text', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('Tin nhắn cần chuyển tiếp'), type: 'text', placeholder: '{{ $trigger.messageId }}', desc: tr('Dùng ID từ trigger để chuyển tiếp đúng tin vừa nhận.'), templateVars: ['$trigger.messageId'] },
    { key: 'targetChannel', label: tr('Kênh đích'), type: 'select', options: [
      { value: 'zalo', label: 'Zalo' }, { value: 'facebook', label: 'Facebook' }, { value: 'telegram_user', label: tr('Telegram User') }, { value: 'telegram_bot', label: 'Telegram Bot' },
    ], clearsKeyOnChange: ['targetAccountId', 'targetChatId'] },
    { key: 'targetAccountId', label: tr('Tài khoản gửi ở kênh đích'), type: 'account-picker', channelFromKey: 'targetChannel', placeholder: tr('Chọn tài khoản đích') },
    { key: 'targetChatId', label: tr('Chat nhận'), type: 'contact-picker', contactType: 'all', channelFromKey: 'targetChannel', accountIdFromKey: 'targetAccountId', placeholder: tr('Chọn chat thuộc tài khoản đích') },
    { key: 'targetThreadType', label: tr('Loại chat đích'), type: 'select', options: [{ value: '0', label: tr('Cá nhân / chat thường') }, { value: '1', label: tr('Nhóm (Zalo)') }], desc: tr('Chỉ dùng cho Zalo; Telegram và Facebook tự nhận diện chat.'), advanced: true },
    { key: 'companionText', label: tr('Tin nhắn gửi kèm'), type: 'textarea', placeholder: tr('Không bắt buộc — được gửi thành tin riêng sau tin gốc'), desc: tr('Giữ nguyên tin gốc; nội dung này luôn được gửi thành tin nhắn riêng.'), advanced: true, templateVars: ['$trigger.content'] },
    { key: 'info', label: tr('Quy tắc chuyển tiếp'), type: 'info', desc: tr('Text, ảnh, video và file đã tải về được gửi lại giữa mọi kênh. Nếu media chưa có file local thì chỉ có thể native-forward trong cùng tài khoản và cùng kênh.') },
  ],
  'trigger.message': [
    {
      key: 'threadType', label: tr('Nguồn tin nhắn'), type: 'choice', section: tr('Phạm vi'),
      desc: tr('Workflow sẽ lắng nghe tin nhắn từ đâu?'),
      options: [
        { value: 'all', label: tr('Tất cả (cá nhân + nhóm)') },
        { value: '0',   label: tr('Chỉ tin nhắn cá nhân') },
        { value: '1',   label: tr('Chỉ tin nhắn nhóm') },
      ],
    },
    {
      key: 'groupId', label: tr('Chỉ nhận từ nhóm cụ thể'), type: 'contact-picker', contactType: 'group', section: tr('Phạm vi'),
      placeholder: tr('Để trống = tất cả các nhóm'),
      desc: tr('Chọn một nhóm cụ thể. Để trống = nhận từ tất cả nhóm.'),
      advanced: true,
    },
    {
      // includeThreadIds + excludeThreadIds (ThreadScopeField)
      key: 'includeThreadIds', label: tr('Chat / nhóm áp dụng'), type: 'thread-scope', section: tr('Phạm vi'),
      contactType: 'all',
    },
    {
      key: 'senderRole', label: tr('Vai trò người gửi trong nhóm'), type: 'choice', section: tr('Người gửi'),
      desc: tr('Chỉ áp dụng cho tin nhắn nhóm (vai trò lấy từ thông tin nhóm Zalo). Khi chọn khác "Tất cả", tin nhắn cá nhân sẽ không kích hoạt workflow.'),
      options: [
        { value: 'all',     label: tr('Tất cả') },
        { value: 'owner',   label: tr('Trưởng nhóm') },
        { value: 'deputy',  label: tr('Phó nhóm') },
        { value: 'admins',  label: tr('Trưởng + phó nhóm') },
        { value: 'members', label: tr('Thành viên thường') },
      ],
    },
    {
      key: 'fromId', label: tr('Chỉ nhận từ người dùng cụ thể'), type: 'contact-picker', contactType: 'user', section: tr('Người gửi'),
      placeholder: tr('Để trống = tất cả mọi người'),
      desc: tr('Chọn một người cụ thể. Để trống = nhận từ tất cả.'),
      advanced: true,
    },
    {
      key: 'excludeSenderIds', label: tr('Loại trừ người gửi'), type: 'contact-picker', section: tr('Người gửi'),
      contactType: 'user', contactMode: 'multi',
      placeholder: tr('Để trống = không loại trừ ai'),
      desc: tr('Tin nhắn từ những người được chọn sẽ không kích hoạt workflow.'),
    },
    {
      key: 'ignoreOwn', label: tr('Bỏ qua tin nhắn do mình gửi'), type: 'boolean', section: tr('Người gửi'),
      desc: tr('Bật để tránh workflow tự kích hoạt khi tài khoản này tự gửi tin.'),
    },
    {
      key: 'onlyOwn', label: tr('Chỉ xử lý tin mình tự gửi'), type: 'boolean', section: tr('Người gửi'),
      desc: tr('Ngược lại - chỉ chạy với tin nhắn từ chính tài khoản này.'),
    },
    {
      key: 'keyword', label: tr('Từ khóa kích hoạt'), type: 'text', section: tr('Nội dung'),
      placeholder: tr('giá, báo giá, order'),
      desc: tr('Workflow chỉ chạy khi tin nhắn chứa một trong các từ khóa này. Nhập nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = mọi tin nhắn đều kích hoạt.'),
    },
    {
      key: 'keywordMode', label: tr('Cách khớp từ khóa'), type: 'select', section: tr('Nội dung'),
      desc: tr('Quy tắc áp dụng khi kiểm tra từ khóa trong tin nhắn.'),
      options: [
        { value: 'contains_any', label: tr('Chứa ít nhất 1 từ khóa (phổ biến nhất)') },
        { value: 'contains_all', label: tr('Phải chứa đủ tất cả từ khóa') },
        { value: 'equals',       label: tr('Khớp chính xác nguyên câu') },
        { value: 'starts_with',  label: tr('Bắt đầu bằng từ khóa') },
        { value: 'regex',        label: tr('Regex - biểu thức chính quy (nâng cao)') },
      ],
    },
    {
      key: 'messageTypes', label: tr('Loại tin nhắn'), type: 'chips', section: tr('Nội dung'),
      desc: tr('Chỉ kích hoạt với các loại tin được chọn, vd. chỉ chọn "Văn bản" để bỏ qua sticker và hình ảnh.'),
      options: [
        { value: 'text',    label: tr('Văn bản') },
        { value: 'image',   label: tr('Hình ảnh') },
        { value: 'sticker', label: tr('Sticker') },
        { value: 'file',    label: tr('Tệp') },
        { value: 'voice',   label: tr('Ghi âm') },
        { value: 'video',   label: tr('Video') },
        { value: 'link',    label: tr('Liên kết') },
        { value: 'other',   label: tr('Khác') },
      ],
    },
    {
      key: 'onlyWhenMentioned', label: tr('Chỉ khi được @nhắc tên trong nhóm'), type: 'boolean', section: tr('Nội dung'),
      desc: tr('Tin nhắn nhóm chỉ kích hoạt khi @nhắc đến tài khoản này hoặc @Tất cả. Tin nhắn cá nhân không bị ảnh hưởng.'),
    },
    {
      key: 'activeHours', label: tr('Khung giờ hoạt động'), type: 'time-window', section: tr('Thời gian & tần suất'),
      desc: tr('Trong khung giờ: chỉ chạy trong giờ đã chọn. Ngoài khung giờ: chỉ chạy ngoài giờ đó, vd. tự động trả lời ngoài giờ làm việc.'),
    },
    {
      key: 'cooldownMinutes', label: tr('Giới hạn tần suất (phút)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0', min: 0,
      desc: tr('Sau khi workflow chạy cho một hội thoại, các tin nhắn tiếp theo từ hội thoại đó bị bỏ qua trong N phút (vd. 60 = tối đa 1 lần mỗi giờ). 0 = tắt. Bộ đếm được đặt lại khi khởi động lại ứng dụng.'),
    },
    {
      key: 'debounceSeconds', label: tr('Gom tin nhắn liên tiếp (giây)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0',
      desc: tr('Chờ N giây sau tin nhắn cuối cùng rồi mới chạy workflow (gom tất cả tin nhắn liên tiếp thành 1 lần xử lý). 0 = chạy ngay mỗi tin. Khuyến nghị 10-15s khi dùng AI trả lời tự động, tránh AI phản hồi từng tin khi khách gõ liên tục.'),
      advanced: true,
    },
  ],
  'trigger.friendRequest': [],
  'trigger.groupEvent': [
    {
      key: 'eventType', label: tr('Sự kiện cần theo dõi'), type: 'select',
      desc: tr('Chọn loại sự kiện trong nhóm sẽ kích hoạt workflow.'),
      options: [
        { value: 'all',           label: tr('Mọi sự kiện nhóm') },
        { value: 'join',          label: tr('Thành viên mới tham gia') },
        { value: 'leave',         label: tr('Thành viên tự rời nhóm') },
        { value: 'remove_member', label: tr('Thành viên bị xóa khỏi nhóm') },
        { value: 'update',        label: tr('Thông tin nhóm thay đổi') },
        { value: 'add_admin',     label: tr('Thêm quản trị viên mới') },
        { value: 'remove_admin',  label: tr('Xóa quyền quản trị viên') },
      ],
    },
    {
      key: 'groupId', label: tr('Chỉ theo dõi nhóm cụ thể'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('Để trống = theo dõi tất cả nhóm'),
      desc: tr('Chọn một nhóm để chỉ lắng nghe sự kiện từ nhóm đó.'),
      advanced: true,
    },
  ],
  'trigger.reaction': [
    {
      key: 'reactionType', label: tr('Loại cảm xúc'), type: 'select',
      desc: tr('Workflow chạy khi tin nhắn nhận được cảm xúc nào?'),
      options: [
        { value: 'any', label: tr('Bất kỳ cảm xúc nào') },
        { value: '1',   label: tr('Like') },
        { value: '2',   label: tr('Yêu thích') },
        { value: '3',   label: tr('Haha') },
        { value: '4',   label: tr('Wow') },
        { value: '5',   label: tr('Buồn') },
        { value: '6',   label: tr('Giận') },
      ],
    },
    {
      key: 'threadId', label: tr('Chỉ theo dõi hội thoại cụ thể'), type: 'text',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('Nhập Thread ID nếu chỉ muốn theo dõi cảm xúc trong một hội thoại nhất định.'),
      advanced: true,
    },
  ],
  'trigger.labelAssigned': [
    {
      key: 'action', label: tr('Khi nào kích hoạt?'), type: 'select',
      desc: tr('Chọn thời điểm workflow chạy.'),
      options: [
        { value: 'any',      label: tr('Cả khi gán và khi gỡ nhãn') },
        { value: 'assigned', label: tr('Chỉ khi nhãn được gán vào') },
        { value: 'removed',  label: tr('Chỉ khi nhãn bị gỡ ra') },
      ],
    },
    {
      key: 'labelSource', label: tr('Nguồn nhãn'), type: 'select',
      desc: tr('Lọc theo loại Nhãn Local hay nhãn Zalo.'),
      options: [
        { value: 'any',   label: tr('Cả Local và Zalo') },
        { value: 'local', label: tr('Chỉ Nhãn Local') },
        { value: 'zalo',  label: tr('Chỉ nhãn Zalo') },
      ],
    },
    {
      key: 'labelIds', label: tr('Nhãn cần lọc'), type: 'label-picker', labelMode: 'multi',
      desc: tr('Để trống = kích hoạt với mọi nhãn. Có thể chọn nhiều nhãn - workflow chạy khi bất kỳ nhãn nào được gán/gỡ.'),
    },
  ],
  'trigger.telegramCommand': [
    {
      key: 'integrationId', label: tr('Chọn Bot Telegram'), type: 'integration-picker',
      desc: tr('Chọn Bot Telegram đã kết nối trong Settings → Tích hợp.'),
    },
    {
      key: 'command', label: tr('Lệnh kích hoạt'), type: 'text',
      placeholder: tr('/baocao'),
      desc: tr('Lệnh mà người dùng gửi cho Bot để kích hoạt workflow. Bắt đầu bằng dấu /. Để trống = mọi tin nhắn đều kích hoạt.'),
    },
    {
      key: 'chatIdFilter', label: tr('Chỉ nhận từ Chat ID cụ thể'), type: 'text',
      placeholder: tr('Để trống = nhận từ tất cả'),
      desc: tr('Nhập Chat ID nếu chỉ muốn nhận lệnh từ một người hoặc nhóm cụ thể.'),
      advanced: true,
    },
  ],
  'trigger.schedule': [
    {
      key: 'cronExpression', label: tr('Lịch chạy tự động'), type: 'cron',
      placeholder: '0 8 * * *',
      desc: tr('Đặt lịch để workflow tự động chạy theo thời gian. Chọn mẫu có sẵn hoặc nhập tùy chỉnh.'),
    },
    {
      key: 'timezone', label: tr('Múi giờ'), type: 'select',
      desc: tr('Múi giờ dùng để tính thời gian chạy.'),
      options: [
        { value: 'Asia/Ho_Chi_Minh', label: tr('Việt Nam (UTC+7)') },
        { value: 'Asia/Bangkok',     label: tr('Bangkok (UTC+7)') },
        { value: 'Asia/Singapore',   label: tr('Singapore (UTC+8)') },
        { value: 'UTC',              label: tr('UTC (chuẩn quốc tế)') },
      ],
      advanced: true,
    },
  ],
  'zalo.sendMessage': [
    {
      key: 'message', label: tr('Nội dung tin nhắn'), type: 'textarea', section: tr('Nội dung'),
      placeholder: tr('Xin chào {{ $trigger.fromName }}! Mình có thể giúp gì?'),
      desc: tr('Nội dung tin nhắn gửi đi. Dùng {{ }} để chèn dữ liệu động như tên người dùng.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', section: tr('Người nhận'),
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại để gửi. Nếu không chọn, sẽ dùng hội thoại từ trigger. Bình thường dùng $trigger.threadId; với trigger Webhook dùng $trigger.body.threadId.'),
      templateVars: ['$trigger.threadId', '$trigger.body.threadId'],
    },
    {
      key: 'threadIdsExpr', label: tr('Danh sách hội thoại động (nâng cao)'), type: 'text', section: tr('Người nhận'),
      placeholder: tr('{{ $node.Chọn đối tượng nhận tin.result }}'),
      desc: tr('Nhập danh sách ID hội thoại dạng JSON, hoặc tham chiếu node "Chọn đối tượng nhận tin" để gửi hàng loạt. Ưu tiên hơn trường chọn hội thoại ở trên.'),
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select', section: tr('Người nhận'),
      desc: tr('Loại hội thoại đang gửi. Giữ "Tự động" để hệ thống tự nhận biết.'),
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger - khuyến nghị)') },
        { value: '0', label: tr('Cá nhân') },
        { value: '1', label: tr('Nhóm') },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: tr('Giãn cách gửi tối thiểu (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '1',
      desc: tr('Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin trả lời gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. Tránh bắn hàng loạt bị Zalo nghi spam. 0 = gửi ngay. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).'),
      advanced: true,
    },
    {
      key: 'sendDelayMaxSeconds', label: tr('Giãn cách gửi tối đa (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '3',
      desc: tr('Khoảng giãn cách tối đa. Hệ thống chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.'),
      advanced: true,
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi tin nhắn này gửi lỗi.'),
      advanced: true,
    },
  ],
  'zalo.sendTyping': [
    {
      key: 'threadId', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại cần gửi sự kiện "đang gõ". Giữ mặc định để tự động nhận từ trigger.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select',
      desc: tr('Cá nhân (DM) hoặc nhóm. Chọn "Tự động" để lấy từ trigger.'),
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger - khuyến nghị)') },
        { value: '0', label: tr('Cá nhân (DM)') },
        { value: '1', label: tr('Nhóm') },
      ],
    },
    {
      key: 'delaySeconds', label: tr('Chờ bao lâu trước bước tiếp'), type: 'select',
      desc: tr('Sau khi gửi "đang gõ", workflow sẽ dừng bấy nhiêu giây rồi mới chạy thẻ tiếp theo (thường là Gửi tin nhắn). Giúp tạo cảm giác tự nhiên như người thật đang soạn.'),
      options: [
        { value: '1',  label: tr('1 giây (nhanh)') },
        { value: '3',  label: tr('3 giây (mặc định)') },
        { value: '5',  label: tr('5 giây (soạn lâu hơn)') },
        { value: '10', label: tr('10 giây (rất lâu)') },
      ],
    },
  ],
  'zalo.sendImage': [
    {
      key: 'filePath', label: tr('Ảnh cần gửi'), type: 'file-picker', fileType: 'image', section: tr('Nội dung'),
      desc: tr('Chọn ảnh từ máy tính để gửi.'),
    },
    {
      key: 'message', label: tr('Chú thích ảnh (tuỳ chọn)'), type: 'text', section: tr('Nội dung'),
      placeholder: tr('Đây là bảng giá mới nhất!'),
      desc: tr('Dòng chữ hiển thị kèm ảnh. Có thể để trống.'),
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', section: tr('Người nhận'),
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại để gửi ảnh. Nếu không chọn, sẽ dùng hội thoại từ trigger.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select', section: tr('Người nhận'),
      desc: tr('Loại hội thoại đang gửi.'),
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger)') },
        { value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: tr('Giãn cách gửi tối thiểu (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '1',
      desc: tr('Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. 0 = gửi ngay. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).'),
      advanced: true,
    },
    {
      key: 'sendDelayMaxSeconds', label: tr('Giãn cách gửi tối đa (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '3',
      desc: tr('Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.'),
      advanced: true,
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi ảnh lỗi.'),
      advanced: true,
    },
  ],
  'zalo.sendFile': [
    {
      key: 'filePath', label: tr('File cần gửi'), type: 'file-picker', fileType: 'file', section: tr('Nội dung'),
      desc: tr('Chọn file từ máy tính để gửi.'),
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', section: tr('Người nhận'),
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại để gửi file. Nếu không chọn, sẽ dùng hội thoại từ trigger.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select', section: tr('Người nhận'),
      desc: tr('Loại hội thoại đang gửi.'),
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger)') },
        { value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: tr('Giãn cách gửi tối thiểu (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '1',
      desc: tr('Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. 0 = gửi ngay. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).'),
      advanced: true,
    },
    {
      key: 'sendDelayMaxSeconds', label: tr('Giãn cách gửi tối đa (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '3',
      desc: tr('Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.'),
      advanced: true,
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi file lỗi.'),
      advanced: true,
    },
  ],
  'zalo.sendVoice': [
    {
      key: 'filePath', label: tr('File âm thanh cần gửi'), type: 'file-picker', fileType: 'file', section: tr('Nội dung'),
      desc: tr('Chọn file tin thoại (m4a/mp3) từ máy tính để gửi.'),
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', section: tr('Người nhận'),
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại để gửi tin thoại. Nếu không chọn, sẽ dùng hội thoại từ trigger.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select', section: tr('Người nhận'),
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger)') },
        { value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: tr('Giãn cách gửi tối thiểu (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '1', advanced: true,
      desc: tr('Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).'),
    },
    {
      key: 'sendDelayMaxSeconds', label: tr('Giãn cách gửi tối đa (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '3', advanced: true,
      desc: tr('Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.'),
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      advanced: true,
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi tin thoại lỗi.'),
    },
  ],
  'zalo.sendVideo': [
    {
      key: 'filePath', label: tr('File video cần gửi'), type: 'file-picker', fileType: 'file', section: tr('Nội dung'),
      desc: tr('Chọn file video (mp4) từ máy tính để gửi.'),
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', section: tr('Người nhận'),
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại để gửi video. Nếu không chọn, sẽ dùng hội thoại từ trigger.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select', section: tr('Người nhận'),
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger)') },
        { value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') },
      ],
      advanced: true,
    },
    {
      key: 'sendDelayMinSeconds', label: tr('Giãn cách gửi tối thiểu (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '1', advanced: true,
      desc: tr('Khi nhiều khách nhắn cùng lúc trên CÙNG 1 tài khoản, các tin gửi lần lượt, cách nhau ít nhất bấy nhiêu giây. Gửi cho nhiều hội thoại trong một bước: giữa hai người nhận luôn chờ ngẫu nhiên, tối thiểu 5 giây (mặc định 5-10 giây; đặt cao hơn thì theo khoảng này).'),
    },
    {
      key: 'sendDelayMaxSeconds', label: tr('Giãn cách gửi tối đa (giây)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '3', advanced: true,
      desc: tr('Khoảng giãn cách tối đa. Chọn ngẫu nhiên giữa tối thiểu và tối đa cho tự nhiên.'),
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      advanced: true,
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi video lỗi.'),
    },
  ],
  'zalo.sendSticker': [
    {
      key: 'stickerId', label: tr('ID sticker cần gửi'), type: 'text',
      placeholder: tr('Nhập ID sticker Zalo (số)'),
      desc: tr('ID của sticker trong bộ sưu tập Zalo. Bạn có thể lấy ID từ thư viện sticker Zalo.'),
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại để gửi sticker. Nếu không chọn, sẽ dùng hội thoại từ trigger.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select',
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger)') },
        { value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') },
      ],
      advanced: true,
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean',
      advanced: true,
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi sticker lỗi.'),
    },
  ],
  'zalo.findUser': [
    {
      key: 'phone', label: tr('Số điện thoại cần tìm'), type: 'text',
      placeholder: tr('{{ $trigger.fromPhone }}  hoặc  0901234567'),
      desc: tr('Nhập số điện thoại để tìm tài khoản Zalo. Kết quả chứa User ID để dùng ở bước sau.'),
      templateVars: ['$trigger.fromPhone'],
    },
  ],
  'zalo.getUserInfo': [
    {
      key: 'userId', label: tr('User ID cần lấy thông tin'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.fromId }}',
      desc: tr('ID người dùng Zalo. Kết quả gồm tên, avatar, giới tính... dùng được ở các bước sau.'),
      templateVars: ['$trigger.fromId', '$trigger.userId'],
    },
  ],
  'zalo.acceptFriendRequest': [
    {
      key: 'userId', label: tr('Chấp nhận kết bạn từ'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: tr('User ID người gửi lời mời. Thường dùng {{ $trigger.userId }} khi kết hợp trigger "Lời mời kết bạn".'),
      templateVars: ['$trigger.userId'],
    },
  ],
  'zalo.rejectFriendRequest': [
    {
      key: 'userId', label: tr('Từ chối kết bạn từ'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: tr('User ID của người gửi lời mời kết bạn cần từ chối.'),
      templateVars: ['$trigger.userId'],
    },
  ],
  'zalo.sendFriendRequest': [
    {
      key: 'userId', label: tr('Gửi lời mời đến User ID'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $node.FindUser.userId }}',
      desc: tr('User ID người muốn kết bạn. Thường lấy từ bước "Tìm user theo SĐT" phía trước.'),
      templateVars: ['$node.FindUser.userId'],
    },
    {
      key: 'message', label: tr('Lời nhắn kèm theo'), type: 'text',
      placeholder: tr('Mình là X, muốn kết bạn để trao đổi thêm!'),
      desc: tr('Nội dung hiển thị kèm theo lời mời. Nên giới thiệu bản thân ngắn gọn.'),
    },
  ],
  'zalo.addToGroup': [
    {
      key: 'userId', label: tr('Thêm người dùng'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: tr('User ID của người muốn thêm vào nhóm.'),
      templateVars: ['$trigger.userId', '$trigger.fromId'],
    },
    {
      key: 'groupId', label: tr('Vào nhóm (Group ID)'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('ID nhóm Zalo'),
      desc: tr('ID nhóm Zalo đích. Xem Group ID trong phần thông tin nhóm.'),
    },
  ],
  'zalo.removeFromGroup': [
    {
      key: 'userId', label: tr('Xóa người dùng'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.userId }}',
      desc: tr('User ID của thành viên cần xóa khỏi nhóm.'),
      templateVars: ['$trigger.userId'],
    },
    {
      key: 'groupId', label: tr('Khỏi nhóm (Group ID)'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('ID nhóm Zalo'),
      desc: tr('ID của nhóm Zalo cần xóa thành viên.'),
    },
  ],
  'zalo.setMute': [
    {
      key: 'action', label: tr('Hành động'), type: 'select',
      desc: tr('Tắt hoặc bật lại thông báo cho hội thoại.'),
      options: [
        { value: 'mute',   label: tr('Tắt thông báo') },
        { value: 'unmute', label: tr('Bật lại thông báo') },
      ],
    },
    {
      key: 'duration', label: tr('Thời gian tắt (giây)'), type: 'number',
      desc: tr('Tắt thông báo trong bao lâu. Nhập 0 để tắt vĩnh viễn.'),
      hint: tr('3600 = 1 giờ  •  86400 = 1 ngày  •  0 = mãi mãi'),
    },
    {
      key: 'threadId', label: tr('ID hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại cần tắt thông báo.'), templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select',
      options: [
        { value: '{{ $trigger.threadType }}', label: tr('Tự động (theo trigger)') },
        { value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') },
      ],
      advanced: true,
    },
  ],
  'zalo.forwardMessage': [
    {
      key: 'message', label: tr('Nội dung chuyển tiếp'), type: 'textarea',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Nội dung tin nhắn sẽ gửi đi. Dùng {{ $trigger.content }} để lấy nội dung từ tin nhắn trigger.'),
      templateVars: ['$trigger.content'],
    },
    {
      key: 'msgId', label: tr('ID tin nhắn gốc (tham khảo)'), type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: tr('ID tin nhắn gốc - chỉ để tham chiếu, không dùng cho forward API.'),
      templateVars: ['$trigger.msgId'],
      advanced: true,
    },
    {
      key: 'toThreadId', label: tr('Chuyển đến hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('ID hội thoại đích'),
      desc: tr('ID hội thoại nơi tin nhắn sẽ được chuyển đến.'),
    },
    {
      key: 'toThreadType', label: tr('Loại hội thoại đích'), type: 'select',
      options: [{ value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') }],
      advanced: true,
    },
  ],
  'zalo.undoMessage': [
    {
      key: 'msgId', label: tr('Tin nhắn cần thu hồi'), type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: tr('ID tin nhắn muốn thu hồi (xóa khỏi cả hai phía cuộc trò chuyện).'),
      templateVars: ['$trigger.msgId'],
    },
    {
      key: 'threadId', label: tr('Thuộc hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại chứa tin nhắn cần thu hồi.'), templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select',
      options: [{ value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') }],
      advanced: true,
    },
  ],
  'zalo.createPoll': [
    {
      key: 'question', label: tr('Câu hỏi bình chọn'), type: 'text',
      placeholder: tr('Bạn thích sản phẩm nào nhất?'),
      desc: tr('Nội dung câu hỏi hiển thị trong poll.'),
    },
    {
      key: 'options', label: tr('Các lựa chọn'), type: 'multiline',
      placeholder: tr('Sản phẩm A\nSản phẩm B\nSản phẩm C'),
      desc: tr('Mỗi dòng là một lựa chọn. Nhập ít nhất 2 lựa chọn.'),
    },
    {
      key: 'allowMultiple', label: tr('Cho phép chọn nhiều đáp án'), type: 'boolean',
      desc: tr('Bật để thành viên có thể tick nhiều lựa chọn cùng lúc.'),
    },
    {
      key: 'groupId', label: tr('Đăng trong nhóm (Group ID)'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('ID nhóm Zalo'), desc: tr('ID nhóm nơi poll sẽ được tạo.'), advanced: true,
    },
    {
      key: 'expireTime', label: tr('Thời gian kết thúc (giây)'), type: 'number',
      desc: tr('Poll tự đóng sau bao nhiêu giây. Nhập 0 để không giới hạn.'),
      hint: tr('86400 = 1 ngày  •  604800 = 1 tuần  •  0 = không giới hạn'),
      advanced: true,
    },
  ],
  'zalo.getMessageHistory': [
    {
      key: 'count', label: tr('Số tin nhắn cần lấy'), type: 'number',
      desc: tr('Lấy bao nhiêu tin nhắn gần nhất từ hội thoại (tối đa thường là 50).'),
    },
    {
      key: 'threadId', label: tr('Lịch sử của hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại cần lấy lịch sử. Kết quả dùng được ở các bước sau.'),
      templateVars: ['$trigger.threadId'], advanced: true,
    },
  ],
  'zalo.addReaction': [
    {
      key: 'reactionType', label: tr('Loại cảm xúc'), type: 'select',
      desc: tr('Cảm xúc sẽ được thêm vào tin nhắn.'),
      options: [
        { value: 'LIKE', label: tr('👍 Like') }, { value: 'HEART', label: tr('❤️ Yêu thích') },
        { value: 'HAHA', label: tr('😆 Haha') }, { value: 'WOW', label: tr('😮 Wow') },
        { value: 'CRY', label: tr('😢 Buồn') }, { value: 'ANGRY', label: tr('😡 Giận') },
      ],
    },
    {
      key: 'msgId', label: tr('Tin nhắn cần react'), type: 'text',
      placeholder: '{{ $trigger.msgId }}',
      desc: tr('ID tin nhắn muốn thêm cảm xúc.'),
      templateVars: ['$trigger.msgId'], advanced: true,
    },
    {
      key: 'clientMsgId', label: tr('Client Message ID'), type: 'text',
      placeholder: '{{ $trigger.cliMsgId }}',
      desc: tr('Dùng ID gốc của tin nhắn. Hệ thống tự lấy khi workflow được kích hoạt từ tin nhắn Zalo.'),
      templateVars: ['$trigger.cliMsgId'], advanced: true,
    },
    {
      key: 'threadId', label: tr('Hội thoại chứa tin nhắn'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Cần để Zalo xác định tin nhắn thuộc hội thoại nào.'),
      templateVars: ['$trigger.threadId'], advanced: true,
    },
    {
      key: 'threadType', label: tr('Loại hội thoại'), type: 'select',
      options: [{ value: '0', label: tr('Cá nhân') }, { value: '1', label: tr('Nhóm') }],
      placeholder: '{{ $trigger.threadType }}', advanced: true,
    },
  ],
  'zalo.assignLabel': [
    {
      key: 'labelSource', label: tr('Loại nhãn'), type: 'select',
      desc: tr('Chọn Nhãn Local (quản lý trong CRM) hoặc nhãn Zalo (đồng bộ với ứng dụng Zalo).'),
      options: [
        { value: 'local', label: tr('Nhãn Local (quản lý trong app)') },
        { value: 'zalo',  label: tr('Nhãn Zalo (đồng bộ Zalo)') },
      ],
    },
    {
      key: 'labelIds', label: tr('Chọn nhãn cần gắn'), type: 'label-picker', labelMode: 'dynamic',
      desc: tr('Nhãn Zalo: chỉ được gắn 1 nhãn mỗi hội thoại. Nhãn Local: có thể chọn nhiều nhãn cùng lúc.'),
    },
    {
      key: 'threadId', label: tr('Gắn nhãn cho hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại cần gắn nhãn. Giữ mặc định để gắn cho hội thoại đang xử lý.'),
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'zalo.removeLabel': [
    {
      key: 'labelSource', label: tr('Loại nhãn'), type: 'select',
      desc: tr('Chọn loại nhãn cần gỡ.'),
      options: [
        { value: 'local', label: tr('Nhãn Local (quản lý trong app)') },
        { value: 'zalo',  label: tr('Nhãn Zalo (đồng bộ Zalo)') },
      ],
    },
    {
      key: 'labelIds', label: tr('Chọn nhãn cần gỡ'), type: 'label-picker', labelMode: 'dynamic',
      desc: tr('Nhãn Zalo: chỉ gỡ 1 nhãn mỗi lần. Nhãn Local: có thể gỡ nhiều nhãn cùng lúc.'),
    },
    {
      key: 'threadId', label: tr('Gỡ nhãn khỏi hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại cần gỡ nhãn.'),
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'zalo.changeAliasName': [
    {
      key: 'friendId', label: tr('Bạn bè cần đổi tên'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.fromId }}',
      desc: tr('ID người dùng Zalo muốn đổi tên gợi nhớ. Giữ mặc định để áp dụng cho người gửi tin nhắn.'),
      templateVars: ['$trigger.fromId'],
    },
    {
      key: 'alias', label: tr('Tên gợi nhớ mới'), type: 'text',
      placeholder: tr('Nhập tên gợi nhớ (hỗ trợ biến)'),
      desc: tr('Tên mới sẽ hiển thị trong danh bạ của bạn. Dùng biến để tạo tên động, ví dụ: {{ $trigger.fromName }} - KH VIP'),
      templateVars: ['$trigger.fromName', '$trigger.fromId', '$trigger.content'],
    },
  ],
  'logic.if': [
    {
      key: 'left', label: tr('Giá trị cần kiểm tra'), type: 'text', section: tr('Điều kiện'),
      placeholder: '{{ $trigger.content }}',
      desc: tr('Giá trị bên trái để so sánh. Thường là nội dung tin nhắn hoặc một biến đã lưu.'),
      templateVars: ['$trigger.content', '$trigger.fromName', '$trigger.fromId'],
    },
    {
      key: 'operator', label: tr('Điều kiện so sánh'), type: 'select', section: tr('Điều kiện'),
      desc: tr('Quy tắc so sánh giữa hai giá trị.'),
      options: [
        { value: 'contains',     label: tr('Có chứa chuỗi') },
        { value: 'contains_any', label: tr('Chứa một trong các từ (cách nhau dấu phẩy)') },
        { value: 'in_list',      label: tr('Là một trong các giá trị (cách nhau dấu phẩy)') },
        { value: 'not_contains', label: tr('Không chứa chuỗi') },
        { value: 'equals',       label: tr('= Bằng chính xác') },
        { value: 'not_equals',   label: tr('Khác') },
        { value: 'starts_with',  label: tr('Bắt đầu bằng') },
        { value: 'ends_with',    label: tr('Kết thúc bằng') },
        { value: 'greater_than', label: tr('> Lớn hơn (số)') },
        { value: 'less_than',    label: tr('< Nhỏ hơn (số)') },
        { value: 'is_empty',     label: tr('Rỗng / trống') },
        { value: 'not_empty',    label: tr('Không rỗng') },
        { value: 'regex',        label: tr('Regex (nâng cao)') },
      ],
    },
    {
      key: 'right', label: tr('So sánh với giá trị'), type: 'text', section: tr('Điều kiện'),
      placeholder: tr('Nhập từ khóa hoặc giá trị cần so sánh'),
      desc: tr('Giá trị bên phải. Ví dụ: nếu trái là nội dung tin nhắn thì phải là từ khóa cần tìm.'),
    },
  ],
  'logic.switch': [
    {
      key: 'value', label: tr('Giá trị để phân nhánh'), type: 'text', section: tr('Điều kiện'),
      placeholder: '{{ $trigger.content }}',
      desc: tr('Giá trị này sẽ được so sánh với từng case để quyết định chạy nhánh nào.'),
      templateVars: ['$trigger.content', '$trigger.fromId'],
    },
    {
      key: 'cases', label: tr('Danh sách các nhánh'), type: 'case-list', section: tr('Các nhánh'),
      desc: tr('Mỗi nhánh có giá trị khớp (match) và tên nhánh (label). Nhánh có giá trị khớp sẽ được chạy; tên nhánh là tay cầm nối trên canvas.'),
    },
    {
      key: 'defaultLabel', label: tr('Nhánh mặc định (không khớp case nào)'), type: 'text', section: tr('Các nhánh'),
      placeholder: 'default',
      desc: tr('Nếu không có case nào khớp, workflow chạy theo nhánh có tên này.'),
      advanced: true,
    },
  ],
  'logic.wait': [
    {
      key: 'delaySeconds', label: tr('Thời gian chờ (giây)'), type: 'number',
      desc: tr('Tạm dừng workflow trước khi tiếp tục bước tiếp theo (tối đa 5 phút).'),
      hint: tr('5 = 5 giây  •  60 = 1 phút  •  300 = 5 phút (tối đa)'),
    },
  ],
  'logic.setVariable': [
    {
      key: 'name', label: tr('Tên biến'), type: 'text',
      placeholder: 'tenKhachHang',
      desc: tr('Đặt tên cho biến (không dấu, không khoảng trắng). Dùng ở bước sau: {{ $var.tenKhachHang }}'),
    },
    {
      key: 'value', label: tr('Giá trị lưu vào biến'), type: 'text',
      placeholder: '{{ $trigger.fromName }}',
      desc: tr('Giá trị sẽ được lưu. Có thể là text cố định hoặc dữ liệu động từ trigger/node khác.'),
      templateVars: ['$trigger.fromName', '$trigger.fromId', '$trigger.content'],
    },
  ],
  'logic.stopIf': [
    {
      key: 'left', label: tr('Giá trị kiểm tra'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Nếu điều kiện này đúng → workflow dừng ngay tại đây, không chạy tiếp.'),
      templateVars: ['$trigger.content', '$trigger.fromId'],
    },
    {
      key: 'operator', label: tr('Điều kiện để dừng'), type: 'select',
      desc: tr('Nếu thoả mãn điều kiện này, workflow sẽ dừng.'),
      options: [
        { value: 'equals',       label: tr('= Bằng') }, { value: 'not_equals',   label: tr('≠ Khác') },
        { value: 'contains',     label: tr('Có chứa') }, { value: 'not_contains', label: tr('⊅ Không chứa') },
        { value: 'contains_any', label: tr('Chứa một trong các từ (cách nhau dấu phẩy)') },
        { value: 'in_list',      label: tr('Là một trong các giá trị (cách nhau dấu phẩy)') },
        { value: 'is_empty',     label: tr('Rỗng') }, { value: 'not_empty',    label: tr('● Không rỗng') },
      ],
    },
    {
      key: 'right', label: tr('So sánh với'), type: 'text',
      placeholder: tr('giá trị so sánh'),
      desc: tr('Giá trị dùng để so sánh với bên trái.'),
    },
  ],
  'logic.forEach': [
    {
      key: 'array', label: tr('Danh sách cần lặp qua'), type: 'text',
      placeholder: '{{ $node.<id node>.products }}',
      desc: tr('Chèn đúng một biến là danh sách của bước trước (vd. sản phẩm, đơn hàng, tin nhắn), hoặc nhập JSON ["a","b"] / mỗi dòng một mục. Các bước nối từ cổng "Mỗi phần tử" chạy lại cho từng phần tử; cổng "Xong" chạy một lần sau khi lặp hết.'),
      templateVars: [],
    },
    {
      key: 'itemVariable', label: tr('Tên biến cho từng phần tử'), type: 'text',
      placeholder: 'item',
      desc: tr('Phần tử đang xét lưu vào {{ $var.item }} (lấy một trường: {{ $var.item.name }}), số thứ tự từ 1 ở {{ $var.itemIndex }}. Chỉ dùng chữ không dấu, số, dấu _.'),
    },
    {
      key: 'maxItems', label: tr('Tối đa số phần tử'), type: 'number', placeholder: '100', min: 1,
      desc: tr('Chỉ lặp tối đa bấy nhiêu phần tử đầu (tối đa 100). Mỗi lần chạy workflow có tối đa 1.000 lượt lặp.'),
      advanced: true,
    },
  ],
  'logic.forEachContact': [
    {
      key: 'source', label: tr('Nguồn đối tượng'), type: 'choice', section: tr('Nguồn'),
      options: [
        { value: 'friends', label: tr('Bạn bè (danh bạ Zalo)') },
        { value: 'group_members', label: tr('Thành viên nhóm Zalo') },
        { value: 'labels', label: tr('Hội thoại theo nhãn (Local)') },
        { value: 'crm_contacts', label: tr('Liên hệ CRM') },
      ],
      desc: tr('Chọn danh sách người sẽ nhận tin. Nối node này vào node gửi tin rồi đặt trường "Gửi đến hội thoại" thành {{ $node.<tên node này>.result }}.'),
    },
    {
      key: 'accountId', label: tr('Tài khoản Zalo'), type: 'account-picker', channel: 'zalo', section: tr('Nguồn'),
      placeholder: tr('Để trống = tài khoản đang chạy workflow'),
      desc: tr('Tài khoản chứa danh sách đối tượng cần lấy.'),
      advanced: true,
    },
    {
      key: 'groupId', label: tr('ID nhóm Zalo'), type: 'text', section: tr('Nguồn'),
      placeholder: tr('Nhập ID nhóm (dùng khi nguồn = Thành viên nhóm)'),
      desc: tr('Chỉ cần điền khi chọn nguồn "Thành viên nhóm Zalo".'),
      advanced: true,
    },
    {
      key: 'labelIds', label: tr('Nhãn cần lọc'), type: 'label-picker', labelMode: 'multi', section: tr('Nguồn'),
      desc: tr('Chỉ lấy hội thoại đã gán các nhãn Local này. Chỉ cần điền khi chọn nguồn "Hội thoại theo nhãn".'),
      advanced: true,
    },
    {
      key: 'limit', label: tr('Giới hạn số người'), type: 'number', section: tr('Người nhận'),
      placeholder: '500', min: 1,
      desc: tr('Số người tối đa sẽ lấy. Giảm để tránh gửi quá nhiều.'),
      advanced: true,
    },
    {
      key: 'excludeIds', label: tr('Loại trừ người nhận'), type: 'contact-picker', section: tr('Người nhận'),
      contactType: 'all', contactMode: 'multi',
      placeholder: tr('Để trống = không loại trừ ai'),
      desc: tr('Những người/hội thoại này sẽ không nhận tin dù có trong danh sách.'),
    },
  ],
  'data.textFormat': [
    {
      key: 'template', label: tr('Mẫu nội dung'), type: 'textarea',
      placeholder: tr('Xin chào {{ $trigger.fromName }}!\nHôm nay là {{ $date.today }}.'),
      desc: tr('Soạn nội dung với biến động. Dùng {{ }} để chèn dữ liệu từ trigger hoặc bước trước.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$date.today', '$date.now'],
    },
  ],
  'data.randomPick': [
    {
      key: 'options', label: tr('Danh sách nội dung'), type: 'multiline',
      placeholder: tr('Xin chào bạn!\nChào mừng đến với shop!\nHi! Mình có thể giúp gì?'),
      desc: tr('Mỗi dòng là một lựa chọn. Hệ thống chọn ngẫu nhiên 1 nội dung mỗi lần chạy - giúp câu trả lời không bị lặp.'),
    },
  ],
  'data.dateFormat': [
    {
      key: 'format', label: tr('Định dạng hiển thị ngày giờ'), type: 'select',
      desc: tr('Chọn cách hiển thị ngày giờ trong kết quả.'),
      options: [
	{ value: 'datetime', label: tr('Ngày + Giờ (25/03/2026 14:30)') },
	{ value: 'date', label: tr('Chỉ ngày (25/03/2026)') },
	{ value: 'time', label: tr('Chỉ giờ (14:30)') },
	{ value: 'full', label: tr('Đầy đủ (Thứ Tư, 25/3/2026)') },
      ],
    },
    {
      key: 'date', label: tr('Ngày giờ cần format'), type: 'text',
      placeholder: tr('Để trống = lấy thời gian hiện tại'),
      desc: tr('Nhập timestamp hoặc để trống để dùng thời gian hiện tại.'),
      templateVars: ['$trigger.timestamp'], advanced: true,
    },
    {
      key: 'locale', label: tr('Ngôn ngữ hiển thị'), type: 'select',
      desc: tr('Kết quả gửi cho khách: mặc định tiếng Việt, không đổi theo ngôn ngữ giao diện app.'),
      options: [
        { value: 'vi-VN', label: tr('Tiếng Việt') },
        { value: 'en-US', label: 'English' },
        { value: 'zh-CN', label: '中文' },
      ],
      advanced: true,
    },
  ],
  'data.jsonParse': [
    {
      key: 'input', label: tr('Chuỗi JSON cần đọc'), type: 'text',
      placeholder: '{{ $node.HttpRequest.responseBody }}',
      desc: tr('Chuyển chuỗi JSON thành object để đọc các trường bên trong. Thường dùng sau bước "HTTP Request".'),
      templateVars: ['$node.HttpRequest.responseBody'],
    },
  ],
  'output.httpRequest': [
    {
      key: 'url', label: tr('Địa chỉ API (URL)'), type: 'text', section: tr('Kết nối API'),
      placeholder: 'https://api.example.com/webhook',
      desc: tr('Địa chỉ URL của API hoặc webhook cần gọi. Phải bắt đầu bằng https:// hoặc http://'),
    },
    {
      key: 'method', label: tr('Phương thức gửi'), type: 'select', section: tr('Kết nối API'),
      desc: tr('Cách gửi dữ liệu. POST = gửi dữ liệu lên, GET = lấy dữ liệu về.'),
      options: [
        { value: 'POST',   label: tr('POST - Gửi dữ liệu (phổ biến nhất cho webhook)') },
        { value: 'GET',    label: tr('GET - Lấy dữ liệu từ server') },
        { value: 'PUT',    label: tr('PUT - Cập nhật toàn bộ dữ liệu') },
        { value: 'PATCH',  label: tr('PATCH - Cập nhật một phần') },
        { value: 'DELETE', label: 'DELETE - Xóa dữ liệu' },
      ],
    },
    {
      key: 'headers', label: tr('Headers (xác thực / nâng cao)'), type: 'textarea', section: tr('Kết nối API'),
      placeholder: '{"Authorization": "Bearer your-token"}',
      desc: tr('HTTP Headers gửi kèm. Thường dùng để xác thực (Authorization token). Để trống nếu không cần.'),
      hint: tr('Ví dụ: {"Authorization": "Bearer abc123", "Content-Type": "application/json"}'),
      advanced: true,
    },
    {
      key: 'body', label: tr('Dữ liệu gửi kèm (Body)'), type: 'textarea', section: tr('Nội dung'),
      placeholder: '{\n  "name": "{{ $trigger.fromName }}",\n  "msg": "{{ $trigger.content }}"\n}',
      desc: tr('Nội dung gửi kèm (định dạng JSON). Dùng {{ }} để chèn dữ liệu động. Chỉ cần điền khi dùng POST/PUT/PATCH.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'timeout', label: tr('Timeout (mili-giây)'), type: 'number', section: tr('Tùy chọn'),
      desc: tr('Nếu API không phản hồi sau thời gian này sẽ bị coi là lỗi. Mặc định 30000 = 30 giây.'),
      advanced: true,
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục dù gọi API thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      desc: tr('Bật nếu muốn workflow vẫn chạy tiếp dù API trả về lỗi.'),
    },
  ],
  'output.log': [
    {
      key: 'message', label: tr('Nội dung cần ghi log'), type: 'text',
      placeholder: tr('Đã nhận tin từ {{ $trigger.fromName }}: {{ $trigger.content }}'),
      desc: tr('Nội dung ghi vào lịch sử chạy để debug. Hữu ích khi cần kiểm tra dữ liệu ở giữa workflow.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId'],
    },
    {
      key: 'level', label: tr('Mức độ log'), type: 'select',
      desc: tr('Phân loại mức độ thông điệp.'),
      options: [
        { value: 'info',  label: tr('Info - Thông tin bình thường') },
        { value: 'warn',  label: tr('Warn - Cảnh báo cần chú ý') },
        { value: 'error', label: tr('Error - Lỗi nghiêm trọng') },
      ],
    },
  ],

  // ── Google Sheets ────────────────────────────────────────────────────────

  'sheets.appendRow': [
    {
      key: 'spreadsheetId', label: tr('ID bảng tính (Spreadsheet ID)'), type: 'text',
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      desc: tr('Lấy từ URL của Google Sheet: docs.google.com/spreadsheets/d/[ ID NÀY ]/edit'),
    },
    {
      key: 'sheetName', label: tr('Tên trang tính (Sheet)'), type: 'text',
      placeholder: 'Sheet1',
      desc: tr('Tên tab trang tính cần ghi dữ liệu vào. Mặc định là "Sheet1".'),
    },
    {
      key: 'values', label: tr('Dữ liệu cần ghi (mảng JSON)'), type: 'textarea',
      placeholder: '["{{ $trigger.fromName }}", "{{ $trigger.content }}", "{{ $date.today }}"]',
      desc: tr('Mỗi phần tử trong mảng là một ô trong hàng mới. Dùng {{ }} để chèn dữ liệu động.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.today', '$date.now'],
    },
    {
      key: 'serviceAccountPath', label: tr('Đường dẫn file Service Account JSON'), type: 'text',
      placeholder: 'C:\\credentials\\google-service-account.json',
      desc: tr('Tải file JSON từ Google Cloud Console → Service Accounts → Keys. Chia sẻ sheet với email trong file JSON đó.'),
    },
  ],

  'sheets.readValues': [
    {
      key: 'spreadsheetId', label: tr('ID bảng tính (Spreadsheet ID)'), type: 'text',
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      desc: tr('Lấy từ URL của Google Sheet: docs.google.com/spreadsheets/d/[ ID NÀY ]/edit'),
    },
    {
      key: 'range', label: tr('Vùng dữ liệu cần đọc'), type: 'text',
      placeholder: 'Sheet1!A1:E100',
      desc: tr('Phạm vi ô cần đọc theo cú pháp TênSheet!CộtDòng. Ví dụ: Sheet1!A1:E100 đọc 100 dòng đầu.'),
      hint: tr('Sheet1!A:D = toàn bộ cột A đến D  •  Sheet1!A2:E = bỏ qua hàng tiêu đề'),
    },
    {
      key: 'serviceAccountPath', label: tr('Đường dẫn file Service Account JSON'), type: 'text',
      placeholder: 'C:\\credentials\\google-service-account.json',
      desc: tr('File xác thực Google Cloud. Kết quả đọc được lưu vào output.rows để dùng ở bước sau.'),
    },
  ],

  'sheets.updateCell': [
    {
      key: 'spreadsheetId', label: tr('ID bảng tính (Spreadsheet ID)'), type: 'text',
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
      desc: tr('Lấy từ URL của Google Sheet.'),
    },
    {
      key: 'range', label: tr('Vị trí ô cần cập nhật'), type: 'text',
      placeholder: 'Sheet1!B2',
      desc: tr('Ô cụ thể cần ghi giá trị. Ví dụ: Sheet1!B2 = sheet "Sheet1", cột B, dòng 2.'),
    },
    {
      key: 'value', label: tr('Giá trị mới'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Giá trị sẽ được ghi vào ô. Có thể là text cố định hoặc biến động.'),
      templateVars: ['$trigger.content', '$trigger.fromName', '$date.today'],
    },
    {
      key: 'serviceAccountPath', label: tr('Đường dẫn file Service Account JSON'), type: 'text',
      placeholder: 'C:\\credentials\\google-service-account.json',
      desc: tr('File xác thực Google Cloud.'),
    },
  ],

  // ── AI & Multi-platform ─────────────────────────────────────────────────────

  'ai.generateText': [
    {
      key: 'aiConfigMode', label: tr('Cách cấu hình AI'), type: 'select', section: tr('Trợ lý AI'),
      desc: tr('Chọn trợ lý đã tạo sẵn (nhanh, tiện) hoặc tự nhập API key & model thủ công.'),
      options: [
        { value: 'assistant', label: tr('Chọn trợ lý AI đã tạo') },
        { value: 'manual',    label: tr('Cài đặt thủ công (API key, model...)') },
      ],
    },
    {
      key: 'assistantId', label: tr('Chọn trợ lý AI'), type: 'assistant-picker', section: tr('Trợ lý AI'),
      desc: tr('Chọn trợ lý đã tạo trong Tích hợp → Trợ lý AI. Sẽ dùng API key, model, system prompt từ trợ lý đó.'),
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'manual',
    },
    {
      key: 'platform', label: tr('Nền tảng AI'), type: 'select', section: tr('Trợ lý AI'),
      desc: tr('Chọn nhà cung cấp AI. Mỗi nền tảng cần API key riêng.'),
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
      key: 'model', label: tr('Model AI'), type: 'select', section: tr('Trợ lý AI'),
      desc: tr('Chọn model phù hợp với nền tảng đã chọn ở trên.'),
      options: [
        // OpenAI
        { value: 'gpt-6-astra',      label: tr('GPT-6 Astra - Reasoning, công việc phức tạp (OpenAI)') },
        { value: 'gpt-6.1-sol',      label: tr('GPT-6.1 Sol - Cân bằng tốc độ, chất lượng (OpenAI)') },
        { value: 'gpt-6-luna',       label: tr('GPT-6 Luna - Nhanh, tiết kiệm (OpenAI)') },
        { value: 'gpt-5.4',          label: tr('GPT-5.4 - Flagship mới nhất (OpenAI)') },
        { value: 'gpt-5.4-pro',      label: tr('GPT-5.4 Pro - Thông minh nhất (OpenAI)') },
        { value: 'gpt-5.4-mini',     label: tr('GPT-5.4 Mini - Code, subagent (OpenAI - khuyến nghị)') },
        { value: 'gpt-5.4-nano',     label: tr('GPT-5.4 Nano - Siêu rẻ (OpenAI)') },
        { value: 'gpt-5-mini',       label: tr('GPT-5 Mini - Cân bằng, giá tốt (OpenAI)') },
        { value: 'gpt-5-nano',       label: tr('GPT-5 Nano - Nhanh, rẻ nhất (OpenAI)') },
        { value: 'gpt-5',            label: tr('GPT-5 - Lý luận mạnh (OpenAI)') },
        { value: 'o4-mini',          label: tr('o4-mini - Lý luận nhanh (OpenAI)') },
        { value: 'o3',               label: tr('o3 - Lý luận mạnh (OpenAI)') },
        { value: 'gpt-4.1',          label: tr('GPT-4.1 - Legacy non-reasoning (OpenAI)') },
        // Gemini
        { value: 'gemini-3.5-flash',        label: tr('Gemini 3.5 Flash - Mới nhất (Google - khuyến nghị)') },
        { value: 'gemini-3.1-pro-preview',  label: tr('Gemini 3.1 Pro Preview - Mạnh nhất (Google)') },
        { value: 'gemini-3-flash-preview',  label: tr('Gemini 3 Flash Preview - Nhanh (Google)') },
        { value: 'gemini-2.5-pro',          label: tr('Gemini 2.5 Pro - Legacy ổn định (Google)') },
        // Claude (Anthropic)
        { value: 'claude-fable-5-1',          label: tr('Claude Fable 5.1 - Reasoning dài hạn (Anthropic)') },
        { value: 'claude-opus-5-5',           label: tr('Claude Opus 5.5 - Agentic, knowledge work (Anthropic)') },
        { value: 'claude-sonnet-5-5',         label: tr('Claude Sonnet 5.5 - Cân bằng (Anthropic)') },
        { value: 'claude-haiku-4-5-20251001', label: tr('Claude Haiku 4.5 - Nhanh (Anthropic)') },
        { value: 'claude-4.6-sonnet-20260301',  label: tr('Claude 4.6 Sonnet - Mới nhất (Anthropic - khuyến nghị)') },
        { value: 'claude-4.5-sonnet-20260115',  label: tr('Claude 4.5 Sonnet - Cân bằng (Anthropic)') },
        { value: 'claude-4.0-haiku-20260101',   label: tr('Claude 4.0 Haiku - Nhanh, rẻ (Anthropic)') },
        { value: 'claude-4.0-opus-20260101',    label: tr('Claude 4.0 Opus - Mạnh nhất gen 4 (Anthropic)') },
        { value: 'claude-sonnet-4-20250514',    label: tr('Claude Sonnet 4 - Legacy (Anthropic)') },
        // Deepseek
        { value: 'deepseek-flash',     label: tr('Deepseek Flash - Mới nhất (Deepseek - khuyến nghị)') },
        { value: 'deepseek-v4-pro',    label: tr('Deepseek V4 Pro - Thinking, mạnh nhất (Deepseek)') },
        { value: 'deepseek-reasoner',  label: tr('Deepseek R1 - Lý luận ổn định (Deepseek)') },
        // Grok
        { value: 'grok-4-fast',      label: tr('Grok 4 Fast - Nhanh (xAI - khuyến nghị)') },
        { value: 'grok-4',           label: tr('Grok 4 - Flagship (xAI)') },
        { value: 'grok-4-mini',      label: tr('Grok 4 Mini - Lý luận, rẻ (xAI)') },
        { value: 'grok-4-mini-fast', label: tr('Grok 4 Mini Fast - Siêu nhanh (xAI)') },
        { value: 'grok-3',           label: tr('Grok 3 - Legacy ổn định (xAI)') },
        // Mistral
        { value: 'mistral-large-2-latest',  label: tr('Mistral Large 2 - Mạnh nhất (Mistral - khuyến nghị)') },
        { value: 'codestral-2-latest',      label: tr('Codestral 2 - Code chuyên dụng (Mistral)') },
        { value: 'mistral-small-3-latest',  label: tr('Mistral Small 3 - Nhanh, rẻ (Mistral)') },
        { value: 'mistral-medium-latest',   label: tr('Mistral Medium - Cân bằng (Mistral)') },
        { value: 'open-mistral-nemo-2',     label: tr('Mistral Nemo 2 - Nhẹ (Mistral)') },
        // OpenRouter
        { value: 'openrouter/auto',             label: tr('Auto Router - Tự chọn model tốt nhất (OpenRouter - khuyến nghị)') },
        { value: 'openai/gpt-5.4-mini',         label: tr('GPT-5.4 Mini - OpenAI qua OpenRouter') },
        { value: 'anthropic/claude-4.6-sonnet', label: tr('Claude 4.6 Sonnet - Anthropic qua OpenRouter') },
        { value: 'google/gemini-3.5-flash',     label: tr('Gemini 3.5 Flash - Google qua OpenRouter') },
        { value: 'deepseek/deepseek-v4-flash',  label: tr('DeepSeek V4 Flash - Rẻ, nhanh (OpenRouter)') },
        { value: 'meta-llama/llama-4-maverick', label: tr('Llama 4 Maverick - Meta, open-source (OpenRouter)') },
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
      key: 'apiKey', label: tr('API Key'), type: 'text', section: tr('Trợ lý AI'),
      placeholder: 'sk-proj-... / AIza... / sk-ant-... / sk-...',
      desc: tr('API key của nền tảng đã chọn. OpenAI: platform.openai.com | Gemini: aistudio.google.com | Claude: console.anthropic.com | Deepseek: platform.deepseek.com | Grok: console.x.ai | Mistral: console.mistral.ai | OpenRouter: openrouter.ai/settings/keys'),
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'systemPrompt', label: tr('Ngữ cảnh / Vai trò của AI'), type: 'textarea', section: tr('Nội dung'),
      placeholder: tr('Bạn là nhân viên tư vấn bán hàng của shop [TÊN]. Trả lời ngắn gọn, thân thiện.'),
      desc: tr('Mô tả vai trò và phong cách trả lời của AI. Không hiển thị với người dùng.'),
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'prompt', label: tr('Câu hỏi / Yêu cầu cho AI'), type: 'textarea', section: tr('Nội dung'),
      placeholder: tr('Khách hỏi: {{ $trigger.content }}\n\nHãy trả lời ngắn gọn, thân thiện bằng tiếng Việt.'),
      desc: tr('Nội dung gửi đến AI để nhận câu trả lời. Dùng {{ }} để chèn tin nhắn từ khách hàng.'),
      templateVars: ['$trigger.content', '$trigger.fromName', '$trigger.fromId'],
    },
    {
      key: 'chatHistory', label: tr('Lịch sử chat (cho AI nhớ ngữ cảnh)'), type: 'textarea', section: tr('Nội dung'),
      placeholder: '{{ $node.GetHistory.messages }}',
      desc: tr('Truyền lịch sử hội thoại để AI nhớ ngữ cảnh. Có thể là mảng JSON [{role:"user",content:"..."},...] hoặc lịch sử Zalo từ node "Lấy lịch sử tin nhắn". Để trống nếu không cần nhớ ngữ cảnh.'),
      templateVars: ['$node.GetHistory.messages'],
    },
    {
      key: 'maxHistoryMessages', label: tr('Số tin nhắn lịch sử tối đa'), type: 'number', section: tr('Nội dung'),
      placeholder: '20', min: 1,
      desc: tr('Giới hạn bao nhiêu tin nhắn lịch sử được gửi kèm (để tiết kiệm token). Mặc định 20.'),
    },
    {
      key: 'maxTokens', label: tr('Độ dài tối đa (tokens)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '500',
      desc: tr('Giới hạn độ dài câu trả lời. 1 token ≈ 0.75 từ. 500 = ~375 từ.'),
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'temperature', label: tr('Mức độ sáng tạo (0.0 – 1.0)'), type: 'number', section: tr('Tùy chọn'),
      placeholder: '0.7',
      desc: tr('0 = trả lời chính xác, ổn định. 1 = sáng tạo, đa dạng hơn. Khuyến nghị 0.7 cho chat bán hàng.'),
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
  ],

  'ai.classify': [
    {
      key: 'aiConfigMode', label: tr('Cách cấu hình AI'), type: 'select', section: tr('Trợ lý AI'),
      desc: tr('Chọn trợ lý đã tạo sẵn (nhanh, tiện) hoặc tự nhập API key & model thủ công.'),
      options: [
        { value: 'assistant', label: tr('Chọn trợ lý AI đã tạo') },
        { value: 'manual',    label: tr('Cài đặt thủ công (API key, model...)') },
      ],
    },
    {
      key: 'assistantId', label: tr('Chọn trợ lý AI'), type: 'assistant-picker', section: tr('Trợ lý AI'),
      desc: tr('Chọn trợ lý đã tạo trong Tích hợp → Trợ lý AI. Sẽ dùng API key, model, system prompt từ trợ lý đó.'),
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'manual',
    },
    {
      key: 'platform', label: tr('Nền tảng AI'), type: 'select', section: tr('Trợ lý AI'),
      desc: tr('Chọn nhà cung cấp AI.'),
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
      key: 'model', label: tr('Model AI'), type: 'select', section: tr('Trợ lý AI'),
      desc: tr('Chọn model phù hợp với nền tảng đã chọn ở trên.'),
      options: [
        { value: 'gpt-6-astra',      label: tr('GPT-6 Astra - Reasoning, công việc phức tạp (OpenAI)') },
        { value: 'gpt-6.1-sol',      label: tr('GPT-6.1 Sol - Cân bằng tốc độ, chất lượng (OpenAI)') },
        { value: 'gpt-6-luna',       label: tr('GPT-6 Luna - Nhanh, tiết kiệm (OpenAI)') },
        { value: 'gpt-5.4-mini',     label: tr('GPT-5.4 Mini - Code, subagent (OpenAI - khuyến nghị)') },
        { value: 'gpt-5-mini',       label: tr('GPT-5 Mini - Cân bằng, giá tốt (OpenAI)') },
        { value: 'gpt-5.4',          label: tr('GPT-5.4 - Flagship (OpenAI)') },
        { value: 'gemini-3.5-flash',        label: tr('Gemini 3.5 Flash (Google - khuyến nghị)') },
        { value: 'gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro Preview (Google)' },
        { value: 'gemini-3-flash-preview',  label: 'Gemini 3 Flash Preview (Google)' },
        { value: 'claude-fable-5-1',          label: tr('Claude Fable 5.1 - Reasoning dài hạn (Anthropic)') },
        { value: 'claude-opus-5-5',           label: tr('Claude Opus 5.5 - Agentic, knowledge work (Anthropic)') },
        { value: 'claude-sonnet-5-5',         label: tr('Claude Sonnet 5.5 - Cân bằng (Anthropic)') },
        { value: 'claude-haiku-4-5-20251001', label: tr('Claude Haiku 4.5 - Nhanh (Anthropic)') },
        { value: 'claude-4.6-sonnet-20260301',  label: tr('Claude 4.6 Sonnet (Anthropic - khuyến nghị)') },
        { value: 'claude-4.0-haiku-20260101',   label: tr('Claude 4.0 Haiku - Nhanh (Anthropic)') },
        { value: 'deepseek-flash',     label: tr('Deepseek Flash (Deepseek - khuyến nghị)') },
        { value: 'deepseek-v4-pro',    label: tr('Deepseek V4 Pro - Thinking (Deepseek)') },
        { value: 'grok-4-fast',      label: tr('Grok 4 Fast (xAI - khuyến nghị)') },
        { value: 'grok-4-mini-fast', label: tr('Grok 4 Mini Fast - Siêu nhanh (xAI)') },
        { value: 'mistral-large-2-latest', label: tr('Mistral Large 2 (Mistral - khuyến nghị)') },
        { value: 'mistral-small-3-latest', label: tr('Mistral Small 3 - Nhanh, rẻ (Mistral)') },
        { value: 'openrouter/auto',            label: tr('Auto Router (OpenRouter - khuyến nghị)') },
        { value: 'deepseek/deepseek-v4-flash', label: tr('DeepSeek V4 Flash - Rẻ, nhanh (OpenRouter)') },
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
      key: 'apiKey', label: tr('API Key'), type: 'text', section: tr('Trợ lý AI'),
      placeholder: 'sk-proj-... / AIza... / sk-ant-... / sk-...',
      desc: tr('API key của nền tảng đã chọn.'),
      hideWhenKey: 'aiConfigMode', hideWhenValue: 'assistant',
    },
    {
      key: 'input', label: tr('Văn bản cần phân loại'), type: 'text', section: tr('Nội dung'),
      placeholder: '{{ $trigger.content }}',
      desc: tr('Nội dung tin nhắn cần được AI phân loại.'),
      templateVars: ['$trigger.content'],
    },
    {
      key: 'categories', label: tr('Danh sách danh mục'), type: 'text', section: tr('Nội dung'),
      placeholder: tr('hỏi giá, đặt hàng, khiếu nại, hỏi thông tin, khác'),
      desc: tr('Các danh mục cách nhau bằng dấu phẩy. AI sẽ trả về tên một danh mục phù hợp nhất. Kết quả lưu vào output.category.'),
    },
  ],

  // ── Notifications ─────────────────────────────────────────────────────────────

  'notify.telegram': [
    {
      key: 'botAccountId', label: tr('Bot Telegram đã kết nối'), type: 'account-picker', channel: 'telegram_bot',
      placeholder: tr('Chọn Bot (kênh Telegram Bot)'),
      desc: tr('Bot đã thêm ở mục Tài khoản (kênh Telegram Bot). Chọn Bot ở đây thì không cần Integration hay Bot Token.'),
    },
    {
      key: 'integrationId', label: tr('Chọn Bot Telegram'), type: 'integration-picker',
      desc: tr('Chọn Bot Telegram đã kết nối trong Settings → Tích hợp. Nếu chưa có, vào Settings để thêm Bot mới.'),
    },
    {
      key: 'botToken', label: tr('Bot Token (nếu chưa chọn Bot)'), type: 'text',
      placeholder: '7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      desc: tr('Hoặc nhập trực tiếp Bot Token. Ưu tiên sử dụng Bot đã kết nối ở trên.'),
      advanced: true,
    },
    {
      key: 'chatId', label: tr('Chat ID nhận tin'), type: 'text',
      placeholder: tr('-1001234567890  hoặc  123456789'),
      desc: tr('ID của người dùng hoặc nhóm/kênh nhận thông báo. Dùng @userinfobot để tìm Chat ID của mình.'),
    },
    {
      key: 'message', label: tr('Nội dung thông báo'), type: 'textarea',
      placeholder: tr('🔔 Tin nhắn mới từ {{ $trigger.fromName }}:\n{{ $trigger.content }}'),
      desc: tr('Nội dung tin nhắn gửi qua Telegram. Để trống sẽ dùng kết quả văn bản từ node phía trước. Hỗ trợ HTML đơn giản (<b>bold</b>, <i>italic</i>).'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.now'],
    },
    {
      key: 'parseMode', label: tr('Định dạng văn bản'), type: 'select',
      desc: tr('Cách hiển thị văn bản trong tin nhắn Telegram.'),
      options: [
        { value: 'HTML',     label: tr('HTML - Hỗ trợ <b>bold</b>, <i>italic</i>') },
        { value: 'Markdown', label: tr('Markdown - Hỗ trợ **bold**, _italic_') },
        { value: '',         label: tr('Plain Text - Không định dạng') },
      ],
      advanced: true,
    },
  ],

  'notify.discord': [
    {
      key: 'webhookUrl', label: tr('Discord Webhook URL'), type: 'text',
      placeholder: 'https://discord.com/api/webhooks/123456789/xxxx',
      desc: tr('Vào kênh Discord → Settings → Integrations → Webhooks → New Webhook → sao chép URL.'),
    },
    {
      key: 'message', label: tr('Nội dung thông báo'), type: 'textarea',
      placeholder: tr('📩 **{{ $trigger.fromName }}** vừa nhắn:\n> {{ $trigger.content }}'),
      desc: tr('Nội dung gửi vào kênh Discord. Hỗ trợ định dạng Markdown (**bold**, *italic*, > quote).'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.now'],
    },
    {
      key: 'username', label: tr('Tên hiển thị của bot'), type: 'text',
      placeholder: 'DepLao Bot',
      desc: tr('Tên sẽ hiển thị khi gửi tin vào kênh Discord.'),
      advanced: true,
    },
    {
      key: 'avatarUrl', label: tr('Avatar URL (tuỳ chọn)'), type: 'text',
      placeholder: 'https://example.com/avatar.png',
      desc: tr('Link ảnh đại diện hiển thị khi bot gửi tin. Để trống = dùng avatar mặc định của webhook.'),
      advanced: true,
    },
  ],

  'notify.email': [
    {
      key: 'to', label: tr('Gửi đến email'), type: 'text',
      placeholder: tr('you@gmail.com  hoặc  a@gmail.com, b@gmail.com'),
      desc: tr('Địa chỉ email nhận. Nhiều email cách nhau bằng dấu phẩy.'),
      templateVars: ['$trigger.fromName'],
    },
    {
      key: 'subject', label: tr('Tiêu đề email'), type: 'text',
      placeholder: tr('🔔 Tin nhắn mới từ {{ $trigger.fromName }}'),
      desc: tr('Tiêu đề hiển thị trong hộp thư.'),
      templateVars: ['$trigger.fromName', '$date.today'],
    },
    {
      key: 'isHtml', label: tr('Nội dung dạng HTML'), type: 'boolean',
      desc: tr('Bật để soạn thảo và xem trước nội dung email dạng HTML.'),
    },
    {
      key: 'body', label: tr('Nội dung email'), type: 'textarea',
      placeholder: tr('Bạn có tin nhắn mới từ {{ $trigger.fromName }}:\n\n{{ $trigger.content }}\n\nGửi lúc: {{ $date.now }}'),
      desc: tr('Nội dung email. Khi bật HTML ở trên, soạn thảo trực tiếp và xem trước ngay.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.fromId', '$date.now'],
      htmlToggle: 'isHtml',
    },
    {
      key: 'smtpHost', label: tr('SMTP Host'), type: 'text',
      placeholder: 'smtp.gmail.com',
      desc: tr('Máy chủ gửi mail. Gmail: smtp.gmail.com | Outlook: smtp-mail.outlook.com'),
      advanced: true,
    },
    {
      key: 'smtpPort', label: tr('SMTP Port'), type: 'number',
      desc: tr('Cổng kết nối. Gmail dùng 587 (TLS) hoặc 465 (SSL).'),
      hint: tr('587 = TLS (phổ biến)  •  465 = SSL  •  25 = không mã hóa (không khuyến nghị)'),
      advanced: true,
    },
    {
      key: 'smtpUser', label: tr('Tài khoản email'), type: 'text',
      placeholder: 'youremail@gmail.com',
      desc: tr('Email đăng nhập SMTP. Với Gmail, cần bật "App Password" trong cài đặt bảo mật.'),
      advanced: true,
    },
    {
      key: 'smtpPass', label: tr('Mật khẩu / App Password'), type: 'text',
      placeholder: 'xxxx xxxx xxxx xxxx',
      desc: tr('Mật khẩu email hoặc App Password (Gmail). Tạo App Password tại myaccount.google.com → Security → App passwords.'),
      advanced: true,
    },
    {
      key: 'allowInvalidCert', label: tr('Bỏ qua kiểm tra chứng chỉ SMTP'), type: 'boolean',
      desc: tr('Chỉ bật với máy chủ mail nội bộ dùng chứng chỉ tự ký. Tắt (mặc định) để mật khẩu không bị lộ qua kết nối giả mạo.'),
      advanced: true,
    },
  ],

  'notify.notion': [
    {
      key: 'databaseId', label: tr('ID Database Notion'), type: 'text',
      placeholder: '1a2b3c4d5e6f7g8h9i0j',
      desc: tr('Lấy từ URL của Notion database: notion.so/[workspace]/[ ID NÀY ]?v=...'),
    },
    {
      key: 'apiKey', label: tr('Notion API Key (Integration Token)'), type: 'text',
      placeholder: 'secret_xxxxxxxxxxxx',
      desc: tr('Tạo integration tại notion.so/my-integrations → Copy token. Sau đó share database với integration đó.'),
    },
    {
      key: 'properties', label: tr('Thuộc tính trang (JSON)'), type: 'json',
      hint: tr('{"Tên": {"title": [{"text": {"content": "{{ $trigger.fromName }}"}}]}, "Nội dung": {"rich_text": [{"text": {"content": "{{ $trigger.content }}"}}]}}'),
      desc: tr('Dữ liệu trang theo cấu trúc Notion API. Xem tài liệu Notion API để biết cách định nghĩa từng loại trường.'),
    },
  ],

  // ─── Trigger: Payment ──────────────────────────────────────────────────
  'trigger.payment': [
    {
      key: 'minAmount', label: tr('Số tiền tối thiểu (VNĐ)'), type: 'number',
      placeholder: '0',
      desc: tr('Chỉ kích hoạt khi số tiền nhận được ≥ giá trị này. Để 0 = nhận tất cả.'),
    },
    {
      key: 'descContains', label: tr('Nội dung CK chứa từ khóa'), type: 'text',
      placeholder: tr('DH, ORDER, ... (để trống = nhận tất cả)'),
      desc: tr('Lọc theo nội dung chuyển khoản. VD: "DH" → chỉ nhận CK có nội dung chứa "DH".'),
      templateVars: ['$trigger.description'],
    },
    {
      key: 'integrationId', label: tr('Tài khoản thanh toán cụ thể'), type: 'text',
      placeholder: tr('Để trống = nhận từ tất cả tài khoản Casso/SePay (VietQR)'),
      desc: tr('Nhập ID tích hợp nếu muốn lọc chỉ một tài khoản cụ thể.'),
      advanced: true,
    },
  ],

  // ─── Trigger: POS software webhook (services/integrations/posWebhook.ts) ─────────
  'trigger.posWebhook': [
    {
      key: 'posWebhookSetup', label: tr('Cách nhận webhook'), type: 'info', section: tr('Nguồn'),
      desc: tr('Vào Tích hợp → mở kết nối KiotViet / Haravan / Sapo / Nhanh.vn / Pancake → đặt "Khoá xác thực webhook" → dán "Địa chỉ nhận webhook" vào phần cấu hình webhook của phần mềm bán hàng. Webhook thiếu khoá hoặc sai chữ ký bị từ chối, không chạy workflow.'),
    },
    {
      key: 'integrationType', label: tr('Phần mềm bán hàng'), type: 'select', section: tr('Nguồn'),
      options: [
        { value: 'all',      label: tr('Tất cả phần mềm đã kết nối') },
        { value: 'kiotviet', label: 'KiotViet' },
        { value: 'haravan',  label: 'Haravan' },
        { value: 'sapo',     label: 'Sapo' },
        { value: 'nhanh',    label: 'Nhanh.vn' },
        { value: 'pancake',  label: 'Pancake POS' },
      ],
      desc: tr('Chỉ chạy với webhook của phần mềm này.'),
    },
    {
      key: 'entity', label: tr('Loại dữ liệu'), type: 'choice', section: tr('Bộ lọc'),
      options: [
        { value: 'order',     label: tr('Đơn hàng') },
        { value: 'invoice',   label: tr('Hoá đơn (KiotViet)') },
        { value: 'customer',  label: tr('Khách hàng') },
        { value: 'product',   label: tr('Sản phẩm') },
        { value: 'inventory', label: tr('Tồn kho') },
        { value: 'all',       label: tr('Tất cả') },
      ],
      desc: tr('Mỗi đơn / khách / sản phẩm trong webhook chạy workflow một lần; nền tảng gửi lại cùng dữ liệu thì bỏ qua.'),
    },
    {
      key: 'eventContains', label: tr('Tên sự kiện chứa'), type: 'text', section: tr('Bộ lọc'),
      placeholder: tr('vd: create, paid, orderAdd (để trống = mọi sự kiện)'),
      desc: tr('Tên sự kiện của nền tảng ($trigger.event): KiotViet order.update / invoice.update, Haravan & Sapo orders/create / orders/paid / orders/cancelled, Nhanh.vn orderAdd / orderUpdate, Pancake orders. Nhiều từ cách nhau dấu phẩy = khớp một trong các từ.'),
    },
    {
      key: 'statusContains', label: tr('Trạng thái chứa'), type: 'text', section: tr('Bộ lọc'),
      placeholder: tr('vd: Hoàn thành, paid, Giao thành công'),
      desc: tr('Trạng thái đơn ($trigger.status): KiotViet StatusValue, Haravan / Sapo financial_status / fulfillment_status, Nhanh.vn tên trạng thái, Pancake status_name. Nhiều từ cách nhau dấu phẩy, không phân biệt hoa / thường.'),
    },
    {
      key: 'integrationId', label: tr('Chỉ một kết nối'), type: 'text', advanced: true,
      placeholder: tr('Để trống = mọi kết nối của phần mềm đã chọn'),
      desc: tr('ID kết nối khi có nhiều cửa hàng cùng phần mềm — phần cuối "Địa chỉ nhận webhook" (/webhook/<ID>) ở trang tích hợp.'),
    },
  ],

  // ─── Trigger: Public API v1 / plugin ─────────────────────────────────────
  'trigger.api': [
    {
      key: 'eventName', label: tr('Tên sự kiện'), type: 'text',
      placeholder: tr('vd: don_hang_moi'),
      desc: tr('Hệ thống ngoài hoặc ứng dụng đã cài gọi POST /api/v1/workflows/events/<tên sự kiện> với body { "payload": {...} }. Để trống = nhận mọi sự kiện. Dùng {{ $trigger.payload.<trường> }} trong các bước sau.'),
    },
    {
      key: 'requiredKeyId', label: tr('Chỉ nhận từ API key (tùy chọn)'), type: 'text',
      placeholder: tr('ID của API key (Công cụ → Ứng dụng, API & Webhook → API)'),
      desc: tr('Nếu điền, chỉ key này kích hoạt được workflow.'),
      advanced: true,
    },
  ],

  // ─── Trigger: External webhook ──────────────────────────────────────────
  'trigger.webhook': [
    {
      key: 'webhookUrlDisplay', label: tr('URL Webhook'), type: 'info',
      desc: tr('URL này dùng để nhận dữ liệu từ bên thứ 3. Gửi URL này cho đối tác để họ POST dữ liệu vào.'),
      isWebhookUrl: true,
    },
    {
      key: 'secretKey', label: tr('Secret Key (tùy chọn)'), type: 'text',
      placeholder: tr('Để trống nếu không cần xác thực'),
      desc: tr('Nếu có, hệ thống sẽ verify HMAC-SHA256 từ header X-Signature. Dùng để đảm bảo dữ liệu đến từ đúng đối tác.'),
    },
    {
      key: 'method', label: tr('Phương thức HTTP'), type: 'select',
      options: [
        { value: 'POST', label: 'POST' },
        { value: 'GET', label: 'GET' },
        { value: 'PUT', label: 'PUT' },
        { value: 'ANY', label: tr('Bất kỳ') },
      ],
      desc: tr('Phương thức HTTP mà bên thứ 3 sẽ dùng để gửi dữ liệu.'),
    },
    {
      key: 'allowedIps', label: tr('Chỉ cho phép IP (tùy chọn)'), type: 'text',
      placeholder: tr('Để trống = cho phép tất cả. VD: 103.21.244.0, 103.21.245.0'),
      desc: tr('Giới hạn địa chỉ IP được phép gọi webhook. Cách nhau bằng dấu phẩy.'),
      advanced: true,
    },
  ],

  // ─── KiotViet ─────────────────────────────────────────────────────────────
  'kiotviet.lookupCustomer': [
    {
      key: 'phone', label: tr('Số điện thoại khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('SĐT để tra cứu khách hàng trong KiotViet. {{POS_PHONE_HINT}} {{POS_CUSTOMER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_CUSTOMER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'kiotviet.lookupOrder': [
    {
      key: 'phone', label: tr('SĐT khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('Tìm đơn hàng theo SĐT; có cả mã đơn thì mã đơn được ưu tiên. {{POS_PHONE_HINT}} {{POS_ORDER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_ORDER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
    {
      key: 'orderId', label: tr('Mã đơn hàng (nếu biết)'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Mã đơn hàng KiotViet. Ưu tiên hơn SĐT nếu điền vào đây.'),
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'kiotviet.lookupProduct': [
    {
      key: 'keyword', label: tr('Tên hoặc mã SKU sản phẩm'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Từ khóa tìm kiếm - tên sản phẩm hoặc mã SKU trong KiotViet.'),
      templateVars: ['$trigger.content'],
    },
    {
      key: 'code', label: tr('Mã SKU chính xác (tùy chọn)'), type: 'text',
      placeholder: 'SP001',
      desc: tr('Nếu biết chính xác mã SKU, điền vào đây để kết quả chính xác hơn.'),
      advanced: true,
    },
    { key: 'limit', label: tr('Số kết quả tối đa'), type: 'number', placeholder: '10', advanced: true },
  ],
  'kiotviet.createOrder': [
    {
      key: 'branchId', label: tr('ID Chi nhánh (branchId)'), type: 'number',
      placeholder: '1',
      desc: tr('ID chi nhánh KiotViet nơi tạo đơn. Xem trong KiotViet Admin → Chi nhánh.'),
    },
    {
      key: 'customerId', label: tr('ID Khách hàng (customerId)'), type: 'text',
      placeholder: tr('{{ $node.KiotViet_Tra_Cứu_Khách.firstCustomer.id }}'),
      desc: tr('ID khách hàng từ bước tra cứu khách hàng. Để trống nếu tạo đơn khách vãng lai.'),
      templateVars: ['$trigger.fromName'],
    },
    {
      key: 'orderDetails', label: tr('Danh sách sản phẩm (JSON)'), type: 'json',
      hint: '[{"productId": 123, "quantity": 1, "price": 150000}, {"productId": 456, "quantity": 2, "price": 80000}]',
      desc: tr('Mảng sản phẩm. Mỗi item cần: productId (int), quantity (int), price (số tiền VNĐ). productId lấy từ bước tra cứu sản phẩm.'),
    },
    {
      key: 'discount', label: tr('Giảm giá trực tiếp (VNĐ)'), type: 'number',
      placeholder: '0', advanced: true,
    },
    {
      key: 'note', label: tr('Ghi chú đơn hàng'), type: 'text',
      placeholder: tr('Ghi chú từ khách: {{ $trigger.content }}'),
      templateVars: ['$trigger.content', '$trigger.fromName'],
      advanced: true,
    },
  ],

  // ─── Haravan ──────────────────────────────────────────────────────────────
  'haravan.lookupCustomer': [
    {
      key: 'phone', label: tr('Số điện thoại khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('SĐT để tìm khách hàng trong Haravan. {{POS_PHONE_HINT}} {{POS_CUSTOMER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_CUSTOMER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'haravan.lookupOrder': [
    {
      key: 'phone', label: tr('SĐT khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('Tìm đơn hàng theo SĐT; có cả mã đơn thì mã đơn được ưu tiên. {{POS_PHONE_HINT}} {{POS_ORDER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_ORDER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
    {
      key: 'orderId', label: tr('Mã đơn hàng (Order ID)'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('ID đơn hàng Haravan (số nguyên). Ưu tiên hơn SĐT.'),
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'haravan.lookupProduct': [
    {
      key: 'keyword', label: tr('Tên sản phẩm'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Tìm sản phẩm theo tên trong Haravan.'),
      templateVars: ['$trigger.content'],
    },
    { key: 'limit', label: tr('Số kết quả tối đa'), type: 'number', placeholder: '10', advanced: true },
  ],
  'haravan.createOrder': [
    {
      key: 'order', label: tr('Dữ liệu đơn hàng (JSON)'), type: 'json',
      hint: tr('{"line_items":[{"variant_id":"123","quantity":1,"price":"150000"}],"customer":{"phone":"0901234567"},"shipping_address":{"name":"Nguyễn Văn A","address1":"123 Đường ABC","city":"Hà Nội","phone":"0901234567"}}'),
      desc: tr('Toàn bộ đối tượng đơn hàng theo Haravan API. line_items là bắt buộc. variant_id lấy từ bước tra cứu sản phẩm (product.variants[0].id).'),
    },
  ],

  // ─── Sapo ─────────────────────────────────────────────────────────────────
  'sapo.lookupCustomer': [
    {
      key: 'phone', label: tr('Số điện thoại khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('SĐT để tìm khách hàng trong Sapo. {{POS_PHONE_HINT}} {{POS_CUSTOMER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_CUSTOMER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'sapo.lookupOrder': [
    {
      key: 'phone', label: tr('SĐT khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('Tìm đơn hàng theo SĐT; có cả mã đơn (ID số của đơn) thì mã đơn được ưu tiên. {{POS_PHONE_HINT}} {{POS_ORDER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_ORDER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
    {
      key: 'orderId', label: tr('Mã đơn hàng'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'sapo.lookupProduct': [
    {
      key: 'keyword', label: tr('Tên sản phẩm'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
    },
    { key: 'limit', label: tr('Số kết quả tối đa'), type: 'number', placeholder: '10', advanced: true },
  ],
  'sapo.getInventory': [
    { key: 'limit', label: tr('Số sản phẩm'), type: 'number', placeholder: '50', advanced: true },
  ],
  'sapo.createOrder': [
    {
      key: 'order', label: tr('Dữ liệu đơn hàng (JSON)'), type: 'json',
      hint: tr('{"line_items":[{"variant_id":"123","quantity":1,"price":"150000"}],"customer":{"phone":"0901234567"},"shipping_address":{"name":"Nguyễn Văn A","address1":"123 Đường ABC","city":"Hồ Chí Minh","phone":"0901234567"}}'),
      desc: tr('Đối tượng đơn hàng Sapo. Cấu trúc tương tự Haravan/Shopify. line_items bắt buộc.'),
    },
  ],

  // ─── Nhanh.vn ────────────────────────────────────────────────────────────
  'nhanh.lookupCustomer': [
    {
      key: 'phone', label: tr('Số điện thoại khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('SĐT để tìm khách hàng trong Nhanh.vn. {{POS_PHONE_HINT}} {{POS_CUSTOMER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_CUSTOMER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'nhanh.lookupOrder': [
    {
      key: 'phone', label: tr('SĐT khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('Tìm đơn hàng theo SĐT người nhận; có cả mã đơn thì lọc thêm theo mã đơn. {{POS_PHONE_HINT}} {{POS_ORDER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_ORDER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
    {
      key: 'orderId', label: tr('Mã đơn hàng'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'nhanh.lookupProduct': [
    {
      key: 'keyword', label: tr('Tên sản phẩm'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      templateVars: ['$trigger.content'],
    },
    {
      key: 'code', label: tr('Mã sản phẩm (tùy chọn)'), type: 'text',
      placeholder: 'SP001',
      advanced: true,
    },
    { key: 'limit', label: tr('Số kết quả tối đa'), type: 'number', placeholder: '10', advanced: true },
  ],
  'nhanh.createOrder': [
    {
      key: 'order', label: tr('Dữ liệu đơn hàng (JSON)'), type: 'json',
      hint: tr('{"info":{"type":1,"description":"Đặt hàng qua Zalo"},"channel":{"appOrderId":"DH001","sourceName":"deplaoapp"},"shippingAddress":{"name":"Nguyễn Văn A","mobile":"0901234567","address":"123 Đường ABC, Phường Hoàn Kiếm, Hà Nội","locationVersion":"v2"},"products":[{"id":123,"price":150000,"quantity":1}]}'),
      desc: tr('Đơn hàng theo Nhanh.vn API v3 (order/add). Bắt buộc: channel.appOrderId (mã đơn riêng, Nhanh chặn trùng theo mã này), shippingAddress.name + mobile, products[].id + price + quantity (id lấy từ bước tra cứu sản phẩm). locationVersion: v2 = địa chỉ mới 2 cấp, v1 = địa chỉ cũ 3 cấp.'),
    },
  ],

  // ─── Pancake POS ──────────────────────────────────────────────────────────
  'pancake.lookupCustomer': [
    {
      key: 'phone', label: tr('Số điện thoại khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('SĐT để tìm khách hàng trong Pancake POS. {{POS_PHONE_HINT}} {{POS_CUSTOMER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_CUSTOMER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
  ],
  'pancake.lookupOrder': [
    {
      key: 'phone', label: tr('SĐT khách hàng'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      desc: tr('Tìm đơn hàng theo SĐT; có cả mã đơn thì mã đơn được ưu tiên. {{POS_PHONE_HINT}} {{POS_ORDER_EMPTY_NOTE}}', { POS_PHONE_HINT, POS_ORDER_EMPTY_NOTE }),
      templateVars: ['$trigger.fromPhone', '$trigger.content'],
    },
    {
      key: 'orderId', label: tr('Mã đơn hàng (nếu biết)'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Mã đơn Pancake POS. Ưu tiên hơn SĐT; không có đơn đúng mã này thì tìm theo SĐT (nếu có) hoặc theo chính mã này.'),
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'pancake.lookupProduct': [
    {
      key: 'keyword', label: tr('Tên sản phẩm'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Tìm sản phẩm theo tên trong Pancake POS (có / không dấu đều được).'),
      templateVars: ['$trigger.content'],
    },
    {
      key: 'code', label: tr('Mã sản phẩm (tùy chọn)'), type: 'text',
      placeholder: 'SP001',
      desc: tr('Biết chính xác mã sản phẩm thì tra thẳng theo mã.'),
      advanced: true,
    },
    { key: 'limit', label: tr('Số kết quả tối đa'), type: 'number', placeholder: '10', advanced: true },
  ],
  'pancake.createOrder': [
    {
      key: 'order', label: tr('Dữ liệu đơn hàng (JSON)'), type: 'json',
      hint: tr('{"bill_full_name":"Nguyễn Văn A","bill_phone_number":"0901234567","shipping_address":{"full_name":"Nguyễn Văn A","phone_number":"0901234567","address":"123 Đường ABC, Phường Sài Gòn, Hồ Chí Minh"},"items":[{"variation_id":"123456","quantity":1}],"shipping_fee":30000,"cod":180000,"note":"Đặt hàng qua Zalo"}'),
      desc: tr('Đơn hàng theo Open API của Pancake POS (cùng dạng với form Tạo đơn hàng trong Tích hợp nhanh). items[].variation_id = id phiên bản lấy từ bước "Pancake: Tra cứu sản phẩm"; cod = tiền thu hộ. shipping_address.address ghi đủ số nhà, phường/xã, tỉnh: Pancake tự nhận ra địa chỉ khi không có province_id.'),
    },
  ],

  // ─── Payment: Get transactions ───────────────────────────────────────────────
  'payment.getTransactions': [
    {
      key: 'integrationType', label: tr('Nền tảng thanh toán'), type: 'select',
      options: [
        { value: 'casso', label: 'Casso' },
        { value: 'sepay', label: 'SePay (VietQR)' },
      ],
      desc: tr('Chọn nền tảng để lấy lịch sử giao dịch.'),
    },
    {
      key: 'limit', label: tr('Số giao dịch tối đa'), type: 'number',
      placeholder: '20',
      desc: tr('Số giao dịch gần nhất cần lấy.'),
    },
    {
      key: 'fromDate', label: tr('Từ ngày (tùy chọn)'), type: 'text',
      placeholder: '2024-01-01', advanced: true,
    },
    {
      key: 'toDate', label: tr('Đến ngày (tùy chọn)'), type: 'text',
      placeholder: '2024-12-31', advanced: true,
    },
  ],

  // ─── GHN Express ─────────────────────────────────────────────────────────
  'ghn.createOrder': [
    {
      key: 'toName', label: tr('Tên người nhận'), type: 'text',
      placeholder: '{{ $trigger.fromName }}',
      desc: tr('Họ tên người nhận hàng.'),
      templateVars: ['$trigger.fromName'],
    },
    {
      key: 'toPhone', label: tr('SĐT người nhận'), type: 'text',
      placeholder: '{{ $trigger.fromPhone }}',
      templateVars: ['$trigger.fromPhone'],
    },
    {
      key: 'toAddress', label: tr('Địa chỉ giao hàng'), type: 'text',
      placeholder: tr('72 Lê Thánh Tôn'),
      desc: tr('Số nhà, tên đường (phường/xã và tỉnh nhập ở hai ô dưới).'),
    },
    {
      key: 'toWardName', label: tr('Phường/Xã nhận'), type: 'text',
      placeholder: tr('Phường Sài Gòn'),
      desc: tr('Tên phường/xã theo địa chỉ mới (sau 01/07/2025). Địa chỉ cũ thì nhập thêm Quận/Huyện ở phần nâng cao.'),
    },
    {
      key: 'toProvinceName', label: tr('Tỉnh/Thành phố nhận'), type: 'text',
      placeholder: tr('Hồ Chí Minh'),
    },
    {
      key: 'toDistrictName', label: tr('Quận/Huyện nhận (chỉ địa chỉ cũ)'), type: 'text',
      placeholder: tr('Quận 1'),
      desc: tr('Để trống với địa chỉ mới 2 cấp. Có Quận/Huyện thì GHN hiểu đây là địa chỉ cũ 3 cấp.'),
      advanced: true,
    },
    {
      key: 'toDistrictId', label: tr('ID Quận/Huyện GHN (cách cũ)'), type: 'number',
      placeholder: '1442',
      desc: tr('Chỉ dùng cho workflow cũ, thay bằng tên Phường/Xã + Tỉnh ở trên. Bị bỏ qua khi gửi địa chỉ mới.'),
      advanced: true,
    },
    {
      key: 'toWardCode', label: tr('Mã Phường/Xã GHN (cách cũ)'), type: 'text',
      placeholder: '20314',
      desc: tr('Chỉ dùng cho workflow cũ, thay bằng tên Phường/Xã + Tỉnh ở trên. Bị bỏ qua khi gửi địa chỉ mới.'),
      advanced: true,
    },
    {
      key: 'content', label: tr('Nội dung hàng hoá'), type: 'text',
      placeholder: tr('Áo thun x2'),
      desc: tr('GHN bắt buộc có nội dung hàng hoá hoặc danh sách items (trong JSON nâng cao).'),
    },
    {
      key: 'weight', label: tr('Trọng lượng (gram)'), type: 'number',
      placeholder: '500',
      desc: tr('Trọng lượng gói hàng tính bằng gram.'),
    },
    {
      key: 'serviceTypeId', label: tr('Loại dịch vụ'), type: 'select',
      options: [
        { value: '2', label: tr('2 - Hàng nhẹ (thường)') },
        { value: '5', label: tr('5 - Hàng nặng (thường)') },
      ],
      desc: tr('Loại dịch vụ GHN.'),
      advanced: true,
    },
    {
      key: 'codAmount', label: tr('Tiền thu hộ COD (VNĐ)'), type: 'number',
      placeholder: '0',
      desc: tr('0 nếu không thu tiền mặt khi giao.'),
      advanced: true,
    },
    {
      key: 'requiredNote', label: tr('Ghi chú giao hàng'), type: 'select',
      options: [
        { value: 'CHOXEMHANGKHONGTHU', label: tr('Cho xem hàng, không cho thử') },
        { value: 'CHOTHUHANG', label: tr('Cho thử hàng') },
        { value: 'KHONGCHOXEMHANG', label: tr('Không cho xem hàng') },
      ],
      desc: tr('Trường bắt buộc của GHN (required_note).'),
      advanced: true,
    },
    {
      key: 'paymentTypeId', label: tr('Người trả phí ship'), type: 'select',
      options: [
        { value: '1', label: tr('Shop trả') },
        { value: '2', label: tr('Người nhận trả') },
      ],
      desc: tr('Trường bắt buộc của GHN (payment_type_id).'),
      advanced: true,
    },
    {
      key: 'order', label: tr('Tham số nâng cao (JSON)'), type: 'json',
      hint: tr('{"insurance_value": 150000, "length": 20, "width": 15, "height": 10, "note": "Giao giờ hành chính"}'),
      desc: tr('Tham số tuỳ chọn bổ sung theo GHN API v2 (GHN bắt buộc length, width, height). Các ô ở trên ghi đè vào JSON này; riêng Ghi chú giao hàng, Người trả phí ship, Nội dung hàng hoá chỉ dùng khi JSON chưa có.'),
      advanced: true,
    },
  ],
  'ghn.getTracking': [
    {
      key: 'orderCode', label: tr('Mã vận đơn GHN'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Mã đơn GHN (order_code) để tra cứu trạng thái.'),
      templateVars: ['$trigger.content'],
    },
  ],
  'ghn.getProvinces': [],
  'ghn.getDistricts': [
    {
      key: 'provinceId', label: tr('Province ID'), type: 'number',
      placeholder: '201',
      desc: tr('ProvinceID do GHN cung cấp từ API Get Province.'),
    },
  ],
  'ghn.getWards': [
    {
      key: 'districtId', label: tr('District ID'), type: 'number',
      placeholder: '1442',
      desc: tr('DistrictID do GHN cung cấp từ API Get District.'),
    },
  ],
  'ghn.getServices': [
    {
      key: 'fromDistrict', label: tr('From District'), type: 'number',
      placeholder: '1447',
      desc: tr('Quận lấy hàng (from_district) theo docs GHN Available Services.'),
    },
    {
      key: 'toDistrict', label: tr('To District'), type: 'number',
      placeholder: '1442',
      desc: tr('Quận giao hàng (to_district) theo docs GHN Available Services.'),
    },
  ],

  // ─── GHTK ─────────────────────────────────────────────────────────────────
  'ghtk.createOrder': [
    {
      key: 'order', label: tr('Dữ liệu đơn hàng GHTK (JSON)'), type: 'json',
      hint: tr('{"order":{"id":"DH001","pick_name":"Cửa hàng ABC","pick_address":"123 Lê Lợi","pick_province":"Hồ Chí Minh","pick_ward":"Phường Sài Gòn","pick_tel":"0909123456","name":"Nguyễn Văn A","address":"456 Hàng Bài","province":"Hà Nội","ward":"Phường Hoàn Kiếm","street":"Hàng Bài","tel":"0901234567","value":150000,"transport":"road","pick_money":150000},"products":[{"name":"Áo thun","weight":0.5,"quantity":1,"price":150000}]}'),
      // "Khác" is the literal value GHTK expects, so it stays out of the translated text
      desc: tr('Đối tượng đơn hàng GHTK gồm order (thông tin giao) và products (khối lượng tính bằng kg). GHTK bắt buộc phường/xã (pick_ward, ward) và tên đường (street) hoặc thôn/xóm (hamlet, không có thì ghi {{other}}); quận/huyện không bắt buộc. Xem api.ghtk.vn để biết đầy đủ các trường.', { other: '"Khác"' }),
    },
  ],
  'ghtk.getTracking': [
    {
      key: 'trackingCode', label: tr('Mã tracking GHTK'), type: 'text',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Mã tracking (label) để tra cứu trạng thái vận đơn GHTK.'),
      templateVars: ['$trigger.content'],
    },
  ],

  // ─── Facebook triggers ──────────────────────────────────────────────────────
  'fb.trigger.message': [
    {
      key: 'threadType', label: tr('Nguồn tin nhắn'), type: 'choice', section: tr('Phạm vi'),
      desc: tr('Workflow sẽ lắng nghe tin nhắn từ đâu?'),
      options: [
        { value: 'all', label: tr('Tất cả (cá nhân + nhóm)') },
        { value: '0',   label: tr('Chỉ tin nhắn cá nhân') },
        { value: '1',   label: tr('Chỉ tin nhắn nhóm') },
      ],
    },
    {
      key: 'groupId', label: tr('Chỉ nhận từ nhóm cụ thể'), type: 'contact-picker', contactType: 'group', section: tr('Phạm vi'),
      placeholder: tr('Để trống = tất cả các nhóm'),
      desc: tr('Chọn một nhóm cụ thể để lắng nghe. Để trống = nhận từ tất cả nhóm.'),
      advanced: true,
    },
    {
      key: 'threadId', label: tr('Chỉ nhận từ hội thoại cụ thể'), type: 'contact-picker', contactType: 'all', section: tr('Phạm vi'),
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả hội thoại.'),
      advanced: true,
    },
    {
      // includeThreadIds + excludeThreadIds (ThreadScopeField)
      key: 'includeThreadIds', label: tr('Chat / nhóm áp dụng'), type: 'thread-scope', section: tr('Phạm vi'),
      contactType: 'all', channel: 'facebook',
    },
    {
      key: 'fromId', label: tr('Chỉ nhận từ người dùng cụ thể'), type: 'contact-picker', contactType: 'user', section: tr('Người gửi'),
      placeholder: tr('Để trống = tất cả mọi người'),
      desc: tr('Chọn một người cụ thể để lắng nghe. Để trống = nhận từ tất cả.'),
      advanced: true,
    },
    {
      key: 'excludeSenderIds', label: tr('Loại trừ người gửi'), type: 'contact-picker', section: tr('Người gửi'),
      contactType: 'user', contactMode: 'multi', channel: 'facebook',
      placeholder: tr('Để trống = không loại trừ ai'),
      desc: tr('Tin nhắn từ những người được chọn sẽ không kích hoạt workflow.'),
    },
    {
      key: 'ignoreOwn', label: tr('Bỏ qua tin nhắn do mình gửi'), type: 'boolean', section: tr('Người gửi'),
      desc: tr('Bật để tránh workflow tự kích hoạt khi tài khoản này tự gửi tin.'),
    },
    {
      key: 'onlyOwn', label: tr('Chỉ xử lý tin mình tự gửi'), type: 'boolean', section: tr('Người gửi'),
      desc: tr('Ngược lại - chỉ chạy với tin nhắn từ chính tài khoản này.'),
    },
    {
      key: 'keyword', label: tr('Từ khóa kích hoạt'), type: 'text', section: tr('Nội dung'),
      placeholder: tr('giá, báo giá, order'),
      desc: tr('Workflow chỉ chạy khi tin nhắn chứa một trong các từ khóa này. Nhập nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = mọi tin nhắn đều kích hoạt.'),
    },
    {
      key: 'keywordMode', label: tr('Cách khớp từ khóa'), type: 'select', section: tr('Nội dung'),
      desc: tr('Quy tắc áp dụng khi kiểm tra từ khóa trong tin nhắn.'),
      options: [
        { value: 'contains_any', label: tr('Chứa ít nhất 1 từ khóa (phổ biến nhất)') },
        { value: 'contains_all', label: tr('Phải chứa đủ tất cả từ khóa') },
        { value: 'equals',       label: tr('Khớp chính xác nguyên câu') },
        { value: 'starts_with',  label: tr('Bắt đầu bằng từ khóa') },
        { value: 'regex',        label: tr('Regex - biểu thức chính quy (nâng cao)') },
      ],
    },
    {
      key: 'activeHours', label: tr('Khung giờ hoạt động'), type: 'time-window', section: tr('Thời gian & tần suất'),
      desc: tr('Trong khung giờ: chỉ chạy trong giờ đã chọn. Ngoài khung giờ: chỉ chạy ngoài giờ đó, vd. tự động trả lời ngoài giờ làm việc.'),
    },
    {
      key: 'cooldownMinutes', label: tr('Giới hạn tần suất (phút)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0', min: 0,
      desc: tr('Sau khi workflow chạy cho một hội thoại, các tin nhắn tiếp theo từ hội thoại đó bị bỏ qua trong N phút (vd. 60 = tối đa 1 lần mỗi giờ). 0 = tắt. Bộ đếm được đặt lại khi khởi động lại ứng dụng.'),
    },
    {
      key: 'debounceSeconds', label: tr('Gom tin nhắn liên tiếp (giây)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0',
      desc: tr('Chờ N giây sau tin nhắn cuối cùng rồi mới chạy workflow (gom tất cả tin nhắn liên tiếp thành 1 lần xử lý). 0 = chạy ngay mỗi tin.'),
      advanced: true,
    },
  ],
  'fb.trigger.image': [
    {
      key: 'threadId', label: tr('Chỉ nhận từ hội thoại cụ thể'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.'),
      advanced: true,
    },
  ],
  'fb.trigger.video': [
    {
      key: 'threadId', label: tr('Chỉ nhận từ hội thoại cụ thể'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.'),
      advanced: true,
    },
  ],
  'fb.trigger.file': [
    {
      key: 'threadId', label: tr('Chỉ nhận từ hội thoại cụ thể'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.'),
      advanced: true,
    },
  ],
  'fb.trigger.sticker': [
    {
      key: 'threadId', label: tr('Chỉ nhận từ hội thoại cụ thể'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('ID hội thoại Facebook muốn lắng nghe. Để trống = nhận từ tất cả.'),
      advanced: true,
    },
  ],
  'fb.trigger.reaction': [
    {
      key: 'reactionType', label: tr('Loại cảm xúc'), type: 'select',
      desc: tr('Workflow chạy khi tin nhắn nhận được cảm xúc nào?'),
      options: [
        { value: 'any', label: tr('Bất kỳ cảm xúc nào') },
        { value: '👍',  label: tr('Like') },
        { value: '❤️',  label: tr('Yêu thích') },
        { value: '😂',  label: tr('Haha') },
        { value: '😮',  label: tr('Wow') },
        { value: '😢',  label: tr('Buồn') },
        { value: '😡',  label: tr('Giận') },
      ],
    },
    {
      key: 'threadId', label: tr('Chỉ theo dõi hội thoại cụ thể'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('ID hội thoại cụ thể muốn theo dõi. Để trống = tất cả.'),
      advanced: true,
    },
  ],
  'fb.trigger.unsend': [
    {
      key: 'threadId', label: tr('Chỉ theo dõi hội thoại cụ thể'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('ID hội thoại cụ thể muốn theo dõi sự kiện thu hồi. Để trống = tất cả.'),
      advanced: true,
    },
  ],
  'fb.trigger.groupEvent': [
    {
      key: 'eventType', label: tr('Sự kiện cần theo dõi'), type: 'select',
      desc: tr('Chọn loại sự kiện trong nhóm Facebook sẽ kích hoạt workflow.'),
      options: [
        { value: 'all',              label: tr('Mọi sự kiện nhóm') },
        { value: 'participant_added', label: tr('Thành viên mới tham gia') },
        { value: 'participant_left',  label: tr('Thành viên rời nhóm') },
      ],
    },
    {
      key: 'threadId', label: tr('Chỉ theo dõi nhóm cụ thể'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('Để trống = theo dõi tất cả nhóm'),
      desc: tr('Chọn một nhóm Facebook để chỉ lắng nghe sự kiện từ nhóm đó.'),
      advanced: true,
    },
  ],

  // ─── Facebook Actions ────────────────────────────────────────────────────
  'fb.action.sendMessage': [
    {
      key: 'message', label: tr('Nội dung tin nhắn'), type: 'textarea', section: tr('Nội dung'),
      placeholder: tr('Xin chào! Mình có thể giúp gì?'),
      desc: tr('Nội dung tin nhắn gửi đi. Dùng {{ }} để chèn dữ liệu động.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.threadId'],
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', section: tr('Người nhận'),
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại Facebook để gửi. Nếu không chọn, sẽ dùng hội thoại từ trigger.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi tin nhắn này gửi lỗi.'),
      advanced: true,
    },
  ],
  'fb.action.sendImage': [
    {
      key: 'filePath', label: tr('Tệp đính kèm cần gửi'), type: 'file-picker', fileType: 'file',
      desc: tr('Chọn ảnh, video, audio hoặc file từ máy tính để gửi.'),
    },
    {
      key: 'body', label: tr('Chú thích (tuỳ chọn)'), type: 'text',
      placeholder: tr('Cảm ơn bạn đã mua hàng!'),
      desc: tr('Nội dung văn bản đi kèm ảnh (caption). Để trống nếu chỉ gửi ảnh.'),
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all',
      contactMode: 'multi',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('Chọn một hoặc nhiều hội thoại Facebook để gửi tệp.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean',
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi gửi tệp lỗi.'),
      advanced: true,
    },
  ],
  'fb.action.sendVideo': [
    {
      key: 'filePath', label: tr('Video cần gửi'), type: 'file-picker', fileType: 'file',
      desc: tr('Chọn file video từ máy tính để gửi.'),
    },
    {
      key: 'body', label: tr('Chú thích (tuỳ chọn)'), type: 'text',
      placeholder: tr('Xem video giới thiệu sản phẩm!'),
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all',
      contactMode: 'multi', placeholder: '{{ $trigger.threadId }}', templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', advanced: true,
    },
  ],
  'fb.action.sendFile': [
    {
      key: 'filePath', label: tr('File cần gửi'), type: 'file-picker', fileType: 'file',
      desc: tr('Chọn file (PDF, Excel, ...) từ máy tính để gửi.'),
    },
    {
      key: 'body', label: tr('Chú thích (tuỳ chọn)'), type: 'text',
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all',
      contactMode: 'multi', placeholder: '{{ $trigger.threadId }}', templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', advanced: true,
    },
  ],
  'fb.action.sendAudio': [
    {
      key: 'filePath', label: tr('File audio cần gửi'), type: 'file-picker', fileType: 'file',
      desc: tr('Chọn file âm thanh từ máy tính để gửi.'),
    },
    {
      key: 'body', label: tr('Chú thích (tuỳ chọn)'), type: 'text',
    },
    {
      key: 'threadIds', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all',
      contactMode: 'multi', placeholder: '{{ $trigger.threadId }}', templateVars: ['$trigger.threadId'],
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', advanced: true,
    },
  ],
  'fb.action.addReaction': [
    {
      key: 'emoji', label: tr('Biểu tượng cảm xúc'), type: 'select',
      desc: tr('Chọn emoji reaction để thả vào tin nhắn.'),
      options: [
        { value: '👍', label: tr('Like') },
        { value: '❤️', label: tr('Yêu thích') },
        { value: '😂', label: tr('Haha') },
        { value: '😮', label: tr('Wow') },
        { value: '😢', label: tr('Buồn') },
        { value: '😡', label: tr('Giận') },
      ],
    },
    {
      key: 'messageId', label: tr('ID tin nhắn cần react'), type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: tr('ID tin nhắn Facebook muốn thả reaction.'),
      templateVars: ['$trigger.messageId'],
      advanced: true,
    },
  ],
  'fb.action.unsend': [
    {
      key: 'messageId', label: tr('ID tin nhắn cần thu hồi'), type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: tr('ID tin nhắn Facebook muốn thu hồi (xóa 2 phía).'),
      templateVars: ['$trigger.messageId'],
    },
  ],
  'fb.action.editMessage': [
    {
      key: 'messageId', label: tr('ID tin nhắn cần chỉnh sửa'), type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: tr('ID tin nhắn Facebook muốn chỉnh sửa nội dung.'),
      templateVars: ['$trigger.messageId'],
    },
    {
      key: 'text', label: tr('Nội dung mới'), type: 'textarea',
      placeholder: tr('Nhập nội dung mới cho tin nhắn...'),
      desc: tr('Nội dung sẽ thay thế tin nhắn cũ.'),
    },
  ],
  'fb.action.forward': [
    {
      key: 'message', label: tr('Nội dung gửi lại'), type: 'textarea',
      placeholder: '{{ $trigger.content }}',
      desc: tr('Node này chỉ gửi lại văn bản. Dùng “Chuyển tiếp đa kênh” khi cần chuyển cả tin gốc, ảnh, video hoặc file.'),
      templateVars: ['$trigger.content'],
    },
    {
      key: 'messageId', label: tr('ID tin nhắn gốc (không dùng)'), type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: tr('Được giữ để tương thích workflow cũ. Node này không có API forward gốc; hãy dùng “Chuyển tiếp đa kênh”.'),
      templateVars: ['$trigger.messageId'],
      advanced: true,
    },
    {
      key: 'targetThreadId', label: tr('Chuyển đến hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: tr('ID hội thoại đích'),
      desc: tr('ID hội thoại Facebook nơi tin nhắn sẽ được chuyển đến.'),
    },
    {
      key: 'accountId', label: tr('Tài khoản Facebook'), type: 'text',
      desc: tr('Nhập ID tài khoản Facebook để gửi tin nhắn.'),
      advanced: true,
      placeholder: '{{ $trigger.fbAccountId }}',
      templateVars: ['$trigger.fbAccountId'],
    },
  ],
  'fb.action.pin': [
    {
      key: 'messageId', label: tr('ID tin nhắn cần ghim'), type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: tr('ID tin nhắn Facebook muốn ghim trong hội thoại.'),
      templateVars: ['$trigger.messageId'],
    },
    {
      key: 'threadId', label: tr('Trong nhóm'), type: 'contact-picker', contactType: 'group',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID nhóm Facebook chứa tin nhắn cần ghim.'),
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'fb.action.unpin': [
    {
      key: 'messageId', label: tr('ID tin nhắn cần bỏ ghim'), type: 'text',
      placeholder: '{{ $trigger.messageId }}',
      desc: tr('ID tin nhắn Facebook muốn bỏ ghim.'),
      templateVars: ['$trigger.messageId'],
    },
    {
      key: 'threadId', label: tr('Trong nhóm'), type: 'contact-picker', contactType: 'group',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID nhóm Facebook chứa tin nhắn cần bỏ ghim.'),
      templateVars: ['$trigger.threadId'],
      advanced: true,
    },
  ],
  'fb.action.createPoll': [
    {
      key: 'question', label: tr('Câu hỏi bình chọn'), type: 'text',
      placeholder: tr('Bạn thích sản phẩm nào nhất?'),
      desc: tr('Nội dung câu hỏi hiển thị trong poll Facebook.'),
    },
    {
      key: 'options', label: tr('Các lựa chọn'), type: 'multiline',
      placeholder: tr('Sản phẩm A\nSản phẩm B\nSản phẩm C'),
      desc: tr('Mỗi dòng là một lựa chọn. Nhập ít nhất 2 lựa chọn.'),
    },
    {
      key: 'threadId', label: tr('Tạo trong nhóm'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('ID nhóm Facebook'),
      desc: tr('ID nhóm Facebook nơi poll sẽ được tạo.'),
    },
  ],
  'fb.action.sendTyping': [
    {
      key: 'threadId', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại Facebook cần gửi trạng thái đang gõ.'),
      templateVars: ['$trigger.threadId'],
    },
    {
      key: 'isTyping', label: tr('Trạng thái'), type: 'select',
      desc: tr('Bật để hiển thị "đang gõ...", tắt để ẩn.'),
      options: [
        { value: 'true', label: tr('Đang gõ...') },
        { value: 'false', label: tr('Ẩn trạng thái') },
      ],
    },
  ],
  'fb.action.markAsRead': [
    {
      key: 'threadId', label: tr('Đánh dấu hội thoại'), type: 'contact-picker', contactType: 'all',
      placeholder: '{{ $trigger.threadId }}',
      desc: tr('ID hội thoại Facebook muốn đánh dấu đã đọc.'),
      templateVars: ['$trigger.threadId'],
    },
  ],
  'fb.action.block': [
    {
      key: 'userId', label: tr('User ID cần chặn'), type: 'contact-picker', contactType: 'user',
      placeholder: '{{ $trigger.fromId }}',
      desc: tr('ID người dùng Facebook muốn chặn.'),
      templateVars: ['$trigger.fromId'],
    },
  ],
  'fb.action.changeName': [
    {
      key: 'threadId', label: tr('Nhóm cần đổi tên'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('ID nhóm Facebook'),
      desc: tr('ID nhóm Facebook muốn đổi tên.'),
    },
    {
      key: 'name', label: tr('Tên mới của nhóm'), type: 'text',
      placeholder: tr('Nhập tên mới cho nhóm'),
      desc: tr('Tên mới sẽ được đặt cho nhóm Facebook.'),
    },
  ],
  'fb.action.changeEmoji': [
    {
      key: 'threadId', label: tr('Nhóm cần đổi biểu tượng'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('ID nhóm Facebook'),
      desc: tr('ID nhóm Facebook muốn đổi emoji đại diện.'),
    },
    {
      key: 'emoji', label: tr('Biểu tượng mới'), type: 'text',
      placeholder: '😊',
      desc: tr('Emoji mới làm biểu tượng đại diện cho nhóm.'),
    },
  ],
  'fb.action.changeNickname': [
    {
      key: 'threadId', label: tr('Trong nhóm'), type: 'contact-picker', contactType: 'group',
      placeholder: tr('ID nhóm Facebook'),
      desc: tr('ID nhóm Facebook chứa thành viên cần đổi biệt danh.'),
    },
    {
      key: 'userId', label: tr('Thành viên cần đổi biệt danh'), type: 'contact-picker', contactType: 'user',
      placeholder: tr('ID người dùng'),
      desc: tr('ID người dùng Facebook muốn đổi biệt danh trong nhóm.'),
    },
    {
      key: 'nickname', label: tr('Biệt danh mới'), type: 'text',
      placeholder: tr('Nhập biệt danh mới'),
      desc: tr('Biệt danh mới trong nhóm cho thành viên này.'),
    },
  ],

  // ─── Telegram triggers ──────────────────────────────────────────────────────
  'tg.trigger.message': [
    {
      key: 'chatType', label: tr('Nguồn tin nhắn'), type: 'choice', section: tr('Phạm vi'),
      desc: tr('Workflow sẽ lắng nghe tin nhắn từ đâu?'),
      options: [
        { value: 'all', label: tr('Tất cả (cá nhân + nhóm + channel + topic)') },
        { value: 'user', label: tr('Chỉ tin nhắn 1-1 (cá nhân)') },
        { value: 'group', label: tr('Chỉ tin nhắn nhóm (group/supergroup)') },
        { value: 'channel', label: tr('Chỉ tin nhắn kênh (channel)') },
        { value: 'topic', label: tr('Chỉ tin nhắn trong topic (forum)') },
      ],
    },
    {
      key: 'chatId', label: tr('Chỉ nhận từ hội thoại cụ thể'), type: 'contact-picker', section: tr('Phạm vi'),
      contactType: 'all', channel: 'telegram_user',
      placeholder: tr('Để trống = tất cả hội thoại'),
      desc: tr('Chọn hội thoại Telegram muốn lắng nghe. Để trống = nhận từ tất cả.'),
    },
    {
      // includeThreadIds + excludeThreadIds (ThreadScopeField)
      key: 'includeThreadIds', label: tr('Chat / nhóm áp dụng'), type: 'thread-scope', section: tr('Phạm vi'),
      contactType: 'all', channel: 'telegram_user',
    },
    {
      key: 'fromId', label: tr('Chỉ nhận từ người gửi cụ thể'), type: 'contact-picker', section: tr('Người gửi'),
      contactType: 'user', channel: 'telegram_user',
      placeholder: tr('Để trống = tất cả'),
      desc: tr('Chọn người gửi cụ thể. Để trống = nhận từ tất cả.'),
      advanced: true,
    },
    {
      key: 'excludeSenderIds', label: tr('Loại trừ người gửi'), type: 'contact-picker', section: tr('Người gửi'),
      contactType: 'user', contactMode: 'multi', channel: 'telegram_user',
      placeholder: tr('Để trống = không loại trừ ai'),
      desc: tr('Tin nhắn từ những người được chọn sẽ không kích hoạt workflow.'),
    },
    {
      key: 'ignoreOwn', label: tr('Bỏ qua tin nhắn do mình gửi'), type: 'boolean', section: tr('Người gửi'),
      desc: tr('Bật để tránh workflow tự kích hoạt khi tài khoản tự gửi tin.'),
    },
    {
      key: 'keyword', label: tr('Từ khóa kích hoạt'), type: 'text', section: tr('Nội dung'),
      placeholder: tr('giá, báo giá, order'),
      desc: tr('Workflow chỉ chạy khi tin nhắn chứa một trong các từ khóa. Nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = mọi tin nhắn.'),
    },
    {
      key: 'keywordMode', label: tr('Cách khớp từ khóa'), type: 'select', section: tr('Nội dung'),
      desc: tr('Quy tắc áp dụng khi kiểm tra từ khóa trong tin nhắn.'),
      options: [
        { value: 'contains_any', label: tr('Chứa ít nhất 1 từ khóa (phổ biến nhất)') },
        { value: 'contains_all', label: tr('Phải chứa đủ tất cả từ khóa') },
        { value: 'exact', label: tr('Khớp chính xác nguyên câu') },
        { value: 'starts_with', label: tr('Bắt đầu bằng từ khóa') },
      ],
    },
    {
      key: 'activeHours', label: tr('Khung giờ hoạt động'), type: 'time-window', section: tr('Thời gian & tần suất'),
      desc: tr('Trong khung giờ: chỉ chạy trong giờ đã chọn. Ngoài khung giờ: chỉ chạy ngoài giờ đó, vd. tự động trả lời ngoài giờ làm việc.'),
    },
    {
      key: 'cooldownMinutes', label: tr('Giới hạn tần suất (phút)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0', min: 0,
      desc: tr('Sau khi workflow chạy cho một hội thoại, các tin nhắn tiếp theo từ hội thoại đó bị bỏ qua trong N phút (vd. 60 = tối đa 1 lần mỗi giờ). 0 = tắt. Bộ đếm được đặt lại khi khởi động lại ứng dụng.'),
    },
    {
      key: 'debounceSeconds', label: tr('Chờ gom tin nhắn (giây)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0',
      desc: tr('Chờ N giây sau tin nhắn cuối rồi mới chạy. 0 = chạy ngay mỗi tin.'),
      advanced: true,
    },
  ],
  'tg.trigger.unsend': [
    { key: 'chatId', label: tr('Hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: tr('Để trống = tất cả') },
  ],
  'tg.trigger.groupEvent': [
    { key: 'chatId', label: tr('Nhóm cụ thể'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: tr('Để trống = tất cả nhóm') },
    { key: 'eventType', label: tr('Loại sự kiện'), type: 'select', options: [
      { value: 'all', label: tr('Tất cả') },
      { value: 'join', label: tr('Thành viên vào nhóm') },
      { value: 'leave', label: tr('Thành viên rời nhóm') },
      { value: 'member_join', label: tr('Có người mới tham gia') },
      { value: 'member_leave', label: tr('Có người rời đi') },
    ]},
  ],

  // ─── Telegram Bot triggers ───────────────────────────────────────────────
  'tgbot.trigger.message': [
    { key: 'chatScope', label: tr('Nguồn chat'), type: 'select', options: [
      { value: 'all', label: tr('Tất cả chat Bot nhận được') },
      { value: 'private', label: tr('Chat riêng') },
      { value: 'group', label: tr('Nhóm và supergroup') },
      { value: 'channel', label: tr('Channel post') },
    ], desc: tr('Trong nhóm, Bot có thể không nhận toàn bộ tin nếu Privacy Mode đang bật.') },
    { key: 'chatId', label: tr('Chat cụ thể'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: tr('Để trống = tất cả chat'), templateVars: ['$trigger.chatId'] },
    { key: 'includeThreadIds', label: tr('Chat / nhóm áp dụng'), type: 'thread-scope', contactType: 'all', channel: 'telegram_bot' },
    { key: 'messageTypes', label: tr('Loại nội dung'), type: 'select', options: [
      { value: 'all', label: tr('Mọi loại nội dung') },
      { value: 'text', label: tr('Văn bản') },
      { value: 'photo', label: tr('Ảnh') },
      { value: 'video', label: tr('Video') },
      { value: 'file', label: tr('File / tài liệu') },
      { value: 'voice', label: tr('Voice') },
      { value: 'sticker', label: tr('Sticker') },
      { value: 'location', label: tr('Vị trí') },
      { value: 'contact', label: tr('Liên hệ') },
      { value: 'poll', label: tr('Bình chọn') },
    ] },
    { key: 'keyword', label: tr('Từ khóa'), type: 'text', placeholder: tr('VD: báo giá, hỗ trợ'), desc: tr('Nhiều từ khóa cách nhau bằng dấu phẩy. Để trống = không lọc.'), templateVars: ['$trigger.content'] },
    { key: 'keywordMode', label: tr('Cách khớp từ khóa'), type: 'select', options: [
      { value: 'contains_any', label: tr('Chứa một trong các từ khóa') },
      { value: 'contains_all', label: tr('Chứa tất cả từ khóa') },
      { value: 'exact', label: tr('Khớp đúng toàn bộ nội dung') },
      { value: 'starts_with', label: tr('Bắt đầu bằng từ khóa') },
    ], advanced: true },
    { key: 'fromId', label: tr('Chỉ nhận từ Telegram user ID'), type: 'text', placeholder: tr('Để trống = tất cả user'), advanced: true },
    { key: 'ignoreOwn', label: tr('Bỏ qua tin do Bot gửi'), type: 'boolean', desc: tr('Tránh workflow tự kích hoạt bởi tin nhắn Bot vừa gửi.') },
    { key: 'ignoreCommands', label: tr('Bỏ qua lệnh /...'), type: 'boolean', desc: tr('Lệnh như /start do trigger "Khi user gửi lệnh cho Bot" xử lý, tránh khách nhận 2 câu trả lời. Từ khoá bắt đầu bằng "/" vẫn nhận lệnh đó.') },
    {
      key: 'cooldownMinutes', label: tr('Giới hạn tần suất (phút)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0', min: 0,
      desc: tr('Sau khi workflow chạy cho một hội thoại, các tin nhắn tiếp theo từ hội thoại đó bị bỏ qua trong N phút (vd. 60 = tối đa 1 lần mỗi giờ). 0 = tắt. Bộ đếm được đặt lại khi khởi động lại ứng dụng.'),
    },
    {
      key: 'debounceSeconds', label: tr('Gom tin nhắn liên tiếp (giây)'), type: 'number', section: tr('Thời gian & tần suất'),
      placeholder: '0',
      desc: tr('Chờ N giây sau tin nhắn cuối cùng rồi mới chạy workflow (gom tất cả tin nhắn liên tiếp thành 1 lần xử lý). 0 = chạy ngay mỗi tin. Khuyến nghị 10-15s khi dùng AI trả lời tự động, tránh AI phản hồi từng tin khi khách gõ liên tục.'),
      advanced: true,
    },
  ],
  'tgbot.trigger.command': [
    { key: 'chatScope', label: tr('Nguồn chat'), type: 'select', options: [
      { value: 'all', label: tr('Mọi chat') }, { value: 'private', label: tr('Chat riêng') }, { value: 'group', label: tr('Nhóm và supergroup') },
    ] },
    { key: 'chatId', label: tr('Chat cụ thể'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: tr('Để trống = tất cả chat'), templateVars: ['$trigger.chatId'] },
    { key: 'includeThreadIds', label: tr('Chat / nhóm áp dụng'), type: 'thread-scope', contactType: 'all', channel: 'telegram_bot' },
    { key: 'command', label: tr('Lệnh chính'), type: 'text', placeholder: '/start', desc: tr('Để trống = nhận mọi lệnh. Có thể nhập /start hoặc start.') },
    { key: 'aliases', label: tr('Lệnh thay thế'), type: 'text', placeholder: '/begin, /menu', desc: tr('Các lệnh tương đương, cách nhau bằng dấu phẩy.'), advanced: true },
    { key: 'argumentContains', label: tr('Tham số phải chứa'), type: 'text', placeholder: tr('VD: premium'), desc: tr('Chỉ kích hoạt nếu phần sau lệnh có cụm này.'), advanced: true },
    { key: 'authorizedUsers', label: tr('Chỉ Telegram user ID'), type: 'text', placeholder: '123456, 987654', desc: tr('Để trống = mọi người. Nhiều ID cách nhau bằng dấu phẩy.'), advanced: true },
    { key: 'ignoreOwn', label: tr('Bỏ qua lệnh do Bot gửi'), type: 'boolean' },
  ],
  'tgbot.trigger.callback': [
    { key: 'chatId', label: tr('Chat cụ thể'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: tr('Để trống = tất cả chat'), templateVars: ['$trigger.chatId'] },
    { key: 'callbackData', label: tr('Callback data cần khớp'), type: 'text', placeholder: tr('Để trống = nhận mọi inline button'), desc: tr('Chỉ dùng cho callback tùy chỉnh. Nút “Đi đến node” tự chạy nhánh node đã chọn trên canvas.') },
  ],
  'tgbot.trigger.editedMessage': [
    { key: 'chatScope', label: tr('Nguồn chat'), type: 'select', options: [
      { value: 'all', label: tr('Mọi chat') }, { value: 'private', label: tr('Chat riêng') }, { value: 'group', label: tr('Nhóm và supergroup') }, { value: 'channel', label: tr('Channel') },
    ] },
    { key: 'chatId', label: tr('Chat cụ thể'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: tr('Để trống = tất cả chat') },
    { key: 'keyword', label: tr('Nội dung mới chứa'), type: 'text', placeholder: tr('Để trống = mọi tin được sửa'), advanced: true },
    { key: 'keywordMode', label: tr('Cách khớp'), type: 'select', options: [
      { value: 'contains_any', label: tr('Chứa một từ khóa') }, { value: 'contains_all', label: tr('Chứa tất cả') }, { value: 'exact', label: tr('Khớp chính xác') }, { value: 'starts_with', label: tr('Bắt đầu bằng') },
    ], advanced: true },
  ],
  'tgbot.trigger.joinRequest': [
    { key: 'chatId', label: tr('Nhóm cụ thể'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: tr('Để trống = mọi nhóm') },
    { key: 'info', label: tr('Yêu cầu quyền'), type: 'info', desc: tr('Bot phải là admin trong nhóm và có quyền mời user. Nối node "Duyệt yêu cầu vào nhóm" để duyệt hoặc từ chối; Bot nhắn riêng được cho người xin vào trong lúc yêu cầu chưa xử lý.') },
  ],
  'tgbot.trigger.memberUpdate': [
    { key: 'chatId', label: tr('Nhóm cụ thể'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: tr('Để trống = mọi nhóm') },
    { key: 'eventType', label: tr('Sự kiện'), type: 'select', options: [
      { value: 'joined', label: tr('Thành viên mới vào nhóm') },
      { value: 'left', label: tr('Thành viên tự rời nhóm') },
      { value: 'removed', label: tr('Thành viên bị xoá / cấm') },
      { value: 'all', label: tr('Mọi thay đổi thành viên') },
    ] },
    { key: 'ignoreBots', label: tr('Bỏ qua Bot khác'), type: 'boolean', desc: tr('Không kích hoạt khi tài khoản vào / rời nhóm là một Bot.') },
    { key: 'info', label: tr('Yêu cầu quyền'), type: 'info', desc: tr('Telegram chỉ báo sự kiện thành viên cho Bot là admin của nhóm.') },
  ],
  'tgbot.trigger.join': [
    { key: 'chatId', label: tr('Nhóm cụ thể'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: tr('Để trống = mọi nhóm') },
    { key: 'eventType', label: tr('Sự kiện Bot trong nhóm'), type: 'select', options: [
      { value: 'all', label: tr('Tất cả thay đổi thành viên của Bot') },
      { value: 'added', label: tr('Bot được thêm vào nhóm') },
      { value: 'removed', label: tr('Bot bị gỡ khỏi nhóm') },
      { value: 'permissions_changed', label: tr('Quyền của Bot thay đổi') },
    ], desc: tr('Telegram chỉ gửi sự kiện này cho chính Bot. Admin phải thêm Bot bằng @username hoặc link mời; Bot không thể tự thêm mình vào nhóm.') },
  ],

  // ─── Telegram Bot actions ────────────────────────────────────────────────
  'tgbot.action.sendPhoto': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'photoPath', label: tr('Ảnh cần gửi'), type: 'file-picker', fileType: 'image', desc: tr('Chọn ảnh từ máy tính để gửi.') },
    { key: 'caption', label: tr('Chú thích'), type: 'textarea', placeholder: tr('Không bắt buộc'), advanced: true, templateVars: ['$trigger.content'] },
  ],
  'tgbot.action.sendVideo': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'videoPath', label: tr('Video cần gửi'), type: 'file-picker', fileType: 'file', desc: tr('Chọn video từ máy tính để gửi.') },
    { key: 'caption', label: tr('Chú thích'), type: 'textarea', placeholder: tr('Không bắt buộc'), advanced: true },
  ],
  'tgbot.action.sendFile': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: tr('File cần gửi'), type: 'file-picker', fileType: 'file' },
    { key: 'caption', label: tr('Chú thích'), type: 'textarea', placeholder: tr('Không bắt buộc'), advanced: true },
  ],
  'tgbot.action.forward': [
    { key: 'fromChatId', label: tr('Chat nguồn'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'targetChatId', label: tr('Chat nhận'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot' },
    { key: 'messageId', label: tr('ID tin nhắn'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.editMessage': [
    { key: 'chatId', label: tr('Chat chứa tin'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin nhắn'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'text', label: tr('Nội dung mới'), type: 'textarea', placeholder: tr('Nội dung thay thế') },
  ],
  'tgbot.action.deleteMessage': [
    { key: 'chatId', label: tr('Chat chứa tin'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin nhắn cần xóa'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.pinMessage': [
    { key: 'chatId', label: tr('Nhóm / channel'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin cần ghim'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.unpinMessage': [
    { key: 'chatId', label: tr('Nhóm / channel'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin cần bỏ ghim'), type: 'text', placeholder: tr('Để trống = bỏ ghim tin đang ghim'), templateVars: ['$trigger.messageId'] },
  ],
  'tgbot.action.addReaction': [
    { key: 'chatId', label: tr('Chat chứa tin'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin nhắn'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'emoji', label: tr('Emoji reaction'), type: 'text', placeholder: '👍' },
  ],
  'tgbot.action.sendPoll': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'question', label: tr('Câu hỏi'), type: 'text', placeholder: tr('Bạn chọn phương án nào?') },
    { key: 'options', label: tr('Các lựa chọn'), type: 'multiline', placeholder: tr('Lựa chọn 1\nLựa chọn 2'), desc: tr('Mỗi lựa chọn một dòng.') },
  ],
  'tgbot.action.sendChatAction': [
    { key: 'chatId', label: tr('Chat hiển thị trạng thái'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'action', label: tr('Trạng thái'), type: 'select', options: [
      { value: 'typing', label: tr('Đang gõ') }, { value: 'upload_photo', label: tr('Đang tải ảnh') }, { value: 'upload_document', label: tr('Đang tải file') }, { value: 'record_voice', label: tr('Đang thu voice') },
    ] },
  ],
  'tgbot.action.banMember': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Telegram user ID'), type: 'text', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
    { key: 'durationMinutes', label: tr('Thời gian cấm (phút)'), type: 'number', placeholder: '0', desc: tr('0 = cấm không thời hạn.'), advanced: true },
  ],
  'tgbot.action.restrictMember': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Telegram user ID'), type: 'text', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
    { key: 'durationMinutes', label: tr('Mute trong (phút)'), type: 'number', placeholder: '10', min: 1, desc: tr('Trong thời gian này user không thể gửi tin.') },
  ],
  'tgbot.action.sendSticker': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'stickerPath', label: tr('File sticker (webp)'), type: 'file-picker', fileType: 'file', desc: tr('Chọn file sticker định dạng webp để gửi.') },
  ],
  'tgbot.action.sendAudio': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'audioPath', label: tr('File audio (mp3)'), type: 'file-picker', fileType: 'file', desc: tr('Chọn file âm thanh để gửi.') },
    { key: 'caption', label: tr('Chú thích'), type: 'textarea', placeholder: tr('Không bắt buộc'), advanced: true },
  ],
  'tgbot.action.sendVoice': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'voicePath', label: tr('File ghi âm (ogg)'), type: 'file-picker', fileType: 'file', desc: tr('Chọn file voice note định dạng ogg để gửi.') },
    { key: 'caption', label: tr('Chú thích'), type: 'textarea', placeholder: tr('Không bắt buộc'), advanced: true },
  ],
  'tgbot.action.leaveChat': [
    { key: 'chatId', label: tr('Chat cần rời'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tgbot.action.unbanMember': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Telegram user ID'), type: 'text', placeholder: '123456789', templateVars: ['$trigger.fromId', '$trigger.memberId'], desc: tr('Bắt buộc. Người được bỏ cấm vào lại nhóm bằng link mời; ai đang ở trong nhóm thì không bị ảnh hưởng.') },
  ],
  'tgbot.action.approveJoinRequest': [
    { key: 'decision', label: tr('Xử lý yêu cầu'), type: 'select', options: [
      { value: 'approve', label: tr('Duyệt cho vào nhóm') },
      { value: 'decline', label: tr('Từ chối') },
    ] },
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Người xin vào (Telegram user ID)'), type: 'text', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
    { key: 'info', label: tr('Yêu cầu quyền'), type: 'info', desc: tr('Dùng sau trigger "Khi có yêu cầu vào nhóm". Bot phải là admin có quyền mời thành viên.') },
  ],
  'tgbot.action.sendMenu': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'text', label: tr('Nội dung menu'), type: 'text', placeholder: tr('Chọn một tùy chọn:') },
    { key: 'buttons', label: tr('Nút bấm (Inline Keyboard)'), type: 'json', hint: tr('[[{"text":"Mua","callback_data":"mua"},{"text":"Hỗ trợ","callback_data":"hotro"}]]'), desc: tr('Mảng 2 chiều các nút. Mỗi nút có "text" và "callback_data".') },
  ],
  'tgbot.action.sendForm': [
    { key: 'chatId', label: tr('Gửi đến chat'), type: 'contact-picker', contactType: 'all', channel: 'telegram_bot', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'text', label: tr('Tiêu đề form'), type: 'text', placeholder: tr('Vui lòng nhập thông tin:') },
    { key: 'fields', label: tr('Các trường form'), type: 'json', hint: tr('[{"label":"Họ tên","field_name":"name","required":true}]'), desc: tr('Mỗi trường có "label", "field_name" và "required".') },
  ],
  'tgbot.action.answerCallback': [
    { key: 'callbackQueryId', label: tr('Callback query ID'), type: 'text', placeholder: '{{ $trigger.callbackQueryId }}', templateVars: ['$trigger.callbackQueryId'] },
    { key: 'text', label: tr('Nội dung trả lời'), type: 'text', placeholder: tr('Không bắt buộc'), desc: tr('Thông báo ngắn hiện lên cho user (popup).') },
    { key: 'showAlert', label: tr('Hiện dạng alert (popup)'), type: 'boolean', desc: tr('Bật để hiện hộp thoại, tắt để hiện thông báo nhỏ.'), advanced: true },
  ],

  // ─── Telegram Actions ───────────────────────────────────────────────────────
  'tg.sendMessage': [
    {
      key: 'message', label: tr('Nội dung tin nhắn'), type: 'textarea', section: tr('Nội dung'),
      placeholder: tr('Xin chào! Mình có thể giúp gì?'),
      desc: tr('Nội dung tin nhắn gửi đi. Dùng {{ }} để chèn dữ liệu động.'),
      templateVars: ['$trigger.fromName', '$trigger.content', '$trigger.chatId'],
    },
    {
      key: 'chatId', label: tr('Gửi đến hội thoại'), type: 'contact-picker', section: tr('Người nhận'),
      contactType: 'all', channel: 'telegram_user',
      placeholder: '{{ $trigger.chatId }}',
      desc: tr('Chọn hội thoại Telegram cần gửi tin nhắn.'),
      templateVars: ['$trigger.chatId', '$trigger.fromId'],
    },
    {
      key: 'continueOnError', label: tr('Tiếp tục workflow dù gửi thất bại'), type: 'boolean', section: tr('Tùy chọn'),
      desc: tr('Bật nếu muốn các bước sau vẫn chạy ngay cả khi tin nhắn này gửi lỗi.'),
      advanced: true,
    },
  ],
  'tg.sendPhoto': [
    {
      key: 'chatId', label: tr('Gửi đến hội thoại'), type: 'contact-picker',
      contactType: 'all', channel: 'telegram_user',
      placeholder: '{{ $trigger.chatId }}',
      desc: tr('Chọn hội thoại Telegram cần gửi ảnh.'),
      templateVars: ['$trigger.chatId'],
    },
    {
      key: 'filePath', label: tr('Ảnh cần gửi'), type: 'file-picker', fileType: 'image',
      desc: tr('Chọn ảnh từ máy tính để gửi.'),
    },
    {
      key: 'caption', label: tr('Chú thích ảnh'), type: 'text',
      placeholder: tr('Để trống nếu không cần chú thích'),
      desc: tr('Chú thích hiển thị dưới ảnh. Dùng {{ }} để chèn dữ liệu động.'),
      templateVars: ['$trigger.content'],
      advanced: true,
    },
  ],
  'tg.sendFile': [
    { key: 'chatId', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: tr('File cần gửi'), type: 'file-picker', fileType: 'file', desc: tr('Chọn file (PDF, Excel, ...) để gửi.') },
    { key: 'caption', label: tr('Chú thích file'), type: 'text', advanced: true },
  ],
  'tg.sendVideo': [
    { key: 'chatId', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: tr('Video cần gửi'), type: 'file-picker', fileType: 'file', desc: tr('Chọn file video (mp4) để gửi.') },
    { key: 'caption', label: tr('Chú thích video'), type: 'text', advanced: true },
  ],
  'tg.sendVoice': [
    { key: 'chatId', label: tr('Gửi đến hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'filePath', label: tr('File ghi âm (ogg)'), type: 'file-picker', fileType: 'file', desc: tr('Chọn file voice note định dạng ogg để gửi.') },
    { key: 'caption', label: tr('Chú thích'), type: 'text', advanced: true },
  ],
  'tg.forwardMessage': [
    { key: 'fromChatId', label: tr('Từ hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', desc: tr('Hội thoại chứa tin nhắn cần chuyển tiếp.') },
    { key: 'toChatId', label: tr('Đến hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', desc: tr('Hội thoại nhận tin nhắn chuyển tiếp.') },
    { key: 'messageId', label: tr('ID tin nhắn'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tg.deleteMessage': [
    { key: 'chatId', label: tr('Trong hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin nhắn cần xóa'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tg.editMessage': [
    { key: 'chatId', label: tr('Trong hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin nhắn cần sửa'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'text', label: tr('Nội dung mới'), type: 'textarea', placeholder: tr('Nhập nội dung mới...') },
  ],
  'tg.addReaction': [
    { key: 'chatId', label: tr('Trong hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin nhắn'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
    { key: 'emoji', label: tr('Emoji'), type: 'select', options: [
      { value: '👍', label: tr('Like 👍') }, { value: '❤️', label: tr('Heart ❤️') },
      { value: '🔥', label: tr('Fire 🔥') }, { value: '🥰', label: tr('Love 🥰') },
      { value: '😮', label: tr('Wow 😮') }, { value: '😢', label: tr('Sad 😢') },
      { value: '🎉', label: tr('Party 🎉') }, { value: '👎', label: tr('Dislike 👎') },
    ]},
  ],
  'tg.pinMessage': [
    { key: 'chatId', label: tr('Trong hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'messageId', label: tr('ID tin nhắn cần ghim'), type: 'text', placeholder: '{{ $trigger.messageId }}', templateVars: ['$trigger.messageId'] },
  ],
  'tg.sendPoll': [
    { key: 'chatId', label: tr('Tạo trong hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'question', label: tr('Câu hỏi'), type: 'text', placeholder: tr('Bạn thích sản phẩm nào nhất?') },
    { key: 'options', label: tr('Các lựa chọn'), type: 'textarea', placeholder: tr('Lựa chọn 1\nLựa chọn 2\nLựa chọn 3'), desc: tr('Mỗi dòng 1 lựa chọn. Tối thiểu 2.') },
  ],
  'tg.banMember': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Thành viên cần ban'), type: 'contact-picker', contactType: 'user', channel: 'telegram_user', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'] },
  ],
  'tg.promoteMember': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Thành viên'), type: 'contact-picker', contactType: 'user', channel: 'telegram_user', placeholder: '{{ $trigger.fromId }}', templateVars: ['$trigger.fromId'], desc: tr('Bắt buộc chọn: để trống thì node báo lỗi, không tự lấy người vừa nhắn.') },
    { key: 'isAdmin', label: tr('Quyền admin'), type: 'select', options: [
      { value: 'true', label: tr('Thăng quyền admin') }, { value: 'false', label: tr('Hạ quyền thành viên') },
    ]},
  ],
  'tg.sendSticker': [
    { key: 'chatId', label: tr('Gửi đến'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'stickerId', label: tr('Sticker ID'), type: 'text', desc: tr('ID sticker từ Telegram sticker set.') },
    { key: 'accessHash', label: tr('Access Hash'), type: 'text', advanced: true },
  ],
  'tg.sendTyping': [
    { key: 'chatId', label: tr('Hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.markAsRead': [
    { key: 'chatId', label: tr('Hội thoại'), type: 'contact-picker', contactType: 'all', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.markTopicAsRead': [
    { key: 'chatId', label: tr('Nhóm (channel)'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'topicId', label: tr('Topic ID'), type: 'text', placeholder: '{{ $trigger.topicId }}', templateVars: ['$trigger.topicId'] },
  ],
  'tg.addMember': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Thành viên cần thêm'), type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.removeMember': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'userId', label: tr('Thành viên cần xóa'), type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.blockUser': [
    { key: 'userId', label: tr('Người cần chặn'), type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.unblockUser': [
    { key: 'userId', label: tr('Người cần bỏ chặn'), type: 'contact-picker', contactType: 'user', channel: 'telegram_user', templateVars: ['$trigger.fromId'] },
  ],
  'tg.changeGroupName': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'name', label: tr('Tên mới'), type: 'text', placeholder: tr('Tên nhóm mới') },
  ],
  'tg.leaveGroup': [
    { key: 'chatId', label: tr('Nhóm cần rời'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.exportInviteLink': [
    { key: 'chatId', label: tr('Nhóm'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
  ],
  'tg.createForumTopic': [
    { key: 'chatId', label: tr('Nhóm Forum'), type: 'contact-picker', contactType: 'group', channel: 'telegram_user', placeholder: '{{ $trigger.chatId }}', templateVars: ['$trigger.chatId'] },
    { key: 'title', label: tr('Tên topic'), type: 'text', placeholder: tr('Tên topic mới') },
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

const DEFAULT_SECTION  = tr('Cấu hình');
const ADVANCED_SECTION = tr('Nâng cao');

/** Section card icons, looked up by `Field.section` name (unknown names → SlidersIcon). */
// Keys are the translated section names, like Field.section (tr in CONFIG_SCHEMA): same lookup in every language
const SECTION_ICONS: Record<string, SectionIcon> = {
  [tr('Phạm vi')]: TargetIcon,
  [tr('Người gửi')]: UserIcon,
  [tr('Người nhận')]: UsersIcon,
  [tr('Nội dung')]: MessageSquareIcon,
  [tr('Tệp đính kèm')]: PaperclipIcon,
  [tr('Thời gian & tần suất')]: ClockIcon,
  [tr('Bộ lọc')]: FilterIcon,
  [tr('Điều kiện')]: FilterIcon,
  [tr('Tài khoản')]: ShieldIcon,
  [tr('Nguồn')]: DatabaseIcon,
  [tr('Tùy chọn')]: SlidersIcon,
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
// days uses JS getDay() numbering (0 = Sunday); empty = every day. Evaluated in Vietnam time.

type TimeWindowMode = 'always' | 'inside' | 'outside';
interface TimeWindowValue { mode: TimeWindowMode; start: string; end: string; days: number[] }

const TIME_WINDOW_DEFAULTS = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5, 6] };
const TIME_WINDOW_MODES: { value: TimeWindowMode; label: string }[] = [
  { value: 'always',  label: tr('Luôn hoạt động') },
  { value: 'inside',  label: tr('Trong khung giờ') },
  { value: 'outside', label: tr('Ngoài khung giờ') },
];
/** Monday-first display order → getDay() values. */
const TIME_WINDOW_DAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: 'T2', name: tr('Thứ 2') },
  { value: 2, short: 'T3', name: tr('Thứ 3') },
  { value: 3, short: 'T4', name: tr('Thứ 4') },
  { value: 4, short: 'T5', name: tr('Thứ 5') },
  { value: 5, short: 'T6', name: tr('Thứ 6') },
  { value: 6, short: 'T7', name: tr('Thứ 7') },
  { value: 0, short: 'CN', name: tr('Chủ nhật') },
];
const TIME_WINDOW_PRESETS: { label: string; start: string; end: string; days: number[] }[] = [
  { label: tr('Giờ hành chính'), start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5] },
  { label: tr('Cả tuần 8h–22h'), start: '08:00', end: '22:00', days: [0, 1, 2, 3, 4, 5, 6] },
  { label: tr('Ban đêm'),        start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] },
];

function describeTimeWindowDays(days: number[]): string {
  const ordered = TIME_WINDOW_DAYS.filter(d => days.includes(d.value));
  if (ordered.length === 0 || ordered.length === TIME_WINDOW_DAYS.length) return tr('mọi ngày');
  const positions = ordered.map(d => TIME_WINDOW_DAYS.indexOf(d));
  const contiguous = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
  if (contiguous && ordered.length >= 3) return `${ordered[0].name} – ${ordered[ordered.length - 1].name}`;
  return ordered.map(d => d.name).join(', ');
}

function describeTimeWindow(v: TimeWindowValue): string {
  const isTime = (t: string) => /^[0-9]{2}:[0-9]{2}$/.test(t);
  if (!isTime(v.start) || !isTime(v.end)) return tr('Hãy chọn đủ giờ bắt đầu và giờ kết thúc.');
  const range = v.start === v.end
    ? tr('cả ngày')
    : tr('từ {{start}} đến {{end}}{{v1}}', { start: v.start, end: v.end, v1: v.start > v.end ? tr(' (qua đêm)') : '' });
  const days = describeTimeWindowDays(v.days);
  return v.mode === 'outside'
    ? tr('Tạm dừng {{range}}, {{days}} — thời gian còn lại vẫn chạy.', { range, days })
    : tr('Chạy {{range}}, {{days}}.', { range, days });
}

function TimeWindowField({ value, onChange }: { value: unknown; onChange: (next: TimeWindowValue) => void }) {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Partial<TimeWindowValue>;
  const mode: TimeWindowMode = raw.mode === 'inside' || raw.mode === 'outside' ? raw.mode : 'always';
  // Missing values fall back to the defaults, so the first switch away from "always"
  // initialises start/end/days (08:00 - 17:30, Mon to Sat).
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
              <span className="block mb-1 text-[11px] font-medium wf-muted">{tr('Từ')}</span>
              <input type="time" value={current.start} onChange={e => emit({ start: e.target.value })} className={inputCls} />
            </label>
            <label className="block min-w-0">
              <span className="block mb-1 text-[11px] font-medium wf-muted">{tr('Đến')}</span>
              <input type="time" value={current.end} onChange={e => emit({ end: e.target.value })} className={inputCls} />
            </label>
          </div>
          <div>
            <span className="block mb-1.5 text-[11px] font-medium wf-muted">{tr('Ngày áp dụng')}</span>
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
            <span className="mr-0.5 text-[11px] font-medium wf-muted">{tr('Mẫu nhanh:')}</span>
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
          <span>{describeTimeWindow(current)} <span className="wf-faint">{tr('(giờ Việt Nam)')}</span></span>
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
    { icon: 'B',  title: tr('In đậm'),      action: () => wrap('<b>','</b>'),     cls: 'font-bold' },
    { icon: 'I',  title: tr('In nghiêng'),  action: () => wrap('<i>','</i>'),     cls: 'italic' },
    { icon: 'U',  title: tr('Gạch chân'),   action: () => wrap('<u>','</u>'),     cls: 'underline' },
    { icon: 'S',  title: tr('Gạch ngang'),  action: () => wrap('<s>','</s>'),     cls: 'line-through' },
    { icon: 'H1', title: tr('Tiêu đề'),     action: () => wrap('<h2>','</h2>'),   cls: '' },
    { icon: 'P',  title: tr('Đoạn văn'),    action: () => wrap('<p>','</p>'),     cls: '' },
    { icon: '↵',  title: tr('Xuống dòng'),  action: () => insertLine('<br/>'),    cls: '' },
    { icon: '≡',  title: tr('Danh sách'),   action: () => insertLine(tr('<ul>\n  <li>Mục 1</li>\n  <li>Mục 2</li>\n</ul>')), cls: '' },
    { icon: <LinkIcon className="w-3.5 h-3.5" />, title: tr('Liên kết'),    action: () => wrap('<a href="https://">','</a>'), cls: '' },
    { icon: '━',  title: tr('Đường kẻ'),    action: () => insertLine('<hr/>'),    cls: '' },
    { icon: <PaletteIcon className="w-3.5 h-3.5" />, title: tr('Màu chữ đỏ'),  action: () => wrap('<span style="color:#e11d48">','</span>'), cls: '' },
  ];

  return (
    <div className="wf-card wf-card--plain overflow-hidden transition-colors focus-within:border-[color:var(--wf-focus)]">
      {/* Tab bar (+ toolbar, wraps below the tabs when the panel is narrow) */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5 border-b border-[color:var(--wf-card-border)]">
        <div className="wf-seg flex-shrink-0">
          <button type="button" onClick={() => setTab('edit')}
            className="wf-seg__btn" data-active={String(tab === 'edit')}>
            {trx('<0/> Soạn thảo', { 0: <EditIcon className="w-3 h-3" /> })}
          </button>
          <button type="button" onClick={() => setTab('preview')}
            className="wf-seg__btn" data-active={String(tab === 'preview')}>
            {trx('<0/> Xem trước', { 0: <EyeIcon className="w-3 h-3" /> })}
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
            placeholder={placeholder || tr('<p>Xin chào <b>{{ $trigger.fromName }}</b>,</p>\n<p>{{ $trigger.content }}</p>')}
            rows={8}
            spellCheck={false}
            className="block w-full bg-transparent px-3 py-2.5 wf-mono leading-relaxed resize-none outline-none text-[color:var(--wf-text)] placeholder:text-[color:var(--wf-faint)]"
          />
          {/* Var chips inside editor */}
          {templateVars && templateVars.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 px-2.5 py-2 border-t border-[color:var(--wf-card-border)]">
              <span className="mr-0.5 text-[10.5px] font-medium wf-faint">{tr('Chèn:')}</span>
              {templateVars.map(v => (
                <button key={v} type="button"
                  onClick={() => { const tag = `{{ ${v} }}`; insertLine(tag); navigator.clipboard.writeText(tag).catch(() => {}); }}
                  title={tr('Chèn + copy: {{ {{v}} }}', { v })}
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
              {tr('Chưa có nội dung - hãy soạn thảo trong tab "Soạn thảo"')}
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
              <h2 className="text-base font-semibold text-foreground">{tr('Chọn nhãn')}</h2>
              <p className="text-xs text-muted-foreground">
                {mode === 'single' ? tr('Chọn 1 nhãn') : tr('Có thể chọn nhiều nhãn')}
                {selected.length > 0 && tr(' • Đã chọn: {{count}}', { count: selected.length })}
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
                {tr('Tài khoản')}
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
                  <div className="text-xs font-medium truncate">{tr('Tất cả')}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {trx('{{count}} nhãn', { count: (activeTab === 'local' ? localOpts : zaloOpts).length })}
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
                        <span>{trx('{{labelCount}} nhãn', { labelCount: acc.labelCount })}</span>
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
                  {trx('Không có tài khoản nào có nhãn {{v1}}', { v1: activeTab === 'local' ? 'Local' : 'Zalo' })}
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
                <span>{tr('Nhãn Local')}</span>
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
                <span>{tr('Nhãn Zalo')}</span>
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
                  <p className="text-sm">{tr('Không có nhãn nào')}</p>
                  <p className="text-xs mt-1">
                    {selectedAccountId !== 'all'
                      ? tr('Tài khoản này chưa có nhãn')
                      : activeTab === 'local' ? tr('Chưa có nhãn Local') : tr('Chưa có nhãn Zalo')}
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
              <span>{trx('Đã chọn <0>{{count}}</0> nhãn', { 0: <span className="text-foreground font-medium" />, count: selected.length })}</span>
            ) : (
              <span>{mode === 'single' ? tr('Chọn 1 nhãn') : tr('Chọn nhãn để áp dụng')}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="px-3 py-2 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
              >
                {tr('Xóa tất cả')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-foreground/80 hover:text-foreground bg-muted hover:bg-accent rounded-lg transition-colors"
            >
              {tr('Đóng')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-white bg-gradient-to-r from-teal-500 to-purple-600 hover:from-teal-400 hover:to-purple-500 rounded-lg transition-all shadow-lg"
            >
              {tr('Xác nhận')}
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
        {trx('<0/>Đang tải danh sách nhãn…', { 0: <Spinner size={4} /> })}
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="wf-callout" data-tone="warn">
        <TagIcon className="w-3.5 h-3.5" />
        <div className="min-w-0">
          <div className="wf-callout__title">{tr('Chưa có nhãn nào')}</div>
          <div className="mt-0.5">{trx('Vào <0>CRM → Quản lý nhãn</0> để tạo nhãn trước.', { 0: <b /> })}</div>
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
              {trx('Đã chọn ({{count}})', { count: selected.length })}
            </span>
            <button
              type="button"
              onClick={() => onChange([])}
              className="wf-btn wf-btn--sm wf-btn--ghost wf-btn--danger"
            >
              {tr('Xóa tất cả')}
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
                    title={tr('Bỏ chọn')}
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
          {selected.length > 0 ? tr('Thêm nhãn khác') : tr('Chọn nhãn')}
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
            {mode === 'single' ? tr('Chọn 1 nhãn để áp dụng') : tr('Có thể chọn nhiều nhãn • Để trống = áp dụng với mọi nhãn')}
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
      <option value="">{placeholder || tr('Chọn tài khoản')}</option>
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
              alt={tr('Preview')}
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
          {value ? tr('Đổi {{v1}}', { v1: fileType === 'image' ? tr('ảnh') : tr('tệp') }) : tr('Chọn {{v1}} từ máy tính', { v1: fileType === 'image' ? tr('ảnh') : tr('tệp') })}
        </button>
      </div>

      {/* File info */}
      {value && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-[color:var(--wf-card-border)]">
          {isLocalFile ? (
            <>
              <CheckCircleIcon className="w-4 h-4 flex-shrink-0 text-[#16a34a]" />
              <span className="min-w-0 truncate text-[11px] wf-text-2" title={value}>
                {trx('Đã chọn: {{v1}}', { v1: value.split(/[\\/]/).pop() })}
              </span>
            </>
          ) : isUrl ? (
            <>
              <LinkIcon className="w-4 h-4 flex-shrink-0 text-[color:var(--wf-focus)]" />
              <span className="min-w-0 truncate text-[11px] wf-muted" title={value}>
                {trx('URL cũ: {{value}}', { value })}
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
              {tr('Xóa')}
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
            <p className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-foreground'}`}>{tr('Chọn dữ liệu từ node')}</p>
            <p className={`text-xs ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>{tr('Click để copy UUID hoặc chèn cú pháp tham chiếu')}</p>
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
              type="text" placeholder={tr('Tìm theo tên, ID, loại node...')}
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
              <p className="text-sm">{tr('Không tìm thấy node')}</p>
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
                        }`}>{tr('đang chọn')}</span>
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
                    title={tr('Copy {{ $node.<ID>.output }}')}
                    className={`flex-shrink-0 px-2.5 py-1.5 text-[10px] font-medium rounded-lg transition-colors ${
                      copied
                        ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                        : isLight
                          ? 'bg-cyan-50 text-cyan-700 hover:bg-cyan-100 border border-cyan-200'
                          : 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/30'
                    }`}
                  >
                    {copied ? tr('✓ Copied') : tr('Copy output')}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className={`px-5 py-3 border-t flex items-center justify-between ${isLight ? 'border-gray-200 bg-gray-50' : 'border-border bg-card/50'}`}>
          <span className={`text-[11px] ${isLight ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
            {trx('{{count}}/{{count1}} node', { count: filtered.length, count1: allNodes.length })}
          </span>
          <button onClick={onClose} className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            isLight ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-muted text-foreground/80 hover:bg-accent'
          }`}>{tr('Đóng')}</button>
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
  return { id: `button_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text: tr('Nút mới'), action: 'node' };
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
  config, updateConfig, accounts, nodes, currentNodeId, onInlineRoutesChange, preferredAccountIds,
}: {
  config: Record<string, any>;
  updateConfig: (next: Record<string, any>) => void;
  accounts: any[];
  nodes: any[];
  currentNodeId: string;
  onInlineRoutesChange?: (targetNodeIds: string[]) => void;
  /** Bots the workflow runs for: the chat picker lists their chats first. */
  preferredAccountIds?: string[];
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
  // Chat variables the workflow's trigger really provides (a payment or schedule trigger has no chat to answer)
  const triggerTypes = nodes.map((item: any) => String(item.data?.type || item.type || '')).filter(isTriggerType);
  const chatVars = ['$trigger.chatId', '$trigger.fromId'].filter(key => isVarAvailable(key, triggerTypes));
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
      setTestResult(tr('Chọn Bot, Chat thử và nhập nội dung trước khi gửi thử.'));
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
      setTestResult(result?.success ? tr('Đã gửi vào chat thử.') : (result?.error || tr('Không thể gửi thử.')));
    } catch (err: any) {
      setTestResult(err?.message || tr('Không thể gửi thử.'));
    } finally { setTesting(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[13px] font-semibold wf-text">{tr('Tin nhắn Telegram Bot')}</p>
        <p className={`${descCls} !mt-1`}>{tr('Để trống phần nút bấm nếu chỉ muốn gửi tin nhắn như workflow hiện tại.')}</p>
      </div>
      <div>
        <label className={`${labelCls} mb-1.5`}>{tr('Bot gửi tin')}</label>
        <select value={config.accountId || ''} onChange={e => applyConfig({ ...config, accountId: e.target.value })}
          className={selectCls}>
          <option value="">{tr('Chọn Telegram Bot')}</option>
          {bots.map((bot: any) => <option key={bot.zalo_id} value={bot.zalo_id}>{bot.full_name || bot.username || bot.zalo_id}</option>)}
        </select>
      </div>
      <div>
        <label className={`${labelCls} mb-1.5`}>{tr('Hội thoại nhận')}</label>
        <ContactPickerField
          value={config.chatId ?? ''}
          onChange={v => applyConfig({ ...config, chatId: v })}
          contactType="all"
          channel="telegram_bot"
          accountId={config.accountId || undefined}
          preferredAccountIds={preferredAccountIds}
          placeholder="{{ $trigger.chatId }}"
          templateVars={chatVars}
        />
        <p className={descCls}>{chatVars.includes('$trigger.chatId')
          ? trx('Giữ <0>{{ $trigger.chatId }}</0> để trả lời đúng chat vừa kích hoạt workflow.', { 0: <code className="wf-var" /> })
          : tr('Trigger này không gắn với chat nào: chọn nhóm, kênh hoặc người nhận.')}</p>
      </div>
      <div>
        <label className={`${labelCls} mb-1.5`}>{tr('Nội dung tin nhắn')}</label>
        <textarea value={config.message ?? ''} onChange={e => applyConfig({ ...config, message: e.target.value })}
          rows={4} placeholder={tr('Xin chào! Mình có thể giúp gì?')} className="wf-textarea" />
      </div>

      <div className="wf-card p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="text-[13px] font-semibold wf-text">{tr('Thêm nút tương tác')}</p><p className={`${descCls} !mt-0.5`}>{tr('Bật khi cần menu hoặc chuyển người dùng đến một nhánh node trong canvas.')}</p></div>
          <button type="button" role="switch" aria-checked={keyboard.enabled} onClick={() => setKeyboard({ enabled: !keyboard.enabled })}
            className="wf-switch mt-0.5" data-on={String(!!keyboard.enabled)} title={keyboard.enabled ? tr('Tắt nút tương tác') : tr('Bật nút tương tác')} />
        </div>
        {keyboard.enabled && <>
          <div className="wf-seg w-full">
            <button type="button" onClick={() => setKeyboard({ type: 'reply' })} className={segBtnCls} data-active={String(keyboard.type === 'reply')}><span className="truncate">{tr('Reply Keyboard')}</span></button>
            <button type="button" onClick={() => setKeyboard({ type: 'inline' })} className={segBtnCls} data-active={String(keyboard.type === 'inline')}><span className="truncate">{tr('Inline Button')}</span></button>
          </div>
          <p className="text-[11px] leading-4 wf-muted">{keyboard.type === 'reply' ? tr('Reply Keyboard gửi chính text của nút như một tin nhắn mới. Hãy dùng trigger tin nhắn để xử lý.') : tr('Inline Button nhận callback. Nút “Đi đến node” chỉ chạy node đích và các node nối sau nó khi người dùng bấm.')}</p>
          <div className="space-y-2">
            {rows.map((row, rowIndex) => <div key={rowIndex} className="wf-card wf-card--plain p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-semibold wf-muted">{trx('Hàng {{v1}}', { v1: rowIndex + 1 })}</span><button type="button" onClick={() => mutateRows(current => current.filter((_, i) => i !== rowIndex))} className="wf-btn wf-btn--sm wf-btn--ghost wf-btn--danger">{tr('Xóa hàng')}</button></div>
              {row.map((button, buttonIndex) => <div key={button.id} className="wf-card p-2 space-y-1.5">
                <div className="flex items-center gap-1.5"><input value={button.text} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, text: e.target.value } : b) : r))} placeholder={tr('Tên nút')} className="wf-input wf-input--sm min-w-0 flex-1" />
                  <button type="button" onClick={() => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.filter((_, bi) => bi !== buttonIndex) : r))} className="wf-icon-btn wf-icon-btn--danger" title={tr('Xóa nút')}><CloseIcon className="w-3.5 h-3.5" /></button></div>
                {keyboard.type === 'inline' && <>
                  <select value={button.action || 'node'} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, action: e.target.value as BotKeyboardButton['action'] } : b) : r))} className="wf-select wf-input--sm"><option value="node">{tr('Đi đến node')}</option><option value="callback">{tr('Callback tùy chỉnh')}</option><option value="url">{tr('Mở liên kết')}</option></select>
                  {(button.action || 'node') === 'node' && <select value={button.targetNodeId || ''} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, targetNodeId: e.target.value } : b) : r))} className="wf-select wf-input--sm"><option value="">{tr('Chọn node đích')}</option>{targetNodes.map((target: any) => <option key={target.id} value={target.id}>{target.label}</option>)}</select>}
                  {(button.action || 'node') === 'callback' && <input value={button.callbackData || ''} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, callbackData: e.target.value } : b) : r))} maxLength={64} placeholder={tr('callback_data (tối đa 64 bytes)')} className="wf-input wf-input--sm" />}
                  {(button.action || 'node') === 'url' && <input value={button.url || ''} onChange={e => mutateRows(current => current.map((r, ri) => ri === rowIndex ? r.map((b, bi) => bi === buttonIndex ? { ...b, url: e.target.value } : b) : r))} placeholder="https://..." className="wf-input wf-input--sm" />}
                </>}
              </div>)}
              <button type="button" onClick={() => mutateRows(current => current.map((r, i) => i === rowIndex ? [...r, newBotKeyboardButton()] : r))} className="wf-btn wf-btn--sm wf-btn--ghost">{trx('<0/> Thêm nút cùng hàng', { 0: <PlusIcon className="w-3 h-3" /> })}</button>
            </div>)}
            <button type="button" onClick={() => mutateRows(current => [...current, [newBotKeyboardButton()]])} className="wf-btn wf-btn--dashed wf-btn--block">{trx('<0/> Thêm hàng nút', { 0: <PlusIcon className="w-3.5 h-3.5" /> })}</button>
          </div>
          {keyboard.type === 'reply' && <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs wf-text-2"><label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-[var(--wf-focus)]" checked={keyboard.resize !== false} onChange={e => setKeyboard({ resize: e.target.checked })} /> {tr('Tự co chiều cao')}</label><label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-[var(--wf-focus)]" checked={!!keyboard.oneTime} onChange={e => setKeyboard({ oneTime: e.target.checked })} /> {tr('Ẩn sau một lần bấm')}</label><label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-[var(--wf-focus)]" checked={!!keyboard.persistent} onChange={e => setKeyboard({ persistent: e.target.checked })} /> {tr('Luôn hiển thị')}</label></div>}
        </>}
      </div>

      <div className="wf-card p-3">
        <p className="mb-2 text-xs font-semibold wf-text">{tr('Xem trước')}</p>
        <div className={`rounded-lg p-3 ${isLight ? 'bg-[#eef3f8]' : 'bg-muted'}`}><div className={`ml-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-sm px-3 py-2 text-xs ${isLight ? 'bg-[#d8ecff] text-foreground' : 'bg-accent text-foreground'}`}>{config.message || tr('Nội dung tin nhắn')}</div>
          {keyboard.enabled && rows.length > 0 && <div className={`mt-2 gap-1 ${keyboard.type === 'reply' ? (isLight ? 'rounded-lg bg-white p-2 shadow-sm' : 'rounded-lg bg-muted p-2') : 'flex flex-col'}`}>{rows.map((row, index) => <div key={index} className="flex gap-1">{row.map(button => <span key={button.id} className={`flex-1 rounded px-2 py-1.5 text-center text-[10px] ${isLight ? 'bg-white text-blue-700 border border-blue-200' : 'bg-accent text-[#8fc7ff]'}`}>{button.text || tr('Nút')}</span>)}</div>)}</div>}</div>
      </div>
      <div className="wf-card p-3"><p className="text-xs font-semibold wf-text">{tr('Gửi thử an toàn')}</p><p className={`${descCls} !mt-0.5`}>{tr('Chỉ gửi vào Chat thử bên dưới, không dùng hội thoại đang kích hoạt workflow.')}</p><div className="mt-2 flex gap-2"><input value={config.testChatId || ''} onChange={e => applyConfig({ ...config, testChatId: e.target.value })} placeholder={tr('Chat ID thử')} className="wf-input min-w-0 flex-1" /><button type="button" disabled={testing} onClick={testSend} className="wf-btn wf-btn--success !h-auto flex-shrink-0">{testing ? tr('Đang gửi…') : tr('Gửi thử')}</button></div>{testResult && <p className="mt-2 text-[11px]" style={{ color: testResult.startsWith('Đã') ? '#16a34a' : '#d97706' }}>{testResult}</p>}</div>
    </div>
  );
}

export default function NodeConfigPanel({ node, nodes, edges, onConfigChange, onLabelChange, onInlineRoutesChange, onClose, workflowId, workflowChannel, workflowPageIds }: Props) {
  const { accounts } = useAccountStore();
  const [config, setConfig]             = useState<Record<string, any>>(node.config || {});
  const [label, setLabel]               = useState(node.label || '');
  // "Nâng cao" (Advanced) section - open by default (settings panel v2).
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

  // ── Group fields into titled sections ("sắp xếp thông minh" (smart sort)) ──────────────
  // Schema order is kept. `section` wins; otherwise basic fields go to "Cấu hình" (Config)
  // and advanced ones to "Nâng cao" (Advanced), which is always rendered last.
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
            label: tr('{{emoji}} {{name}} (Local)', { emoji, name }),
            source: 'local',
            color: l.color || '#14b8a6',
            textColor: l.text_color || '#ffffff',
            emoji,
            name,
            pageIds,
          });
        });

        // Fetch Zalo labels directly from API for each account
        // (audience source "Hội thoại theo nhãn" (conversations by label) only reads Local labels → no Zalo API calls for it)
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
  // Built-in AI node + app nodes with the x-widget "assistant" field.
  const needsAssistants = node.type === 'ai.generateText' || node.type === 'ai.classify'
    || allFields.some(f => f.type === 'assistant-picker');
  useEffect(() => {
    if (!needsAssistants) {
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
              name: a.name || tr('Chưa đặt tên'),
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
  }, [node.type, needsAssistants]);

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

    // Nodes that run before this node (reverse BFS along edges; past the "Xong" (done) gate of "Lặp qua danh sách" (loop over list), the loop body is included too)
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

  /** Several keys at once (a field that edits more than one key, e.g. 'thread-scope'). */
  const patchConfig = (changes: Record<string, any>) => {
    const next = { ...config, ...changes };
    setConfig(next);
    onConfigChange(next);
  };

  const appendVar = (key: string, v: string) => update(key, (config[key] ?? '') + v);

  /** `hideWhenKey` / `hideWhenValue` rule (hidden fields are not rendered; empty sections are skipped). */
  const isFieldHidden = (field: Field): boolean => {
    if (field.hideWhenKey && field.hideWhenValue) {
      const cur = config[field.hideWhenKey] || '';
      // If there is no value yet (old workflow), use default = 'assistant'
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
              {chipsEmpty && <span className="text-[11px] wf-faint">{tr('Không chọn = tất cả')}</span>}
              {showVarBtn && (
                <button
                  type="button"
                  onClick={() => { setTemplatePopupField(field.key); setShowTemplatePopup(true); }}
                  className="wf-var-btn"
                  title={tr('Chèn biến động')}
                >
                  {trx('<0/>Chèn biến', { 0: <BracesGlyph /> })}
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
                    <span className="text-xs font-semibold wf-text-2">{trx('Nhánh {{v1}}', { v1: idx + 1 })}</span>
                    <button
                      type="button"
                      onClick={() => setCases(cases.filter((_, i) => i !== idx))}
                      className="wf-icon-btn wf-icon-btn--danger !w-6 !h-6"
                      title={tr('Xoá nhánh')}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="wf-field-grid">
                    <label className="block min-w-0">
                      <span className="block mb-1 text-[11px] font-medium wf-muted">{tr('Khi giá trị khớp')}</span>
                      <input
                        value={c.match ?? ''}
                        onChange={e => setCases(cases.map((x, i) => i === idx ? { ...x, match: e.target.value } : x))}
                        placeholder={tr('Giá trị khớp (vd: xin chào)')}
                        className="wf-input wf-input--sm"
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="block mb-1 text-[11px] font-medium wf-muted">{tr('Tên nhánh')}</span>
                      <input
                        value={c.label ?? ''}
                        onChange={e => setCases(cases.map((x, i) => i === idx ? { ...x, label: e.target.value } : x))}
                        placeholder={tr('Tên nhánh (vd: case_chao)')}
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
                {trx('<0/> Thêm nhánh', { 0: <PlusIcon className="w-3.5 h-3.5" /> })}
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
          // Compute mode: dynamic → depends on labelSource
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

        {/* ── Chats of a message trigger (includeThreadIds / excludeThreadIds) ── */}
        {field.type === 'thread-scope' && (() => {
          const pickerChannel = field.channel || workflowChannel;
          return (
            <ThreadScopeField
              config={config}
              onPatch={patchConfig}
              contactType={field.contactType || 'all'}
              channel={pickerChannel}
              preferredAccountIds={pickerChannel && pickerChannel === workflowChannel ? workflowPageIds : undefined}
              resetKey={node?.id}
            />
          );
        })()}

        {/* ── Contact Picker ───────────────────────────────────────────── */}
        {field.type === 'contact-picker' && (
          (() => {
            // Channel: cross-channel field → from config; field with its own channel → that channel; otherwise → the workflow's channel
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
                {trx('<0/>Đang tải danh sách trợ lý…', { 0: <Spinner size={4} /> })}
              </div>
            );
          }

          // App nodes: the "không chọn" (none) option comes first (value ''), so the app uses an assistant based on its own settings.
          const emptyChoice = field.emptyLabel ? (
            <button
              type="button"
              onClick={() => update(field.key, '')}
              className="wf-choice"
              data-active={String(!selected || !enabledList.some(a => a.id === selected))}
            >
              <span className="wf-icon-tile" data-size="sm">
                <SlidersIcon className="wf-icon-tile__glyph" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="wf-choice__title block truncate">{field.emptyLabel}</span>
                {selected && !enabledList.some(a => a.id === selected) && (
                  <span className="wf-choice__meta block truncate">{tr('Trợ lý đã chọn trước đây không còn / đang tắt')}</span>
                )}
              </span>
              {(!selected || !enabledList.some(a => a.id === selected)) && <CheckCircleIcon className="w-[18px] h-[18px] flex-shrink-0 text-[color:var(--wf-focus)]" />}
            </button>
          ) : null;

          if (enabledList.length === 0) {
            if (emptyChoice) return <div className="space-y-1.5">{emptyChoice}</div>;
            return (
              <div className="wf-callout" data-tone="warn">
                <AlertIcon className="w-3.5 h-3.5" />
                <div className="min-w-0">
                  <div className="wf-callout__title">{tr('Chưa có trợ lý AI nào')}</div>
                  <div className="mt-0.5">{trx('Vào <0>Tích hợp → Trợ lý AI</0> để tạo trợ lý trước, sau đó quay lại đây chọn.', { 0: <b /> })}</div>
                </div>
              </div>
            );
          }

          return (
            <div className="space-y-1.5">
              {emptyChoice}
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
                  <div className="wf-callout__title">{tr('Chưa có Bot Telegram nào')}</div>
                  <div className="mt-0.5">{trx('Vào <0>Settings → Tích hợp</0> để kết nối Bot Telegram trước, sau đó quay lại đây chọn.', { 0: <b /> })}</div>
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
          title={open ? tr('Thu gọn mục này') : tr('Mở mục này')}>
          <span className="wf-section__icon"><Icon className="w-3.5 h-3.5" /></span>
          <span className="wf-section__title">{section.name}</span>
          <span className="wf-section__meta">{trx('{{count}} mục', { count: visible.length })}</span>
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
          <p className="mt-1 text-[13px] font-semibold wf-text">{tr('Node này không cần cấu hình thêm')}</p>
          <p className="text-xs wf-muted">{tr('Chỉ cần kết nối với các node khác là đủ.')}</p>
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
          preferredAccountIds={workflowPageIds}
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
            <span className="truncate">{tr('Biến động')}</span>
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => setShowNodePicker(true)}
              className="wf-btn wf-btn--sm"
              title={tr('Copy {{ $node.<id>.output }} của một node')}
            >
              {trx('<0/> Output node', { 0: <PlusIcon className="w-3 h-3" /> })}
            </button>
            <button
              type="button"
              onClick={() => { setTemplatePopupField(''); setShowTemplatePopup(true); }}
              className="wf-btn wf-btn--sm wf-btn--primary"
            >
              {trx('<0/> Chèn biến', { 0: <BracesGlyph /> })}
            </button>
          </div>
        </div>
        <p className="text-[11px] leading-4 wf-muted">
          {trx('Dùng <0>{{ }}</0> để chèn dữ liệu động: trigger, ngày giờ, output node khác.', { 0: <code className="wf-var" /> })}
        </p>

        {/* ── Node references ── */}
        {upstreamNodes.length > 0 && (
          <div className="wf-card">
            <button
              type="button"
              onClick={() => setIsUpstreamNodesCollapsed(collapsed => !collapsed)}
              aria-expanded={!isUpstreamNodesCollapsed}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
              title={isUpstreamNodesCollapsed ? tr('Mở dữ liệu từ node phía trước') : tr('Thu gọn dữ liệu từ node phía trước')}
            >
              <span className="flex items-center gap-1.5 min-w-0 text-xs font-semibold wf-text-2">
                <span className="truncate">{tr('Dữ liệu từ node phía trước')}</span>
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
                        title={tr('Copy {{ $node.{{id}}.output }}', { id: n.id })}
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
                <p className="mt-1.5 px-1.5 text-[10.5px] wf-faint">{trx('Bấm để copy <0>{{ $node.<UUID>.output }}</0>', { 0: <code className="wf-var" /> })}</p>
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
      <button type="button" onClick={() => setIsFullscreen(f => !f)} title={isFullscreen ? tr('Thu nhỏ (Esc)') : tr('Mở rộng toàn màn hình')}
        className="wf-icon-btn">
        {isFullscreen ? <MinimizeIcon className="w-4 h-4" /> : <MaximizeIcon className="w-4 h-4" />}
      </button>
      {/* Close */}
      <button type="button" onClick={onClose} title={tr('Đóng')} className="wf-icon-btn">
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
          {/* Display name (was a form field): same state + handler, now edited in place */}
          <input
            value={label}
            onChange={e => { setLabel(e.target.value); onLabelChange(e.target.value); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder={defaultLabel}
            title={tr('Nhấn để đổi tên hiển thị trên sơ đồ')}
            aria-label={tr('Tên hiển thị trên sơ đồ')}
            spellCheck={false}
            className="wf-title-input"
          />
        </div>
        {headerBtns}
      </div>
      {nodeDescription && <p className="wf-panel__desc mt-2.5">{nodeDescription}</p>}
      {isRenamed && <p className="mt-1 text-[11px] wf-muted">{trx('Loại: {{defaultLabel}}', { defaultLabel })}</p>}
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
        title={tr('Kéo để thay đổi chiều rộng')}>
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
