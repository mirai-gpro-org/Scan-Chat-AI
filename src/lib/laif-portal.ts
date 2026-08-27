/**
 * Partner Portal 上り（検査会社 → Wellfort）の実転送。
 *
 * 正本: `docs/lab/laif_s3_secure_handoff_spec.md` §4「転送方式（ブラウザ⇄S3 直接・Vercel中継しない）」
 *   ・アプリがストリーム中継しない（Vercel 60s/メモリ制約で巨大PDFを引くと即死）
 *   ・上り(PDF提出) は **Presigned PUT** を発行し、ブラウザが直接 `quarantine/` へ置く
 *   ・**ファイルサイズ上限・Content-Type・キーを署名に固定**する
 *   ・presigned URL は「認証の代替」ではなく一時的な権限委譲。人間に直接配布しない
 *
 * 【この実装の範囲（2026-08-27）】
 *   実装済 = §4 の転送そのもの（着弾は必ず `quarantine/`・PDF限定・サイズ固定・5分期限）。
 *   **未実装 = §3 認証(Supabase Auth + Passkey) / §6 GuardDuty 検疫 / §8 EventBridge 連携**。
 *   したがって **認証が入るまでこの口は「誰でも書ける」**。事故を避けるため
 *   **env `LAIF_PORTAL_UPLOAD=on` のときだけ有効**にしてある（既定 off）。
 *   本番運用の前に §3 を必ず実装すること。
 *
 * env:
 *   LAIF_PORTAL_UPLOAD        'on' で上り受付を有効化（既定 off＝503 を返す）
 *   LAIF_S3_BUCKET            上り専用バケット（未設定なら AWS_S3_BUCKET へフォールバック）
 *   LAIF_S3_QUARANTINE_PREFIX 着弾プレフィックス（既定 'quarantine/'）
 */

import { PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Config, makeS3Client, type S3Config } from './s3';

/** 受け入れる MIME（結果は PDF のみ）。 */
export const ACCEPTED_CONTENT_TYPE = 'application/pdf';
/** 1 ファイルの上限。デモ画面の表示（最大20MB）と一致させる。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** presigned URL の有効期限（秒）。spec §4「有効期限5分」。 */
export const PRESIGN_EXPIRES_SEC = 300;

const DEFAULT_QUARANTINE_PREFIX = 'quarantine/';

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

/** 上り受付が有効か（既定 off）。認証未実装のため明示的に on にしたときだけ動く。 */
export function isPortalUploadEnabled(): boolean {
  return (env('LAIF_PORTAL_UPLOAD') ?? '').toLowerCase() === 'on';
}

export interface PortalS3Config extends S3Config {
  quarantinePrefix: string;
}

/** 上り用の S3 設定。バケットは LAIF 専用 env を優先。 */
export function getPortalS3Config(): PortalS3Config | null {
  const base = getS3Config();
  if (!base) return null;
  return {
    ...base,
    bucket: env('LAIF_S3_BUCKET') ?? base.bucket,
    quarantinePrefix: env('LAIF_S3_QUARANTINE_PREFIX') ?? DEFAULT_QUARANTINE_PREFIX,
  };
}

/** パートナー識別子（S3 キーの階層に使う。想定外の値は 'unknown'）。 */
const PARTNERS = new Set(['laif', 'prevent']);
export function normalizePartner(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return PARTNERS.has(s) ? s : 'unknown';
}

/**
 * 元ファイル名を S3 メタデータへ載せられる形にする。
 * S3 のユーザ定義メタデータは **ASCII しか安全に運べない**ため、非 ASCII は落として
 * 別途 `x-amz-meta-filename-b64`（UTF-8 の base64）で原名を保持する。
 */
export function sanitizeFilename(name: unknown): { ascii: string; b64: string } {
  const raw = (typeof name === 'string' ? name : '').trim().slice(0, 200) || 'result.pdf';
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(raw, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(raw)));
  return { ascii, b64 };
}

/** UUID v4（crypto.randomUUID が無い環境向けのフォールバック付き）。 */
function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export interface UploadTicket {
  url: string;
  key: string;
  bucket: string;
  expiresIn: number;
  /** ブラウザが PUT 時に必ず送るヘッダ（署名に含めたもの）。 */
  headers: Record<string, string>;
}

export interface UploadRequest {
  partner: string;
  filename: unknown;
  contentType: unknown;
  bytes: unknown;
}

export type TicketResult =
  | { ok: true; ticket: UploadTicket }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * 上り PDF 用の Presigned PUT を発行する。
 * **キー・Content-Type・Content-Length を署名に固定**するので、
 * 受け取った URL で別のキーへ書いたり、別形式・別サイズを流し込むことはできない。
 */
export async function createUploadTicket(req: UploadRequest): Promise<TicketResult> {
  if (!isPortalUploadEnabled()) {
    return {
      ok: false, status: 503, error: 'portal_upload_disabled',
      detail: '上り受付が無効です（env LAIF_PORTAL_UPLOAD=on で有効化）。',
    };
  }
  const cfg = getPortalS3Config();
  if (!cfg) {
    return { ok: false, status: 500, error: 's3_not_configured', detail: 'AWS_REGION 未設定' };
  }
  const contentType = typeof req.contentType === 'string' ? req.contentType.split(';')[0].trim() : '';
  if (contentType !== ACCEPTED_CONTENT_TYPE) {
    return {
      ok: false, status: 400, error: 'unsupported_content_type',
      detail: `PDF のみ受け付けます（受信: ${contentType || '不明'}）`,
    };
  }
  const bytes = typeof req.bytes === 'number' ? req.bytes : Number(req.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, status: 400, error: 'invalid_size', detail: 'ファイルサイズが不正です' };
  }
  if (bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false, status: 413, error: 'file_too_large',
      detail: `最大 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB です（受信: ${(bytes / 1024 / 1024).toFixed(1)}MB）`,
    };
  }

  const partner = normalizePartner(req.partner);
  const { ascii, b64 } = sanitizeFilename(req.filename);
  const now = new Date();
  const day = now.toISOString().slice(0, 10).replace(/-/g, '/');
  // 着弾は必ず quarantine/。キーは推測不能な UUID（元ファイル名はメタデータに保持）。
  const key = `${cfg.quarantinePrefix}${partner}/${day}/${uuid()}.pdf`;

  // requestChecksumCalculation='WHEN_REQUIRED':
  //   既定のままだと SDK が **署名時に空ボディの CRC32 を計算して URL に載せてしまい**
  //   (x-amz-checksum-crc32=AAAAAA==)、実ファイルを PUT した瞬間に S3 がチェックサム不一致で拒否する。
  //   presigned PUT では必ず切る。
  const client = makeS3Client(cfg, { requestChecksumCalculation: 'WHEN_REQUIRED' });
  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: ACCEPTED_CONTENT_TYPE,
    ContentLength: bytes,       // 署名に固定 → サイズ超過の差し替えを S3 が拒否する
    Metadata: { partner, filename: ascii, 'filename-b64': b64, 'received-at': now.toISOString() },
  });
  // Content-Type も署名対象に入れる（署名外だと別形式へすり替えられる）。
  const url = await getSignedUrl(client, cmd, {
    expiresIn: PRESIGN_EXPIRES_SEC,
    signableHeaders: new Set(['content-type']),
  });

  return {
    ok: true,
    ticket: {
      url, key, bucket: cfg.bucket, expiresIn: PRESIGN_EXPIRES_SEC,
      headers: { 'content-type': ACCEPTED_CONTENT_TYPE },
    },
  };
}

export interface PortalUpload {
  key: string;
  bytes: number;
  uploaded_at: string | null;
  filename: string | null;
}

/** 受領済み（quarantine/）の一覧。提出状況の表示と admin の取り込み待ち確認に使う。 */
export async function listUploads(partner: string, limit = 20): Promise<PortalUpload[]> {
  const cfg = getPortalS3Config();
  if (!cfg) return [];
  const client = makeS3Client(cfg);
  const prefix = `${cfg.quarantinePrefix}${normalizePartner(partner)}/`;
  const res = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, MaxKeys: 1000 }));
  const items = (res.Contents ?? [])
    .filter((o) => o.Key && o.Key.endsWith('.pdf'))
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
    .slice(0, limit);
  return items.map((o) => ({
    key: o.Key!,
    bytes: o.Size ?? 0,
    uploaded_at: o.LastModified ? o.LastModified.toISOString() : null,
    filename: null,
  }));
}

/** 受領済み 1 件の presigned GET（admin がスキャンへ回すために取得する）。 */
export async function createDownloadUrl(key: string): Promise<string | null> {
  const cfg = getPortalS3Config();
  if (!cfg) return null;
  if (!key.startsWith(cfg.quarantinePrefix)) return null;   // quarantine 配下だけ
  const client = makeS3Client(cfg);
  return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
    expiresIn: PRESIGN_EXPIRES_SEC,
  });
}
