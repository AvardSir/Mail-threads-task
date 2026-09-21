// src/worker.ts
import { fetchMessages, MessageItem as ClientMessageItem } from './client';
import {
  getState,
  setState,
  saveMessages,
  getAllMessages,
  updateThreadAndParent,
  MessageItem as DbMessageItem,
} from './db';
import { buildUpdates } from './processor';
import { exportAll } from './exporter';

// ---- 1. Types & constants ----
export type Stage = 'idle' | 'loading' | 'processing' | 'done';

export interface WorkerOptions {
  /** Page size passed to fetchMessages. undefined → client default (200). */
  limit?: number;
}

const STAGE_KEY = 'stage';
const CURSOR_KEY = 'cursor';

// ---- 2. Private helpers ----
const readStage = async (): Promise<Stage> => {
  const value = await getState(STAGE_KEY);
  if (value === 'idle' || value === 'loading' || value === 'processing' || value === 'done') {
    return value;
  }
  return 'idle';
};

const mapClientToDb = (item: ClientMessageItem): DbMessageItem => ({
  externalId: item.message_id,
  subject: item.subject,
  fromAddr: item.from,
  toAddrs: item.to,
  sentAt: item.sent_at,
  references: item.references,
  inReplyTo: item.in_reply_to ?? null,
});

const runLoadingLoop = async (limit?: number): Promise<void> => {
  let cursor = await getState(CURSOR_KEY);

  for (;;) {
    const page = await fetchMessages(cursor ?? undefined, limit);
    const dbItems = page.items.map(mapClientToDb);
    await saveMessages(dbItems);

    if (!page.next_cursor) {
      // saveMessages already committed; advance stage only after that.
      await setState(STAGE_KEY, 'processing');
      await setState(CURSOR_KEY, '');
      return;
    }

    await setState(CURSOR_KEY, page.next_cursor);
    cursor = page.next_cursor;
  }
};

const runProcessing = async (): Promise<void> => {
  const messages = await getAllMessages();
  const existingIds = new Set(messages.map((m) => m.externalId));
  const updates = buildUpdates(messages, existingIds);
  await updateThreadAndParent(updates);
  await exportAll();
  await setState(STAGE_KEY, 'done');
};

// ---- 3. Public API ----
export const runWorker = async (options?: WorkerOptions): Promise<Stage> => {
  const stage = await readStage();

  if (stage === 'done') {
    return 'done';
  }

  if (stage === 'processing') {
    await runProcessing();
    return 'done';
  }

  // stage is 'idle' or 'loading'
  if (stage === 'idle') {
    await setState(STAGE_KEY, 'loading');
  }

  await runLoadingLoop(options?.limit);
  await runProcessing();
  return 'done';
};

// ---- 4. CLI entry ----
/* istanbul ignore next */
if (require.main === module) {
  runWorker()
    .then((stage) => {
      console.log(`stage=${stage}`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
}