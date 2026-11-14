/**
 * bankCardTemplate: the Zalo bank card (action `zinstant.bankcard`) that is received.
 *
 * The message only includes a template link on Zalo's zinstant CDN: params.pcItem.data_url (`?data=html`, data_type 4) is HTML for
 * PC; item / bubbleItem (data_type 2) is compressed data for the phone app. The bank, account number and QR are in the HTML.
 *
 * Safety (the HTML is fetched from the link inside the message):
 *  - only https is downloaded, from Zalo's zinstant CDN (zinst*.zadn.vn);
 *  - <script> is removed: it is the zinstant runtime code of the phone app, which the browser cannot run;
 *  - BankCardBubble draws it with an iframe srcdoc + sandbox="" (no script, its own origin): the template cannot reach the UI or
 *    electronAPI. srcdoc does not go through the CSP frame-src, so the installed build can draw it (a blob: frame is blocked, leaving a blank card).
 */

const TEMPLATE_HOST_RE = /^zinst[a-z0-9-]*\.zadn\.vn$/i;
const MAX_TEMPLATE_CHARS = 512 * 1024;
const MAX_CACHED_TEMPLATES = 50;

/** CSS added to the template: hides the phone app's part, fixes the height for the 300 x 230 frame. */
const CARD_CSS = `<style>
  .mobile_element { display: none !important; }
  .card_wrapper { height: 230px !important; min-height: 200px !important; }
  body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
</style>`;

/** Whether the link is on Zalo's zinstant CDN (https, no user:pass, default port). */
export function isZaloTemplateUrl(raw: unknown): raw is string {
    if (typeof raw !== 'string') return false;
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && TEMPLATE_HOST_RE.test(url.hostname);
}

/** HTML template link of the card in the message content; null if there is none or it is not Zalo's CDN. */
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
    // No pcItem: only accept the item when it is HTML (the item is usually compressed data of the phone app).
    const item = params.item;
    const itemUrl = item?.data_url;
    if (isZaloTemplateUrl(itemUrl) && (Number(item.data_type) === 4 || /[?&]data=html(&|$)/.test(itemUrl))) return itemUrl;
    return null;
}

/** Template for srcdoc: drops the script, adds the frame CSS; null if it is not HTML (e.g. compressed data) or too large. */
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

/** Template already loaded (drawn at once when the bubble mounts again while scrolling); undefined if not loaded yet. */
export function peekBankCardTemplate(url: string): string | undefined {
    return templates.get(url)?.html;
}

/** Loads templates: once per link, keeps the 50 most recent cards; after an error it loads again next time. */
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

/** Test: clears the template cache. */
export function resetBankCardTemplates(): void {
    templates.clear();
}
