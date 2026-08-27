# AI レビュー依頼・相談 文書（Gemini / ChatGPT 宛）

開発中に Gemini / ChatGPT へレビュー・相談・フィードバック依頼として作成したドラフトを集約。
実装の意思決定の経緯（なぜその方式に収束したか）の記録。※作業用ドラフトのため確定仕様は各 `docs/…_spec.md` が正本。

## 一覧（テーマ別）

### 設計レビュー
- `consult_basic_design_review.md` — 基本設計レビュー依頼
- `consult_integrated_design_review.md` — 統合設計レビュー依頼

### スキャン精度（非決定・残差）
- `consult_scan_nondeterminism.md` — スキャン非決定性の相談
- `consult_scan_final_residual.md` — 最終残差の相談
- `qualitative_tie_feedback_request.md` — 定性 Semantic-Tie のフィードバック依頼
- `gemini_followup_oxflag.md` — O/X 列追加案のフォローアップ（→ numeric回帰で不採用）
- `vqa_secondpass_consult.md` — 第2パス VQA（Verify&Repair）の相談

### Phase 1/2（決定論修正スタック）
- `consult_phase12_feedback.md` — Phase 1/2 フィードバック依頼
- `consult_phase12_confirm.md` — Phase 1/2 確認

### 人間ドック 残差・ばらつき
- `consult_humandock_residual_20260803.md` — 人間ドック残差（Gemini）
- `consult_humandock_residual_chatgpt_20260803.md` — 同（ChatGPT・golden誤り指摘を含む）
- `consult_humandock_v2_rereview.md` — 再レビュー
- `consult_humandock_variance_20260803.md` — run 間ばらつきの相談

> 補足: Wellfort 宛の確認依頼ドラフト（ウェルネス年齢 v5.4 等）は本フォルダ対象外（確定版は `docs/scan/health_age_caba_v5.4_spec.md`）。
