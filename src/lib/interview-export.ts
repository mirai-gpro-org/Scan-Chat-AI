/**
 * AI 問診結果 → Elith 連携用エクスポート (暫定 interview-export-v0)
 *
 * スキャン (scan-export) と同じ要領で、確定した問診回答を構造化 JSON へ変換し、
 * 読みやすい Markdown と共に S3 へ書き出す。スキャンと同じ `{diagnostic_id}/`
 * フォルダに同居させる想定 (docs/diagnostic_session_data_spec.md §3.5)。
 *
 * 氏名・生年月日・性別は問診で尋ねず、顧客DBから内部取得した値 (user.*) を付与する。
 * ファイル名/フォーマットは暫定。
 *
 * 本モジュールは DOM/AWS に依存しない (サーバ側で実行)。
 */

import {
  QUESTIONS,
  ORDER,
  formatAnswerLabel,
  type AnswerValue,
} from '../scripts/chat/interview-script';
import { compactJstStamp } from './scan-export';
import type { S3PutFile } from './s3';

export const INTERVIEW_EXPORT_SCHEMA_VERSION = 'interview-export-v0';

export interface InterviewExportInput {
  diagnosticId: string;
  diagnosticUserId?: string | null;
  /** 内部取得のユーザー名 (customer.family_name) */
  userName?: string | null;
  /** 内部取得の生年月日 (customer.date_of_birth) */
  dateOfBirth?: string | null;
  /** 内部取得の生物学的性別 (customer.sex) */
  sex?: string | null;
  /** 設問 id → 回答値 */
  answers: Record<string, AnswerValue>;
  /** 完了時刻 (epoch ms) */
  completedAt?: number;
  exportedAt?: Date;
}

export interface InterviewAnswerJson {
  id: string;
  section_id: string | null;
  section_title: string | null;
  question: string | null;
  answer_kind: string | null;
  /** 生の回答値 (string | string[] | number) */
  answer: AnswerValue;
  /** 表示用ラベル */
  answer_label: string;
}

export interface InterviewExportJson {
  schema_version: typeof INTERVIEW_EXPORT_SCHEMA_VERSION;
  kind: 'interview_result';
  diagnostic_id: string;
  diagnostic_user_id: string | null;
  user: { name: string | null; date_of_birth: string | null; sex: string | null };
  completed_at: string | null;
  exported_at: string;
  answer_count: number;
  answers: InterviewAnswerJson[];
  note: string;
}

export interface InterviewExportBundle {
  diagnosticId: string;
  folder: string;
  timestamp: string;
  files: S3PutFile[];
  json: InterviewExportJson;
}

/** answers を設問定義の順 (ORDER) に並べ、表示ラベルを付けて構造化する */
function buildAnswers(answers: Record<string, AnswerValue>): InterviewAnswerJson[] {
  const answeredIds = new Set(Object.keys(answers));
  // ORDER に載っている設問を順番に、その後に ORDER 外 (予期せぬ id) を続ける
  const ordered = [
    ...ORDER.filter((id) => answeredIds.has(id)),
    ...Object.keys(answers).filter((id) => !ORDER.includes(id)),
  ];
  return ordered.map((id) => {
    const q = QUESTIONS[id];
    const value = answers[id];
    return {
      id,
      section_id: q?.section_id ?? null,
      section_title: q?.section_title ?? null,
      question: q?.question ?? null,
      answer_kind: q?.answer_kind ?? null,
      answer: value,
      answer_label: q ? formatAnswerLabel(q, value) : String(value),
    };
  });
}

export function buildInterviewJson(input: InterviewExportInput): InterviewExportJson {
  const exportedAt = input.exportedAt ?? new Date();
  const answers = buildAnswers(input.answers);
  return {
    schema_version: INTERVIEW_EXPORT_SCHEMA_VERSION,
    kind: 'interview_result',
    diagnostic_id: input.diagnosticId,
    diagnostic_user_id: input.diagnosticUserId ?? null,
    user: {
      name: input.userName ?? null,
      date_of_birth: input.dateOfBirth ?? null,
      sex: input.sex ?? null,
    },
    completed_at: input.completedAt ? new Date(input.completedAt).toISOString() : null,
    exported_at: exportedAt.toISOString(),
    answer_count: answers.length,
    answers,
    note: 'AI問診結果テスト用。命名・フォーマットは暫定。',
  };
}

/** 人が読める Markdown 版 (セクションごとに Q/A を列挙) */
export function buildInterviewMarkdown(json: InterviewExportJson): string {
  const out: string[] = ['# AI 問診結果'];
  const u = json.user;
  if (u.name || u.date_of_birth || u.sex) {
    const bits = [u.name, u.date_of_birth, u.sex].filter(Boolean).join(' / ');
    out.push(`\n対象: ${bits}`);
  }
  if (json.completed_at) out.push(`完了: ${json.completed_at}`);

  let currentSection: string | null = null;
  for (const a of json.answers) {
    if (a.section_title && a.section_title !== currentSection) {
      currentSection = a.section_title;
      out.push(`\n## ${currentSection}`);
    }
    out.push(`- **${a.question ?? a.id}**`);
    out.push(`  - ${a.answer_label}`);
  }
  return out.join('\n') + '\n';
}

function utf8Bytes(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return Buffer.byteLength(s, 'utf-8');
}

/**
 * interview-{ts}.json + interview-{ts}.md を生成する。
 * スキャンと同じ `{diagnostic_id}/` フォルダに置く (manifest はスキャン側と衝突するため出さない)。
 * @param prefix バケット内共通プレフィックス (例 "scan-accuracy-test/")。空可。
 */
export function buildInterviewExportBundle(
  input: InterviewExportInput,
  prefix = '',
): InterviewExportBundle {
  const json = buildInterviewJson(input);
  const stamp = compactJstStamp(input.exportedAt ?? new Date());
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${cleanPrefix}${input.diagnosticId}/`;

  const jsonName = `interview-${stamp}.json`;
  const mdName = `interview-${stamp}.md`;
  const jsonBody = JSON.stringify(json, null, 2);
  const mdBody = buildInterviewMarkdown(json);

  const mk = (name: string, contentType: string, body: string): S3PutFile => ({
    key: `${folder}${name}`,
    contentType,
    body,
    bytes: utf8Bytes(body),
  });

  return {
    diagnosticId: input.diagnosticId,
    folder,
    timestamp: stamp,
    json,
    files: [
      mk(jsonName, 'application/json; charset=utf-8', jsonBody),
      mk(mdName, 'text/markdown; charset=utf-8', mdBody),
    ],
  };
}
