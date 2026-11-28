/**
 * Background refresh of Zalo names and profile pictures with getMiniProfiles (zca-js >= 2.4).
 *
 * Zalo profile picture links expire (the `time=` value of the link, about two months after it was read) and then answer
 * 403, so long-lived rows in contacts / page_group_member end up with broken pictures; some group members were also saved
 * without a name (their id is shown). Once the app has settled, each connected account refreshes those rows: at most once
 * every 12 hours, a few thousand people per run, one account at a time. Names are only filled when missing.
 * Measured on real accounts: 100 / 200 / 300 ids per request all answered in under 0.2 s.
 */
import Logger from '../../utils/Logger';
import EventBroadcaster from '../event/EventBroadcaster';
import type DatabaseService from '../database/DatabaseService';

export const ZALO_PROFILE_REFRESH_EVERY_MS = 12 * 60 * 60 * 1000;
export const ZALO_PROFILE_BATCH = 200;
const GAP_MS = 1500;
const MAX_PEOPLE_PER_RUN = 6000;
const MAX_FAILURES = 3;
/** Refresh links that expire within this many seconds. */
const EXPIRY_MARGIN_S = 3 * 24 * 60 * 60;

export interface ZaloProfileRefreshApi {
    getMiniProfiles(userIds: string[]): Promise<Record<string, { zaloName?: string; avatar?: string } | undefined>>;
}

interface StaleContact { id: string; name: string | null; avatar: string | null }
interface StaleMember extends StaleContact { groupId: string }

const lastRunAt = new Map<string, number>();
let queue: Promise<unknown> = Promise.resolve();

/** Expiry (unix seconds) of a Zalo profile picture link (`time=` in the query), 0 when the link has none. */
export function zaloAvatarExpiry(url: unknown): number {
    const match = /[?&]time=(\d{9,11})(?:&|$)/.exec(String(url || ''));
    return match ? Number(match[1]) : 0;
}

/** Name missing / equal to the id, picture missing or expiring within the margin. */
export function isStaleZaloProfile(id: string, name: unknown, avatar: unknown, nowSec: number): boolean {
    const n = String(name ?? '').trim();
    if (!n || n === id) return true;
    const a = String(avatar ?? '').trim();
    if (!a) return true;
    const expiry = zaloAvatarExpiry(a);
    return expiry > 0 && expiry < nowSec + EXPIRY_MARGIN_S;
}

/** SQL twin of isStaleZaloProfile (the `?` is nowSec + margin). */
function staleSql(name: string, id: string, avatar: string): string {
    return `(${name} IS NULL OR trim(${name}) = '' OR ${name} = ${id}
        OR ${avatar} IS NULL OR trim(${avatar}) = ''
        OR (instr(${avatar}, 'time=') > 0 AND CAST(substr(${avatar}, instr(${avatar}, 'time=') + 5) AS INTEGER) < ?))`;
}

export function pickStaleZaloProfiles(db: DatabaseService, zaloId: string, nowSec: number): { contacts: StaleContact[]; members: StaleMember[] } {
    const cutoff = nowSec + EXPIRY_MARGIN_S;
    const contacts = db.query<StaleContact>(
        `SELECT contact_id AS id, display_name AS name, avatar_url AS avatar FROM contacts
         WHERE owner_zalo_id = ? AND (channel = 'zalo' OR channel IS NULL) AND contact_type <> 'group'
           AND contact_id GLOB '[0-9]*' AND ${staleSql('display_name', 'contact_id', 'avatar_url')}
         ORDER BY last_message_time DESC LIMIT ?`,
        [zaloId, cutoff, MAX_PEOPLE_PER_RUN]);
    // Members of the most recently active groups first
    const members = db.query<StaleMember>(
        `SELECT m.group_id AS groupId, m.member_id AS id, m.display_name AS name, m.avatar AS avatar
         FROM page_group_member m
         LEFT JOIN contacts g ON g.owner_zalo_id = m.owner_zalo_id AND g.contact_id = m.group_id
         WHERE m.owner_zalo_id = ? AND m.member_id GLOB '[0-9]*' AND ${staleSql('m.display_name', 'm.member_id', 'm.avatar')}
         ORDER BY COALESCE(g.last_message_time, 0) DESC LIMIT ?`,
        [zaloId, cutoff, MAX_PEOPLE_PER_RUN * 4]);
    return { contacts, members };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Refresh one account's stale names / pictures now. Returns how many contacts and member rows changed. */
export async function refreshZaloProfilesNow(
    zaloId: string,
    api: ZaloProfileRefreshApi,
    opts: { isConnected?: () => boolean; nowMs?: number; gapMs?: number } = {},
): Promise<{ people: number; contacts: number; members: number }> {
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const gap = opts.gapMs ?? GAP_MS;
    const { contacts, members } = EventBroadcaster.withBossDb(db => pickStaleZaloProfiles(db, zaloId, nowSec));

    const contactById = new Map(contacts.map(c => [String(c.id), c]));
    const membersById = new Map<string, StaleMember[]>();
    for (const m of members) {
        const list = membersById.get(String(m.id)) || [];
        list.push(m);
        membersById.set(String(m.id), list);
    }
    const people = [...new Set([...contactById.keys(), ...membersById.keys()])].slice(0, MAX_PEOPLE_PER_RUN);
    const result = { people: people.length, contacts: 0, members: 0 };
    if (!people.length) return result;

    let failures = 0;
    for (let i = 0; i < people.length; i += ZALO_PROFILE_BATCH) {
        if (opts.isConnected && !opts.isConnected()) break;
        const ids = people.slice(i, i + ZALO_PROFILE_BATCH);
        let profiles: Record<string, any>;
        try {
            const res = await api.getMiniProfiles(ids);
            profiles = res && typeof res === 'object' ? res : {};
            failures = 0;
        } catch (err: any) {
            Logger.warn(`[ZaloProfiles] ${zaloId}: getMiniProfiles failed: ${err?.message || err}`);
            if (++failures >= MAX_FAILURES) break;
            await sleep(gap * 2);
            continue;
        }

        const changedContacts: Array<{ contactId: string; displayName: string; avatarUrl: string }> = [];
        EventBroadcaster.withBossDb(db => db.transaction(() => {
            const now = Date.now();
            for (const id of ids) {
                const profile = profiles[id];
                const name = String(profile?.zaloName || '').trim();
                const avatar = String(profile?.avatar || '').trim();
                if (!name && !avatar) continue;

                const contact = contactById.get(id);
                if (contact) {
                    const fillName = !!name && (!String(contact.name || '').trim() || contact.name === id);
                    const newAvatar = !!avatar && avatar !== contact.avatar;
                    if (fillName) db.run(`UPDATE contacts SET display_name = ? WHERE owner_zalo_id = ? AND contact_id = ?`, [name, zaloId, id]);
                    if (newAvatar) db.run(`UPDATE contacts SET avatar_url = ? WHERE owner_zalo_id = ? AND contact_id = ?`, [avatar, zaloId, id]);
                    if (fillName || newAvatar) {
                        changedContacts.push({ contactId: id, displayName: fillName ? name : String(contact.name || ''), avatarUrl: newAvatar ? avatar : String(contact.avatar || '') });
                    }
                }

                for (const row of membersById.get(id) || []) {
                    const fillName = !!name && (!String(row.name || '').trim() || row.name === id);
                    const newAvatar = !!avatar && avatar !== row.avatar;
                    if (!fillName && !newAvatar) continue;
                    db.run(
                        `UPDATE page_group_member SET display_name = ?, avatar = ?, updated_at = ?
                         WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`,
                        [fillName ? name : row.name || '', newAvatar ? avatar : row.avatar || '', now, zaloId, row.groupId, id]);
                    result.members++;
                }
            }
        }));

        if (changedContacts.length) {
            result.contacts += changedContacts.length;
            // One event per batch: the conversation list updates these people in one go (also relayed to employees)
            EventBroadcaster.emit('db:contactProfileUpdated', { ownerZaloId: zaloId, contacts: changedContacts });
        }
        if (i + ZALO_PROFILE_BATCH < people.length) await sleep(gap);
    }
    return result;
}

/**
 * Schedule a refresh for an account (called once the app has settled after it connects). Accounts run one after another,
 * each at most once per ZALO_PROFILE_REFRESH_EVERY_MS.
 */
export function refreshZaloProfiles(zaloId: string, api: any, isConnected?: () => boolean): void {
    if (typeof api?.getMiniProfiles !== 'function') return;
    const last = lastRunAt.get(zaloId) || 0;
    if (Date.now() - last < ZALO_PROFILE_REFRESH_EVERY_MS) return;
    lastRunAt.set(zaloId, Date.now());
    queue = queue.then(async () => {
        if (isConnected && !isConnected()) return;
        const started = Date.now();
        try {
            const res = await refreshZaloProfilesNow(zaloId, api, { isConnected });
            if (res.people) {
                Logger.log(`[ZaloProfiles] ${zaloId}: refreshed ${res.people} people (${res.contacts} contacts, ${res.members} group member rows) in ${Math.round((Date.now() - started) / 1000)} s`);
            }
        } catch (err: any) {
            Logger.warn(`[ZaloProfiles] ${zaloId}: refresh failed: ${err?.message || err}`);
        }
    });
}

export function resetZaloProfileRefreshForTests(): void {
    lastRunAt.clear();
    queue = Promise.resolve();
}
