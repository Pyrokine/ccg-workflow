'use strict';

const fs = require('fs');
const path = require('path');
const { assertRuntimePath, ensureRuntimeDirectory } = require('./task-state-store.js');
const { fail } = require('./task-state-core.js');
const { fsyncDirectory } = require('./task-utils.js');

function filesHaveSameBytes(leftPath, rightPath, size) {
  let left;
  let right;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    left = fs.openSync(leftPath, flags);
    right = fs.openSync(rightPath, flags);
    if (!fs.fstatSync(left).isFile() || !fs.fstatSync(right).isFile()) return false;
    const leftBuffer = Buffer.alloc(64 * 1024);
    const rightBuffer = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < size;) {
      const length = Math.min(leftBuffer.length, size - offset);
      const leftBytes = fs.readSync(left, leftBuffer, 0, length, offset);
      const rightBytes = fs.readSync(right, rightBuffer, 0, length, offset);
      if (
        leftBytes !== length ||
        rightBytes !== length ||
        !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))
      ) {
        return false;
      }
      offset += length;
    }
    return true;
  } finally {
    closeBackupFiles([left, right]);
  }
}

function copyFileBackup(projectRoot, sourcePath, destinationPath) {
  const sourceStat = inspectMigrationSource(sourcePath);
  if (!sourceStat) return false;
  const relativeDestination = path.relative(projectRoot, destinationPath).replace(/\\/g, '/');
  assertRuntimePath(projectRoot, relativeDestination, { allowMissing: true, kind: 'file' });
  if (fs.existsSync(destinationPath)) {
    const destinationStat = fs.lstatSync(destinationPath);
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
      fail('MIGRATION_BACKUP_FAILED', `Migration backup is not a regular file: ${destinationPath}`, null, 3);
    }
    if (destinationStat.size !== sourceStat.size || !filesHaveSameBytes(sourcePath, destinationPath, sourceStat.size)) {
      fail('MIGRATION_BACKUP_CONFLICT', `Existing migration backup does not match source: ${destinationPath}`, null, 3);
    }
    return false;
  }
  try {
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    fsyncDirectory(path.dirname(destinationPath));
    return true;
  } catch (error) {
    fail(
      'MIGRATION_BACKUP_FAILED',
      `Cannot create migration backup: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
}

function backupLegacyTask(projectRoot, taskResult) {
  const backupDir = ensureRuntimeDirectory(projectRoot, `.ccg/migrations/v1/${taskResult.task.id}`);
  for (const name of ['task.json', 'context.jsonl', 'requirements.md', 'progress.md']) {
    copyFileBackup(projectRoot, path.join(taskResult.taskDir, name), path.join(backupDir, name));
  }
}

function closeBackupFiles(descriptors) {
  for (const descriptor of descriptors) {
    if (descriptor === undefined) continue;
    try {
      fs.closeSync(descriptor);
    } catch {
      // A read or comparison result is already available.
    }
  }
}

function inspectMigrationSource(sourcePath) {
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('MIGRATION_BACKUP_FAILED', `Cannot inspect migration source: ${sourcePath}`, null, 3);
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    fail('MIGRATION_BACKUP_FAILED', `Migration source is not a regular file: ${sourcePath}`, null, 3);
  return stat;
}

module.exports = { backupLegacyTask };
