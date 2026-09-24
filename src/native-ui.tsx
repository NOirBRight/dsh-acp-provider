import { useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import {
  DisclosureRow,
  DiffBlock,
  IconApiOutlineRegular,
  IconBrowseOutlineRegular,
  IconChecklistOutlineRegular,
  IconEditOutlineRegular,
  IconGlobeOutlineRegular,
  IconSearchOutlineRegular,
  IconSparkleRegular,
  ReadBlock,
  TerminalBlock,
  writeClipboard,
  type DiffHunk,
} from '@deepseek-ai/dsh-client-ui-primitives'

export type NativeToolRowState = 'running' | 'ok' | 'error'
type NativeToolDetailKind = 'read' | 'diff' | 'terminal'
export type NativeToolTranslationKey =
  | 'tool.title.read' | 'todo.rowTitle' | 'tool.title.bash' | 'tool.title.grep' | 'tool.title.glob'
  | 'tool.title.webSearch' | 'tool.title.webFetch' | 'tool.title.write' | 'tool.title.edit' | 'tool.title.generic' | 'todo.completed'
  | 'copy' | 'copied' | 'collapse' | `${NativeToolDetailKind}.${'collapseAria' | 'expandAria' | 'expandRest'}`
  | 'read.window' | 'terminal.signal' | 'terminal.exitCode' | 'terminal.noExitCode'
  | 'terminal.running' | 'terminal.failed' | 'terminal.done' | 'terminal.noOutput'
  | 'row.inspect' | 'row.input' | 'row.output'
  | 'codeBlock.title' | 'codeBlock.wrap' | 'codeBlock.unwrap'
export type NativeToolTranslate = (key: NativeToolTranslationKey, params?: Readonly<Record<string, string | number>>) => string

export type NativeToolDetail =
  | { readonly kind: 'read'; readonly label: string; readonly lines: readonly { readonly number: number; readonly text: string }[]; readonly totalLines: number }
  | { readonly kind: 'diff'; readonly diffs: readonly DiffHunk[] }
  | { readonly kind: 'terminal'; readonly command: string; readonly output?: string; readonly cwd?: string; readonly exitCode?: number }
  | { readonly kind: 'empty' }

export interface NativeToolCardProps {
  readonly callId: string
  readonly toolName: string
  readonly nativeName: string
  readonly summary: string
  readonly state: NativeToolRowState
  readonly input?: string
  /** Undefined means no result has arrived; an empty string is a settled empty result. */
  readonly output?: string
  readonly detail?: NativeToolDetail
  readonly t: NativeToolTranslate
}

const TOOL_PRESENTATION: Record<string, { readonly titleKey: NativeToolTranslationKey; readonly icon: ReactNode }> = {
  read: { titleKey: 'tool.title.read', icon: <IconBrowseOutlineRegular size={14} /> },
  todo_write: { titleKey: 'todo.rowTitle', icon: <IconChecklistOutlineRegular size={14} /> },
  bash: { titleKey: 'tool.title.bash', icon: <IconApiOutlineRegular size={14} /> },
  grep: { titleKey: 'tool.title.grep', icon: <IconSearchOutlineRegular size={14} /> },
  glob: { titleKey: 'tool.title.glob', icon: <IconSearchOutlineRegular size={14} /> },
  web_search: { titleKey: 'tool.title.webSearch', icon: <IconSearchOutlineRegular size={14} /> },
  web_fetch: { titleKey: 'tool.title.webFetch', icon: <IconGlobeOutlineRegular size={14} /> },
  write: { titleKey: 'tool.title.write', icon: <IconEditOutlineRegular size={14} /> },
  edit: { titleKey: 'tool.title.edit', icon: <IconEditOutlineRegular size={14} /> },
}

const sep = ' \u00b7 '
const ioSection: CSSProperties = { display: 'flex', gap: 12, padding: '10px 16px', minWidth: 0 }
const ioText: CSSProperties = { margin: 0, minWidth: 0, flex: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', overflow: 'auto', maxHeight: 240, font: 'inherit' }

/** Read-only shared presentation for one normalized ACP native tool row. */
export function NativeToolCard(props: NativeToolCardProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const title = titleOf(props.toolName, props.t)
  const renamed = props.nativeName !== '' && props.nativeName !== props.toolName && props.nativeName !== title
  const expandable = props.input !== undefined || props.output !== undefined || props.detail !== undefined
  return <div data-native-tool-card={props.callId} data-state={props.state} title={renamed ? props.nativeName : title}
    aria-label={title + (props.summary === '' ? '' : sep + props.summary)} style={{ width: '100%', minWidth: 0 }}>
    <DisclosureRow
      icon={iconOf(props.toolName)}
      title={title}
      open={open}
      expandable={expandable}
      expandOnRowClick
      keepContentWhenOpen
      onToggle={() => { setOpen(value => !value) }}
      collapsedContent={props.summary === '' ? null : <span data-card-summary={props.summary}
        style={{ minWidth: 0, overflow: 'hidden', color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '24px', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sep + props.summary}</span>}
    >
      <div style={{ minWidth: 0, paddingTop: 6 }}>
        <NativeToolBody {...props} />
      </div>
    </DisclosureRow>
  </div>
}

function titleOf(toolName: string, t: NativeToolTranslate): string {
  return t(TOOL_PRESENTATION[toolName]?.titleKey ?? 'tool.title.generic')
}

function iconOf(toolName: string): ReactNode {
  return TOOL_PRESENTATION[toolName]?.icon ?? <IconSparkleRegular size={14} />
}

function detailLabels(kind: 'read' | 'diff' | 'terminal', t: NativeToolTranslate) {
  return {
    copy: t('copy'),
    copied: t('copied'),
    collapse: t('collapse'),
    collapseAria: t(`${kind}.collapseAria`),
    expandAria: (count: number) => t(`${kind}.expandAria`, kind === 'terminal' ? { n: count } : { count }),
    expand: (count: number) => t(`${kind}.expandRest`, kind === 'terminal' ? { n: count } : { count }),
  }
}

function codeToolbarLabels(t: NativeToolTranslate) {
  return {
    codeLabel: t('codeBlock.title'),
    wrapLabel: t('codeBlock.wrap'),
    unwrapLabel: t('codeBlock.unwrap'),
  }
}

function NativeToolBody(props: NativeToolCardProps): ReactNode {
  const [inspect, setInspect] = useState(false)
  const io = <NativeToolIO input={props.input} output={props.output} state={props.state} t={props.t} />
  if (props.detail === undefined) return io
  let body: ReactNode
  switch (props.detail.kind) {
    case 'read': body = <ReadBlock label={props.detail.label} lines={props.detail.lines} totalLines={props.detail.totalLines} maxLines={8}
      labels={{ ...detailLabels('read', props.t), ...codeToolbarLabels(props.t), window: (shown: number, total: number) => props.t('read.window', { shown, total }) }} />; break
    case 'diff': body = <DiffBlock diffs={[...props.detail.diffs]} maxLines={9}
      labels={{ ...detailLabels('diff', props.t), ...codeToolbarLabels(props.t) }} />; break
    case 'terminal': body = <TerminalBlock command={props.detail.command} output={props.detail.output} running={props.state === 'running'}
      cwd={props.detail.cwd} exitCode={props.detail.exitCode}
      labels={{ ...detailLabels('terminal', props.t), signal: (signal: string) => props.t('terminal.signal', { signal }),
        exitCode: (code: number) => props.t('terminal.exitCode', { code }), noExitCode: props.t('terminal.noExitCode'),
        running: props.t('terminal.running'), failed: props.t('terminal.failed'), done: props.t('terminal.done'), noOutput: props.t('terminal.noOutput') }} />; break
    case 'empty': body = <div data-card-empty-result style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>{props.t('terminal.noOutput')}</div>; break
  }
  return <>{body}
    <button type="button" aria-expanded={inspect} onClick={() => { setInspect(value => !value) }}
      style={{ marginTop: 8, padding: '2px 8px', borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, cursor: 'pointer' }}>{props.t('row.inspect')}</button>
    {inspect ? io : null}
  </>
}

function parse(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

export function prettyNativeToolPayload(text: string): string {
  const value = parse(text)
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function NativeToolIO({ input, output, state, t }: Pick<NativeToolCardProps, 'input' | 'output' | 'state' | 't'>): ReactNode {
  const [copied, setCopied] = useState<string>()
  const rows = [['row.input', input], ['row.output', output]] as const
  return <div data-native-io style={{ border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, overflow: 'hidden', font: 'var(--dsw-font-markdown-code-block)', color: 'var(--dsw-alias-label-secondary)' }}>
    {rows.map(([label, text]) => text === undefined ? null : <div key={label}
      data-card-result={label === 'row.output' ? state : undefined}
      style={{ ...ioSection, borderTop: label === 'row.output' && input !== undefined ? '1px solid var(--dsw-alias-border-l2)' : undefined }}>
      <span style={{ color: 'var(--dsw-alias-label-caption)', flexShrink: 0 }}>{t(label)}</span>
      <pre style={{ ...ioText, color: label === 'row.output' && state === 'error' ? 'var(--dsw-alias-state-error-primary)' : undefined }}>{prettyNativeToolPayload(text)}</pre>
      <button type="button" data-native-copy aria-label={`${t('copy')} ${t(label)}`}
        style={{ alignSelf: 'flex-start', background: 'transparent', border: 0, color: 'inherit', font: 'inherit', cursor: 'pointer' }}
        onClick={() => { void writeClipboard(prettyNativeToolPayload(text)).then(ok => { if (ok) setCopied(text) }) }}>{copied === text ? t('copied') : t('copy')}</button>
    </div>)}
  </div>
}
