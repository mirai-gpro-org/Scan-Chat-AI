# Wellfort 管理画面: 検査結果ファイル一括アップロード機能 仕様書

**版**: 0.1 (2026-05-30)
**対象システム**:
- **Wellfort HP 管理画面** (admin) — 本仕様の実装対象
- **Scan-Chat-AI** — API 提供側 (`https://scan-chat-ai.vercel.app`)

**依頼元**: アンフィックスエンターテイメント株式会社 (担当: 濱田)
**作業担当**: ウェルフォート HP/EC 開発チーム

---

## 1. 概要

ウェルフォート経由で検査を受けた顧客の検査結果ファイル (PDF / CSV) を、
ウェルフォート管理者が **Scan-Chat-AI に一括アップロード** できる機能を、
Wellfort HP の管理画面に新設する。

### 1-1. 対象検査 (4 種)

| 検査名 | 検査機関 | 形式 | 既存ファイル名規則 (例) |
|---|---|---|---|
| 血液検査 | リージャーラボラトリー | PDF + CSV | `RG-YYYY-NNNNNN.pdf`、`RG-YYYY-NNNNNN.csv` |
| がんリスク検査 (尿) | PREVENT メディカル | PDF | `KNNNN.pdf` |
| 遺伝子検査 | ジェノプランジャパン | PDF | `CBAD-DMID-BOAQ.pdf` 等 (検査キー形式) |
| AI 疾病予測 | LAiF (Elith 以外) | PDF | `LAIF-YYYY-MM-NNN.pdf` |

---

## 2. 業務フロー (現行 → 新規)

### 2-1. 現行フロー (手動)

```
[各検査機関]
  ↓ メール通知
[Wellfort 担当者] — 案内URLにアクセス → PDF を 1 件ずつ DL → ローカル PC に保存
  ↓ (手作業)
[Wellfort 担当者] — 顧客に紐付け → メール送付 / マイページ反映
```

### 2-2. 新規フロー (本機能)

```
[各検査機関]
  ↓ メール通知 (現行同じ)
[Wellfort 担当者] — 案内URLにアクセス → 複数 PDF を一括 DL
  ↓ (現行同じ)
[Wellfort 管理画面] ─ ★ 本機能 ★ ─
  ① 検査機関を選択
  ② ファイルを複数選択 (PDF/CSV)
  ③ Scan-Chat-AI に重複チェック自動問合せ
  ④ 重複が無いファイルはチェック ON、有るものは OFF
  ⑤「アップロード」ボタン押下
  ↓
[Scan-Chat-AI] — Supabase Storage 保存 + test_artifacts 自動生成
  ↓
[Scan-Chat-AI 内 LLM 解析] (非同期) → Elith 連携 → 顧客のダッシュボード反映
```

---

## 3. 配置場所

Wellfort HP 管理画面の **検査管理** 等のメニュー配下に新規ページ:

```
/admin/lab-results/upload
```

### 3-1. 推奨ナビゲーション

```
管理画面サイドバー:
  ├ ダッシュボード
  ├ 顧客管理
  ├ 検査管理
  │   ├ 検査結果アップロード ★ ← 新設
  │   └ ...
  ├ 配送管理
  └ ...
```

---

## 4. UI 仕様

### 4-1. 画面ワイヤーフレーム

```
┌─ 検査結果アップロード ────────────────────────────────────┐
│                                                          │
│  検査機関  [ リージャーラボラトリー (血液検査) ▼ ]      │
│                                                          │
│  ファイル  [ ファイルを選択 ] (複数可、PDF/CSV、最大100件)│
│                                                          │
│  ┌─ 選択ファイル一覧 (4 件) ─────────────────────────┐  │
│  │                                                    │  │
│  │ ☑ RG-2026-001045.pdf      [📄 297KB]   新規  ✅   │  │
│  │ ☑ RG-2026-001045.csv      [📄  12KB]   新規  ✅   │  │
│  │ ☐ RG-2025-001234.pdf      [📄 280KB]   重複 ⚠️    │  │
│  │ ☑ RG-2026-001046.pdf      [📄 305KB]   新規  ✅   │  │
│  │                                                    │  │
│  │ ✅ アップロード対象: 3 件 / ⚠️ 重複: 1 件 (除外)   │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  [ キャンセル ]                  [ 🚀 アップロード ]     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 4-2. 重複時の表示

| 状態 | 表示 | デフォルトチェック | 動作 |
|---|---|---|---|
| **新規** | `新規 ✅` (緑) | **ON** (アップロード) | 通常通り処理 |
| **重複** | `重複 ⚠️` (黄) | **OFF** (除外) | ユーザーが手動で ON にすれば上書き |
| **エラー** | `エラー ❌` (赤) | **OFF** | アップロード対象外、詳細 tooltip |

### 4-3. 進行状況表示 (アップロード中)

```
┌─ アップロード中 ──────────────────────────────┐
│  RG-2026-001045.pdf      ✅ 完了              │
│  RG-2026-001045.csv      ⏳ 処理中... 60%     │
│  RG-2026-001046.pdf      ⏸ 待機              │
│                                               │
│  完了 1 / 3   失敗 0 / 3                      │
└───────────────────────────────────────────────┘
```

### 4-4. 完了表示

```
┌─ アップロード完了 ────────────────────────────┐
│  ✅ 3 件アップロード成功                       │
│                                               │
│  詳細:                                        │
│  - RG-2026-001045.pdf → 物部 慶幸様 に紐付け  │
│  - RG-2026-001045.csv → 物部 慶幸様 に紐付け  │
│  - RG-2026-001046.pdf → 顧客未割当 (要確認)   │
│                                               │
│  [ 顧客割当画面へ ]  [ 続けてアップロード ]   │
└───────────────────────────────────────────────┘
```

---

## 5. API 仕様 (Scan-Chat-AI 側で実装)

### 5-1. 重複チェック

```
POST https://scan-chat-ai.vercel.app/api/admin/lab-results/check
```

#### Request

```http
POST /api/admin/lab-results/check
Content-Type: application/json
Authorization: Bearer <ADMIN_API_KEY>

{
  "lab_company": "rieger" | "prevent" | "genoplan" | "laif",
  "test_type": "blood" | "cancer_urine" | "genetics" | "ai_prediction",
  "filenames": ["RG-2026-001045.pdf", "RG-2026-001045.csv", "RG-2025-001234.pdf"]
}
```

#### Response (200)

```json
{
  "lab_company": "rieger",
  "results": [
    { "filename": "RG-2026-001045.pdf", "status": "new" },
    { "filename": "RG-2026-001045.csv", "status": "new" },
    {
      "filename": "RG-2025-001234.pdf",
      "status": "duplicate",
      "existing_artifact_id": "a0000002-0000-0000-0000-000000000000",
      "uploaded_at": "2025-09-26T10:00:00+09:00",
      "customer_name": "物部 慶幸"
    }
  ]
}
```

#### Response (401 / 403)

```json
{ "error": "unauthorized", "detail": "Invalid API key" }
```

---

### 5-2. 一括アップロード

```
POST https://scan-chat-ai.vercel.app/api/admin/lab-results/upload
```

#### Request

```http
POST /api/admin/lab-results/upload
Content-Type: multipart/form-data
Authorization: Bearer <ADMIN_API_KEY>

------WebKitFormBoundary
Content-Disposition: form-data; name="lab_company"

rieger
------WebKitFormBoundary
Content-Disposition: form-data; name="test_type"

blood
------WebKitFormBoundary
Content-Disposition: form-data; name="files"; filename="RG-2026-001045.pdf"
Content-Type: application/pdf

<binary PDF data>
------WebKitFormBoundary
Content-Disposition: form-data; name="files"; filename="RG-2026-001045.csv"
Content-Type: text/csv

<binary CSV data>
------WebKitFormBoundary--
```

#### Response (200)

```json
{
  "lab_company": "rieger",
  "uploaded": [
    {
      "filename": "RG-2026-001045.pdf",
      "status": "success",
      "artifact_id": "f8a3d2c1-...",
      "customer_assigned": true,
      "customer_name": "物部 慶幸",
      "elith_queued": true
    },
    {
      "filename": "RG-2026-001045.csv",
      "status": "success",
      "artifact_id": "f8a3d2c1-...",
      "customer_assigned": true
    }
  ],
  "failed": []
}
```

#### Response (一部失敗の場合 207 Multi-Status)

```json
{
  "uploaded": [{ "filename": "...", "status": "success" }],
  "failed": [
    {
      "filename": "RG-2025-001234.pdf",
      "status": "duplicate",
      "detail": "既に同名ファイルが存在します"
    }
  ]
}
```

#### 制限

| 項目 | 上限 |
|---|---|
| 1 リクエストあたりのファイル数 | 100 |
| 1 ファイルあたりのサイズ | 20 MB |
| 1 リクエスト合計サイズ | 100 MB |
| Content-Type | `application/pdf`, `text/csv`, `application/vnd.ms-excel` |

---

## 6. 認証・認可

### 6-1. (推奨) Bearer API Key

最も簡単で確実な方式。

#### Wellfort 側で必要な作業

環境変数に Scan-Chat-AI から発行された API Key を保存:

```
# Wellfort HP の .env (or 同等の secret store)
SCAN_CHAT_AI_API_KEY=<scan_chat_ai_admin_api_key>
SCAN_CHAT_AI_BASE_URL=https://scan-chat-ai.vercel.app
```

リクエスト時:

```javascript
fetch(`${SCAN_CHAT_AI_BASE_URL}/api/admin/lab-results/check`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SCAN_CHAT_AI_API_KEY}`,
  },
  body: JSON.stringify({ ... }),
})
```

#### Scan-Chat-AI 側

- Vercel 環境変数 `ADMIN_API_KEY` に同じ値を登録
- API ルートで `Authorization` ヘッダを検証
- Wellfort の IP 等での追加制限はしない (admin API key で十分)

### 6-2. (代替) Google OAuth ID Token (Phase 2.0)

Wellfort 管理画面が Google OAuth でログイン済の場合、その ID Token を
そのまま Scan-Chat-AI に渡し、Scan-Chat-AI 側で:
- ID Token を verify
- `email` が `admin_users` テーブル (Wellfort 側) にあるか確認
- OK なら処理続行

→ 将来 Phase 2.0 で検討、Phase 1.0 では Bearer API Key 採用。

---

## 7. ファイル処理ロジック (Scan-Chat-AI 側)

### 7-1. 顧客自動紐付け (Workflow 1: CSV 連携)

血液検査 (リージャー) の場合、CSV に検査ID (`RG-2026-001045`) が記載されており、
Scan-Chat-AI 側で `customer.lab_tests.external_test_id` に予め登録されていれば、
自動で顧客に紐付く。

```
1. CSV/PDF をアップロード
2. ファイル名 → 検査ID 抽出 (`RG-2026-001045`)
3. customer.lab_tests に検査ID で検索
4. 一致すれば customer_id / diagnostic_user_id を取得して紐付け
5. test_artifacts レコード作成
```

### 7-2. 顧客手動紐付け (Workflow 2/3)

PDF のみで外部検査IDが特定できない場合、`customer_assigned: false` で
アップロード後、Wellfort 担当者が後で手動割当。

### 7-3. 重複判定

判定基準: **`lab_company + filename`** の組み合わせ

- 同じ lab_company で同じファイル名が既存なら `duplicate`
- ハッシュベース判定は Phase 1.5 で検討

### 7-4. アップロード成功時の処理

```
1. Supabase Storage の private bucket "lab-results" に保存
   path: lab_results/{lab_company}/{YYYY}/{MM}/{filename}
2. diagnosis.test_artifacts に INSERT:
   - source: 'wellfort_lab'
   - test_type, lab_name, etc.
3. diagnosis.test_artifact_files に raw_pdf_redacted / raw_csv を INSERT
4. (非同期) Edge Function or queue で Elith / Gemini に解析依頼
   - 結果は後で diagnosis.diagnosis_results に反映
```

---

## 8. エラーハンドリング

| 状況 | HTTP | レスポンス例 | UI 表示 |
|---|---|---|---|
| 認証失敗 | 401 | `{"error": "unauthorized"}` | 「API キーが無効です。管理者に問い合わせてください」 |
| 重複ファイル | 207 | `failed: [{ status: 'duplicate' }]` | 「⚠️ 既に同名ファイルが存在します」 |
| ファイル形式 NG | 400 | `{"error": "unsupported file type"}` | 「⚠️ PDF/CSV のみアップロード可能です」 |
| サイズ超過 | 413 | `{"error": "file too large"}` | 「⚠️ ファイルサイズが上限を超えています」 |
| Scan-Chat-AI 側エラー | 5xx | `{"error": "internal error", "detail": "..."}` | 「⚠️ サーバエラー。時間を置いて再試行を」 |

---

## 9. ストレージ仕様 (Scan-Chat-AI 側 — 参考)

```
Supabase Storage Bucket: lab-results (private)
├── rieger/
│   └── 2026/05/
│       ├── RG-2026-001045.pdf
│       └── RG-2026-001045.csv
├── prevent/
│   └── 2026/05/
│       └── K1080.pdf
├── genoplan/
│   └── 2026/03/
│       └── CBAD-XXXX-XXXX.pdf
└── laif/
    └── 2026/04/
        └── LAIF-2026-04-001.pdf
```

アクセスは service_role key のみ (Wellfort 担当者は Scan-Chat-AI を介して取得)。

---

## 10. テスト項目

| # | 項目 | 期待動作 |
|---|---|---|
| 1 | 検査機関選択 | 4 機関 (リージャー/PREVENT/Genoplan/LAiF) が選べる |
| 2 | 単一ファイル選択 | 1 件選択して表示 |
| 3 | 複数ファイル選択 | 10 件選択して一覧表示 |
| 4 | 重複チェック自動実行 | 既存ファイル名は ⚠️ 重複、新規は ✅ 新規 |
| 5 | 重複チェックOFFのまま処理 | 重複ファイルはアップロード対象外 |
| 6 | アップロード進行表示 | プログレスバーで完了率表示 |
| 7 | アップロード完了表示 | 成功 / 失敗 / 顧客割当の有無を一覧 |
| 8 | API キー誤り | 401 エラー → わかりやすいメッセージ |
| 9 | サイズ超過 | 413 エラー → ファイル名と上限明示 |
| 10 | 同時アップロード上限 | 100 件超は分割 / 警告 |

---

## 11. スケジュール想定

| フェーズ | 内容 | 担当 | 期間 |
|---|---|---|---|
| 1 | 仕様レビュー | 両者 | 1 日 |
| 2 | **Scan-Chat-AI 側 API 実装** | UNFIX | 3-5 日 |
| 3 | **Wellfort 管理画面 UI 実装** | Wellfort 開発 | 3-5 日 |
| 4 | 結合テスト (Staging) | 両者 | 2 日 |
| 5 | 本番リリース | Wellfort | 半日 |

---

## 12. Scan-Chat-AI 側 API 提供スケジュール

| API | 実装予定 |
|---|---|
| 重複チェック (`/api/admin/lab-results/check`) | 仕様確定後 1 週間 |
| 一括アップロード (`/api/admin/lab-results/upload`) | 同上 |
| ADMIN_API_KEY 発行 | 仕様確定時 |

実装完了後、Wellfort 開発担当に API Key と疎通テスト URL を共有します。

---

## 13. 連絡先

- **Scan-Chat-AI 開発元**: アンフィックスエンターテイメント株式会社 (担当: 濱田)
  - メール: hamada@eentry.co.jp
- **API 仕様に関する質問・調整**: 上記まで

---

## 付録 A: ファイル命名規則 (参考)

### A-1. リージャー血液検査
- 形式: `RG-YYYY-NNNNNN.pdf` / `RG-YYYY-NNNNNN.csv`
- 例: `RG-2026-001045.pdf`
- 外部検査ID: ファイル名から抽出可能 (CSV キー連携)

### A-2. PREVENT がんリスク
- 形式: `KNNNN.pdf`
- 例: `K1080.pdf`
- 外部検査ID: ファイル名から抽出可能

### A-3. Genoplan 遺伝子検査
- 形式: `XXXX-XXXX-XXXX.pdf` (検査キー)
- 例: `CBAD-DMID-BOAQ.pdf`
- 外部検査ID: ファイル名 = 検査キー

### A-4. LAiF AI 疾病予測
- 形式: `LAIF-YYYY-MM-NNN.pdf`
- 例: `LAIF-2026-04-001.pdf`
- 外部検査ID: ファイル名から抽出可能

※ 検査機関側のファイル命名規則に変更があれば、本仕様の更新が必要。

---

## 付録 B: 将来拡張 (Phase 2.0)

### B-1. 検査機関 API 直接連携
- 各検査機関と SFTP / REST API 連携を確立
- Wellfort 担当者の手動 DL → ZIP アップロードを廃止
- Scan-Chat-AI 側で自動受信 → 解析 → 顧客通知

### B-2. SSO 連携
- Wellfort 管理者の Google OAuth セッションを Scan-Chat-AI に引継ぎ
- Bearer API Key → ID Token Bearer 方式に移行

### B-3. アップロード後の顧客自動マッチング
- PDF を OCR して受診者氏名 / 生年月日 / 検査ID を抽出
- customer_profiles と fuzzy match
- 信頼度 95% 以上は自動紐付け、それ以下は確認画面
