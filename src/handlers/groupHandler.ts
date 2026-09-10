import { messagingApi } from '@line/bot-sdk';
import NodeCache from 'node-cache';
import { FieldValue } from '@google-cloud/firestore';
import { firestore } from '../services/firestoreService.js';

export interface ActiveGroup {
  groupId: string;
  groupName?: string;
  lastActiveAt: any;
  updatedAt?: any;
  isActive: boolean;
}

const ACTIVE_GROUPS_COLLECTION = 'active_groups';

// In-memory cache to throttle Firestore writes (5 minutes TTL)
// Avoids redundant Firestore writes when many messages arrive in rapid succession
export const groupWriteCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Resilient in-memory store as zero-downtime fallback if Firestore API is disabled or unreachable
const inMemoryGroupStore = new Map<string, ActiveGroup>();

/**
 * Capture and store/update active LINE group IDs in Firestore.
 * Throttled using NodeCache to maintain high throughput and minimize write costs.
 */
export async function recordActiveGroup(
  groupId: string,
  client?: messagingApi.MessagingApiClient
): Promise<void> {
  if (!groupId) return;

  // 1. Check in-memory cache to skip redundant writes within TTL window
  if (groupWriteCache.has(groupId)) {
    return;
  }

  // 2. Mark in cache immediately to deduplicate concurrent events
  groupWriteCache.set(groupId, true);

  // 3. Attempt to fetch group summary from LINE API to get clean group name
  let groupName = 'กลุ่มดวลสด LINE';
  if (client) {
    try {
      const summary = await client.getGroupSummary(groupId);
      if (summary?.groupName) {
        groupName = summary.groupName;
      }
    } catch (err: any) {
      // LINE API may fail if bot is not in group or rate limits; fall back safely
      console.warn(`[GroupHandler] Unable to fetch group summary for ${groupId}:`, err?.message || err);
    }
  }

  const groupRecord: ActiveGroup = {
    groupId,
    groupName,
    lastActiveAt: new Date(),
    updatedAt: new Date(),
    isActive: true,
  };

  // Always keep in-memory store warm for zero-latency lookups
  inMemoryGroupStore.set(groupId, groupRecord);

  try {
    // 4. Upsert group record in Firestore 'active_groups' collection
    const groupRef = firestore.collection(ACTIVE_GROUPS_COLLECTION).doc(groupId);
    await groupRef.set(
      {
        groupId,
        groupName,
        lastActiveAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        isActive: true,
      },
      { merge: true }
    );

    console.log(`[GroupHandler] Recorded active group ${groupId} ("${groupName}") in Firestore`);
  } catch (err: any) {
    console.warn(`[GroupHandler] Firestore write skipped/unavailable (${err?.message || err}). Active group retained in memory.`);
  }
}

/**
 * Fetch all active groups from Firestore with resilient in-memory fallback.
 */
export async function getActiveGroups(): Promise<ActiveGroup[]> {
  const mergedMap = new Map<string, ActiveGroup>();

  // Load from in-memory store first
  for (const [gid, g] of inMemoryGroupStore.entries()) {
    if (g.isActive) mergedMap.set(gid, g);
  }

  try {
    const snapshot = await firestore
      .collection(ACTIVE_GROUPS_COLLECTION)
      .where('isActive', '==', true)
      .get();

    snapshot.forEach((doc) => {
      const data = doc.data() as ActiveGroup;
      mergedMap.set(data.groupId, data);
    });
  } catch (err: any) {
    console.warn('[GroupHandler] Note: Firestore lookup unavailable, serving active groups from memory cache:', err?.message || err);
  }

  const groups = Array.from(mergedMap.values());

  // In-memory sort by lastActiveAt descending to avoid composite index requirement
  groups.sort((a, b) => {
    const getMillis = (val: any): number => {
      if (!val) return 0;
      if (typeof val.toMillis === 'function') return val.toMillis();
      if (val instanceof Date) return val.getTime();
      if (typeof val === 'string') return new Date(val).getTime();
      return 0;
    };
    return getMillis(b.lastActiveAt) - getMillis(a.lastActiveAt);
  });

  return groups;
}
