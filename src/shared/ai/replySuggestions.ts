/**
 * Gợi ý trả lời AI (thanh "Gợi ý AI" trên ô soạn tin, API ai/suggest): số câu, lời nhắc gửi AI, đọc câu trả lời.
 * Dùng chung main (AIAssistantService.getSuggestions) + renderer (cài đặt "Số câu gợi ý").
 */

export const MAX_AI_SUGGESTIONS = 5;
/** Ô soạn tin mặc định 3 câu; nơi gọi không truyền số câu (API, nhân viên bản cũ) giữ 5 như trước. */
export const DEFAULT_COMPOSER_AI_SUGGESTIONS = 3;
export const AI_SUGGESTION_COUNT_CHOICES: readonly number[] = [1, 2, 3, 4, 5];

/** Số câu hợp lệ 1..5; lạ / thiếu → `fallback`. */
export function normalizeSuggestionCount(value: unknown, fallback = MAX_AI_SUGGESTIONS): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_AI_SUGGESTIONS);
}

/** Lời nhắc hệ thống: đúng `count` câu, trả JSON array (không dùng system prompt của trợ lý — model miễn phí hay bị lấn át). */
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

/** Câu trả lời của AI → tối đa `count` câu: JSON array trước; không được thì tách dòng (bỏ số thứ tự / gạch đầu dòng), rồi tách câu. */
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
  } catch { /* tách dòng bên dưới */ }
  if (!parsedJson) {
    suggestions = text
      .split('\n')
      .map((s) => s.trim())
      .map((s) => s.replace(/^[\d]+[.):\-]\s*/, ''))
      .map((s) => s.replace(/^[-•*]\s*/, ''))
      .map((s) => s.replace(/^["']|["']$/g, ''))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Một đoạn liền: tách theo câu
    if (suggestions.length === 0 && text.length > 20) {
      suggestions = text.split(/[.!?]\s*/).map((s) => s.trim()).filter((s) => s.length > 20);
    }
  }
  return suggestions.slice(0, n);
}
