# Elith AI 診断結果 統合仕様

| 項目 | 内容 |
|---|---|
| 文書名 | Elith AI 診断結果 統合仕様 |
| バージョン | 0.1 (Draft) |
| 作成日 | 2026-05-28 |
| 対象範囲 | Elith から戻る `diagnostic_result` JSON の受信・保管・ダッシュボード変換ロジック |
| 関連文書 | `docs/architecture/diagnostic_session_data_spec.md §3.4` (JSON フォーマット定義) / `docs/architecture/test_data_storage_and_db_design.md §6.4` (3 モード表示) / `docs/architecture/wellfort_app_design_concept.md §2` (4 UI アプローチ) / `docs/architecture/data_integration_requirements.md §6 EF-6` (callback) |
| 実サンプル | `docs/elith/2026_05_24 Elith_demo.json` |

---

## 1. 文書範囲

Elith AI が生成した診断レポート JSON を、本アプリの**「行動を促すダッシュボード」**にどう変換し、どこに保管するかを規定する。

### 範囲内
- `diagnostic-ai-callback` 受信後のデータフロー
- ストレージ階層 (`diagnosis_results` + 派生 artifacts)
- JSON → ダッシュボード UI への**二次変換ロジック** (Gemini 2.5 Flash 利用)
- 3 モード表示 (a/b/c) への割当
- インラインマーカ (`【sub】` / `[N]`) のパース・deep-link 実装

### 範囲外
- JSON 構造そのもの (→ `docs/architecture/diagnostic_session_data_spec.md §3.4`)
- Elith 側の推論ロジック (→ Elith 社内資料)
- 検査結果 PDF/scan_md の保管 (→ `docs/architecture/test_data_storage_and_db_design.md`)

---

## 2. Elith JSON 受信フロー

### 2.1 全体シーケンス

```
[Elith AI バッチ]
     │
     │ HTTPS POST + HMAC 署名
     ▼
[App-side Edge Function: diagnosis-ai-callback (EF-6)]
     │
     ├ ① 署名検証 (data_integration_requirements §6 EF-6)
     ├ ② payload 解析 → diagnostic_user_id 抽出
     ├ ③ diagnosis_results に raw JSON を upsert
     │
     ├ ④ 二次変換 (非同期 job 起動)
     │    └ Gemini 2.5 Flash で JSON → ダッシュボード用構造化データ
     │    └ test_artifact_items 相当の項目を生成
     │
     ├ ⑤ a) サマリー = アブストラクト セクションを切り出し
     ├ ⑥ b) 要注意 = 医療受診の目安 + 二次抽出の高リスク項目
     ├ ⑦ c) 全編 = JSON のまま保管
     │
     └ ⑧ Realtime チャネルで FE に「結果到着」通知 → ダッシュボード再描画
```

### 2.2 受信側のペイロード形

Edge Function が受け取る payload (`data_integration_requirements §6 EF-6` の `{ diagnosis_user_id, job_id, result: {...} }` 形):

```json
{
  "diagnosis_user_id": "7b3f8c2d-9e4a-4b1c-...",
  "diagnostic_id": "...",
  "job_id": "elith-2026-05-24-abc123",
  "elith_model_version": "v1.2.0",
  "result": [
    { "section_name": "アブストラクト", "char_count": 1247, "text": "..." },
    ...
  ]
}
```

→ `result` 内側が `docs/architecture/diagnostic_session_data_spec.md §3.4` 定義の配列。

---

## 3. ストレージ設計

### 3.1 `diagnosis_results` (App-side Supabase #2)

`docs/architecture/data_integration_requirements.md §5` の既存テーブルに以下のカラムで保管:

```sql
create table diagnosis_results (
  id                  uuid primary key default gen_random_uuid(),
  diagnostic_user_id  uuid not null references app_users(diagnostic_user_id),
  diagnostic_id       uuid not null,
  report              jsonb not null,           -- Elith JSON の配列をそのまま
  schema_version      text not null default 'elith-v1.0',
  elith_job_id        text,                      -- 監査用
  elith_model_version text,                      -- Elith 側のモデルバージョン
  received_at         timestamptz not null default now(),
  -- 二次変換結果へのリンク
  summary_text        text,                      -- a) サマリー版 (アブストラクト原文)
  highlights_text     text,                      -- b) 要注意抜粋 (二次変換出力)
  extracted_at        timestamptz,               -- 二次変換完了時刻
  extracted_by_model  text,                      -- 例: 'gemini-2.5-flash'
  status              text not null default 'received',  -- received | extracted | published | superseded
  unique (diagnostic_user_id, diagnostic_id)
);
create index on diagnosis_results(diagnostic_user_id, received_at desc);
```

### 3.2 `diagnosis_result_items` (`test_artifact_items` と同設計)

ダッシュボードカードや b) 要注意抜粋の各項目を行展開:

```sql
create table diagnosis_result_items (
  id                  uuid primary key default gen_random_uuid(),
  diagnosis_result_id uuid not null references diagnosis_results(id) on delete cascade,
  source_section      text not null,             -- '検査値フィードバック' 等
  source_subsection   text,                      -- '【腎機能・尿酸】' 等 (【】 マーカ)
  item_kind           text not null,             -- 'metric' | 'alert' | 'action' | 'reference' | 'menu' | 'situational_card'
  item_name           text,                      -- '尿酸' / '緑内障の疑い' / '水分2L'
  value_text          text,                      -- '8.4 mg/dL H' / '今週中に眼科' / '1日2リットル'
  risk_level          text,                      -- 'high' | 'slightly_high' | 'normal' | 'slightly_low' | 'low'
  is_actionable       boolean,                   -- b) 抽出フラグ
  priority            int,                       -- ピン留め優先度 (0=最優先)
  citation_indexes    int[],                     -- 例: [14, 15] = リファレンス [14][15] へリンク
  summary_line        text,                      -- カード表示用 1-2 行
  order_in_dashboard  int,                       -- ダッシュボードでの表示順
  order_in_summary    int,                       -- a) サマリー版での表示順
  order_in_highlights int,                       -- b) 要注意抜粋での表示順
  created_at          timestamptz not null default now()
);
create index on diagnosis_result_items(diagnosis_result_id, item_kind);
create index on diagnosis_result_items(diagnosis_result_id, priority);
```

### 3.3 元 JSON の保管

`diagnosis_results.report` (jsonb) に**原文配列をそのまま**保存。

理由:
- Elith 仕様変更時に**再抽出**できる
- ユーザーからの「c) 全編」表示要求に応える
- 監査要件 (10 年保管)

---

## 4. 3 モード表示への変換マップ

`docs/architecture/test_data_storage_and_db_design.md §6.4` の 3 モード設計を Elith レポートに適用:

| モード | 取得元 | 生成方法 |
|---|---|---|
| **a) サマリー版** | `report[0].text` (= `アブストラクト` セクション) | **Elith が既に生成済**。LLM 再生成不要 |
| **b) 要注意事項抜粋版** | `report[7].text` (= `医療受診の目安`) + 二次抽出の高リスク項目 | 二次変換 LLM が `diagnosis_result_items` に書き込み |
| **c) 全編** | `report[*]` 全 10 セクション | jsonb のまま `marked` でレンダリング |

### 4.1 サマリー版の「コスト ゼロ」効果

Elith が `アブストラクト` を自前生成してくれているため:
- 我々の **a) サマリー LLM 生成コストはゼロ** (`docs/architecture/test_data_storage_and_db_design.md §6.4` で見積もった ~$0.008 が不要)
- 表示瞬時 (LLM 待ちなし)
- ハルシネーション源が 1 つ減る (Elith の品質に委譲)

### 4.2 適用判定 (5 pg 以上ルールへの当てはめ)

Elith レポートは合計 ~21,000 字 ≈ **10〜15 ページ相当**。`docs/architecture/test_data_storage_and_db_design.md §6.4` の **5 ページ以上で 3 モード自動 ON** ルールに該当 → **常に 3 モード適用**。

---

## 5. ダッシュボードカードへの二次抽出

`docs/architecture/wellfort_app_design_concept.md §2` の **4 UI アプローチ**にあるダッシュボード要素を、Elith JSON から二次抽出する:

### 5.1 抽出対象マップ

| UI 要素 | 取得元セクション | 抽出粒度 |
|---|---|---|
| 🔴 緊急アラート (ピン留め) | `医療受診の目安` | 最大 1-2 件、`item_kind='alert' priority=0` |
| 🟢🟡🟠 指標カード (3-5 個) | `検査値フィードバック` の `【sub】` ごと | `item_kind='metric'`, `value_text` に「8.4 mg/dL H」原文コピー |
| 📋 デイリークエスト | `運動アドバイス` `食事アドバイス` から `週N回M分` `1日2L` パターン | `item_kind='action' is_actionable=true` |
| 🍱 シチュエーション別カード (食事) | `食事アドバイス` の 【和定食】【洋定食】【コンビニ】等 | `item_kind='situational_card', source_subsection` 保持 |
| 💆 シチュエーション別カード (睡眠/ストレス) | `睡眠・ストレス管理` の 【リラクゼーション】【趣味】等 | 同上 |
| 💊 サプリ提案カード | `必要とする栄養素/サプリ情報` | `item_kind='action', priority=低` |

### 5.2 二次抽出 LLM プロンプト方針

```
モデル: Gemini 2.5 Flash
入力: report (jsonb 全体、約 21K 字)
出力: 構造化 JSON (diagnosis_result_items に行展開する形)
プロンプト要件:
  - 数値は原本から逐語コピー (例: "8.4 mg/dL H")
  - 引用 [N] が含まれる行は citation_indexes に N を抽出
  - is_actionable 判定: 生活習慣の改善で軽減できるなら true
  - priority 判定: '医療受診の目安' から抽出した項目は 0 (最優先)
  - 各項目に source_section + source_subsection を必ず付与 (trace 可能性)
ハルシネーション抑止:
  - 出力 JSON に元 text のスニペットを quote として併記
  - レビュー UI で元セクション該当箇所にジャンプ可能にする
```

### 5.3 抽出コスト

| 工程 | トークン | コスト |
|---|---|---|
| 入力 (約 21K 字 = ~10K トークン) | 10K | $0.003 |
| 出力 (構造化 JSON、~3K トークン) | 3K | $0.008 |
| **計** | | **~$0.011 / 件 (~1.7 円)** |

→ Elith レポート 1 件あたり**2 円弱**。ユーザー 1 名年 3 回でも年 6 円。

---

## 6. インラインマーカのパース

### 6.1 `【sub-section】` マーカ

セクション内部の構造化に使用。例: 検査値フィードバック内の `【血圧】` `【脂質代謝】` `【糖代謝】` 等。

**パース戦略**:
- 正規表現 `/【([^】]+)】/g` で見出しを抽出
- 見出し間のテキストをサブセクションとして切出
- レンダリング時は `<h4>` 相当の見出しとして表示

### 6.2 `[N]` 引用マーカ

`リファレンス` セクション内の `[1]`〜`[30]` に対応するリンク。

**パース戦略**:
- 正規表現 `/\[(\d+)\]/g` で番号抽出
- `リファレンス.text` を改行で分割し、`[1] ...` 形式の行を辞書化
- 本文中の `[14]` をタップ可能なリンク化、リファレンスセクションの該当行にスクロール
- `c) 全編表示` 時に有効。a/b では「出典あり」バッジのみ表示

### 6.3 c) 全編内の deep-link 実装

- 各 `section_name` を URL hash として割当: `#section=食事アドバイス`
- 各 `【sub】` を二次 hash: `#section=食事アドバイス&sub=和定食`
- `diagnosis_result_items.order_in_dashboard` から飛ぶ deep-link target

---

## 7. ダッシュボード描画フロー

```
[受信] EF-6 が JSON 受領
    │
    ├ ① diagnosis_results に raw 保存 (status='received')
    │
    ├ ② Realtime: FE に「結果到着」通知 → ダッシュボードに「処理中」スピナー
    │
    ├ ③ 非同期 job: 二次抽出 LLM 起動 (Gemini 2.5 Flash)
    │    └ 結果を diagnosis_result_items に bulk insert
    │    └ diagnosis_results.status='extracted'
    │
    ├ ④ Realtime: 「準備完了」通知 → FE が再描画
    │
    └ ⑤ FE が表示:
         - a) サマリー版 = report[0].text (Elith のアブストラクト)
         - b) 要注意 = diagnosis_result_items where is_actionable, priority asc
         - c) 全編 = report jsonb をセクション順に Markdown レンダリング
         - 🔴 緊急アラート = diagnosis_result_items where item_kind='alert'
         - 🟢🟡🟠 指標カード = item_kind='metric' top N
         - デイリークエスト = item_kind='action' is_actionable=true top 2
         - シチュエーション別カード = item_kind='situational_card'
```

---

## 8. Phase 別実装計画

### Phase 1.0 (本格運用初期)
- [ ] `diagnosis_results` テーブル追加 (既存 `data_integration_requirements §5` の概念を実装)
- [ ] `diagnosis_result_items` テーブル新設
- [ ] EF-6 (`diagnosis-ai-callback`) 実装、HMAC 署名検証
- [ ] 二次抽出 LLM ジョブ (Gemini 2.5 Flash)
- [ ] a/b/c 3 モード切替 UI (汎用、`docs/architecture/test_data_storage_and_db_design.md §6.4` に倣う)
- [ ] ダッシュボードカード描画 (4 UI アプローチ、`docs/architecture/wellfort_app_design_concept.md §2`)
- [ ] `【sub】` `[N]` パース
- [ ] Realtime 通知

### Phase 1.5
- [ ] 二次抽出のチューニング (運用ログから priority 判定見直し)
- [ ] ユーザーからのフィードバック (「このカードは不要」等) を反映する学習ループ
- [ ] Elith スキーマ変更時の `schema_version` 切替

### Phase 2
- [ ] Elith に**構造化フィールド追加を交渉** (`urgent_actions[]`, `key_findings[]` 等) → 二次抽出コスト削減
- [ ] 経時比較表示 (前回 vs 今回の `diagnosis_results` を並列表示)
- [ ] エクスポート機能 (PDF / メール送信)

---

## 9. 未確定事項 (TBD)

- [ ] 二次抽出ジョブの非同期実装方式 (Edge Function 内で同期 vs キュー経由非同期)
- [ ] 緊急アラート (`item_kind='alert'`) の表示数上限 (1 件? 2 件?)
- [ ] デイリークエストの抽出上限 (2 件推奨だが運用で要調整)
- [ ] シチュエーション別カードのソート優先度 (時間帯? ユーザー嗜好?)
- [ ] 引用 [N] が複数 (例: [22][24][25]) の場合の UI (1 つだけ表示 / 全部展開)
- [ ] Elith スキーマ更新時の旧フォーマット結果の表示互換性 (`schema_version` で切替)
- [ ] 二次抽出失敗時のフォールバック (LLM エラー時 → 最低限 a/c だけ表示)
- [ ] FE で Markdown レンダリング時の `marked` 設定 (改行 LF 解釈、`【】` のスタイリング)
- [ ] 結果到着 Realtime 通知のチャネル (Supabase Realtime / 自前 Pusher)
- [ ] 「アブストラクト」が短すぎる/長すぎるケースのフォールバック (Elith 仕様準拠で対応)

---

## 10. 変更履歴

| Ver | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-28 | 初版。実サンプル `docs/elith/2026_05_24 Elith_demo.json` (10 セクション 21K 字) を解析、3 モード設計との対応 (a=アブストラクト/b=医療受診目安+抽出/c=全文)、ダッシュボード 4 UI への二次抽出ロジック、`diagnosis_results` + `diagnosis_result_items` テーブル、`【】` `[N]` パース戦略、Phase 別実装計画を規定 |
