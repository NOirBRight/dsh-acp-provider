/** Retained native-history store coverage over a controllable fake adapter. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_HISTORY_MAX_FOLLOW_UP_PAGES,
  NATIVE_HISTORY_POLL_MS,
  StaleNativeHistoryCursorError,
  getNativeHistoryStore,
  type NativeHistoryAdapter,
  type NativeHistoryPage,
} from '../src/native-history.js'

interface TestRecord { readonly seq: number }
interface TestState { readonly records: TestRecord[] }
interface TestSnapshot { readonly records: readonly TestRecord[]; readonly error?: string }

interface PendingLoad {
  readonly cursor: number
  readonly signal: AbortSignal
  readonly resolve: (page: NativeHistoryPage<TestRecord>) => void
  readonly reject: (error: unknown) => void
}

/** Adapter whose every read stays pending until the test settles it. */
function fakeAdapter(): {
  readonly adapter: NativeHistoryAdapter<TestRecord, TestState, TestSnapshot>
  readonly loads: PendingLoad[]
  readonly stateCount: () => number
} {
  const loads: PendingLoad[] = []
  let states = 0
  return {
    loads,
    stateCount: () => states,
    adapter: {
      load: (cursor, signal) => new Promise<NativeHistoryPage<TestRecord>>((resolve, reject) => {
        loads.push({ cursor, signal, resolve, reject })
      }),
      createState: () => { states += 1; return { records: [] } },
      apply: (state, records) => { state.records.push(...records) },
      snapshot: (state, error) => ({ records: [...state.records], ...(error === undefined ? {} : { error }) }),
    },
  }
}

const record = (seq: number): TestRecord => ({ seq })
const page = (records: readonly TestRecord[], nextCursor: number, hasMore = false): NativeHistoryPage<TestRecord> => ({ records, nextCursor, hasMore })
const sequences = (snapshot: TestSnapshot): number[] => snapshot.records.map(item => item.seq)

/** Drain the microtask chain one poll runs through, without advancing the fake clock. */
async function settle(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve()
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('getNativeHistoryStore', () => {
  it('pages from cursor 0, publishes each page, and retains the cache across unsubscribe', async () => {
    const { adapter, loads } = fakeAdapter()
    const store = getNativeHistoryStore({}, 'session-1', adapter)
    const seen: TestSnapshot[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()))
    expect(loads).toHaveLength(1)
    expect(loads[0].cursor).toBe(0)
    loads[0].resolve(page([record(1), record(2)], 2))
    await settle()
    expect(sequences(store.getSnapshot())).toEqual([1, 2])
    // A page publishes immediately and a poll that changed publishes once more.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe(store.getSnapshot())
    unsubscribe()
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS * 3)
    expect(loads).toHaveLength(1)
    // A later consumer sees cached history immediately and resumes only the missing pages.
    const unsubscribeAgain = store.subscribe(() => {})
    expect(sequences(store.getSnapshot())).toEqual([1, 2])
    expect(loads).toHaveLength(2)
    expect(loads[1].cursor).toBe(2)
    unsubscribeAgain()
  })

  it('spends one page budget per poll and continues the backlog from the retained cursor', async () => {
    const { adapter, loads } = fakeAdapter()
    const store = getNativeHistoryStore({}, 's', adapter)
    const unsubscribe = store.subscribe(() => {})
    for (let index = 0; index < NATIVE_HISTORY_MAX_FOLLOW_UP_PAGES; index++) {
      expect(loads).toHaveLength(index + 1)
      expect(loads[index].cursor).toBe(index)
      loads[index].resolve(page([record(index + 1)], index + 1, true))
      await settle()
    }
    expect(loads).toHaveLength(NATIVE_HISTORY_MAX_FOLLOW_UP_PAGES)
    expect(sequences(store.getSnapshot())).toEqual([1, 2, 3, 4])
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS)
    expect(loads).toHaveLength(NATIVE_HISTORY_MAX_FOLLOW_UP_PAGES + 1)
    expect(loads[4].cursor).toBe(4)
    unsubscribe()
  })

  it('rebuilds the fold from cursor 0 when the retained cursor is stale', async () => {
    const { adapter, loads, stateCount } = fakeAdapter()
    const store = getNativeHistoryStore({}, 's', adapter)
    const unsubscribe = store.subscribe(() => {})
    loads[0].resolve(page([record(1)], 1))
    await settle()
    expect(sequences(store.getSnapshot())).toEqual([1])
    const states = stateCount()
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS)
    expect(loads).toHaveLength(2)
    expect(loads[1].cursor).toBe(1)
    loads[1].reject(new StaleNativeHistoryCursorError('cursor refused'))
    await settle()
    expect(store.getSnapshot().records).toEqual([])
    expect(stateCount()).toBeGreaterThan(states)
    expect(loads).toHaveLength(3)
    expect(loads[2].cursor).toBe(0)
    loads[2].resolve(page([record(7)], 7))
    await settle()
    expect(sequences(store.getSnapshot())).toEqual([7])
    unsubscribe()
  })

  it('keeps the snapshot identity when a poll changes nothing', async () => {
    const { adapter, loads } = fakeAdapter()
    const store = getNativeHistoryStore({}, 's', adapter)
    const initial = store.getSnapshot()
    const unsubscribe = store.subscribe(() => {})
    loads[0].resolve(page([], 0))
    await settle()
    expect(store.getSnapshot()).toBe(initial)
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS)
    loads[1].resolve(page([], 0))
    await settle()
    expect(store.getSnapshot()).toBe(initial)
    unsubscribe()
  })

  it('publishes a poll failure and clears it on the next successful poll', async () => {
    const { adapter, loads } = fakeAdapter()
    const store = getNativeHistoryStore({}, 's', adapter)
    const unsubscribe = store.subscribe(() => {})
    loads[0].reject(new Error('history unavailable'))
    await settle()
    expect(store.getSnapshot().error).toBe('history unavailable')
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS)
    loads[1].resolve(page([record(1)], 1))
    await settle()
    expect(store.getSnapshot().error).toBeUndefined()
    expect(sequences(store.getSnapshot())).toEqual([1])
    unsubscribe()
  })

  it('refresh aborts the active read, discards its late page, and pages again from 0', async () => {
    const { adapter, loads } = fakeAdapter()
    const store = getNativeHistoryStore({}, 's', adapter)
    const unsubscribe = store.subscribe(() => {})
    loads[0].resolve(page([record(1)], 1))
    await settle()
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS)
    expect(loads).toHaveLength(2)
    const superseded = loads[1]
    store.refresh()
    expect(superseded.signal.aborted).toBe(true)
    expect(loads).toHaveLength(3)
    expect(loads[2].cursor).toBe(0)
    loads[2].resolve(page([record(5)], 5))
    await settle()
    superseded.resolve(page([record(99)], 99))
    await settle()
    expect(sequences(store.getSnapshot())).toEqual([5])
    unsubscribe()
  })

  it('keeps one entry per scope and session, each with its own empty snapshot', () => {
    const scope = {}
    const store = getNativeHistoryStore(scope, 's1', fakeAdapter().adapter)
    expect(getNativeHistoryStore(scope, 's1', fakeAdapter().adapter).getSnapshot()).toBe(store.getSnapshot())
    expect(getNativeHistoryStore({}, 's1', fakeAdapter().adapter).getSnapshot()).not.toBe(store.getSnapshot())
    expect(getNativeHistoryStore(scope, 's2', fakeAdapter().adapter).getSnapshot()).not.toBe(store.getSnapshot())
    expect(store.getSnapshot().records).toEqual([])
  })

  it('shares one poll between listeners and stops it with the last unsubscribe', async () => {
    const { adapter, loads } = fakeAdapter()
    const store = getNativeHistoryStore({}, 's', adapter)
    const first: number[] = []
    const second: number[] = []
    const unsubscribeFirst = store.subscribe(() => first.push(store.getSnapshot().records.length))
    const unsubscribeSecond = store.subscribe(() => second.push(store.getSnapshot().records.length))
    expect(loads).toHaveLength(1)
    loads[0].resolve(page([record(1)], 1))
    await settle()
    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBe(first.length)
    expect(first.at(-1)).toBe(1)
    expect(second.at(-1)).toBe(1)
    unsubscribeFirst()
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS)
    expect(loads).toHaveLength(2)
    unsubscribeSecond()
    loads[1].resolve(page([], 1))
    await settle()
    await vi.advanceTimersByTimeAsync(NATIVE_HISTORY_POLL_MS * 3)
    expect(loads).toHaveLength(2)
  })
})
