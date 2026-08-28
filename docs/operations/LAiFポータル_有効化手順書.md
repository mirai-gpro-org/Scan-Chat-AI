# LAiF ポータル（上り PDF 受領）有効化 手順書

| | |
|---|---|
| 目的 | 検査会社（LAiF / プリベント）が結果 PDF をポータルから提出できる状態にする |
| 正本 | `docs/lab/laif_s3_secure_handoff_spec.md` §4 / §4.0 / §7 |
| 実装 | `src/lib/laif-portal.ts`（Presigned PUT）／ API `src/pages/api/partner/laif-upload.ts`／中継 wellfort-site `src/pages/api/partner/upload.ts`／画面 `partner-portal-preview.astro` |
| バケット | **`wellfort-partner-exchange`**（`ap-northeast-1`・作成済 2026-08-27） |
| 前提 | コードは両リポジトリともデプロイ済み。**あとは設定だけ**（2026-08-27 実測） |

> **リージョンは `ap-northeast-1` 固定。** `getPortalS3Config()` は `getS3Config()` の
> `bucket` だけを差し替える実装で、`region` は全バケット共通の `AWS_REGION` を使う
> （`src/lib/laif-portal.ts:53-61` / `src/lib/s3.ts:63-72`）。`LAIF_S3_REGION` は**存在しない**。
> 別リージョンに置くとリージョン不一致で PUT が `PermanentRedirect` / `SignatureDoesNotMatch` になる。

---

## STEP 0. 先に admin キーを入れる（他より先）

**これを飛ばすと、この後の作業中ずっと admin API が無認可のまま**になる。
現状 `ADMIN_API_KEY` が未設定で、`GET /api/admin/config` が認証ヘッダ無しで 200 を返す
（実測 2026-08-27。詳細＝`laif_s3_secure_handoff_spec §4.0.1`）。

| Vercel プロジェクト | 変数 | 値 |
|---|---|---|
| Scan-Chat-AI | `ADMIN_API_KEY` | 新規生成した十分に長いランダム値 |
| wellfort-site | `SCAN_CHAT_AI_API_KEY` | **上と全く同じ値** |

**両方セットで入れ、両方を再デプロイする。**片方だけだと Elith admin バッチが 401 で止まる
（wellfort-site はキーがある時だけ Bearer を送る実装＝`elith-verify.ts:66` ほか）。

キー生成の例（ローカルで実行し、値は法人パスワードマネージャへ）:

```bash
openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48
```

---

## STEP 1. パブリックアクセスを全ブロック（作成時に外していた場合のみ）

```bash
aws s3api put-public-access-block \
  --bucket wellfort-partner-exchange \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

配布は Presigned URL のみで行うため、バケットを公開する必要は一切ない。

## STEP 2. CORS を設定（**必須**・これが無いとブラウザの PUT が落ちる）

本方式はブラウザが S3 へ直接 PUT する（`partner-portal-preview.astro:266`）。
`https://www.wellfort.co.jp` → `https://wellfort-partner-exchange.s3.ap-northeast-1.amazonaws.com`
のクロスオリジンになるため、バケット側の CORS が要る。**API が正常でもここが無いと失敗する。**

`cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://www.wellfort.co.jp", "https://wellfort.co.jp"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

```bash
aws s3api put-bucket-cors --bucket wellfort-partner-exchange --cors-configuration file://cors.json
aws s3api get-bucket-cors --bucket wellfort-partner-exchange     # 確認
```

- `AllowedHeaders` に **`content-type` を必ず含める**。署名対象に入れているため
  （`laif-portal.ts` の `signableHeaders: new Set(['content-type'])`）。
- **`AllowedOrigins` に `*` を使わない。** 誰でも書ける口になる。
- 将来 `app.wellfort.co.jp` へ移す際はオリジンを追加すること。

## STEP 3. IAM を新バケットへ広げる

Vercel の `AWS_ACCESS_KEY_ID` の権限が既存バケットに絞られていると `AccessDenied` になる。
**Presigned URL は Wellfort の資格情報で署名する**ので、LAiF 側ではなく**こちらの IAM** に権限が要る。

| 権限 | 使う場所 |
|---|---|
| `s3:PutObject` | Presigned PUT（LAiF が `quarantine/` に置く）／将来の `to-laif/` 書き出し |
| `s3:GetObject` | Presigned GET（admin が取り込む・`createDownloadUrl`） |
| `s3:ListBucket` | 提出状況の一覧（`listUploads`） |

既存ポリシーへ以下の 2 ステートメントを追加（`ListBucket` は**バケット ARN**、
オブジェクト操作は **`/*` 付き ARN** — ここを間違えると List だけ通らない等になる）:

```json
[
  {
    "Sid": "PartnerExchangeObjects",
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject"],
    "Resource": "arn:aws:s3:::wellfort-partner-exchange/*"
  },
  {
    "Sid": "PartnerExchangeList",
    "Effect": "Allow",
    "Action": ["s3:ListBucket"],
    "Resource": "arn:aws:s3:::wellfort-partner-exchange"
  }
]
```

`s3:DeleteObject` は入れない（保持はライフサイクルで行う。削除権限を配らない）。

## STEP 4.（任意）バージョニングとライフサイクル

仕様 §7 の保持方針。急ぐなら後回しでよいが、`quarantine/` に PDF が溜まり続けるので早めに。

```bash
aws s3api put-bucket-versioning --bucket wellfort-partner-exchange \
  --versioning-configuration Status=Enabled
```

`lifecycle.json`（§7: `to-laif/`≈14日 / `quarantine/` 短期 / `processed/` 90日 /
非現行バージョン 7日 / 未完了マルチパート 1日）:

```json
{
  "Rules": [
    { "ID": "quarantine-short", "Status": "Enabled",
      "Filter": { "Prefix": "quarantine/" }, "Expiration": { "Days": 30 } },
    { "ID": "to-laif-14d", "Status": "Enabled",
      "Filter": { "Prefix": "to-laif/" }, "Expiration": { "Days": 14 } },
    { "ID": "processed-90d", "Status": "Enabled",
      "Filter": { "Prefix": "processed/" }, "Expiration": { "Days": 90 } },
    { "ID": "noncurrent-7d", "Status": "Enabled", "Filter": { "Prefix": "" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 } },
    { "ID": "abort-mpu-1d", "Status": "Enabled", "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket wellfort-partner-exchange --lifecycle-configuration file://lifecycle.json
```

> **`quarantine/` 30日 は暫定値。** §7 は「短期」としか定めていない。検疫（§6 GuardDuty）と
> 取り込みが自動化されるまでは、取りこぼしを避けるため長めにしてある。自動化後に詰める。

## STEP 5. Vercel env（Scan-Chat-AI）

```
LAIF_PORTAL_UPLOAD = on
LAIF_S3_BUCKET     = wellfort-partner-exchange
```

`LAIF_S3_QUARANTINE_PREFIX` は既定 `quarantine/` のままでよい。
`AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` は既存を共用する。

**設定後に再デプロイする**（env は再デプロイしないと反映されない）。

## STEP 6. 疎通確認

1. `https://wellfort.co.jp/partner-portal-preview` →「結果PDFを提出」
2. 適当な PDF を投入し、**「受付完了 ✔」**になること
3. 着弾確認:

```bash
aws s3 ls s3://wellfort-partner-exchange/quarantine/laif/ --recursive
# quarantine/laif/2026/08/27/{uuid}.pdf が 1 件
aws s3api head-object --bucket wellfort-partner-exchange \
  --key quarantine/laif/2026/08/27/{uuid}.pdf
# Metadata に partner / filename / filename-b64 / received-at が入っていること
```

**失敗したときの切り分け:**

| 症状 | 原因 |
|---|---|
| 画面に `503 portal_upload_disabled` | STEP 5 の `LAIF_PORTAL_UPLOAD` 未設定／未再デプロイ |
| 画面に `500 server_misconfig` | wellfort-site の `SCAN_CHAT_AI_API_KEY` 未設定（STEP 0） |
| 画面に `401 unauthorized` | STEP 0 の 2 つの値が食い違っている |
| ブラウザ Console に CORS エラー（API は 200） | **STEP 2 の CORS 未設定** |
| PUT が 403 | STEP 3 の IAM 不足 |
| PUT が `PermanentRedirect` / `SignatureDoesNotMatch` | バケットのリージョンが `AWS_REGION` と不一致 |

---

## この時点でもまだ未実装のもの（LAiF へ本番公開する前に必要）

`laif_s3_secure_handoff_spec` の以下は**未実装**。有効化＝ポータルが**誰でも書ける口**になる。

- **§3 認証（Supabase Auth + Passkey）** — 現状 URL を知っていれば誰でも提出できる
- **§6 検疫（GuardDuty Malware Protection）** — `quarantine/` → `trusted/` の昇格が手動
- **§8 EventBridge 連携** — 着弾しても自動で取り込まれない（admin から手動で回す）

したがって当面は **LAiF に URL を伝えている相手限定の暫定運用**とし、
§3 を実装するまで一般公開しない。急ぎでなければ IP 制限（§0.1）を先に入れる選択肢もある。
