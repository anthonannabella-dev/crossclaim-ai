import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { env } from '../config/env';
import { getMinio } from '../config/minio';
import { logger } from '../config/logger';

const execAsync = promisify(exec);

const BACKUP_BUCKET = 'database-backups';
const BACKUP_RETENTION_DAYS = 30;

async function ensureBackupBucket() {
  const minio = getMinio();
  if (!minio) return false;
  try {
    const exists = await minio.bucketExists(BACKUP_BUCKET);
    if (!exists) {
      await minio.makeBucket(BACKUP_BUCKET);
      logger.info(`[Backup] Created bucket: ${BACKUP_BUCKET}`);
    }
    return true;
  } catch (err) {
    logger.error('[Backup] Failed to ensure backup bucket', err);
    return false;
  }
}

export async function runDatabaseBackup(): Promise<boolean> {
  const config = env();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `customs-saas-${timestamp}.sql.gz`;
  const tmpDir = '/tmp/backups';

  try {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const tmpFile = path.join(tmpDir, filename);

    // Parse DATABASE_URL to extract connection components
    const dbUrl = new URL(config.DATABASE_URL);

    // Run pg_dump (requires postgresql-client in container)
    const { stderr } = await execAsync(
      `pg_dump -h ${dbUrl.hostname} -p ${dbUrl.port || 5432} -U ${dbUrl.username} -d ${dbUrl.pathname.slice(1)} --no-owner --no-acl | gzip > "${tmpFile}"`,
      {
        env: { ...process.env, PGPASSWORD: dbUrl.password },
        timeout: 300_000, // 5 min timeout
      }
    );

    if (stderr && !stderr.includes('WARNING')) {
      logger.warn(`[Backup] pg_dump stderr: ${stderr}`);
    }

    // Check file size
    const stat = fs.statSync(tmpFile);
    if (stat.size === 0) {
      throw new Error('Backup file is empty');
    }

    logger.info(`[Backup] pg_dump completed: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);

    // Upload to MinIO
    const minio = getMinio();
    if (minio) {
      await ensureBackupBucket();
      await minio.fPutObject(BACKUP_BUCKET, filename, tmpFile);
      logger.info(`[Backup] Uploaded to MinIO: ${BACKUP_BUCKET}/${filename}`);
    } else {
      // Fallback: copy to a local backup directory
      const localBackupDir = path.join(process.cwd(), 'backups');
      if (!fs.existsSync(localBackupDir)) {
        fs.mkdirSync(localBackupDir, { recursive: true });
      }
      fs.copyFileSync(tmpFile, path.join(localBackupDir, filename));
      logger.info(`[Backup] Saved locally: ${filename}`);
    }

    // Clean up temp file
    fs.unlinkSync(tmpFile);

    // Clean up old backups
    await cleanupOldBackups();

    return true;
  } catch (err: any) {
    logger.error(`[Backup] Failed: ${err.message}`);
    return false;
  }
}

async function cleanupOldBackups() {
  const minio = getMinio();
  const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    if (minio) {
      const objects = await minio.listObjects(BACKUP_BUCKET, '', true);
      for await (const obj of objects) {
        if (obj.name && obj.lastModified && obj.lastModified < cutoff) {
          await minio.removeObject(BACKUP_BUCKET, obj.name);
          logger.info(`[Backup] Deleted old backup: ${obj.name}`);
        }
      }
    }
  } catch (err) {
    logger.warn('[Backup] Failed to cleanup old backups', err);
  }
}

// Restore function (for emergencies)
export async function restoreDatabase(backupFilename: string): Promise<boolean> {
  const config = env();
  const tmpDir = '/tmp/backups';
  const tmpFile = path.join(tmpDir, backupFilename);

  try {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const minio = getMinio();
    if (minio) {
      await minio.fGetObject(BACKUP_BUCKET, backupFilename, tmpFile);
    } else {
      const localPath = path.join(process.cwd(), 'backups', backupFilename);
      if (!fs.existsSync(localPath)) {
        throw new Error(`Backup file not found: ${backupFilename}`);
      }
      fs.copyFileSync(localPath, tmpFile);
    }

    const dbUrl = new URL(config.DATABASE_URL);

    await execAsync(
      `gunzip -c "${tmpFile}" | psql -h ${dbUrl.hostname} -p ${dbUrl.port || 5432} -U ${dbUrl.username} -d ${dbUrl.pathname.slice(1)}`,
      {
        env: { ...process.env, PGPASSWORD: dbUrl.password },
        timeout: 600_000, // 10 min timeout for restore
      }
    );

    fs.unlinkSync(tmpFile);
    logger.info(`[Backup] Restored from: ${backupFilename}`);
    return true;
  } catch (err: any) {
    logger.error(`[Backup] Restore failed: ${err.message}`);
    return false;
  }
}
