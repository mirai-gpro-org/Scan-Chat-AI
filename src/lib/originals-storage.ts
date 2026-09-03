/**
 * 検査結果 原本ファイルの保存・取得 (STEP 5 / 案C′)。
 *
 * 【方針 (発注者承認 2026-08-20)】
 *   DB とホット層は Supabase (US Central) に据え置き、**原本だけを
 *   S3 ap-northeast-1 に置く**。署名 URL でブラウザとストレージが直結するため、
 *   Vercel (iad1) のリージョンは配信経路に入らない = アプリのレイテンシは悪化しない。
 *   10 年保管・削除不可 (test_data_storage_and_db_design.md §6.1) は
 *   S3 の Versioning + Object Lock で技術的に担保する (バケット側の設定。§運用手順書)。
 *
 * 【段階移行】S3 が未設定のあいだは Supabase Storage にフォールバックする。
 *   読み出しは storage_url の形 (s3://... かどうか) で自動的に振り分けるので、
 *   バケット作成前後で既存データが読めなくなることはない。
 *
 * 必要な env (すべてサーバ専用):
 *   AWS_REGION                  … S3 を使う際のリージョン (例 ap-northeast-1)
 *   AWS_S3_ORIGINALS_BUCKET     … 原本用バケット (例 wellfort-diagnosis)
 *                                 ※ Elith 連携用の AWS_S3_BUCKET とは別に持つ
 *   AWS_S3_ORIGINALS_PREFIX     … 任意。既定 'raw/'
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY … 任意 (未指定なら既定のチェーン)
 */

import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getServerSupabase } from './supabase';

/** Supabase Storage 側のバケット名 (S3 移行前からの保存先)。 */
const SUPABASE_BUCKET = 'lab-results';
const DEFAULT_PREFIX = 'raw/';

function env(name: string): string | undefined {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (fromMeta != null && fromMeta !== '') return fromMeta;
  const fromProc = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProc != null && fromProc !== '' ? fromProc : undefined;
}

export interface OriginalsS3Config {
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
}

/**
 * 原本用 S3 の設定。**専用バケットの env が無ければ null** を返し、
 * 呼び出し側は Supabase Storage へフォールバックする。
 * Elith 連携用の AWS_S3_BUCKET を誤って使わないよう、既定値は設けない。
 */
export function getOriginalsS3Config(): OriginalsS3Config | null {
  const region = env('AWS_REGION');
  const bucket = env('AWS_S3_ORIGINALS_BUCKET');
  if (!region || !bucket) return null;
  return {
    bucket,
    region,
    prefix: env('AWS_S3_ORIGINALS_PREFIX') ?? DEFAULT_PREFIX,
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    endpoint: env('AWS_S3_ENDPOINT'),
  };
}

export function isOriginalsS3Configured(): boolean {
  return getOriginalsS3Config() !== null;
}

function client(cfg: OriginalsS3Config): S3Client {
  return new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
  });
}

export interface PutOriginalInput {
  /** バケット/プレフィックス配下の相対キー (例 lab_results/rieger/2026/08/xxx.pdf)。 */
  key: string;
  contentType: string;
  body: Uint8Array;
}

export interface PutOriginalResult {
  /** test_artifact_files.storage_url に入れる値。s3://bucket/key または Supabase 内パス。 */
  storageUrl: string;
  /** 改竄検知用 (§6.1)。従来は空文字のまま保存されていた。 */
  sha256: string;
  sizeBytes: number;
  backend: 's3' | 'supabase';
}

/** SHA-256 を 16 進で返す。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 原本を保存する。S3 が設定されていれば S3、無ければ Supabase Storage。 */
export async function putOriginal(input: PutOriginalInput): Promise<PutOriginalResult> {
  const sha256 = sha256Hex(input.body);
  const sizeBytes = input.body.byteLength;

  const cfg = getOriginalsS3Config();
  if (cfg) {
    const key = `${cfg.prefix}${input.key}`.replace(/\/{2,}/g, '/');
    await client(cfg).send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        // 内容ハッシュをオブジェクトにも残す (取り出し時の突合用)。
        Metadata: { sha256 },
      }),
    );
    return { storageUrl: `s3://${cfg.bucket}/${key}`, sha256, sizeBytes, backend: 's3' };
  }

  const sb = getServerSupabase();
  if (!sb) throw new Error('原本の保存先が未設定です (S3 も Supabase も使えません)');
  const { error } = await sb.storage
    .from(SUPABASE_BUCKET)
    .upload(input.key, input.body, { contentType: input.contentType, upsert: false });
  if (error) throw new Error(error.message);
  return { storageUrl: input.key, sha256, sizeBytes, backend: 'supabase' };
}

/**
 * 保存済みの相対キーを列挙する (`putOriginal` の `key` と同じ体系で返す)。
 *
 * 【なぜ要るか】「もう取ったか」を**保存先そのものに聞く**ため。
 * 別に取得済みテーブルを作ると、保存に成功したのに台帳の更新に失敗した回で
 * **同じものを何度も取りに行く／逆に取り漏らす**。デメカルの `last_to` が
 * 「取り込み成功時だけ前進」で取り漏れゼロを担保しているのと同じ考え方で、
 * **実体が在ることだけを「取得済み」の根拠にする**。
 *
 * S3 / Supabase Storage のどちらでも動く。返すのは**プレフィックスを除いた相対キー**。
 */
export async function listOriginalKeys(relPrefix: string): Promise<string[]> {
  const cfg = getOriginalsS3Config();
  if (cfg) {
    const full = `${cfg.prefix}${relPrefix}`.replace(/\/{2,}/g, '/');
    const c = client(cfg);
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await c.send(new ListObjectsV2Command({
        Bucket: cfg.bucket, Prefix: full, ContinuationToken: token, MaxKeys: 1000,
      }));
      for (const o of out.Contents ?? []) {
        if (!o.Key) continue;
        keys.push(o.Key.startsWith(cfg.prefix) ? o.Key.slice(cfg.prefix.length) : o.Key);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  const sb = getServerSupabase();
  if (!sb) throw new Error('原本の保存先が未設定です (S3 も Supabase も使えません)');
  // Supabase Storage の list は「1 階層ずつ」なので、フォルダ指定で引く。
  const dir = relPrefix.replace(/\/*$/, '');
  const { data, error } = await sb.storage.from(SUPABASE_BUCKET).list(dir, { limit: 1000 });
  if (error) throw new Error(error.message);
  return (data ?? []).filter((f) => f.name).map((f) => `${dir}/${f.name}`);
}

/** storage_url を s3://bucket/key として解釈する。S3 でなければ null。 */
function parseS3Uri(storageUrl: string): { bucket: string; key: string } | null {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(storageUrl);
  return m ? { bucket: m[1], key: m[2] } : null;
}

/**
 * 原本の署名 URL を発行する。有効期限は短く保つ (既定 5 分)。
 * S3 / Supabase のどちらに保存されていても storage_url の形で振り分ける。
 */
export async function getOriginalSignedUrl(
  storageUrl: string,
  expiresInSec = 300,
): Promise<string | null> {
  try {
    // 先頭 "/" は public 配下の静的ファイル (サンプル表示用)。署名は不要でそのまま返す。
    if (storageUrl.startsWith('/')) return storageUrl;

    const s3 = parseS3Uri(storageUrl);
    if (s3) {
      const cfg = getOriginalsS3Config();
      if (!cfg) return null;
      return await getSignedUrl(
        client(cfg),
        new GetObjectCommand({ Bucket: s3.bucket, Key: s3.key }),
        { expiresIn: expiresInSec },
      );
    }
    const sb = getServerSupabase();
    if (!sb) return null;
    const { data, error } = await sb.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrl(storageUrl, expiresInSec);
    if (error || !data) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}
