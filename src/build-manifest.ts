/**
 * Build manifest loader — Plugin Contracts v2 (Accepted 2026-06-09).
 *
 * Mirrors clean-server/src/build_manifest.rs. See
 * foundation/spec/plugins/contracts/artifacts.md §5 and §8 for the contract.
 *
 * The compiler (>= 0.30.257) writes a `build-manifest.json` next to the main
 * WASM listing every artifact produced. Hosts read it at startup to locate
 * artifacts by declared `purpose` instead of probing conventional paths.
 *
 * Phase B behavior:
 *   - Manifest present and parseable → authoritative. Missing files declared in
 *     the manifest return a clear error rather than falling back.
 *   - Manifest absent → caller falls back to legacy heuristics.
 *   - Manifest present but unparseable → log warning, fall back to heuristics.
 *     (We do not refuse to start: this matches the Rust host's `warn + Vec::new`
 *     path so older compiler outputs keep working during the migration.)
 */

import * as fs from 'fs';
import * as path from 'path';

export const BUILD_MANIFEST_FILENAME = 'build-manifest.json';

/** Documented `purpose` values consumers handle. */
export const ArtifactPurpose = {
  MAIN_MODULE: 'main_module',
  CLIENT_HYDRATION: 'client_hydration',
  STATIC_ASSET: 'static_asset',
  MANIFEST: 'manifest',
  DATA_MIGRATION: 'data_migration',
} as const;

export const CallbackPurpose = {
  COMPONENT_TAG_RENDER: 'component_tag_render',
  ROUTE_DISPATCH: 'route_dispatch',
  MIGRATION_APPLY: 'migration_apply',
  EVENT_DISPATCH: 'event_dispatch',
} as const;

export const CallbackFallback = {
  PASSTHROUGH: 'passthrough',
  ERROR: 'error',
  EMPTY: 'empty',
} as const;

export interface BuildArtifact {
  name: string;
  path_relative: string;
  purpose: string;
  public?: boolean;
  content_type?: string;
  source_plugin?: string | null;
}

export interface CallbackContract {
  bridge: string;
  purpose: string;
  plugin_target: string;
  discovery: string;
  export_pattern?: string | null;
  fallback: string;
  declared_by_plugin?: string;
}

export interface BuildManifest {
  schema_version?: string;
  compiler_version?: string;
  artifacts: BuildArtifact[];
  callbacks: CallbackContract[];
}

export interface ResolvedArtifact {
  name: string;
  purpose: string;
  public: boolean;
  contentType: string;
  absolutePath: string;
}

/** Filesystem path the manifest sits at, sibling to `mainWasmPath`. */
export function manifestPathFor(mainWasmPath: string): string {
  const dir = path.dirname(mainWasmPath);
  if (!dir || dir === '.') {
    return BUILD_MANIFEST_FILENAME;
  }
  return path.join(dir, BUILD_MANIFEST_FILENAME);
}

/**
 * Best-effort MIME inference. Mirrors the Rust `infer_content_type` switch —
 * only consulted when the manifest entry omits `content_type`.
 */
export function inferContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.wasm')) return 'application/wasm';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.js')) return 'application/javascript';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Resolve a manifest-relative path against `mainWasmDir`. */
export function resolveArtifactPath(mainWasmDir: string, pathRelative: string): string {
  if (path.isAbsolute(pathRelative)) return pathRelative;
  if (!mainWasmDir || mainWasmDir === '') return path.join('.', pathRelative);
  return path.join(mainWasmDir, pathRelative);
}

export interface ManifestLoadResult {
  manifest: BuildManifest | null;
  /** Set when the file existed but failed to parse — caller logs and falls back. */
  parseError?: { manifestPath: string; reason: string };
}

/**
 * Read the manifest that sits next to `mainWasmPath`.
 *
 * Returns `{ manifest: null }` (no parseError) when the file is absent.
 * Returns `{ manifest: null, parseError }` when the file exists but is unreadable
 * or invalid JSON — the caller decides whether to warn-and-fall-back or fail.
 */
export function loadAlongside(mainWasmPath: string): ManifestLoadResult {
  const manifestPath = manifestPathFor(mainWasmPath);
  if (!fs.existsSync(manifestPath)) {
    return { manifest: null };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    return {
      manifest: null,
      parseError: { manifestPath, reason: `read failed: ${(e as Error).message}` },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      manifest: null,
      parseError: { manifestPath, reason: `JSON parse failed: ${(e as Error).message}` },
    };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return {
      manifest: null,
      parseError: { manifestPath, reason: 'top-level value is not an object' },
    };
  }
  const obj = parsed as Record<string, unknown>;
  const artifacts = Array.isArray(obj.artifacts) ? (obj.artifacts as BuildArtifact[]) : [];
  const callbacks = Array.isArray(obj.callbacks) ? (obj.callbacks as CallbackContract[]) : [];
  const manifest: BuildManifest = {
    schema_version: typeof obj.schema_version === 'string' ? obj.schema_version : undefined,
    compiler_version: typeof obj.compiler_version === 'string' ? obj.compiler_version : undefined,
    artifacts,
    callbacks,
  };
  return { manifest };
}

/**
 * Resolve every artifact entry into an absolute path + content-type pair,
 * preserving declaration order so route registration honors plugin precedence.
 */
export function resolveArtifacts(manifest: BuildManifest, mainWasmDir: string): ResolvedArtifact[] {
  return manifest.artifacts.map((a) => ({
    name: a.name,
    purpose: a.purpose,
    public: a.public === true,
    contentType:
      a.content_type && a.content_type.length > 0 ? a.content_type : inferContentType(a.name),
    absolutePath: resolveArtifactPath(mainWasmDir, a.path_relative),
  }));
}

/** First artifact with purpose `client_hydration` — frame.ui's `frontend.wasm`. */
export function clientHydrationArtifact(manifest: BuildManifest): BuildArtifact | undefined {
  return manifest.artifacts.find((a) => a.purpose === ArtifactPurpose.CLIENT_HYDRATION);
}
