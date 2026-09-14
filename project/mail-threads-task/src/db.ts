import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

// ---- 1. Типы ----

export interface MessageItem {
  externalId: string;
  subject?: string | null;
  fromAddr?: string | null;
  toAddrs?: string[];
  sentAt?: Date | string | null;
  references?: string[];
  inReplyTo?: string | null;
}

export interface MessageRow {
  id: number;
  externalId: string;
  parentId: string | null;
  threadKey: string | null;
  subject: string | null;
  fromAddr: string | null;
  toAddrs: string[];
  sentAt: Date | null;
  references: string[];
  inReplyTo: string | null;
}

export interface UpdateThreadInput {
  externalId: string;
  parentId: string | null;
  threadKey: string | null;
}

// ---- 2. State ----

export const getState = async (key: string): Promise<string | null> => {
  const row = await prisma.appState.findUnique({ where: { key } });
  return row?.value ?? null;
};

export const setState = async (key: string, value: string): Promise<void> => {
  await prisma.appState.upsert({
    where: { key },
    update: { value },
  create: { key, value },
  });
};

// ---- 3. Messages ----

export const saveMessages = async (messages: MessageItem[]): Promise<number> => {
  if (messages.length === 0) return 0;

  const data = messages.map((m) => ({
    externalId: m.externalId,
    subject: m.subject ?? null,
    fromAddr: m.fromAddr ?? null,
    toAddrs: m.toAddrs ?? [],
    sentAt: m.sentAt ? new Date(m.sentAt) : null,
    references: m.references ?? [],
    inReplyTo: m.inReplyTo ?? null,
  }));

  const result = await prisma.message.createMany({
    data,
    skipDuplicates: true,
  });

  return result.count;
};

export const getAllMessages = async (): Promise<MessageRow[]> => {
  return prisma.message.findMany({
    orderBy: { externalId: 'asc' },
  });
};

// ---- 4. Thread/Parent ----

export const updateThreadAndParent = async (
  updates: UpdateThreadInput[],
): Promise<void> => {
  if (updates.length === 0) return;

  const values = updates.map(
    (u) => Prisma.sql`(${u.externalId}, ${u.parentId}, ${u.threadKey})`,
  );

  await prisma.$executeRaw`
    UPDATE "messages" AS m
    SET "parentId" = v.parent_id,
        "threadKey" = v.thread_key
    FROM (VALUES ${Prisma.join(values)})
      AS v(external_id, parent_id, thread_key)
    WHERE m."externalId" = v.external_id
  `;
};