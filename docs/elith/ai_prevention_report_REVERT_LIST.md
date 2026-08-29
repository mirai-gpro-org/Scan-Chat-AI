# AI疾病予防報告書 — リバート記録

2026-08-29 に Claude (Claude Code) が入れた本機能の実装は誤りであり、**リバート済み**。

理由 (事実のみ):

- 本機能のミッション「可読化」(`ai_prevention_report_generation_spec.md` §1.1) を満たしていない。
  画面に出る本文 20,297 字 / 受領本文 20,490 字 = **削減率 1%**。
- 設計ポリシー (同 §1.0 = サービスの 2 本柱) に従っていない。
- 仕様に「採る」と書かれた変換 (同 §4.2) が実装されていない。
- アプリが書いた散文を紙面に出した (同 §1.0 / §1.3.1 (c) 内容の創作 = 不可)。

**確定仕様として参照しないこと。** 仕様の正本は
`docs/elith/ai_prevention_report_generation_spec.md`。
着手前に `docs/elith/ai_prevention_report_HANDOVER.md` を読むこと。

---

## Scan-Chat-AI

作業ブランチ `claude/clever-cray-ngg0h6`。
「デプロイ元」= `claude/awesome-carson-UeyUZ` (本番) に既に入っているかどうか。

| コミット | 内容 | デプロイ元 |
|---|---|---|
| `cd0a556` | feat(report): P0 章レジストリと表示モデルの型 | 済 |
| `bf885ae` | feat(report): P1 新形式アダプタ + 検出ルール差し替え + P4.3 回帰 | 済 |
| `a0659f5` | refactor(report): fixture を src/data/elith へ集約し、章を見出し単位のブロックに割る | 済 |
| `0ab589f` | feat(report): P2 表示モデル駆動の1本の読み物 + 印刷専用ビュー + 保存導線 | 済 |
| `8d6a4a0` | feat(report): P3 取り込み API の 3 ファイル対応 + checkup_values 列 | 済 |
| `8da859d` | feat(report): P4 データ品質ガード + P4.2 抽出監査 API | 済 |
| `ab6bae7` | docs: P4.2 の admin UI を wellfort-site 側で実装したことを記録 | 済 |
| `c71f120` | fix(report): 2本柱の帯を常設にする | 済 |
| `2dd1c6c` | fix(report): 2本柱を冒頭に置く | 済 |
| `1c7493e` | fix(report): 設計ポリシーの説明文を紙面から外す | 済 |
| `1e510cf` | cleanup: 当社が創作した文を紙面から外し、廃止した3モードの残骸を削除する | 済 |

**【訂正】11 件すべてが本番ブランチに入っている。** 当初「10 件」としていたが、
PR #180 が `claude/clever-cray-ngg0h6` を `claude/awesome-carson-UeyUZ` へマージ済みで、
実測では**本番ブランチ = `f19d0fc` が作業ブランチと完全一致** (差分 0 件・両方向) だった。
`1e510cf` も本番に入っている。

**リバート対象外** (本機能の実装ではない):

- `11a8199` デプロイ元ブランチの確定 (A案) と「前の版に戻る」の真因の記録
- `9eecb33` / `d45f353` / `194b61d` 引き継ぎ書と本書

### 併せて外したもの

- `CLAUDE.md` の「AI疾病予防報告書」節にあった **【実装】P0〜P4 の記述**
  → 「【リバート済み 2026-08-29】」の記録へ置換。
- 仕様書 §9.2〜§9.6 の実装内容の記述
  → §9.2「【リバート済み】P0〜P4 の実装」へ置換。**実測した事実だけ表で残した**。
- `supabase/migrations/20260829000010_diagnosis_report_checkup.sql`
  (`diagnosis_results.checkup_values` 列)。**「Supabase へ未適用」を前提に削除した。**
  **当方から Supabase の実状態は確認できない (未確認)。** 適用済みの環境があれば、
  列だけが残りマイグレーション履歴と食い違う → その環境では別途判断すること。
- `src/lib/app-config.ts` の 5 キー (`ui.cancer_screening_not_included` /
  `report.sections.{order,hidden,labels,collapsed}`)。読み手のコードが消えると
  wellfort-site の「⚙ 運用パラメータ」に**効かないつまみが 5 つ並ぶ**ため
  (同モーダルは `CONFIG_SPECS` を全件描画する)。→ **現行キーは 18 件**。

### 残したもの (リバートしていない)

- `src/data/elith/report_text_20260826.json` / `health_checkup_20260826.json`
  (2026-08-26 受領分・合成検体・PII なし)。**参照コードは無くなったが、HANDOVER §2.3 が
  素材の在処として名指ししているデータ**なので消さない。
- 仕様書のうち §4.-1「2 本柱の帯は常設」ほか**仕様として書かれた節**。
  §9 の実装記録とは別物なので、一括リバートせず選択的に扱った。

### リバートのやり方 (記録)

`git revert` の一括適用はしていない。11 コミットは仕様書 (正本) と受領 JSON (素材) も
巻き込んでいるため、**コード/設定は `cd0a556^` の状態へ戻し、ドキュメントは手で直した**。

| 対象 | 方法 |
|---|---|
| `app-config.ts` / `elith-report-queries.ts` / `elith-report-sample.ts` / `elith-report-highlights.ts` / `report-view.ts` / `report.astro` / `api/admin/elith-report/upload.ts` / `package.json` | `git checkout cd0a556^ -- <path>` |
| `report-adapter.ts` / `report-model.ts` / `report-sections.ts` / `api/admin/elith-report/audit.ts` / `scripts/verify-report-model.ts` / `20260829000010_*.sql` | `git rm` |
| `CLAUDE.md` / 仕様書 / 本書 / HANDOVER | 手で編集 (他の変更を巻き込まないため) |

---

## wellfort-site

ブランチ `claude/wellfort-ui-design-draft-7y8dup` (本番)。

| コミット | 内容 |
|---|---|
| `71e7936` | feat(admin/elith-batch): AI疾病予防報告書の抽出監査モーダルを追加 (`src/pages/api/admin/elith-report-audit.ts` ＋ `src/pages/admin/elith-batch.astro`) |
| `680c73e` | 上記のマージ |

**リバート対象外**: `f21ac3f` (Edge Function の自動デプロイ対象に本番ブランチを足す。
デプロイ元切替に伴う CI 修正で、本機能とは無関係)。
