# スキャン機能 要件定義書

| 項目 | 内容 |
|---|---|
| 文書名 | Scan-Chat Medical AI — スキャン機能 要件定義書 |
| バージョン | 0.3 (Draft) |
| 作成日 | 2026-05-22 |
| 最終更新 | 2026-05-24 |
| 作成者 | UNFIX Entertainment |
| 対象機能 | カメラスキャン + ユーザー検証 UX（提案書「機能1」相当） |
| 関連文書 | `docs/proposals/scan_chat_medical_ai_proposal.pdf`（UI/UX 総合仕様提案書）/ `docs/architecture/diagnostic_session_data_spec.md` §3.2 |

> **v0.3 の重要変更 (2026-05-24)**: 旧 JSON `ScanItem` ベースの設計は廃止。現在は Gemini 監査官モードによる **9 列 Markdown 表** を生成し、その後 **「ユーザー検証フェーズ」** (§5) で **セル単位** に疑念を解消してから下流診断 AI へ渡す。本書では旧仕様の節 (§4 F-3 / F-5 / F-6、§7 旧 API、§8.1 旧 ScanItem) に Deprecated タグを付け、新フローを §5 と §4 F-11〜F-15 に追加した。

---

## 1. 概要

### 1.1 目的

健康診断結果・人間ドック・検査報告書など「形式が標準化されていない紙ベースの医療文書」を、ユーザーがカメラでスキャンするだけで構造化データに変換し、後続のチャット問診で利用可能な状態にする。

ユーザーが「AI が正しく数値を認識しているか」という不安を抱かないよう、撮影前から AR 枠が吸い付き、撮影後にはデジタルオーバーレイで結果を可視化する。

### 1.2 背景

- 紙の医療報告書は手書き修正・医師メモが混在し、データ化の障壁が高い。
- 既存のフォーム入力は離脱率が高く、起点となる客観データが得られない。
- マルチモーダル LLM（Gemini Vision）により、汎用的なフォーマット適応が可能になった。

### 1.3 用語

| 用語 | 定義 |
|---|---|
| **領域 (region / RegionResult)** | 検査表の論理ブロック (左側検査表、右側手書きメモ等)。Markdown 上は H2 (`## ラベル`) + 直後の HTML コメント `<!-- bbox: ymin,xmin,ymax,xmax -->` で表現。最大 4 領域 |
| **bbox** | bounding box。`[ymin, xmin, ymax, xmax]` を **0.0–1.0** で正規化した配列で表現する (Gemini 慣例の 0–1000 ピクセル正規化ではない点に注意) |
| **scan_md (確定 Markdown)** | ユーザー検証フェーズを通過した、推論値列を除去した 9 列 Markdown。Supabase #2 と下流診断 AI への送信フォーマット。詳細は `docs/architecture/diagnostic_session_data_spec.md` §3.2 |
| **疑念セル (suspicious cell)** | Gemini 出力のうち、§5.3 の 5 つのヒューリスティック (`(?)/??` / 備考タグ / [強調]/H/L マーカ / 判定列 H/L / 桁数異常) のいずれかに該当する個別セル |
| **解消 (resolved)** | 疑念セルがユーザーの「直接修正」または「このまま OK」アクションでマークされた状態。表示は緑 |
| **トリミング画像** | 検証画面上部に表示される、撮影画像のうち全領域 bbox の union (+2% padding) だけを切り出した画像。各領域 bbox は再正規化して上に重畳描画する |
| **PHI** | Protected Health Information。個人を特定可能な医療情報 |
| ~~AR ハイライト~~ (Deprecated) | 旧仕様。F-3 参照 |
| ~~ScanItem / priority_flags / observations~~ (Deprecated) | 旧 JSON モデル。v0.3 で全廃。互換性も保たない |

---

## 2. スコープ

### 2.1 含むもの (In Scope)

- カメラ起動・停止
- AR 連続検知（プレビュー中の bbox 重畳描画）
- 撮影確定時のフル解析（observations / regions / items / priority_flags / urgent）
- デジタル・オーバーレイ表示
- 確信度別の色分け表示
- 補足プロンプト入力（部位・状況の自由記述）
- 解析結果の構造化 JSON 取得
- 後続チャット問診への引継ぎ用データ整形（チャット側で利用するための形）

### 2.2 含まないもの (Out of Scope)

- スキャン結果の Supabase 永続化（次フェーズ）
- 外部 AI 診断システムへの送信（次フェーズ）
- 動画録画・連続フレームの履歴保存
- 複数枚スキャン → 1セッションへの統合（次フェーズ）
- 印鑑・QR コード・バーコード認識
- 顔・体表の医学的所見の自動診断（提案書方針に従い「観察記述のみ・診断はしない」）
- オフライン動作

---

## 3. ユースケース

### UC-1: 健診結果用紙のスキャン
利用者が自宅で健診結果用紙にカメラをかざし、AR 枠で項目が検知されるのを確認し、シャッターを押す。撮影後、項目ごとの認識結果がオーバーレイ表示され、誤りがないか目視確認できる。

### UC-2: 手書きメモを含む報告書
医師の手書きメモを含む報告書をスキャン。手書き部分は黄色枠で強調され、「次のチャット問診で確認します」と扱われる。

### UC-3: 体表の所見写真
皮膚の状態など、文字情報ではない撮影に対しては `observations`（観察所見）・`regions`（部位）・`follow_up_questions`（次に確認すべき質問）が構造化 JSON で返る。

### UC-4: 緊急性の検知
重大所見が示唆される場合は `urgent: true` を返し、UI で警告を表示する（実装は本要件のスコープ）。

---

## 4. 機能要件

### F-1: カメラ起動

| 項目 | 内容 |
|---|---|
| 入力 | ユーザーが「カメラ起動」ボタンを押下 |
| 処理 | `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })` で背面カメラを優先取得 |
| 出力 | `<video>` 要素に MediaStream を割当て、プレビューを再生 |
| 例外 | 権限拒否・カメラ無し → 「カメラを起動できませんでした: <理由>」を `status` に表示 |
| UI | `.btn-primary` ボタン。起動成功で disabled 化、停止ボタンを enabled |

### F-2: カメラ停止

| 項目 | 内容 |
|---|---|
| 入力 | 「停止」ボタン押下 / ページ離脱 |
| 処理 | 取得済 MediaStreamTrack を `stop()`、video の srcObject を null、AR 検知ループを停止、オーバーレイを clear |
| 出力 | プレビュー停止、検知結果クリア |
| 後処理 | 起動ボタンを enabled に戻す |

### ~~F-3: AR 連続検知ハイライト~~ (Deprecated, v0.3)

UI 上のトグル (`#scan-detect-toggle`) は残置されているが、現在の実装ではハンドラを持たない。
旧仕様: `mode: 'detect'` で 1.8s 間隔のフレーム送信 → bbox オーバーレイ。
廃止理由: Gemini 監査官モードに統一し、検証フェーズ (§5) でユーザーが値を吟味するフローに置換。
復活する場合は新フローと両立する設計を別途検討すること。

### F-4: 撮影 & フル解析 (v0.3 改定)

| 項目 | 内容 |
|---|---|
| 入力 | 「📷 撮影 & 解析」ボタン押下 |
| 処理 | フルサイズ JPEG (品質 0.85) フレームを取得 → `/api/scan` に `{ image, hint? }` で POST |
| サーバ処理 | `gemini-2.5-flash` を監査官モード system prompt + 9 列 + 推論値列の 10 列フォーマットで呼び出し |
| 出力 | `{ markdown, finishReason }` の JSON。Markdown には H2 領域 + bbox HTML コメント + GFM テーブル |
| クライアント後処理 | `stripColumnFromTables` で「推論値/推定値」列を除去 → `markdownClean` を生成 → `parseMarkdownRegions` で `RegionResult[]` に分解 |
| 画面遷移 | 解析完了で `panel-result` を表示 (§5) |
| ステータス | 「Gemini Vision に送信中…」→「解析完了。」/ 失敗時はエラー文 |
| 排他制御 | 解析中は撮影ボタン disabled |

### ~~F-5: デジタル・オーバーレイ (旧仕様)~~ (Deprecated, v0.3)

旧仕様の「画像上に label: value をテキスト重畳」描画は廃止。
現在は §5.2 の **トリミング画像 + 領域 bbox オーバーレイ** に置き換わっている。テキスト重畳ではなくブロックタップで詳細パネルに展開する方式。

### ~~F-6: 確信度別の色分け (旧仕様)~~ (Deprecated, v0.3)

旧仕様の `confidence: high/low` ベース色分けは廃止 (Gemini 監査官モードは confidence を返さない)。
現在は §5.4 の **検証ステータス** ベース色分け (黄=未解消疑念セル / 緑=解消済セル or 元から OK)。

### F-7: 補足プロンプト

| 項目 | 内容 |
|---|---|
| 入力 | テキスト入力欄（任意、最大 200 文字推奨） |
| 用途 | フル解析時のヒントとして API に同送（例:「右前腕、3日前から赤み」） |
| バリデーション | 空文字は送信しない。前後の空白は trim |

### F-8: 後続チャット問診への引継ぎ

| 項目 | 内容 |
|---|---|
| 引継ぎ対象 | `priority_flags`、`items` のうち低信頼項目、`urgent` フラグ |
| 引継ぎ手段（現在） | 解析結果を `/api/chat` の `systemHint` に文字列化して渡す（フロントで整形） |
| 引継ぎ手段（次フェーズ） | Supabase の `scan_results` テーブルに保存し、`session_id` で参照 |

### F-9: 撮影前ガイド枠

| 項目 | 内容 |
|---|---|
| 内容 | プレビューの内側に白枠を表示し、被写体配置の目安を示す |
| 実装 | CSS の `absolute inset-4 border-2 border-white/70` |

### F-10: 凡例表示

| 項目 | 内容 |
|---|---|
| 内容 | プレビュー左上に「●高信頼 / ●要確認」の凡例を常時表示 |
| 目的 | 黄色ハイライトの意味をユーザーが直感的に理解できるよう補助 |

### F-11: 表全体のトリミング画像 + bbox オーバーレイ (v0.3 追加)

| 項目 | 内容 |
|---|---|
| 入力 | F-4 完了後の `AnalyzeResult` (特に `fullImage` + `regions[].bbox`) |
| 処理 | 1. 全領域 bbox の union を算出 (各方向に 0.02 パディング)<br>2. `<canvas>` で当該範囲を切り出して JPEG dataURL 化 (`trimImage`)<br>3. 各領域 bbox を union 内座標に再正規化<br>4. トリミング画像の上に半透明ボタン (`<button>`) を絶対配置 |
| 色 | 緑 = 領域内全行 OK / 黄 = 1 件以上未解消 / 赤 = 表が無い領域 (現状未到達) |
| インタラクション | ボタンタップで詳細パネル (F-12) を展開し、`scrollIntoView({behavior:'smooth'})` |

### F-12: ブロック詳細パネル + セル単位着色 (v0.3 追加)

| 項目 | 内容 |
|---|---|
| 入力 | 選択された `RegionResult` |
| 処理 | `parseTable` で GFM テーブルを headers + rows に分解 → HTML `<table>` として描画 |
| セル着色 | セル単位:<br>- 元から疑念なし: 通常表示<br>- 疑念セル 未解消: 黄背景 + bold<br>- 疑念セル 解消済 (編集 or OK): 緑背景 + `✎` プレフィクス (編集済の場合) |
| 行クリック | 元から疑念ありの行はクリック可 (解消済でも再修正用に維持)。元から OK の行はクリック不可 |
| クリック動作 | F-13 の行修正モーダルを開く |

### F-13: 行修正モーダル (セル単位、v0.3 追加)

| 項目 | 内容 |
|---|---|
| 入力 | クリックされた行の `RegionResult` + rowIdx |
| レイアウト | フルスクリーンオーバーレイ (`fixed inset-0`)、下部 sheet (md: center) |
| 表示単位 | 行内の **全セル** を 1 セル = 1 カードとして縦に列挙 (ヘッダラベル + input + ステータス) |
| カード色 | 元から疑念なし = 灰枠 / 疑念あり未解消 = 黄枠 / 疑念あり解消済 = 緑枠 |
| 入力 | 1 行 input。元から疑念ありのセルには「✓ このまま OK」ボタンを併設 |
| 解消条件 | (a) input 値が元と異なる (= 編集) / (b)「このまま OK」押下 のいずれか |
| 自動色変化 | 入力 or OK 押下で即時に該当カードが緑へ遷移 |
| ローカル状態 | モーダル内のドラフトは「保存」押下まで永続化されない (キャンセル可能) |
| 保存ボタン | ラベルに残未解消数を表示 (`💾 保存して閉じる (残 N 件)`)。残 0 のとき青、残ありで黄 |
| 永続化 | 「保存」で `state.rows[${regionIdx}:${rowIdx}].cells[${cellIdx}] = { edited?, userConfirmed: true }` を localStorage に書込 |

### F-14: 検証ゲート + 確定送信 (v0.3 追加)

| 項目 | 内容 |
|---|---|
| 入力 | 検証 state |
| 行 OK 判定 | 行内の **元から疑念ありセル全て** が「編集 (値が元と異なる)」または「userConfirmed=true」のとき OK |
| 領域ステータス | 領域内に未 OK 行があれば黄、全行 OK なら緑 |
| サマリ表示 | `N 領域 / M 行 / K 件 要確認` を panel-result 先頭に表示 |
| 送信ボタン | 全領域緑になるまで disabled。ラベルに残数 (`✓ 確認して送信 (残 K 件)`) |
| 確定動作 | `window.confirm` 経由で同意取得 → `/chat` へ遷移 |
| 永続化 (Phase 0) | 現状はメモリ保持のみ。`/chat` 側は別途 sessionStorage 連携を Phase 1 で追加予定 |
| 永続化 (Phase 1) | `assembleMarkdownClean(regions, cellOverrides)` で確定 `scan_md` を再構築し、`scan_artifacts.content` に書込 (`docs/architecture/diagnostic_session_data_spec.md` §3.2) |

### F-15: 検証状態の localStorage 永続化 (v0.3 追加)

| 項目 | 内容 |
|---|---|
| キー | `scan-chat-ai.verification.${diagnostic_id}` |
| 値スキーマ | `{ rows: Record<"${regionIdx}:${rowIdx}", { cells: Record<cellIdx, { edited?: string; userConfirmed: boolean }> }> }` |
| 復元 | ページ再ロード時に同一 `diagnostic_id` であれば検証進捗が復元される |
| 旧形式互換 | v0.2 までの `{ edited?, userConfirmed }` (行単位) は読込時に破棄 (互換性なし、dev データのみのため許容) |

---

## 5. ユーザー検証フェーズ (Verification UX) — v0.3 新設

撮影 + Gemini 監査官モードでの転記が完了した後、**確定 `scan_md` として下流診断 AI に渡される前に**、ユーザーが Gemini の認識結果を吟味するフェーズ。本機能の臨床的信頼性の中核を担う。

### 5.1 設計原則

| 原則 | 内容 |
|---|---|
| **モデル非依存** | UI は Gemini が markdown 上に出した「タグ」(`【要確認】`, `(?)`, `[強調]`, H/L) のみに依存。後段で Gemma / Qwen / Med-PaLM 等に差し替えても同じプロンプト規約を満たせば動く |
| **セル単位の解消** | 「行」ではなく「セル」を最小解消単位とする。9 列のうち 1 列だけ怪しい場合に、関係ないセルを毎回触らずに済む |
| **元紙との並列比較を前提** | 紙の検査表を手元に置いた状態で「画面の値が紙と同じか」を 1 セルずつ確認する想定。OCR の不確実性を人間が補完する |
| **修正と承認の対称性** | 「直接修正」も「このまま OK」も同等に「ユーザーが見た」シグナル。両者を区別せず行 OK 判定に使う |
| **キャンセル可能な編集** | モーダル内のセル編集は保存ボタンまで永続化されない。誤操作で状態が壊れない |

### 5.2 画面構成

```
┌─────────────────────────────────────┐
│ 📋 解析結果                          │
│ 2 領域 / 32 行 / 8 件 要確認         │  ← サマリ (F-14)
│                                       │
│ ┌─ 表全体 (タップでブロックを確認) ┐│
│ │ ┌─[#1 左側検査表]─┐              ││
│ │ │  ......          │ ← 緑 (全行OK) ││ ← トリミング画像 (F-11)
│ │ └──────────────────┘              ││
│ │ ┌─[#2 右側手書き]─┐               ││
│ │ │  ......          │ ← 黄 (5件)   ││
│ │ └──────────────────┘              ││
│ └────────────────────────────────────┘│
│                                       │
│ ┌─ #2 右側手書き ────────────── ✕ ┐│
│ │ No │ 検査項目 │ 読み取った値 │... ││ ← 詳細パネル (F-12)
│ │ 1  │ AST     │ 18           │... ││ ← 全セル緑/通常
│ │ 8  │ D-Bil   │[0.06 L]      │[L] ││ ← 値・判定セル黄
│ │ ...                                ││
│ └────────────────────────────────────┘│
│                                       │
│ [⏬ 詳細データ (開発用)]               │
│                                       │
│ [✓ 確認して送信 (残 8 件)] ← disabled│ ← 送信ゲート (F-14)
│ [もう一度撮影する]                     │
└─────────────────────────────────────┘

[モーダル: 行 D-Bil の修正]            ← F-13
┌────────────────────────────────────┐
│ ┌─ No ───────────────────────┐    │ ← 灰枠 (元から OK)
│ │ [ 8                    ]   │    │
│ └────────────────────────────┘    │
│ ┌─ 検査項目 ────────────────┐    │ ← 灰枠
│ │ [ D-Bil                ]   │    │
│ └────────────────────────────┘    │
│ ┌─ 読み取った値 ──── ⚠要確認 ┐   │ ← 黄枠 (疑念)
│ │ [ 0.06 L               ]   │    │
│ │ [✓ このまま OK]            │   │
│ └────────────────────────────┘    │
│ ┌─ 判定 ──────────── ⚠要確認 ┐   │ ← 黄枠 (H/L マーカ)
│ │ [ L                    ]   │    │
│ │ [✓ このまま OK]            │   │
│ └────────────────────────────┘    │
│ ...                                │
├────────────────────────────────────┤
│ [💾 保存して閉じる (残 2 件)]       │
└────────────────────────────────────┘
```

### 5.3 疑念セル判定ルール (5 件の OR)

| # | 条件 | 該当セル | 実装 |
|---|---|---|---|
| (a) | セル内に `(?)` または `??` を含む | そのセル | `/\(\?\)\|\?\?/.test(cell)` |
| (b) | 「備考」列に `【要確認】`/`【不整合】`/`【欠落】`/`【混線】`/`【捏造】` のいずれか | 備考セル | 列名で `findColumnIndex('備考')` |
| (c) | 「読み取った値」列に `[強調]` 注記、または ` H ` / ` L ` 等のマーカ共起 | 値セル | `/\[強調\]/`, `/[\s][HL][\s\[]\|[\s][HL]$/` |
| (d) | 「判定」列が `H` / `L` / `HH` / `LL` のいずれか | 判定セル | `cell.trim() === 'H'\|'L'\|...` |
| (e) | 「読み取った値」整数部桁数が同一表の中央値から ±2 以上乖離 | 値セル | `detectDigitAnomalies` |

(e) は周辺行に対する outlier 検出。例: ほとんどが 2-3 桁の中で `CA19-9 = 4048` のような 4 桁を flag できる。

### 5.4 検証ステータスの色対応

| ステータス | bbox オーバーレイ | テーブルセル | モーダルカード |
|---|---|---|---|
| 元から OK (疑念フラグなし) | 緑 (領域内全行 OK の場合) | 通常 (薄い緑系) | 灰枠 |
| 疑念あり 未解消 | 黄 (領域内に 1 件以上ある場合) | 黄背景 + bold | 黄枠 + 「このまま OK」ボタン表示 |
| 疑念あり 解消済 (編集 or OK 押下) | 緑 (全件解消なら) | 緑背景 + `✎` (編集済の場合) | 緑枠 |
| ユーザーが触った非疑念セル | (影響なし) | `✎` プレフィクス | 灰枠 + 「✎ 修正済」ステータス |

### 5.5 確定 `scan_md` の再構築

`assembleMarkdownClean(regions, cellOverrides)`:

```
入力: regions: RegionResult[],
      cellOverrides: Map<"${regionIdx}:${rowIdx}", Map<cellIdx, editedValue>>

処理: 各 region について
  - H2 `## ラベル` + bbox HTML コメント を出力
  - 表があれば preamble (header 行 + separator) を出力
  - 各行について:
    - その行の cellOverrides が無ければ rawLine をそのまま出力
    - あれば、各セルを `cellOverrides.get(cellIdx) ?? originalCell` で置換し
      `| ${cells.join(' | ')} |` 形式で再構築
  - 表が無ければ region.body をそのまま出力

出力: 確定 scan_md (9 列、推論値列なし)
```

これが `docs/architecture/diagnostic_session_data_spec.md` §3.2 の `scan_md` フォーマットに準拠する。

### 5.6 送信ゲート

- 全領域の **全疑念セル** が解消されるまで「✓ 確認して送信」は disabled
- 解消済の数に応じてボタンラベルが `(残 K 件)` を表示
- ヒント文も同期 (黄: `⚠ K 件の疑念がまだ未解消です` / 緑: `✓ 全行を確認しました。問診へ進めます。`)
- クリックで `window.confirm` → 同意で `/chat` へ遷移
- Phase 0 はメモリ保持のみ。Phase 1 で `assembleMarkdownClean` の結果を Supabase #2 に書込予定

### 5.7 スコープ外 (今後検討)

| 項目 | 状況 |
|---|---|
| ブロック単位の再撮影 | 暫定仕様外。現状は「もう一度撮影する」(全画像ベース再撮影) のみ提供 |
| 行追加 / 行削除 | 暫定仕様外。Gemini の出した行構造を変更する操作は提供しない |
| 単位 / 上下限値の修正 UI | 全セル編集可能なので技術的には可能。優先度は低い |
| (e) 桁数異常の閾値チューニング | 現状 ±2 固定。誤検出が問題になれば調整 |

---

## 6. 非機能要件

### 6.1 パフォーマンス

| 指標 | 目標値 | 備考 |
|---|---|---|
| AR 検知リクエスト頻度 | 約 0.55 req/sec（1.8s 間隔） | API コスト・帯域・電池消費のバランス |
| 検知用フレーム最大辺 | 720px | これ以上は精度寄与小・転送負荷増 |
| 撮影用フレーム最大辺 | 1280px | OCR 精度確保のため |
| 検知応答時間（p50） | 2.5 秒以下 | Gemini Flash 想定 |
| 撮影解析応答時間（p50） | 5 秒以下 | フル解析 |
| 初回 LCP | 2.5 秒以下 | モバイル 4G 想定 |

### 6.2 セキュリティ・プライバシー

| 項目 | 要件 |
|---|---|
| 通信 | HTTPS 必須（getUserMedia の前提条件） |
| API キー | `GEMINI_API_KEY` はサーバ側のみで保持。クライアントへ露出させない |
| 画像取扱 | サーバ側で永続化しない（次フェーズで Supabase Storage 保存検討時は別途要件追加） |
| ログ | 画像の base64 をログ出力しない |
| PHI | 個人特定情報を含む可能性があるため、ブラウザコンソール / 解析結果 `<pre>` の DOM 経路以外への漏出を禁止 |
| CORS | `/api/scan` は same-origin のみ受付（既定の Astro 設定） |

### 6.3 可用性・障害時挙動

| 障害 | 挙動 |
|---|---|
| `GEMINI_API_KEY` 未設定 | 500 を返し、`error: 'GEMINI_API_KEY is not configured'` |
| Gemini レート制限 | エラー文を `status` に表示。AR 検知ループは継続（次フレームで自動復帰） |
| Gemini JSON パース失敗 | `json: null` を返却し、`raw` を保持。フロントは「項目数 0」として継続 |
| ネットワーク断 | 検知ループは一過性失敗として握りつぶし、次フレームでリトライ。撮影解析は status にエラー表示 |

### 6.4 対応ブラウザ / デバイス

| カテゴリ | 対応 |
|---|---|
| iOS Safari | 16+ （**最優先：iPhone のみで全フロー完結を担保**） |
| iPadOS Safari | 16+ |
| Android Chrome | 直近 2 バージョン |
| Desktop Chrome / Edge / Firefox / Safari | **スキャンは非対応**（誘導 UI のみ表示） |
| カメラ | 背面カメラ優先（無ければ前面でフォールバック許容） |
| 画面 | 縦長モバイル前提（提案書ワイヤーフレーム準拠） |

#### 6.4.1 デバイス別の利用方針

スキャン機能は **スマートフォン（特に iPhone）またはタブレット**でのみ提供する。スマホを所有していないユーザーは対象外（誰もが少なくとも 1 台はスマホを所有している前提）。**PC は要件外**。

| デバイス | スキャン対応 | 備考 |
|---|---|---|
| iPhone | ◎ **主対象** | 背面カメラ + 手持ち、AR ハイライト最適化、提案書 UI 全機能をここで完結 |
| Android スマホ | ◎ | iPhone と同等扱い |
| タブレット (iPad 等) | ○ | 据置スタンドでの利用シーン。AR 検知間隔は同条件 |
| **PC** | **— 非対応** | スキャンページを開いた場合は「スキャンはスマホまたはタブレットでご利用ください」を表示し、ハンドオフ QR で別デバイスへ誘導 |

#### 6.4.2 iPhone-first 原則

スキャン → 問診 → 結果閲覧の全主要フローは **iPhone 1 台のみで完結可能**であること。タブレット / PC は任意の拡張であり、強制しない。クロスデバイス連携の全体方針（Google One Tap、セッション継続、デバイス引継ぎ）は `docs/architecture/device_and_auth_requirements.md` を参照。診断結果の精読のみ、ユーザー任意でタブレット / PC で行える設計とする。

### 6.5 アクセシビリティ

| 要件 | 実装 |
|---|---|
| 状態通知 | `<p aria-live="polite">` でステータスをスクリーンリーダーへ通知 |
| 装飾要素 | オーバーレイ canvas は `aria-hidden="true"` |
| 操作キー | Tab フォーカス・Enter / Space 操作が可能 |
| 配色コントラスト | 緑・黄ともに WCAG AA 相当の前景コントラストを背景塗りで担保 |
| 色のみに依存しない表現 | 低信頼項目は「(要確認)」テキストも併記 |

### 6.6 国際化

- 当面は日本語のみ。AI 出力も日本語固定（system prompt で指定）。

---

## 7. API 仕様

### 7.1 `POST /api/scan` (v0.3 改定)

#### リクエスト

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `image` | string | yes | data URL もしくは生 base64 (JPEG/PNG)。フルサイズで送信、サーバで Files API に upload |
| `hint` | string | no | 補足プロンプト (例:「黄ばんだ古い検査表」「裏面に注記あり」)。system prompt に注入 |

> 旧 `mode: 'detect' | 'analyze'` フィールドは廃止。`POST /api/scan` は常に監査官モードの **9 列 + 推論値列 = 10 列 Markdown** を生成する。

#### レスポンス

```json
{
  "markdown": "## 左側検査表\n<!-- bbox: 0.05,0.05,0.95,0.65 -->\n\n| No | 検査項目 | ... | 推論値 | ... | 備考 |\n|----|---------|-----|--------|-----|------|\n| 1  | AST     | ... | -      | ... | -    |\n...",
  "finishReason": "STOP"
}
```

`markdown` は **生出力 (10 列)**。クライアント側で `stripColumnFromTables(['推論値','推定値'])` を適用して 9 列の `markdownClean` (= 確定 `scan_md` 候補) を作り、それを `parseMarkdownRegions` で `RegionResult[]` に分解する。

`finishReason` (Gemini 由来): `STOP` (正常) / `MAX_TOKENS` (応答打ち切り) / `SAFETY` (安全フィルタ作動)。UI は `MAX_TOKENS`/`SAFETY` の場合に警告バッジを表示。

#### Markdown フォーマット (詳細は `docs/architecture/diagnostic_session_data_spec.md` §3.2)

- 領域は H2 (`## ラベル`) で開始、最大 4 領域
- 各領域 H2 の直後に bbox HTML コメント `<!-- bbox: ymin,xmin,ymax,xmax -->` (0.0〜1.0)
- 表は GFM テーブル、固定列。`読み取った値` 列は紙面文字通り (H/L マーカ・[強調] を保持)
- 不明値は `(?)`、推測補完禁止
- `備考` 列は不整合検出時のみ `【要確認】理由` を出力

#### bbox 座標系 (v0.3 改定)

- 配列順: `[ymin, xmin, ymax, xmax]`
- 値域: **0.0–1.0 で正規化** (旧 0–1000 から変更)
- フロントは画像の表示サイズに合わせて `top/left/width/height` を `%` で適用

#### エラーレスポンス

| HTTP | ボディ | 発生条件 |
|---|---|---|
| 400 | `{ error: 'Invalid JSON body' }` | リクエスト JSON 不正 |
| 400 | `{ error: 'image is required (data URL or base64)' }` | `image` 欠落 |
| 500 | `{ error: 'GEMINI_API_KEY is not configured' }` | サーバ側設定不備 |
| 4xx/5xx | `{ error, detail }` | Gemini API からの転送エラー |

### 7.2 内部ライブラリ

`src/lib/gemini.ts`:
- `callGemini(apiKey, request, model?)` — Files API upload + `generateContent` + `GeminiError` ハンドリング
- `extractText(res)` — `candidates[0].content.parts[].text` を結合
- `MODELS` — 既定モデル ID 定義 (`gemini-2.5-flash`)

---

## 8. データモデル

### 8.1 ScanItem (Deprecated, v0.3 で削除済)

旧 JSON フローの最小単位だった `ScanItem` (label + value + bbox + confidence + kind) は v0.3 で完全に廃止。
現在のコードベース (`src/scripts/camera-scan.ts`) には存在しない。
互換性は保たない (パイロット段階のため)。

### 8.2 RegionResult (現行)

```ts
// src/scripts/camera-scan.ts
export interface RegionResult {
  /** 領域ラベル (H2 見出し) */
  label: string;
  /** 正規化 bbox [ymin, xmin, ymax, xmax] (0.0-1.0)。HTML コメントから抽出。 */
  bbox?: [number, number, number, number];
  /** 領域内の Markdown 本文 (見出し直下〜次の H2 までのテキスト) */
  body: string;
}
```

### 8.3 AnalyzeResult (現行)

```ts
// src/scripts/camera-scan.ts
export interface AnalyzeResult {
  /** Gemini が出した生 Markdown (推論値列を含む)。デバッグ用途のみ */
  markdown: string;
  /** 推論値列を除去した「確定 scan_md 候補」。UI / Supabase / Elith 入力 */
  markdownClean: string;
  /** 領域ごとに切り分けたメタデータ + 本文 (markdownClean ベース) */
  regions: RegionResult[];
  /** 表示用フル画像 URL (objectURL) */
  fullImage?: string;
  /** Gemini finishReason (STOP / MAX_TOKENS / SAFETY) */
  finishReason?: string;
}
```

### 8.4 VerificationState (現行、検証フェーズ用、v0.3 追加)

```ts
// src/scripts/scan-verification.ts (internal)
interface CellState {
  /** ユーザーが編集したセル値。未編集なら未設定 */
  edited?: string;
  /** ユーザーが「このまま OK」と確認した */
  userConfirmed: boolean;
}
interface RowState {
  /** cellIdx → CellState。記録のあるセルだけ含む */
  cells: Record<number, CellState>;
}
interface VerificationState {
  /** key = `${regionIdx}:${rowIdx}` */
  rows: Record<string, RowState>;
}
```

localStorage キー: `scan-chat-ai.verification.${diagnostic_id}`

### 8.5 検知最大件数

- 現行: 最大 4 領域 (system prompt で指定)
- 表 1 つあたりの行数: 上限なし (Gemini の応答長制限内で自然に決まる)

---

## 9. UI 仕様

### 9.1 画面構成（提案書ワイヤーフレーム[1]に準拠）

```
┌───────────────────────────────┐
│ ‹ 戻る     スキャン             │  ヘッダー
├───────────────────────────────┤
│ ┌───────────────────────────┐ │
│ │ ●高信頼 ●要確認           │ │  凡例（左上）
│ │                           │ │
│ │   [video preview]         │ │  3:4 アスペクト
│ │   [overlay canvas]        │ │
│ │   ┌───────────────┐       │ │  ガイド枠
│ │   │   被写体配置   │       │ │
│ │   └───────────────┘       │ │
│ └───────────────────────────┘ │
│ ☑ AR 検知（連続スキャン）       │
│                               │
│ 補足: [_______________]        │
│                               │
│ [カメラ起動] [撮影&解析] [停止] │
│                               │
│ 状態: …                        │
│                               │
│ ┌─解析結果(JSON)─────────────┐ │
│ │ { ... }                    │ │
│ └────────────────────────────┘ │
└───────────────────────────────┘
```

### 9.2 操作フロー

```
[初期] → カメラ起動押下
       ↓
[起動中] → 撮影 & 解析押下
       ↓
[解析中] → POST /api/scan (image + hint)
       ↓
[Gemini 監査官モード]
       ↓
[結果受信] → Markdown 10列 → クライアントで推論値列除去 → 9列 markdownClean
       ↓
[検証フェーズ (§5)] → トリミング画像 + bbox オーバーレイ
       ↓
       ├─ ブロックタップ → 詳細パネル (セル単位着色)
       │  └─ 疑念セルクリック → モーダル (セル単位編集 or 「このまま OK」)
       │
       ↓ 全疑念解消
[送信ゲート活性化]
       ↓
[✓ 確認して送信] → confirm → /chat へ遷移
       ↓
       ─ Phase 0: メモリ保持 (再ロードで失う)
       ─ Phase 1: assembleMarkdownClean → Supabase #2 scan_artifacts INSERT
```

### 9.3 ステータス文言

| 状況 | 表示 |
|---|---|
| 初期 | 「準備中…」 |
| 起動中 | 「カメラを起動中…」 |
| 起動完了 | 「カメラ起動中。AR 検知を ON にすると連続スキャンを開始します。」 |
| AR ON | 「AR 検知 ON: 連続スキャン中…」 |
| 解析中 | 「Gemini Vision に送信中…」 |
| 解析完了 | 「解析完了：N 項目」または「解析完了。」 |
| 停止 | 「停止中。」 |
| 起動エラー | 「カメラを起動できませんでした: <理由>」 |

### 9.4 ボタン状態マトリクス

| 状態 | カメラ起動 | 撮影&解析 | 停止 | AR 検知 |
|---|---|---|---|---|
| idle | enabled | disabled | disabled | disabled |
| running | disabled | enabled | enabled | enabled |
| busy | disabled | disabled | enabled | disabled |

---

## 10. エラー・例外ケース

| ID | 状況 | 期待挙動 |
|---|---|---|
| E-01 | カメラ権限拒否 | status にエラー文表示、ボタン状態を idle に戻す |
| E-02 | HTTPS でない（localhost 以外） | getUserMedia 失敗 → E-01 と同じ扱い |
| E-03 | 背面カメラなし | 前面カメラへ自動フォールバック（`facingMode: { ideal: ... }`） |
| E-04 | AR 検知中の単発失敗 | 握りつぶし、次フレームで継続 |
| E-05 | 撮影解析タイムアウト | status にエラー文、ボタン状態を running に戻す |
| E-06 | Gemini JSON 不正 | `json: null` で raw のみ返す。フロントは「項目 0」として継続 |
| E-07 | API キー未設定 | サーバ 500 → status に「設定エラー」 |
| E-08 | bbox 範囲外（負値・1000超） | clamp して描画（破綻させない） |
| E-09 | 画像が真っ暗 / 被写体なし | AI が空 items を返す前提。UI は静かに 0 件表示 |

---

## 11. テスト要件 / 受入基準

### 11.1 機能テスト

- [ ] 「カメラ起動」で背面カメラのプレビューが表示される
- [ ] 「AR 検知」ON で 1.8 秒間隔の bbox 描画が始まる
- [ ] 高信頼項目が緑、手書き項目が黄で表示される
- [ ] 「撮影&解析」で 1280px の JPEG が送信され、構造化 JSON が表示される
- [ ] デジタル・オーバーレイで "label: value" が項目位置に表示される
- [ ] 「停止」でプレビュー停止 + オーバーレイ消去
- [ ] 権限拒否時にエラーメッセージが表示される
- [ ] 補足プロンプトを入力すると analyze 結果に反映される（observations の文言に影響）

### 11.2 非機能テスト

- [ ] iPhone Safari (iOS 16+) で動作確認
- [ ] Pixel Chrome で動作確認
- [ ] Lighthouse Mobile スコア: Performance 80+ / Accessibility 90+
- [ ] AR 検知中のメモリリークなし（10 分連続で安定）
- [ ] Gemini レート制限到達時に UI がフリーズしない

### 11.3 セキュリティテスト

- [ ] DevTools の Network タブで `GEMINI_API_KEY` が一切露出しない
- [ ] `/api/scan` への cross-origin リクエストが拒否される
- [ ] サーバログに画像 base64 が記録されていない

---

## 12. 既知の制約・将来課題

| 区分 | 内容 |
|---|---|
| 制約 | Gemini Vision の bbox 精度はフォント・撮影条件に依存。提案書のような「吸い付き感」を完全再現するには追加チューニングまたは別モデル（Cloud Vision OCR + Gemini 解釈）併用検討 |
| 制約 | Vercel serverless の実行時間制限（無料/Hobby で最大 10 秒）。フル解析が長引く場合は Pro プランまたは Cloud Run に移行 |
| 将来 | スキャン結果の Supabase 永続化（`scan_results` テーブル） |
| 将来 | 複数枚スキャン → 1 セッションへの統合 |
| 将来 | 外部 AI 診断システムへの暗号化送信 |
| 将来 | オフライン時のローカルキュー + 再送 |
| 将来 | 多言語（英語・繁体字など）報告書対応 |
| 将来 | 視覚的フィードバックの強化（吸い付きアニメーション、シャッターガイド） |

---

## 13. 関連実装ファイル

| ファイル | 役割 |
|---|---|
| `src/pages/scan.astro` | スキャン画面 UI |
| `src/pages/api/scan.ts` | Gemini Vision プロキシ API（detect / analyze） |
| `src/scripts/camera-scan.ts` | getUserMedia + 検知ループ + オーバーレイ描画 |
| `src/components/ScanOverlay.astro` | bbox 描画用の canvas レイヤー |
| `src/lib/gemini.ts` | Gemini API 呼出ラッパ |

---

## 14. 変更履歴

| バージョン | 日付 | 内容 |
|---|---|---|
| 0.1 | 2026-05-22 | 初版（提案書 PDF + スケルトン実装 v0.1.0 を踏まえて作成） |
| 0.2 | 2026-05-22 | iPhone-first 原則を明文化、スキャン対応デバイスから PC を除外（誘導 UI のみ）、タブレットを明示的に対応に追加 |
| 0.3 | 2026-05-24 | 旧 JSON `ScanItem` フローを廃止、Gemini 監査官モードによる **9 列 Markdown** + **ユーザー検証フェーズ (セル単位)** を採用。§5 新設、§4 F-11〜F-15 追加、§7 API spec を `markdown` レスポンスに改定、§8 データモデルを `RegionResult`/`AnalyzeResult`/`VerificationState` に更新、§9.2 操作フローに検証ステップを反映、bbox 座標系を 0–1000 → 0.0–1.0 に変更 |
