/**
 * 現地実行の bat (接続チェック / 初回セットアップ) が Wellfort 側で実行されたかを
 * **こちらから確認する**口。どの版が走ったかは report.txt の「版」行で分かる。
 *
 * 正本: `docs/lab/demecal_powershell_probe_guide.md` §「実行ログの回収」。
 *
 * 【なぜ作ったか】受け口 (`probe-upload`) は書き込み専用で、回収は S3 コンソールを
 *   直接見る前提だった。ところが **AWS キーは Vercel の env に集中管理**していて
 *   ローカルに置かない (`CLAUDE.md` 確定事項) ため、`aws s3 ls` が使えず、
 *   コンソールを開ける人しか実行有無を判定できなかった。
 *   → **同じトークンで開く読み取り専用の口**を足す (2026-08-30)。
 *
 * 【安全側の作り】
 *   ・認可は `probe-bat` と同じ **env `PROBE_UPLOAD_TOKEN`** (`?k=`)。
 *     **`ADMIN_API_KEY` は使わない** — 配布物に埋まるトークンと同じ寿命に閉じる。
 *   ・env 未設定なら **503** (既定 off・fail-closed)。配布/受取と 1 つの env で同時に開閉する。
 *   ・**`{prefix}ops/probe/` 配下しか触らない**。任意キーの読み出しはできない
 *     (`?key=` は前方一致で検証し、外れたら 400)。
 *   ・返すのはテキストのみ。`page.html` は一覧に出すが**本文は返さない**
 *     (ログイン前ページとはいえ HTML を素で返す口を作らない)。
 *
 * 使い方:
 *   GET /api/ops/probe-list?k=<token>              … 実行の一覧 (新しい順)
 *   GET /api/ops/probe-list?k=<token>&key=<report.txt の key> … その report.txt の中身
 */

import type { APIRoute } from 'astro';
import { getObjectText, getS3Config, isS3Configured, listObjects } from '../../../lib/s3';

export const prerender = false;

/** report.txt を返すときの上限。受け口の上限 (256KB) と揃える。 */
const MAX_REPORT_BYTES = 256 * 1024;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** `{AWS_S3_PREFIX}ops/probe/` を組み立てる (probe-upload の保存先と同じ規則)。 */
function probeRoot(): string {
  const cfg = getS3Config();
  const prefix = (cfg?.prefix ?? '').replace(/^\/+/, '').replace(/\/*$/, '/');
  return `${prefix}ops/probe/`;
}

export const GET: APIRoute = async ({ url }) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) {
    return json({ ok: false, error: 'disabled', detail: 'PROBE_UPLOAD_TOKEN 未設定 (既定 off)' }, 503);
  }
  if ((url.searchParams.get('k') ?? '').trim() !== expected) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!isS3Configured()) return json({ ok: false, error: 's3_not_configured' }, 400);

  const root = probeRoot();

  // ── 1 件の report.txt を読む ──────────────────────────────
  const key = (url.searchParams.get('key') ?? '').trim();
  if (key) {
    // **prefix の外は絶対に読ませない。** 相対指定 (..) も弾く。
    if (!key.startsWith(root) || key.includes('..')) {
      return json({ ok: false, error: 'out_of_scope', detail: `${root} 配下のみ` }, 400);
    }
    if (!key.endsWith('.txt')) {
      return json({ ok: false, error: 'text_only', detail: 'report.txt のみ返します' }, 400);
    }
    try {
      const text = await getObjectText(key);
      const truncated = text.length > MAX_REPORT_BYTES;
      return json({ ok: true, key, truncated, report: truncated ? text.slice(0, MAX_REPORT_BYTES) : text });
    } catch (err) {
      return json({ ok: false, error: 'read_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
  }

  // ── 実行の一覧 ────────────────────────────────────────────
  try {
    const objs = await listObjects(root);

    /*
     * キーの形: `{root}{YYYY-MM-DD}/{label}-{PC名}-{uuid}/report.txt`
     * 1 実行 = 1 フォルダなので、フォルダ単位にまとめる。
     */
    const runs = new Map<string, { date: string; folder: string; files: { name: string; size: number }[] }>();
    for (const o of objs) {
      const rest = o.key.slice(root.length);
      const parts = rest.split('/');
      if (parts.length < 3) continue; // 想定外の配置は無視 (捏造しない)
      const [date, dir, ...tail] = parts;
      const folder = `${root}${date}/${dir}/`;
      const cur = runs.get(folder) ?? { date, folder, files: [] };
      cur.files.push({ name: tail.join('/'), size: o.size });
      runs.set(folder, cur);
    }

    const list = [...runs.values()]
      // 新しい順。同日は uuid 込みのフォルダ名で安定化させる。
      .sort((a, b) => (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0))
      .map((r) => {
        const dir = r.folder.slice(`${root}${r.date}/`.length).replace(/\/$/, '');
        let label: string;
        let host: string;
        let uuid: string;
        if (dir.includes('~')) {
          // 現行 (`probe-upload` 2026-09-01 以降): `{label}~{PC名}~{uuid}`。
          // `~` は slug() が通さないので曖昧さが無い。
          const seg = dir.split('~');
          label = seg[0] ?? dir;
          host = seg[1] ?? '';
          uuid = seg.slice(2).join('~');
        } else {
          /*
           * 旧 (`-` 区切り): `{label}-{PC名}-{uuid}` を後ろから割る。
           * **PC名が `-` を含むと正しく割れない** (実測: `DESKTOP-S0J0000` が
           * label=`demecal-recon-DESKTOP` / host=`S0J0000` になった)。
           * 過去のフォルダを読むためだけに残す。新しい実行はここに来ない。
           */
          const seg = dir.split('-');
          uuid = seg.length >= 3 ? seg.slice(-5).join('-') : '';
          host = seg.length >= 6 ? seg[seg.length - 6] : '';
          label = seg.length >= 7 ? seg.slice(0, seg.length - 6).join('-') : dir;
        }
        const report = r.files.find((f) => f.name === 'report.txt');
        return {
          date: r.date,
          label,
          host,
          uuid,
          folder: r.folder,
          /** これを `?key=` に渡すと本文が読める。無ければ report.txt が無い異常。 */
          report_key: report ? `${r.folder}report.txt` : null,
          report_bytes: report?.size ?? 0,
          has_page_html: r.files.some((f) => f.name === 'page.html'),
        };
      });

    return json({
      ok: true,
      root,
      /** 0 なら「送信された実行が 1 件も無い」。実行されたが送信が無効だった可能性は別途切り分ける。 */
      count: list.length,
      runs: list,
    });
  } catch (err) {
    return json({ ok: false, error: 'list_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};
