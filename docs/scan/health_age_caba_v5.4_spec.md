# 健康年齢（CABA v5.4）仕様・確定事項

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

## 算出不能（必須マーカー不足）の扱い（確定・2026-08）
- ハード必須が欠けると `computeHealthAge` は `biological_age:null / delta:null / ok:false` を返す（`missing_required` に欠落項目）。
- **算出不能は保存しない**: `mode=run`（`api/admin/health-age.ts`）は `result.ok=false` のとき `health_age_scores` へ **upsert しない**
  （応答 `save_skipped:true`）。→ null 行を残さない。既存の妥当スコアも null で上書きしない。
- **算出不能は納品しない**: assemble（`elith-assemble.ts`）は `biological_age==null` の回の **HealthAgeData を書き出さない**
  （`health_age:null` のファイルを Elith へ渡さない＝"載せない"原則・捏造ゼロ）。
- 実障害（2026-08）: `elith-test-002`（2025-01-23）で必須マーカー不足のまま null スコアが保存・納品され、
  `health_age:null` の HealthAgeData が Elith へ渡り問い合わせが発生 → 上記2ガードで是正。
  **既に S3 にある null ファイルは assemble では消えない（別キーを書かないだけ）ため、古い null ファイルは手動削除（admin `elith-delete`）が必要**。
