/**
 * bankCardTemplate - thẻ tài khoản ngân hàng Zalo (action `zinstant.bankcard`) nhận về.
 *
 * Tin chỉ kèm link template trên CDN zinstant của Zalo: params.pcItem.data_url (`?data=html`, data_type 4) là HTML cho
 * PC; item / bubbleItem (data_type 2) là dữ liệu nén cho app điện thoại. Ngân hàng, số tài khoản, QR nằm trong HTML.
 *
 * An toàn (HTML lấy theo link nằm trong tin nhắn):
 *  - chỉ tải https từ CDN zinstant của Zalo (zinst*.zadn.vn);
 *  - bỏ <script>: đó là mã runtime zinstant của app điện thoại, trình duyệt không chạy được;
 *  - BankCardBubble vẽ bằng iframe srcdoc + sandbox="" (không script, origin riêng): template không chạm được giao diện
 *    hay electronAPI. srcdoc không qua CSP frame-src nên bản cài vẽ được (khung blob: bị chặn, thẻ trắng).
 */

const TEMPLATE_HOST_RE = /^zinst[a-z0-9-]*\.zadn\.vn$/i;
const MAX_TEMPLATE_CHARS = 512 * 1024;
const MAX_CACHED_TEMPLATES = 50;

/** CSS thêm vào template: ẩn phần của app điện thoại, cố định chiều cao cho khung 300 x 230. */
const CARD_CSS = `<style>
  .mobile_element { display: none !important; }
  .card_wrapper { height: 230px !important; min-height: 200px !important; }
  body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
</style>`;

/** Link có phải CDN zinstant của Zalo không (https, không user:pass, cổng mặc định). */
export function isZaloTemplateUrl(raw: unknown): raw is string {
    if (typeof raw !== 'string') return false;
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && TEMPLATE_HOST_RE.test(url.hostname);
}

/** Link template HTML của thẻ trong nội dung tin; null nếu không có hoặc không phải CDN của Zalo. */
export function bankCardTemplateUrl(content: string): string | null {
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { return null; }
    if (parsed?.action !== 'zinstant.bankcard') return null;
    let params: any = parsed.params;
    if (typeof params === 'string') {
        try { params = JSON.parse(params); } catch { return null; }
    }
    if (!params || typeof params !== 'object') return null;
    const pcUrl = params.pcItem?.data_url;
    if (isZaloTemplateUrl(pcUrl)) return pcUrl;
    // Không có pcItem: chỉ nhận item khi là HTML (item thường là dữ liệu nén của app điện thoại).
    const item = params.item;
    const itemUrl = item?.data_url;
    if (isZaloTemplateUrl(itemUrl) && (Number(item.data_type) === 4 || /[?&]data=html(&|$)/.test(itemUrl))) return itemUrl;
    return null;
}

/** Template cho srcdoc: bỏ script, thêm CSS khung; null nếu không phải HTML (vd dữ liệu nén) hoặc quá lớn. */
export function prepareBankCardHtml(html: string): string | null {
    if (typeof html !== 'string' || html.length < 50 || html.length > MAX_TEMPLATE_CHARS) return null;
    if (!/^[\s\uFEFF]*</.test(html)) return null;
    const body = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
    if (/<\/head>/i.test(body)) return body.replace(/<\/head>/i, (tag) => CARD_CSS + tag);
    if (/<body/i.test(body)) return body.replace(/<body/i, (tag) => CARD_CSS + tag);
    return CARD_CSS + body;
}

interface CachedTemplate { job: Promise<string | null>; html?: string }
const templates = new Map<string, CachedTemplate>();

async function fetchBankCardTemplate(url: string): Promise<string | null> {
    try {
        const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`, {
            headers: { Accept: 'text/html,application/xhtml+xml,application/xml' },
        });
        if (!res.ok) return null;
        return prepareBankCardHtml(await res.text());
    } catch {
        return null;
    }
}

/** Template đã tải xong (vẽ ngay khi bubble mount lại lúc cuộn); undefined nếu chưa có. */
export function peekBankCardTemplate(url: string): string | undefined {
    return templates.get(url)?.html;
}

/** Tải template: mỗi link một lần, giữ 50 thẻ gần nhất; lỗi thì lần sau tải lại. */
export function loadBankCardTemplate(url: string): Promise<string | null> {
    if (!isZaloTemplateUrl(url)) return Promise.resolve(null);
    const hit = templates.get(url);
    if (hit) return hit.job;
    const entry: CachedTemplate = {
        job: fetchBankCardTemplate(url).then((html) => {
            if (html) entry.html = html;
            else if (templates.get(url) === entry) templates.delete(url);
            return html;
        }),
    };
    templates.set(url, entry);
    if (templates.size > MAX_CACHED_TEMPLATES) {
        const oldest = templates.keys().next().value;
        if (oldest !== undefined) templates.delete(oldest);
    }
    return entry.job;
}

/** Test: xoá bộ nhớ đệm template. */
export function resetBankCardTemplates(): void {
    templates.clear();
}
