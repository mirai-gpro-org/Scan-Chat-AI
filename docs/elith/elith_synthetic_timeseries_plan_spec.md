# Elith 納品用 時系列疑似データ 生成仕様（2プラン・3年分）

| 項目 | 内容 |
|---|---|
| 目的 | Elith 結合テスト用に、**2つの契約プランを想定した3年分の時系列疑似データ**を、1プラン=1人の個別フォルダに、確定フォルダ/ファイル仕様どおり生成する。 |
| 対象 | **経営層・幹部プラン** / **ミドルマネジメントプラン** の各1名（合成 client）。 |
| 方式 | 既存の「実データ種を決定論ジッタして時系列化」方式を踏襲（値をゼロから捏造しない）。`src/pages/api/admin/elith-blood-timeseries.ts` を土台に、プラン駆動で全 format を生成。 |
| 根拠(確定仕様) | `docs/elith/elith_s3_data_handoff_spec.md`（§3 フォルダ/命名、§4 format_id、§8 一括書出し/manifest）。`CLAUDE.md`（パス/命名/format_id）。 |
| 状態 | **仕様（本書）。実装は本書確定後。** |

---

## 1. プラン別 受診頻度（クライアント確定 2026-07）

| 検査 | format_id | 経営層・幹部プラン | ミドルマネジメントプラン |
|---|---|---|---|
| 人間ドック・検診 | `HealthCheckupData` | 年1回 | 年1回 |
| 血液検査 | `BloodTestData` | 年3回（4カ月毎） | 無し |
| 遺伝子検査 | `GeneticTestResultData` | 生涯1回（初回のみ） | 無し |
| がんリスク検査(尿) | `CancerRiskAssessmentData` | 年3回（4カ月毎） | 年2回（6カ月毎） |
| AI疾病予測（Elith以外） | `Other`（`data.kind:"ai_prediction"`） | 年1回 | 無し |

※ AI疾病予測は確定 format が無いため暫定 `Other`（`spec §4/§7.4`）。

---

## 2. 3年分の生成数（1名あたり）

**経営層・幹部プラン**（3年で計 **25 JSON**）:

| format_id | 頻度 | 3年の回数 |
|---|---|---|
| HealthCheckupData | 年1 | 3 |
| BloodTestData | 年3(4カ月) | 9 |
| CancerRiskAssessmentData | 年3(4カ月) | 9 |
| GeneticTestResultData | 生涯1(初回) | 1 |
| Other (ai_prediction) | 年1 | 3 |

**ミドルマネジメントプラン**（3年で計 **9 JSON**）:

| format_id | 頻度 | 3年の回数 |
|---|---|---|
| HealthCheckupData | 年1 | 3 |
| CancerRiskAssessmentData | 年2(6カ月) | 6 |

---

## 3. 日付フォルダ（受診回）と収録 format

異なる頻度の検査は、**各「受診回」の日付フォルダに、その回で揃った format だけ**を置く（`spec §3`）。
基準日 `D0`（＝1年目・第1回）は生成時パラメータ。以下は相対月と収録内容。

### 3.1 経営層・幹部プラン — 3回/年 × 3年 = **9 フォルダ**

| 回 | 相対月 | 収録 format |
|---|---|---|
| Y1-R1 | +0  | HealthCheckup, Blood, Cancer, Other(ai) **, Genetic（初回のみ）** |
| Y1-R2 | +4  | Blood, Cancer |
| Y1-R3 | +8  | Blood, Cancer |
| Y2-R1 | +12 | HealthCheckup, Blood, Cancer, Other(ai) |
| Y2-R2 | +16 | Blood, Cancer |
| Y2-R3 | +20 | Blood, Cancer |
| Y3-R1 | +24 | HealthCheckup, Blood, Cancer, Other(ai) |
| Y3-R2 | +28 | Blood, Cancer |
| Y3-R3 | +32 | Blood, Cancer |

- 年次 format（HealthCheckup / Other）は各年 R1 に同梱。**Genetic は Y1-R1 のみ**。
- フォルダ数 9 / JSON 25 / `manifest.json` 9。

### 3.2 ミドルマネジメントプラン — 2回/年 × 3年 = **6 フォルダ**

| 回 | 相対月 | 収録 format |
|---|---|---|
| Y1-R1 | +0  | HealthCheckup, Cancer |
| Y1-R2 | +6  | Cancer |
| Y2-R1 | +12 | HealthCheckup, Cancer |
| Y2-R2 | +18 | Cancer |
| Y3-R1 | +24 | HealthCheckup, Cancer |
| Y3-R2 | +30 | Cancer |

- HealthCheckup は各年 R1 に同梱。フォルダ数 6 / JSON 9 / `manifest.json` 6。

> 例（`D0 = 2023-06-15` の場合）: 幹部 R1=2023_06_15, R2=2023_10_15, R3=2024_02_15, …／ミドル R1=2023_06_15, R2=2023_12_15, …（末日は月末クランプ）。

---

## 4. フォルダ / ファイル / manifest（確定仕様どおり）

```
{prefix}user/{client_id}/date/{YYYY_MM_DD}/
    {format_id}_date_{YYYY_MM_DD}_user_{client_id}.json   # その回の各検査
    manifest.json                                          # 完了マーカー（最後にPut）
```

- パス/命名は `spec §3 / §8`・`CLAUDE.md` 準拠。`client_id` は通年不変、日付フォルダで回を分離。
- `manifest.json`（`spec §8.3`）:
  ```jsonc
  { "client_id": "...", "date": "YYYY_MM_DD", "schema_version": "elith-handoff-v0.1",
    "created_at": "...Z",
    "files": [ { "format_id": "...", "file": "..._..._user_....json" }, ... ],
    "complete": true }
  ```
- **書込み順序**: 各 format JSON を全て Put → **最後に manifest.json**（半端読み防止・`spec §8.2`）。

---

## 5. client_id / 合成の明示

- `client_id`（＝`diagnostic_user_id` 相当の仮名）は合成 ID:
  - 幹部: `elith-test-exec-001` / ミドル: `elith-test-mid-001`（複数名生成する場合は連番）。
- 各 JSON に `synthetic: true` / `date_source: "synthetic"` / `source.note` に synthetic 明記。**PII 非同梱**。

---

## 6. 値の生成方法（既存方式踏襲・決定論・非捏造）

- **種（seed）**: 各 format の**実データ（または既存サンプル）1件**を種にする（血液で実装済みの方式）。
  - measurement系（Blood/Cancer/HealthCheckup）＝ `data.measurements[].value_num` を ±amplitude（既定5%）ジッタ。問診/非数値は維持。
  - `Other`(ai_prediction) ＝ `data.payload` 内の数値を再帰ジッタ（疾患名・要約テキストは維持）。
  - `Genetic` ＝ **1回のみ**（Y1-R1）。時系列でないので**ジッタ無しで種を1件配置**（遺伝情報は経年変化しない）。
- **決定論**: seed = `client_id | 項目/パス | 回index`（FNV-1a→mulberry32）。`Math.random` 非使用で再現可能。
- **基準値/flag**: 血液で導入した基準値マスタ方式（`applyBloodReference`）を Cancer/HealthCheckup にも適用可（マスタ登録がある項目のみ）。

---

## 7. 生成方法（プラン駆動）

既存の単一 format 生成 API（`elith-blood-timeseries.ts`、format 一般化済み）を**プラン定義で束ねて呼ぶ**オーケストレーションを追加する。

- **プラン定義**（データ）:
  ```jsonc
  Executive = {
    HealthCheckupData:        { perYear: 1, intervalMonths: 12 },
    BloodTestData:            { perYear: 3, intervalMonths: 4 },
    CancerRiskAssessmentData: { perYear: 3, intervalMonths: 4 },
    Other:                    { perYear: 1, intervalMonths: 12, kind: "ai_prediction" },
    GeneticTestResultData:    { lifetimeOnce: true }        // Y1-R1 のみ
  }
  Middle = {
    HealthCheckupData:        { perYear: 1, intervalMonths: 12 },
    CancerRiskAssessmentData: { perYear: 2, intervalMonths: 6 }
  }
  ```
- **処理**: プランと `D0`・年数(既定3) から §3 のスケジュールを展開 → 各回・各 format の JSON を種ジッタで生成 → 該当 date フォルダへ配置 → 各フォルダに `manifest.json`(complete:true) を最後に Put。
- 実装先の候補: (A) 新スクリプト `scripts/gen-elith-plan-timeseries.mjs`、または (B) 既存 admin API を拡張（`mode:"plan"`）。→ 実装時に確定。
- **納品**: 生成物は S3 ソース層に置き、既存 `elith-assemble`（全 format 時系列納品化済み）で納品セットへ。1プラン=1個別フォルダで出力。

---

## 8. 前提・確認点（実装前）

1. **種データ**: Cancer / HealthCheckup / Other(ai_prediction) / Genetic の**実データ or サンプル各1件**が必要（血液と同じ前提）。無い format は種を用意する。
2. **`D0`（基準日）と年数**: 既定は3年。基準日は生成パラメータ（未指定時の既定値は実装時に決める）。
3. **amplitude / トレンド**: 既定 ±5% ジッタ。年次の方向性（改善/悪化）を持たせるかは任意（既定は無方向ジッタ）。
4. **Other(ai_prediction) の payload 形**: `spec §7.4` は `payload:{任意}`。種の payload 構造をそのまま踏襲（数値のみジッタ）。
5. **複数名**: 既定は各プラン1名。複数名は client 連番で拡張可。

> 本書は確定仕様。変更時は本書と `docs/elith/elith_s3_data_handoff_spec.md` を更新してから実装する（CLAUDE.md 作業ルール）。
