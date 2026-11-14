/**
 * syncFacade: "Data sync": ONE shared setup (accounts + from date + mode + include photos/files) for the data (DB)
 * and the photos / files (media) of the open workspace.
 *
 * It has no sync logic of its own: it only calls the right functions of the DB module (cloudDb) and the media module (cloudMedia), in a safe order:
 *  1. Scope first (the same scope for both): the first base snapshot / upload uses the new scope.
 *  2. Remember "kèm ảnh" (include photos): turning sync off and on again still matches what the user wants.
 *  3. Turn media on / off (runs when sync is on and photos are included).
 *  4. DB mode (off / hourly / realtime): turning it on the first time needs the backup password.
 */
import {
    normalizeScope, sameScope, type CloudScope, type DbSyncMode, type SyncConfig, type SyncOverview,
} from '../../shared/cloud/cloudContracts';
import { CloudError } from './contracts';
import type { CloudDbModule, CloudflareCore, CloudMediaModule } from './contracts';
import { tr } from '../../shared/i18n';

export interface SyncFacadeDeps {
    core(): CloudflareCore;
    db(): CloudDbModule;
    media(): CloudMediaModule;
    /** The open workspace (to know whether its copy on R2 already exists); missing = consider every workspace. */
    activeWorkspaceId?(): string | null;
}

const DB_MODES: ReadonlyArray<DbSyncMode> = ['off', 'hourly', 'realtime'];

/** The current setup, derived from the two modules (the scope comes from the DB, the main source; media uses the same scope after its first save). */
export function readSyncConfig(deps: SyncFacadeDeps): SyncConfig {
    const db = deps.db().status();
    const media = deps.media().status();
    const prefs = deps.core().settings.get().sync;
    // Never saved (a version from before the shared screen existed): if sync is on, follow whether media is on / off, otherwise default to including photos.
    const includeMedia = typeof prefs?.includeMedia === 'boolean'
        ? prefs.includeMedia
        : (db.mode !== 'off' ? media.enabled : true);
    return {
        mode: db.mode,
        scope: normalizeScope(db.scope),
        includeMedia,
        includeShared: media.options.includeShared !== false,
    };
}

export function readSyncOverview(deps: SyncFacadeDeps): SyncOverview {
    return { config: readSyncConfig(deps), db: deps.db().status(), media: deps.media().status() };
}

/** Normalizes the input (IPC already checked the types): valid mode, standard scope, non-empty account list. */
export function normalizeSyncConfig(input: Partial<SyncConfig> | null | undefined): SyncConfig {
    const v = input || {};
    const mode = DB_MODES.includes(v.mode as DbSyncMode) ? (v.mode as DbSyncMode) : 'off';
    const scope: CloudScope = normalizeScope(v.scope);
    if (Array.isArray(scope.accounts) && scope.accounts.length === 0) {
        throw new CloudError('BAD_INPUT', tr('Chọn ít nhất một tài khoản'));
    }
    return { mode, scope, includeMedia: v.includeMedia !== false, includeShared: v.includeShared !== false };
}

/**
 * Saves the setup once. rebase = a copy already exists on R2 and the scope changed → the DB module takes a new base snapshot for the new scope.
 * An error midway (e.g. missing R2 permission) → throws; the steps saved before it are kept (the UI reads the state again).
 */
export async function applySyncConfig(
    deps: SyncFacadeDeps, input: Partial<SyncConfig>,
): Promise<{ overview: SyncOverview; rebase: boolean }> {
    const cfg = normalizeSyncConfig(input);
    const dbMod = deps.db();
    const mediaMod = deps.media();
    const before = dbMod.status();
    if (cfg.mode !== 'off' && !before.passphraseSet) {
        throw new CloudError('PASSPHRASE_REQUIRED', tr('Đặt mật khẩu sao lưu trước khi bật đồng bộ'));
    }

    // 1. Scope: the same scope for data and photos / files.
    let rebase = false;
    if (!sameScope(normalizeScope(before.scope), cfg.scope)) {
        await dbMod.setScope(cfg.scope);
        const activeId = deps.activeWorkspaceId?.() ?? null;
        rebase = before.workspaces.some(w => !!w.baseAt && (!activeId || w.workspaceId === activeId));
    }
    const mediaNow = mediaMod.status();
    const mediaScopeChanged = !sameScope(normalizeScope(mediaNow.options.scope), cfg.scope);
    const sharedChanged = (mediaNow.options.includeShared !== false) !== cfg.includeShared;
    if (mediaScopeChanged || sharedChanged) {
        await mediaMod.setOptions({ scope: cfg.scope, includeShared: cfg.includeShared });
    }

    // 2. Remember "kèm ảnh" (include photos).
    deps.core().settings.update(draft => {
        draft.sync = { ...(draft.sync || {}), includeMedia: cfg.includeMedia };
    });

    // 3. Photos / files run when sync is on and photos are included.
    const wantMedia = cfg.mode !== 'off' && cfg.includeMedia;
    if (mediaMod.status().enabled !== wantMedia) await mediaMod.setEnabled(wantMedia);

    // 4. Data mode.
    if (dbMod.status().mode !== cfg.mode) await dbMod.setMode(cfg.mode);

    return { overview: readSyncOverview(deps), rebase };
}
