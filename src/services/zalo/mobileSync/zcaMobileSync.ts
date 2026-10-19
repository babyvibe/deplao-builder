/**
 * Mở rộng zca-js (>= 2.2.0) cho tính năng đồng bộ tin nhắn từ điện thoại — port từ zca-js PR #269
 * nhưng không fork thư viện:
 *   - API mới đăng ký qua điểm mở rộng chính thức `api.custom(...)`.
 *   - Sự kiện `sync_event` (control event act_type="syncmsgmb", WS cmd 601) đọc bằng một listener
 *     phụ gắn vào websocket của zca-js (zca-js 2.2.0 bỏ qua act_type này).
 *
 * Endpoint/params bám theo Zalo Web (zpw_type=30, client mà zca-js giả lập):
 *   - pull_mobile_msg / cancel_pull_mobile_msg (file domain)
 *   - znoise (profile domain): đổi UID/GroupID "plain" (mobile) → "noise" (web) — Zalo PC dùng đúng
 *     API này khi nhập dữ liệu đồng bộ (REQUEST_NOISE_ID → getnuid).
 */
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import Logger from '../../../utils/Logger';
import { initializeSyncEvent, NoisedIdsResult, PullMobileParams, SyncEvent } from './types';

/** pc_name mà Zalo Web gửi lên — điện thoại hiển thị tên này và trả lại trong các sự kiện. */
export const DEFAULT_SYNC_PC_NAME = 'Web';

const CMD_CONTROL = 601;
const SYNC_ACT_TYPE = 'syncmsgmb';
const ZNOISE_FALLBACK_URL = 'https://zwid.api.zalo.me/api/znoise';

export interface MobileSyncApi {
    pullMobile(params: PullMobileParams): Promise<any>;
    cancelPullMobile(params: { public_key: string; pc_name: string }): Promise<any>;
    getNoisedIds(params: { uids: string[]; gids: string[] }): Promise<NoisedIdsResult>;
}

/**
 * pull_mobile_msg / cancel_pull_mobile_msg trả `data` rỗng (PR #269) → resolve của zca-js có thể lỗi
 * khi JSON.parse chuỗi rỗng. Server đã nhận yêu cầu nếu error_code ngoài cùng = 0.
 */
async function resolveLenient(utils: any, response: any): Promise<any> {
    const copy = typeof response?.clone === 'function' ? response.clone() : null;
    try {
        return await utils.resolve(response);
    } catch (err) {
        let json: any = null;
        try { json = copy ? await copy.json() : null; } catch { /* không phải JSON */ }
        if (json && Number(json.error_code) === 0) return null;
        throw err;
    }
}

/**
 * Domain dịch vụ (vd `file`, `profile`). zca-js chỉ lưu service map ở `api.zpwServiceMap`
 * (tham số constructor API) — `ctx.zpwServiceMap` có trong type nhưng không bao giờ được gán.
 */
function serviceDomain(api: any, ctx: any, key: 'file' | 'profile'): string {
    const domain = api?.zpwServiceMap?.[key]?.[0]
        || ctx?.loginInfo?.zpw_service_map_v3?.[key]?.[0]
        || ctx?.zpwServiceMap?.[key]?.[0];
    if (!domain) throw new Error(`Thiếu ${key} service domain`);
    return domain;
}

function toNumericIds(ids: string[]): number[] {
    return ids.map(id => Number.parseInt(id, 10));
}

function normalizeNoised(list: any, expected: number, stripGroupPrefix: boolean): string[] {
    const out: string[] = [];
    const arr = Array.isArray(list) ? list : [];
    for (let i = 0; i < expected; i++) {
        let v = arr[i] == null ? '' : String(arr[i]);
        if (stripGroupPrefix && v.startsWith('g')) v = v.slice(1);
        out.push(v === '0' ? '' : v);
    }
    return out;
}

/**
 * Đăng ký các API đồng bộ vào instance zca-js. `api.custom` định nghĩa property không thể ghi đè
 * nên chỉ đăng ký 1 lần cho mỗi instance.
 */
export function installMobileSyncApis(api: any): MobileSyncApi {
    if (!api || typeof api.custom !== 'function') {
        throw new Error('zca-js API không hỗ trợ api.custom (cần zca-js >= 2.0)');
    }
    if (typeof api.pullMobile === 'function') return api as MobileSyncApi;

    api.custom('pullMobile', async ({ ctx, utils, props }: any) => {
        const p: PullMobileParams = props;
        const fileDomain = serviceDomain(api, ctx, 'file');
        const params = {
            pc_name: p.pc_name,
            public_key: p.public_key,
            from_seq_id: p.from_seq_id ?? 0,
            is_retry: p.is_retry ?? 0,
            min_seq_id: p.min_seq_id ?? 0,
            temp_key: p.temp_key ?? '',
            imei: ctx.imei,
        };
        const encrypted = utils.encodeAES(JSON.stringify(params));
        if (!encrypted) throw new Error('Không mã hoá được params pullMobile');
        const url = utils.makeURL(`${fileDomain}/api/message/pull_mobile_msg`, { params: encrypted });
        return resolveLenient(utils, await utils.request(url, { method: 'GET' }));
    });

    api.custom('cancelPullMobile', async ({ ctx, utils, props }: any) => {
        const fileDomain = serviceDomain(api, ctx, 'file');
        const encrypted = utils.encodeAES(JSON.stringify({
            pc_name: props.pc_name,
            public_key: props.public_key,
            imei: ctx.imei,
        }));
        const url = utils.makeURL(`${fileDomain}/api/message/cancel_pull_mobile_msg`, { params: encrypted });
        return resolveLenient(utils, await utils.request(url, { method: 'GET' }));
    });

    api.custom('getNoisedIds', async ({ ctx, utils, props }: any): Promise<NoisedIdsResult> => {
        const uids: string[] = props.uids || [];
        const gids: string[] = props.gids || [];
        if (uids.length === 0 && gids.length === 0) return { fids: [], gids: [] };

        const payload: Record<string, number[]> = {};
        if (uids.length) payload.fids = toNumericIds(uids);
        if (gids.length) payload.gids = toNumericIds(gids);
        const encrypted = utils.encodeAES(JSON.stringify(payload));

        let data: any;
        try {
            // Zalo Web: GET {profile}/api/znoise (cookie zpw_sek thuộc domain chat.zalo.me)
            const url = utils.makeURL(`${serviceDomain(api, ctx, 'profile')}/api/znoise`, { params: encrypted });
            data = await utils.resolve(await utils.request(url, { method: 'GET' }));
        } catch (err: any) {
            // Zalo PC: POST https://zwid.api.zalo.me/api/znoise
            Logger.warn(`[MobileSync] znoise qua profile domain lỗi (${err?.message}) → thử zwid.api.zalo.me`);
            const url = utils.makeURL(ZNOISE_FALLBACK_URL);
            data = await utils.resolve(await utils.request(url, {
                method: 'POST',
                body: new URLSearchParams({ params: encrypted }).toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            }));
        }
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { data = {}; }
        }
        return {
            fids: normalizeNoised(data?.fids, uids.length, false),
            gids: normalizeNoised(data?.gids, gids.length, true),
        };
    });

    return api as MobileSyncApi;
}

// ─── Đọc control event syncmsgmb từ websocket của zca-js ─────────────────────

/** Giải mã payload event WS (tương đương utils.decodeEventData của zca-js). */
export function decodeWsEventData(parsed: any, cipherKey: string | null | undefined): any {
    if (typeof parsed?.data !== 'string' || typeof parsed?.encrypt !== 'number') return null;
    const encryptType: number = parsed.encrypt;
    if (encryptType === 0) return JSON.parse(parsed.data);

    let buf = Buffer.from(encryptType === 1 ? parsed.data : decodeURIComponent(parsed.data), 'base64');
    if (encryptType !== 1) {
        if (!cipherKey || buf.length < 48) return null;
        const key = Buffer.from(cipherKey, 'base64');
        const iv = buf.subarray(0, 16);
        const aad = buf.subarray(16, 32);
        const body = buf.subarray(32);
        const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-gcm` as any, key, iv) as crypto.DecipherGCM;
        decipher.setAAD(aad);
        decipher.setAuthTag(body.subarray(body.length - 16));
        buf = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
    }
    const plain = encryptType === 3 ? buf : zlib.unzipSync(buf);
    const text = plain.toString('utf8');
    return text ? JSON.parse(text) : null;
}

/** Lấy các sync event từ 1 frame WS (trả mảng rỗng nếu không phải control syncmsgmb). */
export function extractSyncEvents(frame: Buffer, cipherKey: string | null | undefined): SyncEvent[] {
    if (!Buffer.isBuffer(frame) || frame.length < 5) return [];
    const version = frame[0];
    const cmd = frame.readUInt16LE(1);
    const subCmd = frame[3];
    if (version !== 1 || cmd !== CMD_CONTROL || subCmd !== 0) return [];

    const text = frame.subarray(4).toString('utf8');
    if (!text || !text.includes('"data"')) return [];
    const decoded = decodeWsEventData(JSON.parse(text), cipherKey);
    const controls: any[] = decoded?.data?.controls || decoded?.controls || [];
    const events: SyncEvent[] = [];
    for (const control of controls) {
        const content = control?.content;
        if (!content || content.act_type !== SYNC_ACT_TYPE) continue;
        let data = content.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { /* giữ nguyên chuỗi */ }
        }
        events.push(initializeSyncEvent(data, String(content.act || ''), String(content.act_type)));
    }
    return events;
}

/**
 * Gắn listener phụ vào websocket hiện tại của `api.listener` (gắn lại sau mỗi lần `connected`).
 * Trả về hàm huỷ đăng ký.
 */
export function attachSyncEventListener(api: any, onEvent: (event: SyncEvent) => void): () => void {
    const listener = api?.listener;
    if (!listener || typeof listener.on !== 'function') return () => {};

    let boundWs: any = null;
    const onFrame = (data: any) => {
        if (!Buffer.isBuffer(data)) return;
        // Chỉ quan tâm cmd 601 — kiểm tra header trước khi decode để không tốn chi phí cho tin nhắn thường.
        if (data.length < 4 || data[0] !== 1 || data.readUInt16LE(1) !== CMD_CONTROL) return;
        try {
            for (const event of extractSyncEvents(data, listener.cipherKey)) onEvent(event);
        } catch (err: any) {
            Logger.warn(`[MobileSync] Không đọc được control event: ${err?.message}`);
        }
    };
    const bind = () => {
        const ws = listener.ws;
        if (!ws || ws === boundWs || typeof ws.on !== 'function') return;
        if (boundWs) boundWs.off?.('message', onFrame);
        boundWs = ws;
        ws.on('message', onFrame);
    };

    listener.on('connected', bind);
    bind();
    return () => {
        listener.off?.('connected', bind);
        boundWs?.off?.('message', onFrame);
        boundWs = null;
    };
}
