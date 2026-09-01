/**
 * ops: 偵察 bat (`scripts/demecal-recon.ps1`) がデメカルのログイン情報を取りに来る口。
 *
 * 【なぜ作ったか — 発注者指示 2026-09-01】
 *   「ユーザーに入力してもらうのは無し。事前に ID/PW を渡してもらった意味がない」。
 *   そのとおりで、v1.5 までは `Get-Credential`(GUI) → `Read-Host`(コンソール) と
 *   入力方式を変えていただけで、**入力させること自体が誤り**だった。
 *   実測でも WELLFORT_PC の 2 回とも `[2] 資格情報` の手前で止まっている
 *   (段階報告: 起動 → 0-保存先 → 1-証明書 まで届き 2-資格情報 が来ない)。
 *   接続チェック(probe)が毎回届いていたのは**入力を一切求めないから**で、
 *   ① も同じ形にすれば同じように届く。
 *
 * 【なぜ bat に焼き込まないのか】
 *   焼き込むと**デメカルのパスワードが平文の .bat として専用PC の
 *   ダウンロードフォルダに残り続ける**。Pマーク対応の PC でそれは避けたい。
 *   秘匿値は Vercel env に集中管理する (CLAUDE.md 確定事項) 方針にも沿わない。
 *   → **実行時にこの口から取る**。PC 上に残るのは DPAPI 暗号化された
 *     `C:\demecal\secrets\demecal.cred.xml` だけ (これは ② が再利用するので必要)。
 *
 * 【安全側の作り】`probe-bat.ts` / `probe-list.ts` と同じ規律。
 *   ・**既定 off の fail-closed**。env `PROBE_UPLOAD_TOKEN` が無ければ 503。
 *   ・認可はそのトークン (`?k=`)。**`ADMIN_API_KEY` は使わない** —
 *     配布物に埋まるトークンと同じ寿命に閉じる。用が済んだら env を消せば
 *     配布・回収・この口が**同時に閉まる**。
 *   ・`DEMECAL_USER_ID` / `DEMECAL_PASSWORD` が未設定なら 503 (**空で返さない**)。
 *     空を返すと PC 側が「空のまま login して失敗」になり原因が分かりにくい。
 *   ・**値をログに出さない。** 例外メッセージにも載せない。
 *   ・`no-store` / `noindex`。
 *
 * 用が済んだら `PROBE_UPLOAD_TOKEN` と併せて
 * `DEMECAL_USER_ID` / `DEMECAL_PASSWORD` も Vercel から消すこと。
 */

import type { APIRoute } from 'astro';

export const prerender = false;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) {
    return json({ ok: false, error: 'disabled', detail: 'PROBE_UPLOAD_TOKEN 未設定 (既定 off)' }, 503);
  }
  if ((url.searchParams.get('k') ?? '').trim() !== expected) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const user = env('DEMECAL_USER_ID');
  const pass = env('DEMECAL_PASSWORD');
  if (!user || !pass) {
    // **どちらが欠けているかだけ返す。値そのものには触れない。**
    return json({
      ok: false,
      error: 'not_configured',
      detail: `Vercel env 未設定: ${[!user && 'DEMECAL_USER_ID', !pass && 'DEMECAL_PASSWORD'].filter(Boolean).join(' / ')}`,
    }, 503);
  }

  return json({ ok: true, user, pass });
};
