# 検査キット 出荷・進捗・データ受渡 統合管理仕様（サブスク駆動）

| 項目 | 内容 |
|---|---|
| 目的 | サブスク検査プランを起点に、**①タカセへの出荷指示 ②Webアプリでのキット・ライフサイクル管理（発送/受取/返送/問診促し）③進捗駆動の各社データ受渡・検査結果受領・Elith作成指示** を一元管理する仕様。 |
| 元資料 | Wellfort 提供 Excel『商材送付タイミング一覧』（プラン×検査キット×発送タイミング）。 |
| 版 | 2026-08-04（Draft） |
| 関連 | `docs/subscription/subscription_management_feature_requirements.md`／`docs/lab/kit_progress_management.md`（発送〜完了ライフサイクル・パイロット実装済）／`docs/lab/lab_data_reception_overview.md`（各社受取）／`docs/lab/questionnaire_to_lab_csv_spec.md`（問診→各社CSV）／`docs/elith/elith_batch_centralization_design.md`・`docs/elith/elith_assembly_wrapping_spec.md`（Elith）／wellfort-site `admin/shipping.astro`・`api/cron-shipping.ts`（現行出荷）・`docs/billing/gmo_subscription_billing_spec.md` |

---

## 1. プラン × 検査キット × 発送タイミング（元資料）

| プラン | 初年度¥ | 2年目¥ | 発送頻度 | 遺伝子 | がんリスク | 血液 | (AI疾病予測) | (AI疾病予防) |
|---|---|---|---|---|---|---|---|---|
| 経営層・幹部（50代以上） | 187,000 | 157,300 | 年3回(4カ月毎) | 1(初回) | 3 | 3 | 1 | 4 |
| 経営層・幹部（30・40代） | 143,000 | 113,300 | 年2回(6カ月毎) | 1(初回) | 2 | 2 | 1 | 2 |
| ミドルマネジメント（50代以上） | 90,200 | 60,500 | 年3回(4カ月毎) | 1(初回) | 3 | — | — | 1 |
| ミドルマネジメント（30・40代） | 79,200 | 49,500 | 年2回(6カ月毎) | — | 2 | — | — | 1 |

- **物理キット発送（タカセ対象）＝ 遺伝子・がんリスク・血液** のみ（元資料の発送マーク○が付く行）。
  - **遺伝子**: 初年度1回目のみ発送（生涯1回）。
  - **がんリスク**: 発送頻度どおり毎回（年3 or 年2、初年度・次年度とも）。
  - **血液**: 幹部プランのみ毎回。ミドルは無し。
- **(AI疾病予測)＝LAiF**・**(AI疾病予防)＝アプリ機能** は元資料で発送マークが全て「-」＝**物理キット発送ではない**（データ/アプリ由来）。**タカセ出荷指示の対象外**。
  - AI疾病予測は「年1回」相当（データ受領）。AI疾病予防は開発中（回数は将来仕様）。

### 1.1 商品DB連携（確定）
- **4プランは商品DB `test_products`（wellfort-site Supabase）の行**（列: `name`/`price`/`first_time_price`/`renewal_price`/`category`/`features(jsonb)`/`is_active`/`is_renewal_available`/`shop_wellfort_id`/`jan_code` 等）。`products/[id].astro` は幹部プラン(¥187,000/¥157,300)を既定に読む。契約は `subscriptions` テーブル。
- **ギャップ**: `test_products` には**キット構成・年間回数・発送間隔・キット別発送ルール（遺伝子=初回のみ 等）を持つ列が無い**。→ **プラン→キット構成・発送タイミングの定義を `features(jsonb)` かプラン別マッピング表として持たせる**（本§1の表をデータ化）。出荷スケジュール(§2)・合成データ生成はこの定義を参照する。
- **合成データ生成 `elith-plan.ts` は現状 executive/middle の2プラン**。**実プラン4バリアントに合わせて拡張**する（`test_products`/上記マッピングを正とする）。※実DBの行データはキーがVercel側のため本環境から直接照会不可＝スキーマと既定値で確認。

---

## 2. 要件① タカセ出荷指示（サブスク駆動へ改修）

### 2.1 現状
- ECで検査プラン商品の**決済完了時**に、該当検査商品の**発送指示票（CSV）を出力→メール送信**。
- 併せて `api/cron-shipping.ts` が営業日 9:00 JST に自動送信（`warehouse_calendar` で休業日スキップ）。

### 2.2 課題
- 出荷単位が「購入商品」であり、**プラン→含まれる検査キットへの展開**になっていない。
- サブスクの**年間回数・発送タイミング（4/6カ月毎）**に沿った**2回目以降の定期出荷**が未対応。

### 2.3 あるべき仕様（プラン駆動の定期出荷）
1. **契約時**に、プラン（§1）から**キット別の出荷スケジュール**を確定・登録:
   - 起点 `D0`（確定）＝**契約日（＝決済日）**。**契約日が土日祝なら翌営業日**へ繰り下げ（`warehouse_calendar.is_business_day` で判定）。
   - 各回の予定日 = `D0 + 発送間隔(4 or 6カ月) × (回index)`（末日は月末クランプ、当日が非営業日なら翌営業日）。
   - キット別ルール: 遺伝子＝初回のみ／がん＝毎回／血液＝毎回(幹部のみ)。
2. **出荷指示の生成**は各予定日に、その回で発送するキットだけを **1件=1出荷指示（CSV行）** として生成 → タカセへCSV送信（既存 `cron-shipping` を**スケジュール参照型**へ拡張）。
3. CSV項目・宛先様式はタカセ様式に準拠（現行CSVを踏襲）。**サブスク解約/停止**時は以降の予定出荷を停止（`gmo_subscription_billing_spec` の契約状態と連動）。
4. **冪等性**: 同一(契約×回×キット)の二重出荷を防ぐ（出荷済フラグ＝顧客ステータス `instruction_sent` 等）。

---

## 3. 要件② Webアプリ 検査キット・ライフサイクル管理

`docs/lab/kit_progress_management.md`（パイロット版実装済）を土台に、サブスク契約テーブルと連携して1キットの全ライフサイクルを管理する。

### 3.1 状態機械（1キット×1回）
```
(出荷予定) → 出荷指示済 → 発送済 → [ユーザー]受取確認 → 検体採取/問診 → 検体返送 →
  検査会社受領 → 検査結果受領 → Elithデータ作成 → (完了)
```
- 各状態に日時・担当（システム/ユーザー/検査会社）を記録。ユーザー操作は「受取確認」「返送済」。
- **AI問診の促し（確定・催促エスカレーション）**: 検体提出時に問診データが必要な検査（血液 等・`questionnaire_to_lab_csv_spec` 参照）について、**ユーザーの検体返送に関する Webアプリ通知の時点で AI問診が未完了なら催促**する。
  - **ハードブロックにはしない**（返送自体は止めない）。未完了が続く限り **Webアプリ通知機能で毎日催促**。
  - **7日経過しても未完了なら Wellfort 管理者へワーニング通知**（管理ダッシュボードのアラート）。
  - 問診完了で催促停止。問診CSVの各社受渡(§4.1)は問診完了が前提。

### 3.2 サブスク契約テーブルとの連携
- 契約（プラン・D0・回数・状態）→ §2 の出荷スケジュール → 各回のキット・ライフサイクル行を生成。
- 管理者ダッシュボード「サブスク契約管理」（`subscription_management_feature_requirements`）から、契約単位で全キットの進捗を一覧・操作。

---

## 4. 要件③ 進捗駆動のデータ受渡・受領・Elith作成指示

§3 の進捗をトリガに、下流の受渡を管理する。

### 4.1 問診データ → 検査会社へ受渡
- 対象回の検査に応じ、**AI問診回答→各社CSV**（`docs/lab/questionnaire_to_lab_csv_spec.md`）を生成し受渡（受渡経路は `docs/lab/lab_data_reception_overview.md`）。
- トリガ: §3.1「検体返送」前（問診完了済み）／がんリスク等は検体と同送の運用に合わせる。

#### 4.1.1 LAiF 上りCSV（AI疾病発症予測 入力フォーム）生成 — 写像仕様とフロー【2026-08 追加】

> **位置づけ（責務分離・重要）**: LAiF の上り入力フォーム（`input_format_new_202312.xlsx`＝No.0〜157・約158項目）は、
> **健診/人間ドックのAIスキャン結果（HealthCheckupData）＋ AI問診 ＋ 基本情報 を "1人分" に集約して写像**するもの。
> **検査票スキャン（読取）フローには足さない**。スキャンは HealthCheckupData（材料）を作る役、LAiF上りCSVは
> その材料＋問診＋基本情報を集約する**別の"上りexport"ステップ**（Elith納品アセンブリと同じ「集約・書き出し」層）。

**(A) データ源マッピング（3系統）**

| フォーム区分 | No | 主な取得元 | 備考 |
|---|---|---|---|
| 基本情報 | 0–8 | 識別番号=**整理番号（Wellfort採番の仮名ID・確定）**／性別・生年月日=**customer**／受診日・身長・体重・BMI・腹囲=**健診スキャン** | **生年月日は渡す（確定・発注者決定）**→CSVは個人データ扱い |
| 既往歴・服薬・手術・輸血 | 9–24 | **AI問診**（既往/服薬設問）＋（あれば）健診票の既往欄 | 有/無・部位コメント等 |
| 問診情報（喫煙/飲酒/体重変化/運動/食事/睡眠/改善意思） | 25–61 | **AI問診**（`LifestyleQuestionnaireData`） | Y/N・選択肢を LAiF 記法へ |
| 健診情報（血圧・脈・眼圧・視力・聴力・K-W・眼底・エコー所見・CAVI/ABI・尿定性・血算・生化学・腫瘍マーカー 等） | 62–157 | **健診・人間ドックスキャン（HealthCheckupData measurements）が主**（血液=デメカルも源） | 大半が既存スキャン抽出項目に一致 |

**(B) 写像の原則（決定論・捏造ゼロ）**
- **既存の正準化語彙で対応付け**（`canonicalize.ts`/標準マスタと同じ名寄せ・単位・定性正規化）。項目名は LAiF フォームの固定キーに合わせる。
- **定性**（尿蛋白/尿糖/尿潜血/ケトン/便潜血/HBs/HCV/RPR 等）は LAiF 記法 `(ー)/(±)/(1＋)…`・`(ー)/(＋)` へ正規化。K-W/Scheie は群/度の記法へ。
- **値の無い項目は空**（前回値の繰り上げ・推定で埋めない＝捏造ゼロ）。左右別（眼圧/視力/聴力/CAVI/ABI/K-W）はフォームの右左キーへ。
- 写像表の**正本＝`docs/lab/questionnaire_to_lab_csv_spec.md`**（LAiF 列を全158項目ぶん確定していく）＋ 本フォーム原本。

**(C) 生成・受渡フロー（進捗駆動）**
1. §4.3 の「その回の**健診結果＋AI問診が揃った**」判定と同期して **LAiF上りCSVを生成**（集約＝Scan-Chat-AI API／指示UI＝wellfort-site admin）。
2. S3 の上り領域 `to-laif/` へ CSV 書き出し（**整理番号でひも付け**・氏名等は載せない）。
3. `laif_s3_secure_handoff_spec §4.5` の**自動メール通知**（登録3宛先）→ LAiF がポータルから取得（`§0.3` デモ画面あり）。

**(D) 確定事項・残（`laif_s3_secure_handoff_spec §0.2` と同一）**
- **整理番号（識別番号 No.0）＝Wellfort採番の仮名ID（確定 2026-08）**。LAiF自社連番は使わない（突合はWellfort整理番号）。
- **生年月日（No.3）＝渡す（確定 2026-08・発注者決定）**。→ 上りCSVは**生年月日を含む個人データ**（PIIフリーでない）＝`data_integration_requirements` の外部非送付ルールへのLAiF向け明示的例外。ポータルで保護。**残=同意範囲の確認（運用）**。
- **問診由来項目の充足（残）**：既往歴/服薬(9–24)・生活習慣(25–61) は AI問診の設問網羅性に依存（不足設問は問診票側で補完）。

### 4.2 検査結果 受領タイミング管理
- 各社の受領方式（血液=リージャー/RPA・がん=プリベント/調整中・AI予測=LAiF/S3・遺伝子=Genoplan/RPA）ごとに**受領予定と実績を管理**（`lab_data_reception_overview`）。
- 未受領のアラート／再督促。受領=そのキット行を「検査結果受領」へ前進。

### 4.3 Elith データ作成指示 管理
- 全必要データ（当該回の検査結果＋問診＋健康年齢等）が揃った時点で、**Elith 形式 JSON 生成＋S3受渡を指示**（`docs/elith/elith_batch_centralization_design.md`／`elith_assembly_wrapping_spec.md`）。
- 健康年齢・AI疾病予測も §該当仕様どおり同梱（検査日毎の時系列）。作成/受渡の状態を記録。

---

## 5. 全体フロー

```
サブスク契約(プラン/D0)  ─▶ ②出荷スケジュール ─▶ タカセ出荷指示(CSV) ─▶ 発送
        │                                                          │
        └────────── ③Webアプリ ライフサイクル管理 ◀──────────────┘
                     受取確認 → (AI問診促し) → 検体返送
                          │
                          ├─▶ ④-1 問診→各社CSV 受渡
                          ├─▶ ④-2 検査結果 受領(各社方式)
                          └─▶ ④-3 Elith JSON 作成・S3受渡 指示
```

## 6. データモデル

### 6.1 キット構成の持ち方（**確定＝案A: 正規化＋版管理**・2026-08）
キット自体（検査会社都合で変更/追加/削除が頻繁）と、プラン×キット構成（サブスク契約保護で慎重に変更）は
ライフサイクルが別なので、**商品DB `test_products` と連携する別テーブルへ正規化し、構成は版管理**する。

| テーブル | 役割・主な列 |
|---|---|
| `test_kits`（キット/項目マスタ） | `id`/`kit_code`(UK)/`name`/`kind`('physical_kit'\|'data'\|'app')/`lab_company`(リージャー/プリベント/LAiF/Genoplan)/`format_id`(Elith)/`is_active`/`sort_order`。**キット変更・追加・削除はここで完結**。physical_kit=遺伝子・がん・血液(タカセ発送)／data=AI疾病予測(LAiF)／app=AI疾病予防 |
| `plan_compositions`（プラン構成ヘッダ＝**版**） | `id`/`product_id`(FK→`test_products`)/`version`/`per_year`/`interval_months`/`effective_from`/`is_current`/`note`。**プラン単位で構成をバージョン管理** |
| `plan_composition_items`（構成明細） | `id`/`composition_id`(FK)/`kit_id`(FK→`test_kits`)/`qty_per_year`/`ship_rule`('every'\|'first_only'\|'none')。遺伝子=first_only／がん・血液=every／AI予測・予防=none(発送しない) |
| `subscriptions`（列追加） | `plan_composition_id`(FK→`plan_compositions`)。**契約時の構成【版】をpin** → プラン改定後も既存契約は当時の構成のまま（サブスク保護） |

**変更シナリオ耐性**:
- キット変更/追加/削除 → `test_kits` 1箇所（既存構成は `kit_id` 参照で属性は自動追従、差替は明細更新）。
- プラン構成変更/新プラン → 新 `plan_compositions` 版を作成。**既存契約は旧版pinのまま不変**。
- プラン廃止 → `is_current=false`（＋商品 `is_active=false`）。走行中サブスク契約は旧版で継続。

> 他案比較: B=`test_products.features(jsonb)`埋込(手軽だがキット非正規化・版/契約保護が弱い・逆引き不可)、C=ハイブリッド(キットのみ正規化・構成jsonb)、D=コード定数(DB非連携・契約pin不可=合成/開発用のみ)。→ **整合性・双方向照会・契約版pin で案Aを確定採用**。

#### DDL スケッチ（実装用・wellfort-site Supabase＝`test_products`/`subscriptions` と同一DB）
```sql
create table test_kits (
  id uuid primary key default gen_random_uuid(),
  kit_code text unique not null,
  name text not null,
  kind text not null check (kind in ('physical_kit','data','app')),
  lab_company text,                 -- リージャー/プリベント/LAiF/Genoplan
  format_id text,                   -- Elith: BloodTestData/CancerRiskAssessmentData/GeneticTestResultData/Other 等
  is_active boolean default true,
  sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table plan_compositions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references test_products(id),
  version int not null,
  per_year int not null,            -- 発送/受診 回数/年
  interval_months int not null,     -- 4 or 6
  effective_from date,
  is_current boolean default true,
  note text,
  created_at timestamptz default now(),
  unique (product_id, version)
);
create table plan_composition_items (
  id uuid primary key default gen_random_uuid(),
  composition_id uuid not null references plan_compositions(id) on delete cascade,
  kit_id uuid not null references test_kits(id),
  qty_per_year int not null,
  ship_rule text not null check (ship_rule in ('every','first_only','none')),
  unique (composition_id, kit_id)
);
alter table subscriptions add column plan_composition_id uuid references plan_compositions(id);  -- 契約時の版をpin
```
- インデックス: `plan_compositions(product_id, is_current)`、`plan_composition_items(kit_id)`（キット→プラン逆引き）。

#### 初期データ（Excel 4プラン → 構成明細）
`test_kits`: 遺伝子(physical_kit/Genoplan/GeneticTestResultData)・がんリスク(physical_kit/プリベント/CancerRiskAssessmentData)・血液(physical_kit/リージャー/BloodTestData)・AI疾病予測(data/LAiF/Other)・AI疾病予防(app)。

| プラン(product) | per_year/間隔 | 遺伝子 | がん | 血液 | AI予測 | AI予防 |
|---|---|---|---|---|---|---|
| 幹部(50代以上) ¥187,000/157,300 | 3 / 4カ月 | first_only(1) | every(3) | every(3) | none(1) | none(4) |
| 幹部(30・40代) ¥143,000/113,300 | 2 / 6カ月 | first_only(1) | every(2) | every(2) | none(1) | none(2) |
| ミドル(50代以上) ¥90,200/60,500 | 3 / 4カ月 | first_only(1) | every(3) | — | — | none(1) |
| ミドル(30・40代) ¥79,200/49,500 | 2 / 6カ月 | — | every(2) | — | — | none(1) |

- `ship_rule`: `every`=各回発送(タカセ)、`first_only`=初回のみ発送、`none`=物理発送なし(データ/アプリ)。
- 各 `plan_compositions` は初版 `version=1, is_current=true`。以後の改定は新 `version` を追加し既存契約は旧版pinで保護。

### 6.2 運用系テーブル（本仕様の管理対象）
- `subscription_contract`／`subscriptions`（プラン・`plan_composition_id`・D0・状態）
- `kit_shipment_schedule`（契約×回×キット×予定日×出荷状態）← §2。契約→`plan_composition_id`→明細から展開。
- `kit_lifecycle`（出荷→受取→返送→受領→Elith の各状態・日時）← §3
- `lab_handoff`（回×検査会社×問診CSV送付・結果受領・Elith作成 の各状態）← §4
- 既存の顧客ステータス（`instruction_sent` 等）・`warehouse_calendar`（営業日）と整合。

### 6.3 合成データ生成との整合
`elith-plan.ts`（合成）は上記 `test_kits`／`plan_compositions`／`plan_composition_items` を正として**4プランへ拡張**（ハードコード2プランを置換）。

## 7. 実装状況
- **実装済**: EC決済→発送指示CSV・`cron-shipping`（日次）・検査キット発送情報（パイロット）・各社受取/問診CSV/Elith の各要素仕様。
- **未実装（本仕様の主眼）**: (a) プラン→キット展開の**定期出荷スケジュール**化、(b) ライフサイクル状態機械＋AI問診促しの結線、(c) 進捗駆動の各社受渡・受領・Elith作成指示の**オーケストレーション**。

## 8. 確定事項（2026-08 回答反映）
1. **プラン数（確定）**: 実プランは**4バリアント**。商品DB `test_products` と連携。→ **合成 `elith-plan.ts` を4へ拡張**し、キット構成/回数/間隔は `test_products.features` かプラン別マッピングをデータ源とする（§1.1）。
2. **出荷起点 D0（確定）**: **D0 ＝ 契約日（＝決済日）**。**土日祝は翌営業日**（`warehouse_calendar`）。
3. **AI問診 催促（確定）**: 検体返送通知時に未完なら催促。**毎日通知**、**7日超で Wellfort 管理者へワーニング**。ハードブロックしない（§3.1）。
4. **タカセCSV様式（確定）**: **現行様式を踏襲**（スケジュール駆動でも項目・宛先は同一）。

5. **キット構成データの持ち方（確定）**: **案A＝正規化＋版管理の別テーブル**（`test_kits`/`plan_compositions`/`plan_composition_items`＋`subscriptions.plan_composition_id`）。§6.1 に DDL・初期データ。

### 残・要確認
- **AI疾病予測/予防**: 物理キット外（タカセ対象外）。AI疾病予測=年1回のデータ受領、AI疾病予防=開発中の回数/仕様（管理対象に含める時期）。
