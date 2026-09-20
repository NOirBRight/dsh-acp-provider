import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: (props: { title: string; collapsedContent?: ReactNode; children?: ReactNode }) => <div data-disclosure-row="">{props.title}{props.collapsedContent}{props.children}</div>,
  ReadBlock: (props: unknown) => <div data-read-block="">{JSON.stringify(props)}</div>,
  DiffBlock: (props: unknown) => <div data-diff-block="">{JSON.stringify(props)}</div>,
  TerminalBlock: (props: unknown) => <div data-terminal-block="">{JSON.stringify(props)}</div>,
  writeClipboard: async () => true,
  IconApiOutline14: () => null,
  IconBrowseOutline16: () => null,
  IconChecklistOutline14: () => null,
  IconEditOutline16: () => null,
  IconGlobeOutline14: () => null,
  IconSearchOutline16: () => null,
  IconSparkle16: () => null,
}))

import { NativeToolCard, prettyNativeToolPayload, type NativeToolCardProps } from '../src/native-ui.js'

const t = (key: string): string => key.split('.').pop() ?? key
const base: NativeToolCardProps = {
  callId: 'call-1', toolName: 'read', nativeName: 'Read file', summary: '/tmp/a', state: 'ok',
  input: JSON.stringify({ file_path: '/tmp/a' }), output: 'hello', t,
}

describe('NativeToolCard', () => {
  it('renders shared disclosure chrome and normalized rich details', () => {
    const html = renderToStaticMarkup(<NativeToolCard {...base} detail={{ kind: 'read', label: '/tmp/a', lines: [{ number: 1, text: 'hello' }], totalLines: 1 }} />)
    expect(html).toContain('data-native-tool-card="call-1"')
    expect(html).toContain('data-disclosure-row')
    expect(html).toContain('data-read-block')
    expect(html).toContain('>inspect</button>')
  })

  it('keeps unknown tools on the copyable IN/OUT fallback', () => {
    const html = renderToStaticMarkup(<NativeToolCard {...base} toolName="vendor_magic" nativeName="Vendor magic" detail={undefined} />)
    expect(html).toContain('data-native-io')
    expect(html).toContain('data-native-copy')
    expect(html).not.toContain('data-read-block')
  })

  it('distinguishes an empty settled result from no result', () => {
    const settled = renderToStaticMarkup(<NativeToolCard {...base} output="" detail={{ kind: 'empty' }} />)
    const running = renderToStaticMarkup(<NativeToolCard {...base} state="running" output={undefined} />)
    expect(settled).toContain('data-card-empty-result')
    expect(running).not.toContain('data-card-result')
  })
})

it('pretty prints structured payloads without changing raw text', () => {
  expect(prettyNativeToolPayload('{"a":1}')).toContain('\n')
  expect(prettyNativeToolPayload('plain')).toBe('plain')
})
