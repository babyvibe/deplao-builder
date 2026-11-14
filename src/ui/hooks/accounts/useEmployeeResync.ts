/**
 * useEmployeeResync: in employee mode, reload data when the connection to the BOSS is restored.
 *
 * Temporary REST errors no longer turn into "không có dữ liệu" (no data) (DataAccessor returns `success: false`, and the caller keeps
 * the old data), but that old data must be refreshed when the network comes back. This hook calls `callback` when:
 *  - `RestQueryService.onRecovered`: the REST client goes from blocked / lost connection back to reachable;
 *  - window event `employee:resync`: the main process reconnects to the BOSS / the machine wakes from sleep.
 *
 * The two sources often fire close together → merged (debounce ~500 ms) into ONE call. Triggered while the previous run is still
 * running (the callback returns a Promise) → runs exactly one more time after it finishes, never overlapping.
 * BOSS / standalone mode: registers nothing, never calls `callback`.
 */
import { useEffect, useRef } from 'react';
import RestQueryService from '../../../services/http/RestQueryService';
import { useEmployeeStore } from '../../store/employee/employeeStore';

/** Window event fired by the App after the main process reconnects to the BOSS / the system wakes up. */
export const EMPLOYEE_RESYNC_EVENT = 'employee:resync';
export const EMPLOYEE_RESYNC_DEBOUNCE_MS = 500;

export interface ResyncScheduler {
  /** Reload request; requests inside the debounce window merge into one run. */
  request(): void;
  /** Cancel the pending schedule and any extra runs (a run already in progress still finishes). */
  cancel(): void;
}

/**
 * Plain reload scheduler (no React): trailing debounce of `debounceMs`, never overlapping. Requests that arrive while `run` is
 * busy are merged into one more run after it finishes.
 */
export function createResyncScheduler(
  run: () => void | Promise<unknown>,
  debounceMs: number = EMPLOYEE_RESYNC_DEBOUNCE_MS,
): ResyncScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let cancelled = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };

  function fire() {
    timer = null;
    if (cancelled) return;
    if (running) { again = true; return; }
    running = true;
    let pending: unknown;
    try {
      pending = run();
    } catch (err) {
      console.warn('[useEmployeeResync] resync failed:', err);
    }
    Promise.resolve(pending)
      .catch((err) => { console.warn('[useEmployeeResync] resync failed:', err); })
      .finally(() => {
        running = false;
        if (again && !cancelled) {
          again = false;
          schedule();
        }
      });
  }

  return {
    request() {
      if (!cancelled) schedule();
    },
    cancel() {
      cancelled = true;
      again = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Registers `RestQueryService.onRecovered` (new API) defensively: builds without the API keep only the
 * window event source. Returns the unsubscribe function.
 */
export function subscribeRestRecovered(cb: () => void): () => void {
  try {
    const service = RestQueryService.getInstance() as unknown as {
      onRecovered?: (listener: () => void) => (() => void) | void;
    };
    if (typeof service?.onRecovered !== 'function') return () => {};
    const unsubscribe = service.onRecovered(cb);
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  } catch {
    return () => {};
  }
}

/**
 * Calls `callback` (the latest version from the most recent render) each time the BOSS connection is restored, in employee mode only.
 * The callback should read the latest state itself (store.getState()) and only reload the part that is shown.
 */
export function useEmployeeResync(
  callback: () => void | Promise<unknown>,
  debounceMs: number = EMPLOYEE_RESYNC_DEBOUNCE_MS,
): void {
  // Boolean selector: re-renders only when the mode changes (does not subscribe to the whole employeeStore)
  const isEmployee = useEmployeeStore((s) => s.mode === 'employee');
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!isEmployee) return;
    const scheduler = createResyncScheduler(() => callbackRef.current(), debounceMs);
    const trigger = () => scheduler.request();
    const unsubscribeRecovered = subscribeRestRecovered(trigger);
    window.addEventListener(EMPLOYEE_RESYNC_EVENT, trigger);
    return () => {
      scheduler.cancel();
      unsubscribeRecovered();
      window.removeEventListener(EMPLOYEE_RESYNC_EVENT, trigger);
    };
  }, [isEmployee, debounceMs]);
}

export default useEmployeeResync;
