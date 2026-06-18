/**
 * 最小構成の S3 アップロードユーティリティ (サーバ専用)。
 *
 * AI スキャン読込結果を Elith 連携用バケットへ書き出すために使う。
 * 接続情報はすべて環境変数 (サーバ専用)。未設定なら isS3Configured()=false を返し、
 * 呼び出し側でドライラン (プレビュー返却) にフォールバックできる。
 *
 * 必須 env:
 *   AWS_S3_BUCKET           書き出し先バケット名
 *   AWS_REGION              リージョン (例 ap-northeast-1)
 * 任意 env:
 *   AWS_S3_PREFIX           バケット内共通プレフィックス (例 scan-accuracy-test/)
 *   AWS_ACCESS_KEY_ID /
 *   AWS_SECRET_ACCESS_KEY   明示キー (未指定なら SDK 既定のクレデンシャルチェーン)
 *   AWS_S3_ENDPOINT         S3 互換エンドポイント (MinIO 等。任意)
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ScanExportFile } from './scan-export';

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

function env(name: string): string | undefined {
  // Astro (Vite) は import.meta.env、Node 実行時は process.env を見る
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (fromMeta != null && fromMeta !== '') return fromMeta;
  const fromProc = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProc != null && fromProc !== '' ? fromProc : undefined;
}

export function getS3Config(): S3Config | null {
  const bucket = env('AWS_S3_BUCKET');
  const region = env('AWS_REGION');
  if (!bucket || !region) return null;
  return {
    bucket,
    region,
    prefix: env('AWS_S3_PREFIX') ?? '',
    endpoint: env('AWS_S3_ENDPOINT'),
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
  };
}

export function isS3Configured(): boolean {
  return getS3Config() !== null;
}

export interface UploadedObject {
  key: string;
  bytes: number;
  /** s3://bucket/key */
  uri: string;
}

/** ファイル群をバケットへ PUT する。成功した key のリストを返す。 */
export async function putScanFiles(files: ScanExportFile[]): Promise<UploadedObject[]> {
  const cfg = getS3Config();
  if (!cfg) throw new Error('S3 is not configured (AWS_S3_BUCKET / AWS_REGION required)');

  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
  });

  const uploaded: UploadedObject[] = [];
  for (const f of files) {
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: f.key,
        Body: f.body,
        ContentType: f.contentType,
      }),
    );
    uploaded.push({ key: f.key, bytes: f.bytes, uri: `s3://${cfg.bucket}/${f.key}` });
  }
  return uploaded;
}
