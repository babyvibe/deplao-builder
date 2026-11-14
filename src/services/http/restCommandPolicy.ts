/**
 * restCommandPolicy.ts: REST write commands of employees (POST/PUT/PATCH/DELETE /api/command/*): the pure rule part, has tests.
 *
 * checkEmployeeAccess (employeeAccess.ts) has already checked the usual account ids (zaloId...) in the parameters. This is the
 * part specific to write commands, run right after it in HttpRelayService.executeRestCommand:
 *   1. Module permission per command group, using the same table as the proxy path (channelToModule): crm/* → crm, workflows → workflow,
 *      integrations → integration, ai/* → ai_assistant. Previously REST did not check: an employee whose module was turned off could still
 *      edit / delete Boss's campaigns, workflows, integrations and AI assistant.
 *   2. Commands only Boss may run: network proxies (/api/command/proxies*, /api/command/accounts/proxy). Assigning a proxy to an account =
 *      routing all of the account's traffic (cookies included) through a server chosen by the caller.
 *   3. The source / target accounts of a clone command (sourceZaloId / targetZaloId / targetZaloIds) must also be assigned: previously
 *      an employee could copy quick messages / labels from an account they were not assigned into their own account (and the reverse).
 */

import { tr } from '../../shared/i18n';

export interface CommandEmployee {
  assigned_accounts?: readonly string[] | null;
}

export type RestCommandDenied = {
  status: 403;
  code: 'MODULE_FORBIDDEN' | 'COMMAND_FORBIDDEN' | 'ACCOUNT_FORBIDDEN';
  error: string;
};

/** Command group tied to one permission module (same module name as EmployeeService / ALL_MODULES). */
const COMMAND_MODULES: ReadonlyArray<{ prefix: string; module: string }> = [
  { prefix: '/api/command/crm/', module: 'crm' },
  { prefix: '/api/command/workflows', module: 'workflow' },
  { prefix: '/api/command/integrations', module: 'integration' },
  { prefix: '/api/command/ai/', module: 'ai_assistant' },
  // ERP: detailed ERP permissions (RBAC per ERP profile) are checked additionally in HttpRelayService.executeErpRest
  { prefix: '/api/command/erp/', module: 'erp' },
];

/** Commands only Boss may run (employees are always rejected). */
const BOSS_ONLY_COMMAND_PREFIXES: readonly string[] = ['/api/command/proxies', '/api/command/accounts/proxy'];

/** Secondary account parameters of a write command (beyond the keys checkEmployeeAccess already checked). */
export const COMMAND_EXTRA_ACCOUNT_KEYS = ['sourceZaloId', 'targetZaloId'] as const;
/** The same, as a list (campaign clone into several accounts: targetZaloIds). */
export const COMMAND_EXTRA_ACCOUNT_LIST_KEYS = ['targetZaloIds'] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Permission module needed for a write command (undefined = no separate module required, e.g. labels / quick messages / pins). */
export function requiredCommandModule(pathname: string): string | undefined {
  const path = String(pathname || '');
  return COMMAND_MODULES.find((rule) => matchesPrefix(path, rule.prefix))?.module;
}

export function isBossOnlyCommand(pathname: string): boolean {
  const path = String(pathname || '');
  return BOSS_ONLY_COMMAND_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

/** Source / target account ids in the command parameters (empty ones are skipped). */
export function commandExtraAccountIds(params: Record<string, unknown> | null | undefined): string[] {
  const ids = new Set<string>();
  if (!params) return [];
  const add = (raw: unknown) => {
    if (raw === undefined || raw === null) return;
    const id = String(raw).trim();
    if (id) ids.add(id);
  };
  for (const key of COMMAND_EXTRA_ACCOUNT_KEYS) add(params[key]);
  for (const key of COMMAND_EXTRA_ACCOUNT_LIST_KEYS) {
    const raw = params[key];
    // Not a list → the whole value is one id (never skipped: a string would otherwise pass unchecked)
    if (Array.isArray(raw)) raw.forEach(add); else add(raw);
  }
  return [...ids];
}

/** null = allowed. `hasPermission(module)` is provided by Boss (EmployeeService.hasPermission). */
export function checkRestCommand(
  employee: CommandEmployee,
  pathname: string,
  params: Record<string, unknown> | null | undefined,
  hasPermission: (module: string) => boolean,
): RestCommandDenied | null {
  if (isBossOnlyCommand(pathname)) {
    return { status: 403, code: 'COMMAND_FORBIDDEN', error: tr('Thao tác này chỉ Boss được thực hiện') };
  }
  const assigned = new Set((employee.assigned_accounts || []).map(String));
  if (commandExtraAccountIds(params).some((id) => !assigned.has(id))) {
    return { status: 403, code: 'ACCOUNT_FORBIDDEN', error: tr('Không có quyền truy cập tài khoản này') };
  }
  const module = requiredCommandModule(pathname);
  if (module && !hasPermission(module)) {
    return { status: 403, code: 'MODULE_FORBIDDEN', error: tr('Không có quyền truy cập module: {{module}}', { module }) };
  }
  return null;
}

/**
 * Default account when the command does not send `zaloId`: only when the employee is assigned exactly ONE account (no ambiguity).
 * Previously the first assigned account was always taken → a command missing that parameter wrote into a different account.
 */
export function defaultCommandAccount(params: Record<string, unknown> | null | undefined, assignedAccounts: readonly string[] | null | undefined): string {
  const explicit = params?.zaloId;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) return String(explicit).trim();
  const assigned = [...new Set((assignedAccounts || []).map((id) => String(id || '').trim()).filter(Boolean))];
  return assigned.length === 1 ? assigned[0] : '';
}

/**
 * Dynamic part of the command path, via a regex with capture groups (%xx decoded). Previously it was cut with `split('/')[3]` →
 * for /api/command/conversations/<id>/flags it took the word "conversations" as the id (flags / aliases / conversation deletes were written
 * to the contact named "conversations"; the same for labels, workflows, integrations).
 */
export function commandPathParams(pathname: string, pattern: RegExp): string[] | null {
  const match = pattern.exec(String(pathname || ''));
  if (!match) return null;
  return match.slice(1).map((part) => {
    try { return decodeURIComponent(part ?? ''); } catch { return part ?? ''; }
  });
}

/** Page list of a workflow: a pageIds array, an "a,b" string (page_ids column) or a single pageId. */
export function workflowPageIds(pageIds: unknown, pageId?: unknown): string[] {
  const list: unknown[] = Array.isArray(pageIds)
    ? pageIds
    : (typeof pageIds === 'string' ? pageIds.split(',') : []);
  const ids = list.map((id) => String(id ?? '').trim()).filter(Boolean);
  if (ids.length === 0 && pageId !== undefined && pageId !== null && String(pageId).trim()) ids.push(String(pageId).trim());
  return [...new Set(ids)];
}

/**
 * An employee may only save / toggle / delete a workflow whose EVERY page belongs to an assigned account. Editing a workflow attached to a page
 * that is not assigned would change that account's auto replies. Shared workflows (not attached to a page) stay as before.
 */
export function workflowPagesAllowed(pageIds: readonly string[], assignedAccounts: readonly string[] | null | undefined): boolean {
  if (pageIds.length === 0) return true;
  const assigned = new Set((assignedAccounts || []).map((id) => String(id)));
  return pageIds.every((id) => assigned.has(id));
}

/** Positive integer from a parameter (id of a label / campaign / quick message...); invalid → 0. */
export function positiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
