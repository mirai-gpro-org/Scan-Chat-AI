# Elith バッチ生成「チェックフェーズ」仕様（S3書出し前の検証ゲート）

| 項目 | 内容 |
|---|---|
| 目的 | Elith へ**不完全データを納品しない**ため、AIスキャン生成JSONを**S3書出し前に検証**し、合格したものだけ書き出す。 |
| 対象 | Elith バッチ生成（検査機関の検査結果画像を AIスキャン → Elith形式JSON+元画像を S3 へ。1画像=1リクエスト）。 |
| 方式 | 生成(Gemini)とは**独立したモデル(Claude)**で「元画像 × 生成JSON」を照合し、構造化 verdict を返す。**人手承認ゲート**で書出し。 |
| 現行 | `src/pages/api/admin/elith-scan.ts`（`buildElithScanBundle`→`putFiles`）。S3未設定時は書出さず preview 返却（＝生成と書出しは既に分離可能）。UI=`wellfort-site: admin/elith-batch.astro`。 |
| 状態 | **仕様（本書）。実装は確定後。** |

---

## 1. 背景・原則
- これまで列ズレ・行混線・欠落等の**不完全JSONをそのままS3へ書き出していた**（例: HDL行の列ズレ、体脂肪率=腹囲の同値、体脂肪率105%）。
- 原則: **「生成」→「検証」→「（合格時のみ）書出し」の3段**にし、書出し前に必ずゲートを通す。
- **独立モデル検証**: 生成はGemini、検証は**別モデル(Claude)**。同一モデルの自己検証は誤りを見逃しやすい（相関誤差）。別モデル照合で検出力を上げる。

---

## 2. フロー（3段・案A＝人手承認ゲート推奨）

```
[1 生成]  画像 → Gemini スキャン → Elith形式JSON(+元画像) を作成（S3へは書かない）
   ↓
[2 検証]  元画像 × 生成JSON を Claude で照合 → verdict(構造化) を返す
   ↓
[3 判定]  pass → 承認で書出し / warn → 管理者レビュー必須 / fail → 書出しブロック
   ↓
[4 書出]  承認された bundle のみ S3 へ（JSON + 元画像 + 検証ログは当社側監査に保存）
```

- **反省を踏まえ「案A（人手承認ゲート）」を推奨**：生成＋検証で止め、管理者が verdict を確認して承認したものだけ書き出す。
- （案B: 生成→検証→pass自動書出しの1リクエスト自動ゲートも可能。速いが人の目が入らない。）

---

## 3. 検証項目（チェックリスト）

Claude に「元画像」と「生成JSON」を渡し、以下を照合させる:

| 観点 | 内容 | 例（過去の実障害） |
|---|---|---|
| 正確性 | 各値が画像と一致（OCR誤り・桁誤り無し） | 尿素窒素90 の誤読疑い |
| 列整合 | value/unit/ref_low/ref_high が正しい列にある | HDL行: 推論値="mg/dL"/単位="40"（列ズレ） |
| 行整合 | 隣接行の混線・不自然な値重複が無い | 体脂肪率=腹囲=105.0（同値） |
| 完全性 | 画像の全行を抽出（欠落無し）／画像に無い項目を捏造していない | テンプレ補完による捏造 |
| 妥当性 | 単位整合・割合(%)が0–100・値と基準値の整合 | 体脂肪率105% |
| 形式/PII | format_id整合・氏名等PIIの混入無し | — |

---

## 4. verdict（構造化・当社側監査用。納品物には含めない）

```jsonc
{
  "verdict": "pass" | "warn" | "fail",
  "score": 0-100,                       // 総合信頼度
  "summary": "総評（日本語・簡潔）",
  "checked_count": 0,                   // JSON項目数
  "image_row_estimate": 0,              // 画像から読める行数の見積り（欠落検出用）
  "issues": [
    { "severity": "error"|"warn",
      "item_index": 0, "item_name": "HDLコレステロール",
      "field": "unit", "got": "40", "expected_from_image": "mg/dL",
      "reason": "単位列に数値。推論値と単位が入れ違い（列ズレ）" }
  ],
  "missing_items":   [ "画像にあるがJSONに無い項目名" ],
  "fabricated_items":[ "JSONにあるが画像に無い項目名" ]
}
```

判定基準（既定・調整可）:
- **fail**: `issues` に severity=error が1件以上、または `missing_items`/`fabricated_items` が非空。
- **warn**: error無し・warn有り、または score < しきい値（例80）。
- **pass**: error/warn無し・score≥しきい値。

---

## 5. ゲート挙動

| verdict | 挙動 |
|---|---|
| pass | 書出し可（承認ワンクリック。案Bなら自動書出し） |
| warn | **管理者レビュー必須**。内容確認のうえ承認で書出し |
| fail | **書出しブロック**。再スキャン / 手動修正 / 管理者による強制承認（理由を監査ログに必須記録） |

- 検証結果(verdict)・元画像・生成JSONは**当社側の監査ストレージ**（S3の別prefix or DB）に保存。Elith納品物には含めない。

---

## 6. API 設計

`elith-scan.ts` を拡張、または新規 `elith-scan-check.ts` / `scan-verify.ts`:

- `POST /api/admin/elith-scan { mode:"generate", image, formatId, clientId, ... }`
  → Gemスキャンで bundle 生成 → **検証実行** → `{ preview: json, verdict, bundle_ref }` を返す（**S3書出ししない**）。
- `POST /api/admin/elith-scan { mode:"commit", bundle_ref (or 検証済みJSON+画像), approver, override?:{reason} }`
  → verdict が pass、または承認/override 付きのときのみ **S3書出し**。冪等（同一 client/date/format の二重書出し防止）。
- 検証本体 `verifyScanJson(imageBase64, mimeType, json, formatId): Promise<Verdict>`（新規 `src/lib/scan-verify.ts`）。
  - Claude（Anthropic）ネイティブ・マルチモーダルに画像+JSON+チェックリストを渡し、**構造化出力(JSON)**で verdict を得る。

---

## 7. 管理画面（wellfort-site `admin/elith-batch.astro`）

1. 画像アップ → **[生成＋検証]** 実行。
2. **verdict 表示**：総合(pass/warn/fail・score)、issues一覧（項目/列/画像期待値/JSON値/理由）、missing/fabricated、JSONプレビュー（可能なら画像と並置）。
3. **[承認して書出し] / [却下（再スキャン）]**。fail は既定で却下、override は理由入力必須。
4. 書出し後は既存どおり（1画像=1リクエスト）。

---

## 8. 前提・確認点（実装前）

1. **検証モデルの鍵**：Claude を使うなら **`ANTHROPIC_API_KEY`（新規env・Vercel）が必要**（現状は `GEMINI_API_KEY` のみ／CLAUDE.md）。
   - 無い場合のフォールバック: Gemini の**別モデル/別プロンプトで自己検証**（独立性は下がるが可）。→ どちらで進めるか要確認。
2. **コスト/レイテンシ**：1画像あたり **LLM 2回**（生成Gemini＋検証Claude）。Vercel関数 ~60s の範囲か、大型検査表は分割/タイムアウト調整。
3. **画像の再入力**：検証にも元画像を渡す（生成時のbase64を再利用）。
4. **監査保存先**：verdict/画像/JSON の保存場所（S3別prefix or Supabase）。保持期間。
5. **override 権限**：fail 強制承認できる管理者範囲（`admin_users` 権限）と理由記録。
6. **既存 Phase3 ガードとの関係**：Phase3（納品前の機械ガード）は残す＝**二重の防御**（画像照合=Claude / 決定論ガード=プログラム）。

> 本書は仕様。変更時は本書と関連docを更新してから実装（CLAUDE.md 作業ルール）。
