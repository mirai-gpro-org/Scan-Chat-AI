# 【返答 v1.0】接続情報依頼への回答への回答（Web アプリチーム）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/web連携_接続情報依頼_回答.md`
- 関連: `docs/HP_EC_接続情報依頼.md`, `supabase/functions/sync-announcements/index.ts`

---

## 0. 受領

接続情報 A-1〜A-4 をセキュアチャネルで（権限者対応・Web 提供物と同時に）受け渡しいただける旨、了解しました。
A-5〜A-7 の確認回答もありがとうございます。Web 側の対応を反映しました。

---

## 1. 各回答への対応

| 項目 | HP 回答 | Web の対応 |
|---|---|---|
| A-1/A-3 URL | #1 Project URL（bridge / edge 共通）をセキュア共有 | 受領後 `HP_BRIDGE_SUPABASE_URL` / `HP_EDGE_BASE_URL` に登録 |
| A-2 read-only キー | restricted ロール、**生 PII テーブルへの grant 無しを確認済** | 受領後 `HP_BRIDGE_READONLY_KEY` に登録（サーバ専用） |
| A-4 シークレット | HP 生成・Vault・ローテーション可 | 受領後 `RESOLVE_SHARED_SECRET` に登録（サーバ専用） |
| A-5 関数パス | `/functions/v1/{resolve-customer,kit-self-report,news-feed}` 稼働 | Web 実装のパスと一致。OK |
| A-6 削除追跡 | `news` に削除追跡なし → **Web 側でフル同期突合**を依頼。`news-feed` は `visible_on_web=true` を全件付与 | **実装済**（§2） |
| A-7 RLS | Web 提案を受諾（サーバ専用キー＋`diagnostic_user_id` 本人フィルタ、claim 名は将来 `diagnostic_user_id`） | 現実装と一致。キーは非 `PUBLIC_`（サーバ専用）で保持済 |

---

## 2. A-6 削除突合（reconciliation）の実装

`sync-announcements` に**フル同期時の削除突合**を追加しました。

- 動作: `news-feed` をフル取得 → present 行を `source_news_id` 冪等 upsert →
  **feed に存在しない news 由来 announcement を `visible_on_web=false` に論理削除**。
- 起動方針: **日次はフル同期（`SYNC_SINCE` 未指定）**で削除突合を有効化。短間隔の差分（`SYNC_SINCE` 指定）時は突合をスキップ（負荷軽減）。
- 物理削除はしない（Q1 合意どおり論理削除）。Web 表示は `visible_on_web=true` のみのため、突合で自然に非表示化されます。
- 戻り値に `{ fetched, upserted, hidden }` を返し、運用監視可能。

---

## 3. 残・次アクション

1. **接続情報の受け渡し**（A-1〜A-4）と **Web→HP 提供物**（B-1 `DIAGNOSIS_SUPABASE_URL` / B-2 `DIAGNOSIS_SERVICE_ROLE_KEY`）を**同時にセキュアチャネルで**実施。
2. Web: 受領後に env 登録 → 本番疎通テスト（ダッシュボード / One Tap / 自己申告 / お知らせ pull＋削除突合）。
3. Web: `sync-announcements` のスケジュール化（**日次フル**＋必要なら短間隔差分）。

仕様面は出尽くしました。あとは接続情報の受け渡し → 疎通でクローズに向かいます。
