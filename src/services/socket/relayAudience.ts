/**
 * relayAudience.ts: who may receive a realtime event from Boss → employee (pure part, testable).
 *
 * Shared by direct sending (SocketIOService.publish) and replay on reconnect (catch-up): the same rule,
 * the same "assigned accounts" source as the REST permission checks (RegisteredEmployee.assigned_accounts in HttpRelayService,
 * kept in sync by updateEmployeeRooms). Previously catch-up sent the whole buffer (every account, every employee) to the client.
 *
 * classifyRelayEvent → RelayAudience:
 *  - accounts  - the event carries an account id (zaloId / ownerZaloId / accountId...): only employees assigned that account.
 *                An employee with no assigned account receives nothing (like REST: every account is 403).
 *  - employees - addressed to specific people: ERP calendar + reminders (organizer / participants), notes (author / people
 *                it is shared with), ERP notifications (recipient_id). An empty list → only Boss ('boss', not an employee).
 *  - global    - the workspace's shared data, safe for every employee: GLOBAL_RELAY_CHANNELS, ERP notes at workspace scope,
 *                and events WITHOUT an account id on config channels (e.g. db:localQuickMessageChanged
 *                active/reorder, relay:*...).
 *  - nobody    - chat / CRM / Facebook channels (ACCOUNT_REQUIRED_PREFIXES) or per-account conversation data
 *                (ACCOUNT_REQUIRED_CHANNELS) but missing the account id → nobody is sent it (it does not leak to other accounts).
 * The list of relayed channels: relayChannels.ts.
 */

/** Boss's user id in ERP (ErpAuthContext), which is never an employee's employee_id. */
export const BOSS_ACTOR_ID = 'boss';

export type RelayAudience =
  | { kind: 'global' }
  | { kind: 'nobody' }
  | { kind: 'accounts'; accountIds: readonly string[] }
  | { kind: 'employees'; employeeIds: readonly string[] };

const GLOBAL: RelayAudience = { kind: 'global' };
const NOBODY: RelayAudience = { kind: 'nobody' };

/**
 * Workspace-wide data channels: every connected employee receives them (even when the payload carries an account id).
 * ERP: projects / tasks / comments / leave / attendance / departments / HR records are workspace-level data
 * of the ERP module (as before, not filtered by account).
 */
export const GLOBAL_RELAY_CHANNELS: ReadonlySet<string> = new Set([
  'db:localLabelChanged', // shared label definitions (the local_labels table is not per account)
  'workflow:executed', // workflow run / save state
  'workflow:changed', // the workflow list changed (only id + action): each machine reloads its own list, filtered by permission
  // integration:payment / integration:webhook: no longer relayed (they only trigger workflows on Boss): relayChannels.ts
  'erp:event:projectCreated',
  'erp:event:projectUpdated',
  'erp:event:projectDeleted',
  'erp:event:taskCreated',
  'erp:event:taskUpdated',
  'erp:event:taskDeleted',
  'erp:event:commentAdded',
  'erp:event:leaveCreated',
  'erp:event:leaveDecided',
  'erp:event:attendanceUpdated',
  'erp:event:departmentUpdated',
  'erp:event:employeeProfileUpdated',
  'erp:event:employeeProfileDeleted',
]);

/** Chat / CRM / Facebook channels always belong to ONE account: without an account id nobody is sent the event (safer than sending it to everyone). */
export const ACCOUNT_REQUIRED_PREFIXES: readonly string[] = ['event:', 'crm:', 'fb:'];

/**
 * Config channels (db:*, library:*) whose data belongs to ONE conversation / account: if the sender forgets the account id, nobody
 * is sent it (previously it fell into "global" → every employee received the pins / flags / aliases / conversation deletes of other accounts).
 * Excludes db:localQuickMessageChanged (active/reorder only carry an id) and db:localLabelChanged (shared).
 * library:itemUpdated: LibraryService.updateItem sends zaloId = the page that owns the item (previously absent → every employee).
 */
export const ACCOUNT_REQUIRED_CHANNELS: ReadonlySet<string> = new Set([
  'db:localLabelThreadChanged',
  'db:pinnedMessageChanged',
  'db:pinnedConversationChanged',
  'db:starredMessageChanged',
  'db:contactFlagsChanged',
  'db:contactAliasChanged',
  'db:contactProfileUpdated',
  'db:conversationDeleted',
  'db:unreadChanged',
  'library:itemAdded',
  'library:itemUpdated',
  'library:itemDeleted',
]);

/**
 * Channels that only matter in the moment: sent live but NOT buffered / replayed: a "đang soạn tin" (typing) indicator replayed after a reconnect
 * would only show a wrong indicator, and it is the most frequent event (it pushes real events out of the buffer).
 */
export const EPHEMERAL_RELAY_CHANNELS: ReadonlySet<string> = new Set([
  'event:typing',
  'fb:onTyping',
  // Online / last seen (Telegram): an old value replayed after a reconnect only causes a wrong display
  'event:userPresence',
  // Control messages sent to one employee only: live only. Replaying them after a reconnect is wrong
  // ("kicked" would kick the employee who has just logged in again), or redundant (the client refreshes its snapshot itself on resync).
  'relay:kicked',
  'relay:accountAccessUpdate',
  'relay:initialState',
  'relay:permissionUpdate',
]);

export function isEphemeralRelayChannel(channel: string): boolean {
  return EPHEMERAL_RELAY_CHANNELS.has(channel);
}

/**
 * Field names that carry the account id in an event payload (Zalo / Facebook / Telegram all store it in accounts.zalo_id).
 * fbAccountId: fb:* events (FacebookService.getFacebookId() = the accounts.zalo_id of the Facebook account).
 */
export const RELAY_ACCOUNT_FIELDS = ['zaloId', 'zalo_id', 'ownerZaloId', 'owner_zalo_id', 'accountId', 'account_id', 'fbAccountId'] as const;

function nonEmpty(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** The event's account id ('' if none). Old event:message builds only have message.zaloId. */
export function relayEventAccountId(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  for (const key of RELAY_ACCOUNT_FIELDS) {
    const id = nonEmpty(record[key]);
    if (id) return id;
  }
  const message = record.message;
  if (message && typeof message === 'object') {
    const nested = message as Record<string, unknown>;
    return nonEmpty(nested.zaloId) || nonEmpty(nested.accountId);
  }
  return '';
}

function uniqueIds(values: unknown[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const id = nonEmpty(value);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The specific employees; nobody → only Boss (keeps the old rule `allowed.size === 0 ? id === 'boss'`). */
function employeesAudience(ids: unknown[]): RelayAudience {
  const employeeIds = uniqueIds(ids);
  return { kind: 'employees', employeeIds: employeeIds.length ? employeeIds : [BOSS_ACTOR_ID] };
}

function arrayOf(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/** Organizer + participants of one ERP calendar event (= ErpCalendarService.getVisibleEmployeeIdsForEvent). */
function calendarParticipants(event: any): unknown[] {
  if (!event || typeof event !== 'object') return [];
  return [event.organizer_id, ...arrayOf(event.attendees).map((attendee: any) => attendee?.employee_id)];
}

/** Sends one event to exactly one employee (SocketIOService.emitToEmployee). */
export function addressedAudience(employeeId: string): RelayAudience {
  return employeesAudience([employeeId]);
}

/** Classifies the recipients of a relay event: see the top of the file. */
export function classifyRelayEvent(channel: string, data: any): RelayAudience {
  const name = String(channel || '');

  // ── ERP: calendar / reminders: only the organizer + participants (the old HttpRelayService rule) ──
  if (name.startsWith('erp:event:calendarEvent') || name === 'erp:event:reminder') {
    return employeesAudience([...arrayOf(data?.visibleEmployeeIds), ...calendarParticipants(data?.event)]);
  }

  // ── ERP: notes: workspace scope → everyone receives it; otherwise the author + people who can view / were shared with ──
  if (name.startsWith('erp:event:note')) {
    const note = data?.note;
    if (note?.share_scope === 'workspace' || data?.scope === 'workspace') return GLOBAL;
    // noteShared (carries no content): the OLD scope was the workspace → everyone who had viewed it receives it to remove the note from their list
    if (name === 'erp:event:noteShared' && data?.previousScope === 'workspace') return GLOBAL;
    return employeesAudience([
      note?.author_id,
      data?.authorId,
      ...arrayOf(data?.visibleEmployeeIds),
      ...arrayOf(data?.shares).map((share: any) => share?.employeeId || share?.employee_id),
    ]);
  }

  // ── ERP: notifications: sent to the right recipient only (previously every employee added it to their own inbox) ──
  if (name === 'erp:event:notification') {
    return employeesAudience([data?.notification?.recipient_id ?? data?.notification?.recipientId]);
  }

  if (GLOBAL_RELAY_CHANNELS.has(name)) return GLOBAL;

  const accountId = relayEventAccountId(data);
  if (accountId) return { kind: 'accounts', accountIds: [accountId] };

  if (ACCOUNT_REQUIRED_PREFIXES.some((prefix) => name.startsWith(prefix))) return NOBODY;
  if (ACCOUNT_REQUIRED_CHANNELS.has(name)) return NOBODY;
  // Config channel without an account id (e.g. db:localQuickMessageChanged active/reorder):
  // only carries the id + the flag / field just edited → kept as before, sent to every employee.
  return GLOBAL;
}

/**
 * Whether employee `employeeId` (assigned `assignedAccounts`) may receive an event with this audience.
 * `assignedAccounts` must be the current list: the same source as the REST permission checks.
 */
export function canReceiveRelayEvent(
  audience: RelayAudience | null | undefined,
  employeeId: string,
  assignedAccounts: readonly string[] | null | undefined,
): boolean {
  if (!audience) return false;
  switch (audience.kind) {
    case 'global':
      return true;
    case 'employees':
      return !!employeeId && audience.employeeIds.includes(String(employeeId));
    case 'accounts': {
      if (!assignedAccounts || assignedAccounts.length === 0) return false;
      return audience.accountIds.some((id) => assignedAccounts.some((assigned) => String(assigned) === id));
    }
    default:
      return false;
  }
}

/** Normalizes the assigned account list (drops empty / duplicate entries, forces strings). */
export function normalizeAccountList(value: unknown): string[] {
  return uniqueIds(arrayOf(value));
}
