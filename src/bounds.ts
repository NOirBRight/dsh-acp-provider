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
function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength }
function truncateUtf8(value: string, maxBytes: number): string {
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
function emptyEvent(event: ExternalAgentEvent): ExternalAgentEvent {
  switch (event.type) {
    case 'assistant-delta': return { type: event.type, text: '' }
    case 'thought-delta': return { type: event.type, text: '' }
    case 'tool-activity': return { type: event.type, toolId: '', name: '', status: event.status }
    case 'plan-update': return { type: event.type, summary: '', steps: [] }
    case 'usage': return event
    case 'notice': return { type: event.type, level: event.level, message: '' }
    case 'session': return { type: event.type, status: event.status }
    case 'turn-result': return { type: event.type, status: event.status }
  }
}
function boundedInitialEvent(event: ExternalAgentEvent, maxTextBytes: number): ExternalAgentEvent {
  switch (event.type) {
    case 'assistant-delta': return { ...event, text: truncateUtf8(event.text, maxTextBytes) }
    case 'thought-delta': return { ...event, text: truncateUtf8(event.text, maxTextBytes) }
    case 'tool-activity': return {
      ...event,
      toolId: truncateUtf8(event.toolId, maxTextBytes),
      name: truncateUtf8(event.name, maxTextBytes),
      ...(event.input === undefined ? {} : { input: truncateUtf8(event.input, maxTextBytes) }),
      ...(event.output === undefined ? {} : { output: truncateUtf8(event.output, maxTextBytes) }),
      ...(event.error === undefined ? {} : { error: truncateUtf8(event.error, maxTextBytes) }),
      ...(event.locations === undefined ? {} : { locations: event.locations.map(location => truncateUtf8(location, maxTextBytes)) }),
    }
    case 'plan-update': return { ...event, summary: truncateUtf8(event.summary, maxTextBytes), steps: event.steps.map(step => truncateUtf8(step, maxTextBytes)) }
    case 'usage': return event
    case 'notice': return { ...event, message: truncateUtf8(event.message, maxTextBytes) }
    case 'session': return event.cursor === undefined ? event : { ...event, cursor: truncateUtf8(event.cursor, maxTextBytes) }
    case 'turn-result': return event.content === undefined ? event : { ...event, content: truncateUtf8(event.content, maxTextBytes) }
  }
}
/** Bound every variable in one event and guarantee its complete JSON is within the payload cap. */
export function boundExternalAgentEvent(event: ExternalAgentEvent, bounds: ExternalAgentEventBounds): ExternalAgentEvent {
  if (!Number.isSafeInteger(bounds.maxTextBytes) || bounds.maxTextBytes < 0) throw new RangeError('maxTextBytes must be a non-negative safe integer')
  if (!Number.isSafeInteger(bounds.maxPayloadBytes) || bounds.maxPayloadBytes < 1) throw new RangeError('maxPayloadBytes must be a positive safe integer')
  const initial = boundedInitialEvent(event, bounds.maxTextBytes)
  if (payloadBytes(initial) <= bounds.maxPayloadBytes) return initial
  let current = emptyEvent(initial)
  if (payloadBytes(current) > bounds.maxPayloadBytes) throw new RangeError('external-agent event exceeds maxPayloadBytes: ' + event.type)
  const slots: Array<{ readonly value: string; readonly optional?: boolean; readonly apply: (event: ExternalAgentEvent, value: string) => ExternalAgentEvent }> = []
  switch (initial.type) {
    case 'assistant-delta': slots.push({ value: initial.text, apply: (valueEvent, value) => ({ ...valueEvent, text: value } as ExternalAgentEvent) }); break
    case 'thought-delta': slots.push({ value: initial.text, apply: (valueEvent, value) => ({ ...valueEvent, text: value } as ExternalAgentEvent) }); break
    case 'tool-activity':
      slots.push({ value: initial.toolId, apply: (valueEvent, value) => ({ ...valueEvent, toolId: value } as ExternalAgentEvent) }, { value: initial.name, apply: (valueEvent, value) => ({ ...valueEvent, name: value } as ExternalAgentEvent) })
      for (const location of initial.locations ?? []) slots.push({ value: location, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, locations: [...(valueEvent.type === 'tool-activity' ? valueEvent.locations ?? [] : []), value] } as ExternalAgentEvent) })
      for (const key of ['input', 'output', 'error'] as const) {
        const value = initial[key]
        if (value !== undefined) slots.push({ value, optional: true, apply: (valueEvent, next) => ({ ...valueEvent, [key]: next } as ExternalAgentEvent) })
      }
      break
    case 'plan-update':
      slots.push({ value: initial.summary, apply: (valueEvent, value) => ({ ...valueEvent, summary: value } as ExternalAgentEvent) })
      for (const step of initial.steps) slots.push({ value: step, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, steps: [...(valueEvent.type === 'plan-update' ? valueEvent.steps : []), value] } as ExternalAgentEvent) })
      break
    case 'notice': slots.push({ value: initial.message, apply: (valueEvent, value) => ({ ...valueEvent, message: value } as ExternalAgentEvent) }); break
    case 'session': if (initial.cursor !== undefined) slots.push({ value: initial.cursor, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, cursor: value } as ExternalAgentEvent) }); break
    case 'turn-result': if (initial.content !== undefined) slots.push({ value: initial.content, optional: true, apply: (valueEvent, value) => ({ ...valueEvent, content: value } as ExternalAgentEvent) }); break
    case 'usage': break
  }
  for (const slot of slots) {
    const points = Array.from(slot.value)
    let low = 0
    let high = points.length
    let best = ''
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = points.slice(0, middle).join('')
      if (payloadBytes(slot.apply(current, candidate)) <= bounds.maxPayloadBytes) { best = candidate; low = middle + 1 } else high = middle - 1
    }
    if (best !== '' || slot.optional !== true) current = slot.apply(current, best)
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
function boundUserInputRequest(request: ExternalAgentUserInputRequest, bounds: ExternalAgentEventBounds): ExternalAgentUserInputRequest {
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
    requestUserInput: request => host.requestUserInput(boundUserInputRequest(request, bounds)),
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
