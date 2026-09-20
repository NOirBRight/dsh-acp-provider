import { describe, expect, it } from 'vitest'
import { boundNativeToolPreview } from '../src/native-preview.js'

describe('boundNativeToolPreview', () => {
  it('keeps short payloads unchanged and marks raw truncation', () => {
    expect(boundNativeToolPreview('ok', 128)).toBe('ok')
    const bounded = boundNativeToolPreview('x'.repeat(200), 128)
    expect(bounded.length).toBeLessThanOrEqual(128)
    expect(bounded).toContain('[truncated]')
  })

  it('keeps long structured previews valid JSON', () => {
    const bounded = boundNativeToolPreview(JSON.stringify({ file_path: '/tmp/a', content: 'x'.repeat(1000) }), 256)
    expect(bounded.length).toBeLessThanOrEqual(256)
    expect(JSON.parse(bounded)).toMatchObject({ file_path: '/tmp/a' })
  })

  it('falls back to a valid preview object for many short fields', () => {
    const bounded = boundNativeToolPreview(JSON.stringify(Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['k' + index, 'v' + index]))), 256)
    expect(bounded.length).toBeLessThanOrEqual(256)
    expect(JSON.parse(bounded)).toHaveProperty('truncatedPreview')
  })

  it('rejects unusably small limits', () => {
    expect(() => boundNativeToolPreview('x', 127)).toThrow(RangeError)
  })
})
