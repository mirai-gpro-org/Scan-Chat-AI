/**
 * AI疾病予防報告書の **アダプタ** — 受領 JSON → 表示モデル (`ReportVM`)。
 *
 * 正本: `docs/elith/ai_prevention_report_generation_spec.md` §5 / §1.3.3 / §1.3.4。
 *
 * 【この 1 モジュールが変換規則を所有する】`.astro` に正規表現を散らさない (spec §1.3.4)。
 *   本リポジトリの前例は `elith-export.ts` の `sanitizeMeasurementsForDelivery()` —
 *   「納品整形は 1 箇所に集約し二重管理しない」と CLAUDE.md に明記されている。同じ扱いにする。
 *
 * 【すべて決定論。LLM を通さない】(spec §5.5)
 *   ここでやるのは **切り出しと構造化だけ**。要約・言い換え・並べ替え・良否の判定はしない
 *   (ミッション④)。本文は Elith の原文 Markdown がそのまま `body` に入り、
 *   組版 (段落化・主題強調・h4 化) は描画時に `report-view.ts` が行う。
 *
 * 【並べ替えをしない】検査値の所見は **Elith が書いた順のまま**返す。
 *   旧 `elith-report-highlights.ts` は判定区分のラダーで並べ替えていたが、
 *   どれが重いかを当社が決めることになる。最優先は Elith 自身が
 *   「医療受診の目安 §1 最優先の所見」に書いているので、そちらを使う (spec §4.2.1)。
 */

import { anchorFor, resolveChapters, type ChapterKey, type ChapterSpec } from './report-sections';
import type {
  ChapterVM, CoverVM, CycleVM, LifestylePairVM, MeasurementVM,
  ReportAudit, ReportSectionRaw, ReportType, ReportVM, TopicVM,
} from './report-model';

/** 紙面テンプレートの版。紙面を変えたら上げ、紙面に印字する (spec §1.3.9)。 */
export const REPORT_TEMPLATE_VERSION = 'v1.0';

// ───────────────────────────────────────────────────────────────
// 受領ファイルのパース (spec §2.1 / §2.2)
// ───────────────────────────────────────────────────────────────

export interface ParsedReportText {
  /** 受領キー → セクション。 */
  byKey: Map<string, ReportSectionRaw>;
  /** ウェルネス年齢。受領キーは `health_age` (内部識別子なので据え置き・spec §1.3.8)。 */
  healthAge: number | null;
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * `report_text.json` (新形式 dict) を読む。
 *
 * 旧形式 (`ElithSection[]` の配列) で渡されたときも読めるようにしてある —
 * `elith-report-sample.ts` の Stage2 サンプルが配列で、実データ受領までは
 * こちらが表示される (`elith-report-queries.ts` のフォールバック)。
 */
export function parseReportText(raw: unknown): ParsedReportText {
  const byKey = new Map<string, ReportSectionRaw>();
  let healthAge: number | null = null;

  if (Array.isArray(raw)) {
    // 旧形式: [{ section_name, char_count, text }, …]。キーが無いので section_name を鍵にする。
    for (const s of raw as Array<Record<string, unknown>>) {
      const name = asText(s?.section_name);
      if (!name) continue;
      byKey.set(name, { section_name: name, text: asText(s?.text) });
    }
    return { byKey, healthAge };
  }

  if (!raw || typeof raw !== 'object') return { byKey, healthAge };

  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'health_age') {
      const n = Number(v);
      if (Number.isFinite(n)) healthAge = n;
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const text = asText(o.text);
    if (!text) continue;
    byKey.set(key, {
      section_name: asText(o.section_name) || key,
      actual_chars: typeof o.actual_chars === 'number' ? o.actual_chars : undefined,
      text,
    });
  }
  return { byKey, healthAge };
}

/** 受領キー `項目名 [単位]` を名前と単位に割る。 */
function splitUnit(key: string): { name: string; unit: string | null } {
  const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(key);
  return m ? { name: m[1].trim(), unit: m[2].trim() || null } : { name: key.trim(), unit: null };
}

/**
 * `health_checkup.json` を読む (spec §2.2)。
 * **基準値・判定は入っていない**ので、ここでは値と日付だけを持つ。
 */
export function parseCheckup(raw: unknown): MeasurementVM[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: MeasurementVM[] = [];
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    // 日付が複数ある形式に備えて最新を採る。実測では 1 件のみ (時系列にならない)。
    const points = (v as Array<Record<string, unknown>>)
      .filter((p) => p && (typeof p.value === 'number' || typeof p.value === 'string'))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
    const last = points[points.length - 1];
    if (!last) continue;
    const { name, unit } = splitUnit(key);
    out.push({
      name, unit,
      value: String(last.value),
      reference: null,
      judgement: null,
      date: typeof last.date === 'string' ? last.date : null,
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
// 章内の切り出し
// ───────────────────────────────────────────────────────────────

const HEADING_RE = /^###\s*(.+?)\s*$/;
/**
 * `【項目】` 見出し。**行頭にあれば見出しとして扱い、同じ行の続きは本文**にする。
 * 新形式は `【項目】` が単独行だが、Stage2 サンプルは PDF 抽出のため
 * `【体格・腹囲】体重は 95.8 kg…` と本文が地続きになっている。両方読めないと
 * サンプル表示が無言で空になる (実測)。
 */
const BLOCK_RE = /^【([^】]+)】\s*(.*)$/;
/** `【現状評価】` のように、行がその小見出しだけでできているか。 */
const BLOCK_ONLY_RE = /^【[^】]+】\s*$/;
/** 旧形式の先頭ページマーカー `[p4]`。新形式には無い (spec §5.1)。 */
const PAGE_MARK_RE = /^\s*\[p\d+\]\s*/;

interface Block { heading: string; body: string }

/**
 * 章本文を見出し単位に割る。`### 見出し` と `【項目】` の両方を見出しとして扱う。
 * 見出しより前の文 (章の導入文) は `heading: ''` のブロックになる。
 */
function splitBlocks(text: string, mode: 'both' | 'hash' = 'both'): Block[] {
  const out: Block[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = (): void => {
    const body = buf.join('\n').trim();
    if (heading || body) out.push({ heading, body });
    buf = [];
  };
  for (const raw of text.split('\n')) {
    // 旧形式は `[p4] 【体格・腹囲】…` と、見出しの前にページマーカーが付く。
    // 剥がしてから見出し判定する (剥がさないと最初のブロックを取りこぼす)。
    const line = raw.replace(PAGE_MARK_RE, '');
    const hh = HEADING_RE.exec(line);
    if (hh) { flush(); heading = hh[1].trim(); continue; }
    const hb = mode === 'both' ? BLOCK_RE.exec(line) : null;
    if (hb) {
      flush();
      heading = hb[1].trim();
      if (hb[2].trim()) buf.push(hb[2]); // 同じ行の続きは本文
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** その本文が `### 見出し` を持っているか。 */
function hasHashHeading(text: string): boolean {
  return text.split('\n').some((l) => HEADING_RE.test(l));
}

/**
 * 冒頭 1 文を原文のまま返す (要約ではない)。
 * 先頭の Markdown 構造行 (`## 一覧` のような見出し) は本文ではないので飛ばす。
 */
function firstSentence(body: string): string {
  const lines = body.split('\n').map((l) => l.trim());
  // 見出し・箇条書き・表・引用、および `【現状評価】` のような小見出しだけの行は本文でない
  const start = lines.findIndex((l) => l && !/^(#{1,6}\s|[-*+]\s|\||>)/.test(l) && !BLOCK_ONLY_RE.test(l));
  if (start < 0) return '';
  const flat = lines.slice(start).join('').trim();
  if (!flat) return '';
  const i = flat.indexOf('。');
  return i >= 0 ? flat.slice(0, i + 1) : flat;
}

/**
 * トピック一覧 (spec §5.4)。**見出し + 冒頭 1 文 (原文) + アンカー**。
 *
 * 見出しを持たない章 (アブストラクト / リファレンス) は、
 * **Elith が付けた `section_name` を見出しとして** 章まるごと 1 トピックにする
 * (当社が見出しを創作しない)。
 */
export function extractTopics(key: ChapterKey, section: ReportSectionRaw): TopicVM[] {
  // **`###` があればそれだけを見出しとする。** `【】` は章の中の小分け
  // (食事の食材カテゴリ・生活習慣の【現状評価】/【行動提案】) で、トピックにすると
  // 一覧が細かくなりすぎる (実測: 39 のはずが 74 件になった)。
  // `【】` を構造に使っている章 (検査値フィードバック) は `###` を持たないので、
  // その場合だけ `【】` へ落ちる。
  const mode = hasHashHeading(section.text) ? 'hash' : 'both';
  const blocks = splitBlocks(section.text, mode).filter((b) => b.heading);
  if (blocks.length === 0) {
    const teaser = firstSentence(section.text);
    return teaser ? [{ id: anchorFor(key, section.section_name), heading: section.section_name, teaser }] : [];
  }
  return blocks.map((b) => ({
    id: anchorFor(key, b.heading),
    heading: b.heading,
    teaser: firstSentence(b.body),
  }));
}

/**
 * 生活習慣を【現状評価】→【行動提案】のペアにする (spec §4.2.2)。
 * **維持／改善の自動分類はしない** — 語尾判別は「続け**ながら**」を取りこぼす脆い判定。
 */
export function extractLifestylePairs(text: string): LifestylePairVM[] {
  const out: LifestylePairVM[] = [];
  // `### N. 見出し` 単位に割り、その中の【現状評価】【行動提案】を拾う
  const sections = text.split(/^###\s*/m).slice(1);
  for (const s of sections) {
    const nl = s.indexOf('\n');
    const topic = (nl >= 0 ? s.slice(0, nl) : s).trim();
    const rest = nl >= 0 ? s.slice(nl + 1) : '';
    const cur = /【現状評価】([\s\S]*?)(?=【|$)/.exec(rest);
    const pro = /【行動提案】([\s\S]*?)(?=【|$)/.exec(rest);
    if (!topic || (!cur && !pro)) continue;
    out.push({ topic, current: (cur?.[1] ?? '').trim(), proposal: (pro?.[1] ?? '').trim() });
  }
  return out;
}

/**
 * 食事アドバイスから「1 か月の食事改善プラン」の見出しブロックを切り出す (spec §4.1 の 7.5)。
 * 見出しの表記ゆれ (`1か月` / `1 か月`) を吸収する。無ければ null。
 */
export function extractDietPlan(text: string): { heading: string; body: string } | null {
  for (const b of splitBlocks(text)) {
    if (b.heading && /か\s*月/.test(b.heading) && /プラン/.test(b.heading)) return b;
  }
  return null;
}

/** 切り出したブロックを本文から取り除く (同じ文章を 2 か所に出さないため)。 */
function removeBlock(text: string, heading: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const h = HEADING_RE.exec(line) ?? BLOCK_RE.exec(line);
    if (h) skipping = h[1].trim() === heading;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ───────────────────────────────────────────────────────────────
// 検査値と所見 (spec §5.2 / §5.3)
// ───────────────────────────────────────────────────────────────

/**
 * Elith 自身が書いた判定句。**当社が語を作らない** (spec §4.2.1)。
 *
 * 誤字「基準範囲を**上上**回っており」が実データにあるため `上+` にしてある。
 * **原文は直さない**(§7.3) が、拾えなくなるのは別の問題なので検出だけ許容する。
 */
const JUDGEMENT_PATTERNS: RegExp[] = [
  /基準範囲を上+回っています/,
  /基準範囲を上+回っており/,
  /基準範囲内であり/,
  /基準範囲内です/,
  /基準範囲内に収まっており/,
  /基準範囲内に収まっています/,
  /基準値を下回っています/,
  /基準値を下回っており/,
  /基準範囲を下回っています/,
  /基準範囲を下回っており/,
];

/** 旧形式 (Stage2) の `（判定区分：X）`。新形式には 0 件だが、サンプル表示のため残す。 */
const LEGACY_JUDGEMENT_RE = /判定区分[：:]\s*([^）)、。]+)/;

/** `赤血球数は585 10^4/ul（基準値：400〜539 10^4/ul）` を拾う。 */
const VALUE_WITH_REF_RE = /([^\s、。は（(]{1,20})は\s*([^（(、。]{1,24}?)\s*[（(]基準値[：:]\s*([^）)]+)[）)]/g;

/** 項目名の位置に来る「項目名でない主語」。この場合はブロック見出しを項目名にする。 */
const GENERIC_SUBJECT_RE = /^(?:今回の(?:測定値|結果|値)|測定値|結果|値|数値)$/;

/** `585 10^4/ul` → 値 `585` / 単位 `10^4/ul`。最初の空白で割る。 */
function splitValueUnit(s: string): { value: string; unit: string | null } {
  const m = /^(\S+)\s+(.+)$/.exec(s);
  return m ? { value: m[1], unit: m[2].trim() } : { value: s, unit: null };
}

export interface ReportFinding {
  /** 【】で括られたカテゴリ名。 */
  category: string;
  /** **Elith の原文のまま**の判定句。無ければ null。 */
  judgement: string | null;
  /** 判定句を含む一文 (原文のまま。要約しない)。 */
  sentence: string;
  /** そのブロックで値と基準値が読み取れた項目。 */
  items: MeasurementVM[];
  anchor: string;
}

const FEEDBACK_KEYS = ['blood_analysis', '検査値フィードバック'];

function findFeedback(byKey: Map<string, ReportSectionRaw>): ReportSectionRaw | null {
  for (const k of FEEDBACK_KEYS) {
    const s = byKey.get(k);
    if (s) return s;
  }
  return null;
}

/**
 * 「検査値フィードバック」から Elith 自身の判定文を拾う (spec §5.2)。
 *
 * **アプリは値と基準値を比べない。** 拾うのは Elith が明記した判定文だけ。
 * 判定文が無いブロックは所見にしない (fail-safe: 拾えなければ何も出さない)。
 * **並べ替えない** — Elith が書いた順のまま返す。
 */
export function extractFindings(byKey: Map<string, ReportSectionRaw>): ReportFinding[] {
  const fb = findFeedback(byKey);
  if (!fb) return [];

  const out: ReportFinding[] = [];
  for (const b of splitBlocks(fb.text)) {
    if (!b.heading || !b.body) continue;
    const flat = b.body.replace(/\s*\n+\s*/g, '');

    let judgement: string | null = null;
    let sentence = '';
    for (const s of flat.split(/(?<=。)/)) {
      const hit = JUDGEMENT_PATTERNS.map((re) => re.exec(s)).find((m) => m != null);
      if (hit) { judgement = hit[0]; sentence = s.trim(); break; }
    }
    if (!judgement) {
      const legacy = LEGACY_JUDGEMENT_RE.exec(flat);
      if (legacy) {
        judgement = legacy[1].trim();
        sentence = (flat.split('です。')[0] || flat.slice(0, 120)) + (flat.includes('です。') ? 'です。' : '');
      }
    }
    if (!judgement) continue;

    const items: MeasurementVM[] = [];
    for (const m of flat.matchAll(VALUE_WITH_REF_RE)) {
      // 単一項目のブロックでは Elith が「**今回の測定値**は27.9 mg/dL（基準値：…）」と書く。
      // 主語が項目名になっていないので、そのブロックの見出し (=項目名) を使う。
      // これも Elith の文字列であって、当社が名前を作っているわけではない。
      const raw = m[1].trim();
      const name = GENERIC_SUBJECT_RE.test(raw) ? b.heading : raw;
      const { value, unit } = splitValueUnit(m[2].trim());
      items.push({ name, unit, value, reference: m[3].trim(), judgement, date: null });
    }

    out.push({ category: b.heading, judgement, sentence, items, anchor: anchorFor('measurements', b.heading) });
  }
  return out;
}

/**
 * 「医療受診の目安」の最優先所見 (spec §4.2.1「医師に相談する項目」)。
 * 新形式の `### N. 最優先…` と旧形式の `**最優先…**` の両方に対応する。
 */
export function extractTopPriority(byKey: Map<string, ReportSectionRaw>): { heading: string; text: string } | null {
  const s = byKey.get('medical_visit') ?? byKey.get('医療受診の目安');
  if (!s) return null;
  for (const b of splitBlocks(s.text)) {
    if (!/最優先/.test(b.heading)) continue;
    const text = firstSentence(b.body);
    if (text) return { heading: b.heading, text };
  }
  // 旧形式: 見出しが `**最優先の所見**` のように太字で書かれている
  const m = /\*\*([^*]*最優先[^*]*)\*\*\s*([\s\S]+?)(?=\n\n\*\*|$)/.exec(s.text);
  if (!m) return null;
  const text = firstSentence(m[2]);
  return text ? { heading: m[1].trim(), text } : null;
}

/**
 * 検査値へ、本文から拾えた基準値と判定を重ねる。
 * **拾えないものは空のまま** (外部マスタで補完しない = 捏造ゼロ・spec §5.3)。
 *
 * 【単位まで一致させる理由】この検体には `総コレステロール [mg/dL]`=210 と
 * `[mg/dl]`=251 の 2 行がある。**大文字小文字は 2 検査の混在を意味する** (spec §7.0) ので、
 * 名前だけで結ぶと Elith が触れていない方の値にまで基準値が付いてしまう。
 * 一意に決まらないときは**付けない**。
 */
function applyReferences(
  rows: MeasurementVM[],
  findings: ReportFinding[],
): { hit: number; notes: string[] } {
  const notes: string[] = [];
  let hit = 0;

  for (const f of findings) {
    for (const it of f.items) {
      if (!it.reference) continue;
      let cands = rows.filter((r) => r.name === it.name);
      if (cands.length === 0) {
        // 本文が参照している値が health_checkup.json に無い (spec §7.2)。
        notes.push(`本文が参照する値が検査値に無い: ${it.name} = ${it.value}`);
        continue;
      }
      if (it.unit && cands.length > 1) {
        const byUnit = cands.filter((r) => r.unit === it.unit);
        if (byUnit.length > 0) cands = byUnit;
      }
      if (cands.length !== 1) {
        notes.push(`基準値の対応先が一意でない: ${it.name} (候補 ${cands.length} 件)`);
        continue;
      }
      cands[0].reference = it.reference;
      cands[0].judgement = it.judgement;
      hit++;
    }
  }
  return { hit, notes };
}

/**
 * 同名別値を検出する (spec §7.1)。**自動採用しない** — 両方残し、監査に出すだけ。
 * 単位の大文字小文字違い (`mg/dL` / `mg/dl`) は 2 検査の混在を意味する (spec §7.0)。
 *
 * **名前は完全一致で見る。** 括弧を落として `ALT` と `ALT(GPT)` を同一視すると、
 * 「この 2 つは同じ項目だ」という判断を当社がすることになる (ミッション④)。
 * 受領キーが別なら別項目として扱い、実測 9 組を検出する。
 */
function duplicateNames(rows: MeasurementVM[]): string[] {
  const seen = new Map<string, string[]>();
  for (const r of rows) {
    const base = r.name;
    const list = seen.get(base) ?? [];
    list.push(r.value);
    seen.set(base, list);
  }
  return [...seen.entries()]
    .filter(([, vals]) => vals.length > 1 && new Set(vals).size > 1)
    .map(([name, vals]) => `同名別値: ${name} = ${vals.join(' / ')}`);
}

// ───────────────────────────────────────────────────────────────
// 表示モデルの組み立て
// ───────────────────────────────────────────────────────────────

export interface BuildReportInput {
  /** `report_text.json` の中身 (新形式 dict / 旧形式 配列 のどちらでも)。 */
  reportText: unknown;
  /** `health_checkup.json` の中身。無ければ検査値の章は出ない。 */
  checkup?: unknown;
  /** 報告書のタイプ。**アプリが持つ** (Elith 出力から推測しない・spec §1.0.3)。 */
  type: ReportType;
  issuedOn: string;
  /** 氏名。本人への表示なので出す (spec §4.0.0.1)。 */
  name?: string | null;
  actualAge?: number | null;
  /** 検査サイクル。タイプ 2 (単品購入) では null (spec §4.0.0.2)。 */
  cycle?: CycleVM | null;
  isSample?: boolean;
  /** 当社 CABA の算出値。**本来 Elith の値と一致する**ので、ズレは異常として監査に出す (spec §1.3.8)。 */
  ownWellnessAge?: number | null;
  /** 章立ての解決を差し替える (テスト用)。既定は `app_config` を重ねた結果。 */
  chapters?: ChapterSpec[];
}

/** 章 1 つ分の本文を作る。材料が無ければ null を返し、**章ごと出さない** (spec §0.3)。 */
function buildChapter(
  spec: ChapterSpec,
  byKey: Map<string, ReportSectionRaw>,
  ctx: { dietPlanEnabled: boolean; measurements: MeasurementVM[]; findings: ReportFinding[] },
): ChapterVM | null {
  const base = {
    key: spec.key, title: spec.title, axis: spec.axis, source: spec.source,
    topics: [] as TopicVM[], measurements: [] as MeasurementVM[], pairs: [] as LifestylePairVM[],
    collapsed: spec.collapsed, anchor: anchorFor(spec.key),
  };

  if (spec.source === 'cancer_finding') {
    // A の章。Elith にフィールドの新設を依頼中 (spec §4.0.1)。
    // **フィールド自体が無ければカードごと非表示** — 定型表現も出さない。
    const s = byKey.get('cancer_finding');
    return s?.text ? { ...base, body: s.text } : null;
  }

  if (spec.source === 'measurements') {
    if (ctx.measurements.length === 0 && ctx.findings.length === 0) return null;
    return {
      ...base,
      body: '',
      measurements: ctx.measurements,
      topics: ctx.findings.map((f) => ({ id: f.anchor, heading: f.category, teaser: f.sentence })),
    };
  }

  if (spec.source === 'diet_plan') {
    const diet = byKey.get('diet') ?? byKey.get('食事アドバイス');
    const plan = diet ? extractDietPlan(diet.text) : null;
    return plan?.body ? { ...base, body: plan.body } : null;
  }

  const s = byKey.get(spec.source);
  if (!s?.text) return null;

  let body = s.text;
  // 「1 か月の食事プラン」を別章にしているときは、食事の本文から取り除いて重複を避ける。
  if (spec.source === 'diet' && ctx.dietPlanEnabled) {
    const plan = extractDietPlan(body);
    if (plan) body = removeBlock(body, plan.heading);
  }

  const chapter: ChapterVM = { ...base, body, topics: extractTopics(spec.key, { ...s, text: body }) };
  if (spec.source === 'lifestyle') chapter.pairs = extractLifestylePairs(body);
  return chapter;
}

/** 受領 JSON から表示モデルを組み立てる。 */
export function buildReportVM(input: BuildReportInput): ReportVM {
  const { byKey, healthAge } = parseReportText(input.reportText);
  const resolved = input.chapters ? { chapters: input.chapters, hidden: [], unknown: [] } : resolveChapters();

  const findings = extractFindings(byKey);
  const measurements = parseCheckup(input.checkup);
  const { hit: referenceCount, notes: refNotes } = applyReferences(measurements, findings);

  const dietPlanEnabled = resolved.chapters.some((c) => c.key === 'diet_plan');
  const ctx = { dietPlanEnabled, measurements, findings };

  const chapters: ChapterVM[] = [];
  const skipped: ChapterKey[] = [];
  for (const spec of resolved.chapters) {
    const ch = buildChapter(spec, byKey, ctx);
    if (ch) chapters.push(ch);
    else skipped.push(spec.key);
  }

  const abstract = byKey.get('abstract') ?? byKey.get('アブストラクト');
  const anomalies = [...duplicateNames(measurements), ...refNotes];
  if (resolved.unknown.length > 0) {
    anomalies.push(`app_config に未知の章キー: ${resolved.unknown.join(', ')}`);
  }
  // ウェルネス年齢はアプリが算出して Elith へ渡した値がそのまま返る = 本来必ず一致する (spec §1.3.8)。
  if (healthAge != null && input.ownWellnessAge != null && Math.abs(healthAge - input.ownWellnessAge) > 0.05) {
    anomalies.push(`ウェルネス年齢が当社算出と不一致: Elith ${healthAge} / 当社 ${input.ownWellnessAge}`);
  }

  const cover: CoverVM = {
    name: input.name ?? null,
    issuedOn: input.issuedOn,
    templateVersion: REPORT_TEMPLATE_VERSION,
    wellnessAge: healthAge,
    actualAge: input.actualAge ?? null,
    abstract: abstract?.text ?? '',
    cycle: input.type === 'course' ? input.cycle ?? null : null,
  };

  const audit: ReportAudit = {
    recognizedSections: [...byKey.values()].map((s) => s.section_name),
    skippedChapters: skipped,
    hiddenChapters: resolved.hidden,
    topicCount: chapters.reduce((n, c) => n + c.topics.length, 0),
    measurementCount: measurements.length,
    referenceCount,
    anomalies,
  };

  return { type: input.type, cover, chapters, audit, isSample: input.isSample ?? false };
}
