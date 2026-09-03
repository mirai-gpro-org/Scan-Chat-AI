/**
 * `scripts/tests/demecal-flow.tests.ps1` を走らせるだけのラッパ。
 *
 * 実行: npm run verify:demecal-flow
 *
 * 【なぜ PowerShell 側にテストを置くか】
 *   検査対象は**実際に専用PC で走る .ps1 そのもの**でないと意味が無い。
 *   同じ判定を JS へ移植して検査しても、配布されるコードは検査されない。
 *
 * pwsh が無い環境では**黙って飛ばさず落とす** (通ったように見せない)。
 * 入れ方: https://learn.microsoft.com/powershell/scripting/install/installing-powershell
 * 置き場所を明示したいときは env `PWSH` にパスを入れる。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const TEST = resolve(ROOT, 'scripts/tests/demecal-flow.tests.ps1');

if (!existsSync(TEST)) {
  console.error(`✗ テストが見つかりません: ${TEST}`);
  process.exit(1);
}

const candidates = [process.env.PWSH, 'pwsh', 'pwsh-preview', 'powershell'].filter(Boolean);
let exe = null;
for (const c of candidates) {
  const probe = spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
  });
  if (probe.status === 0) { exe = c; break; }
}

if (!exe) {
  console.error('✗ PowerShell (pwsh) が見つかりません。');
  console.error('  デメカルのスクリプトは PowerShell なので、検査も PowerShell で走らせます。');
  console.error('  PWSH=<pwsh のパス> npm run verify:demecal-flow でも指定できます。');
  process.exit(1);
}

const run = spawnSync(exe, ['-NoProfile', '-File', TEST], { stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
