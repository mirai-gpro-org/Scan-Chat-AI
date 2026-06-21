# 【依頼】診断系(#2) への「お知らせ機能テーブル」SQL 適用のお願い（Web → HP/EC）

- 作成: Web アプリ（Scan-Chat / マイページ）チーム
- 宛先: HP/EC（wellfort-site）チーム / #2 DB 権限者
- 日付: 2026-06-21
- 緊急度: 中（マイページの「お知らせ」ページが現在エラーで開けない）

---

## 0. 事象

マイページの「🔔 お知らせ」を開くと次のエラーになります：

```
user_notices: Could not find the table 'diagnosis.user_notices' in the schema cache
```

- 原因: **お知らせ系テーブルを作成するマイグレが #2（診断系）にまだ適用されていない**ためです。
- ダッシュボード本体（`app_users` / `test_artifacts` 等）は表示できているので、`diagnosis` スキーマ自体は公開済みで、**該当テーブルだけが欠落**しています。
- コード側（`notice-queries`）は正しく `diagnosis.user_notices` / `diagnosis.announcements` を参照しています（不具合ではありません）。

## 1. お願い

**#2（Web が参照する Supabase）の `diagnosis` スキーマに、お知らせ系テーブルを作成**してください。
DB 適用権限は権限者（HP/EC 側）にあるため、本依頼とします。

### 方法（どちらでも可）

**方法A: Supabase CLI（リンク済みの場合・推奨）**
```bash
supabase db push    # 未適用マイグレのみ反映（破壊なし）
```
対象マイグレ（リポジトリ同梱・適用順）:
1. `supabase/migrations/20260620000010_notices.sql`
2. `supabase/migrations/20260621000010_announcements_news_sync.sql`
3. `supabase/migrations/20260621000020_announcements_visibility_align.sql`

**方法B: SQL を直接実行（Studio の SQL Editor 等・CLI を使わない場合）**
- リポジトリの **`supabase/apply_notices.sql`** を貼り付けて実行してください。
  - 上記3マイグレを**1ファイルに統合・冪等化**（`create/add ... if not exists`）したものです。**再実行しても安全**です。
  - 末尾で `notify pgrst, 'reload schema';` を実行し、作成直後のスキーマキャッシュも更新します。

> いずれの方法でも **DDL のみ**で、既存データは破壊しません。デモ用のサンプルお知らせ（`seed_notices.sql`）は**含めていません**（§3 参照）。

## 2. 適用後の確認

```sql
select to_regclass('diagnosis.user_notices')  as user_notices,
       to_regclass('diagnosis.announcements') as announcements;
-- 両方が NULL でなければ成功
```
- アプリ側: マイページの「🔔 お知らせ」を再読込し、エラーが消える（データ未投入なら空表示＝正常）ことをご確認ください。

## 3. 確認したいこと（ご回答ください）

1. **適用対象の #2 プロジェクト**は（接続情報受け渡しで共有予定の）診断系 Supabase で相違ないか。
2. **デモ用サンプルお知らせ（`supabase/seed_notices.sql`）の投入要否**：
   - 動作確認用に投入する／本番相当のため投入しない、のどちらにしますか。
   - 本番運用では、個別お知らせは管理画面（`notices-admin`）、ニュースは pull 同期（`sync-announcements`）から入る想定のため、**通常はサンプル不要**です。
3. **本番 RLS**：`apply_notices.sql` の policy は既存マイグレと同じ dev policy（緩め）です。本番強化のタイミング・方針に問題ないか。

## 4. 確認チェックリスト

- [ ] #2 へ方法A or B で適用完了
- [ ] `to_regclass` 確認で2テーブルとも作成済み
- [ ] マイページ「お知らせ」がエラーなく開ける
- [ ] サンプル投入の要否を回答（§3-2）

---

お手数ですが、適用と §3 のご回答をお願いします。適用後にこちらでも疎通（お知らせ表示／既読フィルタ／pull 同期）を確認します。
