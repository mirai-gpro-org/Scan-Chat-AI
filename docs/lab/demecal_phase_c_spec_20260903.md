# デメカル自動取得 Phase C — 本番連携・冪等化・無人化 詳細仕様

**作成日:** 2026-09-03  
**対象:** Scan-Chat-AI / デメカル血液CSV自動取得  
**前提:** Phase A PASS / Phase B `verify-1.4` PASS  
**基準:** `claude/awesome-carson-UeyUZ` / `7c54c79`  
**位置づけ:** `docs/lab/demecal_recovery_plan_20260902.md` §7 を具体化する実装仕様  
**実装担当:** Claude Code  
**設計・Phase移行判定:** ChatGPT / GPT-5.6 Sol

---

## 0. Phase C の目的

Phase B で確定したのは、デメカルからCSVを決定論的に取得し、メモリ上で正しく検査できるところまで。

```text
mTLS / login
 → STATE A
 → STATE B
 → STATE C
 → CSV取得
 → RawContentStream byte[]
 → Shift_JIS / filename / header / rows 検査
```

Phase C ではこの取得経路に対して、以下を追加する。

```text
本人を間違えない
重複納品しない
取り漏らさない
失敗時にwatermarkを進めない
0件を正常に扱う
正しいdiagnostic_user_idでElith/S3へ書く
無人で監視可能にする
```

**Phase Bで実証したSTATE A/B/C取得ロジックを再設計し直さない。**

---

# 1. 絶対条件

## 1.1 PIIを本人紐付けに使わない

CSVには氏名・生年月日・住所・電話・メール等が含まれるが、自動本人割当には使わない。

主経路は必ず:

```text
CSV 指図番号
  ↓ exact match
customer.lab_tests.external_test_id
  ↓
diagnostic_user_id
```

氏名・生年月日等による自動照合で `diagnostic_user_id` を決めることは禁止。

## 1.2 専用PCへ管理鍵を置かない

専用PCに置いてよいもの:

- mTLS証明書
- DPAPI保存済みデメカル資格情報
- `LAB_INTAKE_API_KEY`
- 診断用途の `PROBE_UPLOAD_TOKEN`

置かないもの:

- `ADMIN_API_KEY`
- Supabase service role
- AWS access key / S3管理権限

DB照合・冪等性・S3 writeはScan-Chat-AIサーバ側で行う。

## 1.3 Phase B成功経路を保存

- `scripts/demecal-verify.ps1` (`verify-1.4`) は保持。
- `scripts/demecal-daily.ps1` (`daily-1.7`) の凍結は維持。
- Phase C本番runnerは新規系統とする。
- verify-onlyへ本番writeを追加しない。

---

# 2. Phase C の段階

```text
C0 Reality Check / 前提確定
 ↓
C1 production parser + 本人解決（writeなし）
 ↓
C2 冪等性 + production import API
 ↓
C3 watermark / overlap + production runner
 ↓
C4 fault injection / staging
 ↓
C5 controlled production run 1回
 ↓
C6 scheduler / monitoring
```

各段階のExit Criteriaを満たすまで次へ進まない。

---

# 3. C0 — Reality Check

**最初はコードを書かない。**

## C0-1. 指図番号マッピングの実在確認

正本の受け皿:

```text
customer.lab_tests.external_test_id
customer.lab_tests.diagnostic_user_id
customer.lab_tests.lab_company_id
customer.lab_tests.test_type
```

DBには `(lab_company_id, external_test_id)` のunique制約がある。

Claude Codeは以下を機械確認する。

1. `lab_tests.external_test_id` を作成・更新する既存コード。
2. デメカル/リージャー血液検査で、指図番号を結果取得前に登録する業務イベント。
3. productionでbloodの `external_test_id` を持つ `lab_tests` 行が成立する既存経路。
4. Demecal/Riegerを指す `lab_company_id` を安定して確定する方法。
5. Scan-Chat-AIサーバからproductionの `customer.lab_tests` を読める既存権限・接続経路。

### C0 blocker

結果取得前に指図番号をDBへ登録する経路が無ければ:

```text
C0_MAPPING_SOURCE_MISSING
```

として停止。

**CSVの氏名・DOB等で穴埋めしない。**

---

## C0-2. Elith S3フォルダ日付

現在、正本と現行血液コードに差がある。

正本 `elith_s3_data_handoff_spec`:

```text
date/{YYYY_MM_DD} = AI診断回の単位日
JSON test_date    = 検査実施日 / 採血日
```

現行 `elith-blood-csv.ts`:

```text
testDate = 採血日 → 結果承認日 → today
同じtestDateをS3 folderにも使用
```

Claude Codeは以下を確認する。

1. 他の現行Elith exportがfolder dateをどう決めているか。
2. サブスク/検査回を表す既存データ。
3. `lab_tests → shipment → subscription/year/seq` 等からAI診断回の日付を確定できるか。
4. Elith側と現在運用している実パスについてrepo内の最新合意・実測。

### C0 blocker

診断回日を確定できない状態で採血日を代用して本番writeしてはならない。

```text
C0_ELITH_CYCLE_DATE_UNRESOLVED
```

として停止する。

---

# 4. C1 — production parser / 本人解決

まだS3へ書かない。

## 4.1 parseとbuildを分離

現行 `buildBloodCsvBundles()` は:

```text
CSV parse
+ client_id採番
+ JSON生成
+ S3 key生成
```

を一度に行う。

Phase Cではまず純粋parseを分離する。

例:

```text
parseBloodCsvRows(bytes)
```

出力:

```text
orderNo
drawnDate
approvedDate
testDate
dateSource
itemCount
subject
measurements
errorCode
errorDetail
```

ここでは `client_id` / `diagnostic_id` / S3 keyを作らない。

## 4.2 productionではtoday fallback禁止

現在の:

```text
採血日なし
→ 結果承認日なし
→ today
```

は禁止。

production最低要件:

- `指図番号` 必須
- `結果承認日` 必須かつ妥当
- `test_date` は採血日があれば採血日、なければ結果承認日
- 両方不正ならFAIL
- 実行日を医療データの日付として捏造しない

例:

```text
BLOOD_ROW_ORDER_NO_MISSING
BLOOD_ROW_APPROVED_DATE_INVALID
BLOOD_ROW_TEST_DATE_INVALID
```

## 4.3 CSV内部重複

同じCSV内に同一指図番号が2行以上あれば:

```text
DUPLICATE_EXTERNAL_TEST_ID_IN_CSV
```

でbatch全体FAIL。

先頭だけ採用しない。

## 4.4 本人解決

サーバ側で全orderNoをまとめてDB照合。

条件:

```text
external_test_id = CSV.orderNo 完全一致
test_type = blood
lab_company_id = C0で確定したDemecal/Rieger
diagnostic_user_id valid
```

exactly one のみ成功。

```text
0件    → UNRESOLVED_EXTERNAL_TEST_ID
2件以上 → AMBIGUOUS_EXTERNAL_TEST_ID
```

**1行でも未解決ならS3 writeを1件も開始しない。**

## 4.5 追加日付整合

DBの `lab_tests.sampled_at` が既にあればCSV採血日と一致必須。

DBの `lab_tests.reported_at` が既にあればCSV結果承認日と一致必須。

不一致ならFAIL。DB側nullを理由にPII照合へフォールバックしない。

## C1 Exit Criteria

- production parseで `test-*` client_idを作らない
- 全行exact resolve
- unresolved/duplicate/date conflictでwrite 0
- PIIによる本人割当コード0
- 複数人fixture PASS
- production S3 writeはまだOFF

---

# 5. C2 — 冪等性 / production import API

## 5.1 新しい本番入口

推奨:

```text
POST /api/admin/demecal-import
```

認証:

```text
x-intake-key: LAB_INTAKE_API_KEY
```

入力:

```json
{
  "csvBase64": "...",
  "filename": "...",
  "range_from": "YYYY-MM-DD",
  "range_to": "YYYY-MM-DD"
}
```

CSV原本を保存しない。
request bodyをログへ出さない。

## 5.2 import ledger

S3とDBは同一transactionにできないので、retry可能な非PII ledgerを持つ。

推奨新テーブル:

```text
customer.lab_result_imports
```

最低カラム案:

```text
id uuid PK
lab_test_id uuid UNIQUE NOT NULL
source_kind text NOT NULL
source_external_id text NOT NULL
diagnostic_user_id uuid NOT NULL
semantic_sha256 text NOT NULL
diagnostic_id uuid NOT NULL
exported_at timestamptz NOT NULL
s3_key text NOT NULL
s3_sha256 text NULL
status text NOT NULL
attempt_count int NOT NULL DEFAULT 0
last_error text NULL
created_at timestamptz
updated_at timestamptz
```

status:

```text
prepared
uploaded
committed
conflict
failed
```

制約:

```text
UNIQUE(source_kind, source_external_id)
UNIQUE(lab_test_id)
```

PIIは保存しない。

## 5.3 semantic hash

冪等性判定用に、Elithへ意味のある非PIIデータだけをcanonical化しSHA-256。

含める:

```text
external_test_id
diagnostic_user_id
test_date
date_source
subject.sex
subject.age
measurements[]
source.error_code
source.error_detail
```

含めない:

```text
exported_at
diagnostic_id
filename
実行時刻
```

同一external_test_idでsemantic hashが変わったら:

```text
IDEMPOTENCY_CONTENT_CONFLICT
```

自動上書き禁止。

## 5.4 retryで同じpayload

ledger作成時に一度だけ:

```text
diagnostic_id
exported_at
```

を発行し保存。

retryでは同じ値を再利用し、同じ入力から同じJSON bytesを再生成できること。

## 5.5 S3 write

新規rowごとに:

```text
ledger PREPARED
 ↓
expected JSON / exact SHA
 ↓
target S3確認
```

targetなし:

```text
PUT
→ GETしてSHA確認
→ ledger UPLOADED
```

targetあり:

- hash一致 → 再PUTせずrecovery
- hash不一致 → `S3_TARGET_CONFLICT`、上書き禁止

## 5.6 DB finalization

S3成功後、DB側はtransaction/RPCで一括確定。

最低:

```text
diagnosis.test_artifacts INSERT/UPSERT
diagnosis.test_artifact_files INSERT/UPSERT
customer.lab_tests.status = imported
customer.lab_tests.assigned_at
customer.lab_tests.assigned_by = auto_lookup
ledger.status = committed
ledger.s3_sha256
```

`test_artifacts`:

```text
source = wellfort_lab
test_type = blood
diagnostic_user_id = resolved id
external_test_id = 指図番号
test_date = 検査日
imported_by = wellfort_batch
```

`test_artifact_files`:

```text
file_kind = extracted_json
storage_url = s3://...
sha256
size_bytes
```

途中失敗で半端なDB状態を残さない。

## 5.7 already imported

ledgerがcommittedなら:

```text
already_imported
```

としてS3 PUT 0。

正常扱い。

## 5.8 batch原則

**preflight all → write later**

```text
parse all
resolve all
idempotency plan all
↓
1件でもNG
write 0 / watermark 0
```

全行OKの場合だけwrite。

---

# 6. C3 — watermark / overlap

## 6.1 last_to の意味

`last_to` は:

> 結果承認日フィルタについて「この日までの範囲処理が全部成功した」というcoverage high-watermark

とする。

**CSV中の最大採血日・最大test_dateではない。**

現行 `elith-blood-csv.ts` の `max_test_date` をwatermarkへ使わない。

## 6.2 to

```text
to = JSTの昨日
```

当日は対象にしない。

朝の取得後、同日中に結果承認された行を永久に取り漏らすのを防ぐ。

## 6.3 overlap

設計値:

```text
DEMECAL_OVERLAP_DAYS = 7
```

既存last_toあり:

```text
from = last_to - 6日
to   = yesterday
```

直近7日を毎回取り直す。

重複はC2のidempotencyでskip。

## 6.4 最大60日

requested rangeが60日超なら:

```text
chunk_from = from
chunk_to   = min(from + 59日, yesterday)
```

1 scheduled runにつき**1 chunkだけ**。

長期停止後は日次でcatch-up。
1回で複数chunkを連続送信しない。

## 6.5 初回state

productionで `last_to=null` のときに勝手に直近7日を開始しない。

```text
STATE_NOT_INITIALIZED
```

で停止。

運用開始時、管理者が初期last_toを明示設定する。

専用PCのintake keyから強制巻戻しを許可しない。

## 6.6 watermark更新

以下のみ:

```text
new_imported + already_imported == all rows
```

または:

```text
valid header + rows == 0
```

の場合に:

```text
last_to = range_to
```

禁止:

```text
max_test_date
最大採血日
partial success
unresolvedあり
conflictあり
```

---

# 7. 0件

valid CSV header + data rows 0 は正常。

```text
result = ok_zero
S3 PUT = 0
last_to = range_to
```

0件をerrorにしない。

---

# 8. production runner

新規:

```text
scripts/demecal-production.ps1
```

など明確な別系統。

**daily-1.7を復活させない。**

Phase Bで実証済みの:

```text
cert/login
STATE A/B/C
RawContentStream
CSV validation
```

は同一ロジックを使う。

可能ならfunction共通化または機械的parity testを入れ、Claudeが取得部を独自に書き直さない。

runner追加部分:

```text
state GET
 ↓
range計算
 ↓
CSV取得 + validate
 ↓
rows=0 → state update
rows>0 → POST demecal-import
             ↓ ok only
          state update last_to=range_to
 ↓
run log
 ↓
memory discard
```

**watermarkは最後。**

---

# 9. C4 — fault injection

専用PC不要で最低以下を検証。

1. 同じCSVを2回 → 2回目S3 PUT=0
2. S3成功→DB finalize失敗 → retryで再PUTせずcommit
3. target存在hash一致 → recovery
4. target存在hash不一致 → conflict、overwrite 0
5. 1 row unresolved → batch write 0
6. date conflict → batch write 0
7. upload失敗 → watermark 0
8. DB finalize失敗 → watermark 0
9. all already_imported → watermark前進
10. rows=0 → watermark前進 / S3 0
11. 7-day overlap反復 → 二重納品0
12. todayをwatermark対象にしない
13. no state → STATE_NOT_INITIALIZED
14. >60日backlog → 1 chunkだけ
15. PIIがElith JSON / ledger / run logに出ない

退行注入でもテストが落ちること。

---

# 10. controlled production run

C0〜C4 PASS後のみ1回。

事前確認:

```text
mapping source READY
cycle/folder date READY
ledger READY
state initialized
production import API READY
S3 bucket/prefix READY
daily-1.7 frozen
verify-1.4 available
```

確認値は非PIIのみ:

```text
range
rows
mapped
new_imported
already_imported
unresolved=0
conflict=0
S3 keys
DB committed
last_to before/after
```

成功後のみschedulerへ。

---

# 11. scheduler / monitoring

Windows Task Scheduler。

時刻は業務判断。コードで勝手に決めない。

`demecal-run`へ最低限:

```text
started_at
finished_at
script_version
range_from
range_to
rows
mapped
new_imported
already_imported
unresolved
conflicts
last_to_before
last_to_after
result
error_code
```

PII / CSV本文 / clinical valuesは送らない。

要通知:

```text
CERT_NOT_FOUND
LOGIN_FAILED
STATE_* failure
CSV_* failure
UNRESOLVED_EXTERNAL_TEST_ID
AMBIGUOUS_EXTERNAL_TEST_ID
IDEMPOTENCY_CONTENT_CONFLICT
S3_TARGET_CONFLICT
S3_WRITE_FAILED
DB_FINALIZE_FAILED
STATE_WRITE_FAILED
```

0件は通知不要。

---

# 12. 最終write順序

```text
[専用PC]
state GET
 ↓
range
 ↓
CSV取得
 ↓
local validate
 ↓
0件 ─────────────────────┐
 ↓ rows>0                 │
POST demecal-import       │
                          │
[Server]                  │
parse all                 │
resolve all               │
idempotency plan all      │
 ↓ all OK                 │
prepare ledger            │
 ↓                        │
S3 existing check         │
 ↓                        │
PUT / recover             │
 ↓                        │
S3 hash verify            │
 ↓                        │
DB transaction finalize   │
 ↓                        │
OK ───────────────────────┤
                          │
[専用PC]                  │
last_to = range_to ◀──────┘
 ↓
run log
 ↓
memory discard
```

**watermarkが最後。**

---

# 13. Stop Conditions

以下は自動回避禁止。

- mapping source不在
- diagnostic_user_id未解決
- external_test_id重複
- same external_test_idのsemantic内容変更
- Elith cycle/folder date未確定
- S3既存objectが期待hashと違う
- partial failure
- DB finalize failure
- state update failure

禁止:

```text
PIIで本人を推測
別IDへ自動フォールバック
既存S3を上書き
partial成功でwatermark前進
```

---

# 14. Claude Codeへの最初の指示

**Phase Cを受け取っても実装を始めない。まずC0 Reality Checkのみ。**

報告項目:

1. `lab_tests.external_test_id` のwriter/登録経路
2. production bloodの指図番号mappingを事前に用意できる根拠
3. Demecal/Rieger `lab_company_id` の確定方法
4. serverからcustomer/diagnosis schemaへアクセスする既存経路
5. Elith folder dateの現行実装と正本差分
6. AI診断回日を決める既存データ
7. Phase Cで変更予定ファイル一覧
8. 本仕様と現実のSPEC CONFLICT

**C0報告後に停止。コード変更なし。**

ChatGPTがC0をレビューしてGOを出してからC1へ進む。

---

# 15. Phase C 完了条件

```text
Phase B取得部を維持
external_test_id exact mapping
PII自動照合なし
client_id = diagnostic_user_id
Elith folder date正しい
today fallbackなし
冪等ledger
retryで再PUTなし
S3 conflict overwriteなし
transactional DB finalize
7-day overlap
to=yesterday
last_to=coverage range_to
0件正常
partial failureでlast_to据置
controlled production run PASS
scheduler
monitoring / alert
verify-1.4保持
daily-1.7は新runner完成まで凍結
```
