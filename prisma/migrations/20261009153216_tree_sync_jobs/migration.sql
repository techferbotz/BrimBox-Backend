-- CreateEnum
CREATE TYPE "NodeKind" AS ENUM ('FOLDER', 'FILE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "syncFloor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "syncSeq" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Node" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "parentId" UUID,
    "kind" "NodeKind" NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "mimeType" TEXT,
    "trashedAt" TIMESTAMP(3),
    "trashRootId" UUID,
    "deletedAt" TIMESTAMP(3),
    "syncSeq" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "name" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "summary" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("name","periodKey")
);

-- CreateIndex
CREATE INDEX "Node_userId_parentId_nameKey_idx" ON "Node"("userId", "parentId", "nameKey");

-- CreateIndex
CREATE INDEX "Node_userId_syncSeq_id_idx" ON "Node"("userId", "syncSeq", "id");

-- CreateIndex
CREATE INDEX "Node_userId_trashedAt_idx" ON "Node"("userId", "trashedAt");

-- CreateIndex
CREATE INDEX "Node_trashedAt_idx" ON "Node"("trashedAt");

-- CreateIndex
CREATE INDEX "Node_deletedAt_idx" ON "Node"("deletedAt");

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Node"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
