-- AI疾病予防報告書: 受領 `health_checkup.json` の受け皿。
--
-- 正本: docs/elith/ai_prevention_report_generation_spec.md §8.2
--
-- 【背景】受領は 1 件 = 3 ファイル (§2)。
--   report_text.json    → diagnosis_results.report          (既存)
--   health_checkup.json → diagnosis_results.checkup_values  (★ この列を追加)
--   組版済み PDF        → diagnosis_results.report_pdf_*    (既存・原本として保管)
--
-- 【なぜ別列か】`report` は本文 (10 セクションの散文)、`checkup_values` は検査値 (40 項目) で
--   別のファイル・別の構造。混ぜると表示側で「どちらの形式か」を推測することになる。
--   2 ファイルは**包含関係でない** — 本文が参照するヘマトクリットが検査値側に無い、
--   という実測がある (§7.2)。片方から他方を導けないので、そのまま 2 つ持つ。
--
-- 【なぜ measurement_values に入れないか】あちらは**当社がスキャンで読み取った検査値**
--   (原本忠実の記録・時系列グラフ用) で、こちらは **Elith が診断に使った値の控え**。
--   出どころが違うものを同じ表に混ぜると、どちらの値をユーザーに見せているか分からなくなる。
--
-- 【schema_version】新形式 (dict) を入れたら取り込み API が 'elith-v2.0' を書く。
--   既存行は 'elith-v1.0' のまま = 旧形式 (配列) と読み分けられる。

alter table diagnosis.diagnosis_results
  add column if not exists checkup_values jsonb;

comment on column diagnosis.diagnosis_results.checkup_values is
  'Elith 受領 health_checkup.json をそのまま格納する。形は { "項目名 [単位]": [{date, value}] }。'
  ' 基準値・判定は含まれない (受領データに無い)。基準値は report 本文の散文から拾える分だけ。'
  ' 当社スキャン由来の diagnosis.measurement_values とは出どころが違うので混ぜない。';

comment on column diagnosis.diagnosis_results.report is
  'Elith 受領 report_text.json。schema_version=elith-v2.0 は dict 形式'
  ' ({ health_age, <key>: { section_name, actual_chars, text } })、elith-v1.0 は旧セクション配列。';
