# 検査データファイル・DB 基本設計

| 項目 | 内容 |
|---|---|
| 文書名 | 検査データファイル・DB 基本設計 |
| バージョン | 0.2 (Draft) |
| 作成日 | 2026-05-28 |
| 対象範囲 | 検査結果 PDF/CSV の取込・保管・正規化、ユーザー紐付け、DB スキーマ、ファイルストレージ階層 |
| 関連文書 | `wellfort_app_design_concept.md` §5 / `lab_integration_workflow.md` / `diagnostic_session_data_spec.md` §3 / `data_integration_requirements.md` |
| 参考 | `docs/kensa_sample/` (4 種の検査会社サンプル PDF) |

---

## 1. 文書範囲

本書は「検査結果データの**取込から DB 格納まで**の物理レイヤ」を規定する。

| 範囲 | 対象 |
|---|---|
| **範囲内** | PDF/CSV ファイル保管、LLM 変換戦略、DB テーブル、検査会社マスタ、検査 ID と顧客 ID の紐付けテーブル |
| **範囲外** | UI / ダッシュボード設計 (→ `wellfort_app_design_concept.md`)、ユーザー割当ワークフロー (→ `lab_integration_workflow.md`)、scan_md フォーマット詳細 (→ `diagnostic_session_data_spec.md` §3.2) |

---

## 2. データソースの分類

`wellfort_app_design_concept.md §5` の 3 ソースを再掲しつつ、本書での取扱いを明示:

### (a) ユーザー UP — 個人/会社で受けた検査

| 項目 | 内容 |
|---|---|
| 種別 | 人間ドック / 定期健康診断 / その他検査 (血液など) |
| フォーマット | **複数** (検査機関ごとに異なる) |
| ユーザー入手 | 紙 (主) / PDF (副) |
| 取込手段 | カメラ撮影 / PDF・画像アップロード (実装済) |
| 紐付け | アプリログイン中の `diagnostic_user_id` に直接 |

### (b) Wellfort 経由 — サブスク検査

| 項目 | 内容 |
|---|---|
| 種別 | 血液検査 / 遺伝子検査 / がんリスク検査 / AI 疾病予測 (Elith 以外) |
| フォーマット | **固定** (検査会社ごとに定型) |
| ユーザー入手 | PDF (主) / 紙 (副) |
| Wellfort 入手 | **検査会社ごとに異なる** (血液=CSV、その他=PDF) |
| 紐付け | サブスク注文時の `customer_id` ↔ 検査会社の `external_test_id` のマッピングで自動 |
| 頻度 | **最大 年 3 回 / ユーザー** (サブスク契約、年更新) |

### (c) Elith AI 診断結果

| 項目 | 内容 |
|---|---|
| 入力元 | (a) + (b) を Elith に送信した結果 |
| フォーマット | 構造化 JSON + Markdown (`diagnostic_session_data_spec.md §3.1`) |
| 紐付け | `diagnostic_user_id` で同一性確定 |
| 保管 | App-side `diagnosis_results` テーブル (既存) |

---

## 3. 入出力マトリクス (Google Sheet 由来)

`https://docs.google.com/spreadsheets/d/11Gq4lhRtlfJ5ZZzs3llfIq-6V48Mb8NDtvvem8zox9c/` のマトリクス本書に転記:

| 個人又は会社で受けたもの | フォーマット | ユーザー本人通知 (紙) | (PDF) | Wellfort 取得 (CSV) | (PDF) | Web 取込 (新規) | (過去分) | Web 表示 (新規) | (過去比較) | Elith 提供 |
|---|---|---|---|---|---|---|---|---|---|---|
| 人間ドック | 複数 | ◯ | △ | - | - | ◯ | ◯ | ◯ | ◯ | ◯ |
| 定期健康診断 | 複数 | ◯ | △ | - | - | ◯ | ◯ | ◯ | ◯ | ◯ |
| その他検査 (血液など) | 複数 | ◯ | △ | - | - | ◯ | ◯ | ◯ | ◯ | ◯ |

| Wellfort 経由で受けたもの | フォーマット | (紙) | (PDF) | (CSV) | (PDF) | (新規) | (過去分) | (新規) | (過去比較) | Elith |
|---|---|---|---|---|---|---|---|---|---|---|
| 血液検査 | 固定 | - | ◯ | **◯** | - | ◯ | ◯ | ◯ | ◯ | ◯ |
| 遺伝子検査 | 固定 | - | ◯ | - | **◯** | ◯ | ◯ | ◯ | ◯ | ◯ |
| がんリスク検査 (尿) | 固定 | - | ◯ | - | **◯** | ◯ | ◯ | ◯ | ◯ | ◯ |
| AI 疾病予測 (Elith 以外) | 固定 | - | ◯ | - | **◯** | ◯ | ◯ | ◯ | ◯ | ◯ |

| Elith AI 診断結果 | フォーマット | (紙) | (PDF) | (CSV) | (PDF) | (新規) | (過去分) | (新規) | (過去比較) | Elith |
|---|---|---|---|---|---|---|---|---|---|---|
| AI 診断レポート | - | - | - | - | - | **自動** | - | ◯ | ◯ | - |

**読み方の要点**:
- (b) のうち**血液検査だけが CSV 配信**、他 3 種は PDF 配信
- (b) 全てで「新規 + 過去分」両方を Web アプリで保持・比較表示する必要あり
- Elith 提供は全ソース ◯ (Elith 結果自身を除く)

---

## 4. 検査会社別の現状把握 (サンプル PDF 解析)

`docs/kensa_sample/` の 4 ファイルから抽出した実情:

### 4.1 血液検査 (Wellfort 経由)

| 項目 | 値 |
|---|---|
| 検査会社 | リージャーラボラトリー |
| 検査名 | メタボリックシンドローム＆生活習慣病セルフチェック |
| ファイル形式 | 1 ページ PDF (296 KB) + CSV |
| PII (PDF に印字) | 姓・名・姓カナ・名カナ・性別・生年月日 |
| 検査 ID | **PDF 上に明示なし** (CSV 側で連携想定) |
| 検査日 | 採血日 / 結果承認日 |
| 検査項目数 | 20 項目 + アンケート 14 項目 |
| 結果列 | 検査項目 / 測定値 / 判定 / 基準値 / 単位 |
| 特殊事項 | 末尾に**生活習慣アンケート** (yes/no) が付帯 |

### 4.2 がんリスク検査 (Wellfort 経由)

| 項目 | 値 |
|---|---|
| 検査会社 | PREVENT メディカル (株) |
| 検査名 | ALA-PDS (がんのリスクチェック) |
| ファイル形式 | 3 ページ PDF (794 KB) |
| PII | 氏名 / 生年月日 / 性別 |
| 検査 ID | **検査 ID: K1079** / **バーコード No: 702000889** (二重 ID) |
| 検査日 | 受付日 / 報告日 |
| 結果項目 | 尿中ポルフィリン量 / インデックス値 / リスクランク (A-D) |
| 特殊事項 | リスクランク説明図、検査概要 (機構説明) が付帯 |

### 4.3 遺伝子検査 (Wellfort 経由)

| 項目 | 値 |
|---|---|
| 検査会社 | **ジェノプランジャパン株式会社** (福岡市西区九大新町4-1) |
| 検査名 | Genoplan My Book |
| 検体 | 唾液 / 分析方法: SNP Genotyping |
| ファイル形式 | **207 ページ PDF** (8.7 MB) |
| PII | 顧客名 (p.2 アウトライン + 各ページ下部に印字) |
| 検査 ID | **認証キー / 固有検体番号** (例: `CBAD-DMID-BOAQ` — 英字 4 文字 × 3 ブロックをハイフン区切り、計 14 文字)。 p.2 アウトラインと p.207 保証書の**両方に印字** |
| 検査日 | 発行日 (p.2) |
| 検査回数 | **生涯 1 回のみ** (遺伝情報は不変) |
| 経年比較 | **不要** (1 回限り) |

#### PDF の実構造 (207 ページの内訳)

| ページ | セクション | 構造 | 抽出価値 |
|---|---|---|---|
| 1-2 | カバー + アウトライン (認証キー、顧客名、発行日) | フォーム | **メタ抽出必須** |
| 3-8 | サービス案内 / My Book の見方 | 説明文 | 不要 |
| **9-24** | **全体項目** (**472 項目** の分析結果サマリー表) | **構造化テーブル** | **機械抽出可能** |
| **25-33** | **主要項目** (**100 項目** = がん 25 + 一般疾患 40 + 体質 35) のサマリー表 | **構造化テーブル** | **機械抽出可能** |
| 34-199 | **各疾患の詳細ページ** (1 疾患 = 2 pg × 100 ≈ 166 pg) — テンプレ固定: 総合発症リスク (倍数)、80 歳までの%、年齢別予測グラフ、影響 SNP 数、危険要因、管理方法 | **構造化テンプレート** | 構造化抽出可能 |
| 200-204 | 用語辞典 (染色体・DNA・SNP 等) | 説明 | 不要 |
| 205-206 | FAQ | Q&A | 不要 |
| 207 | **分析結果保証書** (固有検体番号、検体種別、分析方法、QC 結果、検査責任者 3 名) | **フォーム** | **メタ抽出必須** |

#### 取込方針 (改訂)

要件定義書 v1.0 の「PDF 表示だけで OK」記述は、**サマリー機能を実装しない場合のフォールバック**として解釈。実態は構造化されており抽出可能なため、**§6.2 / §6.4 の 3 段階抽出 + 3 モード表示**を採用する。

### 4.4 AI 疾病予測 (Wellfort 経由 / Elith 以外)

| 項目 | 値 |
|---|---|
| 検査会社 | LAiF (AI で健康を見守る) |
| ファイル形式 | 9 ページ PDF (3.1 MB) |
| PII | 氏名 / 報告日 |
| 結果項目 | 4 カテゴリ × 計 18 疾患 (生活習慣病 / 循環器疾患 / 悪性腫瘍 / 神経疾患) |
| 各疾患 | 5 年発症率 / 10 年発症率 / 相対リスク比 / **昨年の相対リスク比** (経年比較あり) |
| 特殊事項 | 表で全疾患をカバー、過去比較列あり |

### 4.5 まとめ表

| 検査種別 | 検査会社 | ページ数 | 配信形式 | 検査 ID 名 | LLM 変換 | 表示モード | 原本保管 |
|---|---|---|---|---|---|---|---|
| 血液検査 | リージャーラボラトリー | 1 | **CSV** + PDF | (CSV キーで紐付け) | あり (CSV→md) | 単一 | 必須 |
| がんリスク | PREVENT メディカル | 3 | PDF | 検査 ID / バーコード No | あり (Gemini) | 単一 | 必須 |
| **遺伝子検査** | **ジェノプランジャパン** | **207** | PDF | **認証キー / 固有検体番号** | **あり (3 段階抽出)** | **3 モード** (a/b/c) | 必須 |
| AI 疾病予測 | LAiF | 9 | PDF | (TBD) | あり (Gemini) | **3 モード** (a/b/c) | 必須 |

---

## 5. (b) Wellfort 経由の運用フロー

### 5.1 ① 検査キット発送

```
[ユーザー] ─── EC サイトで検査キット申込 ──▶ [Wellfort EC]
                                                  │
                                                  ├── 注文確定 (order_id 発番)
                                                  ├── 顧客マスタ照合 (customer_id 確定)
                                                  ├── サブスク契約 (subscription_id)
                                                  ▼
                                          [タカセ倉庫]
                                                  │
                                                  ├── 検査キット出荷
                                                  ├── 出荷完了通知 ──▶ [Wellfort]
                                                  ▼
                                          { order_id, customer_id,
                                            shipped_at, tracking_no }
                                          を `kit_shipments` テーブルに記録
```

**確定情報**: 出荷時点で `order_id`、`customer_id` が確定。検査会社の `external_test_id` はまだ不明。

### 5.2 ② 検査完了通知 + 結果報告

```
[ユーザー] ─── 検体採取 → 返送 ──▶ [検査会社] (4 種別ごとに異なる)
                                          │
                                          ├── 分析
                                          ├── external_test_id を発番
                                          ├── 結果報告書を生成 (PDF or CSV)
                                          │
                          ┌────────────────┼────────────────┐
                          ▼                ▼                ▼
                  [ユーザー本人通知]  [Wellfort 通知]   [報告書送付]
                  PDF (or 紙)        CSV (血液のみ)     PDF (全種別)
                                    or PDF (それ以外)
```

**重要**: このタイミングで初めて `external_test_id ↔ customer_id` の紐付けが可能になる。<br>
詳細フロー: `lab_integration_workflow.md` Workflow 1/2/3

### 5.3 ③ サブスクの年更新サイクル

```
契約年 1: 検査 ① ─→ 検査 ② ─→ 検査 ③ (最大 年 3 回)
契約年 2: 検査 ④ ─→ 検査 ⑤ ─→ 検査 ⑥
...
```

- 同一 `customer_id` に対し**複数回**の検査結果が蓄積
- 各回は **`external_test_id` で区別** (検査会社が一意に発番)
- DB 設計では 1 顧客に N 件の lab_tests が紐付く構造

---

## 6. ファイル保管設計

### 6.1 PDF 原本は必ず保管 (削除不可)

理由:
1. **監査要件**: 医療情報安全管理ガイドラインで原本保管 10 年
2. **再変換**: LLM 変換のスキーマ進化時に再処理可能
3. **トレース**: scan_md の値と原本の突合 (改竄検知)
4. **クレーム対応**: ユーザーから「読取値が違う」と申立てがあった場合の証跡

### 6.2 LLM 変換戦略 (検査種別ごとに分岐)

| 検査種別 | LLM 変換 | scan_md 生成 | 理由 |
|---|---|---|---|
| 血液検査 (CSV 配信) | 不要 | CSV → md 直接変換 (Python script で OK) | CSV が既に構造化 |
| 血液検査 (PDF 経路) | **必要** | Gemini 2.5 Flash でテーブル抽出 | 検査会社が CSV 対応してない場合 |
| がんリスク検査 | **必要** | Gemini で値抽出 | 3 値のみだが PDF |
| 遺伝子検査 (207pg) | **必要** | **3 段階抽出** (§6.2.1 参照)。生成した a) サマリー / b) ハイライト は §6.4 の 3 モード表示で利用、c) 全編 PDF も保管 | 構造化されているが膨大。サマリー優先で UX を救う |
| AI 疾病予測 (9pg) | **必要** | Gemini でテーブル抽出 (18 疾患 × 4 列) + サマリー生成 | 構造的だが PDF。9pg は閾値ぎりぎりで 3 モード適用 |
| (a) ユーザー UP 全て | **必要** | 既存パイプライン (Gemini 2.5 Flash)。**5pg 以上**は 3 モード自動適用 | フォーマット可変 |

#### 6.2.1 遺伝子検査 — 3 段階抽出

ジェノプラン社の 207 pg PDF は構造が整理されているため、抽出を 3 段階に分けて Phase 別に深化:

| 抽出レベル | 対象ページ | 取得データ | 推定コスト/件 | 採用 Phase |
|---|---|---|---|---|
| **Lv1: メタのみ** | p.2 + p.207 | 認証キー、顧客名、発行日、検体、分析方法、QC、検査責任者 | ~$0.001 | Phase 1 から |
| **Lv2: サマリー抽出** (推奨) | + p.9-33 | 全体 472 項目 + 主要 100 項目のテーブル (項目名 / カテゴリ / リスク倍数 / 状態色 / 該当 PDF ページ番号) | ~$0.01 | **Phase 1 主軸** |
| Lv3: 完全抽出 | + p.34-199 | 各疾患詳細 (総合発症リスク、80歳までの%、年齢別予測、影響 SNP 数) | ~$0.05 | Phase 2 |

すべてのレベルで **PDF 原本 (c 全編) は別途必ず保管**。Lv2 取得時に各項目の PDF ページ番号を `test_artifact_items.pdf_page` に保存することで、§6.4 の deep-link が成立する。

### 6.3 ストレージ階層

`system_architecture_overview.md §1.2` の PII 物理分離原則を踏襲。

```
[顧客系ストレージ — Wellfort HP 配下 S3 / Supabase Storage]
s3://wellfort-customer/
└── lab_intake/                       # Wellfort が検査会社から受領した生 PDF
    └── lab_company={company_id}/
        └── date={YYYY-MM-DD}/
            └── intake_{intake_id}/   # PII を含む可能性あり
                ├── original.pdf      # SHA-256 改竄検知
                ├── original.csv      # 血液検査のみ
                └── meta.json         # 受領日時、検査ID、ファイル名等

[診断系ストレージ — App 配下 Supabase Storage]
s3://wellfort-diagnosis/
├── raw/                              # PII 除去済 PDF (原本に PII があれば redaction 後)
│   └── diagnostic_user={diagnostic_user_id}/
│       └── test_type={blood|genetics|cancer_urine|ai_prediction|health_checkup}/
│           └── lab_test={lab_test_id}/
│               ├── original.pdf      # PII redacted
│               └── meta.json
├── normalized/                       # scan_md (LLM 変換後)
│   └── diagnostic_user={diagnostic_user_id}/
│       └── date={YYYY-MM-DD}/
│           └── {test_type}_{lab_test_id}.md
└── audit/                            # 監査ログ
    └── lab_import/
        └── date={YYYY-MM-DD}/
            └── {audit_id}.json
```

**ポイント**:
- 顧客系ストレージは PII を含む生 PDF を保持 (Wellfort 担当者のみアクセス)
- 診断系ストレージへ移送時に**必ず PII redaction** + `diagnostic_user_id` 命名に切替
- 顧客系 → 診断系の橋渡し時点で `lab_integration_workflow.md` の Workflow 1/2/3 が走る

### 6.4 結果表示モード設計 (3 モード: サマリー / 要注意抜粋 / 全編)

#### 背景

207 ページの遺伝子検査 PDF を生のまま表示すると、`ai_app_ui_ux_proposal.pdf` 末尾の「スクロール地獄」アンチパターンに直撃する。一方、ユーザーは「LLM サマリーだけ」では信頼しきれない。**両者を両立**するため、長尺レポート用の **3 モード表示**を採用。

#### 3 モードの定義

| モード | 用途 | 生成方法 | デフォルト |
|---|---|---|---|
| **a) サマリー版** | LLM が総括して 1 画面で読める形に圧縮 | 取込時に **1 回 LLM 生成 + キャッシュ** | **◯ デフォルト + 「おすすめ」バッジ** |
| **b) 要注意事項抜粋版** | 高リスク + 行動可能な項目だけ抽出 | 取込時に LLM がフラグ付け | 切替可 |
| **c) 全編** | 原本 PDF をそのまま | 配信された原本 PDF | 詳細確認時 |

#### a/b/c の連動 (deep-link + back navigation)

```
[a) サマリー版]                    [c) 全編 PDF]
┌──────────────────────┐          ┌──────────────────┐
│ 大腸がん 4.47倍 高い  │  tap     │ p.38             │
│ → 詳細を見る (p.38) ─┼─────────▶│  大腸がん       │
│                      │          │  発症リスク...   │
│ 前立腺がん 4.53倍 高い│          │  [← 要約に戻る] │
│                      │ ◀────────┼──────────────────┘
└──────────────────────┘   back
```

- a) / b) の各項目に `pdf_page` (PDF 内のページ番号) を保持
- タップで c) を該当ページにスクロール (PDF embed の `#page=N` 機構を利用)
- c) 内の固定「← 要約に戻る」ボタンで a/b の元位置に復帰 (アプリ内 history stack + ブラウザ history.back() 併用)

#### b) 「要注意」の定義 (推奨案)

LLM が以下の **2 軸**で各項目を判定し、両方を満たすものを b) に抽出:

| 軸 | 判定 |
|---|---|
| **リスク軸** | 平均比リスク ≥ 1.5 倍 (or 4 色判定で赤・オレンジ) |
| **行動軸** | 生活習慣の改善で軽減できる項目 (`is_actionable: true`) |

→ 例:
- 大腸がん リスク 4.47 倍 + 食事改善で軽減可能 → **b に表示**
- アルツハイマー リスク 5 倍 + 行動で変えにくい → b には表示せず a) には "Watch" タグで掲載

(注: 「行動可能性」は LLM 判定。Phase 1 は固定リスト+ Phase 2 で運用ログから調整)

#### 適用範囲 (ページ数による自動判定)

| 検査 | ページ数 | 3 モード適用 |
|---|---|---|
| 血液 | 1 | ✕ (単一表示) |
| がんリスク | 3 | ✕ (単一表示) |
| AI 疾病予測 | 9 | **◯ 自動** |
| 遺伝子 | 207 | **◯ 自動** |
| 人間ドック (a 経由) | 可変 | **5pg 以上で自動 ON** |

→ ルール: **PDF/コンテンツが 5pg 以上で 3 モード自動適用**。閾値以下は単一表示。

#### LLM サマリー生成のハルシネーション抑止

医療コンテンツのため以下を必須:

1. **出典ページ番号を必ず併記** (a/b の各項目に `(p.38)` 等を表示)
2. 数値は**原本から逐語コピー** (LLM は自由文だけ生成、数値は引用のみ)
3. **「医師の診断に代わるものではない」フッタ**を a/b ともに常時表示
4. b) の「Watch / Action」ラベル分けで、コントロール可能性を明示

#### コスト試算 (遺伝子検査 1 件あたり)

| 工程 | トークン | コスト |
|---|---|---|
| Lv2 サマリー抽出入力 (PDF p.9-33) | ~30K | $0.009 (Gemini 2.5 Flash) |
| a) サマリー版生成 (出力) | ~3K | $0.008 |
| b) 要注意抽出 (出力) | ~1K | $0.003 |
| **計** | | **~$0.02 / 件 (約 3 円)** |

遺伝子検査は**生涯 1 回**なのでユーザー 1 人あたり**生涯 3 円**で完結。

---

## 7. DB スキーマ設計

### 7.1 全体マップ

`data_integration_requirements.md §2` の「2 Supabase 分離」を継承して新テーブルを配置:

```
┌─ HP-side Supabase #1 (顧客系・PII 含む) ─────────────────┐
│                                                          │
│  既存:                                                    │
│    customer_profiles (HP 既存)                            │
│      ├ user_id, 氏名, 住所, 生年月日, ...                 │
│      └ diagnosis_user_id (NEW カラム by v0.3)            │
│    orders (HP 既存)                                       │
│                                                          │
│  新規追加 (本書):                                          │
│    lab_companies        (検査会社マスタ)                   │
│    kit_shipments        (検査キット出荷台帳)               │
│    lab_tests            (検査ID ↔ customer_id 紐付け)    │
│    lab_intake_files     (検査会社から受領した原本ファイル)   │
│                                                          │
└──────────────────────────────────────────────────────────┘
                              │
                              │ diagnostic_user_id (匿名キー)
                              ▼
┌─ App-side Supabase #2 (診断系・PII なし) ────────────────┐
│                                                          │
│  既存:                                                    │
│    app_users (diagnostic_user_id)                        │
│    sessions / messages                                    │
│    scan_results (パイロット用、本書で再定義)               │
│    diagnosis_inputs / diagnosis_results                  │
│                                                          │
│  新規 / 再定義 (本書):                                     │
│    test_artifacts       (a/b 統一の検査成果物)             │
│    test_artifact_files  (scan_md / PDF redacted への参照) │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 7.2 顧客系テーブル (HP-side Supabase #1)

#### `lab_companies` — 検査会社マスタ

```sql
create table lab_companies (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,                    -- 例: "リージャーラボラトリー"
  test_types         text[] not null,                  -- ['blood', 'genetics', ...]
  delivery_format    text not null,                    -- 'csv' | 'pdf' | 'csv_and_pdf'
  external_id_label  text,                             -- 検査会社の "検査ID" 名 (例: "検査ID", "バーコードNo")
  notification_method text,                            -- 'sftp' | 'api' | 'email' | 'manual'
  contact_email      text,
  workflow_default   int not null default 2,           -- 1 | 2 | 3 (lab_integration_workflow.md)
  created_at         timestamptz not null default now()
);
```

初期データ例 (サンプル PDF から判明):

| name | test_types | delivery_format | external_id_label | workflow_default |
|---|---|---|---|---|
| リージャーラボラトリー | `['blood']` | `csv_and_pdf` | (なし、CSV キー連携) | 1 |
| PREVENT メディカル | `['cancer_urine']` | `pdf` | `検査ID / バーコードNo` | 2 |
| LAiF | `['ai_prediction']` | `pdf` | (TBD) | 2 or 3 |
| **ジェノプランジャパン** | `['genetics']` | `pdf` | **認証キー / 固有検体番号** (`^[A-Z]{4}-[A-Z]{4}-[A-Z]{4}$`) | 2 |

#### `kit_shipments` — 検査キット出荷台帳

```sql
create table kit_shipments (
  id              uuid primary key default gen_random_uuid(),
  order_id        text not null,                      -- EC サイトの注文 ID
  customer_id     uuid not null references customer_profiles(user_id),
  lab_company_id  uuid not null references lab_companies(id),
  test_type       text not null,                      -- 'blood' | 'genetics' | ...
  shipped_at      timestamptz not null,
  tracking_no     text,
  warehouse       text,                               -- "タカセ倉庫"
  subscription_id text,                               -- サブスク注文の場合
  subscription_year  int,                             -- 契約年 (1, 2, ...)
  subscription_seq   int,                             -- 年内の検査回数 (1〜3)
  created_at      timestamptz not null default now()
);
create index on kit_shipments(customer_id);
create index on kit_shipments(order_id);
```

> **進捗管理 (検査キット内容・配送予定日・受取/返送自己申告・検査会社受領・通知) のために、本テーブルには追加カラム + 関連テーブル (`subscription_plans` / `subscriptions` / `notifications`) が必要**。
> 詳細は `kit_progress_management.md §8` を参照 (本書では関心の分離のため進捗管理仕様は分離)。

#### `lab_tests` — 検査 ID ↔ 顧客 ID の紐付け (要のテーブル)

```sql
create table lab_tests (
  id                 uuid primary key default gen_random_uuid(),
  shipment_id        uuid references kit_shipments(id),     -- 出荷台帳との関連 (Workflow 2)
  customer_id        uuid not null references customer_profiles(user_id),
  diagnostic_user_id uuid not null,                          -- App 側との橋渡し
  lab_company_id     uuid not null references lab_companies(id),
  test_type          text not null,
  external_test_id   text,                                   -- 検査会社の検査 ID (例: K1079)
  external_barcode   text,                                   -- バーコード No (PREVENT 等)
  sampled_at         date,                                   -- 採血日 / 検体採取日
  reported_at        date,                                   -- 結果報告日
  status             text not null default 'pending',        -- pending|in_lab|reported|imported|failed
  workflow_used      int,                                    -- 1 | 2 | 3
  assigned_at        timestamptz,
  assigned_by        text,                                   -- 'auto_id' | 'auto_lookup' | 'manual:<user_id>'
  notes              text,
  created_at         timestamptz not null default now(),
  unique (lab_company_id, external_test_id)                  -- 検査会社内で一意
);
create index on lab_tests(customer_id);
create index on lab_tests(diagnostic_user_id);
create index on lab_tests(reported_at);
```

**ユーザー提案の「検査名、検査会社ID、検査ID、顧客ID、検査日」をすべて含み、加えて運用上必要な status / workflow / 監査列を追加**。

#### `lab_intake_files` — 検査会社から受領した原本

```sql
create table lab_intake_files (
  id              uuid primary key default gen_random_uuid(),
  lab_test_id     uuid references lab_tests(id),
  lab_company_id  uuid not null references lab_companies(id),
  file_kind       text not null,                       -- 'pdf' | 'csv' | 'xml'
  storage_url     text not null,                       -- s3://wellfort-customer/lab_intake/...
  sha256          text not null,                       -- 改竄検知
  size_bytes      bigint not null,
  received_at     timestamptz not null,
  received_via    text,                                -- 'sftp' | 'email' | 'manual_upload' | 'api'
  contains_pii    boolean not null default true,       -- 顧客系に置く前提
  redacted_url    text,                                -- PII 除去版 (診断系へ送る前に生成)
  redacted_sha256 text,
  redacted_at     timestamptz,
  created_at      timestamptz not null default now()
);
```

### 7.3 診断系テーブル (App-side Supabase #2)

#### `test_artifacts` — a/b 統一の検査成果物 (パイロット `scan_results` を再定義)

```sql
create table test_artifacts (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_user_id uuid not null references app_users(diagnostic_user_id),
  source             text not null,                   -- 'user_upload' | 'wellfort_lab'
  test_type          text not null,                   -- health_checkup|blood|genetics|cancer_urine|ai_prediction
  test_date          date,                            -- 検査日 (採血日 or 受付日)
  external_test_id   text,                            -- (b) 経由の場合のみ
  lab_name           text,                            -- 検査機関名 (PII ではない)
  schema_version     text not null default '1.0',
  age_at_test        int,                             -- 年齢のみ (生年月日は保存しない)
  sex                text,                            -- male | female | other
  display_mode       text not null default 'single',  -- 'single' | 'three_mode' (§6.4)
                                                      -- five_mode 適用: 5pg 以上で自動 three_mode
  page_count         int,                             -- 原本 PDF のページ数 (three_mode 判定用)
  imported_at        timestamptz not null default now(),
  imported_by        text not null,                   -- user | wellfort_batch | wellfort_manual
  status             text not null default 'active',  -- active | superseded | withdrawn
  notes              text,
  unique (diagnostic_user_id, source, test_type, test_date, external_test_id)
);
create index on test_artifacts(diagnostic_user_id, test_type, test_date desc);
```

#### `test_artifact_files` — 物理ファイルへの参照

```sql
create table test_artifact_files (
  id                 uuid primary key default gen_random_uuid(),
  test_artifact_id   uuid not null references test_artifacts(id) on delete cascade,
  file_kind          text not null,                   -- 'scan_md' | 'raw_pdf_redacted' | 'raw_csv'
                                                      -- | 'summary_md'    (§6.4 a)
                                                      -- | 'highlights_md' (§6.4 b)
                                                      -- | 'extracted_json' (Lv2/Lv3 抽出データ)
  storage_url        text not null,                   -- s3://wellfort-diagnosis/...
  sha256             text not null,
  size_bytes         bigint not null,
  llm_model          text,                            -- 生成モデル (例: 'gemini-2.5-flash')
  llm_generated_at   timestamptz,                     -- summary_md / highlights_md の場合
  created_at         timestamptz not null default now()
);
```

**設計のポイント**:
- 1 検査 = 1 `test_artifacts` 行 + 複数の `test_artifact_files` 行
- 3 モード適用検査では `file_kind` が `summary_md` / `highlights_md` / `raw_pdf_redacted` の 3 行が並ぶ
- 単一モードの検査は `scan_md` + `raw_pdf_redacted` の 2 行
- パイロットの `scan_results` は `test_artifacts` + `file_kind='scan_md'` で表現可能 → **互換マイグレーション可**

#### `test_artifact_items` — a/b の項目データ + c) への deep-link (§6.4 新規)

3 モード表示の根幹。a) サマリー / b) 要注意 で表示する個々の「項目」を行として保持し、各行に PDF 全編ページ番号 (deep-link 先) を持たせる。

```sql
create table test_artifact_items (
  id                  uuid primary key default gen_random_uuid(),
  test_artifact_id    uuid not null references test_artifacts(id) on delete cascade,
  category            text,           -- 'がん > 消化器' / '一般疾患 > 代謝疾患' / '体質' 等
  item_name           text not null,  -- '大腸がん' / 'アルツハイマー病' / 'HbA1c' 等
  risk_value          text,           -- 原本逐語コピー (例: '4.47倍' / '8.4 mg/dL H')
  risk_multiplier     numeric,        -- 数値化 (例: 4.47)
  risk_level          text,           -- 'high' | 'slightly_high' | 'normal' | 'slightly_low' | 'low'
  is_actionable       boolean,        -- §6.4 b) の Action / Watch 判定
  pdf_page            int,            -- deep-link target → c) 全編の該当ページ
  summary_line        text,           -- a) で表示する 1-2 行コメント (LLM 生成)
  order_in_summary    int,            -- a) サマリー版での表示順
  order_in_highlights int,            -- b) 要注意抜粋版での表示順 (null なら b には出ない)
  source_md_anchor    text,           -- scan_md / summary_md 内のアンカー
  created_at          timestamptz not null default now()
);
create index on test_artifact_items(test_artifact_id, order_in_summary);
create index on test_artifact_items(test_artifact_id, order_in_highlights);
create index on test_artifact_items(test_artifact_id, risk_level);
```

**運用**:
- 取込時に LLM が `extracted_json` を生成し、その内容を `test_artifact_items` に行展開
- a) で表示する項目: `order_in_summary IS NOT NULL` で order 順
- b) で表示する項目: `order_in_highlights IS NOT NULL AND is_actionable = true AND risk_level IN ('high','slightly_high')` で order 順
- 「タップで全編 p.X に飛ぶ」は `pdf_page` を使う
- 遺伝子検査 1 件 = 472 + 100 = **約 572 行** (全体項目 + 主要項目)。Lv3 完全抽出時はさらに増える

### 7.4 ER 図

```
┌────────────── 顧客系 (HP Supabase #1) ──────────────┐
│                                                     │
│ customer_profiles ◀────┐                            │
│   - user_id (PK)        │                           │
│   - 氏名, 住所, 生年月日                              │
│   - diagnosis_user_id ──┼──┐                       │
│                          │  │ (匿名キー)             │
│ orders ─────────────────┤  │                       │
│                          │  │                       │
│ kit_shipments ──────────┤  │                       │
│   - order_id (FK)        │  │                       │
│   - customer_id (FK) ────┘  │                       │
│   - lab_company_id ────┐   │                       │
│                         │   │                       │
│ lab_companies ◀─────────┤   │                       │
│   - id (PK)             │   │                       │
│   - name, formats       │   │                       │
│                         │   │                       │
│ lab_tests ◀─────────────┘   │                       │
│   - shipment_id (FK)        │                       │
│   - customer_id (FK)        │                       │
│   - lab_company_id (FK)     │                       │
│   - external_test_id        │                       │
│   - diagnostic_user_id ─────┼──┐                   │
│                              │  │                   │
│ lab_intake_files ───────────┘  │                   │
│   - lab_test_id (FK)            │                   │
│   - storage_url (PII 含む PDF)   │                   │
│                                 │                   │
└─────────────────────────────────┼───────────────────┘
                                  │ diagnostic_user_id
                                  ▼
┌────────── 診断系 (App Supabase #2) ─────────────────┐
│                                                     │
│ app_users ◀───────────┐                             │
│   - diagnostic_user_id │                            │
│                         │                           │
│ test_artifacts ◀───────┤                            │
│   - diagnostic_user_id │ (FK)                       │
│   - source              │                           │
│   - test_type           │                           │
│   - external_test_id    │ ← lab_tests と同値で照合 │
│   - display_mode        │ single | three_mode       │
│   - page_count          │                           │
│                                                     │
│ test_artifact_files ──┐                             │
│   - test_artifact_id  │ (FK)                        │
│   - file_kind         │ scan_md / summary_md /     │
│   - storage_url       │ highlights_md / raw_pdf /  │
│   - llm_model         │ extracted_json             │
│                                                     │
│ test_artifact_items ──┐  (§6.4 NEW)                 │
│   - test_artifact_id  │ (FK)                        │
│   - item_name          │ 大腸がん / HbA1c 等        │
│   - risk_value          │ 4.47倍 / 8.4 mg/dL H      │
│   - risk_level          │ high / slightly_high...   │
│   - is_actionable       │ b 抽出フラグ              │
│   - pdf_page            │ → c 全編への deep-link    │
│   - order_in_summary    │                           │
│   - order_in_highlights │                           │
│                                                     │
│ diagnosis_inputs / diagnosis_results (既存)          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 8. データフロー詳細

### 8.1 (b) Wellfort 経由フロー

```
1. EC 注文
   orders に行追加 → customer_id 確定

2. 出荷
   kit_shipments INSERT
   { shipment_id, order_id, customer_id, lab_company_id, test_type, shipped_at }

3. 検体採取・返送・検査機関分析
   (Wellfort 側システムでの処理なし)

4. 検査結果受領 (検査会社 → Wellfort)
   a. ファイル受領 (SFTP / Email / API / 手動 UL)
   b. lab_intake_files INSERT (顧客系ストレージへ保存、PII あり)

5. ユーザー紐付け (lab_integration_workflow.md の Workflow を実行)
   Workflow 2 例:
     - PDF から external_test_id を OCR
     - kit_shipments と照合 (lab_company_id × external_test_id × test_date)
     - 一致 → customer_id 取得
     - app_users から diagnostic_user_id 解決
     - lab_tests INSERT (確定)

6. PII Redaction
   - lab_intake_files.storage_url の PDF をコピー
   - 氏名・住所・生年月日 (の月日) を黒塗り
   - lab_intake_files.redacted_url に書込

7. LLM 変換 (test_type ごとに分岐)
   - blood (CSV): Python で CSV → scan_md
   - blood/cancer/ai_prediction (PDF): Gemini 2.5 Flash で scan_md
   - genetics: 変換スキップ、PDF のまま

8. 診断系へ書き出し
   - redacted PDF → s3://wellfort-diagnosis/raw/diagnostic_user_id/...
   - scan_md → s3://wellfort-diagnosis/normalized/diagnostic_user_id/...
   - test_artifacts INSERT
   - test_artifact_files INSERT (file_kind ごとに 1 行)

9. Elith 通知 (バッチ)
   - diagnosis_inputs にペイロード保存
   - Elith AI バッチに渡す (data_integration_requirements.md EF-5)
```

### 8.2 (a) ユーザー UP フロー (既存パイロットの拡張)

```
1. ユーザーが Web アプリで撮影 / UL
   (実装済: /scan + camera-scan.ts + /api/scan)

2. /api/scan が Gemini に投げて Markdown 生成
   (実装済)

3. ユーザーがセル単位で検証 (scan_feature_requirements.md §5)
   (実装済)

4. 確定 scan_md を診断系ストレージへ書込
   - s3://wellfort-diagnosis/raw/diagnostic_user_id/ に原本画像
   - s3://wellfort-diagnosis/normalized/diagnostic_user_id/ に scan_md
   - test_artifacts INSERT (source='user_upload', external_test_id=NULL)
   - test_artifact_files INSERT
```

---

## 9. 検査会社別の連携プロトコル (現時点)

| 検査会社 | 配信形式 | 配信手段 (推測) | Workflow 1 対応 | 現状 Workflow |
|---|---|---|---|---|
| リージャーラボラトリー (血液) | CSV + PDF | TBD (SFTP?) | 対応打診 | **Workflow 2** (CSV キーで紐付け) |
| PREVENT メディカル (がんリスク) | PDF | 郵送 + メール? | 要相談 | Workflow 2 (検査ID OCR) |
| **ジェノプランジャパン (遺伝子)** | PDF (207pg) | TBD | 要相談 | Workflow 2 (認証キー OCR、p.2/p.207 から抽出) |
| LAiF (AI 疾病予測) | PDF | TBD | 要相談 | Workflow 2 (検査ID OCR) |

→ Phase 1 移行時に各検査会社と**配信プロトコル契約**を結ぶ必要あり (`lab_integration_workflow.md §5` 実装ロードマップ参照)

---

## 10. 段階的構築計画

### Phase 0 (パイロット — 現在)
- (a) のみ実装。`test_artifacts` 相当は localStorage で代替
- DB なし

### Phase 1 (本格運用初期)
- [ ] HP-side Supabase に `lab_companies` / `kit_shipments` / `lab_tests` / `lab_intake_files` を作成
- [ ] App-side Supabase に `test_artifacts` / `test_artifact_files` を作成 (旧 `scan_results` を吸収)
- [ ] PII redaction バッチ (顧客系 → 診断系)
- [ ] CSV → scan_md 変換スクリプト (血液検査)
- [ ] PDF → scan_md 変換 Edge Function (がんリスク・AI 予測)
- [ ] 遺伝子検査は PDF 表示のみ実装
- [ ] Workflow 2 を主軸に運用開始

### Phase 2 (スケール)
- [ ] AWS S3 へ移行 (顧客系/診断系の 2 バケット)
- [ ] 検査会社との Workflow 1 移行 (バーコード/QR or webhook 連携)
- [ ] Document AI Custom Extractor の段階導入 (上位 5 形式)
- [ ] 過去比較ダッシュボード (AI 疾病予測の「昨年の相対リスク比」のような経年機能)

---

## 11. 未確定事項 (TBD)

- [ ] 検査会社からの配信プロトコル: SFTP / メール添付 / API webhook / 手動 UL のどれを主とするか
- [ ] CSV のスキーマ確定 (血液検査・リージャーラボラトリー版)
- [ ] LAiF の検査 ID 体系
- [ ] PII redaction の実装 (PyMuPDF / pdf-redact-tool / 自前 Gemini プロンプト)
- [ ] 検査結果の改訂・再発行への対応 (同 external_test_id で新版が来た場合の supersede ロジック)
- [ ] 検査キャンセル・返金時のデータ削除ポリシー
- [ ] `scan_results` (パイロット) → `test_artifacts` (本設計) のマイグレーション手順
- [ ] サブスク終了時のデータ取扱 (個情法上の請求権、エクスポート機能)
- [ ] **3 モード適用閾値の最終決定**: 「5pg 以上」は仮置き。テスト実装後に再評価
- [ ] **b) 要注意事項の定義**: 案 D (リスク≥1.5 倍 + actionable) は推奨。テスト実装後に閾値・抽出ロジックを再評価
- [ ] **遺伝子検査 抽出レベル選択**: Lv2 (サマリー) を Phase 1 主軸の推奨。Lv3 (完全抽出) を Phase 2 に持ち越すか、それとも Lv2 で十分か、運用ログから判断
- [ ] **LLM サマリー の医療レビュー要否**: ハルシネーション抑止策 (出典ページ・逐語数値) は技術側で実装するが、最終公開前に医療従事者レビューを介すべきか
- [ ] **PDF embed の deep-link** (`#page=N`) のブラウザ互換性確認 (Safari / iOS / Android Chrome / モバイル WebView)
- [ ] **「← 要約に戻る」ナビゲーション**の実装方式 (アプリ内 history stack vs URL hash)
- [ ] **遺伝子検査 472 個 vs 100 個**: Elith 提供データはどちらをメインにするか (現状は両方を `test_artifact_items` に持つ案)

---

## 12. 変更履歴

| Ver | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-28 | 初版。Google Sheet マトリクス、サンプル PDF 4 種の実態を踏まえて、ファイルストレージ階層 (顧客系/診断系の物理分離) と DB スキーマ (lab_companies / kit_shipments / lab_tests / lab_intake_files / test_artifacts / test_artifact_files) を規定 |
| 0.2 | 2026-05-28 | 遺伝子検査 207pg の全構造を検証 → §4.3 を実態反映 (検査会社=ジェノプランジャパン、認証キー=CBAD-DMID-BOAQ 形式)。§6.2 LLM 変換戦略を改訂し**3 段階抽出** (Lv1 メタ / Lv2 サマリー (推奨) / Lv3 完全) を導入。新規 §6.4 **結果表示モード設計 (a サマリー / b 要注意 / c 全編 + deep-link + 戻る)** を追加。`test_artifacts` に `display_mode` / `page_count` カラム追加、`test_artifact_files` の `file_kind` enum に `summary_md` / `highlights_md` / `extracted_json` を追加、`test_artifact_items` テーブルを新設 (a/b の項目 + pdf_page による deep-link)。§7.4 ER 図と §9 連携プロトコル、§11 TBD も更新 |
