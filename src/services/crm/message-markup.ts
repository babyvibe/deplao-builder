// Parser for BBCode-style markup → zca-js formatting (styles) for Zalo messages.
//
// Because {name} is replaced at send time (each contact's name is longer or shorter), styles CANNOT be
// stored by absolute offset. Instead, the inline tags are kept in the text and parsed AFTER
// the substitution is done → the offsets always match the real text being sent.

/** Map of tags → zca-js TextStyle codes (dist/apis/sendMessage: enum TextStyle). */
const TAG_TO_STYLE: Record<string, string> = {
    b: 'b',            // Bold
    i: 'i',            // Italic
    u: 'u',            // Underline
    s: 's',            // StrikeThrough
    red: 'c_db342e',   // Red
    orange: 'c_f27806',// Orange
    yellow: 'c_f7b503',// Yellow
    green: 'c_15a85f', // Green
    big: 'f_18',       // Big
    small: 'f_13',     // Small
};

export interface MarkupStyle {
    start: number;
    len: number;
    st: string;
}

export interface ParsedMarkup {
    text: string;
    styles: MarkupStyle[];
}

const TAG_RE = /\[(\/?)([a-z]+)\]/gi;

/**
 * Splits markup tags out of the text and builds the style list by offset on the clean text.
 * - Nested tags are OK (several styles on the same range; zca-js accepts them).
 * - Unknown tags / tags without a matching open-close pair → kept as plain text (no crash).
 */
export function parseMarkup(raw: string): ParsedMarkup {
    if (!raw) return { text: '', styles: [] };

    const styles: MarkupStyle[] = [];
    const openStack: { tag: string; start: number }[] = [];
    let text = '';
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(raw)) !== null) {
        const isClose = m[1] === '/';
        const tag = m[2].toLowerCase();

        // A tag not in the table → treated as plain text and skipped (kept as a literal).
        if (!(tag in TAG_TO_STYLE)) continue;

        // Append the text before the tag to the clean output.
        text += raw.slice(lastIndex, m.index);
        lastIndex = TAG_RE.lastIndex;

        if (!isClose) {
            openStack.push({ tag, start: text.length });
        } else {
            // Find the nearest open tag of the same type (LIFO).
            let found = -1;
            for (let i = openStack.length - 1; i >= 0; i--) {
                if (openStack[i].tag === tag) { found = i; break; }
            }
            if (found === -1) continue; // close tag without an open tag → skip
            const open = openStack.splice(found, 1)[0];
            const len = text.length - open.start;
            if (len > 0) styles.push({ start: open.start, len, st: TAG_TO_STYLE[tag] });
        }
    }
    text += raw.slice(lastIndex);

    return { text, styles };
}
