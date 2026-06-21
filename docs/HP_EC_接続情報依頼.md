# 【依頼】連携に必要な接続情報の受け渡しのお願い（Web → HP/EC）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 目的: ブリッジ参照・Edge Function 連携・お知らせ pull 同期の**本番疎通**に必要な接続情報の受け渡し。
- 前提: 仕様は統合仕様書 v1.0＋v0.9 で合意済み。実装は Web 側で `astro check`/`build` 通過済み。

> ⚠️ 重要: **シークレット値（キー・URL の一部含む機微情報）は本文書・GitHub・チャットに記載しないでください。**
> Vault / 1Password 等のセキュアチャネルで共有し、本書はチェックリストとしてのみ使用します。

---

## A. HP/EC → Web に提供いただきたい項目

| # | 項目（Web の env 名） | 用途 | 形式・例 | 状態 |
|---|---|---|---|---|
| A-1 | `HP_BRIDGE_SUPABASE_URL` | #1 `app_bridge` 参照（ダッシュボード） | #1 Project URL `https://<project-ref>.supabase.co` | ☐ |
| A-2 | `HP_BRIDGE_READONLY_KEY` | 同上（`app_bridge_readonly` ロールで read-only 接続） | 当該ロールに紐づく API キー / JWT。**生 PII テーブルへの grant は無いこと**を確認 | ☐ |
| A-3 | `HP_EDGE_BASE_URL` | Edge Function 呼び出し共通ベース URL | 通常 #1 Project URL（`/functions/v1/...` を Web 側で付与） | ☐ |
| A-4 | `RESOLVE_SHARED_SECRET` | `x-resolve-secret` ヘッダ（サーバー間認証） | HP 生成のランダム文字列。**ローテーション可能に** | ☐ |

### 付随確認（値ではなく仕様の確認）
- A-5 ☐ Edge Function の関数名／パスが次で確定か:
  `/functions/v1/resolve-customer`、`/functions/v1/kit-self-report`、`/functions/v1/news-feed`
- A-6 ☐ `news-feed` に **`visible_on_web` を含める**（v0.9 Q2）／**論理削除済み news も `visible_on_web=false` で返す**（v0.9 Q1）対応の有無
- A-7 ☐ 本番 RLS 方式: Web 提案「サーバ専用キー＋クエリ側で `diagnostic_user_id` 本人フィルタ」で進めてよいか（per-user JWT 不要案）。RLS 強制希望時の claim 名は `diagnostic_user_id`

---

## B. Web → HP/EC へ提供する項目（`notices-admin` が #2 に書込むため）

| # | 項目 | 用途 | 受け渡し |
|---|---|---|---|
| B-1 | #2 Project URL（`DIAGNOSIS_SUPABASE_URL`） | 管理画面→#2 のお知らせ書込み | セキュアチャネル |
| B-2 | #2 service_role キー（`DIAGNOSIS_SERVICE_ROLE_KEY`） | 同上（サーバー専用・ブラウザ非露出） | セキュアチャネル |

---

## C. 受け渡し方法・登録先

- **チャネル**: Vault / 1Password 等の共有ボールト（リンクや値を GitHub・チャットに貼らない）。
- **登録先**:
  - Web: デプロイ環境のサーバー専用環境変数（`PUBLIC_` 接頭辞を付けない＝クライアントに出さない）。
  - HP: Supabase Functions secrets（`RESOLVE_SHARED_SECRET` 等）。
- **タイミング**: A-1〜A-4 は**一括**でいただけると、Web は env 登録のみで即接続テストに入れます。

---

## D. 受領後に Web が実施すること（疎通テスト）

1. ダッシュボード: `app_bridge`（customer_account / subscription / kit_shipment）参照の表示確認。
2. One Tap: `resolve-customer` 経由の本人解決 → `?u=<diagnostic_user_id>` 遷移。
3. 自己申告: `kit-self-report` → `orders` 反映 → ブリッジ展開の確認。
4. お知らせ: `notices-admin`（管理画面→#2）と `sync-announcements`（`news-feed` pull）の疎通＋スケジュール化。

---

### お願い
A-1〜A-4 の値をセキュアチャネルでご共有のうえ、本書の各 ☐ にチェック／コメントをお願いします。
A-5〜A-7 は仕様確認なので、本書 or 返答文書に ◯/× でご回答ください。いただき次第、本番疎通に進みます。
