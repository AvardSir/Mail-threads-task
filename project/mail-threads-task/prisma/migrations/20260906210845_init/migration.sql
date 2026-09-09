-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "externalId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "subject" TEXT NOT NULL,
    "fromAddr" TEXT NOT NULL,
    "toAddrs" TEXT[],
    "sentAt" TIMESTAMP(3) NOT NULL,
    "parentId" TEXT,
    "threadKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_state" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "app_state_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "messages_externalId_key" ON "messages"("externalId");
