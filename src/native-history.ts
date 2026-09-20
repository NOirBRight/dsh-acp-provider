/** Retained, incrementally paged native activity history for one consumer.
 *
 * One fold, one cursor, and one snapshot per scope and session: the store pages
 * from cursor 0 on its first read, then requests only records after its retained
 * cursor, so a long history never transfers in one unbounded read and epoch, row
 * routing and text merging survive page boundaries. Each accepted page publishes
 * immediately, an unchanged poll keeps the snapshot identity, and a stale cursor
 * resets the fold and pages again from 0.
 *
 * The module owns retention, paging, resynchronization, and subscription. A
 * vendor supplies the bounded read (`load`), the fold (`createState`, `apply`),
 * and the published snapshot; it imports no framework and no host module, so it
 * is safe to load in a browser bundle and usable with a plain
 * subscribe/getSnapshot pair for useSyncExternalStore.
 */

/** Poll interval for the session-scoped native history subscription. */
export const NATIVE_HISTORY_POLL_MS = 1000

/** Page budget for one poll: a deeper backlog continues on the next poll. */
export const NATIVE_HISTORY_MAX_FOLLOW_UP_PAGES = 4

/** One bounded page: records strictly after the requested cursor, in order. */
export interface NativeHistoryPage<Record> {
  readonly records: readonly Record[]
  /** Pass back as the next cursor: the last returned record's cursor, or the requested cursor for an empty page. */
  readonly nextCursor: number
  /** True when the history holds further records after this page. */
  readonly hasMore: boolean
}

/**
 * Host history no longer contains the retained cursor.
 *
 * A vendor's `load` throws this — from a stale-cursor error code or from a page
 * that reports the history as deleted — and the store rebuilds its fold from
 * cursor 0 instead of displaying a silently truncated history.
 */
export class StaleNativeHistoryCursorError extends Error {
  /** Capture the host message describing the refused cursor.
   * @param message - Host-provided reason for the resynchronization.
   */
  constructor(message: string) {
    super(message)
    this.name = 'StaleNativeHistoryCursorError'
  }
}

/** Vendor seam: bounded paging plus the retained fold behind one snapshot. */
export interface NativeHistoryAdapter<Record, State, Snapshot> {
  /** Read one bounded page strictly after `cursor`; throw {@link StaleNativeHistoryCursorError} when the cursor is gone. */
  load(cursor: number, signal: AbortSignal): Promise<NativeHistoryPage<Record>>
  /** Fresh empty fold state: called once per entry and again on every reset. */
  createState(): State
  /** Apply one ordered page to the retained state; later pages continue it. */
  apply(state: State, records: readonly Record[]): void
  /** Immutable snapshot of the retained state; `error` describes a failed poll. */
  snapshot(state: State, error?: string): Snapshot
}

/** Shared subscription over one scope and session. */
export interface NativeHistoryStore<Snapshot> {
  /** Add one listener; the first starts polling immediately and the last stops the timer and the active read. */
  subscribe(listener: () => void): () => void
  /** Current snapshot; its identity is stable while no page and no poll error changed it. */
  getSnapshot(): Snapshot
  /** Drop the retained fold and page again from cursor 0. */
  refresh(): void
}

interface NativeHistoryEntry<Record, State, Snapshot> {
  readonly adapter: NativeHistoryAdapter<Record, State, Snapshot>
  state: State
  snapshot: Snapshot
  /** Error carried by the published snapshot, compared so an unchanged poll keeps snapshot identity. */
  error: string | undefined
  /** Exclusive cursor of the retained fold: 0 until the first page lands. */
  cursor: number
  /** True after an accepted page establishes the fold, even if a later page is cancelled. */
  foldEstablished: boolean
  readonly listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController | undefined
}

/** One entry per live scope and session: keying by the scope object keeps
 * concurrent connections from sharing or resurrecting each other's history, so a
 * reconnecting connection pages from cursor 0 on its own scope.
 * Unsubscribed entries retain history but no timer or active request.
 * ponytail: histories live for the scope's lifetime; add inactive-session LRU
 * eviction if browsing many large sessions makes retained memory significant.
 */
const nativeHistoryStores = new WeakMap<object, Map<string, unknown>>()

function entryFor<Record, State, Snapshot>(
  scope: object,
  sessionId: string,
  adapter: NativeHistoryAdapter<Record, State, Snapshot>,
): NativeHistoryEntry<Record, State, Snapshot> {
  let bySession = nativeHistoryStores.get(scope)
  if (bySession === undefined) {
    bySession = new Map()
    nativeHistoryStores.set(scope, bySession)
  }
  // One scope supplies one adapter family, so the erased cache value narrows
  // back to the caller's own types.
  let entry = bySession.get(sessionId) as NativeHistoryEntry<Record, State, Snapshot> | undefined
  if (entry === undefined) {
    // Fresh state and a fresh empty snapshot per entry: no empty snapshot is
    // shared, so an entry's identity is its own from the first read.
    const state = adapter.createState()
    entry = {
      adapter,
      state,
      snapshot: adapter.snapshot(state),
      error: undefined,
      cursor: 0,
      foldEstablished: false,
      listeners: new Set(),
      timer: undefined,
      controller: undefined,
    }
    bySession.set(sessionId, entry)
  }
  return entry
}

function notifyEntry<Record, State, Snapshot>(entry: NativeHistoryEntry<Record, State, Snapshot>): void {
  for (const listener of [...entry.listeners]) listener()
}

function resetRetainedFold<Record, State, Snapshot>(entry: NativeHistoryEntry<Record, State, Snapshot>): void {
  entry.state = entry.adapter.createState()
  entry.cursor = 0
}

/** Apply bounded pages after the retained cursor.
 * Each non-empty page publishes the fold immediately so a long history cannot
 * hold the consumer on one unbounded transfer. A poll that still has more stops
 * here: the next poll continues from the cursor instead of rereading.
 * @returns True when at least one record changed the state.
 */
async function followNativeHistory<Record, State, Snapshot>(
  entry: NativeHistoryEntry<Record, State, Snapshot>,
  controller: AbortController,
): Promise<boolean> {
  let changed = false
  for (let page = 0; page < NATIVE_HISTORY_MAX_FOLLOW_UP_PAGES; page++) {
    const next = await entry.adapter.load(entry.cursor, controller.signal)
    // A superseded read never publishes: refresh and resubscribe abandon it.
    if (entry.controller !== controller) return changed
    entry.foldEstablished = true
    if (next.records.length === 0) {
      entry.cursor = next.nextCursor
      return changed
    }
    changed = true
    entry.adapter.apply(entry.state, next.records)
    entry.cursor = next.nextCursor
    entry.snapshot = entry.adapter.snapshot(entry.state)
    entry.error = undefined
    notifyEntry(entry)
    if (!next.hasMore) return changed
  }
  return changed
}

async function pollNativeHistory<Record, State, Snapshot>(entry: NativeHistoryEntry<Record, State, Snapshot>): Promise<void> {
  if (entry.controller !== undefined || entry.listeners.size === 0) return
  const controller = new AbortController()
  entry.controller = controller
  let changed = false
  let error: string | undefined
  try {
    try {
      if (!entry.foldEstablished) resetRetainedFold(entry)
      changed = await followNativeHistory(entry, controller)
    } catch (caught) {
      if (!(caught instanceof StaleNativeHistoryCursorError)) throw caught
      // The host history no longer contains this cursor: page again from 0.
      if (entry.controller !== controller) return
      resetRetainedFold(entry)
      entry.foldEstablished = false
      // Publish the empty fold immediately so a deleted history cannot keep
      // previous rows.
      entry.snapshot = entry.adapter.snapshot(entry.state)
      entry.error = undefined
      notifyEntry(entry)
      changed = true
      changed = (await followNativeHistory(entry, controller)) || changed
    }
  } catch (caught) {
    if (entry.controller !== controller) return
    error = caught instanceof Error ? caught.message : 'Native activity history is unavailable'
  } finally {
    if (entry.controller !== controller) return
    entry.controller = undefined
  }
  // An unchanged poll keeps the snapshot identity, so a consumer only re-renders
  // on real activity.
  if (changed || error !== entry.error) {
    entry.snapshot = entry.adapter.snapshot(entry.state, error)
    entry.error = error
  }
  notifyEntry(entry)
  scheduleNativeHistory(entry)
}

function scheduleNativeHistory<Record, State, Snapshot>(entry: NativeHistoryEntry<Record, State, Snapshot>): void {
  if (entry.listeners.size === 0) return
  if (entry.timer !== undefined) return
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    void pollNativeHistory(entry)
  }, NATIVE_HISTORY_POLL_MS)
}

/**
 * Session-scoped abortable subscription over retained native history: one poll
 * loop per scope and session no matter how many consumers mount, so trailing
 * records after a turn ends still arrive while any native view stays mounted.
 * Late tool updates never move rows: the vendor's fold partitions on the first
 * observation. Refresh and resubscribe cancel the active read and start a new
 * one, so a superseded promise can never stall the loop.
 * @param scope - Stable object scoping the retained cache; reuse one instance per connection.
 * @param sessionId - DSH session scoping the history read.
 * @param adapter - Paging and fold seams; the first adapter seen for the entry is retained.
 * @returns Shared subscription, snapshot, and refresh seams.
 */
export function getNativeHistoryStore<Record, State, Snapshot>(
  scope: object,
  sessionId: string,
  adapter: NativeHistoryAdapter<Record, State, Snapshot>,
): NativeHistoryStore<Snapshot> {
  const entry = entryFor(scope, sessionId, adapter)
  return {
    subscribe: (listener: () => void): (() => void) => {
      entry.listeners.add(listener)
      if (entry.listeners.size === 1) void pollNativeHistory(entry)
      else scheduleNativeHistory(entry)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0) {
          if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined }
          entry.controller?.abort()
          entry.controller = undefined
          // Keep the fold and cursor together so navigation displays cached
          // history immediately and resumes only the missing pages.
        }
      }
    },
    getSnapshot: (): Snapshot => entry.snapshot,
    refresh: (): void => {
      entry.controller?.abort()
      entry.controller = undefined
      if (entry.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined }
      // The next poll pages from cursor 0 and swaps the fold in as pages arrive.
      entry.foldEstablished = false
      if (entry.listeners.size > 0) void pollNativeHistory(entry)
    },
  }
}
