/**
 * 回帰チェック: PowerShell の **「使う行より後ろで定義した関数」** を落とす。
 *
 * 実行: npx tsx scripts/verify-ps1-order.ts   (npm run verify:ps1-order)
 *
 * 【なぜ要るか — 実障害 2026-09-02 (daily-1.6)】
 *   `Html-Decode` を [3] ログインで呼びながら、定義を [5] に置いた。
 *   PowerShell は**上から実行**するので、その行に来た時点では関数が存在せず
 *   `The term 'Html-Decode' is not recognized` で落ちた。**専用PC で 1 回消費した。**
 *
 *   この種は**こちらの検証を全部すり抜ける**:
 *     ・`[Parser]::ParseFile` は構文しか見ない (名前解決はしない)
 *     ・関数ブロックだけ抜き出した単体テストは、その定義を含んでいるので当然通る
 *     ・bat 生成もテキスト連結なので通る
 *   → **順序そのものを機械で見る**しかない。それがこのチェック。
 *
 * 【見かた】
 *   ・`function Foo` の定義行を集める
 *   ・**関数の外 (= 手続き部。上から順に実行される)** にある呼び出しだけを見る
 *     — 関数の中の呼び出しは「その関数が呼ばれた時点」で解決されるので、
 *       行の前後だけでは判定できない。ここは対象外にする (過検出を避ける)。
 *   ・手続き部の呼び出し行 < 定義行 なら落とす。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// npm script は esbuild で束ねて **stdin から** node に流すので `import.meta.url` が
// 使えない (`<stdin>` になる)。npm run はリポジトリ直下で走るので cwd を使い、
// **本当にそこがリポジトリ直下かを確かめてから**進む (静かに 0 件で通さない)。
const ROOT = process.cwd();
if (!existsSync(resolve(ROOT, 'package.json'))) {
  console.error(`✗ リポジトリ直下で実行してください (cwd=${ROOT})`);
  process.exit(1);
}

/** 見る .ps1。**現地で実行されるものは全部ここに入れる。** */
const TARGETS = [
  'scripts/demecal-daily.ps1',
  'scripts/demecal-recon.ps1',
  'scripts/demecal-verify.ps1',
  // C-1 の範囲プランナ。手続き部を持たない lib だが、C-4 の本番 runner が dot-source する。
  'scripts/demecal-range.ps1',
  'scripts/demecal-production.ps1',
];

interface Fn { name: string; defLine: number; startLine: number; endLine: number }

/**
 * `function Name ... { ... }` の範囲を波括弧の対応で求める。
 * 文字列・コメント中の括弧は無視しない（近似）が、対象の .ps1 では
 * 関数の外形を取るのに十分で、過検出側にも倒れない（範囲が広く出るだけ）。
 */
function findFunctions(lines: string[]): Fn[] {
  const out: Fn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*function\s+([A-Za-z][\w-]*)/.exec(lines[i]);
    if (!m) continue;
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
      }
      if (started && depth <= 0) { end = j; break; }
      end = j;
    }
    out.push({ name: m[1], defLine: i + 1, startLine: i + 1, endLine: end + 1 });
  }
  return out;
}

const failures: string[] = [];
let checked = 0;

for (const rel of TARGETS) {
  let src: string;
  try { src = readFileSync(resolve(ROOT, rel), 'utf8'); }
  catch { failures.push(`${rel}: ファイルが無い (消したなら TARGETS からも外す)`); continue; }

  const lines = src.split(/\r?\n/);
  const fns = findFunctions(lines);
  if (fns.length === 0) { console.log(`--  ${rel} (関数なし)`); continue; }

  // 関数の中に入る行を塗る (手続き部だけを見るため)。
  const inFn = new Array<boolean>(lines.length + 1).fill(false);
  for (const f of fns) for (let l = f.startLine; l <= f.endLine; l++) inFn[l] = true;

  for (const f of fns) {
    // 呼び出しの形: 行頭/空白/`(`/`|`/`=` の直後に関数名。定義行そのものは除く。
    const call = new RegExp(`(^|[\\s(|=&;{])${f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      if (line === f.defLine) continue;
      if (inFn[line]) continue;                      // 関数の中は対象外 (上記のとおり)
      const code = lines[i].replace(/#.*$/, '');     // 行コメントは除く
      if (!call.test(code)) continue;
      if (line < f.defLine) {
        failures.push(
          `${rel}:${line} で ${f.name} を呼んでいるが、定義は ${f.defLine} 行目。`
          + ` PowerShell は上から実行するので実行時に落ちる`,
        );
      }
    }
    checked++;
  }
  console.log(`OK  ${rel} (関数 ${fns.length} 件)`);
}

if (failures.length > 0) {
  console.error('\n✗ .ps1 の定義順 NG:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ .ps1 の定義順 OK (${checked} 関数の手続き部からの呼び出しを確認)`);
