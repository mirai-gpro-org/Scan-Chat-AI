/**
 * AI疾病予防報告書の **章レジストリ**。
 *
 * 正本: `docs/elith/ai_prevention_report_generation_spec.md` §1.3.2 / §4.1。
 *
 * 【なぜレジストリにするか】この報告書は本アプリの肝で、改善要望が絶えず出る前提で作る
 *   (spec §1.3)。章を 1 つ増やす・順序を変える・見出しを直す、を**コード変更なし**で
 *   できるようにしておかないと要望が滞留する。
 *   → 章の **順序 / 表示可否 / 見出し文言 / 既定の開閉** は `diagnosis.app_config` で上書きし、
 *     完全なレジストリはここ (コード既定) に置く。優先順位は既存の流儀どおり
 *     **DB値 → コード既定** (`app-config.ts`)。
 *
 * 【なぜ 4 本の文字列キーか】`ConfigType` は `'bool' | 'enum' | 'string'` の 3 種しかなく
 *   (`app-config.ts:15`)、admin UI は wellfort-site 側にある (CLAUDE.md 確定事項)。
 *   章ごとにキーを生やすと admin の画面がキーで埋まり、章を足すたびに
 *   `CONFIG_SPECS` へ 4 行追加することになる。
 *   → **カタログを増やさずに済む「一覧を 1 本の文字列で渡す」形**にした。
 *     既定は空・空ならコード既定、という `ui.support_contact` と同じ流儀 (spec §1.3.2)。
 *
 * 【表紙はレジストリに入れない】表紙は章ではなく、並べ替えも非表示もしない
 *   (`CoverVM`・spec §4.0.0)。ここが持つのは本文の章だけ。
 */

import { cfg } from './app-config';
import type { ChapterSource, ReportAxis } from './report-model';

/**
 * **サービスの 2 本柱** (spec §1.0 / 設計ポリシー)。
 *
 * 【これは章ではなく報告書の骨格】表紙と同じ理由でレジストリに入れない。
 *   **並べ替えも非表示もしない。** 設計ポリシーで
 *   「報告書の冒頭には、サービスの 2 本柱をそのままトピックとして置く」
 *   「章の並び・見出しも、この 2 本柱に沿えて構成する」と決めており、
 *   これは個々の章の出し分けより**上位の決定**だから。
 *
 * 【実装事故の記録 (2026-08-29)】当初これを描かず、`axis` を配列を分けるための
 *   変数にしか使っていなかった。結果、A に材料が無い検体 (タイプ 2) では
 *   「材料が無い章は出さない」が働いて **A 軸の痕跡がゼロ**になり、
 *   報告書が B からいきなり始まっていた。**枠(軸)と中身(章)を分けること。**
 *   枠は常設、中身だけが条件付き。
 */
export const REPORT_AXES = [
  {
    key: 'A' as const,
    title: '初期がんの早期発見',
    lead: '年 1 回の人間ドックの隙間を年 3 回の検査で埋め、年 4 回で早期発見につなげます。',
  },
  {
    key: 'B' as const,
    title: 'AI 診断による疾病予防アドバイス',
    lead: 'その年 4 回の検査データで AI 診断を回し、健康・生活改善につなげます。',
  },
] as const;

export type ChapterKey =
  | 'cancer_finding'
  | 'medical_visit'
  | 'measurements'
  | 'summary'
  | 'diet'
  | 'exercise'
  | 'sleep'
  | 'lifestyle'
  | 'diet_plan'
  | 'nutrients'
  | 'references';

export interface ChapterSpec {
  key: ChapterKey;
  /** 見出し。`report.sections.labels` で上書きできる。 */
  title: string;
  /** どの受領キーから作るか。 */
  source: ChapterSource;
  /** サービスの 2 本柱のどちら (spec §1.0)。A → B の順に構成する。 */
  axis: ReportAxis;
  /** 既定で畳むか。spec §4.3「既定は開く」に合わせ全章 false。 */
  collapsed: boolean;
}

/**
 * コード既定のレジストリ (spec §4.1 の表)。
 *
 * 並びの要点:
 *   - **A (がん早期発見) を先頭**に置く (spec §4)。
 *   - **`medical_visit` を B の先頭**に置く。受領 PDF ではこれが 6 章目に埋もれており、
 *     「最優先の所見」が最後まで読まないと出てこない (spec §4.1)。
 */
export const CHAPTER_REGISTRY: readonly ChapterSpec[] = [
  { key: 'cancer_finding', title: '初期がんの早期発見',   source: 'cancer_finding', axis: 'A', collapsed: false },
  { key: 'medical_visit',  title: 'いちばん大事なこと',   source: 'medical_visit',  axis: 'B', collapsed: false },
  { key: 'measurements',   title: '検査値でみておくこと', source: 'measurements',   axis: 'B', collapsed: false },
  { key: 'summary',        title: '総評',                 source: 'summary',        axis: 'B', collapsed: false },
  { key: 'diet',           title: '食事',                 source: 'diet',           axis: 'B', collapsed: false },
  { key: 'exercise',       title: '運動',                 source: 'exercise',       axis: 'B', collapsed: false },
  { key: 'sleep',          title: '睡眠・ストレス',       source: 'sleep',          axis: 'B', collapsed: false },
  { key: 'lifestyle',      title: '生活習慣',             source: 'lifestyle',      axis: 'B', collapsed: false },
  { key: 'diet_plan',      title: '1 か月の食事プラン',   source: 'diet_plan',      axis: 'B', collapsed: false },
  { key: 'nutrients',      title: '栄養素・サプリ',       source: 'nutrients',      axis: 'B', collapsed: false },
  { key: 'references',     title: '出典',                 source: 'references',     axis: 'B', collapsed: false },
];

const KEYS = new Set<string>(CHAPTER_REGISTRY.map((c) => c.key));

function isChapterKey(v: string): v is ChapterKey {
  return KEYS.has(v);
}

/** `a, b , c` → `['a','b','c']`。空要素と重複は落とす。 */
function splitList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** `key=表示名, key=表示名` → Map。`=` を含まない要素と未知キーは無視する。 */
function parsePairs(raw: string): Map<ChapterKey, string> {
  const out = new Map<ChapterKey, string>();
  for (const item of splitList(raw)) {
    const at = item.indexOf('=');
    if (at <= 0) continue;
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (!value || !isChapterKey(key)) continue;
    out.set(key, value);
  }
  return out;
}

/** 未知キーだけを取り出す (監査用。設定の打ち間違いを黙って飲み込まないため)。 */
function unknownKeys(raw: string): string[] {
  return splitList(raw).map((s) => s.split('=')[0].trim()).filter((k) => k && !isChapterKey(k));
}

export interface ResolvedChapters {
  chapters: ChapterSpec[];
  /** `report.sections.hidden` で落とした章。監査に出す (spec §1.3.6)。 */
  hidden: ChapterKey[];
  /** 設定に書かれていたが解釈できなかったキー。打ち間違いの検知用。 */
  unknown: string[];
}

/**
 * `app_config` を重ねた章立てを返す。
 *
 * 呼ぶ前に `refreshConfig()` を済ませておくこと (未実行でもコード既定＝本番挙動)。
 *
 * - `report.sections.order`     … 並び。**書いた章だけを、書いた順で出す**
 *                                 (＝ここに列挙しなかった章は出ない)。空ならコード既定の全章。
 * - `report.sections.hidden`    … 非表示にする章。`order` より後に効く。
 * - `report.sections.labels`    … `key=表示名` で見出しを差し替える。
 * - `report.sections.collapsed` … 既定で畳む章。
 *
 * **未知キーは無視する** — 設定の打ち間違いで画面が真っ白にならないようにする
 * (代わりに `unknown` へ入れて監査に出す)。
 *
 * @param read 設定の読み取り。既定は `app-config` の `cfg`。
 *   テスト (spec §1.3.7 のスナップショット回帰) から任意の設定を差し込めるようにしてある。
 */
export function resolveChapters(read: (key: string) => string = cfg): ResolvedChapters {
  const orderRaw = read('report.sections.order');
  const hiddenRaw = read('report.sections.hidden');
  const labelsRaw = read('report.sections.labels');
  const collapsedRaw = read('report.sections.collapsed');

  const byKey = new Map<ChapterKey, ChapterSpec>(CHAPTER_REGISTRY.map((c) => [c.key, c]));

  // 並び: 設定があればそれを正とする。
  // **「空」の判定は生文字列でなく "解釈できた章が 1 つでもあるか" で行う** —
  // `' , , '` や未知キーだけの指定を「設定あり」と見なすと章が 0 件になり、
  // 打ち間違い 1 つで報告書が真っ白になる (実測でこの分岐を踏んだ)。
  const requested = splitList(orderRaw).filter(isChapterKey);
  const ordered: ChapterSpec[] = requested.length > 0
    ? requested.map((k) => byKey.get(k)!)
    : CHAPTER_REGISTRY.slice();

  const hiddenSet = new Set(splitList(hiddenRaw).filter(isChapterKey));
  const labels = parsePairs(labelsRaw);
  const collapsedSet = new Set(splitList(collapsedRaw).filter(isChapterKey));

  const chapters = ordered
    .filter((c) => !hiddenSet.has(c.key))
    .map((c) => ({
      ...c,
      title: labels.get(c.key) ?? c.title,
      collapsed: collapsedSet.has(c.key) ? true : c.collapsed,
    }));

  return {
    chapters,
    hidden: [...hiddenSet],
    unknown: [
      ...unknownKeys(orderRaw),
      ...unknownKeys(hiddenRaw),
      ...unknownKeys(labelsRaw),
      ...unknownKeys(collapsedRaw),
    ].filter((v, i, a) => a.indexOf(v) === i),
  };
}

/**
 * 決定論のアンカー ID。
 *
 * 章を並べ替えてもリンクが壊れないよう、**連番を使わず見出し文字列から作る**
 * (spec §5.4)。同じ見出しなら常に同じ ID になる。
 */
export function anchorFor(key: string, heading = ''): string {
  if (!heading) return `sec-${key}`;
  // FNV-1a 32bit。暗号用途ではない (同一性の安定だけが目的)。
  let h = 0x811c9dc5;
  for (let i = 0; i < heading.length; i++) {
    h ^= heading.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `sec-${key}-${h.toString(36)}`;
}
