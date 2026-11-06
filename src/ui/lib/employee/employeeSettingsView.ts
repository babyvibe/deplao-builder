/**
 * Cài đặt → Nhân viên: phần thuần (không React) của trang — danh mục quyền, dòng tóm tắt dưới mỗi nhân viên, trạng thái
 * online, gợi ý tên đăng nhập / mật khẩu, nội dung gửi cho nhân viên sau khi tạo. Có test riêng.
 */

/** Một mục nhân viên được dùng (khoá = module trong employee_permissions). */
export interface EmployeeModule {
  key: string;
  label: string;
  desc: string;
  /** work = các trang làm việc; settings = phần Cài đặt chỉ chủ có (mặc định không giao). */
  group: 'work' | 'settings';
}

/**
 * Thứ tự = thứ tự trên màn hình. Khoá giữ nguyên (lưu trong DB, Boss kiểm tra khi nhân viên gọi). `facebook` không còn
 * mục riêng: Facebook đi theo quyền Tin nhắn + tài khoản được giao như mọi kênh.
 */
export const EMPLOYEE_MODULES: readonly EmployeeModule[] = [
  { key: 'chat', label: 'Tin nhắn', desc: 'Đọc, trả lời tin', group: 'work' },
  { key: 'friends', label: 'Bạn bè', desc: 'Danh bạ, lời mời kết bạn', group: 'work' },
  { key: 'crm', label: 'Khách hàng', desc: 'CRM, chiến dịch', group: 'work' },
  { key: 'erp', label: 'Công việc', desc: 'Việc, lịch, ghi chú', group: 'work' },
  { key: 'workflow', label: 'Tự động hoá', desc: 'Workflow', group: 'work' },
  { key: 'integration', label: 'Tích hợp', desc: 'POS, vận chuyển', group: 'work' },
  { key: 'analytics', label: 'Báo cáo', desc: 'Thống kê', group: 'work' },
  { key: 'ai_assistant', label: 'Trợ lý AI', desc: 'Gợi ý, trả lời tự động', group: 'work' },
  { key: 'settings_accounts', label: 'Quản lý tài khoản', desc: 'Cài đặt → Tài khoản', group: 'settings' },
  { key: 'settings_employees', label: 'Quản lý nhân viên', desc: 'Trang này', group: 'settings' },
];

/** Quyền nhân viên mới được giao sẵn. */
export const DEFAULT_NEW_EMPLOYEE_MODULES: readonly string[] = ['chat'];

export interface EmployeePermissionRow {
  module: string;
  can_access: boolean | number;
}

export interface EmployeeLike {
  employee_id: string;
  username: string;
  display_name: string;
  is_active: number | boolean;
  last_login?: number | null;
  permissions?: EmployeePermissionRow[];
  assigned_accounts?: string[];
  group_id?: string | null;
}

/** Một nhân viên như `employee:list` trả về (không có mật khẩu). */
export interface EmployeeRecord extends EmployeeLike {
  avatar_url: string;
  role: string;
  is_active: number;
  group_id: string | null;
  last_login: number | null;
  permissions: EmployeePermissionRow[];
  assigned_accounts: string[];
}

export interface AccountLike {
  zalo_id: string;
  full_name?: string;
}

export interface ConnectedEmployeeLike {
  employee_id: string;
  ip_address?: string;
  connected_at?: number;
}

/** Quyền đang bật (theo EMPLOYEE_MODULES) → map module → bật. */
export function permissionMap(rows: readonly EmployeePermissionRow[] | undefined): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const module of EMPLOYEE_MODULES) map[module.key] = false;
  for (const row of rows || []) if (row && row.module in map) map[row.module] = !!row.can_access;
  return map;
}

/**
 * Danh sách đầy đủ để lưu (mọi mục trên màn hình, kể cả mục tắt). Quyền cũ không còn trên màn hình (vd `facebook`,
 * `settings`) giữ nguyên giá trị đang lưu.
 */
export function permissionRows(
  map: Record<string, boolean>,
  existing: readonly EmployeePermissionRow[] = [],
): Array<{ module: string; can_access: boolean }> {
  const shown = new Set(EMPLOYEE_MODULES.map((module) => module.key));
  const kept = existing
    .filter((row) => row && !shown.has(row.module))
    .map((row) => ({ module: row.module, can_access: !!row.can_access }));
  return [...EMPLOYEE_MODULES.map((module) => ({ module: module.key, can_access: !!map[module.key] })), ...kept];
}

/** "A, B, C +2" — tối đa `max` tên, phần còn lại thành số. */
export function shortList(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

/** Tóm tắt dòng "Quyền dùng". */
export function summarizeModules(map: Record<string, boolean>): { text: string; count: number } {
  const labels = EMPLOYEE_MODULES.filter((module) => map[module.key]).map((module) => module.label);
  return { text: labels.length ? shortList(labels) : 'Chưa có quyền nào', count: labels.length };
}

/** Tóm tắt dòng "Tài khoản chat" (tài khoản đã gỡ khỏi app thì không tính). */
export function summarizeAccounts(assigned: readonly string[] | undefined, accounts: readonly AccountLike[]): { text: string; count: number } {
  const byId = new Map(accounts.map((account) => [account.zalo_id, account]));
  const names = (assigned || [])
    .map((id) => byId.get(id))
    .filter((account): account is AccountLike => !!account)
    .map((account) => account.full_name || account.zalo_id);
  return { text: names.length ? shortList(names, 2) : 'Chưa giao tài khoản nào', count: names.length };
}

/** "vừa xong" / "5 phút" / "2 giờ" / "3 ngày". */
export function formatSince(ts: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ`;
  return `${Math.floor(hours / 24)} ngày`;
}

function formatDay(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Trạng thái dưới tên nhân viên: online (IP, đã vào bao lâu) hoặc lần đăng nhập cuối. */
export function employeePresence(
  employee: EmployeeLike,
  connected: readonly ConnectedEmployeeLike[],
  now: number,
): { online: boolean; text: string } {
  const session = connected.find((item) => item.employee_id === employee.employee_id);
  if (session) {
    const parts = ['Online'];
    if (session.ip_address) parts.push(session.ip_address);
    if (session.connected_at) parts.push(formatSince(session.connected_at, now));
    return { online: true, text: parts.join(' · ') };
  }
  if (employee.last_login) return { online: false, text: `Vào lần cuối ${formatDay(employee.last_login)}` };
  return { online: false, text: 'Chưa đăng nhập lần nào' };
}

function lanRank(ip: string): number {
  const [a, b] = ip.split('.').map((part) => parseInt(part, 10));
  if (a === 192 && b === 168) return ip.startsWith('192.168.56.') || ip.startsWith('192.168.99.') ? 3 : 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 169 && b === 254) return 5;
  return 4;
}

/**
 * Địa chỉ LAN theo thứ tự nên gửi nhân viên: 192.168.x trước, rồi 10.x, 172.16-31.x (thường là WSL / Docker / Hyper-V),
 * mạng ảo VirtualBox (192.168.56.x) và link-local 169.254.x sau cùng. Cùng hạng giữ thứ tự cũ.
 */
export function sortLanIps(ips: readonly string[]): string[] {
  return ips.map((ip, index) => ({ ip, index, rank: lanRank(ip) }))
    .sort((x, y) => x.rank - y.rank || x.index - y.index)
    .map((item) => item.ip);
}

/** Tên đăng nhập gợi ý từ tên hiển thị: bỏ dấu, viết thường, chỉ chữ + số ("Nguyễn Văn Đức" → "nguyenvanduc"). */
export function suggestUsername(displayName: string): string {
  return displayName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24);
}

/** Mật khẩu ngẫu nhiên dễ đọc (không có 0/O, 1/l/I). */
export function generatePassword(length = 10, random: (max: number) => number = defaultRandom): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[random(alphabet.length)];
  return out;
}

function defaultRandom(max: number): number {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint32Array(1);
    cryptoObj.getRandomValues(buf);
    return buf[0] % max;
  }
  return Math.floor(Math.random() * max);
}

/** Nội dung gửi cho nhân viên vừa tạo (dán vào Zalo / tin nhắn). */
export function employeeLoginText(info: {
  displayName: string;
  username: string;
  password: string;
  lanHost?: string | null;
  port?: number | null;
  internetUrl?: string | null;
}): string {
  const lines = [`Tài khoản Deplao của ${info.displayName || info.username}`];
  if (info.lanHost) lines.push(`Địa chỉ máy chủ: ${info.lanHost}`, `Cổng: ${info.port || 9900}`);
  if (info.internetUrl) lines.push(`${info.lanHost ? 'Ở xa, dùng địa chỉ' : 'Địa chỉ máy chủ'}: ${info.internetUrl}`);
  lines.push(`Tên đăng nhập: ${info.username}`, `Mật khẩu: ${info.password}`);
  lines.push('Trong Deplao: Cài đặt → Workspace → Thêm workspace → Kết nối máy chủ.');
  return lines.join('\n');
}

export interface GroupLike {
  group_id: string;
  name: string;
}

export interface EmployeeGroupRecord extends GroupLike {
  color?: string;
  sort_order?: number;
}

/** Tóm tắt dòng "Nhóm" dưới thẻ nhân viên: tên nhóm đang ở, không thì "Chưa có nhóm". */
export function summarizeGroup(employee: EmployeeLike, groups: readonly GroupLike[]): { text: string; grouped: boolean } {
  const group = employee.group_id ? groups.find((item) => item.group_id === employee.group_id) : undefined;
  return group ? { text: group.name, grouped: true } : { text: 'Chưa có nhóm', grouped: false };
}

/** Đã có nhóm trùng tên (bỏ khoảng trắng hai đầu, không phân biệt hoa thường). */
export function groupNameTaken(groups: readonly GroupLike[], name: string, exceptId?: string): boolean {
  const value = name.trim().toLowerCase();
  return !!value && groups.some((group) => group.group_id !== exceptId && group.name.trim().toLowerCase() === value);
}

/** Lỗi của tên đăng nhập (giống luật bên máy chủ), rỗng = hợp lệ. */
export function usernameError(username: string): string {
  const value = username.trim();
  if (!value) return 'Nhập tên đăng nhập';
  if (value.length < 3) return 'Ít nhất 3 ký tự';
  if (!/^[a-z0-9_]+$/.test(value)) return 'Chỉ chữ thường không dấu, số và _';
  return '';
}

/** Lỗi của mật khẩu (ít nhất 4 ký tự), rỗng = hợp lệ. */
export function passwordError(password: string): string {
  if (!password) return 'Nhập mật khẩu';
  return password.length < 4 ? 'Ít nhất 4 ký tự' : '';
}

/** Nhân viên theo nhóm (thứ tự nhóm), người chưa có nhóm ở cuối; không có nhóm nào thì một khối không tiêu đề. */
export function groupEmployees<E extends EmployeeLike, G extends GroupLike>(
  employees: readonly E[],
  groups: readonly G[],
): Array<{ group: G | null; employees: E[] }> {
  if (groups.length === 0) return employees.length ? [{ group: null, employees: [...employees] }] : [];
  const known = new Set(groups.map((group) => group.group_id));
  const result: Array<{ group: G | null; employees: E[] }> = [];
  for (const group of groups) {
    const members = employees.filter((employee) => employee.group_id === group.group_id);
    if (members.length) result.push({ group, employees: members });
  }
  const loose = employees.filter((employee) => !employee.group_id || !known.has(employee.group_id));
  if (loose.length) result.push({ group: null, employees: loose });
  return result;
}

/** Tìm theo tên hiển thị / tên đăng nhập, không phân biệt dấu. */
export function matchEmployee(employee: EmployeeLike, query: string): boolean {
  const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const q = fold(query.trim());
  if (!q) return true;
  return fold(employee.display_name || '').includes(q) || fold(employee.username || '').includes(q);
}
