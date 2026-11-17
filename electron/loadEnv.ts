import * as fs from 'fs';
import * as path from 'path';

/** Small dependency-free .env loader. Existing process variables win. */
export function loadEnvFile(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (match[2].startsWith('"')) value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    } else value = value.replace(/\s+#.*$/, '').trim();
    process.env[match[1]] = value;
  }
}
