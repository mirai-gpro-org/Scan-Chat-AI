# 【返答 v0.8】お知らせ機能 Web 引継ぎへの回答（Web アプリチーム）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/お知らせ機能_Web引継ぎ.md`
- 関連: 統合仕様書 v1.0、`docs/hp_ec/HP回答への返答_v0.7.md`

---

## 0. 受領

`notices-admin` Edge Function（6 操作）と管理画面 `admin/notices.astro` の完成を確認しました。
#2 側の依存（スキーマ・可視性フラグ・接続情報）に対応しました（§1〜§3）。

---

## 1. スキーマ要件への対応（#2 diagnosis）

| 引継ぎ要件 | 対応 |
|---|---|
| `announcements.visible_on_hp boolean default true` | **◯ 整合済**（migration `20260621000020`）。先行マイグレでは既定が逆だったため**既定値を HP 仕様に揃え**、既存行を表示マッピングでバックフィル |
| `announcements.visible_on_web boolean default false` | **◯ 整合済**（同上） |
| `user_notices`（diagnostic_user_id/title/body/link_url/published_at/read_at） | **◯ 既存どおり維持** |

### `create_announcement` / `create_notice` のカラム整合（#2 実カラム名）
- `announcements`: `id, category(general/news), title, body, link_url, published_at, source_news_id, image_url, link_text, visible_on_hp, visible_on_web, published_until, created_at, updated_at`
  - **本文は `body`**（`content` ではない）。`category` は `general|news` の CHECK。
  - `title`/`body`/`category` は NOT NULL。その他は任意。
- `user_notices`: `id, diagnostic_user_id, title, body, link_url, published_at, read_at, created_at`
  - `diagnostic_user_id`/`title`/`body` は NOT NULL。

> **依頼**: `create_announcement` は**掲載面トグルの値を明示送信**してください。既定は `visible_on_hp=true / visible_on_web=false` のため、Web 掲載したい一般お知らせ/ニュースは `visible_on_web=true` を明示しないと Web に出ません。

## 2. Web 表示の可視性フィルタ（実装済）

- Web のお知らせ取得（`notice-queries`）に **`visible_on_web=true` フィルタを追加**。HP 管理画面の掲載面トグルが Web 表示に反映されます。
- 表示マッピングに沿ってバックフィル＆seed 明示化：**general=Web のみ / news=HP+Web**。

## 3. 接続情報の受け渡し（引継ぎ §Required Handoff Items）

| 提供物 | 値の所在 | 受け渡し |
|---|---|---|
| #2 Project URL（`DIAGNOSIS_SUPABASE_URL`） | Web `PUBLIC_SUPABASE_URL` | **Vault/1Password 等のセキュアチャネル**（文書・リポジトリには記載しない） |
| #2 service_role キー（`DIAGNOSIS_SERVICE_ROLE_KEY`） | Web `SUPABASE_SERVICE_ROLE_KEY` | **同上** |
| スキーマ準備・migration 所有 | — | **Web 側で実施・所有**（announcements 拡張＝20260621000010 / 20260621000020） |

---

## 4. ニュースの生成経路の一本化 → **確定: 案A（HP news → pull 同期のみ）**

> **決定（2026-06-21）**: news の正本は **HP `news` テーブル**。`sync-announcements` の pull 同期のみで `announcements(category=news)` を生成する。
> **管理画面 `create_announcement` は general 専用**とし、news は作成しない運用。`sync-announcements` は Web 側で採用継続。

（以下、検討の経緯）
現状、`announcements`（category=news）への書込み経路が **2 つ**存在し得ます：

1. **pull 同期**（v0.5 合意）: `sync-announcements` が `app_bridge.announcement_source`（HP `news` 由来）を取得して upsert（突合キー `source_news_id`）。
2. **管理画面 create_announcement**: `notices-admin` が category=news を #2 へ直接 insert（`source_news_id` なし）。

**両方が動くと news が二重登録**されます（source_news_id 有/無で重複）。正本を 1 つに決めたいです：

- 案A: **HP `news` を正本 → pull 同期のみ**（管理画面は general 専用、news は news テーブルで管理）。← v0.5 合意に忠実
- 案B: **管理画面 create_announcement を news の正本**（pull 同期 `sync-announcements` は停止/不採用）。
- 案C: 併用するなら、管理画面 news も `source_news_id` を必須化し重複排除（複雑）。

→ どれにするか合意ください。Web 側は決定に応じて `sync-announcements` の採否を確定します。

---

## 5. ステータス

| 項目 | 状態 |
|---|---|
| announcements 可視性フラグ整合（既定・バックフィル） | ✅ 実装 |
| Web 表示の visible_on_web フィルタ | ✅ 実装 |
| create_announcement/notice のカラム整合 | ✅ 確認（明示フラグ送信を依頼） |
| #2 接続情報の受け渡し | 方式合意済・実施待ち（セキュアチャネル） |
| news 生成経路の一本化 | ✅ 確定: 案A（HP news→pull同期のみ／管理画面は general 専用） |

`astro check` / `build` 通過済み。接続情報受領後に管理画面→#2 の疎通（create_announcement/notice／検索／一覧）を確認します。
