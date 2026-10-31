/**
 * aiUtils.ts
 * Helpers dùng chung cho AI Assistant - parsing structured JSON, validation, ...
 */

export interface AIStructuredSegment {
  type: 'text' | 'image';
  content: any;
}

/**
 * Parse structured AI response dạng JSON array:
 *   [{type:"text",content:"..."}, {type:"image",content:["url",...]}]
 *
 * Xử lý 3 trường hợp:
 *  1. JSON hoàn chỉnh - JSON.parse trực tiếp
 *  2. JSON bị wrap trong markdown / khoảng trắng - extract bằng regex
 *  3. JSON bị truncate / cắt ngang - dùng state machine trích object hoàn chỉnh
 */
export function parseStructuredResponse(
  raw: string
): AIStructuredSegment[] | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return null;

  // ── Attempt 1: Full valid JSON ──────────────────────────────────
  try {
    const parsed = JSON.parse(trimmed);
    if (isValidStructuredResponse(parsed)) return parsed;
  } catch {
    // fall through
  }

  // ── Attempt 2: Extract array via regex (AI may wrap in markdown / extra text) ──
  try {
    const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (isValidStructuredResponse(parsed)) return parsed;
    }
  } catch {
    // fall through
  }

  // ── Attempt 3: Truncated JSON - extract individual complete {..} objects ──
  // Khi AI bị cắt ngang giữa chừng, VD:
  //   [{"type":"text","content":"Chào bạn"}, {"type
  // Ta dùng state machine để vớt các object hoàn chỉnh còn được.
  try {
    const objects: AIStructuredSegment[] = [];
    let depth = 0;
    let startIdx = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];

      // Escape sequence trong string
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\' && inString) { escapeNext = true; continue; }

      // Toggle string mode
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue; // bỏ qua mọi thứ bên trong string

      // Brace tracking
      if (ch === '{') {
        if (depth === 0) startIdx = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && startIdx >= 0) {
          const objStr = trimmed.substring(startIdx, i + 1);
          startIdx = -1;
          try {
            const obj = JSON.parse(objStr);
            if (obj && (obj.type === 'text' || obj.type === 'image') && obj.content !== undefined) {
              objects.push(obj as AIStructuredSegment);
            }
          } catch {
            // skip malformed object
          }
        }
      }
    }

    if (objects.length > 0) return objects;
  } catch {
    // fall through
  }

  return null;
}

/**
 * Validate structured response có đúng format không
 */
export function isValidStructuredResponse(parsed: any): parsed is AIStructuredSegment[] {
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.every(
    (item: any) =>
      item &&
      typeof item === 'object' &&
      (item.type === 'text' || item.type === 'image') &&
      item.content !== undefined,
  );
}
