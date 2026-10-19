/**
 * build.ts — dựng OpenAPI 3.1 từ chính RouteDef đã đăng ký (docs không thể lệch code).
 */
import { API_SCOPES, ERROR_CODES, RouteDef } from '../types';
import { GUIDES, TAG_DESCRIPTIONS, OVERVIEW_MARKDOWN } from './guides';

export interface BuildOptions {
    version: string;
    servers?: string[];
}

interface ListedRoute {
    def: RouteDef;
    operationId: string;
    template: string;
}

const ERROR_RESPONSE_CODES: Array<[string, string]> = [
    ['400', 'Tham số không hợp lệ (VALIDATION_ERROR, INVALID_JSON)'],
    ['401', 'Thiếu hoặc sai API key (UNAUTHORIZED)'],
    ['403', 'Thiếu scope / không được cấp tài khoản / IP bị chặn'],
    ['404', 'Không tìm thấy (NOT_FOUND)'],
    ['409', 'Tài khoản chưa kết nối (ACCOUNT_OFFLINE) hoặc xung đột'],
    ['422', 'Kênh không hỗ trợ thao tác (CHANNEL_UNSUPPORTED)'],
    ['429', 'Vượt giới hạn tốc độ bạn đã đặt (RATE_LIMITED)'],
    ['502', 'Zalo/Facebook/Telegram trả lỗi (UPSTREAM_ERROR)'],
    ['503', 'API đang tắt hoặc workspace không khả dụng'],
];

function pathParameters(def: RouteDef, template: string): any[] {
    const keys = Array.from(template.matchAll(/\{([^}]+)\}/g)).map(m => m[1]);
    const shape: Record<string, any> = (def.params as any)?.shape || {};
    return keys.map(key => {
        const schemaKey = key === 'path' ? '*' : key;
        const sch = shape[schemaKey];
        const json = sch ? sch.toJSONSchema() : { type: 'string' };
        const description = json.description;
        delete json.description;
        return { name: key, in: 'path', required: true, schema: json, ...(description ? { description } : {}) };
    });
}

function queryParameters(def: RouteDef): any[] {
    const shape: Record<string, any> = (def.query as any)?.shape || {};
    return Object.entries(shape).map(([name, sch]) => {
        const json = sch.toJSONSchema();
        const description = json.description;
        delete json.description;
        return { name, in: 'query', required: !sch._optional, schema: json, ...(description ? { description } : {}) };
    });
}

function successSchema(def: RouteDef): any {
    const data = def.response ? def.response.toJSONSchema() : {};
    return {
        type: 'object',
        required: ['success', 'data', 'request_id'],
        properties: {
            success: { type: 'boolean', const: true },
            data,
            pagination: { $ref: '#/components/schemas/Pagination' },
            request_id: { type: 'string' },
        },
    };
}

function describe(def: RouteDef): string {
    const parts: string[] = [];
    if (def.description) parts.push(def.description);
    if (def.scope === null) parts.push('**Không cần API key.**');
    else if (def.scope === 'any') parts.push('**Cần API key** (scope bất kỳ).');
    else parts.push(`**Scope:** \`${def.scope}\``);
    return parts.join('\n\n');
}

export function buildOpenApi(routes: ListedRoute[], opts: BuildOptions): any {
    const paths: Record<string, any> = {};
    const usedTags = new Set<string>();

    for (const { def, operationId, template } of routes) {
        if (def.hidden) continue;
        const p = `/v1${template}`;
        if (!paths[p]) paths[p] = {};
        def.tags.forEach(t => usedTags.add(t));

        const op: any = {
            operationId,
            summary: def.summary,
            description: describe(def),
            tags: def.tags,
            parameters: [...pathParameters(def, template), ...queryParameters(def)],
            'x-scope': def.scope,
            responses: {},
        };
        if (def.scope === null) op.security = [];

        if (def.rawBody) {
            op.requestBody = {
                required: true,
                description: def.rawBody.description,
                content: {
                    [def.rawBody.contentType]: { schema: { type: 'string', format: 'binary' } },
                    'multipart/form-data': {
                        schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
                    },
                },
            };
        } else if (def.body) {
            const bodySchema = def.body.toJSONSchema();
            op.requestBody = {
                required: !(def.body as any)._optional,
                content: {
                    'application/json': {
                        schema: bodySchema,
                        ...(def.examples?.request !== undefined ? { example: def.examples.request } : {}),
                    },
                },
            };
        }

        if (def.rawResponse) {
            op.responses['200'] = {
                description: def.rawResponse.description,
                content: { [def.rawResponse.contentType]: { schema: { type: 'string', format: 'binary' } } },
            };
        } else {
            const example = def.examples?.response !== undefined
                ? { success: true, data: def.examples.response, request_id: '3f0c0b6e-6d0a-4b8e-9d1a-1d2f3a4b5c6d' }
                : undefined;
            op.responses['200'] = {
                description: 'Thành công',
                content: { 'application/json': { schema: successSchema(def), ...(example ? { example } : {}) } },
            };
        }
        for (const [code, desc] of ERROR_RESPONSE_CODES) {
            if (def.scope === null && (code === '401' || code === '403')) continue;
            op.responses[code] = { description: desc, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } };
        }
        paths[p][def.method.toLowerCase()] = op;
    }

    const tags = Array.from(usedTags).map(name => ({ name, ...(TAG_DESCRIPTIONS[name] ? { description: TAG_DESCRIPTIONS[name] } : {}) }));

    return {
        openapi: '3.1.0',
        info: {
            title: 'Deplao Public API',
            version: opts.version,
            description: OVERVIEW_MARKDOWN,
        },
        servers: (opts.servers && opts.servers.length ? opts.servers : ['http://127.0.0.1:9900/api']).map(url => ({ url })),
        security: [{ BearerApiKey: [] }, { HeaderApiKey: [] }],
        tags,
        paths,
        components: {
            securitySchemes: {
                BearerApiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'dpk_…', description: 'Authorization: Bearer dpk_...' },
                HeaderApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
            },
            schemas: {
                ErrorEnvelope: {
                    type: 'object',
                    required: ['success', 'error', 'request_id'],
                    properties: {
                        success: { type: 'boolean', const: false },
                        error: {
                            type: 'object',
                            required: ['code', 'message'],
                            properties: {
                                code: { type: 'string', enum: Object.keys(ERROR_CODES) },
                                message: { type: 'string' },
                                details: {},
                            },
                        },
                        request_id: { type: 'string' },
                    },
                },
                Pagination: {
                    type: 'object',
                    properties: {
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                        total: { type: 'integer' },
                        has_more: { type: 'boolean' },
                        next_offset: { type: ['integer', 'null'] },
                        next_before: { type: ['integer', 'null'], description: 'Truyền vào `before` để lấy trang tin cũ hơn' },
                        next_since: { type: ['integer', 'null'], description: 'Polling sự kiện: truyền vào `since` lần sau' },
                    },
                },
            },
        },
        'x-scopes': API_SCOPES.map(s => ({ id: s.id, group: s.group, label: s.label })),
        'x-error-codes': Object.entries(ERROR_CODES).map(([code, v]) => ({ code, status: v.status, description: v.description })),
        'x-guides': GUIDES,
    };
}
