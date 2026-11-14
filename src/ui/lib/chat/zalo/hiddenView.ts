/**
 * The list shown when viewing Zalo's hidden conversations (ZL-03, after typing the right PIN): ONLY the hidden conversations of the unlocked account, newest
 * first, not mixed with normal conversations. Source: the pages already loaded (live state) overwrite the catch-up copies by id.
 */
import type { ContactItem } from '@/store/chat/chatStore';

export function hiddenViewRows(
  accountIds: ReadonlyArray<string>,
  hiddenByAccount: Readonly<Record<string, ReadonlySet<string> | undefined>>,
  extrasByAccount: Readonly<Record<string, ReadonlyArray<ContactItem> | undefined>>,
  loadedByAccount: Readonly<Record<string, ReadonlyArray<ContactItem> | undefined>>,
): ContactItem[] {
  const rows: ContactItem[] = [];
  for (const accountId of accountIds) {
    const ids = hiddenByAccount[accountId];
    if (!ids || ids.size === 0) continue;
    const byId = new Map<string, ContactItem>();
    const add = (contact: ContactItem) => {
      if (ids.has(contact.contact_id)) byId.set(contact.contact_id, contact.owner_zalo_id ? contact : { ...contact, owner_zalo_id: accountId });
    };
    for (const contact of extrasByAccount[accountId] || []) add(contact);
    for (const contact of loadedByAccount[accountId] || []) add(contact);
    rows.push(...byId.values());
  }
  return rows.sort((a, b) => (Number(b.last_message_time) || 0) - (Number(a.last_message_time) || 0));
}
