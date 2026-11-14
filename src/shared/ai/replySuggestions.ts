/**
 * AI reply suggestions (the "Gợi ý AI" (AI suggestions) bar above the compose box, API ai/suggest): number of sentences, the prompt sent to the AI, and reading the answer.
 * Shared by main (AIAssistantService.getSuggestions) and the renderer (the "Số câu gợi ý" (suggestion count) setting).
 */

export const MAX_AI_SUGGESTIONS = 5;
/** The compose box defaults to 3 sentences; callers that do not pass a count (API, older employee builds) keep 5 as before. */
export const DEFAULT_COMPOSER_AI_SUGGESTIONS = 3;
export const AI_SUGGESTION_COUNT_CHOICES: readonly number[] = [1, 2, 3, 4, 5];

/** Valid counts are 1..5; unknown / missing → `fallback`. */
export function normalizeSuggestionCount(value: unknown, fallback = MAX_AI_SUGGESTIONS): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_AI_SUGGESTIONS);
}

/** System prompt: exactly `count` sentences, returned as a JSON array (not the assistant's system prompt, since free models are often overwhelmed by it). */
export function suggestionSystemPrompt(count: number): string {
  const n = normalizeSuggestionCount(count);
  const sample = Array.from({ length: n }, (_, i) => `"Câu gợi ý ${i + 1}"`).join(',');
  return `Bạn là trợ lý gợi ý tin nhắn cho người bán hàng / chăm sóc khách hàng.

NHIỆM VỤ: Dựa vào lịch sử hội thoại bên dưới, hãy gợi ý ĐÚNG ${n} câu trả lời ngắn gọn, tự nhiên, phù hợp nhất.

YÊU CẦU BẮT BUỘC:
- Trả về JSON array gồm ĐÚNG ${n} string, KHÔNG thêm text nào khác
- Mỗi câu phải ngắn gọn (dưới 100 ký tự), tự nhiên như chat thật
- Câu gợi ý phải khớp ngữ cảnh cuộc hội thoại
- KHÔNG giải thích, KHÔNG thêm markdown, KHÔNG thêm lời chào dư thừa

ĐỊNH DẠNG CHUẨN (chỉ trả về đúng format này, không thêm gì khác):
[${sample}]`;
}

/** The AI answer → at most `count` sentences: a JSON array first; if that fails, split by lines (dropping numbering / bullets), then split into sentences. */
export function parseSuggestionResult(result: string, count: number): string[] {
  const n = normalizeSuggestionCount(count);
  const text = String(result || '');
  let suggestions: string[] = [];
  let parsedJson = false;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        parsedJson = true;
        suggestions = parsed.map((s: any) => String(s).trim()).filter((s) => s.length > 0);
      }
    }
  } catch { /* split by lines below */ }
  if (!parsedJson) {
    suggestions = text
      .split('\n')
      .map((s) => s.trim())
      .map((s) => s.replace(/^[\d]+[.):\-]\s*/, ''))
      .map((s) => s.replace(/^[-•*]\s*/, ''))
      .map((s) => s.replace(/^["']|["']$/g, ''))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // One continuous paragraph: split into sentences
    if (suggestions.length === 0 && text.length > 20) {
      suggestions = text.split(/[.!?]\s*/).map((s) => s.trim()).filter((s) => s.length > 20);
    }
  }
  return suggestions.slice(0, n);
}
