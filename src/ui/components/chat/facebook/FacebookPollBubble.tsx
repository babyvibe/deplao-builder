/**
 * Messenger poll (fb.poll): question, options with the people who chose them, and voting from Deplao. Messenger polls
 * allow several choices; a tap toggles one option and sends the account's whole choice list (fb:votePollInThread).
 * Counts are the votes Deplao has seen since the poll was saved. Like Messenger, each option shows the avatars of the
 * people who chose it; the "N người đã bình chọn" line opens who chose what.
 */
import React from 'react';
import { ipc } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';
import { fbPollFromAttachments } from '../../../../shared/facebook/facebookSpecialMessages';

/** A voter as shown on the card (window/rows/pollPeople resolves names and avatars). */
export interface PollPerson {
  id: string;
  name: string;
  avatar: string;
}

const MAX_OPTION_AVATARS = 3;

function VoterAvatar({ person }: { person: PollPerson }) {
  const [broken, setBroken] = React.useState(false);
  return person.avatar && !broken ? (
    <img src={person.avatar} alt="" className="h-4 w-4 rounded-full object-cover ring-1 ring-card" onError={() => setBroken(true)} />
  ) : (
    <PeerInitials id={person.id} name={person.name} single className="h-4 w-4 text-[8px] ring-1 ring-card" />
  );
}

export default function FacebookPollBubble({ msg, isSent, accountId, threadId, getPerson }: {
  msg: any;
  isSent: boolean;
  accountId: string;
  threadId: string;
  /** Name + avatar of a voter; without it the card shows counts only. */
  getPerson?: (userId: string) => PollPerson;
}) {
  const poll = React.useMemo(() => fbPollFromAttachments(msg?.attachments), [msg?.attachments]);
  const showNotification = useAppStore(s => s.showNotification);
  const [pending, setPending] = React.useState<string | null>(null);
  const [showVoters, setShowVoters] = React.useState(false);
  if (!poll) return null;

  const total = poll.total_voters || 0;
  const chosen = poll.options.filter(o => o.chosen).map(o => o.id);

  const toggle = async (optionId: string) => {
    if (pending || !accountId || !threadId) return;
    const next = chosen.includes(optionId) ? chosen.filter(id => id !== optionId) : [...chosen, optionId];
    setPending(optionId);
    try {
      const res = await ipc.fb?.votePollInThread({ accountId, threadId, pollId: poll.poll_id, optionIds: next });
      if (!res?.success) showNotification(res?.error || tr('Không gửi được bình chọn'), 'error');
    } catch (err: any) {
      showNotification(err?.message || tr('Không gửi được bình chọn'), 'error');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="min-w-[260px] max-w-sm rounded-2xl p-3 text-foreground">
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-base" aria-hidden="true">📊</span>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{tr('Bình chọn')}</p>
          <p className="mt-0.5 break-words text-sm font-semibold leading-snug">{poll.question}</p>
        </div>
      </div>
      <div className="space-y-1.5">
        {poll.options.map(option => {
          const percentage = total > 0 ? Math.round(option.voters / total * 100) : 0;
          return (
            <button
              key={option.id}
              type="button"
              disabled={!!pending}
              onClick={() => toggle(option.id)}
              className="relative block w-full overflow-hidden rounded-lg bg-foreground/5 px-2.5 py-2 text-left transition-colors hover:bg-foreground/10 disabled:cursor-wait"
            >
              {total > 0 && (
                <div className={`absolute inset-y-0 left-0 ${isSent ? 'bg-primary/15' : 'bg-blue-500/20'}`} style={{ width: `${percentage}%` }} />
              )}
              <div className="relative flex items-center gap-2">
                <span className={`flex h-4 w-4 flex-none items-center justify-center rounded border ${option.chosen ? 'border-current bg-current/20' : 'border-current/60'}`}>
                  {option.chosen && <span className="text-[10px] leading-none">✓</span>}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm">{option.text}</span>
                {getPerson && option.voter_ids.length > 0 && (
                  <span
                    className="flex flex-none -space-x-1"
                    title={option.voter_ids.map(id => getPerson(id).name).join(', ')}
                  >
                    {option.voter_ids.slice(0, MAX_OPTION_AVATARS).map(id => <VoterAvatar key={id} person={getPerson(id)} />)}
                  </span>
                )}
                {pending === option.id
                  ? <span className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-current border-t-transparent" />
                  : option.voters > 0 && <span className="flex-none text-xs text-muted-foreground">{option.voters}</span>}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {getPerson && total > 0 ? (
          <button
            type="button"
            aria-expanded={showVoters}
            onClick={() => setShowVoters(v => !v)}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            {trx('{{total}} người đã bình chọn', { total })}
          </button>
        ) : (
          <span>{trx('{{total}} người đã bình chọn', { total })}</span>
        )}
        <span>{tr('Chọn nhiều')}</span>
      </div>
      {getPerson && showVoters && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          {poll.options.filter(option => option.voter_ids.length > 0).map(option => (
            <div key={option.id} className="text-xs">
              <p className="font-medium text-foreground">{option.text}</p>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
                {option.voter_ids.map(id => {
                  const person = getPerson(id);
                  return (
                    <span key={id} className="inline-flex items-center gap-1 text-muted-foreground">
                      <VoterAvatar person={person} />
                      <span className="max-w-[140px] truncate">{person.name}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
