# CLAUDE.md — このリポジトリで作業する前に必ず読む

この文書は **確定済みの決定事項と、その根拠ドキュメントの索引**。
作業前にここと該当ドキュメントを読み、**推測・再質問で確定事項を蒸し返さない**こと。

## 作業ルール (厳守)

1. **まず `docs/` を読む。** 質問する前に、関連ドキュメントを検索・精読する
   (`docs/`, `docs/operations/`, ルートの各 `*.md`)。答えは大抵書いてある。
2. **確定事項 (下記) を再質問しない。** 変更や矛盾があるときだけ確認する。
3. 決定が変わったら **この CLAUDE.md と該当ドキュメントを更新**してから進む。
4. 憶測で仕様を作らない。ドキュメントに無い場合のみ、明示して確認する。

## 調査・推測のアンチパターン (厳守・上記ルール1/4の具体化)

> 実障害 (2026-07): GMO決済のサブスク課金情報が渡らず、`gmo-return.ts:54-55` を読めば即分かる
> 真因 (`GMO_API_BASE_URL` テスト値残存が `gmoApiBase` を最優先で pt01 に固定) を、根拠の無い仮説
> (存在しない「本番/テスト Vercel」「結果通知URL」「GMO_LINK_BASE_URL 変数」「取引区分＝即時売上」
> 「戻り先URL=/products/complete」等) を**断言→撤回**で何本も繰り返し、泥沼化させた。全て以下違反。

- **R1. 断言には出典を付ける。** 外部システム/env/UI/変数名/仕様に触れる主張は必ず
  `file:line` か 公式ドキュメントの節・URL か 実際の値 を添える。**出典を出せない主張は
  「未確認の仮説」と明示ラベルを付け、断定文で書かない。**
- **R2. 「存在するか」を先に確認する (捏造ゼロ)。** env変数・設定項目・UIフィールド・変数名を
  名指しする前に、必ず grep (コード) か 公式ドキュメント該当箇所 を先に引く。
  「引けば無いと分かるもの」を口にしない。
- **R3. 外部システムは記憶でなく一次資料。** GMO-PG 等の外部仕様は学習知識を根拠にしない
  (信頼性が低い)。公式ドキュメントで確認してから述べる。不明なら「公式で要確認」と言う。
- **R4. 原因はコードのフローで特定。ユーザーに無駄確認をさせない。** 「ログを見て」等の外部確認を
  頼む前に、自分でできるコード/docs追跡を尽くす。順位付けは"勘の自信度"でなく
  **コードパスが実際に何で分岐するか**で行う。
- **R5. 反証が来たら即座に仮説を捨てる。** ユーザーが事実を示したら固執せず即撤回し次へ。
  粘って再主張しない。

## 確定事項 (Settled decisions)

### 設定値の置き場所 (env / app_config の切り分け・2026-08 確定・発注者判断)

**判断基準は「秘匿性」**。

| | 置き場所 | 対象 |
|---|---|---|
| **秘匿性が高い** | **env 継続** (Vercel 環境変数) | API キー・シークレット・接続情報 |
| **秘匿性が低く、切り替えが想定される** | **`diagnosis.app_config` (Supabase) → admin で管理** | 使用モデル・スキャン精度フラグ・画面文言 |

env は「現在値が見えない」「変えるたびに再デプロイが要る」ため運用パラメータに不適、というのが理由
(マイグレーション `supabase/migrations/20260815000010_app_config.sql` の冒頭コメントに記載)。

- **優先順位 = DB値 → コード既定** (`src/lib/app-config.ts` の `CONFIG_SPECS[].default`)。
  **env フォールバックは廃止済み**。旧 `SCAN_*` / `GEMINI_*_MODEL` env は**コードから参照されていない**
  (grep でヒット 0) ので、Vercel 側に残っていても無視される。撤去してよい。
- 反映は TTL 45 秒 (`app-config.ts` の `TTL_MS`)。各 API は処理前に `refreshConfig()` を呼ぶ。
- 変更 API = `src/pages/api/admin/config.ts` (Bearer `ADMIN_API_KEY`)。
  GET でカタログ+現在値、POST で upsert。**UI は wellfort-site admin 側** (この作業ツリーには
  未取得のため実装状況は未確認)。

**app_config の現行キー (18 件)**: `ui.support_contact` / `ui.health_age_followup` /
`scan.model` / `live.model` / `scan.output_format` / `scan.boundary_recheck` / `scan.obs_dedup` /
`scan.scramble_fix` / `scan.eye_resolve` / `scan.lipid_fix` / `scan.canonicalize` /
`scan.perception_repair` / `scan.vqa_rowcrop` / `scan.ai_prediction_dedup` /
`fabgate.unperformed` / `fabgate.refbleed` / `fabgate.reftable` / `fabgate.adjacent`

**【重要】この文書の下の方に残っている `env SCAN_XXX` という表記は、すべて app_config キーの
読み替え**で理解すること (`SCAN_BOUNDARY_RECHECK` → `scan.boundary_recheck` のように
小文字ドット区切り。`SCAN_FABGATE_*` → `fabgate.*`)。**env として設定しても効かない。**

**env に残すもの (秘匿値・実測 grep)**: `GEMINI_API_KEY` / `ADMIN_API_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` / `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` /
`HP_BRIDGE_SUPABASE_URL` / `HP_BRIDGE_READONLY_KEY` / `HP_EDGE_BASE_URL` /
`RESOLVE_SHARED_SECRET` / `PUBLIC_GOOGLE_CLIENT_ID` / `PUBLIC_DEMO_FALLBACK` /
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `AWS_S3_BUCKET` /
`AWS_S3_PREFIX` / `AWS_S3_ENDPOINT` / `AWS_S3_ORIGINALS_BUCKET` / `AWS_S3_ORIGINALS_PREFIX`
(wellfort-site 側は `SCAN_CHAT_AI_API_KEY`)。

### 環境変数・キー管理
- **API キー (Gemini / AWS S3 など) は Vercel 本番環境の環境変数で一元管理**。
  **ローカル `.env`・operator PC・クライアントには置かない。**
  - 根拠: `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` L26 / L153
    「UNFIX が受領した API キーを Vercel 本番環境の環境変数 `GEMINI_API_KEY` に設定」。
  - キーローテーション: 3 か月に 1 回程度 (同 L155)。法人パスワードマネージャに保管 (L154)。
  - **キー形式変更 `AIza`→`AQ.`**: 新 `AQ.` キーで本アプリはそのまま動作 (ネイティブ endpoint に
    `x-goog-api-key` ヘッダ + 公式SDK 利用のため。コード変更不要)。
    **旧 `AIza` は 2026-09 に失効** → それまでに Vercel の `GEMINI_API_KEY` を `AQ.` キーへ差し替える
    (運用のみ)。詳細: `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` §7.1。
  - Gemini 呼び出しは `src/lib/gemini.ts` に集約。キーは `x-goog-api-key` ヘッダ送信 (URL に載せない)。
- **使用モデルは app_config (DB) で差替え可 (コード変更・再デプロイ不要・admin から即時)**。
  `src/lib/gemini.ts` の `MODELS` は getter で、`scan.model` / `live.model` を都度参照する。
  **旧 `GEMINI_SCAN_MODEL` / `GEMINI_LIVE_MODEL` env は廃止 (コードに存在しない)**。
  - スキャン (画像解析・全 REST 呼び出し): 既定 **`gemini-3.1-flash-lite`** (軽量・安定)。`scan.model` で上書き。
    精度を上げるなら `gemini-3.5-flash` (GA) だが、**混雑時に 503(model overloaded) が出やすくバッチ全滅の実績あり (2026-07)**
    ため常用の既定は 3.1-flash-lite に据え置き。Tier1 未開通/不具合時は `gemini-2.5-flash` (旧既定) へ。
    ※ 正式ID は Gemini API 公式 (ai.google.dev/gemini-api/docs/models/gemini-3.5-flash) で確認: Stable=`gemini-3.5-flash` /
      Preview=`gemini-3-flash-preview`。**末尾-preview無しの `gemini-3-flash` は Gemini API に存在しない** (設定すると全スキャン失敗)。
    - **前提**: 3.x 系は **Tier1 (課金有効化) + 当該キーでのモデルアクセス** が必要。未開通のまま 3.x を指すと
      全スキャン (検診/がん/血液image/遺伝子) が失敗する → その場合は env で 2.5 に戻す。
    - スキャン精度は **検診 numeric → ウェルネス年齢 (CABA)** に直結。モデル切替時は代表ページで再検証すること。
  - **Live (AI問診)**: 既定 `gemini-3.1-flash-live-preview` (REST 非対応の専用プレビュー)。`live.model` で追従。
    経路: `chat` 画面 (`live-controller.ts`) → `POST /api/live-token` → `MODELS.liveChat`
    → `getLiveModel()` → `cfg('live.model')`。**実際に何が使われているかは DB の値次第**なので、
    確認するときは `select value from diagnosis.app_config where key='live.model'` を見る
    (行が無ければコード既定)。
  - **スキャン出力形式 `SCAN_OUTPUT_FORMAT` (既定 `markdown`)**: `json` で **responseSchema 構造化出力** 経路に切替
    (Phase 2)。Markdown 表は列帰属が自由すぎ定性記号 `(-)` が run 毎に基準列へ吸われる (Semantic Tie) ため、
    value/ref_high をフィールドで固定して列ズレを構造的に断つ狙い。Gemini/ChatGPT 両者の一致見解 (2026-07)。
    **未検証のうちは既定 `markdown` のまま**。代表ページで 🎯ゴールデン照合の回帰ゼロを確認してから `json` へ寄せる。
    プロンプト/スキーマは `src/lib/scan-prompt.ts` の `ANALYZE_SYSTEM_JSON` / `SCAN_RESPONSE_SCHEMA`。読取ルール
    (今回のみ・推論値隔離・総合判定除外・疎ページ) は Markdown 版と同一。両経路とも `toMeasurements` 以降を共用。
    - **検証結果 (2026-07・🎯決定論比較)**: json は列は安定するが**補助欄が暴走**する (未実施項目の value に基準値を
      流し込む捏造=False-Value 8件・重複12・rows120 の実測)。値一致率は markdown と同点。**json は不安定で
      ゴール①(余剰/誤り排除)に不利** → **既定 `markdown` で確定運用**。json 経路はコード温存 (将来の補助欄抑制改良用)。
  - **境界定性の2パス再読 `SCAN_BOUNDARY_RECHECK` (既定 off・`on` で有効)**: numeric は安定だが定性/境界
    (尿蛋白/尿潜血/尿糖/免疫便潜血/K-W) が run 毎に入れ替わりで空返しされる (検出の揺れ=非決定)。一次パスで
    空だった該当項目**だけ**を、その画像へ軽量シングルタスクで再読しギャップ埋めする (`boundaryRecheck`・既存値は
    絶対に上書きしない=numeric不変・空返しは埋めない=捏造しない)。モード非依存。🎯回帰ゼロ確認後に常用する想定。
- **確定運用 (2026-08・人間ドック決定論スタック確定)**: 本番 env は **`SCAN_OUTPUT_FORMAT` 未設定(=markdown) +
  `SCAN_BOUNDARY_RECHECK=on` + `SCAN_OBS_DEDUP=on` + `SCAN_SCRAMBLE_FIX=on` + `SCAN_EYE_RESOLVE=on` + `SCAN_LIPID_FIX=on`**。
  すべて**捏造ゼロ(出力値は実読値のみ・新値を作らない)**・env off で挙動不変・🎯回帰ゼロで on 化。**Phase 2-2 決定論修正スタック** (hc-merge finalize 順):
  1. **推移グラフ非納品** (⑧-2「検査結果の推移」由来を詳細に同概念あれば除外・trend のみは残す=漏れ防止)。
  2. **dedup** (`observation-dedup`・同値統合/別値は競合記録=自動採用しない)。
  3. **肝鉄 scramble 再割当** (`scramble-detect.reassignScramble`・env `SCAN_SCRAMBLE_FIX`): 値がラベル基準に不適合 かつ
     別項目Bの基準に**唯一**適合 かつ B欠落 → B へラベル付け替え。**block内限定**(liver/iron。血清鉄40-188がALP/LDHと重複するため)。
     例 γ-GTP=157→LDH・ChE=78→ALP・TIBC=43→血清鉄。検知は再割当**前**に実行(偽陽性防止)。
  4. **眼科 collapsed-row** (`collapsed-row.resolveEyeCollapsed`・env `SCAN_EYE_RESOLVE`): `右眼`/`左眼` ちょうどの行を値域で
     種別へ (0.01-2.0→裸眼視力/5-30→眼圧/定性→眼底所見・左右別・付け替え先が既存なら作らない・範囲外は不触)。
  5. **脂質 LDL↔TG 物理制約修正** (`lipid-fix.fixLipidSwap`・env `SCAN_LIPID_FIX`): 不変量 **LDL+HDL≤TC**。現状 LDL+HDL が
     TC を MARGIN(15)超で超え(物理不能)、LDL↔TG 入替で解消するときだけ両行の値を交換(Friedewald絶食仮定不要=施設非依存)。
  - **受容する確率的残差 (決定論で取れない=確定運用で許容)**: **分画の同レンジ入替**(好酸球↔好塩基球・独立制約なし)、
    **系統脱落**(run依存で 好酸球/LDH/γ-GTP/血小板/身長 等が時々落ちる)。実務は**別 run 引き直し**で吸収。
    (b)完全性チェック+ターゲット再読は VQA 信頼性課題(実測で眼圧を19.0と誤読)のため保留。
  - **多数決(N-run)は撤回**: 名称が run 毎に揺れるため semanticKey で整合できず union 膨張(rows95→123・重複15・捏造5)=逆効果と実証。
    scramble は「run毎に別ブロック」だが、レンジ再割当(単一run・跨run整合不要)の方が安全で確実。
  - **wellfort-site admin 表示**: `🔧再割当`/`👁眼科`/`🧪脂質`/`⚠scramble疑い(残)` を監査表示(納品 data には含めない)。
- **(旧・検診の確定運用) 2026-07・🎯検証済**: 本番スキャンは **`SCAN_OUTPUT_FORMAT` 未設定(=markdown) + `SCAN_BOUNDARY_RECHECK=on`**。
  🎯決定論ゴールデンで numeric 全一致・False-Value 0・Shift/Wrong 0 を確認。名称ゆれ(血圧最高/最低・白血球数↔白血球)は
  `pickDeliveryName` 正規化と照合器 alt で吸収。定性(-)の列取り違えは `salvageQualitativeResult`
  (便潜血→尿定性へ allow-list 一般化・🎯検証待ち)で救済。照合器(`elith-batch.astro goldenCheck`)に
  **定性一致率 (numericと分離) と Semantic-Tie(残) 指標**を追加済 (定性の今回値が空で基準列に(-)がある残差を可視化)。
  - **残差 = 免疫便潜血の稀な純粋検出漏れ**: モデルが (-) を value にも ref にも読まない run では、salvage も再読(temp0)も
    埋められない。**ここで (-) を補完すると捏造になるため、空のままにする(捏造ゼロ)** のが確定挙動。多くの run では
    base/salvage/再読のいずれかで捕捉される。さらに追う場合の未実装オプション: 温度変動の多段再読 / 検便領域の
    クロップ拡大前処理 (コストと payoff を見て判断)。
  - **Gemini 3.x の生成設定差は `callGemini` が自動吸収**: 呼び出し側は 2.x 形式 (`thinkingBudget`・`temperature`) の
    まま書けばよい。3.x 指定時のみ `temperature/topP/topK` を除去 (既定推奨) し `thinkingBudget→thinkingLevel` へ変換。
- したがって **ローカル端末での CLI 直実行は不可** (キーを読めない)。
  スキャン/エクスポート等の鍵が要る処理は **Vercel サーバ側 (API/admin バッチ)** で実行する。

### アプリ構成 / 管理画面の所在 (重要・誤解しやすい)
- **Scan-Chat-AI は単独アプリではなく、`www.wellfort.co.jp`(wellfort-site) 配下の診断アプリ**。
  ユーザーは `www.wellfort.co.jp` マイページのリンクから Scan-Chat-AI に遷移する
  (`docs/architecture/wellfort_mypage_button_spec.md`: 本番 `https://scan-chat-ai.vercel.app/`、将来 `app.wellfort.co.jp`)。
- **管理者メニューも `www.wellfort.co.jp/admin`(wellfort-site) 側**。
  - **admin UI は wellfort-site に置く**。**Scan-Chat-AI は API 提供側**
    (`https://scan-chat-ai.vercel.app/api/admin/...`)。根拠: `docs/lab/wellfort_admin_lab_upload_spec.md`
    L5-6/§3「実装対象=Wellfort HP 管理画面 / Scan-Chat-AI=API提供側」。
  - **認証は 2 層**:
    1. **入口(admin判定)**: wellfort-site 側で管理者かを確認する。方式は既存 `admin/users.astro`
       (L543-551) と同じ = **ユーザー自身のアクセストークン + anon apikey で `admin_users` を照会**
       (`is_active=true`)。**service_role は使わない**。
    2. **上流(Scan-Chat-AI)**: **Bearer API Key** (`wellfort_admin_lab_upload_spec §6-1`)。
       wellfort-site 側 env `SCAN_CHAT_AI_API_KEY` = Scan-Chat-AI 側 env `ADMIN_API_KEY` (同値)。
       キーはブラウザに出さない・CORS不要。
  - **§6-2 の「Scan-Chat-AI 側で ID Token→admin_users 照合」は Phase 2.0 (将来)。Phase 1.0 では実装しない。**
  - → 新しい admin 機能を作るときは **UI=wellfort-site / 処理=Scan-Chat-AI API** で分ける。
    Scan-Chat-AI 側に admin 画面を作らない (キー・処理は Scan-Chat-AI、入口は wellfort-site)。

### AI問診 / Live API 制御 (絶対厳守)
- **Live API のターン制御（VAD・割り込み・復唱・エコー対策）は全て LLM/Live API に委ねる。
  プログラム側で制御しない。** マイクの半二重ゲート、AI発話中のマイク送信停止、
  「LLMが自発復唱するはずだから復唱依頼を出し分ける（silent 分岐）」等の**プログラム制御は禁止**。
  → 必ずドツボに嵌る（読み上げが途中で途切れる等の回帰を生む）。実績: 2026-07-05 に
    `f3d59e8`/`09af5ec` で silent 分岐・2パターンプロンプトを入れた結果、AI 読み上げが
    途中で切れる回帰が発生。`b67c15b`（単一依頼「①復唱 ②(切替時)導線 ③次質問」を送り
    ターン制御は LLM 任せ）へ戻して解消。
- 問診の進行（質問順・分岐・完了）は `InterviewEngine`（クライアント）が制御し、
  LLM は「渡された質問文の読み上げ＋回答の復唱」だけを担う。**LLM に問診順を決めさせない。**
- AI問診＝**5セクション（嗜好品・運動・食生活・睡眠・心身）**が仕様
  (`docs/interview/20260331_AI参考問診票.png` / `docs/funding_application/要件定義書.md` F-3)。
  **同意設問・実施検査確認などは問診に含めない**（同意は登録/オンボーディングで取得）。
- **詳細仕様・設計原則・アンチパターン・二重話者問題の因果は `docs/interview/AI問診_仕様と設計原則.md` が正本。
  AI問診コードに触れる前に必読。** 責務分界（フロー/選択肢/データ=プログラム, 音声のターン/発話=LLM任せ）、
  silent 分岐・マイクゲート禁止、`f99f47e` が二重話者の起点である因果、案1(音声=LLM単独話者)への修正方針を記載。

### インフラ / 実行モデル
- **Vercel Serverless (iad1 / US East)**。Gemini API と地理的近接 (`docs/architecture/system_architecture_overview.md` L143/L273)。
- 関数タイムアウト ~60s。大型検査表はストリーミング/分割。
  → バッチは **1 画像 = 1 リクエスト**で処理し、クライアントが順に呼ぶ (`docs/architecture/system_architecture_overview.md` L316)。

### Elith 連携 (S3 データ受け渡し)
- 仕様は `docs/elith/elith_s3_data_handoff_spec.md` が正:
  - パス `/{prefix}user/{client_id}/date/{YYYY_MM_DD}/`
  - ファイル `{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json`
  - format_id: `CancerRiskAssessmentData` / `HealthCheckupData` / `GeneticTestResultData` /
    `BloodTestData` / `LifestyleQuestionnaireData` / `Other`
  - `client_id` = `diagnostic_user_id` (PII 非含有)。必要データが揃った時点で一括書き出し。
- S3 既定: バケット `wellfort-ai-input` / prefix は用途による (`src/lib/s3.ts`)。

### 戦略正本: 検査票→標準フォーマット正準化 (2層・最優先で読む)
- **正本: `docs/scan/scan_canonicalization_standard_format_design.md`**。最終ゴール(正確=漏れなし/捏造なし/余剰なし なJSON→Elith→高精度診断)を
  最上位に置き、設計思想(native multimodal・OCRパターンマッチを使わない)は**手段=従属**とする(ゴールが勝つ)。
- **2層に分ける**: ①**読取(Perception)=native multimodal 維持**(レイアウト多様→テンプレOCR不可)。
  ②**正準化(Normalize)=業界標準「健診標準フォーマット(KMAT)」への決定論マッピング(新規)**。②は"1つの標準マスタ"が標的で
  レイアウト別テンプレではない(=汎化しない負債でない)。名寄せ/単位/判定/余剰・不足を②で得点する。
- **一次資料(R3)**: 健診標準フォーマット=日本医学健康管理評価協議会策定。維持運用=日本医学健康管理推進機構(HASTOS/hastos.jp)。
  KMAT ver5.0≒2000項目。**完全マスタは推進機構/HASTOS or クライアント/Elith 経由で入手(捏造しない)**。
- **受け皿は実装済**: `elith-necessity-check.ts` の `requiredItemsMaster`(現 null)にサブセットを与えれば起動。
  `elith_check_phase_spec §8` の「必要項目マスタ」の正体がこの標準。`pickDeliveryName` の当て推量はマスタ照合へ置換していく。
- **実装進捗 (テンプレート穴埋め方式)**: 計画=`docs/scan/基本設定書_実装修正プラン.md`、基本設定=`docs/scan/基本設定書.md §3.6`、
  機能別=`docs/修正仕様書_{標準マスタ,正準化エンジン,検証と確定運用}.md`。
  - **P1 完了**: starter 標準マスタ `src/lib/standard-master.ts` (41項目・ゴールデン実在項目のみ・捏造ゼロ・
    `findByAlias` 完全一致=危険同義語 総蛋白/便潜血 は非マッチ)。
  - **P2 実装済 (既定 off・🎯実画像は未)**: `src/lib/canonicalize.ts` (S1〜S3: 名寄せ/単位正準化/カバレッジ)。
    全書出し経路 (`buildElithScanBundle`/`elith-hc-merge`/`elith-assemble.sanitizeDelivery`) に結線。
    **env `SCAN_CANONICALIZE=on` のときだけ発火・既定 off=挙動不変**。numeric は変えない・非ヒットは元名のまま・
    監査(`mapped/unmapped/deficient`)は納品 data に混ぜない (hc-merge 応答 `canon`)。`pickDeliveryName` は前段維持。
  - **P3 実装済 (既定 off)**: API が canon 監査を返す (scan=`bundle.canon`→`elith-scan.ts`, merge=`elith-hc-merge` 応答 `canon`)。
    `checkNecessity` へ既定 starter マスタ供給 (surplus/カバレッジ可視化)。**starter は Elith 必須サブセットでないため deficient は非ブロック
    =情報提示。明示 `requiredItems` 指定時のみブロック**。admin 表示は wellfort-site `src/pages/admin/elith-batch.astro` (②正準化 写像/マスタ外/不足)。
  - **次 P4/P5**: 🎯実画像ゲート(Vercel で `SCAN_CANONICALIZE=on`→ゴールデン再RUN) → 確定運用。完全マスタ受領で starter 差替。**on 化は🎯回帰ゼロ確認後**。
- **P-perc: 画像証拠ベースの後段補修 (人間ドック課題A/B/C・①読取層・②とは直交)**。正本=`基本設定書 §3.4.1`/`実装修正プラン §3.1`。
  Gemini/ChatGPT 再レビュー収束(2026-08)。共通根=主パス出力に「画像のどの領域/セル由来か」の来歴が無いこと → **出力起点でなく画像証拠候補と主パス出力の双方向照合**で確定 (§3.6.1 S3 の①層への拡張)。主パス(プロンプト/入力画像)は不変。
  - **P-perc-1 実装済 (env `SCAN_OBS_DEDUP`・既定off)**: 課題C 決定論 dedup `src/lib/observation-dedup.ts`。概念ID(canonical_name)で同一性判定・**同一キー同値のみ統合**(別名重複除去)・**別値は競合記録で自動採用しない**(捏造ゼロ・課題B 検知)。table_id/row は意味キーに含めない。眼圧右/左・便潜血1/2日目 は別 canonical_name=統合しない。`buildElithScanBundle` の canonicalize 後に発火→監査 `bundle.dedup`。numeric 不変。astro check 0error・ロジック15ケース検証。**on 化は🎯後**。
  - **P-perc-2/3/4 実装済 (env `SCAN_PERCEPTION_REPAIR`・既定off・Vercel🎯前提)**: 決定論コア `src/lib/perception-repair.ts` (課題B リスク別ゲート evidenceVerdict/emitDecision: 高リスク=証拠必須/通常=weak保持/過去・グラフ一致=contradicted除外/推定不能=ambiguous非ドロップ・状態機械 ATTEMPT_1→2→3→EXHAUSTED_UNRESOLVED・双方向会計 buildAccounting。ロジック22ケース検証)。画像I/O `elith-export.ts` (`perceptionRepair`= A:Geminiインベントリ→照合→局所VQA充填[画像証拠に基づくpush=捏造ゼロ] / B:同名別値の領域判定→ゲートで除外)。`scanArtifacts` に結線・Gemini/sharp全try/catch=フォールバック・主パス不変。astro check 0error。
    **タイムバジェット必須(実測504対応・2026-08)**: 後段の直列Gemini呼び出しは60s関数タイムアウト=**504でスキャン全損**を起こす(実測 ⑧-1.JPG)。→ `scanArtifacts` の主パス開始 t0 から `PERCEPTION_DEADLINE_MS=45000` の deadline を rowcrop/perception に渡し、各Gemini呼び出し前に `Date.now()>=deadline` で打ち切り+呼び出し上限(MAX_INVENTORY_REPAIRS/MAX_REGION_CHECKS=8)。打ち切り分は `budget_stop`=left_unresolved(次リクエストで再試行=RETRY_PENDING)。関数は必ず60s内に主結果を返す。
    **実測回帰(2026-08・⑧検体 perception=on)→捏造ゲート追加**: `inventoryReread` が 好中球(画像は分葉核球)/LDH/右耳/受診コース(=日付) 等を**幻覚して push=捏造5**、かつ 視力右眼/眼圧右眼 等を別名で push=重複増(rows100→116)。**CLAUDE.md 確定ルール「VQA充填は新規pushしない」を P-perc で上書きしたのが誤り**(R5撤回)。→ `inventoryReread` の新規pushを **findByAlias ヒット(starter標準マスタ実在概念)のみ + 日付様value除外 + canonical_name で既存概念と重複回避** に厳格ゲート(幻覚名/メタデータ/日付を全弾き)。**結果: 課題Aの push はマスタ収録項目に限定=大半の真の欠落(FT3/内科診察等)は非対象**(捏造ゼロ優先)。**当面 SCAN_PERCEPTION_REPAIR は off 推奨**(baseline=perception off が 98%/誤読0/捏造0 で優位)。完全マスタ受領で push 対象が広がる。
    **課題B 単独値リークは未解決**: LDL=102/TG=129(前回値混入)は主パス由来だが regionGate は「同名別値の競合」しか見ず単独値を取り逃す(Gemini①指摘)。全値の領域照会は60s予算外→ dedup で 129 が復元され競合化した時のみ拾える。恒久策は要検討。
    **残る精密化はVercel🎯で調整**: 純CV occupied検出・残留証拠監査・current_column_confidence・跨リクエストの client リトライループ。VQA/CVの効き(漏れ検知率/誤ドロップ/503/60s)はローカル不可(キー無)=決定論部とastro checkのみ検証。**on化は人間ドックゴールデン(FT3欠落・推移グラフ)での🎯回帰ゼロ確認後** (`SCAN_VQA_ROWCROP` と同運用)。
  - **「必ず入れる」の実行形 (発注者裁定2026-08)**: 漏れなし(§1.1絶対)=**サイレント脱落ゼロ＋自動リトライラダーで読み切り(人手ゼロ)**。読めないインクに値を出す=捏造なので不可。終端は自動停止でなく**自動継続の状態機械** `ATTEMPT_1→2→3→EXHAUSTED_UNRESOLVED`(未解決+証拠を永続化し次リクエストへ・1画像=1reqは分割規則で再試行を禁じない)。EXHAUSTED_UNRESOLVED は通常納品しない・捏造しない・黙って消さない。**保証=サイレント脱落ゼロ / 非保証=常に完全JSON(確率モデル単体で数学的に不可)**。
- **却下再掲**: 様式別プロンプト/テンプレOCR=却下 / 主パス規則強化=numeric回帰で不採用 / モデル3.5格上げ=md段階で lite 超えず不採用。
  - **例外(確定 2026-08・発注者判断)= LAiF「AI疾病発症予測」は様式特化プロンプトを採用**。却下理由は「多機関=様式可変」だが
    **LAiF は単一ベンダー・固定様式**で当てはまらず、ゴール(正確)優先で採用。狙い=発症予測テーブル(密表)の行ズレ/空行捏造/
    入れ子ゆれ抑制(行単位読取・疾患名ある行のみ項目化・フラット固定キー・疾患名は印字どおり)。
    実装=`src/lib/elith-genetic.ts` `AI_PREDICTION_USER`。正本=`docs/elith/elith_assembly_wrapping_spec.md §5.6`。
    後段統合(`ai-prediction-consolidate.ts`・env `SCAN_AI_PREDICTION_DEDUP`)と直交併用。固定様式の改訂検知は今後の課題。

### 捏造ゲート (False-Value 抑制・決定論・仕様着手2026-08)
- **正本: `docs/scan/修正仕様書_捏造ゲート.md`**。人間ドックgolden(2025-02-17)で顕在化した False-Value 8件
  (尿定性/便潜血の未実施(-)充填・腹囲=基準吸い上げ・B3基準値表の男性/女性項目化) を決定論で抑制する仕様。
  4ゲート (G1未実施ブロック抑制[`fabgate.unperformed`・比重/pH アンカーで尿未実施判定]・
  G2基準吸い上げ[`fabgate.refbleed`・value==片側基準閾値をドロップ]・G3参考資料行[`fabgate.reftable`・
  レンジ値/男性女性名をドロップ]・G4隣接漏れ[`fabgate.adjacent`・監査のみ])。全て `sanitizeMeasurementsForDelivery`
  集約・off=挙動不変・捏造ゼロ・🎯(test_date=2025-02-17)回帰ゼロで on化。
  **実装済 (2026-08・`elith-export.ts:457` で 4 ゲートとも参照)・既定は 4 つとも off**。
  切替は app_config の `fabgate.*` (旧 `SCAN_FABGATE_*` env は廃止)。

### スキャン読取の共通ルール (検査票 → JSON)
- **時系列列は「今回」のみ採用**: 検査票に「今回/前回/前々回」や受診日付きの複数回分が
  並ぶ場合、**"今回"(最新回) の値だけを採用し、前回・前々回以前は捨てる**。今回が空欄なら
  その項目の今回値は空 (前回値を繰り上げない)。**検診・人間ドックに限らず血液・がん・遺伝子等
  全検査票で共通**。実装: `src/lib/scan-prompt.ts`【時系列列の扱い】。
- **納品整形は決定論プログラムに集約**: `src/lib/elith-export.ts` の
  `sanitizeMeasurementsForDelivery()` が唯一の正規化本体 (lean化 / ↑↓→flag・value_num数値化 /
  空白(未実施)行 除外 / 総合判定(A/B/C)欄 除外[血液型ABO/Rhは例外] / 妥当性ガード)。
  **scan(`buildElithScanBundle`) と hc-merge finalize の書き出し時点**、および assemble
  (`sanitizeDelivery`) の全経路で同関数を通す (二重管理しない)。LLM に判定・整形はさせない。
  - 理由: 方式Aバッチ/assemble未実行の経路では**生スキャン出力がそのまま Elith 納品**になり得るため、
    整形は「書き出し時点」に置く (assemble任せにしない)。監査は raw_markdown + 元画像(S3) に保持。
  - **定性結果の列サルベージ (Phase 0)**: `salvageQualitativeResult()` が `sanitizeMeasurementsForDelivery` 冒頭で、
    value 空時に括弧付き定性記号 `(-)`/`(+)`/`(±)`/陰性/陽性 を ref_high/ref_low/note から value へ移送する
    (結果 `(-)` が基準列(上限値)へ吸われ脱落する非決定バグ=Semantic Tie の保険)。
    **名称 allow-list に限定** (「基準=(-)」を結果と誤読して埋める False-Value を避ける):
    許可=`/便潜血|^(?:尿蛋白|尿潜血|尿糖|蛋白|潜血)$/`、除外(deny)=血清 RPR/TP抗体/HBs/HCV・尿沈渣 細菌/円柱/結晶・
    総蛋白/血糖 等 (「基準=(-)だが今回空=未実施」が正当な行を埋めない)。
    **2026-07: 便潜血限定→尿定性まで一般化 (Gemini/ChatGPT/実装の3者収束・🎯検証待ち)**。
    残リスク=検体未採取で尿ディップ全欄が空の run は基準(-)を誤救済し得る → 恒久対処は下記 VQA 再読。
    (旧恒久策の `SCAN_OUTPUT_FORMAT=json` は補助欄暴走=False-Value で不採用済み。)
  - **時系列軸リーク (今回の False-Value) = 定性(-)とは別系統**: 今回=空が正の行 (眼圧・血清 RPR/TP抗体・HBs/HCV 等)
    で、モデルが**前々回の孤立値を今回列に混入**する (実測: 眼圧=前々回16 / RPR・TP=前々回(-)。raw の「読み取った値」列に
    過去値が入る=主パス起因で**後段は過去列を持たず修正不能**)。
    - **対策A (プロンプト補強) = 試したが撤回 (2026-07・🎯回帰)**: `scan-prompt.ts`【時系列列の扱い】に「孤立した過去列値の
      混入禁止」を追記したところ、**False-Value は 0 になったが Missing が 9 に急増** (身長/体重/BMI/腹囲/血圧/視力=**今回/前回/
      前々回が3列とも埋まる行**を flash-lite が過剰にドロップ)。numeric 回帰のため即撤回 (`0c4b519`→revert)。
      **教訓: 主パス(プロンプト)への時系列規則の強化は flash-lite で numeric を壊す。定性の O/X 却下と同じ轍**。
    - **対策B (列追加=構造保持) も不採用**: O/X 却下と同じ numeric 回帰リスク。
    - **採用方針 = 対策C (後段/第2パス VQA でドロップ)**: 主パス不変のまま、今回=空が正の疑い行 (眼圧・血清等) だけを
      VQA で「今回セルは空か」確認し、空確認できた時だけ過去混入値を**後段でドロップ** (誤削除=Missing を避けるため
      高信頼の空確認時のみ)。定性の VQA (下記) と同一機構で扱う。未実装。
    - 照合器に RPR/TP抗体/HBs/HCV を today='' 番人として追加済 (従来 golden 未検出だった漏れを可視化。撤回後は
      眼圧/RPR/TP が再び False-Value として出るが、これは"検出できている"正しい状態。恒久対処は上記 C)。
  - **定性の恒久対処 = 第2パス VQA (Verify & Repair・Gemini/ChatGPT/実装3者収束)**: 主パス(10列Markdown)は不変のまま、
    `SCAN_BOUNDARY_RECHECK` 経路を「値抽出」から**局所VQA(監査役・列挙回答・グラウンディング)**へ格上げ。
    プロンプト/スキーマは `scan-prompt.ts` の `BOUNDARY_RECHECK_SYSTEM`/`BOUNDARY_RECHECK_SCHEMA`/`buildBoundaryRecheckUser`
    (「今回セルだけ・過去列/基準を混同しない・列でなく行で辿る」)。後段パッチは `elith-export.ts boundaryRecheck`。
    - **Phase 1 (実装済・🎯検証待ち)**: `missing_detection`(今回空→VQAの妥当トークンで充填) と
      `unexpected_token`(今回値が定性許可集合外=例 免疫便潜血"1" → VQAトークンで上書き)。項目別 allow 集合
      (`QUAL_URINE_ALLOW`/`KW_GRADE_ALLOW`)でトリガー/採用をガード。**fail-safe**: VQA が空/不能/集合外なら不変・
      **既に妥当な値と numeric は絶対に触らない**。
      **可視化**: `boundaryRecheck` が `VqaAuditEntry[]`(name/reason/before/vqa/action=filled|overwritten|left_unresolved|vqa_error)
      を返し、`scanImageToParsed`→hc-merge の per-part 応答 `vqa_audit`→admin(`elith-batch.astro`)で
      「VQA再読 充填/上書き/未解決/エラー」を表示 (Elith 納品 data には含めない)。「VQAが発火したか/残差か」を🎯とは別に判別可能。
    - **Phase 2 (実装済・🎯検証待ち)**: `timeline_leak` の**削除(値→空)**。眼圧・眼底その他・血清(RPR/TP)等
      「今回=空が正」の項目 (`TIMELINE_LEAK_ITEMS`) を値ありでも VQA でダブルチェックし、VQA に `past_seen`
      (過去列に見えた値) を報告させ、**③3条件 (VQAが今回空 & past_seen に値 & 現value==past_seen) を全て満たす時だけ**
      後段で削除 (`sameLoose` 一致必須)。本番は過去列を持たないので VQA の past_seen と突合する。誤削除=Missing を
      構造的に防ぐ。残リスク=今回値==過去値が偶然一致する検体で実施済を誤削除し得る → **眼圧/血清が"実施済"の
      第2検体ゴールデン**で「実施済を落とさない」を確認してから本番常用する。監査 action に `dropped` を追加。
    - **① 行クロップ独立VQA (実装済・env `SCAN_VQA_ROWCROP`・既定off・🎯Vercel検証前提)**: Phase2 の**相関失敗**
      (主パスも全画像VQAも今回に過去値を読む run。実測 2026-08: 眼圧右/左=16 を両方 today=16 と読み削除できず
      False-Value 残存) を救済。対象 timeline_leak 行を `sharp` で切り出した独立画像で今回セルを読み直し、
      ③3条件 (行クロップVQAが今回空 & 過去列に値 & 現value==過去値) 全満たしで削除。**全幅Y帯=今回/前回/前々回
      を保持し X 座標特定の泥沼を回避**。`sharp` は**遅延import+全try/catch**=失敗時フォールバック(本経路は不変)。
      実装 `elith-export.ts` `rowCropLeakRescue`/`cropRowStripBase64`。
      - **🎯初回(2026-08)で判明→改良**: 行のみクロップだと**列見出しが無く今回/前回を取り違える**(眼圧左=today空 正読・
        眼圧右=today16 誤読)。→ locate で **header_bbox(列見出し行) も取得し「ヘッダ帯＋行帯」を縦連結**して列を
        対応付け。confirm プロンプトで **past_seen(過去列値) の報告を強制**(3条件の past を安定取得)。今回空判定は
        **present:false か today値空**で成立(修正)。numeric値は削除しか行わない(充填しない)=捏造ゼロ。
      - **on化は🎯回帰ゼロ確認後**(ローカルはキー不可＝連結クロップの画像生成のみ検証済。VQA部は Vercel🎯 で検証)。
    - **VQA充填の別名dedup (実装済)**: `BOUNDARY_RECHECK_ITEMS` に `aliases` (蛋白≡尿蛋白/潜血≡尿潜血)。
      これが無いと充填が別名の重複行を push する (実測 2026-08 重複2)。既存の尿蛋白/尿潜血行を照合し重複を作らない。
      さらに **潜血 hint=`(?<!便)潜血`**: boundaryRecheck は画像1枚ごとに走るため hint=/潜血/ だと免疫便潜血のある
      検便ページ(③-4)へ誤マッチ→尿定性潜血の無いそのページに新規潜血を push→③-2 の本物とマージ後に重複(実測 2026-08)。
      (?<!便) で免疫便潜血を除外し**ページ跨ぎの重複push**を防ぐ。
    - **VQA充填は新規pushしない=既存空行のみ充填 (実装済・捏造ゼロ)**: 該当行が主パス結果に無い様式では、
      VQAが値を返しても **push しない**(実測 2026-08: K-W の無い様式で VQA が 0 を push=捏造4)。「主パスが行を
      作った=その様式に存在が確認済」の空行だけを埋める。免疫便潜血/K-W/尿定性はその様式に行があれば
      idx>=0 で fill in place。完全に行ごと欠落した項目は捏造回避のため空のまま(捏造ゼロ優先)。
    - 主パスへの O/X 列追加・時系列規則強化は numeric 回帰で不採用(実証済)。~~クロップ前処理は画像ライブラリ不在で保留~~
      → **上記① で `sharp` 導入し行クロップを実装 (既定off)**。VQA単機能の仮想クロップでは相関失敗を消せなかったため。

### 検査種別ごとの本番処理 (役割分担)
根拠: `docs/elith/elith_batch_centralization_design.md`
- 検診・人間ドック (`HealthCheckupData`) … **ユーザーがアプリでAIスキャン**
- がんリスク (`CancerRiskAssessmentData`) / 遺伝子 (`GeneticTestResultData`) …
  **Wellfort が検査機関から手動取得 → admin バッチ (サーバ実行) で処理**
- 血液 (`BloodTestData`) … デメカル (dl.demecal.net) から取得。自動DLは
  `docs/lab/demecal_auto_download_overview_spec.md` (クライアント証明書 mTLS)
- 生活習慣・問診 (`LifestyleQuestionnaireData`) … アプリの AI 問診

### 検査値と原本の保存 (2026-08-20 確定・発注者承認)
- **検査値 = 案A-3 (ハイブリッド)**。`diagnosis.test_artifacts.measurements` (jsonb・原本忠実の全記録) と
  `diagnosis.measurement_values` (正規化・時系列グラフ用) の 2 層に書く。
  マイグレーション `supabase/migrations/20260820000010_measurement_values.sql`。
  - **書き込み口は `src/lib/measurement-persist.ts` の `persistMeasurements()` だけ**。両層を同時に書く。
    入力は `sanitizeMeasurementsForDelivery()` を通した後の lean measurement (整形はここでしない)。
  - 一意制約は `(artifact_id, seq)`。`(artifact_id, item_name)` にしない —
    同名別値は `observation-dedup` が競合として残す仕様のため、名前で一意にすると取込時に
    **行が黙って落ちる** (「サイレント脱落ゼロ」に反する)。
  - `canonical_name` は `standard-master.findByAlias` のヒット時のみ。非ヒットは null のまま (当て推量で埋めない)。
  - 旧計画の `diagnosis.test_artifact_items` は**不採用**。
- **原本ファイル = 案C′**。DB とホット層は Supabase (US Central) 据え置き、**原本だけ S3 `ap-northeast-1`**。
  署名 URL でブラウザとストレージが直結するため Vercel(iad1) は配信経路に入らない = レイテンシ不変。
  - 実装 `src/lib/originals-storage.ts`。**env `AWS_S3_ORIGINALS_BUCKET` が切替スイッチ**で、
    未設定なら Supabase Storage にフォールバック。読み出しは `storage_url` が `s3://` かで自動振り分け。
  - **Elith 連携用の `AWS_S3_BUCKET` (`wellfort-ai-input`) とは別変数**。上書きしない。
  - 10 年保管・削除不可 (§6.1) は S3 の Versioning + Object Lock で担保。構築手順は
    `docs/operations/S3原本ストレージ_構築手順書.md`。
    **Compliance モードはルートでも削除不可 (AWS公式)。テスト中は GOVERNANCE にすること。**
  - `file_kind` に `raw_pdf` を追加。**redaction は未実装**なので未処理の原本は `raw_pdf` を書く。
    `raw_pdf_redacted` は PII 除去を実装した経路でのみ使う (実態と名前を一致させる)。
- **Elith の AI 診断結果レポート (PDF) = パイプライン⑥・暫定実装 (2026-08-20)**。
  置き場所は **`diagnosis.diagnosis_results`** (`test_artifact_files` ではない —
  あちらは検査機関の原本。`diagnosis_results` が既に「Elith の診断結果 1 回分」を表す)。
  マイグレーション `supabase/migrations/20260820000040_diagnosis_report_pdf.sql` で
  `report_pdf_url` / `report_pdf_sha256` / `report_pdf_pages` / `report_pdf_received_at` を追加。
  - 取込 API = `src/pages/api/admin/elith-report/upload.ts` (Bearer `ADMIN_API_KEY`)。
    PDF を `putOriginal()` へ保存し、既存行を `status='superseded'` に落として新行を足す。
    **UI は wellfort-site 側**に作る (Scan-Chat-AI は API 提供側)。
  - 表示 = `src/lib/elith-report-queries.ts` `loadElithReport()` → `src/pages/report.astro`。
    実データが無い間は Elith 提供サンプル (`elith-report-sample.ts`・2026-08-06 Stage2 版) へ
    フォールバックする。3 モード (a サマリー / b 要注意抜粋 / c 全編 PDF) と `[pN]`→`#page=N`。
  - **要約はアプリが作らない**。a/b はレポート自身が持つ章 (アブストラクト / 医療受診の目安 /
    栄養素) と、本文に印字された `（判定区分：X）` の機械抽出だけ (`elith-report-highlights.ts`)。
  - 実データ経路の目視確認は `supabase/seed_elith_report.sql` (既定では読み込まない・手で流す)。
  - **受取仕様は未確定** (`docs/lab/lab_data_pipeline_master_spec.md:98`)。命名規則・出力トリガ・
    世代管理・ひも付け・受領確認が決まったら自動受信へ差し替える。
  - **【仕様変更 2026-08-28・発注者指示】報告書は「Elith の PDF を見せる」から
    「受領 JSON からアプリが生成する」へ変わる。正本 `docs/elith/ai_prevention_report_generation_spec.md`。**
    目的は**フォーマット変換ではなく可読化** (Elith の出力は文章の羅列で一般ユーザーが読み通せない)。
    見本 PDF は**様式のお手本**であって埋める項目の一覧ではない。
    - 受領は **1 件 = 3 ファイル** (`report_text.json` 10 セクション+`health_age` /
      `health_checkup.json` 40 項目 / 組版済み PDF)。**PDF は JSON の部分集合**で固有情報ゼロ
      (実測: JSON 19,870 字 / PDF 19,827 字)。しかも **PDF は箇条書き構造を潰す**ので
      **JSON のほうが素材として上位**。PDF は原本として保管し表示の主役から外す。
    - 出力は **HTML が正**。**サーバ側 PDF 生成はしない** (Vercel で Chromium=関数サイズと 60s に直撃・
      紙面が 2 系統になる)。証跡/外部配布の要件が固まったら Phase 2。
    - **印刷は `@media print` に依存させない (重要)**。iOS は 共有→**プリント**(印刷CSSが効く) と
      共有→**PDF**(効かない・こちらが見つけやすい) の 2 経路があり、後者では
      **折りたたんだ本文が PDF に載らない=中身が欠ける**。→ **印刷専用ビュー `/report?print=1`**
      (全展開・UI なしを**通常の画面 CSS**で出す) を用意し、`@media print` は上乗せに留める。
      どちらの経路でも同じ紙面になる。**`?print=1` では折りたたみを使わない**。
      iOS/Android の実機確認は未実施 (WebKit は手元で再現不可)。
    - **`elith-report-highlights.ts` は新形式で無言で空になる**。`（判定区分：X）` 依存 (L20) だが
      新データに **0 件**。検出を「基準範囲を上回っています」等の Elith 自身の判定文へ差し替える。
      `[pN]` も 0 件 → **原本 PDF へのページジャンプは廃止**。
    - **作れないもの (発注者判断: 受領に無いものは作らない)**: ①要注意/良好=Elith 判定文のある
      5 ブロックのみ ②原理/原因/疾患/予後/症状 = **原理のみ**取れる ③がんリスク = 全文に
      「がん」0 件で**不可** ④基準値比較 = 散文中の 8 件のみ (`health_checkup.json` に基準値が無い)。
      **これは欠損でなく方針の相違** — Elith は病名・原因・予後を意図的に書かない (ミッション④と一致)。
    - **受領データの既知不具合**: 同名別値 9 組 (総コレステロール 210/251 等・**自動採用しない**)、
      本文が使う**ヘマトクリットが JSON に無い** (2 ファイルは包含関係でない)、誤字「上上回っており」
      (**アプリで直さない**=原文改変)。
    - **`health_age`(Elith) と ウェルネス年齢(CABA) は別物**。混ぜない・どちらを出すか要確認。

### ウェルネス年齢 (旧称: 健康年齢・2026-08 確定・発注者指示)
- **名称は「ウェルネス年齢」**。画面・帳票・ドキュメントの表示名は全部これ。
  **内部識別子は据え置き** (`HealthAgeData` / `data.health_age` / `diagnosis.health_age_scores` /
  `ui.health_age_followup` / `src/lib/health-age*.ts` 等)。`HealthAgeData` は **Elith との受け渡し
  format_id なので勝手に変えない** (変更には Elith 合意が要る)。納品 JSON の `source.note` にだけ
  「ウェルネス年齢 (旧称: 健康年齢 / CABA)」と両名を書いて先方が気づけるようにしてある。
  ※ wellfort-site の企業サイト側スローガン「定年は『健康年齢』で決める」は**アプリの機能名ではない**
    ので今回の改称対象外 (`HealthManagement.astro` / `InvestmentRisk.astro`)。
- **算出は 3 段階フォールバック**。入口は `src/lib/wellness-age.ts` の `computeWellnessAge` **だけ**
  (`computeHealthAge` を直接呼ばない)。
  1. **①正規版 CABA v5.4** (`health-age.ts`)。不足項目は合理的に補填してから算出 (MCV=赤血球+Ht /
     RDW=13.0 / CRP=NLR推定→0.15 / WBC 桁正規化 / BMI=身長体重)。正本 `docs/scan/health_age_caba_v5.4_spec.md`。
  2. **②簡易版 CABA v7.0** (`health-age-simple.ts`)。血球分画・ALP・WBC・hs-CRP を持たない簡易書式向け。
     必須= 実年齢・アルブミン・クレアチニン ＋ (血糖 **または** HbA1c。血糖欠測時は eAG=28.7×HbA1c−46.7 で代用)。
     正本 `docs/scan/health_age_simple_v7.0_spec.md` (係数表・移植の復元手順・実ブラウザとの数値照合9件全一致)。
  3. **③算出不能** → 値を作らず定型文 `WELLNESS_AGE_UNAVAILABLE_MESSAGE`
     =「算出に必要なデータが不足しています。詳細は事務局へお問合せ下さい。」を提示。**文言を変えない**。
     API は 422・**保存しない** (`health_age_scores` に null 行を作らない=捏造ゼロ)。
- **どの版で出したかを必ず残す**: API 応答 `method` / `inputs.method` / `model_version`
  (`CABA-v5.4` or `CABA-SIMPLE-v7.0`) / ダッシュボード見出し右。**簡易版は係数が暫定・血糖が eAG 推定に
  なり得る**ため、版を伏せて数値だけ比較しない (①②で同じ検体でも値は一致しない=②だけ tanh 圧縮がある)。

### UI / デザイン (2026-08 刷新)
- **ブランド**: 顧客向け主ブランド = **Welltect** / 運営 = Wellfort。主な利用者は 50〜65 代の経営者・役員。
- **トークンは `tailwind.config.mjs` に集約**。既存クラス名は変えず**パレットの解決先だけ差し替える**方針
  (brand-/slate- は数百箇所で使用中。改名すると差分が全ファイルに広がる)。
  brand = Precision Teal `#287F86` (操作の色) / slate = Warm Ivory〜Graphite / navy・mist・bronze・status.* を追加。
  装飾の cyan/sky/blue/indigo/violet は navy へ寄せて中立化済み。
  - **Quiet Bronze `#A98558` はヘアラインと小面積のみ**。ボタン・カード背景に使わない。
  - **ステータス色は `status.*`** でブランド色と分離。表示は必ず アイコン + テキスト + 色 の 3 点セット。
  - 配色変更時は **WCAG AA を数値で検証**すること (過去に 2 ペアが不足し調整した実績あり)。
- **禁止事項 (発注者指定)**: フルダークモード / グラスモーフィズム / ネオン・発光 / 過度な影 /
  **絵文字を本番素材にする** / 小さく薄いグレー文字 (12px 以下を作らない)。
- **アイコンは Lucide 一本 (`@lucide/astro`, ISC)**。入口は `src/components/AppIcon.astro` の**静的マッピングのみ**
  (動的な文字列ロードをしない)。JS から HTML を組む箇所は `src/lib/icon-svg.ts`。
  - **絵文字を戻さないこと**。`live-controller.ts` の Live プロンプト・`scan-prompt.ts`・`elith-samples.ts` は対象外。
- **ロゴは `src/lib/brand.ts` が解決**。`public/welltect_logo.svg` 等を置けば自動的に切り替わる。
  ブランド資産を目視トレースした代替 SVG は作らない。
- **和文の組版 (2026-08 確定・長文が読めない指摘を受けて)**
  - **`font-feature-settings: 'palt'` は使わない**。和文を詰めるので句読点・カギカッコの
    アキまで削られ、長文で文の切れ目が見えなくなる (実機 Windows で顕在化)。詰め組みが
    要るのは大きな見出しだけで、本文には不要。`global.css` の body から撤去済み。
  - **和文フォントは `BIZ UDGothic` (モリサワ UD フォント) を優先**。`tailwind.config.mjs`
    の `fontFamily.sans` で 欧文/数字 = system-ui、和文 = BIZ UDGothic → Hiragino Sans →
    Noto Sans JP の順に落とす (フォールバックは 1 文字ずつ効く)。
    - **Windows 10 October 2018 Update 以降に OS 標準搭載**なので主要利用者には
      追加ダウンロード無しで届く (出典: モリサワ ニュースリリース morisawa.co.jp/about/news/4010)。
    - **等幅版 (UDGothic) を使う。プロポーショナル版 (UDPGothic) は句読点を詰める**ため、
      今回の指摘に逆行する。欧文・数字は system-ui 側が出すので等幅の影響を受けない。
    - **Web フォントは入れない**。Google Fonts の和文は実測で 400+700 のサブセットが
      約 700KB (BIZ UDGothic 693KB / Noto Sans JP 988KB・本文 603 字で使われる分)。
      統一感のために入れるかは費用対効果で別途判断する。
  - **長文の行長は 38em (≒和文 38 字) で止める**。ワイド画面ではカード幅いっぱいに伸びて
    1 行 90 字超になり目線が戻れない。`.md-region p / li` に `max-width` を掛ける
    (表・画像は対象外)。
  - **行間は詰め気味に (2026-08 見直し)**。「文字が大きすぎる / 1 画面に入る量が少ない」の
    実体は**文字サイズではなく行間**だった。**本文 16px は据え置き** (iOS/Web の標準的な
    本文サイズで、これ以下にすると別の読みづらさが出る)。代わりに
    `fontSize.base` の行間 1.85 → **1.75**、`.md-summary p` は 2.0 → **1.75**、
    `.card` の内側余白はスマホで `p-4` (sm 以上は `p-5`) にした。
    実測 (iPhone 15 Pro 相当 393pt): 1 画面あたり 330 字 → **377 字** / サマリー全体
    5.0 画面 → **4.7 画面**。**高齢者向けに大きくする発想は採らない** (発注者指定
    2026-08:「老人向けサービスでもらくらくホンでもない。30 代でも違和感のないサイズに」)。
    老眼対応は OS/ブラウザの文字拡大に委ねる。
  - **段落化は `report-view.ts` の `paragraphizeJa()`**。Elith のレポートは 1 章が
    まるごと 1 段落 (改行なし・600 字超) で届くため、「。」2 文ごとに空行を入れて段落に割る。
    **内容には触れない** (要約・言い換え・並べ替えをしない = ミッション④)。見出し/箇条書き/
    表/引用など Markdown の構造行は対象外。
  - **文頭の主題を太字にする `emphasizeTopicJa()`** (同ファイル)。均一な灰色の塊で
    「何の話か目に入ってこない」を避ける。**どこが重要かは判断しない** — 日本語の
    主題提示部 (「〜について(は)」「〜に関して(は)」「〜としては」「〜では」「〜は」) を
    文法的に拾うだけで、マーカーが無い文は何もしない。指示語 (これは/その…) は除外。
    **1 段落 1 箇所まで** (全文が太字だと強調の意味が消える)。文字は増減させず `**` を
    挿すだけ = ミッション④ の範囲内。
  - **`**小見出し**` だけの行は `headingizeBoldLines()` で h4 に変換する**。
    以前は CSS の `p:has(> strong:first-child:last-child)` で「太字だけの段落」を
    小見出し扱いにしていたが、**`:first-child`/`:last-child` は text ノードを数えない**ため
    文中に 1 箇所強調を入れた段落まで一致し、**段落全体が太字になる**回帰を出した
    (実測 2026-08)。構造は CSS で推測せず、変換して h4 として出す。
  - 読み物のページ (`/report` のサマリー・要注意) は `BaseLayout width="flow"` (中幅)。
    本文だけ 38em で止めて器が広いままだと右が大きく空く。全編 (PDF) は `app` のまま。
  - **未対応 (発注者判断 2026-08「とりあえず現状のまま」)**: `/notices` と `/coach` は
    今回の刷新の対象外で、本文が `text-xs` (13px) 中心 + `leading-relaxed` の個別指定なので
    **行間トークンの見直しが届いていない** (実測で他ページが -4〜-11% のところ ±0%)。
    他ページと文字サイズの基準が揃っていない。揃えるなら別途作業。
- **未サインイン画面は `src/components/SignInPanel.astro`** (2026-08)。以前はロゴと
  スピナーだけで、One Tap が自動で出るのを待つ作りだった。**One Tap は iOS Safari の ITP や
  Google 未サインインの環境では出ない**ため、その場合に文言もボタンも無い行き止まりになっていた。
  → 見出し+説明+**Google 公式ボタン**(`#gsi-button` に `renderButton`)+読み込み失敗時の
  再読み込み導線、の 4 状態を持たせた。**ロゴ+スピナーだけの実装に戻さないこと。**
  - 責務分界: 表示=`SignInPanel.astro` / 認証処理=`GoogleOneTap.astro`。両者は
    `#gsi-button` と `welltect:signin` イベント (`state: ready|unavailable`, `text`, `tone`) で繋ぐ。
  - 認証失敗は `alert()` をやめ、画面内の `#signin-status` (aria-live) に出す。
    パネルが無いページでは alert にフォールバックする。
  - 使用箇所は `dashboard` / `kit` / `notices`。gate の markup を各ページに複製しない。

- **ホーム画面追加の案内は `src/components/AddToHomeCard.astro`** (2026-08)。開くたびに
  モーダルで出し、閉じたらページ下部のカードとして残す (発注者指示)。中身は 1 つだけ持ち、
  モーダルの器と `#a2hs-slot` の間で要素を移動させる (markup を 2 つ置かない)。
  - **「出さない」判断は 3 つだけ**: ①`display-mode: standalone`/`navigator.standalone`
    (いまホーム画面から起動中) ②`appinstalled` (その場で閉じるだけ)
    ③localStorage `welltect.a2hs.dismissed` (**「このガイドを今後表示しない」を押したときだけ**)。
  - **`appinstalled` と ✕ で ③ を書かないこと**。以前は `appinstalled` で恒久フラグを
    書いていたが、**ホーム画面から削除しても localStorage は消えない**ため、一度追加した
    端末では二度と案内が出せなくなった (実機で発覚 2026-08)。実機の解除は `?a2hs=reset`。
  - **Android は `beforeinstallprompt` を待たない**。Chrome は「タップ 1 回以上 + 30 秒以上の
    滞在」を満たすまで発火しない (web.dev: Installability criteria) ので、発火前は
    ブラウザメニューからの手順を出し、発火したらボタンへ差し替える。
  - ホーム画面アイコンは `scripts/build-pwa-icons.mjs` で生成。**ロゴは無加工**で、
    地の色だけ Executive Navy `#102B3A`。白地はロゴ色 rgb(71,191,200) に対して 2.20:1 しかなく
    「薄い」と指摘された (濃紺なら 6.69:1)。白に戻すなら引数に `"#FFFFFF"` を渡す。

- **表示の原則 (ミッション④)**: 各診断結果を整理して伝える。**独自に分析・解釈しない**。
  - 判定レベルを値と基準値から算出しない。助言文・受診勧告文を生成しない。
  - 表示してよいのは 検査票の値・単位・基準値 と、**検査機関が付けた** `flag` / `assessment`。
    `flag` が null は「印が無い」であって「基準値内」ではない → **判定を表示しない**。
- **テストフェーズの前提 (維持)**: admin なら誰でもアクセスでき全員が同じデータ・同じ表示になる。
  `?u=` 入場 (`dashboard.astro`) / `DEFAULT_USER` フォールバック (`dashboard-queries.ts`) /
  デモ層 (`demo-data.ts`・env `PUBLIC_DEMO_FALLBACK`) / デバッグフッタ。**クライアントの UI 確認に必要なので触らない。**
  本番相当への切替は**総合テスト段階**で行う。

### PII / データ分離
- `customer` スキーマ(PII) と `diagnosis` スキーマ(非PII) を **`diagnostic_user_id` のみで橋渡し**。
  氏名・住所・生年月日を診断系/外部/S3 に載せない (`docs/architecture/data_integration_requirements.md` §1.3,
  `docs/lab/lab_integration_workflow.md` §1.1)。氏名OCRのみでの顧客割当確定は禁止。

#### DB 権限まわりの既知の宿題 (総合テスト時に必ず潰す・2026-08-20)
Supabase database linter の指摘を棚卸しした結果。**テストフェーズの前提 (admin なら誰でも同じ
データが見える) を維持するため、今は直さない**。本番相当へ切り替える段で以下を必ず処理する。
- **[最重要] `customer` スキーマの PII が anon キーで読める**。
  `20260601000020_rls_policies.sql:45` の `grant select on all tables in schema customer to anon`
  ＋ 同 `:63` の `dev_read_all` (`for select using (true)`) の組み合わせ。anon キーは
  `GoogleOneTap.astro:35,53` でブラウザに出るため、**公開鍵だけで `customer_profiles` の
  氏名/住所/生年月日/メール/電話が引ける**。上の「PII は診断系/外部に載せない」方針と正面衝突する。
  → 本番では customer 系の read を `auth.uid()` 紐付け (または service_role 限定) に絞る。
  ※ linter の `rls_policy_always_true` は SELECT を対象外にしているので**この件は警告に出ない**。
- **`dev_authn_write` (`for all to authenticated using(true) with check(true)`) が全 15 テーブル**。
  `20260601000020_rls_policies.sql:67` のループ生成 + 後続マイグレーションの個別コピー。
  authenticated JWT を取れれば全テーブルに書ける。元コード `:51` にも
  「本番移行時に customer 系は service_role 以外の write を禁止する」と書いてある。
- **`function_search_path_mutable` は解消済** (`20260820000050_function_search_path.sql`)。
  3 つとも `new.updated_at = now()` だけで名前解決をしないため `search_path=''` 固定で挙動不変。
  ローカル PG16 で 3 トリガーが発火し続けることを確認済み。
- **Leaked Password Protection (Auth)** はコードでなく Supabase Dashboard の設定
  (Authentication → Providers → Password)。本アプリの認証は `signInWithIdToken` (Google) のみ
  (`GoogleOneTap.astro:56`) なので、**そもそもメール/パスワード サインアップを無効化するのが本筋**。
  ホスト側で有効かは未確認 (`supabase/config.toml:45,48` はローカル用の設定であり本番を表さない)。

## 主要ドキュメント索引

| ドキュメント | 内容 |
|---|---|
| `docs/interview/AI問診_仕様と設計原則.md` | **AI問診の確定仕様・設計原則（責務分界/禁止事項/二重話者問題/修正方針）。コード変更前必読** |
| `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` | Gemini キー発行・**Vercel 環境変数運用**・ローテーション |
| `docs/architecture/system_architecture_overview.md` | 全体構成・**Vercel/タイムアウト**・データフロー |
| `docs/elith/elith_s3_data_handoff_spec.md` | **Elith S3 受け渡し仕様** (パス/命名/format_id/JSON) |
| `docs/elith/elith_batch_centralization_design.md` | Elith バッチ**一元化設計**(キーは Vercel・役割分担・admin バッチ) |
| `docs/elith/elith_assembly_wrapping_spec.md` | **納品セット アセンブリのラップ仕様(Elith向け説明)**。フォルダ/命名/ウェルネス年齢の時系列化(検査日毎・旧1件を撤回)・疑似データも同様に時系列生成・**LAiF AI疾病発症予測(Other/ai_prediction)のファイル仕様=Elith承諾により確定(§5・2026-08)。合成は data.items[] の発症率%/相対リスク比のみジッタ・昨年比は前年の相対リスク比を引継ぎ(実装済)**・manifest不一致の確認事項 |
| `docs/elith/ai_prevention_report_generation_spec.md` | **AI疾病予防報告書 生成機能の仕様 (パイプライン⑥・2026-08-28)**。受領 JSON 3 点 → アプリが可読な報告書を生成。入力仕様/出力は HTML+印刷CSS(PDF生成しない)/章立て/決定論の変換規則/**作れないもの①〜④と捏造ゼロの境界**/受領データの既知不具合/実装計画/Elith 確認事項 |
| `docs/elith/batch_scan_to_elith_usage.md` | サンプル一括スキャン→S3 バッチ手順 (`scripts/batch-scan-to-elith.mjs`) |
| `docs/lab/lab_data_pipeline_master_spec.md` | **検査データ・パイプライン 総合仕様書(E2E正本・上位文書)**。EC購入→キット/タイミング→発送指示/進捗→AI問診/検体返送→各社受渡→受領チェック(週次)→Elithラップ/S3書出→AI診断PDF受取/表示 を6ステップで連結。詳細は(a)(b)(c)へ委譲(二重管理しない) |
| `docs/lab/lab_data_reception_overview.md` | **4検査のデータ受取 詳細**(血液=リージャー/RPA・がん=プリベント/専用ポータル+S3を提案中・AI疾病予測=LAiF/S3 URL・遺伝子=Genoplan/RPA。方式/経路/現状/課題/次アクション)。E2E全体像は上記 master_spec が上位 |
| `docs/lab/questionnaire_to_lab_csv_spec.md` | **AI問診回答→各社CSV 変換仕様(実装用)**。共通設問No→各社必要行のマスターマッピング表+各社項目リスト+生成ルール(フリー/選択/範囲/複数)+PII確認事項。元=Wellfort問診項目マトリクスExcel |
| `docs/lab/demecal_auto_download_overview_spec.md` | 血液検査データ自動DL (デメカル/mTLS) 概要 |
| `docs/lab/demecal_inquiry_email_template.md` | 検査会社への自動DL可否 照会メール雛形 |
| `docs/subscription/subscription_management_feature_requirements.md` | サブスク契約管理 拡張 機能要件 (要件1〜4・データモデル・付録Bマトリクス) |
| `docs/subscription/subscription_management_implementation_guide.md` | 上記の実装手順書 |
| `docs/subscription/kit_lifecycle_and_handoff_management_spec.md` | **検査キット 出荷・進捗・データ受渡 統合管理仕様(サブスク駆動)**。プラン×キット×発送タイミング/タカセ定期出荷/ライフサイクル状態機械+AI問診促し/進捗駆動の各社受渡・Elith作成指示。**§4.1.1=LAiF上りCSV(AI疾病発症予測 入力フォーム 約158項目)の写像仕様＋生成フロー**(健診スキャン+AI問診+基本情報を集約=スキャンフローに足さない別export・整理番号/生年月日は要確認) |
| `docs/lab/wellfort_admin_lab_upload_spec.md` | 管理UI: 検査結果ファイルアップロード仕様 |
| `docs/lab/lab_integration_workflow.md` | 検査機関→ユーザー割当ワークフロー (PII 制約) |
| `docs/lab/kit_progress_management.md` | 検査キット発送・進捗管理 |
| `docs/architecture/data_integration_requirements.md` | PII 分離・連携要件 |
| `docs/operations/S3原本ストレージ_構築手順書.md` | **原本を S3 ap-northeast-1 へ置くためのインフラ手順** (Object Lock / ライフサイクル / IAM / Vercel env / 動作確認)。Compliance モードの不可逆性に注意 |
| `docs/architecture/id_management_and_correlation_spec.md` | **ID体系の正本**(顧客ID/診断ユーザーID=diagnostic_user_id/注文/契約/出荷/検査/各社上りID/Elith client_id を層別整理・採番=現状全てWellfort・相関マップ・PII境界・**将来の各社独自ID/キット物理ID(POS/バーコード)連携=受け皿カラム`lab_tests.external_test_id`/`external_barcode`実在**) |
| `docs/architecture/diagnostic_session_data_spec.md` | 診断セッションのデータ構造 |
| `docs/scan/scan_feature_requirements.md` / `docs/scan/scan_s3_export.md` | AIスキャン機能要件 / S3書き出し |
| `docs/scan/health_age_caba_v5.4_spec.md` | **ウェルネス年齢 ①正規版(CABA v5.4)確定事項** (免責2文/WBC桁正規化/補完定数/SBP・FEV補正・Wellfort確認2026-08) |
| `docs/scan/health_age_simple_v7.0_spec.md` | **ウェルネス年齢 ②簡易版(CABA v7.0)** = 血球分画/ALP/WBC/CRP を持たない簡易書式向けフォールバック。**改称(健康年齢→ウェルネス年齢)の適用範囲・段階フォールバック①②③・移植元の復元手順と数値照合表**もここ |
| `docs/scan/scan_canonicalization_standard_format_design.md` | **戦略正本: 検査票→標準フォーマット正準化(2層戦略)**。①読取=native multimodal維持 / ②正準化=健診標準フォーマット(KMAT)への決定論マッピング新規 |
| `docs/ai_reviews/` | Gemini/ChatGPT へのレビュー依頼・相談ドラフト集(開発経緯の記録。確定仕様は各 spec が正本) |

## コード / スタック
- Astro v5 + TypeScript (SSR / Vercel)。UI=`.astro`、API=`src/pages/api/**.ts`、ロジック=`src/lib/`。
- Supabase 2スキーマ (`customer`=PII / `diagnosis`=非PII)。マイグレーション=`supabase/migrations/`。
- 標準スクリプトは `scripts/*.mjs` (Node ESM, 追加依存なし方針)。
- 主要ライブラリ: `@google/genai`(Gemini)、`@aws-sdk/client-s3`(S3)、`@supabase/supabase-js`。

## 開発ブランチ / ブランチ管理 (2リポジトリ・ドメイン別・ペア運用・2026-08 定義)
- **ドメイン別ブランチ**: wellfort-site は EC/FA/Elith 等 関心事が混在するため、関心事ごとにブランチを分ける
  (`claude/<domain>-<topic>`。EC/FA と Elith を混ぜない)。
- **Elith/scan精度 作業の正本ペア (この作業線)**:
  - **Scan-Chat-AI = `claude/clever-cray-ngg0h6`** (読取/正準化/dedup/perception/**golden 正解データ(docs)**)。
  - **wellfort-site = `claude/elith-verify-image-json`** (admin UI・**goldenCheck 照合器**・necessity 可視化)。
  - **🎯 検証はこの2本を同時デプロイして成立** (Scan-Chat-AI API × wellfort-site admin)。EC/FA ブランチには触らない。
- **照合(検証)のタイプ別定義** (照合器=wellfort-site admin / golden正解データ=Scan-Chat-AI docs):
  | タイプ | format_id | 取得 | 🎯値golden(決定論・画像非依存) | 🔍画像照合(LLM) | ④の照合 |
  |---|---|---|---|---|---|
  | 健康診断(検診) | HealthCheckupData | アプリscan | ○ `docs/scan/golden/scan_golden_healthcheckup_20250123.md` | ○ | — |
  | 人間ドック | HealthCheckupData | アプリscan | ○ `docs/scan/golden/scan_golden_humandock_20240924.md`／`…_20250217.md`(湘南メディカル個人表様式・未実施多数=定性番人) | ○ | — |
  | がんリスク | CancerRiskAssessmentData | adminバッチ | ○ `docs/scan/golden/scan_golden_cancer_alapds_20251226.md`(ALA-PDS様式1) | ○ | — |
  | 遺伝子 | GeneticTestResultData | adminバッチ | 建立待ち(様式1) | ○ | — |
  | AI疾病発症予測(LAiF) | Other/ai_prediction | adminバッチ(多ページPDF) | ○ `docs/scan/golden/scan_golden_ai_prediction_laif_20250818.md`(様式1・2ページ目=本人結果) | △(値中心・名前セル不可読) | — |
  | 血液 | BloodTestData | デメカルCSV | (CSV由来値で可) | **×(画像なし)** | **CSV↔JSON構造照合(決定論・Scan-Chat-AI scripts)** |
  - **🎯値golden = 画像非依存**なので全タイプで使える(正解値さえ建立すれば)。`elith-batch.astro goldenCheck` は
    `test_date` で検体切替(検診/人間ドック実装済・②③は様式1つで各1本)。
  - **golden は必ず元画像から人手で起こす (2026-08 確定・R2/R3)**: スキャン run の raw_markdown を"正解"にしてはならない。
    実障害(2026-08): 人間ドック golden を scan 出力から作った結果、その run の隣接行シフト/脂質混入を golden が継承し
    (LDL/HDL/TG・LDH/ALP/γ-GTP・好酸球/好塩基球 が誤り。LDL+HDL=176>TC=151 の物理矛盾を見落とし)、**正しいスキャンを
    誤判定して改善を誤導**した(ChatGPT指摘で発覚→元画像で全項目再監査し修正、`docs/scan/golden/scan_golden_humandock_20240924.md`)。
    建立時は 推移グラフ/Friedewald(TC≒LDL+HDL+TG/5)/基準値レンジ 等でクロス検算する。
  - **🔍画像照合 = 画像がある型(検診/人間ドック/がん/遺伝子)のみ**。④血液は CSV が決定論正解源=画像照合不可 →
    **CSV↔JSON 構造照合**(全項目写像=漏れゼロ/余剰=捏造ゼロ/単位・判定コード対応)を Scan-Chat-AI 側 fixture で。
- **git 規定との関係**: タスク既定は両repo `clever-cray-ngg0h6` だが、wellfort-site の Elith admin は上記のとおり
  `elith-verify-image-json` を正本とする(発注者承認 2026-08)。別ブランチへの push は都度明示許可を得る。
</content>
