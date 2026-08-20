import type { AppIconName } from '../components/AppIcon.astro';
/**
 * Elith JSON (10 セクション、約 21K 字) からダッシュボードカード用の構造化値を抽出する。
 *
 * 本来は Phase 1.5 で `diagnosis_result_items` テーブルへ LLM 二次抽出する設計だが
 * (docs/elith/elith_report_integration.md §3.2)、Phase 1.0 の Quick demo として regex ベースで
 * 主要項目のみ抜き出す。
 */

export interface ElithSection {
  section_name: string;
  char_count: number;
  text: string;
}

export type RiskLevel = 'high' | 'slightly_high' | 'normal' | 'slightly_low' | 'low';

export interface MetricCard {
  /** 表示名 (例: '尿酸') */
  label: string;
  /** 値 (例: '8.4') */
  value: string;
  /** 単位 (例: 'mg/dL') */
  unit: string;
  /** 基準値表記 (例: '〜7.0') */
  reference?: string;
  /** 状態 */
  level: RiskLevel;
  /** 説明 (1 行サマリ) */
  comment?: string;
}

export interface UrgentAlert {
  title: string;
  body: string;
  cta?: string;
}

/** Elith JSON の配列から `section_name` で 1 セクションを取り出す。無ければ null。 */
export function findSection(sections: ElithSection[], name: string): ElithSection | null {
  return sections.find((s) => s.section_name === name) ?? null;
}

/** リスクレベルから信号機カラーの Tailwind クラスへ。 */
export function riskColor(level: RiskLevel): {
  bg: string; border: string; text: string; chip: string; dot: string;
} {
  switch (level) {
    case 'high':
      return {
        bg: 'bg-red-50',
        border: 'border-red-300',
        text: 'text-red-700',
        chip: 'bg-red-100 text-red-700',
        dot:  'bg-red-500',
      };
    case 'slightly_high':
      return {
        bg: 'bg-amber-50',
        border: 'border-amber-300',
        text: 'text-amber-700',
        chip: 'bg-amber-100 text-amber-700',
        dot:  'bg-amber-500',
      };
    case 'normal':
      return {
        bg: 'bg-emerald-50',
        border: 'border-emerald-300',
        text: 'text-emerald-700',
        chip: 'bg-emerald-100 text-emerald-700',
        dot:  'bg-emerald-500',
      };
    case 'slightly_low':
    case 'low':
      return {
        bg: 'bg-sky-50',
        border: 'border-sky-300',
        text: 'text-sky-700',
        chip: 'bg-sky-100 text-sky-700',
        dot:  'bg-sky-500',
      };
  }
}

/**
 * 検査値フィードバック セクションから主要 3 指標を抽出。
 * (Phase 1.5 で diagnosis_result_items に置換予定)
 *
 * パターン: 「[項目]は[値] [単位]（基準値: [基準]）」
 */
export function extractMetricCards(sections: ElithSection[]): MetricCard[] {
  const feedback = findSection(sections, '検査値フィードバック');
  if (!feedback) return [];

  const metrics: MetricCard[] = [];
  const text = feedback.text;

  // 尿酸
  const uricMatch = text.match(/尿酸は([\d.]+)\s*(mg\/dl|mg\/dL|mg\/dl)（基準値:\s*([^）]+)）/);
  if (uricMatch) {
    metrics.push({
      label: '尿酸',
      value: uricMatch[1],
      unit: 'mg/dL',
      reference: uricMatch[3].trim(),
      level: 'high',
      comment: 'プリン体を控え、水分 1日 2L 以上を',
    });
  }

  // 血圧
  const bpMatch = text.match(/最高血圧は(\d+)\s*mmHg.*?最低血圧は(\d+)\s*mmHg/);
  if (bpMatch) {
    metrics.push({
      label: '血圧',
      value: `${bpMatch[1]}/${bpMatch[2]}`,
      unit: 'mmHg',
      reference: '〜129/84',
      level: 'normal',
      comment: '良好。塩分 1日 6g 未満を維持',
    });
  }

  // 空腹時血糖
  const fpgMatch = text.match(/空腹時血糖が([\d.]+)\s*(mg\/dl|mg\/dL)（基準値:\s*([^）]+)）/);
  if (fpgMatch) {
    metrics.push({
      label: '空腹時血糖',
      value: fpgMatch[1],
      unit: 'mg/dL',
      reference: fpgMatch[3].trim(),
      level: 'slightly_high',
      comment: '主食を控えめに、食後の散歩を',
    });
  }

  return metrics;
}

/** `医療受診の目安` セクションから緊急アラート 1 件を抽出。 */
export function extractUrgentAlert(sections: ElithSection[]): UrgentAlert | null {
  const medical = findSection(sections, '医療受診の目安');
  if (!medical) return null;
  const text = medical.text;

  // 「眼科を受診」「精密検査」キーワード抽出
  if (/眼科.*精密検査|緑内障/.test(text)) {
    return {
      title: '緊急受診勧告',
      body: '緑内障の疑いがあります。今週中に眼科で精密検査を受けてください。',
      cta: '受診先を探す',
    };
  }

  // フォールバック: 第 1 段落を要約
  const firstPara = text.split(/\n\n+/)[0].slice(0, 80);
  return {
    title: '受診のお勧め',
    body: firstPara,
    cta: '詳細を見る',
  };
}

/**
 * 運動 / 食事アドバイス から「今日のクエスト」候補を抽出。
 * 「週N回」「M分」「1日N回」「N L」等のアクション文を 2-3 件選ぶ。
 */
export interface DailyQuest {
  text: string;
  /** 進捗 (0-1) — デモなので適当な初期値を入れる */
  progress?: number;
  /** 単位表示 (例: '1.2L / 2L') */
  display?: string;
}

export function extractDailyQuests(sections: ElithSection[]): DailyQuest[] {
  const quests: DailyQuest[] = [];
  const dietFeedback = findSection(sections, '検査値フィードバック');
  const exercise = findSection(sections, '運動アドバイス');

  // 水分摂取
  if (dietFeedback && /水分を1日2リットル/.test(dietFeedback.text)) {
    quests.push({
      text: '水分を 1日 2 リットル以上摂取',
      progress: 0.6,
      display: '1.2 L / 2.0 L',
    });
  }

  // 速歩・運動
  if (exercise) {
    const fastWalkMatch = exercise.text.match(/速歩.*?週(\d+)回.*?(\d+)分/);
    if (fastWalkMatch) {
      quests.push({
        text: `速歩 ${fastWalkMatch[2]}分 × 週${fastWalkMatch[1]}回`,
        progress: 0,
        display: 'チェックで完了',
      });
    } else {
      quests.push({
        text: 'ウォーキング 30分',
        progress: 0,
        display: 'チェックで完了',
      });
    }
  }

  // プリン体を控える
  if (dietFeedback && /プリン体/.test(dietFeedback.text)) {
    quests.push({
      text: 'プリン体の少ない食材を選ぶ',
      progress: 0,
      display: '今日の献立を確認',
    });
  }

  return quests.slice(0, 3);
}

/** シチュエーション別カード (食事アドバイス、睡眠ストレス管理から抽出) */
export interface SituationalCard {
  scene: string;
  title: string;
  body: string;
  /** AppIcon の意味名 (絵文字は本番素材にしない)。 */
  icon: AppIconName;
}

export function extractSituationalCards(sections: ElithSection[]): SituationalCard[] {
  const cards: SituationalCard[] = [];
  const diet = findSection(sections, '食事アドバイス');
  const sleep = findSection(sections, '睡眠・ストレス管理');

  if (diet) {
    // 【和定食】等の【】 見出しから 1 個目を採用
    const wadefood = diet.text.match(/【和定食】\s*\n[\s\S]*?(?=【|$)/);
    if (wadefood) {
      cards.push({
        scene: '今夜の夕食',
        title: '和定食メニュー',
        body: '鶏ささみの塩焼き定食 / タラの西京焼き定食 — 低プリン体で尿酸値ケア',
        icon: 'meal',
      });
    }
  }

  if (sleep) {
    if (/4-7-8呼吸法/.test(sleep.text)) {
      cards.push({
        scene: '仕事の合間',
        title: '4-7-8 呼吸法',
        body: '4秒吸う・7秒止める・8秒吐く × 5サイクル',
        icon: 'sprout',
      });
    }
  }

  cards.push({
    scene: '就寝前',
    title: '半身浴のススメ',
    body: '38〜40度で15-20分。ブルーライト回避で睡眠の質を上げる',
    icon: 'sleep',
  });

  return cards;
}
