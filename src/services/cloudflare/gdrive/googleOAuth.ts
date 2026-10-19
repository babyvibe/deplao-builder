/**
 * googleOAuth — đăng nhập Google cho app desktop (OAuth 2.0 "installed app"):
 *
 *  - PKCE S256 (code_verifier 32 byte ngẫu nhiên) + state ngẫu nhiên 32 byte (base64url).
 *  - Nhận mã qua máy chủ HTTP loopback chỉ nghe 127.0.0.1, cổng do hệ điều hành cấp (redirect_uri
 *    http://127.0.0.1:<cổng>). Chỉ nhận GET có state khớp; mọi lối ra (xong / từ chối / quá 5 phút / huỷ) đều đóng server.
 *  - Quyền duy nhất: drive.file (không nhạy cảm — app chỉ thấy file do chính nó tạo). Không xin openid / email: email
 *    lấy từ Drive about.get. access_type=offline + prompt=consent → lần nào Google cũng trả refresh token.
 *  - Đổi mã / làm mới / thu hồi token qua oauth2.googleapis.com (x-www-form-urlencoded).
 *  - Không bao giờ log token, mã đăng nhập, client secret hay URL chứa chúng.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { CloudError } from '../contracts';
import { MSG_NETWORK, NETWORK_WAIT_MS, parseRetryAfter } from './DriveApi';
import type { DriveFetch } from './DriveApi';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Chờ người dùng đăng nhập trên trình duyệt tối đa 5 phút. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const REVOKE_TIMEOUT_MS = 10_000;

export const MSG_DENIED = 'Bạn đã từ chối cho Deplao truy cập Google Drive.';
export const MSG_SCOPE_DENIED = 'Bạn chưa cho phép Deplao xem, tạo và xoá tệp Google Drive do Deplao tạo — đăng nhập lại và đánh dấu ô quyền Google Drive.';
export const MSG_TIMEOUT = 'Quá 5 phút chưa đăng nhập xong Google — bấm Đăng nhập để thử lại.';
export const MSG_CANCELLED = 'Đã huỷ đăng nhập Google';
export const MSG_SESSION_EXPIRED = 'Phiên Google đã hết hạn hoặc bị thu hồi — đăng nhập lại Google Drive.';
export const MSG_NO_REFRESH = 'Google không trả về phiên đăng nhập dài hạn — vào myaccount.google.com → Bảo mật → Kết nối với ứng dụng bên thứ ba, gỡ Deplao rồi đăng nhập lại.';

/** Client OAuth dùng để đăng nhập / làm mới (secret có thể trống với client Desktop + PKCE). */
export interface OAuthClient {
    clientId: string;
    clientSecret?: string | null;
}

export interface GoogleTokens {
    accessToken: string;
    /** ms (đồng hồ máy) lúc access token hết hạn. */
    expiresAt: number;
    /** Có khi đổi mã (bắt buộc) — làm mới thường không trả lại. */
    refreshToken: string | null;
    /** Quyền Google đã cấp (cách nhau bởi dấu cách). */
    scope: string;
}

// ─── PKCE / state / URL đăng nhập ────────────────────────────────────────────

export function createPkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    return { verifier, challenge };
}

export function createOAuthState(): string {
    return randomBytes(32).toString('base64url');
}

export function hasDriveScope(scope: string | null | undefined): boolean {
    return String(scope || '').split(/[\s,+]+/).includes(DRIVE_FILE_SCOPE);
}

export function buildAuthorizeUrl(p: { clientId: string; redirectUri: string; codeChallenge: string; state: string }): string {
    const q = new URLSearchParams({
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        response_type: 'code',
        scope: DRIVE_FILE_SCOPE,
        code_challenge: p.codeChallenge,
        code_challenge_method: 'S256',
        state: p.state,
        access_type: 'offline',
        prompt: 'consent',
    });
    return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

// ─── Máy chủ loopback nhận mã ────────────────────────────────────────────────

export interface LoopbackLogin {
    /** http://127.0.0.1:<cổng> — dùng y nguyên cho URL đăng nhập và lúc đổi mã. */
    readonly redirectUri: string;
    /** Mã đăng nhập (+ quyền Google báo đã cấp, nếu có trên URL chuyển hướng). Lỗi = CloudError. */
    readonly result: Promise<{ code: string; scope: string | null }>;
    /** Huỷ chờ → result bị từ chối CloudError('CANCELLED'). Gọi khi đã xong: không làm gì. */
    cancel(): void;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, detail: string, ok: boolean): string {
    const color = ok ? '#16a34a' : '#dc2626';
    return '<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Deplao — Google Drive</title><style>'
        + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f7fb;'
        + 'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2937}'
        + '.card{background:#fff;border-radius:14px;padding:32px 40px;max-width:460px;text-align:center;box-shadow:0 6px 28px rgba(15,23,42,.08)}'
        + `h1{font-size:19px;margin:0 0 10px;color:${color}}p{margin:0;color:#4b5563;line-height:1.5}`
        + `</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div></body></html>`;
}

/** So sánh state không lộ thời gian. */
function sameSecret(a: string, b: string): boolean {
    const x = Buffer.from(String(a), 'utf8');
    const y = Buffer.from(String(b), 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Mở máy chủ loopback 127.0.0.1:<cổng ngẫu nhiên> chờ Google chuyển hướng về với ?code=…&state=…
 * Từ chối (error=access_denied) → CloudError('GOOGLE_DENIED'); quá hạn → 'GOOGLE_TIMEOUT'; huỷ → 'CANCELLED'.
 */
export function startLoopbackLogin(opts: { state: string; timeoutMs?: number }): Promise<LoopbackLogin> {
    const timeoutMs = Math.max(1, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
    return new Promise<LoopbackLogin>((resolveStart, rejectStart) => {
        const server = http.createServer();
        let listening = false;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let settle: (err: CloudError | null, value?: { code: string; scope: string | null }) => void = () => undefined;
        const result = new Promise<{ code: string; scope: string | null }>((resolve, reject) => {
            settle = (err, value) => (err ? reject(err) : resolve(value as { code: string; scope: string | null }));
        });
        // Người gọi vẫn nhận lỗi khi await; dòng này chỉ tránh "unhandled rejection" nếu huỷ trước khi có ai await.
        result.catch(() => undefined);

        const closeServer = (dropAll: boolean) => {
            try { server.close(); } catch { /* đã đóng */ }
            const s = server as unknown as { closeAllConnections?: () => void; closeIdleConnections?: () => void };
            try {
                if (dropAll) s.closeAllConnections?.();
                else s.closeIdleConnections?.();
            } catch { /* bỏ qua */ }
        };
        const finish = (err: CloudError | null, value?: { code: string; scope: string | null }, dropAll = false) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            timer = null;
            // Trang trả về có 'Connection: close' → Node tự đóng kết nối sau khi gửi xong; còn lại thì đóng ngay
            closeServer(dropAll);
            settle(err, value);
        };

        server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
            const reply = (status: number, html: string) => {
                res.writeHead(status, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                    Connection: 'close',
                });
                res.end(html);
            };
            if (req.method !== 'GET') {
                reply(405, '');
                return;
            }
            let url: URL;
            try {
                url = new URL(req.url || '/', 'http://127.0.0.1');
            } catch {
                reply(400, '');
                return;
            }
            const state = url.searchParams.get('state');
            // favicon / request lạ / state sai (chống CSRF) → bỏ qua, vẫn chờ
            if (!state || !sameSecret(state, opts.state)) {
                reply(404, '');
                return;
            }
            if (done) {
                reply(200, page('Đăng nhập đã kết thúc', 'Quay lại Deplao để xem kết quả.', true));
                return;
            }
            const error = url.searchParams.get('error');
            const code = url.searchParams.get('code');
            const scope = url.searchParams.get('scope');
            let failure: CloudError | null = null;
            if (error) {
                failure = error === 'access_denied'
                    ? new CloudError('GOOGLE_DENIED', MSG_DENIED)
                    : new CloudError('GOOGLE_AUTH_FAILED', `Google báo lỗi khi đăng nhập (${error.replace(/[^\w.-]/g, '').slice(0, 40)}) — thử lại.`);
            } else if (!code) {
                failure = new CloudError('GOOGLE_AUTH_FAILED', 'Google không trả về mã đăng nhập — thử lại.');
            } else if (scope !== null && !hasDriveScope(scope)) {
                // Màn đồng ý cho bỏ chọn từng quyền: bỏ ô Google Drive = không dùng được
                failure = new CloudError('GOOGLE_SCOPE_DENIED', MSG_SCOPE_DENIED);
            }
            if (failure) {
                reply(400, page('Chưa kết nối được Google Drive', failure.message, false));
                finish(failure);
                return;
            }
            reply(200, page('Đã kết nối Google Drive — quay lại Deplao.', 'Có thể đóng thẻ này.', true));
            finish(null, { code: code as string, scope });
        });

        server.on('error', (err: any) => {
            if (!listening) {
                rejectStart(new CloudError('GOOGLE_LOOPBACK', `Không mở được cổng nhận kết quả đăng nhập trên máy (${err?.code || err?.message || err}).`));
                return;
            }
            finish(new CloudError('GOOGLE_LOOPBACK', 'Máy chủ nhận kết quả đăng nhập Google bị lỗi — thử lại.'), undefined, true);
        });

        server.listen(0, '127.0.0.1', () => {
            listening = true;
            const port = (server.address() as AddressInfo).port;
            timer = setTimeout(() => finish(new CloudError('GOOGLE_TIMEOUT', MSG_TIMEOUT), undefined, true), timeoutMs);
            try { (timer as { unref?: () => void }).unref?.(); } catch { /* bỏ qua */ }
            resolveStart({
                redirectUri: `http://127.0.0.1:${port}`,
                result,
                cancel: () => finish(new CloudError('CANCELLED', MSG_CANCELLED), undefined, true),
            });
        });
    });
}

// ─── Token ───────────────────────────────────────────────────────────────────

async function postForm(fetchImpl: DriveFetch, url: string, form: URLSearchParams, timeoutMs: number): Promise<{ status: number; data: any; retryAfter: string | null }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        let text = '';
        let status = 0;
        let retryAfter: string | null = null;
        try {
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: form.toString(),
                signal: controller.signal,
            });
            status = res.status;
            retryAfter = res.headers.get('retry-after');
            text = await res.text();
        } catch {
            throw timedOut
                ? new CloudError('R2_TIMEOUT', 'Google phản hồi quá lâu — tự thử lại sau.', undefined, NETWORK_WAIT_MS)
                : new CloudError('R2_NETWORK', MSG_NETWORK, undefined, NETWORK_WAIT_MS);
        }
        let data: any = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        return { status, data, retryAfter };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lỗi của máy chủ token Google → CloudError. invalid_grant khi làm mới = phiên chết ('GOOGLE_INVALID_GRANT' —
 * GoogleDriveService xoá refresh token rồi báo NOT_CONNECTED); client sai → 'GOOGLE_CLIENT_INVALID' (status 401 để tầng
 * trên dừng như lỗi quyền).
 */
function tokenError(status: number, data: any, retryAfter: string | null, phase: 'exchange' | 'refresh'): CloudError {
    const code = typeof data?.error === 'string' ? data.error : '';
    const desc = typeof data?.error_description === 'string' ? data.error_description : '';
    if (status === 429 || status >= 500) {
        return new CloudError('R2_BUSY', 'Google đang bận — tự thử lại sau.', status, parseRetryAfter(retryAfter, Date.now()) ?? (status === 429 ? 30_000 : 10_000));
    }
    if (code === 'invalid_grant') {
        return phase === 'refresh'
            ? new CloudError('GOOGLE_INVALID_GRANT', MSG_SESSION_EXPIRED, status)
            : new CloudError('GOOGLE_AUTH_FAILED', 'Mã đăng nhập Google đã hết hạn hoặc đã dùng — đăng nhập lại.', status);
    }
    if (/client_secret is missing/i.test(desc)) {
        return new CloudError('GOOGLE_CLIENT_SECRET_REQUIRED', 'Client OAuth này cần Client secret — nhập Client secret (mục Nâng cao) rồi đăng nhập lại.', 401);
    }
    if (code === 'invalid_client' || code === 'unauthorized_client') {
        return new CloudError('GOOGLE_CLIENT_INVALID', 'Client OAuth Google không hợp lệ (sai Client ID / Client secret hoặc client đã bị xoá) — kiểm tra mục Nâng cao.', 401);
    }
    const reason = code.replace(/[^\w.-]/g, '').slice(0, 40);
    return new CloudError('GOOGLE_AUTH_FAILED', `Google từ chối đăng nhập (${reason || `HTTP ${status}`}).`, status);
}

function parseTokens(data: any, nowMs: number): GoogleTokens {
    const accessToken = typeof data?.access_token === 'string' ? data.access_token : '';
    if (!accessToken) throw new CloudError('GOOGLE_AUTH_FAILED', 'Google không trả về token truy cập — thử đăng nhập lại.');
    const expiresIn = Number(data?.expires_in);
    return {
        accessToken,
        expiresAt: nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
        refreshToken: typeof data?.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
        scope: typeof data?.scope === 'string' ? data.scope : '',
    };
}

function clientForm(client: OAuthClient): URLSearchParams {
    const form = new URLSearchParams();
    form.set('client_id', client.clientId);
    // Client "Desktop app" dùng PKCE có thể không cần secret — chỉ gửi khi có
    if (client.clientSecret) form.set('client_secret', client.clientSecret);
    return form;
}

/** Đổi mã đăng nhập lấy token. Thiếu quyền drive.file → 'GOOGLE_SCOPE_DENIED'; thiếu refresh token → 'GOOGLE_NO_REFRESH'. */
export async function exchangeAuthCode(
    fetchImpl: DriveFetch,
    client: OAuthClient,
    p: { code: string; codeVerifier: string; redirectUri: string },
    now: () => number = Date.now,
): Promise<GoogleTokens & { refreshToken: string }> {
    const form = clientForm(client);
    form.set('code', p.code);
    form.set('code_verifier', p.codeVerifier);
    form.set('grant_type', 'authorization_code');
    form.set('redirect_uri', p.redirectUri);
    const r = await postForm(fetchImpl, GOOGLE_TOKEN_URL, form, TOKEN_TIMEOUT_MS);
    if (r.status < 200 || r.status >= 300) throw tokenError(r.status, r.data, r.retryAfter, 'exchange');
    const tokens = parseTokens(r.data, now());
    if (!hasDriveScope(tokens.scope)) throw new CloudError('GOOGLE_SCOPE_DENIED', MSG_SCOPE_DENIED);
    if (!tokens.refreshToken) throw new CloudError('GOOGLE_NO_REFRESH', MSG_NO_REFRESH);
    return tokens as GoogleTokens & { refreshToken: string };
}

/** Làm mới access token. invalid_grant → CloudError('GOOGLE_INVALID_GRANT'). */
export async function refreshAccessToken(fetchImpl: DriveFetch, client: OAuthClient, refreshToken: string, now: () => number = Date.now): Promise<GoogleTokens> {
    const form = clientForm(client);
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refreshToken);
    const r = await postForm(fetchImpl, GOOGLE_TOKEN_URL, form, TOKEN_TIMEOUT_MS);
    if (r.status < 200 || r.status >= 300) throw tokenError(r.status, r.data, r.retryAfter, 'refresh');
    return parseTokens(r.data, now());
}

/** Thu hồi token (best effort): true nếu Google xác nhận. Không ném. */
export async function revokeToken(fetchImpl: DriveFetch, token: string): Promise<boolean> {
    try {
        const form = new URLSearchParams();
        form.set('token', token);
        const r = await postForm(fetchImpl, GOOGLE_REVOKE_URL, form, REVOKE_TIMEOUT_MS);
        return r.status >= 200 && r.status < 300;
    } catch {
        return false;
    }
}
