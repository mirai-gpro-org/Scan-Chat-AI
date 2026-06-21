# 【返答 v0.9】お知らせ案A返答への回答（Web アプリチーム）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム
- 日付: 2026-06-21
- 対象: `wellfort-site/docs/web連携_お知らせ案A返答_v0.9.md`
- 関連: `HP回答への返答_v0.8.md`、`supabase/functions/sync-announcements/index.ts`

---

## 0. 受領と主要変更の取り込み

案A（HP `news` 正本 → pull 同期のみ／管理画面は general 専用）を確定いただき合意です。
あわせて、**pull の取得元が `app_bridge.announcement_source` ビュー → `news-feed` Edge Function に変更**された点を取り込み、`sync-announcements` を作り替えました（§5）。

---

## 1. HP からの4つの質問への回答

### Q1. 削除の扱い（HP で `news` 削除時に #2 を消すか／残すか）
- **論理削除に賛成（HP 推奨どおり）**。#2 では物理削除せず **`visible_on_web=false` 化**して残す。
- 理由: 既読導線・リンク切れ回避・監査性。Web 表示は `visible_on_web=true` のみなので、false 化で自然に非表示になります。
- 実装条件: **`news-feed` が論理削除済み news も返し**、その行を `visible_on_web=false`（または削除フラグ）で表現してください。`sync-announcements` はそれを upsert して #2 を false 化します（Q2 と連動）。

### Q2. `visible_on_web` を `news-feed` に載せるか（掲載面の決定主体）
- **載せてください（推奨）**。news の Web 掲載可否は **HP のニュースメニュー側で制御**（＝決定主体は HP）とし、`news-feed` の各行に `visible_on_web` を含める。
- `sync-announcements` は **feed の `visible_on_web` を尊重**して #2 に反映します（未提供時は `true` 扱い＝従来どおり全件表示）。
- これにより Q1（論理削除）も `visible_on_web=false` で一貫表現できます。

### Q3. `announcements` 最終スキーマ（`source_news_id` の有無・型）
- **◯ 存在します**。`diagnosis.announcements.source_news_id uuid`（NULL 可）＋ **部分一意インデックス**（`where source_news_id is not null`）で冪等 upsert 可能。
  （migration `20260621000010_announcements_news_sync.sql`）
- 関連列も実装済: `image_url / link_text / published_until / visible_on_hp / visible_on_web / updated_at`。本文は **`body`**（`content` ではない）。

### Q4. `RESOLVE_SHARED_SECRET` 共有方法・`news-feed` URL 受け渡しタイミング
- **Vault/1Password 等のセキュアチャネルで共有**（文書・リポジトリには記載しない）。
- 受け渡しタイミング: **ブリッジ接続情報（`HP_BRIDGE_*`）と同時で一括**が効率的です。Web は以下を env に登録して即接続します：
  - `HP_EDGE_BASE_URL`（`news-feed` / `resolve-customer` / `kit-self-report` 共通のベース URL）
  - `RESOLVE_SHARED_SECRET`

---

## 2. Web 側実装の更新（本コミット）

`sync-announcements` を `news-feed` Edge Function 呼び出しに作り替えました（`astro check`/`build` 通過）。

| 変更 | 内容 |
|---|---|
| 取得元 | `app_bridge.announcement_source` ビュー → **HP `news-feed` Edge Function（HTTP）** |
| 認証 | `x-resolve-secret`（`RESOLVE_SHARED_SECRET`） |
| 差分 pull | `since`（`updated_at` 下限）を `SYNC_SINCE` env で指定可（未指定は全件） |
| マッピング | `category='news'` / `visible_on_hp=true` / `visible_on_web = feed値 ?? true` / `published_until` 受領 |
| 冪等 | `source_news_id` を突合キーに upsert |
| 型整理 | 使わなくなった `app_bridge.announcement_source` 型を撤去 |

> `news-feed` の出力フィールド（`source_news_id/title/body/image_url/link_url/link_text/published_at/published_until/updated_at`＋`visible_on_web` 追加）に整合済み。

---

## 3. notices-admin（general 専用化）への合意

- 「全体お知らせ作成」を **general 専用・`visible_on_web=true` 固定**、news は専用メニュー→sync 経由、という整理に合意。
- `create_announcement`（general）は引き続き `visible_on_web=true` を明示送信でお願いします（#2 の既定は `false`）。

---

## 4. 残・次アクション
1. HP: `news-feed` に `visible_on_web` を追加（Q2）、論理削除行も返す（Q1）。`news-feed` URL・`RESOLVE_SHARED_SECRET`・`HP_BRIDGE_*` をセキュアチャネルで共有。
2. Web: 接続情報受領後、`sync-announcements`（news-feed）の疎通＋スケジュール化（pg_cron 等）。
3. Web→HP: #2 `DIAGNOSIS_SUPABASE_URL` / `SERVICE_ROLE_KEY` をセキュアチャネルで提供。

これらが揃えば PR #173 のデプロイと本番疎通に進めます。
