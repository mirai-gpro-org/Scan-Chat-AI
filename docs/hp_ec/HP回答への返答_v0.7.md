# 【返答 v0.7】HP/EC 実装報告への回答＋Web 実装着手報告

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/web連携_共有サマリ.md`（HP 実装完了報告）
- 関連: 統合仕様書 v1.0、本コミットの Web 実装

---

## 0. HP 実装完了の受領

`app_bridge` 3テーブル＋`announcement_source` ビュー、`app_bridge_readonly` ロール、Edge Function 3本
（`resolve-customer` / `kit-self-report` / `notices-admin`）、管理画面の完了を確認しました。ありがとうございます。
Web 側も基盤実装に着手しました（§3）。

---

## 1. HP からの4確認事項への回答

### ① `subscription.plan_code`（UUID 文字列 → basic/cancer/ai 等が必要か）
- **当面は非ブロッキング**。ダッシュボード表示は `plan_name` を使うため、`plan_code` は不透明 UUID のままでも動作します。
- ただしロジック分岐用に**安定した短いコード（slug）**があると望ましい。可能であれば `test_products` に slug 列があるか、`plan_code` に `basic`/`cancer`/`ai` 等を供給ください（**enhancement 扱い**）。無ければ Web 側で UUID→slug の変換表を持ちます。

### ② `kit_shipment.test_type`（`test_products.category` の値整合）
- Web の正準タクソノミ（`testTypeLabel` のキー）は次の5つです：
  `health_checkup` / `blood` / `genetics` / `cancer_urine` / `ai_prediction`
- **`test_products.category` の取り得る値一覧を共有**ください。差異があれば Web 側で正規化マップを実装します（未知値は「📋 その他」表示でフォールバック済）。

### ③ お知らせ書込みを `notices-admin` Edge Function 経由にする方式
- **◯ 承認**。#2 のキーをブラウザに置かない方式に賛成です。
- 前提: `notices-admin` は #2 `diagnosis.user_notices` へ書込むため、**#2 の service_role キーを HP サーバー側に保持**する必要があります（§2 で受け渡し）。RLS/権限は #2 側の既存 grant に従います。

### ④ 本番 RLS の行フィルタ用 JWT クレーム名
- Web は **#1 を SSR（サーバー側）からのみ参照**し、`app_bridge_readonly` キーは**ブラウザに出しません**。各ユーザーの行は **SSR が `diagnostic_user_id` で明示フィルタ**して取得します。
- 推奨方式: **(a) `app_bridge_readonly` をサーバー専用キーとして秘匿＋クエリ側で本人フィルタ**（＋ネットワーク制限）。これなら per-user JWT 不要で運用が軽い。
- もし RLS で行レベル強制をご希望なら **(b) per-user JWT にクレーム `diagnostic_user_id` を載せる**方式に対応します（Web 側でユーザー毎トークン発行）。**まずは (a) を提案**。どちらで進めるか選定ください。

---

## 2. Web → HP へ渡す接続情報（共有サマリ §3 への対応）

| 提供物 | 値の所在 | 受け渡し |
|---|---|---|
| `DIAGNOSIS_SUPABASE_URL`（#2 Project URL） | Web 環境変数 `PUBLIC_SUPABASE_URL` | **セキュアチャネル（Vault/1Password）で共有**（本書には記載しません） |
| `DIAGNOSIS_SERVICE_ROLE_KEY`（#2 service_role・サーバ専用） | Web 環境変数 `SUPABASE_SERVICE_ROLE_KEY` | **同上（リポジトリ/文書に絶対に書かない）** |

| HP → Web へ依頼（受領待ち） | 用途 |
|---|---|
| `HP_BRIDGE_SUPABASE_URL`（#1 Project URL） | app_bridge 参照 / Edge Function ベース URL |
| `HP_BRIDGE_READONLY_KEY`（app_bridge_readonly JWT/キー） | app_bridge 読み取り |
| `RESOLVE_SHARED_SECRET`（HP 生成） | `x-resolve-secret` ヘッダ |

> シークレットは双方とも**コミットせず**、デプロイ環境のシークレットストアにのみ登録します。

---

## 3. Web 実装の着手報告（本コミット）

統合仕様書に沿って基盤を実装し、`astro check` / `build` 通過済みです。

| 実装 | 内容 |
|---|---|
| 2接続化 | `getBridgeSupabase()` / `isBridgeConfigured()`（#1 app_bridge read-only, schema 固定） |
| ブリッジ型 | `src/types/supabase-bridge.ts`（3テーブル＋`announcement_source`） |
| アダプタ | `src/lib/bridge-queries.ts`（ブリッジ行→既存型へ適合、UI 無改修。lab 系は null） |
| ダッシュボード | `loadDashboard()` は **bridge 構成時に app_bridge 参照**、未構成時は customer モックへフォールバック（dev 維持） |
| Edge 連携 | `src/lib/hp-edge.ts`（`resolveCustomerByEmail` / `submitKitSelfReport`、`x-resolve-secret`） |
| 自己申告 | self-report API は **HP Edge 構成時に `kit-self-report` へ委譲**（正本=orders）、dev はモック更新 |
| env | `HP_BRIDGE_SUPABASE_URL` / `HP_BRIDGE_READONLY_KEY` / `HP_EDGE_BASE_URL` / `RESOLVE_SHARED_SECRET` 追加 |

### 残 Web タスク（次の着手）
- [ ] **One Tap の email 解決化**: `DEMO_EMAIL_TO_UID` を撤去し、サーバー API 経由で `resolve-customer` を呼び、`diagnostic_user_id` 解決＋#2 `app_users` へ `google_sub` 永続化。
- [ ] `sync-announcements` の接続確定・スケジュール化（`announcement_source` 接続後）。
- [ ] 接続情報（§2）受領後の本番疎通テスト（ダッシュボード／自己申告／お知らせ pull）。

---

## 4. 次アクション
1. HP: §1-④ の RLS 方式選定（(a) 推奨）、§1-② の category 値一覧、§2 の接続情報・シークレット発行。
2. Web: One Tap の email 解決化を実装（接続情報受領前でも実装は先行可）。
3. 双方: 接続情報受け渡し後、本番疎通（dev はモックで継続検証）。
