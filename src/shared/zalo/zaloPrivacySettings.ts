/**
 * zaloPrivacySettings.ts: Zalo privacy settings (ZL-02, SRS Deplao): table shared by main (checks the key / value before calling Zalo) + renderer (draws the Settings → Account → Zalo privacy screen).
 *
 * zca-js 2.2.0: getSettings() → UserSetting; updateSettings(type, value), one setting at a time. The two write keys
 * archivedChatStatus / quickMessageStatus (camelCase) differ from the read fields archived_chat_status / quick_message_status.
 */

import { tr } from '../i18n';

export type ZaloSettingKey =
  | 'view_birthday' | 'show_online_status' | 'display_seen_status'
  | 'receive_message' | 'accept_stranger_call'
  | 'add_friend_via_phone' | 'add_friend_via_qr' | 'add_friend_via_group' | 'add_friend_via_contact' | 'display_on_recommend_friend'
  | 'archivedChatStatus' | 'quickMessageStatus';

export type ZaloSettingGroup = 'display' | 'messaging' | 'friendSources' | 'utilities';

export interface ZaloSettingDef {
  /** Write key (a value of UpdateSettingsType). */
  key: ZaloSettingKey;
  /** Read field in getSettings(). */
  readField: string;
  group: ZaloSettingGroup;
  label: string;
  /** One consequence line shown under the setting name. */
  hint: string;
  kind: 'toggle' | 'select';
  options?: ReadonlyArray<{ value: number; label: string }>;
  /** A value to confirm again before changing (e.g. "Chỉ bạn bè" (Friends only) blocks customers who are not friends yet). */
  confirm?: { value: number; title: string; message: string };
}

export const ZALO_SETTING_GROUPS: ReadonlyArray<{ id: ZaloSettingGroup; label: string }> = [
  { id: 'display', label: tr('Hiển thị') },
  { id: 'messaging', label: tr('Tin nhắn & cuộc gọi') },
  { id: 'friendSources', label: tr('Cho phép người lạ tìm thấy và kết bạn qua') },
  { id: 'utilities', label: tr('Tiện ích') },
];

const friendSource = (key: ZaloSettingKey, label: string, hint: string): ZaloSettingDef =>
  ({ key, readField: key, group: 'friendSources', label, hint, kind: 'toggle' });

export const ZALO_PRIVACY_SETTINGS: ReadonlyArray<ZaloSettingDef> = [
  {
    key: 'view_birthday', readField: 'view_birthday', group: 'display', kind: 'select', label: tr('Ngày sinh'),
    hint: tr('Cách ngày sinh hiện trên hồ sơ Zalo của tài khoản này.'),
    options: [{ value: 0, label: tr('Không hiện') }, { value: 1, label: tr('Hiện ngày / tháng / năm') }, { value: 2, label: tr('Chỉ hiện ngày / tháng') }],
  },
  {
    key: 'show_online_status', readField: 'show_online_status', group: 'display', kind: 'toggle', label: tr('Hiện trạng thái truy cập'),
    hint: tr('Tắt thì người khác không thấy tài khoản đang online hay truy cập lúc nào.'),
  },
  {
    key: 'display_seen_status', readField: 'display_seen_status', group: 'display', kind: 'toggle', label: tr('Hiện trạng thái "Đã xem"'),
    hint: tr('Tắt thì người gửi không thấy bạn đã xem tin; Deplao cũng có thể không nhận được dấu đã xem từ Zalo.'),
  },
  {
    key: 'receive_message', readField: 'receive_message', group: 'messaging', kind: 'select', label: tr('Cho phép nhắn tin'),
    hint: tr('Ai được nhắn tin cho tài khoản này.'),
    options: [{ value: 1, label: tr('Mọi người') }, { value: 2, label: tr('Chỉ bạn bè') }],
    confirm: { value: 2, title: tr('Chỉ cho bạn bè nhắn tin?'), message: tr('Khách chưa kết bạn sẽ không nhắn được cho tài khoản này nữa.') },
  },
  {
    key: 'accept_stranger_call', readField: 'accept_stranger_call', group: 'messaging', kind: 'select', label: tr('Cho phép gọi điện'),
    hint: tr('Ai được gọi thoại / video cho tài khoản này.'),
    options: [{ value: 3, label: tr('Mọi người') }, { value: 4, label: tr('Bạn bè và người từng liên hệ') }, { value: 2, label: tr('Chỉ bạn bè') }],
    confirm: { value: 2, title: tr('Chỉ cho bạn bè gọi điện?'), message: tr('Khách chưa kết bạn sẽ không gọi được cho tài khoản này nữa.') },
  },
  friendSource('add_friend_via_phone', tr('Số điện thoại'), tr('Người khác tìm thấy và kết bạn bằng số điện thoại.')),
  friendSource('add_friend_via_qr', tr('Mã QR của tôi'), tr('Người khác kết bạn bằng cách quét mã QR.')),
  friendSource('add_friend_via_group', tr('Nhóm chung'), tr('Thành viên nhóm chung xem hồ sơ và kết bạn được.')),
  friendSource('add_friend_via_contact', tr('Danh thiếp Zalo'), tr('Người nhận danh thiếp của bạn kết bạn được.')),
  friendSource('display_on_recommend_friend', tr('Gợi ý "Có thể bạn quen"'), tr('Tài khoản xuất hiện trong gợi ý kết bạn của người khác.')),
  {
    key: 'archivedChatStatus', readField: 'archived_chat_status', group: 'utilities', kind: 'toggle', label: tr('Lưu trữ trò chuyện'),
    hint: tr('Mục Lưu trữ trò chuyện trên app Zalo.'),
  },
  {
    key: 'quickMessageStatus', readField: 'quick_message_status', group: 'utilities', kind: 'toggle', label: tr('Tin nhắn nhanh'),
    hint: tr('Tính năng Tin nhắn nhanh trên app Zalo.'),
  },
];

export function zaloSettingDef(key: unknown): ZaloSettingDef | undefined {
  return ZALO_PRIVACY_SETTINGS.find((def) => def.key === key);
}

/** Key present in the table, and the value is exactly the set Zalo accepts (toggle: 0 / 1; select: by the choice). */
export function isValidZaloSettingValue(key: unknown, value: unknown): boolean {
  const def = zaloSettingDef(key);
  if (!def || typeof value !== 'number' || !Number.isInteger(value)) return false;
  if (def.kind === 'toggle') return value === 0 || value === 1;
  return !!def.options?.some((option) => option.value === value);
}

/** Current value of a setting from getSettings (boolean → 1 / 0); missing → null. */
export function readZaloSettingValue(def: ZaloSettingDef, settings: Record<string, any> | null | undefined): number | null {
  const raw = settings?.[def.readField];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Two-step verification (read only): true / false; Zalo does not return it → null. */
export function zaloTwoFactorEnabled(settings: Record<string, any> | null | undefined): boolean | null {
  const raw = settings?.setting_2FA_status;
  if (raw === undefined || raw === null || raw === '') return null;
  return Number(raw) > 0 || raw === true;
}
