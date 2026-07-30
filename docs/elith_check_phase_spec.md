# Elith バッチ生成「不要項目チェック（必要要素検証）」仕様

| 項目 | 内容 |
|---|---|
| 目的 | **Elith のアウトプット（AI診断書）に必要な入力要素という観点で**、生成JSON（＋元データ）に**不要な項目／余剰フィールドが無いか**を S3書出し前に検証する新機能。 |
| 位置づけ | **モデルの読み取り精度検証ではない**（それは実施済み）。「Elith が使わない要素を納品していないか」の**必要性/余剰の監査（lint）**。 |
| 対象 | Elith バッチ生成（検査結果 jpeg/PDF を AIスキャン → Elith形式JSON+元画像を S3 へ。1画像=1リクエスト）。 |
| 現行 | `src/pages/api/admin/elith-scan.ts`（`buildElithScanBundle`→`putFiles`）。S3未設定時は書出さず preview 返却（生成と書出しは分離可能）。UI=`wellfort-site: admin/elith-batch.astro`。 |
| 状態 | **仕様（本書）。実装は確定後。** |

---

## 1. 背景・原則
- Elith から「分析に不要な項目（例: `region`/`no`/`category`/`inferred`重複/空項目 等）が含まれる」との指摘。
- 反省: **Elith の出力に不要な要素を含んだJSONをそのまま書き出していた**。
- 本機能: **書出し前に「Elith が必要とする入力要素」だけになっているかを検証**し、余剰があれば止める/除去する。

---

## 2.「必要な入力要素」の定義（2層）

### 2.1 フィールド層（確定・当社で判定可能）
納品 measurement に**必要なキーのみ**（Elith要望2026-07・Phase1 lean 形）:
```
name / value / value_num / unit / ref_low / ref_high / flag
```
これ以外のキー（`region`/`no`/`category`/`inferred`/`name_detail`/`note`/`bbox`/`assessment` 等）＝**不要（余剰フィールド）**。
→ **allowlist で決定論的に検証可能**（マスタ不要）。

### 2.2 項目層（＝どの検査項目が必要か。要マスタ）
Elith が AI診断書生成に**実際に使う検査項目の集合**＝**必要項目マスタ（allowlist）**。
- マスタ外の項目 ＝ **不要候補**。
- 値が空/未測定の項目 ＝ **不要**。
- 元データ（画像/PDF）に無いのにJSONにある項目 ＝ **捏造（要除去）**。
- 必要マスタにあるのにJSONに無い項目 ＝ **不足（要確認）**。

> **重要（R3）**: 「Elith が何を使うか」を当社が勝手に決めない。
> 必要項目マスタは **Elith 合意** もしくは **AI診断書（アウトプット）からの逆引き** で確定する。
> マスタが未確定の間、項目層チェックは「空/捏造/重複」のみ動かし、allowlist 判定は保留する。

---

## 3. チェック内容（検証項目）

| 分類 | 検出内容 | 判定 | 依存 |
|---|---|---|---|
| 余剰フィールド | measurement に allowlist 外のキーがある | 不要 | なし（即可） |
| 余剰項目(マスタ外) | 必要項目マスタに無い検査項目 | 不要候補 | 必要項目マスタ |
| 空項目 | value/value_num が共に無い | 不要 | なし |
| 重複項目 | 同名 or 同値の重複（隣接混線の残骸等） | 要確認 | なし |
| 捏造項目 | 元データに無いのにJSONにある | 要除去 | 元データ参照 |
| 不足項目 | 必要マスタにあるのにJSONに無い | 要確認 | 必要項目マスタ |
| エンベロープ余剰 | 納品トップに不要キー（raw_markdown/assembled_from/source_image 等） | 不要 | なし |

---

## 4. 出力（不要項目レポート・当社側監査用。納品物には含めない）

```jsonc
{
  "result": "clean" | "surplus" | "deficient",   // clean=不要無し
  "counts": { "items_in_json": 0, "surplus_fields": 0, "surplus_items": 0,
              "empty_items": 0, "fabricated_items": 0, "missing_required": 0 },
  "surplus_fields": [ { "item_name": "BMI", "field": "no" } ],
  "surplus_items":  [ { "item_name": "内臓脂肪CT", "reason": "必要項目マスタ外" } ],
  "empty_items":    [ "白血球数" ],
  "fabricated_items":[ "…（元データに無い）" ],
  "missing_required":[ "…（必要だが欠落）" ]
}
```

---

## 5. 挙動（ゲート）

| result | 挙動 |
|---|---|
| clean | 書出し可（承認ワンクリック or 自動） |
| surplus | **余剰を除去（自動クリーン）** → 除去後を書出し。除去内容はレポートに記録。管理者確認可 |
| deficient（不足あり） | **書出しブロック**。再スキャン/手動確認（必要項目の欠落は分析に影響するため） |

- **自動クリーン方針**：余剰フィールド/空項目は**決定論で自動除去**（Phase1 の sanitize と同ロジックを前段でも適用）。マスタ外の“余剰項目”は**除去せずフラグ**（Elith が使わない確証はマスタ次第のため、既定はレポート提示→管理者判断）。

---

## 6. 実装方針

- 検証本体 `src/lib/elith-necessity-check.ts`（純粋関数）:
  - `checkNecessity(json, { requiredItemsMaster?, sourceItemNames? }): NecessityReport`。
  - フィールド allowlist ＝ Phase1 の lean キー集合を**共通利用**（二重管理しない）。
- `elith-scan.ts`：`mode:"generate"` で bundle 生成 → **necessity-check 実行** → `{ preview, report }` を返す（**S3書出ししない**）。`mode:"commit"` で承認後に書出し（既存 preview 分岐を発展）。
- 既存 **Phase1(lean整形)/Phase3(妥当性ガード)は納品アセンブリ側の最終防御として残す**＝多層。本機能は**バッチ生成の前段**で早期に不要を検出・可視化する。

---

## 7. 管理画面（wellfort-site `admin/elith-batch.astro`）
- 画像アップ → [生成＋チェック] → **不要項目レポート表示**（余剰フィールド/項目・空/捏造・不足）＋ JSONプレビュー → [クリーンして書出し]/[却下]。
- deficient は既定却下。

---

## 8. 前提・確認点（実装前）
1. **必要項目マスタ（項目層）**：Elith が AI診断書生成に使う検査項目セットを **Elith 合意 or アウトプット逆引き**で確定（当社で捏造しない）。未確定の間はフィールド層＋空/捏造/重複のみ稼働。
2. **元データ照合の範囲**：捏造/不足の判定に画像/PDFの項目名参照が要る場合の実装（生成時の抽出項目名を利用）。
3. **自動クリーン vs フラグのみ**：余剰フィールド/空=自動除去、マスタ外項目=フラグ提示、の既定で良いか。
4. **エンベロープ余剰**：`source_image`/`finish_reason` 等は納品に残すか（監査扱いで除去するか）を要確認。

> 本書は仕様。変更時は本書と関連docを更新してから実装（CLAUDE.md 作業ルール）。
