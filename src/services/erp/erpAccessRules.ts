/**
 * erpAccessRules: ERP permission rules that depend on the parameters / existing data (pure logic, has tests: erpRestRoutes.test.ts).
 *
 * The erp:* IPC handlers (shared by the Boss UI, employees through REST and API v1) call these functions, then
 * `requireErpPermission(action, ctx)` for each permission returned, including the personal permissions (allow / deny) of the ERP profile.
 * Before the employee REST API existed, these checks only ran on each machine's local DB, so the hole was not exposed; now an
 * employee calls the Boss directly, so every rule has to be correct here.
 */
import { parseErpPermissionOverridesFromExtraJson } from './permissions';

export type AssignmentAction = 'task.assign_self' | 'task.assign_others';

function idSet(ids: readonly unknown[] | null | undefined): Set<string> {
  return new Set((Array.isArray(ids) ? ids : []).map((id) => (id === undefined || id === null ? '' : String(id))).filter(Boolean));
}

/**
 * Assign permission based on the CHANGE to the assignees compared with now: no change → null (no permission needed); only adding / removing
 * yourself → task.assign_self; adding / removing other people → task.assign_others. (Before, the whole list sent up was checked:
 * the task edit form always sends the assignees too → a member editing a task's title, for a task assigned to someone else, was refused.)
 */
export function assignmentAction(nextIds: readonly unknown[], currentIds: readonly unknown[], actorId: string): AssignmentAction | null {
  const next = idSet(nextIds);
  const current = idSet(currentIds);
  const changed = [...next].filter((id) => !current.has(id)).concat([...current].filter((id) => !next.has(id)));
  if (!changed.length) return null;
  return changed.every((id) => id === actorId) ? 'task.assign_self' : 'task.assign_others';
}

/**
 * Deleting a task: the creator can delete their own task if they have the edit right (same rule as the employee REST API before); a task of
 * someone else needs task.delete. null = no extra permission needed.
 */
export function taskDeleteAction(reporterId: string | null | undefined, actorId: string, canUpdateTask: boolean): 'task.delete' | null {
  return reporterId && reporterId === actorId && canUpdateTask ? null : 'task.delete';
}

/** Organisation fields of the profile: department, job title, direct manager (= the leave approval line), start date. */
export const PROFILE_ORG_FIELDS = ['department_id', 'position_id', 'manager_employee_id', 'joined_at'] as const;

export const ERP_ROLE_NAMES = ['owner', 'admin', 'manager', 'member', 'guest'] as const;

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  return norm(a) === norm(b);
}

/** The same set of per-person permissions (extra_json.action_permissions), regardless of key order / string format. */
export function sameErpOverrides(a: unknown, b: unknown): boolean {
  const key = (raw: unknown) => {
    const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw);
    return JSON.stringify(Object.entries(parseErpPermissionOverridesFromExtraJson(text)).sort(([x], [y]) => x.localeCompare(y)));
  };
  return key(a) === key(b);
}

/**
 * Extra permission needed for an edit to an ERP profile (on top of employee.edit_self / edit_others): only the fields that really change are checked
 * (the form always sends the whole profile back):
 *  - changing the ERP role / personal permissions → settings.erp (owner / admin). Before, anyone with employee.edit_self could promote themselves to
 *    owner; through the employee REST API that was privilege escalation on the Boss;
 *  - changing your own organisation fields (e.g. choosing your own leave approver) → employee.edit_others (manager).
 */
export function profilePatchActions(
  patch: Record<string, unknown> | null | undefined,
  current: Record<string, unknown> | null | undefined,
  isSelf: boolean,
): string[] {
  const p = patch || {};
  const actions: string[] = [];
  if (isSelf && PROFILE_ORG_FIELDS.some((field) => p[field] !== undefined && !sameValue(p[field], current?.[field]))) {
    actions.push('employee.edit_others');
  }
  const roleChanged = p.erp_role !== undefined && !sameValue(p.erp_role, current?.erp_role ?? 'member');
  const overridesChanged = p.extra_json !== undefined && !sameErpOverrides(p.extra_json, current?.extra_json);
  if (roleChanged || overridesChanged) actions.push('settings.erp');
  return actions;
}

/** Deleting the profile of someone with a role on member = demoting them → needs the ERP configuration right, as when changing a role. */
export function profileDeleteAction(role: unknown): 'settings.erp' | null {
  const r = String(role || 'member');
  return r === 'member' || r === 'guest' ? null : 'settings.erp';
}

/**
 * A calendar event that invites other people (attendees other than yourself) = a meeting → calendar.create_meeting (owner / admin / manager).
 * Before, the right to create personal events was enough to invite anyone, and to send them the "Mời tham dự" (Invitation) notification.
 */
export function eventInviteAction(attendees: readonly unknown[] | null | undefined, actorId: string): 'calendar.create_meeting' | null {
  return [...idSet(attendees)].some((id) => id !== actorId) ? 'calendar.create_meeting' : null;
}

/** Leave approver: the direct manager of the person asking for leave (manager_employee_id) or the Boss, as in listPendingForManager. */
export function canDecideLeave(approverId: string, managerId: string | null | undefined): boolean {
  if (approverId === 'boss') return true;
  return !!managerId && managerId === approverId;
}
