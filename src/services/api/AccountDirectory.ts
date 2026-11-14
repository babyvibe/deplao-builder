/**
 * AccountDirectory: the account directory (Zalo, Facebook, Telegram) for the API layer.
 *
 * Loaded from the IPC channel `login:getAccounts` (the same source the UI uses), cached for 3 seconds.
 * - `get/list` return AccountInfo WITHOUT cookies/imei/user_agent.
 * - `zaloAuthFor` builds auth exactly like the UI's buildZaloAuth (src/ui/lib/ipc.ts) to pass
 *   into the zalo:* handlers: used only inside the process, never returned outside.
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

    /** Auth for the zalo:* handlers, same as the UI's buildZaloAuth(acc, accountId). */
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
