---
spec_id: WF-0000
status: approved
repo: mirai-gpro/scan-chat-ai
base_branch: claude/awesome-carson-UeyUZ
baseline_sha: 0000000
depends_on: []
---

# WF-0000 — <一行タイトル>

> **この文書は Implementation Spec の雛形。** V1 運用では Sol が作成し、人間が承認して merge する。
> **Claude Code は `/impl` からこのファイルを変更しない**（恒久 Do Not Touch）。

---

## 0. metadata の書き方（**この構文以外を認めない**）

`spec-guard.mjs` は汎用 YAML パーサを持たない。**曖昧な記法を「たぶんこういう意味」と解釈させないため**、
metadata の構文を以下に限定する。**逸脱は validate エラー**。

- front matter は **1 行目の `---`** で始まり、**次の `---`** で終わる
- 各行は **`key: value`**。**コロンの後は半角スペース 1 個**
- **入れ子・引用符・コメント・複数行値は不可**
- 許可キーは **6 個ちょうど**: `spec_id` `status` `repo` `base_branch` `baseline_sha` `depends_on`
- `spec_id` は **`WF-` + 4 桁**。**ファイル名と一致**すること
- `status` は **`approved` のみ**（実装可能な spec は常に approved。進行状態は Issue label で管理する）
- `repo` は **`owner/name`**
- `depends_on` は **`[]`** または **`[WF-0001, WF-0002]`**（先に merge が要る spec）

機械可読ブロックは**フェンス付きコードブロック**で書く。**言語タグがブロックの種類**を表す。

---

## 1. Objective

<この spec が何を達成するか。1〜3 文。**設計判断は §8 に書く**>

---

## 2. Direct Confirmed Facts

**file:line から直接確認できる事実だけ。** 一般化・件数・不存在はここに書かない（→ §3）。

```direct_fact DF-01
claim: bridge-queries は subscription を status='active' で絞る
evidence: src/lib/bridge-queries.ts:128
```

---

## 3. Derived Confirmed Facts

**全称・不存在・件数を含む事実は必ずここ。** 例:「全 repository で N 箇所」「他には存在しない」「すべてこの経路を通る」

**`reproduce` は Expected と不一致なら非ゼロ終了するコマンド**でなければならない。
**Claude Code が結果を見て Expected と見比べる方式にしない。** 非ゼロ終了は **SPEC CONFLICT**。

```derived_fact RF-01
claim: diagnosis スキーマへの書き込み入口は measurement-persist.ts だけ
evidence: src/lib/measurement-persist.ts:88
reproduce: test "$(grep -rl "schema('diagnosis')" src/lib --include=*.ts | wc -l)" -eq 1
expected: exit 0
```

---

## 4. Unknown / Assumptions

**確定していないものをここに隔離する。** Confirmed に混ぜない。
ここに書かれた事項に依存する実装は、**Implementation Requirements に書いてはならない**。

- <未確定事項>

---

## 5. External Evidence Required

**コードにも docs にも無く、DB / env / 外部コンソールにしかない事実。**
`status: unresolved` が 1 件でもある、または**有効期限切れ**なら**実装開始禁止**。

```external_evidence EE-01
required_fact: orders への外部キーの有無
source: Production Supabase
status: resolved
collected_by: human
collected_at: 2026-08-31T10:00:00Z
max_age_hours: 24
evidence: FK なし (information_schema.table_constraints 出力)
```

- `status` は `resolved` / `unresolved`
- `collected_by` は `human` / `trusted-readonly-connector`
- `collected_at` は **ISO8601 (UTC, `Z` 終端)**
- `max_age_hours` は**整数**、または期限不要なら **`null`**

---

## 6. Scope

**記載外の modify / create / delete はすべて Scope violation。**
「触ってよいファイル一覧」ではなく、**操作の種類まで含めて宣言**する。

```scope
modify src/lib/example.ts
create src/lib/example-new.ts
```

- 各行は **`<modify|create|delete> <path>`**（半角スペース区切り、パスに空白は使えない）
- 該当が無い種別は**行を書かない**
- パスは**リポジトリルートからの相対**

---

## 7. Do Not Touch

以下は**全 spec 共通の恒久 Do Not Touch**。spec に書かなくても常に適用される。

```
CLAUDE.md
.claude/**
.github/workflows/**
docs/specs/**
scripts/spec-guard.mjs
scripts/sol-publisher.mjs
```

この spec に固有の追加禁止対象があれば以下に列挙する。

```do_not_touch
```

---

## 8. Design Decision

<なぜこの実装方針にしたか。**Claude Code はここを再検討しない**>

---

## 9. Implementation Requirements

**Claude Code が実装する内容。** ここに書かれていないことは実装しない。
**不足・矛盾があれば推論で補完せず SPEC CONFLICT で停止する。**

1. <要件>

---

## 10. Acceptance Criteria

```acceptance AC-01
criterion: <満たすべき条件>
verified_by: V-01
```

- `criterion` / `verified_by` は**必須**
- `verified_by` は **§11 に実在する Verification id** を指すこと（不明な id は validate FAIL）
- id の重複は禁止

---

## 11. Verification Commands

**`kind` は spec 側で確定する。Claude Code に static / behavioral を判断させない。**

- `static` … typecheck / syntax / lint / compile
- `behavioral` … test / assertion / verify:* / API 挙動

```verification V-01
kind: static
command: npm run check
expected_baseline: 0 errors
expected_after: 0 errors
```

- `id` / `kind` / `command` / `expected_baseline` / `expected_after` はすべて**必須**。id の重複は禁止
- Scan-Chat-AI には正式な `check` script と `@astrojs/check` があるので **`npm run check`** を使う
  （`npx astro check` は依存が無い repository で**対話プロンプトを出し package.json を書き換える**）

**PoC-1 では失敗時は種別を問わず停止する**（attempt を数える workflow がまだ無いため）。
将来 workflow 導入後、**static かつ error path が Scope 内のときだけ**最大 2 回の自動修正を許可する。

---

## 12. Stop Conditions

以下に該当したら**推論で解決せず停止**し、§末尾の書式で報告する。

- spec と現在の repo が矛盾している
- Scope 外のファイル変更が必要
- Do Not Touch 対象への変更が必要
- DB schema / API contract の変更が必要
- Acceptance Criteria を満たせない
- spec に存在しない仕様判断が必要
- Sources / Evidence の前提が baseline 以降変更されている
- spec の実装方法が現在の repo では成立しない
- Verification Command がそのまま実行できない
- External Evidence に unresolved / 期限切れがある

**報告書式（この形以外で停止しない）**

```
SPEC CONFLICT

Expected:
Observed:
Evidence:
Impact:
Question:
```

---

## 13. Sources / Evidence

**§2 / §3 が引用した出典の一覧。** baseline_sha 時点の内容を指す。

- src/lib/example.ts:12-34
- docs/example.md §3.2
