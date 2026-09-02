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

---

# 7. Phase C — 本番連携と無人化

Phase B成功後に別問題として着手する。

## C-1. 本人紐付け

現在の `test-<時刻>-<連番>` client_idを本番利用しない。

CSV `指図番号` (`external_test_id`) をWellfort側の内部 `diagnostic_user_id` へ確定的に結び付ける。

正本:

- `lab_tests.external_test_id`
- `id_management_and_correlation_spec.md`

## C-2. 冪等性

同じCSV/同じ指図番号/同じ結果を再取得してもElithへ二重納品しない。

**取り込み成功 → last_to更新失敗 → 同じ範囲再取得**でも重複しないことを機械保証する。

## C-3. date watermark / overlap

`last_to` の意味を「結果承認日で安全に確定したwatermark」として再設計する。

現在の `to = today` は使用しない。

最低案:

```text
to = yesterday
```

より堅牢な案:

```text
過去N日を毎回overlap取得
 + external_test_id等で冪等化
```

採用方式はChatGPT側で最終決定する。

## C-4. 0件

正しいCSVヘッダがありデータ行0件なら正常。

```text
rows=0
result=ok
```

とし、必要なwatermarkだけ安全に前進させる。

## C-5. 本番write順序

本人紐付け・冪等性・watermarkが完成してから初めて:

```text
CSV取得
 → validate
 → id resolve
 → idempotency check
 → Elith/S3 write
 → success確認
 → watermark更新
 → cleanup
```

を有効化する。

## C-6. 無人化

最後にタスクスケジューラ・監視・通知を有効化する。

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
