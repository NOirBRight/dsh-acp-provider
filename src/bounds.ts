import type {
  ExternalAgentEvent,
  ExternalAgentPermissionRequest,
  ExternalAgentTurnHost,
  ExternalAgentUserInputRequest,
} from './contracts.js'

/** Byte limit for canonical provider payloads. */
export interface ExternalAgentEventBounds {
  readonly maxTextBytes: number
  readonly maxPayloadBytes: number
}
/** Return the UTF-8 byte length of a string. */
function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength }
/** Truncate text without splitting a Unicode code point.
 * @param value - text to truncate.
 * @param maxBytes - maximum UTF-8 byte length.
 * @returns the longest fitting prefix.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxTextBytes must be a non-negative safe integer')
  if (utf8Length(value) <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const next = utf8Length(character)
    if (bytes + next > maxBytes) break
    result += character
    bytes += next
  }
  return result
}

function payloadBytes(value: unknown): number { return utf8Length(JSON.stringify(value)) }
type EventTextSlot = { readonly value: string; readonly apply: (event: ExternalAgentEvent, value: string) => ExternalAgentEvent }
function assertNever(value: never): never { throw new TypeError('unknown external-agent event: ' + JSON.stringify(value)) }
function eventTextSlots(event: ExternalAgentEvent): readonly EventTextSlot[] {
  switch (event.type) {
    case 'assistant-delta': return [{ value: event.text, apply: (candidate, value) => ({ ...candidate, text: value } as ExternalAgentEvent) }]
    case 'thought-delta': return [{ value: event.text, apply: (candidate, value) => ({ ...candidate, text: value } as ExternalAgentEvent) }]
    case 'tool-activity': return [
      { value: event.name, apply: (candidate, value) => ({ ...candidate, name: value } as ExternalAgentEvent) },
      ...(['input', 'output', 'error'] as const).flatMap(key => event[key] === undefined ? [] : [{ value: event[key], apply: (candidate: ExternalAgentEvent, value: string) => ({ ...candidate, [key]: value } as ExternalAgentEvent) }]),
      ...(event.locations ?? []).map((location, index) => ({ value: location.path, apply: (candidate: ExternalAgentEvent, value: string) => candidate.type === 'tool-activity' ? { ...candidate, locations: candidate.locations?.map((item, itemIndex) => itemIndex === index ? { ...item, path: value } : item) } : candidate })),
    ]
    case 'plan-update': return [
      { value: event.summary, apply: (candidate, value) => ({ ...candidate, summary: value } as ExternalAgentEvent) },
      ...event.steps.map((step, index) => ({ value: step, apply: (candidate: ExternalAgentEvent, value: string) => candidate.type === 'plan-update' ? { ...candidate, steps: candidate.steps.map((item, itemIndex) => itemIndex === index ? value : item) } : candidate })),
    ]
    case 'notice': return [{ value: event.message, apply: (candidate, value) => ({ ...candidate, message: value } as ExternalAgentEvent) }]
    case 'session': return event.cursor === undefined ? [] : [{ value: event.cursor, apply: (candidate, value) => ({ ...candidate, cursor: value } as ExternalAgentEvent) }]
    case 'turn-result': return event.content === undefined ? [] : [{ value: event.content, apply: (candidate, value) => ({ ...candidate, content: value } as ExternalAgentEvent) }]
    case 'usage': return []
    default: return assertNever(event)
  }
}

/** Bound every variable in one event and guarantee its complete JSON is within the payload cap. */
export function boundExternalAgentEvent(event: ExternalAgentEvent, bounds: ExternalAgentEventBounds): ExternalAgentEvent {
  if (!Number.isSafeInteger(bounds.maxTextBytes) || bounds.maxTextBytes < 0) throw new RangeError('maxTextBytes must be a non-negative safe integer')
  if (!Number.isSafeInteger(bounds.maxPayloadBytes) || bounds.maxPayloadBytes < 1) throw new RangeError('maxPayloadBytes must be a positive safe integer')
  const slots = eventTextSlots(event)
  let current = slots.reduce((candidate, slot) => slot.apply(candidate, truncateUtf8(slot.value, bounds.maxTextBytes)), event)
  if (payloadBytes(current) <= bounds.maxPayloadBytes) return current
  for (const slot of slots) {
    const points = Array.from(truncateUtf8(slot.value, bounds.maxTextBytes))
    let low = 0
    let high = points.length
    let best = ''
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = points.slice(0, middle).join('')
      if (payloadBytes(slot.apply(current, candidate)) <= bounds.maxPayloadBytes) { best = candidate; low = middle + 1 } else high = middle - 1
    }
    current = slot.apply(current, best)
  }
  if (payloadBytes(current) > bounds.maxPayloadBytes) throw new RangeError('external-agent event exceeds maxPayloadBytes: ' + event.type)
  return current
}

function boundPermissionRequest(request: ExternalAgentPermissionRequest, bounds: ExternalAgentEventBounds): ExternalAgentPermissionRequest {
  const result: ExternalAgentPermissionRequest = {
    requestId: request.requestId,
    toolName: truncateUtf8(request.toolName, bounds.maxTextBytes),
    reason: truncateUtf8(request.reason, bounds.maxTextBytes),
    options: request.options.map(option => ({ ...option, label: truncateUtf8(option.label, bounds.maxTextBytes) })),
    ...(request.securityWarning === undefined ? {} : { securityWarning: { ...request.securityWarning, message: truncateUtf8(request.securityWarning.message, bounds.maxTextBytes) } }),
  }
  if (payloadBytes(result) > bounds.maxPayloadBytes) throw new RangeError('external-agent permission request exceeds maxPayloadBytes')
  return result
}
/** Bound one user-input request before a provider calls the host.
 * @param request - normalized user-input request.
 * @param bounds - complete payload and per-text byte limits.
 * @returns a bounded copy preserving request identity.
 */
export function boundExternalAgentUserInputRequest(request: ExternalAgentUserInputRequest, bounds: ExternalAgentEventBounds): ExternalAgentUserInputRequest {
  const result: ExternalAgentUserInputRequest = {
    requestId: request.requestId,
    question: truncateUtf8(request.question, bounds.maxTextBytes),
    ...(request.options === undefined ? {} : { options: request.options.map(option => truncateUtf8(option, bounds.maxTextBytes)) }),
    ...(request.multiple === undefined ? {} : { multiple: request.multiple }),
  }
  if (payloadBytes(result) > bounds.maxPayloadBytes) throw new RangeError('external-agent user-input request exceeds maxPayloadBytes')
  return result
}
/** Apply event and interaction bounds before display or persistence. */
export function withBoundedExternalAgentHost(host: ExternalAgentTurnHost, bounds: ExternalAgentEventBounds): ExternalAgentTurnHost {
  return {
    ...(host.signal === undefined ? {} : { signal: host.signal }),
    publish: event => host.publish(boundExternalAgentEvent(event, bounds)),
    requestPermission: request => host.requestPermission(boundPermissionRequest(request, bounds)),
    requestUserInput: request => host.requestUserInput(boundExternalAgentUserInputRequest(request, bounds)),
  }
}

/** Options for a bounded in-memory event log. */
export interface BoundedEventLogOptions {
  readonly maxEvents?: number
  readonly maxTextBytes?: number
  readonly maxPayloadBytes?: number
}
/** Bounded event sink that drops oldest events after its count cap. */
export class BoundedEventLog {
  private readonly buffer: ExternalAgentEvent[] = []
  private dropped = 0
  private readonly maxEvents: number
  private readonly bounds: ExternalAgentEventBounds
  constructor(options: BoundedEventLogOptions = {}) {
    const maxEvents = options.maxEvents ?? 500
    const maxTextBytes = options.maxTextBytes ?? 4000
    const maxPayloadBytes = options.maxPayloadBytes ?? 16 * 1024 * 1024
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new RangeError('maxEvents must be a positive safe integer')
    if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 0) throw new RangeError('maxTextBytes must be a non-negative safe integer')
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) throw new RangeError('maxPayloadBytes must be a positive safe integer')
    this.maxEvents = maxEvents
    this.bounds = { maxTextBytes, maxPayloadBytes }
  }
  /** Push one bounded event. */
  push(event: ExternalAgentEvent): void {
    const bounded = boundExternalAgentEvent(event, this.bounds)
    if (this.buffer.length >= this.maxEvents) { this.buffer.shift(); this.dropped += 1 }
    this.buffer.push(bounded)
  }
  /** Return a snapshot of retained events. */
  events(): readonly ExternalAgentEvent[] { return [...this.buffer] }
  /** Number of events dropped due to the count cap. */
  get droppedCount(): number { return this.dropped }
}