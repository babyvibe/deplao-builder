/**
 * AccountDirectory — danh bạ tài khoản (Zalo, Facebook, Telegram) cho lớp API.
 *
 * Lấy từ kênh IPC `login:getAccounts` (cùng nguồn UI dùng), cache 3 giây.
 * - `get/list` trả AccountInfo KHÔNG có cookies/imei/user_agent.
 * - `zaloAuthFor` dựng auth y hệt buildZaloAuth của UI (src/ui/lib/ipc.ts) để truyền
 *   vào handler zalo:* — chỉ dùng trong process, không bao giờ trả ra ngoài.
 */
import type { AccountInfo } from './types';

export type AccountFetcher = () => Promise<any>;

const CACHE_MS = 3000;

export function toAccountInfo(raw: any): AccountInfo {
    return {
        id: String(raw?.zalo_id ?? raw?.id ?? ''),
        channel: String(raw?.channel || 'zalo'),
        display_name: String(raw?.full_name ?? raw?.name ?? ''),
        avatar_url: String(raw?.avatar_url ?? ''),
        phone: String(raw?.phone ?? ''),
        online: !!raw?.isOnline,
        is_business: !!raw?.is_business,
        listener_active: raw?.listenerActive !== undefined ? !!raw.listenerActive : !!raw?.listener_active,
        created_at: raw?.created_at ?? null,
        last_seen: raw?.last_seen ?? null,
    };
}

interface Snapshot {
    at: number;
    list: AccountInfo[];
    raw: Map<string, any>;
}

export class AccountDirectory {
    private cache: Snapshot | null = null;
    private inflight: Promise<Snapshot> | null = null;

    constructor(private readonly fetcher: AccountFetcher) {}

    invalidate(): void {
        this.cache = null;
    }

    private async snapshot(): Promise<Snapshot> {
        const now = Date.now();
        if (this.cache && now - this.cache.at < CACHE_MS) return this.cache;
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            try {
                const res = await this.fetcher();
                const rows: any[] = Array.isArray(res) ? res : (res?.accounts || []);
                const raw = new Map<string, any>();
                const list: AccountInfo[] = [];
                for (const row of rows) {
                    const info = toAccountInfo(row);
                    if (!info.id) continue;
                    raw.set(info.id, row);
                    list.push(info);
                }
                this.cache = { at: Date.now(), list, raw };
                return this.cache;
            } finally {
                this.inflight = null;
            }
        })();
        return this.inflight;
    }

    async list(): Promise<AccountInfo[]> {
        return (await this.snapshot()).list;
    }

    async get(accountId: string): Promise<AccountInfo | null> {
        const id = String(accountId);
        return (await this.list()).find(a => a.id === id) || null;
    }

    /** Auth cho handler zalo:* — giống buildZaloAuth(acc, accountId) của UI. */
    async zaloAuthFor(accountId: string): Promise<Record<string, string>> {
        const id = String(accountId);
        const row = (await this.snapshot()).raw.get(id);
        return {
            cookies: String(row?.cookies || ''),
            imei: String(row?.imei || ''),
            userAgent: String(row?.user_agent || ''),
            accountId: id,
            zaloId: id,
        };
    }
}
