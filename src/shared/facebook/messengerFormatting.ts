/**
 * Messenger text formatting: Messenger clients turn markers typed in the text into formatting, and the text keeps the
 * markers. Rules ported from mautrix-meta pkg/msgconv/textfmt/markdown.go (parseMetaFormatting):
 *   ```code block```, >>> block quote <<<, "> " quote line, `inline code`, *bold*, _italic_, ~strikethrough~.
 * Ranges never nest: the rules run in that order and a match overlapping an earlier one is dropped. Inline formats stay
 * on one line, open after a space / line start (or listed punctuation) and close before a space / line end (or punctuation),
 * so a_b_c or a*b*c inside words and links stays plain text.
 * Offsets are UTF-16 indexes into the original text (markers included), as stored mention ranges use.
 */

export type MessengerFormat = 'codeBlock' | 'blockQuote' | 'inlineQuote' | 'inlineCode' | 'bold' | 'italic' | 'strike';

export interface MessengerFormatRange {
  format: MessengerFormat;
  /** Whole range in the text, markers included. */
  start: number;
  end: number;
  /** Shown text: text.slice(contentStart, contentEnd). */
  contentStart: number;
  contentEnd: number;
  /** Code block language (a known one only). */
  language?: string;
}

const LINE_BREAKS = new Set(['\n', '\u2028']);

function isSpace(char: string | undefined): boolean {
  return !!char && /\s/u.test(char);
}

function charAt(text: string, offset: number): string | undefined {
  if (offset < 0 || offset >= text.length) return undefined;
  const code = text.codePointAt(offset);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

function charBefore(text: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const low = text.charCodeAt(offset - 1);
  if (low >= 0xdc00 && low <= 0xdfff && offset >= 2) return text.slice(offset - 2, offset);
  return text[offset - 1];
}

function lineEndFrom(text: string, offset: number): number {
  for (let i = offset; i < text.length; i++) if (LINE_BREAKS.has(text[i])) return i;
  return text.length;
}

/** [end of the line, start of the next line] from `offset`. */
function lineBounds(text: string, offset: number): [number, number] {
  const end = lineEndFrom(text, offset);
  return end < text.length ? [end, end + 1] : [end, end];
}

function isLineStart(text: string, offset: number): boolean {
  return offset === 0 || LINE_BREAKS.has(text[offset - 1]);
}

function isAsciiWord(char: string | undefined): boolean {
  return !!char && /^[A-Za-z0-9_]$/.test(char);
}

function hasPrefix(text: string, offset: number, prefixChars: string): boolean {
  if (offset === 0) return true;
  const prev = charBefore(text, offset);
  return isSpace(prev) || (!!prev && prefixChars.includes(prev));
}

function hasSuffix(text: string, offset: number, suffixChars: string): boolean {
  if (offset >= text.length) return true;
  const next = charAt(text, offset);
  if (isSpace(next) || (!!next && suffixChars.includes(next))) return true;
  return suffixChars.startsWith('word') && isAsciiWord(next);
}

function validInlineContent(content: string, code: boolean): boolean {
  if (!content || content.includes('\n') || content.includes('\u2028')) return false;
  if (code) return true;
  return !isSpace(charAt(content, 0)) && !isSpace(charBefore(content, content.length));
}

function findInlineDelimited(
  text: string, format: MessengerFormat, delimiter: string, prefixChars: string, suffixChars: string, code: boolean,
): MessengerFormatRange[] {
  const matches: MessengerFormatRange[] = [];
  let offset = 0;
  while (offset < text.length) {
    const open = text.indexOf(delimiter, offset);
    if (open < 0) break;
    if (!hasPrefix(text, open, prefixChars)) {
      offset = open + 1;
      continue;
    }
    const searchEnd = lineEndFrom(text, open + 1);
    let found = false;
    for (let closeSearch = open + 1; closeSearch < searchEnd;) {
      const close = text.indexOf(delimiter, closeSearch);
      if (close < 0 || close >= searchEnd) break;
      if (validInlineContent(text.slice(open + 1, close), code) && hasSuffix(text, close + 1, suffixChars)) {
        matches.push({ format, start: open, end: close + 1, contentStart: open + 1, contentEnd: close });
        offset = close + 1;
        found = true;
        break;
      }
      closeSearch = close + 1;
    }
    if (!found) offset = open + 1;
  }
  return matches;
}

/** After a closing fence only spaces may follow on its line; returns the end (after the line break) or -1. */
function consumeTail(text: string, offset: number): number {
  for (let i = offset; i < text.length; i++) {
    if (LINE_BREAKS.has(text[i])) return i + 1;
    if (!isSpace(text[i])) return -1;
  }
  return text.length;
}

function findClosingFence(text: string, offset: number, fence: string): [number, number] | null {
  for (let from = offset; ;) {
    const start = text.indexOf(fence, from);
    if (start < 0) return null;
    const end = consumeTail(text, start + fence.length);
    if (end >= 0) return [start, end];
    from = start + 1;
  }
}

const CODE_LANGUAGES = new Set([
  'asp', 'aspx', 'bash', 'c', 'clj', 'cljc', 'cljx', 'clojure', 'coffeescript', 'cplusplus', 'cpp', 'c++', 'cql', 'cs',
  'csharp', 'css', 'curl', 'd', 'dart', 'diff', 'dockerfile', 'ecmascript', 'erl', 'erlang', 'go', 'gql', 'gradle',
  'graphql', 'groovy', 'handlebars', 'hbs', 'html', 'http', 'java', 'javascript', 'jl', 'jruby', 'js', 'json', 'jsx',
  'julia', 'kotlin', 'kt', 'less', 'liquid', 'lua', 'macruby', 'markdown', 'ml', 'mssql', 'mysql', 'node', 'objc',
  'objc++', 'objcpp', 'objectivec', 'objectivecplusplus', 'objectivecpp', 'ocaml', 'perl', 'pgsql', 'php', 'pl',
  'plsql', 'postgres', 'postgresql', 'powershell', 'ps1', 'py', 'python', 'r', 'rake', 'rb', 'rbx', 'rs', 'ruby',
  'rust', 'sass', 'scala', 'scss', 'sh', 'shell', 'sol', 'solidity', 'sql', 'sqlite', 'styl', 'stylus', 'swift', 'ts',
  'typescript', 'xhtml', 'xml', 'yaml', 'yml', 'zsh',
]);

function findCodeBlocks(text: string): MessengerFormatRange[] {
  const matches: MessengerFormatRange[] = [];
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf('```', offset);
    if (start < 0) break;
    let fenceEnd = start;
    while (fenceEnd < text.length && text[fenceEnd] === '`') fenceEnd++;
    const match = codeBlockAt(text, start, fenceEnd, text.slice(start, fenceEnd));
    if (match) {
      matches.push(match);
      offset = match.end;
    } else {
      offset = start + 1;
    }
  }
  return matches;
}

function codeBlockAt(text: string, start: number, fenceEnd: number, fence: string): MessengerFormatRange | null {
  const lineEnd = lineEndFrom(text, fenceEnd);
  if (lineEnd < text.length) {
    const lineBreakEnd = lineEnd + 1;
    const close = findClosingFence(text, lineBreakEnd, fence);
    if (close) {
      const language = text.slice(fenceEnd, lineEnd).trim().toLowerCase();
      const known = !language || CODE_LANGUAGES.has(language);
      return {
        format: 'codeBlock', start, end: close[1],
        // An unknown "language" is part of the code
        contentStart: known ? lineBreakEnd : fenceEnd, contentEnd: close[0],
        ...(known && language ? { language } : {}),
      };
    }
  }
  const close = findClosingFence(text, fenceEnd, fence);
  if (!close || close[0] === fenceEnd) return null;
  return { format: 'codeBlock', start, end: close[1], contentStart: fenceEnd, contentEnd: close[0] };
}

function findLinePrefix(text: string, offset: number, prefix: string): number {
  for (let from = offset; from < text.length;) {
    const idx = text.indexOf(prefix, from);
    if (idx < 0) return -1;
    if (isLineStart(text, idx)) return idx;
    from = idx + 1;
  }
  return -1;
}

function findBlockQuotes(text: string): MessengerFormatRange[] {
  const matches: MessengerFormatRange[] = [];
  let offset = 0;
  while (offset < text.length) {
    const start = findLinePrefix(text, offset, '>>>');
    if (start < 0) break;
    let contentStart = start + 3;
    if (text[contentStart] === ' ') contentStart++;
    let close: [number, number] | null = null;
    for (let from = contentStart; ;) {
      const closeStart = findLinePrefix(text, from, '<<<');
      if (closeStart < 0) break;
      const [lineEnd, nextLineStart] = lineBounds(text, closeStart);
      if (!text.slice(closeStart + 3, lineEnd).trim()) {
        close = [closeStart, nextLineStart];
        break;
      }
      from = nextLineStart;
      if (from >= text.length) break;
    }
    if (!close) {
      offset = contentStart;
      continue;
    }
    if (text.slice(contentStart, close[0]).trim()) {
      matches.push({ format: 'blockQuote', start, end: close[1], contentStart, contentEnd: close[0] });
    }
    offset = close[1];
  }
  return matches;
}

function findInlineQuotes(text: string): MessengerFormatRange[] {
  if (text.trim() === '>') return [];
  const matches: MessengerFormatRange[] = [];
  for (let lineStart = 0; lineStart < text.length;) {
    const [lineEnd, nextLineStart] = lineBounds(text, lineStart);
    if (text.startsWith('>', lineStart) && lineStart < lineEnd) {
      let contentStart = lineStart + 1;
      if (contentStart < lineEnd && text[contentStart] === ' ') contentStart++;
      matches.push({ format: 'inlineQuote', start: lineStart, end: lineEnd, contentStart, contentEnd: lineEnd });
    }
    if (nextLineStart <= lineStart) break;
    lineStart = nextLineStart;
  }
  return matches;
}

const RULES: Array<(text: string) => MessengerFormatRange[]> = [
  findCodeBlocks,
  findBlockQuotes,
  findInlineQuotes,
  text => findInlineDelimited(text, 'inlineCode', '`', "*_~'\"(", "word*_~,.;:!?'\")", true),
  text => findInlineDelimited(text, 'bold', '*', "_~'\"(", "_~,.;:!?'\")", false),
  text => findInlineDelimited(text, 'italic', '_', "*~'\"(", "*~,.;:!?'\")", false),
  text => findInlineDelimited(text, 'strike', '~', "*_'\"(", "*_,.;:!?'\")", false),
];

/** Formatting ranges of a Messenger text, sorted by position; [] = plain text. */
export function parseMessengerFormatting(text: string | null | undefined): MessengerFormatRange[] {
  const value = String(text || '');
  if (!/[*_~`>]/.test(value)) return [];
  const ranges: MessengerFormatRange[] = [];
  for (const rule of RULES) {
    for (const match of rule(value)) {
      if (match.start >= match.end) continue;
      if (ranges.some(existing => match.end > existing.start && match.start < existing.end)) continue;
      ranges.push(match);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Block formats start on their own line (the line break around them belongs to the block). */
export function isMessengerBlockFormat(format: MessengerFormat): boolean {
  return format === 'codeBlock' || format === 'blockQuote' || format === 'inlineQuote';
}

/** The text without its formatting marks, for the chat list and notifications. */
export function stripMessengerFormatting(text: string | null | undefined): string {
  const value = String(text ?? '');
  const ranges = parseMessengerFormatting(value);
  if (!ranges.length) return value;
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += value.slice(cursor, range.start) + value.slice(range.contentStart, range.contentEnd);
    cursor = range.end;
  }
  return out + value.slice(cursor);
}
