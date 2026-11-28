/**
 * What a person wrote when asking to join a Zalo group that needs approval: getPendingGroupMembers returns it per person as
 * `users[].user_submit`. zca-js types the field as null and Zalo does not document it, so every likely shape is read: plain text,
 * JSON text, an object with an answer (and maybe its question), a list of question / answer pairs. Anything else gives no answer
 * (the person is still listed). Shared by the public API (GET .../pending-members) and the "Chờ duyệt vào nhóm" panel.
 */

export interface ZaloJoinAnswer {
  /** The group's question, when Zalo sends it with the answer. */
  question: string | null;
  answer: string;
}

const ANSWER_KEYS = ['answer', 'ans', 'content', 'text', 'msg', 'message', 'value', 'reply', 'note', 'reason'];
const QUESTION_KEYS = ['question', 'ques', 'title', 'label', 'q'];
const LIST_KEYS = ['answers', 'questions', 'items', 'list', 'data'];
/** Keys that never hold what the person wrote (ids, times, flags, links). */
const NOT_TEXT_KEY = /(^|_)(id|uid|time|ts|type|status|avatar|url|link)$|Id$|Time$/i;

export const ZALO_JOIN_ANSWER_MAX = 10;
export const ZALO_JOIN_ANSWER_MAX_LENGTH = 1000;
const MAX_DEPTH = 4;

function clip(text: string): string {
  return text.length > ZALO_JOIN_ANSWER_MAX_LENGTH ? `${text.slice(0, ZALO_JOIN_ANSWER_MAX_LENGTH)}…` : text;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = textOf(record[key]);
    if (text) return text;
  }
  return '';
}

function readAnswers(value: unknown, depth: number): ZaloJoinAnswer[] {
  if (value == null || depth > MAX_DEPTH) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return readAnswers(JSON.parse(text), depth + 1);
      } catch {
        // Not JSON: the person's own text
      }
    }
    return [{ question: null, answer: clip(text) }];
  }
  if (Array.isArray(value)) return value.flatMap((item) => readAnswers(item, depth + 1));
  if (typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    if (Array.isArray(record[key])) return readAnswers(record[key], depth + 1);
  }
  const answer = firstText(record, ANSWER_KEYS);
  if (answer) {
    const question = firstText(record, QUESTION_KEYS);
    return [{ question: question ? clip(question) : null, answer: clip(answer) }];
  }
  // Unknown keys: the text values (never ids, times or links) are what the person wrote
  return Object.entries(record)
    .filter(([key, item]) => typeof item === 'string' && item.trim() && !NOT_TEXT_KEY.test(key))
    .map(([, item]) => ({ question: null, answer: clip(String(item).trim()) }));
}

/** The answers of one pending person (`user_submit`); [] when there is none. */
export function zaloJoinAnswers(userSubmit: unknown): ZaloJoinAnswer[] {
  return readAnswers(userSubmit, 0).slice(0, ZALO_JOIN_ANSWER_MAX);
}

/** All answers as one text ("question: answer" per line), null when there is none. */
export function zaloJoinAnswerText(answers: readonly ZaloJoinAnswer[]): string | null {
  if (!answers.length) return null;
  return answers.map((item) => (item.question ? `${item.question}: ${item.answer}` : item.answer)).join('\n');
}
