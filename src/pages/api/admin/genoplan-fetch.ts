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
  putOriginal, listOriginalKeys, getOriginalsS3Config, isOriginalsS3Configured, sha256Hex,
} from '../../../lib/originals-storage';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const prerender = false;

/**
 * 【テスト用の保存先】`?dest=exchange`。
 *
 * 発注者指示 2026-09-01「PDF は S3 の `wellfort-partner-exchange` にフォルダを作って保存」。
 * このバケットは LAiF/プリベントとの受渡用で **ap-northeast-1・2026-08-27 作成済**
 * (`docs/lab/laif_s3_secure_handoff_spec.md §7`)。**原本ストレージ (案C′) ではない**ので、
 * ここに置いたものは 10 年保管・削除不可の対象にならない = **テストとして安全に捨てられる**。
 * 本番運用では `dest=originals` (既定) に戻す。
 */
const EXCHANGE_BUCKET = 'wellfort-partner-exchange';
const EXCHANGE_REGION = 'ap-northeast-1';
const EXCHANGE_PREFIX = 'genoplan/';

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
 * 認可。**原本ストレージへの書き込みは Bearer `ADMIN_API_KEY` だけ。**
 *
 * `?k=<PROBE_UPLOAD_TOKEN>` を通すのは次の 2 つに限る:
 *   ① 差分の確認 (dry-run)。副作用が無く、同じトークンで開いている
 *      `/api/ops/genoplan-probe` が既に一覧そのものを返しているので**露出が増えない**。
 *   ② **テスト保存先 (`dest=exchange`) への書き込み**。原本ストレージ (10 年・削除不可) ではなく
 *      受渡用バケットなので**捨てられる**。同じトークンの `/api/ops/probe-upload` も
 *      S3 へ書いており、権限の重さが揃っている。
 * **`PROBE_UPLOAD_TOKEN` を消すとどちらも閉じる** (調査用の一時口)。
 */
function authorized(request: Request, url: URL, dryRun: boolean, dest: Dest): boolean {
  if (isAdminAuthorized(request)) return true;
  if (!dryRun && dest !== 'exchange') return false;
  const probe = env('PROBE_UPLOAD_TOKEN');
  return !!probe && (url.searchParams.get('k') ?? '').trim() === probe;
}

type Dest = 'originals' | 'exchange';

/** 保存先の抽象。差分は**保存先そのものに聞く**ので list と put が対になっている。 */
interface Store {
  label: string;
  list(): Promise<string[]>;
  put(key: string, contentType: string, body: Uint8Array):
    Promise<{ storageUrl: string; sha256: string; sizeBytes: number }>;
}

function originalsStore(): Store {
  const c = getOriginalsS3Config();
  return {
    label: c ? `s3://${c.bucket}/${c.prefix}genoplan/ (${c.region})` : 'supabase storage: lab-results/genoplan/',
    list: () => listOriginalKeys('genoplan/'),
    put: async (key, contentType, body) => {
      const r = await putOriginal({ key, contentType, body });
      return { storageUrl: r.storageUrl, sha256: r.sha256, sizeBytes: r.sizeBytes };
    },
  };
}

function exchangeStore(): Store {
  const client = new S3Client({
    region: EXCHANGE_REGION,
    ...(env('AWS_ACCESS_KEY_ID') && env('AWS_SECRET_ACCESS_KEY')
      ? {
        credentials: {
          accessKeyId: env('AWS_ACCESS_KEY_ID') as string,
          secretAccessKey: env('AWS_SECRET_ACCESS_KEY') as string,
        },
      }
      : {}),
  });
  return {
    label: `s3://${EXCHANGE_BUCKET}/${EXCHANGE_PREFIX} (${EXCHANGE_REGION})`,
    list: async () => {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const out = await client.send(new ListObjectsV2Command({
          Bucket: EXCHANGE_BUCKET, Prefix: EXCHANGE_PREFIX, ContinuationToken: token, MaxKeys: 1000,
        }));
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    put: async (key, contentType, body) => {
      // `key` は `genoplan/...` 始まりなので、そのままバケット直下のフォルダになる。
      const sha256 = sha256Hex(body);
      await client.send(new PutObjectCommand({
        Bucket: EXCHANGE_BUCKET, Key: key, Body: body, ContentType: contentType,
        Metadata: { sha256 },
      }));
      return { storageUrl: `s3://${EXCHANGE_BUCKET}/${key}`, sha256, sizeBytes: body.byteLength };
    },
  };
}

async function run(request: Request, url: URL): Promise<Response> {
  const isDry = url.searchParams.get('dry') === '1';
  // 保存先。既定は原本ストレージ。`exchange` は発注者指示のテスト保存先 (捨てられる)。
  const dest: Dest = url.searchParams.get('dest') === 'exchange' ? 'exchange' : 'originals';
  if (!authorized(request, url, isDry, dest)) return json({ ok: false, error: 'unauthorized' }, 401);
  const store = dest === 'exchange' ? exchangeStore() : originalsStore();
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
    const savedKeys = await store.list();
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
      dest,
      storage_backend: dest === 'exchange' ? 's3' : (isOriginalsS3Configured() ? 's3' : 'supabase'),
      storage_target: store.label,
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
    //
    // **保存できた件数**で `max` を数える (試行回数ではない)。
    // 生成中 (6020) の行は保存されないので、試行回数で数えると
    // 次の呼び出しでも同じ行が先頭に来て**永遠に足踏みする** (pending は発行日の昇順)。
    // 保存に至らなかったものは飛ばして次の行へ進む — `getPdfUrl` は速いので安い。
    const outcomes: Outcome[] = [];
    let savedCount = 0;
    for (const kit of pending) {
      if (savedCount >= max) break;
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
        const saved = await store.put(originalKey(kit), 'application/pdf', body);
        // 割り当て用の材料を横に置く (**氏名・電話は入れない**)。
        await store.put(
          originalKey(kit).replace(/\.pdf$/, '.json'),
          'application/json; charset=utf-8',
          new TextEncoder().encode(JSON.stringify({
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
        );
        savedCount += 1;
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
      remaining_after: Math.max(summary.pending - savedCount, 0),
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
