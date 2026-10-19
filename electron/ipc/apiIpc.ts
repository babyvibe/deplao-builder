/**
 * apiIpc — IPC cho phần API của trang Công cụ → Ứng dụng, API & Webhook (chỉ renderer của Boss gọi).
 *
 * Các kênh api:* KHÔNG được route v1 nào gọi tới (không tự nâng quyền qua API).
 */
import { ipcMain, shell } from 'electron';
import Logger from '../../src/utils/Logger';
import ApiPlatform from '../../src/services/api/ApiPlatform';
import ApiKeyService from '../../src/services/api/ApiKeyService';
import {
    API_SETTING_DEFAULTS, API_SETTING_KEYS, ApiSettingKey, getAllApiSettings, setApiSetting, clearApiSettingsCache,
} from '../../src/services/api/settings';
import { API_SCOPES, ApiError, SCOPE_PRESETS } from '../../src/services/api/types';
import { principalLogId } from '../../src/services/api/types';
import { EVENT_TYPES } from '../../src/services/api/events/catalog';

function relay(): any {
    return require('../../src/services/http/HttpRelayService').default.getInstance();
}

function fail(err: any): { success: false; error: string; code?: string } {
    if (err instanceof ApiError) return { success: false, error: err.message, code: err.code };
    return { success: false, error: err?.message || String(err) };
}

function isEmployeeMachine(): boolean {
    try {
        const AppModeManager = require('../../src/utils/AppModeManager').default;
        return AppModeManager.getInstance().getMode() === 'employee';
    } catch {
        return false;
    }
}

export function registerApiIpc(): void {
    ipcMain.handle('api:status', async () => {
        try {
            const st = relay().getStatus();
            return {
                success: true,
                server: {
                    running: !!st.running,
                    port: st.port,
                    localIPs: st.localIPs || [],
                    tunnelActive: !!st.tunnelActive,
                    tunnelUrl: st.tunnelUrl || null,
                    connectedEmployees: (st.connectedEmployees || []).length,
                },
                platform: ApiPlatform.getInstance().status(),
                settings: getAllApiSettings(),
                defaults: API_SETTING_DEFAULTS,
                scopes: API_SCOPES,
                presets: SCOPE_PRESETS,
                employeeMachine: isEmployeeMachine(),
            };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:server:start', async (_e, { port }: { port?: number } = {}) => {
        try {
            if (isEmployeeMachine()) return { success: false, error: 'Máy nhân viên không chạy API server' };
            const res = await relay().start(port);
            return res;
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:server:stop', async () => {
        try {
            return relay().stop();
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:settings:set', async (_e, { key, value }: { key: string; value: string }) => {
        try {
            if (!API_SETTING_KEYS.includes(key as ApiSettingKey)) return { success: false, error: `Không có cài đặt ${key}` };
            setApiSetting(key as ApiSettingKey, String(value ?? ''));
            clearApiSettingsCache();
            ApiPlatform.getInstance().invalidateOpenApi();
            return { success: true, settings: getAllApiSettings() };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:keys:list', async (_e, { includeRevoked }: { includeRevoked?: boolean } = {}) => {
        try {
            const keys = ApiKeyService.getInstance().list({ includeRevoked: !!includeRevoked });
            return { success: true, keys };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:keys:create', async (_e, input: any) => {
        try {
            const res = ApiKeyService.getInstance().create({
                name: input?.name,
                scopes: input?.scopes || [],
                accountIds: input?.accountIds ?? null,
                allowedIps: input?.allowedIps ?? null,
                rateLimitPerMin: input?.rateLimitPerMin ?? 0,
                erpRole: input?.erpRole,
                note: input?.note,
                expiresAt: input?.expiresAt ?? null,
                createdBy: 'boss',
            });
            Logger.log(`[apiIpc] API key created: ${res.record.name} (${res.record.key_prefix}…) scopes=${res.record.scopes.join(',')}`);
            return { success: true, key: res.key, record: res.record };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:keys:update', async (_e, { id, patch }: { id: string; patch: any }) => {
        try {
            const record = ApiKeyService.getInstance().update(id, patch || {});
            return { success: true, record };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:keys:revoke', async (_e, { id }: { id: string }) => {
        try {
            const ok = ApiKeyService.getInstance().revoke(id);
            Logger.log(`[apiIpc] API key revoked: ${id}`);
            return { success: ok };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:keys:revokeAll', async () => {
        try {
            const count = ApiKeyService.getInstance().revokeAll();
            Logger.warn(`[apiIpc] Revoked ALL API keys (${count})`);
            return { success: true, count };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:keys:purge', async (_e, { id }: { id: string }) => {
        try {
            const ok = ApiKeyService.getInstance().purge(id);
            // Xoá hẳn key → xoá luôn webhook của key (không còn ai sở hữu).
            if (ok) ApiPlatform.getInstance().getWebhooks().removeByOwner(id);
            return { success: ok };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:keys:usage', async (_e, { id, hours }: { id: string; hours?: number }) => {
        try {
            const usage = ApiPlatform.getInstance().log.usage(id, hours || 24);
            return { success: true, usage };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:logs:list', async (_e, { limit, principalId }: { limit?: number; principalId?: string } = {}) => {
        try {
            const logs = ApiPlatform.getInstance().log.latest(limit || 100, principalId);
            return { success: true, logs };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:docs:open', async (_e: any, params?: { hash?: string }) => {
        try {
            // Bấm "Mở tài liệu API" là đủ: server chưa chạy thì tự bật (trừ máy nhân viên).
            let st = relay().getStatus();
            let started = false;
            if (!st.running) {
                if (isEmployeeMachine()) return { success: false, error: 'Máy nhân viên không chạy API server' };
                const res = await relay().start();
                if (!res?.success) return { success: false, error: res?.error || 'Không bật được API server' };
                started = true;
                st = relay().getStatus();
                Logger.log(`[apiIpc] API server auto-started on port ${st.port} to open docs`);
            }
            // Chỉ nhận mục của trang docs (#guide/…, #op/…, #tag/…, #overview) — không cho ghép URL tuỳ ý.
            const hash = typeof params?.hash === 'string' && /^#[A-Za-z0-9/_%.-]{1,120}$/.test(params.hash) ? params.hash : '';
            await shell.openExternal(`http://127.0.0.1:${st.port}/docs${hash}`);
            return { success: true, started, port: st.port };
        } catch (err: any) {
            return fail(err);
        }
    });

    // ─── Webhook (tab API) ────────────────────────────────────
    // Webhook tạo trong app: chủ = null (nhận mọi tài khoản), được trỏ vào mạng nội bộ.

    ipcMain.handle('api:webhooks:list', async () => {
        try {
            const keys = new Map(ApiKeyService.getInstance().list({ includeRevoked: true }).map(k => [k.id, k.name]));
            const webhooks = ApiPlatform.getInstance().getWebhooks().list().map(w => ({
                ...w,
                owner: w.key_id === null ? 'app' : (keys.get(w.key_id) || w.key_id),
            }));
            return { success: true, webhooks };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:webhooks:create', async (_e, input: any) => {
        try {
            const res = ApiPlatform.getInstance().getWebhooks().create({
                keyId: null,
                name: input?.name,
                url: String(input?.url || ''),
                events: Array.isArray(input?.events) ? input.events.map(String) : ['*'],
                accountIds: Array.isArray(input?.accountIds) && input.accountIds.length ? input.accountIds.map(String) : null,
                allowPrivate: true,
            });
            Logger.log(`[apiIpc] webhook created: ${res.subscription.id} → ${res.subscription.url}`);
            return { success: true, webhook: res.subscription, secret: res.secret };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:webhooks:update', async (_e, { id, patch }: { id: string; patch: any }) => {
        try {
            const p = patch || {};
            const webhook = ApiPlatform.getInstance().getWebhooks().update(id, undefined, {
                name: p.name,
                url: p.url,
                events: Array.isArray(p.events) ? p.events.map(String) : undefined,
                accountIds: p.accountIds === undefined ? undefined : (Array.isArray(p.accountIds) && p.accountIds.length ? p.accountIds.map(String) : null),
                active: typeof p.active === 'boolean' ? p.active : undefined,
                allowPrivate: true,
            });
            return { success: true, webhook };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:webhooks:delete', async (_e, { id }: { id: string }) => {
        try {
            ApiPlatform.getInstance().getWebhooks().remove(id);
            return { success: true };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:webhooks:test', async (_e, { id }: { id: string }) => {
        try {
            const result = await ApiPlatform.getInstance().getWebhooks().test(id);
            return { success: true, result };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:webhooks:deliveries', async (_e, { id, status, limit }: { id: string; status?: string; limit?: number }) => {
        try {
            const deliveries = ApiPlatform.getInstance().getWebhooks().deliveries(id, { status, limit });
            return { success: true, deliveries };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:webhooks:retry', async (_e, { deliveryId }: { deliveryId: string }) => {
        try {
            ApiPlatform.getInstance().getWebhooks().retry(deliveryId);
            return { success: true };
        } catch (err: any) {
            return fail(err);
        }
    });

    ipcMain.handle('api:events:types', async () => ({ success: true, types: EVENT_TYPES }));

    void principalLogId;
}
