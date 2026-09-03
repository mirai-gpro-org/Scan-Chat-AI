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
acquisition watermark / overlap
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
C-2 overlap / retry
C-3 zero rows
C-4 production acquisition runner
C-5 scheduler
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
| `noop` | `OK_NOOP` | **空** | 追いついている。**login / download を実行しない**。実行結果は `ok_noop` |
| `not_initialized` | `STATE_NOT_INITIALIZED` | **空** | **停止**。直近 N 日などを自動設定しない |
| `invalid_state` | `TODAY_JST_INVALID` / `STATE_LAST_TO_INVALID` / `DATE_OUT_OF_RANGE` | **空** | fail-closed で停止 |

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

### C-2. overlap / retry

直近 N 日を毎回取り直す（設計値は ChatGPT が確定）。
長期停止後の catch-up と、1 回あたりの取得範囲の上限を決める。

**重複取得そのものは取得層では避けられない**（同じ範囲を再取得するのが overlap の目的）。
**重複の扱いは後段の責務**であり、このセクションでは扱わない。

### C-3. zero rows

正しいヘッダがありデータ行 0 件なら**正常**。`rows=0` / `result=ok` とし、
watermark だけ安全に前進させる。**0 件を error にしない。**

### C-4. production acquisition runner

新規系統（例 `scripts/demecal-production.ps1`）。**`daily-1.7` を復活させない。**
Phase B で実証済みの **cert / login / STATE A/B/C / `RawContentStream` / CSV validation** は
**同一ロジックを使う**（共通化するか、機械的な parity test を置く）。
**取得部を独自に書き直さない。**

### C-5. scheduler

Windows Task Scheduler。ユーザー `info` / 「ログオン中のみ実行」/
ログオン時＋毎日 / 「開始時刻を過ぎたらすぐ開始」ON（`demecal_unattended_spec §4.3`）。
**実行時刻は業務判断。コードで勝手に決めない。**

### C-6. monitoring

`/api/admin/demecal-run` の実行ログ ＋ GitHub Actions の日次ワークフローを見張りにする
（**新しい通知基盤は作らない** = 既存の確定事項どおり）。
送るのは**非 PII の取得結果だけ**（範囲 / 行数 / 結果 / エラーコード）。
**CSV 本文・臨床値・PII は送らない。**

## 7.3 このセクションの完成条件

```text
Phase B の取得部を維持 (verify-1.4 を書き直さない)
to = 当日を使わない
overlap で取り漏らさない
失敗時に watermark を前進させない
0 件を正常に扱う
production runner が無人で走る
scheduler が登録され、走ったことがサーバ側に残る
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
