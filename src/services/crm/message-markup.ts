// Parser markup BBCode-style → định dạng zca-js (styles) cho tin nhắn Zalo.
//
// Vì {name} được thay lúc gửi (mỗi contact tên dài/ngắn khác nhau), style KHÔNG thể
// lưu theo offset tuyệt đối. Thay vào đó lưu thẻ inline trong text và parse SAU khi
// đã substitute → offset luôn khớp với text thật gửi đi.

/** Bảng ánh xạ thẻ → mã TextStyle của zca-js (dist/apis/sendMessage: enum TextStyle). */
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
 * Tách thẻ markup khỏi text và sinh danh sách style theo offset trên text sạch.
 * - Thẻ lồng nhau OK (sinh nhiều style cùng range — zca-js chấp nhận).
 * - Thẻ lạ / không khớp cặp mở-đóng → giữ nguyên như text thường (không crash).
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

        // Thẻ không nằm trong bảng → coi như text thường, bỏ qua (giữ nguyên literal).
        if (!(tag in TAG_TO_STYLE)) continue;

        // Nối phần text đứng trước thẻ vào output sạch.
        text += raw.slice(lastIndex, m.index);
        lastIndex = TAG_RE.lastIndex;

        if (!isClose) {
            openStack.push({ tag, start: text.length });
        } else {
            // Tìm thẻ mở gần nhất cùng loại (LIFO).
            let found = -1;
            for (let i = openStack.length - 1; i >= 0; i--) {
                if (openStack[i].tag === tag) { found = i; break; }
            }
            if (found === -1) continue; // đóng không có mở → bỏ qua
            const open = openStack.splice(found, 1)[0];
            const len = text.length - open.start;
            if (len > 0) styles.push({ start: open.start, len, st: TAG_TO_STYLE[tag] });
        }
    }
    text += raw.slice(lastIndex);

    return { text, styles };
}
