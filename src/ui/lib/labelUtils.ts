/**
 * labelUtils.ts
 *
 * Shared utilities for label sync operations.
 * Used by both runAccountInit (zaloInitUtils) and LabelSettings UI.
 */

import ipc from '@/lib/ipc';

/**
 * Extract the display name from a Zalo label object.
 * Zalo labels use `text` as the primary name field, falling back to `name` and `title`.
 */
export function getZaloLabelName(zLabel: any): string {
    return (zLabel.text || zLabel.name || zLabel.title || `Nhãn ${zLabel.id ?? '?'}`).trim();
}

// ── Sync Zalo Labels -> Local DB ──────────────────────────────────────────────

export interface SyncZaloLabelsOptions {
    /** Raw Zalo label array from API (labelData) */
    zaloLabels: any[];
    /** Target account zalo_id */
    activeZaloId: string;
    /** merge = skip labels that already exist by name; replace = upsert all */
    mode: 'merge' | 'replace';
    /** Existing local labels (for merge dedup). If not provided, fetched from DB. */
    existingLocalLabels?: Array<{ name: string }>;
}

/**
 * Syncs Zalo labels into the local_labels DB table.
 *
 * Correctly maps Zalo API fields:
 *   text/name/title  ->  name
 *   color            ->  color
 *   emoji/icon       ->  emoji
 *   (computed)       ->  textColor  (based on background luminance)
 *
 * Returns the number of labels actually upserted.
 */
export async function syncZaloLabelsToLocalDB(opts: SyncZaloLabelsOptions): Promise<number> {
    const {zaloLabels, activeZaloId, mode, existingLocalLabels} = opts;
    if (!zaloLabels || zaloLabels.length === 0) return 0;

    // Build a Set of existing label names for merge dedup
    let existingNames = new Set<string>();
    if (mode === 'merge') {
        if (existingLocalLabels) {
            existingNames = new Set(existingLocalLabels.map(l => l.name.toLowerCase()));
        } else {
            try {
                const res = await ipc.db?.getLocalLabels({zaloId: activeZaloId});
                const labels: any[] = res?.labels || [];
                existingNames = new Set(labels.map((l: any) => (l.name || '').toLowerCase()));
            } catch { /* ignore */
            }
        }
    }

    // Mode = 'replace' removeAllLabels done and add labels new
    if (mode === 'replace') {
        try {
            const res = await ipc.db?.getLocalLabels({zaloId: activeZaloId});
            const labels: any[] = res?.labels || [];
            for (const label of labels) {
                if (label?.id == null) continue;
                await ipc.db?.deleteLocalLabel({id: label.id});
            }
        } catch { /* ignore */
        }
    }

    let count = 0;
    for (const zLabel of zaloLabels) {
        const name = getZaloLabelName(zLabel);
        if (!name) continue;

        // In merge mode, skip if a label with the same name already exists
        if (mode === 'merge' && existingNames.has(name.toLowerCase())) continue;

        const color = zLabel.color || '#3b82f6';
        const emoji = zLabel.emoji || zLabel.icon || '🏷️';
        const textColor = '#ffffff';

        try {
            await ipc.db?.upsertLocalLabel({
                label: {
                    name,
                    color,
                    textColor,
                    emoji,
                    pageIds: activeZaloId,
                    isActive: 1,
                    sortOrder: count,
                },
            });
            count++;
        } catch { /* skip individual failures */
        }
    }

    return count;
}
