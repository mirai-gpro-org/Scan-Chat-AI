---
name: impl
description: 承認済み Implementation Spec (docs/specs/WF-NNNN.md) に従って実装する。spec に無い仕様判断は行わず、矛盾・不足があれば SPEC CONFLICT で停止する。
disable-model-invocation: true
argument-hint: "[spec-path]"
---

# /impl — Implementation Spec 実行

**引数**: `$0` = spec path（例 `docs/specs/WF-0001.md`）

---

## この Skill の原則（**逸脱したら失格**）

1. **spec の意味を再解釈しない。** 書かれていないことは実装しない
2. **Confirmed Facts を独自に再定義しない。** 照合はするが、結論を出し直さない
3. **不足・矛盾を推論で埋めない。** 「この意図だろう」「一般的にはこう実装する」は**禁止**
4. **境界判定を自分でしない。** static / behavioral は spec の `kind` が決める。attempt 回数は workflow が数える
5. **spec を変更しない**
6. **停止は敗北ではない。** 埋めて進むことが失格

---

## 手順（**この順序で。飛ばさない**）

### 0. 引数チェック

`$0` が空なら**即停止**。探索しない。

```
SPEC CONFLICT

Expected: spec path が引数で渡されること
Observed: 引数なしで起動された
Evidence: /impl は argument-hint "[spec-path]" を要求する
Impact: 対象 spec を特定できない
Question: 実装対象の spec path を指定してください
```

### 1. validate（**実装前の機械検査**）

```
node scripts/spec-guard.mjs validate $0
```

**非ゼロ終了なら即停止**（出力をそのまま Evidence に載せる）。
この検査が見ているもの: spec path の形式 / spec の存在 / metadata 必須項目 / `status: approved` /
repo 一致 / base_branch 存在 / baseline_sha 存在 / External Evidence の unresolved・期限切れ / Scope 構造。

**自分で同じ判定をやり直さない。** validator が PASS したものを疑わない。

### 2. spec を全文読む

**§1〜§13 をすべて読む。** 部分読みで着手しない。

### 3. Sources / Evidence の存在確認（**照合のみ**）

§13 と §2 / §3 の `evidence` が指すファイル・行・symbol が**現在も存在し、内容が一致するか**だけを見る。

**ここでやってよいのは照合だけ。** 新しい事実の発見・解釈・一般化は**しない**。
不一致を見つけたら**その場で SPEC CONFLICT**。「実質同じ」と判断しない。

### 4. Derived Facts の `reproduce` を実行

§3 の各ブロックの `reproduce` を**そのまま実行**する。
**非ゼロ終了は SPEC CONFLICT**（baseline 時点の前提が崩れている）。

結果を見て「期待と実質同じ」と判断する余地は無い。**exit code がすべて**。

### 5. Reality Check

確認するのは以下**だけ**。

- spec に書かれている対象が存在するか
- Sources / Evidence と現在の repo が一致するか
- Scope 内で実装可能か
- Stop Conditions に該当しないか

**spec を再設計するための工程ではない。**

### 6. Stop Conditions の確認（§12）

該当したら**実装に入らず**停止する。

### 7. 実装

- **§6 Scope に列挙されたファイルのみ**（modify / create / delete の種別も守る）
- **§9 Implementation Requirements に書かれたことだけ**
- 恒久 Do Not Touch（`CLAUDE.md` / `.claude/**` / `.github/workflows/**` / `docs/specs/**` / `scripts/spec-guard.mjs` / `scripts/sol-publisher.mjs`）は**絶対に触らない**
- **Scope 外のリファクタリング・整形・改善を行わない**（たとえ改善であっても violation）

### 8. scope（**実装後の機械検査**）

```
node scripts/spec-guard.mjs scope $0
```

**非ゼロ終了なら停止**。変更を戻すかどうかは自分で判断せず、結果を報告する。

### 9. Verification 直前に working tree を snapshot

```
node scripts/spec-guard.mjs snapshot $0 > /tmp/spec-guard-snapshot.txt
```

**stdout だけをリダイレクトする**（`2>&1` を付けない）。snapshot は
診断メッセージを stderr、snapshot 本体を stdout に分けて出すので、
混ぜると snapshot が壊れて次の verify-clean が誤検知する。

**Verification Command 自身が repository を書き換える**ことがある
（例: 依存が無い repository での `npx astro check` は対話プロンプトを出し package.json を書き換える）。
scope guard は §8 で既に走っているので、**ここで取らないと検出できない**。

### 10. Verification Commands を**全件**実行

§11 の全ブロックを実行する。**失敗した 1 本だけを再実行しない。**

**PoC-1 では、失敗したら種別を問わず停止する**（attempt を数える workflow がまだ無いため）。
**「これは明らかな typo だから直してよい」という判断はしない。**

**ただし、停止する前に必ず §11 の verify-clean を通すこと。**
失敗した Verification こそ tree を汚している可能性が高い。
ここを飛ばすと、**汚れたまま停止して次の実行に持ち越す**。

報告書式:

```
VERIFICATION FAILED

Verification:
Kind:
Command:
Observed:
Error path:
Scope relation:

Action:
STOP
```

`Kind` は **spec の `kind` をそのまま写す**（自分で分類しない）。
`Scope relation` は error path が §6 Scope に**含まれるか否か**の事実だけを書く。

### 11. Verification が tree を汚していないか機械比較

```
node scripts/spec-guard.mjs verify-clean $0 /tmp/spec-guard-snapshot.txt
```

**Verification の成否にかかわらず必ず実行する。**
成功時だけ確認する作りにしない — **失敗した Verification のほうが tree を汚している可能性が高い**。
順序は「Verification 実行 → verify-clean → その後に停止判断」。

**非ゼロ終了なら停止**。目視で「実質同じ」と判断しない。

```
VERIFICATION MUTATED WORKTREE

Verification:
Command:
Observed:

Action:
STOP
```

### 12. Acceptance Criteria ごとに結果を報告

§10 の各 `acceptance` について、`criterion` と `verified_by` の Verification 結果を
紐づけて PASS / FAIL を出す。

### 13. PR 作成

**すべての Acceptance が PASS したときだけ。** 1 つでも FAIL なら PR を作らず停止する。

---

## SPEC CONFLICT 書式（**この形以外で停止しない**）

```
SPEC CONFLICT

Expected:
Observed:
Evidence:
Impact:
Question:
```

- **Expected** … spec がそうなっていると述べていること
- **Observed** … repo の実物がどうなっているか
- **Evidence** … `file:line` / コマンド出力 / exit code
- **Impact** … このまま進むと何が壊れるか
- **Question** … Sol が再設計するために必要な問い

**Question に自分の答えを書かない。** 答えを持っているつもりでも、それは推論。

停止したら**そこで終わる**。回避策を実装しない。
