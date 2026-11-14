/**
 * restoreGate: after the DB is restored from R2 (a new machine / a backup machine), all automation that can send messages
 * (CRM campaigns, workflows, the app's schedules) must wait until the user confirms the old machine is turned off (step 6 of the
 * restore wizard), so two machines do not send the same campaign.
 *
 * The flags live in the app_settings of the workspace (Restore writes them into the file it restored before replacing the DB):
 *  - 'cloud_restore_paused_automations' = '1' → automation paused.
 *  - 'cloud_restore_pending_relogin'    = '1' → a channel still needs to sign in again (only for the UI to remind).
 *
 * Reading the flags is cheap (one SELECT by primary key, cached for 5 s, reread when the workspace changes), so it can be called on the hot path.
 */
import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';

export const RESTORE_PAUSED_KEY = 'cloud_restore_paused_automations';
export const RESTORE_RELOGIN_KEY = 'cloud_restore_pending_relogin';

const CACHE_MS = 5000;
let cache: { value: boolean; at: number; dbPath: string } | null = null;

/** true when the open workspace was just restored and the user has not turned automation back on. */
export function automationsPausedAfterRestore(): boolean {
    try {
        const db = DatabaseService.getInstance();
        const dbPath = db.getDbPath();
        const now = Date.now();
        if (cache && cache.dbPath === dbPath && now - cache.at < CACHE_MS) return cache.value;
        const value = db.getSetting(RESTORE_PAUSED_KEY) === '1';
        cache = { value, at: now, dbPath };
        return value;
    } catch {
        return false;
    }
}

export function restorePendingRelogin(): boolean {
    try {
        return DatabaseService.getInstance().getSetting(RESTORE_RELOGIN_KEY) === '1';
    } catch {
        return false;
    }
}

/** Step 6 of the restore wizard: the user confirms the old machine is off → clear the flags and run the interrupted campaign again. */
export function resumeAutomationsAfterRestore(): void {
    const db = DatabaseService.getInstance();
    db.setSetting(RESTORE_PAUSED_KEY, '0');
    db.setSetting(RESTORE_RELOGIN_KEY, '0');
    cache = null;
    try {
        // lazy require: avoids an import cycle CRMQueueService ↔ DatabaseService at startup.
        const CRMQueueService = require('../crm/CRMQueueService').default;
        CRMQueueService.getInstance().resumeActiveCampaigns();
    } catch (err: any) {
        Logger.warn(`[restoreGate] resume campaigns: ${err?.message || err}`);
    }
    Logger.log('[restoreGate] Automations resumed after restore');
}

/** Called when the DB is replaced / the workspace changes, so the next read gets the new value at once. */
export function invalidateRestoreGate(): void {
    cache = null;
}
