/**
 * 撮影 → AI 解析 → 「ユーザー検証」フェーズの UI コントローラ。
 *
 * ユーザーが経るフロー (docs/scan_chat_medical_ai_proposal.pdf + 5/24 仕様確認):
 *   1. 撮影画像から「表全体」だけを切り出した画像を上部に表示
 *   2. 各ブロック (region) を bbox に基づいて緑/黄/赤の半透明矩形でオーバーレイ
 *   3. ブロックをタップ → そのブロックの表データをテキスト一覧表示。
 *      確度高 = 緑、疑念あり = 黄。
 *   4. 疑念行をタップ → 手入力修正 or 「このまま OK」を選択
 *   5. 全疑念が解消されると画像オールグリーンになり「確認して送信」が活性化
 *      → /chat に遷移 (Phase 0、データはメモリ保持)
 *
 * 永続化 (docs/diagnostic_session_data_spec.md §3.2):
 *   - Gemini 生 markdown は scan_artifacts.content に**そのまま保存されない**
 *   - 確定 scan_md = ユーザー検証 (編集 + userConfirmed) を反映した markdownClean
 *   - 現状は localStorage に diagnostic_id 単位で行状態を保存し、ページ再ロード時に復元
 */

import { marked } from 'marked';
import type { AnalyzeResult, RegionResult } from './camera-scan';

// ============================================================
// 公開ヘルパー: テーブル解析、疑念判定、Markdown 再構築
// ============================================================

export interface TableCell {
  raw: string;
}
export interface TableRow {
  cells: string[];
  /** Markdown 上の元の 1 行 (パイプ込みの生テキスト) */
  rawLine: string;
}
export interface TableModel {
  headers: string[];
  rows: TableRow[];
  /** ヘッダ行と区切り行を含む先頭 2 行 (再構築用) */
  preamble: string[];
}

/**
 * 領域本文から GFM テーブルをパースする。テーブルが無ければ null。
 * 表は本文中に 1 つだけ存在する前提 (複数表が混在する領域は未対応)。
 */
export function parseTable(body: string): TableModel | null {
  const lines = body.split('\n');
  const tableLineIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) tableLineIndexes.push(i);
  }
  if (tableLineIndexes.length < 3) return null;
  const tableLines = tableLineIndexes.map((i) => lines[i].trim());
  const headers = splitRow(tableLines[0]);
  // 区切り行 (`|---|---|`) をスキップして残りがデータ行
  const separatorIdx = tableLines.findIndex((l) =>
    /^\|[\s\-:|]+\|?$/.test(l),
  );
  if (separatorIdx < 0) return null;
  const dataLines = tableLines.slice(separatorIdx + 1);
  const rows = dataLines.map((line) => ({
    cells: splitRow(line),
    rawLine: line,
  }));
  return {
    headers,
    rows,
    preamble: [tableLines[0], tableLines[separatorIdx]],
  };
}

function splitRow(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '');
  return inner.split('|').map((c) => c.trim());
}

/** ヘッダ配列から指定列名を含むインデックスを返す。無ければ -1。 */
export function findColumnIndex(headers: string[], keyword: string): number {
  return headers.findIndex((h) =>
    h.replace(/\s+/g, '').includes(keyword.replace(/\s+/g, '')),
  );
}

/**
 * 行の「疑念」判定。以下の OR で 1 つでも該当すれば疑念あり:
 *   (a) いずれかのセルに `(?)` または `??` を含む
 *   (b) 備考列に【要確認/不整合/欠落/混線/捏造】タグ
 *   (c) 読み取った値/結果列に [強調] 注記、または H/L マーカが値の隣にある
 *   (d) 判定列が H or L
 *   (e) 桁数異常 (周辺行と整数部桁数が 2 以上乖離)
 */
export function isRowSuspicious(
  row: TableRow,
  headers: string[],
  digitAnomalyRowIdx?: Set<number>,
  rowIdx?: number,
): boolean {
  const allText = row.cells.join(' ');
  // (a)
  if (/\(\?\)|\?\?/.test(allText)) return true;
  // (b)
  const remarksIdx = findColumnIndex(headers, '備考');
  if (
    remarksIdx >= 0 &&
    /【要確認|【不整合|【欠落|【混線|【捏造/.test(row.cells[remarksIdx] ?? '')
  ) {
    return true;
  }
  // (c) 値列の [強調] or H/L 共起
  const valueIdx = findValueColumn(headers);
  if (valueIdx >= 0) {
    const v = row.cells[valueIdx] ?? '';
    if (/\[強調\]/.test(v)) return true;
    if (/[\s][HL][\s\[]|[\s][HL]$/.test(v)) return true;
  }
  // (d) 判定列が H/L
  const judgeIdx = findColumnIndex(headers, '判定');
  if (judgeIdx >= 0) {
    const j = (row.cells[judgeIdx] ?? '').trim();
    if (j === 'H' || j === 'L' || j === 'HH' || j === 'LL') return true;
  }
  // (e) 桁数異常
  if (
    digitAnomalyRowIdx &&
    rowIdx !== undefined &&
    digitAnomalyRowIdx.has(rowIdx)
  ) {
    return true;
  }
  return false;
}

function findValueColumn(headers: string[]): number {
  // 「読み取った値」「結果」「値」のいずれか
  for (const kw of ['読み取った値', '結果', '値']) {
    const i = findColumnIndex(headers, kw);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 表の「読み取った値」列の整数部桁数を見て、中央値から 2 以上離れた行を返す。
 * 例: 多くの行が 2-3 桁の中で CA19-9 = 4048 (4 桁) のような行を flagged。
 */
export function detectDigitAnomalies(model: TableModel): Set<number> {
  const valueIdx = findValueColumn(model.headers);
  if (valueIdx < 0) return new Set();
  const intDigitCounts: number[] = [];
  model.rows.forEach((row) => {
    const raw = row.cells[valueIdx] ?? '';
    const m = /(-?\d+)(\.\d+)?/.exec(raw);
    intDigitCounts.push(m ? m[1].replace('-', '').length : 0);
  });
  const sorted = intDigitCounts.filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length < 4) return new Set(); // 少なすぎる時は判定しない
  const median = sorted[Math.floor(sorted.length / 2)];
  const anomalies = new Set<number>();
  intDigitCounts.forEach((count, i) => {
    if (count > 0 && Math.abs(count - median) >= 2) anomalies.add(i);
  });
  return anomalies;
}

/**
 * 領域配列 + 行単位の編集後行 → 確定 scan_md を再構築。
 * 編集後行は parseTable の rows と同じ位置で上書きされる。
 */
export function assembleMarkdownClean(
  regions: RegionResult[],
  rowOverrides: Map<string, string>, // key = `${regionIdx}:${rowIdx}` → 編集後 rawLine
): string {
  const out: string[] = [];
  regions.forEach((region, regionIdx) => {
    out.push(`## ${region.label}`);
    if (region.bbox) {
      out.push(`<!-- bbox: ${region.bbox.map((n) => n.toFixed(2)).join(',')} -->`);
    }
    out.push('');
    const table = parseTable(region.body);
    if (!table) {
      out.push(region.body);
      out.push('');
      return;
    }
    out.push(...table.preamble);
    table.rows.forEach((row, rowIdx) => {
      const overrideKey = `${regionIdx}:${rowIdx}`;
      out.push(rowOverrides.get(overrideKey) ?? row.rawLine);
    });
    out.push('');
  });
  return out.join('\n').trim() + '\n';
}

// ============================================================
// 行状態管理 (localStorage)
// ============================================================

interface RowState {
  /** ユーザーが編集した rawLine (markdown 1 行)。未編集なら未設定 */
  edited?: string;
  /** ユーザーが「OK」と確認した (= 疑念解消) */
  userConfirmed: boolean;
}

interface VerificationState {
  /** key = `${regionIdx}:${rowIdx}` */
  rows: Record<string, RowState>;
}

function storageKey(diagnosticId: string): string {
  return `scan-chat-ai.verification.${diagnosticId}`;
}

function loadState(diagnosticId: string): VerificationState {
  if (typeof window === 'undefined') return { rows: {} };
  const raw = window.localStorage.getItem(storageKey(diagnosticId));
  if (!raw) return { rows: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<VerificationState>;
    return { rows: parsed.rows ?? {} };
  } catch {
    return { rows: {} };
  }
}

function saveState(diagnosticId: string, state: VerificationState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(diagnosticId), JSON.stringify(state));
}

// ============================================================
// コントローラ
// ============================================================

export interface VerificationRefs {
  trimmedImage: HTMLElement;     // 上部の表トリミング画像 + bbox オーバーレイ
  blockDetail: HTMLElement;      // 選択ブロックの詳細パネル
  blockDetailTitle: HTMLElement; // 詳細パネルの見出し
  blockDetailBody: HTMLElement;  // 詳細パネルの本文 (表が入る)
  resultSummary: HTMLElement;    // 「2 領域 / N 行 / M 件 要確認」
  downstreamPreview: HTMLElement;// 下流送信 markdown プレビュー <pre>
  submitBtn: HTMLButtonElement;  // 「✓ 確認して送信」
  submitHint: HTMLElement;       // 送信ボタン下のヒント

  // 行修正モーダル
  rowEditModal: HTMLElement;
  rowEditTextarea: HTMLTextAreaElement;
  rowEditOriginal: HTMLElement;   // 元行の表示先 <pre>
  rowEditSaveBtn: HTMLButtonElement;
  rowEditOkBtn: HTMLButtonElement;
  rowEditCancelBtn: HTMLButtonElement;
}

interface RegionView {
  region: RegionResult;
  table: TableModel | null;
  digitAnomalies: Set<number>;
  /** 各データ行の元の疑念フラグ (state を考慮しない) */
  originalSuspicious: boolean[];
}

const STATUS_RING: Record<'green' | 'yellow' | 'red', string> = {
  green: 'border-emerald-500/80 bg-emerald-300/25',
  yellow: 'border-amber-500/80 bg-amber-300/25',
  red: 'border-rose-500/80 bg-rose-300/25',
};

export class ScanVerificationController {
  private state: VerificationState;
  private regions: RegionView[] = [];
  /** トリミング画像内での各領域の bbox (再正規化済) */
  private overlayBoxes: Array<[number, number, number, number] | undefined> =
    [];
  /** 編集モーダルの編集対象 */
  private editing: { regionIdx: number; rowIdx: number } | null = null;
  private selectedRegionIdx: number | null = null;
  /** 画像が onload で読み終わってトリミングが完了したかフラグ */
  private trimmedImageReady = false;

  constructor(
    private refs: VerificationRefs,
    private result: AnalyzeResult,
    private diagnosticId: string,
  ) {
    this.state = loadState(diagnosticId);
  }

  async render(): Promise<void> {
    marked.setOptions({ gfm: true, breaks: false });
    this.prepareRegionViews();
    await this.renderTrimmedImage();
    this.renderSummary();
    this.refs.blockDetail.hidden = true;
    this.bindModal();
    this.bindSubmit();
    this.updateDownstreamPreview();
    this.updateSubmitGate();
  }

  // ----------------------------------------------------------
  // 領域ビューの準備
  // ----------------------------------------------------------

  private prepareRegionViews(): void {
    const regions = this.result.regions ?? [];
    this.regions = regions.map((region) => {
      const table = parseTable(region.body);
      const digitAnomalies = table ? detectDigitAnomalies(table) : new Set<number>();
      const originalSuspicious = table
        ? table.rows.map((row, i) =>
            isRowSuspicious(row, table.headers, digitAnomalies, i),
          )
        : [];
      return { region, table, digitAnomalies, originalSuspicious };
    });
  }

  // ----------------------------------------------------------
  // 表全体トリミング画像 + bbox オーバーレイ
  // ----------------------------------------------------------

  private async renderTrimmedImage(): Promise<void> {
    const container = this.refs.trimmedImage;
    container.innerHTML = '';
    const full = this.result.fullImage;
    if (!full || this.regions.length === 0) {
      container.innerHTML =
        '<p class="px-4 py-6 text-center text-sm text-slate-500">画像がありません</p>';
      return;
    }
    // 領域 bbox の union を計算 (表全体のおおまかな範囲)
    const bboxes = this.regions
      .map((r) => r.region.bbox)
      .filter((b): b is [number, number, number, number] => !!b);
    if (bboxes.length === 0) {
      // bbox 無し: 全画像をそのまま表示
      container.innerHTML = `<img src="${full}" class="block w-full" alt="撮影画像" />`;
      return;
    }
    const padding = 0.02;
    const ymin = clamp01(Math.min(...bboxes.map((b) => b[0])) - padding);
    const xmin = clamp01(Math.min(...bboxes.map((b) => b[1])) - padding);
    const ymax = clamp01(Math.max(...bboxes.map((b) => b[2])) + padding);
    const xmax = clamp01(Math.max(...bboxes.map((b) => b[3])) + padding);
    const unionW = xmax - xmin;
    const unionH = ymax - ymin;
    if (unionW <= 0 || unionH <= 0) {
      container.innerHTML = `<img src="${full}" class="block w-full" alt="撮影画像" />`;
      return;
    }
    // 各領域 bbox をトリミング後座標に再正規化
    this.overlayBoxes = this.regions.map(({ region }) => {
      const b = region.bbox;
      if (!b) return undefined;
      return [
        (b[0] - ymin) / unionH,
        (b[1] - xmin) / unionW,
        (b[2] - ymin) / unionH,
        (b[3] - xmin) / unionW,
      ];
    });
    const trimmed = await trimImage(full, [ymin, xmin, ymax, xmax]);
    this.trimmedImageReady = true;
    container.innerHTML = `
      <div class="relative">
        <img src="${trimmed}" alt="切り出した表全体" class="block w-full select-none" />
        <div class="absolute inset-0" id="trimmed-overlay-layer"></div>
      </div>
    `;
    const layer = container.querySelector(
      '#trimmed-overlay-layer',
    ) as HTMLElement | null;
    if (!layer) return;
    this.regions.forEach((_, idx) => {
      const box = this.overlayBoxes[idx];
      if (!box) return;
      const [yt, xl, yb, xr] = box;
      const top = (yt * 100).toFixed(2);
      const left = (xl * 100).toFixed(2);
      const height = ((yb - yt) * 100).toFixed(2);
      const width = ((xr - xl) * 100).toFixed(2);
      const overlay = document.createElement('button');
      overlay.type = 'button';
      overlay.dataset.regionIdx = String(idx);
      overlay.className =
        'absolute rounded border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1';
      overlay.style.top = `${top}%`;
      overlay.style.left = `${left}%`;
      overlay.style.height = `${height}%`;
      overlay.style.width = `${width}%`;
      overlay.title = this.regions[idx].region.label;
      overlay.addEventListener('click', () => this.selectRegion(idx));
      const labelEl = document.createElement('span');
      labelEl.className =
        'absolute -top-5 left-0 rounded bg-slate-900/80 px-1.5 py-0.5 text-[10px] font-medium text-white';
      labelEl.textContent = `#${idx + 1} ${this.regions[idx].region.label}`;
      overlay.appendChild(labelEl);
      layer.appendChild(overlay);
    });
    this.refreshOverlayColors();
  }

  private refreshOverlayColors(): void {
    if (!this.trimmedImageReady) return;
    const layer = this.refs.trimmedImage.querySelector(
      '#trimmed-overlay-layer',
    );
    if (!layer) return;
    layer.querySelectorAll('button[data-region-idx]').forEach((el) => {
      const idx = Number((el as HTMLButtonElement).dataset.regionIdx);
      const status = this.computeRegionStatus(idx);
      const ring = STATUS_RING[status];
      // 既存の色クラスを除去して新規付与
      (el as HTMLButtonElement).className =
        'absolute rounded border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ' +
        ring;
    });
  }

  // ----------------------------------------------------------
  // ブロック詳細
  // ----------------------------------------------------------

  private selectRegion(idx: number): void {
    this.selectedRegionIdx = idx;
    this.renderBlockDetail(idx);
    this.refs.blockDetail.hidden = false;
    // 詳細パネルが表示されたらスムーズスクロール
    this.refs.blockDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderBlockDetail(idx: number): void {
    const view = this.regions[idx];
    if (!view) return;
    this.refs.blockDetailTitle.textContent = `#${idx + 1} ${view.region.label}`;
    const body = this.refs.blockDetailBody;
    body.innerHTML = '';
    if (!view.table) {
      // 表が無い領域 (手書きメモ等) は markdown 表示
      const div = document.createElement('div');
      div.className = 'md-region';
      const parsed = marked.parse(view.region.body);
      Promise.resolve(parsed).then((html) => {
        div.innerHTML = typeof html === 'string' ? html : '';
      });
      body.appendChild(div);
      return;
    }
    const table = document.createElement('table');
    table.className =
      'w-full table-auto border-collapse text-xs md:text-sm';
    // ヘッダ
    const thead = document.createElement('thead');
    const trH = document.createElement('tr');
    view.table.headers.forEach((h) => {
      const th = document.createElement('th');
      th.className =
        'border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium dark:border-slate-700 dark:bg-slate-800';
      th.textContent = h;
      trH.appendChild(th);
    });
    thead.appendChild(trH);
    table.appendChild(thead);
    // 本文
    const tbody = document.createElement('tbody');
    view.table.rows.forEach((row, rowIdx) => {
      const ok = this.isRowOk(idx, rowIdx);
      const suspicious = !ok;
      const tr = document.createElement('tr');
      tr.dataset.rowIdx = String(rowIdx);
      tr.className = suspicious
        ? 'cursor-pointer bg-amber-50 transition-colors hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50'
        : 'bg-emerald-50/40 dark:bg-emerald-900/15';
      if (suspicious) {
        tr.addEventListener('click', () =>
          this.openRowEdit(idx, rowIdx),
        );
      }
      // 編集済み行は太字 + マーク
      const rowState = this.state.rows[`${idx}:${rowIdx}`];
      const isEdited = !!rowState?.edited;
      const cells =
        rowState?.edited != null
          ? splitRow(rowState.edited)
          : row.cells;
      cells.forEach((cellText, cellIdx) => {
        const td = document.createElement('td');
        td.className =
          'border border-slate-200 px-2 py-1 align-top dark:border-slate-700';
        if (cellIdx === 0 && isEdited) {
          td.innerHTML =
            '<span class="mr-1 inline-block rounded bg-emerald-500 px-1 text-[10px] font-medium text-white">編集</span>' +
            escapeHtml(cellText);
        } else {
          td.textContent = cellText;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
    // 凡例
    const legend = document.createElement('p');
    legend.className = 'mt-3 text-[11px] text-slate-500';
    legend.innerHTML =
      '黄色の行 = 疑念あり (タップで修正可能)。緑色の行 = 確度高。';
    body.appendChild(legend);
  }

  // ----------------------------------------------------------
  // 行編集モーダル
  // ----------------------------------------------------------

  private openRowEdit(regionIdx: number, rowIdx: number): void {
    const view = this.regions[regionIdx];
    if (!view?.table) return;
    const row = view.table.rows[rowIdx];
    if (!row) return;
    this.editing = { regionIdx, rowIdx };
    const currentLine =
      this.state.rows[`${regionIdx}:${rowIdx}`]?.edited ?? row.rawLine;
    this.refs.rowEditOriginal.textContent = row.rawLine;
    this.refs.rowEditTextarea.value = currentLine;
    this.refs.rowEditModal.hidden = false;
    setTimeout(() => this.refs.rowEditTextarea.focus(), 50);
  }

  private closeRowEdit(): void {
    this.editing = null;
    this.refs.rowEditModal.hidden = true;
  }

  private bindModal(): void {
    this.refs.rowEditSaveBtn.addEventListener('click', () =>
      this.handleRowSave(),
    );
    this.refs.rowEditOkBtn.addEventListener('click', () =>
      this.handleRowOk(),
    );
    this.refs.rowEditCancelBtn.addEventListener('click', () =>
      this.closeRowEdit(),
    );
    this.refs.rowEditModal.addEventListener('click', (ev) => {
      // 背景タップで閉じる
      if (ev.target === this.refs.rowEditModal) this.closeRowEdit();
    });
  }

  private handleRowSave(): void {
    if (!this.editing) return;
    const { regionIdx, rowIdx } = this.editing;
    const key = `${regionIdx}:${rowIdx}`;
    const edited = this.refs.rowEditTextarea.value.trim();
    const view = this.regions[regionIdx];
    const original = view?.table?.rows[rowIdx]?.rawLine ?? '';
    if (edited === '' || edited === original) {
      // 元と同じ or 空 → userConfirmed のみ
      this.state.rows[key] = { userConfirmed: true };
    } else {
      this.state.rows[key] = { edited, userConfirmed: true };
    }
    saveState(this.diagnosticId, this.state);
    this.closeRowEdit();
    this.afterRowChange(regionIdx);
  }

  private handleRowOk(): void {
    if (!this.editing) return;
    const { regionIdx, rowIdx } = this.editing;
    const key = `${regionIdx}:${rowIdx}`;
    const prev = this.state.rows[key];
    this.state.rows[key] = { ...prev, userConfirmed: true };
    saveState(this.diagnosticId, this.state);
    this.closeRowEdit();
    this.afterRowChange(regionIdx);
  }

  private afterRowChange(regionIdx: number): void {
    this.renderBlockDetail(regionIdx);
    this.refreshOverlayColors();
    this.renderSummary();
    this.updateDownstreamPreview();
    this.updateSubmitGate();
  }

  // ----------------------------------------------------------
  // 状態判定
  // ----------------------------------------------------------

  /** その行が「ユーザー視点で OK 扱い」か */
  private isRowOk(regionIdx: number, rowIdx: number): boolean {
    const view = this.regions[regionIdx];
    if (!view) return true;
    const rowState = this.state.rows[`${regionIdx}:${rowIdx}`];
    if (rowState?.userConfirmed) return true;
    if (view.table) {
      // 編集後の行は疑念再評価。ただし userConfirmed 既に true なら↑で抜けている
      const rawSuspicious = view.originalSuspicious[rowIdx] ?? false;
      return !rawSuspicious;
    }
    return true;
  }

  private computeRegionStatus(idx: number): 'green' | 'yellow' | 'red' {
    const view = this.regions[idx];
    if (!view) return 'red';
    if (!view.table) {
      // 手書きメモ等: 緑 (確認対象ではない)
      return 'green';
    }
    const total = view.table.rows.length;
    if (total === 0) return 'red';
    const unresolved = view.table.rows.filter(
      (_, rowIdx) => !this.isRowOk(idx, rowIdx),
    ).length;
    return unresolved === 0 ? 'green' : 'yellow';
  }

  // ----------------------------------------------------------
  // サマリ / プレビュー / 送信ゲート
  // ----------------------------------------------------------

  private renderSummary(): void {
    let totalRows = 0;
    let unresolved = 0;
    this.regions.forEach((view, regionIdx) => {
      if (!view.table) return;
      totalRows += view.table.rows.length;
      view.table.rows.forEach((_, rowIdx) => {
        if (!this.isRowOk(regionIdx, rowIdx)) unresolved++;
      });
    });
    const parts = [`${this.regions.length} 領域`];
    if (totalRows) parts.push(`${totalRows} 行`);
    if (unresolved > 0) {
      parts.push(`${unresolved} 件 要確認`);
    } else {
      parts.push('すべて確認済み');
    }
    this.refs.resultSummary.textContent = parts.join(' / ');
  }

  private updateDownstreamPreview(): void {
    const overrides = new Map<string, string>();
    Object.entries(this.state.rows).forEach(([key, rowState]) => {
      if (rowState.edited != null) overrides.set(key, rowState.edited);
    });
    const md = assembleMarkdownClean(
      this.result.regions ?? [],
      overrides,
    );
    this.refs.downstreamPreview.textContent = md || '(empty)';
  }

  private updateSubmitGate(): void {
    let unresolved = 0;
    this.regions.forEach((view, regionIdx) => {
      if (!view.table) return;
      view.table.rows.forEach((_, rowIdx) => {
        if (!this.isRowOk(regionIdx, rowIdx)) unresolved++;
      });
    });
    if (unresolved === 0) {
      this.refs.submitBtn.disabled = false;
      this.refs.submitBtn.textContent = '✓ 確認して送信';
      this.refs.submitHint.textContent =
        '✓ 全行を確認しました。問診へ進めます。';
      this.refs.submitHint.className =
        'text-center text-xs text-emerald-700 dark:text-emerald-400';
    } else {
      this.refs.submitBtn.disabled = true;
      this.refs.submitBtn.textContent = `✓ 確認して送信 (残り ${unresolved} 件)`;
      this.refs.submitHint.textContent = `⚠ ${unresolved} 件の疑念がまだ未解消です`;
      this.refs.submitHint.className =
        'text-center text-xs text-amber-700 dark:text-amber-400';
    }
  }

  private bindSubmit(): void {
    this.refs.submitBtn.addEventListener('click', () => {
      if (this.refs.submitBtn.disabled) return;
      const ok = window.confirm(
        'この内容で確定し、問診に進みますか?\n確定後は同じ画面で編集できません。',
      );
      if (!ok) return;
      // Phase 0: メモリ保持で /chat に遷移。
      // 確定 markdown は sessionStorage 経由で問診画面に渡す案もあるが、
      // 現状は遷移のみ。Phase 1 で Supabase 書込を追加予定。
      window.location.href = '/chat';
    });
  }
}

// ============================================================
// 内部ヘルパー
// ============================================================

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * dataURL の画像から指定 bbox (0-1 正規化) を切り出し、新しい dataURL を返す。
 */
function trimImage(
  dataUrl: string,
  bbox: [number, number, number, number],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const [ymin, xmin, ymax, xmax] = bbox;
        const sx = Math.round(xmin * img.width);
        const sy = Math.round(ymin * img.height);
        const sw = Math.round((xmax - xmin) * img.width);
        const sh = Math.round((ymax - ymin) * img.height);
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL('image/jpeg', 0.92));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}
