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
- **使用モデルは env で差替え可 (コード変更不要・env反映は再デプロイ要)**。既定は `src/lib/gemini.ts` の `MODELS`。
  - スキャン (画像解析・全 REST 呼び出し): 既定 **`gemini-3.1-flash-lite`** (軽量・安定)。`GEMINI_SCAN_MODEL` で上書き。
    精度を上げるなら `gemini-3.5-flash` (GA) だが、**混雑時に 503(model overloaded) が出やすくバッチ全滅の実績あり (2026-07)**
    ため常用の既定は 3.1-flash-lite に据え置き。Tier1 未開通/不具合時は `gemini-2.5-flash` (旧既定) へ。
    ※ 正式ID は Gemini API 公式 (ai.google.dev/gemini-api/docs/models/gemini-3.5-flash) で確認: Stable=`gemini-3.5-flash` /
      Preview=`gemini-3-flash-preview`。**末尾-preview無しの `gemini-3-flash` は Gemini API に存在しない** (設定すると全スキャン失敗)。
    - **前提**: 3.x 系は **Tier1 (課金有効化) + 当該キーでのモデルアクセス** が必要。未開通のまま 3.x を指すと
      全スキャン (検診/がん/血液image/遺伝子) が失敗する → その場合は env で 2.5 に戻す。
    - スキャン精度は **検診 numeric → 健康年齢 (CABA)** に直結。モデル切替時は代表ページで再検証すること。
  - Live (AI問診): 既定 `gemini-3.1-flash-live-preview` (REST 非対応の専用プレビュー)。`GEMINI_LIVE_MODEL` で追従。
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

### PII / データ分離
- `customer` スキーマ(PII) と `diagnosis` スキーマ(非PII) を **`diagnostic_user_id` のみで橋渡し**。
  氏名・住所・生年月日を診断系/外部/S3 に載せない (`docs/architecture/data_integration_requirements.md` §1.3,
  `docs/lab/lab_integration_workflow.md` §1.1)。氏名OCRのみでの顧客割当確定は禁止。

## 主要ドキュメント索引

| ドキュメント | 内容 |
|---|---|
| `docs/interview/AI問診_仕様と設計原則.md` | **AI問診の確定仕様・設計原則（責務分界/禁止事項/二重話者問題/修正方針）。コード変更前必読** |
| `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` | Gemini キー発行・**Vercel 環境変数運用**・ローテーション |
| `docs/architecture/system_architecture_overview.md` | 全体構成・**Vercel/タイムアウト**・データフロー |
| `docs/elith/elith_s3_data_handoff_spec.md` | **Elith S3 受け渡し仕様** (パス/命名/format_id/JSON) |
| `docs/elith/elith_batch_centralization_design.md` | Elith バッチ**一元化設計**(キーは Vercel・役割分担・admin バッチ) |
| `docs/elith/elith_assembly_wrapping_spec.md` | **納品セット アセンブリのラップ仕様(Elith向け説明)**。フォルダ/命名/健康年齢の時系列化(検査日毎・旧1件を撤回)・疑似データも同様に時系列生成・**LAiF AI疾病発症予測(Other/ai_prediction)のファイル仕様=Elith承諾により確定(§5・2026-08)。合成は data.items[] の発症率%/相対リスク比のみジッタ・昨年比は前年の相対リスク比を引継ぎ(実装済)**・manifest不一致の確認事項 |
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
| `docs/architecture/id_management_and_correlation_spec.md` | **ID体系の正本**(顧客ID/診断ユーザーID=diagnostic_user_id/注文/契約/出荷/検査/各社上りID/Elith client_id を層別整理・採番=現状全てWellfort・相関マップ・PII境界・**将来の各社独自ID/キット物理ID(POS/バーコード)連携=受け皿カラム`lab_tests.external_test_id`/`external_barcode`実在**) |
| `docs/architecture/diagnostic_session_data_spec.md` | 診断セッションのデータ構造 |
| `docs/scan/scan_feature_requirements.md` / `docs/scan/scan_s3_export.md` | AIスキャン機能要件 / S3書き出し |
| `docs/scan/health_age_caba_v5.4_spec.md` | **健康年齢(CABA v5.4)確定事項** (免責2文/WBC桁正規化/補完定数/SBP・FEV補正・Wellfort確認2026-08) |
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
  | 人間ドック | HealthCheckupData | アプリscan | ○ `docs/scan/golden/scan_golden_humandock_20240924.md` | ○ | — |
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
