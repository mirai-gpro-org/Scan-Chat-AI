/**
 * 「手元に残す」— 端末別の保存手順 (spec §4.4 手段 A)。
 *
 * 【なぜ端末別か】
 *   以前は **iPhone 1 機種ぶんの手順しか無く**、Windows・Mac・Android にも同じ文が出ていた。
 *   PC には「共有ボタン」も「指 2 本で広げる」も無いので、読んでも実行できない
 *   (テストユーザーから「分かり難い」・2026-09-02)。
 *
 * 【手順は公式の一次資料から起こす (R3)】
 *   旧手順の「出てきた紙面を指 2 本で広げると PDF になります」は**公式に無い**。
 *   Apple が案内している経路は 共有 →「マークアップ」→「完了」→「ファイルを保存」で、
 *   プリント画面もピンチ操作も通らない。**旧手順より 1 手少なく、ジェスチャも要らない。**
 *   出典は各 guide の `source` に URL で残す (記憶で書き足さない)。
 *
 * 【文言は app_config から差し替えられる】
 *   OS の更新でメニュー名は変わる。`ui.save_steps` で admin から直せる (再デプロイ不要)。
 *   上書きは**素の文字列**になる (強調やキーキャップは付かない) — 語を直すための口であって、
 *   紙面の意匠を admin から作るための口ではない。
 */

export type SavePlatform = 'windows' | 'mac' | 'iphone' | 'android';

/** 手順 1 行の構成要素。**HTML を文字列で持たない** (画面側がタグを組む)。 */
export type StepPart = string | { b: string } | { kbd: string };

export interface SaveStep {
  parts: StepPart[];
  /**
   * **ボタンが代わりに開いてくれる操作。**
   * PC ではボタンを押すと印刷ダイアログが直接開く (案 3) ので、この行は出さない。
   * JavaScript が動かない環境では**出したままにする** — 自力で開く必要があるため。
   */
  opensDialog?: boolean;
}

export interface SaveGuide {
  key: SavePlatform;
  /** 端末を選び直すボタンのラベル。 */
  label: string;
  /** 手順の見出し。 */
  heading: string;
  /**
   * `desktop` … ボタンで印刷ダイアログを直接開く (`?print=1&autoprint=1`)。
   * `mobile`  … ボタンは印刷ビューを開くだけ。保存はブラウザのメニューから行う。
   */
  kind: 'desktop' | 'mobile';
  steps: SaveStep[];
  /** 補足 1 文。ブラウザ違いなど、手順に混ぜると長くなるものだけ。 */
  note?: string;
  /** 手順の出典 (一次資料)。 */
  source: string;
}

const b = (s: string): StepPart => ({ b: s });
const kbd = (s: string): StepPart => ({ kbd: s });

export const SAVE_GUIDES: readonly SaveGuide[] = [
  {
    key: 'windows',
    label: 'Windows',
    heading: 'Windows で保存する',
    kind: 'desktop',
    steps: [
      { parts: [kbd('Ctrl'), '＋', kbd('P'), ' を押します'], opensDialog: true },
      { parts: ['「送信先」で ', b('PDF に保存'), ' を選びます'] },
      { parts: [b('保存'), ' を押して、置き場所を選びます'] },
    ],
    // https://support.google.com/chrome/answer/1069693 (パソコン)
    source: 'Google「Chrome から印刷する」パソコン',
  },
  {
    key: 'mac',
    label: 'Mac',
    heading: 'Mac で保存する',
    kind: 'desktop',
    steps: [
      { parts: [kbd('⌘'), '＋', kbd('P'), ' を押します'], opensDialog: true },
      { parts: ['画面の下の ', b('PDF'), ' を押して、「', b('PDFとして保存'), '」を選びます'] },
      { parts: [b('保存'), ' を押して、置き場所を選びます'] },
    ],
    note: 'Chrome をお使いのときは、「送信先」で「PDF に保存」を選びます。',
    // https://support.apple.com/ja-jp/guide/safari/ibrw1060/mac
    source: 'Apple「MacのSafariでWebページのPDFをプリントする/作成する」',
  },
  {
    key: 'iphone',
    label: 'iPhone',
    heading: 'iPhone・iPad で保存する',
    kind: 'mobile',
    steps: [
      { parts: ['画面の下（または上）の ', b('共有'), '（□に↑の形）を押します'] },
      { parts: ['', b('マークアップ'), ' を選び、', b('完了'), ' を押します'] },
      { parts: ['「', b('ファイルを保存'), '」を押し、名前をつけて ', b('保存'), ' します'] },
    ],
    // https://support.apple.com/ja-jp/guide/iphone/iphfd5b616b5/ios
    source: 'Apple「iPhoneのSafariでWebページをPDFとして保存する」',
  },
  {
    key: 'android',
    label: 'Android',
    heading: 'Android で保存する',
    kind: 'mobile',
    steps: [
      { parts: ['右上の ', b('⋮'), ' を押して、', b('共有'), ' を選びます'] },
      { parts: ['', b('印刷'), ' を選びます'] },
      { parts: ['上のプリンタで ', b('PDF として保存'), ' を選び、', b('保存'), ' を押します'] },
    ],
    // https://support.google.com/chrome/answer/1069693 (Android)
    source: 'Google「Chrome から印刷する」Android',
  },
] as const;

/**
 * `ui.save_steps` の上書きを当てる。
 *
 * 書式 = `端末キー=手順1｜手順2｜手順3` をカンマ区切り
 * (`report.sections.labels` と同じ `key=value` 方式)。
 * 区切りは**全角の縦棒 `｜`** — 手順文に読点は出るが縦棒は出ないため。
 *
 * **fail-safe**: 解釈できない端末キー・空の手順は無視してコード既定のまま
 * (打ち間違いで保存手順が消えると、利用者は控えを残せなくなる)。
 */
export function applySaveStepOverrides(raw: string): SaveGuide[] {
  const base = SAVE_GUIDES.map((g) => ({ ...g, steps: g.steps.map((s) => ({ ...s })) }));
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const guide = base.find((g) => g.key === key);
    if (!guide) continue;
    const steps = pair
      .slice(eq + 1)
      .split('｜')
      .map((s) => s.trim())
      .filter(Boolean);
    // 空の上書きでは消さない。**手順が 1 行も無い状態を作らない。**
    if (!steps.length) continue;
    guide.steps = steps.map((s) => ({ parts: [s] }));
  }
  return base;
}
