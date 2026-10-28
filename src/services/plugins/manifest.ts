/**
 * manifest.ts — đọc và kiểm tra deplao-plugin.json.
 *
 * Kiểm tra thủ công (không zod) để trả lỗi tiếng Việt dễ hiểu, gom nhiều lỗi một lần,
 * và áp các quy tắc chéo: quyền ↔ điểm mở rộng, runtime ↔ backend, tiền tố node type…
 */
import * as fs from 'fs';
import * as path from 'path';
import { API_SCOPES, ApiScope, isApiScope } from '../api/types';
import { compareSemver, isValidSemver } from './semver';

export const PLUGIN_API_VERSION = 1;
export const MANIFEST_FILE = 'deplao-plugin.json';
const MAX_MANIFEST_BYTES = 256 * 1024;

export type PluginRuntime = 'web' | 'local' | 'remote';

export type PluginPermission =
    | 'storage' | 'ui:pages' | 'ui:chat-panel' | 'ui:composer' | 'ui:microphone'
    | 'workflow:nodes' | 'events:emit' | 'network' | 'schedules'
    | 'cloudflare:workers';

export const PLUGIN_PERMISSIONS: ReadonlyArray<{ id: PluginPermission; label: string }> = [
    { id: 'storage', label: 'Lưu dữ liệu riêng của ứng dụng trên máy này' },
    { id: 'ui:pages', label: 'Thêm trang riêng trong Deplao' },
    { id: 'ui:chat-panel', label: 'Hiện panel trong màn hình chat và biết bạn đang mở hội thoại nào' },
    { id: 'ui:composer', label: 'Thêm nút vào ô soạn tin nhắn' },
    // Khung giao diện của ứng dụng được gắn allow="microphone" (PluginFrame) — không có quyền này thì trình duyệt chặn micro.
    { id: 'ui:microphone', label: 'Dùng micro trong giao diện ứng dụng (ghi âm khi bạn bấm nút ghi âm)' },
    { id: 'workflow:nodes', label: 'Thêm node và trigger vào Workflow' },
    { id: 'events:emit', label: 'Phát sự kiện cho Workflow, webhook và hệ thống khác' },
    { id: 'network', label: 'Kết nối Internet' },
    { id: 'schedules', label: 'Chạy định kỳ khi Deplao đang mở' },
    // deplao.cloudflare (chỉ backend): token Cloudflare không đưa cho ứng dụng; tên tài nguyên = tiền tố pluginShortName.
    { id: 'cloudflare:workers', label: 'Triển khai Worker và cơ sở dữ liệu D1 lên tài khoản Cloudflare đã kết nối trong Deplao (chỉ tài nguyên mang tên của ứng dụng này)' },
];

/** Scope plugin không được xin (tự nâng quyền / quản trị máy). */
export const FORBIDDEN_PLUGIN_SCOPES: readonly string[] = ['admin', 'plugins:manage', 'employees:manage', 'settings:write'];

/** Tiền tố node có sẵn của Deplao — phần cuối id plugin không được trùng (tránh đè node nội bộ). */
export const RESERVED_SHORT_NAMES: readonly string[] = [
    'trigger', 'action', 'logic', 'output', 'data', 'ai', 'notify', 'sheets', 'payment', 'integration', 'crm', 'erp',
    'zalo', 'fb', 'facebook', 'tg', 'tgbot', 'telegram', 'workflow', 'api', 'plugin', 'plugins', 'system', 'deplao',
    'ghn', 'ghtk', 'sapo', 'pancake', 'nhanh', 'kiotviet', 'haravan', 'casso', 'sepay', 'viettelpost', 'jt',
];

/** Scope "nhạy cảm" — tô đỏ ở màn duyệt quyền. */
const RISKY = new Set(['chat:send', 'chat:manage', 'contacts:write', 'crm:write', 'campaigns:run', 'workflow:write', 'integrations:execute', 'integrations:manage', 'erp:write', 'accounts:manage', 'network', 'cloudflare:workers', 'ui:microphone']);

export type SettingFieldType = 'string' | 'number' | 'integer' | 'boolean';

export interface SettingsField {
    type: SettingFieldType;
    title?: string;
    description?: string;
    default?: any;
    enum?: Array<string | number>;
    minimum?: number;
    maximum?: number;
    maxLength?: number;
    /** Lưu mã hoá, không hiện lại trong UI. */
    'x-secret'?: boolean;
    'x-multiline'?: boolean;
}

export interface SettingsSchema {
    type?: 'object';
    properties: Record<string, SettingsField>;
    required?: string[];
}

export interface ConfigField {
    type: SettingFieldType | 'array';
    title?: string;
    description?: string;
    default?: any;
    enum?: Array<string | number>;
    minimum?: number;
    maximum?: number;
    maxLength?: number;
    items?: { type: 'string' };
    /** Ô nhập có gợi ý biến {{ ... }} của workflow. */
    'x-template'?: boolean;
    'x-multiline'?: boolean;
    /** Dùng picker có sẵn của app (assistant = chọn trợ lý AI của Deplao, lưu id; để trống = ứng dụng tự quyết định). */
    'x-widget'?: 'account' | 'thread' | 'label' | 'assistant';
}

/** Picker có sẵn dùng được trong form cấu hình node workflow của ứng dụng. */
export const CONFIG_WIDGETS = ['account', 'thread', 'label', 'assistant'] as const;

export interface ConfigSchema {
    type?: 'object';
    properties: Record<string, ConfigField>;
    required?: string[];
}

export interface PageContribution { id: string; title: string; icon?: string; path: string }
export interface ChatPanelContribution { id: string; title: string; path: string; width?: number }
export interface ComposerButtonContribution { id: string; title: string; icon?: string; target: 'ui' | 'backend'; path?: string }
export interface OutputDef { name: string; label?: string }
export interface WorkflowNodeContribution {
    type: string;
    label: string;
    group?: string;
    description?: string;
    icon?: string;
    configSchema?: ConfigSchema;
    outputs?: OutputDef[];
}
export interface TriggerContribution {
    type: string;
    label: string;
    description?: string;
    configSchema?: ConfigSchema;
    outputs?: OutputDef[];
}
export interface RouteContribution {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    /** Scope người gọi cần có; mặc định 'any' (key hợp lệ bất kỳ). */
    scope?: string;
    description?: string;
}
export interface ScheduleContribution { id: string; cron: string; handler: string; description?: string }

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    apiVersion: number;
    minDeplaoVersion?: string;
    description?: string;
    author?: string;
    homepage?: string;
    icon?: string;
    runtime: PluginRuntime;
    permissions: string[];
    accounts?: 'all' | string[];
    ui?: { entry: string; connectSrc?: string[]; imgSrc?: string[] };
    backend?: { entry: string };
    remote?: { baseUrl: string };
    contributes?: {
        pages?: PageContribution[];
        chatPanels?: ChatPanelContribution[];
        composerButtons?: ComposerButtonContribution[];
        settings?: { schema: SettingsSchema };
        workflowNodes?: WorkflowNodeContribution[];
        triggers?: TriggerContribution[];
        routes?: RouteContribution[];
        schedules?: ScheduleContribution[];
        events?: string[];
    };
}

export type ManifestResult = { ok: true; manifest: PluginManifest; errors?: undefined } | { ok: false; errors: string[]; manifest?: undefined };

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const CONTRIB_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NODE_SUFFIX_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
const ROUTE_PATH_RE = /^\/[A-Za-z0-9_\-./:]*$/;
const EVENT_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const HANDLER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,60}$/;
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,60}$/;

/** Phần cuối của id: "vn.acme.spa" → "spa". Node/trigger type phải bắt đầu bằng "spa.". */
export function pluginShortName(id: string): string {
    const parts = String(id).split('.');
    return parts[parts.length - 1];
}

/** Đường dẫn tương đối an toàn bên trong thư mục plugin. */
export function isSafeRelativePath(p: string): boolean {
    if (typeof p !== 'string' || !p || p.length > 200) return false;
    if (p.includes('\\') || p.includes('\0') || p.includes(':')) return false;
    if (p.startsWith('/')) return false;
    return p.split('/').every(seg => seg !== '..');
}

/**
 * Nguồn ảnh cho CSP img-src của UI plugin: `https://host` hoặc `https://*.domain.tld` (ảnh đại diện trên CDN nhiều subdomain,
 * vd https://*.zadn.vn). Không đường dẫn / cổng / ký tự CSP; wildcard chỉ ở nhãn đầu và còn ít nhất 2 nhãn sau nó.
 */
export function isImageSource(v: unknown): v is string {
    return typeof v === 'string' && v.length <= 200
        && /^https:\/\/(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)
        && (!v.startsWith('https://*.') || v.slice('https://*.'.length).includes('.'));
}

function isHttpsUrl(v: string, allowLocalHttp = false): boolean {
    try {
        const u = new URL(v);
        if (u.username || u.password) return false;
        if (u.protocol === 'https:') return true;
        return allowLocalHttp && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    } catch {
        return false;
    }
}

function str(v: any, max: number): v is string {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

class Collector {
    errors: string[] = [];
    add(where: string, msg: string): void {
        if (this.errors.length < 50) this.errors.push(`${where}: ${msg}`);
    }
}

function checkFields(c: Collector, where: string, schema: any, allowWidgets: boolean): void {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { c.add(where, 'phải là object JSON Schema'); return; }
    if (schema.type !== undefined && schema.type !== 'object') c.add(`${where}.type`, 'chỉ hỗ trợ "object"');
    const props = schema.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) { c.add(`${where}.properties`, 'thiếu'); return; }
    const keys = Object.keys(props);
    if (keys.length > 50) c.add(`${where}.properties`, 'tối đa 50 trường');
    for (const key of keys) {
        const f = props[key];
        const fw = `${where}.properties.${key}`;
        if (!FIELD_KEY_RE.test(key)) c.add(fw, 'tên trường chỉ gồm chữ, số, _');
        if (!f || typeof f !== 'object') { c.add(fw, 'phải là object'); continue; }
        const types = allowWidgets ? ['string', 'number', 'integer', 'boolean', 'array'] : ['string', 'number', 'integer', 'boolean'];
        if (!types.includes(f.type)) c.add(`${fw}.type`, `phải là ${types.join(' | ')}`);
        if (f.type === 'array' && f.items?.type !== 'string') c.add(`${fw}.items`, 'chỉ hỗ trợ mảng chuỗi');
        if (f.enum !== undefined && (!Array.isArray(f.enum) || f.enum.length === 0 || f.enum.length > 100)) c.add(`${fw}.enum`, 'phải là mảng 1–100 giá trị');
        if (f.title !== undefined && !str(f.title, 100)) c.add(`${fw}.title`, 'tối đa 100 ký tự');
        if (f['x-widget'] !== undefined && (!allowWidgets || !(CONFIG_WIDGETS as readonly string[]).includes(f['x-widget']))) c.add(`${fw}.x-widget`, `chỉ ${CONFIG_WIDGETS.join(' | ')} (node workflow)`);
        if (f['x-widget'] === 'assistant' && f.type !== 'string') c.add(`${fw}.x-widget`, 'assistant chỉ dùng cho trường string (id trợ lý)');
    }
    if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || schema.required.some((k: any) => !keys.includes(k))) c.add(`${where}.required`, 'phải là tên trường có trong properties');
    }
}

function checkOutputs(c: Collector, where: string, outputs: any): void {
    if (outputs === undefined) return;
    if (!Array.isArray(outputs) || outputs.length > 50) { c.add(where, 'phải là mảng ≤ 50 phần tử'); return; }
    outputs.forEach((o, i) => {
        if (!o || !FIELD_KEY_RE.test(String(o.name || ''))) c.add(`${where}[${i}].name`, 'tên chỉ gồm chữ, số, _');
    });
}

/**
 * Kiểm tra manifest. `dir` (nếu có) dùng để kiểm tra file entry tồn tại;
 * `appVersion` để so minDeplaoVersion.
 */
export function validateManifest(raw: any, opts: { dir?: string; appVersion?: string } = {}): ManifestResult {
    const c = new Collector();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['deplao-plugin.json phải là một object JSON'] };

    if (!str(raw.id, 100) || !PLUGIN_ID_RE.test(raw.id)) c.add('id', 'dạng reverse-DNS chữ thường, vd "vn.acme.spa-booking"');
    else if (RESERVED_SHORT_NAMES.includes(pluginShortName(raw.id))) c.add('id', `phần cuối "${pluginShortName(raw.id)}" trùng tiền tố node có sẵn của Deplao, hãy đổi tên`);
    if (!str(raw.name, 80)) c.add('name', 'bắt buộc, tối đa 80 ký tự');
    if (!str(raw.version, 50) || !isValidSemver(raw.version)) c.add('version', 'phải là semver, vd "1.0.0"');
    if (raw.apiVersion !== PLUGIN_API_VERSION) c.add('apiVersion', `phải là ${PLUGIN_API_VERSION}`);
    if (raw.minDeplaoVersion !== undefined) {
        if (!isValidSemver(raw.minDeplaoVersion)) c.add('minDeplaoVersion', 'phải là semver');
        else if (opts.appVersion && isValidSemver(opts.appVersion) && compareSemver(opts.appVersion, raw.minDeplaoVersion) < 0) {
            c.add('minDeplaoVersion', `cần Deplao ${raw.minDeplaoVersion} trở lên (máy đang chạy ${opts.appVersion})`);
        }
    }
    if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) c.add('description', 'tối đa 500 ký tự');
    if (raw.author !== undefined && (typeof raw.author !== 'string' || raw.author.length > 100)) c.add('author', 'chuỗi tối đa 100 ký tự');
    if (raw.homepage !== undefined && !isHttpsUrl(raw.homepage)) c.add('homepage', 'phải là URL https');
    if (raw.icon !== undefined && !isSafeRelativePath(raw.icon)) c.add('icon', 'đường dẫn tương đối tới file ảnh trong plugin');

    const runtime: PluginRuntime = raw.runtime;
    if (!['web', 'local', 'remote'].includes(runtime)) c.add('runtime', 'phải là web | local | remote');

    // ── Quyền ──
    const perms: string[] = [];
    if (!Array.isArray(raw.permissions)) c.add('permissions', 'phải là mảng');
    else {
        if (raw.permissions.length > 60) c.add('permissions', 'tối đa 60 quyền');
        for (const p of raw.permissions) {
            const v = String(p);
            if (FORBIDDEN_PLUGIN_SCOPES.includes(v)) c.add('permissions', `plugin không được xin quyền "${v}"`);
            else if (!isApiScope(v) && !PLUGIN_PERMISSIONS.some(x => x.id === v)) c.add('permissions', `quyền không tồn tại: "${v}"`);
            else if (perms.includes(v)) c.add('permissions', `trùng "${v}"`);
            else perms.push(v);
        }
    }
    const has = (p: string) => perms.includes(p);
    // deplao.cloudflare chỉ có ở backend chạy trên máy (PluginApiBridge từ chối lời gọi từ UI).
    if (has('cloudflare:workers') && runtime !== 'local') c.add('permissions', 'quyền "cloudflare:workers" chỉ dùng với runtime local (deplao.cloudflare ở backend)');

    if (raw.accounts !== undefined && raw.accounts !== 'all') {
        if (!Array.isArray(raw.accounts) || raw.accounts.length > 200 || raw.accounts.some((a: any) => !str(a, 200))) c.add('accounts', '"all" hoặc mảng id tài khoản');
    }

    // ── UI / backend / remote ──
    let remoteOrigin = '';
    if (runtime === 'remote') {
        if (!raw.remote || !isHttpsUrl(raw.remote.baseUrl, true)) c.add('remote.baseUrl', 'bắt buộc với runtime remote, URL https (http://127.0.0.1 khi phát triển)');
        else remoteOrigin = new URL(raw.remote.baseUrl).origin;
        if (raw.backend !== undefined) c.add('backend', 'plugin remote không có backend chạy trên máy');
    } else if (raw.remote !== undefined) {
        c.add('remote', 'chỉ dùng với runtime remote');
    }
    if (runtime === 'local') {
        if (!raw.backend || !isSafeRelativePath(raw.backend.entry) || !/\.(c|m)?js$/.test(raw.backend.entry)) c.add('backend.entry', 'bắt buộc với runtime local, file .js tương đối');
    } else if (runtime === 'web' && raw.backend !== undefined) {
        c.add('backend', 'runtime web không có backend; dùng runtime local');
    }
    if (raw.ui !== undefined) {
        const entry = raw.ui?.entry;
        const remoteUi = runtime === 'remote' && typeof entry === 'string' && /^https?:/i.test(entry);
        if (remoteUi) {
            if (!isHttpsUrl(entry, true) || new URL(entry).origin !== remoteOrigin) c.add('ui.entry', 'URL UI của plugin remote phải cùng origin với remote.baseUrl');
        } else if (!isSafeRelativePath(entry) || !/\.html?$/.test(entry)) {
            c.add('ui.entry', 'file .html tương đối trong plugin');
        }
        if (raw.ui.connectSrc !== undefined) {
            if (!Array.isArray(raw.ui.connectSrc) || raw.ui.connectSrc.length > 10 || raw.ui.connectSrc.some((o: any) => !isHttpsUrl(String(o)))) c.add('ui.connectSrc', 'mảng tối đa 10 origin https');
            else if (!has('network')) c.add('ui.connectSrc', 'cần quyền "network"');
        }
        if (raw.ui.imgSrc !== undefined) {
            if (!Array.isArray(raw.ui.imgSrc) || raw.ui.imgSrc.length > 10 || raw.ui.imgSrc.some((o: any) => !isImageSource(o))) {
                c.add('ui.imgSrc', 'mảng tối đa 10 nguồn ảnh https://tên-miền hoặc https://*.tên-miền (không đường dẫn)');
            } else if (!has('network')) c.add('ui.imgSrc', 'cần quyền "network"');
        }
    }

    // ── Điểm mở rộng ──
    const contrib = raw.contributes;
    const short = typeof raw.id === 'string' ? pluginShortName(raw.id) : '';
    if (contrib !== undefined) {
        if (!contrib || typeof contrib !== 'object' || Array.isArray(contrib)) c.add('contributes', 'phải là object');
        else {
            const list = (key: string, max: number): any[] => {
                const v = contrib[key];
                if (v === undefined) return [];
                if (!Array.isArray(v) || v.length > max) { c.add(`contributes.${key}`, `mảng tối đa ${max} phần tử`); return []; }
                return v;
            };
            const uniq = (where: string, values: string[]) => {
                const seen = new Set<string>();
                for (const v of values) {
                    if (seen.has(v)) c.add(where, `trùng "${v}"`);
                    seen.add(v);
                }
            };

            const pages = list('pages', 10);
            if (pages.length) {
                if (!has('ui:pages')) c.add('contributes.pages', 'cần quyền "ui:pages"');
                if (!raw.ui) c.add('contributes.pages', 'cần ui.entry');
            }
            pages.forEach((p, i) => {
                if (!CONTRIB_ID_RE.test(String(p?.id || ''))) c.add(`contributes.pages[${i}].id`, 'chữ thường, số, "-" (≤ 40)');
                if (!str(p?.title, 40)) c.add(`contributes.pages[${i}].title`, 'bắt buộc, ≤ 40 ký tự');
                if (typeof p?.path !== 'string' || p.path.length > 200) c.add(`contributes.pages[${i}].path`, 'hash route, vd "/"');
            });
            uniq('contributes.pages', pages.map(p => String(p?.id)));

            const panels = list('chatPanels', 5);
            if (panels.length) {
                if (!has('ui:chat-panel')) c.add('contributes.chatPanels', 'cần quyền "ui:chat-panel"');
                if (!raw.ui) c.add('contributes.chatPanels', 'cần ui.entry');
            }
            panels.forEach((p, i) => {
                if (!CONTRIB_ID_RE.test(String(p?.id || ''))) c.add(`contributes.chatPanels[${i}].id`, 'chữ thường, số, "-"');
                if (!str(p?.title, 40)) c.add(`contributes.chatPanels[${i}].title`, 'bắt buộc, ≤ 40 ký tự');
                if (typeof p?.path !== 'string' || p.path.length > 200) c.add(`contributes.chatPanels[${i}].path`, 'hash route');
                if (p?.width !== undefined && (!Number.isInteger(p.width) || p.width < 200 || p.width > 600)) c.add(`contributes.chatPanels[${i}].width`, '200–600');
            });
            uniq('contributes.chatPanels', panels.map(p => String(p?.id)));

            const buttons = list('composerButtons', 5);
            if (buttons.length && !has('ui:composer')) c.add('contributes.composerButtons', 'cần quyền "ui:composer"');
            buttons.forEach((b, i) => {
                if (!CONTRIB_ID_RE.test(String(b?.id || ''))) c.add(`contributes.composerButtons[${i}].id`, 'chữ thường, số, "-"');
                if (!str(b?.title, 40)) c.add(`contributes.composerButtons[${i}].title`, 'bắt buộc, ≤ 40 ký tự');
                if (b?.target !== 'ui' && b?.target !== 'backend') c.add(`contributes.composerButtons[${i}].target`, 'ui | backend');
                if (b?.target === 'backend' && runtime === 'web') c.add(`contributes.composerButtons[${i}].target`, 'runtime web không có backend');
                if (b?.target === 'ui' && !raw.ui) c.add(`contributes.composerButtons[${i}]`, 'target ui cần ui.entry');
            });
            uniq('contributes.composerButtons', buttons.map(b => String(b?.id)));

            if (contrib.settings !== undefined) checkFields(c, 'contributes.settings.schema', contrib.settings?.schema, false);

            const nodes = list('workflowNodes', 50);
            const triggers = list('triggers', 20);
            if ((nodes.length || triggers.length) && !has('workflow:nodes')) c.add('contributes.workflowNodes', 'cần quyền "workflow:nodes"');
            if (nodes.length && runtime === 'web') c.add('contributes.workflowNodes', 'node workflow cần runtime local hoặc remote');
            // Quy ước của editor workflow: trigger có ".trigger." trong type (vd tgbot.trigger.message).
            const nodeTypeOk = (t: any) => typeof t === 'string' && t.startsWith(`${short}.`) && !t.includes('.trigger.') && NODE_SUFFIX_RE.test(t.slice(short.length + 1));
            const triggerTypeOk = (t: any) => typeof t === 'string' && t.startsWith(`${short}.trigger.`) && NODE_SUFFIX_RE.test(t.slice(short.length + 9));
            nodes.forEach((n, i) => {
                if (!nodeTypeOk(n?.type)) c.add(`contributes.workflowNodes[${i}].type`, `phải bắt đầu bằng "${short}." và không chứa ".trigger."`);
                if (!str(n?.label, 60)) c.add(`contributes.workflowNodes[${i}].label`, 'bắt buộc, ≤ 60 ký tự');
                if (n?.configSchema !== undefined) checkFields(c, `contributes.workflowNodes[${i}].configSchema`, n.configSchema, true);
                checkOutputs(c, `contributes.workflowNodes[${i}].outputs`, n?.outputs);
            });
            triggers.forEach((t, i) => {
                if (!triggerTypeOk(t?.type)) c.add(`contributes.triggers[${i}].type`, `phải có dạng "${short}.trigger.<tên>"`);
                if (!str(t?.label, 60)) c.add(`contributes.triggers[${i}].label`, 'bắt buộc, ≤ 60 ký tự');
                if (t?.configSchema !== undefined) checkFields(c, `contributes.triggers[${i}].configSchema`, t.configSchema, true);
                checkOutputs(c, `contributes.triggers[${i}].outputs`, t?.outputs);
            });
            uniq('contributes.workflowNodes/triggers', [...nodes, ...triggers].map(n => String(n?.type)));

            const routes = list('routes', 50);
            if (routes.length && runtime === 'web') c.add('contributes.routes', 'route cần runtime local hoặc remote');
            routes.forEach((r, i) => {
                if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r?.method)) c.add(`contributes.routes[${i}].method`, 'GET | POST | PUT | PATCH | DELETE');
                if (typeof r?.path !== 'string' || !ROUTE_PATH_RE.test(r.path) || r.path.split('/').includes('..')) c.add(`contributes.routes[${i}].path`, 'bắt đầu bằng "/", chỉ chữ, số, - _ . / :');
                if (r?.scope !== undefined && r.scope !== 'any' && !isApiScope(String(r.scope))) c.add(`contributes.routes[${i}].scope`, 'scope API hợp lệ hoặc "any"');
            });
            uniq('contributes.routes', routes.map(r => `${r?.method} ${r?.path}`));

            const schedules = list('schedules', 10);
            if (schedules.length) {
                if (!has('schedules')) c.add('contributes.schedules', 'cần quyền "schedules"');
                if (runtime === 'web') c.add('contributes.schedules', 'lịch chạy cần runtime local hoặc remote');
            }
            schedules.forEach((s, i) => {
                if (!CONTRIB_ID_RE.test(String(s?.id || ''))) c.add(`contributes.schedules[${i}].id`, 'chữ thường, số, "-"');
                const fields = typeof s?.cron === 'string' ? s.cron.trim().split(/\s+/).length : 0;
                if (fields < 5 || fields > 6) c.add(`contributes.schedules[${i}].cron`, 'biểu thức cron 5 hoặc 6 trường');
                if (!HANDLER_RE.test(String(s?.handler || ''))) c.add(`contributes.schedules[${i}].handler`, 'tên hàm trong handlers của backend');
            });
            uniq('contributes.schedules', schedules.map(s => String(s?.id)));

            const events = list('events', 50);
            if (events.length && !has('events:emit')) c.add('contributes.events', 'cần quyền "events:emit"');
            events.forEach((e, i) => {
                if (!EVENT_NAME_RE.test(String(e))) c.add(`contributes.events[${i}]`, 'chữ thường, số, _ . -');
            });
        }
    }

    // ── File tồn tại ──
    if (opts.dir && !c.errors.length) {
        const mustExist: Array<[string, string | undefined]> = [
            ['backend.entry', raw.backend?.entry],
            ['icon', raw.icon],
        ];
        if (raw.ui?.entry && !/^https?:/i.test(raw.ui.entry)) mustExist.push(['ui.entry', raw.ui.entry]);
        for (const [where, rel] of mustExist) {
            if (!rel) continue;
            const full = path.resolve(opts.dir, ...rel.split('/'));
            if (!full.startsWith(path.resolve(opts.dir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
                c.add(where, `không tìm thấy file "${rel}" trong plugin`);
            }
        }
    }

    if (c.errors.length) return { ok: false, errors: c.errors };
    return { ok: true, manifest: raw as PluginManifest };
}

/** Đọc + kiểm tra manifest trong thư mục plugin. */
export function readManifest(dir: string, appVersion?: string): ManifestResult {
    const file = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(file)) return { ok: false, errors: [`Không có ${MANIFEST_FILE} trong thư mục plugin`] };
    const st = fs.statSync(file);
    if (st.size > MAX_MANIFEST_BYTES) return { ok: false, errors: [`${MANIFEST_FILE} quá lớn`] };
    let raw: any;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err: any) {
        return { ok: false, errors: [`${MANIFEST_FILE} không phải JSON hợp lệ: ${err?.message || err}`] };
    }
    return validateManifest(raw, { dir, appVersion });
}

export interface PermissionInfo {
    id: string;
    label: string;
    group: string;
    risky: boolean;
}

/** Danh sách quyền dịch sang câu tiếng Việt cho màn duyệt cài đặt. */
export function describePermissions(permissions: string[]): PermissionInfo[] {
    return permissions.map(id => {
        const scope = API_SCOPES.find(s => s.id === id);
        if (scope) return { id, label: scope.label, group: scope.group, risky: RISKY.has(id) };
        const p = PLUGIN_PERMISSIONS.find(x => x.id === id);
        return { id, label: p?.label || id, group: 'Plugin', risky: RISKY.has(id) };
    });
}

/** Scope API trong danh sách quyền đã duyệt (bỏ quyền riêng của plugin). */
export function apiScopesOf(permissions: string[]): ApiScope[] {
    return permissions.filter(p => isApiScope(p) && !FORBIDDEN_PLUGIN_SCOPES.includes(p)) as ApiScope[];
}

export function hasPluginPermission(permissions: string[], p: PluginPermission): boolean {
    return permissions.includes(p);
}
