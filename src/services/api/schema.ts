/**
 * schema.ts — thư viện schema tối giản cho Public API v1.
 *
 * Một schema làm hai việc:
 *  1. Validate + chuẩn hoá dữ liệu đầu vào (body, query, path param), bỏ key lạ.
 *  2. Sinh JSON Schema để build OpenAPI (docs luôn khớp code).
 *
 * Không dùng zod để tránh thêm dependency vào app Electron (xem docs/api/README.md,
 * mục "Quyết định kỹ thuật"). API cố tình nhỏ: string, number, boolean, array,
 * object, record, any, enum, literal union.
 */

export interface SchemaIssue {
    path: string;
    message: string;
}

export interface ParseOptions {
    /** Ép kiểu từ chuỗi (query string, path param): "12" → 12, "true" → true, "a,b" → ['a','b']. */
    coerce?: boolean;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

type JsonSchema = Record<string, any>;

export abstract class Schema<T = any> {
    /** @internal */ _description?: string;
    /** @internal */ _example?: any;
    /** @internal */ _optional = false;
    /** @internal */ _nullable = false;
    /** @internal */ _default?: any;
    /** @internal */ _hasDefault = false;
    /** @internal */ _deprecated = false;

    /**
     * Builder BẤT BIẾN: mọi modifier trả bản sao, không sửa schema gốc
     * (schema dùng chung giữa nhiều route không bị "lây" optional/default).
     */
    protected with(mutate: (copy: this) => void): this {
        const copy = Object.assign(Object.create(Object.getPrototypeOf(this)), this) as this;
        mutate(copy);
        return copy;
    }

    describe(text: string): this {
        return this.with(c => { c._description = text; });
    }

    example(value: any): this {
        return this.with(c => { c._example = value; });
    }

    optional(): this {
        return this.with(c => { c._optional = true; });
    }

    nullable(): this {
        return this.with(c => { c._nullable = true; });
    }

    default(value: T): this {
        return this.with(c => {
            c._default = value;
            c._hasDefault = true;
            c._optional = true;
        });
    }

    deprecated(): this {
        return this.with(c => { c._deprecated = true; });
    }

    /** Validate `value`. Trả bản đã chuẩn hoá (ép kiểu, bỏ key lạ, điền default). */
    parse(value: unknown, opts: ParseOptions = {}): ParseResult<T> {
        const issues: SchemaIssue[] = [];
        const out = this._run(value, '', issues, opts);
        if (issues.length > 0) return { ok: false, issues };
        return { ok: true, value: out as T };
    }

    /** @internal Xử lý undefined/null/default rồi giao cho _check. */
    _run(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        if (value === undefined || (value === '' && opts.coerce && !(this instanceof StringSchema))) {
            if (this._hasDefault) return cloneDefault(this._default);
            if (this._optional) return undefined;
            issues.push({ path: path || '(root)', message: 'Bắt buộc' });
            return undefined;
        }
        if (value === null) {
            if (this._nullable) return null;
            if (this._optional) return undefined;
            issues.push({ path: path || '(root)', message: 'Không được null' });
            return undefined;
        }
        return this._check(value, path, issues, opts);
    }

    /** @internal */
    abstract _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any;

    /** @internal */
    abstract _json(): JsonSchema;

    toJSONSchema(): JsonSchema {
        const base = this._json();
        if (this._description) base.description = this._description;
        if (this._example !== undefined) base.examples = [this._example];
        if (this._hasDefault) base.default = this._default;
        if (this._deprecated) base.deprecated = true;
        if (this._nullable) {
            if (typeof base.type === 'string') base.type = [base.type, 'null'];
            else if (!base.type) return { anyOf: [base, { type: 'null' }] };
        }
        return base;
    }
}

function cloneDefault(v: any): any {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
}

function joinPath(path: string, key: string | number): string {
    if (typeof key === 'number') return `${path}[${key}]`;
    return path ? `${path}.${key}` : key;
}

// ─── String ──────────────────────────────────────────────────────────────────

export class StringSchema<T extends string = string> extends Schema<T> {
    private _min?: number;
    private _max?: number;
    private _pattern?: RegExp;
    private _enum?: readonly string[];
    private _format?: string;
    private _trim = false;

    min(n: number): this { return this.with(c => { c._min = n; }); }
    max(n: number): this { return this.with(c => { c._max = n; }); }
    pattern(re: RegExp): this { return this.with(c => { c._pattern = re; }); }
    format(f: 'uri' | 'email' | 'date-time' | 'uuid' | 'binary' | string): this { return this.with(c => { c._format = f; }); }
    trim(): this { return this.with(c => { c._trim = true; }); }
    /** @internal */
    _setEnum(values: readonly string[]): this { return this.with(c => { c._enum = values; }); }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        let v: any = value;
        if (typeof v === 'number' || typeof v === 'bigint') v = String(v);
        if (typeof v === 'boolean' && opts.coerce) v = String(v);
        if (typeof v !== 'string') {
            issues.push({ path: path || '(root)', message: 'Phải là chuỗi' });
            return undefined;
        }
        if (this._trim) v = v.trim();
        if (this._min !== undefined && v.length < this._min) {
            issues.push({ path: path || '(root)', message: `Tối thiểu ${this._min} ký tự` });
        }
        if (this._max !== undefined && v.length > this._max) {
            issues.push({ path: path || '(root)', message: `Tối đa ${this._max} ký tự` });
        }
        if (this._pattern && !this._pattern.test(v)) {
            issues.push({ path: path || '(root)', message: 'Sai định dạng' });
        }
        if (this._enum && !this._enum.includes(v)) {
            issues.push({ path: path || '(root)', message: `Chỉ nhận: ${this._enum.join(', ')}` });
        }
        if (this._format === 'uri' && v) {
            try { new URL(v); } catch { issues.push({ path: path || '(root)', message: 'URL không hợp lệ' }); }
        }
        return v;
    }

    _json(): JsonSchema {
        const j: JsonSchema = { type: 'string' };
        if (this._min !== undefined) j.minLength = this._min;
        if (this._max !== undefined) j.maxLength = this._max;
        if (this._pattern) j.pattern = this._pattern.source;
        if (this._enum) j.enum = [...this._enum];
        if (this._format) j.format = this._format;
        return j;
    }
}

// ─── Number ──────────────────────────────────────────────────────────────────

export class NumberSchema extends Schema<number> {
    private _int = false;
    private _min?: number;
    private _max?: number;

    int(): this { return this.with(c => { c._int = true; }); }
    min(n: number): this { return this.with(c => { c._min = n; }); }
    max(n: number): this { return this.with(c => { c._max = n; }); }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        let v: any = value;
        if (typeof v === 'string' && (opts.coerce || /^-?\d+(\.\d+)?$/.test(v.trim()))) {
            const n = Number(v.trim());
            if (v.trim() !== '' && Number.isFinite(n)) v = n;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            issues.push({ path: path || '(root)', message: 'Phải là số' });
            return undefined;
        }
        if (this._int && !Number.isInteger(v)) {
            issues.push({ path: path || '(root)', message: 'Phải là số nguyên' });
        }
        if (this._min !== undefined && v < this._min) {
            issues.push({ path: path || '(root)', message: `Tối thiểu ${this._min}` });
        }
        if (this._max !== undefined && v > this._max) {
            issues.push({ path: path || '(root)', message: `Tối đa ${this._max}` });
        }
        return v;
    }

    _json(): JsonSchema {
        const j: JsonSchema = { type: this._int ? 'integer' : 'number' };
        if (this._min !== undefined) j.minimum = this._min;
        if (this._max !== undefined) j.maximum = this._max;
        return j;
    }
}

// ─── Boolean ─────────────────────────────────────────────────────────────────

export class BooleanSchema extends Schema<boolean> {
    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        if (typeof value === 'boolean') return value;
        if (opts.coerce || typeof value === 'number' || typeof value === 'string') {
            if (value === 'true' || value === '1' || value === 1) return true;
            if (value === 'false' || value === '0' || value === 0) return false;
        }
        issues.push({ path: path || '(root)', message: 'Phải là true/false' });
        return undefined;
    }

    _json(): JsonSchema {
        return { type: 'boolean' };
    }
}

// ─── Array ───────────────────────────────────────────────────────────────────

export class ArraySchema<I = any> extends Schema<I[]> {
    private _min?: number;
    private _max?: number;

    constructor(private readonly item: Schema<I>) {
        super();
    }

    min(n: number): this { return this.with(c => { c._min = n; }); }
    max(n: number): this { return this.with(c => { c._max = n; }); }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        let v: any = value;
        if (typeof v === 'string' && opts.coerce) {
            const trimmed = v.trim();
            if (trimmed.startsWith('[')) {
                try { v = JSON.parse(trimmed); } catch { /* giữ nguyên để báo lỗi */ }
            } else {
                v = trimmed === '' ? [] : trimmed.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        if (!Array.isArray(v)) {
            issues.push({ path: path || '(root)', message: 'Phải là mảng' });
            return undefined;
        }
        if (this._min !== undefined && v.length < this._min) {
            issues.push({ path: path || '(root)', message: `Tối thiểu ${this._min} phần tử` });
        }
        if (this._max !== undefined && v.length > this._max) {
            issues.push({ path: path || '(root)', message: `Tối đa ${this._max} phần tử` });
            return undefined;
        }
        return v.map((item: unknown, i: number) => this.item._run(item, joinPath(path, i), issues, opts));
    }

    _json(): JsonSchema {
        const j: JsonSchema = { type: 'array', items: this.item.toJSONSchema() };
        if (this._min !== undefined) j.minItems = this._min;
        if (this._max !== undefined) j.maxItems = this._max;
        return j;
    }
}

// ─── Object ──────────────────────────────────────────────────────────────────

export type Shape = Record<string, Schema<any>>;

export class ObjectSchema<S extends Shape = Shape> extends Schema<{ [K in keyof S]: any }> {
    private _passthrough = false;

    constructor(readonly shape: S) {
        super();
    }

    /** Giữ lại key không khai báo (mặc định bỏ để không lọt tham số lạ vào IPC). */
    passthrough(): this {
        return this.with(c => { c._passthrough = true; });
    }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        let v: any = value;
        if (typeof v === 'string' && opts.coerce && v.trim().startsWith('{')) {
            try { v = JSON.parse(v); } catch { /* báo lỗi bên dưới */ }
        }
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
            issues.push({ path: path || '(root)', message: 'Phải là object' });
            return undefined;
        }
        const out: Record<string, any> = this._passthrough ? { ...v } : {};
        for (const [key, schema] of Object.entries(this.shape)) {
            const parsed = schema._run(v[key], joinPath(path, key), issues, opts);
            if (parsed !== undefined) out[key] = parsed;
            else if (this._passthrough) delete out[key];
        }
        return out;
    }

    _json(): JsonSchema {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        for (const [key, schema] of Object.entries(this.shape)) {
            properties[key] = schema.toJSONSchema();
            if (!schema._optional) required.push(key);
        }
        const j: JsonSchema = { type: 'object', properties };
        if (required.length > 0) j.required = required;
        if (!this._passthrough) j.additionalProperties = false;
        return j;
    }

    keys(): string[] {
        return Object.keys(this.shape);
    }

    /** Bản sao với một số key (dùng cho PATCH: mọi field optional). */
    partial(): ObjectSchema<S> {
        const next: Shape = {};
        for (const [key, schema] of Object.entries(this.shape)) {
            next[key] = schema._optional ? schema : schema.optional();
        }
        return new ObjectSchema(next as S);
    }
}

// ─── Record (map tuỳ ý key) ──────────────────────────────────────────────────

export class RecordSchema<V = any> extends Schema<Record<string, V>> {
    constructor(private readonly valueSchema: Schema<V>, private readonly maxKeys = 200) {
        super();
    }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            issues.push({ path: path || '(root)', message: 'Phải là object' });
            return undefined;
        }
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > this.maxKeys) {
            issues.push({ path: path || '(root)', message: `Tối đa ${this.maxKeys} key` });
            return undefined;
        }
        const out: Record<string, V> = {};
        for (const [key, raw] of entries) {
            const parsed = this.valueSchema._run(raw, joinPath(path, key), issues, opts);
            if (parsed !== undefined) out[key] = parsed;
        }
        return out;
    }

    _json(): JsonSchema {
        return { type: 'object', additionalProperties: this.valueSchema.toJSONSchema() };
    }
}

// ─── Any ─────────────────────────────────────────────────────────────────────

export class AnySchema extends Schema<any> {
    constructor(private readonly typeHint?: 'object' | 'string' | 'array') {
        super();
    }

    _check(value: unknown): any {
        return value;
    }

    _json(): JsonSchema {
        return this.typeHint ? { type: this.typeHint } : {};
    }
}

// ─── Union (chọn schema đầu tiên parse được) ─────────────────────────────────

export class UnionSchema extends Schema<any> {
    constructor(private readonly options: Schema<any>[]) {
        super();
    }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        const collected: SchemaIssue[][] = [];
        for (const option of this.options) {
            const local: SchemaIssue[] = [];
            const out = option._run(value, path, local, opts);
            if (local.length === 0) return out;
            collected.push(local);
        }
        issues.push({ path: path || '(root)', message: 'Không khớp kiểu nào được chấp nhận' });
        return undefined;
    }

    _json(): JsonSchema {
        return { anyOf: this.options.map(o => o.toJSONSchema()) };
    }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export const s = {
    string: () => new StringSchema(),
    number: () => new NumberSchema(),
    int: () => new NumberSchema().int(),
    boolean: () => new BooleanSchema(),
    array: <I>(item: Schema<I>) => new ArraySchema<I>(item),
    object: <S extends Shape>(shape: S) => new ObjectSchema<S>(shape),
    record: <V>(value: Schema<V>, maxKeys?: number) => new RecordSchema<V>(value, maxKeys),
    any: (hint?: 'object' | 'string' | 'array') => new AnySchema(hint),
    enum: <T extends string>(values: readonly T[]) => new StringSchema<T>()._setEnum(values),
    union: (...options: Schema<any>[]) => new UnionSchema(options),
    /** id dạng chuỗi (Zalo/FB/TG id có thể là số lớn → luôn nhận chuỗi). */
    id: () => new StringSchema().min(1).max(200),
    /** Epoch mili giây. */
    timestamp: () => new NumberSchema().int().min(0),
};

export type Infer<T> = T extends Schema<infer U> ? U : never;
