/**
 * FacebookMetrics.ts
 * Phase 8: Lightweight in-memory counters for Facebook bridge observability.
 *
 * Logs structured metadata for each counter increment.
 * No external dependencies — works in Electron main process.
 */

import Logger from '../../utils/Logger';

type MetricName =
  | 'fb_bridge_hello_failure'
  | 'fb_bridge_restart'
  | 'fb_bridge_generation_stale_event'
  | 'fb_event_queue_depth'
  | 'fb_event_queue_drop_low_priority'
  | 'fb_event_processing_failure'
  | 'fb_e2ee_state_save_failure'
  | 'fb_e2ee_media_rejected_too_large'
  | 'fb_thread_kind_unknown'
  | 'fb_graphql_semantic_failure';

const counters = new Map<MetricName, number>();

/**
 * Increment a metric counter. Logs at WARN level for abnormal metrics.
 */
export function metricInc(name: MetricName, accountId?: string, extra?: Record<string, any>): void {
  const current = (counters.get(name) || 0) + 1;
  counters.set(name, current);

  // Log structured metadata (no PII — accountId is UUID, not FB ID)
  const meta = extra ? ` ${JSON.stringify(extra)}` : '';
  Logger.warn(`[METRIC] ${name}=${current}${accountId ? ` acct=${accountId.slice(0, 8)}` : ''}${meta}`);
}

/**
 * Get current value of a metric counter (for dashboards/health checks).
 */
export function metricGet(name: MetricName): number {
  return counters.get(name) || 0;
}

/**
 * Get all counters as a snapshot (for health check endpoint).
 */
export function metricSnapshot(): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const [k, v] of counters) {
    snap[k] = v;
  }
  return snap;
}
