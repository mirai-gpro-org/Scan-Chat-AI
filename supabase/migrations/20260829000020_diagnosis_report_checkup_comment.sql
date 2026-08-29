-- AI疾病予防報告書: `checkup_values` / `report` のコメントを実態に合わせる。
--
-- 正本: docs/elith/ai_prevention_report_generation_spec.md §9.2
--
-- 【なぜ 20260829000010 を直さないか】あちらは**適用済み**。
--   このリポジトリの適用は `supabase db push` (未適用ぶんのみ反映・`schema_migrations` で
--   状態管理。docs/hp_ec/連携_DB適用プロセス課題と対策.md) なので、適用済みファイルを
--   編集しても push はスキップする。編集は**新環境 (`db reset`) にしか届かず**、
--   同じファイル名で中身の違う DB が並ぶ。→ 前進マイグレーションで直す。
--
-- 【何が食い違っていたか】20260829000010 のコメントは、同日に入れた
--   AI疾病予防報告書の実装 (P0〜P4) を前提に書かれていた。**その実装は全て
--   リバートした**ため、コメントだけが実装を指したまま残っていた。
--     - `report` 列: 「schema_version=elith-v2.0 は dict 形式」と書いてあるが、
--       **`elith-v2.0` を書くコードは無い**。`diagnosis_results.schema_version` の
--       既定は 20260601000010 の `'elith-v1.0'`。
--     - `checkup_values` 列: 受領 `health_checkup.json` の受け皿として作ったが、
--       **読み書きするコードが無い** (取り込み API は PDF のみ・表示側は select しない)。
--
-- 【なぜ列を drop しないか】受け皿は作り直しでも要る (spec §8.2)。
--   受領は 1 件 = 3 ファイルで、本文 (`report`) と検査値 (`health_checkup.json`) は
--   **包含関係でない** (本文が最優先扱いするヘマトクリットが検査値側に無い、という実測)。
--   片方から他方を導けないので、そのまま 2 つ持つ設計は変わらない。
--   空の列を残すコストより、drop → 再 add の往復のほうが高い。

comment on column diagnosis.diagnosis_results.checkup_values is
  'Elith 受領 health_checkup.json の受け皿。形は { "項目名 [単位]": [{date, value}] }。'
  ' 基準値・判定は含まれない (受領データに無い)。'
  ' 当社スキャン由来の diagnosis.measurement_values とは出どころが違うので混ぜない。'
  ' 【2026-08-29 現在】AI疾病予防報告書の実装をリバートしたため読み書きするコードが無く、'
  ' 常に null。作り直し時に取り込み API と表示側を結線する'
  ' (docs/elith/ai_prevention_report_generation_spec.md §8.2)。';

comment on column diagnosis.diagnosis_results.report is
  'Elith 受領の報告書本文。schema_version=elith-v1.0 は旧セクション配列。'
  ' 【2026-08-29 現在】これが唯一の形式。dict 形式 (elith-v2.0) を書く実装は'
  ' リバートしたため存在しない。作り直しで新形式を入れるときに schema_version を bump する。';
