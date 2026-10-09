// Syntax-check the browser scripts shipped as template strings (nothing else parses them).
// Usage: node scripts/check-embedded.mjs
// Writes each export to a temp file and runs `node --check` on it; exits 1 on any failure.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { RUNTIME_JS } from '../src/runtime.js';
import { SITE_JS } from '../src/assets.js';

const SCRIPTS = [
  { name: 'RUNTIME_JS', code: RUNTIME_JS, ext: '.cjs' },
  { name: 'SITE_JS', code: SITE_JS, ext: '.cjs' },
];

const dir = mkdtempSync(join(tmpdir(), 'charm-embed-'));
let failed = false;
try {
  for (const { name, code, ext } of SCRIPTS) {
    const file = join(dir, name + ext);
    writeFileSync(file, code);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status === 0) {
      console.log(`ok  ${name}`);
    } else {
      failed = true;
      const err = (r.stderr || r.stdout || 'no output').trim().split('\n').slice(0, 5).join('\n');
      console.log(`FAIL ${name}: ${err}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
