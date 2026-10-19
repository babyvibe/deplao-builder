/**
 * build-bridge-e2ee.js - Cross-platform Go bridge build script.
 *
 * Phase 1 + Phase 8: Reads vendor manifest, validates meta revision,
 * runs tests/vet/build in order. Never clones HEAD.
 *
 * Builds two binaries into src/bridge-e2ee/build/:
 *   fbchat-bridge-e2ee   - the E2EE chat bridge (pinned meta/ submodule)
 *   fbchat-login-bridge  - the credential login wizard (login/, its own Go
 *                          module on a newer mautrix-meta; see manifest.loginHelper)
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
const GO_BUILD_CACHE = path.resolve(__dirname, '..', 'tmp', 'go-build-cache');
const MANIFEST_PATH = path.resolve(__dirname, '..', 'docs', 'fbchat-v2.3.3-vendor-manifest.json');
const BINARY_NAME = process.platform === 'win32'
  ? 'fbchat-bridge-e2ee.exe'
  : 'fbchat-bridge-e2ee';
// DEPLAO_ADAPTER: separate Go module (own go.mod) so `./...` in BRIDGE_DIR
// never compiles it against the pinned meta/.
const LOGIN_DIR = path.join(BRIDGE_DIR, 'login');
const LOGIN_BINARY_NAME = process.platform === 'win32'
  ? 'fbchat-login-bridge.exe'
  : 'fbchat-login-bridge';

const skipTests = process.argv.includes('--skip-tests');
const fastBuild = process.argv.includes('--fast');

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

/**
 * The development command starts this script on every Electron launch. Go's
 * build cache helps, but linking a 20+ MB binary still delays Vite/Electron.
 * Reuse the current binary only when all Go inputs and the pinned manifest are
 * older than it; any bridge source, module or vendor update rebuilds normally.
 * `skipDirs` are directory names left out of the walk (build output, VCS data,
 * nested modules that build separately).
 */
function isFastBuildOutputCurrent(outputPath, rootDir, skipDirs) {
  if (!fs.existsSync(outputPath)) return false;
  const outputMtime = fs.statSync(outputPath).mtimeMs;
  const stack = [rootDir];
  let newestInput = fs.statSync(MANIFEST_PATH).mtimeMs;

  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.go') || entry.name === 'go.mod' || entry.name === 'go.sum')) {
        newestInput = Math.max(newestInput, fs.statSync(fullPath).mtimeMs);
      }
    }
  }

  return newestInput <= outputMtime;
}

/**
 * Build the credential login helper. Its module graph is pinned by
 * login/go.mod + go.sum (never tidied here); the manifest records the
 * mautrix-meta version so a bump is a deliberate, reviewed change.
 */
function buildLoginHelper(manifest) {
  const helper = manifest.loginHelper;
  const metaVersion = helper?.mautrixMeta?.version;
  if (!helper || !metaVersion) {
    throw new Error('vendor manifest has no loginHelper.mautrixMeta.version');
  }
  const goModPath = path.join(LOGIN_DIR, 'go.mod');
  if (!fs.existsSync(goModPath)) {
    throw new Error(`login helper module not found at ${LOGIN_DIR}`);
  }
  const goMod = fs.readFileSync(goModPath, 'utf8');
  if (!goMod.split(/\r?\n/).some((line) => line.trim() === `go.mau.fi/mautrix-meta ${metaVersion}`)) {
    throw new Error(`login/go.mod does not require go.mau.fi/mautrix-meta ${metaVersion} (manifest loginHelper)`);
  }
  console.log(`[build-bridge] 📌 login helper: mautrix-meta ${metaVersion}`);

  const outputPath = path.join(BUILD_DIR, LOGIN_BINARY_NAME);
  if (fastBuild && isFastBuildOutputCurrent(outputPath, LOGIN_DIR, ['.git'])) {
    const fileSize = fs.statSync(outputPath).size;
    console.log(`[build-bridge] ⏭️ Fast dev build: login helper unchanged; reusing ${LOGIN_BINARY_NAME} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
    return;
  }

  // Downloaded even in --fast mode: unlike meta/, this module resolves from
  // the Go module proxy. With a warm module cache it is a no-op.
  console.log('[build-bridge] 📦 login helper: go mod download...');
  run('go mod download', { cwd: LOGIN_DIR });

  if (!skipTests && !fastBuild) {
    console.log('[build-bridge] 🧪 login helper: go test...');
    run('go test ./...', { cwd: LOGIN_DIR });
    console.log('[build-bridge] 🔍 login helper: go vet...');
    run('go vet ./...', { cwd: LOGIN_DIR });
  }

  const escapedOutput = outputPath.replace(/\\/g, '/');
  const bridgeVersion = manifest.version || '0.0.0';
  console.log(`[build-bridge] 🔨 Building login helper v${bridgeVersion}...`);
  run(`go build -trimpath -buildvcs=false -ldflags="-s -w -X main.bridgeVersion=${bridgeVersion}" -o "${escapedOutput}" .`, { cwd: LOGIN_DIR });
  const fileSize = fs.statSync(outputPath).size;
  console.log(`[build-bridge] ✅ Built: ${LOGIN_BINARY_NAME} v${bridgeVersion} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
}

function main() {
  // Sandboxed Windows builds may not be able to write the user-level Go cache.
  // Keep the build cache inside the ignored project tmp directory so predev can
  // always compile the current bridge instead of falling back to an old .exe.
  if (!process.env.GOCACHE) {
    fs.mkdirSync(GO_BUILD_CACHE, { recursive: true });
    process.env.GOCACHE = GO_BUILD_CACHE;
  }

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
    // Git normalizes safe.directory with forward slashes on Windows. Passing
    // the backslash form leaves nested vendor checkouts marked as dubious and
    // makes predev silently retain an older bridge binary.
    const safeMetaDir = META_DIR.split(path.sep).join('/');
    const metaGit = `git -c safe.directory=${JSON.stringify(safeMetaDir)} `;
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

  const outputPath = path.join(BUILD_DIR, BINARY_NAME);
  if (fastBuild && isFastBuildOutputCurrent(outputPath, BRIDGE_DIR, ['build', '.git', 'login'])) {
    const fileSize = fs.statSync(outputPath).size;
    console.log(`[build-bridge] ⏭️ Fast dev build: bridge source unchanged; reusing ${BINARY_NAME} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    buildE2EEBridge(manifest, outputPath);
  }

  // ── 8. Credential login helper ───────────────────────────────────────
  try {
    buildLoginHelper(manifest);
  } catch (err) {
    console.error(`[build-bridge] ❌ Login helper build failed: ${err.message}`);
    process.exit(1);
  }
}

function buildE2EEBridge(manifest, outputPath) {
  // ── 4. Download the already-pinned module graph ───────────────────────
  // Never run `go mod tidy` here: it mutates go.mod/go.sum based on the
  // local toolchain and makes release builds non-reproducible.
  if (fastBuild) {
    console.log('[build-bridge] ⏭️ Fast dev build: reusing module cache');
  } else {
    console.log('[build-bridge] 📦 go mod download...');
    run('go mod download');
  }

  // ── 5. go test (optional) ────────────────────────────────────────────
  if (!skipTests && !fastBuild) {
    console.log('[build-bridge] 🧪 go test...');
    try {
      run('go test ./...');
      console.log('[build-bridge] ✅ Tests passed');
    } catch {
      console.error('[build-bridge] ❌ Tests failed');
      process.exit(1);
    }
  } else {
    console.log(`[build-bridge] ⏭️ Skipping tests (${fastBuild ? '--fast' : '--skip-tests'})`);
  }

  // ── 6. go vet ─────────────────────────────────────────────────────────
  if (fastBuild) {
    console.log('[build-bridge] ⏭️ Fast dev build: skipping go vet');
  } else {
    console.log('[build-bridge] 🔍 go vet...');
    try {
      run('go vet ./...');
      console.log('[build-bridge] ✅ Vet passed');
    } catch {
      console.error('[build-bridge] ❌ Vet failed');
      process.exit(1);
    }
  }

  // ── 7. go build with version flag ────────────────────────────────────
  const escapedOutput = outputPath.replace(/\\/g, '/');
  const bridgeVersion = manifest.version || '0.0.0';
  console.log(`[build-bridge] 🔨 Building v${bridgeVersion}...`);
  // The bridge is vendored in a nested checkout, which may not have Git
  // metadata available in a packaged/dev environment. Version is injected
  // explicitly above, so VCS stamping is unnecessary and can otherwise make
  // predev keep an older binary after a failed rebuild.
  run(`go build -trimpath -buildvcs=false -ldflags="-s -w -X main.bridgeVersion=${bridgeVersion}" -o "${escapedOutput}" .`);

  const fileSize = fs.statSync(outputPath).size;
  console.log(`[build-bridge] ✅ Built: ${BINARY_NAME} v${bridgeVersion} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
}

try {
  main();
} catch (err) {
  console.error(`[build-bridge] ❌ Failed: ${err.message}`);
  process.exit(1);
}
