/**
 * build-bridge-e2ee.js - Cross-platform Go bridge build script.
 *
 * Phase 1 + Phase 8: Reads vendor manifest, validates meta revision,
 * runs tests/vet/build in order. Never clones HEAD.
 *
 * Usage:
 *   node scripts/build-bridge-e2ee.js [--skip-tests]
 *
 * Exit codes:
 *   0 - success
 *   1 - failure
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BRIDGE_DIR = path.resolve(__dirname, '..', 'src', 'bridge-e2ee');
const META_DIR = path.join(BRIDGE_DIR, 'meta');
const BUILD_DIR = path.join(BRIDGE_DIR, 'build');
const MANIFEST_PATH = path.resolve(__dirname, '..', 'docs', 'fbchat-v2.3.1-vendor-manifest.json');
const BINARY_NAME = process.platform === 'win32'
  ? 'fbchat-bridge-e2ee.exe'
  : 'fbchat-bridge-e2ee';

const skipTests = process.argv.includes('--skip-tests');

function run(cmd, opts = {}) {
  const cwd = opts.cwd || BRIDGE_DIR;
  console.log(`[build-bridge] $ ${cmd}`);
  return execSync(cmd, { cwd, stdio: 'inherit', ...opts });
}

function runCapture(cmd, opts = {}) {
  const cwd = opts.cwd || BRIDGE_DIR;
  return execSync(cmd, { cwd, encoding: 'utf8', ...opts }).trim();
}

function isGoInstalled() {
  try {
    execSync('go version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  // ── 0. Prerequisites ──────────────────────────────────────────────────
  if (!isGoInstalled()) {
    console.error('[build-bridge] ❌ Go is not installed. Install Go ≥ 1.24 from https://go.dev/dl/');
    process.exit(1);
  }

  if (!fs.existsSync(BRIDGE_DIR)) {
    console.error(`[build-bridge] ❌ Bridge directory not found: ${BRIDGE_DIR}`);
    process.exit(1);
  }

  // ── 1. Read vendor manifest ──────────────────────────────────────────
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[build-bridge] ❌ Vendor manifest not found: ${MANIFEST_PATH}`);
    console.error('[build-bridge] Run Phase 0 first to create the manifest.');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.upstream !== 'https://github.com/m008v/fbchat-v2' || !/^[0-9a-f]{40}$/i.test(manifest.commit || '')) {
    console.error('[build-bridge] ❌ Invalid fbchat-v2 vendor manifest. Refusing an unpinned build.');
    process.exit(1);
  }
  const metaManifest = manifest.submodules?.['bridge-e2ee/meta'];
  if (!metaManifest || !/^[0-9a-f]{40}$/i.test(metaManifest.commit || '')) {
    console.error('[build-bridge] ❌ Missing pinned bridge-e2ee/meta revision in vendor manifest.');
    process.exit(1);
  }
  console.log(`[build-bridge] 📋 fbchat-v2: version=${manifest.version} commit=${manifest.commit.slice(0, 12)}`);

  // ── 2. Validate meta submodule ────────────────────────────────────────
  const metaGoMod = path.join(META_DIR, 'go.mod');
  if (!fs.existsSync(metaGoMod)) {
    console.error(`[build-bridge] ❌ meta/ not found at ${META_DIR}`);
    console.error(`[build-bridge] Initialise the pinned submodule revision ${metaManifest.commit.slice(0, 12)} before building.`);
    process.exit(1);
  }

  // The checked-out meta revision must be exact. "Ahead" is not reproducible.
  try {
    // Do not mutate global git config in a user workspace. The local config
    // override is enough for the build process to inspect its own vendor dir.
    const metaGit = `git -c safe.directory=${JSON.stringify(META_DIR)} `;
    const currentRev = runCapture(`${metaGit}rev-parse HEAD`, { cwd: META_DIR });
    const manifestRev = metaManifest.commit;
    console.log(`[build-bridge] 📌 meta/ current: ${currentRev.slice(0, 12)} (manifest: ${manifestRev.slice(0, 12)})`);

    if (currentRev.toLowerCase() !== manifestRev.toLowerCase()) {
      console.error('[build-bridge] ❌ meta/ revision does not match the pinned vendor revision.');
      console.error(`[build-bridge] Expected ${manifestRev.slice(0, 12)}, found ${currentRev.slice(0, 12)}`);
      process.exit(1);
    }
    console.log('[build-bridge] ✅ meta/ revision OK');
  } catch (err) {
    console.error(`[build-bridge] ❌ Could not validate pinned meta revision: ${err.message}`);
    process.exit(1);
  }

  // ── 3. Ensure build/ directory ────────────────────────────────────────
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  // ── 4. Download the already-pinned module graph ───────────────────────
  // Never run `go mod tidy` here: it mutates go.mod/go.sum based on the
  // local toolchain and makes release builds non-reproducible.
  console.log('[build-bridge] 📦 go mod download...');
  run('go mod download');

  // ── 5. go test (optional) ────────────────────────────────────────────
  if (!skipTests) {
    console.log('[build-bridge] 🧪 go test...');
    try {
      run('go test ./...');
      console.log('[build-bridge] ✅ Tests passed');
    } catch {
      console.error('[build-bridge] ❌ Tests failed');
      process.exit(1);
    }
  } else {
    console.log('[build-bridge] ⏭️ Skipping tests (--skip-tests)');
  }

  // ── 6. go vet ─────────────────────────────────────────────────────────
  console.log('[build-bridge] 🔍 go vet...');
  try {
    run('go vet ./...');
    console.log('[build-bridge] ✅ Vet passed');
  } catch {
    console.error('[build-bridge] ❌ Vet failed');
    process.exit(1);
  }

  // ── 7. go build with version flag ────────────────────────────────────
  const outputPath = path.join(BUILD_DIR, BINARY_NAME);
  const escapedOutput = outputPath.replace(/\\/g, '/');
  const bridgeVersion = manifest.version || '0.0.0';
  console.log(`[build-bridge] 🔨 Building v${bridgeVersion}...`);
  run(`go build -trimpath -ldflags="-s -w -X main.bridgeVersion=${bridgeVersion}" -o "${escapedOutput}" .`);

  const fileSize = fs.statSync(outputPath).size;
  console.log(`[build-bridge] ✅ Built: ${BINARY_NAME} v${bridgeVersion} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
}

try {
  main();
} catch (err) {
  console.error(`[build-bridge] ❌ Failed: ${err.message}`);
  process.exit(1);
}
