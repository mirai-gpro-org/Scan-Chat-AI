# デメカル自動取得 — 泥沼脱出計画 / 実装ディレクション

**作成日:** 2026-09-02  
**対象:** `scripts/demecal-daily.ps1` 系（デメカル汎用CSV自動取得）  
**基準:** `claude/awesome-carson-UeyUZ` / `b75e322` 時点の実装・実測資料・Wellfort提供の操作動画  
**状態:** **方向性承認済み。Phase A から実施する。**

---

## 0. この文書の目的

これまで `demecal-daily.ps1` は、専用PCでの実行失敗 → 診断追加 → 再実行 → 推測修正、という反復になり、Wellfort 側へ何度も実行依頼する状態になった。

この案件では専用PCの実行は通常の開発デバッグではない。**Wellfort役員に操作を依頼する高コストな本番相当テスト**である。

したがって今後は、

> **実機テストはデバッグ工程ではなく、事前分析とローカル検証で固めた結論を確認する最終検証工程とする。**

この原則に基づき、既存の `daily-1.7` をいったん凍結し、以下の3フェーズで立て直す。

---

# 1. 役割分担

## 1.1 ChatGPT / GPT-5.6 Sol

担当:

- 実測事実・動画・既存コード・仕様の突合
- Confirmed / Unknown / 推論の分離
- 全体アーキテクチャ・状態遷移設計
- 詳細仕様・安全条件・Acceptance Criteria の決定
- Claude Code が作った差分のレビュー
- Phase A → B → C の移行判定

**ChatGPTは原則としてアプリ実装を直接行わない。**

## 1.2 Claude Code

担当:

- 本文書およびChatGPTが確定した仕様に従う実装
- fixture / unit / regression test の作成と実行
- GitHub上へのcommit / push / PR作成
- 実装結果・テスト結果・SPEC CONFLICTの報告

Claude Code がしてはいけないこと:

- 実測されていない原因を「真因」と断定する
- Unknownを推測で埋めて本番コードへ反映する
- 失敗したら診断を足してWellfortへ再実行依頼する、という反復を始める
- 本文書のPhase境界を独断で越える
- Phase A中にElith/S3/`last_to`の本番writeを有効にする

仕様と実装の現実が衝突する場合は、**推測で迂回せず STOP → ChatGPTへ SPEC CONFLICT を返す。**

---

# 2. 現時点で確定している操作フロー

Wellfort提供の操作動画を正本として、人間の操作は以下の3状態で整理する。

## STATE A — 販売先選択

表示URL:

```text
/hanyou/start
```

実測:

- 代理店: `Q05-0010 / 株式会社ウェルフォート` は表示済み
- **販売先は最初は空**
- 人が販売先プルダウンを開き、**`000000 株式会社ウェルフォート` を明示選択**
- その後「次へ」

重要:

- 「販売先000000は最初から入っている」という従来文書の記述は動画と一致しない
- `000000` は推測値ではなくWellfortの業務契約値
- `000000` が選択肢に存在しなければ別候補を試さず **FAIL**

## STATE B — 条件入力

動画上、表示URLはまだ:

```text
/hanyou/start
```

実測入力:

- `DateFrom` / `DateTo`
- 検査結果: **正常終了のみ**
- 項目見出し: 既定は「出力しない」だが、**人が「出力する」へ変更**
- 「確認」

reconで存在確認済みの主要field:

```text
DateFrom
DateTo
DataType
OutputHeader
submitType
__RequestVerificationToken
```

業務上の明示条件:

```text
DataType     = 正常終了のみ
OutputHeader = 出力する
```

「現在checkedだからそのまま」は不可。対象ラベルに対応するvalueを画面から取得して明示設定する。

## STATE C — 確認画面

「確認」後、動画上の表示URL:

```text
/hanyou/entry
```

実測表示:

- 代理店 `Q05-0010`
- 販売店 `000000`
- 日付範囲
- 検査結果 `正常終了のみ`
- 項目見出し `出力する`
- 件数（動画では18件）
- 「ダウンロード」「戻る」

「ダウンロード」後、実測ファイル名例:

```text
Q05-0010-000000result_20260701_18.csv
```

---

# 3. 設計方針変更 — 汎用探索器をやめる

`daily-1.7` は現在、概ね次の探索を行う:

```text
何も押さない
 → 同じ画面なら候補1
 → 候補2
 → ...
 → 戻る / cancel系も試す
 → MaxHopsまで反復
```

この方式を**本番経路から廃止**する。

理由:

1. 人間の正しい操作は動画ですでに固定されている
2. 業務サイトで「戻る」「cancel」まで総当たりするのはfail-closedではない
3. 画面変更時には別操作を試すのではなく即座に検知して止まるべき
4. これまでの泥沼化の主要因が「症状から候補を増やして試す」ことだった

新方式:

```text
STATE A を機械判定
  → Aで許可された操作のみ
  → 応答がSTATE BでなければSTOP

STATE B を機械判定
  → Bで許可された操作のみ
  → 応答がSTATE CでなければSTOP

STATE C を機械判定
  → ダウンロードのみ
  → CSVでなければSTOP
```

削除/本番経路から除外する対象:

- `MaxHops` による探索
- `$tried` による候補総当たり
- 「押さない→別候補→戻る/cancel」自動試行
- Unknownな操作値を外部JS最大N本から探して総当たりする処理
- 状態不一致時に別操作を試して前進を試みる処理

必要なら診断目的のHTML parserは残してよいが、**未知状態から前進するためには使わない。**

---

# 4. Confirmed / Unknown の扱い

## 4.1 Confirmed

- mTLSクライアント証明書が必要
- 証明書は `Cert:\CurrentUser\My` / user `info`
- GET login → antiforgery hidden + Cookie → 同一sessionでPOST
- ログイン失敗でもHTTP 200になり得る
- STATE A/B/Cの人間操作
- 販売先 `000000`
- `DataType = 正常終了のみ`
- `OutputHeader = 出力する`
- 日付は `yyyy/MM/dd`
- 日付条件は結果承認日基準
- CSVはShift_JIS
- CSVには `指図番号` / `結果承認日` / `結果項目数` 等のヘッダがある

## 4.2 実在バグとしてConfirmed

- `daily-1.6` の `Html-Decode` 定義順バグ
- HTML属性値を未decodeのままPOSTして多重escapeを起こしていた問題
- `daily-1.7` の `$r.Content` をbyte[]として扱う実装はWindows PowerShell 5.1の型と不整合
- 現在の0件処理は正本仕様「0件成功」と不整合
- 現在の本番取り込みは `client_id = test-<時刻>-<連番>` で本人紐付け未実装
- 同一範囲再取得時の冪等性未実装

## 4.3 Unknown — 推測で埋めない

- STATE Bの「確認」で実際に送る `submitType` の値と正確なDOM/JS契約
- STATE Cの「ダウンロード」の正確なDOM/POST契約
- CSV応答の本番Content-Type / Content-Dispositionの正確な値

既存skeleton / recon報告から確定できるものは実機を使わず解析する。
確定できない場合、Phase Bの**1回だけのverify-only実行**で観測する。

---

# 5. Phase A — 実機なしで作り直す

## 5.1 Goal

Wellfort専用PCを一切使わず、

```text
STATE A → STATE B → STATE C → CSV
```

を決定論的に処理できるコードとfixtureテストを完成させる。

## 5.2 必須実装

### A-1. deterministic state machine

3状態をfield集合・期待値・actionで明示する。

例:

```text
A: dealer/seller selection fields
B: DateFrom + DateTo + DataType + OutputHeader + submitType
C: confirmation/download form
```

URLだけで状態判定しない。STATE B/Cは同系URLになり得るためfield構造を併用する。

**判定順は B → C → A。** STATE C が `HanbaitenCode` を hidden で持ち回り、
`DateFrom`/`DateTo` を持たない形のとき、A を先に見ると **C を A と誤判定**して
1段目へ戻ろうとする。「ダウンロードの押しどころが在る」は C にしか無い特徴なので A より先に見る。

**form の選び方も探索にしない。** 「token以外のfieldが最も多いformを採る」ような
ヒューリスティックは使わない（検索formのようなdecoyが対象より多くのfieldを持てば
そちらを掴む）。**各stepで全formを判定し、期待STATEに一致するformが正確に1件のときだけ採用**する。
0件・複数件はfail-closed。

### A-2. 業務値を明示契約化

```text
ExpectedDealerCode = Q05-0010
ExpectedSellerCode = 000000
ExpectedDataType    = 正常終了のみ
ExpectedHeader      = 出力する
```

値はHTML内の対応option/radioから取得する。**存在しない場合はFAIL。代替値を選ばない。**

### A-3. HTML decode

ブラウザのform送信相当になるよう、HTML属性値を必要な箇所で**1回**decodeする。
多重decodeはしない。

### A-4. CSV byte処理

対象はWindows PowerShell 5.1。

CSVは `$r.Content` をbyte[]扱いせず、`RawContentStream` からbyte[]を取得する。

そのbyte[]を:

- Shift_JIS decode
- SHA-256
- byte count
- row count
- header validation

に使用する。

### A-5. CSVの厳格判定

「text/htmlでないからCSV」だけでは成功にしない。

最低条件:

- attachment/filenameを確認可能なら確認
- filenameがデメカル規則に合うことを確認
- decoded headerに少なくとも以下が存在:

```text
指図番号
結果承認日
結果項目数
```

必要に応じて `性別` / `生年月日` / `採血日` も必須ヘッダへ含める。

### A-6. verify-only mode

**Phase B用のverify-only経路を実装する。**

**verify-only が禁止するのは「業務データのwrite」であって、writeの一切ではない。**
非PIIの診断用POSTは**むしろ必要**（無人運用で黙って失敗するのを避けるため）。
実装レビュー時にここを「write一切禁止」と読んで診断POSTまで消さないこと。

**禁止（業務データ）**

- `/api/admin/elith-blood-csv` を呼ばない
- BloodTestData / S3 への本番投入をしない
- `/api/admin/demecal-state`（`last_to`）を読まない・更新しない
- CSVをディスクへ保存しない
- CSV本文をログ/S3/probeへ送らない

**許可（非PIIの診断）**

- `/api/admin/demecal-run` … 実行ログ。下記だけを送る
- `/api/ops/probe-upload` … **失敗したときだけ**画面の骨格（タグと script。本文テキストは載せない）

許可する報告:

```text
state transitions
HTTP status
content-type
content-disposition (PIIを含まない範囲)
filename
byte count
row count
SHA-256
required-header validation result
```

PIIを含むCSV本文はメモリ内だけで破棄する。

### A-7. fixture test

最低限以下の完全架空fixtureを用意:

```text
state-a.html
state-b.html
state-c.html
sample.csv
```

テスト内容:

1. Aで `000000` を選べる
2. `000000`が無ければFAIL
3. Bで日付を設定
4. Bで「正常終了のみ」を明示選択
5. Bで「出力する」を明示選択
6. 対象ラベルが無ければFAIL
7. Cだけでdownloadへ進む
8. 戻る/cancelを自動実行しない
9. 想定外stateは即FAIL
10. CSV byte[]を壊さない
11. Shift_JISヘッダ検査PASS/FAIL
12. verify-onlyで業務データのwrite系が1つも現れない（診断POSTは残っていること・probeは失敗時のみ）
13. decoy formが対象より多くのfieldを持っても、期待STATEのformを選ぶ
14. 期待STATEのformが0件・複数件ならfail-closed
15. `HanbaitenCode` hidden + ダウンロードbutton + datesなし をCと判定する（Aに誤判定しない）

## 5.3 Phase Aでやらないこと

- 本人 `diagnostic_user_id` 紐付けの本実装
- 冪等性の本実装
- overlap取得方式の確定
- 本番`last_to`更新
- 本番Elith/S3投入
- タスクスケジューラによる無人定期運用
- Wellfortへの実行依頼

## 5.4 Phase A Exit Criteria

全て満たしたらChatGPTへレビュー依頼:

- fixtureのA→B→C→CSVがPASS
- negative testsがPASS
- PS5.1互換を前提にbyte処理検証済み
- verify-onlyの**業務データwrite禁止**がテストで保証される（かつ診断POSTが残っていることも）
- Unknownを推測実装していない
- `daily-1.7` の探索ロジックを本番経路から除外

**ChatGPTがGOを出すまでPhase Bへ進まない。**

---

# 6. Phase B — Wellfortで1回だけverify-only

## 6.1 Goal

実サイトで、事前に作った3-stateモデルとHTTP/DOM契約が一致することを**1回だけ**確認する。

これはデバッグではなく最終疎通確認。

## 6.2 実行内容

```text
login
 ↓
STATE A validation
 ↓
STATE B validation
 ↓
STATE C validation
 ↓
CSV download to memory
 ↓
byte/header validation
 ↓
report only
 ↓
memory discard
```

## 6.3 Phase Bで禁止（業務データのwrite）

- Elith/S3へBloodTestDataを書かない
- `elith-blood-csv` を呼ばない
- `last_to`を書かない（読まない）
- PII CSVをディスクへ保存しない
- CSV本文をprobe/reportへ送らない
- 失敗後にその場で別候補を自動試行しない

**禁止されていないもの（非PIIの診断・むしろ必要）**

- `/api/admin/demecal-run` への実行ログPOST（§6.2 の report only の実体）
- **失敗時のみ** `/api/ops/probe-upload` への骨格アップロード（§6.4 の「非PII構造情報を持ち帰る」の実体）

## 6.4 失敗コード

曖昧な「進めません」ではなく、一意な分類にする。例:

```text
STATE_A_EXPECTATION_FAILED
STATE_A_SELLER_000000_NOT_FOUND
STATE_B_EXPECTATION_FAILED
STATE_B_DATATYPE_NOT_FOUND
STATE_B_OUTPUTHEADER_NOT_FOUND
STATE_B_CONFIRM_ACTION_UNKNOWN
STATE_C_EXPECTATION_FAILED
STATE_C_DOWNLOAD_ACTION_UNKNOWN
CSV_RESPONSE_INVALID
CSV_BYTES_INVALID
CSV_HEADER_INVALID
```

失敗時はその1回の情報でChatGPTが次の判断をできるだけの**非PII構造情報**を持ち帰る。

## 6.5 Phase B Exit Criteria

- A/B/C全state一致
- 正しい業務値を送信
- CSV応答取得
- byte[]取得正常
- Shift_JIS decode正常
- 必須ヘッダ正常
- writeが1件も発生していない

ここで初めて「デメカル取得部は完成」と判定する。

## 6.6 Phase B 完了記録（2026-09-03・`verify-1.4`・ChatGPT 判定 PASS）

**専用PC で `scripts/demecal-verify.ps1` / `verify-1.4` を実行し、結果 ○。**
上の Exit Criteria を全て満たしたので **Phase B PASS**。

実測の経緯は `docs/lab/demecal_unattended_spec.md` の ②-1〜②-6 が正
（1 回の実機ごとに 1 節。停止コードと実測 DOM と修正内容をそこに書いてある）。

### Confirmed（この 4 回の実機で確定したこと）

| # | 事項 | 確定した回 |
|---|---|---|
| 1 | **mTLS**（`Cert:\CurrentUser\My` の証明書で接続）と **login**（GET→POST の antiforgery 往復） | `verify-1.0` 以降 全回 |
| 2 | **STATE A**（`/hanyou/start`） | `verify-1.1` |
| 3 | **STATE B**（`/hanyou/entry`） | `verify-1.2` |
| 4 | **STATE C**（`/hanyou/confirm`） | `verify-1.4` |
| 5 | **`GET /hanbaiten?dairitenCode=…` → `code=="000000"` がちょうど 1 件** で販売先が決まる | `verify-1.1`→`1.2` で通過 |
| 6 | **検査結果「正常終了のみ」/ 項目見出し「出力する」** をラベル起点で選んで送ると受理される | `verify-1.2`→`1.3` で通過 |
| 7 | **`POST /hanyou/confirm` に `submitType=download`** を送ると CSV 応答が返る | `verify-1.4` |
| 8 | **CSV レスポンスが返ること自体** | `verify-1.4` |
| 9 | **Windows PowerShell 5.1 で `RawContentStream` から byte[] を取れる**（`$r.Content` は文字列なので使わない） | `verify-1.4` |
| 10 | **Shift_JIS として decode できる** | `verify-1.4` |
| 11 | **filename 規則 / 必須ヘッダ / 行数** の検査が通る | `verify-1.4` |
| 12 | **verify-only で業務データの write が 1 件も発生しない**（`elith-blood-csv` / BloodTestData / S3 / `last_to` / CSV のディスク保存・本文送信 いずれも無し） | 全 4 回 |

**傍証（こちらで実測）**: `verify-1.4` の回で `probe-upload` へ**新しい骨格が 1 件も上がっていない**
（`probe-list` の件数 31・最新は `verify-1.2` の `f2c747ee` のまま）。
`Send-Skeleton` は**失敗経路にしか無い**ので、成功時にこうなるのが正しい挙動。

**この記録に個々の実測値（行数・ファイル名・SHA-256）は書かない** — 実行画面の値が
こちらへ渡っていないため。**書けば捏造になる。** 必要なら
`GET /api/admin/demecal-run` の実行ログ（非PII）に残っている。

### この時点の到達点と非到達点

- **到達**: 「デメカルから CSV を 1 本、正しく取ってきてメモリ上で検証できる」までが機械で担保された。
- **非到達（Phase C の担当）**: 本人紐付け / 冪等性 / date watermark と overlap / 0 件の扱い /
  本番 write の順序 / 無人化（タスク登録・監視）。**この 6 つは 1 行も実装していない。**

### 成功証跡として残すもの

- **`scripts/demecal-verify.ps1` (`verify-1.4`) は消さない。** Phase B の成功証跡であり、
  Phase C で本番経路を作った後も「取得部だけを業務データ write 抜きで試せる唯一の口」になる。
- **`scripts/demecal-daily.ps1` (`daily-1.7`) の凍結は維持**（`api/ops/probe-bat` の `FROZEN` で
  409 を返す）。Phase C の実装が出来るまで**配布しない**。

---

# 7. Phase C — 取得運用の完成

**【スコープ訂正 2026-09-03・ChatGPT】** 旧 §7 は「本番連携と無人化」として
**本人紐付け・冪等性・Elith/S3 本番 write** まで含めていたが、**広げすぎだった**。

正本の再確認:

- `demecal_auto_download_overview_spec.md` の目的は **CSV 自動ダウンロード・定期取得**
- **後続連携は「任意」**
- `lab_integration_workflow.md` は**ユーザー割当を扱う別仕様**

→ **このセクションの責務を「Leisure / Demecal から血液検査 CSV を
安全・確実・無人で取得すること」だけに限定する。**

## 7.0 スコープ

### In Scope

```text
mTLS
login
STATE A/B/C
date range
CSV download
RawContentStream byte[]
Shift_JIS
filename / header / row-count / SHA-256 validation
0-row handling
acquisition watermark / overlap の要否 (→ C-2 で「しない」と確定)
Task Scheduler
acquisition monitoring
fail-closed
PII を不要に保存しない
```

### OUT OF SCOPE — see lab integration / data pipeline specs

```text
指図番号 → diagnostic_user_id
mapping table
customer / app_bridge
EC
lab_tests
test_artifacts
diagnosis DB
Elith JSON
Elith S3 handoff
全体パイプライン設計
```

**今後このセクションでは、上記について調査・設計・実装・質問作成を行わない。**
参照先は `lab_integration_workflow.md` / `lab_data_pipeline_master_spec.md` /
`id_management_and_correlation_spec.md`。

旧 §7 の本文と、それを具体化した `demecal_phase_c_spec_20260903.md` は
**削除せず履歴として残す**（同 spec の冒頭に
`SUPERSEDED FOR DEMECAL ACQUISITION SCOPE` を記録済み）。

## 7.1 既存成果物の扱い

| 成果物 | 扱い |
|---|---|
| `scripts/demecal-verify.ps1` (`verify-1.4`) | **取得部の実機成功証跡として保持。** 変更しない |
| `scripts/demecal-daily.ps1` (`daily-1.7`) | **凍結維持。** 新 runner ができるまで配布しない |
| `parseBloodCsvRowsStrict()` / C1-A 実装 | **revert しない。** ただし**後段データ処理向けの成果物**として扱い、
**取得の完成条件から外す**。**このセクションでは `src/lib/elith-blood-csv.ts` を変更しない** |

## 7.2 Phase C（取得）の対象

```text
C-1 date range / watermark
C-2 retry / catch-up
C-3 zero rows
C-4 production acquisition runner
C-4.1 distribution / install   (3 本を専用PC へ配置する)
C-5 scheduler                  (無効のまま登録するところまで)
C-6 monitoring
```

### C-1. date range / watermark

`last_to` の意味を「**結果承認日で、この日までの取得が成功した**」という
coverage high-watermark として確定する。

- **`to = today` は使わない**（当日中に結果承認される行を取り逃すため）。
- **失敗時に `last_to` を前進させない**（この性質が無人運用の根拠。§1）。
- **`last_to` は CSV 内の最大採血日・最大 test_date ではない。**

#### C-1 確定仕様（2026-09-03・実装済み）

| | |
|---|---|
| 実装 | `scripts/demecal-range.ps1` の **`Resolve-DemecalAcquisitionRange -LastTo <s> -TodayJst <s>`** |
| 検査 | `scripts/tests/demecal-range.tests.ps1`（`npm run verify:demecal-range`・**68 件**） |
| 範囲 | `to = TodayJst - 1日`（**JST の昨日**） / `from = last_to + 1日` |

**`today_jst` は呼び出し側（C-4 の本番 runner）が渡す。プランナ内部で現在時刻を取らない。**
そうしないと日付をまたぐ瞬間もうるう年も**テストで固定できない**（実行日で結果が変わるテストは
通っても何も保証しない）。ネットワーク / S3 / デメカル / state POST からも独立した純粋関数。

返り値（`Status` / `Code`）と、それぞれで**次に何をしてよいか**:

| Status | Code | From/To | 次の動作 |
|---|---|---|---|
| `ready` | — | **入る** | この範囲で取得してよい |
| `noop` | `OK_NOOP` | **空** | 追いついている。**login / download を実行しない**。実行ログは `result=ok` / `rows=0` / range なし |
| `not_initialized` | `STATE_NOT_INITIALIZED` | **空** | **停止**。直近 N 日などを自動設定しない |
| `invalid_state` | `TODAY_JST_INVALID` / `STATE_LAST_TO_INVALID` / **`STATE_LAST_TO_AHEAD_OF_WINDOW`** / `DATE_OUT_OF_RANGE` | **空** | fail-closed で停止 |

**watermark と窓の終端 (`to` = JST の昨日) の関係で 3 つに分かれる**
（2026-09-03 レビュー裁定。**`last_to > to` を `noop` にしない**）:

| 関係 | 結果 | 例 (`today=2026-09-03` → `to=2026-09-02`) |
|---|---|---|
| `last_to < to` | `ready` | `last_to=2026-09-01` → `ready 09-02..09-02` |
| `last_to == to` | `noop` / `OK_NOOP` | `last_to=2026-09-02` → `noop` |
| `last_to > to` | `invalid_state` / **`STATE_LAST_TO_AHEAD_OF_WINDOW`** | `last_to=2026-09-03`（= today）/ `2026-09-05` → `invalid_state` |

**理由**: `last_to` は「結果承認日ベースで、この日まで取得完了」の watermark なので、
**窓の終端より未来の値は「追いついた」ではなく、状態が壊れている証拠**
（時計ずれ / 別環境の state を読んだ / 誤った `force` 巻き戻し 等）。
これを `noop` に畳むと、壊れた側が**黙って毎日何もしないまま放置**され、
その間の未取得分は watermark が前進済みなので**永久に回収されない**。
だから止めて人に見せる（`invalid_state` は監視に出る＝§7.2 C-6）。

**`last_to == today` も `invalid_state`**（`to` は昨日なので `today > to`）。
当日中に結果承認される行を取り逃さないため `to = today` を使わない、という C-1 の前提の裏返し。

**`From`/`To` は `ready` のときだけ入れる**（`noop` などでは空文字）。呼び出し側が `Status` を
見ずに `.From`/`.To` を読んでも、**壊れた範囲でダウンロードへ進めない**ようにするため。

**日付は完全一致 `YYYY-MM-DD` のみ**（`2026/09/01` / `2026-9-1` / 前後の空白 / 末尾改行 /
`2026-09-01T00:00:00` は `invalid_state`）。暦日の妥当性は `[datetime]::TryParseExact` に委ねる
（4 年・100 年・400 年規則を .NET が持っている＝こちらで日数表を書かない）。

**`daily-1.7` からコピーしなかったもの**（仕様と食い違うため。`demecal-daily.ps1` は凍結・参照のみ）:

| `daily-1.7` | C-1 |
|---|---|
| `$to = (Get-Date).Date`（`:235`） | **JST の昨日**。今日を含めない |
| `$FirstRunDays = 7` の初回 fallback（`:41,236`） | **`STATE_NOT_INITIALIZED` で停止** |
| `$MaxRangeDays = 60` の clamp（`:43,243`） | **実装しない**（下記） |

#### C-1 Reality Check: 1 回の指定範囲の上限は**未確定**（推測で固定しない）

repo 内の `MaxRangeDays = 60` は **`demecal-daily.ps1:43`** と、それを説明した
**`demecal_daily_HANDOVER_20260902.md:160`** / **`demecal_phase_c_spec_20260903.md §6.4`** の
3 か所にしか無く、**デメカル側の制限としての出典が 1 件も無い**（実測でも先方回答でもない）。

逆向きの材料もある: **`demecal_auto_download_overview_spec.md:84`** のダウンロード履歴に
`2025/12/01〜2026/06/11`（**193 日**）が実際に残っている＝**60 日で切られてはいない**。
ただしこれは過去の手作業の記録であって、「上限が無い」ことの証明にもならない。

→ **C-1 では clamp を実装しない。C-4 runner 設計時の確認事項**（デメカルへの確認・
`demecal_auto_download_overview_spec.md §6`「アクセス制限」と同じ枠）。
テスト `C41`/`C42` が「245 日・数年の backlog を切らない」を固定しているので、
**上限が確定したときに黙って 60 を足すと落ちる**（意図的な差し替えを強制する）。

#### C-1 の機械確認（何を見張り、壊すと落ちることを確認済み）

実行時（`Invoke-WebRequest` / `Invoke-RestMethod` / **`Get-Date`** を投げる関数で覆って全ケース走破）
とソース検査の**両方**で見る。片方だけだとすり抜ける（ソース検査は別名の呼び出しに弱く、
実行時検査は「呼ばれない経路」に弱い）。

network call 0 / state write 0 / `force` 0 / 現在時刻 0 / overlap 0 / 隙間 0 /
`FirstRunDays` fallback 0 / `MaxRangeDays` clamp 0 / ファイル書き込み 0。

退行を注入して落ちることを実測（`✓ 68 件` → ）:

| 注入した退行 | 結果 |
|---|---|
| `to = today`（昨日でなく今日） | **19 件失敗** |
| 日付を部分一致 + 任意の `\D` 区切りへ緩める | **10 件失敗** |
| `FirstRunDays = 7` の初回 fallback を復活 | **落ちる**（ソース検査） |
| 同上を**変数名を使わず**に書く | **6 件失敗**（振る舞いで捕まる＝grep 回避されない） |
| `MaxRangeDays = 60` の clamp を追加 | **落ちる** |
| 内部で `Get-Date` を呼ぶ | **その場で throw** |

#### C-1 で触っていないもの

- **`src/pages/api/admin/demecal-state.ts` は Reality Check のみ・無変更**。
  `last_to` の単調前進（`:74` 過去日付は据置）と `YYYY-MM-DD` 検証（`:41,67`）は既にあり、
  C-1 に必要な変更が無かった。**`force`（`:74`）はプランナから触らない。**
- `demecal-daily.ps1`（`daily-1.7`）は**凍結のまま無変更**。`demecal-verify.ps1`（`verify-1.4`・
  Phase B の成功証跡）も無変更（`verify:demecal-flow` 129 件 PASS で確認）。
- STATE A/B/C・CSV download・scheduler・後段連携は C-1 の対象外。

### C-2. retry / catch-up

**旧題「overlap / retry」と「直近 N 日を毎回取り直す」は撤回（2026-09-03）。**
C-1 で **`from = last_to + 1日` / overlap しない**と確定したので、
同じ節に「毎回取り直す」が残っていると正面から矛盾する。

```text
通常:     last_to + 1日 ～ JST の昨日 の連続範囲
失敗:     last_to 据置 → 次回、同じ未取得範囲を再試行
長期停止: last_to + 1日 から catch-up
overlap はしない
```

> **用語の補足（2026-09-03）**: ここでいう **「no overlap」は、成功済み coverage に
> 意図的な overlap を作らない**という意味。**failure で `last_to` を据え置いた場合に、
> 次回 run が同じ未取得 range を再要求するのは retry 契約どおり**であって overlap ではない
> （その range はまだ一度も取得できていない）。

**取り漏れは overlap でなく「連続 range ＋ 失敗時 `last_to` 据置」で防ぐ。**
成功した回だけ watermark が前進するので（`demecal-state.ts:74` の単調前進）、
走らなかった日・失敗した日の範囲は**次の成功回がそのまま続きから拾う**。
これが §1「無人にしてよい根拠」そのもので、overlap は要らない。

#### C-2 確定仕様（2026-09-03）

```text
retry          = 次回 scheduled run
same-run retry = なし
catch-up       = last_to + 1日 ～ JST の昨日
no overlap / no gap
range cap 未確定なので自動 chunking なし
```

**① 同一 run 内で自動再試行しない。**

```text
failure → last_to 据置 → run 終了 → 次回 scheduled run が同じ未取得範囲を再計算
```

ログイン失敗・ポータル変更・CSV 異常のいずれでも、**その場で別候補・別範囲を自動試行しない**。
Phase A で本番経路から外した「症状から候補を増やして試す」（§3）を production でも維持する。
**1 回失敗したら証拠を残して設計へ戻る。**

**② 同じ state なら同じ range。** retry で開始日を勝手にずらさない。

```text
last_to = 2026-08-31 / today_jst = 2026-09-03
  run #1 → 09-01..09-02    失敗 → state unchanged
  run #2 → 09-01..09-02    (同じ)
```

**プランナは「失敗した」ことを知らない。それでよい** — 失敗しても `last_to` が動かないので、
次回 run は同じ入力から同じ範囲を再計算する。**「失敗回数」を渡す設計にすると、
そこから backoff・範囲縮小が生えてくる。**

**③ catch-up は最後に成功した watermark の次の日から。**

```text
last_to = 2026-08-31 / today_jst = 2026-09-10  →  2026-09-01..2026-09-09
```

**④ range 上限は実装しない。** C-1 Reality Check のとおり、デメカル側の上限を
Confirmed できていない。したがって **60 日の決め打ち clamp / adaptive shrink / 自動分割は
いずれも入れない**。大きな range をポータルが拒否した場合も、**勝手に 30 日・60 日へ縮めて
試さない**:

```text
→ failure → last_to 据置 → monitoring (C-6)
```

取得範囲上限が**一次情報または実測で確定したときだけ**、明示的な設計変更として chunking を足す。

#### C-2 で足したもの = `demecal-range.ps1` の契約テストだけ

**新しいライブラリを作っていない。** C-2 の契約は C-1 のプランナが純粋関数であることから
自然に出るので、**それを機械で固定した**（`demecal-range.tests.ps1`・74 → **90 件**）。
network call / state POST / sleep / backoff / デメカルへのアクセスは 1 行も足していない。

| 検査 | 内容 |
|---|---|
| C60 | 同じ state + 同じ today → 毎回まったく同じ範囲 |
| C61 | 失敗 → `last_to` 据置 → 次回 run は同じ範囲（開始日をずらさない） |
| C62 | 同じ state + today だけ進む → **from 不変・to だけ伸びる** |
| C63 | 取り込み成功で watermark 前進 → 次の from = 前回の to + 1日 |
| C64 | 多日停止の catch-up（`08-31` / `09-10` → `09-01..09-09`） |
| C65 / C66 / C67 | 連続 run を通しで回して **overlap 0 / gap 0**・覆った範囲 `09-01..09-07` |
| C68 / C69 | **失敗を挟んでも** overlap 0 / gap 0・同じ範囲を覆う（取り漏れゼロ） |
| C70 / C71 | 呼び直しても範囲が縮まない（shrink なし）/ 大きな backlog を 1 回で返す（chunking なし） |
| C50 追加 4 本 | ソースに **待機（sleep/backoff）・再試行の概念（retry/attempt）・ループ・範囲の自動調整（chunk/split/shrink/clamp）** が無い |

**退行を注入して落ちることを実測**:

| 注入した退行 | 結果 |
|---|---|
| gap を作る（`from = last_to + 2日`） | **26 件失敗** |
| overlap を作る（`from = last_to`） | **27 件失敗** |
| 60 日 clamp を足す | **3 件失敗**（C41 / C42 / C71） |
| 待機（`Start-Sleep`）を足す | **1 件失敗** |
| 同一 run 内の再試行ループを足す | **2 件失敗** |

**clamp の注入が 3 件しか落ちなかったのは重要**: 変数名を使わず `60` を直接書いたので
`MaxRangeDays` のソース検査をすり抜けた。**ソース検査だけでは足りず、
振る舞い（C41/C42/C71）が最後の砦になっている。**

### C-3. zero rows

正しいヘッダがありデータ行 0 件なら**正常**。`rows=0` / `result=ok` とし、
watermark だけ安全に前進させる。**0 件を error にしない。**

#### C-3 確定仕様（2026-09-03）

**0 件とは「CSV レスポンス自体が有効で、必須ヘッダが存在し、データ行が 0 件」のときだけ。**

```text
result = ok   /  rows = 0  /  range あり
```

**`ok_zero` は API の `result` ではない。** 実行ログ `/api/admin/demecal-run` の `result` は
**`ok` か `fail` の 2 値だけ** (`demecal-run.ts:97`)。0 件かどうかは `rows` と `range` で表す:

| 状態 | `result` | `rows` | `range` |
|---|---|---|---|
| zero (0 件を正常に取得) | `ok` | `0` | **あり** |
| noop (取りに行っていない) | `ok` | `0` | **なし** |
| failure | `fail` | — | — |

**0 件成功にしてはいけないもの（すべて failure）**:

```text
empty HTTP body
HTML response
header 無し
Shift_JIS decode failure
malformed CSV response
```

**`DataCount` を推測しない。** STATE C の hidden `DataCount` は実測で存在するが、
`verify-1.4` は**意味を推測せずそのまま持ち回る**契約（§6 STATE C）。したがって
**「`DataCount=0` だから CSV を取得せず成功」という近道は作らない**。
0 件成功は**実際に返った valid CSV を検証した結果だけ**で判定する。
実サイトが 0 件のとき CSV を返すのかどうかは**未確認**なので、推測で仕様化しない。

**watermark 契約（C-4 で実装）**:

```text
valid CSV + rows=0 → acquisition success → last_to = 要求 range の to まで前進可
```

理由 = クエリ条件は結果承認日の range であり、**「その range について正常に 0 件だった」**
ことを確認できたため。**C-3 では state POST を実装しない。**

#### C-3 の Reality Check → 既存実装は変更不要・不足していた 1 点だけテストを足した

`verify-1.4` の `Test-CsvResponse()`（`demecal-verify.ps1:690-747`）は既に契約どおり:

| 入力 | 結果 |
|---|---|
| valid header + data rows ≥ 1 | `Ok=true` / `Rows=N` |
| valid header + data rows = 0 | `Ok=true` / `Rows=0` |
| zero bytes | `CSV_BYTES_INVALID` |
| header 無し | `CSV_HEADER_INVALID` |
| HTML response | `CSV_RESPONSE_INVALID` |

**`verify-1.4` は 1 バイトも変更していない**（Phase B の成功証跡）。
production 用 validator の共通化・parity は **C-4 runner 構築時**に行う。

既存テストの棚卸しで **4 つは固定済み**だった（T29 header-only 成功 / T31 空 bytes 失敗 /
T28 header 無し失敗 / T30 HTML 失敗）。**足りなかったのは「rows=0 と bytes=0 を混同しない」**で、
これが**いちばん危ない穴**だった:

> C-4 の watermark 規則は「valid CSV + rows=0 → 前進」なので、**rows の値が watermark を動かす**。
> 失敗経路が `rows=0` を返すようになると、**失敗が「正常に 0 件だった」に化けて watermark が前進し、
> その範囲は二度と取りに行かれない**（無人運用の唯一の土台が壊れる）。

実測で、失敗 3 種はいずれも `Rows` を**数えていない（`$null`）**まま返すことを確認し、
それをテストで固定した（`demecal-flow.tests.ps1` 129 → **135 件**）:

| 追加 | 内容 |
|---|---|
| T29a | 0 件成功は `bytes > 0`（rows=0 と bytes=0 を混同しない） |
| T29b | 0 件成功はヘッダを確認した結果（`HeaderOk`） |
| **T29c** | **失敗時に `rows=0` と報告しない**（bytes=0 / header 無し / HTML の 3 種） |
| T29d | Shift_JIS でないバイト列は成功にしない（`CSV_HEADER_INVALID`） |
| T29e | 末尾の空行を行として数えない（0 件のまま） |
| T29f | 0 件と 1 件を取り違えない |

**T29d の補足（実測）**: `GetString` は不正なバイト列でも例外を投げず化けた文字を返すので、
`Test-CsvResponse` の「Shift_JIS として読めません」の枝は**実質到達しない**。
実際の防波堤は**必須ヘッダが一致せず `CSV_HEADER_INVALID` になること**なので、そちらを固定した。

**退行を注入して落ちることを実測**（注入後は `verify-1.4` を復元。diff ゼロ）:

| 注入した退行 | 結果 |
|---|---|
| `Rows` の初期値を `$null` → `0` | **T29c だけが落ちる（1 件）** |
| 空応答を「0 件成功」として通す | 2 件（T29c / T31） |
| 空行も 1 行として数える | 4 件（T24 / T29 / T29e / T29f） |
| 必須ヘッダの検査をやめる | 3 件（T28 / T29c / T29d） |
| ヘッダ行しか無い CSV を失敗にする | 3 件（T29 / T29b / T29e） |

**1 行目が C-3 の核心** — `Rows = $null` を `0` に「整理」する変更は、
**追加前の 129 件では 1 件も落ちなかった**。T29c だけが捕まえる。

### C-4. production acquisition runner

新規系統（例 `scripts/demecal-production.ps1`）。**`daily-1.7` を復活させない。**
Phase B で実証済みの **cert / login / STATE A/B/C / `RawContentStream` / CSV validation** は
**同一ロジックを使う**（共通化するか、機械的な parity test を置く）。
**取得部を独自に書き直さない。**

#### C-4 Foundation（2026-09-03・実装済み）

| | |
|---|---|
| 実装 | `scripts/demecal-production.ps1`（`production-1.0`） |
| 検査 | `scripts/tests/demecal-production.tests.ps1`（`npm run verify:demecal-production`・**43 件**） |

**流れ**:

```text
JST today → GET demecal-state → Resolve-DemecalAcquisitionRange
  → noop / not_initialized / invalid_state はここで終わり (ポータルに触らない)
  → ready のときだけ 証明書 → 資格情報 → ログイン → STATE A/B/C → CSV 検査 → watermark
```

**Phase B parity は「書き写さない」ことで担保した。**
`demecal-verify.ps1 -LibOnly` と `demecal-range.ps1` を **dot-source** して
**同じ関数をそのまま呼ぶ**（コピーは必ずずれる）。**`demecal-verify.ps1` は 1 バイトも変更していない。**
検査 P20 が **14 関数の `ScriptBlock` が verify-1.4 と同一**であることを、P21 が
**production 側で再定義していない**ことを機械で見る。

**watermark（§7.2 C-3 の契約を実装）**:

| CSV | 判断 | 理由 |
|---|---|---|
| valid + `rows=0` | **前進する** (`ZERO_ROWS`) | 「その range について正常に 0 件だった」と確認できた |
| valid + `rows>0` | **前進しない** (`HANDOFF_NOT_IMPLEMENTED`) | 取得は成功。だが**「取得した bytes を次工程が確実に受領した」外部契約がまだ無い**。**ここで後段 interface を発明しない** |
| invalid / rows 不明 | **前進しない** | fail-closed |

**fail-closed（すべて state 据置）**: state GET 失敗 / planner が ready でない /
証明書 / 資格情報 / ログイン / STATE A/B/C 不一致 / CSV 応答不正 / ヘッダ不正 / バイト検査失敗。
**`force=true` は送らない**（巻き戻しはこのスクリプトの仕事ではない）。
same-run retry / range shrink / chunking も無い（C-2 の確定どおり）。
**取得は成功したが watermark を書けなかった回は `fail` で残す** — 次回 run が同じ範囲を
取り直すので取り漏れは起きない（C-2 の retry 契約）。

**検査は 3 層**（純粋関数 / parity / **手続き部を子プロセスで実際に走らせる**）。
③が要るのは、「ポータルに触らない」を**ソース検査では保証できない**から:

| 検査 | 内容 |
|---|---|
| P01–P06 | `Get-RunAction`（ready だけ Proceed。noop は `result=ok`/`rows=0`/range なし。他は `fail`） |
| P10–P15 | `Get-WatermarkDecision`（上の表のとおり。`Ok` なのに rows が null でも前進しない） |
| P20–P24 | parity（14 関数が同一 / 再定義していない / dot-source している / `daily-1.7` を参照しない） |
| P30–P35 | ready のとき Phase B と同じ要求を組む（販売先 `000000` / 日付 `yyyy/MM/dd` / `submitType=''` / `submitType=download`） |
| P40–P51 | **子プロセスで手続き部を実行**。noop / not_initialized / invalid_state で **`Invoke-WebRequest` 0 回**・state 書き込み 0 回・終了コード / **ready では 1 回以上**（0 回が常に 0 でないことの確認）/ どの経路でも実行ログを 1 回送る |
| P60–P61 | ソースに `force` / retry / sleep / chunk / `FirstRunDays` / CSV のディスク保存 / 後段 interface が無い |

**退行を注入して落ちることを実測**:

| 注入した退行 | 結果 |
|---|---|
| noop でも証明書へ進む（plan の分岐を外す） | 2 件（P41 / P51） |
| `rows>0` でも watermark を前進させる | 1 件（P11） |
| CSV が invalid でも前進させる | 1 件（P12） |
| `not_initialized` を ok 扱いにして進める | 4 件（P03 / P04 / P05 / P51） |
| state 書き込みに `force=true` を足す | 1 件（P60） |
| STATE B を自前で書き写す | 2 件（**P20 / P21** = parity） |

#### JST の暦日は **UTC+09:00 固定**で出す（2026-09-03 レビュー裁定）

**ローカル時刻へのフォールバックを禁止した。** 当初は
`FindSystemTimeZoneById('Tokyo Standard Time' → 'Asia/Tokyo')` を試し、
どちらも無い環境で `(Get-Date).Date` へ落ちる作りだった。これは
**PC の時計が JST でない環境で、黙って別の日を取りに行く**。
取得範囲は watermark を動かすので、**間違った日付は「取り漏れ」か
「二度と取りに行かれない範囲」に直結する**。id が無いことより静かに壊れる方が悪い。

```text
UTC の瞬間 → +09:00 へ寄せる → その暦日
```

**OS のタイムゾーンデータベースにもローカル時刻にも依存しない。**
テストのために純粋関数へ分けた:

| | |
|---|---|
| `ConvertTo-JstDate([DateTimeOffset])` | 瞬間 → JST の暦日。**純粋** |
| `Get-JstToday()` | `ConvertTo-JstDate([DateTimeOffset]::UtcNow)` だけ |

`ToOffset` は**入力自身の offset が何であっても**同じ瞬間を +09:00 で表し直すので、
`Z` でも `+09:00` でも `-05:00` でも同じ答えになる。
**`-TodayJst` の明示注入は従来どおり**（C-1 の「渡す側が決める」契約は不変）。

固定した境界（`J01`–`J11`）:

```text
2026-09-03T14:59:59Z → 2026-09-03   (JST 23:59:59)
2026-09-03T15:00:00Z → 2026-09-04   (JST 00:00:00 = 日付が変わる)
2026-12-31T15:00:00Z → 2027-01-01   (年をまたぐ)
2024-02-28T15:00:00Z → 2024-02-29   (うるう日)
```

**実行時とソースの両方で見る**: `J08` が `Get-Date` を投げる関数で覆って
`Get-JstToday` を呼び、`J09`–`J11` が**この 2 関数の中だけ**を対象に
`Get-Date` / `::Now` / `::Today` / `ToLocalTime` / `TimeZoneInfo` が無いこと、
`ToOffset` + `FromHours(9)` + `UtcNow` を使っていることを見る
（関数の中だけを見るのは、起動バナーや証明書の残日数で使う `Get-Date` を誤検出しないため）。

退行を注入して落ちることを実測:

| 注入した退行 | 結果 |
|---|---|
| ローカル時刻の fallback を復活させる | **J09 のみ（1 件）** |
| タイムゾーン DB を使う形へ戻す | J09（1 件） |
| offset を `+08:00` にする | 6 件（J02–J07 の境界が全部ずれる） |
| `UtcNow` でなくローカルの `Now` を入れる | 2 件（J09 / J11） |
| 瞬間でなく日付部分だけ見る（offset を無視） | 5 件（J02 / J04 / J05 / J07 …） |

**1 行目が両層を置いている理由**: fallback を戻しても `UtcNow` が成功する限り
**その経路は実行されない**ので、実行時検査（J08）は素通りする。
**眠っている fallback を捕まえられるのはソース検査だけ。**

#### C-4 Foundation で踏んだ実装バグ 3 件（すべて検査が検出）

**どれもソース検査では出ない。「実際に走らせる」検査を置いたから出た。**

1. **dot-source は相手の `param()` を自分のスコープに作る。**
   `. demecal-verify.ps1 -LibOnly` で **production 自身の `$LibOnly` が `$true` に化け**、
   **手続き部が丸ごと実行されなくなっていた**。→ 自分の引数を先に
   `$ProdLibOnly` / `$ProdTodayJst` へ退避する。**名前が同じだと必ず踏む。**
2. **取り込み専用キーのプレースホルダが「読み込まれる側」にあった。**
   `$IntakeKey` は verify-1.4 が持っていたので、配布時に差し替える対象がずれて
   `INTAKE_KEY_MISSING` で止まった。→ **本番で配る production 側で持ち直した**。
3. **`&` で呼んだスクリプトの `exit` は呼び出し元へ伝わらない。**
   テストの子プロセスが常に 0 で終わり、終了コードの検査が素通りしていた。
   → driver 側で `exit $LASTEXITCODE` を拾い直す。
   併せて **`Start-Process` は空文字の引数を落とす**（`-LastTo ''` が後ろへずれる）ので、
   子プロセスへの受け渡しは環境変数にした。

#### C-4 Foundation で決めていないもの（C-4.1 以降）

- **配布の形** → **C-4.1 で確定した（下記）**。
- 1 回の指定範囲の上限（C-1 Reality Check のとおり**未確定**）。
- `rows>0` の受け渡し先（**このセクションの scope 外**）。

### C-4.1. 配布とインストール（2026-09-03・実装済み）

**Wellfort に渡すものは 1 ファイルのまま。ダブルクリック 1 回で 3 本が置かれる。**

```
デメカル自動取得_インストール_v1.0.bat
  ↓ 1 回実行
C:\demecal\production\
  demecal-production.ps1   ← 取り込み専用キーを注入済み
  demecal-verify.ps1       ← Phase B の実証済みロジック（そのまま）
  demecal-range.ps1        ← C-1 の範囲プランナ（そのまま）
  install-manifest.json    ← 版と 3 本の SHA-256（非 PII）
```

#### なぜ既存の `buildProbeBat()` を使えないのか

`buildProbeBat()` は **.ps1 を 1 本だけ** bat の中へ置き、bat が自分自身を読み直して
`Invoke-Expression` する方式で、**ディスクにファイルを 1 つも残さない**。
ところが本番 runner は C-4 の設計どおり

```powershell
. (Join-Path $PSScriptRoot 'demecal-verify.ps1') -LibOnly
. (Join-Path $PSScriptRoot 'demecal-range.ps1')
```

を **dot-source** する（「書き写さない = parity を構造で保証する」）。
`Invoke-Expression` された文字列に `$PSScriptRoot` は無く、隣に置くべき 2 本も存在しないので、
**production.ps1 だけを自己実行 bat へ包んでも成立しない**。

→ **新しい builder `src/lib/demecal-installer.ts` を分けた。**
`buildProbeBat()` は 1 行も変えていない（recon / verify / 接続チェックの配布は現行のまま。
`verify:probe-bat-gate` が 3 つとも 200 のままであることを見ている）。

#### 確定仕様

| | |
|---|---|
| 配布口 | `GET /api/ops/probe-bat?k=<PROBE_UPLOAD_TOKEN>&script=production-install` |
| 配置先 | `C:\demecal\production`（**固定**。無ければ作る） |
| 埋め込み | 3 本を **base64** で bat の中へ |
| 秘密 | `__LAB_INTAKE_KEY__` を **production 1 本だけ**に注入（Vercel env `LAB_INTAKE_API_KEY`） |
| 埋め込まないもの | **`ADMIN_API_KEY`**（builder の引数にも無い）/ デメカル ID・PW（①recon の DPAPI 資格情報を再利用）/ `PROBE_UPLOAD_TOKEN` |
| 失敗 | `INSTALL_FAILED <コード>` ＋ **exit != 0** |
| インストール後 | **取得しない**。デメカルに接続しない・state を読み書きしない・runner を起動しない・タスク登録もしない |

`daily` の凍結は解除していない（`?script=daily` は 409 のまま）。
`script` 省略時の fail-closed（400）も維持。

**`demecal-verify.ps1` の `__PROBE_TOKEN__` は未注入のまま置く。** Phase B 用の診断トークンを
本番 PC へ再導入しない、という判断で、`Send-Skeleton` が no-op になる現行契約
（`demecal-verify.ps1:846`）をそのまま使う。必要になったら C-6 で別途判断する。
verify 側の `$IntakeKey` も未注入でよい — production は dot-source の**後**に自分の
`$IntakeKey` を代入するので（`demecal-production.ps1:61`）、`Report-Run` が見るのは
production の値になる。**結果として秘密が載るファイルは 1 本に閉じる。**

#### base64 で埋めた理由（2 つとも実利）

1. 中身が日本語なので、bat の読み直し（`Get-Content -Encoding UTF8`）を通しても
   **バイト単位で同一**であることを保証したい。ここが崩れると SHA-256 照合が意味を失う。
2. **インストーラ自身のコードに `Invoke-WebRequest` / `demecal-state` / `schtasks` 等が
   1 つも無いことを grep で言い切れる**（3 本の中身は base64 の中なので混ざらない）。
   「install だけでは何も取りに行かない」を、実行時の計数**と**ソースの両方で固定できる。

#### 混成セットを作らない — temp → 全数照合 → 入れ替え → 再照合 → 旧セット破棄

**一部だけ新しく、一部だけ古い状態を正常扱いしない。**

```
①作業フォルダ (production.new) へ 3 本を書き、1 本ずつ SHA-256 を照合
②本数と名前が期待どおりかを見る（欠損・余剰の検出）
③ここで初めて target を入れ替える（旧セットは .old へ退避 → 失敗したら戻す）
④入れ替えた**後**の実物をもう一度照合する（SHA-256 と 本数・名前）
⑤④が全部通ってから、**初めて** .old を捨てる
```

target へ直接書かないので、**途中で落ちても既に入っている正常セットは 1 バイトも変わらない**。

##### ⑤の順序が blocker だった（2026-09-03 レビュー裁定）

最初の実装は **③のあと・④の前に `.old` を捨てて**いた。
これだと④に落ちたときに**戻す先が無く、壊れた新セットが target に居座る**。
④で落ちる形は「移動が半端に終わった」等なので、まさにそこで復旧できないと意味が無い。

→ **`.old` を捨ててよいのは、④（配置後の SHA-256 ＋ 本数・名前）が全部通ったあとだけ。**
④に落ちたときは `Restore-Old` で

| 状況 | やること |
|---|---|
| 旧セットが在った（上書き） | 壊れた target を消す → `.old` を target へ戻す → `INSTALL_FAILED` / exit != 0 |
| 旧セットが無い（初回） | 壊れた target を消す → **target ごと無い状態にする** → `INSTALL_FAILED` / exit != 0 |

初回で target を残さないのは、**壊れたものを置いておくより、次の install をやり直せる方がよい**から。

#### 検証 `npm run verify:demecal-installer`（84 件）

node（組み立て・配布口）と PowerShell（実際の展開）を **1 本で跨ぐ**。
境界を跨いだところに事故が出る（ハッシュの取り方 / 改行 / 文字コード / 終了コードの伝わり方）ので、
片側だけでは「配って初めて壊れている」が残る。

**実機と同じ形で走らせる。** bat の cmd 部が呼ぶのと同じ
`Get-Content <bat>` → `skip` → `Invoke-Expression` の形で起動し、**skip 行数も bat 自身から読む**。

> **実測 2026-09-03**: PowerShell 部だけを取り出して dot-source する形で試したところ、
> インストーラが `exit 1` してもドライバは走り続け、**終了コードが 0 のまま通った**。
> C-4 で踏んだ「`exit` が `&` を越えない」と同じ穴。**実機と同じ呼び方でしか検査にならない。**

Wellfort 実機は使わない（配置先だけテンポラリへ差し替えて Linux で走らせる）。

**入れ替えた後に落ちる形は、別の経路として検査する。**
`C20`〜`C23` は入れ替える**前**に落ちる形しか見ていないので、
生成した bat の **2 回目の `Sha256File`（＝配置後の照合）だけ**を潰して強制的に
`INSTALLED_MISMATCH` を起こし、上書き（`C26`〜`C31`）と初回（`C32`〜`C34`）の
両方で復旧を固定した。

#### 退行を注入して落ちることを確認（11 通り）

| 注入した退行 | 落ちた検査 |
|---|---|
| temp を経由せず target へ直接書く | **C22 のみ**（旧セットが `GONE` になる） |
| 診断トークンも verify へ注入する | A08 / A13 / C13 |
| 3 本すべてに取り込み専用キーを注入 | A11 |
| bat が終了コードを握りつぶす（`exit /b`） | **A21 のみ** |
| OneDrive ガードを外す | C35 / C36 |
| 作成直後のハッシュ照合を外す | **C16 のみ** |
| 入れ替え**後**の再照合を外す | **A23 のみ**（当初は 0 件 → 下記） |
| **配置後の照合より前に `.old` を捨てる（＝旧実装）** | **A25 / A26 / C28 / C29 / C30**（旧セットが `GONE`） |
| 配置後の失敗で `Restore-Old` を呼ばない | A27 / C28〜C31 / C33 |
| 壊れた新セットを消さずに旧セットを戻そうとする | C28 / C29 / C30 / C33 |
| 配置後の本数照合を条件ごと潰す | **A24b のみ**（当初は 0 件 → 下記） |

**「ソース検査と実行時検査は両方要る」がまた出た。**
`exit /b %RC%` の退行は実行時の層に映らない（C 層は PowerShell 部を直接動かすので cmd 部を見ない）。
逆に **順序や「条件式が生きているか」は実行時では捕まらない**:

- 入れ替え**後**の再照合を外す退行は、手元の Linux で「移動が半端に終わる」状況を作れず
  **実行時では全件通ってしまった** → 照合が 2 回あることをソースで固定（A23 / A24）。
- 配置後の本数照合は、エラーコードの文字列を残したまま条件を `$false` に潰すと
  **文字列の有無だけを見る検査は通ってしまった** → 条件式ごと見る A24b を足した。
- `.old` を捨てる位置は、照合が通る限り実行時の見た目が正常なので
  **順序そのものをソースで固定**（A25 / A26）。

JST の local fallback（C-4）と同じ構図。

#### C-4.1 で決めていないもの

- **タスクスケジューラへの登録は C-5**。インストールと本番取得・自動実行を
  同じ実機操作にしない（1 回の実行で全部やると、失敗したときにどこで失敗したか分からなくなる）。
- 1 回の指定範囲の上限（変わらず**未確定**）。
- `rows>0` の受け渡し先（**scope 外**）。

### C-5. scheduler（2026-09-03・実装済み）

Windows Task Scheduler へ**登録するだけ**。`demecal-production.ps1` は変更していない。

#### 最大の安全条件 = 登録するタスクは最初から無効

```xml
<Settings>
  <Enabled>false</Enabled>
</Settings>
```

**C-6 monitoring と最終の controlled validation が終わるまで自動取得を始めない。**
登録 → 設定の確認 → **無効のまま終了**。ここまで。

登録の実行そのものが取得を 1 回も始めないこと (`schtasks /Run` / `Enable-ScheduledTask` /
production runner の起動 / デメカルへの接続 / state API) は、**実測 0 回**で固定してある
(検査 C07〜C11。スタブに数えさせる)。

#### タスク契約

| | |
|---|---|
| タスク名 | `Wellfort-Demecal-Acquisition` |
| action | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\demecal\production\demecal-production.ps1"` |
| principal | **setup を実行した今のユーザー**。`UserId` は名前でなく**解決した SID** |
| logon type | `InteractiveToken`（**Windows のパスワードを保存しない**） |
| run level | `LeastPrivilege` |
| triggers | ①当該ユーザーの `LogonTrigger` ②`CalendarTrigger` 日次 `HH:MM` |
| その他 | `StartWhenAvailable=true` / `MultipleInstancesPolicy=IgnoreNew` / `ExecutionTimeLimit=PT30M` |

**「ユーザーがログオンしているかどうかにかかわらず実行する」は採らない**
(`demecal_unattended_spec §4.3` の確定どおり)。理由は**証明書**で、mTLS の
クライアント証明書は `Cert:\CurrentUser\My` にしか無い。別ユーザー / SYSTEM で走らせると
証明書が見えず必ず失敗する。**だから `info` のようなアカウント名をベタ書きせず、
実行中の SID を解決して principal に入れる** — 「証明書と DPAPI 資格情報を持っている今の
ユーザー」と task principal を一致させるのが要件だから。

#### 実行時刻 `DEMECAL_DAILY_AT`

**repo 側で未確定なので既定値を作らない。** 配布生成時の env で与える。
`^(?:[01]\d|2[0-3]):[0-5]\d$` の完全一致だけ受理し、**未設定・不正なら bat を配らない**
(`?script=production-scheduler` が 500)。`.ps1` 側にも同じ検査を置いてある
(配布口を通らずに届いた場合の最後の砦 = `DAILY_AT_INVALID`)。

前後の空白・改行だけは落として受ける — env は貼り付けで付きやすく、
**空白を落としても不正な時刻が正しい時刻に化けることはない**ため。
焼き込むのは trim 後の値であることを検査で固定している (A05b)。

検査の fixture は `09:30`。**production の既定値ではない。**

#### 登録前 preflight — 揃っていなければ 1 つも登録しない

```
C:\demecal\production\ に 3 本 + install-manifest.json が在るか
手控えの 3 つの SHA-256 と実ファイルを再照合    ← 混成セットの上へ登録しない
Cert:\CurrentUser\My に 発行者=demecal.net CA かつ 秘密鍵あり の証明書が在るか
① recon が作った DPAPI 資格情報ファイルが在るか
```

**値もパスワードも拇印も表示しない。在るか無いかだけ。**
どれか 1 つでも欠ければ `SCHEDULER_INSTALL_FAILED <コード>` / exit != 0 /
**タスク登録 0 回**で止め、C-4.1 installer や ① recon を先に実行すべき状態として返す。

#### 登録したら読み戻して照合する

`schtasks /Create /XML` が通ったこと自体を成功の証拠にしない。
`schtasks /Query /TN <name> /XML` で読み戻し、**task name / user SID / InteractiveToken /
LeastPrivilege / Enabled=false / daily time / LogonTrigger / StartWhenAvailable /
IgnoreNew / PT30M / action path** を照合する。1 つでも違えば
`REGISTERED_MISMATCH` で失敗にする。タスクスケジューラの画面は開かせない。

##### 失敗したら登録ごと引き取る（2026-09-03 レビュー裁定）

最初の実装は、読み戻しが合わなくても **登録済みのタスクを残したまま**
`REGISTERED_MISMATCH` で終了していた。
とくに読み戻しが `Enabled=true` だった場合、**失敗を報告しながら有効なタスクが残る**。
「C-6 まで自動取得を開始しない」に正面から反する。

→ `/Create` の**後**の失敗 — **Query 失敗 / 読み戻しの解析不能 / 照合不一致** — では、
いま登録したタスクを `schtasks /Delete /TN <name> /F` で消してから失敗で終わる。

| | |
|---|---|
| 消せた | `SCHEDULER_INSTALL_FAILED <元のコード>` / exit != 0 |
| 消せなかった | `SCHEDULER_INSTALL_FAILED REGISTERED_CLEANUP_FAILED` / exit != 0 ＋ 手動削除の案内と「有効化しないでください」 |

**どちらも成功扱いにしない。`/Run` も有効化も引き続き絶対にしない。**

「消せた」の条件は **2 つの AND**:

```
① /Delete コマンド自体が成功した
②  かつ /Query /XML に <Task が返らない
```

**①が要る理由 (2026-09-03 レビュー指摘)**: `schtasks.exe` はネイティブ実行ファイルなので、
**終了コードが 0 以外でも PowerShell の例外にならず `try/catch` に入らない**。
②だけで見ていると

```
/Delete が失敗 → /Query もエラー文字列 → <Task が無い → 「消えた」
```

と読み違え、**タスクが残ったまま「消せた」と報告する**。
→ 例外・`$?`・`$LASTEXITCODE` の 3 つで見て、①が偽なら**その場で `$false`**
(②へ進まない)。②は `/Delete` の**出力の文言では判定しない** — 表示は環境で変わり得るので、
「引けなくなったか」という観測できる事実で締める。

> **どの signal が実際に効いたか (実測)**: 手元の検査 (Linux・`schtasks` を関数で差し替え、
> 失敗は `/bin/false` による**本物のネイティブ失敗**) で落とすのは **`$LASTEXITCODE`** の方。
> `$?` は関数呼び出しとしては成功なので `$true` のままだった。
> `$?` は**実機の exe に対する保険**として残してある (**実機での挙動は未確認**)。

検査は `C34`〜`C39` が 6 通りの失敗経路それぞれで **失敗 / 削除 1 回 / タスクが残らない /
外部操作 0 回** を固定し、`C11b`〜`C11c` が **正常登録では削除 0 回・タスクは残る**を固定する。
`C40`〜`C46` が「消せなかったとき」(CLEANUP_FAILED / 案内文 / `/Run` 0 回 /
**タスクが残っていることを実体で確認** / 失敗を画面に出す / 確認の `/Query` へ進まない)、
`C47`〜`C49` が **削除失敗 ＋ `/Query` も非 XML エラー** (旧実装が「消せた」と誤判定していた形)、
`C43` が **呼ぶのは `/Create` `/Query` `/Delete` だけ**。

**スタブの失敗のさせ方も実機に合わせる**。文字列を返すだけだと「PowerShell から見て失敗」に
ならず、検査が実機の失敗を模していないことになるので、`/bin/false` を実行して
**終了コードだけが 1 になる** (例外は飛ばない) 形にしてある。

#### 配布 — Reality Check の結論は「`buildProbeBat()` を再利用しない」

.ps1 は 1 本なので形の上では載るが、実際に読んで確かめると 2 点で載らない:

1. **`__DAILY_AT__` を知らない。** `buildProbeBat()` が扱うのは
   `__PROBE_TOKEN__` / `__LAB_INTAKE_KEY__` / `__DEMECAL_USER__` / `__DEMECAL_PASS__` の 4 つだけ。
   実行時刻を差し込み「未設定・不正なら配らない」を持たせるには**あちらへ分岐を足す**ことになる。
2. **終了コードを握りつぶす。** cmd 部が `exit /b` で終わり `%ERRORLEVEL%` を返さない。
   C-5 は `SCHEDULER_INSTALL_FAILED` → exit != 0 が契約なので成立しない。

→ 別 builder `src/lib/demecal-scheduler.ts`。cmd 部は C-4.1 と共通化して
**`src/lib/demecal-bat.ts` の `wrapPs1AsBat()`** に置いた (終了コードを返す形は 1 か所)。
**`buildProbeBat()` は 1 行も変えていない**。`daily` の 409 凍結も維持。

配布口 = `GET /api/ops/probe-bat?k=<PROBE_UPLOAD_TOKEN>&script=production-scheduler`。

#### 検証 `npm run verify:demecal-scheduler`（133 件）

C-4.1 と同じく node（組み立て・配布口）と PowerShell（実際の登録）を 1 本で跨ぐ。
**bat の cmd 部と同じ形で起動し、skip 行数も bat 自身から読む。**
preflight の入力は **C-4.1 installer が実際に置いた 3 本 + 手控え**を使う (捏造しない)。

Windows にしか無いもの (SID / 証明書ストア / `schtasks`) だけをドライバ側で差し替える。
**preflight も XML 生成も照合も本物のコードが走る。**

> **`$GetUserSid` / `$GetUserName` を関数でなく scriptblock 変数にしてある理由 (実測)**:
> 関数だと `Invoke-Expression` された本体側の定義が**後から勝って**スタブが効かない。
> `$InstallRoot` と同じ「呼び出し元が先に定義していればそれを使う」形にした。
> 専用PC では `-NoProfile` 起動なので未定義 = 本物が使われる。

#### 退行を注入して落ちることを確認（10 通り）

| 注入した退行 | 落ちた検査 |
|---|---|
| 有効な状態で登録する (`Enabled=true`) | C02 / C04 / C16 |
| 登録後にタスクを起動する (`schtasks /Run`) | A20 / C10 / **C11 (外部操作 1 回)** |
| Windows パスワードで登録 (`LogonType=Password`) | A17×2 / A18 / C02 / C04 / C14 / C25 |
| 実行時刻に既定値を作る | A04 / A05 / **B12 (未設定でも 200 になる)** |
| 読み戻しの照合をやめる | C34〜C37 |
| preflight の SHA 再照合をやめる | **C28 のみ** |
| 証明書チェックをやめる | **C30 のみ** |
| **後始末をやめる (mismatch でも登録を残す = 旧実装)** | C34〜C39 / C40 / C41 / C43。実測は**タスクが残ったまま** |
| 消えたか確かめずに成功扱いする | **C40 / C41 のみ** |
| 後始末で `/Run` してしまう | A20 / C34〜C39 / **C42 (外部操作 1 回)** / C43 |
| **削除の成否を `try/catch` だけで見る (= 旧実装)** | **C47 のみ**（＋実装の形を見る C45 / C46）|
| 終了コードを見ず `$?` だけで判定 | C47 (＋C45 / C46)。**手元では `$?` が効かない**ため |

**検査自身の誤検出も 2 件出た (どちらも検査側を直した)**:
`.ps1` の冒頭コメントが「`schtasks /Run` しない」と宣言しているため素のテキストでは
自分の説明文に当たる → **ブロックコメントを先に落としてから grep**
(行コメントを先に消すと `#>` が消えて対応が壊れる。C-4.1 と同じ穴)。
`/Run` は `<RunLevel>` `<RunOnlyIfIdle>` に部分一致するので**語として**見る。

#### 構文エラーは「実際に走らせる層」でしか捕まらなかった（実測 2026-09-03）

後始末を足したとき、PowerShell の構文エラーを入れてしまった。

```powershell
Stop-Setup 'X' (
  ('…' -f $a)
  + '…')          # ← 閉じ括弧のあとで改行して + を続けると、そこで式が切れる
```

**丸ごと parse できず手続き部が 1 行も動かない**状態になったが、
`verify:ps1-order` は **OK を返した** (故意に壊した状態でも「関数 9 件」で通過)。
あれは**定義順だけ**を見る検査で、構文エラーは対象外。
捕まえたのは **C 層 (bat と同じ形で実際に走らせる)** で、全ケースが
ドライバのフォールスルー (`exit 99`) に落ちて一斉に赤くなった。

→ **「実機と同じ形で走らせる」は、細かい契約のためだけでなく
「そもそも動くか」を見る唯一の層でもある。**

#### 未確認（実機で 1 回通すまで確定しない）

- **Task Scheduler の XML スキーマ**と `schtasks /Query /XML` の出力エンコーディング。
  手元に Windows が無いので実測できていない。
  ただし**間違っていても害は出ない** — `/Create` が失敗すれば読み戻しも失敗し、
  `SCHEDULER_INSTALL_FAILED` / 登録 0 で止まる (fail-closed)。しかも登録できても**無効**。
- `CalendarTrigger` の `StartBoundary` は**固定日付** (`2026-01-01T<HH:MM>:00`)。
  実行日を入れると生成のたびに XML が変わり検査で固定できないため。
  日次トリガは開始日以降の毎日なので過去日付でよい、という理解は**未検証**。

#### C-5 で決めていないもの

- **有効化 (`Enabled=true` にする操作) は C-6 の後**。ここでは手順も自動化も作らない。
- 実行時刻の値そのもの (業務判断)。
- 1 回の指定範囲の上限 / `rows>0` の受け渡し先 (変わらず **scope 外**)。

### C-6. monitoring

`/api/admin/demecal-run` の実行ログ ＋ GitHub Actions の日次ワークフローを見張りにする
（**新しい通知基盤は作らない** = 既存の確定事項どおり）。
送るのは**非 PII の取得結果だけ**（範囲 / 行数 / 結果 / エラーコード）。
**CSV 本文・臨床値・PII は送らない。**

## 7.3 このセクションの完成条件

```text
Phase B の取得部を維持 (verify-1.4 を書き直さない)
to = 当日を使わない
連続 range + 失敗時 last_to 据置で取り漏らさない
失敗時に watermark を前進させない
0 件を正常に扱う
production runner の 3 本が 1 回の操作で専用PC へ揃って入る (混成セットにしない)
production runner が無人で走る
scheduler が **無効のまま**登録され、設定が意図どおりであることを機械で確認できる
scheduler を有効化したあと、走ったことがサーバ側に残る
失敗が人に届く
PII を不要に保存しない
```

**本人紐付け・Elith/S3 本番納品は、この完成条件に含めない。**

---

# 8. 日付仕様の不整合

現在資料に差がある:

- 旧概要仕様: `to = 実行日 - 1日`
- `daily-1.7`: `to = 当日`
- 無人仕様: `to = 当日 - N日`、Nは未確定とする記述あり

動画UIにも「出力日より前を指定」という表示がある。

**Phase Aでは本番watermarkを進めないため、この不整合は実機疎通のブロッカーではない。**

Phase C開始前にChatGPTが正本を統一する。

---

# 9. 現行文書の注意点

`demecal_daily_HANDOVER_20260902.md` 等には、動画との不一致や、後の解析で撤回された推論が混在している。

代表例:

- 「販売先は最初から入っている」→ 動画では人が`000000`を選択
- ブラウザ表示URLとform actionの混同
- `submitType`仮説を一時「真因」とした後、HTML decodeを「真因」と再断定

今後は:

```text
動画/実測
 > raw skeleton/recon evidence
 > この文書で確定した設計
 > 過去の推論コメント
```

の優先順位で扱う。

過去文書を一括書き換えて履歴を消す必要はない。矛盾を見つけたら、この文書と最新のChatGPT指示を優先する。

---

# 10. Claude Codeへの現在の指示

**いま開始してよいのは Phase A のみ。**

実装前にまずReality Checkとして、以下を短く報告すること:

1. Phase Aで変更予定のファイル
2. 現行探索ロジックのうち削除/隔離する箇所
3. 3-state判定方法
4. fixture構成
5. verify-onlyでwriteを機械的に禁止する方法
6. Unknownのまま残るDOM/HTTP項目

その報告が本文書と矛盾しなければ、そのままPhase Aを実装してよい。

**Wellfortへの実行依頼、Phase Bの実行、Phase Cの実装はまだ行わない。**

---

# 11. 完了の定義

このプロジェクトの成功は「batが一度動いた」ではない。

最終的に:

```text
正しい3-state操作
 + fail-closed
 + PS5.1で正しいCSV byte取得
 + PIIを不要箇所へ残さない
 + 本人IDへ正しく対応
 + 冪等
 + 取り漏れのないwatermark
 + 0件正常処理
 + 無人監視
```

を同時に満たして初めて完了とする。

---

## 最重要ルール

> **Wellfort役員に何度も試行させて前進する開発を、ここで終わらせる。**
>
> 実機1回の前に、手元で証明できることはすべて証明する。  
> 実機でしか分からないことだけを、1回で確認する。  
> 失敗したら別候補を試すのではなく、期待との差を持ち帰って設計へ戻す。
