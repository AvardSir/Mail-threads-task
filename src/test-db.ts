import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$connect();
  console.log('Connected to database');
  // Создаём тестовую запись в AppState (если нет)
  await prisma.appState.upsert({
    where: { key: 'stage' },
    update: {},
    create: { key: 'stage', value: 'idle' },
  });
  console.log('AppState initialized');
  await prisma.$disconnect();
}

main();