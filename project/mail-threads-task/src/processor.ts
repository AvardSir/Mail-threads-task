// src/processor.ts
// ---- 1. Imports ----
import type { MessageRow, UpdateThreadInput } from './db';

// ---- 2. Public API ----
/**
 * Stub for Milestone 5. Real implementation lands in Milestone 6:
 * parent_id resolution + thread_key via DSU over references/in_reply_to.
 */
export const buildUpdates = (
  _messages: MessageRow[],
  _existingIds: Set<string>,
): UpdateThreadInput[] => {
  return [];
};