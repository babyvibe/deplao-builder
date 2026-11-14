/**
 * manifest.ts: reads and checks deplao-plugin.json.
 *
 * Hand-written checks (not zod) so it can return easy-to-understand Vietnamese error messages, collect several errors in one pass,
 * and apply the cross-rules: permissions ↔ extension points, runtime ↔ backend, node type prefixes...
 */
import * as fs from 'fs';
import * as path from 'path';
import { API_SCOPES, ApiScope, isApiScope } from '../api/types';
import { compareSemver, isValidSemver } from './semver';
import { tr } from '../../shared/i18n';

export const PLUGIN_API_VERSION = 1;
export const MANIFEST_FILE = 'deplao-plugin.json';
const MAX_MANIFEST_BYTES = 256 * 1024;

export type PluginRuntime = 'web' | 'local' | 'remote';

export type PluginPermission =
    | 'storage' | 'ui:pages' | 'ui:chat-panel' | 'ui:composer' | 'ui:microphone'
    | 'workflow:nodes' | 'events:emit' | 'network' | 'schedules'
    | 'cloudflare:workers';

export const PLUGIN_PERMISSIONS: ReadonlyArray<{ id: PluginPermission; label: string }> = [
    { id: 'storage', label: tr('Lưu dữ liệu riêng của ứng dụng trên máy này') },
    { id: 'ui:pages', label: tr('Thêm trang riêng trong Deplao') },
    { id: 'ui:chat-panel', label: tr('Hiện panel trong màn hình chat và biết bạn đang mở hội thoại nào') },
    { id: 'ui:composer', label: tr('Thêm nút vào ô soạn tin nhắn') },
    // The app's UI frame is given allow="microphone" (PluginFrame): without this permission the browser blocks the microphone.
    { id: 'ui:microphone', label: tr('Dùng micro trong giao diện ứng dụng (ghi âm khi bạn bấm nút ghi âm)') },
    { id: 'workflow:nodes', label: tr('Thêm node và trigger vào Workflow') },
    { id: 'events:emit', label: tr('Phát sự kiện cho Workflow, webhook và hệ thống khác') },
    { id: 'network', label: tr('Kết nối Internet') },
    { id: 'schedules', label: tr('Chạy định kỳ khi Deplao đang mở') },
    // deplao.cloudflare (backend only): the Cloudflare token is not given to the app; resource names = the pluginShortName prefix.
    { id: 'cloudflare:workers', label: tr('Triển khai Worker và cơ sở dữ liệu D1 lên tài khoản Cloudflare đã kết nối trong Deplao (chỉ tài nguyên mang tên của ứng dụng này), gắn tên miền con cho Worker đó khi bạn đồng ý') },
];

/** Scopes a plugin may not request (self-granting permissions / machine administration). */
export const FORBIDDEN_PLUGIN_SCOPES: readonly string[] = ['admin', 'plugins:manage', 'employees:manage', 'settings:write'];

/** Deplao's built-in node prefixes: the last part of the plugin id must not match one (to avoid overriding built-in nodes). */
export const RESERVED_SHORT_NAMES: readonly string[] = [
    'trigger', 'action', 'logic', 'output', 'data', 'ai', 'notify', 'sheets', 'payment', 'integration', 'crm', 'erp',
    'zalo', 'fb', 'facebook', 'tg', 'tgbot', 'telegram', 'workflow', 'api', 'plugin', 'plugins', 'system', 'deplao',
    'ghn', 'ghtk', 'sapo', 'pancake', 'nhanh', 'kiotviet', 'haravan', 'casso', 'sepay', 'viettelpost', 'jt',
];

/** "nhạy cảm" (sensitive) scope: highlighted in red on the permission approval screen. */
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
    /** Stored encrypted, never shown again in the UI. */
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
    /** Input field with workflow {{ ... }} variable suggestions. */
    'x-template'?: boolean;
    'x-multiline'?: boolean;
    /** Uses a built-in app picker (assistant = pick a Deplao AI assistant, saves its id; empty = the app decides). */
    'x-widget'?: 'account' | 'thread' | 'label' | 'assistant';
}

/** Built-in pickers available in the app's workflow node configuration form. */
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
    /** Scope the caller must have; default 'any' (any valid key). */
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

/** Last part of the id: "vn.acme.spa" → "spa". Node / trigger types must start with "spa.". */
export function pluginShortName(id: string): string {
    const parts = String(id).split('.');
    return parts[parts.length - 1];
}

/** A safe relative path inside the plugin folder. */
export function isSafeRelativePath(p: string): boolean {
    if (typeof p !== 'string' || !p || p.length > 200) return false;
    if (p.includes('\\') || p.includes('\0') || p.includes(':')) return false;
    if (p.startsWith('/')) return false;
    return p.split('/').every(seg => seg !== '..');
}

/**
 * Image source for the plugin UI's CSP img-src: `https://host` or `https://*.domain.tld` (avatars on a CDN with many subdomains,
 * e.g. https://*.zadn.vn). No path / port / CSP characters; the wildcard is only allowed in the first label and there must be at least 2 labels after it.
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
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { c.add(where, tr('phải là object JSON Schema')); return; }
    if (schema.type !== undefined && schema.type !== 'object') c.add(`${where}.type`, tr('chỉ hỗ trợ "object"'));
    const props = schema.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) { c.add(`${where}.properties`, tr('thiếu')); return; }
    const keys = Object.keys(props);
    if (keys.length > 50) c.add(`${where}.properties`, tr('tối đa 50 trường'));
    for (const key of keys) {
        const f = props[key];
        const fw = `${where}.properties.${key}`;
        if (!FIELD_KEY_RE.test(key)) c.add(fw, tr('tên trường chỉ gồm chữ, số, _'));
        if (!f || typeof f !== 'object') { c.add(fw, tr('phải là object')); continue; }
        const types = allowWidgets ? ['string', 'number', 'integer', 'boolean', 'array'] : ['string', 'number', 'integer', 'boolean'];
        if (!types.includes(f.type)) c.add(`${fw}.type`, tr('phải là {{v1}}', { v1: types.join(' | ') }));
        if (f.type === 'array' && f.items?.type !== 'string') c.add(`${fw}.items`, tr('chỉ hỗ trợ mảng chuỗi'));
        if (f.enum !== undefined && (!Array.isArray(f.enum) || f.enum.length === 0 || f.enum.length > 100)) c.add(`${fw}.enum`, tr('phải là mảng 1–100 giá trị'));
        if (f.title !== undefined && !str(f.title, 100)) c.add(`${fw}.title`, tr('tối đa 100 ký tự'));
        if (f['x-widget'] !== undefined && (!allowWidgets || !(CONFIG_WIDGETS as readonly string[]).includes(f['x-widget']))) c.add(`${fw}.x-widget`, tr('chỉ {{v1}} (node workflow)', { v1: CONFIG_WIDGETS.join(' | ') }));
        if (f['x-widget'] === 'assistant' && f.type !== 'string') c.add(`${fw}.x-widget`, tr('assistant chỉ dùng cho trường string (id trợ lý)'));
    }
    if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || schema.required.some((k: any) => !keys.includes(k))) c.add(`${where}.required`, tr('phải là tên trường có trong properties'));
    }
}

function checkOutputs(c: Collector, where: string, outputs: any): void {
    if (outputs === undefined) return;
    if (!Array.isArray(outputs) || outputs.length > 50) { c.add(where, tr('phải là mảng ≤ 50 phần tử')); return; }
    outputs.forEach((o, i) => {
        if (!o || !FIELD_KEY_RE.test(String(o.name || ''))) c.add(`${where}[${i}].name`, tr('tên chỉ gồm chữ, số, _'));
    });
}

/**
 * Checks the manifest. `dir` (if given) is used to check that the entry file exists;
 * `appVersion` is compared with minDeplaoVersion.
 */
export function validateManifest(raw: any, opts: { dir?: string; appVersion?: string } = {}): ManifestResult {
    const c = new Collector();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: [tr('deplao-plugin.json phải là một object JSON')] };

    if (!str(raw.id, 100) || !PLUGIN_ID_RE.test(raw.id)) c.add('id', tr('dạng reverse-DNS chữ thường, vd "vn.acme.spa-booking"'));
    else if (RESERVED_SHORT_NAMES.includes(pluginShortName(raw.id))) c.add('id', tr('phần cuối "{{v1}}" trùng tiền tố node có sẵn của Deplao, hãy đổi tên', { v1: pluginShortName(raw.id) }));
    if (!str(raw.name, 80)) c.add('name', tr('bắt buộc, tối đa 80 ký tự'));
    if (!str(raw.version, 50) || !isValidSemver(raw.version)) c.add('version', tr('phải là semver, vd "1.0.0"'));
    if (raw.apiVersion !== PLUGIN_API_VERSION) c.add('apiVersion', tr('phải là {{PLUGIN_API_VERSION}}', { PLUGIN_API_VERSION }));
    if (raw.minDeplaoVersion !== undefined) {
        if (!isValidSemver(raw.minDeplaoVersion)) c.add('minDeplaoVersion', tr('phải là semver'));
        else if (opts.appVersion && isValidSemver(opts.appVersion) && compareSemver(opts.appVersion, raw.minDeplaoVersion) < 0) {
            c.add('minDeplaoVersion', tr('cần Deplao {{minDeplaoVersion}} trở lên (máy đang chạy {{appVersion}})', { minDeplaoVersion: raw.minDeplaoVersion, appVersion: opts.appVersion }));
        }
    }
    if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) c.add('description', tr('tối đa 500 ký tự'));
    if (raw.author !== undefined && (typeof raw.author !== 'string' || raw.author.length > 100)) c.add('author', tr('chuỗi tối đa 100 ký tự'));
    if (raw.homepage !== undefined && !isHttpsUrl(raw.homepage)) c.add('homepage', tr('phải là URL https'));
    if (raw.icon !== undefined && !isSafeRelativePath(raw.icon)) c.add('icon', tr('đường dẫn tương đối tới file ảnh trong plugin'));

    const runtime: PluginRuntime = raw.runtime;
    if (!['web', 'local', 'remote'].includes(runtime)) c.add('runtime', tr('phải là web | local | remote'));

    // ── Permissions ──
    const perms: string[] = [];
    if (!Array.isArray(raw.permissions)) c.add('permissions', tr('phải là mảng'));
    else {
        if (raw.permissions.length > 60) c.add('permissions', tr('tối đa 60 quyền'));
        for (const p of raw.permissions) {
            const v = String(p);
            if (FORBIDDEN_PLUGIN_SCOPES.includes(v)) c.add('permissions', tr('plugin không được xin quyền "{{v}}"', { v }));
            else if (!isApiScope(v) && !PLUGIN_PERMISSIONS.some(x => x.id === v)) c.add('permissions', tr('quyền không tồn tại: "{{v}}"', { v }));
            else if (perms.includes(v)) c.add('permissions', tr('trùng "{{v}}"', { v }));
            else perms.push(v);
        }
    }
    const has = (p: string) => perms.includes(p);
    // deplao.cloudflare exists only in the backend running on the machine (PluginApiBridge rejects calls from the UI).
    if (has('cloudflare:workers') && runtime !== 'local') c.add('permissions', tr('quyền "cloudflare:workers" chỉ dùng với runtime local (deplao.cloudflare ở backend)'));

    if (raw.accounts !== undefined && raw.accounts !== 'all') {
        if (!Array.isArray(raw.accounts) || raw.accounts.length > 200 || raw.accounts.some((a: any) => !str(a, 200))) c.add('accounts', tr('"all" hoặc mảng id tài khoản'));
    }

    // ── UI / backend / remote ──
    let remoteOrigin = '';
    if (runtime === 'remote') {
        if (!raw.remote || !isHttpsUrl(raw.remote.baseUrl, true)) c.add('remote.baseUrl', tr('bắt buộc với runtime remote, URL https (http://127.0.0.1 khi phát triển)'));
        else remoteOrigin = new URL(raw.remote.baseUrl).origin;
        if (raw.backend !== undefined) c.add('backend', tr('plugin remote không có backend chạy trên máy'));
    } else if (raw.remote !== undefined) {
        c.add('remote', tr('chỉ dùng với runtime remote'));
    }
    if (runtime === 'local') {
        if (!raw.backend || !isSafeRelativePath(raw.backend.entry) || !/\.(c|m)?js$/.test(raw.backend.entry)) c.add('backend.entry', tr('bắt buộc với runtime local, file .js tương đối'));
    } else if (runtime === 'web' && raw.backend !== undefined) {
        c.add('backend', tr('runtime web không có backend; dùng runtime local'));
    }
    if (raw.ui !== undefined) {
        const entry = raw.ui?.entry;
        const remoteUi = runtime === 'remote' && typeof entry === 'string' && /^https?:/i.test(entry);
        if (remoteUi) {
            if (!isHttpsUrl(entry, true) || new URL(entry).origin !== remoteOrigin) c.add('ui.entry', tr('URL UI của plugin remote phải cùng origin với remote.baseUrl'));
        } else if (!isSafeRelativePath(entry) || !/\.html?$/.test(entry)) {
            c.add('ui.entry', tr('file .html tương đối trong plugin'));
        }
        if (raw.ui.connectSrc !== undefined) {
            if (!Array.isArray(raw.ui.connectSrc) || raw.ui.connectSrc.length > 10 || raw.ui.connectSrc.some((o: any) => !isHttpsUrl(String(o)))) c.add('ui.connectSrc', tr('mảng tối đa 10 origin https'));
            else if (!has('network')) c.add('ui.connectSrc', tr('cần quyền "network"'));
        }
        if (raw.ui.imgSrc !== undefined) {
            if (!Array.isArray(raw.ui.imgSrc) || raw.ui.imgSrc.length > 10 || raw.ui.imgSrc.some((o: any) => !isImageSource(o))) {
                c.add('ui.imgSrc', tr('mảng tối đa 10 nguồn ảnh https://tên-miền hoặc https://*.tên-miền (không đường dẫn)'));
            } else if (!has('network')) c.add('ui.imgSrc', tr('cần quyền "network"'));
        }
    }

    // ── Extension points ──
    const contrib = raw.contributes;
    const short = typeof raw.id === 'string' ? pluginShortName(raw.id) : '';
    if (contrib !== undefined) {
        if (!contrib || typeof contrib !== 'object' || Array.isArray(contrib)) c.add('contributes', tr('phải là object'));
        else {
            const list = (key: string, max: number): any[] => {
                const v = contrib[key];
                if (v === undefined) return [];
                if (!Array.isArray(v) || v.length > max) { c.add(`contributes.${key}`, tr('mảng tối đa {{max}} phần tử', { max })); return []; }
                return v;
            };
            const uniq = (where: string, values: string[]) => {
                const seen = new Set<string>();
                for (const v of values) {
                    if (seen.has(v)) c.add(where, tr('trùng "{{v}}"', { v }));
                    seen.add(v);
                }
            };

            const pages = list('pages', 10);
            if (pages.length) {
                if (!has('ui:pages')) c.add('contributes.pages', tr('cần quyền "ui:pages"'));
                if (!raw.ui) c.add('contributes.pages', tr('cần ui.entry'));
            }
            pages.forEach((p, i) => {
                if (!CONTRIB_ID_RE.test(String(p?.id || ''))) c.add(`contributes.pages[${i}].id`, tr('chữ thường, số, "-" (≤ 40)'));
                if (!str(p?.title, 40)) c.add(`contributes.pages[${i}].title`, tr('bắt buộc, ≤ 40 ký tự'));
                if (typeof p?.path !== 'string' || p.path.length > 200) c.add(`contributes.pages[${i}].path`, 'hash route, vd "/"');
            });
            uniq('contributes.pages', pages.map(p => String(p?.id)));

            const panels = list('chatPanels', 5);
            if (panels.length) {
                if (!has('ui:chat-panel')) c.add('contributes.chatPanels', tr('cần quyền "ui:chat-panel"'));
                if (!raw.ui) c.add('contributes.chatPanels', tr('cần ui.entry'));
            }
            panels.forEach((p, i) => {
                if (!CONTRIB_ID_RE.test(String(p?.id || ''))) c.add(`contributes.chatPanels[${i}].id`, tr('chữ thường, số, "-"'));
                if (!str(p?.title, 40)) c.add(`contributes.chatPanels[${i}].title`, tr('bắt buộc, ≤ 40 ký tự'));
                if (typeof p?.path !== 'string' || p.path.length > 200) c.add(`contributes.chatPanels[${i}].path`, 'hash route');
                if (p?.width !== undefined && (!Number.isInteger(p.width) || p.width < 200 || p.width > 600)) c.add(`contributes.chatPanels[${i}].width`, '200–600');
            });
            uniq('contributes.chatPanels', panels.map(p => String(p?.id)));

            const buttons = list('composerButtons', 5);
            if (buttons.length && !has('ui:composer')) c.add('contributes.composerButtons', tr('cần quyền "ui:composer"'));
            buttons.forEach((b, i) => {
                if (!CONTRIB_ID_RE.test(String(b?.id || ''))) c.add(`contributes.composerButtons[${i}].id`, tr('chữ thường, số, "-"'));
                if (!str(b?.title, 40)) c.add(`contributes.composerButtons[${i}].title`, tr('bắt buộc, ≤ 40 ký tự'));
                if (b?.target !== 'ui' && b?.target !== 'backend') c.add(`contributes.composerButtons[${i}].target`, 'ui | backend');
                if (b?.target === 'backend' && runtime === 'web') c.add(`contributes.composerButtons[${i}].target`, tr('runtime web không có backend'));
                if (b?.target === 'ui' && !raw.ui) c.add(`contributes.composerButtons[${i}]`, tr('target ui cần ui.entry'));
            });
            uniq('contributes.composerButtons', buttons.map(b => String(b?.id)));

            if (contrib.settings !== undefined) checkFields(c, 'contributes.settings.schema', contrib.settings?.schema, false);

            const nodes = list('workflowNodes', 50);
            const triggers = list('triggers', 20);
            if ((nodes.length || triggers.length) && !has('workflow:nodes')) c.add('contributes.workflowNodes', tr('cần quyền "workflow:nodes"'));
            if (nodes.length && runtime === 'web') c.add('contributes.workflowNodes', tr('node workflow cần runtime local hoặc remote'));
            // Workflow editor convention: a trigger has ".trigger." in its type (e.g. tgbot.trigger.message).
            const nodeTypeOk = (t: any) => typeof t === 'string' && t.startsWith(`${short}.`) && !t.includes('.trigger.') && NODE_SUFFIX_RE.test(t.slice(short.length + 1));
            const triggerTypeOk = (t: any) => typeof t === 'string' && t.startsWith(`${short}.trigger.`) && NODE_SUFFIX_RE.test(t.slice(short.length + 9));
            nodes.forEach((n, i) => {
                if (!nodeTypeOk(n?.type)) c.add(`contributes.workflowNodes[${i}].type`, tr('phải bắt đầu bằng "{{short}}." và không chứa ".trigger."', { short }));
                if (!str(n?.label, 60)) c.add(`contributes.workflowNodes[${i}].label`, tr('bắt buộc, ≤ 60 ký tự'));
                if (n?.configSchema !== undefined) checkFields(c, `contributes.workflowNodes[${i}].configSchema`, n.configSchema, true);
                checkOutputs(c, `contributes.workflowNodes[${i}].outputs`, n?.outputs);
            });
            triggers.forEach((t, i) => {
                if (!triggerTypeOk(t?.type)) c.add(`contributes.triggers[${i}].type`, tr('phải có dạng "{{short}}.trigger.<tên>"', { short }));
                if (!str(t?.label, 60)) c.add(`contributes.triggers[${i}].label`, tr('bắt buộc, ≤ 60 ký tự'));
                if (t?.configSchema !== undefined) checkFields(c, `contributes.triggers[${i}].configSchema`, t.configSchema, true);
                checkOutputs(c, `contributes.triggers[${i}].outputs`, t?.outputs);
            });
            uniq('contributes.workflowNodes/triggers', [...nodes, ...triggers].map(n => String(n?.type)));

            const routes = list('routes', 50);
            if (routes.length && runtime === 'web') c.add('contributes.routes', tr('route cần runtime local hoặc remote'));
            routes.forEach((r, i) => {
                if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r?.method)) c.add(`contributes.routes[${i}].method`, 'GET | POST | PUT | PATCH | DELETE');
                if (typeof r?.path !== 'string' || !ROUTE_PATH_RE.test(r.path) || r.path.split('/').includes('..')) c.add(`contributes.routes[${i}].path`, tr('bắt đầu bằng "/", chỉ chữ, số, - _ . / :'));
                if (r?.scope !== undefined && r.scope !== 'any' && !isApiScope(String(r.scope))) c.add(`contributes.routes[${i}].scope`, tr('scope API hợp lệ hoặc "any"'));
            });
            uniq('contributes.routes', routes.map(r => `${r?.method} ${r?.path}`));

            const schedules = list('schedules', 10);
            if (schedules.length) {
                if (!has('schedules')) c.add('contributes.schedules', tr('cần quyền "schedules"'));
                if (runtime === 'web') c.add('contributes.schedules', tr('lịch chạy cần runtime local hoặc remote'));
            }
            schedules.forEach((s, i) => {
                if (!CONTRIB_ID_RE.test(String(s?.id || ''))) c.add(`contributes.schedules[${i}].id`, tr('chữ thường, số, "-"'));
                const fields = typeof s?.cron === 'string' ? s.cron.trim().split(/\s+/).length : 0;
                if (fields < 5 || fields > 6) c.add(`contributes.schedules[${i}].cron`, tr('biểu thức cron 5 hoặc 6 trường'));
                if (!HANDLER_RE.test(String(s?.handler || ''))) c.add(`contributes.schedules[${i}].handler`, tr('tên hàm trong handlers của backend'));
            });
            uniq('contributes.schedules', schedules.map(s => String(s?.id)));

            const events = list('events', 50);
            if (events.length && !has('events:emit')) c.add('contributes.events', tr('cần quyền "events:emit"'));
            events.forEach((e, i) => {
                if (!EVENT_NAME_RE.test(String(e))) c.add(`contributes.events[${i}]`, tr('chữ thường, số, _ . -'));
            });
        }
    }

    // ── Files exist ──
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
                c.add(where, tr('không tìm thấy file "{{rel}}" trong plugin', { rel }));
            }
        }
    }

    if (c.errors.length) return { ok: false, errors: c.errors };
    return { ok: true, manifest: raw as PluginManifest };
}

/** Reads + checks the manifest in the plugin folder. */
export function readManifest(dir: string, appVersion?: string): ManifestResult {
    const file = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(file)) return { ok: false, errors: [tr('Không có {{MANIFEST_FILE}} trong thư mục plugin', { MANIFEST_FILE })] };
    const st = fs.statSync(file);
    if (st.size > MAX_MANIFEST_BYTES) return { ok: false, errors: [tr('{{MANIFEST_FILE}} quá lớn', { MANIFEST_FILE })] };
    let raw: any;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err: any) {
        return { ok: false, errors: [tr('{{MANIFEST_FILE}} không phải JSON hợp lệ: {{v1}}', { MANIFEST_FILE, v1: err?.message || err })] };
    }
    return validateManifest(raw, { dir, appVersion });
}

export interface PermissionInfo {
    id: string;
    label: string;
    group: string;
    risky: boolean;
}

/** Turns the permission list into Vietnamese sentences for the install approval screen. */
export function describePermissions(permissions: string[]): PermissionInfo[] {
    return permissions.map(id => {
        const scope = API_SCOPES.find(s => s.id === id);
        if (scope) return { id, label: scope.label, group: scope.group, risky: RISKY.has(id) };
        const p = PLUGIN_PERMISSIONS.find(x => x.id === id);
        return { id, label: p?.label || id, group: 'Plugin', risky: RISKY.has(id) };
    });
}

/** API scopes in the approved permission list (drops the plugin's own permissions). */
export function apiScopesOf(permissions: string[]): ApiScope[] {
    return permissions.filter(p => isApiScope(p) && !FORBIDDEN_PLUGIN_SCOPES.includes(p)) as ApiScope[];
}

export function hasPluginPermission(permissions: string[], p: PluginPermission): boolean {
    return permissions.includes(p);
}
