# 診断セッション データ仕様書

| 項目 | 内容 |
|---|---|
| 文書名 | Scan-Chat Medical AI — 診断セッション データ仕様書 |
| バージョン | 0.2 (Draft) |
| 作成日 | 2026-05-23 (v0.1) / 2026-05-28 (v0.2) |
| 対象 | 1 回の診断で生まれる成果物（scan / 問診 / AI 診断）のデータ構造・保存先・連携仕様 |
| 関連文書 | `docs/architecture/data_integration_requirements.md`（ユーザー単位の ID/ 認証連携）/ `docs/lab/lab_integration_workflow.md` (検査機関連携) |

> 本書は **「1 回の検査・診断セッション」単位**で生まれる成果物の取り回しを定義します。
> 「ユーザー単位の認証・ID マッピング」は `docs/architecture/data_integration_requirements.md` を参照のこと。

---

## 1. スコープと前提

### 1.1 ユーザーフロー

```
1. ユーザーが HP/EC マイページで「検査を申し込む」
2. 検査キット発送・受領・採取・返送
3. 検査機関が紙の検査結果報告書を発行
4. ユーザーがマイページから「結果をスキャン」→ Scan-Chat-AI へ
5. 検査表をスマホで撮影 → Markdown に転記
6. 必要に応じて音声問診（Live API）
7. 全データを下流の AI 診断システムへ渡し、診断結果を生成
8. マイページで診断結果を閲覧、進捗管理
```

### 1.2 設計原則

| 原則 | 内容 |
|---|---|
| **PII 分離** | 顧客個人情報を持つ系統と診断データを持つ系統を物理的に分離する。診断系は氏名・メール等を一切持たない |
| **Pseudonymization** | 診断系では `diagnostic_id`（UUID）のみで個人を識別する |
| **段階的永続化** | パイロット中は端末保存、検証後に Supabase、本番で AWS と段階的に上げる |
| **スキーマ進化耐性** | 診断 AI の出力は将来変わるため、JSONB ハイブリッド設計とする |
| **Markdown ファースト** | 各成果物は LLM 処理に最適化した Markdown で保持する。JSON 変換は必要時のみ |

---

## 2. ID 体系

### 2.1 4 つの ID の関係

| ID | 発番者 | 紐づく単位 | 何系統に置くか |
|---|---|---|---|
| `customer_id` | HP/EC 既存システム | **1 ユーザー（自然人）= 1 customer** | 顧客系 Supabase |
| `diagnosis_user_id` | App 側 Supabase（既存設計） | **1 ユーザー = 1 diagnosis_user** | 診断系 Supabase |
| `diagnostic_id` | **Scan-Chat-AI** | **1 回の検査・診断セッション** | 診断系 Supabase（および橋渡しの link テーブル） |
| `artifact_id` | 診断系 Supabase | **1 つの成果物（scan, image, 問診 等）** | 診断系 Supabase |

```
customer_id (1) ─── (n) diagnosis_user_id [このユーザーの認証実体]
                          │
                          └─ (n) diagnostic_id [1回の検査セッション]
                                    │
                                    └─ (n) artifact_id [scan_md / image / 問診md / 診断結果]
```

通常は `customer_id : diagnosis_user_id = 1 : 1`、`diagnosis_user_id : diagnostic_id = 1 : n`（同一ユーザーが複数回検査する）、`diagnostic_id : artifact_id = 1 : n`（1 セッションに複数成果物）。

### 2.2 `diagnostic_id` の発番

- **発番者**: Scan-Chat-AI クライアント（`crypto.randomUUID()` v4）
- **発番タイミング**: 撮影開始（`/scan` の最初の `📷 撮影 & 解析`）または明示的に新セッション開始時
- **永続化**: クライアント localStorage → 後段で Supabase / API 同期
- **形式**: 標準 UUID v4 （例: `6f2c1a9b-1234-4abc-9def-d3a3aa30c777`）

#### 将来：マイページ側で発番に切り替える場合

```
マイページが「新規検査セッション開始」をトリガで diagnostic_id 発番
  → URL パラメータで Scan-Chat-AI に引き渡し
  → Scan-Chat-AI はクライアント側で受領、独自発番はしない
```

これにより `customer_diagnostic_link` の登録漏れを防ぐ。マイページからの導線が整った段階で切り替える。

---

## 3. 成果物（Artifacts）

### 3.1 1 セッションで発生する成果物

| 種別 | 中身 | 形式 | 主たる消費先 |
|---|---|---|---|
| `scan_md` | 検査表を AI が転記した構造化 Markdown | text/markdown | 診断 AI / ユーザー閲覧 |
| `scan_image` | 撮影元画像（証跡） | image/jpeg | ユーザー閲覧 / 監査 |
| `interrogation_md` | 音声/テキスト問診の会話ログ | text/markdown | 診断 AI / ユーザー閲覧 |
| `diagnostic_result` | 下流 AI が生成した診断結果 | JSONB + Markdown 併存 | ユーザー閲覧 |

複数の検査表を 1 セッションに紐付ける場合は、`scan_md` / `scan_image` が複数個並ぶ（タイムスタンプで区別）。

### 3.2 `scan_md` のフォーマット

`scan_md` は **ユーザー検証フェーズを通過した「確定 Markdown」** を指す。Gemini が生成した raw 出力は Scan-Chat-AI の `/api/scan` レスポンスに含まれるが、これは**そのまま永続化されない**。ユーザーが **セル単位で確認・編集** した後の Markdown のみが Supabase #2 / S3 に書き込まれ、Elith 診断 AI に渡される。

#### 統一フォーマット — YAML front-matter + Markdown 本体

`scan_md` は **入力ソース (a/b 共通)** で同一の構造を持つ。冒頭に YAML front-matter で**メタデータ**を、続けて検査種別ごとの**標準 Markdown 本体**を置く。

```markdown
---
diagnostic_user_id: 7b3f8c2d-9e4a-4b1c-...   # 必須 / 内部識別子 (PII ではない)
source: wellfort_lab                           # 必須 / user_upload | wellfort_lab
test_type: blood                               # 必須 / health_checkup | blood | genetics | cancer_urine | ai_prediction
test_date: 2026-05-15                          # 必須 / 検査日 (YYYY-MM-DD)
external_test_id: WF-2026-XYZ-001              # 任意 / 検査機関の検査 ID (トレース用)
lab_name: タカセクリニック検査センター            # 任意 / 検査機関名
schema_version: 1.0                            # 必須
imported_at: 2026-05-28T10:00:00+09:00         # 必須 / 取込タイムスタンプ
imported_by: wellfort_batch                    # 必須 / user | wellfort_batch | wellfort_manual
age_at_test: 45                                # 任意 / 生年月日から年齢のみ抽出して保存
sex: male                                      # 任意 / male | female | other
---

## 左側検査表
<!-- bbox: 0.05,0.05,0.95,0.65 -->

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1  | AST      | AST(GOT)     | 18           | U/L  | 13     | 30     | -    | -    |
```

front-matter のキー (PII 取扱を含む):

| key | 必須 | 型 | 用途 | PII? |
|---|---|---|---|---|
| `diagnostic_user_id` | ◯ | uuid | 内部識別子 (両系統の橋渡し) | 匿名 |
| `source` | ◯ | enum | `user_upload` / `wellfort_lab` | - |
| `test_type` | ◯ | enum | 後述の検査種別 | - |
| `test_date` | ◯ | date | 検査日 (時系列分析用) | - |
| `external_test_id` | - | string | 検査機関の検査 ID | - |
| `lab_name` | - | string | 検査機関名 (問合せ用) | - |
| `schema_version` | ◯ | string | スキーマ進化への追従 | - |
| `imported_at` | ◯ | datetime | 取込日時 | - |
| `imported_by` | ◯ | enum | `user` / `wellfort_batch` / `wellfort_manual` | - |
| `age_at_test` | - | int | **年齢のみ** (生年月日は保存禁止) | - |
| `sex` | - | enum | 性別 (診断に必要) | - |
| **氏名・生年月日・住所** | ✕ **保存禁止** | - | front-matter にも本体にも入れない | **PII** |

#### `source: user_upload` のユーザー検証フェーズ

ユーザーが本アプリで撮影・アップロードした場合は、Gemini 生出力をそのまま永続化せず、UI で**セル単位の人間確認**を経てから確定 `scan_md` を書き出す。UX 仕様は `docs/scan/scan_feature_requirements.md` §5 を参照。要点:

- 表全体のトリミング画像 + 領域 bbox オーバーレイをハブ画面とする
- ブロックをタップすると 9 列テーブルを展開、**セル単位**で着色 (黄=要確認 / 緑=確認済 or 元から OK)
- 疑念セルをタップするとモーダルで該当行の全セルを入力フィールドとして表示
- 各疑念セルは「直接修正」または「このまま OK」で個別に解消できる
- 行内の疑念セル**全て**が解消されたら行が緑になり、全行緑で「✓ 確認して送信」が活性化

#### `source: wellfort_lab` の取込フェーズ

Wellfort 側が代理アップロードする場合 (固定フォーマットの 血液・遺伝子・がんリスク・AI予測 等) は、本アプリのユーザー検証 UI は介在しない。代わりに、Wellfort 側のバッチパイプラインで以下を実施:

1. **ユーザー割当** — `diagnostic_user_id` を検査機関から取得 or 検査ID で逆引き (詳細: `docs/lab/lab_integration_workflow.md`)
2. **PII 除去** — front-matter の `age_at_test` / `sex` のみ抽出、氏名・生年月日・住所は破棄
3. **スキーマ正規化** — 検査種別ごとの標準 Markdown 本体に整形 (§3.6)

#### Gemini 生出力 (中間データ、永続化されない)

監査官モードで 10 列構成を出力する。最後の 2 列のうち `推論値` は Gemini の自己チェック専用で、後段で除去される。

| 列 | 内容 |
|---|---|
| No | 紙面の連番 |
| 検査項目 | 略号 (AST, Hgb 等) |
| 検査項目詳細 | 日本語名称 (ヘモグロビン量 等) |
| 読み取った値 | 紙面の文字通り (例: `8.1 L`, `(?)`) |
| **推論値** | **Gemini の医学知識による参考値 (内部のみ)** |
| 単位 | 紙面通り |
| 下限値 | 紙面通り |
| 上限値 | 紙面通り |
| 判定 | 範囲外なら H/L、範囲内なら `-` |
| 備考 | 不整合検出時 `【要確認】理由`、無ければ `-` |

#### 確定 `scan_md` (Supabase / Elith 入力フォーマット)

クライアント側で **`推論値` 列のみを除去**した 9 列構成。これが `scan_artifacts.content` に入る。

```markdown
## 左側検査表
<!-- bbox: 0.05,0.05,0.95,0.65 -->

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1  | AST      | AST(GOT)     | 18           | U/L  | 13     | 30     | -    | -    |
| 6  | Cholin-E | コリンエステラーゼ | 1.22   | U/L  | 240    | 486    | L    | 【要確認】読取値 1.22 が #15 Creatini と同一値、隣接行混線の可能性 |
| 23 | Hgb      | ヘモグロビン量 | 8.1 L      | g/dl | 13.7   | 16.8   | L    | -    |
| 38 | CA19-9   | CA19-9       | 4048.7 H     | U/ml | 0.0    | 37.0   | H    | -    |

## 右側手書きメモ
<!-- bbox: 0.50,0.20,0.95,0.85 -->

- 古富先生
- CA19-9 (腫瘍マーカー) 前回 4981 → 今回 4048 = -933 改善
- ヘモグロビン 0.7 (-)
- 白血球 改善
```

#### フォーマット規約

- 領域は H2 (`## ラベル`) で開始、最大 4 領域
- 領域 bbox は HTML コメント `<!-- bbox: ymin,xmin,ymax,xmax -->` (0.0〜1.0 正規化)
- 表は GFM テーブル、9 列固定
- 手書きメモは箇条書き / 段落
- 「読み取った値」列は紙面文字通り (H/L マーカ・赤字強調注記 `[強調]` を保持)
- 不明値は `(?)`、推測補完禁止
- 「備考」列の `【要確認】` は Gemini 監査官が検出した不整合シグナルで、Elith 側は重み付けに利用可能
- 「推論値」列は **本フォーマットに存在しない** (中間データ、永続化禁止)

#### 検査種別ごとの本体スキーマ

`test_type` の値ごとに、Markdown 本体の標準セクション構成を定める。Elith 側パーサが `test_type` で分岐できるよう、**セクション見出しと表の列構成は固定**する。

##### `test_type: health_checkup` (人間ドック / 定期健康診断)

ユーザー撮影 (source: `user_upload`) でも Wellfort 取込でも同じ。9 列固定 (上述)。

##### `test_type: blood` (Wellfort 経由・血液検査)

```markdown
## 血液検査値表
| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1  | HbA1c    | HbA1c (NGSP) | 6.2          | %    | 4.6    | 6.2    | -    | -    |
```

`health_checkup` と同じ 9 列。違いは `source: wellfort_lab` で固定フォーマットゆえ Gemini 介在不要。

##### `test_type: genetics` (Wellfort 経由・遺伝子検査)

```markdown
## 遺伝子リスク評価
| 疾患カテゴリ | リスクランク | 相対リスク | コメント |
|---|---|---|---|
| 大腸がん | 高 | 1.8 | APC 変異検出 |
| 2型糖尿病 | 中 | 1.3 | - |

## 詳細所見
- 高リスク所見: ...
- 中リスク所見: ...
```

##### `test_type: cancer_urine` (Wellfort 経由・がんリスク検査)

```markdown
## がんリスク評価 (尿検体)
| 指標 | 値 | リスクランク | 備考 |
|---|---|---|---|
| ポルフィリン量 | 12.4 ng/mL | 中 | - |
| インデックス値 | 4.2 | 高 | 要精査 |

## 推奨事項
- 3 ヶ月以内の精密検査推奨
```

##### `test_type: ai_prediction` (Wellfort 経由・AI 疾病予測)

```markdown
## AI 疾病予測結果
| 予測項目 | 確率 | 95% 信頼区間 | 予測根拠 (top 3) |
|---|---|---|---|
| 5 年以内の 2 型糖尿病発症 | 18% | 14-22% | HbA1c, BMI, 家族歴 |
| 10 年以内の心血管イベント | 8% | 5-11% | LDL-C, 血圧, 喫煙歴 |

## モデル情報
- model_name: <vendor>/<model>
- model_version: 1.2.0
```

##### 共通規約

- セクション見出しと表の列構成は `schema_version` 単位で**不変** (Elith 側のパース安定性のため)
- 数値型は単位付きで文字列化 (例: `12.4 ng/mL`) — Elith 側で正規化
- 不明値は `(?)`、推測補完禁止
- 表に表現できない自由テキスト所見は `## 詳細所見` セクションへ箇条書きで

### 3.3 `interrogation_md` のフォーマット（予定）

```markdown
## 問診セッション
<!-- session_id: ... -->
<!-- started_at: 2026-05-23T14:30:00+09:00 -->

### 主訴
- 約 1 ヶ月前から食欲低下
- 体重 −3kg

### 既往歴
- 高血圧（10 年）
- 服薬: ARB 50mg/日

### 生活習慣
- 飲酒: 週 2-3 回
- 喫煙: なし
```

詳細フォーマットは Live API 実装フェーズで確定。

### 3.4 `diagnostic_result` のフォーマット (Elith JSON)

Elith AI 診断システムからの戻り。実サンプル: `docs/elith/2026_05_24 Elith_demo.json`。

#### 構造

**フラットな配列 + オブジェクト** (ネストなし):

```json
[
  { "section_name": "アブストラクト",      "char_count": 1247, "text": "【総評】..." },
  { "section_name": "総評",                "char_count": 1281, "text": "..." },
  { "section_name": "検査値フィードバック", "char_count": 1815, "text": "【血圧】..." },
  { "section_name": "食事アドバイス",       "char_count": 4068, "text": "..." },
  { "section_name": "運動アドバイス",       "char_count": 3484, "text": "..." },
  { "section_name": "睡眠・ストレス管理",   "char_count": 3780, "text": "..." },
  { "section_name": "ライフスタイル総合",   "char_count": 2918, "text": "..." },
  { "section_name": "医療受診の目安",       "char_count":  692, "text": "..." },
  { "section_name": "リファレンス",         "char_count": 1424, "text": "..." },
  { "section_name": "必要とする栄養素/サプリ情報", "char_count": 233, "text": "..." }
]
```

#### フィールド仕様

| key | 型 | 内容 |
|---|---|---|
| `section_name` | string | セクション識別子。固定 10 種類 (下記)。 |
| `char_count` | int | text の文字数 (`mb_strlen` 相当)。UI のページネーション判定に使用 |
| `text` | string | 本文。Markdown プレーンテキスト + 内部マーカ |

#### セクション一覧 (`section_name` 固定値)

| # | section_name | 想定文字数 | UI マッピング |
|---|---|---|---|
| 1 | アブストラクト | ~1,200 | **3 モード a) サマリー版** に使用 (Elith が自前で生成済) |
| 2 | 総評 | ~1,300 | b) 要注意の文脈、c) 全編冒頭 |
| 3 | 検査値フィードバック | ~1,800 | ダッシュボード指標カードの原文 |
| 4 | 食事アドバイス | ~4,000 | シチュエーション別カード (外食/コンビニ) |
| 5 | 運動アドバイス | ~3,500 | デイリークエスト (週N回M分) |
| 6 | 睡眠・ストレス管理 | ~3,800 | シチュエーション別カード (就寝前/業務中) |
| 7 | ライフスタイル総合 | ~2,900 | c) 全編 |
| 8 | 医療受診の目安 | ~700 | **🔴 緊急アラート (ピン留め)** の原文 |
| 9 | リファレンス | ~1,400 | `[N]` 引用の解決先 |
| 10 | 必要とする栄養素/サプリ情報 | ~200 | b) 要注意 + アクション |

#### 内部マーカ

| マーカ | 用途 | 例 |
|---|---|---|
| `【sub-section】` | セクション内のサブカテゴリ区切り | `【血圧】`, `【腎機能・尿酸】`, `【和定食】` |
| `[N]` | リファレンス引用 (N=1〜30) | `...が示されています [14]` → `リファレンス` セクションの `[14]` 行へ deep-link |
| `\n\n` | 段落区切り | プレーンに改行解釈 |

#### 含まれないもの (PII 非送付原則)

| 項目 | 扱い |
|---|---|
| `diagnosis_user_id` / `diagnostic_id` / 顧客名 / 生年月日 | **JSON 本体に含まない**。`diagnosis-ai-callback` Edge Function (EF-6) が受信時にラップして保存 |
| 検査日 / 検査値 (生数値) | テキスト内に埋込 (例: 「尿酸 8.4 mg/dL」)。構造化されてはいない |
| ハッシュ / 署名 | HTTP ヘッダ側で HMAC 署名 (`data_integration_requirements §6 EF-6`) |

#### 確定 `diagnostic_result` の保存形

Edge Function EF-6 が受信後、App-side Supabase `diagnosis_results` に以下の形で保存:

```sql
diagnostic_user_id  uuid       -- ラッピング側で付与
diagnostic_id       uuid       -- 1 セッションの識別子
report              jsonb      -- ↑ 受信した配列をそのまま
schema_version      text       -- 'elith-v1.0'
received_at         timestamptz
elith_job_id        text       -- 監査用
```

#### フォーマット規約

- セクション数・順序は**実装時点で固定** (Elith 仕様変更時に `schema_version` を bump)
- `section_name` は変えない (UI が enum で分岐)
- `char_count` は表示用 (実値と一致しない場合は `text` を優先)
- `text` 内の `\n` は LF。CRLF は禁止
- `【` (【) `】` (】) は半角括弧に正規化しない (UI 表示用にそのまま)
- 引用記法は半角 `[N]` (`[1]`〜`[30]` の範囲)

#### UI 変換戦略 (要点)

詳細: `docs/旧版・ボツ/elith_report_integration.md`

| 用途 | 取得元 |
|---|---|
| a) サマリー版 | `アブストラクト.text` をそのまま表示 |
| b) 要注意抜粋 | `医療受診の目安` + `総評` + 二次抽出 LLM で抽出した高リスク項目 |
| c) 全編 | 全 9 セクションを順次レンダリング (Markdown プレーン) |
| 🔴 緊急アラート | `医療受診の目安` から LLM 抽出 (e.g. 「眼科を今週中に受診」) |
| 🟢🟡🟠 指標カード | `検査値フィードバック` の `【sub】` ごとに二次抽出で値・基準・色を構造化 |
| デイリークエスト | `運動アドバイス` `食事アドバイス` から `週N回M分` `1日2L` 等のパターン抽出 |
| シチュエーション別カード | `食事アドバイス` の 【和定食】【洋定食】等、`睡眠・ストレス管理` の 【リラクゼーション】等 |

### 3.5 ファイル名規約（端末ダウンロード / オブジェクトストレージ共通）

```
{diagnostic_id}/
  scan-{ISO8601}.md
  scan-{ISO8601}.jpg
  interrogation-{ISO8601}.md
  diagnostic_result-{ISO8601}.json    # 後続で診断 AI が書く
  manifest.json
```

例:
```
6f2c1a9b-1234-4abc-9def-d3a3aa30c777/
  ├ scan-20260523T142005.md
  ├ scan-20260523T142005.jpg
  ├ interrogation-20260523T142810.md
  └ manifest.json
```

### 3.6 `manifest.json` のスキーマ

```json
{
  "diagnostic_id": "6f2c1a9b-1234-4abc-9def-d3a3aa30c777",
  "schema_version": 1,
  "created_at": "2026-05-23T14:20:05+09:00",
  "device": { "ua": "...", "screen": "..." },
  "app_version": "80f6a45",
  "artifacts": [
    { "type": "scan_md",          "file": "scan-20260523T142005.md",       "bytes": 2840 },
    { "type": "scan_image",       "file": "scan-20260523T142005.jpg",      "bytes": 287430, "mime": "image/jpeg" },
    { "type": "interrogation_md", "file": "interrogation-20260523T142810.md", "bytes": 1820 }
  ]
}
```

Supabase / S3 へ移行する際、この manifest を読めば全レコードを再構成できる。

---

## 4. 段階的ストレージ戦略

### Phase 0：パイロット（現在）

ローカル端末への明示ダウンロードのみ。サーバ側永続化はしない。

```
[iPhone Safari / iPad]
  ├ localStorage: 直近の diagnostic_id, 進行中セッション
  └ Files App / Downloads: {diagnostic_id}/*.md, *.jpg, manifest.json
                            (一括 ZIP ダウンロードボタン経由)
```

### Phase 1：Supabase 二分割

```
┌─ Supabase #1: 顧客系（既存 HP/EC）────────┐    ┌─ Supabase #2: 診断系（新規） ────────┐
│  customers (PII)                          │    │  diagnostics                          │
│  customer_diagnostic_link  ← 唯一の橋     │    │  scan_artifacts                       │
│  kit_shipments                            │    │  diagnostic_results (JSONB)           │
│  notifications                            │    │  Storage: {diagnostic_id}/*.md, *.jpg │
└───────────────────────────────────────────┘    └───────────────────────────────────────┘
            │                                              │
            └── diagnostic_id だけで橋渡し ────────────────┘
                (PII はこの境界を越えない)
```

### Phase 2：AWS 移行

```
┌─ 顧客系 ──────────────────────────────────┐    ┌─ 診断系 ─────────────────────────────┐
│  AWS RDS PostgreSQL (顧客 VPC)            │    │  AWS Aurora PostgreSQL Serverless v2 │
│  + S3 (各種ドキュメント)                  │    │  + S3 (scan_image, manifest)         │
│  + CloudFront (静的アセット)              │    │  + OpenSearch (任意・MD 全文検索)    │
└───────────────────────────────────────────┘    └───────────────────────────────────────┘

  両 DB は別 VPC、必要時のみ VPC Peering or PrivateLink で
  customer_diagnostic_link テーブル経由のクエリだけ流す。
```

各フェーズの境界では `pg_dump | pg_restore` でスキーマ移行可能（Supabase も AWS RDS/Aurora も PostgreSQL のため）。

---

## 5. スキーマ定義

### 5.1 顧客系 Supabase / RDS（PII を保持）

#### `customer_diagnostic_link`

顧客 ID と診断 ID を結ぶ唯一のテーブル。診断系には漏らさない。

```sql
create table customer_diagnostic_link (
  link_id        uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references customers(customer_id),
  diagnostic_id  uuid not null unique,                  -- 診断系の diagnostic_id と同値
  created_at     timestamptz not null default now(),
  status         text not null default 'in_progress',   -- 'in_progress' | 'completed' | 'archived'
  kit_serial     text,                                   -- 検査キット個体番号
  notified_at    timestamptz,                            -- 診断完了通知送信日時
  viewed_at      timestamptz                             -- ユーザー閲覧日時
);

create index ix_cdl_customer  on customer_diagnostic_link(customer_id);
create index ix_cdl_diagnostic on customer_diagnostic_link(diagnostic_id);
create index ix_cdl_status     on customer_diagnostic_link(status);
```

### 5.2 診断系 Supabase / Aurora（PII を持たない）

#### `diagnostics`

1 セッションを表すルート行。

```sql
create table diagnostics (
  diagnostic_id  uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  status         text not null default 'in_progress',  -- 'in_progress' | 'analyzed' | 'completed' | 'archived'
  app_version    text                                   -- Scan-Chat-AI コミット SHA
);

create index ix_d_status on diagnostics(status);
create index ix_d_created_at on diagnostics(created_at desc);
```

#### `scan_artifacts`

スキャン関連の成果物（MD / 画像 / 問診 MD）。

```sql
create table scan_artifacts (
  artifact_id     uuid primary key default gen_random_uuid(),
  diagnostic_id   uuid not null references diagnostics(diagnostic_id) on delete cascade,
  type            text not null check (type in ('scan_md','scan_image','interrogation_md')),
  content         text,                                  -- md の場合
  storage_path    text,                                  -- バイナリの場合 (Supabase Storage / S3 のキー)
  storage_bucket  text,                                  -- バケット名
  bytes           int,
  mime_type       text,
  created_at      timestamptz not null default now(),
  meta            jsonb default '{}'::jsonb              -- bbox / model 等の補助情報
);

create index ix_sa_diagnostic on scan_artifacts(diagnostic_id);
create index ix_sa_type       on scan_artifacts(type);
create index ix_sa_meta_gin   on scan_artifacts using gin (meta);
```

#### `diagnostic_results`

下流 AI の診断結果。**JSONB ハイブリッド設計**で将来のスキーマ進化に対応。

```sql
create table diagnostic_results (
  id              uuid primary key default gen_random_uuid(),
  diagnostic_id   uuid not null references diagnostics(diagnostic_id) on delete cascade,
  created_at      timestamptz not null default now(),

  -- AI トレーサビリティ（不変・必須）
  ai_provider     text not null,                         -- 'gemma' | 'qwen' | 'anthropic' | ...
  ai_model        text not null,                         -- 'gemma-4-medical-7b'
  ai_version      text,                                  -- '2026-05-15' or model hash
  schema_version  int  not null,                         -- AI 出力スキーマのバージョン

  -- 進化する本体
  result          jsonb not null,                        -- 診断結果本体（自由構造）
  result_md       text,                                  -- ユーザー閲覧用 Markdown（任意）

  -- よく使う指標の denormalized（任意）
  severity        text,                                  -- 'normal' | 'watch' | 'urgent'
  abnormal_count  int,
  flagged_items   text[],

  -- 監査・再現性
  prompt_used     text,
  raw_response    text,
  tokens_in       int,
  tokens_out      int,
  cost_usd        numeric(10,6),
  latency_ms      int
);

create index ix_dr_diagnostic on diagnostic_results(diagnostic_id);
create index ix_dr_created_at on diagnostic_results(created_at desc);
create index ix_dr_severity   on diagnostic_results(severity) where severity is not null;
create index ix_dr_ai_model   on diagnostic_results(ai_model, ai_version);
create index ix_dr_result_gin on diagnostic_results using gin (result);
```

**進化吸収のパターン:**

| 変化 | 対応 |
|---|---|
| AI が新しいフィールドを返すように | `result` JSONB に追加。テーブル定義変更なし。`schema_version` を上げる |
| ある指標が定着して頻繁にクエリされる | `alter table ... add column` で昇格、JSONB との二重保持で互換維持 |
| 別の AI モデルで A/B テスト | 同 `diagnostic_id` に対し別行 INSERT。`ai_model` / `ai_version` で識別 |
| 過去診断を embedding で類似検索 | 後付けで `embedding vector(768)` + `pgvector` を追加 |

### 5.3 Supabase Storage（バイナリ）

バケット構成:

```
diagnostic-artifacts/                     # private bucket, RLS で diagnostic_id 一致時のみ参照可
  {diagnostic_id}/
    scan-{ts}.jpg
    interrogation-audio-{ts}.webm        # Live API の録音（任意）
```

`scan_artifacts.storage_path` にこの key を入れる。

---

## 6. セキュリティ / アクセス制御

### 6.1 PII 越境禁止の原則

```
顧客系 ─→ 診断系: diagnostic_id のみ通過させる（氏名・メール等は絶対に流さない）
診断系 ─→ 顧客系: diagnostic_id と status / result_md のみ返す
```

これにより診断系 DB の万が一の漏洩でも個人特定が困難になる（HIPAA-style pseudonymization）。

### 6.2 セッション認証

Scan-Chat-AI クライアントは `diagnostic_id` だけで動作する。マイページ経由のセッション検証は HMAC トークン方式:

```
[マイページ]
  diagnostic_id = uuid4()
  scan_session_token = HMAC_SHA256(diagnostic_id + expires_at, secret)
  → リダイレクト URL: https://scan-chat-ai.../scan?diagnostic_id={id}&token={t}&exp={exp}

[Scan-Chat-AI]
  URL から diagnostic_id / token / exp を取得
  サーバ側で HMAC 再計算し一致確認
  exp を過ぎていれば拒否
  ※ token に customer_id は含めない
```

### 6.3 RLS（Row Level Security）

#### 顧客系
```sql
-- customer_diagnostic_link: 本人 customer_id のみ参照可
create policy "customers see own links" on customer_diagnostic_link
  for select using (customer_id = auth.uid());
```

#### 診断系
```sql
-- diagnostics / scan_artifacts / diagnostic_results: 一般ユーザーは参照不可
-- マイページからの参照は API 経由（diagnostic_id allowlist 検証あり）
```

---

## 7. データフロー詳細

### 7.1 スキャン → 保存

```
[Scan-Chat-AI (Vercel iad1)]
  capture → Files API upload → Gemini Flash → Markdown stream
                                                       │
                                                       ▼
  [Phase 0] ローカル ZIP ダウンロード（manifest.json + scan-*.md + scan-*.jpg）
  [Phase 1] Supabase Storage に画像 PUT、Postgres に scan_artifacts INSERT
  [Phase 2] AWS S3 に PUT、Aurora に INSERT
```

### 7.2 診断 AI トリガ

```
[scan_artifacts] INSERT
        │ (Postgres trigger or Supabase Realtime)
        ▼
[診断 AI ワーカー（別ホスト）]
  diagnostic_id をキーに最新の scan_artifacts と interrogation_md を読み込み
  AI 診断生成
  diagnostic_results に INSERT
        │
        ▼
[Edge Function / Webhook]
  顧客系 customer_diagnostic_link.status = 'completed' に更新
  notified_at は通知配信後に更新
        │
        ▼
[マイページ]
  push / メール通知
  ユーザーが結果を閲覧 → viewed_at 更新
```

### 7.3 マイページからの閲覧

```
[ユーザー: マイページ]
  ログイン (customer_id)
  自分の link 行を SELECT → diagnostic_id 一覧
  各 diagnostic_id について diagnostic_results を SELECT (API 経由)
  scan_md, scan_image, interrogation_md も同様に取得
  → ダッシュボードに統合表示
```

---

## 8. 移行プレイブック

### 8.1 Phase 0 → Phase 1 (Supabase 二分割)

1. 顧客系 Supabase に `customer_diagnostic_link` テーブル追加（マイグレーション）
2. 診断系 Supabase プロジェクト新規作成
3. 診断系に `diagnostics` / `scan_artifacts` / `diagnostic_results` テーブル作成
4. 診断系に Storage バケット `diagnostic-artifacts` 作成
5. Scan-Chat-AI 側にクライアント追加（`@supabase/supabase-js` 既存）
6. `/api/scan` 完了時に Supabase に書き込み
7. ユーザーは引き続き ZIP ダウンロードも可能（バックアップ）
8. ローカル保存はオプション機能として残す

### 8.2 Phase 1 → Phase 2 (AWS 移行)

1. AWS Aurora PostgreSQL Serverless v2 をプロビジョン（診断系）
2. AWS RDS PostgreSQL をプロビジョン（顧客系）
3. `pg_dump` で Supabase の各 DB をダンプ
4. `pg_restore` で AWS にリストア
5. Supabase Storage の object を S3 に同期（`gsutil` 経由でも `s3 sync` でも可）
6. アプリの DB 接続文字列を切替
7. RLS / IAM を AWS に合わせて再構成
8. Supabase 側は読み取り専用にして並行運用 → 安定確認後にクローズ

### 8.3 GCS バックアップ

両フェーズで並行:

```
日次 cron:
  pg_dump --format=custom <db_url> | gsutil cp - gs://medical-backup/{date}/{db}.dump
  gsutil rsync s3://artifacts gs://medical-backup/{date}/artifacts/
```

GCS 側は Coldline で保管、30 日以降は Archive クラスへライフサイクル遷移。

---

## 9. 未確定事項 / 今後の議論

| # | 項目 | 検討要否 |
|---|---|---|
| 1 | 同一 `diagnostic_id` に複数検査表をまとめる UX（複数撮影） | UI 設計時 |
| 2 | 問診中断・再開 時のセッション継続戦略 | Live API 実装時 |
| 3 | 診断 AI の冪等性（同じ scan_md に対して何度呼んでも同じ結果か） | 診断 AI 仕様確定後 |
| 4 | `result` JSONB の言語切替（日本語/英語両出力） | 国際化検討時 |
| 5 | 監査ログ / アクセスログのスキーマ | HIPAA 監査要件確定時 |
| 6 | 画像のサムネイル生成（一覧表示用） | UI 拡張時 |
| 7 | `diagnostic_id` 発番をマイページ側に移譲する切替時期 | マイページ実装後 |

---

## 10. 参考: 現在のコード位置

| ファイル | 役割 |
|---|---|
| `src/pages/api/scan.ts` | スキャン → Markdown 生成 |
| `src/pages/api/live-token.ts` | Live API 問診の ephemeral token 発行 |
| `src/scripts/camera-scan.ts` | 撮影 + Markdown 受信 + `parseMarkdownRegions` |
| `src/scripts/scan-verification.ts` | 検証 UX (トリミング画像 + bbox オーバーレイ + セル単位モーダル + `assembleMarkdownClean`) |
| `src/scripts/chat/live-controller.ts` | 問診 (Live API) UI 連携 |
| `src/pages/scan.astro` | スキャン UI |
| `src/pages/chat.astro` | 問診 UI |

Phase 1 着手時の追加予定:
| ファイル | 役割 |
|---|---|
| `src/lib/diagnosis-storage.ts` | 診断系 Supabase クライアント |
| `src/lib/diagnostic-id.ts` | UUID 生成・localStorage 永続化 |
| `supabase/diagnosis/migrations/*.sql` | 診断系スキーマ |
| `supabase/customer/migrations/*.sql` | 顧客系スキーマ（追加分のみ）|
