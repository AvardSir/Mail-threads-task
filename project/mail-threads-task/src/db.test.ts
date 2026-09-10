import { prisma } from './prisma';
import {
  getState,
  setState,
  saveMessages,
  getAllMessages,
  updateThreadAndParent,
} from './db';

describe('db', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "State", "Message" RESTART IDENTITY CASCADE;'
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // группы тестов ниже

export const getState = async (key: string): Promise<string | null> => {
  const row = await prisma.state.findUnique({ where: { key } });
  return row?.value ?? null;
};

export const setState = async (key: string, value: string): Promise<void> => {
  await prisma.state.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
};

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

import { Prisma } from '@prisma/client';

export const updateThreadAndParent = async (
  updates: UpdateThreadInput[]
): Promise<void> => {
  if (updates.length === 0) return;

  const values = updates.map(
    (u) => Prisma.sql`(${u.externalId}, ${u.parentId}, ${u.threadKey})`
  );

  await prisma.$executeRaw`
    UPDATE "Message" AS m
    SET "parentId" = v.parent_id,
        "threadKey" = v.thread_key
    FROM (VALUES ${Prisma.join(values)})
      AS v(external_id, parent_id, thread_key)
    WHERE m."externalId" = v.external_id
  `;
};


});