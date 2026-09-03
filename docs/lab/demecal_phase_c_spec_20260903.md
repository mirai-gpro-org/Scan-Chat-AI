# デメカル自動取得 Phase C — 本番連携・冪等化・無人化 詳細仕様

**版:** **v0.2 (2026-09-03 改訂)**  
**作成日:** 2026-09-03  
**対象:** Scan-Chat-AI / デメカル血液CSV自動取得  
**前提:** Phase A PASS / Phase B `verify-1.4` PASS / **C0 Reality Check 実施済（PASS ではない）**  
**基準:** `claude/awesome-carson-UeyUZ` / `7c54c79`  
**位置づけ:** `docs/lab/demecal_recovery_plan_20260902.md` §7 を具体化する実装仕様  
**実装担当:** Claude Code  
**設計・Phase移行判定:** ChatGPT / GPT-5.6 Sol

## 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v0.1 | 2026-09-03 | 初版 |
| **v0.2** | 2026-09-03 | **C0 Reality Check の結果を受けた ChatGPT 裁定を反映。** ①本人紐付けを `customer.lab_tests` から **`diagnosis.lab_external_id_map`** へ変更 ②ledger を `customer` → **`diagnosis`** へ ③`customer.lab_tests` 更新を必須条件から除外 ④**取込と最終納品を分離**し `C0_ELITH_CYCLE_DATE_UNRESOLVED` を「Elith final handoff の blocker」へ移動 ⑤デメカル/リージャーの法人関係を technical blocker から外す ⑥C0 結果を **§16**、Wellfort 確認事項を **§17** に追記 |

> **v0.2 で変わったのは「どこに置くか」だけ。**
> §1.1（PII で本人を決めない）・§5.3（semantic hash）・§5.8（preflight all → write later）・
> §6（watermark）・§12（write 順序）・§13（Stop Conditions）は**変更していない**。

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
diagnosis.lab_external_id_map (source_system, external_test_id)   ← v0.2 で変更
  ↓
diagnostic_user_id
```

氏名・生年月日等による自動照合で `diagnostic_user_id` を決めることは禁止。

> **【v0.2 変更】** v0.1 は `customer.lab_tests.external_test_id` を主経路にしていたが、
> **本番 architecture で成立しない**ことが C0 で確定した（§16-A）:
> 本番の顧客データは `app_bridge`（**read-only**・`customer_account`/`subscription`/`kit_shipment`
> の 3 テーブルのみ）で、**`lab_tests` は含まれない**。血液用の `external_test_id` writer も repo に無い。
> → **Scan-Chat-AI が本番で write できる `diagnosis` スキーマ側に、非PII の対応表を持つ。**
>
> ```text
> diagnosis.lab_external_id_map
>   source_system        text    -- 技術的な連携元 namespace。法人 UUID ではない
>   external_test_id     text    -- デメカル CSV の「指図番号」
>   diagnostic_user_id   uuid
>   test_type            text
>   created_at           timestamptz
>   UNIQUE (source_system, external_test_id)
> ```
>
> **`source_system` は法人 UUID ではなく技術的な namespace。** デメカルは仮称 **`demecal_portal`**。
> **「デメカルとリージャーが同一法人か」に本人紐付けロジックを依存させない**（§6・§17-Q1）。
> **回答前に法人 UUID を作らない。**

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
C0 Reality Check / 前提確定          ← 実施済 (§16)。PASS ではなく設計補正で v0.2 へ
 ↓
C0.5 仕様補正 (本 v0.2) + mapping発生源の確定   ← いまここ。C0.5 が閉じるまで C1 へ行かない
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

## 2.1 【v0.2】取込と最終納品を分離する

**Demecal CSV の取込時に、未確定の AI 診断回日を推測して
`/user/{client_id}/date/{YYYY_MM_DD}/` へ本番 write してはいけない。**

```text
Demecal ingestion
   ↓
本人特定済み BloodTestData を内部成果物として確定
   ↓
diagnosis 側で保持 (test_artifacts / test_artifact_files)
   ↓
診断回 (bundleDate) が確定
   ↓
Elith assemble / final S3 handoff
```

- **Demecal import 時には最終 Elith date folder を作らない。**
- したがって **`C0_ELITH_CYCLE_DATE_UNRESOLVED` は「Demecal CSV 取込の blocker」ではなく
  「Elith final handoff 開始の blocker」**へ位置づけを変更する（§3 C0-2）。
- これにより **C1〜C4 は診断回日の確定を待たずに進められる。**

---

# 3. C0 — Reality Check

**最初はコードを書かない。**

## C0-1. 指図番号マッピングの実在確認

**【v0.2】実施済。結果は §16。以下は v0.1 の確認項目（記録として残す）。**

~~正本の受け皿: `customer.lab_tests.external_test_id` / `.diagnostic_user_id` /
`.lab_company_id` / `.test_type`（`(lab_company_id, external_test_id)` unique）~~

→ **この受け皿は本番で使えない**（§16-A）。**v0.2 の受け皿は
`diagnosis.lab_external_id_map`**（§1.1）。

v0.1 の確認 5 項目と実測（詳細 §16-A）:

| # | 確認項目 | 結果 |
|---|---|---|
| 1 | `lab_tests.external_test_id` の writer | **血液には無い**（実 writer は Genoplan 1 本） |
| 2 | 指図番号を結果取得前に登録する業務イベント | **無い** |
| 3 | production で blood の `lab_tests` 行が成立する経路 | **無い** |
| 4 | `lab_company_id` の確定方法 | **不可**（§6 で technical blocker から除外） |
| 5 | server から production `customer.lab_tests` を読める経路 | **無い**（`app_bridge` に含まれない） |

### C0 blocker（**v0.2 で意味を限定**）

**`C0_MAPPING_SOURCE_MISSING` は「受け皿テーブルが無いこと」ではなく
「mapping の発生源（指図番号が判明する時点で `diagnostic_user_id` を持っている処理）が無いこと」を指す。**

受け皿は §1.1 の新テーブルで解決するが、**表を作るだけでは 1 行も埋まらない。**
発生源が確定するまで **C1 の本人解決は実装しない**（§16-B / §17-Q2〜Q4）。

**CSVの氏名・DOB等で穴埋めしない。** **PII から mapping を後付けする案は禁止。**

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

### C0 blocker（**v0.2 で適用範囲を変更**）

診断回日を確定できない状態で採血日を代用して**最終納品**を write してはならない。

```text
C0_ELITH_CYCLE_DATE_UNRESOLVED
```

**適用先を「Demecal CSV 取込」から「Elith final handoff 開始」へ移す**（§2.1）。
取込は診断回日を必要としない（内部成果物として `diagnosis` 側に保持するだけ）ので、
**この blocker は C1〜C4 を止めない。**

> **【v0.2 重要な訂正】この「正本との差」は単純な実装バグではない。**
> **当社ドキュメントどうしが食い違っている**ことが C0 で判明した（§16-C）:
> - `elith_s3_data_handoff_spec.md:47,153` … `date/` = **AI診断回の単位日**
> - `elith_assembly_wrapping_spec.md:79,254-255` … **検査日毎（時系列）に納品**。
>   「date フォルダごとに存在し得る」。**Elith へ読み取り更新を依頼済**（2026-08・発注者判断）
>
> **実装は後者（新しい方）に一致している。** どちらを正とするかは
> **Elith への確認（`elith_s3_data_handoff_spec.md:159` が自ら未決と書いている）を含む裁定事項**であり、
> **実装で答えを出さない。**

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

条件（**v0.2**）:

```text
diagnosis.lab_external_id_map を引く
  source_system      = 'demecal_portal'      ← 法人 UUID ではなく namespace
  external_test_id   = CSV.orderNo 完全一致
  test_type          = 'blood'
  diagnostic_user_id valid
```

~~`lab_company_id = C0で確定したDemecal/Rieger`~~ → **撤回**（§6・§16-A-4）。
**法人の同定を本人紐付けの条件にしない。**

exactly one のみ成功。

```text
0件    → UNRESOLVED_EXTERNAL_TEST_ID
2件以上 → AMBIGUOUS_EXTERNAL_TEST_ID
```

**1行でも未解決ならS3 writeを1件も開始しない。**

## 4.5 追加日付整合（**v0.2 で保留**）

~~DBの `lab_tests.sampled_at` / `.reported_at` が既にあれば CSV と一致必須~~

→ **本番で `lab_tests` を読めない**ので**この照合は成立しない**（§16-A-5）。**v0.2 では要件から外す。**

`diagnosis.lab_external_id_map` に採血日・結果承認日を持たせるかは、
**mapping の発生源（§17-Q2〜Q4）が決まってから判断する** — 発生源が
「指図番号だけを渡す」形なら日付は持てないため、**先に列を決めない**。

**DB 側 null を理由に PII 照合へフォールバックしない**（この原則は変更なし）。

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

推奨新テーブル（**v0.2 で `customer` → `diagnosis` へ変更**）:

```text
diagnosis.lab_result_imports
```

> **理由**: ①**Scan-Chat-AI が本番で write 可能な領域**（`customer` は `app_bridge` 経由の
> read-only。§16-A-5） ②中身は external ID / `diagnostic_user_id` / hash / status 等の**非PII**
> ③**顧客 PII DB へ置く必要が無い**。

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

最低（**v0.2**）:

```text
diagnosis.test_artifacts INSERT/UPSERT
diagnosis.test_artifact_files INSERT/UPSERT
diagnosis.lab_result_imports.status = committed
diagnosis.lab_result_imports.s3_sha256
```

~~`customer.lab_tests.status = imported` / `.assigned_at` / `.assigned_by = auto_lookup`~~
→ **v0.2 で必須条件から外す**（本番で write できないため。§16-A-5）。

**本人割当・import 状態の正本は `diagnosis` 側で完結させる**:

```text
diagnosis.lab_external_id_map     ← 誰の検査か
diagnosis.lab_result_imports      ← 取り込んだか / 冪等性
diagnosis.test_artifacts          ← 成果物メタ
diagnosis.test_artifact_files     ← 実体ファイル
```

`customer` 側への進捗同期が要るなら**別 Phase / 別 API** として扱う（Phase C の範囲外）。

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

---

# 16. 【v0.2 追記】C0 Reality Check の結果

**基準:** `claude/awesome-carson-UeyUZ` / `e2b2428`。**コードは 1 行も変更していない。**
表記は **Confirmed（repo/schema の実測）/ Derived（実測からの論理的帰結）/ Unknown（repo からは決まらない）**。

## 16-A. 本人紐付け

| # | 事項 | 区分 | 出典 |
|---|---|---|---|
| A-1 | `lab_tests.external_test_id` の**実 writer は Genoplan の 1 本だけ** | **Confirmed** | `src/pages/api/admin/genoplan-fetch.ts:274-275`（`external_test_id = kit.serialNumber` / `external_barcode = kit.boxNumber`） |
| A-2 | **血液には writer が無い** | **Confirmed** | `src/lib/elith-blood-csv.ts:171`「**将来** lab_tests への割当に使用」／`src/pages/api/admin/elith-blood-csv.ts:107` |
| A-3 | **デメカル取込 API は DB を 1 行も触らない**（CSV → S3 のみ） | **Confirmed** | `elith-blood-csv.ts` に `supabase` / `test_artifacts` / `persistMeasurements` いずれも grep 0 件 |
| A-4 | **`lab_companies` に「デメカル」の行は無い**。血液は「リージャーラボラトリー」（`1a000001-…`・`{blood}`・`workflow_default 1`） | **Confirmed** | `supabase/seed.sql:20`。しかも**これは dev seed で UUID も手書き固定値** |
| A-5 | **本番の Scan-Chat-AI から `customer.lab_tests` は読めない** | **Confirmed** | `app_bridge` は `customer_account` / `subscription` / `kit_shipment` の**3 テーブルのみ**・`Insert: never` / `Update: never`（`src/types/supabase-bridge.ts`）。`customer` スキーマ経由は**dev モック**（`src/lib/dashboard-queries.ts:205`「dev フォールバック: モック `customer` スキーマ」） |
| A-6 | `wellfort-site` にも `lab_tests` の実装は無い | **Confirmed** | `grep -l lab_tests` = 0 件 |
| A-7 | 現行の `client_id` は **`test-<時刻>-<連番>` の仮 ID** | **Confirmed** | `src/pages/api/admin/elith-blood-csv.ts:92` |

**Derived**: 上記より、**指図番号 → `diagnostic_user_id` の対応表は「本番に受け皿が無い」だけでなく
「発生源も無い」**。→ v0.2 §1.1 で受け皿を `diagnosis` へ移す。**発生源は §16-B。**

## 16-B. mapping の「発生源」— **repo には無い**

### B-1. 指図番号は業務上いつ判明するか

| 事項 | 区分 | 出典 |
|---|---|---|
| **出荷指示 CSV に検査 ID / キット ID の列は無い** | **Confirmed** | `wellfort-site` `supabase/functions/generate-shipping-csv/index.ts:219` のヘッダは `JAN,出荷数,発送先氏名,郵便番号,都道府県,市区町村,地番,建物名,電話番号,order_number` の **10 列**。指図番号もバーコードも無い |
| **`external_test_id` / `external_barcode` を人が入力する admin 画面は両 repo に無い** | **Confirmed** | `wellfort-site` で `external_test_id` / `external_barcode` / 「検査ID」/「バーコード」の grep = **0 件** |
| **現在の両 repo および取得済み資料では、デメカル CSV より前に指図番号を取得する経路を確認できない。実際の採番・印字・通知タイミングは Wellfort Q2/Q3 待ち**（CSV 上の実値は 15 桁前後の数値） | **Confirmed**（= 確認できないこと）／**Unknown**（実際の採番タイミング） | `docs/lab/demecal_unattended_spec.md:557,562`。CSV 列は `レイアウトID`/**`指図番号`**/姓/名/…/`商品CD`/`代理店番号`/`二次店番号`/`検査グループ`/`採血日`/`結果承認日`/`備考半角`/… |
| **設計上も「検査会社が採番」= 将来の話** | **Confirmed** | `docs/architecture/id_management_and_correlation_spec.md:135`「**想定フロー（将来）**: 出荷時に `external_barcode` をキットへ印字/貼付→ユーザー受取/返送時にスキャン→**検査会社が `external_test_id` を採番**→結果受領時に両IDを `lab_tests` に確定」 |
| **同 spec 自身が「未確定」と明記** | **Confirmed** | 同 `:145`「**将来の外部ID運用**: `external_test_id`/`external_barcode` の**採番タイミング・スキャン工程・突合ルール**」 |

**Derived（B-1 の結論）**:
**現在の両 repo および取得済み資料の範囲では、Wellfort が結果受領より前に指図番号を知る経路を確認できない。**

> **【訂正 2026-09-03・ChatGPT 指摘】** 初出時に「**指図番号を採番するのはデメカル側で、
> 結果受領より前に知る経路は現状 1 つも無い**」と断定したが、**これは repo の範囲を超えた主張**だった。
> repo から言えるのは「**その経路をこちらでは確認できない**」までで、
> **実際の採番・印字・通知のタイミングは外部業務**（デメカル／Wellfort の運用）にあり、
> **Q2/Q3 の回答を待って確定する**。`id_management_and_correlation_spec.md:135` の
> 「検査会社が採番」も**当社の想定（将来フロー）**であって先方の確認が取れた記述ではない。
> **外部業務を repo から確定した扱いにしない**（R1/R3）。

### B-2. その時点で `diagnostic_user_id` を持っている処理はあるか

**Confirmed: ある。ただし「その時点」が来ない。**

出荷・キット進捗の各処理は `diagnostic_user_id` を持っている
（`app_bridge.kit_shipment.diagnostic_user_id` / `supabase/functions/kit-self-report` /
`src/pages/api/kit/[id]/self-report.ts`）。**足りないのは相手側の ID（指図番号）だけ。**

### B-3. 既存処理へ「非PII mapping 登録 API 呼出」を追加できる地点

**Derived: 技術的な差し込み口は 3 つある。どれも「指図番号を誰かが入れてくれる」ことが前提。**

| 候補 | 地点 | 前提（= Wellfort/デメカル への確認事項） |
|---|---|---|
| ① 出荷時 | `generate-shipping-csv`（CSV 生成時に `order_number` と対にして登録） | **出荷時点で指図番号が決まるか** → 現状の CSV に無いので **Q2** |
| ② 検体返送/受取時 | `kit-self-report` / `api/kit/[id]/self-report.ts`（ユーザーがキット番号を入力） | **キットに指図番号が印字されているか** → **Q3** |
| ③ 受領後の admin 手動 | 新規 admin 画面（`wellfort-site`）で 指図番号 ↔ 顧客 を人が確定 | **PII を見て人が判断する**ので §1.1 の禁止（**自動**照合の禁止）には抵触しないが、**無人運用にならない** → **Q4** |

**Unknown**: ①②③ のどれが業務として成立するか。**repo からは決まらない。**
**PII から後付けする案は禁止**なので、**Q2〜Q4 の回答が来るまで C1 の本人解決は実装しない。**

> **補足（未確認の仮説・実装しない）**: CSV には **`備考半角`** という自由記入欄が実在する
> （`demecal_unattended_spec.md:558`）。ここに Wellfort 側の ID を入れられるなら
> ①の経路が成立し得るが、**入力できるか・誰が入れるかは未確認**。**Q5 として出す。**

## 16-C. Elith folder date — **当社ドキュメントどうしの食い違い**

| # | 事項 | 区分 | 出典 |
|---|---|---|---|
| C-1 | **直書き経路は `test_date` を folder date にしている**（血液・スキャン とも） | **Confirmed** | `src/lib/elith-blood-csv.ts:316` / `src/lib/elith-export.ts:1397` = `dateFolder = testDate.replace(/-/g,'_')` |
| C-2 | **`bundleDate` の既定は UTC**（正本は JST 基準） | **Confirmed** | `src/lib/elith-assemble.ts:210`「本日 (UTC) を YYYY_MM_DD で返す」／`elith_s3_data_handoff_spec.md:47`「JST 基準」→ **JST 09:00 まで 1 日ずれる** |
| C-3 | **`bundleDate` は時系列 format には効いていない** | **Confirmed** | `elith-assemble.ts:495` `const bd = /^\d{4}_\d{2}_\d{2}$/.test(s.date) ? s.date : bundleDate;` — **`s.date`（= 取込時に付いた `test_date`）が優先**され、`bundleDate` は**パースできない時のフォールバック**。`bundleDate` が実際に効くのは**単発 format（遺伝子・問診）だけ**（同 `:504`） |
| C-4 | `bundleDate` は **caller から明示指定できる** | **Confirmed** | `src/pages/api/admin/elith-assemble.ts:54,124,138`（`body.bundleDate`）→ wellfort-site `admin/elith-batch.astro:1747` |
| C-5 | **`elith_assembly_wrapping_spec` は「検査日毎（時系列）」を明示的に選んでいる** | **Confirmed** | 同 `:79`「検査日毎（時系列）に納品します」／`:254-255`「`HealthAgeData` は…**date フォルダごとに存在し得る**」／`:263`「**Elith 側の読み取りを各 `date/` 走査へ更新をお願いします**」（2026-08・発注者判断） |
| C-6 | **正本 `elith_s3_data_handoff_spec` 自身が未決を抱えている** | **Confirmed** | 同 `:159`「**要確認(Elith)**: フォルダ日付は『診断実行日』基準でよいか、それとも『検体採取日』基準が望ましいか」 |

**Derived（C の結論・重要）**:
**実装は「古い正本」に違反しているのではなく、「新しい方の決定（時系列＝検査日毎）」に一致している。**
**単純な実装バグとして直してはいけない。** どちらを正とするかは
**Elith への確認（C-6）を含む裁定事項**で、**実装で答えを出さない**。

## 16-D. §5 elith-assemble Reality Check（5 問への回答）

| # | 問い | 回答 | 区分 |
|---|---|---|---|
| 1 | 既存 BloodTestData をどう受け取るか | **S3 を走査して拾う**。`inventoryElithSource(sourcePrefix)` が `listObjects` → `parseElithKey` でキー名から `{formatId, clientId, date}` を復元（`elith-assemble.ts:107-135,48`）。**DB は見ない** | **Confirmed** |
| 2 | `bundleDate` を caller が明示指定できるか | **できる**（C-4）。ただし **C-3 のとおり時系列 format には効かない** | **Confirmed** |
| 3 | 取込結果を `test_artifacts` 等へ一旦保存し、後から assemble へ渡せるか | **いまはできない。** assemble の入力は **S3 のキー名**であって DB ではない（回答 1）。`test_artifacts` へ保存しても assemble は拾わない | **Confirmed** |
| 4 | 最終 `/user/{client}/date/{bundleDate}/` write を assemble 側へ一本化できるか | **できるが、C-3 の 1 行を変える必要がある。** 現状は時系列 format が `s.date` を採るので、一本化しても**フォルダ日は取込時の `test_date` のまま**になる | **Confirmed**（挙動）／**Unknown**（変えてよいかは C の裁定次第） |
| 5 | `bundleDate` 未指定時の UTC today fallback を production で禁止できるか | **できる**（`AssembleOptions.bundleDate` は optional なので**必須化するだけ**）。ただし **§2.1 の分離を採るなら、そもそも取込側は folder date を作らない**ので、禁止すべき場所は **assemble の入口 1 箇所**に集約される | **Derived** |

**Derived（D の結論）**: §2.1 の「取込と最終納品を分離」を実現するには、
**assemble の入力を「S3 キー名」から「`diagnosis` の成果物」へ変える**必要がある。
これは v0.1 が想定していたより**大きい変更**なので、**C2 の設計時に明示的に扱う。**

## 16-E. その他の Confirmed（v0.1 の記述の裏取り）

| 事項 | 区分 | 出典 |
|---|---|---|
| §4.2 の today fallback は**実在する** | **Confirmed** | `elith-blood-csv.ts:241` `const testDate = drawn ?? approved ?? new Date()…` / `:242` `date_source: 'today'` / 型は `:150` |
| §6.2 の `to = 昨日` は**既に一致** | **Confirmed** | `scripts/demecal-verify.ps1:954` `(Get-Date).Date.AddDays(-1)`。**ただし `Get-Date` はローカル時刻で JST を保証していない**（C-2 と同種） |
| §5.6 の `file_kind = extracted_json` / `imported_by = wellfort_batch` は**許可値に実在** | **Confirmed** | `supabase/migrations/20260601000010_schemas_and_tables.sql:218` / `:204` |
| §5.1 の新口追加は **`verify:intake-scope` の allowlist 変更が必須** | **Confirmed** | `scripts/verify-intake-scope.ts:31` の `ALLOWED` は 3 口固定。4 つ目を足すと**回帰チェックが落ちる**（意図した設計） |
| §11 の run log 13 項目のうち **8 項目が現行 `RunRecord` に無い** | **Confirmed** | `src/pages/api/admin/demecal-run.ts:32-57`。不足＝`mapped`/`new_imported`/`already_imported`/`unresolved`/`conflicts`/`last_to_before`/`last_to_after`/`error_code` |
| §8 の監視方針は**既存確定事項と一致** | **Confirmed** | `demecal_unattended_spec.md:269,291`「通知基盤は無い。作らずに済ませる」「**GitHub Actions を見張り役にする**」 |

---

# 17. 【v0.2 追記】Wellfort への確認事項

**回答が来るまで実装しない。推測で埋めない。**

## Q1. 検査会社の名称（法人関係）

> デメカルの管理画面（`dl.demecal.net`）から取得している血液検査について、
> **検査実施会社として管理すべき名称は「リージャーラボラトリー」でよいでしょうか。
> それともデメカルを別の検査会社／サービスとして管理すべきでしょうか。**

- **背景**: 当社のマスタ（dev seed）には「リージャーラボラトリー」の行はありますが、
  「デメカル」という行はありません（§16-A-4）。
- **影響範囲**: **本人紐付けには影響しません**（v0.2 で `source_system = 'demecal_portal'` という
  技術的 namespace に切り替えたため。§1.1・§6）。**回答前に法人 UUID は作りません。**

## Q2. 指図番号が判明するタイミング【最重要・C1 の前提】

> 血液検査の **「指図番号」（デメカルの CSV に入っている 15 桁前後の番号）** は、
> **どの時点で・誰が決めていますか。**
> **Wellfort 側で、検査結果を受け取る前に「この指図番号はどのお客様のものか」を知る方法はありますか。**

- **背景**: 現在、出荷指示 CSV には注文番号（`order_number`）と配送先の情報しか入っておらず、
  指図番号の欄がありません（§16-B-1）。当社の設計書も「**検査会社が採番**する」「採番タイミングは
  **未確定**」と書いています（`id_management_and_correlation_spec.md:135,145`）。
- **なぜ要るか**: **お客様の氏名・生年月日で自動的に突き合わせることを禁止している**ためです
  （取り違えが起きたときに検知できないため）。**番号どうしで確実に一致させる**必要があります。

## Q3. 検査キットに番号は印字されていますか

> お客様へお送りする血液検査キットに、**個体を識別する番号やバーコードは印字されていますか。**
> ある場合、その番号は **デメカルの「指図番号」と同じもの**ですか、別のものですか。

- **背景**: 当社 DB には `external_barcode`（キット物理 ID）の受け皿だけ用意してあります
  （`id_management_and_correlation_spec.md:132`）が、**実際に印字されているかは未確認**です。
- **これがあれば**: キット発送時または返送時に番号を控えることで Q2 が解決します。

## Q4. 手作業での突き合わせは許容できますか

> Q2・Q3 のどちらも「無い」場合、**検査結果を受け取ったあとに、
> 管理画面で「この指図番号はこのお客様」と人が確認して確定する**運用は可能ですか。
> その場合、**月あたり何件くらい**になりますか。

- **背景**: この場合、**完全な無人運用にはなりません**（人の確認が 1 手挟まります）。
  件数が少なければ実用的です。

## Q5. CSV の「備考」欄は使えますか（**未確認の仮説**）

> デメカルの CSV には **`備考半角`** という自由記入欄があります。
> **ここに Wellfort 側の注文番号などを入れておくことは可能ですか**（誰がいつ入力する欄でしょうか）。

- **背景**: 当社が実測した CSV の列に `備考半角` が実在します（`demecal_unattended_spec.md:558`）。
  ただし **誰が入力する欄なのかは分かっていません**。使えるなら Q2 が解決します。
  **使えると決めつけて実装はしません。**

## Q6. Elith のフォルダ日付【C-6 の再掲・Elith への確認】

> Elith へ渡す S3 のフォルダ `date/{YYYY_MM_DD}/` は、
> **「AI 診断を実行する回の日付」と「検査を実施した日付」のどちらを基準にすべきでしょうか。**

- **背景**: 当社の仕様書 2 本で記述が食い違っており（§16-C）、**現在の実装は「検査日ごと」**です。
  2026-08 に **Elith へ「各 `date/` を走査する形へ更新をお願いします」と依頼済**
  （`elith_assembly_wrapping_spec.md:263`）なので、**その回答と合わせて確定させたい**論点です。

---

# 18. 【v0.2 追記】Phase C の新しい構成案と変更予定ファイル

## 18.1 構成案

```text
[A] 取込 (Demecal ingestion)          ← Q2〜Q5 の回答が要る
    demecal-production.ps1 (新規)
      → POST /api/admin/demecal-import (新規・x-intake-key)
          parse → resolve (lab_external_id_map) → idempotency plan
          → diagnosis.test_artifacts / test_artifact_files
          → diagnosis.lab_result_imports
      ※ Elith の date フォルダは作らない
    → last_to 前進 (最後)

[B] 最終納品 (Elith final handoff)     ← Q6 の回答が要る
    assemble (bundleDate 明示必須)
      → /user/{client_id}/date/{bundleDate}/
```

**A と B は別 Phase として進める。** A は Q6 を待たない / B は Q2〜Q5 を待たない。

## 18.2 変更予定ファイル（**まだ 1 行も変更していない**）

### 新規（migration は Q2〜Q5 の回答後）

| 予定 | 内容 |
|---|---|
| `supabase/migrations/*_lab_external_id_map.sql` | §1.1 の対応表。**発生源が決まるまで作らない**（列が決まらないため。§4.5） |
| `supabase/migrations/*_lab_result_imports.sql` | §5.2 の ledger（`diagnosis` 側） |
| `src/pages/api/admin/demecal-import.ts` | §5.1 の新口 |
| `scripts/demecal-production.ps1` | §8 の runner（**`demecal-verify.ps1` は変更しない**） |

### 変更

| ファイル | 変更内容 | 依存 |
|---|---|---|
| `src/lib/elith-blood-csv.ts` | §4.1 純粋 parse の分離 / §4.2 today fallback 禁止 | なし（先行可） |
| `src/pages/api/admin/elith-blood-csv.ts` | 直書き経路の位置づけ整理（attended 運用が使用中） | §2.1 |
| `src/lib/elith-assemble.ts` | §16-D-3/4: 入力を S3 キー名から `diagnosis` 成果物へ / `:495` の `s.date` 優先 / `:210` の UTC fallback | **Q6** |
| `src/pages/api/admin/demecal-run.ts` | §11 の 8 フィールド追加 | なし（先行可） |
| `src/lib/api-auth.ts` + `scripts/verify-intake-scope.ts` + `demecal_unattended_spec §3.1` | §7: 新口の allowlist 追加を**同一変更単位で** | §5.1 |
| `scripts/tests/demecal-flow.tests.ps1` | runner 追加ぶんの回帰 | §8 |
| `.github/workflows/` | §8 の見張り | C6 |

### 変更しない

`scripts/demecal-verify.ps1`（**Phase B 成功証跡**）/ `scripts/demecal-daily.ps1`（**凍結維持**）/
`scripts/demecal-probe.ps1` / `scripts/demecal-recon.ps1`。

## 18.3 いま着手してよいもの / いけないもの

| | 内容 |
|---|---|
| **着手可（Q 回答不要）** | §4.1 parse 分離 ／ §4.2 today fallback 禁止 ／ §4.3 CSV 内部重複 ／ §11 run log のフィールド追加 |
| **Q2〜Q5 待ち** | §4.4 本人解決 ／ `lab_external_id_map` の migration ／ §5 の import API 全体 |
| **Q6 待ち** | §2.1 の [B]（assemble / 最終納品） |

**ただし v0.2 の時点では上記いずれも未着手。ChatGPT の C0.5 レビューと GO を待つ。**

---

# 19. 【実装記録】C1-A production parser foundation（2026-09-03）

**基準:** `claude/awesome-carson-UeyUZ` / `98e14f6` からの差分。
**DB / migration / API / S3 write / watermark / runner / scheduler は 1 つも作っていない。**

## 19.1 何を作ったか

`src/lib/elith-blood-csv.ts` に **`parseBloodCsvRowsStrict()`** を追加した（§4.1）。
S3 / `client_id` / `diagnostic_id` / `exported_at` から独立した**純粋 parser**。

```ts
parseBloodCsvRowsStrict({ text?: string; bytes?: Uint8Array }): BloodProductionParseResult
```

```ts
interface BloodProductionRow {
  rowIndex: number;                 // 1-based のデータ行番号 (PII ではない)
  orderNo: string;                  // 指図番号。**必ず string**
  drawnDate: string | null;
  approvedDate: string;             // 必須
  testDate: string;                 // drawnDate ?? approvedDate
  dateSource: 'drawn_date' | 'approved_date';   // **'today' は型に無い**
  itemCount: number;
  subject: { sex: string | null; age: number | null };
  measurements: ElithMeasurement[];
  errorCode: string | null;         // CSV の「エラーコード」列 (デメカル側の検査エラー)
  errorDetail: string | null;       // 同「エラー内容」列
}
```

**raw PII を返さない。** 生年月日は **age の算出中だけメモリで使い、結果に残さない**。

### エラーコード

| コード | 意味 |
|---|---|
| `CSV_HEADER_INVALID` | §6 の最低ヘッダ（`指図番号` / `結果承認日` / `結果項目数`）が欠けている |
| `CSV_NO_DATA_ROWS` | ヘッダは妥当だがデータ行が 0 |
| `BLOOD_ROW_ORDER_NO_MISSING` | 指図番号が空 |
| `BLOOD_ROW_DRAWN_DATE_INVALID` | **採血日が入っているのに実在する日付でない**（v0.2.1 追加） |
| `BLOOD_ROW_APPROVED_DATE_INVALID` | 結果承認日が無い / 実在する日付でない |
| `BLOOD_ROW_TEST_DATE_INVALID` | 検査日を決められない（型と意図の明示。現状は到達しない） |
| `DUPLICATE_EXTERNAL_TEST_ID_IN_CSV` | 同一指図番号が 2 行以上 → **batch 全体 FAIL** |

**1 件でも失敗があれば `ok:false` かつ `rows:[]`。** 部分的な行を返すと呼び出し側が
「使えるものだけ書く」を選べてしまうため、**§5.8 preflight all → write later を型で守る**。
失敗は 1 件ずつでなく**全部まとめて**返す。

## 19.2 決定論パースを複製していない

旧 `buildBloodCsvBundles()` の measurements 構築ループを **`buildRowMeasurements()` として切り出し、
新旧の両方がこれを呼ぶ**。同じロジックを 2 か所に置くと必ず片方だけ直って割れる。

**旧経路の挙動は変えていない** — 既存の `npm run verify:blood-csv` が ALL PASS のままであることで固定。
（`elith-blood-csv.ts` 以外は触っていない。`api/admin/elith-blood-csv.ts` は attended 運用が使用中なので無変更。）

## 19.3 検査 — `npm run verify:blood-parser`（**48 件 PASS**）

**2 種類を混ぜている**:

- **振る舞い**（P01〜P32）… fixture を通して出力を見る
- **ソース検査**（P33〜P40）… production parser の **region のソース文字列**を直接読む

ソース検査が要るのは、「今日の日付を作らない」「UUID を作らない」は
**出力を見るだけでは「たまたま出なかった」と区別できない**から。
region は `C1-A: production parser (ここから)` 〜 `(ここまで)` のマーカーで切る
（**旧経路にはこれらが在る**ので、範囲を切らないと検査が成立しない）。

**踏んだ罠 2 件**（どちらも「検査が空振りする」型）:

1. **region の冒頭コメント自体が禁止語を列挙している**ので、素朴に検査すると自分の説明文に
   引っかかった。マーカーがブロックコメントの**中**にあるため slice は
   「閉じていないコメント片」で始まる → 先頭の `*/` までと末尾の `/*` 以降を落としてから見る。
2. **PII 検査が正規化後の形を見ていなかった。** DOB を結果へ残す退行を注入したとき、
   fixture にある raw の `19800115` では **1 件も引っかからず**、
   正規化後の `1980-01-15` でしか検出できなかった。→ `RAW_PII`（fixture に在る）と
   `DERIVED_PII`（正規化後）を分けて両方を見る。

### 退行注入（**4 件とも落ちることを確認**）

| 注入 | 落ちるテスト |
|---|---|
| `orderNo` を `Number` 化 | P04（17 桁が `…230` に化ける）/ P05（先頭 0 が消える） |
| today fallback を復活 | P21 / P22 / P28 / **P34（region に `new Date(`）** |
| 重複チェックを削除 | P23 / P24 / P25 / P28 |
| DOB を parse 結果へ残す | **P29** / P31 |

**fixture の指図番号は「Number 化すると必ず壊れる」値にしてある** — 17 桁（`2^53` 超で精度が落ちる）と
先頭 0 付き。15 桁だと `Number` 往復しても値が一致してしまい、**テストが空振りする**（P06 がその前提を固定）。

## 19.4 変更ファイル

| ファイル | 内容 |
|---|---|
| `src/lib/elith-blood-csv.ts` | `parseBloodCsvRowsStrict` 追加 / `buildRowMeasurements` 切り出し |
| `scripts/verify-blood-parser.ts` | 新規（48 件） |
| `scripts/blood-csv-fixtures/prod_*.csv` | 新規 7 本（**架空 PII 入り**・Shift_JIS 版 1 本） |
| `package.json` | `verify:blood-parser` を追加 |
| `docs/lab/demecal_phase_c_spec_20260903.md` | §16-B の断定を訂正 / 本節を追記 |

**無変更（禁止リスト・機械確認済み）**: `scripts/demecal-verify.ps1` / `scripts/demecal-daily.ps1` /
`src/pages/api/admin/elith-blood-csv.ts` / `src/pages/api/admin/demecal-state.ts` /
`src/lib/elith-assemble.ts` / `supabase/migrations/**` / `src/lib/s3.ts` /
`src/lib/api-auth.ts` / `scripts/verify-intake-scope.ts` / `.github/workflows/**`。

## 19.5 次に進まないもの

mapping table の migration / mapping API / `demecal-import` API / S3 / watermark /
production runner。**すべて未着手**（Q2〜Q6 の回答と ChatGPT レビュー待ち）。

---

# 20. 【実装記録】C1-A レビュー指摘の修正 — 日付の暦検証（2026-09-03）

**ChatGPT C1-A レビューの blocker 1 件。** parser 以外は触っていない。

## 20.1 何が壊れていたか

1. **`normDate()` は「月 1〜12 / 日 1〜31」しか見ない。**
   `2026-02-31` / `2026-04-31` / `2025-02-29` を**受理していた**。
   医療データの日付なので、**存在しない日をそのまま納品してはいけない**。
2. **strict parser が「採血日が空」と「採血日が在るのに不正」を区別していなかった。**
   どちらも `null` になり、**不正な採血日が黙って結果承認日へ fallback**していた
   （= 採血日が別の日に化けたまま通る）。

## 20.2 直し方

- **`normDateStrict()` を strict 専用に新設**（`normDate` は attended 経路が使うので**変更しない**）。
  - **実在する暦日だけを通す**。閏年は **100 年 / 400 年規則まで**。
  - **`Date` を一切使わない** — production parser に現在時刻を持ち込まないため、算術だけで判定する。
  - 年の範囲は 1900〜2999（`0000` 年のような明らかな異常を落とす。生年月日も検査日も通る幅）。
- **戻り値を 3 値 `{blank | invalid | ok}` にした。**
  `string | null` の 2 値だと呼び出し側が必ず取り違える（実際 v1 がそうなっていた）。
- **採血日**: 空 → `drawnDate=null` で `approvedDate` へ fallback（従来どおり）。
  **在るのに不正 → `BLOOD_ROW_DRAWN_DATE_INVALID` で FAIL（fallback しない）。**
- **結果承認日**: 同じ暦検証。不正なら既存の `BLOOD_ROW_APPROVED_DATE_INVALID`。
- **生年月日も strict で見る**（`2025-02-29` から年齢を作らない）。
  ただし必須ではないので **FAIL にはせず `age` を null** にする。

## 20.3 検証 — `npm run verify:blood-parser` = **61 件 PASS**（48 → 61）

追加は P41〜P53。

| | 内容 |
|---|---|
| P41 / P42 | `2026-02-28` valid / **閏年 `2024-02-29` valid** |
| P43 / P44 / P45 | **非閏年 `2025-02-29`** / **`2026-02-31`** / **`2026-04-31`** が invalid |
| P46 / P47 | **不正な採血日が `approvedDate` へ fallback しない**（+ その検査が意味を持つ前提） |
| P48 | **空の採血日だけ** は fallback する |
| P49 / P50 | 結果承認日にも同じ暦検証が効く |
| P51 | （前提）旧 `normDate` はこれらを受理する = strict 版が要る理由 |
| **P52 / P53** | **100 年規則 `2100-02-29` invalid / 400 年規則 `2000-02-29` valid** |

### 退行注入（**4 件とも落ちる**）

| 注入 | 落ちるテスト |
|---|---|
| 暦検証を旧 `normDate` 相当（`D <= 31`）へ戻す | P43 / P44 / P45 / P46 / P49 / P50 |
| 不正な採血日を blank と同じ扱いにする（fallback 復活） | P43 / P44 / P45 / P46 / **P47** |
| 閏年を `year % 4 === 0` だけにする | **P52** |
| 400 年規則だけ落とす（`% 100 !== 0` のみ） | **P53** |

> **P52 / P53 は後から足した。** 最初に「閏年を 4 の倍数だけ」に壊す退行を注入したとき、
> **59 件すべて PASS のままだった** — 100 年 / 400 年規則を 1 件もテストしていなかった。
> **退行注入をしなければ、この穴には気づけなかった。**

既存 suite は全て PASS（`verify:blood-csv` ALL PASS = **旧経路の挙動不変**／`verify:demecal-flow` 129 /
`verify:report-model` 92 / `verify:sheet-contract` / `verify:demo-gate` / `verify:ps1-order` /
`verify:intake-scope` / `verify:probe-bat-gate` / `astro check` 0 errors / `astro build` 成功）。

**変更したのは `src/lib/elith-blood-csv.ts` と `scripts/verify-blood-parser.ts` の 2 本だけ。**
DB / migration / API / S3 / mapping / watermark へは進んでいない。
