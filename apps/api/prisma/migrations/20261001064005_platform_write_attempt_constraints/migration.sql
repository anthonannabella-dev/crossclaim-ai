-- CreateIndex
CREATE INDEX "PlatformWriteAttempt_organizationId_status_nextRetryAt_idx" ON "PlatformWriteAttempt"("organizationId", "status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "PlatformWriteAttempt_organizationId_status_reconcileNextAt_idx" ON "PlatformWriteAttempt"("organizationId", "status", "reconcileNextAt");

-- CreateIndex
CREATE INDEX "PlatformWriteAttempt_organizationId_targetKind_targetId_idx" ON "PlatformWriteAttempt"("organizationId", "targetKind", "targetId");

-- CreateIndex
CREATE INDEX "PlatformWriteAttempt_organizationId_createdAt_idx" ON "PlatformWriteAttempt"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformWriteAttempt_organizationId_idempotencyKey_key" ON "PlatformWriteAttempt"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformWriteAttempt_organizationId_approvalId_key" ON "PlatformWriteAttempt"("organizationId", "approvalId");

