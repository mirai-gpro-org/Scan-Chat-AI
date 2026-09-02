/**
 * ops: 現地実行スクリプト (`デメカル接続チェック_v*.bat` 等) の配布口。
 * **ファイル名には .ps1 の `$Version` を入れる** (下記 readScriptVersion)。
 *
 * なぜ必要か: .bat はメール添付でも ChatWork でも
 * **セキュリティポリシーで弾かれる** (2026-08-28 実測)。URL なら渡せるので、
 * その場で組み立ててダウンロードさせる。
 *
 * 設計方針 (`probe-upload.ts` と同じ):
 *   ・**既定 off の fail-closed**。env `PROBE_UPLOAD_TOKEN` が設定されている
 *     ときだけ配る。未設定なら 503 (何も出さない)。
 *   ・認可はそのトークン自身 (`?k=`)。**`ADMIN_API_KEY` は使わない**。
 *     env を消せば配布も回収口も同時に閉じる = 後始末が 1 手で済む。
 *   ・**トークンをここで注入する**ので、リポジトリにもメール添付にも乗らない
 *     (`.ps1` はプレースホルダのまま commit されている)。
 *   ・検索避け: `noindex` を付け、キャッシュさせない。
 *
 * 手順書: `docs/lab/demecal_powershell_probe_guide.md`
 */

import type { APIRoute } from 'astro';
// scripts/ の .ps1 をビルド時に文字列として取り込む (実行時の fs 読みは Vercel で不可)。
import PROBE_PS1 from '../../../../scripts/demecal-probe.ps1?raw';
import RECON_PS1 from '../../../../scripts/demecal-recon.ps1?raw';
import DAILY_PS1 from '../../../../scripts/demecal-daily.ps1?raw';
import VERIFY_PS1 from '../../../../scripts/demecal-verify.ps1?raw';
import { buildProbeBat } from '../../../lib/probe-bat';

export const prerender = false;

/**
 * 配布する bat は 2 本 (`docs/lab/demecal_unattended_spec.md §7`)。
 *
 * **Wellfort に何度も実行を頼まない**ため、①で必要な情報を全部取り切る設計にしてある。
 *   ① `?script=recon` … 初回セットアップ＆偵察。資格情報の保存・ログイン・
 *                        CSV ダウンロード画面の form 構造の採取まで 1 回で行う
 *   ② `?script=probe` … 既存の接続チェック (ログインしない)。実行済みなので通常は使わない
 *
 * 本番の自動実行 bat は①の結果を見てから作る (別口で配布)。
 */
const SCRIPTS = {
  probe: { ps1: PROBE_PS1, ja: 'デメカル接続チェック', ascii: 'demecal-check' },
  recon: { ps1: RECON_PS1, ja: 'デメカル初回セットアップ', ascii: 'demecal-setup' },
  // ② 本番の自動実行。①が保存した資格情報を再利用し、毎日 CSV を取り込む。
  // **`ADMIN_API_KEY` は焼き込まない。** 取り込み専用キーだけ (spec §3.1)。
  //
  // **【凍結中 2026-09-02】`daily` は配らない** (下記 FROZEN)。
  // 立て直し計画 `docs/lab/demecal_recovery_plan_20260902.md` により、
  // daily-1.7 の汎用探索器は本番経路から外した。次に現地で走らせるのは
  // `?script=verify` (verify-only) だけで、Phase B の GO が出てからになる。
  daily: { ps1: DAILY_PS1, ja: 'デメカル自動取得', ascii: 'demecal-daily' },
  // Phase B の疎通確認。**書き込みを一切しない** (計画 §6.3)。
  verify: { ps1: VERIFY_PS1, ja: 'デメカル疎通確認', ascii: 'demecal-verify' },
} as const;
type ScriptKey = keyof typeof SCRIPTS;

/**
 * **配布を止めているスクリプト。**
 *
 * 【なぜ口を塞ぐか — 実障害 2026-09-02】daily は v1.0→v1.7 の間、
 * 「失敗 → 診断を足す → 現地でもう一度実行してもらう」を繰り返した。
 * **専用PC の実行は Wellfort 役員に依頼する高コストな本番相当テスト**で、
 * デバッグ工程に使ってはいけない (計画 §0)。
 * 意思だけでは同じことが起きるので、**配布口を閉じて機械で止める**。
 */
const FROZEN: Partial<Record<ScriptKey, string>> = {
  daily:
    'daily-1.7 は凍結中です (docs/lab/demecal_recovery_plan_20260902.md)。\n'
    + '次に現地で実行するのは ?script=verify (verify-only) だけで、\n'
    + 'Phase A のレビューが通ってからになります。',
};

/**
 * `.ps1` の `$Version = 'recon-1.1'` を読む。**配布ファイル名に入れるため**。
 *
 * 【なぜ要るか — 実測 2026-09-01】ファイル名が版によらず同じだと、
 * Wellfort 側は**手元の古い bat と新しい bat を見分けられない**。実際に
 * 「初回セットアップ.bat を実行した」と連絡を受けたが実行ログに届いていたのは
 * 接続チェックだけ、という切り分けの効かない状況になった。
 * → **版をファイル名に出し、担当者が目で確認できるようにする。**
 *
 * 版が読めなければ**落とす**。無言で版なしのファイル名を配ると、
 * 「版が付いていない＝古い」のか「付け忘れ」なのかが区別できなくなる。
 */
function readScriptVersion(ps1: string): string {
  const m = ps1.match(/^\s*\$Version\s*=\s*'([^']+)'/m);
  if (!m) throw new Error('$Version が .ps1 に見つかりません (配布ファイル名に版を入れるため必須)');
  // ファイル名に使える範囲だけ通す (パス区切り・空白を混ぜない)。
  const v = m[1].trim();
  if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new Error(`$Version の書式が不正: ${v}`);
  return v;
}

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) return text('disabled (PROBE_UPLOAD_TOKEN 未設定)', 503);

  const given = (url.searchParams.get('k') || '').trim();
  if (given !== expected) return text('unauthorized', 401);

  // 既定は従来どおり接続チェック (既存の配布 URL を壊さない)。
  const key = ((url.searchParams.get('script') || 'probe').trim() as ScriptKey);
  const spec = SCRIPTS[key];
  if (!spec) return text(`unknown script: ${key} (probe | recon | daily | verify)`, 400);
  const frozen = FROZEN[key];
  if (frozen) return text(frozen, 409);

  let bat: Uint8Array;
  let nameJa: string;
  let nameAscii: string;
  try {
    // デメカルの ID/PW は**リポジトリに置かず** Vercel env から注入する
    // (発注者判断 2026-09-01「bat に平文で今回は構わない」)。
    // 未設定なら buildProbeBat が落とすので、動かない bat を配ってしまうことはない。
    // `recon-1.7` → `1.7`。担当者が見るのは「v1.7」の部分だけでよい。
    const num = readScriptVersion(spec.ps1).split('-').pop() as string;
    bat = buildProbeBat(spec.ps1, expected, {
      user: env('DEMECAL_USER_ID') ?? '',
      pass: env('DEMECAL_PASSWORD') ?? '',
      intakeKey: env('LAB_INTAKE_API_KEY') ?? '',
    }, `${spec.ascii} v${num}`).bytes;
    nameJa = `${spec.ja}_v${num}.bat`;
    nameAscii = `${spec.ascii}-v${num}.bat`;
  } catch (err) {
    return text(`build_failed: ${err instanceof Error ? err.message : String(err)}`, 500);
  }

  return new Response(bat as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bat.byteLength),
      'content-disposition':
        `attachment; filename="${nameAscii}"; `
        + `filename*=UTF-8''${encodeURIComponent(nameJa)}`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
};
