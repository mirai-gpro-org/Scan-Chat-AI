/**
 * ops: Genoplan (ジェノプラン) biz ポータルの**読み取り専用**サーバ側プローブ。
 *
 * 目的 = `docs/lab/lab_data_reception_overview.md §4.4` の「次の 1 手」を 1 回で潰す。
 *   ① login.php が通るか / `multi` と `accounts[]` の実際の形 (§4.2(b))
 *   ② 一覧エンドポイントがどれか・何を返すか (group_type で 3 分岐する)
 *   ③ PDF の署名付き URL が返るか・実体が PDF か
 *
 * **血液 (デメカル) と違い専用PC が要らない**ので bat は作らない。
 * クライアント証明書が無く Cookie セッションも使わないため、ここ (Vercel) から直接叩ける。
 *
 * 設計方針 (`probe-upload.ts` / `probe-bat.ts` と同じ):
 *   ・**既定 off の fail-closed**。env `PROBE_UPLOAD_TOKEN` が設定されているときだけ動く。
 *     env を消せば血液のプローブ口と同時に閉じる = 後始末が 1 手で済む。
 *   ・認可はそのトークン自身 (`?k=`)。**`ADMIN_API_KEY` は使わない**。
 *   ・**読み取りしかしない。** 叩くのは login / 一覧 / PDF URL 取得の 3 種だけで、
 *     kitAdd・userAdd・passwordFind・sendAuthNumber 等の**状態を変える口は呼ばない**。
 *
 * 【PII (最重要)】Genoplan の一覧は **`signer_name` (氏名) と `signer_mobile` (電話)** を返す。
 * CLAUDE.md の PII 分離 (氏名・電話を診断系/外部へ載せない) に直接かかるので、
 * **本プローブは値を一切出力しない** — キーの有無と「空か否か」だけを報告する (`presence()`)。
 * シリアル番号も既定でマスクする (`?full=1` で解除)。**§4.3 のとおり、シリアルを知っていれば
 * 無認証で署名付き URL が取れてしまう**ため、シリアル自体を秘密として扱う。
 */

import type { APIRoute } from 'astro';

export const prerender = false;

const API_BASE = 'https://bizapi.genoplan.com';
/** My Book PDF の署名付き URL を返す Lambda (バンドルの `RequestAPI.runMode=="product"` 側)。 */
const PDF_LAMBDA = 'https://s3r5oxqcgwmyf4inuxdao64wae0yflhw.lambda-url.ap-northeast-1.on.aws';

/** 値を出してはいけないキー (PII)。存在と空否だけを報告する。 */
const PII_KEYS = new Set([
  'signer_name', 'signer_mobile', 'doctor_name', 'mobile', 'loginid',
  'email', 'buyer_name', 'buyer_email', 'buyer_mobile', 'name', 'partner_name',
  'store_name', 'address', 'birth', 'birthday',
]);

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

/** PII キーは値でなく「在る/空」だけ返す。 */
function presence(v: unknown): string {
  if (v == null) return '<null>';
  const s = String(v).trim();
  return s === '' ? '<empty>' : `<present len=${s.length}>`;
}

/** シリアルは既定でマスク (先頭4 + 末尾2)。§4.3 の無認証 Lambda があるため秘密として扱う。 */
function maskSn(sn: unknown, full: boolean): string {
  const s = String(sn ?? '');
  if (full || s.length <= 6) return s;
  return `${s.slice(0, 4)}…${s.slice(-2)}`;
}

/** 1 行を PII 抜きに要約する。**値をそのまま出すのは PII 以外のキーだけ**。 */
function safeRow(row: Record<string, unknown>, full: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (PII_KEYS.has(k)) { out[k] = presence(v); continue; }
    if (k === 'serialnumber' || k === 'sn') { out[k] = maskSn(v, full); continue; }
    if (v && typeof v === 'object') { out[k] = `<${Array.isArray(v) ? 'array' : 'object'}>`; continue; }
    const s = String(v ?? '');
    out[k] = s.length > 60 ? `${s.slice(0, 60)}…` : v;
  }
  return out;
}

/**
 * biz API は **form-urlencoded の POST**。axios ラッパ
 * `Mt = (url, body) => xt.post(url, URLSearchParams(body))` と同じ形にする。
 * 配列は `key[]` で並べる (バンドルの `It()` と同じ)。
 */
async function apiPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) { for (const x of v) form.append(`${k}[]`, String(x)); continue; }
    if (v == null) continue;
    form.append(k, String(v));
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: form.toString(),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _http: res.status, _nonJson: text.slice(0, 300) }; }
}

type Step = { step: string; ok: boolean; note?: string; detail?: unknown };

export const GET: APIRoute = async ({ url }) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) return json({ ok: false, error: 'disabled', detail: 'PROBE_UPLOAD_TOKEN 未設定 (既定 off)' }, 503);
  if ((url.searchParams.get('k') ?? '').trim() !== expected) return json({ ok: false, error: 'unauthorized' }, 401);

  const loginid = env('GENOPLAN_LOGIN_ID');
  const password = env('GENOPLAN_PASSWORD');
  if (!loginid || !password) {
    return json({
      ok: false, error: 'missing_credentials',
      detail: 'Vercel env の GENOPLAN_LOGIN_ID / GENOPLAN_PASSWORD が未設定',
      seen: { GENOPLAN_LOGIN_ID: !!loginid, GENOPLAN_PASSWORD: !!password },
    }, 400);
  }

  const full = url.searchParams.get('full') === '1';
  const lang = (url.searchParams.get('lang') ?? 'ja').trim();
  /** 何行まで一覧を引くか。既定 20 (60s 関数タイムアウトに余裕を持たせる)。 */
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 200);
  /** `accounts[]` が複数のとき、どれを使うか (§4.2(b))。 */
  const accountIdx = Math.max(Number(url.searchParams.get('account') ?? 0) || 0, 0);

  const steps: Step[] = [];
  const t0 = Date.now();

  // ── ① ログイン ──────────────────────────────────────────
  let accesskey = '';
  let account: Record<string, unknown> | null = null;
  try {
    const r = await apiPost('/api/biz/login.php', { lang, loginid, password }) as
      { success?: boolean; code?: string; message?: string; data?: Record<string, unknown> };
    const data = r?.data ?? {};
    const accounts = Array.isArray(data.accounts) ? data.accounts as Record<string, unknown>[] : [];
    steps.push({
      step: '1-login',
      ok: r?.success === true,
      note: r?.success === true ? undefined : `code=${r?.code} message=${r?.message}`,
      detail: {
        // accesskey は**値を出さない** (これ 1 つで全 API が叩けるため)。
        accesskey: presence(data.accesskey),
        multi: data.multi,
        accounts_count: accounts.length,
        // どの権限で何が見えるかの判定材料。氏名系は presence() で潰れる。
        accounts: accounts.map((a) => safeRow(a, full)),
      },
    });
    if (r?.success !== true) return json({ ok: false, elapsed_ms: Date.now() - t0, steps });
    accesskey = String(data.accesskey ?? '');
    account = accounts[accountIdx] ?? accounts[0] ?? null;
    if (!account) return json({ ok: false, elapsed_ms: Date.now() - t0, steps, error: 'no_accounts' });
  } catch (e) {
    steps.push({ step: '1-login', ok: false, note: String(e) });
    return json({ ok: false, elapsed_ms: Date.now() - t0, steps });
  }

  const partnerSeq = String(account.partner_seq ?? '');

  // ── ② 一覧 ────────────────────────────────────────────
  //
  // UI は **group_type で 3 分岐**する (バンドルの `viewListWithOptions`):
  //   master  (group_type=='A')                        → bizMasterUsers.php (mode=kitStatus)
  //   manager (group_type=='M' && auth_sales_kits=='Y') → kitStatusAdmin.php
  //   seller  (それ以外)                                 → kitStatusSeller.php
  // ここでも同じ分岐にする (勝手に別の口を叩かない)。
  const groupType = String(account.group_type ?? '');
  const accountType =
    groupType === 'A' ? 'master'
      : (groupType === 'M' && String(account.auth_sales_kits ?? '') === 'Y') ? 'manager'
        : 'seller';
  const listPath =
    accountType === 'master' ? '/api/biz/bizMasterUsers.php'
      : accountType === 'manager' ? '/api/biz/kitStatusAdmin.php'
        : '/api/biz/kitStatusSeller.php';

  let rows: Record<string, unknown>[] = [];
  try {
    const body: Record<string, unknown> = {
      accesskey, partner_seq: partnerSeq, lang, page: 1, limit,
      // UI の既定と同じ「絞り込みなし」。日付を空にすると全期間。
      kit_status: '', keyword: '', keyword_type: '', finaldate_start: '', finaldate_end: '',
    };
    if (accountType === 'master') body.mode = 'kitStatus';
    const r = await apiPost(listPath, body) as
      { success?: boolean; code?: string; message?: string; data?: Record<string, unknown> };
    const list = Array.isArray(r?.data?.list) ? r.data!.list as Record<string, unknown>[] : [];
    rows = list;
    steps.push({
      step: '2-list',
      ok: r?.success === true,
      note: `accountType=${accountType} endpoint=${listPath}` + (r?.success === true ? '' : ` code=${r?.code} message=${r?.message}`),
      detail: {
        total: r?.data?.total ?? r?.data?.cnt ?? null,
        returned: list.length,
        // 「どんなキーが返るか」が実装設計の要。1 行目のキー一覧を出す。
        keys: list[0] ? Object.keys(list[0]) : [],
        // PII キーが実在するかを名指しで確認 (§4.2(c) の設計判断のため)。
        pii_keys_present: list[0] ? Object.keys(list[0]).filter((k) => PII_KEYS.has(k)) : [],
        rows: list.slice(0, 5).map((x) => safeRow(x, full)),
      },
    });
  } catch (e) {
    steps.push({ step: '2-list', ok: false, note: String(e) });
  }

  // ── ③ PDF ────────────────────────────────────────────
  //
  // **発行済みの 1 件だけ**で確かめる (他人のデータに余計に触らない)。
  // 判定は「署名付き URL が返るか」と「実体が PDF か」の 2 点だけで、
  // **本文は保存も出力もしない** (先頭 1KB を読んで `%PDF-` を見るだけ)。
  const published = rows.find((r) => String(r.publish_origin ?? '').trim() !== ''
    && String(r.serviceExpireYN ?? '') !== 'Y');
  if (!published) {
    steps.push({ step: '3-pdf', ok: false, note: '発行済みの行が一覧に無いため未検証 (捏造しない)' });
  } else {
    const sn = String(published.serialnumber ?? '');
    try {
      const pdfSeq = String(published.pdf_seq ?? '').trim();
      const u = `${PDF_LAMBDA}/gpj/${encodeURIComponent(lang)}/${encodeURIComponent(sn)}`
        + (pdfSeq ? `?custom-seq=${encodeURIComponent(pdfSeq)}` : '');
      const res = await fetch(u);
      const body = await res.json().catch(() => null) as { pdfUrl?: string; code?: number; message?: string } | null;
      const pdfUrl = body?.pdfUrl ?? '';
      steps.push({
        step: '3a-pdf-url',
        ok: !!pdfUrl,
        note: pdfUrl ? undefined : `code=${body?.code} message=${body?.message} (6020=生成中)`,
        detail: {
          target_sn: maskSn(sn, full),
          used_custom_seq: pdfSeq || null,
          http: res.status,
          // URL の**中身は出さない** (署名付き=1時間有効な実物なので)。形だけ報告する。
          pdf_url_host: pdfUrl ? new URL(pdfUrl).host : null,
          pdf_url_expires: pdfUrl ? new URL(pdfUrl).searchParams.get('X-Amz-Expires') : null,
        },
      });

      if (pdfUrl) {
        const head = await fetch(pdfUrl, { headers: { range: 'bytes=0-1023' } });
        const buf = new Uint8Array(await head.arrayBuffer());
        const magic = new TextDecoder().decode(buf.slice(0, 5));
        steps.push({
          step: '3b-pdf-body',
          ok: magic === '%PDF-',
          detail: {
            http: head.status,
            content_type: head.headers.get('content-type'),
            content_range: head.headers.get('content-range'),
            magic,
          },
        });
      }
    } catch (e) {
      steps.push({ step: '3-pdf', ok: false, note: String(e) });
    }
  }

  return json({
    ok: steps.every((s) => s.ok),
    elapsed_ms: Date.now() - t0,
    note: '読み取り専用。状態を変える API は呼んでいない。PII (氏名・電話) は値を出力していない。',
    steps,
  });
};
