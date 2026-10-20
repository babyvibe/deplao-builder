/**
 * Màu & chữ viết tắt theo người / hội thoại (kiểu Telegram Desktop), dùng chung mọi kênh (Zalo, Facebook, Telegram):
 * tên người gửi trong tin nhắn, khung trích dẫn, ảnh đại diện chữ ở danh sách hội thoại / đầu khung chat / thành viên…
 * cùng một màu cho cùng một người.
 *
 * Màu: id số → `id % 7` trên id "trần" (Telegram: nhóm thường -123 → 123, siêu nhóm / kênh -100123 → 123) → 0 đỏ, 1 cam,
 * 2 tím, 3 xanh lá, 4 xanh ngọc, 5 xanh dương, 6 hồng — đúng cách Telegram tô màu người dùng chưa tự chọn màu (đã đối
 * chiếu Telegram Desktop trên dữ liệu thật, 5/5 khớp). Id không phải số → băm chuỗi. Bảng màu sáng / tối: lớp
 * `chat-peer-N` trong index.css.
 */

export const PEER_COLOR_COUNT = 7;

/** id trần (bỏ "-" / "-100" của nhóm / kênh Telegram); không phải số → ''. */
function barePeerId(peerId: string): string {
  const id = peerId.trim();
  if (/^-100\d+$/.test(id)) return id.slice(4);
  if (/^-\d+$/.test(id)) return id.slice(1);
  return /^\d+$/.test(id) ? id : '';
}

function hashIndex(text: string): number {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + (ch.codePointAt(0) || 0)) % 1_000_003;
  return hash % PEER_COLOR_COUNT;
}

/**
 * Chỉ số màu 0–6 của người / nhóm. Thiếu id số → băm `fallbackKey` (vd tên) hoặc chính id; không có gì → null.
 */
export function peerColorIndex(peerId: string | number | null | undefined, fallbackKey?: string | null): number | null {
  const raw = peerId === null || peerId === undefined ? '' : String(peerId);
  const bare = barePeerId(raw);
  if (bare && !/^0+$/.test(bare)) {
    // Chia lấy dư theo từng chữ số: id Zalo (19 chữ số) / kênh Telegram vượt độ chính xác an toàn của số thực
    let rest = 0;
    for (const digit of bare) rest = (rest * 10 + Number(digit)) % PEER_COLOR_COUNT;
    return rest;
  }
  const key = String(fallbackKey || raw || '').trim();
  return key ? hashIndex(key) : null;
}

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Chữ viết tắt trên ảnh đại diện như Telegram Desktop (EmptyUserpic::InitialsString): chữ cái đầu của từ đầu + chữ cái
 * đầu của từ cuối, bỏ qua emoji / ký hiệu ("🐶👾 BITSDuck Smart👾 BITS🦴" → "BB", "Nguyễn Bích Diệp" → "ND").
 */
export function peerInitials(name: string | null | undefined): string {
  const text = String(name || '').normalize('NFC').trim();
  if (!text) return '';
  const letters: string[] = [];
  const levels: number[] = [];
  let level = 0;
  let letterFound = false;
  for (const ch of text) {
    if (LETTER_OR_NUMBER.test(ch)) {
      if (!letterFound) {
        letterFound = true;
        letters.push(ch);
        levels.push(level);
      }
    } else if (ch === ' ') {
      level = 0;
      letterFound = false;
    } else if (letterFound && ch === '-') {
      // Ưu tiên từ sau dấu cách, sau đó mới tới phần sau dấu "-" (Anne-Marie → "AM")
      level = 1;
      letterFound = false;
    }
  }
  if (!letters.length) return '';
  let best = 0;
  let bestLevel = 2;
  for (let i = letters.length - 1; i > 0; i--) {
    if (levels[i] < bestLevel) {
      best = i;
      bestLevel = levels[i];
    }
  }
  return (letters[0] + (best > 0 ? letters[best] : '')).toLocaleUpperCase('vi');
}

/**
 * Một chữ đại diện cho tên: chữ cái / số đầu tiên. Trước đây `charAt(0)` của tên mở đầu bằng emoji lấy nửa cặp
 * surrogate → hiện ô "�". Không có chữ nào → ký tự (emoji) đầu tiên nguyên vẹn.
 */
export function nameInitial(name: string | null | undefined, fallback = '?'): string {
  const text = String(name || '').normalize('NFC').trim();
  if (!text) return fallback;
  for (const ch of text) {
    if (LETTER_OR_NUMBER.test(ch)) return ch.toLocaleUpperCase('vi');
  }
  return Array.from(text)[0] || fallback;
}

/** Vai trò trong nhóm Telegram (telegram_group_admins): 1 = người tạo, 2 = quản trị viên. */
export interface TelegramGroupAdmin {
  memberId: string;
  role: number;
  /** Chức vụ tự đặt (vd "I.... am.... mod"); rỗng → nhãn mặc định. */
  rank: string;
}

/** Telegram: chức vụ tự đặt, không có thì "Chủ nhóm" / "Quản trị viên" (như Telegram). */
export function telegramRankLabel(admin: Pick<TelegramGroupAdmin, 'role' | 'rank'> | null | undefined): string {
  if (!admin) return '';
  const rank = String(admin.rank || '').trim();
  if (rank) return rank;
  if (Number(admin.role) === 1) return 'Chủ nhóm';
  if (Number(admin.role) === 2) return 'Quản trị viên';
  return '';
}

/**
 * Nhãn chức vụ từ `role` của thành viên nhóm (page_group_member) — quy ước theo kênh (shared/groupMemberRoles):
 * Telegram 1 = người tạo / 2 = quản trị viên; Zalo 2 = trưởng nhóm / 1 = phó nhóm; Facebook: quản trị viên.
 */
export function groupRankLabel(channel: string | null | undefined, role: number | string | null | undefined): string {
  const value = Number(role || 0);
  if (!value) return '';
  const ch = String(channel || '');
  if (ch.startsWith('telegram')) return telegramRankLabel({ role: value, rank: '' });
  if (ch === 'facebook') return 'Quản trị viên';
  if (value === 2) return 'Trưởng nhóm';
  if (value === 1) return 'Phó nhóm';
  return '';
}
