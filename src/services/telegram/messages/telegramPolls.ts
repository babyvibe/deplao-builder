/**
 * Bình chọn Telegram (MessageMediaPoll): attachment `poll` lưu cùng tin (câu hỏi, lựa chọn, số người chọn) và cập nhật
 * kết quả về sau (UpdateMessagePoll Telegram đẩy về, messages.getPollResults khi hội thoại đang mở — như app Telegram).
 * Trước đây kết quả chỉ chụp lúc tin về nên Deplao hiện "0 lượt bình chọn" mãi trong khi Telegram đã có người chọn.
 */

const optionKey = (option: unknown): string => Buffer.from((option as any) || []).toString('base64');

/** attachment `poll` (dạng lưu trong messages.attachments) từ poll + results của Telegram. */
export function telegramPollAttachment(poll: any, results: any): Record<string, any> {
  const question = String(poll?.question?.text || poll?.question || 'Bình chọn');
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
 * Áp một cập nhật (`poll` khi bản thân bình chọn đổi, vd đóng / thêm lựa chọn; `results` = kết quả) lên attachments đã
 * lưu. Kết quả `min` không mang lựa chọn của chính mình → giữ "đã chọn" cũ; lựa chọn không kèm số người (Telegram ẩn
 * tới khi bỏ phiếu / đóng) → giữ số cũ. null = không phải tin bình chọn hoặc không đổi gì.
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
