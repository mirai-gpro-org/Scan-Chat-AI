/**
 * デメカル 本番取得の **タスクスケジューラ登録 bat** を組む (Phase C / C-5)。
 * 正本: docs/lab/demecal_recovery_plan_20260902.md §7.2 C-5
 *
 * 【Reality Check: なぜ `buildProbeBat()` を再利用しないのか — 2026-09-03】
 *   scheduler の .ps1 は 1 本なので、形の上では `buildProbeBat()` に載る。
 *   実際に読んで確かめたところ、載せられない理由が 2 つあった:
 *
 *   ①**`__DAILY_AT__` を知らない。** `buildProbeBat()` が扱うプレースホルダは
 *     `__PROBE_TOKEN__` / `__LAB_INTAKE_KEY__` / `__DEMECAL_USER__` / `__DEMECAL_PASS__`
 *     の 4 つだけ (`probe-bat.ts`)。実行時刻を差し込み、**未設定・不正なら配らない**
 *     という契約を持たせるには、あちらへ production 向けの分岐を足すことになる。
 *     → 「特殊分岐を足す必要があるなら使わない」の指示どおり、別 builder にする。
 *   ②**終了コードを握りつぶす。** `buildProbeBat()` の cmd 部は `exit /b` で終わり
 *     `%ERRORLEVEL%` を返さない (`probe-bat.ts`)。C-5 は
 *     `SCHEDULER_INSTALL_FAILED` → exit != 0 が契約なので、そのままでは成立しない。
 *
 *   → cmd 部は C-4.1 と同じ `demecal-bat.ts` の共有ラッパを使う。
 *     **`buildProbeBat()` は 1 行も変えない** (recon / verify / 接続チェックの配布は現行のまま)。
 *
 * 【この bat に焼き込むもの / 焼き込まないもの】
 *   焼き込む   … 実行時刻 `HH:mm` だけ (`DEMECAL_DAILY_AT`)。**秘密ではない。**
 *   焼き込まない … `ADMIN_API_KEY` / `LAB_INTAKE_API_KEY` / `PROBE_UPLOAD_TOKEN` /
 *                  デメカルの ID・PW / Windows のパスワード。
 *   登録するタスクは **`InteractiveToken`** なので Windows のパスワードを保存しない。
 *   取り込み専用キーは C-4.1 が **production.ps1 の中**へ入れてあるので、
 *   登録側が鍵を持つ必要が無い。
 */

import { psQuote, readPs1Version, wrapPs1AsBat } from './demecal-bat';

/** `.ps1` 側の差し込み位置。 */
export const DAILY_AT_PLACEHOLDER = '__DAILY_AT__';

/**
 * 実行時刻の書式。**厳密一致のみ。**
 * `9:30` (桁落ち) / `24:00` / `09:60` は通さない。`\z` を使うのは
 * JS の `$` が `m` フラグ無しでも末尾の改行の手前に一致し得るため。
 */
export const DAILY_AT_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** 登録するタスク名。**`.ps1` 側と同じ値でなければならない**ので突き合わせる。 */
export const TASK_NAME = 'Wellfort-Demecal-Acquisition';

export interface SchedulerInput {
  /** `scripts/demecal-scheduler.ps1` の中身 (プレースホルダ入り)。 */
  ps1: string;
  /** `DEMECAL_DAILY_AT`。`HH:mm`。**既定値は作らない** (repo 上で未確定のため)。 */
  dailyAt: string;
}

export interface SchedulerResult {
  bytes: Uint8Array;
  /** `scheduler-1.0`。配布ファイル名と画面に出す。 */
  version: string;
  /** 焼き込んだ実行時刻。 */
  dailyAt: string;
}

/**
 * 登録 .ps1 の **PowerShell 本文だけ**を返す (bat に包まない)。
 *
 * 【なぜ分けたか — 2026-09-03 / 最終セットアップ BAT】
 * 最終セットアップ BAT は登録の安全契約 (preflight → Disabled で登録 →
 * 読み戻して照合 → 不一致なら登録を消す) を**書き写さない**。
 * ここで本文を取り出して**そのまま**同梱する。
 * → 登録のロジックは `scripts/demecal-scheduler.ps1` の 1 か所にしかない。
 */
export interface SchedulerPayload {
  /** `__DAILY_AT__` を差し替えただけの .ps1 本文 (CRLF)。 */
  ps: string;
  version: string;
  dailyAt: string;
}

export function buildSchedulerPayload(input: SchedulerInput): SchedulerPayload {
  const at = (input.dailyAt ?? '').trim();
  if (!at) {
    throw new Error('DEMECAL_DAILY_AT が未設定です (実行時刻は業務判断。既定値をコード側で作らない)');
  }
  if (!DAILY_AT_RE.test(at)) {
    throw new Error(`DEMECAL_DAILY_AT の書式が不正です: '${at}' (HH:mm / 00:00-23:59)`);
  }

  if (!input.ps1.includes(DAILY_AT_PLACEHOLDER)) {
    throw new Error(`${DAILY_AT_PLACEHOLDER} が demecal-scheduler.ps1 にありません (差し込み先が消えた)`);
  }
  // 登録側は「タスク名」以外に外部から入るものが無い。念のため .ps1 と突き合わせる
  // (名前がずれると、登録したものと読み戻すものが別になり照合が意味を失う)。
  if (!input.ps1.includes(`$TaskName = '${TASK_NAME}'`)) {
    throw new Error(`タスク名が ${TASK_NAME} と一致しません`);
  }

  const ps = input.ps1.split(DAILY_AT_PLACEHOLDER).join(psQuote(at));
  if (ps.includes(DAILY_AT_PLACEHOLDER)) throw new Error('実行時刻の差し込みに漏れがあります');

  return { ps: ps.replace(/\r?\n/g, '\r\n'), version: readPs1Version(ps), dailyAt: at };
}

export function buildDemecalSchedulerBat(input: SchedulerInput): SchedulerResult {
  const { ps, version, dailyAt } = buildSchedulerPayload(input);

  const { bytes } = wrapPs1AsBat(
    ps,
    `demecal-scheduler v${version.split('-').pop()}`,
    'demecal_scheduler_error.txt',
  );

  return { bytes, version, dailyAt };
}
