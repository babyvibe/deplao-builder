/**
 * zca-js (>= 2.4) reads the API type / version from the Zalo Web page at every login when none is given:
 * one more page load per login, through the account's proxy, and accounts log in one by one at startup.
 * The first login detects it, later logins reuse that value for a few hours (Zalo changes it rarely).
 */
import Logger from '../Logger';

export const ZALO_API_VERSION_REUSE_MS = 6 * 60 * 60 * 1000;

interface KnownVersion {
    apiType: number;
    apiVersion: number;
    at: number;
}

let known: KnownVersion | null = null;

const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const fresh = (now: number) => !!known && now - known.at <= ZALO_API_VERSION_REUSE_MS;

/** Options for `new Zalo(...)`: the remembered type / version, or nothing so zca-js detects them. */
export function zaloApiVersionOptions(now = Date.now()): { apiType?: number; apiVersion?: number } {
    return known && fresh(now) ? { apiType: known.apiType, apiVersion: known.apiVersion } : {};
}

/** Remember the type / version a logged-in session uses (zca-js sets them on the context at login). */
export function rememberZaloApiVersion(api: { getContext?: () => any } | null | undefined, now = Date.now()): void {
    if (fresh(now)) return;
    let ctx: any;
    try {
        ctx = api?.getContext?.();
    } catch {
        return;
    }
    if (!isPositiveInt(ctx?.API_TYPE) || !isPositiveInt(ctx?.API_VERSION)) return;
    const changed = !known || known.apiType !== ctx.API_TYPE || known.apiVersion !== ctx.API_VERSION;
    known = { apiType: ctx.API_TYPE, apiVersion: ctx.API_VERSION, at: now };
    if (changed) Logger.log(`[ZaloLogin] Zalo Web API type ${ctx.API_TYPE}, version ${ctx.API_VERSION}`);
}

export function resetZaloApiVersionForTests(): void {
    known = null;
}
