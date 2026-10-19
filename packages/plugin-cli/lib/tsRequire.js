'use strict';
/**
 * Nạp file .ts của repo Deplao trực tiếp (transpile bằng typescript, không type-check) —
 * để CLI và script dùng CHÍNH bộ kiểm tra manifest / router của app, không chép lại luật.
 */
const fs = require('fs');
const path = require('path');

let registered = false;

function register(repoRoot) {
  if (registered) return;
  let ts;
  try {
    ts = require(require.resolve('typescript', { paths: [repoRoot, __dirname] }));
  } catch {
    throw new Error('Cần package "typescript" (chạy trong repo Deplao sau khi npm install).');
  }
  require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const out = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    module._compile(out.outputText, filename);
  };
  registered = true;
}

/** Thư mục gốc repo Deplao (chứa src/services/plugins). */
function findRepoRoot(start) {
  let dir = path.resolve(start || __dirname);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'services', 'plugins', 'manifest.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

module.exports = { register, findRepoRoot };
