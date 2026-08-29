# AI疾病予防報告書 — リバート対象コミット

2026-08-29 に Claude (Claude Code) が入れた本機能の実装は**誤りであり、全てリバートする**。

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
| `1e510cf` | cleanup: 当社が創作した文を紙面から外し、廃止した3モードの残骸を削除する | — |

**11 件中 10 件が既に本番ブランチに入っている。** リバートは作業ブランチと
デプロイ元の両方に要る。

**リバート対象外** (本機能の実装ではない):

- `11a8199` デプロイ元ブランチの確定 (A案) と「前の版に戻る」の真因の記録
- `9eecb33` / `d45f353` / `194b61d` 引き継ぎ書と本書

### 併せて外すもの

- `CLAUDE.md` の「AI疾病予防報告書」節にある **【実装】P0〜P4 の記述**
  (実装の記録であって確定仕様ではない)
- `supabase/migrations/20260829000010_diagnosis_report_checkup.sql`
  (`diagnosis_results.checkup_values` 列)。**Supabase へは未適用**。
  適用済みの環境がある場合は列を落とすかどうかを判断すること。

---

## wellfort-site

ブランチ `claude/wellfort-ui-design-draft-7y8dup` (本番)。

| コミット | 内容 |
|---|---|
| `71e7936` | feat(admin/elith-batch): AI疾病予防報告書の抽出監査モーダルを追加 (`src/pages/api/admin/elith-report-audit.ts` ＋ `src/pages/admin/elith-batch.astro`) |
| `680c73e` | 上記のマージ |

**リバート対象外**: `f21ac3f` (Edge Function の自動デプロイ対象に本番ブランチを足す。
デプロイ元切替に伴う CI 修正で、本機能とは無関係)。
