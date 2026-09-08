/** Shared activity-store coverage with generic typed events. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalAgentActivityStore, type ExternalAgentActivityRecord } from '../src/activity-store.js'

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
  })
})
