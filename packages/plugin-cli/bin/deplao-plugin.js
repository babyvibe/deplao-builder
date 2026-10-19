#!/usr/bin/env node
'use strict';
/**
 * deplao-plugin — tạo, kiểm tra, đóng gói plugin Deplao.
 *
 *   deplao-plugin create <thư-mục> [--runtime web|local|remote] [--id vn.acme.ten] [--name "Tên"]
 *   deplao-plugin validate <thư-mục>
 *   deplao-plugin pack <thư-mục> [--out plugin.zip]
 *
 * validate/pack dùng chính bộ kiểm tra manifest của app (src/services/plugins/manifest.ts).
 */
const fs = require('fs');
const path = require('path');
const { register, findRepoRoot } = require('../lib/tsRequire');
const templates = require('../lib/templates');

const EXCLUDE = new Set(['node_modules', '.git', '.idea', '.vscode', '.DS_Store', 'Thumbs.db']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function loadPluginModules() {
  const root = findRepoRoot(process.cwd()) || findRepoRoot(__dirname);
  if (!root) throw new Error('Không tìm thấy repo Deplao (cần src/services/plugins/manifest.ts).');
  register(root);
  return {
    root,
    manifest: require(path.join(root, 'src/services/plugins/manifest.ts')),
    zip: require(path.join(root, 'src/services/plugins/zip.ts')),
  };
}

function appVersion(root) {
  try { return require(path.join(root, 'package.json')).version; } catch { return undefined; }
}

function validate(dir) {
  const { root, manifest } = loadPluginModules();
  const res = manifest.readManifest(path.resolve(dir), appVersion(root));
  if (!res.ok) {
    console.error('✗ Manifest không hợp lệ:');
    res.errors.forEach((e) => console.error('  - ' + e));
    return null;
  }
  const m = res.manifest;
  console.log(`✓ ${m.name} ${m.version} (${m.id}, runtime ${m.runtime})`);
  console.log('  Quyền: ' + manifest.describePermissions(m.permissions).map((p) => `${p.id}${p.risky ? ' (!)' : ''}`).join(', '));
  return m;
}

function walk(dir, base, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name) || entry.name.endsWith('.zip')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) throw new Error(`Không đóng gói symlink: ${rel}`);
    if (entry.isDirectory()) walk(full, base, files);
    else if (entry.isFile()) files.push({ name: rel, data: fs.readFileSync(full) });
  }
  return files;
}

function pack(dir, out) {
  const m = validate(dir);
  if (!m) return 1;
  const { zip } = loadPluginModules();
  const files = walk(path.resolve(dir), path.resolve(dir), []);
  const buf = zip.createZip(files);
  const target = path.resolve(out || `${m.id}-${m.version}.zip`);
  fs.writeFileSync(target, buf);
  // Tự kiểm tra: gói vừa tạo phải đọc lại được bằng bộ giải nén của app.
  zip.readZipEntries(buf);
  console.log(`✓ Đã đóng gói ${files.length} file (${Math.round(buf.length / 1024)} KB) → ${target}`);
  return 0;
}

function create(dir, opts) {
  const runtime = ['web', 'local', 'remote'].includes(opts.runtime) ? opts.runtime : 'web';
  const target = path.resolve(dir);
  const short = path.basename(target).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'my-plugin';
  const id = opts.id || `vn.example.${short}`;
  const name = opts.name || short;
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    console.error(`✗ Thư mục ${target} không trống`);
    return 1;
  }
  fs.mkdirSync(target, { recursive: true });
  const write = (rel, content) => {
    const full = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('deplao-plugin.json', templates.manifest({ id, name, runtime }));
  write('README.md', templates.readme(name, runtime));
  if (runtime !== 'remote') {
    write('ui/index.html', templates.INDEX_HTML);
    write('ui/app.js', templates.APP_JS);
    write('ui/style.css', templates.STYLE_CSS);
  }
  if (runtime === 'local') write('backend/index.js', templates.backend(id));
  console.log(`✓ Đã tạo plugin ${name} (${id}, runtime ${runtime}) tại ${target}`);
  return validate(target) ? 0 : 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, dir] = args._;
  try {
    if (cmd === 'create' && dir) return create(dir, args);
    if (cmd === 'validate' && dir) return validate(dir) ? 0 : 1;
    if (cmd === 'pack' && dir) return pack(dir, args.out);
  } catch (err) {
    console.error('✗ ' + (err && err.message ? err.message : err));
    return 1;
  }
  console.log('Cách dùng:\n  deplao-plugin create <thư-mục> [--runtime web|local|remote] [--id vn.acme.ten] [--name "Tên"]\n  deplao-plugin validate <thư-mục>\n  deplao-plugin pack <thư-mục> [--out plugin.zip]');
  return cmd ? 1 : 0;
}

process.exitCode = main();
