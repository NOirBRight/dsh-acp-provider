import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: (props: { title: string; collapsedContent?: ReactNode; children?: ReactNode }) => <div data-disclosure-row="">{props.title}{props.collapsedContent}{props.children}</div>,
  ReadBlock: (props: unknown) => <div data-read-block="">{JSON.stringify(props)}</div>,
  DiffBlock: (props: unknown) => <div data-diff-block="">{JSON.stringify(props)}</div>,
  TerminalBlock: (props: unknown) => <div data-terminal-block="">{JSON.stringify(props)}</div>,
  writeClipboard: async () => true,
  IconApiOutlineRegular: () => null,
  IconBrowseOutlineRegular: () => null,
  IconChecklistOutlineRegular: () => null,
  IconEditOutlineRegular: () => null,
  IconGlobeOutlineRegular: () => null,
  IconSearchOutlineRegular: () => null,
  IconSparkleRegular: () => null,
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
  it('shows the official common locale labels on expanded read and diff tools', () => {
    const labels: Record<string, string> = {
      'codeBlock.title': 'Code block',
      'codeBlock.wrap': 'Wrap lines',
      'codeBlock.unwrap': 'Do not wrap lines',
    }
    const translate: NativeToolCardProps['t'] = key => labels[key] ?? key
    const read = renderToStaticMarkup(<NativeToolCard {...base} t={translate} detail={{ kind: 'read', label: '/tmp/a', lines: [], totalLines: 0 }} />)
    const diff = renderToStaticMarkup(<NativeToolCard {...base} t={translate} detail={{ kind: 'diff', diffs: [] }} />)
    for (const html of [read, diff]) {
      expect(html).toContain('Code block')
      expect(html).toContain('Wrap lines')
      expect(html).toContain('Do not wrap lines')
    }
  })
})

it('pretty prints structured payloads without changing raw text', () => {
  expect(prettyNativeToolPayload('{"a":1}')).toContain('\n')
  expect(prettyNativeToolPayload('plain')).toBe('plain')
})
