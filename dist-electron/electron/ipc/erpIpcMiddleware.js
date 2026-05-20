"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.erpValidate = void 0;
exports.withErpAuth = withErpAuth;
const ErpAuthContext_1 = __importStar(require("../../src/services/erp/ErpAuthContext"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
/**
 * Wrap an IPC handler with:
 *  1. Main-side `ErpAuthContext.resolve()` → always trusted `employeeId` + `role`.
 *  2. Optional RBAC action check (throws ErpPermissionError on deny).
 *  3. Uniform `{ success, error, code }` response envelope.
 *
 * The inner `handler(input, ctx, event)` may return any object; its keys are
 * merged into `{ success: true, ... }`. Throwing is the ONLY way to signal
 * error — validation helpers should throw `new Error('...')`.
 */
function withErpAuth(action, handler) {
    return async (event, input) => {
        let ctx;
        try {
            ctx = ErpAuthContext_1.default.resolve();
            if (action)
                ErpAuthContext_1.default.requirePermission(action, ctx);
        }
        catch (err) {
            if (err instanceof ErpAuthContext_1.ErpPermissionError) {
                Logger_1.default.warn(`[erpIpc] ${err.message}`);
                return { success: false, error: err.message, code: 'permission_denied' };
            }
            return { success: false, error: err.message || String(err), code: 'internal_error' };
        }
        try {
            const out = await handler(input ?? {}, ctx, event);
            return { success: true, ...out };
        }
        catch (err) {
            const msg = err?.message || String(err);
            Logger_1.default.warn(`[erpIpc] handler error: ${msg}`);
            return { success: false, error: msg, code: 'internal_error' };
        }
    };
}
/** Lightweight runtime validators — throw on mismatch. */
exports.erpValidate = {
    string(v, field, opts = {}) {
        if (typeof v !== 'string')
            throw new Error(`${field}: must be string`);
        if (!opts.allowEmpty && !v.length)
            throw new Error(`${field}: must not be empty`);
        if (opts.min !== undefined && v.length < opts.min)
            throw new Error(`${field}: too short`);
        if (opts.max !== undefined && v.length > opts.max)
            throw new Error(`${field}: too long`);
        return v;
    },
    enum(v, field, allowed) {
        if (!allowed.includes(v))
            throw new Error(`${field}: must be one of ${allowed.join(',')}`);
        return v;
    },
    int(v, field) {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n))
            throw new Error(`${field}: must be integer`);
        return n;
    },
    required(v, field) {
        if (v === undefined || v === null)
            throw new Error(`${field}: required`);
    },
};
//# sourceMappingURL=erpIpcMiddleware.js.map