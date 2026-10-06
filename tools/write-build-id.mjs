#!/usr/bin/env node
/**
 * Lokarta: Come Into The Light - Build Id Generator
 *
 * Writes a per-deployment `build-id.json` manifest consumed by `boot.js`. The
 * id is generated at build/deploy time so every rebuild is distinguishable and
 * can trigger a one-time client cache flush.
 *
 * Sources, in priority order:
 *   1. `LOKARTA_BUILD_ID` env override (used by CI and tests).
 *   2. `git rev-parse --short HEAD` + a UTC timestamp (default for local/CI).
 *   3. A UTC timestamp alone when git is unavailable.
 *
 * Usage:
 *   node tools/write-build-id.mjs                 # writes html/build-id.json
 *   node tools/write-build-id.mjs --out _site     # writes _site/build-id.json
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOLS_DIR, '..');

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

/** UTC stamp like `20261005T184500Z` (filesystem/URL friendly). */
export function utcStamp(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}Z`;
}

/**
 * Resolves the deployed build id and its source.
 * @param {object} [options]
 * @param {string|null} [options.override]
 * @param {string} [options.root]
 * @param {Date} [options.now]
 * @returns {{ buildId: string, source: 'env'|'git'|'clock' }}
 */
export function resolveBuildId({ override = null, root = REPO_ROOT, now = new Date() } = {}) {
  const envValue = override !== null && override !== undefined ? String(override).trim() : '';
  if (envValue) {
    return { buildId: envValue, source: 'env' };
  }

  let sha = null;
  try {
    sha = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    sha = null;
  }

  const stamp = utcStamp(now);
  if (sha) {
    return { buildId: `${sha}-${stamp}`, source: 'git' };
  }
  return { buildId: `build-${stamp}`, source: 'clock' };
}

/**
 * Writes `<outDir>/build-id.json`. Returns the manifest that was written.
 * @param {object} [options]
 * @param {string} [options.outDir]
 * @param {string|null} [options.override]
 * @param {string} [options.root]
 * @param {Date} [options.now]
 * @returns {{ buildId: string, builtAt: string, source: string }}
 */
export function writeBuildManifest({ outDir = resolve(REPO_ROOT, 'html'), override = null, root = REPO_ROOT, now = new Date() } = {}) {
  const resolvedOut = isAbsolute(outDir) ? outDir : resolve(root, outDir);
  const { buildId, source } = resolveBuildId({ override, root, now });
  const manifest = {
    buildId,
    builtAt: now.toISOString(),
    source,
  };
  mkdirSync(resolvedOut, { recursive: true });
  writeFileSync(resolve(resolvedOut, 'build-id.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function main() {
  const outFlag = readFlag('--out');
  const rootFlag = readFlag('--root');
  const override = process.env.LOKARTA_BUILD_ID ?? null;
  const outDir = outFlag ? resolve(process.cwd(), outFlag) : resolve(REPO_ROOT, 'html');
  const root = rootFlag ? resolve(process.cwd(), rootFlag) : REPO_ROOT;

  const manifest = writeBuildManifest({ outDir, override, root });
  process.stdout.write(`[build-id] ${manifest.buildId} (${manifest.source}) -> ${resolve(outDir, 'build-id.json')}\n`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
