# 【依頼】お知らせ通知機能 — 管理者(admin)ダッシュボード側の実装依頼

宛先: HP / 管理者ダッシュボード担当
発信: Web アプリ(Scan-Chat / マイページ)担当
関連: `docs/architecture/data_integration_requirements.md`（PII分離原則）, `docs/elith/elith_report_integration.md`

---

## 0. 前提（重要：テーブルは Web アプリ側で既に新設済み）

Web アプリ（マイページ）側で、ユーザー向け「お知らせ」機能を**既にリリース済み**です。
ヘッダーに「🔔 お知らせ」を新設し、`/notices` ページで以下3区分を表示しています。

| Web表示区分 | データソース |
|---|---|
| 《ユーザー名》様への重要なお知らせ（個別・既読/未読あり） | `diagnosis.user_notices` |
| 一般のお知らせ（全ユーザー共通） | `diagnosis.announcements` (category='general') |
| ニュース（全ユーザー共通） | `diagnosis.announcements` (category='news') |

**つまり「お知らせテーブルの新設(依頼①)」は Web アプリ側で完了しています。**
管理者ダッシュボード側では**同じテーブルに対して作成・一覧UIを実装**してください（テーブルを別途作り直さないでください。二重管理になります）。

> マイグレーション: `supabase/migrations/20260620000010_notices.sql`（Web アプリリポジトリ）

---

## 1. 既存テーブル定義（この契約に合わせてください）

### 1-1. 個別お知らせ `diagnosis.user_notices`（指定顧客向け・既読/未読あり）

```sql
create table diagnosis.user_notices (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_user_id uuid not null references diagnosis.app_users(diagnostic_user_id),
  title              text not null,
  body               text not null,
  link_url           text,                 -- 任意リンク
  published_at       timestamptz not null default now(),
  read_at            timestamptz,          -- null = 未読 / 値あり = 既読
  created_at         timestamptz not null default now()
);
```

- **未読/既読の判定は `read_at` の有無**（null=未読）。
- 宛先は **`diagnostic_user_id`**（診断系の匿名ID）で指定します。後述の「2. 顧客の指定方法」を必読。

### 1-2. 全ユーザー向けお知らせ `diagnosis.announcements`（一般／ニュース）

```sql
create table diagnosis.announcements (
  id            uuid primary key default gen_random_uuid(),
  category      text not null check (category in ('general','news')),
  title         text not null,
  body          text not null,
  link_url      text,
  published_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
```

- `category='general'` → Webの「一般のお知らせ」
- `category='news'`    → Webの「ニュース」

---

## 2. 依頼事項（①〜⑥への回答とタスク）

### ① お知らせテーブルの新設 → ✅ 完了済み（Webアプリ側）
上記2テーブルが既にあります。管理側は**新設不要、既存テーブルを利用**してください。

### ② 全ユーザー向け / 個別（指定顧客向け）の2タイプ → 対応済みの構造
- 全ユーザー向け = `announcements`
- 個別（指定顧客向け）= `user_notices`
管理UIから両方を作成できるようにしてください。

### ③ お知らせ作成UIを admin ダッシュボードに新設
- **全ユーザー向け作成**: `announcements` に INSERT（category を general/news から選択、title/body/任意 link_url/published_at）。
- **個別作成**: `user_notices` に INSERT（宛先顧客 + title/body/任意 link_url）。
  - 宛先は顧客を画面で選び、**`customer_id` → `diagnostic_user_id` に解決**してから保存（次項参照）。

### ④ 通知済み一覧の表示
- `announcements`: category別・`published_at desc` で一覧。
- `user_notices`: 宛先・`published_at desc` で一覧。

### ⑤ 個別通知の既読/未読の確認 ＋「全件表示 / 未読のみ表示」
- 一覧に **既読/未読バッジ**（`read_at` 有無）と、**既読化日時 `read_at`** を表示。
- フィルタ: **全件** / **未読のみ(`read_at is null`)** の切替。
- （参考）Webアプリ側のユーザー画面でも同等の「未読のみ / 全て見る」を実装済みなので、判定ロジックを合わせてください。

### ⑥ 既存「NEWSメンテ機能」に表示対象フラグ（HP / Web）を新設・DB項目追加
- **DB項目の追加が必要です。** `announcements` に表示対象フラグを追加する想定です（下記DDL案）。
- **デフォルトは HP のみ**（Webには出さない）。

```sql
alter table diagnosis.announcements
  add column visible_on_hp  boolean not null default true,   -- HPに表示
  add column visible_on_web boolean not null default false;  -- Webアプリに表示（デフォルトOFF）
```

- 既存NEWSメンテ画面に「表示対象: ☑HP ☑Web」を追加し、上記2カラムを更新。
- **Webアプリ側の対応**: ニュース/一般の取得クエリに `visible_on_web = true` の条件を追加します（このカラム追加が確定したらWeb側で対応します）。
- これにより「NEWSは原則HPのみ、Webにも出したいものだけフラグON」という運用が可能になります。

---

## 3. 連携上の必須決定事項（先に握りたい点）

### (A) 顧客の指定方法：`customer_id` → `diagnostic_user_id` の解決
個別お知らせの宛先は **`diagnostic_user_id`（診断系の匿名ID／PIIなし）** です。
管理画面はPIIのある `customer.customer_profiles` で顧客を検索すると思いますが、保存時は
`customer_profiles.diagnostic_user_id` を引いて `user_notices.diagnostic_user_id` に格納してください。

```sql
select diagnostic_user_id
from customer.customer_profiles
where user_id = :selected_customer_id;
-- diagnostic_user_id が null の顧客（マイページ未連携）は個別通知の宛先に選べない旨をUIで明示
```

### (B) どの Supabase に置くか（本番のスキーマ分離）
- これらは PII を含まないため **`diagnosis` スキーマ**（本番では診断系=Supabase #2）に置いています。
- 管理ダッシュボードが顧客系(Supabase #1)に接続している場合、**お知らせの書き込み先は診断系(#2)** になります。
  書き込み手段（service_role 接続 or Edge Function 経由 or 同期ジョブ）をどうするか方針合わせをお願いします。
- dev プロファイルでは 1 Supabase内の2スキーマ構成なので、ローカルでは同一接続で書けます。

### (C) NEWS のソース・オブ・トゥルース統一
既存のHP側NEWSと、Webの「ニュース」を**同一テーブル `diagnosis.announcements(category='news')` に一本化**することを推奨します。
別テーブルで持つ場合は、⑥のフラグON時にWeb側へ同期する仕組みが別途必要になります。どちらで進めるか確認させてください。

---

## 4. 既読化 API 契約（Webアプリ側で実装済み・参考）

ユーザーがマイページで既読/未読を切り替えるAPIは実装済みです。管理側で既読状態を読むだけなら `read_at` を参照すればOKです。

```
POST /api/notices/{user_notices.id}/read
body: { "diagnosticUserId": "<uuid>", "read": true | false }
→ read=true で read_at=now()、read=false で read_at=null
   （所有者チェックあり：diagnosticUserId が当該お知らせの宛先と一致する場合のみ更新）
```

---

## 5. 受け入れ基準（Done の定義）

- [ ] 管理画面から「全ユーザー向け(general/news)」「個別(指定顧客)」のお知らせを作成できる
- [ ] 個別作成時、PII顧客選択 → `diagnostic_user_id` 解決 → 保存 ができる
- [ ] 通知済み一覧（全ユーザー向け／個別）が新しい順で表示される
- [ ] 個別一覧で既読/未読・既読日時が表示され、「全件 / 未読のみ」で絞り込める
- [ ] NEWSメンテに「HP/Web」表示対象フラグ（デフォルトHPのみ）が追加され、DBに `visible_on_hp/visible_on_web` が反映される
- [ ] （Web側連携）`visible_on_web=true` のニュースのみWebアプリに表示される

---

## 6. Web アプリ側で対応すること（こちらのTODO）

- ⑥の `visible_on_hp/visible_on_web` カラム確定後、`announcements` 取得クエリに `visible_on_web=true` を追加。
- カラム追加のマイグレーションは、診断系スキーマの所有がどちらかに応じて分担（要相談）。

ご不明点・方針のすり合わせ（特に §3 の A/B/C）があれば連絡ください。
