/** Bounded, display-safe previews for native tool payloads. */

export const DEFAULT_NATIVE_TOOL_PREVIEW_CHARS = 4000
const TRUNCATED_MARKER = '\n… [truncated]'
const IDENTITY_KEYS = new Set(['path', 'file_path', 'type', 'status'])

/**
 * Bound a native tool payload without turning valid JSON into an invalid fragment.
 * Structured values keep identity fields and progressively shorten long strings;
 * payloads with too many small fields fall back to an explicit preview object.
 */
export function boundNativeToolPreview(text: string, maxChars = DEFAULT_NATIVE_TOOL_PREVIEW_CHARS): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 128) throw new RangeError('maxChars must be a safe integer of at least 128')
  if (text.length <= maxChars) return text
  try {
    const value: unknown = JSON.parse(text)
    for (let limit = Math.min(2000, Math.floor(maxChars / 2)); limit >= 64; limit = Math.floor(limit / 2)) {
      const bounded = JSON.stringify(value, (key, part: unknown) =>
        typeof part === 'string' && part.length > limit && !IDENTITY_KEYS.has(key)
          ? part.slice(0, limit) + TRUNCATED_MARKER
          : part)
      if (bounded.length <= maxChars) return bounded
    }
    // JSON escaping may consume six characters per source code unit. Keep the
    // wrapper valid instead of pretending a cut fragment is a file or diff.
    return JSON.stringify({
      truncatedPreview: text.slice(0, Math.max(1, Math.floor((maxChars - 64) / 6))) + TRUNCATED_MARKER,
    })
  } catch {
    return text.slice(0, maxChars - TRUNCATED_MARKER.length) + TRUNCATED_MARKER
  }
}
