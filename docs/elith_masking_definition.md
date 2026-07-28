# Wellfort → Elith 納品データ マスキング定義書

| 項目 | 内容 |
|---|---|
| 対象 | Wellfort が S3 で Elith に受け渡す全 format（`elith-handoff-v0.1`） |
| 版 | 2026-07-28 |
| 定義の要旨 | **「マスキング」= ①個人情報(PII)を最初から含めない ＋ ②版面・内部メタ情報を除去。検査値そのものは伏字化しない。** |

> 用語補足：本納品での「マスキング」は、値の一部を `***` 等で伏せる処理ではありません。
> **PII を構造的に非同梱**にし、**版面座標・内部メタ・監査専用列を除去**することを指します。
> 個人の特定は `client_id`（= 仮名 `diagnostic_user_id`）でのみ可能で、氏名等の直接識別子は一切載せません。

---

## A. 常に「含めない」もの（PII・直接識別子）

| 区分 | 具体項目 | 納品データでの扱い |
|---|---|---|
| 氏名 | 姓・名・カナ | **キーごと非同梱**（出力しない） |
| 住所・連絡先 | 住所・電話・メール | **非同梱** |
| 生年月日 | DOB | **非同梱**。代わりに `subject.age`（検査時点の満年齢, 整数）のみ |
| その他PII | 顧客番号・保険証番号等 | **非同梱** |
| 識別子 | 個人の識別 | `client_id` = **仮名 `diagnostic_user_id`**（PII非該当）でのみ表現 |

- `subject` は **`{ sex, age }` のみ**。`sex ∈ {male, female, other, null}`、`age` は整数 or null。
- 血液検査CSVは、**元CSVの段階でPII列を削除**済み → `subject` は原則 `null`。

## B. 納品物から「除去」するもの（版面・内部メタ）

| 対象 | 説明 | 根拠 |
|---|---|---|
| `bbox` / 版面座標 | OCRの版面座標 | `sanitizeDelivery`（elith-assemble.ts）/ spec §7.1 |
| `regions[]` / `region` | スキャンの版面見出し（器と各要素） | 同上 |
| `category`（**検査値型のみ**） | 検診・がん・血液の区分/項目区分 | 同上（Elith 要望） |
| 監査専用列 | `No` / `推論値` 等 | spec §7.1 |
| `raw_markdown` 内 `<!-- bbox: … -->` | Markdown原本のbboxコメント | `sanitizeDelivery` |
| 血液CSVの区分3ブロック | 判定コード行（値の羅列） | spec §7.1（区分3は納品しない。判定は §C の `assessment` として値へ付与） |

## C. 「除去しない／保持する」もの（＝マスキング対象外）

- 検査値：`value` / `value_num` / `unit` / `ref_low` / `ref_high` / `flag` / `note`（**値は書き換えない**）。
- 遺伝子検査 `items[]` の `category`（**遺伝子のみ意味を持つため保持**。検査値型の区分除去とは別扱い）。
- 血液の判定コード（F1 等）は、対応する検査値項目の **`assessment`** として保持（区分3ブロック自体は非同梱）。
- 問診 `answers[]`（設問・回答・ラベル）。※問診内容は本人の生活習慣回答であり PII（氏名等）は含まれない。

---

## D. まとめ（1行）

> **PII（氏名・住所・生年月日）は構造的に非同梱** ／ **版面座標・見出し・検査値型の区分・監査列は除去** ／
> **検査値・判定・問診回答は保持（伏字化しない）** ／ 個人特定は **仮名 `client_id` のみ**。

## E. 参照
- 確定スキーマ：`elith_handoff.schema.json`
- 受け渡し仕様：`elith_s3_data_handoff_spec.md`（§6 共通エンベロープ / §7 format別 / §7.3.1 マスキング）
- 実装：`src/lib/elith-assemble.ts`（`sanitizeDelivery`）／`src/lib/elith-export.ts`／`src/lib/interview-export.ts`
