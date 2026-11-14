/**
 * Telegram poll (MessageMediaPoll): a `poll` attachment saved with the message (question, options, number of voters), and the results are updated
 * afterwards (Telegram pushes UpdateMessagePoll, messages.getPollResults while the conversation is open, as in the Telegram app).
 * Previously the results were only captured when the message arrived, so Deplao showed "0 lượt bình chọn" (0 votes) forever while Telegram already had voters.
 */

import { tr } from '../../../shared/i18n';

const optionKey = (option: unknown): string => Buffer.from((option as any) || []).toString('base64');

/** `poll` attachment (saved form in messages.attachments) from the Telegram poll + results. */
export function telegramPollAttachment(poll: any, results: any): Record<string, any> {
  const question = String(poll?.question?.text || poll?.question || tr('Bình chọn'));
  const resultByOption = new Map<string, any>();
  for (const result of results?.results || []) resultByOption.set(optionKey(result?.option), result);
  return {
    type: 'poll', id: String(poll?.id || ''), question,
    closed: !!poll?.closed, multiple_choice: !!poll?.multipleChoice, quiz: !!poll?.quiz,
    open_answers: !!poll?.openAnswers,
    total_voters: Number(results?.totalVoters || 0),
    answers: (poll?.answers || []).map((answer: any) => {
      const option = optionKey(answer?.option);
      const result = resultByOption.get(option);
      return {
        text: String(answer?.text?.text || answer?.text || ''), option,
        voters: Number(result?.voters || 0), chosen: !!result?.chosen, correct: !!result?.correct,
      };
    }),
  };
}

/**
 * Applies an update (`poll` when the poll itself changes, e.g. closed / option added; `results` = the results) to the saved attachments.
 * A `min` result does not carry my own choice, so keep the old "đã chọn" (chosen) state; an option without a voter count (Telegram hides it
 * until you vote or the poll closes) keeps the old count. null = not a poll message, or nothing changed.
 */
export function mergeTelegramPollUpdate(attachments: unknown, update: { poll?: any; results?: any }): string | null {
  let list: any[];
  try {
    list = typeof attachments === 'string' ? JSON.parse(attachments || '[]') : (attachments as any[]);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const index = list.findIndex(item => item?.type === 'poll');
  if (index < 0) return null;
  const prev = list[index] || {};
  const prevAnswers: any[] = Array.isArray(prev.answers) ? prev.answers : [];
  const prevByOption = new Map<string, any>(prevAnswers.map(answer => [String(answer?.option || ''), answer]));
  const base = update.poll ? telegramPollAttachment(update.poll, null) : null;
  const results = update.results;
  const min = !!results?.min;
  const resultByOption = new Map<string, any>();
  for (const result of results?.results || []) resultByOption.set(optionKey(result?.option), result);

  const answers = (base ? base.answers : prevAnswers).map((answer: any) => {
    const option = String(answer?.option || '');
    const old = prevByOption.get(option) || {};
    const result = resultByOption.get(option);
    return {
      text: String(answer?.text || old.text || ''),
      option,
      voters: result && result.voters != null ? Number(result.voters) : Number(old.voters || 0),
      chosen: result && !min ? !!result.chosen : !!old.chosen,
      correct: result ? !!result.correct || (min && !!old.correct) : !!old.correct,
    };
  });
  const next = {
    ...prev,
    ...(base ? {
      id: base.id || prev.id, question: base.question, closed: base.closed,
      multiple_choice: base.multiple_choice, quiz: base.quiz, open_answers: base.open_answers,
    } : {}),
    total_voters: results?.totalVoters != null ? Number(results.totalVoters) : Number(prev.total_voters || 0),
    answers,
  };
  if (JSON.stringify(next) === JSON.stringify(prev)) return null;
  const out = [...list];
  out[index] = next;
  return JSON.stringify(out);
}
