/**
 * Build manifest reader tests — Plugin Contracts v2 (artifacts.md §5).
 *
 * Mirrors the test set in clean-server/src/build_manifest.rs to keep cross-host
 * parity: round-trip parse, missing-file fallback, malformed-manifest fallback,
 * absent-manifest backward compatibility.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BUILD_MANIFEST_FILENAME,
  ArtifactPurpose,
  CallbackPurpose,
  CallbackFallback,
  clientHydrationArtifact,
  inferContentType,
  loadAlongside,
  manifestPathFor,
  resolveArtifactPath,
  resolveArtifacts,
} from '../src/build-manifest';

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cns-manifest-'));
}

function writeManifest(dir: string, json: string): string {
  const p = path.join(dir, BUILD_MANIFEST_FILENAME);
  fs.writeFileSync(p, json);
  return p;
}

describe('build-manifest reader', () => {
  it('manifest path sits next to the main WASM', () => {
    expect(manifestPathFor('dist/app.wasm')).toBe(path.join('dist', BUILD_MANIFEST_FILENAME));
  });

  it('manifest path handles a bare WASM filename', () => {
    expect(manifestPathFor('app.wasm')).toBe(BUILD_MANIFEST_FILENAME);
  });

  it('returns null manifest when none exists (backward-compat fallback)', () => {
    const dir = mkTempDir();
    const wasm = path.join(dir, 'app.wasm');
    fs.writeFileSync(wasm, 'WASM');
    const result = loadAlongside(wasm);
    expect(result.manifest).toBeNull();
    expect(result.parseError).toBeUndefined();
  });

  it('returns parseError (no throw) on malformed manifest', () => {
    const dir = mkTempDir();
    const wasm = path.join(dir, 'app.wasm');
    fs.writeFileSync(wasm, 'WASM');
    writeManifest(dir, '{not valid json');
    const result = loadAlongside(wasm);
    expect(result.manifest).toBeNull();
    expect(result.parseError).toBeDefined();
    expect(result.parseError!.reason).toMatch(/JSON parse failed/);
  });

  it('round-trips the frontend.wasm + main artifact entries', () => {
    const dir = mkTempDir();
    const wasm = path.join(dir, 'app.wasm');
    fs.writeFileSync(wasm, 'WASM');
    writeManifest(
      dir,
      JSON.stringify({
        schema_version: '1.0.0',
        compiler_version: '0.30.401',
        artifacts: [
          {
            name: 'app.wasm',
            path_relative: 'app.wasm',
            purpose: ArtifactPurpose.MAIN_MODULE,
            public: false,
            content_type: 'application/wasm',
            source_plugin: null,
          },
          {
            name: 'frontend.wasm',
            path_relative: 'frontend.wasm',
            purpose: ArtifactPurpose.CLIENT_HYDRATION,
            public: true,
            content_type: 'application/wasm',
            source_plugin: 'frame.ui',
          },
        ],
      }),
    );
    const { manifest, parseError } = loadAlongside(wasm);
    expect(parseError).toBeUndefined();
    expect(manifest).not.toBeNull();
    expect(manifest!.artifacts).toHaveLength(2);
    const frontend = clientHydrationArtifact(manifest!);
    expect(frontend?.name).toBe('frontend.wasm');
    expect(frontend?.public).toBe(true);
    expect(frontend?.source_plugin).toBe('frame.ui');
  });

  it('resolves manifest-relative paths to absolute paths', () => {
    const dir = mkTempDir();
    const dist = path.join(dir, 'dist');
    fs.mkdirSync(dist);
    const wasm = path.join(dist, 'app.wasm');
    fs.writeFileSync(wasm, 'WASM');
    writeManifest(
      dist,
      JSON.stringify({
        schema_version: '1.0.0',
        artifacts: [
          {
            name: 'frontend.wasm',
            path_relative: 'frontend.wasm',
            purpose: ArtifactPurpose.CLIENT_HYDRATION,
            public: true,
            content_type: 'application/wasm',
          },
        ],
      }),
    );
    const { manifest } = loadAlongside(wasm);
    const resolved = resolveArtifacts(manifest!, dist);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].absolutePath).toBe(path.join(dist, 'frontend.wasm'));
    expect(resolved[0].public).toBe(true);
    expect(resolved[0].purpose).toBe(ArtifactPurpose.CLIENT_HYDRATION);
  });

  it('keeps absolute paths unchanged', () => {
    const abs = process.platform === 'win32' ? 'C:\\absolute\\theme.css' : '/absolute/theme.css';
    expect(resolveArtifactPath('/whatever', abs)).toBe(abs);
  });

  it('infers content-type from extension when manifest omits it', () => {
    const dir = mkTempDir();
    const wasm = path.join(dir, 'app.wasm');
    fs.writeFileSync(wasm, 'WASM');
    writeManifest(
      dir,
      JSON.stringify({
        schema_version: '1.0.0',
        artifacts: [
          {
            name: 'theme.css',
            path_relative: 'theme.css',
            purpose: ArtifactPurpose.STATIC_ASSET,
            public: true,
          },
        ],
      }),
    );
    const { manifest } = loadAlongside(wasm);
    const resolved = resolveArtifacts(manifest!, dir);
    expect(resolved[0].contentType).toBe('text/css');
  });

  it('covers the common extensions in inferContentType', () => {
    expect(inferContentType('frontend.wasm')).toBe('application/wasm');
    expect(inferContentType('theme.css')).toBe('text/css');
    expect(inferContentType('loader.js')).toBe('application/javascript');
    expect(inferContentType('components.json')).toBe('application/json');
    expect(inferContentType('UNKNOWN.bin')).toBe('application/octet-stream');
  });

  it('parses callback contracts when present', () => {
    const dir = mkTempDir();
    const wasm = path.join(dir, 'app.wasm');
    fs.writeFileSync(wasm, 'WASM');
    writeManifest(
      dir,
      JSON.stringify({
        schema_version: '1.0.0',
        artifacts: [],
        callbacks: [
          {
            bridge: '_ui_render_page',
            purpose: CallbackPurpose.COMPONENT_TAG_RENDER,
            plugin_target: 'frame.ui',
            discovery: 'exports_matching',
            export_pattern: '{tagname}_render',
            fallback: CallbackFallback.PASSTHROUGH,
            declared_by_plugin: 'frame.ui',
          },
        ],
      }),
    );
    const { manifest } = loadAlongside(wasm);
    expect(manifest!.callbacks).toHaveLength(1);
    expect(manifest!.callbacks[0].bridge).toBe('_ui_render_page');
    expect(manifest!.callbacks[0].export_pattern).toBe('{tagname}_render');
  });

  it('defaults callbacks to empty when absent', () => {
    const dir = mkTempDir();
    const wasm = path.join(dir, 'app.wasm');
    fs.writeFileSync(wasm, 'WASM');
    writeManifest(dir, '{ "schema_version": "1.0.0", "artifacts": [] }');
    const { manifest } = loadAlongside(wasm);
    expect(manifest!.callbacks).toEqual([]);
  });
});
