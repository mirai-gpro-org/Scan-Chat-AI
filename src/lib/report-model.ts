/**
 * AI疾病予防報告書の **表示モデル (ViewModel)**。
 *
 * 正本: `docs/elith/ai_prevention_report_generation_spec.md` §1.3.3 / §4。
 *
 * 【なぜ型を先に置くか (P0)】
 *   `受領JSON → 表示モデル → レンダラ` の 3 層にし、層をまたいだ直参照を作らないため
 *   (spec §1.3.3)。Elith の出力形式は **既に 1 度変わっている** —
 *   Stage2 → Stage3 で `（判定区分：X）` と `[pN]` が消え、
 *   `elith-report-highlights.ts` が**無言で空になる**状態になった (spec §5.2)。
 *   次も変わる前提で、**形式変更はアダプタ 1 枚で吸収する**。
 *   画面 (`report.astro`) と印刷ビュー (`?print=1`) はこの型しか知らない。
 *
 * 【この層がしないこと】
 *   要約・言い換え・並べ替え・良否の判定 (ミッション④)。
 *   `body` に入るのは **Elith の原文 Markdown そのまま**で、
 *   組版 (段落化・主題強調・h4 化) は描画時に `report-view.ts` が行う。
 */

import type { ChapterKey } from './report-sections';

/** 受領 `report_text.json` の 1 セクション (新形式・spec §2.1)。 */
export interface ReportSectionRaw {
  section_name: string;
  /** 受領 JSON のキー名。実測では `actual_chars`。 */
  actual_chars?: number;
  text: string;
}

/** 受領 `health_checkup.json` の 1 項目 (spec §2.2)。基準値・判定は持たない。 */
export interface CheckupPoint {
  date: string;
  value: number | string;
}

/**
 * 章の材料 (どの受領キーから作るか)。
 * 受領 JSON のキーと 1:1 ではない — `diet_plan` は `diet` の一部、
 * `measurements` は `health_checkup.json` ＋ `blood_analysis` の散文から組む。
 */
export type ChapterSource =
  | 'abstract'
  | 'summary'
  | 'blood_analysis'
  | 'diet'
  | 'exercise'
  | 'sleep'
  | 'lifestyle'
  | 'medical_visit'
  | 'nutrients'
  | 'references'
  /** A の章。Elith にフィールドの新設を依頼中 (spec §4.0.1)。無ければ章ごと非表示。 */
  | 'cancer_finding'
  /** `diet` の「1 か月の食事改善プラン」だけを前に出す (spec §4.1 の 7.5)。 */
  | 'diet_plan'
  /** 検査値テーブル。値=health_checkup / 基準値=blood_analysis 本文の 8 件のみ。 */
  | 'measurements';

/** サービスの 2 本柱 (spec §1.0)。章がどちらに属するか。 */
export type ReportAxis = 'A' | 'B';

/**
 * 章内のトピック (spec §5.4)。
 * `### N. 見出し` / `【項目】` から決定論で作る。**LLM は使わない** (spec §5.5)。
 */
export interface TopicVM {
  /** 同一 HTML 内アンカー。`章key + 見出しのハッシュ` で決定論生成する
   *  (連番にすると章を並べ替えたときにリンクが壊れる・spec §5.4)。 */
  id: string;
  /** 見出し (原文のまま)。 */
  heading: string;
  /** 冒頭 1 文 (原文のまま)。要約ではない。 */
  teaser: string;
}

/**
 * 検査値 1 行 (spec §5.3)。
 * **アプリは値と基準値を比べない。** `judgement` は Elith が本文に書いた判定文のみ。
 */
export interface MeasurementVM {
  /** 項目名 (受領キーから単位を除いたもの)。 */
  name: string;
  /** 単位。受領キーの `[...]` 部分。無ければ null。 */
  unit: string | null;
  value: string;
  /** `blood_analysis` の散文から拾えた基準値のみ。無ければ null (外部マスタで補完しない)。 */
  reference: string | null;
  /** Elith 自身の判定文 (例「基準範囲を上回っています」)。当社が作った語は入れない。 */
  judgement: string | null;
  date: string | null;
}

/** 生活習慣の 1 項目 (spec §4.2.2)。維持/改善の自動分類はしない。 */
export interface LifestylePairVM {
  /** 見出し (飲酒 / 喫煙 / 仕事中の過ごし方 …)。 */
  topic: string;
  /** 【現状評価】の本文 (原文)。 */
  current: string;
  /** 【行動提案】の本文 (原文)。 */
  proposal: string;
}

/**
 * 章 1 つ分。
 * `body` / `topics` / `measurements` / `pairs` のうち、その章が持つものだけが埋まる。
 */
export interface ChapterVM {
  key: ChapterKey;
  /** 表示名。レジストリのコード既定を `app_config` が上書きし得る。 */
  title: string;
  axis: ReportAxis;
  source: ChapterSource;
  /** 本文 Markdown (Elith の原文のまま)。 */
  body: string;
  topics: TopicVM[];
  /** `measurements` 章のみ。 */
  measurements: MeasurementVM[];
  /** `lifestyle` 章のみ。 */
  pairs: LifestylePairVM[];
  /** 既定で畳むか。**`?print=1` では常に false** (畳んだ状態が紙面に漏れると本文が欠ける・spec §3.2)。 */
  collapsed: boolean;
  /** 同一 HTML 内アンカー。 */
  anchor: string;
}

/** 検査サイクル (spec §4.0.0.2)。出どころは `customer.subscriptions`。 */
export interface CycleVM {
  /** 第 N 回。 */
  seq: number;
  /** 全 N 回 (最上位プランは 4)。 */
  total: number;
  /** 次回予定日 (`next_test_at`)。無ければ null。 */
  nextAt: string | null;
}

/** 表紙 (spec §4.0.0)。 */
export interface CoverVM {
  /** 氏名。**本人への表示なので出す** (spec §4.0.0.1)。取得できなければ null。 */
  name: string | null;
  /** 報告書の作成日 (受領日)。 */
  issuedOn: string;
  /** 紙面テンプレートの版。端末に保存された控えの識別に要る (spec §1.3.9 / §3.6)。 */
  templateVersion: string;
  /** ウェルネス年齢。**Elith 出力の値のみ**・併記しない (spec §1.3.8)。無ければ null。 */
  wellnessAge: number | null;
  /** 実年齢。数直線での比較用。無ければ null。 */
  actualAge: number | null;
  /** アブストラクト本文 (原文)。 */
  abstract: string;
  /** **タイプ 2 (単品購入) では null** — `subscriptions` 行が無い (spec §4.0.0.2)。 */
  cycle: CycleVM | null;
}

/**
 * 報告書のタイプ (spec §1.0.3)。
 * **アプリが持つ** (その回の入力にがんリスク検査があったか)。Elith 出力から推測しない。
 */
export type ReportType = 'course' | 'single';

/**
 * 抽出監査 (spec §1.3.6)。
 * fail-safe な抽出は**黙って空になる**ので、何を認識し何を落としたかを admin に出す。
 * **表示データには混ぜない** (スキャン側 `vqa_audit` と同じ流儀)。
 */
export interface ReportAudit {
  /** 受領 JSON で認識できた `section_name` の一覧。 */
  recognizedSections: string[];
  /** レジストリにあるが**材料が無くて出さなかった**章。空カードを出さないための記録。 */
  skippedChapters: ChapterKey[];
  /** `app_config` で非表示にされた章。 */
  hiddenChapters: ChapterKey[];
  topicCount: number;
  measurementCount: number;
  /** 基準値を拾えた項目数 (spec §5.3 では実測 8 件)。 */
  referenceCount: number;
  /**
   * 気づきたい異常。
   * 例: ウェルネス年齢が当社 CABA と一致しない (本来必ず一致する・spec §1.3.8)、
   *     同名別値 (自動採用しない・spec §7.1)。
   */
  anomalies: string[];
}

/** 画面と `?print=1` が共有する、報告書 1 部の表示モデル。 */
export interface ReportVM {
  type: ReportType;
  cover: CoverVM;
  chapters: ChapterVM[];
  audit: ReportAudit;
  /** true = Elith 提供サンプルを表示している (実データ未受領)。 */
  isSample: boolean;
}
