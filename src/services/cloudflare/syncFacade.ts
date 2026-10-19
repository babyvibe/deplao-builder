/**
 * syncFacade — "Đồng bộ dữ liệu": MỘT thiết lập chung (tài khoản + từ ngày + chế độ + kèm ảnh/file) cho dữ liệu (DB)
 * và ảnh/file (media) của workspace đang mở.
 *
 * Không có logic đồng bộ riêng — chỉ gọi đúng các hàm của module DB (cloudDb) và media (cloudMedia), theo thứ tự an toàn:
 *  1. Phạm vi trước (cùng một phạm vi cho cả hai) → lần chụp bản gốc / tải lên đầu tiên đã dùng phạm vi mới.
 *  2. Ghi nhớ "kèm ảnh" (đồng bộ tắt rồi bật lại vẫn đúng ý người dùng).
 *  3. Bật / tắt media (chạy khi đồng bộ bật và kèm ảnh).
 *  4. Chế độ DB (tắt / theo giờ / realtime) — bật lần đầu cần mật khẩu sao lưu.
 */
import {
    normalizeScope, sameScope, type CloudScope, type DbSyncMode, type SyncConfig, type SyncOverview,
} from '../../shared/cloudContracts';
import { CloudError } from './contracts';
import type { CloudDbModule, CloudflareCore, CloudMediaModule } from './contracts';

export interface SyncFacadeDeps {
    core(): CloudflareCore;
    db(): CloudDbModule;
    media(): CloudMediaModule;
    /** Workspace đang mở (để biết bản trên R2 của nó có sẵn chưa); thiếu = xét mọi workspace. */
    activeWorkspaceId?(): string | null;
}

const DB_MODES: ReadonlyArray<DbSyncMode> = ['off', 'hourly', 'realtime'];

/** Thiết lập hiện tại suy từ hai module (phạm vi lấy theo DB — nguồn chính; media cùng phạm vi sau lần lưu đầu). */
export function readSyncConfig(deps: SyncFacadeDeps): SyncConfig {
    const db = deps.db().status();
    const media = deps.media().status();
    const prefs = deps.core().settings.get().sync;
    // Chưa từng lưu (bản trước khi có màn hình chung): đồng bộ đang bật thì theo media đang bật / tắt, còn lại mặc định kèm ảnh.
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

/** Chuẩn hoá đầu vào (IPC đã kiểm kiểu): chế độ hợp lệ, phạm vi chuẩn, danh sách tài khoản không rỗng. */
export function normalizeSyncConfig(input: Partial<SyncConfig> | null | undefined): SyncConfig {
    const v = input || {};
    const mode = DB_MODES.includes(v.mode as DbSyncMode) ? (v.mode as DbSyncMode) : 'off';
    const scope: CloudScope = normalizeScope(v.scope);
    if (Array.isArray(scope.accounts) && scope.accounts.length === 0) {
        throw new CloudError('BAD_INPUT', 'Chọn ít nhất một tài khoản');
    }
    return { mode, scope, includeMedia: v.includeMedia !== false, includeShared: v.includeShared !== false };
}

/**
 * Lưu thiết lập một lần. rebase = đã có bản trên R2 và phạm vi đổi → module DB sẽ chụp bản gốc mới theo phạm vi mới.
 * Lỗi giữa chừng (vd thiếu quyền R2) → ném lỗi; các bước trước đã lưu vẫn giữ (giao diện đọc lại trạng thái).
 */
export async function applySyncConfig(
    deps: SyncFacadeDeps, input: Partial<SyncConfig>,
): Promise<{ overview: SyncOverview; rebase: boolean }> {
    const cfg = normalizeSyncConfig(input);
    const dbMod = deps.db();
    const mediaMod = deps.media();
    const before = dbMod.status();
    if (cfg.mode !== 'off' && !before.passphraseSet) {
        throw new CloudError('PASSPHRASE_REQUIRED', 'Đặt mật khẩu sao lưu trước khi bật đồng bộ');
    }

    // 1. Phạm vi — cùng một phạm vi cho dữ liệu và ảnh/file.
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

    // 2. Ghi nhớ "kèm ảnh".
    deps.core().settings.update(draft => {
        draft.sync = { ...(draft.sync || {}), includeMedia: cfg.includeMedia };
    });

    // 3. Ảnh / file chạy khi đồng bộ bật và kèm ảnh.
    const wantMedia = cfg.mode !== 'off' && cfg.includeMedia;
    if (mediaMod.status().enabled !== wantMedia) await mediaMod.setEnabled(wantMedia);

    // 4. Chế độ dữ liệu.
    if (dbMod.status().mode !== cfg.mode) await dbMod.setMode(cfg.mode);

    return { overview: readSyncOverview(deps), rebase };
}
