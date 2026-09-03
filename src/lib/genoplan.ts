/**
 * Genoplan (ジェノプラン) biz ポータルの読み取りクライアント。
 *
 * 正本 = `docs/lab/lab_data_reception_overview.md §4`。
 * 画面は Vue SPA だが**背後は素の PHP REST API** なので、
 * **クライアント証明書も Cookie セッションも要らず Vercel から直接叩ける**
 * (血液=デメカルのような専用PC は不要)。
 *
 * 【読み取りしかしない】login / 一覧 / PDF URL 取得 / PDF 取得 の 4 つだけ。
 * `kitAdd` `userAdd` `passwordFind` `sendAuthNumber` 等**状態を変える口は呼ばない**。
 *
 * 【PII (最重要)】一覧は `signer_name`(氏名) / `doctor_name` を、
 * `getKitInfoList` はさらに `signer_mobile`(電話) を返す。
 * **本モジュールは型として持たない。** `GenoplanKit` に入れるのは
 * 認証キー・ボックスナンバー・状態・日付だけ (CLAUDE.md の PII 分離)。
 */

const API_BASE = 'https://bizapi.genoplan.com';
/** My Book PDF の署名付き URL を返す Lambda (バンドルの `RequestAPI.runMode=="product"` 側)。 */
const PDF_LAMBDA = 'https://s3r5oxqcgwmyf4inuxdao64wae0yflhw.lambda-url.ap-northeast-1.on.aws';

/** 「レポート発行完了」。この状態のものだけ PDF が出る (実測 2026-09-01: 255 件中 72 件)。 */
export const STATUS_PUBLISHED = '600';

/** PDF 生成中を表す Lambda の応答コード。**失敗ではない**ので次回に回す。 */
export const CODE_GENERATING = 6020;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

export function isGenoplanConfigured(): boolean {
  return !!env('GENOPLAN_LOGIN_ID') && !!env('GENOPLAN_PASSWORD');
}

/**
 * biz API は **form-urlencoded の POST**
 * (バンドルの `Mt = (url, body) => axios.post(url, URLSearchParams(body))` と同じ)。
 * 配列は `key[]` で並べる。
 */
async function apiPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    if (Array.isArray(v)) { for (const x of v) form.append(`${k}[]`, String(x)); continue; }
    form.append(k, String(v));
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: form.toString(),
  });
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch {
    throw new Error(`Genoplan ${path} が JSON を返しませんでした (HTTP ${res.status})`);
  }
}

export interface GenoplanSession {
  accesskey: string;
  partnerSeq: string;
  /** UI の区分 (master/manager/seller)。一覧の口がこれで変わる。 */
  accountType: 'master' | 'manager' | 'seller';
  /** PDF ダウンロード権限。無ければ取得しても意味が無いので呼び出し側で弾く。 */
  canDownloadPdf: boolean;
}

/**
 * ログイン。**MFA も CAPTCHA も CSRF トークンも無い** (実測 2026-09-01)。
 * `accesskey` は**ログに出さないこと** — これ 1 つで全 API が叩ける。
 */
export async function login(): Promise<GenoplanSession> {
  const loginid = env('GENOPLAN_LOGIN_ID');
  const password = env('GENOPLAN_PASSWORD');
  if (!loginid || !password) throw new Error('GENOPLAN_LOGIN_ID / GENOPLAN_PASSWORD が未設定です');

  const r = await apiPost<{ success?: boolean; code?: string; message?: string; data?: Record<string, unknown> }>(
    '/api/biz/login.php', { lang: 'ja', loginid, password },
  );
  if (r?.success !== true) throw new Error(`Genoplan ログイン失敗 (code=${r?.code} message=${r?.message})`);

  const data = r.data ?? {};
  const accounts = Array.isArray(data.accounts) ? data.accounts as Record<string, unknown>[] : [];
  // 実測では `multi="N"` / accounts 1 件。複数になったら先頭を使わずに落とす
  // (どれを使うべきかを勝手に決めない = 捏造しない)。
  if (accounts.length !== 1) {
    throw new Error(`Genoplan の accounts が ${accounts.length} 件です (実測は 1 件。選択規則が未定なので中断)`);
  }
  const a = accounts[0];
  const groupType = String(a.group_type ?? '');
  const accountType: GenoplanSession['accountType'] =
    groupType === 'A' ? 'master'
      : (groupType === 'M' && String(a.auth_sales_kits ?? '') === 'Y') ? 'manager'
        : 'seller';

  return {
    accesskey: String(data.accesskey ?? ''),
    partnerSeq: String(a.partner_seq ?? ''),
    accountType,
    canDownloadPdf: String(a.auth_pdf_down ?? '') === 'Y',
  };
}

/** 一覧 1 行。**PII は入れない** (氏名・電話は受け取った時点で捨てる)。 */
export interface GenoplanKit {
  /** 認証キー。仕様の `external_test_id` に当たる (`lab_integration_workflow §2 Workflow 2`)。 */
  serialNumber: string;
  /** ボックスナンバー = キットの箱に印字された番号。仕様の `external_barcode` に当たる。 */
  boxNumber: string;
  statusCode: string;
  /** 発行日。二重照合の「検査日」に当たる。 */
  publishedOn: string;
  reportSeq: string;
  /** カスタム PDF の連番。実測では全件空 = カスタム版は未使用。 */
  pdfSeq: string;
  serviceExpired: boolean;
}

/** UI と同じ 3 分岐 (バンドルの `viewListWithOptions`)。勝手に別の口を叩かない。 */
function listPath(accountType: GenoplanSession['accountType']): string {
  return accountType === 'master' ? '/api/biz/bizMasterUsers.php'
    : accountType === 'manager' ? '/api/biz/kitStatusAdmin.php'
      : '/api/biz/kitStatusSeller.php';
}

/**
 * 発行済みキットの一覧を**全ページ**引く。
 *
 * **日付では絞れない** — `finaldate_start/end` は `final_update_date` を見ていない
 * (実測: 直近 30 日で 0 件なのに `final_update_date` の最大はその窓の中)。
 * 代わりに `kit_status='600'` が効く (255 → 72)。
 * 差分は日付でなく**ボックスナンバーの差集合**で出す (発注者指示 2026-09-01)。
 */
export async function listPublishedKits(s: GenoplanSession, pageLimit = 200): Promise<GenoplanKit[]> {
  const out: GenoplanKit[] = [];
  for (let page = 1; page <= 50; page++) {
    const body: Record<string, unknown> = {
      accesskey: s.accesskey, partner_seq: s.partnerSeq, lang: 'ja',
      page, limit: pageLimit,
      kit_status: STATUS_PUBLISHED,
      keyword: '', keyword_type: '', finaldate_start: '', finaldate_end: '',
    };
    if (s.accountType === 'master') body.mode = 'kitStatus';
    const r = await apiPost<{ success?: boolean; message?: string; data?: Record<string, unknown> }>(
      listPath(s.accountType), body,
    );
    if (r?.success !== true) throw new Error(`Genoplan 一覧の取得に失敗 (${r?.message})`);
    const list = Array.isArray(r.data?.list) ? r.data!.list as Record<string, unknown>[] : [];
    for (const x of list) {
      out.push({
        serialNumber: String(x.serialnumber ?? '').trim(),
        boxNumber: String(x.extchar03 ?? '').trim(),
        statusCode: String(x.statuscode ?? '').trim(),
        publishedOn: String(x.publish_origin ?? '').trim(),
        reportSeq: String(x.report_seq ?? '').trim(),
        pdfSeq: String(x.pdf_seq ?? '').trim(),
        serviceExpired: String(x.serviceExpireYN ?? '') === 'Y',
      });
    }
    // `list_total_page` を信じて止める。無ければ「満たなかったら最終ページ」で判断する。
    const totalPage = Number(r.data?.list_total_page ?? 0);
    if (totalPage > 0 ? page >= totalPage : list.length < pageLimit) break;
  }
  return out;
}

export interface PdfUrlResult {
  /** 署名付き URL (有効 1 時間)。生成中なら null。 */
  url: string | null;
  /** Lambda の応答コード。`6020` = 生成中。 */
  code: number | null;
  message: string | null;
}

/**
 * PDF の署名付き URL を得る。
 *
 * **`getKitInfoList.php` の `pdf_url` は常に空**なので、この Lambda が唯一の経路 (実測)。
 * 生成には 30〜60 秒かかることがあり、その間は `{ code: 6020 }` が返る。
 * **これは失敗ではない** — 保存しなければ「未取得」のままなので次回の実行で拾える。
 */
export async function getPdfUrl(kit: GenoplanKit, lang = 'ja'): Promise<PdfUrlResult> {
  const u = `${PDF_LAMBDA}/gpj/${encodeURIComponent(lang)}/${encodeURIComponent(kit.serialNumber)}`
    + (kit.pdfSeq ? `?custom-seq=${encodeURIComponent(kit.pdfSeq)}` : '');
  const res = await fetch(u);
  const body = await res.json().catch(() => null) as { pdfUrl?: string; code?: number; message?: string } | null;
  return {
    url: body?.pdfUrl ?? null,
    code: typeof body?.code === 'number' ? body.code : null,
    message: typeof body?.message === 'string' ? body.message : null,
  };
}

/** 署名付き URL から PDF を取る。**中身の検査は呼び出し側**(先頭 `%PDF-`)。 */
export async function fetchPdf(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDF の取得に失敗 (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 保存キー。**ボックスナンバー始まり**にするのは、
 * 「取得済みかどうか」をボックスナンバーで判断するため (発注者指示 2026-09-01)。
 * ボックスナンバーが空の行だけ `sn-{認証キー}` にフォールバックする
 * (空を全部同じキーにすると別人の報告書が上書きされるため)。
 */
export function originalKey(kit: GenoplanKit): string {
  const box = kit.boxNumber || `sn-${kit.serialNumber}`;
  return `genoplan/${box}__${kit.serialNumber}.pdf`;
}

/** 保存キーからボックスナンバー部分を取り出す (差分判定に使う)。 */
export function boxFromKey(key: string): string | null {
  const m = /(?:^|\/)genoplan\/([^/]+?)__[^/]+\.pdf$/.exec(key);
  return m ? m[1] : null;
}
