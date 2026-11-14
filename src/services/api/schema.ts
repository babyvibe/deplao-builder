/**
 * schema.ts: a minimal schema library for the Public API v1.
 *
 * One schema does two things:
 *  1. Validates + normalizes input data (body, query, path param), drops unknown keys.
 *  2. Generates a JSON Schema to build the OpenAPI (docs always match the code).
 *
 * Zod is not used, to avoid adding a dependency to the Electron app (see docs/api/README.md,
 * section "Quyết định kỹ thuật" (Technical decisions)). The API is intentionally small: string, number, boolean, array,
 * object, record, any, enum, literal union.
 */

import { tr } from '../../shared/i18n';

export interface SchemaIssue {
    path: string;
    message: string;
}

export interface ParseOptions {
    /** Coerce from strings (query string, path param): "12" → 12, "true" → true, "a,b" → ['a','b']. */
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
     * IMMUTABLE builder: every modifier returns a copy and never changes the original schema
     * (a schema shared by several routes does not "leak" optional/default to the others).
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

    /** Validate `value`. Returns the normalized copy (coerced, unknown keys dropped, defaults filled in). */
    parse(value: unknown, opts: ParseOptions = {}): ParseResult<T> {
        const issues: SchemaIssue[] = [];
        const out = this._run(value, '', issues, opts);
        if (issues.length > 0) return { ok: false, issues };
        return { ok: true, value: out as T };
    }

    /** @internal Handle undefined/null/default, then hand off to _check. */
    _run(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        if (value === undefined || (value === '' && opts.coerce && !(this instanceof StringSchema))) {
            if (this._hasDefault) return cloneDefault(this._default);
            if (this._optional) return undefined;
            issues.push({ path: path || '(root)', message: tr('Bắt buộc') });
            return undefined;
        }
        if (value === null) {
            if (this._nullable) return null;
            if (this._optional) return undefined;
            issues.push({ path: path || '(root)', message: tr('Không được null') });
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
            issues.push({ path: path || '(root)', message: tr('Phải là chuỗi') });
            return undefined;
        }
        if (this._trim) v = v.trim();
        if (this._min !== undefined && v.length < this._min) {
            issues.push({ path: path || '(root)', message: tr('Tối thiểu {{_min}} ký tự', { _min: this._min }) });
        }
        if (this._max !== undefined && v.length > this._max) {
            issues.push({ path: path || '(root)', message: tr('Tối đa {{_max}} ký tự', { _max: this._max }) });
        }
        if (this._pattern && !this._pattern.test(v)) {
            issues.push({ path: path || '(root)', message: tr('Sai định dạng') });
        }
        if (this._enum && !this._enum.includes(v)) {
            issues.push({ path: path || '(root)', message: tr('Chỉ nhận: {{v1}}', { v1: this._enum.join(', ') }) });
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
            issues.push({ path: path || '(root)', message: tr('Phải là số') });
            return undefined;
        }
        if (this._int && !Number.isInteger(v)) {
            issues.push({ path: path || '(root)', message: tr('Phải là số nguyên') });
        }
        if (this._min !== undefined && v < this._min) {
            issues.push({ path: path || '(root)', message: tr('Tối thiểu {{_min}}', { _min: this._min }) });
        }
        if (this._max !== undefined && v > this._max) {
            issues.push({ path: path || '(root)', message: tr('Tối đa {{_max}}', { _max: this._max }) });
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
        issues.push({ path: path || '(root)', message: tr('Phải là true/false') });
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
                try { v = JSON.parse(trimmed); } catch { /* keep as is so the error is reported */ }
            } else {
                v = trimmed === '' ? [] : trimmed.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        if (!Array.isArray(v)) {
            issues.push({ path: path || '(root)', message: tr('Phải là mảng') });
            return undefined;
        }
        if (this._min !== undefined && v.length < this._min) {
            issues.push({ path: path || '(root)', message: tr('Tối thiểu {{_min}} phần tử', { _min: this._min }) });
        }
        if (this._max !== undefined && v.length > this._max) {
            issues.push({ path: path || '(root)', message: tr('Tối đa {{_max}} phần tử', { _max: this._max }) });
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

    /** Keep undeclared keys (dropped by default so unknown params do not leak into IPC). */
    passthrough(): this {
        return this.with(c => { c._passthrough = true; });
    }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        let v: any = value;
        if (typeof v === 'string' && opts.coerce && v.trim().startsWith('{')) {
            try { v = JSON.parse(v); } catch { /* the error is reported below */ }
        }
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
            issues.push({ path: path || '(root)', message: tr('Phải là object') });
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

    /** A copy with some keys (used for PATCH: every field is optional). */
    partial(): ObjectSchema<S> {
        const next: Shape = {};
        for (const [key, schema] of Object.entries(this.shape)) {
            next[key] = schema._optional ? schema : schema.optional();
        }
        return new ObjectSchema(next as S);
    }
}

// ─── Record (map with any keys) ──────────────────────────────────────────────────

export class RecordSchema<V = any> extends Schema<Record<string, V>> {
    constructor(private readonly valueSchema: Schema<V>, private readonly maxKeys = 200) {
        super();
    }

    _check(value: unknown, path: string, issues: SchemaIssue[], opts: ParseOptions): any {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            issues.push({ path: path || '(root)', message: tr('Phải là object') });
            return undefined;
        }
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > this.maxKeys) {
            issues.push({ path: path || '(root)', message: tr('Tối đa {{maxKeys}} key', { maxKeys: this.maxKeys }) });
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

// ─── Union (the first schema that parses is chosen) ─────────────────────────────────

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
        issues.push({ path: path || '(root)', message: tr('Không khớp kiểu nào được chấp nhận') });
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
    /** id as a string (Zalo/FB/TG ids can be large numbers → always accept a string). */
    id: () => new StringSchema().min(1).max(200),
    /** Epoch milliseconds. */
    timestamp: () => new NumberSchema().int().min(0),
};

export type Infer<T> = T extends Schema<infer U> ? U : never;
