/**
 * "Trên Messenger" results of the global search for a Facebook account: Messenger's people search (friends, other
 * people, Pages, the account's groups). Opening one starts the chat on Messenger and adds the conversation to Deplao.
 */
import React from 'react';
import { ipc } from '@/lib/ipc';
import { Spinner } from '@/components/common/PageLoading';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { useAppStore } from '@/store/app/appStore';
import type { FacebookPersonResult } from '../../../../shared/facebook/facebookPeople';
import { tr } from '../../../../shared/i18n';

const DEBOUNCE_MS = 500;
const SHOWN = 8;

function kindLabel(person: FacebookPersonResult): string {
  if (person.isGroup) return tr('Nhóm');
  if (person.kind === 'contact') return tr('Bạn bè');
  if (person.kind === 'page') return tr('Trang');
  return '';
}

export default function FacebookPeopleResults({ accountId, query, onOpen }: {
  accountId: string;
  query: string;
  onOpen: (threadId: string, threadType: number, info: { display_name: string; avatar_url: string; channel: 'facebook' }) => void;
}) {
  const [results, setResults] = React.useState<FacebookPersonResult[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [opening, setOpening] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState('');
  const seqRef = React.useRef(0);
  const showNotification = useAppStore(s => s.showNotification);
  const text = query.trim();

  React.useEffect(() => {
    const seq = ++seqRef.current;
    setFailed('');
    if (text.length < 2 || !accountId) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      ipc.fb?.searchPeople({ accountId, query: text })
        .then(res => {
          if (seq !== seqRef.current) return;
          if (res?.success) setResults(res.results || []);
          else { setResults([]); setFailed(res?.error || ''); }
        })
        .catch(err => { if (seq === seqRef.current) { setResults([]); setFailed(String(err?.message || err)); } })
        .finally(() => { if (seq === seqRef.current) setSearching(false); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [accountId, text]);

  const open = async (person: FacebookPersonResult) => {
    if (opening) return;
    setOpening(person.id);
    try {
      const res = await ipc.fb?.startChat({
        accountId, userId: person.id, name: person.name, avatarUrl: person.avatarUrl, isGroup: person.isGroup === true,
      });
      if (!res?.success || !res.threadId) {
        showNotification(res?.error || tr('Không mở được cuộc trò chuyện'), 'error');
        return;
      }
      onOpen(res.threadId, person.isGroup ? 1 : 0, { display_name: person.name || person.id, avatar_url: person.avatarUrl || '', channel: 'facebook' });
    } finally {
      setOpening(null);
    }
  };

  if (text.length < 2) return null;
  if (!searching && results && results.length === 0 && !failed) return null;

  return (
    <div data-fb-people="1">
      <div className="px-3 pt-3 pb-1.5 flex items-center gap-2">
        <span className="text-xs text-foreground/80 font-semibold">{tr('Trên Messenger')}</span>
        {searching && <Spinner size={3} />}
      </div>
      {failed && <p className="px-3 pb-2 text-xs text-muted-foreground">{failed}</p>}
      {(results || []).slice(0, SHOWN).map(person => {
        const label = kindLabel(person);
        const second = [label, person.contextLine].filter(Boolean).join(' · ');
        return (
          <button
            key={person.id}
            type="button"
            disabled={!!opening || !person.canMessage}
            onClick={() => open(person)}
            className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted transition-colors disabled:opacity-60"
            title={person.canMessage ? undefined : tr('Messenger không cho nhắn tin người này')}
          >
            {person.avatarUrl
              ? <img src={person.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0" referrerPolicy="no-referrer" />
              : <PeerInitials name={person.name || person.id} className="w-9 h-9 flex-shrink-0" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground truncate">{person.name || person.id}</p>
              {second && <p className="text-xs text-muted-foreground truncate">{second}</p>}
            </div>
            {opening === person.id
              ? <Spinner size={3} />
              : person.hasConversation && <span className="text-[11px] text-muted-foreground flex-shrink-0">{tr('Đã có')}</span>}
          </button>
        );
      })}
    </div>
  );
}
