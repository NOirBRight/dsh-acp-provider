/**
 * Node-only append-only per-session JSONL history for native agent activity.
 *
 * One JSONL file per session under the caller-supplied root; each line is one
 * versioned record { v, seq, time, type, data }. One owner per history root:
 * concurrent writers can interleave batches and break seq contiguity, which
 * read() rejects as corruption, and a crash can leave a partial trailing line
 * that read() fails closed on without repairing. History files open with
 * O_NOFOLLOW and must be regular files, so a planted symlink is rejected and
 * never followed for read, write, or chmod.
 */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

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

/** Minimal durable store independent of runtime and auth directories. */
export class ExternalAgentActivityStore<TEvent extends ExternalAgentActivityEvent = ExternalAgentActivityEvent, TRecord extends ExternalAgentActivityRecord = ExternalAgentActivityRecord> {
  private readonly root: string
  private readonly version: number
  private readonly decode: ExternalAgentActivityDecoder<TRecord>

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
   * Event bounds are per-event and do not bound history size.
   * @param sessionId - Required session id; hashed into the filename so it can never escape the root.
   * @param events - Durable typed events.
   * @returns Nothing; throws fail-closed on a corrupt existing file without overwriting it.
   */
  append(sessionId: string, events: readonly TEvent[]): void {
    requireSessionId(sessionId)
    if (events.length === 0) return
    const path = this.fileFor(sessionId)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    // ponytail: O(n) re-read per append to assign seq; track next seq in memory if append throughput matters
    const next = this.read(sessionId).records.length + 1
    const time = new Date().toISOString()
    const out = Buffer.from(events
      .map((event, index) => JSON.stringify({ v: this.version, seq: next + index, time, type: event.type, data: event.data }) + String.fromCharCode(10))
      .join(''), 'utf8')
    const fd = openHistory(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    try {
      fchmodSync(fd, 0o600)
      let offset = 0
      while (offset < out.byteLength) offset += writeSync(fd, out, offset)
    } finally {
      closeSync(fd)
    }
  }

  /** Read one session history in seq order.
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
      const lines = readFileSync(fd, 'utf8').split(String.fromCharCode(10))
      if (lines.pop() !== '') throw corrupt('incomplete trailing record')
      return { version: this.version, records: lines.map((line, index) => this.decode(line, index + 1)) }
    } finally {
      closeSync(fd)
    }
  }

  private fileFor(sessionId: string): string {
    return join(this.root, createHash('sha256').update(sessionId, 'utf8').digest('hex') + '.jsonl')
  }
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
