/**
 * Visual identity of workflow nodes: family (colour + eyebrow label), icon and channel.
 * Shared by the canvas nodes, the node palette and the node settings panel so a node
 * looks the same everywhere. Styling lives in index.css (`.wf-*` classes).
 */
import React from 'react';
import { NODE_GROUPS, getNodeLabel } from './workflowConfig';
import {
  BarChartIcon, BellOffIcon, BookIcon, BoxIcon, BrainIcon, CalendarIcon, CheckCircleIcon,
  ClipboardListIcon, ClockIcon, CreditCardIcon, CrownIcon, EditIcon, FileIcon, FileTextIcon,
  GlobeIcon, HashIcon, HeartIcon, ImageIcon, InboxIcon, LightningIcon, LinkIcon, LockIcon,
  MailIcon, MapPinIcon, MenuIcon, MessageCircleIcon, MessageSquareIcon, MusicIcon, PackageIcon,
  PaperclipIcon, PinIcon, PlayIcon, RepeatIcon, ReplyIcon, SearchIcon, SendIcon, ShareIcon,
  ShieldIcon, ShoppingCartIcon, ShuffleIcon, SmileIcon, SparklesIcon, TagIcon, TargetIcon,
  TerminalIcon, TrashIcon, TruckIcon, UndoIcon, UserCheckIcon, UserIcon, UserPlusIcon, UsersIcon,
  WebhookIcon,
} from '@/components/common/icons';
import { FacebookIcon, TelegramIcon, ZaloIcon } from '@/components/common/avatars/ChannelBadge';

type IconComponent = (props: { className?: string }) => JSX.Element;

// ─── Extra icons (same 24×24 stroke style as common/icons) ───────────────────

const svgProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

const BranchIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="7" r="2.2" /><path d="M6 7.2v9.6" /><path d="M18 9.2c0 4.3-6 3.8-11.2 7.6" /></svg>
);
const SplitIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M12 3v6" /><path d="M12 9 5 16v5" /><path d="M12 9v12" /><path d="m12 9 7 7v5" /></svg>
);
const StopIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" /><path d="M9 9h6v6H9z" /></svg>
);
const BracesIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" /><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" /></svg>
);
const VariableIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2" /><path d="m9 9 6 6" /><path d="m15 9-6 6" /></svg>
);
const TableIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /></svg>
);
const VideoIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3.5v11L16 14" /></svg>
);
const MicIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v4" /></svg>
);
const TypingIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M8 10h.01" /><path d="M12 10h.01" /><path d="M16 10h.01" /></svg>
);
const UserMinusIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 11h-6" /></svg>
);
const UserXIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m17 8 5 5" /><path d="m22 8-5 5" /></svg>
);
const BanIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><circle cx="12" cy="12" r="10" /><path d="m4.9 4.9 14.2 14.2" /></svg>
);
const LogOutIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
);
const PointerIcon: IconComponent = ({ className }) => (
  <svg {...svgProps} className={className}><path d="m9 9 5 12 1.8-5.2L21 14z" /><path d="M7.2 2.2 8 5.1" /><path d="m5.1 8-2.9-.8" /><path d="M14 4.1 12 6" /><path d="m6 12-1.9 2" /></svg>
);

// ─── Families ────────────────────────────────────────────────────────────────

export type NodeFamily =
  | 'trigger' | 'action' | 'logic' | 'data' | 'sheets' | 'ai' | 'notify' | 'output'
  | 'pos' | 'payment' | 'shipping';

export const FAMILY_META: Record<NodeFamily, { label: string; accent: string }> = {
  trigger:  { label: 'Kích hoạt',     accent: '#7c3aed' },
  action:   { label: 'Hành động',     accent: '#2563eb' },
  logic:    { label: 'Logic',         accent: '#d97706' },
  data:     { label: 'Dữ liệu',       accent: '#0d9488' },
  sheets:   { label: 'Google Sheets', accent: '#16a34a' },
  ai:       { label: 'AI',            accent: '#c026d3' },
  notify:   { label: 'Thông báo',     accent: '#ea580c' },
  output:   { label: 'Đầu ra',        accent: '#e11d48' },
  pos:      { label: 'Bán hàng',      accent: '#4f46e5' },
  payment:  { label: 'Thanh toán',    accent: '#059669' },
  shipping: { label: 'Vận chuyển',    accent: '#0891b2' },
};

/** Palette group label → family, so palette dots match the canvas colours. */
export const PALETTE_GROUP_FAMILY: Record<string, NodeFamily> = {
  'Kích hoạt': 'trigger',
  'Hành động': 'action',
  'Điều kiện & Logic': 'logic',
  'Xử lý dữ liệu': 'data',
  'Google Sheets': 'sheets',
  'Trí tuệ nhân tạo (AI)': 'ai',
  'Gửi thông báo': 'notify',
  'Đầu ra & API': 'output',
  'POS / Bán hàng': 'pos',
  'Thanh toán': 'payment',
  'Vận chuyển': 'shipping',
};

const POS_PREFIXES = ['kiotviet.', 'haravan.', 'sapo.', 'nhanh.', 'pancake.'];

export function getNodeFamily(type: string): NodeFamily {
  const t = type || '';
  if (t.startsWith('trigger.') || t.includes('.trigger.')) return 'trigger';
  if (t.startsWith('logic.')) return 'logic';
  if (t.startsWith('data.')) return 'data';
  if (t.startsWith('sheets.')) return 'sheets';
  if (t.startsWith('ai.')) return 'ai';
  if (t.startsWith('notify.')) return 'notify';
  if (t.startsWith('output.')) return 'output';
  if (POS_PREFIXES.some(p => t.startsWith(p))) return 'pos';
  if (t.startsWith('payment.')) return 'payment';
  if (t.startsWith('ghn.') || t.startsWith('ghtk.')) return 'shipping';
  return 'action';
}

// ─── Channel ─────────────────────────────────────────────────────────────────

export type NodeChannel = 'zalo' | 'facebook' | 'telegram_user' | 'telegram_bot';

const ITEM_BY_TYPE: Record<string, { label: string; desc: string; channel?: string }> = (() => {
  const map: Record<string, { label: string; desc: string; channel?: string }> = {};
  for (const group of NODE_GROUPS) {
    for (const item of group.items) map[item.type] = item;
  }
  return map;
})();

export function getNodeChannel(type: string): NodeChannel | undefined {
  const t = type || '';
  const declared = ITEM_BY_TYPE[t]?.channel;
  if (declared === 'zalo' || declared === 'facebook' || declared === 'telegram_user' || declared === 'telegram_bot') {
    return declared;
  }
  if (declared === 'both') return undefined;
  if (t.startsWith('zalo.')) return 'zalo';
  if (t.startsWith('fb.')) return 'facebook';
  if (t.startsWith('tgbot.')) return 'telegram_bot';
  if (t.startsWith('tg.')) return 'telegram_user';
  return undefined;
}

export const CHANNEL_NAME: Record<NodeChannel, string> = {
  zalo: 'Zalo',
  facebook: 'Facebook',
  telegram_user: 'Telegram',
  telegram_bot: 'Telegram Bot',
};

/** Node description from the palette catalogue (empty for engine-only types). */
export function getNodeDescription(type: string): string {
  return ITEM_BY_TYPE[type]?.desc || '';
}

// ─── Icons ───────────────────────────────────────────────────────────────────

const TRIGGER_ICONS: Record<string, IconComponent> = {
  message: MessageCircleIcon, friendRequest: UserPlusIcon, groupEvent: UsersIcon,
  reaction: SmileIcon, labelAssigned: TagIcon, schedule: CalendarIcon, manual: PlayIcon,
  payment: CreditCardIcon, posWebhook: ShoppingCartIcon, webhook: WebhookIcon, unsend: UndoIcon, image: ImageIcon,
  video: VideoIcon, file: FileIcon, sticker: SmileIcon, command: TerminalIcon,
  telegramCommand: TerminalIcon, callback: PointerIcon, join: UserCheckIcon,
  editedMessage: EditIcon, joinRequest: UserPlusIcon,
};

const OP_ICONS: Record<string, IconComponent> = {
  // Messaging
  sendMessage: SendIcon, sendTyping: TypingIcon, sendChatAction: TypingIcon,
  sendImage: ImageIcon, sendPhoto: ImageIcon, sendFile: PaperclipIcon, sendVoice: MicIcon,
  sendAudio: MusicIcon, sendVideo: VideoIcon, sendSticker: SmileIcon, sendPoll: BarChartIcon,
  createPoll: BarChartIcon, sendMenu: MenuIcon, sendForm: ClipboardListIcon,
  answerCallback: ReplyIcon, forwardMessage: ShareIcon, forward: ShareIcon,
  forwardCrossChannel: ShuffleIcon, undoMessage: UndoIcon, unsend: UndoIcon,
  getMessageHistory: InboxIcon, addReaction: HeartIcon, editMessage: EditIcon,
  deleteMessage: TrashIcon, pin: PinIcon, pinMessage: PinIcon, unpin: PinIcon,
  unpinMessage: PinIcon, markAsRead: CheckCircleIcon, markTopicAsRead: CheckCircleIcon,
  // People & groups
  findUser: SearchIcon, getUserInfo: UserIcon, acceptFriendRequest: UserCheckIcon,
  rejectFriendRequest: UserXIcon, sendFriendRequest: UserPlusIcon, addToGroup: UserPlusIcon,
  addMember: UserPlusIcon, removeFromGroup: UserMinusIcon, removeMember: UserMinusIcon,
  setMute: BellOffIcon, assignLabel: TagIcon, removeLabel: TagIcon, changeAliasName: EditIcon,
  changeName: EditIcon, changeNickname: EditIcon, changeGroupName: EditIcon,
  changeEmoji: SmileIcon, block: BanIcon, blockUser: BanIcon, unblockUser: ShieldIcon,
  banMember: BanIcon, restrictMember: LockIcon, promoteMember: CrownIcon,
  leaveChat: LogOutIcon, leaveGroup: LogOutIcon, exportInviteLink: LinkIcon,
  createForumTopic: HashIcon,
  // Logic & data
  if: BranchIcon, switch: SplitIcon, wait: ClockIcon, setVariable: VariableIcon,
  stopIf: StopIcon, forEach: RepeatIcon, forEachContact: TargetIcon,
  textFormat: FileTextIcon, randomPick: ShuffleIcon, dateFormat: CalendarIcon,
  jsonParse: BracesIcon,
  // Integrations
  appendRow: TableIcon, readValues: TableIcon, updateCell: TableIcon,
  generateText: SparklesIcon, classify: BrainIcon,
  email: MailIcon, discord: MessageSquareIcon, notion: BookIcon,
  httpRequest: GlobeIcon, log: TerminalIcon,
  lookupCustomer: UserIcon, lookupOrder: ClipboardListIcon, lookupProduct: BoxIcon,
  createOrder: ShoppingCartIcon, getInventory: PackageIcon, getTransactions: CreditCardIcon,
  getTracking: MapPinIcon, getProvinces: MapPinIcon, getDistricts: MapPinIcon,
  getWards: MapPinIcon, getServices: ClipboardListIcon,
};

export function getNodeIcon(type: string): IconComponent {
  const t = type || '';
  const op = t.split('.').pop() || '';
  if (getNodeFamily(t) === 'trigger') return TRIGGER_ICONS[op] || LightningIcon;
  if (t === 'notify.telegram') return SendIcon;
  if (t.startsWith('ghn.createOrder') || t.startsWith('ghtk.createOrder')) return TruckIcon;
  return OP_ICONS[op] || LightningIcon;
}

// ─── Aggregate ───────────────────────────────────────────────────────────────

export interface NodeVisual {
  family: NodeFamily;
  familyLabel: string;
  accent: string;
  Icon: IconComponent;
  channel?: NodeChannel;
  defaultLabel: string;
}

export function getNodeVisual(type: string): NodeVisual {
  const family = getNodeFamily(type);
  return {
    family,
    familyLabel: FAMILY_META[family].label,
    accent: FAMILY_META[family].accent,
    Icon: getNodeIcon(type),
    channel: getNodeChannel(type),
    defaultLabel: getNodeLabel(type),
  };
}

/** Inline style that exposes the node accent to the `.wf-*` classes. */
export function accentStyle(accent: string): React.CSSProperties {
  return { ['--wf-accent' as any]: accent };
}

// ─── Components ──────────────────────────────────────────────────────────────

export function ChannelMark({ channel, className = '' }: { channel: NodeChannel; className?: string }) {
  if (channel === 'zalo') {
    return (
      <span className={`wf-channel-mark wf-channel-mark--zalo ${className}`} title={CHANNEL_NAME[channel]}>
        <ZaloIcon size={16} />
      </span>
    );
  }
  const bg = channel === 'facebook' ? '#1877F2' : '#229ED9';
  return (
    <span className={`wf-channel-mark ${className}`} style={{ background: bg }} title={CHANNEL_NAME[channel]}>
      {channel === 'facebook' ? <FacebookIcon size={10} /> : <TelegramIcon size={10} />}
    </span>
  );
}

export function NodeIconTile({ type, size = 'md', showChannel = true }: {
  type: string;
  size?: 'sm' | 'md' | 'lg';
  showChannel?: boolean;
}) {
  const visual = getNodeVisual(type);
  const Icon = visual.Icon;
  return (
    <span className="wf-icon-tile" data-size={size} style={accentStyle(visual.accent)}>
      <Icon className="wf-icon-tile__glyph" />
      {showChannel && visual.channel && <ChannelMark channel={visual.channel} />}
    </span>
  );
}

/** Text with `{{ variables }}` rendered as compact code chips. */
export function VarText({ text }: { text: string }) {
  if (!text) return null;
  // split() with a capture group alternates plain text (even) and `{{ … }}` (odd); a `{{ …`
  // cut off by truncate() ends at its ellipsis (or at the end of the text).
  const parts = text.split(/(\{\{[^}…]*(?:\}\}|…|$))/);
  return (
    <>
      {parts.map((part, i) => (
        i % 2 === 1
          ? <code key={i} className="wf-var">{part.replace(/^\{\{\s*/, '').replace(/\s*(\}\})?$/, '')}</code>
          : <React.Fragment key={i}>{part}</React.Fragment>
      ))}
    </>
  );
}
