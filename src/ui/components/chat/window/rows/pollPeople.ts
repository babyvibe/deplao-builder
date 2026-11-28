/**
 * Name + avatar of the people who voted in a poll card: the account itself ("Bạn"), contacts, group members. Ids Deplao
 * knows nothing about yet show their id until the member list loads.
 */
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { useAccountStore } from '@/store/accounts/accountStore';
import { tr } from '../../../../../shared/i18n';
import type { PollPerson } from '../../facebook/FacebookPollBubble';
import type { MessageRowContext } from './rowContext';

export function pollPersonResolver(
  ctx: Pick<MessageRowContext, 'activeAccountId' | 'getContact' | 'getGroupMember'>,
): (userId: string) => PollPerson {
  return (userId: string) => {
    const id = String(userId);
    if (id && id === String(ctx.activeAccountId || '')) {
      const account = useAccountStore.getState().accounts.find(a => a.zalo_id === id);
      return { id, name: tr('Bạn'), avatar: toLocalMediaUrl(account?.avatar_url || '') };
    }
    const contact = ctx.getContact(id) as any;
    const member = ctx.getGroupMember(id) as any;
    const contactName = String(contact?.alias || contact?.display_name || '');
    const name = (contactName && contactName !== id ? contactName : '') || String(member?.displayName || '') || contactName || id;
    return { id, name, avatar: toLocalMediaUrl(contact?.avatar_url || member?.avatar || '') };
  };
}
