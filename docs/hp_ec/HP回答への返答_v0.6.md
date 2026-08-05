# 【確認 v0.6】統合仕様書 v1.0 への確認回答（Web アプリチーム）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/web連携_統合仕様書.md`（v1.0 / v0.5 合意時点）
- 関連: `docs/HP回答への返答_v0.3〜v0.5.md`, `supabase/functions/sync-announcements/index.ts`

---

## 0. 結論

統合仕様書 v1.0 は **v0.1〜v0.5 のキャッチボール内容を正確に集約**しており、当方の設計・成果物とも一致します。
**本書を正本（single source of truth）とすることに合意**します。以降、当方ドラフト（bridge_table_design_draft / 返答 v0.3〜v0.5）は履歴として残します。

---

## 1. §10 オープン項目への回答

| 項目 | Web の回答 |
|---|---|
| `announcement_source` ビューのカラム名最終確認 | **◯ 確認完了**。§7-1 の列（source_news_id / title / **body**(=content) / image_url / link_url / link_text / published_at / published_until / source_updated_at）で問題なし。当方 pull 処理を本仕様に合わせて修正済（下記§2）。 |
| ビュー作成＋restricted SELECT 付与 | HP 着手待ち。付与後に接続情報（URL/キー）を secrets 経由で連携ください。 |
| `visible_on_web` の運用（将来プロセス化） | 当面は **pull 側で `visible_on_hp=false / visible_on_web=true` 一律付与**でよいと考えます。将来「Web 非掲載の news」を出す要件が出たら、ビューにフラグ列追加 or 管理画面で制御、を別途協議。 |
| 本番シークレット値の受渡 | 方式合意済（HP 生成→Vault/1Password→双方環境変数）。実施タイミングはビュー／ロール発行と同時で。 |
| マイグレ／Edge Function の本番適用 | HP 権限者対応で了解。 |

---

## 2. 当方 pull 処理を仕様に整合（修正済）

`supabase/functions/sync-announcements/index.ts` を統合仕様書 §7-1 に合わせて修正しました。

- ビュー列は **`body`（=content 改名済）** を select（旧 scaffold の `content` を修正）。
- `published_until` をビューから受領（NULL=無期限）。
- フラグは **`visible_on_hp=false / visible_on_web=true`**（旧 scaffold の両 true を修正）。理由: HP は native `news` を自サイト表示するため、#2 の announcements を HP に出す必要はない。
- 突合キー `source_news_id` で冪等 upsert（変更なし）。

> 将来最適化: ビュー提供の `source_updated_at` を使った**差分 pull**（前回同期以降のみ upsert）に拡張可能。初期は全件 upsert で開始します。

---

## 3. 受け入れ基準（§11）に対する Web 側の担保計画

| 受け入れ基準 | Web 側の対応 |
|---|---|
| `loadDashboard` が `app_bridge` を参照 | モック `customer` スキーマ参照を `app_bridge`（customer_account/subscription/kit_shipment）へ置換 |
| `resolve-customer` 本番疎通 | One Tap を email 解決化（`DEMO_EMAIL_TO_UID` 撤去）、#2 `app_users` に google_sub↔diagnostic_user_id 永続化 |
| 自己申告が `kit-self-report`→`orders` 反映 | 受取/返送 UI を POST へ置換、楽観更新＋次回同期で整合 |
| news→announcements pull 同期が日次で冪等 | `sync-announcements`（本書修正版）を接続確定後にスケジュール化 |

---

## 4. 役割分担（§9）の Web タスク・着手順

1. **#2 の 2接続化**（#1 `app_bridge` read-only クライアント）＋環境変数整備 … *依存の起点*
2. **One Tap の email 解決化**（`resolve-customer` 利用、`DEMO_EMAIL_TO_UID` 撤去）
3. `loadDashboard()` を `app_bridge` 参照へ
4. 自己申告 UI を `kit-self-report` POST へ置換
5. `sync-announcements` の接続確定・スケジュール化（本書修正版を最終化）

> HP 側の「`app_bridge` 3テーブル＋`announcement_source` ビュー作成・restricted ロール発行」が揃えば、当方 1→2 から実装着手できます（モック相手の先行実装も可）。

---

## 5. まとめ

- 統合仕様書 v1.0 に **全面合意**、正本として採用。
- オープン項目はいずれも回答済 or 実施待ち（HP のビュー／ロール発行がクリティカルパス）。
- 当方 pull 処理は仕様に整合済。HP のビュー／ロール発行と接続情報共有を待って、Web 実装（2接続化→email解決→ダッシュボード→自己申告→同期）に着手します。
