import { PGlite } from '@electric-sql/pglite';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Database = PGlite;

export class DatabaseLockError extends Error {
  readonly code = 'DATABASE_LOCKED';
  constructor(message: string) { super(message); this.name = 'DatabaseLockError'; }
}
interface LockOwner { version: 1; pid: number; token: string; createdAt: string; }
function isErrorCode(error: unknown, code: string) { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const owner: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!owner || typeof owner !== 'object') return null;
    const value = owner as Partial<LockOwner>;
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string' || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.token) || typeof value.createdAt !== 'string') return null;
    return value as LockOwner;
  } catch (error) { if (error instanceof SyntaxError || isErrorCode(error, 'ENOENT')) return null; throw error; }
}
function isDemonstrablyStopped(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return isErrorCode(error, 'ESRCH'); }
}
async function acquireDatabaseLock(dataPath: string): Promise<() => Promise<void>> {
  // Keep the lock outside PostgreSQL's directory: a new database must start in
  // an empty directory. Never rely on PGlite to protect independent processes.
  const lockPath = `${resolve(dataPath)}.lock`;
  const owner: LockOwner = { version: 1, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  await mkdir(dirname(lockPath), { recursive: true });
  async function createLock() {
    const file = await open(lockPath, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(owner)); }
    finally { await file.close(); }
  }
  try { await createLock(); }
  catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
    const previous = await readOwner(lockPath);
    const guidance = `Lock file: ${lockPath}. Stop the other backend before restarting. If no backend is running, inspect the lock and remove only this lock file manually; never delete the database directory.`;
    if (!previous) throw new DatabaseLockError(`The database lock is unknown, incomplete or malformed. It was left untouched. ${guidance}`);
    if (!isDemonstrablyStopped(previous.pid)) throw new DatabaseLockError(`The database is already open, or access to its owning process (PID ${previous.pid}) cannot be verified. ${guidance}`);
    // A token-specific claim serializes stale recovery. Without this claim, two
    // starters could both observe the stale lock and one could unlink the new
    // owner's lock after the other had successfully recovered it.
    const recoveryPath = `${lockPath}.${previous.token}.recovering`;
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch (recoveryError) {
      if (isErrorCode(recoveryError, 'EEXIST')) throw new DatabaseLockError(`Another startup may be recovering this database lock. Retry after it exits. Recovery marker: ${recoveryPath}. ${guidance}`);
      throw recoveryError;
    }
    try {
      await recovery.writeFile(JSON.stringify(owner));
      const current = await readOwner(lockPath);
      if (!current || current.token !== previous.token || current.pid !== previous.pid || !isDemonstrablyStopped(current.pid)) throw new DatabaseLockError(`The database lock changed during recovery. It was left untouched. ${guidance}`);
      await unlink(lockPath);
      try { await createLock(); }
      catch (creationError) {
        if (isErrorCode(creationError, 'EEXIST')) throw new DatabaseLockError(`Another startup acquired the database while its old lock was being recovered. ${guidance}`);
        throw creationError;
      }
    } finally { await recovery.close(); await unlink(recoveryPath); }
  }
  return async () => {
    const current = await readOwner(lockPath);
    // Never remove a replacement, malformed lock, or another instance's file.
    if (current?.token === owner.token && current.pid === owner.pid) await unlink(lockPath);
  };
}

/** Omit path for a completely isolated, in-memory PostgreSQL database. */
export async function openDatabase(path?: string): Promise<Database> {
  const releaseLock = path ? await acquireDatabaseLock(path) : async () => undefined;
  let db: PGlite | undefined;
  try {
    db = new PGlite(path);
    await db.waitReady;
    const migration = await readFile(fileURLToPath(new URL('./migrations/001_initial.sql', import.meta.url)), 'utf8');
    await db.transaction(async tx => {
      await tx.exec(migration);
      await tx.query('INSERT INTO schema_migrations (version, applied_at) VALUES (1, $1) ON CONFLICT (version) DO NOTHING', [new Date().toISOString()]);
      // A process restart cannot safely resume a remote inference request. Keep the
      // original transcript and expose a retryable failure instead of a stuck job.
      await tx.query(`UPDATE jobs SET status = 'failed', error = 'Processing was interrupted when the server stopped. Your transcript is safe; run analysis again.', error_code = 'INTERRUPTED', progress = 0 WHERE status IN ('queued', 'processing')`);
    });
    const originalClose = db.close.bind(db);
    let closing: Promise<void> | undefined;
    db.close = () => closing ??= (async () => { await originalClose(); await releaseLock(); })();
    return db;
  } catch (error) {
    if (db) await db.close();
    await releaseLock();
    throw error;
  }
}
