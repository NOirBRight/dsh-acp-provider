/** Bounded coalescing coverage over a vendor-free test codec and a fake clock. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_COALESCE_WINDOW_MS,
  ACTIVITY_MAX_PENDING_BYTES,
  ACTIVITY_MAX_PENDING_RECORDS,
  ACTIVITY_MAX_TEXT_CHARS,
  ACTIVITY_TOOL_SKIP_FLUSH,
  ActivityCoalescer,
  type ActivityCoalescerCodec,
  type ActivityCoalescerSink,
} from '../src/activity-coalescer.js'

type TestEvent =
  | { readonly type: 'text'; readonly trajectoryId: string; readonly text: string }
  | { readonly type: 'tool'; readonly toolId: string; readonly status: string; readonly name?: string; readonly output?: string; readonly error?: string }
  | { readonly type: 'ready' }

const codec: ActivityCoalescerCodec<TestEvent> = {
  decode(event) {
    if (event.type === 'text') {
      return { kind: 'text', key: event.trajectoryId, fields: { trajectoryId: event.trajectoryId }, text: event.text }
    }
    if (event.type !== 'tool' || event.status === 'completed' || event.status === 'failed') return undefined
    return {
      kind: 'tool',
      toolId: event.toolId,
      status: event.status,
      fields: event.name === undefined ? {} : { name: event.name },
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(event.error === undefined ? {} : { error: event.error }),
    }
  },
  encode(record) {
    if (record.kind === 'text') return { type: 'text', trajectoryId: String(record.fields.trajectoryId), text: record.text }
    return {
      type: 'tool',
      toolId: record.toolId,
      status: record.status,
      ...(record.fields.name === undefined ? {} : { name: String(record.fields.name) }),
      ...(record.output === undefined ? {} : { output: record.output }),
      ...(record.error === undefined ? {} : { error: String(record.error) }),
    }
  },
}

const text = (trajectoryId: string, value: string): TestEvent => ({ type: 'text', trajectoryId, text: value })
const tool = (status: string, fields: { readonly name?: string; readonly output?: string } = {}, toolId = 'tool-1'): TestEvent => ({ type: 'tool', toolId, status, ...fields })
const ready: TestEvent = { type: 'ready' }

interface RecordedBatch {
  readonly sessionId: string
  readonly events: readonly TestEvent[]
}

/** Sink that records batch order and can fail one call by number. */
function recordingSink(failOnCall?: number): { readonly calls: RecordedBatch[]; readonly sink: ActivityCoalescerSink<TestEvent> } {
  const calls: RecordedBatch[] = []
  let count = 0
  return {
    calls,
    sink: {
      append: (sessionId, events) => {
        count += 1
        if (count === failOnCall) throw new Error('sink unavailable')
        calls.push({ sessionId, events: [...events] })
      },
    },
  }
}

function coalescer(sink: ActivityCoalescerSink<TestEvent>, windowMs?: number): ActivityCoalescer<TestEvent> {
  return new ActivityCoalescer<TestEvent>({ sink, codec, ...(windowMs === undefined ? {} : { windowMs }) })
}

interface FakeTimeout {
  readonly delay: number
  unrefCalls: number
  cleared: boolean
  fire(): void
}

let clock: FakeTimeout[] = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

beforeEach(() => {
  clock = []
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    const timer: FakeTimeout & { unref: () => void } = {
      delay: delay ?? 0,
      unrefCalls: 0,
      cleared: false,
      fire: () => { if (!timer.cleared) handler() },
      unref: () => { timer.unrefCalls += 1 },
    }
    clock.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer?: unknown) => {
    if (typeof timer === 'object' && timer !== null) (timer as FakeTimeout).cleared = true
  }) as typeof clearTimeout
})

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

describe('ActivityCoalescer', () => {
  it('merges adjacent text deltas into one durable append and tracks its buffer', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('session-1', [text('t1', 'hel'), text('t1', 'lo')])
    expect(calls).toEqual([])
    expect(activity.pendingCount('session-1')).toBe(1)
    expect(activity.pendingBytes('session-1')).toBeGreaterThan(0)
    activity.flush('session-1')
    expect(calls).toEqual([{ sessionId: 'session-1', events: [text('t1', 'hello')] }])
    expect(activity.pendingCount('session-1')).toBe(0)
    expect(activity.pendingBytes('session-1')).toBe(0)
  })

  it('writes the buffer before a barrier and never buffers the barrier', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('s', [text('t1', 'a'), ready, text('t1', 'b')])
    expect(calls).toEqual([
      { sessionId: 's', events: [text('t1', 'a')] },
      { sessionId: 's', events: [ready] },
    ])
    expect(activity.pendingCount('s')).toBe(1)
  })

  it('treats a terminal tool status as a barrier', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    const running = tool('running', { output: 'x' })
    activity.append('s', [running, tool('completed', { output: 'xy' })])
    expect(calls).toEqual([
      { sessionId: 's', events: [running] },
      { sessionId: 's', events: [tool('completed', { output: 'xy' })] },
    ])
    expect(activity.pendingCount('s')).toBe(0)
  })

  it('flushes on the delivery window and unrefs its timer', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('s', [text('t1', 'a')])
    activity.append('s', [text('t1', 'b')])
    expect(clock).toHaveLength(1)
    expect(clock[0].delay).toBe(ACTIVITY_COALESCE_WINDOW_MS)
    expect(clock[0].unrefCalls).toBe(1)
    clock[0].fire()
    expect(calls).toEqual([{ sessionId: 's', events: [text('t1', 'ab')] }])
    expect(activity.pendingCount('s')).toBe(0)
  })

  it('honours an injected window and clears the window timer on an explicit flush', () => {
    const { sink } = recordingSink()
    const activity = coalescer(sink, 25)
    activity.append('s', [text('t1', 'a')])
    expect(clock[0].delay).toBe(25)
    activity.flush('s')
    expect(clock[0].cleared).toBe(true)
    expect(activity.pendingCount('s')).toBe(0)
  })

  it('writes text at a paragraph or closed-fence boundary before the window', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('s', [text('t1', 'para\n\n')])
    expect(calls).toHaveLength(1)
    expect(activity.pendingCount('s')).toBe(0)
    activity.append('s', [text('t1', '```ts\nlet x = 1\n```')])
    expect(calls).toHaveLength(2)
    activity.append('s', [text('t1', '```ts\nlet x')])
    expect(calls).toHaveLength(2)
    expect(activity.pendingCount('s')).toBe(1)
  })

  it('starts a new record at the per-record text ceiling', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    const full = 'a'.repeat(ACTIVITY_MAX_TEXT_CHARS)
    activity.append('s', [text('t1', full), text('t1', 'b')])
    expect(activity.pendingCount('s')).toBe(2)
    activity.flush('s')
    expect(calls).toEqual([{ sessionId: 's', events: [text('t1', full), text('t1', 'b')] }])
  })

  it('flushes at the buffered-record ceiling before buffering the arrival', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('s', Array.from({ length: ACTIVITY_MAX_PENDING_RECORDS }, (_, index) => text(`t${index}`, 'x')))
    expect(calls).toHaveLength(0)
    expect(activity.pendingCount('s')).toBe(ACTIVITY_MAX_PENDING_RECORDS)
    activity.append('s', [text('extra', 'y')])
    expect(calls).toHaveLength(1)
    expect(calls[0].events).toHaveLength(ACTIVITY_MAX_PENDING_RECORDS)
    expect(activity.pendingCount('s')).toBe(1)
  })

  it('flushes instead of dropping when an arrival would cross the byte ceiling', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    const half = 'x'.repeat(150_000)
    activity.append('s', [tool('running', { output: half })])
    expect(activity.pendingBytes('s')).toBeLessThanOrEqual(ACTIVITY_MAX_PENDING_BYTES)
    activity.append('s', [tool('running', { output: half + half })])
    expect(calls).toHaveLength(1)
    expect(activity.pendingCount('s')).toBe(1)
    activity.flush('s')
    expect(calls).toHaveLength(2)
    const flushed = calls.flatMap(call => call.events)
    expect(flushed.map(event => event.type === 'tool' ? event.output?.length : -1)).toEqual([150_000, 300_000])
  })

  it('grows a running tool row in place and materializes a record on a field change', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('s', [tool('running', { output: 'a' })])
    activity.append('s', [tool('running', { output: 'ab' })])
    expect(activity.pendingCount('s')).toBe(1)
    activity.append('s', [tool('running', { name: 'Read', output: 'ab' })])
    expect(activity.pendingCount('s')).toBe(2)
    activity.flush('s')
    expect(calls).toEqual([{
      sessionId: 's',
      events: [tool('running', { output: 'ab' }), tool('running', { name: 'Read', output: 'ab' })],
    }])
  })

  it('advances a repainting row after the finite skip bound', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    const repaint = tool('running', { output: 'a' })
    activity.append('s', [repaint])
    for (let index = 0; index < ACTIVITY_TOOL_SKIP_FLUSH - 1; index++) activity.append('s', [repaint])
    expect(calls).toHaveLength(0)
    expect(activity.pendingCount('s')).toBe(1)
    activity.append('s', [repaint])
    expect(calls).toEqual([{ sessionId: 's', events: [repaint] }])
    expect(activity.pendingCount('s')).toBe(0)
  })

  it('reports a deferred timer failure to the next caller-owned operation without retrying', () => {
    const { calls, sink } = recordingSink(1)
    const activity = coalescer(sink)
    activity.append('s', [text('t1', 'a')])
    clock[0].fire()
    expect(calls).toEqual([])
    expect(activity.pendingCount('s')).toBe(0)
    expect(() => activity.append('s', [text('t1', 'b')])).toThrow('sink unavailable')
    expect(() => activity.flush('s')).toThrow('sink unavailable')
    expect(calls).toEqual([])
    // release reports the pending failure and drops the poisoned buffer either way.
    expect(() => activity.release('s')).toThrow('sink unavailable')
    activity.append('s', [text('t1', 'c')])
    activity.flush('s')
    expect(calls).toEqual([{ sessionId: 's', events: [text('t1', 'c')] }])
  })

  it('flushAll attempts every session, returns the ids, and rethrows the first failure', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('s1', [text('t1', 'a')])
    activity.append('s2', [text('t1', 'b')])
    expect(activity.flushAll()).toEqual(['s1', 's2'])
    expect(calls.map(call => call.sessionId)).toEqual(['s1', 's2'])
    expect(activity.flushAll()).toEqual([])

    const failing = recordingSink(1)
    const poisoned = coalescer(failing.sink)
    poisoned.append('s1', [text('t1', 'a')])
    poisoned.append('s2', [text('t1', 'b')])
    expect(() => poisoned.flushAll()).toThrow('sink unavailable')
    expect(failing.calls.map(call => call.sessionId)).toEqual(['s2'])
  })

  it('release flushes one session and reset flushes every session', () => {
    const { calls, sink } = recordingSink()
    const activity = coalescer(sink)
    activity.append('s1', [text('t1', 'a')])
    activity.append('s2', [text('t1', 'b')])
    activity.release('s1')
    expect(calls.map(call => call.sessionId)).toEqual(['s1'])
    expect(activity.pendingCount('s1')).toBe(0)
    expect(activity.pendingBytes('s1')).toBe(0)
    expect(activity.pendingCount('s2')).toBe(1)
    activity.reset()
    expect(calls.map(call => call.sessionId)).toEqual(['s1', 's2'])
    expect(activity.pendingCount('s2')).toBe(0)
    expect(activity.pendingBytes('s2')).toBe(0)
    activity.release('s2')
    expect(calls).toHaveLength(2)
  })
})
