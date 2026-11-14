/**
 * "Cài đặt" → "Nhân viên" (Settings → Employees): the pure part (no React) of the page: the permission list, the summary line under each employee, the status
 * online, the suggested login name / password, the message sent to the employee after creating them. Has its own tests.
 */

/** One employee-usable item (key = module in employee_permissions). */
import { tr } from '../../../shared/i18n';

export interface EmployeeModule {
  key: string;
  label: string;
  desc: string;
  /** work = the working pages; settings = the "Cài đặt" (Settings) section that only the owner has (not assigned by default). */
  group: 'work' | 'settings';
}

/**
 * Order = the order on screen. Keys stay the same (saved in the DB, Boss checks them when an employee calls). `facebook` no longer has
 * its own item: Facebook follows the "Tin nhắn" (Messages) permission + the accounts assigned, like every other channel.
 */
export const EMPLOYEE_MODULES: readonly EmployeeModule[] = [
  { key: 'chat', label: tr('Tin nhắn'), desc: tr('Đọc, trả lời tin'), group: 'work' },
  { key: 'friends', label: tr('Bạn bè'), desc: tr('Danh bạ, lời mời kết bạn'), group: 'work' },
  { key: 'crm', label: tr('Khách hàng'), desc: tr('CRM, chiến dịch'), group: 'work' },
  { key: 'erp', label: tr('Công việc'), desc: tr('Việc, lịch, ghi chú'), group: 'work' },
  { key: 'workflow', label: tr('Tự động hoá'), desc: 'Workflow', group: 'work' },
  { key: 'integration', label: tr('Tích hợp'), desc: tr('POS, vận chuyển'), group: 'work' },
  { key: 'analytics', label: tr('Báo cáo'), desc: tr('Thống kê'), group: 'work' },
  { key: 'ai_assistant', label: tr('Trợ lý AI'), desc: tr('Gợi ý, trả lời tự động'), group: 'work' },
  { key: 'settings_accounts', label: tr('Quản lý tài khoản'), desc: tr('Cài đặt → Tài khoản'), group: 'settings' },
  { key: 'settings_employees', label: tr('Quản lý nhân viên'), desc: tr('Trang này'), group: 'settings' },
];

/** Permissions a new employee is given by default. */
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

/** One employee as returned by `employee:list` (without the password). */
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

/** Permissions currently on (by EMPLOYEE_MODULES) → map of module → on. */
export function permissionMap(rows: readonly EmployeePermissionRow[] | undefined): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const module of EMPLOYEE_MODULES) map[module.key] = false;
  for (const row of rows || []) if (row && row.module in map) map[row.module] = !!row.can_access;
  return map;
}

/**
 * The full list to save (every item on screen, including the ones turned off). Old permissions that are no longer on screen (e.g. `facebook`,
 * `settings`) keep the value currently saved.
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

/** "A, B, C +2": at most `max` names, the rest becomes a number. */
export function shortList(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

/** Summary of the "Quyền dùng" (Permissions in use) line. */
export function summarizeModules(map: Record<string, boolean>): { text: string; count: number } {
  const labels = EMPLOYEE_MODULES.filter((module) => map[module.key]).map((module) => module.label);
  return { text: labels.length ? shortList(labels) : tr('Chưa có quyền nào'), count: labels.length };
}

/** Summary of the "Tài khoản chat" (Chat accounts) line (accounts removed from the app are not counted). */
export function summarizeAccounts(assigned: readonly string[] | undefined, accounts: readonly AccountLike[]): { text: string; count: number } {
  const byId = new Map(accounts.map((account) => [account.zalo_id, account]));
  const names = (assigned || [])
    .map((id) => byId.get(id))
    .filter((account): account is AccountLike => !!account)
    .map((account) => account.full_name || account.zalo_id);
  return { text: names.length ? shortList(names, 2) : tr('Chưa giao tài khoản nào'), count: names.length };
}

/** "vừa xong" (just now) / "5 phút" (5 minutes) / "2 giờ" (2 hours) / "3 ngày" (3 days). */
export function formatSince(ts: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return tr('vừa xong');
  if (minutes < 60) return tr('{{minutes}} phút', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr('{{hours}} giờ', { hours });
  return tr('{{v1}} ngày', { v1: Math.floor(hours / 24) });
}

function formatDay(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Status under the employee's name: online (IP, how long ago they came online) or the last login. */
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
  if (employee.last_login) return { online: false, text: tr('Vào lần cuối {{v1}}', { v1: formatDay(employee.last_login) }) };
  return { online: false, text: tr('Chưa đăng nhập lần nào') };
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
 * LAN addresses in the order to send to employees: 192.168.x first, then 10.x, 172.16-31.x (usually WSL / Docker / Hyper-V),
 * the VirtualBox virtual network (192.168.56.x) and link-local 169.254.x last. Within the same rank the old order is kept.
 */
export function sortLanIps(ips: readonly string[]): string[] {
  return ips.map((ip, index) => ({ ip, index, rank: lanRank(ip) }))
    .sort((x, y) => x.rank - y.rank || x.index - y.index)
    .map((item) => item.ip);
}

/** Login name suggested from the display name: diacritics removed, lowercase, letters + digits only ("Nguyễn Văn Đức" → "nguyenvanduc"). */
export function suggestUsername(displayName: string): string {
  return displayName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24);
}

/** Random password that is easy to read (no 0/O, 1/l/I). */
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

/** Message sent to the employee just created (pasted into Zalo / a message). */
export function employeeLoginText(info: {
  displayName: string;
  username: string;
  password: string;
  lanHost?: string | null;
  port?: number | null;
  internetUrl?: string | null;
}): string {
  const lines = [tr('Tài khoản Deplao của {{v1}}', { v1: info.displayName || info.username })];
  if (info.lanHost) lines.push(tr('Địa chỉ máy chủ: {{lanHost}}', { lanHost: info.lanHost }), tr('Cổng: {{v1}}', { v1: info.port || 9900 }));
  if (info.internetUrl) lines.push(`${info.lanHost ? tr('Ở xa, dùng địa chỉ') : tr('Địa chỉ máy chủ')}: ${info.internetUrl}`);
  lines.push(tr('Tên đăng nhập: {{username}}', { username: info.username }), tr('Mật khẩu: {{password}}', { password: info.password }));
  lines.push(tr('Trong Deplao: Cài đặt → Workspace → Thêm workspace → Kết nối máy chủ.'));
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

/** Summary of the "Nhóm" (Group) line under the employee card: the name of the group they are in, otherwise "Chưa có nhóm" (No group yet). */
export function summarizeGroup(employee: EmployeeLike, groups: readonly GroupLike[]): { text: string; grouped: boolean } {
  const group = employee.group_id ? groups.find((item) => item.group_id === employee.group_id) : undefined;
  return group ? { text: group.name, grouped: true } : { text: tr('Chưa có nhóm'), grouped: false };
}

/** A group with the same name already exists (leading / trailing spaces removed, case-insensitive). */
export function groupNameTaken(groups: readonly GroupLike[], name: string, exceptId?: string): boolean {
  const value = name.trim().toLowerCase();
  return !!value && groups.some((group) => group.group_id !== exceptId && group.name.trim().toLowerCase() === value);
}

/** Error for the login name (same rules as the server), empty = valid. */
export function usernameError(username: string): string {
  const value = username.trim();
  if (!value) return tr('Nhập tên đăng nhập');
  if (value.length < 3) return tr('Ít nhất 3 ký tự');
  if (!/^[a-z0-9_]+$/.test(value)) return tr('Chỉ chữ thường không dấu, số và _');
  return '';
}

/** Error for the password (at least 4 characters), empty = valid. */
export function passwordError(password: string): string {
  if (!password) return tr('Nhập mật khẩu');
  return password.length < 4 ? tr('Ít nhất 4 ký tự') : '';
}

/** Employees grouped by group (in group order), people without a group at the end; if there are no groups, a single block without a heading. */
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

/** Search by display name / login name, ignoring diacritics. */
export function matchEmployee(employee: EmployeeLike, query: string): boolean {
  const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const q = fold(query.trim());
  if (!q) return true;
  return fold(employee.display_name || '').includes(q) || fold(employee.username || '').includes(q);
}
