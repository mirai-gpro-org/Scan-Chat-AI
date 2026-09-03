/**
 * デメカル 本番取得 — **最終セットアップ BAT** (1 ファイル・今回の案件専用)。
 * 正本: `docs/lab/demecal_recovery_plan_20260902.md §7.2 最終セットアップ`
 *
 * 【何をするか】Wellfort のダブルクリック 1 回で、順に:
 *   [1] 取得範囲の初期化 (`last_to` の GET → 判定 → POST → GET で確認)
 *   [2] 3 本 + manifest を `C:\demecal\production\` へ配置   ← **C-4.1 をそのまま**
 *   [3] タスク `Wellfort-Demecal-Acquisition` を **無効で**登録 ← **C-5 をそのまま**
 *   [4] `FINAL_SETUP_OK` を表示
 *
 * 【最重要 — 安全ロジックを書き写さない】
 * [2] は `demecal-installer.ts` の `buildInstallerPayload()` が返す本文、
 * [3] は `scripts/demecal-scheduler.ps1` (実行時刻を差し込んだだけ) を
 * **1 バイトも変えずに同梱する**。
 * だから「temp → 全数照合 → 入れ替え → 再照合 → 旧セット破棄」(C-4.1) と
 * 「preflight → Disabled で登録 → 読み戻して照合 → 不一致なら登録を消す」(C-5) は
 * **この新しいファイルには 1 行も無い**。検査 (`verify:demecal-final-setup`) が
 * 「同梱した本文が payload と完全一致していること」を機械で固定する。
 *
 * 【なぜ 4 つの PowerShell を別プロセスで走らせるのか (実装上の要)】
 * [2] と [3] は**それぞれ完結した .ps1** で、自分で `exit` し、`Say` / `Fail` /
 * `Stop-Setup` といった同名の関数を持つ。1 つの PowerShell セッションへ
 * 単純に連結すると **[2] の `exit 0` でそこで全部終わる**し、関数名も衝突する。
 * → `wrapPs1AsBat` が既にやっている「bat が自分自身を読んで
 *   `Invoke-Expression` する」を**行範囲ごとに 4 回**行う。
 *   ・各段は自分のプロセスなので `exit` はその段だけで終わる
 *   ・関数名は衝突しない
 *   ・**ディスクに何も書かない** (一時 .ps1 を作らない = 鍵を余計な場所へ置かない)
 *   ・段ごとの終了コードを cmd 側で見て、失敗したらそこで止める
 *
 * 【秘密】`__LAB_INTAKE_KEY__` は **配布生成時 (Vercel env) に注入**する。
 * リポジトリには実値を置かない (既存 `production-install` と同じ扱い)。
 * `ADMIN_API_KEY` は引数にも無いので**通り道が存在しない**。
 * 生成物は取り込み専用キーを平文で含む**機密ファイル**なので、配布口は
 * `Cache-Control: no-store` で返す。
 *
 * 【やらないこと】`force=true` を送らない / 本番 runner を実行しない /
 * タスクを有効化しない / `schtasks /Run` しない。
 */

import { asciiTitle, psQuote } from './demecal-bat';
import { buildInstallerPayload, INSTALL_ROOT, type InstallerEntry } from './demecal-installer';
import { buildSchedulerPayload, TASK_NAME } from './demecal-scheduler';

/** 今回の案件専用の固定値 (発注者確定 2026-09-03)。**既定値ではなく案件値**。 */
export const INITIAL_LAST_TO = '2026-09-01';
export const FINAL_DAILY_AT = '11:00';
/** 配布ファイルの版。中身を変えたら上げる。 */
export const FINAL_SETUP_VERSION = 'final-setup-1.0';

export interface FinalSetupInput {
  /** `scripts/demecal-production.ps1` の中身 (プレースホルダ入り)。 */
  productionPs1: string;
  /** `scripts/demecal-verify.ps1` の中身。**`$ApiBase` の出どころでもある**。 */
  verifyPs1: string;
  /** `scripts/demecal-range.ps1` の中身。 */
  rangePs1: string;
  /** `scripts/demecal-scheduler.ps1` の中身 (`__DAILY_AT__` 入り)。 */
  schedulerPs1: string;
  /** `LAB_INTAKE_API_KEY`。 */
  intakeKey: string;
}

export interface FinalSetupResult {
  bytes: Uint8Array;
  version: string;
  /** 配置される 3 本の SHA-256 (監査表示用・C-4.1 と同じ値)。 */
  entries: InstallerEntry[];
  /** 焼き込んだ値。報告に出す (秘密ではない)。 */
  initialLastTo: string;
  dailyAt: string;
  apiBase: string;
  /** 段ごとの行範囲 (検査が突き合わせる)。 */
  ranges: { name: string; from: number; to: number }[];
}

/**
 * `$ApiBase` を **`demecal-verify.ps1` から読む**。
 * ここで URL をもう 1 か所ベタ書きすると、移行時に片方だけ直して黙ってずれる。
 */
export function readApiBase(verifyPs1: string): string {
  const m = verifyPs1.match(/^\s*\$ApiBase\s*=\s*'([^']+)'/m);
  if (!m) throw new Error('$ApiBase が demecal-verify.ps1 に見つかりません');
  const v = m[1].trim();
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(v)) throw new Error(`$ApiBase の書式が不正: ${v}`);
  return v;
}

/** `YYYY-MM-DD` の厳密一致。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 行頭が `#` の行 (= 解説) を落として**実行行だけ**にする。
 *
 * 【なぜ要るか — 実測 2026-09-03・**2 回続けて踏んだ**】禁止語の走査を素の全文に
 * 当てたところ、①`demecal-scheduler.ps1:13` の「`schtasks /Run` **しない**」
 * ②この builder が [1] に書いた「**`force` を送らない**」の 2 つに誤爆して、
 * 生成そのものが落ちた。**禁止語は「やらない」と書いた文にこそ出る。**
 * C-5 (`verify:ps1-order`) / C-6 (`Date.now()` / `STALE_DAYS`) と同じ穴。
 *
 * 行内の後置コメントまでは落とさない (`#` は文字列にも出るので、
 * 雑に切ると**実行行を削って検査を素通しさせる**方が危ない)。
 */
function onlyCode(ps: string): string {
  return ps.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
}

/* ── [1] 取得範囲の初期化 (この段だけが新しいコード) ───────────────── */

function stateInitPayload(apiBase: string, intakeKey: string, initialLastTo: string): string {
  const q = (v: string) => `'${psQuote(v)}'`;
  const L: string[] = [];
  const P = (s: string) => L.push(s);

  P('# デメカル 本番取得 — 最終セットアップ [1/3] 取得範囲の初期化');
  P('#');
  P('# **`force` を送らない。** 巻き戻しはこの段の仕事ではないので、');
  P('# 既に先へ進んでいたら「変更せずに止める」。');
  P('# POST の応答を信じず、**必ず GET で読み直して**確かめる。');
  P('');
  P("$ErrorActionPreference = 'Continue'");
  P(`$ApiBase       = ${q(apiBase)}`);
  P(`$IntakeKey     = ${q(intakeKey)}`);
  P(`$InitialLastTo = ${q(initialLastTo)}`);
  P("$StateUrl = \"$ApiBase/api/admin/demecal-state\"");
  P("$H = @{ 'x-intake-key' = $IntakeKey }");
  P('');
  P('function Say([string]$m) { Write-Host $m }');
  P('function Stop-Step([string]$code, [string]$msg) {');
  P("  Say ''");
  P("  Say ('コード: {0}: {1}' -f $code, $msg)");
  P("  Say '  ここで止めました。次の手順へ進まないでください。'");
  P('  exit 1');
  P('}');
  P('');
  P('function Get-LastTo {');
  P('  $r = [pscustomobject]@{ Ok = $false; LastTo = \'\'; Detail = \'\' }');
  P('  try {');
  P('    $res = Invoke-RestMethod -Uri $StateUrl -Method Get -TimeoutSec 30 -Headers $H');
  P("    if (-not $res.ok) { $r.Detail = 'state API が ok を返しません'; return $r }");
  P('    $r.Ok = $true');
  P('    if ($res.last_to) { $r.LastTo = [string]$res.last_to }   # 未初期化なら空のまま');
  P('    return $r');
  P('  } catch { $r.Detail = $_.Exception.Message; return $r }');
  P('}');
  P('');
  P("Say '=================================================='");
  P("Say ' デメカル 本番取得 — 最終セットアップ'");
  P("Say ' [1/3] 取得範囲の初期化'");
  P("Say '=================================================='");
  P("Say ''");
  P("Say '  ※ ここでは取得しません。取得範囲の開始位置を決めるだけです。'");
  P("Say ''");
  // 未注入で走らせない (production runner と同じガード。文字列は結合して書く)。
  P("if ($IntakeKey -eq ('__LAB_INTAKE' + '_KEY__') -or -not $IntakeKey) {");
  P("  Stop-Step 'INTAKE_KEY_MISSING' '取り込み専用キーが埋め込まれていません (配布のやり直しが必要)'");
  P('}');
  P('');
  P('$cur = Get-LastTo');
  P("if (-not $cur.Ok) { Stop-Step 'STATE_READ_FAILED' $cur.Detail }");
  P("if ($cur.LastTo) { Say ('  いまの last_to : {0}' -f $cur.LastTo) }");
  P("else { Say '  いまの last_to : (未初期化)' }");
  P("Say ('  初期値         : {0}' -f $InitialLastTo)");
  P('');
  P('# 形が違う値を日付として比べない (比較は YYYY-MM-DD の辞書順 = 時系列順)。');
  P("if ($cur.LastTo -and $cur.LastTo -notmatch '^\\d{4}-\\d{2}-\\d{2}$') {");
  P("  Stop-Step 'STATE_FORMAT_UNEXPECTED' ('last_to が日付の形ではありません: {0}' -f $cur.LastTo)");
  P('}');
  P('');
  P('if ($cur.LastTo -and $cur.LastTo -gt $InitialLastTo) {');
  P("  Say ''");
  P("  Say ('  すでに {0} まで進んでいます (初期値 {1} より新しい)。' -f $cur.LastTo, $InitialLastTo)");
  P("  Say '  **値は変更していません。** 巻き戻すと取り込み済みの範囲を取り直すことになるため、'");
  P("  Say '  この画面のまま作業を止めて UNFIX へ連絡してください。'");
  P("  Stop-Step 'LAST_TO_AHEAD' ('既存 {0} > 初期値 {1} — 巻き戻さないので中止' -f $cur.LastTo, $InitialLastTo)");
  P('}');
  P('');
  P('if ($cur.LastTo -eq $InitialLastTo) {');
  P("  Say ''");
  P("  Say ('  すでに {0} です。初期化は要らないのでそのまま次へ進みます。' -f $InitialLastTo)");
  P('} else {');
  P('  # 未初期化 または 初期値より過去 → 初期値へ揃える。');
  P('  try {');
  P('    $body = @{ last_to = $InitialLastTo } | ConvertTo-Json -Compress');
  P('    $p = Invoke-RestMethod -Uri $StateUrl -Method Post -TimeoutSec 30 `');
  P("           -ContentType 'application/json; charset=utf-8' -Body $body -Headers $H");
  P("    if (-not $p.ok) { Stop-Step 'STATE_WRITE_FAILED' 'state API が ok を返しません' }");
  P("  } catch { Stop-Step 'STATE_WRITE_FAILED' $_.Exception.Message }");
  P('');
  P('  # **応答を信じない。** 読み直して一致を確かめる。');
  P('  $after = Get-LastTo');
  P("  if (-not $after.Ok) { Stop-Step 'STATE_VERIFY_FAILED' $after.Detail }");
  P('  if ($after.LastTo -ne $InitialLastTo) {');
  P("    Stop-Step 'STATE_VERIFY_MISMATCH' ('書き込み後の last_to が {0} でした (期待 {1})' -f $after.LastTo, $InitialLastTo)");
  P('  }');
  P("  Say ''");
  P("  Say ('  last_to = {0} に設定しました (読み直して確認済み)' -f $after.LastTo)");
  P('}');
  P('');
  P("Say ''");
  P("Say '[1/3] 完了'");
  P('exit 0');

  return L.join('\r\n') + '\r\n';
}

/* ── [4] 完了表示 ─────────────────────────────────────────────────── */

function donePayload(dailyAt: string, initialLastTo: string): string {
  const q = (v: string) => `'${psQuote(v)}'`;
  const L: string[] = [];
  const P = (s: string) => L.push(s);

  P('# デメカル 本番取得 — 最終セットアップ [完了表示]');
  P('#');
  P('# **3 段すべてが成功したときだけ**ここへ来る (cmd 側で終了コードを見ている)。');
  P('');
  P("Write-Host ''");
  P("Write-Host 'FINAL_SETUP_OK'");
  P("Write-Host ''");
  P(`Write-Host ('  取得範囲の開始位置 : {0}' -f ${q(initialLastTo)})`);
  P(`Write-Host ('  自動実行の時刻     : {0} (毎日) ＋ ログオン時' -f ${q(dailyAt)})`);
  P(`Write-Host ('  配置先             : {0}' -f ${q(INSTALL_ROOT)})`);
  P(`Write-Host ('  タスク名           : {0}' -f ${q(TASK_NAME)})`);
  P("Write-Host ''");
  P("Write-Host '  登録したタスクは **無効** のままです。自動では走りません。'");
  P("Write-Host '  有効にするのは UNFIX 側の確認が済んでからです。'");
  P("Write-Host ''");
  P("Write-Host '  この画面をそのまま撮って UNFIX へ送ってください。'");
  P('exit 0');

  return L.join('\r\n') + '\r\n';
}

/* ── 組み立て ─────────────────────────────────────────────────────── */

export function buildDemecalFinalSetupBat(input: FinalSetupInput): FinalSetupResult {
  if (!input.intakeKey) {
    throw new Error('LAB_INTAKE_API_KEY が未設定です (最終セットアップは取り込み専用キーが無いと動きません)');
  }
  if (input.intakeKey.includes("'")) throw new Error("LAB_INTAKE_API_KEY に ' は使えません");
  if (!DATE_RE.test(INITIAL_LAST_TO)) throw new Error(`INITIAL_LAST_TO の書式が不正: ${INITIAL_LAST_TO}`);

  const apiBase = readApiBase(input.verifyPs1);

  // [2] C-4.1 の本文をそのまま。**配置ロジックをここへ書き写さない。**
  const installer = buildInstallerPayload({
    files: {
      'demecal-production.ps1': input.productionPs1,
      'demecal-verify.ps1': input.verifyPs1,
      'demecal-range.ps1': input.rangePs1,
    },
    intakeKey: input.intakeKey,
  });

  // [3] C-5 の .ps1 をそのまま (実行時刻だけ差し込む)。
  const scheduler = buildSchedulerPayload({ ps1: input.schedulerPs1, dailyAt: FINAL_DAILY_AT });

  const phases = [
    { name: 'state', ps: stateInitPayload(apiBase, input.intakeKey, INITIAL_LAST_TO) },
    { name: 'install', ps: installer.ps },
    { name: 'scheduler', ps: scheduler.ps },
    { name: 'done', ps: donePayload(FINAL_DAILY_AT, INITIAL_LAST_TO) },
  ];

  /**
   * cmd 部。**ASCII のみ** (bat の日本語は ANSI コードページで読まれるため。
   * 日本語の表示は全部 PowerShell 側が出す)。
   * 各段は `%~f0` の**自分の行範囲だけ**を `Invoke-Expression` する別プロセス。
   */
  const psCall = (i: number) =>
    'powershell -NoProfile -ExecutionPolicy Bypass -Command '
    + `"$s=Get-Content -LiteralPath '%~f0' -Encoding UTF8; `
    + `Invoke-Expression (($s[{R${i}}]) -join [Environment]::NewLine)" 2>${i === 0 ? '' : '>'} "%ERRLOG%"`;

  const head: string[] = [
    '@echo off',
    'chcp 65001 >nul',
    `title ${asciiTitle(`demecal-final-setup v${FINAL_SETUP_VERSION.split('-').pop()}`, 'demecal')}`,
    'set "ERRLOG=%TEMP%\\demecal_final_setup_error.txt"',
  ];
  phases.forEach((_, i) => {
    head.push(psCall(i));
    head.push('set "RC=%ERRORLEVEL%"');
    // 段が落ちたらそこで止める。**次の段へ進めない。**
    if (i < phases.length - 1) head.push('if not "%RC%"=="0" goto stopped');
  });
  head.push(
    'goto tail',
    ':stopped',
    'echo.',
    'echo FINAL_SETUP_STOPPED  (see the message above)',
    ':tail',
    'echo.',
    'echo ---- error log (empty is normal): %ERRLOG%',
    'type "%ERRLOG%"',
    'echo.',
    'pause',
    'exit /b %RC%',
  );

  // 行範囲を確定して差し込む (`wrapPs1AsBat` の `{SKIP}` と同じ手)。
  const skip = head.length;
  let cursor = skip;
  const ranges: { name: string; from: number; to: number }[] = [];
  for (const p of phases) {
    const n = p.ps.split('\r\n').length - 1; // 末尾は空要素
    ranges.push({ name: p.name, from: cursor, to: cursor + n - 1 });
    cursor += n;
  }
  ranges.forEach((r, i) => {
    const token = `{R${i}}`;
    const at = head.findIndex((l) => l.includes(token));
    if (at < 0) throw new Error(`${token} の差し込み先がありません`);
    head[at] = head[at].replace(token, `${r.from}..${r.to}`);
  });

  const content = head.join('\r\n') + '\r\n' + phases.map((p) => p.ps).join('');
  const bytes = new TextEncoder().encode(content);

  /* ── 壊れたものを配らないための自己検証 ────────────────────────── */
  const lines = content.split('\r\n');
  // eslint-disable-next-line no-control-regex
  if (!lines.slice(0, skip).every((l) => /^[\x00-\x7F]*$/.test(l))) {
    throw new Error('cmd 部に非 ASCII が混ざった');
  }
  if (lines.some((l) => l.includes('{R'))) throw new Error('行範囲の差し込みに漏れがあります');
  for (const r of ranges) {
    if (!lines[r.from]?.startsWith('#')) {
      throw new Error(`段 ${r.name} の開始位置がずれている (${r.from} 行目)`);
    }
  }
  // 範囲が隙間なく連続し、PowerShell 部を余さず覆っていること。
  if (ranges[0].from !== skip) throw new Error('最初の段が cmd 部の直後から始まっていません');
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].from !== ranges[i - 1].to + 1) throw new Error('行範囲に隙間があります');
  }
  if (ranges[ranges.length - 1].to !== lines.length - 2) {
    throw new Error('最後の段が PowerShell 部の末尾まで届いていません');
  }
  // **同梱した本文が payload と完全一致していること** = 書き写していない証拠。
  const slice = (r: { from: number; to: number }) =>
    lines.slice(r.from, r.to + 1).join('\r\n') + '\r\n';
  if (slice(ranges[1]) !== installer.ps) throw new Error('[2] の本文がインストーラ payload と一致しません');
  if (slice(ranges[2]) !== scheduler.ps) throw new Error('[3] の本文が登録 .ps1 と一致しません');
  /**
   * 禁止事項の走査は **この builder が書いた部分だけ** (cmd 部 / [1] / [4]) に当てる。
   *
   * 【なぜ範囲を絞るか — 実測 2026-09-03】全文に当てたら
   * `demecal-scheduler.ps1:13` の**解説文**「`schtasks /Run` しない」に誤爆して
   * 生成そのものが落ちた。C-5・C-6 で踏んだのと同じ穴 (禁止語が
   * 「やらないと書いた文」に出る)。
   * 同梱した 2 本は **payload と一致していること** を上で確かめており、
   * 中身の禁止事項は `verify:demecal-installer` / `verify:demecal-scheduler`
   * が既に見張っている。ここで二重に見ると誤爆するだけで安全は増えない。
   */
  const mine = onlyCode([head.join('\r\n'), phases[0].ps, phases[3].ps].join('\r\n'));
  for (const banned of ['schtasks', 'Enable-ScheduledTask', 'force', 'demecal-production.ps1']) {
    if (mine.includes(banned)) throw new Error(`禁止された操作が含まれています: ${banned}`);
  }

  return {
    bytes,
    version: FINAL_SETUP_VERSION,
    entries: installer.entries,
    initialLastTo: INITIAL_LAST_TO,
    dailyAt: scheduler.dailyAt,
    apiBase,
    ranges,
  };
}
