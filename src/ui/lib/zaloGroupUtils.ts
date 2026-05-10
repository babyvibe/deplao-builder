/**
 * zaloGroupUtils.ts
 *
 * Single public API: syncZaloGroups()
 *
 * ┌─ No groupId (full sync) ─────────────────────────────────────────────────┐
 * │  getAllGroups → getGroupInfo batches (save contacts + initial members)    │
 * │  → Phase 2: per-group member enrichment                                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 * ┌─ groupId provided (single-group mode) ───────────────────────────────────┐
 * │  getGroupInfo(groupId) → save placeholders → member enrichment           │
 * │  (skips getAllGroups entirely)                                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Per-group enrichment (anti-spam logic):
 *   0. All placeholders already have displayName → skip entirely
 *   1. getGroupMembersInfo → if ≥50% of unnamed members covered → done
 *   2. getUserInfo batch (fallback) → names + phones
 *      Also the sole path when skipGetGroupMembersInfo=true
 */

import ipc from '@/lib/ipc';
import { extractUserProfile } from '../../utils/profileUtils';

// ── Public types ──────────────────────────────────────────────────────────────

export interface MemberPlaceholder {
  memberId: string;
  displayName: string;
  avatar: string;
  role: number;
}

export interface SyncGroupsProgress {
  phase: 'groups' | 'members';
  /** Phase 1: groups processed. Phase 2: members processed for current group. */
  current: number;
  /** Phase 1: total groups. Phase 2: total members for current group. */
  total: number;
  /** Phase 2 only: which group we're on (1-based) */
  groupCurrent?: number;
  /** Phase 2 only: total groups to enrich */
  groupTotal?: number;
  /** Phase 2 only: display name of current group */
  currentGroupName?: string;
}

export interface SyncGroupsOptions {
  activeAccountId: string;
  auth: { cookies: any; imei: string; userAgent: string };

  /**
   * Single-group mode: enrich only this group (skip getAllGroups + batch getGroupInfo).
   * Omit for full sync of all Zalo groups.
   */
  groupId?: string;

  /** Called on each progress update for Phase 1 and Phase 2 */
  onProgress?: (p: SyncGroupsProgress) => void;

  /**
   * Called once after Phase 1 is complete:
   *  - Full sync: after all group contacts + initial members are saved to DB
   *  - Single-group: after getGroupInfo placeholders are saved to DB
   * Use to reload the group/member list in the UI immediately (show UIDs).
   */
  onPhase1Done?: () => Promise<void>;

  /**
   * Called after each group's member enrichment finishes in Phase 2.
   * Use to refresh member list / group member counts in the UI.
   */
  onGroupEnriched?: () => Promise<void>;

  /** Set .current = true to abort between Phase 2 groups */
  stopRef?: { current: boolean };

  /**
   * (Single-group mode only) Pre-parsed member IDs from a getGroupInfo call the caller
   * already made. When provided together with placeholders, skips the internal getGroupInfo
   * call to avoid a duplicate API request.
   * Pass displayName: '' in each placeholder to force fresh enrichment.
   */
  memberIds?: string[];
  /** Paired with memberIds above. */
  placeholders?: MemberPlaceholder[];
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface _EnrichOpts {
  activeAccountId: string;
  auth: { cookies: any; imei: string; userAgent: string };
  groupId: string;
  memberIds: string[];
  placeholders: MemberPlaceholder[];
  batchSize?: number;
  onProgress?: (current: number, total: number) => void;
  stopRef?: { current: boolean };
  /** true = skip getGroupMembersInfo, known to fail for this group */
  skipGetGroupMembersInfo?: boolean;
}

type _GroupEnrichItem = {
  groupId: string; groupName: string;
  memberIds: string[]; placeholders: MemberPlaceholder[];
  skipGetGroupMembersInfo: boolean;
};

async function _fetchGroupMembersComplete(opts: _EnrichOpts): Promise<void> {
  const {
    activeAccountId, auth, groupId, memberIds, placeholders,
    batchSize = 200, onProgress, stopRef,
    skipGetGroupMembersInfo = false,
  } = opts;

  if (memberIds.length === 0) return;

  const roleMap: Record<string, number> = {};
  const existingNameSet = new Set<string>();
  for (const p of placeholders) {
    roleMap[p.memberId] = p.role;
    if (p.displayName?.trim()) existingNameSet.add(p.memberId);
  }

  const membersWithoutNames = memberIds.filter(id => !existingNameSet.has(id));
  if (membersWithoutNames.length === 0) {
    console.log(`[zaloGroupUtils] Group ${groupId}: all ${memberIds.length} named → skip`);
    onProgress?.(memberIds.length, memberIds.length);
    return;
  }
  console.log(`[zaloGroupUtils] Group ${groupId}: ${membersWithoutNames.length}/${memberIds.length} need enrichment (skipStep1=${skipGetGroupMembersInfo})`);

  const coveredByStep1 = new Set<string>();

  if (!skipGetGroupMembersInfo) {
    try {
      const memberIdsForApi = memberIds.map(id => `${id}_0`);
      const res = await ipc.zalo?.getGroupMembersInfo({ auth, groupId, memberIds: memberIdsForApi });
      const profiles: Record<string, any> = res?.success
        ? (res.response?.profiles ?? res.response?.membersInfo ?? res.response?.data?.membersInfo ?? {})
        : {};
      console.log(`[zaloGroupUtils] getGroupMembersInfo → ${Object.keys(profiles).length} profiles for ${groupId}`);

      if (Object.keys(profiles).length > 0) {
        const updates: MemberPlaceholder[] = [];
        for (const [uid, info] of Object.entries(profiles)) {
          const memberId = uid.replace(/_0$/, '').trim();
          if (!memberId || !/^\d+$/.test(memberId)) continue;
          const displayName = (info as any).displayName || (info as any).zaloName || (info as any).name || '';
          const avatar = (info as any).avatar || (info as any).fullAvt || (info as any).avt || '';
          updates.push({ memberId, displayName, avatar, role: roleMap[memberId] ?? 0 });
          if (displayName) coveredByStep1.add(memberId);
        }
        if (updates.length > 0) {
          await ipc.db?.saveGroupMembers({ zaloId: activeAccountId, groupId, members: updates });
        }
      }
    } catch (err) {
      console.warn('[zaloGroupUtils] getGroupMembersInfo error:', err);
    }

    if (coveredByStep1.size >= membersWithoutNames.length * 0.5) {
      console.log(`[zaloGroupUtils] Group ${groupId}: step1 sufficient (${coveredByStep1.size}/${membersWithoutNames.length}) → skip getUserInfo`);
      onProgress?.(memberIds.length, memberIds.length);
      return;
    }
    console.log(`[zaloGroupUtils] Group ${groupId}: step1 insufficient → getUserInfo fallback`);
  }

  const BATCH = batchSize;
  for (let j = 0; j < memberIds.length; j += BATCH) {
    if (stopRef?.current) break;
    const batch = memberIds.slice(j, j + BATCH);
    try {
      const uRes = await ipc.zalo?.getUserInfo({ auth, userId: batch });
      if (uRes?.success && uRes.response) {
        const changedProfiles: Record<string, any> = uRes.response.changed_profiles ?? {};
        const memberUpdates: MemberPlaceholder[] = [];
        const contactSaves: Promise<any>[] = [];
        for (const memberId of batch) {
          const rawProfile = changedProfiles[memberId] ?? changedProfiles[`${memberId}_0`] ?? null;
          if (!rawProfile) continue;
          const { displayName, avatar, phone, gender, birthday } = extractUserProfile(rawProfile);
          if (!coveredByStep1.has(memberId) && !existingNameSet.has(memberId)) {
            memberUpdates.push({ memberId, displayName, avatar, role: roleMap[memberId] ?? 0 });
          }
          // Always save profile with gender/birthday/phone when available
          contactSaves.push(
            ipc.db?.updateContactProfile({
              zaloId: activeAccountId, contactId: memberId,
              displayName, avatarUrl: avatar, phone, contactType: 'friend',
              gender, birthday,
            }) ?? Promise.resolve()
          );
        }
        if (memberUpdates.length > 0) {
          await ipc.db?.saveGroupMembers({ zaloId: activeAccountId, groupId, members: memberUpdates });
        }
        if (contactSaves.length > 0) await Promise.all(contactSaves);
      }
    } catch (err) {
      console.warn('[zaloGroupUtils] getUserInfo batch error:', err);
    }
    onProgress?.(Math.min(j + BATCH, memberIds.length), memberIds.length);
    if (!stopRef?.current && j + BATCH < memberIds.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

// ── Single-group mode ─────────────────────────────────────────────────────────

async function _syncSingleGroup(opts: SyncGroupsOptions): Promise<void> {
  const {
    activeAccountId, auth, groupId, onProgress, onPhase1Done, onGroupEnriched, stopRef,
    memberIds: prebuiltMemberIds, placeholders: prebuiltPlaceholders,
  } = opts;
  if (!groupId) return;

  let memberIds: string[];
  let placeholders: MemberPlaceholder[];
  let groupName = groupId;

  if (prebuiltMemberIds && prebuiltPlaceholders && prebuiltMemberIds.length > 0) {
    // Caller already called getGroupInfo → skip duplicate API call
    memberIds = prebuiltMemberIds;
    placeholders = prebuiltPlaceholders;
    console.log(`[zaloGroupUtils] _syncSingleGroup: using pre-built memberIds (${memberIds.length}) for ${groupId}`);
  } else {
    // getGroupInfo → member IDs + roles
    const infoRes = await ipc.zalo?.getGroupInfo({ auth, groupId });
    const gridMap = infoRes?.response?.gridInfoMap ?? {};
    const gData: any = gridMap[groupId] ?? Object.values(gridMap)[0];
    if (!gData) {
      console.warn('[zaloGroupUtils] getGroupInfo returned no data for:', groupId);
      return;
    }

    groupName = gData.name || groupId;
    const creatorId = (gData.creatorId || '').replace(/_0$/, '');
    const adminIds: string[] = (gData.adminIds || []).map((a: string) => a.replace(/_0$/, ''));
    const adminSet = new Set([creatorId, ...adminIds]);

    const memVerEntries: string[] = Array.isArray(gData.memVerList)
      ? gData.memVerList
      : (gData.memVerList && typeof gData.memVerList === 'object' ? Object.keys(gData.memVerList) : []);

    const rawIds: string[] =
      (gData.memberIds?.length > 0 ? gData.memberIds : null) ??
      (gData.currentMems?.length > 0 ? gData.currentMems.map((m: any) => String(m.id || '')) : null) ??
      (memVerEntries.length > 0 ? memVerEntries : null) ??
      [];

    memberIds = [...new Set(
      rawIds.map(id => id.replace(/_0$/, '').trim()).filter(id => /^\d+$/.test(id))
    )];

    if (memberIds.length === 0) {
      console.warn('[zaloGroupUtils] No UIDs from getGroupInfo for:', groupId);
      return;
    }

    // Build placeholders (empty names — will be enriched)
    placeholders = memberIds.map(memberId => {
      let role = 0;
      if (memberId === creatorId) role = 2;
      else if (adminSet.has(memberId)) role = 1;
      return { memberId, displayName: '', avatar: '', role };
    });
  }

  await ipc.db?.saveGroupMembers({ zaloId: activeAccountId, groupId, members: placeholders });

  // Phase 1 done: let UI show UIDs
  await onPhase1Done?.();

  // Signal enrichment starting (total known now)
  onProgress?.({ phase: 'members', current: 0, total: memberIds.length, groupCurrent: 1, groupTotal: 1, currentGroupName: groupName });

  await _fetchGroupMembersComplete({
    activeAccountId, auth, groupId, memberIds, placeholders,
    onProgress: (cur, total) => onProgress?.({
      phase: 'members', current: cur, total,
      groupCurrent: 1, groupTotal: 1, currentGroupName: groupName,
    }),
    stopRef,
  });

  await onGroupEnriched?.();
}

// ── Full-sync mode ────────────────────────────────────────────────────────────

async function _syncAllGroups(opts: SyncGroupsOptions): Promise<void> {
  const { activeAccountId, auth, onProgress, onPhase1Done, onGroupEnriched, stopRef } = opts;

  const res = await ipc.zalo?.getGroups(auth);
  if (!res?.success) {
    console.warn('[zaloGroupUtils] getGroups failed:', res?.error);
    return;
  }

  const gridVerMap: Record<string, string> = res.response?.gridVerMap ?? {};
  const groupIds = Object.keys(gridVerMap);
  console.log(`[zaloGroupUtils] getAllGroups: ${groupIds.length} IDs`);
  if (groupIds.length === 0) return;

  // Load ALL existing members in one shot (no extra DB queries per group later)
  const existingMembersRes = await ipc.db?.getAllGroupMembers({ zaloId: activeAccountId });
  const existingMemberRows: any[] = existingMembersRes?.rows ?? [];
  const existingCountMap: Record<string, number> = {};
  const groupMembersMap: Record<string, MemberPlaceholder[]> = {};
  for (const row of existingMemberRows) {
    if (!row.group_id || !/^\d+$/.test(row.member_id ?? '')) continue;
    existingCountMap[row.group_id] = (existingCountMap[row.group_id] || 0) + 1;
    if (!groupMembersMap[row.group_id]) groupMembersMap[row.group_id] = [];
    groupMembersMap[row.group_id].push({
      memberId: row.member_id,
      displayName: row.display_name || '',
      avatar: row.avatar || '',
      role: row.role ?? 0,
    });
  }

  const newlySaved: _GroupEnrichItem[] = [];
  const uidOnlyExisting: _GroupEnrichItem[] = [];

  // Phase 1: getGroupInfo in batches of 50
  const BATCH_GROUPS = 50;
  let processed = 0;

  for (let i = 0; i < groupIds.length; i += BATCH_GROUPS) {
    const batchIds = groupIds.slice(i, i + BATCH_GROUPS);
    const infoRes = await ipc.zalo?.getGroupInfo({ auth, groupId: batchIds });
    const batchMap: Record<string, any> = infoRes?.success
      ? (infoRes.response?.gridInfoMap ?? infoRes.response?.data?.gridInfoMap ?? {})
      : {};

    for (const [groupId, info] of Object.entries(batchMap)) {
      const name: string = info.name || info.groupName || '';
      const avatar: string = info.fullAvt || info.avt || '';
      const creatorId: string = info.creatorId || '';
      const adminIds: string[] = info.adminIds || [];
      const rawMemberIds: string[] = info.memberIds || [];
      const currentMems: any[] = info.currentMems || [];

      const memInfoMap: Record<string, { displayName: string; avatar: string }> = {};
      for (const mem of currentMems) {
        const id = String(mem.id || '').replace(/_0$/, '').trim();
        if (id) memInfoMap[id] = { displayName: mem.dName || mem.zaloName || '', avatar: mem.avatar || mem.avatar_25 || '' };
      }

      await ipc.db?.updateContactProfile({
        zaloId: activeAccountId, contactId: groupId,
        displayName: name, avatarUrl: avatar, phone: '', contactType: 'group',
      });

      const alreadyHasMembers = (existingCountMap[groupId] ?? 0) > 0;
      if (alreadyHasMembers) {
        // Check if group has UID-only members (getGroupMembersInfo previously failed)
        const existingMembers = groupMembersMap[groupId] ?? [];
        const namedCount = existingMembers.filter(m => m.displayName?.trim()).length;
        if (namedCount < existingMembers.length) {
          uidOnlyExisting.push({ groupId, groupName: name, memberIds: existingMembers.map(m => m.memberId), placeholders: existingMembers, skipGetGroupMembersInfo: true });
        }
        // else: all named → fully enriched, skip
      } else {
        const memVerEntries: string[] = Array.isArray(info.memVerList)
          ? info.memVerList
          : (info.memVerList && typeof info.memVerList === 'object' ? Object.keys(info.memVerList) : []);
        const idsToSave =
          rawMemberIds.length > 0 ? rawMemberIds :
          currentMems.length > 0 ? currentMems.map((m: any) => String(m.id || '')) :
          memVerEntries;

        if (idsToSave.length > 0) {
          const adminSet = new Set([...adminIds, ...adminIds.map(a => a.replace(/_0$/, ''))]);
          const creatorSet = new Set([creatorId, creatorId.replace(/_0$/, '')]);
          const members: MemberPlaceholder[] = idsToSave
            .map(rawId => {
              const memberId = rawId.replace(/_0$/, '').trim();
              if (!memberId || !/^\d+$/.test(memberId)) return null;
              let role = 0;
              if (creatorSet.has(memberId) || creatorSet.has(rawId)) role = 2;
              else if (adminSet.has(memberId) || adminSet.has(rawId)) role = 1;
              const known = memInfoMap[memberId];
              return { memberId, displayName: known?.displayName || '', avatar: known?.avatar || '', role };
            })
            .filter((m): m is MemberPlaceholder => m !== null);

          if (members.length > 0) {
            await ipc.db?.saveGroupMembers({ zaloId: activeAccountId, groupId, members });
            await ipc.db?.removeGroupMember({ zaloId: activeAccountId, groupId, memberId: '' });
            newlySaved.push({ groupId, groupName: name, memberIds: members.map(m => m.memberId), placeholders: members, skipGetGroupMembersInfo: false });
          }
        }
      }
    }

    processed = Math.min(i + BATCH_GROUPS, groupIds.length);
    onProgress?.({ phase: 'groups', current: processed, total: groupIds.length });
    if (i + BATCH_GROUPS < groupIds.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`[zaloGroupUtils] Phase 1 done: ${processed}/${groupIds.length}. New: ${newlySaved.length}, UID-only: ${uidOnlyExisting.length}`);
  await onPhase1Done?.();

  // Phase 2: enrich member details
  const allToEnrich = [...newlySaved, ...uidOnlyExisting];
  for (let i = 0; i < allToEnrich.length; i++) {
    if (stopRef?.current) { console.log('[zaloGroupUtils] Phase 2 stopped by user'); break; }
    const { groupId, groupName, memberIds, placeholders, skipGetGroupMembersInfo } = allToEnrich[i];

    onProgress?.({ phase: 'members', current: 0, total: memberIds.length, groupCurrent: i + 1, groupTotal: allToEnrich.length, currentGroupName: groupName });

    await _fetchGroupMembersComplete({
      activeAccountId, auth, groupId, memberIds, placeholders, skipGetGroupMembersInfo,
      onProgress: (cur, total) => onProgress?.({
        phase: 'members', current: cur, total,
        groupCurrent: i + 1, groupTotal: allToEnrich.length, currentGroupName: groupName,
      }),
      stopRef,
    });

    await onGroupEnriched?.();
  }
  console.log('[zaloGroupUtils] Phase 2 done.');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sync Zalo group members (full or single-group mode).
 *
 * opts.groupId present → single-group: getGroupInfo → enrich (skip getAllGroups)
 * opts.groupId absent  → full sync: getAllGroups → getGroupInfo batches → enrich
 */
export async function syncZaloGroups(opts: SyncGroupsOptions): Promise<void> {
  if (opts.groupId) {
    await _syncSingleGroup(opts);
  } else {
    await _syncAllGroups(opts);
  }
}
