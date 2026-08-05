# スキャン回帰用ゴールデン（がんリスク検査 ALA-PDS / 報告日 2025-12-26）

**format_id: `CancerRiskAssessmentData`**。検査機関=プリベントメディカル（1社）・様式=ALA-PDS 1つ。
🎯値golden は **元PDF `2026_0105…ALA_PDS_.pdf` page2 の印字値**から人手確定（R2/R3・スキャン出力を正解にしない）。

- 検体: `scan-accuracy-test/user/test-…/date/2025_12_26/CancerRiskAssessmentData_date_2025_12_26_user_….json`
- 取得: **Wellfort が検査機関から手動取得 → admin バッチ（`/api/admin/elith-scan`・単画像）** で処理（`docs/elith/elith_batch_centralization_design.md`）。
- 照合: 🎯値golden（決定論）＋ 🔍画像照合（LLM）。1様式なので `selectGolden` は format_id で分岐（検体別スイッチ不要）。

## 納品対象（測定値・3項目）
| 項目 | 今回値(正解) | 単位 | メモ |
|---|---|---|---|
| 尿中ポルフィリン量 | **972** | nmol/g・CRE | 尿中の 5-ALA 代謝物ポルフィリン量。「尿中のポルフィリン量」表記も可 |
| インデックス値 | **0.8** | —（0〜8） | ポルフィリン量から独自算出。PDFは「0.8 / 8.0」表記（0.8） |
| リスクランク | **A** | 定性 | A/B/C/D。0.8<2.0 → A。定性項目 |

## 納品対象外（PII/メタ・納品したら誤り）
- **患者情報**: 検査ID K1020 / 生年月日 1960.06.14 / 氏名 新藤幹雄 / 性別 男性 / 受付日 2025.12.17 / 報告日 2025.12.26。
  → **PII 分離**（氏名/生年月日を診断系/S3 に載せない・`docs/architecture/data_integration_requirements.md §1.3`）。measurement でない → 除外が正。
  スキャンがこれらを measurement 化していたら **捏造/余剰**（🔍/necessity で可視化）。
- リスクランクの目安表（A: <2.0 / B: 2.0〜4.9 / C: 5.0〜6.9 / D: 7.0以上）・検査概要・注意事項 = 説明文（非測定値）。

## 照合器配列（wellfort-site `elith-batch.astro` `GOLDEN_CANCER_ALAPDS`・実装済）
```js
var GOLDEN_CANCER_ALAPDS = [
  { name: '尿中ポルフィリン量', today: '972', alt: ['尿中のポルフィリン量','ポルフィリン量','尿中ポルフィリン','ポルフィリン'] },
  { name: 'インデックス値', today: '0.8', alt: ['インデックス','インデックス値(0-8)','index'] },
  { name: 'リスクランク', today: 'A', q: 1, alt: ['リスク判定','がんリスクランク','リスク','ランク','リスクレベル'] },
];
```

## メモ
- **スキャン rows=2 の実測（test-202608040333）**: 3値中2つを取得 → 1つ漏れの可能性を 🎯 が Missing で示す。
  どれが取れているか（納品JSON）を見て、名称ゆれなら alt 追加、真の漏れなら主パス/necessity で対処。
- 値の桁: インデックス値=0.8（PDF「0.8 / 8.0」の左）。ポルフィリン量=972（nmol/g・CRE）。
- 定性 `リスクランク=A` は 🎯 の定性一致で別集計（numeric と分離）。
