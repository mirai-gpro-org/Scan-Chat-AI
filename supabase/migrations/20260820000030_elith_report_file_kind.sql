-- Elith AI 診断結果レポート (PDF) の受け皿 (パイプライン ⑥)。
--
-- 根拠: docs/lab/lab_data_pipeline_master_spec.md:24,96
--   「⑥ElithのAI診断結果(PDF)をS3から受取→Webアプリへ表示UP」
--   「フォーマット＝PDF。サンプルデータで表示実装テスト済。」
--
-- ①〜⑤ が上り (Wellfort→各社/Elith)、⑥ は下り (Elith→Wellfort→ユーザー) で
-- 別 S3 経路・別仕様 (同 :100)。検査機関の原本 (raw_pdf) と混同しないよう
-- 専用の種別を設ける。
--
-- 受取仕様 (命名規則・出力トリガ・世代管理・ひも付け・受領確認) は未確定 (同 :98)。
-- 本マイグレーションは**受け皿のみ**で、取り込み処理は仕様確定後に実装する。

alter table diagnosis.test_artifact_files
  drop constraint if exists test_artifact_files_file_kind_check;

alter table diagnosis.test_artifact_files
  add constraint test_artifact_files_file_kind_check
  check (file_kind in (
    'scan_md',
    'summary_md',
    'highlights_md',
    'raw_pdf',           -- 検査機関の原本 PDF (PII 除去なし)
    'raw_pdf_redacted',  -- 検査機関の原本 PDF (PII 除去済み)
    'raw_csv',
    'extracted_json',
    'elith_report_pdf'   -- Elith の AI 診断結果レポート (⑥ 下り)
  ));

comment on column diagnosis.test_artifact_files.file_kind is
  'ファイル種別。raw_pdf/raw_pdf_redacted=検査機関の原本 (redaction の有無を実態と一致させる)。'
  ' elith_report_pdf=Elith の AI 診断結果レポート (パイプライン⑥・下り)。';
