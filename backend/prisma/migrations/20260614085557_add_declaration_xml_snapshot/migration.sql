-- 归档调档:新增申报报文快照字段,用于留存「申报当时的原始报文」供调档/海关稽查
ALTER TABLE "BatchGroup" ADD COLUMN "declarationXml" TEXT;
ALTER TABLE "BatchGroup" ADD COLUMN "declarationSnapshotAt" TIMESTAMP(3);