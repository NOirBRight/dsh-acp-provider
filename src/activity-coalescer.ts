/** Bounded per-session coalescing for provider-owned native activity.
 *
 * Transient records (text deltas and a running tool row's output growth) are
 * merged in memory and written as one durable batch, so a fast native turn no
 * longer causes one history append per delta. Every other record keeps today's
 * semantics: it is written before anything that follows it, and it flushes the
 * records it followed, so session readiness, audit, trajectory discovery, user
 * answers, usage, tool starts and every tool lifecycle change — including a
 * terminal completed/failed state — can never be reordered behind buffered text
 * or delayed behind the window.
 *
 * Each session buffer is bounded independently by three ceilings: buffered
 * records, one text record, and the serialized bytes of the whole buffer.
 * Crossing any of them forces a flush; a required record is never dropped.
 *
 * The module is vendor-free: a codec normalizes the provider's durable events
 * into the records the merge policy understands and rebuilds them for the sink.
 * Apart from that codec, the injected sink, and the clock it is pure — no
 * filesystem, no transport, no host imports — so a recording sink and a fake
 * timer fully determine its behavior. Events must be JSON-serializable: the byte
 * ceiling charges their serialized UTF-8 size.
 */
const encoder = new TextEncoder()

/** Transient delivery window; a closed paragraph still flushes immediately. */
export const ACTIVITY_COALESCE_WINDOW_MS = 400
/** Hard ceiling on buffered records per session; reaching it forces a flush. */
export const ACTIVITY_MAX_PENDING_RECORDS = 64
/** Hard ceiling on one text record; a longer delta starts a new pending record. */
export const ACTIVITY_MAX_TEXT_CHARS = 8192
/** Fixed ceiling on the serialized bytes buffered for one session.
 *
 * The record and text ceilings bound how many records and characters may wait,
 * not their size: JSON escaping can turn one character into six bytes, and a
 * tool row carries input, output and error. Crossing this ceiling forces a
 * flush, never a dropped record. It sits above the largest record the per-record
 * limits can produce (ACTIVITY_MAX_TEXT_CHARS, and the vendor's tool text
 * truncation), so flushing can always restore the budget. */
export const ACTIVITY_MAX_PENDING_BYTES = 256 * 1024
/** Non-growing updates a pending tool row absorbs before it is written anyway, so
 * a progress line that only redraws in place still advances for the reader. */
export const ACTIVITY_TOOL_SKIP_FLUSH = 32

/** Durable write seam: one call per batch, throwing fail-closed like today. */
export interface ActivityCoalescerSink<Event> {
  append(sessionId: string, events: readonly Event[]): void
}

/** One text record normalized for coalescing.
 *
 * `key` is the vendor's stable merge key: only adjacent records with an equal
 * key fold, and the fields of the record that opened the merge are the ones
 * rebuilt on flush, so a key must cover every field two foldable deltas share.
 * `fields` carries the vendor's other text fields verbatim.
 */
export interface CoalescibleTextRecord {
  readonly kind: 'text'
  readonly key: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly text: string
}

/** One running tool record normalized for coalescing.
 *
 * `fields` holds the row's non-output fields, folded field-wise: a later present
 * value wins and an omitted one never erases the buffered value. `output` is the
 * one cumulative field whose growth merges without materializing a record, and
 * `error` is tracked beside it. A terminal status must not decode to a record:
 * it is an ordering barrier and is durable on arrival.
 */
export interface CoalescibleToolRecord {
  readonly kind: 'tool'
  readonly toolId: string
  readonly status: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly output?: string
  readonly error?: unknown
}

/** One normalized record: the shape the merge policy below operates on. */
export type CoalescibleActivityRecord = CoalescibleTextRecord | CoalescibleToolRecord

/** Vendor mapping between durable events and the records coalescing merges. */
export interface ActivityCoalescerCodec<Event> {
  /** Normalize one durable event; `undefined` marks an ordering barrier, written on arrival. */
  decode(event: Event): CoalescibleActivityRecord | undefined
  /** Rebuild one durable event from a record, merged records included. */
  encode(record: CoalescibleActivityRecord): Event
}

/** Construction seams: the durable sink, the vendor codec, and the window. */
export interface ActivityCoalescerOptions<Event> {
  /** Durable writer; must throw (not reject) so failures reach the turn. */
  readonly sink: ActivityCoalescerSink<Event>
  /** Vendor mapping between durable events and coalescing records. */
  readonly codec: ActivityCoalescerCodec<Event>
  /** Maximum time a transient record may stay buffered. */
  readonly windowMs?: number
}

interface TextPending {
  readonly kind: 'text'
  readonly key: string
  readonly fields: Readonly<Record<string, unknown>>
  text: string
  /** Serialized bytes of this record, kept so the buffer total stays incremental. */
  bytes: number
}

interface ToolPending {
  readonly kind: 'tool'
  readonly toolId: string
  readonly status: string
  readonly fields: Readonly<Record<string, unknown>>
  readonly output: string | undefined
  readonly error: unknown
  /** Output length of the first update this record absorbed. */
  readonly base: number
  /** Non-growing updates folded into this record since it last carried progress. */
  skipped: number
  /** Serialized bytes of this record, kept so the buffer total stays incremental. */
  bytes: number
}

type Pending = TextPending | ToolPending

interface SessionBuffer {
  readonly sessionId: string
  queue: Pending[]
  /** Serialized bytes of `queue`, so the byte ceiling check is O(1) per append. */
  bytes: number
  timer: ReturnType<typeof setTimeout> | undefined
  /** A timer-driven flush failed; the next caller-owned operation rethrows it. */
  deferred: Error | undefined
}

/** Serialized size of one durable event, the unit the byte ceiling counts. */
function recordBytes<Event>(event: Event): number {
  return encoder.encode(JSON.stringify(event)).byteLength
}

/** Serialized bytes one appended string value adds to a record, escaping included. */
function escapedBytes(value: string): number {
  return encoder.encode(JSON.stringify(value)).byteLength - 2
}

/**
 * Whether buffered text has reached a paragraph or closed-code-block boundary.
 *
 * The window is a ceiling, not a delay: text that already forms a visible block
 * is written now, so streaming still shows the first paragraph promptly. Only a
 * fence that is still open defers, because its remainder is still being typed.
 */
function atTextBoundary(text: string): boolean {
  if (/\n[ \t]*\n/.test(text)) return true
  if (!text.startsWith('```')) return false
  const fence = text.indexOf('\n')
  if (fence === -1) return false
  const closer = text.indexOf('\n```', fence)
  return closer !== -1 && /^\n?[ \t]*$/.test(text.slice(closer + 4))
}

/** Undefined matches only undefined; every other value compares by its JSON form.
 *
 * The fold keeps a prior value when an update omits a field, so an omitted field
 * must never compare equal to a present one.
 */
function sameValue(left: unknown, right: unknown): boolean {
  return left === undefined || right === undefined
    ? left === right
    : JSON.stringify(left) === JSON.stringify(right)
}

/** Whether every field of both records matches under {@link sameValue}. */
function sameFields(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): boolean {
  const names = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const name of names) if (!sameValue(next[name], previous[name])) return false
  return true
}

/** Whether an update carries only values the pending row already holds; an omitted field never blocks a merge. */
function carriesKnownFields(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): boolean {
  for (const [name, value] of Object.entries(next)) {
    if (value !== undefined && !sameValue(value, previous[name])) return false
  }
  return true
}

/** Field-wise fold that reproduces folding both updates in order. */
function foldFields(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const folded: Record<string, unknown> = { ...previous }
  for (const [name, value] of Object.entries(next)) folded[name] = value ?? previous[name]
  return folded
}

/**
 * Whether one tool update can be folded into the buffered record for its row as
 * unbounded, order-preserving growth.
 *
 * The mergeable change is output that extends the string already buffered:
 * terminal output is cumulative, so the merged record folds to the same state as
 * the updates it replaces while keeping the first update's fields. A status,
 * name, ownership or location change materializes a record instead, so a
 * lifecycle transition is never hidden behind the window. A redraw that does not
 * extend the buffered value is handled by the bounded replacement policy below:
 * the latest row is retained and emitted after a finite skip count, so terminal
 * redraws cannot flood persistence.
 */
function toolMergeable(pending: ToolPending, next: CoalescibleToolRecord): boolean {
  if (next.toolId !== pending.toolId || next.status !== pending.status) return false
  if (!carriesKnownFields(pending.fields, next.fields)) return false
  const output = next.output ?? ''
  return output.length > pending.base && output.startsWith(pending.output ?? '')
}

/** Field-wise merge that reproduces folding both updates in order. */
function mergeToolUpdate(pending: ToolPending, next: CoalescibleToolRecord): ToolPending {
  return {
    kind: 'tool',
    toolId: next.toolId,
    status: next.status,
    fields: foldFields(pending.fields, next.fields),
    output: next.output ?? pending.output,
    error: next.error ?? pending.error,
    base: pending.base,
    skipped: 0,
    bytes: pending.bytes,
  }
}

/**
 * Whether an update repeats the pending row field for field, so folding it in
 * leaves the folded row unchanged.
 *
 * Undefined matches only undefined: the fold keeps a prior value when an update
 * omits a field, so absorbing an update that omits one would erase it from the
 * durable row instead of preserving the state the stream folded to.
 */
function repeatsPendingRow(pending: ToolPending, next: CoalescibleToolRecord): boolean {
  return next.status === pending.status
    && sameFields(pending.fields, next.fields)
    && sameValue(next.output, pending.output)
    && sameValue(next.error, pending.error)
}

/** A same-row replacement can wait for the finite repaint bound. */
function repaintMergeable(pending: ToolPending, next: CoalescibleToolRecord): boolean {
  return next.toolId === pending.toolId
    && next.status === pending.status
    && sameFields(pending.fields, next.fields)
    && (next.output !== undefined || next.error !== undefined)
}

/** Materialize one pending record back into its normalized record. */
function toRecord(pending: Pending): CoalescibleActivityRecord {
  return pending.kind === 'tool'
    ? {
      kind: 'tool',
      toolId: pending.toolId,
      status: pending.status,
      fields: pending.fields,
      output: pending.output,
      error: pending.error,
    }
    : { kind: 'text', key: pending.key, fields: pending.fields, text: pending.text }
}

/**
 * Per-session bounded activity buffer with ordering barriers.
 *
 * Construct once per activity store and route every append through it: the
 * barriers only hold if all writers share the same buffer.
 */
export class ActivityCoalescer<Event> {
  private readonly sink: ActivityCoalescerSink<Event>
  private readonly codec: ActivityCoalescerCodec<Event>
  private readonly windowMs: number
  private readonly sessions = new Map<string, SessionBuffer>()

  /** Capture the durable sink and the vendor codec.
   * @param options - Durable sink, coalescing codec, and optional window override.
   */
  constructor(options: ActivityCoalescerOptions<Event>) {
    this.sink = options.sink
    this.codec = options.codec
    this.windowMs = options.windowMs ?? ACTIVITY_COALESCE_WINDOW_MS
  }

  /**
   * Route one batch of durable events for one session.
   *
   * Coalescible records join the buffer; any other record — a terminal tool
   * state included — is an ordering barrier that materializes the buffer first
   * and is then written on arrival. A previous failed flush stays fail-closed:
   * nothing is retried and the original error is rethrown.
   * @param sessionId - DSH session owning the history.
   * @param events - Durable events in publish order.
   */
  append(sessionId: string, events: readonly Event[]): void {
    let buffer = this.sessions.get(sessionId)
    for (const event of events) {
      if (buffer?.deferred !== undefined) throw buffer.deferred
      const record = this.codec.decode(event)
      if (record === undefined) {
        // Every non-coalescible record is an ordering barrier, including a
        // terminal tool state and the session-ready record that opens the next
        // native epoch.
        if (buffer !== undefined && buffer.queue.length > 0) this.flush(sessionId)
        this.sink.append(sessionId, [event])
        continue
      }
      buffer ??= this.open(sessionId)
      if (buffer.queue.length >= ACTIVITY_MAX_PENDING_RECORDS) this.flush(sessionId)
      // Charge the arrival before it joins the buffer: when it would cross the
      // byte ceiling, what is buffered is written first and the arrival starts a
      // new record instead. Nothing is ever dropped to fit.
      const bytes = recordBytes(event)
      this.reserve(buffer, bytes)
      const bounded = record.kind === 'text'
        ? this.bufferText(buffer, record, bytes)
        : this.bufferToolUpdate(buffer, record, bytes)
      // A boundary or skip-count flush writes the record just buffered, so the
      // appended content is already durable and still in emitted order.
      if (bounded) this.flush(sessionId)
      else this.schedule(buffer)
    }
  }

  /**
   * Write every buffered record for one session now.
   *
   * An empty queue still reports a deferred timer-flush failure: the batch that
   * failed is gone, but its error is owed to this caller-owned operation.
   * @param sessionId - DSH session whose buffer must materialize.
   */
  flush(sessionId: string): void {
    const buffer = this.sessions.get(sessionId)
    if (buffer === undefined) return
    if (buffer.queue.length === 0) {
      if (buffer.deferred !== undefined) throw buffer.deferred
      return
    }
    const batch = buffer.queue
    buffer.queue = []
    buffer.bytes = 0
    try {
      // Drop the timer first: a throwing sink must not leave a live timer that
      // re-enters the same failed batch.
      buffer.deferred = undefined
      this.clearTimer(buffer)
      this.sink.append(sessionId, batch.map(pending => this.codec.encode(toRecord(pending))))
    } catch (error) {
      buffer.deferred = error instanceof Error ? error : new Error('Native activity flush failed')
      throw buffer.deferred
    }
  }

  /** Flush every session; used before adapter teardown.
   *
   * One session's failure never abandons another's buffered records: every
   * buffer is attempted and the first failure is rethrown afterwards.
   * @returns The ids that had buffered records, for diagnostics.
   */
  flushAll(): readonly string[] {
    const flushed: string[] = []
    let failure: unknown
    for (const [sessionId, buffer] of [...this.sessions]) {
      if (buffer.queue.length === 0 && buffer.deferred === undefined) continue
      flushed.push(sessionId)
      try {
        this.flush(sessionId)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
    return flushed
  }

  /**
   * Flush one session and drop its buffer; called when the session is disposed.
   * A pending flush failure — deferred or fresh — is reported, then the buffer
   * is dropped either way.
   * @param sessionId - DSH session being disposed.
   */
  release(sessionId: string): void {
    const buffer = this.sessions.get(sessionId)
    if (buffer === undefined) return
    this.clearTimer(buffer)
    try {
      this.flush(sessionId)
    } finally {
      this.sessions.delete(sessionId)
    }
  }

  /** Flush every session and drop all buffers; called on adapter reset.
   * A flush failure is rethrown after every buffer was attempted and dropped.
   */
  reset(): void {
    try {
      this.flushAll()
    } finally {
      for (const buffer of this.sessions.values()) this.clearTimer(buffer)
      this.sessions.clear()
    }
  }

  /** Buffered record count for one session, for tests and diagnostics. */
  pendingCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.queue.length ?? 0
  }

  /** Buffered serialized bytes for one session, the total the byte ceiling bounds. */
  pendingBytes(sessionId: string): number {
    return this.sessions.get(sessionId)?.bytes ?? 0
  }

  private open(sessionId: string): SessionBuffer {
    const buffer: SessionBuffer = { sessionId, queue: [], bytes: 0, timer: undefined, deferred: undefined }
    this.sessions.set(sessionId, buffer)
    return buffer
  }

  /** Serialized size of one pending record once its codec rebuilt it. */
  private recordSize(pending: Pending): number {
    return recordBytes(this.codec.encode(toRecord(pending)))
  }

  /**
   * Hold `bytes` in one session buffer, writing the buffer out first when the
   * per-session serialized ceiling would be crossed.
   *
   * Called before an arrival joins or grows the buffer, so a merged record
   * cannot push the buffer past the ceiling. Crossing it always means a flush,
   * never a dropped record; a lone record larger than the ceiling is still
   * buffered and written, because the per-record limits keep that from being
   * reachable in practice.
   * @param buffer - Session buffer that must hold the arrival.
   * @param bytes - Serialized size of the arrival, charged before it is applied.
   */
  private reserve(buffer: SessionBuffer, bytes: number): void {
    if (buffer.bytes + bytes <= ACTIVITY_MAX_PENDING_BYTES) return
    if (buffer.queue.length === 0) return
    // The flushed tail is gone, so a merge finds no record to fold into and
    // starts a new one: the arrival is never reflected onto a written row.
    this.flush(buffer.sessionId)
  }

  /** Merge one delta into the pending tail, or start a new record for it.
   * @param buffer - Session buffer that owns the queue tail.
   * @param record - Decoded text delta.
   * @param bytes - Serialized size of the arrival, charged by the caller.
   * @returns Whether the merged text reached a paragraph or closed code block.
   */
  private bufferText(buffer: SessionBuffer, record: CoalescibleTextRecord, bytes: number): boolean {
    // Only the queue tail may merge: a record emitted between two deltas must
    // stay between them, or the fold would concatenate across it.
    const last = buffer.queue.at(-1)
    const pending = last?.kind === 'text' && last.key === record.key ? last : undefined
    if (pending !== undefined && pending.text.length + record.text.length <= ACTIVITY_MAX_TEXT_CHARS) {
      const growth = escapedBytes(record.text)
      pending.text += record.text
      pending.bytes += growth
      buffer.bytes += growth
      return atTextBoundary(pending.text)
    }
    buffer.queue.push({ kind: 'text', key: record.key, fields: record.fields, text: record.text, bytes })
    buffer.bytes += bytes
    return atTextBoundary(record.text)
  }

  /** Merge one tool update into the pending tail, or start a new record for it.
   * @param buffer - Session buffer that owns the queue tail.
   * @param record - Decoded native tool update; never a terminal state.
   * @param bytes - Serialized size of the arrival, charged by the caller.
   * @returns Whether the row hit its skip-count flush and must be written now.
   */
  private bufferToolUpdate(buffer: SessionBuffer, record: CoalescibleToolRecord, bytes: number): boolean {
    // Same tail rule: a tool update may only fold into the row's own latest
    // record while nothing else was emitted after it.
    const last = buffer.queue.at(-1)
    const pending = last?.kind === 'tool' && last.toolId === record.toolId ? last : undefined
    if (pending !== undefined && toolMergeable(pending, record)) {
      const merged = mergeToolUpdate(pending, record)
      merged.bytes = this.recordSize(merged)
      const growth = merged.bytes - pending.bytes
      buffer.bytes += growth
      buffer.queue[buffer.queue.length - 1] = merged
      return false
    }
    if (pending !== undefined && repaintMergeable(pending, record)) {
      // A same-row repaint replaces the pending display value, then advances at
      // the finite skip bound. Fields omitted by the repaint stay preserved.
      const replacement = mergeToolUpdate(pending, record)
      replacement.skipped = pending.skipped + 1
      replacement.bytes = this.recordSize(replacement)
      const growth = replacement.bytes - pending.bytes
      buffer.bytes += growth
      buffer.queue[buffer.queue.length - 1] = replacement
      return replacement.skipped >= ACTIVITY_TOOL_SKIP_FLUSH
    }
    if (pending !== undefined
      && (record.output ?? '').length <= pending.base
      && (record.output ?? '').startsWith(pending.output ?? '')
      && repeatsPendingRow(pending, record)) {
      // A repaint that omits fields is absorbed only when it folds to the same
      // row, so no omitted value can erase the durable state.
      pending.skipped += 1
      return pending.skipped >= ACTIVITY_TOOL_SKIP_FLUSH
    }
    buffer.queue.push({
      kind: 'tool',
      toolId: record.toolId,
      status: record.status,
      fields: record.fields,
      output: record.output,
      error: record.error,
      base: record.output?.length ?? 0,
      skipped: 0,
      bytes,
    })
    buffer.bytes += bytes
    return false
  }

  private schedule(buffer: SessionBuffer): void {
    if (buffer.timer !== undefined) return
    const timer = setTimeout(() => {
      buffer.timer = undefined
      try {
        this.flush(buffer.sessionId)
      } catch {
        // Fail closed without an unhandled rejection: no retry, and the next
        // append or explicit flush reports the original error to the caller.
      }
    }, this.windowMs)
    // A buffered record must never hold the host process open by itself.
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    buffer.timer = timer
  }

  private clearTimer(buffer: SessionBuffer): void {
    if (buffer.timer === undefined) return
    clearTimeout(buffer.timer)
    buffer.timer = undefined
  }
}
