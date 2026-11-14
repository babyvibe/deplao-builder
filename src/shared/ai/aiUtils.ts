/**
 * aiUtils.ts
 * Shared helpers for the AI Assistant - parsing structured JSON, validation, ...
 */

export interface AIStructuredSegment {
  type: 'text' | 'image';
  content: any;
}

/**
 * Parse a structured AI response in JSON array form:
 *   [{type:"text",content:"..."}, {type:"image",content:["url",...]}]
 *
 * Handles 3 cases:
 *  1. Complete JSON: JSON.parse directly
 *  2. JSON wrapped in markdown / whitespace: extract it with a regex
 *  3. JSON truncated / cut off midway: use a state machine to extract the complete objects
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
  // When the AI is cut off midway, e.g.:
  //   [{"type":"text","content":"Chào bạn"}, {"type
  // We use a state machine to salvage the complete objects that remain.
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
      if (inString) continue; // skip everything inside a string

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
 * Validate that the structured response has the right format
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
