// ---- 1. Imports ----
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { getAllMessages, MessageRow } from './db';
import { rootLogger } from './client';

// ---- 2. Public types ----
export interface ExportedMessage {
  externalId: string;
  parentId: string | null;
  threadKey: string | null;
  subject: string | null;
  fromAddr: string | null;
  toAddrs: string[];
  sentAt: string | null; // ISO 8601 or null
}

// ---- 3. Config ----
const DEFAULT_OUTPUT_PATH = './out/result.jsonl';

// ---- 4. Logger ----
const logger = rootLogger.child({ module: 'exporter' });

// ---- 5. Helpers ----
const toExported = (row: MessageRow): ExportedMessage => ({
  externalId: row.externalId,
  parentId: row.parentId,
  threadKey: row.threadKey,
  subject: row.subject,
  fromAddr: row.fromAddr,
  toAddrs: row.toAddrs,
  sentAt: row.sentAt ? row.sentAt.toISOString() : null,
});

const serialize = (rows: MessageRow[]): string =>
  rows.map((row) => JSON.stringify(toExported(row))).join('\n') +
  (rows.length > 0 ? '\n' : '');

// ---- 6. Public API ----
export const exportAll = async (
  outputPath: string = DEFAULT_OUTPUT_PATH,
): Promise<void> => {
  logger.info({ outputPath }, 'Export started');

  const rows = await getAllMessages();
  const payload = serialize(rows);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, payload, 'utf-8');

  logger.info({ outputPath, count: rows.length }, 'Export finished');
};

// ---- 7. CLI wrapper ----
export const runCli = async (): Promise<void> => {
  try {
    await exportAll();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Export failed');
    process.exit(1);
  }
};

/* istanbul ignore next */
if (require.main === module) {
  void runCli();
}