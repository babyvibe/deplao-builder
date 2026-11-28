/**
 * Fills the name / picture of Facebook conversations in the background, one queue per account.
 *
 * Before, the only lookup that always ran was the one when a conversation is opened (ChatHeader), so a new conversation in
 * the list showed its id and initials until it was clicked, and conversations found by the inbox / history sync were never
 * looked up at all. The queue skips the account itself, non-numeric ids and group threads, never asks for the same id twice
 * at once, backs off per id after a failure (10 min → 1 h → 6 h), paces the lookups and pauses on a Facebook risk error.
 * Only existing conversation rows are updated: a name is filled when missing (or equal to the id), a picture when missing,
 * expired, or equal to the account's own picture (an old bug copied it onto Page threads).
 */
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';

export interface FacebookProfile {
    name: string;
    avatarUrl: string;
}

export interface FacebookProfileResolverDeps {
    /** fb_accounts.id */
    accountId: string;
    /** contacts.owner_zalo_id of the account (its Facebook uid) */
    ownerId(): string;
    lookup(uid: string): Promise<FacebookProfile | null>;
    /** Local copy of the picture (Facebook links expire); null keeps the link. */
    saveAvatar?(uid: string, url: string): Promise<string | null>;
    isRiskError?(err: unknown): boolean;
    gapMs?: number;
}

export interface ResolvedContact {
    contactId: string;
    displayName: string;
    avatarUrl: string;
}

const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const GAP_MS = 800;
const RISK_PAUSE_MS = 30 * 60_000;
const FAILURE_PAUSE_MS = 10 * 60_000;
const MAX_FAILURES_IN_ROW = 3;
const SWEEP_LIMIT = 100;
const EMIT_EVERY = 10;

/** Compare signed Facebook CDN URLs without treating unrelated image URLs as equal. */
export function isSameFacebookAvatar(left?: string, right?: string): boolean {
    if (!left || !right) return false;
    if (left === right) return true;
    try {
        const aHash = new URL(left).searchParams.get('oh');
        const bHash = new URL(right).searchParams.get('oh');
        return !!aHash && aHash === bHash;
    } catch {
        return false;
    }
}

/** Facebook CDN links carry their expiry as hex unix seconds (`oe=`); a local file path never expires. */
export function isExpiredFacebookUrl(url: unknown, nowMs = Date.now()): boolean {
    const match = /[?&]oe=([0-9a-f]{8})(?:&|$)/i.exec(String(url || ''));
    return !!match && parseInt(match[1], 16) * 1000 < nowMs;
}

const isPersonId = (id: string) => /^\d{5,20}$/.test(id);

export class FacebookProfileResolver {
    private queue: string[] = [];
    private queued = new Set<string>();
    private failures = new Map<string, { count: number; until: number }>();
    private running = false;
    private pausedUntil = 0;
    private resumeTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(private readonly deps: FacebookProfileResolverDeps) {}

    /** Queue ids for a lookup; returns how many were added. */
    enqueue(ids: Iterable<string>, now = Date.now()): number {
        if (this.stopped) return 0;
        const owner = this.deps.ownerId();
        let added = 0;
        for (const raw of ids) {
            const id = String(raw || '').trim();
            if (!isPersonId(id) || id === owner || this.queued.has(id)) continue;
            const failure = this.failures.get(id);
            if (failure && failure.until > now) continue;
            if (this.isGroup(id)) continue;
            this.queue.push(id);
            this.queued.add(id);
            added++;
        }
        if (added) void this.drain();
        return added;
    }

    /** Queue the one-to-one conversations of the account that still miss a name or a usable picture. */
    sweep(now = Date.now()): number {
        try {
            const db = DatabaseService.getInstance();
            const owner = this.deps.ownerId();
            const accountAvatar = db.queryOne<{ avatar_url?: string }>(
                `SELECT avatar_url FROM fb_accounts WHERE id = ?`, [this.deps.accountId])?.avatar_url || '';
            const rows = db.query<{ id: string; name: string | null; avatar: string | null }>(
                `SELECT c.contact_id AS id, c.display_name AS name, c.avatar_url AS avatar
                 FROM contacts c
                 LEFT JOIN fb_threads t ON t.id = c.contact_id AND t.account_id = ?
                 WHERE c.owner_zalo_id = ? AND c.channel = 'facebook' AND COALESCE(c.contact_type, 'user') <> 'group'
                   AND COALESCE(t.type, 'user') <> 'group' AND c.contact_id GLOB '[0-9]*' AND c.contact_id <> ?
                   AND (COALESCE(c.last_message_time, 0) > 0 OR t.id IS NOT NULL)
                   AND (c.display_name IS NULL OR trim(c.display_name) = '' OR c.display_name = c.contact_id
                        OR c.avatar_url IS NULL OR trim(c.avatar_url) = '' OR c.avatar_url LIKE '%oe=%')
                 ORDER BY COALESCE(c.last_message_time, 0) DESC LIMIT 500`,
                [this.deps.accountId, owner, owner]);
            const stale = rows.filter(r => this.needsProfile(r.id, r.name, r.avatar, accountAvatar, now)).map(r => r.id);
            return this.enqueue(stale.slice(0, SWEEP_LIMIT), now);
        } catch (err: any) {
            Logger.warn(`[FacebookProfiles:${this.deps.accountId}] sweep failed: ${err?.message || err}`);
            return 0;
        }
    }

    stop(): void {
        this.stopped = true;
        this.queue = [];
        this.queued.clear();
        if (this.resumeTimer) clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
    }

    /** For tests: resolves when the current run is over. */
    async idle(): Promise<void> {
        while (this.running) await new Promise(resolve => setTimeout(resolve, 5));
    }

    private needsProfile(id: string, name: unknown, avatar: unknown, accountAvatar: string, now: number): boolean {
        const n = String(name ?? '').trim();
        const a = String(avatar ?? '').trim();
        return !n || n === id || !a || isSameFacebookAvatar(a, accountAvatar) || isExpiredFacebookUrl(a, now);
    }

    private isGroup(id: string): boolean {
        try {
            const db = DatabaseService.getInstance();
            const thread = db.queryOne<{ type?: string }>(`SELECT type FROM fb_threads WHERE id = ? AND account_id = ?`, [id, this.deps.accountId]);
            if (thread?.type === 'group') return true;
            const contact = db.queryOne<{ contact_type?: string }>(
                `SELECT contact_type FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
                [this.deps.ownerId(), id]);
            return contact?.contact_type === 'group';
        } catch {
            return false;
        }
    }

    private backoff(id: string, now = Date.now()): void {
        const count = (this.failures.get(id)?.count || 0) + 1;
        this.failures.set(id, { count, until: now + BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1] });
    }

    private pause(ms: number): void {
        this.pausedUntil = Date.now() + ms;
        if (this.resumeTimer) clearTimeout(this.resumeTimer);
        this.resumeTimer = setTimeout(() => { this.resumeTimer = null; void this.drain(); }, ms);
        (this.resumeTimer as any)?.unref?.();
    }

    private async drain(): Promise<void> {
        if (this.running || this.stopped || Date.now() < this.pausedUntil) return;
        this.running = true;
        const changed: ResolvedContact[] = [];
        let failuresInRow = 0;
        try {
            while (this.queue.length && !this.stopped) {
                const id = this.queue.shift()!;
                this.queued.delete(id);
                let profile: FacebookProfile | null = null;
                try {
                    profile = await this.deps.lookup(id);
                } catch (err: any) {
                    if (this.deps.isRiskError?.(err?.message ?? err)) {
                        Logger.warn(`[FacebookProfiles:${this.deps.accountId}] Facebook refused (${err?.message || err}), pausing lookups`);
                        this.backoff(id);
                        this.pause(RISK_PAUSE_MS);
                        break;
                    }
                }
                if (profile && (String(profile.name || '').trim() || profile.avatarUrl)) {
                    failuresInRow = 0;
                    this.failures.delete(id);
                    const row = await this.apply(id, profile);
                    if (row) changed.push(row);
                    if (changed.length >= EMIT_EVERY) this.flush(changed);
                } else {
                    this.backoff(id);
                    if (++failuresInRow >= MAX_FAILURES_IN_ROW) {
                        this.pause(FAILURE_PAUSE_MS);
                        break;
                    }
                }
                if (this.queue.length) {
                    const gap = this.deps.gapMs ?? GAP_MS;
                    await new Promise(resolve => setTimeout(resolve, gap + Math.floor(Math.random() * (gap / 2 + 1))));
                }
            }
        } finally {
            this.flush(changed);
            this.running = false;
        }
    }

    /** Write the profile into the existing conversation row (never creates one). */
    private async apply(id: string, profile: FacebookProfile): Promise<ResolvedContact | null> {
        const db = DatabaseService.getInstance();
        const owner = this.deps.ownerId();
        const row = db.queryOne<{ display_name?: string; avatar_url?: string }>(
            `SELECT display_name, avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
            [owner, id]);
        // Group members without a name (encrypted groups only send ids) get the name / picture too
        if (profile.name || profile.avatarUrl) {
            try {
                db.applyFBPeople(this.deps.accountId, [{ id, name: String(profile.name || ''), avatarUrl: String(profile.avatarUrl || '') }]);
            } catch { /* member rows only */ }
        }
        if (!row) return null;
        const accountAvatar = db.queryOne<{ avatar_url?: string }>(
            `SELECT avatar_url FROM fb_accounts WHERE id = ?`, [this.deps.accountId])?.avatar_url || '';

        const name = String(profile.name || '').trim();
        const currentName = String(row.display_name || '').trim();
        const fillName = !!name && (!currentName || currentName === id);
        const currentAvatar = String(row.avatar_url || '').trim();
        const needAvatar = !currentAvatar || isSameFacebookAvatar(currentAvatar, accountAvatar) || isExpiredFacebookUrl(currentAvatar);
        let avatar = '';
        if (needAvatar && profile.avatarUrl && !isSameFacebookAvatar(profile.avatarUrl, accountAvatar)) {
            avatar = (await this.deps.saveAvatar?.(id, profile.avatarUrl).catch(() => null)) || profile.avatarUrl;
        }
        if (!fillName && !avatar) return null;

        db.transaction(() => {
            if (fillName) {
                db.run(`UPDATE contacts SET display_name = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`, [name, owner, id]);
                db.run(`UPDATE fb_threads SET name = ? WHERE id = ? AND account_id = ? AND COALESCE(name, '') = ''`, [name, id, this.deps.accountId]);
            }
            if (avatar) {
                db.run(`UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`, [avatar, owner, id]);
                // saveFBMessage copies fb_threads.metadata.avatar_url onto the contact on every new message: keep it current
                const thread = db.queryOne<{ metadata?: string }>(`SELECT metadata FROM fb_threads WHERE id = ? AND account_id = ?`, [id, this.deps.accountId]);
                if (thread) {
                    let meta: any = {};
                    try { meta = thread.metadata ? JSON.parse(thread.metadata) : {}; } catch { meta = {}; }
                    meta.avatar_url = avatar;
                    db.run(`UPDATE fb_threads SET metadata = ? WHERE id = ? AND account_id = ?`, [JSON.stringify(meta), id, this.deps.accountId]);
                }
            }
        });
        return { contactId: id, displayName: fillName ? name : currentName, avatarUrl: avatar || currentAvatar };
    }

    private flush(changed: ResolvedContact[]): void {
        if (!changed.length) return;
        // Same event as the Zalo refresh: the renderer patches the rows it has (also relayed to employees)
        EventBroadcaster.emit('db:contactProfileUpdated', { ownerZaloId: this.deps.ownerId(), contacts: changed.splice(0) });
    }
}
