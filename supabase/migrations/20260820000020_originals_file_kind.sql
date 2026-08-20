-- 原本ファイル種別の是正 (STEP 5 / 案C′)。
--
-- 背景: test_artifact_files.file_kind の許可値に 'raw_pdf' が無く、
--   redaction 未実装のまま `raw_pdf_redacted` を名乗るしかない状態だった
--   (src/pages/api/admin/lab-results/upload.ts。src/ 全走査で redaction 処理なし)。
--   実態と名前が食い違うと、後から「これは PII 除去済みか」を判定できなくなる。
--
-- 方針: 'raw_pdf' (未 redaction の原本) を許可値に追加する。
--   'raw_pdf_redacted' は残す — PII 除去を実装したときの正しい種別として使う。
--   取込側は redaction を通した場合のみ 'raw_pdf_redacted' を書く。

alter table diagnosis.test_artifact_files
  drop constraint if exists test_artifact_files_file_kind_check;

alter table diagnosis.test_artifact_files
  add constraint test_artifact_files_file_kind_check
  check (file_kind in (
    'scan_md',
    'summary_md',
    'highlights_md',
    'raw_pdf',           -- 原本 PDF (PII 除去なし)
    'raw_pdf_redacted',  -- 原本 PDF (PII 除去済み)
    'raw_csv',
    'extracted_json'
  ));

comment on column diagnosis.test_artifact_files.file_kind is
  'ファイル種別。raw_pdf = 未 redaction / raw_pdf_redacted = PII 除去済み。実態と一致させること。';

comment on column diagnosis.test_artifact_files.storage_url is
  '保存先。s3://bucket/key なら S3、それ以外は Supabase Storage 内のパス。';
