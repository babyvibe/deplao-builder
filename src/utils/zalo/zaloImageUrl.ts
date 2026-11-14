/**
 * Zalo JPEG XL images.
 *
 * Newer Zalo phone builds send some images as JPEG XL: URL `https://…/jxl/<…>/<id>.jxl` (with
 * `params.convertible = "jxl"`). Chromium/Electron cannot display JXL → the image shows as broken.
 * When a machine cannot decode JXL, Zalo Web/PC switches to the JPG version, which the CDN always has (Zalo PC 26.9.10,
 * module `QWlH`: the `transcode` function → `toJpg`): `/jxl/` → `/jpg/`, `.jxl` → `.jpg`, and the `jxlstatus` parameter is dropped.
 * E2EE image URLs (containing `?e2esession`) cannot be changed → left as they are.
 *
 * Shared by the main process and the renderer.
 */

const JXL_URL_RE = /^https?:\/\/.*\/jxl\/.*\.jxl/i;
/**
 * Quick check on the unparsed JSON string. Do not search for "/jxl/": Zalo often escapes the "/" characters inside nested JSON strings
 * (`params`, `quote.attach`: `https:\/\/…\/jxl\/…`), so you must search for "jxl", then parse, and check the real URL.
 */
const JXL_HINT_RE = /jxl/i;
const E2EE_SESSION_MARKER = '?e2esession';
const JXL_STATUS_PARAM = 'jxlstatus';

/** The fields that contain image URLs in the content / params of an image message (same list as the Zalo transcode). */
const CONTENT_URL_KEYS = ['href', 'thumb', 'hd', 'hdUrl', 'normalUrl', 'oriUrl', 'thumbUrl', 'raw', 'rawUrl'];
const PARAMS_URL_KEYS = ['hd', 'rawUrl', 'href', 'thumb'];

/** Zalo media hosts (image / file CDN, chat.zalo.me): only these hosts may receive the account's session cookie. */
const ZALO_MEDIA_HOST_RE = /(^|\.)(zdn\.vn|zadn\.vn|zalo\.me|zaloapp\.com)$/i;

/** An http(s) link on a Zalo media host. */
export function isZaloMediaUrl(url: unknown): url is string {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    try {
        return ZALO_MEDIA_HOST_RE.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

export function isZaloJxlUrl(url: unknown): url is string {
    return typeof url === 'string' && JXL_URL_RE.test(url);
}

/** Zalo JXL image URL → the matching JPG URL. Other URLs stay unchanged. */
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
 * Change every JXL image URL in the content of an image message (object, or JSON string) to JPG.
 * `params` may be an object or a JSON string; keep its type. Returns the same object if nothing changed.
 */
export function normalizeZaloPhotoContent<T>(content: T): T {
    if (typeof content === 'string') {
        if (!JXL_HINT_RE.test(content)) return content;
        try {
            const parsed = JSON.parse(content);
            // Only process the JSON string of an object (the content of an image message); plain text strings stay unchanged.
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
        } catch { /* params is not JSON */ }
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
 * Change the JXL URLs in a zca-js message (`message.data.content` + the images of the quoted message `data.quote.attach`)
 * BEFORE saving to the DB / sending to the renderer. Edits the object in place; returns true if anything changed.
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
