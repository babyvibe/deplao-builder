import React from 'react';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

type TelegramPollOption = {
  text: string;
  voters: number;
  chosen: boolean;
  correct: boolean;
};

function readPoll(msg: any): {
  question: string;
  options: TelegramPollOption[];
  totalVoters: number;
  closed: boolean;
  multipleChoice: boolean;
  quiz: boolean;
  openAnswers: boolean;
} | null {
  try {
    const rawAttachments = typeof msg?.attachments === 'string'
      ? JSON.parse(msg.attachments || '[]')
      : (msg?.attachments || []);
    const poll = Array.isArray(rawAttachments)
      ? rawAttachments.find((attachment: any) => attachment?.type === 'poll')
      : null;
    if (!poll) return null;

    const options = (poll.answers || poll.options || []).map((answer: any) => ({
      text: String(typeof answer === 'string' ? answer : answer?.text || ''),
      voters: Number(answer?.voters ?? answer?.voter_count ?? 0),
      chosen: !!answer?.chosen,
      correct: !!answer?.correct,
    })).filter((answer: TelegramPollOption) => answer.text);

    return {
      question: String(poll.question || msg?.content || tr('Bình chọn')),
      options,
      totalVoters: Number(poll.total_voters ?? poll.total_voter_count ?? 0),
      closed: !!(poll.closed ?? poll.is_closed),
      multipleChoice: !!(poll.multiple_choice ?? poll.allows_multiple_answers),
      quiz: !!poll.quiz,
      openAnswers: !!(poll.open_answers ?? poll.allows_add_options),
    };
  } catch {
    return null;
  }
}

/** Renders the read-only state Telegram sends for polls. Voting stays in Telegram
 * because neither user nor bot channels currently expose a vote action in Deplao. */
export default function TelegramPollBubble({ msg, isSent }: { msg: any; isSent: boolean }) {
  const poll = React.useMemo(() => readPoll(msg), [msg]);
  if (!poll) return null;

  const answerCount = poll.options.length;
  const total = poll.totalVoters || Math.max(...poll.options.map(option => option.voters), 0);
  // ChatWindow already wraps the poll message in a bubble (white / light blue background + time) → do not draw a background frame
  // solid inside; the choice rows are the cells inside the bubble → bg-foreground/5 (works on both sent and received).
  const panelClass = 'text-foreground';
  const optionClass = 'bg-foreground/5';
  const mutedClass = 'text-muted-foreground';

  return (
    <div className={`min-w-[260px] max-w-sm rounded-2xl p-3 ${panelClass}`}>
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-base" aria-hidden="true">📊</span>
        <div className="min-w-0">
          <p className={`text-[11px] font-bold uppercase tracking-wider ${mutedClass}`}>{tr('Bình chọn')}</p>
          <p className="mt-0.5 break-words text-sm font-semibold leading-snug">{poll.question}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        {poll.options.map((option, index) => {
          const percentage = total > 0 ? Math.round(option.voters / total * 100) : 0;
          return (
            <div key={`${option.text}-${index}`} className={`relative overflow-hidden rounded-lg px-2.5 py-2 ${optionClass}`}>
              {total > 0 && (
                <div
                  className={`absolute inset-y-0 left-0 ${isSent ? 'bg-primary/15' : 'bg-purple-500/25'}`}
                  style={{ width: `${percentage}%` }}
                />
              )}
              <div className="relative flex items-center gap-2">
                <span className={`flex h-4 w-4 flex-none items-center justify-center border ${poll.multipleChoice ? 'rounded' : 'rounded-full'} ${option.chosen ? 'border-current bg-current/20' : 'border-current/60'}`}>
                  {option.chosen && <span className="text-[10px] leading-none">✓</span>}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm">{option.text}</span>
                {(total > 0 || option.correct) && (
                  <span className={`flex-none text-xs ${mutedClass}`}>{option.correct ? '✓ ' : ''}{percentage}%</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className={`mt-3 flex flex-wrap gap-x-2 gap-y-1 text-xs ${mutedClass}`}>
        <span>{trx('{{total}} lượt bình chọn', { total })}</span>
        {poll.multipleChoice && <span>{tr('Chọn nhiều')}</span>}
        {poll.quiz && <span>{tr('Đố vui')}</span>}
        {poll.openAnswers && <span>{tr('Có thể thêm lựa chọn')}</span>}
        {poll.closed && <span>{tr('Đã đóng')}</span>}
        {answerCount === 0 && <span>{tr('Chưa có lựa chọn')}</span>}
      </div>
    </div>
  );
}
