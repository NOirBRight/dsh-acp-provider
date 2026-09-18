/**
 * Node-only append-only per-session JSONL history for native agent activity.
 *
 * One JSONL file per session under the caller-supplied root; each line is one
 * versioned record { v, seq, time, type, data }. One owner per history root:
 * concurrent writers can interleave batches and break seq contiguity, which
 * read() rejects as corruption, and a crash can leave a partial trailing line
 * that reads fail closed on without repairing. History files open with
 * O_NOFOLLOW and must be regular files, so a planted symlink is rejected and
 * never followed for read, write, or chmod.
 *
 * Sequence allocation is cached per session: the first append after process
 * startup validates the existing history once, and every later append costs
 * O(batch) instead of O(history). Each append still compares the opened file
 * against that cache by inode, size, and mtime, so a change made outside this
 * store (tampering, a torn write, another writer) is revalidated from disk and
 * still fails closed instead of being appended past. The residual blind spot is
 * a same-size in-place edit that also preserves the recorded mtime, which is
 * easier to hit on filesystems with coarse timestamps and costs O(history)
 * hashing to close. Appends are synchronous and state is keyed per session, so
 * one session's writes are serialized by construction and different sessions
 * never share a lock or a history scan.
 */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/** Fixed ceiling on records returned by one incremental read. */
export const EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS = 500
/** Fixed byte ceiling on the serialized records returned by one incremental read. */
export const EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_BYTES = 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

/** One durable event: a namespaced type plus its JSON-serializable data. */
export interface ExternalAgentActivityEvent {
  readonly type: string
  readonly data: unknown
}

/** One validated history line with replay order and wall-clock time. */
export interface ExternalAgentActivityRecord {
  readonly seq: number
  readonly time: string
  readonly type: string
  readonly data: unknown
}

/** History snapshot: schema version plus records in seq order. */
export interface ExternalAgentActivityHistory<TRecord extends ExternalAgentActivityRecord = ExternalAgentActivityRecord> {
  readonly version: number
  readonly records: readonly TRecord[]
}

/** One bounded incremental page: records strictly after the requested cursor in seq order. */
export interface ExternalAgentActivityPage<TRecord extends ExternalAgentActivityRecord = ExternalAgentActivityRecord> {
  readonly records: readonly TRecord[]
  /** Pass back as the next afterSeq: the last returned seq, or the requested cursor for an empty page. */
  readonly nextCursor: number
  /** True when the history holds further records after this page. */
  readonly hasMore: boolean
  /**
   * Present and true only when the history file is absent and afterSeq was
   * greater than 0: the cursor this caller was following cannot be satisfied
   * because the history no longer exists, so the consumer should resync instead
   * of treating the empty page as caught up. Omitted for an existing history,
   * including one with zero records, and for an absent history at afterSeq 0,
   * which stays an ordinary empty page because nothing was being followed yet.
   * Consumers that ignore the field keep the previous behavior.
   */
  readonly historyMissing?: boolean
}

/** Thrown by readAfter when the cursor is past the end of an existing history. */
export class ExternalAgentActivityCursorAheadError extends Error {
  /** Stable discriminator to branch on instead of matching the message text. */
  readonly kind = 'cursor-ahead'
  /** The requested exclusive cursor. */
  readonly afterSeq: number
  /** Complete records the existing history holds, always below afterSeq. */
  readonly historyLength: number

  /** Capture the requested cursor and the history length it exceeded.
   * @param afterSeq - Requested exclusive cursor.
   * @param historyLength - Complete records in the existing history.
   */
  constructor(afterSeq: number, historyLength: number) {
    super('External agent activity cursor ' + String(afterSeq) + ' is ahead of the ' + String(historyLength) + '-record history')
    this.name = 'ExternalAgentActivityCursorAheadError'
    this.afterSeq = afterSeq
    this.historyLength = historyLength
  }
}

/** Decode one history line, throwing fail-closed on any invalid field.
 * @param line - One raw JSONL history line.
 * @param seq - Expected 1-based position; records must stay contiguous.
 * @returns The validated record.
 */
export type ExternalAgentActivityDecoder<TRecord extends ExternalAgentActivityRecord = ExternalAgentActivityRecord> = (line: string, seq: number) => TRecord

/** Construction options; every field is required and nothing is guessed. */
export interface ExternalAgentActivityStoreOptions<TRecord extends ExternalAgentActivityRecord = ExternalAgentActivityRecord> {
  readonly rootDirectory: string
  readonly schemaVersion: number
  readonly decodeRecord: ExternalAgentActivityDecoder<TRecord>
}

/** File identity captured after a validated read or a completed append. */
interface HistoryStamp {
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

/** Cached per-session sequence and the file state it was validated against. */
interface SessionCursor {
  readonly nextSeq: number
  readonly stamp: HistoryStamp
}

/** Minimal durable store independent of runtime and auth directories. */
export class ExternalAgentActivityStore<TEvent extends ExternalAgentActivityEvent = ExternalAgentActivityEvent, TRecord extends ExternalAgentActivityRecord = ExternalAgentActivityRecord> {
  private readonly root: string
  private readonly version: number
  private readonly decode: ExternalAgentActivityDecoder<TRecord>
  private readonly cursors = new Map<string, SessionCursor>()
  private rootReady = false

  /** Capture the history root, schema version, and line decoder.
   * @param options - Explicit history root, schema version, and record decoder.
   */
  constructor(options: ExternalAgentActivityStoreOptions<TRecord>) {
    if (options.rootDirectory.trim() === '') throw new Error('External agent activity history requires a root directory')
    this.root = options.rootDirectory
    this.version = options.schemaVersion
    this.decode = options.decodeRecord
  }

  /** Append events for one session, assigning contiguous seq values.
   * Event bounds are per-event and do not bound history size. The session's
   * sequence comes from the per-session cursor, initialized by one validation
   * read on first use, so a batch costs O(batch) after that. Any failure drops
   * the cached cursor, so the next append revalidates the history from disk
   * before writing and a torn or corrupt file still fails closed. A history
   * root removed after the one-time setup is recreated once and the append
   * goes through, so the hoisted root setup cannot wedge the store.
   * @param sessionId - Required session id; hashed into the filename so it can never escape the root.
   * @param events - Durable typed events.
   * @returns Nothing; throws fail-closed on a corrupt existing file without overwriting it.
   */
  append(sessionId: string, events: readonly TEvent[]): void {
    requireSessionId(sessionId)
    if (events.length === 0) return
    this.ensureRoot()
    try {
      this.appendBatch(sessionId, events)
    } catch (error) {
      if (!isFileNotFound(error)) throw error
      this.rootReady = false
      this.ensureRoot()
      this.appendBatch(sessionId, events)
    }
  }

  private appendBatch(sessionId: string, events: readonly TEvent[]): void {
    const fd = openHistory(this.fileFor(sessionId), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    try {
      fchmodSync(fd, 0o600)
      const stamp = stampOf(fstatSync(fd))
      const cached = this.cursors.get(sessionId)
      if (cached !== undefined && !sameHistory(cached.stamp, stamp)) this.cursors.delete(sessionId)
      const next = this.cursors.get(sessionId)?.nextSeq ?? (this.read(sessionId).records.length + 1)
      const out = this.encode(next, events)
      let offset = 0
      while (offset < out.byteLength) offset += writeSync(fd, out, offset)
      this.cursors.set(sessionId, { nextSeq: next + events.length, stamp: stampOf(fstatSync(fd)) })
    } catch (error) {
      this.cursors.delete(sessionId)
      throw error
    } finally {
      closeSync(fd)
    }
  }

  /** Read one session history in seq order for bootstrap, binding, and resynchronization.
   * Validates every line, so it stays O(history); a successful read also primes
   * the session cursor for the appends that follow.
   * @param sessionId - Required session id.
   * @returns The schema version plus validated records; empty records for an unknown session.
   */
  read(sessionId: string): ExternalAgentActivityHistory<TRecord> {
    requireSessionId(sessionId)
    let fd: number
    try {
      fd = openHistory(this.fileFor(sessionId), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isFileNotFound(error)) return { version: this.version, records: [] }
      throw error
    }
    try {
      const stamp = stampOf(fstatSync(fd))
      const lines = readFileSync(fd, 'utf8').split(String.fromCharCode(10))
      if (lines.pop() !== '') throw corrupt('incomplete trailing record')
      const records = lines.map((line, index) => this.decode(line, index + 1))
      this.cursors.set(sessionId, { nextSeq: records.length + 1, stamp })
      return { version: this.version, records }
    } finally {
      closeSync(fd)
    }
  }

  /** Read at most one bounded page of records strictly after an exclusive cursor.
   * Skips the already-seen prefix without decoding it, so only the returned
   * records are parsed and corruption at or before the cursor is not
   * re-detected here; use read() to revalidate the whole history. A missing
   * history, including one deleted after a cursor was issued, is an empty page
   * carrying the requested cursor rather than an error; when afterSeq is
   * greater than 0 that page also sets historyMissing so the consumer can tell
   * a deleted history from an existing empty or short one. A cursor past the
   * end of an existing history throws the exported
   * ExternalAgentActivityCursorAheadError. The page always carries at least one
   * record when the history has one, even if that record alone exceeds the byte
   * budget; a full page reports hasMore instead of dropping the remaining records.
   * @param sessionId - Required session id.
   * @param afterSeq - Exclusive cursor; 0 starts at the first record.
   * @param limit - Requested record count, clamped to the fixed page limit.
   * @returns Ordered records, the cursor to pass next, and whether more remain.
   * @throws ExternalAgentActivityCursorAheadError - When afterSeq exceeds an existing history's record count.
   */
  readAfter(sessionId: string, afterSeq: number, limit: number): ExternalAgentActivityPage<TRecord> {
    requireSessionId(sessionId)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError('External agent activity cursor must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('External agent activity page limit must be a positive safe integer')
    let fd: number
    try {
      fd = openHistory(this.fileFor(sessionId), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isFileNotFound(error)) return missingHistoryPage(afterSeq)
      throw error
    }
    try {
      return this.readPage(fd, afterSeq, Math.min(limit, EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS))
    } finally {
      closeSync(fd)
    }
  }

  private readPage(fd: number, afterSeq: number, limit: number): ExternalAgentActivityPage<TRecord> {
    // ponytail: a page rescans the skipped prefix to find its cursor instead of keeping a seq-to-offset index; add one if a caught-up poll on a multi-megabyte history shows up in profiles.
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    const records: TRecord[] = []
    let carry: Buffer | undefined
    let line = 0
    let bytes = 0
    for (;;) {
      const size = readSync(fd, chunk, 0, chunk.byteLength, null)
      if (size === 0) break
      let start = 0
      for (;;) {
        const newline = start < size ? chunk.indexOf(10, start) : -1
        if (newline < 0 || newline >= size) break
        const tail = chunk.subarray(start, newline)
        const raw = carry === undefined ? tail : Buffer.concat([carry, tail])
        carry = undefined
        line += 1
        if (line > afterSeq) {
          if (records.length >= limit || (records.length > 0 && bytes + raw.byteLength > EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_BYTES)) {
            return { records, nextCursor: lastSeq(records, afterSeq), hasMore: true }
          }
          records.push(this.decode(raw.toString('utf8'), line))
          bytes += raw.byteLength
        }
        start = newline + 1
      }
      if (start < size) {
        const rest = Buffer.from(chunk.subarray(start, size))
        carry = carry === undefined ? rest : Buffer.concat([carry, rest])
      }
    }
    if (carry !== undefined && carry.byteLength > 0) throw corrupt('incomplete trailing record')
    if (afterSeq > line) throw new ExternalAgentActivityCursorAheadError(afterSeq, line)
    return { records, nextCursor: lastSeq(records, afterSeq), hasMore: false }
  }

  private encode(nextSeq: number, events: readonly TEvent[]): Buffer {
    const time = new Date().toISOString()
    return Buffer.from(events
      .map((event, index) => JSON.stringify({ v: this.version, seq: nextSeq + index, time, type: event.type, data: event.data }) + String.fromCharCode(10))
      .join(''), 'utf8')
  }

  private ensureRoot(): void {
    if (this.rootReady) return
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    this.rootReady = true
  }

  private fileFor(sessionId: string): string {
    return join(this.root, createHash('sha256').update(sessionId, 'utf8').digest('hex') + '.jsonl')
  }
}

function lastSeq<TRecord extends ExternalAgentActivityRecord>(records: readonly TRecord[], fallback: number): number {
  return records.length === 0 ? fallback : records[records.length - 1]!.seq
}

function missingHistoryPage<TRecord extends ExternalAgentActivityRecord>(afterSeq: number): ExternalAgentActivityPage<TRecord> {
  return afterSeq === 0
    ? { records: [], nextCursor: 0, hasMore: false }
    : { records: [], nextCursor: afterSeq, hasMore: false, historyMissing: true }
}

function requireSessionId(sessionId: string): void {
  if (sessionId.trim() === '') throw new Error('External agent activity history requires a session id')
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isTooManyLinks(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ELOOP'
}

function stampOf(stats: Stats): HistoryStamp {
  return { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs }
}

function sameHistory(left: HistoryStamp, right: HistoryStamp): boolean {
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function openHistory(path: string, flags: number, mode?: number): number {
  let fd: number
  try {
    fd = openSync(path, flags, mode)
  } catch (error) {
    if (isTooManyLinks(error)) throw new Error('External agent activity history must not be a symbolic link')
    throw error
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    throw corrupt('history path is not a regular file')
  }
  return fd
}

function corrupt(reason: string): Error {
  return new Error('External agent activity history is corrupt: ' + reason)
}
