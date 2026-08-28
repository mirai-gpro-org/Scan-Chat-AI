/**
 * `scripts/demecal-probe.ps1` を、ダブルクリックで動く 1 ファイルの .bat に包む。
 *
 * 同じ処理が `scripts/build-demecal-probe-bat.py` にもある (オフラインで作る用)。
 * **両者は同じ bat を出す必要がある**ので、片方を直したらもう片方も直すこと。
 * ここは配布 URL (`/api/ops/probe-bat`) 用で、トークンを **env から** 注入する
 * = トークンがリポジトリにもメール添付にも乗らない、というのが分けている理由。
 *
 * なぜ bat が自分自身を読むのか:
 *   外部ファイルを配らずに済ませるため。cmd 部の行数だけ読み飛ばして
 *   残りを PowerShell として実行する。文字化けを避けるため
 *   **cmd 部は ASCII のみ / BOM 無し UTF-8 / chcp 65001** とする
 *   (bat の日本語は ANSI コードページで読まれるので UTF-8 と混ぜると壊れる)。
 */

/** `.ps1` 内のプレースホルダ。配布時にここへトークンを差し込む。 */
export const PROBE_TOKEN_PLACEHOLDER = '__PROBE_TOKEN__';

/** bat 側で pause するので PowerShell 側の入力待ちは外す。 */
const READ_HOST_LINE = 'Read-Host "確認できたら Enter キーを押してください"\n';

export interface ProbeBatResult {
  /** BOM 無し UTF-8 / CRLF のバイト列。 */
  bytes: Uint8Array;
  /** cmd 部の行数 (= PowerShell 部の開始 index)。 */
  skip: number;
}

/**
 * @param ps1     `scripts/demecal-probe.ps1` の中身
 * @param token   埋め込む `PROBE_UPLOAD_TOKEN`。省略すると送信なし版
 *                (bat は「自動送信は無効です」と表示し、デスクトップのファイルだけ残す)
 */
export function buildProbeBat(ps1: string, token?: string): ProbeBatResult {
  let ps = ps1.replace(READ_HOST_LINE, '');

  if (token) {
    if (!ps.includes(PROBE_TOKEN_PLACEHOLDER)) {
      throw new Error(`プレースホルダ ${PROBE_TOKEN_PLACEHOLDER} が .ps1 に見つかりません`);
    }
    // PowerShell のシングルクォート文字列に入れるので ' だけは通せない。
    if (token.includes("'")) throw new Error("トークンに ' は使えません");
    ps = ps.split(PROBE_TOKEN_PLACEHOLDER).join(token);
  }

  const head = [
    '@echo off',
    'chcp 65001 >nul',
    'title Demecal connection check',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command '
      + '"$s=Get-Content -LiteralPath \'%~f0\' -Encoding UTF8; '
      + 'Invoke-Expression (($s[{SKIP}..($s.Count-1)]) -join [Environment]::NewLine)"',
    'echo.',
    'pause',
    'exit /b',
  ];
  const skip = head.length;
  head[3] = head[3].replace('{SKIP}', String(skip));

  const content = head.join('\r\n') + '\r\n' + ps.replace(/\n/g, '\r\n');
  const bytes = new TextEncoder().encode(content);   // BOM は付けない

  // 壊れた bat を配らないための自己検証 (python 側の assert と同じ)。
  const lines = content.split('\r\n');
  // eslint-disable-next-line no-control-regex
  if (!lines.slice(0, skip).every((l) => /^[\x00-\x7F]*$/.test(l))) {
    throw new Error('cmd 部に非 ASCII が混ざった');
  }
  if (!lines[skip]?.startsWith('#')) throw new Error('PowerShell 部の開始位置がずれている');

  return { bytes, skip };
}
