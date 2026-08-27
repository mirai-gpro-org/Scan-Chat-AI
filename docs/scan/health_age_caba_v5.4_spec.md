# ウェルネス年齢（CABA v5.4・正規版）仕様・確定事項

> **名称変更（2026-08・発注者指示）**: 「健康年齢」→ **「ウェルネス年齢」**。表示名のみ変更で、
> 内部識別子（`HealthAgeData` / `data.health_age` / `health_age_scores` / `ui.health_age_followup` /
> ファイル名）は**据え置き**。詳細は `docs/scan/health_age_simple_v7.0_spec.md` §0。
>
> **本書は①正規版の仕様**。正規版で算出できない検体は **②簡易版（CABA v7.0）へフォールバック**する
> （`docs/scan/health_age_simple_v7.0_spec.md`）。段階の全体像は `src/lib/wellness-age.ts`。

- **実装**: `src/lib/health-age.ts`（決定論・LLM不使用）／表示 `src/components/dashboard/HealthAgeCard.astro`／API `src/pages/api/admin/health-age.ts`
- **モデル**: Levine 2018 PhenoAge（PMID 30596641）本体 ＋ Wellfort 拡張。`HEALTH_AGE_MODEL_VERSION='CABA-v5.4'`
- **原典**: `biological_age_calculator_v5.4.html`（計算式の数値一致を移植時に確認済）

Wellfort への確認依頼（2026-08-03）に対し、以下の回答を受領・**確定**（`docs/` と本コードに反映済）。

## A. 採用可否・免責（確定）

- v5.4（PhenoAge 本体＋拡張：NLR代用／性別正規化／SBP・FEV1FVC 補正）を**採用**。
- **対外表記に以下2文を必ず明記**（`HealthAgeCard.astro` に実装済・結果表示時に常時表示）:
  1. 「診断・治療の根拠にしないでください。本結果は、検査結果に基づく理論値です。」
  2. 「本数値は、原著に基づきウェルフォート社が改変したものです。」

## B. データの単位・可用性（確定・算出精度に直結＝最優先）

- **白血球(WBC)の桁数は検査機関でバラバラ（決まっていない）**。赤血球・血小板も同様。
  → **読み取り都度、桁(オーダー)で判断して正規化**する。式は **×10³/μL 前提**。
  実装 `normalizeWbcScale()`（`health-age.ts`・冪等）:
  | 表記 | 例 | 変換 |
  |---|---|---|
  | /μL | 6700（人間ドック） | ÷1000 → 6.7 |
  | ×10²/μL | 45.2（検診） | ÷10 → 4.52 |
  | ×10³/μL | 6.7 | そのまま |
  しきい値: 値≥1000 → /μL、値≥30 → ×10²/μL、それ未満 → ×10³/μL。
  （※RBC は MCV 補完側で別途スケール処理済／血小板は式に不使用）。
- **RDW**: 検査機関により無い場合あり → **中央値 13.0 で代用**（`RDW_MEDIAN`・参考値扱い・`imputed` 表示）。
- **hs-CRP**: **任意入力**。無い場合の処理（`resolveCRP`）:
  ① hs-CRP 実測値 → ② 好中球比率／リンパ球比率から **NLR（好中球/リンパ球比）**を算出し CRP を推定
  → ③ いずれも無ければ **集団中央値 0.15 mg/dL** で補完（炎症寄与は中立）。
- **好中球%（分画）**: **任意**。未入力時は上記②/③の処理へ（NLR 代用に使用）。

## C. 定数（確定・暫定でない）

- **性別中央値（クレアチニン）男 0.86／女 0.63**: 原著に無く、性別選択時の基準として設定。**このまま使用**
  （`SEX_NORM_CREAT`。ref=0.85 へ位置シフトし性差アーチファクトを除去）。
- **hs-CRP 中央値 0.15**: 上記 B の処理を参照（`CRP_MEDIAN_MGDL`）。
- **自院基準範囲**: 上記の補完処理で対応（別途提供は不要）。

## D. 補助補正（確定・採用）

- **SBP・FEV1/FVC**（原著外の加算オーバーレイ）: 本計算に運動機能関連の項目が無いため Wellfort が追加。**このまま使用**。
  - SBP: `(sbp-120)*0.06`（[-3,3]）／ FEV1FVC: `(78-fev)*0.15`（[-2,3]）／ 合計 [-4,4]。

## 必須マーカーと補完

- **ハード必須（欠けると算出不可）**: `age` ＋ `albumin, creatinine, glucose, lymph, mcv, alp, wbc`。
- **補完前提（欠けても算出可）**: `rdw`(13.0) ／ `crp`(NLR or 0.15) ／ `sbp`・`fev1fvc`・`neut`（任意）。
- 補完した項目は結果の `imputed_markers` に載せ、カードに「参考値」バッジ＋注記を表示。
- 最終クランプ 18–95 歳。BMI は v5.4 では計算に使わず参考表示のみ。

## 算出不能（必須マーカー不足）の扱い（確定・2026-08／**簡易版フォールバック追加で改訂**）

**改訂（2026-08・発注者指示）**: 正規版で必須が揃わない場合、**即座に算出不能とせず②簡易版を試す**。
判定順は `src/lib/wellness-age.ts` の `computeWellnessAge`（①正規版 → ②簡易版 → ③算出不能）。

- ハード必須が欠けると `computeHealthAge` は `biological_age:null / delta:null / ok:false` を返す（`missing_required` に欠落項目）。
  → その結果を受けて **②簡易版（`computeSimpleHealthAge`）を試行**する。
- **③（①②とも不能）でハードゲート**: `mode=run`（`api/admin/health-age.ts`）は `method==='unavailable'` のとき
  **422 `not_computable` で算出せず終了**し、`message` に発注者指定の定型文
  「算出に必要なデータが不足しています。詳細は事務局へお問合せ下さい。」を返す（定数 `WELLNESS_AGE_UNAVAILABLE_MESSAGE`）。
  → **算出不能な入力からは health_age を作らせない**（＝null は構造的に生じない）。
  `mode=check` は同じ `wellnessAgeCoverage` を使い `method`（full / simple / unavailable）を返すので、run と判定が一致する。
  - 補足: **適合チェック（`mode=check`）は lymph を含む全必須を見る**（CRP/RDW は補完前提で対象外）。従来 `mode=check` は ✅/⚠️ の**表示のみ**で
    `mode=run` を止めていなかった（⚠️でも算出実行可能）。本ゲートで run 側にも同じ判定を効かせた。
  - **どの版で算出したかは必ず残す**: API 応答 `method` / `health_age_scores.inputs.method` /
    `model_version`（`CABA-v5.4` or `CABA-SIMPLE-v7.0`）/ ダッシュボード見出し右のラベル。
- **算出不能は納品しない（防御多重化）**: assemble（`elith-assemble.ts`）は `biological_age==null` の回の **HealthAgeData を書き出さない**
  （万一 null 行が既存でも `health_age:null` を Elith へ渡さない＝"載せない"原則・捏造ゼロ）。
- 実障害（2026-08）: `elith-test-002`（2025-01-23）で必須マーカー不足（適合チェックなら⚠️）のまま `mode=run` が実行され、
  `health_age:null` の HealthAgeData が Elith へ渡り問い合わせが発生 → run ハードゲート＋assemble ガードで是正。
  **既に S3 にある null ファイルは assemble では消えない（別キーを書かないだけ）ため、古い null ファイルは手動削除（admin `elith-delete`）が必要**。
