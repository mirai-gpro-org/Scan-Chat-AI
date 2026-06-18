/**
 * ホイール (ドラム) 選択モーダル
 *
 * 選択肢が多い設問向けの UI。単純なスクロールではなく、
 * iOS の日付ピッカーのように「回して選ぶ」ドラム表現を採用する。
 *   - 縦スクロール (scroll-snap) で項目を回す
 *   - 中央に来た項目を 3D 的に強調 (perspective + rotateX)
 *   - タップで選択 (単一: 即確定候補 / 複数: トグル)
 *   - 複数選択 (multi:true) にも対応
 *
 * いずれもモーダルは body 直下へ動的生成し、Promise で結果を返す。
 * キャンセル時は null を返す。
 */

export interface WheelOption {
  label: string;
  emoji?: string;
}

export interface WheelPickerArgs {
  title: string;
  subtitle?: string;
  options: WheelOption[];
  multi?: boolean;
  /** 初期選択 (label の配列) */
  initial?: string[];
}

const ITEM_H = 48; // 1 項目の高さ(px) — CSS の .wheel-item と同期

/** 開いているピッカーの強制クローズ関数 (音声回答で先に進んだ時などに使用) */
const activeClosers = new Set<() => void>();

/** 開いている全ピッカーを閉じる (キャンセル扱い) */
export function closeAllPickers(): void {
  for (const c of [...activeClosers]) c();
}

/**
 * ホイール選択モーダルを開く。
 * @returns 選択された label 配列。キャンセルは null。
 */
export function openWheelPicker(args: WheelPickerArgs): Promise<string[] | null> {
  const { title, subtitle, options, multi = false } = args;
  const selected = new Set(args.initial ?? []);

  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'wheel-root';
    root.innerHTML = `
      <div class="sheet-backdrop" data-wheel-cancel></div>
      <div class="sheet-panel wheel-panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="sheet-handle"></div>
        <h2 class="mb-1 text-base font-semibold">${escapeHtml(title)}</h2>
        <p class="mb-3 text-xs text-slate-500">${escapeHtml(subtitle ?? (multi ? '回して、タップで複数選べます' : '回して、タップで選んでください'))}</p>
        <div class="wheel-viewport" data-wheel-viewport>
          <div class="wheel-highlight" aria-hidden="true"></div>
          <ul class="wheel-list" data-wheel-list></ul>
        </div>
        <p class="wheel-summary" data-wheel-summary></p>
        <div class="mt-4 flex gap-2">
          <button type="button" class="btn-secondary flex-1" data-wheel-cancel>キャンセル</button>
          <button type="button" class="btn-primary flex-1" data-wheel-confirm>決定</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    const viewport = root.querySelector<HTMLElement>('[data-wheel-viewport]')!;
    const list = root.querySelector<HTMLUListElement>('[data-wheel-list]')!;
    const summary = root.querySelector<HTMLElement>('[data-wheel-summary]')!;

    // 上下パディングで先頭/末尾を中央に寄せられるようにする
    const pad = document.createElement('li');
    pad.className = 'wheel-pad';
    const padBottom = pad.cloneNode() as HTMLLIElement;
    list.appendChild(pad);

    options.forEach((o, i) => {
      const li = document.createElement('li');
      li.className = 'wheel-item';
      li.dataset.index = String(i);
      li.dataset.label = o.label;
      li.innerHTML = `
        <span class="wheel-check" aria-hidden="true">${multi ? '' : ''}</span>
        <span class="wheel-text">${o.emoji ? `<span class="wheel-emoji">${escapeHtml(o.emoji)}</span>` : ''}${escapeHtml(o.label)}</span>
      `;
      if (selected.has(o.label)) li.classList.add('on');
      list.appendChild(li);
    });
    list.appendChild(padBottom);

    function renderSummary(): void {
      if (!multi) {
        summary.textContent = '';
        return;
      }
      const arr = [...selected];
      summary.textContent = arr.length ? `選択中: ${arr.join('、')}` : '未選択';
    }
    renderSummary();

    // ドラム 3D 表現: スクロール位置に応じて各項目を回転/減衰
    let raf = 0;
    function updateTilt(): void {
      const center = viewport.scrollTop + viewport.clientHeight / 2;
      list.querySelectorAll<HTMLElement>('.wheel-item').forEach((el) => {
        const mid = el.offsetTop + el.offsetHeight / 2;
        const dist = (mid - center) / ITEM_H; // 中央からの項目数
        const clamped = Math.max(-3, Math.min(3, dist));
        const rot = clamped * 18; // deg
        const opacity = Math.max(0.25, 1 - Math.abs(clamped) * 0.28);
        const scale = Math.max(0.8, 1 - Math.abs(clamped) * 0.06);
        el.style.transform = `rotateX(${rot}deg) scale(${scale})`;
        el.style.opacity = String(opacity);
        el.classList.toggle('centered', Math.abs(dist) < 0.5);
      });
    }
    function onScroll(): void {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateTilt();
      });
    }
    viewport.addEventListener('scroll', onScroll, { passive: true });

    // 中央に項目をスナップ
    function scrollToIndex(i: number, smooth = true): void {
      viewport.scrollTo({ top: i * ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
    }

    // タップ: 単一=その項目を中央へ+選択 / 複数=トグル
    list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.wheel-item');
      if (!item) return;
      const label = item.dataset.label ?? '';
      const idx = Number(item.dataset.index ?? '0');
      if (multi) {
        if (selected.has(label)) {
          selected.delete(label);
          item.classList.remove('on');
        } else {
          selected.add(label);
          item.classList.add('on');
        }
        renderSummary();
      } else {
        list.querySelectorAll('.wheel-item.on').forEach((el) => el.classList.remove('on'));
        selected.clear();
        selected.add(label);
        item.classList.add('on');
      }
      scrollToIndex(idx);
    });

    let settled = false;
    function close(result: string[] | null): void {
      if (settled) return;
      settled = true;
      activeClosers.delete(forceClose);
      viewport.removeEventListener('scroll', onScroll);
      document.body.style.overflow = '';
      root.remove();
      resolve(result);
    }
    const forceClose = (): void => close(null);
    activeClosers.add(forceClose);

    root.querySelectorAll('[data-wheel-cancel]').forEach((b) =>
      b.addEventListener('click', () => close(null)),
    );
    root.querySelector('[data-wheel-confirm]')!.addEventListener('click', () => {
      close([...selected]);
    });

    // 初期表示: 選択済 (or 先頭) を中央に
    const firstSel = options.findIndex((o) => selected.has(o.label));
    requestAnimationFrame(() => {
      scrollToIndex(firstSel >= 0 ? firstSel : 0, false);
      updateTilt();
    });
  });
}

// ── マトリクス選択 (行 × 列) ───────────────────────────────────

export interface MatrixPickerArgs {
  title: string;
  rows: string[];
  cols: WheelOption[];
  /** 初期値 row -> col label */
  initial?: Record<string, string>;
}

/**
 * マトリクス選択モーダル。各行 (項目) について 1 列 (頻度) をタップ選択する。
 * @returns row -> col label の Record。キャンセルは null。
 */
export function openMatrixPicker(args: MatrixPickerArgs): Promise<Record<string, string> | null> {
  const { title, rows, cols } = args;
  const picked: Record<string, string> = { ...(args.initial ?? {}) };

  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'wheel-root';
    const rowsHtml = rows
      .map((r, ri) => {
        const colsHtml = cols
          .map(
            (c) =>
              `<button type="button" class="matrix-cell${picked[r] === c.label ? ' on' : ''}" data-row="${ri}" data-col="${escapeAttr(c.label)}">${escapeHtml(c.label)}</button>`,
          )
          .join('');
        return `
          <div class="matrix-row" data-row-name="${escapeAttr(r)}">
            <div class="matrix-row-label">${escapeHtml(r)}</div>
            <div class="matrix-cells">${colsHtml}</div>
          </div>`;
      })
      .join('');

    root.innerHTML = `
      <div class="sheet-backdrop" data-wheel-cancel></div>
      <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="sheet-handle"></div>
        <h2 class="mb-1 text-base font-semibold">${escapeHtml(title)}</h2>
        <p class="mb-3 text-xs text-slate-500">各項目の頻度をタップで選んでください</p>
        <div class="matrix-wrap" data-matrix>${rowsHtml}</div>
        <div class="mt-4 flex gap-2">
          <button type="button" class="btn-secondary flex-1" data-wheel-cancel>キャンセル</button>
          <button type="button" class="btn-primary flex-1" data-wheel-confirm>決定</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    const wrap = root.querySelector<HTMLElement>('[data-matrix]')!;
    wrap.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLButtonElement>('.matrix-cell');
      if (!cell) return;
      const ri = Number(cell.dataset.row);
      const rowName = rows[ri];
      const col = cell.dataset.col ?? '';
      picked[rowName] = col;
      // 同じ行の他セルを解除
      cell.parentElement?.querySelectorAll('.matrix-cell').forEach((el) => el.classList.remove('on'));
      cell.classList.add('on');
    });

    let settled = false;
    function close(result: Record<string, string> | null): void {
      if (settled) return;
      settled = true;
      activeClosers.delete(forceClose);
      document.body.style.overflow = '';
      root.remove();
      resolve(result);
    }
    const forceClose = (): void => close(null);
    activeClosers.add(forceClose);
    root.querySelectorAll('[data-wheel-cancel]').forEach((b) =>
      b.addEventListener('click', () => close(null)),
    );
    root.querySelector('[data-wheel-confirm]')!.addEventListener('click', () => close(picked));
  });
}

/** matrix 結果を表示/エンジン用の 1 行文字列に整形 */
export function formatMatrix(picked: Record<string, string>): string {
  return Object.entries(picked)
    .map(([row, col]) => `${row}：${col}`)
    .join(' / ');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
