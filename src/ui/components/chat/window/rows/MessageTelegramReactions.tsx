/**
 * Telegram reaction chips of a message row (TelegramReactionChips), inside the message frame or right below a sticker / photo:
 * click = add / remove that reaction, reactors' pictures from the contacts, the group's members and your own account.
 */
import { useAccountStore } from '@/store/accounts/accountStore';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { parseReactionsFull } from '../../messages/reactions/ReactionComponents';
import { TelegramReactionChips, telegramReactionChips, type ReactionPeer } from '../../messages/reactions/TelegramReactionChips';
import type { MessageRowContext } from './rowContext';
import { tr } from '../../../../../shared/i18n';

export function MessageTelegramReactions({ ctx, msg, className, trailingSpacerClass }: {
  ctx: MessageRowContext;
  msg: any;
  className?: string;
  trailingSpacerClass?: string;
}) {
  const { activeAccountId, getContact, getGroupMember, handleCancelReaction, handleReact } = ctx;
  const ownAvatar = useAccountStore((s) => s.accounts.find((account) => account.zalo_id === activeAccountId)?.avatar_url || '');
  const chips = telegramReactionChips(parseReactionsFull(msg.reactions, msg.channel).emoji, activeAccountId, true);
  const peerOf = (id: string): ReactionPeer => {
    if (id === activeAccountId) return { name: tr('Bạn'), avatarUrl: ownAvatar ? toLocalMediaUrl(ownAvatar) : '' };
    const contact = getContact(id);
    const member = getGroupMember(id);
    const name = contact?.alias || contact?.display_name || member?.displayName
      || [member?.firstName, member?.lastName].filter(Boolean).join(' ') || id;
    const avatar = contact?.avatar_url || member?.avatar || '';
    return { name, avatarUrl: avatar ? toLocalMediaUrl(avatar) : '' };
  };
  return (
    <TelegramReactionChips
      chips={chips}
      peerOf={peerOf}
      className={className}
      trailingSpacerClass={trailingSpacerClass}
      onToggle={(emoji, mine) => {
        if (mine) void handleCancelReaction(msg);
        else void handleReact(msg, emoji);
      }}
    />
  );
}
