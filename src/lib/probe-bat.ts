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

/**
 * デメカルの ID / PW のプレースホルダ (`scripts/demecal-recon.ps1`)。
 *
 * 【発注者判断 2026-09-01】「bat に平文で今回は構わない。専用PCで、PC に証明書が
 *   入っているので、bat 漏洩しても大きな問題じゃない」。
 *   → 実行時に取りに行く案 (`/api/ops/demecal-cred`) は撤回し、**配布時に焼き込む**。
 *     failure point が 1 つ減る (専用PC 側でのネットワーク取得が不要)。
 *
 * **値はリポジトリに置かない。** トークンと同じく Vercel env から注入する
 * (`DEMECAL_USER_ID` / `DEMECAL_PASSWORD`)。`.ps1` はプレースホルダのまま commit する。
 */
export const DEMECAL_USER_PLACEHOLDER = '__DEMECAL_USER__';
export const DEMECAL_PASS_PLACEHOLDER = '__DEMECAL_PASS__';
/**
 * 本番の自動実行 (bat ②) が使う**取り込み専用キー**の差し込み位置。
 * `ADMIN_API_KEY` は**絶対に焼き込まない** — 専用PC に置いてよい鍵ではない
 * (`demecal_unattended_spec §3.1`)。通るのは取り込みの 3 口だけ。
 */
export const INTAKE_KEY_PLACEHOLDER = '__LAB_INTAKE_KEY__';

/** bat 側で pause するので PowerShell 側の入力待ちは外す。 */
const READ_HOST_LINE = 'Read-Host "確認できたら Enter キーを押してください"\n';

export interface ProbeBatResult {
  /** BOM 無し UTF-8 / CRLF のバイト列。 */
  bytes: Uint8Array;
  /** cmd 部の行数 (= PowerShell 部の開始 index)。 */
  skip: number;
}

/** cmd の `title` に置ける形へ落とす (ASCII のみ・cmd の特殊文字を除去)。 */
function asciiTitle(v?: string): string {
  const s = (v ?? '').replace(/[^\x20-\x7E]/g, '').replace(/[&|<>^%"]/g, '').trim();
  return s || 'Demecal';
}

/** PowerShell のシングルクォート文字列へ安全に入れる (`'` は `''` へ)。 */
function psQuote(v: string): string {
  return v.split("'").join("''");
}

/**
 * @param ps1     `scripts/demecal-probe.ps1` / `demecal-recon.ps1` の中身
 * @param token   埋め込む `PROBE_UPLOAD_TOKEN`。省略すると送信なし版
 *                (bat は「自動送信は無効です」と表示し、デスクトップのファイルだけ残す)
 * @param creds   デメカルの ID / PW。`.ps1` がプレースホルダを持つときは**必須**。
 *                持たない `.ps1` (接続チェック) では無視される。
 */
export function buildProbeBat(
  ps1: string,
  token?: string,
  creds?: { user?: string; pass?: string; intakeKey?: string },
  title?: string,
): ProbeBatResult {
  let ps = ps1.replace(READ_HOST_LINE, '');

  /*
   * 調査用トークンの差し込み。
   *
   * **プレースホルダを持たない .ps1 もある**ので「無ければ落とす」にしない。
   * ①(probe/recon) は結果を `probe-upload` へ送るのでトークンが要るが、
   * ②(daily) は**取り込み専用キーで実行ログAPIへ報告する**ので使わない
   * (`demecal_unattended_spec §3.1`)。ここで必須にすると②が配れない (実測 2026-09-02)。
   * 逆に「プレースホルダはあるのに値が無い」ときは、送信できない bat を配ることに
   * なるので**落とす** — 資格情報と同じ扱い。
   */
  if (ps.includes(PROBE_TOKEN_PLACEHOLDER)) {
    if (!token) throw new Error(`${PROBE_TOKEN_PLACEHOLDER} を持つ .ps1 ですがトークンが渡されていません`);
    // PowerShell のシングルクォート文字列に入れるので ' だけは通せない。
    if (token.includes("'")) throw new Error("トークンに ' は使えません");
    ps = ps.split(PROBE_TOKEN_PLACEHOLDER).join(token);
  }

  /*
   * 資格情報の差し込み。**プレースホルダがあるのに値が無ければ落とす。**
   * 差し込まないまま配ると、専用PC で [2] を通過できずにまた 1 往復になる
   * (実測 2026-09-01: recon が 2 版続けてここで止まった)。**黙って配らない。**
   */
  if (ps.includes(INTAKE_KEY_PLACEHOLDER)) {
    if (!creds?.intakeKey) {
      throw new Error('LAB_INTAKE_API_KEY が未設定です (② は取り込み専用キーが無いと動きません)');
    }
    ps = ps.split(INTAKE_KEY_PLACEHOLDER).join(psQuote(creds.intakeKey));
  }
  if (ps.includes(DEMECAL_USER_PLACEHOLDER) || ps.includes(DEMECAL_PASS_PLACEHOLDER)) {
    if (!creds?.user || !creds?.pass) {
      throw new Error(
        'デメカルの ID/PW が未設定です (Vercel env: DEMECAL_USER_ID / DEMECAL_PASSWORD)',
      );
    }
    ps = ps.split(DEMECAL_USER_PLACEHOLDER).join(psQuote(creds.user));
    ps = ps.split(DEMECAL_PASS_PLACEHOLDER).join(psQuote(creds.pass));
  }

  const head = [
    '@echo off',
    'chcp 65001 >nul',
    /*
     * ウィンドウ名。**スクリプトと版を必ず入れる。**
     *
     * 【なぜ — 実測 2026-09-01】ここが全版・全スクリプトで
     * `Demecal connection check` 固定だったため、接続チェックの窓も
     * v1.1 の窓も v1.7 の窓も**タスクバー上で見分けが付かなかった**。
     * 実際に「v1.7 が 30 分終わらない」と報告された窓が、
     * [2] の資格情報ダイアログで止まったままの旧版の窓だった疑いが出ている。
     * **cmd 部は ASCII のみ**(自己検証で弾かれる)なので英字で書く。
     */
    `title ${asciiTitle(title)}`,
    // PowerShell 自身のエラー (構文エラー・未捕捉の例外) は stderr に出る。
    // **ここで拾わないと、スクリプトが 1 行も動かなかった場合に何も残らない**
    // (実測 2026-09-01: recon が 2 版続けて無反応で、起動したのかどうかも分からなかった)。
    // stdout は触らないので画面表示は従来どおり。
    'set "ERRLOG=%TEMP%\\demecal_error.txt"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command '
      + '"$s=Get-Content -LiteralPath \'%~f0\' -Encoding UTF8; '
      + 'Invoke-Expression (($s[{SKIP}..($s.Count-1)]) -join [Environment]::NewLine)" 2> "%ERRLOG%"',
    'echo.',
    'echo ---- error log (empty is normal): %ERRLOG%',
    'type "%ERRLOG%"',
    'echo.',
    'pause',
    'exit /b',
  ];
  const skip = head.length;
  // powershell 行の位置は固定でなく探す (ヘッダに行を足したときに黙ってずれないように)。
  const psLine = head.findIndex((l) => l.startsWith('powershell '));
  if (psLine < 0) throw new Error('powershell 行が見つかりません');
  head[psLine] = head[psLine].replace('{SKIP}', String(skip));

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
