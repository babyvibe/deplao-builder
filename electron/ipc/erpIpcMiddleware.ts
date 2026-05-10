import { IpcMainInvokeEvent } from 'electron';
import ErpAuthContext, { ErpAuthCtx, ErpPermissionError } from '../../src/services/erp/ErpAuthContext';
import Logger from '../../src/utils/Logger';

export interface ErpHandlerResult<T = any> {
  success: boolean;
  error?: string;
  code?: 'permission_denied' | 'validation_error' | 'internal_error';
  [k: string]: any;
}

export type ErpHandler<TInput, TOutput extends object> = (
  input: TInput,
  ctx: ErpAuthCtx,
  event: IpcMainInvokeEvent,
) => Promise<TOutput> | TOutput;

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
export function withErpAuth<TInput = any, TOutput extends object = any>(
  action: string | null,
  handler: ErpHandler<TInput, TOutput>,
) {
  return async (event: IpcMainInvokeEvent, input: TInput): Promise<ErpHandlerResult> => {
    let ctx: ErpAuthCtx;
    try {
      ctx = ErpAuthContext.resolve();
      if (action) ErpAuthContext.requirePermission(action, ctx);
    } catch (err: any) {
      if (err instanceof ErpPermissionError) {
        Logger.warn(`[erpIpc] ${err.message}`);
        return { success: false, error: err.message, code: 'permission_denied' };
      }
      return { success: false, error: err.message || String(err), code: 'internal_error' };
    }

    try {
      const out = await handler(input ?? ({} as TInput), ctx, event);
      return { success: true, ...out };
    } catch (err: any) {
      const msg = err?.message || String(err);
      Logger.warn(`[erpIpc] handler error: ${msg}`);
      return { success: false, error: msg, code: 'internal_error' };
    }
  };
}

/** Lightweight runtime validators — throw on mismatch. */
export const erpValidate = {
  string(v: any, field: string, opts: { min?: number; max?: number; allowEmpty?: boolean } = {}): string {
    if (typeof v !== 'string') throw new Error(`${field}: must be string`);
    if (!opts.allowEmpty && !v.length) throw new Error(`${field}: must not be empty`);
    if (opts.min !== undefined && v.length < opts.min) throw new Error(`${field}: too short`);
    if (opts.max !== undefined && v.length > opts.max) throw new Error(`${field}: too long`);
    return v;
  },
  enum<T extends string>(v: any, field: string, allowed: readonly T[]): T {
    if (!allowed.includes(v)) throw new Error(`${field}: must be one of ${allowed.join(',')}`);
    return v;
  },
  int(v: any, field: string): number {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${field}: must be integer`);
    return n;
  },
  required(v: any, field: string): void {
    if (v === undefined || v === null) throw new Error(`${field}: required`);
  },
};

