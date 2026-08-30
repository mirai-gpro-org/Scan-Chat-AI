/**
 * AI疾病予防報告書 — **受領 JSON → 表示モデル** の変換規則。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §5
 *
 * 【このモジュールが唯一の変換本体】抽出・整形の規則をここに集約し、`.astro` に
 *   正規表現を散らさない (spec §1.3.4)。本リポジトリには同じ規律の前例がある —
 *   納品整形は `elith-export.ts` の `sanitizeMeasurementsForDelivery()` に集約し、
 *   CLAUDE.md に「二重管理しない」と明記されている。
 *
 * 【絶対の制約 — 紙面に出る文はすべて逐語】(spec §1.0.0)
 *   可読化は **「選択」で行い「圧縮」で行わない**。どの文を出すかを決めるのは当社の仕事だが、
 *   出すと決めた文は 1 文字も変えない。要約・言い換え・語順の入れ替えをしない。
 *   **原文の誤字も直さない** (実データの「基準範囲を上上回っており」はそのまま出す・spec §7.3)。
 *
 * 【アプリは値を評価しない】判定は Elith が書いた文をそのまま運ぶ。
 *   値と基準値を比べて良し悪しを決めない (ミッション④)。
 *
 * 【LLM を使わない】(spec §5.5) 決定論のみ。スキャン側で LLM を後段に置いて
 *   繰り返し捏造を踏んだ実績 (多数決撤回・inventoryReread の幻覚 5 件・VQA の捏造 4 件) が
 *   そのままここにも効く。
 */

import type { ElithSection } from './elith-parser';
import type {
  ChapterVM, CoverVM, DigestBlock, DigestCardVM, DigestItem,
  LifestylePair, MeasurementRow, ReportAudit, ReportVM, TopicVM,
} from './report-model';
import { CHAPTER_REGISTRY, REPORT_AXES, anchorFor, resolveChapters } from './report-sections';

/** 紙面テンプレートの版 (spec §1.3.9)。紙面を変えたら上げ、紙面に印字する。 */
export const SHEET_VERSION = 'v1.0';

/** 検査サイクルの総数 (年 4 回・spec §1.0.1)。 */
export const CYCLE_TOTAL = 4;

/**
 * 【パイロット版 v0.1 の唯一の例外・発注者指示 2026-08-29】
 *
 * タイプ 2 の主軸 A「今回の所見」に出す 2 文。**これは Elith の原文ではない。**
 * spec §10.1 E-1 で Elith に出力を依頼している文型そのもので、受領データにはまだ無い。
 *
 * 発注者判断: **パイロット版ではこのまま出す。** 依頼の内容をそのまま Wellfort と Elith に
 * 見てもらい、回答を得てから修正する。確定したら
 *   ① Elith が `cancer_screening.text` を返すようになれば、そちらが優先される
 *   ② それでも来なければ `ui.cancer_screening_not_included` (admin から入力) へ降りる
 * のどちらかに置き換わり、この定数は消える。
 *
 * **これ以外に、当社が書いた文を紙面へ出してはならない** (spec §1.0.0)。
 */
export const PILOT_CANCER_FINDING_TEXT = [
  '今回お預かりした人間ドックの結果と問診の範囲では、がんに関して特に気になる点は見当たりませんでした。',
  'なお、がんリスク検査は今回の検査には含まれていません。',
];

// ── 受領 JSON の取り込み (spec §5.1) ──────────────────────────

/** 新形式 (dict) の 1 セクション。 */
interface RawSection { section_name?: unknown; actual_chars?: unknown; text?: unknown }

export interface ParsedReportText {
  sections: ElithSection[];
  /** セクション key (`medical_visit` 等) → セクション。章レジストリの `sourceKey` で引く。 */
  byKey: Map<string, ElithSection>;
  /** Elith 出力のウェルネス年齢。無ければ null。 */
  wellnessAge: number | null;
  /** Elith が返した場合のがん所見 (spec §4.0.1 の依頼形)。未受領なら null。 */
  cancerText: string | null;
}

/**
 * `report_text.json` を取り込む。
 *
 * **新旧どちらの形式も読む。** 新形式 = dict (`{ health_age, <key>: {section_name, text} }`)、
 * 旧形式 = `ElithSection[]` (`schema_version='elith-v1.0'` の既存行)。
 * DB に旧形式の行が残っているあいだ、片方しか読めないと黙って空になる。
 */
export function parseReportText(raw: unknown): ParsedReportText {
  const sections: ElithSection[] = [];
  const byKey = new Map<string, ElithSection>();
  let wellnessAge: number | null = null;
  let cancerText: string | null = null;

  const push = (key: string, s: ElithSection) => {
    sections.push(s);
    byKey.set(key, s);
  };

  if (Array.isArray(raw)) {
    // 旧形式: section_name しか無いので、レジストリの sourceKey とは section_name で突き合わせる。
    for (const v of raw as ElithSection[]) {
      if (!v || typeof v.section_name !== 'string') continue;
      const s: ElithSection = {
        section_name: v.section_name,
        char_count: Number(v.char_count ?? 0),
        text: String(v.text ?? ''),
      };
      push(legacyKeyOf(v.section_name), s);
    }
    return { sections, byKey, wellnessAge, cancerText };
  }

  if (!raw || typeof raw !== 'object') return { sections, byKey, wellnessAge, cancerText };

  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'health_age') {
      const n = Number(v);
      if (Number.isFinite(n)) wellnessAge = n;
      continue;
    }
    // Elith へ依頼中の独立フィールド (spec §4.0.1)。未受領のあいだは通らない。
    if (key === 'cancer_screening' && v && typeof v === 'object') {
      const t = (v as { text?: unknown }).text;
      if (typeof t === 'string' && t.trim()) cancerText = t.trim();
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const r = v as RawSection;
    if (typeof r.text !== 'string') continue;
    push(key, {
      section_name: typeof r.section_name === 'string' ? r.section_name : key,
      char_count: Number(r.actual_chars ?? String(r.text).length),
      text: r.text,
    });
  }
  return { sections, byKey, wellnessAge, cancerText };
}

/** 旧形式 (配列) の `section_name` を新形式のキーへ寄せる。 */
const LEGACY_KEY_BY_NAME: Record<string, string> = {
  'アブストラクト': 'abstract',
  '総評': 'summary',
  '検査値フィードバック': 'blood_analysis',
  '食事アドバイス': 'diet',
  '運動アドバイス': 'exercise',
  '睡眠・ストレス管理': 'sleep',
  'ライフスタイル総合': 'lifestyle',
  '医療受診の目安': 'medical_visit',
  '必要とする栄養素/サプリ情報': 'nutrients',
  'リファレンス': 'references',
};
function legacyKeyOf(name: string): string {
  return LEGACY_KEY_BY_NAME[name] ?? name;
}

// ── 文の切り出し ────────────────────────────────────────

/**
 * 冒頭 n 文を**逐語で**返す。文字を足さない・削らない。
 *
 * 「。」で割って先頭から n 個を戻すだけ。原文に「。」が無ければ全体を返す。
 */
export function leadSentences(text: string, n = 1): string {
  const body = text.trim();
  if (!body) return '';
  // 区切り「。」ごと取り出す。**`split('。')` して後から `。` を付け直さないこと** —
  // 原文に「。」が無い断片にまで句点が生えて**原文改変**になる (回帰テストで検出した)。
  const parts = body.match(/[^。]+。|[^。]+$/g);
  if (!parts) return body;
  return parts.slice(0, n).join('').trim();
}

/** `### N. 見出し` / `【見出し】` でブロックに割る。見出しと本文を逐語で返す。 */
interface Block { heading: string; body: string }

function splitByHash(text: string): Block[] {
  const out: Block[] = [];
  const parts = text.split(/^###\s*/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const headRaw = (nl < 0 ? p : p.slice(0, nl)).trim();
    const body = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    // 「1. 飲酒習慣」→「飲酒習慣」。番号は Elith の採番であって内容ではない。
    out.push({ heading: headRaw.replace(/^\d+\.\s*/, ''), body });
  }
  return out;
}

function splitByBracket(text: string): Block[] {
  const out: Block[] = [];
  const parts = text.split(/【([^】]+)】/);
  for (let i = 1; i < parts.length; i += 2) {
    out.push({ heading: parts[i].trim(), body: (parts[i + 1] ?? '').trim() });
  }
  return out;
}

/** 章を「トピック」に割る。`###` があればそれだけを使う (無いときだけ `【】`)。 */
export function splitTopics(text: string): Block[] {
  const hash = splitByHash(text);
  if (hash.length) return hash;
  const bracket = splitByBracket(text);
  if (bracket.length) return bracket;
  return [];
}

/**
 * 見出しが 1 つも無い章を **章まるごと 1 ブロック**として返す。
 *
 * 【なぜ要るか】受領形式は世代で変わる。実測 (2026-08-29・本番 DB の 真鍋検体) では
 *   `医療受診の目安` / `ライフスタイル総合` / `必要とする栄養素/サプリ情報` に
 *   `###` も `【】` も無く、`splitTopics` が 0 件を返して**ダイジェストのカードが
 *   全部消えた** (主軸 B が帯だけの白紙になる)。全編の章側は既にこの受け皿を持っていた
 *   (「見出しの無い章は章まるごと 1 トピック」) が、ダイジェスト側に無かった。
 *
 * **中身は足さない。** 見出しが無いことを「見出し = 章名」として扱うだけで、
 * 本文は 1 文字も変えない (spec §1.0.0)。
 */
function topicsOrWhole(section: ElithSection): Block[] {
  const blocks = splitTopics(section.text);
  if (blocks.length) return blocks;
  const body = section.text.trim();
  return body ? [{ heading: '', body }] : [];
}

// ── 検査値 (spec §5.3 / §7.1 / §7.2) ─────────────────────────

/**
 * Elith 自身が書いた判定句。**アプリが値と基準値を比べて作った文ではない。**
 *
 * `上+` は実データの誤字「基準範囲を**上上**回っており」を拾うため (spec §7.3)。
 * **原文は直さないが、検出はする。**
 */
const JUDGEMENT_RE =
  /(基準範囲を上+回って(?:います|おり)|基準範囲内|基準範囲に収まって(?:います|おり)|基準値を下回って(?:います|おり))/;

function toneOf(judgement: string): MeasurementRow['tone'] {
  if (!judgement) return 'unknown';
  if (/基準範囲内|収まって/.test(judgement)) return 'within';
  return 'flagged';
}

/**
 * `名前は 値（基準値：〜）` を拾う。
 *
 * **コロンは全角 `：` と半角 `:` の両方を受ける。** 受領世代によって揺れており、
 * 全角だけを見ていたため本番 DB の検体 (半角 `（基準値: 〜129 mmHg）` が 12 箇所) で
 * **1 件も拾えず、検査値の表が空になった** (実測 2026-08-29)。
 */
const VALUE_RE = /([^\s、。（(]+?)(?:は|が)((?:[0-9][^（(、。]*?))（基準値[：:]\s*([^）]*)）/g;

/** `health_checkup.json` のキー `項目名 [単位]` を分解する。 */
function splitCheckupKey(key: string): { name: string; unit: string } {
  const m = /^(.*?)\s*\[(.*)\]\s*$/.exec(key);
  return m ? { name: m[1].trim(), unit: m[2].trim() } : { name: key.trim(), unit: '' };
}

/**
 * `585 10^4/ul` → `10^4/ul`。先頭の数値トークンだけを落として残りを単位とみなす。
 *
 * **文字クラスに空白を入れて貪欲に消さないこと。** `[\d.,\s]+` にすると
 * `585 10^4/ul` の単位側の `10` まで食って `^4/ul` になり、単位が一致せず
 * 本文の基準値が結べなくなる (実測)。
 */
function unitOfValue(value: string): string {
  return value.replace(/^[\d.,]+\s*/, '').trim();
}

/**
 * 本文と `health_checkup.json` を突き合わせるキー。
 *
 * **単位の大文字・小文字を潰さないこと。** 2026-08-26 受領分は合成検体で、
 * **単位の小文字 `l` = 人間ドック / 大文字 `L` = 血液検査**という規則で 2 つの検査が
 * 混ざっている (spec §7.0)。`toLowerCase()` すると別検査の値が同一視され、
 * Elith が判定していない行に判定が付く。空白だけ落として大小はそのまま比べる。
 */
function textKey(name: string, unit: string): string {
  return `${name}|${unit.replace(/\s+/g, '')}`;
}

export interface MeasurementResult {
  /** 受領した全行。**受領ファイルのキー順のまま**にする (原票と並びが揃う)。全編の表に出す。 */
  rows: MeasurementRow[];
  /**
   * ダイジェストの表に出す行 = **Elith が本文で取り上げた項目**を、
   * **Elith が本文で言及した順**に並べたもの (spec §1.3.10 / モック契約)。
   *
   * 【なぜ受領順ではないか】`health_checkup.json` のキー順は検査票の様式順で、
   * Elith の話の流れとは無関係。そのまま出すと、Elith が最初に取り上げた
   * 赤血球・ヘモグロビン・ヘマトクリットの 3 点セットが表の中ほどにばらけ、
   * 直前の「医療受診の目安」の話と繋がらない (モックとの差分で発覚)。
   *
   * 【なぜ当社の解釈ではないか】並べ替えの根拠は **Elith が本文に書いた順序そのもの**。
   * 値と基準値を当社が比べて優先順位を付けているのではないので、
   * 整理であって解釈ではない (ミッション④)。
   */
  digestRows: MeasurementRow[];
  anomalies: string[];
}

/**
 * 検査値の表を組む。
 *
 * - 値 = `health_checkup.json` (受領そのまま)。
 * - **本文にしかない値も載せる** (spec §7.2)。2 ファイルは包含関係でないため、
 *   検査値ファイルだけで組むと本文が最優先扱いする項目 (実測: ヘマトクリット) が落ちる。
 * - 基準値・判定 = `blood_analysis` の本文から取れた分だけ。**無い項目は空**
 *   (外部マスタで補完しない = 捏造ゼロ)。
 * - **同名別値は自動採用しない** (spec §7.1)。両方を行として残し `variants` で通数を持つ。
 */
export function buildMeasurements(
  checkup: Record<string, { date?: string; value?: unknown }[]> | null,
  bloodAnalysis: ElithSection | null,
): MeasurementResult {
  const anomalies: string[] = [];

  // ① 本文から 値・基準値・判定 を拾う (`項目名|単位` → 情報)
  //    **キーに単位を含める。** 同じ項目名で単位違いの値が届くことがあり
  //    (実測: 赤血球数 [10^4/ul]=585 と [万/μL]=504)、名前だけで突き合わせると
  //    Elith が判定していない行に判定が付く = 書いていない判定を作ることになる (spec §7.1)。
  interface FromText { name: string; unit: string; value: string; reference: string; judgement: string }
  const fromText = new Map<string, FromText>();

  if (bloodAnalysis) {
    // **`【】` 決め打ちにしない。** 受領世代によって節の書き方が `###` に変わる
    // (実測 2026-08-29: 本番 DB の検体は `### 血圧` 形式で `【` が 0 件)。
    // `splitByBracket` しか見ていなかったため 1 ブロックも取れず表が空になった。
    // 見出しがまったく無い章は章まるごと 1 ブロックとして扱う。
    for (const block of topicsOrWhole(bloodAnalysis)) {
      const found: FromText[] = [];
      VALUE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = VALUE_RE.exec(block.body))) {
        // 「今回の測定値は27.9 mg/dL（基準値：…）」のように項目名が入らない書き方がある。
        // その場合はブロック見出しが項目名 (単一項目ブロック)。
        const raw = m[1].trim();
        const name = /測定値|結果$/.test(raw)
          ? (block.heading.trim() || bloodAnalysis.section_name.trim())
          : raw;
        if (!name) continue;
        const value = m[2].trim();
        const entry: FromText = { name, unit: unitOfValue(value), value, reference: m[3].trim(), judgement: '' };
        found.push(entry);
        fromText.set(textKey(entry.name, entry.unit), entry);
      }
      if (!found.length) continue;

      // ② 判定句を項目へ割り当てる。
      //    まず「<項目>は…<判定句>」の形で項目名に隣接するものだけを引く。
      //    「クレアチニンについても基準値との関係において…」のように判定句を伴わない
      //    言及に判定を付けないため (Elith が書いていない判定を作らない)。
      for (const e of found) {
        const esc = e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = new RegExp(`${esc}(?:は|も|が)[^。]{0,12}?${JUDGEMENT_RE.source}`).exec(block.body);
        if (hit) e.judgement = hit[1];
      }
      // 一括表明を当てる。次の 2 つだけを対象にする:
      //   - 「これら3つの項目すべてが基準範囲を上回っています」= 明示的に全項目
      //   - 単一項目ブロック = 「今回の結果は基準範囲を上回っており」の主語がその項目しかない
      // どちらでもないブロックには当てない (どの項目の判定か決められないため)。
      const blanket = new RegExp(`(?:すべてが|今回の結果は)[^。]{0,10}?${JUDGEMENT_RE.source}`).exec(block.body);
      if (blanket && (found.length === 1 || /すべてが/.test(blanket[0]))) {
        for (const e of found) if (!e.judgement) e.judgement = blanket[1];
      }
    }
  }

  // ③ health_checkup.json を行にする。同名別値は競合として両方残す。
  const rows: MeasurementRow[] = [];
  const seenNames = new Map<string, number>();
  const entries = Object.entries(checkup ?? {});

  for (const [key] of entries) {
    const { name } = splitCheckupKey(key);
    seenNames.set(name, (seenNames.get(name) ?? 0) + 1);
  }

  // 行 → 本文での言及順。`fromText` は Map なので**挿入順 = 本文に現れた順**。
  // **行を作るその場で記録する。** 後から名前で引き当てると、同名別値 (総コレステロール
  // 210 mg/dL と 251 mg/dl) で**単位違いの別の行に順序が付く** (実測で末尾へ飛んだ)。
  const mentionAt = new Map<string, number>();
  [...fromText.keys()].forEach((k, i) => mentionAt.set(k, i));
  const rowMention = new Map<MeasurementRow, number>();

  const usedFromText = new Set<string>();
  for (const [key, arr] of entries) {
    const { name, unit } = splitCheckupKey(key);
    const first = Array.isArray(arr) ? arr[0] : undefined;
    if (!first || first.value === undefined || first.value === null) continue;
    // 単位まで一致したときだけ本文の基準値・判定を結ぶ。一致しなければ空のまま。
    const k = textKey(name, unit);
    const t = fromText.get(k);
    if (t) usedFromText.add(k);
    const row: MeasurementRow = {
      name,
      value: unit ? `${first.value} ${unit}` : String(first.value),
      reference: t?.reference ?? '',
      judgement: t?.judgement ?? '',
      tone: toneOf(t?.judgement ?? ''),
      source: 'checkup',
      variants: seenNames.get(name) ?? 1,
    };
    rows.push(row);
    const at = mentionAt.get(k);
    if (at !== undefined) rowMention.set(row, at);
  }

  for (const [name, count] of seenNames) {
    if (count > 1) anomalies.push(`同名別値: ${name} が ${count} 通り届いています (自動採用しません)`);
  }



  // ④ 本文にしかない項目を足す (spec §7.2)。
  //    2 ファイルは包含関係でないので、検査値ファイルだけで組むと本文が最優先扱いする
  //    項目 (実測: ヘマトクリット) が落ちる。
  for (const [k, t] of fromText) {
    if (usedFromText.has(k)) continue;
    rows.push({
      name: t.name,
      value: t.value,
      reference: t.reference,
      judgement: t.judgement,
      tone: toneOf(t.judgement),
      source: 'report_text',
      variants: 1,
    });
    if (!seenNames.has(t.name)) {
      anomalies.push(`本文が扱う ${t.name} が health_checkup.json に無いため、本文から拾いました`);
    }
    rowMention.set(rows[rows.length - 1], mentionAt.get(k) ?? Number.MAX_SAFE_INTEGER);
  }

  // ダイジェスト = 本文が取り上げた行 (基準値が付いた行) を、**本文での言及順**に。
  // 言及順が取れなかった行は末尾へ回し、その中では受領順を保つ (安定ソート)。
  const digestRows = rows
    .filter((r) => r.reference)
    .map((r, i) => ({ r, i, m: rowMention.get(r) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.m - b.m || a.i - b.i)
    .map((x) => x.r);

  return { rows, digestRows, anomalies };
}

// ── ダイジェストのカード ────────────────────────────────

/** Elith が救急受診を促した文。**赤を使ってよいのはここだけ** (spec §4.2.1)。 */
const EMERGENCY_RE = /(?:早急な医療確認|救急|ただちに医療機関|直ちに医療機関)/;

/** 章タイトル。レジストリ／`app_config` の上書きが空なら受領 JSON の `section_name`。 */
function titleOf(key: string, label: string, section: ElithSection | null): string {
  if (label) return label;
  return section?.section_name ?? key;
}

function card(
  key: string, title: string, axis: 'a' | 'b', source: string,
  blocks: DigestBlock[], tone: DigestCardVM['tone'] = 'normal',
): DigestCardVM | null {
  const filled = blocks.filter((b) =>
    (b.kind === 'paragraphs' && b.items.length) ||
    (b.kind === 'steps' && b.items.length) ||
    (b.kind === 'table' && b.rows.length) ||
    (b.kind === 'pairs' && b.items.length) ||
    (b.kind === 'weeks' && b.items.length));
  if (!filled.length) return null;
  return { key, title, axis, tone, blocks: filled, source };
}

// ── 本体 ────────────────────────────────────────────────

export interface BuildInput {
  reportText: unknown;
  checkup: Record<string, { date?: string; value?: unknown }[]> | null;
  name: string;
  issuedOn: string;
  isSample: boolean;
  /** その回の入力にがんリスク検査があったか。**アプリが判定する** (spec §1.0.3)。 */
  hasCancerRisk: boolean;
  cycleSeq: number | null;
  chronologicalAge: number | null;
  /** 当社 CABA の算出値。Elith 出力との突合に使う (紙面には出さない・spec §1.3.8)。 */
  ourWellnessAge?: number | null;
  /** `ui.cancer_screening_not_included`。空なら使わない (spec §0.3)。 */
  cancerFallbackText?: string;
  /** 章立ての設定リーダ。回帰テストで差し替える。 */
  readConfig?: (key: string) => string;
}

export function buildReportVM(input: BuildInput): ReportVM {
  const parsed = parseReportText(input.reportText);
  const { chapters: specs, hidden, unknown } = resolveChapters(input.readConfig);
  const sec = (k: string | null) => (k ? parsed.byKey.get(k) ?? null : null);

  const anomalies: string[] = [];
  const digest: DigestCardVM[] = [];
  const emptyCards: string[] = [];

  const measured = buildMeasurements(input.checkup, sec('blood_analysis'));
  anomalies.push(...measured.anomalies);

  // ウェルネス年齢は当社が算出して Elith へ渡した値がそのまま返る = 本来必ず一致する。
  // 不一致は往復のどこかでデータが壊れた兆候 (spec §1.3.8)。**紙面には出さず監査に出す。**
  if (parsed.wellnessAge != null && input.ourWellnessAge != null
      && Math.abs(parsed.wellnessAge - input.ourWellnessAge) > 0.05) {
    anomalies.push(
      `ウェルネス年齢が当社 CABA と不一致: Elith ${parsed.wellnessAge} / 当社 ${input.ourWellnessAge}`);
  }

  for (const spec of specs) {
    const section = sec(spec.sourceKey);
    const title = titleOf(spec.key, spec.label, section);
    let built: DigestCardVM | null = null;

    switch (spec.key) {
      // ── 主軸 A ──────────────────────────────────────
      case 'cancer_finding': {
        const texts = cancerFindingTexts(parsed.cancerText, input);
        built = card(spec.key, title, 'a',
          parsed.cancerText ? '総評' : 'Elith へ依頼中 (spec §10.1 E-1)',
          [{ kind: 'paragraphs', items: texts }]);
        break;
      }

      // ── 主軸 B ──────────────────────────────────────
      case 'medical_visit': {
        if (!section) break;
        // 見出しの無い世代でも空にしない (`topicsOrWhole` のコメントを参照)。
        const blocks = topicsOrWhole(section);
        // 救急サインは別カードに切り出す。**赤はここだけ** (spec §4.2.1)。
        const emergency = findEmergencySentence(section.text);
        if (emergency) {
          const e = card('emergency', '', 'b', `${section.section_name}`,
            [{ kind: 'paragraphs', items: [emergency] }], 'emergency');
          if (e) digest.push(e);
        }
        const lead = blocks[0];
        const steps: DigestItem[] = blocks.slice(1).map((b) => ({
          heading: b.heading, text: leadSentences(b.body, 1),
        })).filter((s) => s.heading && s.text);
        built = card(spec.key, title, 'b',
          steps.length ? `${section.section_name} §1〜§${blocks.length}`
                       : `${section.section_name} 冒頭 2 文`, [
            ...(lead ? [{ kind: 'paragraphs' as const, items: [leadSentences(lead.body, 2)] }] : []),
            { kind: 'steps' as const, items: steps },
          ]);
        break;
      }

      case 'measurements': {
        // ダイジェストには **Elith が本文で取り上げた項目だけ**を出す (基準値が付いた行)。
        // 受領した全 40 項目は全編の章に出る (可読化 = 出す文を選ぶこと・spec §1.1)。
        // 判定が無い行 (実測: クレアチニン) も、Elith が触れている以上は落とさず
        // 判定欄を空で出す。「印が無い」を「基準値内」と読み替えない (ミッション④)。
        //
        // 並びは **Elith が本文で言及した順** (`measured.digestRows`・spec §1.3.10)。
        // 受領ファイルのキー順ではない。当社が優先順位を決めているのでもない。
        const rows = measured.digestRows;
        built = card(spec.key, title, 'b',
          `${section?.section_name ?? '検査値フィードバック'} (値・基準値・判定はすべて本文からの逐語)`,
          [{ kind: 'table', rows }]);
        break;
      }

      case 'lifestyle': {
        if (!section) break;
        const pairs = buildLifestylePairs(section.text);
        built = card(spec.key, title, 'b',
          `${section.section_name} §1〜§${pairs.length}（各節の【現状評価】【行動提案】冒頭文）`,
          [{ kind: 'pairs', items: pairs }]);
        break;
      }

      case 'diet_plan': {
        const diet = sec('diet');
        if (!diet) break;
        const plan = splitTopics(diet.text).find((b) => /食事改善プラン/.test(b.heading));
        if (!plan) break;
        const weeks = splitWeeks(plan.body);
        built = card(spec.key, spec.label || plan.heading, 'b',
          `${diet.section_name} §4`, [
            { kind: 'paragraphs', items: [leadSentences(plan.body.split('【第')[0], 2)] },
            { kind: 'weeks', items: weeks },
          ]);
        break;
      }

      case 'nutrients': {
        if (!section) break;
        const blocks = topicsOrWhole(section);
        const hasHeadings = blocks.some((b) => b.heading);
        // 見出しがある世代は各節の冒頭 1 文。無い世代は章の冒頭 2 文
        // (節が無いのに「§1〜§1」と書かないため、出典表記も分ける)。
        const items = hasHeadings
          ? blocks.map((b) => leadSentences(b.body, 1)).filter(Boolean)
          : [leadSentences(blocks[0]?.body ?? '', 2)].filter(Boolean);
        built = card(spec.key, title, 'b',
          hasHeadings ? `${section.section_name} §1〜§${blocks.length}`
                      : `${section.section_name} 冒頭 2 文`,
          [{ kind: 'paragraphs', items }]);
        break;
      }

      // それ以外の章はダイジェストに出さず、全編にだけ出す。
      default: break;
    }

    if (built) digest.push(built);
    else if (isDigestChapter(spec.key)) emptyCards.push(spec.key);
  }

  // ── 全編 ────────────────────────────────────────────
  const chapters: ChapterVM[] = [];
  for (const spec of specs) {
    const section = sec(spec.sourceKey);
    if (!section || !section.text.trim()) continue;
    const blocks = splitTopics(section.text);
    const topics: TopicVM[] = blocks.length
      ? blocks.map((b) => ({ anchor: anchorFor(spec.key, b.heading), heading: b.heading, body: b.body }))
      // 見出しの無い章 (アブストラクト / リファレンス) は章まるごと 1 トピック。
      : [{ anchor: anchorFor(spec.key, section.section_name), heading: '', body: section.text.trim() }];
    chapters.push({
      key: spec.key,
      title: titleOf(spec.key, spec.label, section),
      axis: spec.axis,
      collapsed: spec.collapsed,
      topics,
      ...(spec.key === 'measurements' ? { table: measured.rows } : {}),
    });
  }

  const cover: CoverVM = {
    name: input.name,
    issuedOn: input.issuedOn,
    sheetVersion: SHEET_VERSION,
    testedOn: firstCheckupDate(input.checkup),
    cycleSeq: input.cycleSeq,
    cycleTotal: CYCLE_TOTAL,
    wellnessAge: parsed.wellnessAge,
    chronologicalAge: input.chronologicalAge,
  };

  const audit: ReportAudit = {
    sections: parsed.sections.map((s) => s.section_name),
    digestCards: digest.map((c) => c.key),
    emptyCards,
    hiddenChapters: hidden,
    unknownChapterKeys: unknown,
    topicCount: chapters.reduce((n, c) => n + c.topics.length, 0),
    measurementCount: measured.rows.length,
    referenceCount: measured.rows.filter((r) => r.reference).length,
    anomalies,
  };

  return {
    reportType: input.hasCancerRisk ? 1 : 2,
    isSample: input.isSample,
    cover,
    axes: [...REPORT_AXES],
    digest,
    chapters,
    audit,
  };
}

// ── 補助 ────────────────────────────────────────────────

/** ダイジェストに出す想定の章か (出なかったら監査で「0 件」を報せる対象)。 */
function isDigestChapter(key: string): boolean {
  return ['cancer_finding', 'medical_visit', 'measurements', 'lifestyle', 'diet_plan', 'nutrients']
    .includes(key);
}

/**
 * A の「今回の所見」に出す文を決める (spec §4.0.1)。
 *   ① Elith が書いていれば**その本文**
 *   ② `ui.cancer_screening_not_included` (admin から入力・既定は空)
 *   ③ パイロット版の暫定文 (`PILOT_CANCER_FINDING_TEXT`・発注者指示)
 *
 * タイプ 1 で Elith の記述が無いのはイレギュラーなので、**カードごと非表示**にする
 * (アプリが代わりを書かない)。
 */
function cancerFindingTexts(cancerText: string | null, input: BuildInput): string[] {
  // ① Elith が書いていれば、その本文をそのまま。当社は但し書きを足さない
  //    (Stage2 では Elith 自身が「がんがないことを断定するものではない」と書いている)。
  if (cancerText) return [cancerText];
  // ② タイプ 1 で Elith の記述が無いのはイレギュラー。**カードごと非表示**にして、
  //    アプリが代わりを書かない。欠落は監査に出る (spec §4.0.1「記載が無いこと ≠ 所見が無いこと」)。
  if (input.hasCancerRisk) return [];
  // ③ タイプ 2。admin で文言が確定していればそれを使う。
  const fallback = (input.cancerFallbackText ?? '').trim();
  if (fallback) return [fallback];
  // ④ パイロット版のみの暫定文 (発注者指示・上の定数のコメントを参照)。
  return [...PILOT_CANCER_FINDING_TEXT];
}

/** Elith が救急受診を促した文を 1 文だけ逐語で取り出す。無ければ null。 */
function findEmergencySentence(text: string): string | null {
  for (const raw of text.split('。')) {
    const s = raw.trim();
    if (s && EMERGENCY_RE.test(s)) return `${s}。`;
  }
  return null;
}

/** `lifestyle` を【現状評価】/【行動提案】のペアにする (spec §4.2.2)。 */
export function buildLifestylePairs(text: string): LifestylePair[] {
  const out: LifestylePair[] = [];
  for (const b of splitByHash(text)) {
    const cur = b.body.split('【現状評価】')[1]?.split('【行動提案】')[0] ?? '';
    const act = b.body.split('【行動提案】')[1] ?? '';
    const current = leadSentences(cur, 1);
    const action = leadSentences(act, 1);
    if (!current && !action) continue;
    out.push({ heading: b.heading, current, action });
  }
  return out;
}

/** `【第1週】…` を週ごとに割る。 */
function splitWeeks(text: string): DigestItem[] {
  const out: DigestItem[] = [];
  const parts = text.split(/【(第\s*\d+\s*週)】/);
  for (let i = 1; i < parts.length; i += 2) {
    const t = leadSentences(parts[i + 1] ?? '', 1);
    if (t) out.push({ heading: parts[i].replace(/\s+/g, ''), text: t });
  }
  return out;
}

/** 受領 `health_checkup.json` から検査日を 1 つ取る。 */
function firstCheckupDate(
  checkup: Record<string, { date?: string; value?: unknown }[]> | null,
): string | null {
  for (const arr of Object.values(checkup ?? {})) {
    const d = Array.isArray(arr) ? arr[0]?.date : undefined;
    if (typeof d === 'string' && d) return d;
  }
  return null;
}

/** 全編の章のうち、ダイジェストに同じ内容を出したもの (章側では畳んでよい)。 */
export const DIGEST_BACKED_CHAPTERS = new Set(['medical_visit', 'lifestyle', 'nutrients']);

/** レジストリの既定キー一覧 (admin の監査表示で使う)。 */
export const ALL_CHAPTER_KEYS = CHAPTER_REGISTRY.map((c) => c.key);
