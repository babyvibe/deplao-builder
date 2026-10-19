/**
 * Ảnh JPEG XL của Zalo.
 *
 * Zalo điện thoại bản mới gửi một số ảnh dạng JPEG XL: URL `https://…/jxl/<…>/<id>.jxl` (kèm
 * `params.convertible = "jxl"`). Chromium/Electron không hiển thị được JXL → ảnh lỗi.
 * Máy không giải mã được JXL thì Zalo Web/PC đổi sang bản JPG mà CDN luôn có sẵn (Zalo PC 26.9.10,
 * module `QWlH` — hàm `transcode` → `toJpg`): `/jxl/` → `/jpg/`, `.jxl` → `.jpg`, bỏ tham số `jxlstatus`.
 * URL ảnh E2EE (chứa `?e2esession`) không đổi được → giữ nguyên.
 *
 * Dùng chung cho main process và renderer.
 */

const JXL_URL_RE = /^https?:\/\/.*\/jxl\/.*\.jxl/i;
/**
 * Kiểm tra nhanh trên chuỗi JSON chưa parse. Không dò "/jxl/": Zalo hay escape dấu "/" trong chuỗi JSON lồng
 * (`params`, `quote.attach`: `https:\/\/…\/jxl\/…`) → phải dò "jxl" rồi parse ra mới kiểm tra đúng URL.
 */
const JXL_HINT_RE = /jxl/i;
const E2EE_SESSION_MARKER = '?e2esession';
const JXL_STATUS_PARAM = 'jxlstatus';

/** Các field chứa URL ảnh trong content / params của tin ảnh (giống danh sách Zalo transcode). */
const CONTENT_URL_KEYS = ['href', 'thumb', 'hd', 'hdUrl', 'normalUrl', 'oriUrl', 'thumbUrl', 'raw', 'rawUrl'];
const PARAMS_URL_KEYS = ['hd', 'rawUrl', 'href', 'thumb'];

export function isZaloJxlUrl(url: unknown): url is string {
    return typeof url === 'string' && JXL_URL_RE.test(url);
}

/** URL ảnh JXL của Zalo → URL bản JPG tương ứng. URL khác giữ nguyên. */
export function toZaloJpgUrl(url: string): string {
    if (!isZaloJxlUrl(url) || url.includes(E2EE_SESSION_MARKER)) return url;
    try {
        const parsed = new URL(url);
        parsed.searchParams.delete(JXL_STATUS_PARAM);
        parsed.pathname = parsed.pathname.replace('/jxl/', '/jpg/').replace(/\.jxl$/i, '.jpg');
        return parsed.toString();
    } catch {
        return url;
    }
}

function convertKeys(target: Record<string, any>, keys: string[]): boolean {
    let changed = false;
    for (const key of keys) {
        const value = target[key];
        if (!isZaloJxlUrl(value)) continue;
        const next = toZaloJpgUrl(value);
        if (next !== value) {
            target[key] = next;
            changed = true;
        }
    }
    return changed;
}

/**
 * Đổi mọi URL ảnh JXL trong content của tin ảnh (object, hoặc chuỗi JSON) sang JPG.
 * `params` có thể là object hoặc chuỗi JSON — giữ nguyên kiểu. Trả về chính đối tượng cũ nếu không có gì đổi.
 */
export function normalizeZaloPhotoContent<T>(content: T): T {
    if (typeof content === 'string') {
        if (!JXL_HINT_RE.test(content)) return content;
        try {
            const parsed = JSON.parse(content);
            // Chỉ xử lý chuỗi JSON của object (content tin ảnh); chuỗi văn bản thường giữ nguyên.
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content;
            const next = normalizeZaloPhotoContent(parsed);
            return (next === parsed ? content : JSON.stringify(next)) as unknown as T;
        } catch {
            return content;
        }
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
    const copy: Record<string, any> = { ...(content as Record<string, any>) };
    let changed = convertKeys(copy, CONTENT_URL_KEYS);
    const params = copy.params;
    if (typeof params === 'string' && JXL_HINT_RE.test(params)) {
        try {
            const parsedParams = JSON.parse(params);
            if (parsedParams && typeof parsedParams === 'object' && convertKeys(parsedParams, PARAMS_URL_KEYS)) {
                copy.params = JSON.stringify(parsedParams);
                changed = true;
            }
        } catch { /* params không phải JSON */ }
    } else if (params && typeof params === 'object' && !Array.isArray(params)) {
        const paramsCopy = { ...params };
        if (convertKeys(paramsCopy, PARAMS_URL_KEYS)) {
            copy.params = paramsCopy;
            changed = true;
        }
    }
    return (changed ? copy : content) as T;
}

/**
 * Đổi URL JXL trong tin nhắn zca-js (`message.data.content` + ảnh của tin được trích dẫn `data.quote.attach`)
 * TRƯỚC khi lưu DB / gửi renderer. Sửa trực tiếp trên object; trả true nếu có thay đổi.
 */
export function normalizeZaloMessageImages(message: any): boolean {
    const data = message?.data;
    if (!data || typeof data !== 'object') return false;
    let changed = false;
    const content = normalizeZaloPhotoContent(data.content);
    if (content !== data.content) {
        data.content = content;
        changed = true;
    }
    const quote = data.quote;
    if (quote && typeof quote === 'object' && quote.attach) {
        const attach = normalizeZaloPhotoContent(quote.attach);
        if (attach !== quote.attach) {
            quote.attach = attach;
            changed = true;
        }
    }
    return changed;
}
