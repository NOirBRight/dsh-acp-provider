/**
 * Structural probe for the bridge host surface. Reports whether an
 * arbitrary host object can mount the bridge, so composition against
 * current DSH yields a named blocked verdict instead of a faked seam.
 *
 * @module dsh-bridge/current-dsh
 */

/** Every host path createBridge requires, in check order. */
export const REQUIRED_HOST_PATHS: readonly string[] = [
  'directory.register',
  'directory.list',
  'drivers.setPrimary',
  'sessions.read',
  'sessions.onEvent',
  'interaction.requestApproval',
  'interaction.askUser',
];

/** Paths in REQUIRED_HOST_PATHS the host does not provide. */
export function missingPaths(host: unknown): string[] {
  const missing: string[] = [];
  for (const path of REQUIRED_HOST_PATHS) {
    const segments = path.split('.');
    let current: unknown = host;
    for (const segment of segments) {
      if (current !== null && typeof current === 'object') {
        current = (current as Record<string, unknown>)[segment];
      } else {
        current = undefined;
      }
    }
    if (typeof current !== 'function') missing.push(path);
  }
  return missing;
}

export type BridgeHostProbe =
  | { readonly ok: true }
  | { readonly ok: false, readonly missing: readonly string[] };

/**
 * Check one host object against the bridge surface.
 * @param host - candidate host (a BridgeHost or a DSH-shaped stub).
 * @returns ok when the bridge can mount; otherwise the missing paths.
 */
export function probeBridgeHost(host: unknown): BridgeHostProbe {
  const missing = missingPaths(host);
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}
