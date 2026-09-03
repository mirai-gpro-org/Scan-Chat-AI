/**
 * 専用PC で走らせる PowerShell を、ダブルクリックで動く 1 ファイルの .bat に包む。
 * (Phase C の配布共通部 — C-4.1 installer / C-5 scheduler が使う)
 *
 * 【`src/lib/probe-bat.ts` の `buildProbeBat()` とどう違うのか — 使い分けの根拠】
 *   あちらは recon / verify / 接続チェックの配布に**現に使われている**経路で、
 *   `__PROBE_TOKEN__` / `__LAB_INTAKE_KEY__` / `__DEMECAL_USER__` / `__DEMECAL_PASS__` の
 *   4 つのプレースホルダを知っている。**あれは変えない。**
 *   ただし cmd 部が `exit /b` で終わっており **PowerShell の終了コードを返さない**。
 *   Phase C の配布物 (installer / scheduler) は「失敗したら exit != 0」が契約なので、
 *   **終了コードを返す cmd 部**をこちらに置いて共有する。
 *   → `buildProbeBat()` に分岐を足して多目的化しない、というのがこの分割の意図。
 *
 * cmd 部は **ASCII のみ / BOM 無し UTF-8 / chcp 65001**
 * (bat の日本語は ANSI コードページで読まれるので UTF-8 と混ぜると壊れる)。
 */

/** cmd の `title` に置ける形へ落とす (ASCII のみ・cmd の特殊文字を除去)。 */
export function asciiTitle(v: string, fallback: string): string {
  const s = v.replace(/[^\x20-\x7E]/g, '').replace(/[&|<>^%"]/g, '').trim();
  return s || fallback;
}

/** PowerShell のシングルクォート文字列へ安全に入れる (`'` は `''` へ)。 */
export function psQuote(v: string): string {
  return v.split("'").join("''");
}

/** `$Version = 'production-1.0'` を読む。読めなければ落とす (版なしを黙って配らない)。 */
export function readPs1Version(ps1: string): string {
  const m = ps1.match(/^\s*\$Version\s*=\s*'([^']+)'/m);
  if (!m) throw new Error('$Version が .ps1 に見つかりません');
  const v = m[1].trim();
  if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new Error(`$Version の書式が不正: ${v}`);
  return v;
}

export interface BatResult {
  /** BOM 無し UTF-8 / CRLF のバイト列。 */
  bytes: Uint8Array;
  /** cmd 部の行数 (= PowerShell 部の開始 index)。 */
  skip: number;
}

/**
 * PowerShell 本文を .bat に包む。
 *
 * @param ps      PowerShell 本文 (**1 行目は `#` で始まること**。自己検証で見る)
 * @param title   cmd のウィンドウ名 (ASCII へ落とされる)
 * @param errlog  stderr の退避先ファイル名 (`%TEMP%` 配下)
 */
export function wrapPs1AsBat(ps: string, title: string, errlog: string): BatResult {
  const psText = ps.endsWith('\r\n') ? ps : `${ps}\r\n`;

  // **終了コードを握りつぶさない。** 中の PowerShell が 1 でも bat が 0 を返すと
  // 「失敗したのに成功に見える」= 壊れた状態を黙って許すのと同じことになる。
  const head = [
    '@echo off',
    'chcp 65001 >nul',
    `title ${asciiTitle(title, 'demecal')}`,
    `set "ERRLOG=%TEMP%\\${errlog}"`,
    'powershell -NoProfile -ExecutionPolicy Bypass -Command '
      + '"$s=Get-Content -LiteralPath \'%~f0\' -Encoding UTF8; '
      + 'Invoke-Expression (($s[{SKIP}..($s.Count-1)]) -join [Environment]::NewLine)" 2> "%ERRLOG%"',
    'set "RC=%ERRORLEVEL%"',
    'echo.',
    'echo ---- error log (empty is normal): %ERRLOG%',
    'type "%ERRLOG%"',
    'echo.',
    'pause',
    'exit /b %RC%',
  ];
  const skip = head.length;
  // powershell 行の位置は固定でなく探す (ヘッダに行を足したときに黙ってずれないように)。
  const psLine = head.findIndex((l) => l.startsWith('powershell '));
  if (psLine < 0) throw new Error('powershell 行が見つかりません');
  head[psLine] = head[psLine].replace('{SKIP}', String(skip));

  const content = head.join('\r\n') + '\r\n' + psText;
  const bytes = new TextEncoder().encode(content);

  // 壊れた bat を配らないための自己検証 (`buildProbeBat` と同じ規律)。
  const lines = content.split('\r\n');
  // eslint-disable-next-line no-control-regex
  if (!lines.slice(0, skip).every((l) => /^[\x00-\x7F]*$/.test(l))) {
    throw new Error('cmd 部に非 ASCII が混ざった');
  }
  if (!lines[skip]?.startsWith('#')) throw new Error('PowerShell 部の開始位置がずれている');

  return { bytes, skip };
}
