/**
 * strip-console.js
 * Bỏ các lời gọi console.* trong JS đã compile ở dist-electron/ (chạy sau `tsc -p tsconfig.electron.prod.json`),
 * rồi kiểm tra cú pháp MỌI file — có file lỗi thì dừng build, không đóng gói bản không mở được.
 * Production không có devtools nên console.* chỉ tốn stdout I/O.
 *
 * Trước đây dùng regex `console\.\w+\s*\([^;]*\)\s*;?` — không hiểu ngoặc / chuỗi nên:
 *  - `.catch((err) => console.error('…', err));` mất luôn `)` của `.catch(` → main.js lỗi cú pháp, app báo
 *    "SyntaxError: Unexpected token '}'" khi mở;
 *  - `if (x) console.log(…);` chỉ còn `if (x)` → câu lệnh kế tiếp thành thân của if (sai logic, không báo lỗi gì).
 * Nay dùng parser TypeScript: chỉ thay đúng biểu thức gọi bằng `void 0` (hoặc `void [đối số]` khi đối số có tác dụng
 * phụ như gọi hàm / await / ++ — vẫn chạy như cũ, chỉ không in), nên câu lệnh xung quanh giữ nguyên, số dòng cũng giữ
 * nguyên. Gán `console.log = …` (plugin-worker) không phải lời gọi nên không bị đụng tới.
 *
 * Usage: node scripts/strip-console.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist-electron');

/** `console.log`, `console?.log`, `console['log']` */
function isConsoleMethod(expr) {
  if (!ts.isPropertyAccessExpression(expr) && !ts.isElementAccessExpression(expr)) return false;
  let target = expr.expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  return ts.isIdentifier(target) && target.text === 'console';
}

const PURE_BINARY_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.CommaToken,
]);

/** Biểu thức không có tác dụng phụ (literal, biến, đọc thuộc tính, phép toán trên chúng…) → bỏ hẳn được. */
function isPure(node) {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
      return true;
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.PropertyAccessExpression:
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.VoidExpression:
      return isPure(node.expression);
    case ts.SyntaxKind.ElementAccessExpression:
      return isPure(node.expression) && isPure(node.argumentExpression);
    case ts.SyntaxKind.TemplateExpression:
      return node.templateSpans.every((span) => isPure(span.expression));
    case ts.SyntaxKind.PrefixUnaryExpression:
      return node.operator !== ts.SyntaxKind.PlusPlusToken
        && node.operator !== ts.SyntaxKind.MinusMinusToken
        && isPure(node.operand);
    case ts.SyntaxKind.BinaryExpression:
      return PURE_BINARY_OPERATORS.has(node.operatorToken.kind) && isPure(node.left) && isPure(node.right);
    case ts.SyntaxKind.ConditionalExpression:
      return isPure(node.condition) && isPure(node.whenTrue) && isPure(node.whenFalse);
    case ts.SyntaxKind.ArrayLiteralExpression:
      return node.elements.every((el) => !ts.isSpreadElement(el) && isPure(el));
    case ts.SyntaxKind.ObjectLiteralExpression:
      return node.properties.every((prop) =>
        ts.isShorthandPropertyAssignment(prop)
        || (ts.isPropertyAssignment(prop) && !ts.isComputedPropertyName(prop.name) && isPure(prop.initializer)));
    default:
      return false; // gọi hàm, await, new, gán, ++/--, spread, yield, delete…
  }
}

/** Vị trí mà `void …` phải bọc ngoặc mới giữ đúng cú pháp (rất hiếm: `console.log(x).then`, `console.log() ** 2`…). */
function needsParens(node) {
  const parent = node.parent;
  if (!parent) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return true;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return true;
  return ts.isBinaryExpression(parent)
    && parent.left === node
    && parent.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken;
}

const countNewlines = (text) => (text.match(/\n/g) || []).length;

/**
 * Thay mọi lời gọi console.* trong một file JS. Trả { code, count }.
 * Lời gọi lồng trong đối số của lời gọi console khác đi cùng lời gọi ngoài.
 */
function stripConsoleCalls(code, fileName = 'file.js') {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && isConsoleMethod(node.expression)) {
      calls.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (calls.length === 0) return { code, count: 0 };

  let out = code;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    const start = call.getStart(sourceFile);
    const end = call.getEnd();
    const args = call.arguments;
    let replacement;
    if (args.every((arg) => !ts.isSpreadElement(arg) && isPure(arg))) {
      replacement = 'void 0' + '\n'.repeat(countNewlines(code.slice(start, end)));
    } else {
      // Giữ nguyên đối số (kể cả xuống dòng / dấu phẩy cuối) trong một mảng để vẫn tính như cũ
      const removed = code.slice(start, args.pos) + code.slice(args.end, end);
      replacement = 'void [' + code.slice(args.pos, args.end) + ']' + '\n'.repeat(countNewlines(removed));
    }
    if (needsParens(call)) replacement = '(' + replacement + ')';
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return { code: out, count: calls.length };
}

/** Lỗi cú pháp như khi Node/Electron nạp module CommonJS (null nếu hợp lệ). */
function syntaxError(code, fileName) {
  try {
    vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: fileName });
    return null;
  } catch (err) {
    const where = String(err && err.stack || '').split('\n')[0];
    return `${err && err.message}${where && where !== String(err) ? ` (${where})` : ''}`;
  }
}

function findJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * dist-electron giờ là bản production, còn `npm run dev` biên dịch tăng dần (incremental) vào CÙNG thư mục và chỉ ghi
 * file nguồn đã đổi → xoá trạng thái incremental của dev để lần chạy dev sau biên dịch lại toàn bộ (có console,
 * sourcemap) thay vì chạy tiếp bản production.
 */
function invalidateDevBuildInfo() {
  try {
    const configPath = path.join(ROOT, 'tsconfig.electron.json');
    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config || {}, ts.sys, ROOT, undefined, configPath);
    const buildInfo = parsed.options.tsBuildInfoFile;
    if (buildInfo && fs.existsSync(buildInfo)) fs.rmSync(buildInfo, { force: true });
  } catch {
    /* không đọc được cấu hình → bỏ qua, chỉ ảnh hưởng lần chạy dev kế tiếp */
  }
}

function main() {
  const files = findJsFiles(DIST_DIR);
  if (files.length === 0) {
    console.warn('[strip-console] No JS files found in dist-electron/');
    return;
  }

  let strippedFiles = 0;
  let strippedCalls = 0;
  const broken = [];
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const { code, count } = stripConsoleCalls(original, file);
    if (count > 0) {
      fs.writeFileSync(file, code, 'utf8');
      strippedFiles++;
      strippedCalls += count;
    }
    const error = syntaxError(code, file);
    if (error) broken.push(`${path.relative(ROOT, file)}: ${error}`);
  }
  invalidateDevBuildInfo();

  console.log(`[strip-console] Done: ${strippedCalls} console calls removed in ${strippedFiles}/${files.length} files.`);
  if (broken.length > 0) {
    console.error(`[strip-console] ❌ ${broken.length} file JS lỗi cú pháp — dừng build (app đóng gói sẽ không mở được):`);
    for (const line of broken) console.error(`  ${line}`);
    console.error('[strip-console] File cũ không còn nguồn? Xoá thư mục dist-electron rồi build lại.');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { stripConsoleCalls, syntaxError };
