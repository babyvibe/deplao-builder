/**
 * accountContacts.ts: reloads the conversation list of ONE account after an event (reconnect listener, sync
 * finished…), shared by useZaloEvents / useChatEvents / App.
 *
 * Boss / standalone: DB via IPC (all conversations, as before). Employee: `ipc.db.getContacts` is only a stub
 * `{ success: true }` (the employee machine's DB has no conversations) → reads from the BOSS via DataAccessor.getConversations
 * (the latest EMPLOYEE_CONTACT_RELOAD_LIMIT conversations). On a read error → keep the list that is there; do not replace a list that has already
 * loaded more (the user scrolled past the limit); still returns the list just read so the caller can use it (e.g. loading aliases).
 */
import ipc from '@/lib/ipc';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { useChatStore, type ContactItem } from '@/store/chat/chatStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';

export const EMPLOYEE_CONTACT_RELOAD_LIMIT = 500;

/** The list just read (set into the store, unless it would shrink the employee list already there); null = read error / nothing. */
export async function reloadAccountContacts(zaloId: string): Promise<ContactItem[] | null> {
  if (!zaloId) return null;
  if (useEmployeeStore.getState().mode === 'employee') {
    const res = await DataAccessor.getConversations(zaloId, EMPLOYEE_CONTACT_RELOAD_LIMIT, 0);
    if (isReadFailure(res) || !Array.isArray(res?.items) || res.items.length === 0) return null;
    const contacts = res.items as ContactItem[];
    const current = useChatStore.getState().contacts[zaloId] || [];
    if (contacts.length >= current.length) useChatStore.getState().setContacts(zaloId, contacts);
    return contacts;
  }
  // Boss / standalone: DB reads all conversations → replace, as before
  const res: any = await ipc.db?.getContacts(zaloId);
  const contacts: ContactItem[] = Array.isArray(res?.contacts) ? res.contacts : [];
  if (contacts.length === 0) return null;
  useChatStore.getState().setContacts(zaloId, contacts);
  return contacts;
}
