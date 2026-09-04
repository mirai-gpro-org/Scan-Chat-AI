/**
 * `isScanUploadKey` の回帰チェック (サーバ不要・純ロジック)。
 *
 * 【なぜここを機械で見張るのか】
 * `/api/scan` は受け取ったキーの中身を読んで Gemini に渡す。**キーの検証が緩むと、
 * 同じバケットにある他のオブジェクト (Elith 納品 JSON = 全利用者ぶん) を
 * 読み出せてしまう**。しかも緩んでも画面は正常に見えるので、目視では守れない。
 *
 * 通ってよいのは「サーバが採番した形」だけ:
 *   {prefix}scan-uploads/YYYY/MM/DD/<UUID>.<ext>
 */
import { isScanUploadKey } from '../src/lib/scan-upload-ticket';
import type { S3Config } from '../src/lib/s3';

const cfg: S3Config = {
  bucket: 'wellfort-ai-input',
  region: 'ap-northeast-1',
  prefix: 'scan-accuracy-test/',
};
const P = `${cfg.prefix}scan-uploads/`;
const UUID = '0189d4c1-2b3a-4c5d-8e6f-a1b2c3d4e5f6';

const cases: { key: string; want: boolean; why: string }[] = [
  // ── 通ってよいもの ──
  { key: `${P}2026/09/04/${UUID}.jpg`, want: true, why: 'サーバが採番した形 (jpg)' },
  { key: `${P}2026/09/04/${UUID}.pdf`, want: true, why: 'サーバが採番した形 (pdf)' },
  { key: `${P}2026/09/04/${UUID}.png`, want: true, why: 'png' },
  { key: `${P}2026/09/04/${UUID}.webp`, want: true, why: 'webp' },
  { key: `${P}2026/09/04/${UUID}.heic`, want: true, why: 'heic' },
  { key: `${P}2026/09/04/${UUID}.heif`, want: true, why: 'heif' },

  // ── 他人のデータへ届かせない (ここが本丸) ──
  { key: 'user/abc/date/2026_09_04/HealthCheckupData.json', want: false, why: 'Elith 納品を直接' },
  { key: `${cfg.prefix}user/abc/date/2026_09_04/x.json`, want: false, why: 'prefix 内の別領域' },
  { key: `${P}../user/abc/x.json`, want: false, why: '相対パスで外へ' },
  { key: `${P}2026/09/04/${UUID}.jpg/../../../../secret.json`, want: false, why: '後ろに継ぎ足し' },
  { key: `${P}2026/09/04/${UUID}.json`, want: false, why: '許可外の拡張子 (JSON を読ませない)' },
  { key: `${P}2026/09/04/${UUID}.jpg.json`, want: false, why: '二重拡張子' },

  // ── 形が違うもの ──
  { key: `${P}${UUID}.jpg`, want: false, why: '日付階層が無い' },
  { key: `${P}2026/09/04/notauuid.jpg`, want: false, why: 'UUID でない (推測可能になる)' },
  { key: `${P}2026/09/04/${UUID.toUpperCase()}.jpg`, want: false, why: '大文字 UUID は採番しない' },
  { key: `${P}2026/9/4/${UUID}.jpg`, want: false, why: 'ゼロ埋めなし' },
  { key: `${P}2026/09/04/sub/${UUID}.jpg`, want: false, why: '階層が深い' },
  { key: `scan-uploads/2026/09/04/${UUID}.jpg`, want: false, why: 'prefix が無い' },
  { key: `other/${P}2026/09/04/${UUID}.jpg`, want: false, why: 'prefix が先頭でない' },
  { key: '', want: false, why: '空' },
];

let failed = 0;
for (const c of cases) {
  const got = isScanUploadKey(c.key, cfg);
  const pass = got === c.want;
  if (!pass) failed++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${c.want ? '通す' : '弾く'}: ${c.why}` +
      (pass ? '' : `  (期待 ${c.want} / 実際 ${got})  key=${c.key}`),
  );
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
