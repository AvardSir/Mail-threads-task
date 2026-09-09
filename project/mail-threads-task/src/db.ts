import { PrismaClient, Prisma } from '@prisma/client';
import logger from './logger'; // если логгер уже настроен, либо используйте console

// Можно вынести в отдельный файл, но для простоты оставим здесь
export interface MessageInput {
  external_id: string;
  in_reply_to?: string | null;
  references?: string[]; // может быть пустым или отсутствовать
  subject: string;
  from_addr: string;
  to_addrs: string[];
  sent_at: Date | string; // API может вернуть строку, мы преобразуем
}

export interface MessageRecord extends MessageInput {
  id: number;
  parent_id?: string | null;
  thread_key?: string | null;
  // остальные поля из схемы
}

export const prisma = new PrismaClient();

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
});

export async function getState(key: string): Promise<string | null> {
  try {
    const record = await prisma.appState.findUnique({
      where: { key },
      select: { value: true },
    });
    return record?.value ?? null;
  } catch (error) {
    logger.error(`Error getting state for key "${key}":`, error);
    throw error;
  }
}

export async function setState(key: string, value: string): Promise<void> {
  try {
    await prisma.appState.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  } catch (error) {
    logger.error(`Error setting state for key "${key}" to "${value}":`, error);
    throw error;
  }
}

export async function saveMessages(messages: MessageInput[]): Promise<void> {
  if (messages.length === 0) return;

  try {
    // Преобразуем даты в объекты Date, если они пришли как строки
    const data: Prisma.MessageCreateManyInput[] = messages.map((msg) => ({
      external_id: msg.external_id,
      in_reply_to: msg.in_reply_to ?? null,
      references: msg.references ?? [],
      subject: msg.subject,
      from_addr: msg.from_addr,
      to_addrs: msg.to_addrs,
      sent_at: new Date(msg.sent_at),
      // parent_id и thread_key пока null, они будут заполнены позже
      parent_id: null,
      thread_key: null,
    }));

    // Разбиваем на чанки по 1000 записей, чтобы не превысить лимиты запроса
    const chunkSize = 1000;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      await prisma.message.createMany({
        data: chunk,
        skipDuplicates: true, // игнорируем записи с дублирующимся external_id
      });
    }
  } catch (error) {
    logger.error('Error saving messages:', error);
    throw error;
  }
}

export async function getAllMessages(): Promise<MessageRecord[]> {
  try {
    const messages = await prisma.message.findMany({
      orderBy: { id: 'asc' }, // порядок не важен, но для стабильности
    });
    return messages as MessageRecord[];
  } catch (error) {
    logger.error('Error fetching all messages:', error);
    throw error;
  }
}

export async function updateThreadAndParent(
  updates: { id: number; parentId: string | null; threadKey: string }[]
): Promise<void> {
  if (updates.length === 0) return;

  try {
    // Формируем массив значений для VALUES
    const values = updates
      .map((u) => `(${u.id}, ${u.parentId === null ? 'NULL' : `'${u.parentId}'`}, '${u.threadKey}')`)
      .join(',');

    const query = `
      UPDATE "Message"
      SET "parent_id" = data."parentId",
          "thread_key" = data."threadKey"
      FROM (VALUES ${values}) AS data("id", "parentId", "threadKey")
      WHERE "Message"."id" = data."id"
    `;

    await prisma.$executeRawUnsafe(query);
  } catch (error) {
    logger.error('Error batch updating thread and parent:', error);
    throw error;
  }
}

export async function savePage(
  messages: MessageInput[],
  newCursor: string | null,
  stage: 'loading' | 'processing' | 'done'
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Сохраняем сообщения
    if (messages.length > 0) {
      const data = messages.map((msg) => ({
        external_id: msg.external_id,
        in_reply_to: msg.in_reply_to ?? null,
        references: msg.references ?? [],
        subject: msg.subject,
        from_addr: msg.from_addr,
        to_addrs: msg.to_addrs,
        sent_at: new Date(msg.sent_at),
        parent_id: null,
        thread_key: null,
      }));
      await tx.message.createMany({ data, skipDuplicates: true });
    }

    // Обновляем курсор
    if (newCursor !== null) {
      await tx.appState.upsert({
        where: { key: 'cursor' },
        update: { value: newCursor },
        create: { key: 'cursor', value: newCursor },
      });
    } else {
      // Если курсор null, удаляем запись или устанавливаем пустое значение
      // Можно просто оставить как null, но тогда getState вернёт null
      // В зависимости от логики можно удалить:
      await tx.appState.delete({ where: { key: 'cursor' } }).catch(() => {});
    }

    // Обновляем stage
    await tx.appState.upsert({
      where: { key: 'stage' },
      update: { value: stage },
      create: { key: 'stage', value: stage },
    });
  });
}
