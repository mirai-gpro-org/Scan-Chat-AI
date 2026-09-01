/**
 * admin: Genoplan の遺伝子検査レポート PDF を**差分で**取得して原本ストレージへ保存する。
 *
 * 正本 = `docs/lab/lab_data_reception_overview.md §4.4`。
 * 認可 = Bearer `ADMIN_API_KEY` (`src/lib/api-auth.ts`)。
 * UI は wellfort-site 側に置く (CLAUDE.md: admin UI=wellfort-site / 処理=Scan-Chat-AI)。
 *
 * 【差分の判断 = ボックスナンバー】発注者指示 2026-09-01。
 *   保存キーを `genoplan/{ボックスナンバー}__{認証キー}.pdf` にしてあるので、
 *   **保存先を list して既にあるボックスナンバーを引けば「取得済み」が分かる**。
 *   取得済みテーブルを別に作らないのは、保存に成功したのに台帳更新に失敗した回で
 *   取り漏れ/二重取得が起きるため (`listOriginalKeys` の説明)。
 *   → **保存できたものだけが「取得済み」**。途中で落ちても次回が拾う。
 *
 * 【1 リクエスト 1 件が既定】実測で PDF は 1 本 **約 21MB / 208 ページ**、
 *   さらに Lambda 側の生成に 30〜60 秒かかることがある。Vercel の関数は 60 秒なので、
 *   **既定 `max=1`** にして呼び出し側が繰り返す (スキャンの「1 画像 = 1 リクエスト」と同じ)。
 *
 * 【PII】一覧は `signer_name`(氏名) / `signer_mobile`(電話) を返すが
 *   `src/lib/genoplan.ts` の型が持たないので、ここには入って来ない。
 *   応答にもボックスナンバー/認証キーしか出さない。
 *   **PDF 本体には氏名が印字されている**が、発注者判断 2026-09-01「暫定でそのまま保存」に従い
 *   原本は無加工で保存する (原本の保管方針は CLAUDE.md 案C′ = S3 ap-northeast-1・10 年)。
 *
 * 【まだやらないこと】**顧客への割り当ては行わない。**
 *   `lab_integration_workflow §2 Workflow 2` は「発注時に external_test_id ↔
 *   diagnostic_user_id を保持して逆引き」だが、その対応表の運用工程が未確定
 *   (`id_management_and_correlation_spec §7-3`)。**割り当てに使う材料 (認証キー・
 *   ボックスナンバー・発行日) を manifest に残しておき、対応表が出来てから紐付ける。**
 *   ここで氏名から推測して割り当てるのは禁止 (PII 分離・捏造ゼロ)。
 */

import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import {
  isGenoplanConfigured, login, listPublishedKits, getPdfUrl, fetchPdf,
  originalKey, boxFromKey, CODE_GENERATING, type GenoplanKit,
} from '../../../lib/genoplan';
import {
  putOriginal, listOriginalKeys, getOriginalsS3Config, isOriginalsS3Configured,
} from '../../../lib/originals-storage';

export const prerender = false;

/** 60 秒の関数なので、これを過ぎたら次の 1 件に手を出さない。 */
const DEADLINE_MS = 45_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

type Outcome = {
  box: string;
  serial: string;
  published_on: string;
  result: 'saved' | 'generating' | 'no_url' | 'not_pdf' | 'error' | 'skipped_deadline';
  bytes?: number;
  sha256?: string;
  storage_url?: string;
  detail?: string;
};

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

/**
 * 認可。**書き込み (POST) は Bearer `ADMIN_API_KEY` だけ。**
 *
 * 差分の確認 (GET=dry-run) に限り `?k=<PROBE_UPLOAD_TOKEN>` も通す。
 * 理由: 同じトークンで開いている `/api/ops/genoplan-probe` が既に**一覧そのもの**を
 * 返しており、dry-run はその部分集合 (件数と発行日だけ・副作用なし) なので**露出が増えない**。
 * **`PROBE_UPLOAD_TOKEN` を消すときにこの経路も一緒に閉じる** (調査用の一時口)。
 */
function authorized(request: Request, url: URL, dryRun: boolean): boolean {
  if (isAdminAuthorized(request)) return true;
  if (!dryRun) return false;
  const probe = env('PROBE_UPLOAD_TOKEN');
  return !!probe && (url.searchParams.get('k') ?? '').trim() === probe;
}

async function run(request: Request, url: URL): Promise<Response> {
  const isDry = url.searchParams.get('dry') === '1';
  if (!authorized(request, url, isDry)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!isGenoplanConfigured()) {
    return json({ ok: false, error: 'not_configured', detail: 'GENOPLAN_LOGIN_ID / GENOPLAN_PASSWORD が未設定' }, 400);
  }

  /** 実際には取らずに差分だけ見る。運用前の確認用。 */
  const dryRun = isDry;
  const max = Math.min(Math.max(Number(url.searchParams.get('max') ?? 1) || 1, 1), 10);
  const t0 = Date.now();

  try {
    const session = await login();
    if (!session.canDownloadPdf) {
      return json({ ok: false, error: 'no_pdf_permission', detail: 'このアカウントに auth_pdf_down がありません' }, 403);
    }

    // ── ① Genoplan 側の発行済み一覧 ────────────────────────
    const kits = await listPublishedKits(session);

    // ── ② 保存先にあるボックスナンバー ─────────────────────
    const savedKeys = await listOriginalKeys('genoplan/');
    const savedBoxes = new Set(savedKeys.map(boxFromKey).filter((x): x is string => !!x));

    // ── ③ 差分 ────────────────────────────────────────────
    //
    // **期限切れ (`serviceExpireYN=Y`) は取りに行かない** — 画面でも選べない行なので、
    // 叩いても URL が返らない。取れないものを毎回試して失敗記録を積まない。
    const pending: GenoplanKit[] = [];
    const expired: GenoplanKit[] = [];
    for (const k of kits) {
      const box = k.boxNumber || `sn-${k.serialNumber}`;
      if (savedBoxes.has(box)) continue;
      (k.serviceExpired ? expired : pending).push(k);
    }
    // 古い順に取る (発行日の昇順)。回を跨いでも順番が安定する。
    pending.sort((a, b) => (a.publishedOn < b.publishedOn ? -1 : a.publishedOn > b.publishedOn ? 1 : 0));

    const summary = {
      published_total: kits.length,
      already_saved: savedBoxes.size,
      pending: pending.length,
      skipped_expired: expired.length,
      // ボックスナンバーが空の行は保存キーが `sn-…` になる。運用で気づけるように数える。
      without_box_number: kits.filter((k) => !k.boxNumber).length,
      /**
       * **どこへ書くのかを書く前に見せる。** 原本バケットが未設定だと
       * Supabase Storage へ落ちる (原本の置き場は S3 ap-northeast-1 が正・CLAUDE.md 案C′)。
       * 1 本 21MB なので、意図しない側に 1.5GB 書いてしまうと取り返しがつかない。
       */
      storage_backend: isOriginalsS3Configured() ? 's3' : 'supabase',
      storage_target: (() => {
        const c = getOriginalsS3Config();
        return c ? `s3://${c.bucket}/${c.prefix}genoplan/ (${c.region})` : 'supabase storage: lab-results/genoplan/';
      })(),
      estimated_bytes_if_all: pending.length * 21_000_000,
    };

    if (dryRun) {
      return json({
        ok: true, dry_run: true, elapsed_ms: Date.now() - t0, summary,
        // 何が残っているかは**件数と発行日**だけ出す (識別子を無用に並べない)。
        pending_published_on: pending.slice(0, 50).map((k) => k.publishedOn),
      });
    }

    // ── ④ 取得 (既定 1 件) ────────────────────────────────
    const outcomes: Outcome[] = [];
    for (const kit of pending.slice(0, max)) {
      const box = kit.boxNumber || `sn-${kit.serialNumber}`;
      const base = { box, serial: kit.serialNumber, published_on: kit.publishedOn };
      if (Date.now() - t0 > DEADLINE_MS) {
        outcomes.push({ ...base, result: 'skipped_deadline' });
        break;
      }
      try {
        const { url: pdfUrl, code, message } = await getPdfUrl(kit);
        if (!pdfUrl) {
          // 6020 = 生成中。**失敗として記録しない**。保存しないので次回また候補に上がる。
          outcomes.push({
            ...base,
            result: code === CODE_GENERATING ? 'generating' : 'no_url',
            detail: `code=${code} message=${message ?? ''}`,
          });
          continue;
        }
        const body = await fetchPdf(pdfUrl);
        // 中身が本当に PDF かを見てから保存する (エラーページを原本として残さない)。
        const magic = new TextDecoder().decode(body.slice(0, 5));
        if (magic !== '%PDF-') {
          outcomes.push({ ...base, result: 'not_pdf', bytes: body.byteLength, detail: `magic=${magic}` });
          continue;
        }
        const saved = await putOriginal({
          key: originalKey(kit),
          contentType: 'application/pdf',
          body,
        });
        // 割り当て用の材料を横に置く (**氏名・電話は入れない**)。
        await putOriginal({
          key: originalKey(kit).replace(/\.pdf$/, '.json'),
          contentType: 'application/json; charset=utf-8',
          body: new TextEncoder().encode(JSON.stringify({
            source: 'genoplan',
            external_test_id: kit.serialNumber,   // 認証キー
            external_barcode: kit.boxNumber,      // ボックスナンバー
            report_seq: kit.reportSeq,
            published_on: kit.publishedOn,
            pdf_sha256: saved.sha256,
            pdf_bytes: saved.sizeBytes,
            fetched_at: new Date().toISOString(),
            note: '顧客への割り当ては未実施 (対応表の運用工程が未確定・id_management_and_correlation_spec §7-3)',
          }, null, 2)),
        });
        outcomes.push({
          ...base, result: 'saved',
          bytes: saved.sizeBytes, sha256: saved.sha256, storage_url: saved.storageUrl,
        });
      } catch (e) {
        outcomes.push({ ...base, result: 'error', detail: e instanceof Error ? e.message : String(e) });
      }
    }

    return json({
      ok: outcomes.every((o) => o.result === 'saved' || o.result === 'generating'),
      elapsed_ms: Date.now() - t0,
      summary,
      /** 取り切るまで同じ口を呼び直す。保存できた分だけ pending が減る。 */
      remaining_after: Math.max(summary.pending - outcomes.filter((o) => o.result === 'saved').length, 0),
      outcomes,
    });
  } catch (e) {
    return json({ ok: false, error: 'failed', detail: e instanceof Error ? e.message : String(e) }, 502);
  }
}

/** 差分の確認だけ (`?dry=1` 相当も可)。副作用を持たせない。 */
export const GET: APIRoute = async ({ request, url }) => {
  const u = new URL(url);
  u.searchParams.set('dry', '1');
  return run(request, u);
};

/** 実際に取得して保存する。既定 1 件 (`?max=N` で最大 10)。 */
export const POST: APIRoute = ({ request, url }) => run(request, new URL(url));
