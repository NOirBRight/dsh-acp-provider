/** Provider-owned Settings models and the generic External Agents page join. */
import type { ExternalAgentProviderId, ExternalAgentProviderInstanceId } from './contracts.js'

/** Common runtime health shown without equating plugin liveness to readiness. */
export interface ExternalAgentSettingsStatus {
  readonly installed: boolean
  readonly authenticated: boolean
  readonly live: boolean
  readonly ready: boolean
  readonly message?: string
}
/** Directory row for one independently configured provider instance. */
export interface ExternalAgentSettingsDirectoryEntry {
  readonly provider: ExternalAgentProviderId
  readonly instanceId: ExternalAgentProviderInstanceId
  readonly displayName: string
}
/** Serialized provider-specific settings. */
export interface ExternalAgentSerializedSettings {
  readonly provider: ExternalAgentProviderId
  readonly instanceId: ExternalAgentProviderInstanceId
  readonly values: Readonly<Record<string, string | boolean | number | null>>
}
/** Value-free credential metadata. */
export interface ExternalAgentCredentialMetadata {
  readonly provider: ExternalAgentProviderId
  readonly instanceId: ExternalAgentProviderInstanceId
  readonly authenticated: boolean
  readonly accountLabel?: string
}
/** Provider editor snapshot contributed by a provider plugin. */
export interface ExternalAgentSettingsEditorSnapshot {
  readonly provider: ExternalAgentProviderId
  readonly instanceId: ExternalAgentProviderInstanceId
  readonly title: string
  readonly status: ExternalAgentSettingsStatus
  readonly fields: readonly ExternalAgentSettingsField[]
  readonly actions: readonly ExternalAgentSettingsAction[]
}
/** Settings field rendered by the provider editor. */
export interface ExternalAgentSettingsField {
  readonly key: string
  readonly label: string
  readonly kind: 'text' | 'password' | 'boolean' | 'status'
  readonly value?: string | boolean
}
/** Provider-owned action routed through its own RPC namespace. */
export interface ExternalAgentSettingsAction {
  readonly id: 'validate-installation' | 'refresh-models' | 'sign-in' | 'sign-out' | string
  readonly label: string
  readonly run: (value?: unknown) => Promise<unknown>
}
/** Editor contribution registered by one provider instance. */
export interface ExternalAgentSettingsEditor {
  readonly provider: ExternalAgentProviderId
  readonly instanceId: ExternalAgentProviderInstanceId
  snapshot(): ExternalAgentSettingsEditorSnapshot
  run(action: string, value?: unknown): Promise<unknown>
}
/** Joined generic Settings row. */
export interface ExternalAgentSettingsRow {
  readonly directory: ExternalAgentSettingsDirectoryEntry
  readonly settings?: ExternalAgentSerializedSettings
  readonly credentials?: ExternalAgentCredentialMetadata
  readonly editor?: ExternalAgentSettingsEditorSnapshot
}
/** Generic External Agents page model. */
export interface ExternalAgentSettingsPage {
  readonly title: 'External Agents'
  readonly rows: readonly ExternalAgentSettingsRow[]
}
/** Explicit missing-editor failure. */
export class ExternalAgentSettingsEditorUnavailableError extends Error {
  constructor(readonly provider: ExternalAgentProviderId, readonly instanceId: ExternalAgentProviderInstanceId) {
    super('External Agent Settings editor is unavailable for ' + provider + '/' + instanceId)
    this.name = 'ExternalAgentSettingsEditorUnavailableError'
  }
}
/** Data source joined by the generic page. */
export interface ExternalAgentSettingsStore {
  listDirectory(): readonly ExternalAgentSettingsDirectoryEntry[]
  listSettings(): readonly ExternalAgentSerializedSettings[]
  listCredentials(): readonly ExternalAgentCredentialMetadata[]
  saveDirectory(entry: ExternalAgentSettingsDirectoryEntry): Promise<void> | void
  removeDirectory(provider: ExternalAgentProviderId, instanceId: ExternalAgentProviderInstanceId): Promise<void> | void
}
/** In-memory store for Loader and Settings tests. */
export class MemoryExternalAgentSettingsStore implements ExternalAgentSettingsStore {
  private readonly directory = new Map<string, ExternalAgentSettingsDirectoryEntry>()
  private readonly settings = new Map<string, ExternalAgentSerializedSettings>()
  private readonly credentials = new Map<string, ExternalAgentCredentialMetadata>()
  /** Seed serialized settings and value-free credential metadata. */
  seed(settings: ExternalAgentSerializedSettings, credentials?: ExternalAgentCredentialMetadata): void {
    this.settings.set(key(settings.provider, settings.instanceId), settings)
    if (credentials !== undefined) this.credentials.set(key(credentials.provider, credentials.instanceId), credentials)
  }
  /** List configured provider instances. */
  listDirectory(): readonly ExternalAgentSettingsDirectoryEntry[] { return [...this.directory.values()] }
  /** List serialized settings. */
  listSettings(): readonly ExternalAgentSerializedSettings[] { return [...this.settings.values()] }
  /** List credential metadata. */
  listCredentials(): readonly ExternalAgentCredentialMetadata[] { return [...this.credentials.values()] }
  /** Add or replace one directory row. */
  saveDirectory(entry: ExternalAgentSettingsDirectoryEntry): void { this.directory.set(key(entry.provider, entry.instanceId), entry) }
  /** Remove a row and its provider-owned metadata. */
  removeDirectory(provider: ExternalAgentProviderId, instanceId: ExternalAgentProviderInstanceId): void {
    const id = key(provider, instanceId)
    this.directory.delete(id)
    this.settings.delete(id)
    this.credentials.delete(id)
  }
}
/** Provider editor registry with idempotent unload disposers. */
export class ExternalAgentSettingsEditorRegistry {
  private readonly editors = new Map<string, ExternalAgentSettingsEditor>()
  /** Register one provider editor. */
  register(editor: ExternalAgentSettingsEditor): () => void {
    const id = key(editor.provider, editor.instanceId)
    if (this.editors.has(id)) throw new Error('External Agent Settings editor already registered: ' + id)
    this.editors.set(id, editor)
    let active = true
    return () => { if (active) { active = false; if (this.editors.get(id) === editor) this.editors.delete(id) } }
  }
  /** Find an editor or fail explicitly. */
  require(provider: ExternalAgentProviderId, instanceId: ExternalAgentProviderInstanceId): ExternalAgentSettingsEditor {
    const editor = this.editors.get(key(provider, instanceId))
    if (editor === undefined) throw new ExternalAgentSettingsEditorUnavailableError(provider, instanceId)
    return editor
  }
  /** Current editor snapshots. */
  list(): readonly ExternalAgentSettingsEditorSnapshot[] { return [...this.editors.values()].map(editor => editor.snapshot()) }
}
/**
 * Generic page model. Directory, settings and credential values are joined by
 * provider/instance id; editor snapshots are read at request time.
 */
export class ExternalAgentSettingsPageModel {
  constructor(private readonly store: ExternalAgentSettingsStore, private readonly editors: ExternalAgentSettingsEditorRegistry) {}
  /** Build the current page, including rows whose editor has unloaded. */
  snapshot(): ExternalAgentSettingsPage {
    const settings = new Map(this.store.listSettings().map(value => [key(value.provider, value.instanceId), value]))
    const credentials = new Map(this.store.listCredentials().map(value => [key(value.provider, value.instanceId), value]))
    return {
      title: 'External Agents',
      rows: this.store.listDirectory().map(directory => {
        const id = key(directory.provider, directory.instanceId)
        let editor: ExternalAgentSettingsEditorSnapshot | undefined
        try { editor = this.editors.require(directory.provider, directory.instanceId).snapshot() } catch (error) {
          if (!(error instanceof ExternalAgentSettingsEditorUnavailableError)) throw error
        }
        const saved = settings.get(id)
        const credential = credentials.get(id)
        return { directory, ...(saved === undefined ? {} : { settings: saved }), ...(credential === undefined ? {} : { credentials: credential }), ...(editor === undefined ? {} : { editor }) }
      }),
    }
  }
  /** Add or replace one instance row. */
  async add(entry: ExternalAgentSettingsDirectoryEntry): Promise<void> { await this.store.saveDirectory(entry) }
  /** Remove one instance row and provider-owned metadata. */
  async remove(provider: ExternalAgentProviderId, instanceId: ExternalAgentProviderInstanceId): Promise<void> { await this.store.removeDirectory(provider, instanceId) }
  /** Dispatch a provider-specific Settings action. */
  async runAction(provider: ExternalAgentProviderId, instanceId: ExternalAgentProviderInstanceId, action: string, value?: unknown): Promise<unknown> { return this.editors.require(provider, instanceId).run(action, value) }
}
function key(provider: ExternalAgentProviderId, instanceId: ExternalAgentProviderInstanceId): string { return String(provider) + '\u0000' + instanceId }
