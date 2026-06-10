/**
 * docs/funding_application/*.md → docx 変換スクリプト
 *
 * 実行: node scripts/build-funding-docx.mjs
 * 出力: 要件定義書.docx / 見積書.docx / 補助事業要件定義書_ウェルフォート_v2.0.docx
 *
 * 前提: pandoc がインストールされていること
 *   Ubuntu: apt-get install pandoc
 *   macOS:  brew install pandoc
 *   Windows: choco install pandoc  または https://pandoc.org/installing.html
 */
import { execSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FUNDING_DIR = resolve(ROOT, 'docs/funding_application');

const TARGETS = [
  { md: '要件定義書.md',                           docx: '要件定義書.docx' },
  { md: '見積書.md',                             docx: '見積書.docx' },
  { md: '補助事業要件定義書_ウェルフォート_v2.0.md', docx: '補助事業要件定義書_ウェルフォート_v2.0.docx' },
  { md: '選定理由書_UNFIX_v1.0.md',                docx: '選定理由書_UNFIX_v1.0.docx' },
];

// pandoc の存在確認
try {
  execSync('pandoc --version', { stdio: 'ignore' });
} catch {
  console.error('✗ pandoc がインストールされていません。');
  console.error('  Ubuntu: sudo apt-get install pandoc');
  console.error('  macOS:  brew install pandoc');
  console.error('  Windows: choco install pandoc  または https://pandoc.org/installing.html');
  process.exit(1);
}

for (const { md, docx } of TARGETS) {
  const mdPath = resolve(FUNDING_DIR, md);
  const docxPath = resolve(FUNDING_DIR, docx);
  // GFM (GitHub Flavored Markdown) で読み込み、docx で出力
  // -s: standalone document、表組み・見出しスタイル等を保持
  execSync(`pandoc -f gfm -t docx -s "${mdPath}" -o "${docxPath}"`, { cwd: FUNDING_DIR });
  const size = statSync(docxPath).size;
  console.log(`✓ ${basename(docxPath)} (${(size / 1024).toFixed(1)} KB)`);
}

console.log('完了');
