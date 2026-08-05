# 【返答 v0.5】news 同期方式（pull）への合意（Web アプリチーム）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/web連携_IF仕様とマッピング_draft.md`（v0.4 更新分）
- 関連: `docs/hp_ec/HP回答への返答_v0.4.md`, `supabase/functions/sync-announcements/index.ts`（本回答で追加）

---

## 1. 同期方式: pull で合意 … ◯

HP 提案どおり **pull 型**で進めます。

- **#2（Web）のバッチが #1 `app_bridge.announcement_source` ビューを取得 → `diagnosis.announcements` へ upsert**。
- 突合キー: `source_news_id`（= `news.id`）。冪等。
- cadence: 日次〜数十分で十分（お知らせは低頻度）。**当面は日次**で開始し、必要なら短縮。
- この方式は「Web は `app_bridge` のみ参照」という方針と完全整合（#2 への inbound 書込み口が不要）。

### HP 側に用意いただくもの（確認）
- `app_bridge.announcement_source` ビュー（`news` を read-only 公開、`source_news_id = id`）＋ Web restricted ロールへ SELECT 付与 … **お願いします**。
- ビューの**列名の確定**を依頼（当方 scaffold は下記想定）。差異があれば教えてください。

| announcement_source（想定列） | 当方マッピング先（announcements） |
|---|---|
| source_news_id (= news.id) | source_news_id |
| title | title |
| content | **body**（※当方は body） |
| image_url | image_url |
| link_url | link_url |
| link_text | link_text |
| published_at | published_at |
| （固定） | category = `'news'` |
| （固定） | visible_on_hp = true / visible_on_web = true |
| （無し） | published_until = NULL（news に終了日カラム無し＝無期限） |

> `visible_on_*` は **pull 側（Web）が設定**します（HP news は HP/Web 双方掲載対象として既定 true）。編集面で「Web 非掲載」にしたい news があれば、ビューにフラグ列を足すか別途協議。

## 2. 公開終了日（published_until）… 確定

HP `news` に終了日カラムが無いとのことなので、**`published_until = NULL`（無期限）**で確定。将来 news に終了日が入る場合のみ供給ください（列は当方に用意済み）。

## 3. Web 側の対応（本回答で前進）

- `supabase/functions/sync-announcements/index.ts` を **scaffold 追加**。
  - #1 `app_bridge.announcement_source`（read-only）取得 → #2 `diagnosis.announcements` upsert（`onConflict: source_news_id`）。
  - 必要 env: `HP_BRIDGE_SUPABASE_URL` / `HP_BRIDGE_READONLY_KEY`（#1）, `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`（#2 自動）。
  - ビュー列確定後に列マッピングを最終化。スケジュール起動（pg_cron 等）は接続情報確定後に設定。

---

## 4. 残り（ほぼクローズ）

| 項目 | 状態 |
|---|---|
| resolve-customer / kit-self-report I/F | 合意済 |
| 共有シークレット受け渡し | secrets 管理で合意（具体チャネル＝1Password/Vault 等の最終決定のみ） |
| announcements 拡張マイグレ | Web 実施済（`20260621000010_...`） |
| news→announcements マッピング | 確定（content→body / source_news_id 突合 / published_until=NULL） |
| 同期方式 | **pull で合意（本書）** |
| announcement_source ビュー列名 | HP 確定待ち |

### Web 側 実装タスク（着手順・推奨）
1. #2 の 2接続化（#1 `app_bridge` read-only クライアント）＋ env 整備
2. `resolve-customer` 呼び出しで One Tap を email 解決化（`DEMO_EMAIL_TO_UID` 撤去、#2 `app_users` へ google_sub 永続化）
3. `loadDashboard` をブリッジ参照へ（kit=orders由来 / 検査完了=#2）
4. 自己申告 UI → `kit-self-report` POST へ置換
5. `sync-announcements` の接続確定・スケジュール設定（本書 scaffold を最終化）

齟齬なければ、Web 側は 1→2 から実装着手します。
