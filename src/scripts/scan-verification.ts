/**
 * 撮影 → AI 解析の結果を、ブロック (領域) 単位で
 * 「読込精度メトリクス + 画像参照 + 確認/編集」できる検証 UI コントローラ。
 *
 * 設計根拠:
 * - docs/scan_chat_medical_ai_proposal.pdf: 視覚フィードバックでユーザの不安を払拭
 * - docs/scan_feature_requirements.md F-5/F-6: 緑/黄色分け、デジタルオーバーレイ
 * - docs/diagnostic_session_data_spec.md §3.2: scan_md はユーザー検証フェーズを
 *   通過した「確定 Markdown」であり、Gemini 生出力はそのまま永続化されない
 * - docs/system_architecture_overview.md §11 リスク表: 「不明値は (?) + 目視確認 UI」
 *
 * 検証状態は localStorage に diagnostic_id 単位で保存し、再来訪時に復元する。
 * (Scan-Chat-AI 自体はステートレス、永続化はクライアント側のみ — Phase 0)
 */

import { marked } from 'marked';
import type { AnalyzeResult, RegionResult } from './camera-scan';

// ============================================================
// メトリクス計算
// ============================================================

export interface RegionMetrics {
  /** GFM テーブルのデータ行数 (ヘッダ + 区切り行を除く) */
  totalRows: number;
  /** 備考に【要確認】系タグまたは値に (?) を含む行 */
  flaggedRows: number;
  /** 結果値に [強調] 注記、または H/L マーカが付いた行 */
  abnormalRows: number;
  /** 表 (GFM テーブル) がそもそも領域内にあるか */
  hasTable: boolean;
}

/** Markdown 1 領域分の本文から、表示用メトリクスを算出 */
export function computeRegionMetrics(body: string): RegionMetrics {
  let totalPipeRows = 0;
  let separatorRows = 0;
  let flaggedRows = 0;
  let abnormalRows = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // 区切り行: `|---|---|` のように `:`/`-`/空白/パイプ のみで構成
    if (/^\|[\s\-:|]+\|?$/.test(trimmed)) {
      separatorRows++;
      continue;
    }
    totalPipeRows++;
    if (/【要確認】|【不整合】|【欠落】|【混線】|【捏造】|\(\?\)|\?\?/.test(line)) {
      flaggedRows++;
    }
    if (/\[強調\]|[\s|]\s*[HL]\s*[\s|]/.test(line)) {
      abnormalRows++;
    }
  }
  // 表 1 つあたりヘッダ行 1 = 区切り行数 と等しい想定
  const totalRows = Math.max(0, totalPipeRows - separatorRows);
  return {
    totalRows,
    flaggedRows,
    abnormalRows,
    hasTable: separatorRows > 0,
  };
}

// ============================================================
// 領域ステータス判定 (緑/黄/赤)
// ============================================================

export type RegionStatus = 'green' | 'yellow' | 'red';

/** メトリクスから領域全体のステータスを 1 色で代表する */
export function regionStatus(body: string, metrics: RegionMetrics): RegionStatus {
  if (!body.trim()) return 'red';
  if (metrics.flaggedRows > 0) return 'yellow';
  // 表が無いがテキストはある (手書きメモ等) は緑扱い
  return 'green';
}

// ============================================================
// 編集後の Markdown 再構築
// ============================================================

/**
 * 領域配列 + 編集された本文 → 完全な scan_md (clean = 推論値除去済) を再構築する。
 * docs/diagnostic_session_data_spec.md §3.2 の確定 scan_md フォーマット準拠。
 */
export function assembleMarkdownClean(
  regions: RegionResult[],
  editedBodies: Record<number, string>,
): string {
  const out: string[] = [];
  regions.forEach((region, idx) => {
    out.push(`## ${region.label}`);
    if (region.bbox) {
      out.push(`<!-- bbox: ${region.bbox.map((n) => n.toFixed(2)).join(',')} -->`);
    }
    out.push('');
    const body = editedBodies[idx] ?? region.body;
    out.push(body);
    out.push('');
  });
  return out.join('\n').trim() + '\n';
}

// ============================================================
// 検証状態 (localStorage 永続化)
// ============================================================

interface VerificationState {
  /** 領域インデックス → 確認済みフラグ */
  verifiedRegions: Record<number, boolean>;
  /** 領域インデックス → 編集後の本文 (未編集なら未設定) */
  editedBodies: Record<number, string>;
}

function storageKey(diagnosticId: string): string {
  return `scan-chat-ai.verification.${diagnosticId}`;
}

function loadState(diagnosticId: string): VerificationState {
  if (typeof window === 'undefined') {
    return { verifiedRegions: {}, editedBodies: {} };
  }
  const raw = window.localStorage.getItem(storageKey(diagnosticId));
  if (!raw) return { verifiedRegions: {}, editedBodies: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<VerificationState>;
    return {
      verifiedRegions: parsed.verifiedRegions ?? {},
      editedBodies: parsed.editedBodies ?? {},
    };
  } catch {
    return { verifiedRegions: {}, editedBodies: {} };
  }
}

function saveState(diagnosticId: string, state: VerificationState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(diagnosticId), JSON.stringify(state));
}

// ============================================================
// 検証 UI コントローラ
// ============================================================

export interface VerificationRefs {
  /** カード一覧の <ul> */
  itemsList: HTMLElement;
  /** 下流送信 markdown プレビュー <pre> */
  downstreamPreview: HTMLElement;
  /** 「N 領域を読み取りました」表示 <p> */
  resultCount: HTMLElement;
  /** 「問診を開始する」リンク */
  startChatBtn: HTMLAnchorElement;
  /** 開始ボタン下のヒント表示要素 */
  startChatHint: HTMLElement;
}

interface CardElements {
  article: HTMLElement;
  body: HTMLElement;
  edit: HTMLElement;
  textarea: HTMLTextAreaElement;
  image: HTMLElement;
  badge: HTMLElement;
  verifyBtn: HTMLButtonElement;
}

const STATUS_COLOR: Record<RegionStatus, string> = {
  green:
    'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/30',
  yellow:
    'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/30',
  red: 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-900/30',
};

const STATUS_TEXT: Record<RegionStatus, string> = {
  green: 'text-emerald-800 dark:text-emerald-200',
  yellow: 'text-amber-800 dark:text-amber-200',
  red: 'text-rose-800 dark:text-rose-200',
};

const STATUS_LABEL: Record<RegionStatus, string> = {
  green: '✓ OK',
  yellow: '⚠ 要確認',
  red: '✗ 要対応',
};

export class ScanVerificationController {
  private cards: CardElements[] = [];
  private state: VerificationState;

  constructor(
    private refs: VerificationRefs,
    private result: AnalyzeResult,
    private diagnosticId: string,
  ) {
    this.state = loadState(diagnosticId);
  }

  async render(): Promise<void> {
    marked.setOptions({ gfm: true, breaks: false });

    const regions = this.result.regions ?? [];
    if (regions.length === 0) {
      this.refs.itemsList.innerHTML =
        '<li class="px-4 py-6 text-center text-sm text-slate-500">領域は検出されませんでした</li>';
      this.refs.resultCount.textContent = '解析結果が空でした';
      this.updateDownstreamPreview();
      this.updateGate();
      return;
    }

    // 全領域分のカードを並べる
    this.refs.itemsList.innerHTML = '';
    this.cards = [];
    for (let idx = 0; idx < regions.length; idx++) {
      const card = await this.buildRegionCard(regions[idx], idx);
      this.cards.push(card);
      const li = document.createElement('li');
      li.className = 'px-3 py-3 md:px-4';
      li.appendChild(card.article);
      this.refs.itemsList.appendChild(li);
    }

    this.updateResultCount();
    this.updateDownstreamPreview();
    this.updateGate();
  }

  /** 現在の確定 scan_md (= 編集反映後の markdownClean) を取得 */
  getFinalMarkdown(): string {
    return assembleMarkdownClean(
      this.result.regions ?? [],
      this.state.editedBodies,
    );
  }

  // ----------------------------------------------------------
  // カード生成
  // ----------------------------------------------------------

  private async buildRegionCard(
    region: RegionResult,
    idx: number,
  ): Promise<CardElements> {
    const currentBody = this.state.editedBodies[idx] ?? region.body;
    const metrics = computeRegionMetrics(currentBody);
    const status = this.computeStatus(idx, currentBody, metrics);

    const article = document.createElement('article');
    article.dataset.regionIdx = String(idx);

    // body (rendered markdown)
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'md-region mt-3';
    bodyDiv.innerHTML = await marked.parse(currentBody || '');

    // image area (toggle-on demand)
    const imageDiv = document.createElement('div');
    imageDiv.className = 'mt-3';
    imageDiv.hidden = true;
    imageDiv.innerHTML = this.renderImageOverlay(region);

    // edit area
    const editDiv = document.createElement('div');
    editDiv.className = 'mt-3 space-y-2';
    editDiv.hidden = true;
    const textarea = document.createElement('textarea');
    textarea.className =
      'w-full min-h-[12rem] rounded-lg border border-slate-300 bg-white p-2 font-mono text-xs leading-relaxed text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';
    textarea.value = currentBody;
    textarea.spellcheck = false;
    const editButtonRow = document.createElement('div');
    editButtonRow.className = 'flex gap-2';
    editButtonRow.innerHTML = `
      <button type="button" data-action="save" data-region="${idx}" class="btn-primary !py-2 !text-xs">保存</button>
      <button type="button" data-action="cancel" data-region="${idx}" class="btn-secondary !py-2 !text-xs">キャンセル</button>
    `;
    editDiv.append(textarea, editButtonRow);

    // header (label, status badge)
    const badge = document.createElement('span');
    badge.className =
      'rounded-full bg-white/70 px-2 py-0.5 text-xs font-medium dark:bg-slate-900/60';
    badge.textContent = STATUS_LABEL[status];

    // metrics summary line
    const metricsLine = document.createElement('p');
    metricsLine.className = 'mt-1 text-xs text-slate-600 dark:text-slate-400';
    metricsLine.textContent = this.formatMetrics(metrics);

    // action buttons
    const actionRow = document.createElement('div');
    actionRow.className = 'mt-2 flex flex-wrap gap-2';
    const verifyBtn = this.makeVerifyButton(idx);
    actionRow.appendChild(verifyBtn);
    actionRow.appendChild(this.makeButton('✏️ 修正', 'edit', idx, 'btn-secondary !py-1.5 !text-xs'));
    actionRow.appendChild(this.makeButton('🖼️ 撮影画像', 'toggle-image', idx, 'btn-secondary !py-1.5 !text-xs'));

    const bboxNote = region.bbox
      ? `<span class="ml-2 text-[10px] font-normal text-slate-400">bbox=[${region.bbox.map((n) => n.toFixed(2)).join(',')}]</span>`
      : '';

    const header = document.createElement('header');
    header.className = 'flex items-center justify-between gap-2';
    header.innerHTML = `
      <h4 class="flex items-baseline gap-2 text-sm font-semibold md:text-base ${STATUS_TEXT[status]}">
        <span class="text-xs text-slate-500">#${idx + 1}</span>${escapeHtml(region.label)}${bboxNote}
      </h4>
    `;
    header.appendChild(badge);

    article.className = `rounded-2xl border ${STATUS_COLOR[status]} p-3 md:p-4 transition-colors`;
    article.append(header, metricsLine, actionRow, imageDiv, bodyDiv, editDiv);

    // event delegation
    article.addEventListener('click', (ev) => this.onClick(ev));

    return {
      article,
      body: bodyDiv,
      edit: editDiv,
      textarea,
      image: imageDiv,
      badge,
      verifyBtn,
    };
  }

  private makeVerifyButton(idx: number): HTMLButtonElement {
    const verified = !!this.state.verifiedRegions[idx];
    const btn = this.makeButton(
      verified ? '✓ 確認済み (取消)' : '✓ 確認済みにする',
      'verify',
      idx,
      verified ? 'btn-primary !py-1.5 !text-xs' : 'btn-secondary !py-1.5 !text-xs',
    );
    return btn;
  }

  private makeButton(
    text: string,
    action: string,
    idx: number,
    cls: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.action = action;
    btn.dataset.region = String(idx);
    btn.className = cls;
    btn.textContent = text;
    return btn;
  }

  private renderImageOverlay(region: RegionResult): string {
    const src = this.result.fullImage;
    if (!src) {
      return '<p class="text-xs text-slate-500">撮影画像がありません</p>';
    }
    let overlay = '';
    if (region.bbox) {
      const [ymin, xmin, ymax, xmax] = region.bbox;
      const top = (ymin * 100).toFixed(2);
      const left = (xmin * 100).toFixed(2);
      const height = ((ymax - ymin) * 100).toFixed(2);
      const width = ((xmax - xmin) * 100).toFixed(2);
      overlay = `
        <div class="pointer-events-none absolute rounded border-2 border-emerald-400/90 bg-emerald-300/15"
          style="top:${top}%;left:${left}%;height:${height}%;width:${width}%;"></div>
      `;
    }
    return `
      <div class="relative overflow-hidden rounded-xl border border-slate-300 dark:border-slate-700">
        <img src="${src}" alt="撮影画像" class="block w-full" />
        ${overlay}
      </div>
      <p class="mt-1 text-[10px] text-slate-500">緑枠 = この領域に AI が割り当てたエリア。紙と比較してください。</p>
    `;
  }

  // ----------------------------------------------------------
  // イベントハンドラ
  // ----------------------------------------------------------

  private onClick(ev: Event): void {
    const target = ev.target as HTMLElement;
    const btn = target.closest('button[data-action]') as HTMLButtonElement | null;
    if (!btn) return;
    const idx = Number(btn.dataset.region);
    if (Number.isNaN(idx)) return;
    switch (btn.dataset.action) {
      case 'toggle-image':
        this.toggleImage(idx);
        break;
      case 'verify':
        this.toggleVerify(idx);
        break;
      case 'edit':
        this.enterEdit(idx);
        break;
      case 'save':
        void this.saveEdit(idx);
        break;
      case 'cancel':
        this.cancelEdit(idx);
        break;
    }
  }

  private toggleImage(idx: number): void {
    const card = this.cards[idx];
    if (!card) return;
    card.image.hidden = !card.image.hidden;
  }

  private toggleVerify(idx: number): void {
    this.state.verifiedRegions[idx] = !this.state.verifiedRegions[idx];
    this.persist();
    this.refreshHeader(idx);
    this.updateGate();
  }

  private enterEdit(idx: number): void {
    const card = this.cards[idx];
    if (!card) return;
    card.body.hidden = true;
    card.edit.hidden = false;
    card.textarea.focus();
  }

  private cancelEdit(idx: number): void {
    const card = this.cards[idx];
    if (!card) return;
    // textarea の中身を最新の保存済 body に巻き戻す
    const region = (this.result.regions ?? [])[idx];
    card.textarea.value = this.state.editedBodies[idx] ?? region?.body ?? '';
    card.edit.hidden = true;
    card.body.hidden = false;
  }

  private async saveEdit(idx: number): Promise<void> {
    const card = this.cards[idx];
    if (!card) return;
    const newBody = card.textarea.value;
    const region = (this.result.regions ?? [])[idx];
    const original = region?.body ?? '';
    if (newBody === original) {
      // 元と同じなら編集状態を解除
      delete this.state.editedBodies[idx];
    } else {
      this.state.editedBodies[idx] = newBody;
    }
    this.persist();
    // 表示を再生成
    card.body.innerHTML = await marked.parse(newBody);
    card.edit.hidden = true;
    card.body.hidden = false;
    this.refreshHeader(idx);
    this.updateResultCount();
    this.updateDownstreamPreview();
    this.updateGate();
  }

  // ----------------------------------------------------------
  // 派生表示の更新
  // ----------------------------------------------------------

  private refreshHeader(idx: number): void {
    const card = this.cards[idx];
    if (!card) return;
    const region = (this.result.regions ?? [])[idx];
    if (!region) return;
    const currentBody = this.state.editedBodies[idx] ?? region.body;
    const metrics = computeRegionMetrics(currentBody);
    const status = this.computeStatus(idx, currentBody, metrics);
    card.article.className = `rounded-2xl border ${STATUS_COLOR[status]} p-3 md:p-4 transition-colors`;
    card.badge.textContent = STATUS_LABEL[status];

    // ヘッダの色を更新
    const h4 = card.article.querySelector('h4');
    if (h4) {
      h4.className = `flex items-baseline gap-2 text-sm font-semibold md:text-base ${STATUS_TEXT[status]}`;
    }
    // メトリクス行も更新
    const metricsP = card.article.querySelectorAll('p')[0] as HTMLElement | undefined;
    if (metricsP) metricsP.textContent = this.formatMetrics(metrics);
    // 確認済みボタンのラベル更新
    const newVerifyBtn = this.makeVerifyButton(idx);
    card.verifyBtn.replaceWith(newVerifyBtn);
    card.verifyBtn = newVerifyBtn;
  }

  private updateResultCount(): void {
    const regions = this.result.regions ?? [];
    let totalRows = 0;
    let totalFlagged = 0;
    for (let i = 0; i < regions.length; i++) {
      const body = this.state.editedBodies[i] ?? regions[i].body;
      const m = computeRegionMetrics(body);
      totalRows += m.totalRows;
      totalFlagged += m.flaggedRows;
    }
    const parts = [`${regions.length} 領域`];
    if (totalRows) parts.push(`${totalRows} 行`);
    if (totalFlagged) parts.push(`${totalFlagged} 件 要確認`);
    this.refs.resultCount.textContent = parts.join(' / ') + ' を読み取りました';
  }

  private updateDownstreamPreview(): void {
    this.refs.downstreamPreview.textContent =
      this.getFinalMarkdown() || '(empty)';
  }

  private updateGate(): void {
    const regions = this.result.regions ?? [];
    const verifiedCount = regions.filter(
      (_, i) => !!this.state.verifiedRegions[i],
    ).length;
    const total = regions.length;
    const allVerified = total > 0 && verifiedCount === total;
    if (allVerified) {
      this.refs.startChatHint.textContent =
        '✓ すべての領域を確認済みにしました';
      this.refs.startChatHint.className =
        'text-center text-xs text-emerald-700 dark:text-emerald-400';
    } else {
      const remaining = total - verifiedCount;
      this.refs.startChatHint.textContent =
        total === 0
          ? ''
          : `⚠ 未確認の領域が ${remaining} 件あります (このまま進むこともできます)`;
      this.refs.startChatHint.className =
        'text-center text-xs text-amber-700 dark:text-amber-400';
    }
  }

  // ----------------------------------------------------------
  // ヘルパー
  // ----------------------------------------------------------

  private computeStatus(
    idx: number,
    body: string,
    metrics: RegionMetrics,
  ): RegionStatus {
    if (this.state.verifiedRegions[idx]) return 'green';
    return regionStatus(body, metrics);
  }

  private formatMetrics(m: RegionMetrics): string {
    if (!m.hasTable) return '手書きメモ / 自由テキスト';
    const parts = [`${m.totalRows} 項目`];
    if (m.flaggedRows) parts.push(`${m.flaggedRows} 要確認`);
    if (m.abnormalRows) parts.push(`${m.abnormalRows} 異常値`);
    return parts.join(' / ');
  }

  private persist(): void {
    saveState(this.diagnosticId, this.state);
  }
}

// ============================================================
// 内部ヘルパー
// ============================================================

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
