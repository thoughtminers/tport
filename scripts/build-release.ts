#!/usr/bin/env tsx
/**
 * Build script: bundles devpilot with esbuild and packages a platform tarball.
 *
 * Usage:
 *   tsx scripts/build-release.ts [--platform darwin|linux] [--arch arm64|x64]
 *
 * Output:
 *   dist-release/devpilot-{version}-{platform}-{arch}.tar.gz
 *   dist-release/devpilot-{version}-{platform}-{arch}.tar.gz.sha256
 */

import * as esbuild from 'esbuild';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const targetPlatform = flag('--platform', os.platform() === 'darwin' ? 'darwin' : 'linux') as
  | 'darwin'
  | 'linux';
const targetArch = flag('--arch', os.arch() === 'arm64' ? 'arm64' : 'x64') as 'arm64' | 'x64';

// ── Version ───────────────────────────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
  version: string;
};
const VERSION = pkg.version;

// ── Paths ─────────────────────────────────────────────────────────────────────

const DIST = path.join(ROOT, 'dist-release');
const BUNDLE_NAME = `devpilot-${VERSION}-${targetPlatform}-${targetArch}`;
const BUNDLE_DIR = path.join(DIST, BUNDLE_NAME);

const NODE_VERSION = '22.15.0';
const NODE_OS = targetPlatform === 'darwin' ? 'darwin' : 'linux';
const NODE_ARCH_MAP: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
const NODE_ARCH = NODE_ARCH_MAP[targetArch];
const NODE_TARBALL = `node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.gz`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`  ${msg}`);
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location!, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', err => {
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ── Build ─────────────────────────────────────────────────────────────────────

console.log(`\nBuilding devpilot v${VERSION} for ${targetPlatform}-${targetArch}\n`);

// Clean and create output directory
fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(BUNDLE_DIR, 'bin'), { recursive: true });
fs.mkdirSync(path.join(BUNDLE_DIR, 'lib', 'public'), { recursive: true });
fs.mkdirSync(path.join(BUNDLE_DIR, 'lib', 'node_modules'), { recursive: true });

// 1. Bundle JS with esbuild
log('Bundling with esbuild...');
await esbuild.build({
  entryPoints: [
    path.join(ROOT, 'src', 'cli.ts'),
    path.join(ROOT, 'src', 'daemon.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: path.join(BUNDLE_DIR, 'lib'),
  outExtension: { '.js': '.mjs' },
  external: ['node-pty'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  define: {
    DEVPILOT_VERSION: JSON.stringify(VERSION),
  },
  minify: false,
});
log('  → lib/cli.mjs');
log('  → lib/daemon.mjs');

// 2. Download Node.js binary
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-build-'));
const nodeTarPath = path.join(tmpDir, NODE_TARBALL);

log(`Downloading Node.js v${NODE_VERSION} (${NODE_OS}-${NODE_ARCH})...`);
await download(NODE_URL, nodeTarPath);

// Extract just the `node` binary
execSync(
  `tar -xzf "${nodeTarPath}" -C "${tmpDir}" "node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}/bin/node"`,
);
const nodeExtracted = path.join(
  tmpDir,
  `node-v${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}`,
  'bin',
  'node',
);
fs.copyFileSync(nodeExtracted, path.join(BUNDLE_DIR, 'bin', 'node'));
fs.chmodSync(path.join(BUNDLE_DIR, 'bin', 'node'), 0o755);
log('  → bin/node');

// Cleanup tmp
fs.rmSync(tmpDir, { recursive: true, force: true });

// 3. Copy node-pty
log('Copying node-pty...');
const nodePtySrc = path.join(ROOT, 'node_modules', 'node-pty');
const nodePtyDest = path.join(BUNDLE_DIR, 'lib', 'node_modules', 'node-pty');
fs.mkdirSync(nodePtyDest, { recursive: true });

// Copy package.json and lib/
fs.copyFileSync(
  path.join(nodePtySrc, 'package.json'),
  path.join(nodePtyDest, 'package.json'),
);
execSync(`cp -r "${path.join(nodePtySrc, 'lib')}" "${path.join(nodePtyDest, 'lib')}"`);

// Copy prebuilds or build/Release depending on what exists
const prebuildsDir = path.join(nodePtySrc, 'prebuilds');
const buildDir = path.join(nodePtySrc, 'build', 'Release');

if (fs.existsSync(prebuildsDir)) {
  // Copy only the matching platform prebuild
  const entries = fs.readdirSync(prebuildsDir);
  const match = entries.find(e => e.startsWith(`${NODE_OS}-`) && e.includes(NODE_ARCH));
  if (match) {
    fs.mkdirSync(path.join(nodePtyDest, 'prebuilds'), { recursive: true });
    execSync(
      `cp -r "${path.join(prebuildsDir, match)}" "${path.join(nodePtyDest, 'prebuilds', match)}"`,
    );
    log(`  → lib/node_modules/node-pty/prebuilds/${match}`);
  } else {
    console.warn(`  ⚠ No prebuild found for ${NODE_OS}-${NODE_ARCH} in prebuilds/`);
  }
} else if (fs.existsSync(buildDir)) {
  fs.mkdirSync(path.join(nodePtyDest, 'build', 'Release'), { recursive: true });
  execSync(`cp -r "${buildDir}/." "${path.join(nodePtyDest, 'build', 'Release')}"`);
  log('  → lib/node_modules/node-pty/build/Release');
} else {
  throw new Error('node-pty: no prebuilds or build/Release found');
}

// 4. Copy spawn-helper if present (macOS)
const spawnHelperSrc = path.join(nodePtySrc, 'build', 'Release', 'spawn-helper');
if (fs.existsSync(spawnHelperSrc)) {
  const dest = path.join(nodePtyDest, 'build', 'Release', 'spawn-helper');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(spawnHelperSrc, dest);
  fs.chmodSync(dest, 0o755);
}

// 5. Copy public/
log('Copying public/...');
execSync(
  `cp -r "${path.join(ROOT, 'public')}/." "${path.join(BUNDLE_DIR, 'lib', 'public')}"`,
);
log('  → lib/public/');

// 6. Write shell wrapper
log('Writing bin/devpilot wrapper...');
const wrapper = `#!/bin/sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVPILOT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DEVPILOT_ROOT
exec "$SCRIPT_DIR/node" "$DEVPILOT_ROOT/lib/cli.mjs" "$@"
`;
fs.writeFileSync(path.join(BUNDLE_DIR, 'bin', 'devpilot'), wrapper);
fs.chmodSync(path.join(BUNDLE_DIR, 'bin', 'devpilot'), 0o755);

// 7. Write version.json
fs.writeFileSync(
  path.join(BUNDLE_DIR, 'version.json'),
  JSON.stringify({ version: VERSION }, null, 2) + '\n',
);

// 8. Create tarball
log('Creating tarball...');
const tarName = `${BUNDLE_NAME}.tar.gz`;
const tarPath = path.join(DIST, tarName);
execSync(`tar -czf "${tarPath}" -C "${DIST}" "${BUNDLE_NAME}"`);

// 9. SHA256 checksum
const hash = sha256File(tarPath);
const sha256Path = `${tarPath}.sha256`;
fs.writeFileSync(sha256Path, `${hash}  ${tarName}\n`);

console.log(`\nDone!\n`);
console.log(`  ${tarPath}`);
console.log(`  ${sha256Path}`);
console.log(`  SHA256: ${hash}\n`);
