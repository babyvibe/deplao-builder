/**
 * DB / workspace scope per running flow (AsyncLocalStorage).
 *
 * One machine can have a local workspace (the owner's) and also open an employee workspace (remote, e.g. to try the employee features on the same
 * machine): everything running in the background for the local workspace (Zalo, Telegram, Facebook, workflow, API, ERP, Cloudflare, plugins…) must
 * keep reading / writing the DB + media folder of the local workspace, whichever workspace the UI has open. Before, switching the workspace
 * also switched the DB shared by the main process: Telegram messages, API events and files downloaded by the owner were written into the employee
 * workspace, and opening the app while on the employee workspace stopped the owner's Telegram / Facebook / workflows from running.
 *
 *  - The main DB (DatabaseService) = the local workspace that is running ("runtime"), never the remote workspace.
 *  - Commands from the UI (IPC, local-media://) while the UI has a remote workspace open run in the 'ui' scope: they use the cache DB
 *    + media of that remote workspace as before, and "open workspace" / app mode = employee.
 *  - withDbPath() = the 'path' scope: one specific DB for the code inside (including the async parts).
 */
import { AsyncLocalStorage } from 'async_hooks';

export type DbScope = { kind: 'ui' } | { kind: 'path'; dbPath: string };

/** The remote workspace open on the UI. */
export interface UiRemoteWorkspace {
    workspaceId: string;
    dbPath: string;
    mediaDir: string;
}

const storage = new AsyncLocalStorage<DbScope>();
const UI_SCOPE: DbScope = Object.freeze({ kind: 'ui' as const });
let uiRemote: UiRemoteWorkspace | null = null;

export function currentDbScope(): DbScope | undefined {
    return storage.getStore();
}

/** Run `fn` (including the async parts inside) on the DB `dbPath`. */
export function runWithDbPath<T>(dbPath: string, fn: () => T): T {
    return storage.run({ kind: 'path', dbPath }, fn);
}

/** Run `fn` outside every scope: the DB / media / the running local workspace. */
export function runInRuntimeScope<T>(fn: () => T): T {
    return storage.exit(fn);
}

/**
 * Command from the UI. If the UI has a remote workspace open → the 'ui' scope (the DB + media of the remote workspace that is open at the time of the
 * call). If the UI has a local workspace open → runs directly, with no scope attached: the background work started by the command (connecting an
 * account, turning on the bot, saving a workflow…) always belongs to the local workspace.
 */
export function runInUiScope<T>(fn: () => T): T {
    return uiRemote ? storage.run(UI_SCOPE, fn) : fn();
}

export function setUiRemoteWorkspace(ws: UiRemoteWorkspace | null): void {
    uiRemote = ws;
}

export function getUiRemoteWorkspace(): UiRemoteWorkspace | null {
    return uiRemote;
}

/** The running code is a command from the UI of the remote workspace that is open. */
export function inUiRemoteScope(): boolean {
    return !!uiRemote && storage.getStore()?.kind === 'ui';
}
