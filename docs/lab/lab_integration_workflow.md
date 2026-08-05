# 検査機関連携・ユーザー割当 ワークフロー仕様

| 項目 | 内容 |
|---|---|
| 文書名 | 検査機関連携・ユーザー割当 ワークフロー仕様 |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-05-28 |
| 対象範囲 | Wellfort 経由 (source: `wellfort_lab`) で取り込まれる検査結果のユーザー割当 |
| 関連文書 | `docs/architecture/wellfort_app_design_concept.md` §5b / `docs/architecture/diagnostic_session_data_spec.md` §3.2 / `docs/architecture/data_integration_requirements.md` §1.3 |

---

## 1. 背景と課題

`docs/architecture/wellfort_app_design_concept.md §5 (b)` の通り、Wellfort 側が代理アップロードする検査結果は**固定フォーマット**で、以下 4 種類:

- 血液検査 (`test_type: blood`)
- 遺伝子検査 (`test_type: genetics`)
- がんリスク検査 / 尿 (`test_type: cancer_urine`)
- AI 疾病予測・Elith 以外 (`test_type: ai_prediction`)

検査機関から戻ってきた PDF 結果報告書を、システム上の正しい**ユーザー (`diagnostic_user_id`)** に紐付ける必要がある。本書はその**ユーザー割当ワークフロー**を規定する。

### 1.1 核心的制約 (絶対遵守)

| 制約 | 出典 |
|---|---|
| `diagnostic_user_id` が両系統 (顧客系 / 診断系) の**唯一の橋渡し** | `docs/architecture/data_integration_requirements.md §1.3-2` |
| **PII 越境禁止** — 氏名・住所・生年月日は診断系 DB に書き込まない | `docs/architecture/data_integration_requirements.md §1.3-7` |
| 個情法・医療情報安全管理ガイドライン準拠 | 3 省 2 ガイドライン |

→ **氏名と生年月日の OCR 自動マッピングだけで割当を確定するのは禁止**。誤割当は PHI 漏洩 = 法務インシデント。

---

## 2. 3 つのワークフロー (優先度順)

### Workflow 1: ID 同伴方式 ★★★ (最終目標)

検査キット発送時に `diagnostic_user_id` を検査機関に渡し、結果報告に**同じ ID を同伴**して戻してもらう。

```
[Wellfort]                                    [検査機関]
    │
    ├── 検査キット発送                          │
    │   バーコード/QR で diagnostic_user_id    │
    │   をキット個体に印字 ────────────────────▶│
    │                                          │
    │                                          ├── 検体受領
    │                                          ├── 分析
    │                                          │
    │                                          ├── 結果 PDF 生成
    │                                          │   メタデータ / 印字 / 別紙 csv で
    │◀── 結果報告 + diagnostic_user_id ────────┤   diagnostic_user_id を同伴
    │                                          │
    ├── ID で自動的にユーザー割当                │
    ├── PII (氏名・生年月日) を破棄              │
    └── scan_md に書き込み (PII 含まず)         │
```

**メリット**: 氏名・生年月日を見る必要が無く、PHI 漏洩リスクが構造的にゼロ。<br>
**デメリット**: 検査機関側に運用変更を依頼する必要あり。<br>
**適用**: Phase 2 (本格運用後、検査機関と契約改定可能なタイミング) で主軸化。

#### 必要な検査機関側対応

| 連携方式 | 詳細 |
|---|---|
| バーコード/QR 印字 | 検査キットに `diagnostic_user_id` のバーコード貼付。検査機関は OCR or スキャナで読取して結果に転記 |
| 別紙 CSV 同伴 | 結果 PDF と同 zip 内に `{external_test_id, diagnostic_user_id}` のマッピング CSV を同梱 |
| API 連携 (推奨) | 検査機関が結果 webhook 時に `diagnostic_user_id` をペイロードに含める |

---

### Workflow 2: 検査ID 逆引き方式 ★★ (Phase 1 推奨)

発注時点で `external_test_id ↔ diagnostic_user_id` のマッピングを Wellfort 側 DB に保持し、結果 PDF の検査 ID から逆引き。

```
[Wellfort]                                    [検査機関]
    │
    ├── 検査キット発注 ──────────────────────▶ │
    │                                          │
    │◀── external_test_id 発番 ────────────────┤  (例: WF-2026-XYZ-001)
    │                                          │
    ├── DB に保存:                              │
    │   {external_test_id: WF-2026-XYZ-001,    │
    │    diagnostic_user_id: 7b3f...}           │
    │                                          │
    │                              (検体取得・分析・PDF 生成)
    │                                          │
    │◀── 結果 PDF ─────────────────────────────┤
    │                                          │
    ├── PDF から external_test_id を読取        │
    ├── DB 逆引きで diagnostic_user_id 取得     │
    └── scan_md に書き込み                     │
```

**メリット**: 検査機関側の運用変更不要 (既存の検査 ID をそのまま使う)。<br>
**デメリット**: 発注時の二重登録が必要、external_test_id の OCR は必要。<br>
**適用**: **Phase 1 の主軸**。Workflow 1 へ移行するまでの実用解。

#### 実装ポイント

- `external_test_id` は OCR で読み取るが、これは **PII ではない** ので OCR ミスがあっても PHI 漏洩には直結しない (誤割当には繋がるので二重照合は必要)
- **二重照合**: external_test_id 一致 + 検査日一致 + 検査機関名一致 の **3 つすべて一致**で確定。1 つでも不一致なら Workflow 3 にフォールバック

---

### Workflow 3: AI 抽出 + 人間承認 (補助のみ) ★

PDF から氏名・生年月日・検査ID を AI で抽出し、顧客マスタと突合して候補を提示。**Wellfort 担当者が画面上で最終承認**するまで割当は確定しない。

```
[Wellfort バックエンド]
    │
    ├── 仮置きフォルダに PDF を受領              
    │                                          
    ├── AI で抽出:                              
    │   - 氏名 (OCR)                            
    │   - 生年月日 (OCR)                         
    │   - 検査 ID (OCR)                          
    │   - 検査日 (OCR)                           
    │                                          
    ├── 顧客マスタ (HP 側 `customer_profiles`) と突合
    │   → 候補上位 N 件を抽出                    
    │                                          
    ▼                                          
[割当承認 UI]                                  
    │                                          
    ├── 担当者が候補から正解を選択 (or 「該当なし」)
    │   ↓                                       
    ├── 1 クリックで承認                        
    │                                          
    ▼                                          
[割当確定]                                     
    │                                          
    ├── customer_id → diagnostic_user_id 解決   
    ├── PII (氏名・生年月日) を破棄              
    └── scan_md に書き込み (front-matter に     
        age_at_test のみ転記、氏名・誕生日は無)  
```

**メリット**: 検査機関の協力が一切不要。既存ストックの PDF にも適用可能。<br>
**デメリット**:
- 同姓同名・OCR ミスでの誤候補提示リスク
- 担当者の承認操作がボトルネック
- **完全自動化は絶対不可** (誤割当 = PHI 漏洩)

**適用**: Workflow 1/2 のフォールバック、過去 PDF の遡及取込、特殊ケース対応。**単独運用は禁止**。

#### 承認 UI 要件

| 要素 | 仕様 |
|---|---|
| 候補表示 | 上位 3 件を信頼度スコア付きで表示。各候補に `customer_name (氏名 masked)` / 生年月日 / 過去検査数 を表示 |
| 「該当なし」 | 候補が全て誤りの場合のオプション → エラーキューへ送る |
| 「保留」 | 即時判断できない場合に翌日以降に持ち越し |
| 監査ログ | 承認者 ID / 承認時刻 / 候補スコア / 最終選択を `audit_logs` に保存 (10 年保管) |
| 二重承認 (オプション) | 高リスク種別 (遺伝子検査等) は 2 名承認を必須化できる設定 |

---

## 3. ワークフロー選択マトリクス

| シナリオ | 推奨 Workflow |
|---|---|
| 新規検査機関と契約締結時 | **Workflow 1** を契約条件に含める |
| 既存検査機関 (運用変更困難) | **Workflow 2** で external_test_id 連携 |
| Workflow 1/2 が二重照合で不一致 | **Workflow 3** にフォールバック |
| 過去 PDF の遡及取込 (バックフィル) | **Workflow 3** (人間承認必須) |
| 緊急対応・特殊ケース | **Workflow 3** |

### Phase 別の主軸切替

| Phase | 主軸 | 補助 |
|---|---|---|
| Phase 1 (運用開始) | Workflow 2 | Workflow 3 |
| Phase 2 (スケール) | Workflow 1 | Workflow 2 / 3 |

---

## 4. 共通要件 (全 Workflow)

### 4.1 PII 除去ポイント

PDF 上の情報を `scan_md` に書き出す時点で:

| PDF 上の情報 | scan_md に保存? | 用途 |
|---|---|---|
| 氏名 | ✕ | 割当時の確認のみ、即破棄 |
| 生年月日 | △ **年齢のみ** (`age_at_test`) | 診断 AI が年齢を参考にする |
| 性別 | ◯ (`sex`) | 診断に必要 (PII ではない) |
| 検査日 | ◯ (`test_date`) | 時系列分析に必要 |
| 検査 ID | ◯ (`external_test_id`) | トレーサビリティ |
| 検査機関名 | ◯ (`lab_name`) | 監査・問合せ用 |
| 住所 | ✕ | 検査結果の解釈に不要 |
| 連絡先 | ✕ | 検査結果の解釈に不要 |
| diagnostic_user_id | ◯ | 内部識別子 (匿名キー) |
| customer_id | ✕ | HP/EC 顧客系 DB のみ保持 |

### 4.2 監査ログ要件

| 項目 | 内容 |
|---|---|
| 取込トリガ | バッチ (cron) / 手動 / API webhook |
| 取込時刻 | `imported_at` (timezone 付き) |
| 取込実行主体 | `imported_by` (system / 担当者 ID) |
| 採用 Workflow | `workflow_used: 1 | 2 | 3` |
| 信頼度スコア | Workflow 3 の場合のみ。承認時の候補スコアと選択候補 |
| 元 PDF ハッシュ | SHA-256 (改竄検知用) |
| 保管期間 | **10 年** (医療情報安全管理ガイドライン) |

### 4.3 失敗時のキュー

| 失敗種別 | 対応 |
|---|---|
| Workflow 1 で ID 不整合 | Workflow 2 にフォールバック → 失敗なら 3 へ |
| Workflow 2 で逆引きヒットなし | エラーキューへ → Workflow 3 で担当者対応 |
| Workflow 3 で「該当なし」承認 | 検査機関に問合せ → 場合により破棄 (個情法上、所有者不明データは保持禁止) |
| OCR 失敗 (検査ID 不読) | 担当者に通知 → 手動入力 UI |

---

## 5. 実装ロードマップ

### Phase 1.0 (運用開始)
- [ ] `external_test_id ↔ diagnostic_user_id` マッピングテーブルを Wellfort DB に追加
- [ ] Workflow 2 のバッチ処理実装 (S3 監視 → OCR → 逆引き → scan_md 書込)
- [ ] Workflow 3 の承認 UI を Wellfort 管理画面に追加
- [ ] 監査ログテーブル `lab_import_audit` 設計

### Phase 1.5 (主要検査機関との Workflow 1 移行)
- [ ] 主要 1-2 機関と契約改定協議 (バーコード/QR or 別紙 CSV 同伴の合意)
- [ ] Workflow 1 のバッチ処理実装
- [ ] 検査キット個体への `diagnostic_user_id` バーコード貼付運用

### Phase 2 (スケール)
- [ ] 全提携検査機関で Workflow 1 を主軸化
- [ ] AWS 移行 (Lambda + S3 イベントトリガ)
- [ ] 検査機関側 API による webhook 連携 (リアルタイム化)

---

## 6. 未確定事項 (TBD)

- [ ] 検査機関ごとの PDF レイアウトばらつきへの対応 (OCR テンプレート定義)
- [ ] external_test_id の発番ルール (Wellfort 側 or 検査機関側、桁数・チェックデジット)
- [ ] Workflow 3 で複数候補のスコアリングロジック (氏名一致度・生年月日完全一致・検査機関一致)
- [ ] バッチ実行頻度 (1 日 1 回 / 1 時間 1 回 / リアルタイム webhook)
- [ ] 承認 SLA (担当者の応答時間目標)
- [ ] Workflow 3 で「該当なし」確定後の PDF 保管・廃棄ルール
- [ ] 異常検出時 (例: 1 日に 100 件以上のエラー) のアラート閾値

---

## 7. 変更履歴

| Ver | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-28 | 初版。Workflow 1/2/3 の 3 段階定義、Phase 別主軸切替、PII 除去ポリシー、監査ログ要件を規定 |
