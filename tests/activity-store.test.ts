/** Shared activity-store coverage with generic typed events. */
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { latestNativeSessionBinding } from '../src/contracts.js'
import {
  EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_BYTES,
  EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS,
  ExternalAgentActivityStore,
  type ExternalAgentActivityRecord,
} from '../src/activity-store.js'

const SCHEMA_VERSION = 7
type TestEvent = { readonly type: 'test/ready' | 'test/start' | 'test/update'; readonly data: Record<string, unknown> }
function decode(line: string, seq: number): ExternalAgentActivityRecord {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    throw new Error('test history is corrupt: line ' + String(seq) + ' is not JSON')
  }
  if (typeof value !== 'object' || value === null) throw new Error('test history is corrupt: line ' + String(seq) + ' is not an object')
  const record = value as Record<string, unknown>
  if (record.v !== SCHEMA_VERSION) throw new Error('test history is corrupt: line ' + String(seq) + ' has an unknown version')
  if (record.seq !== seq) throw new Error('test history is corrupt: line ' + String(seq) + ' breaks the sequence')
  if (typeof record.time !== 'string' || Number.isNaN(Date.parse(record.time))) throw new Error('test history is corrupt: line ' + String(seq) + ' has an invalid time')
  if (record.type !== 'test/ready' && record.type !== 'test/start' && record.type !== 'test/update') throw new Error('test history is corrupt: line ' + String(seq) + ' has an unknown type')
  return { seq, time: record.time, type: record.type, data: record.data }
}
function store(root: string): ExternalAgentActivityStore<TestEvent> {
  return new ExternalAgentActivityStore<TestEvent>({ rootDirectory: root, schemaVersion: SCHEMA_VERSION, decodeRecord: decode })
}
const ready: TestEvent = { type: 'test/ready', data: { provider: 'test' } }
const start: TestEvent = { type: 'test/start', data: { toolId: 'tool-1', status: 'running' } }
const update: TestEvent = { type: 'test/update', data: { toolId: 'tool-1', status: 'completed' } }
const updates = (count: number, from = 0): TestEvent[] => Array.from({ length: count }, (_, index) => ({ type: 'test/update', data: { index: from + index } }))
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function tempRoot(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'external-agent-activity-'))
  roots.push(sandbox)
  const root = join(sandbox, 'history')
  mkdirSync(root)
  return root
}
function onlyFile(root: string): string {
  const entries = readdirSync(root)
  expect(entries).toHaveLength(1)
  return join(root, entries[0]!)
}
function pathFor(root: string, sessionId: string): string {
  return join(root, createHash('sha256').update(sessionId, 'utf8').digest('hex') + '.jsonl')
}

describe('ExternalAgentActivityStore', () => {
  it('persists typed events and reads them back with contiguous seq', () => {
    const root = tempRoot()
    store(root).append('session-a', [ready, start, update])
    const history = store(root).read('session-a')
    expect(history.version).toBe(SCHEMA_VERSION)
    expect(history.records.map(record => record.seq)).toEqual([1, 2, 3])
    expect(history.records.map(record => record.type)).toEqual(['test/ready', 'test/start', 'test/update'])
    for (const record of history.records) expect(Number.isNaN(Date.parse(record.time))).toBe(false)
    expect(statSync(onlyFile(root)).mode & 0o777).toBe(0o600)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    store(root).append('session-a', [update])
    expect(store(root).read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4])
  })
  it('isolates sessions and reports unknown sessions as empty', () => {
    const root = tempRoot()
    store(root).append('session-a', [ready])
    store(root).append('session-b', [start, update])
    expect(store(root).read('session-a').records).toHaveLength(1)
    expect(store(root).read('session-b').records).toHaveLength(2)
    expect(store(root).read('session-unknown')).toEqual({ version: SCHEMA_VERSION, records: [] })
    expect(readdirSync(root)).toHaveLength(2)
  })
  it('keeps traversal session ids inside the root', () => {
    const root = tempRoot()
    const parentBefore = readdirSync(dirname(root)).sort()
    for (const evil of ['../../evil', '/abs/path', '..']) {
      store(root).append(evil, [ready])
      expect(store(root).read(evil).records).toHaveLength(1)
    }
    expect(readdirSync(root)).toHaveLength(3)
    expect(readdirSync(dirname(root)).sort()).toEqual(parentBefore)
  })
  it('rejects unknown schema versions without overwriting', () => {
    const root = tempRoot()
    store(root).append('session-a', [ready])
    const path = onlyFile(root)
    const tampered = readFileSync(path, 'utf8').replace('"v":7', '"v":999')
    expect(tampered).not.toBe(readFileSync(path, 'utf8'))
    writeFileSync(path, tampered)
    expect(() => store(root).read('session-a')).toThrow(/corrupt/)
    expect(readFileSync(path, 'utf8')).toBe(tampered)
  })
  it('rejects corrupt lines on read and append without overwriting', () => {
    const root = tempRoot()
    const cases: ReadonlyArray<readonly [string, (raw: string) => string]> = [
      ['broken-json', () => 'not-json\n'],
      ['missing-delimiter', raw => raw.slice(0, -1)],
      ['partial-line', raw => raw + '{"v":7,"seq":2'],
      ['bad-type', raw => raw.replace('test/ready', 'nope')],
    ]
    for (const [sessionId] of cases) store(root).append(sessionId, [ready])
    for (const [sessionId, tamper] of cases) {
      const path = pathFor(root, sessionId)
      const tampered = tamper(readFileSync(path, 'utf8'))
      writeFileSync(path, tampered)
      expect(() => store(root).read(sessionId)).toThrow(/corrupt/)
      expect(() => store(root).append(sessionId, [ready])).toThrow(/corrupt/)
      expect(readFileSync(path, 'utf8')).toBe(tampered)
    }
  })
  it('rejects symlinks without touching their targets', () => {
    const root = tempRoot()
    const target = join(root, 'target.jsonl')
    writeFileSync(target, 'sentinel')
    symlinkSync(target, pathFor(root, 'session-sym'))
    expect(() => store(root).read('session-sym')).toThrow(/symbolic link/)
    expect(() => store(root).append('session-sym', [ready])).toThrow(/symbolic link/)
    expect(readFileSync(target, 'utf8')).toBe('sentinel')
  })
  it('requires root directories and session ids', () => {
    expect(() => new ExternalAgentActivityStore<TestEvent>({ rootDirectory: '   ', schemaVersion: SCHEMA_VERSION, decodeRecord: decode })).toThrow(/root directory/)
    const root = tempRoot()
    expect(() => store(root).append('', [ready])).toThrow(/session id/)
    expect(() => store(root).read('')).toThrow(/session id/)
    expect(() => store(root).readAfter('', 0, 1)).toThrow(/session id/)
  })

  it('appends one schema-versioned line per event with contiguous seq and one timestamp', () => {
    const root = tempRoot()
    store(root).append('session-a', [ready, ...updates(3), update])
    const raw = readFileSync(pathFor(root, 'session-a'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').slice(0, -1)
    expect(lines).toHaveLength(5)
    const parsed = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    for (const [index, record] of parsed.entries()) {
      expect(Object.keys(record)).toEqual(['v', 'seq', 'time', 'type', 'data'])
      expect(record.v).toBe(SCHEMA_VERSION)
      expect(record.seq).toBe(index + 1)
    }
    expect(new Set(parsed.map(record => record.time)).size).toBe(1)
    expect(store(root).read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5])
    store(root).append('session-a', updates(2, 5))
    expect(store(root).read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
  it('continues an existing history after a store restart with exact order', () => {
    const root = tempRoot()
    const before = store(root)
    before.append('session-a', [ready, start])
    before.append('session-a', [update])
    const after = store(root)
    after.append('session-a', [start, ready])
    expect(after.read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5])
    expect(after.read('session-a').records.map(record => record.type)).toEqual(['test/ready', 'test/start', 'test/update', 'test/start', 'test/ready'])
    after.append('session-a', [update])
    expect(after.read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('initializes a session cursor once instead of re-reading history per append', () => {
    const root = tempRoot()
    let decodes = 0
    const counted = (line: string, seq: number): ExternalAgentActivityRecord => { decodes += 1; return decode(line, seq) }
    const activity = new ExternalAgentActivityStore<TestEvent>({ rootDirectory: root, schemaVersion: SCHEMA_VERSION, decodeRecord: counted })
    activity.append('session-a', [ready, start])
    expect(decodes).toBe(0)
    activity.append('session-a', [update])
    activity.append('session-a', [update])
    expect(decodes).toBe(0)
    expect(activity.read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4])
    expect(decodes).toBe(4)
    activity.append('session-a', [ready])
    expect(decodes).toBe(4)
    let restartDecodes = 0
    const restarted = new ExternalAgentActivityStore<TestEvent>({
      rootDirectory: root,
      schemaVersion: SCHEMA_VERSION,
      decodeRecord: (line, seq) => { restartDecodes += 1; return decode(line, seq) },
    })
    restarted.append('session-a', [ready])
    expect(restartDecodes).toBe(5)
    restarted.append('session-a', [ready])
    expect(restartDecodes).toBe(5)
    expect(restarted.read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
  it('keeps concurrent sessions ordered and independent from a long history', () => {
    const root = tempRoot()
    const activity = store(root)
    const long = 'session-long'
    activity.append(long, updates(200))
    const peers = ['session-a', 'session-b', 'session-c']
    for (let round = 0; round < 20; round++) {
      for (const peer of peers) activity.append(peer, [ready, start])
      activity.append(long, [update])
    }
    expect(activity.read(long).records.map(record => record.seq)).toEqual(Array.from({ length: 220 }, (_, index) => index + 1))
    for (const peer of peers) {
      const records = activity.read(peer).records
      expect(records.map(record => record.seq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
      expect(records.filter(record => record.type === 'test/start')).toHaveLength(20)
      expect(records.filter(record => record.type === 'test/ready')).toHaveLength(20)
    }
  })
  it('revalidates a warm cursor against a tampered history before appending', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready])
    const path = pathFor(root, 'session-a')
    const original = readFileSync(path, 'utf8')
    const shorter = original.replace('test/ready', 'nope')
    writeFileSync(path, shorter)
    expect(() => activity.append('session-a', [start])).toThrow(/corrupt/)
    expect(readFileSync(path, 'utf8')).toBe(shorter)
    writeFileSync(path, original)
    activity.append('session-a', [start])
    expect(activity.read('session-a').records.map(record => record.seq)).toEqual([1, 2])
    const sameSize = original.replace('test/ready', 'test/nope!')
    expect(sameSize).toHaveLength(original.length)
    writeFileSync(path, sameSize)
    expect(() => activity.append('session-a', [start])).toThrow(/corrupt/)
    expect(readFileSync(path, 'utf8')).toBe(sameSize)
  })
  it('revalidates a torn trailing write before appending again', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready])
    const path = pathFor(root, 'session-a')
    appendFileSync(path, '{"v":7,"seq":2')
    const torn = readFileSync(path, 'utf8')
    expect(() => activity.append('session-a', [start])).toThrow(/corrupt/)
    expect(readFileSync(path, 'utf8')).toBe(torn)
  })
  it('fails closed on a corrupt record inside a cursor page without repairing it', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready, start, update])
    const path = pathFor(root, 'session-a')
    const tampered = readFileSync(path, 'utf8').replace('test/start', 'test/nope')
    writeFileSync(path, tampered)
    expect(() => activity.readAfter('session-a', 0, 10)).toThrow(/corrupt/)
    expect(() => activity.readAfter('session-a', 1, 10)).toThrow(/corrupt/)
    expect(() => activity.read('session-a')).toThrow(/corrupt/)
    expect(readFileSync(path, 'utf8')).toBe(tampered)
  })
  it('recreates a history root removed after the one-time setup instead of wedging', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready])
    rmSync(root, { recursive: true, force: true })
    activity.append('session-a', [start])
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(pathFor(root, 'session-a')).mode & 0o777).toBe(0o600)
    const records = activity.read('session-a').records
    expect(records.map(record => record.seq)).toEqual([1])
    expect(records.map(record => record.type)).toEqual(['test/start'])
    activity.append('session-a', [update])
    expect(activity.read('session-a').records.map(record => record.seq)).toEqual([1, 2])
  })
  it('rejects a symlink planted after a cached append without touching its target', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-sym', [ready])
    const path = pathFor(root, 'session-sym')
    const target = join(root, 'target.jsonl')
    writeFileSync(target, 'sentinel')
    rmSync(path)
    symlinkSync(target, path)
    expect(() => activity.append('session-sym', [start])).toThrow(/symbolic link/)
    expect(() => activity.readAfter('session-sym', 0, 10)).toThrow(/symbolic link/)
    expect(readFileSync(target, 'utf8')).toBe('sentinel')
  })
  it('rejects a non-regular file at the history path', () => {
    const root = tempRoot()
    const activity = store(root)
    const path = pathFor(root, 'session-dir')
    mkdirSync(path)
    expect(() => activity.read('session-dir')).toThrow(/not a regular file/)
    expect(() => activity.readAfter('session-dir', 0, 10)).toThrow(/not a regular file/)
    expect(() => activity.append('session-dir', [ready])).toThrow()
    expect(readdirSync(path)).toHaveLength(0)
  })
  it.skipIf(isRoot)('surfaces write errors without advancing or losing durable records', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready])
    const path = pathFor(root, 'session-a')
    const before = readFileSync(path, 'utf8')
    chmodSync(path, 0o400)
    expect(() => activity.append('session-a', [start])).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
    chmodSync(path, 0o600)
    activity.append('session-a', [start])
    const records = activity.read('session-a').records
    expect(records.map(record => record.seq)).toEqual([1, 2])
    expect(records.map(record => record.type)).toEqual(['test/ready', 'test/start'])
  })
  it('reads bounded cursor pages in order with a next cursor and continuation', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready, start, update, ready, update])
    const reader = store(root)
    const first = reader.readAfter('session-a', 0, 2)
    expect(first.records.map(record => record.seq)).toEqual([1, 2])
    expect(first.records.map(record => record.type)).toEqual(['test/ready', 'test/start'])
    expect(first.nextCursor).toBe(2)
    expect(first.hasMore).toBe(true)
    const second = reader.readAfter('session-a', first.nextCursor, 2)
    expect(second.records.map(record => record.seq)).toEqual([3, 4])
    expect(second.nextCursor).toBe(4)
    expect(second.hasMore).toBe(true)
    const third = reader.readAfter('session-a', second.nextCursor, 2)
    expect(third.records.map(record => record.seq)).toEqual([5])
    expect(third.nextCursor).toBe(5)
    expect(third.hasMore).toBe(false)
    expect(reader.readAfter('session-a', third.nextCursor, 2)).toEqual({ records: [], nextCursor: 5, hasMore: false })
    activity.append('session-a', [start])
    const next = reader.readAfter('session-a', third.nextCursor, 10)
    expect(next.records.map(record => record.seq)).toEqual([6])
    expect(next.nextCursor).toBe(6)
    expect(next.hasMore).toBe(false)
    expect(reader.read('session-a').records.map(record => record.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(reader.readAfter('session-unknown', 0, 10)).toEqual({ records: [], nextCursor: 0, hasMore: false })
    expect(reader.readAfter('session-unknown', 4, 10)).toEqual({ records: [], nextCursor: 4, hasMore: false })
  })
  it('clamps pages to fixed limits and never drops a record larger than the byte budget', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-many', updates(EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS + 2))
    const page = activity.readAfter('session-many', 0, 10_000)
    expect(page.records).toHaveLength(EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS)
    expect(page.nextCursor).toBe(EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS)
    expect(page.hasMore).toBe(true)
    const rest = activity.readAfter('session-many', page.nextCursor, 10_000)
    expect(rest.records.map(record => record.seq)).toEqual([EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS + 1, EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_RECORDS + 2])
    expect(rest.hasMore).toBe(false)
    const huge: TestEvent = { type: 'test/update', data: { text: 'x'.repeat(EXTERNAL_AGENT_ACTIVITY_MAX_PAGE_BYTES) } }
    activity.append('session-huge', [huge, ready])
    const oversized = activity.readAfter('session-huge', 0, 10)
    expect(oversized.records).toHaveLength(1)
    expect(oversized.nextCursor).toBe(1)
    expect(oversized.hasMore).toBe(true)
    const oversizedRest = activity.readAfter('session-huge', oversized.nextCursor, 10)
    expect(oversizedRest.records.map(record => record.type)).toEqual(['test/ready'])
    expect(oversizedRest.nextCursor).toBe(2)
    expect(oversizedRest.hasMore).toBe(false)
  })
  it('fails closed on an incomplete trailing record in cursor reads', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready])
    const path = pathFor(root, 'session-a')
    appendFileSync(path, '{"v":7,"seq":2')
    const torn = readFileSync(path, 'utf8')
    expect(() => activity.readAfter('session-a', 0, 10)).toThrow(/corrupt/)
    expect(() => activity.readAfter('session-a', 1, 10)).toThrow(/corrupt/)
    expect(() => activity.read('session-a')).toThrow(/corrupt/)
    expect(readFileSync(path, 'utf8')).toBe(torn)
  })
  it('rejects a cursor ahead of the history and invalid page arguments', () => {
    const root = tempRoot()
    const activity = store(root)
    activity.append('session-a', [ready, start])
    expect(() => activity.readAfter('session-a', 3, 10)).toThrow(/ahead/)
    for (const cursor of [-1, 1.5, Number.NaN, Number.MAX_VALUE]) {
      expect(() => activity.readAfter('session-a', cursor, 1)).toThrow(/cursor/)
    }
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => activity.readAfter('session-a', 0, limit)).toThrow(/page limit/)
    }
  })
})

describe('latestNativeSessionBinding', () => {
  const ready = 'vendor/session-ready'
  it('returns the latest ready ref and a legacy fallback without a ref', () => {
    const records = [
      { type: 'other', data: {} },
      { type: ready, data: { provider: 'vendor' } },
      { type: ready, data: { provider: 'vendor', ref: { provider: 'vendor', session: 'dsh', nativeSession: 'n1' } } },
    ]
    expect(latestNativeSessionBinding(records, 'dsh', ready, 'vendor')).toEqual({
      provider: 'vendor', session: 'dsh', nativeSession: 'n1',
    })
    expect(latestNativeSessionBinding(records.slice(0, 2), 'dsh', ready, 'vendor')).toEqual({
      provider: 'vendor', session: 'dsh',
    })
    expect(latestNativeSessionBinding(records, 'dsh', 'missing', 'vendor')).toBeUndefined()
  })

  it('rejects a ready ref that belongs to another session', () => {
    const records = [{ type: ready, data: { ref: { provider: 'vendor', session: 'dsh' } } }]
    expect(() => latestNativeSessionBinding(records, 'other', ready, 'vendor')).toThrow('another DSH session')
    expect(() => latestNativeSessionBinding([{ type: ready, data: { ref: 'dsh' } }], 'dsh', ready, 'vendor')).toThrow('another DSH session')
  })

  it('brands a resume cursor from a decoder-shaped ref', () => {
    const records = [{ type: ready, data: { ref: { provider: 'vendor', session: 'dsh', resumeCursor: { provider: 'vendor', value: 'cursor-1' } } } }]
    expect(latestNativeSessionBinding(records, 'dsh', ready, 'vendor')).toEqual({
      provider: 'vendor', session: 'dsh', resumeCursor: { provider: 'vendor', value: 'cursor-1' },
    })
  })

  it('rejects a binding or cursor owned by another provider', () => {
    expect(() => latestNativeSessionBinding([
      { type: ready, data: { ref: { provider: 'other', session: 'dsh' } } },
    ], 'dsh', ready, 'vendor')).toThrow('another provider')
    expect(() => latestNativeSessionBinding([
      { type: ready, data: { ref: { provider: 'vendor', session: 'dsh', resumeCursor: { provider: 'other', value: 'cursor-1' } } } },
    ], 'dsh', ready, 'vendor')).toThrow('another provider')
  })
})
