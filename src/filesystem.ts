/** Host filesystem mediation for opt-in External Agent client capabilities. */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExternalAgentFilesystem } from './index.js'

/** Explicit filesystem policy failure. */
export class ExternalAgentFilesystemPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'ExternalAgentFilesystemPolicyError' }
}
/** Filesystem operations understood by the provider-neutral client capability. */
export type ExternalAgentFilesystemMethod = 'fs/read_text_file' | 'fs/write_text_file'
/** Parameters for a mediated read/write operation. */
export interface ExternalAgentFilesystemRequest {
  readonly path: string
  readonly content?: string
}
/** Optional realpath seam for deterministic policy tests. */
export interface ExternalAgentFilesystemResolver {
  realpath(path: string, operation?: 'read' | 'write'): Promise<string>
}

/**
 * Check one path against roots and return its canonical path. Reads may use
 * workspace or attachment roots; writes are restricted to workspace roots.
 */
export async function assertExternalAgentPath(policy: ExternalAgentFilesystem, path: string, operation: 'read' | 'write', resolver: ExternalAgentFilesystemResolver): Promise<string> {
  if (!isAbsolute(path)) throw new ExternalAgentFilesystemPolicyError('filesystem path must be absolute')
  if (path.includes('\0')) throw new ExternalAgentFilesystemPolicyError('filesystem path contains NUL')
  const roots = operation === 'write' ? policy.workspaceRoots : [...policy.workspaceRoots, ...policy.attachmentRoots]
  const requested = resolve(path)
  const lexicalRoot = roots.find(root => isWithin(root, requested))
  if (lexicalRoot === undefined) throw new ExternalAgentFilesystemPolicyError('filesystem path is outside configured roots')
  const realRoots = await Promise.all(roots.map(root => resolver.realpath(resolve(root), operation)))
  const realAttachmentRoots = operation === 'write' ? await Promise.all(policy.attachmentRoots.map(root => resolver.realpath(resolve(root), operation))) : []
  const target = await resolver.realpath(requested, operation).catch(async error => {
    if (operation !== 'write') throw error
    return resolve(await resolver.realpath(dirname(requested), operation), requested.slice(dirname(requested).length + 1))
  })
  const realRoot = realRoots.find(root => isWithin(root, target))
  if (realRoot === undefined) throw new ExternalAgentFilesystemPolicyError('filesystem path escapes configured roots')
  if (operation === 'write' && realAttachmentRoots.some(root => isWithin(root, target))) throw new ExternalAgentFilesystemPolicyError('filesystem writes to attachment roots are denied')
  return target
}

/** Build an ACP-like handler that mediates only approved filesystem methods. */
export function createExternalAgentFilesystemHandler(policy: ExternalAgentFilesystem, resolver: ExternalAgentFilesystemResolver): (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown> {
  return async (method, params, signal): Promise<unknown> => {
    if (method !== 'fs/read_text_file' && method !== 'fs/write_text_file') throw new ExternalAgentFilesystemPolicyError('filesystem method is unavailable: ' + method)
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    if (!isRequest(params)) throw new ExternalAgentFilesystemPolicyError('filesystem request is malformed')
    if (method === 'fs/read_text_file') {
      const target = await assertExternalAgentPath(policy, params.path, 'read', resolver)
      return policy.readTextFile(target, signal)
    }
    if (typeof params.content !== 'string') throw new ExternalAgentFilesystemPolicyError('filesystem write has no text content')
    const target = await assertExternalAgentPath(policy, params.path, 'write', resolver)
    await policy.writeTextFile(target, params.content, signal)
    return {}
  }
}
function isRequest(value: unknown): value is ExternalAgentFilesystemRequest { return typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string' }
function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
