/**
 * zaloPrivacySettings.ts — cài đặt quyền riêng tư Zalo (ZL-02, SRS Deplao): bảng dùng chung main (kiểm khoá / giá trị trước
 * khi gọi Zalo) + renderer (vẽ màn Cài đặt → Tài khoản → Quyền riêng tư Zalo).
 *
 * zca-js 2.2.0: getSettings() → UserSetting; updateSettings(type, value) — mỗi lần một cài đặt. Hai khoá ghi
 * archivedChatStatus / quickMessageStatus (camelCase) khác tên trường đọc archived_chat_status / quick_message_status.
 */

export type ZaloSettingKey =
  | 'view_birthday' | 'show_online_status' | 'display_seen_status'
  | 'receive_message' | 'accept_stranger_call'
  | 'add_friend_via_phone' | 'add_friend_via_qr' | 'add_friend_via_group' | 'add_friend_via_contact' | 'display_on_recommend_friend'
  | 'archivedChatStatus' | 'quickMessageStatus';

export type ZaloSettingGroup = 'display' | 'messaging' | 'friendSources' | 'utilities';

export interface ZaloSettingDef {
  /** Khoá ghi (giá trị của UpdateSettingsType). */
  key: ZaloSettingKey;
  /** Trường đọc trong getSettings(). */
  readField: string;
  group: ZaloSettingGroup;
  label: string;
  /** Một dòng hệ quả hiện dưới tên cài đặt. */
  hint: string;
  kind: 'toggle' | 'select';
  options?: ReadonlyArray<{ value: number; label: string }>;
  /** Giá trị cần hỏi lại trước khi đổi (vd "Chỉ bạn bè" chặn khách chưa kết bạn). */
  confirm?: { value: number; title: string; message: string };
}

export const ZALO_SETTING_GROUPS: ReadonlyArray<{ id: ZaloSettingGroup; label: string }> = [
  { id: 'display', label: 'Hiển thị' },
  { id: 'messaging', label: 'Tin nhắn & cuộc gọi' },
  { id: 'friendSources', label: 'Cho phép người lạ tìm thấy và kết bạn qua' },
  { id: 'utilities', label: 'Tiện ích' },
];

const friendSource = (key: ZaloSettingKey, label: string, hint: string): ZaloSettingDef =>
  ({ key, readField: key, group: 'friendSources', label, hint, kind: 'toggle' });

export const ZALO_PRIVACY_SETTINGS: ReadonlyArray<ZaloSettingDef> = [
  {
    key: 'view_birthday', readField: 'view_birthday', group: 'display', kind: 'select', label: 'Ngày sinh',
    hint: 'Cách ngày sinh hiện trên hồ sơ Zalo của tài khoản này.',
    options: [{ value: 0, label: 'Không hiện' }, { value: 1, label: 'Hiện ngày / tháng / năm' }, { value: 2, label: 'Chỉ hiện ngày / tháng' }],
  },
  {
    key: 'show_online_status', readField: 'show_online_status', group: 'display', kind: 'toggle', label: 'Hiện trạng thái truy cập',
    hint: 'Tắt thì người khác không thấy tài khoản đang online hay truy cập lúc nào.',
  },
  {
    key: 'display_seen_status', readField: 'display_seen_status', group: 'display', kind: 'toggle', label: 'Hiện trạng thái "Đã xem"',
    hint: 'Tắt thì người gửi không thấy bạn đã xem tin; Deplao cũng có thể không nhận được dấu đã xem từ Zalo.',
  },
  {
    key: 'receive_message', readField: 'receive_message', group: 'messaging', kind: 'select', label: 'Cho phép nhắn tin',
    hint: 'Ai được nhắn tin cho tài khoản này.',
    options: [{ value: 1, label: 'Mọi người' }, { value: 2, label: 'Chỉ bạn bè' }],
    confirm: { value: 2, title: 'Chỉ cho bạn bè nhắn tin?', message: 'Khách chưa kết bạn sẽ không nhắn được cho tài khoản này nữa.' },
  },
  {
    key: 'accept_stranger_call', readField: 'accept_stranger_call', group: 'messaging', kind: 'select', label: 'Cho phép gọi điện',
    hint: 'Ai được gọi thoại / video cho tài khoản này.',
    options: [{ value: 3, label: 'Mọi người' }, { value: 4, label: 'Bạn bè và người từng liên hệ' }, { value: 2, label: 'Chỉ bạn bè' }],
    confirm: { value: 2, title: 'Chỉ cho bạn bè gọi điện?', message: 'Khách chưa kết bạn sẽ không gọi được cho tài khoản này nữa.' },
  },
  friendSource('add_friend_via_phone', 'Số điện thoại', 'Người khác tìm thấy và kết bạn bằng số điện thoại.'),
  friendSource('add_friend_via_qr', 'Mã QR của tôi', 'Người khác kết bạn bằng cách quét mã QR.'),
  friendSource('add_friend_via_group', 'Nhóm chung', 'Thành viên nhóm chung xem hồ sơ và kết bạn được.'),
  friendSource('add_friend_via_contact', 'Danh thiếp Zalo', 'Người nhận danh thiếp của bạn kết bạn được.'),
  friendSource('display_on_recommend_friend', 'Gợi ý "Có thể bạn quen"', 'Tài khoản xuất hiện trong gợi ý kết bạn của người khác.'),
  {
    key: 'archivedChatStatus', readField: 'archived_chat_status', group: 'utilities', kind: 'toggle', label: 'Lưu trữ trò chuyện',
    hint: 'Mục Lưu trữ trò chuyện trên app Zalo.',
  },
  {
    key: 'quickMessageStatus', readField: 'quick_message_status', group: 'utilities', kind: 'toggle', label: 'Tin nhắn nhanh',
    hint: 'Tính năng Tin nhắn nhanh trên app Zalo.',
  },
];

export function zaloSettingDef(key: unknown): ZaloSettingDef | undefined {
  return ZALO_PRIVACY_SETTINGS.find((def) => def.key === key);
}

/** Khoá có trong bảng và giá trị đúng tập Zalo nhận (toggle: 0 / 1; select: theo lựa chọn). */
export function isValidZaloSettingValue(key: unknown, value: unknown): boolean {
  const def = zaloSettingDef(key);
  if (!def || typeof value !== 'number' || !Number.isInteger(value)) return false;
  if (def.kind === 'toggle') return value === 0 || value === 1;
  return !!def.options?.some((option) => option.value === value);
}

/** Giá trị hiện tại của một cài đặt từ getSettings (boolean → 1 / 0); thiếu → null. */
export function readZaloSettingValue(def: ZaloSettingDef, settings: Record<string, any> | null | undefined): number | null {
  const raw = settings?.[def.readField];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Xác thực 2 lớp (chỉ đọc): true / false; Zalo không trả → null. */
export function zaloTwoFactorEnabled(settings: Record<string, any> | null | undefined): boolean | null {
  const raw = settings?.setting_2FA_status;
  if (raw === undefined || raw === null || raw === '') return null;
  return Number(raw) > 0 || raw === true;
}
