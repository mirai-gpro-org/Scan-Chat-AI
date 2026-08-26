import { iconSvg } from '../../lib/icon-svg';
/**
 * 選択肢モーダル（リスト方式）＋ マトリクス選択
 *
 * 【経緯】以前はホイール (ドラム) 選択だったが、2026-08 に**廃止**した。
 *   - 実測でホイールに見えていなかった: CSS に `perspective` が無く `rotateX` が
 *     ただの縦潰しになっていた。中央のハイライト帯も不透明 (#DCECEF) で
 *     **選択中の項目を塗りつぶして隠していた**(デザイントークン統一 98cf87b の副作用)。
 *   - 中央に来ている項目が「選択済み」になっておらず、何もタップせず決定を押すと
 *     空配列が返って**何も起きずに閉じる**行き止まりがあった。
 *   → デザインチーム案 (2026-08) に沿って、件数で 3 段階に切り替わるリストへ置換。
 *
 * 【件数による切替】options.length で自動判定する。呼び出し側は指定しない。
 *   - 〜7 件   : ボトムシート        (スクロール不要に収まる)
 *   - 8〜12 件 : 全画面リスト        (同上)
 *   - 13 件〜  : 全画面 + 検索 + 分類 (27 件の疾患リスト)
 *
 * 【スクロールが「ある」と分かるための 3 点セット】(発注者承認 2026-08)
 *   ① 見切れ (peek) … 最下部の行をわざと半分だけ見せる。`applyPeek()`。
 *   ② 分類見出しの sticky … スクロール中に見出しが上端へ貼り付き、位置が分かる。CSS `.lp-group`。
 *   ③ 残数のテキスト … 「↓ あと N 件」。`updateMore()`。
 *   スクロールバーの見た目強化は**採らない**。モバイルのバーは触っている間しか出ず、
 *   常時表示にすると細くて掴めない飾りになるため (①②③ の代わりにならない)。
 *
 * 【フッター被り】パネルを flex column にし、リストを `flex:1; min-height:0`、
 *   フッターを `flex-shrink:0` にしてある。**構造的に最終行が隠れない**ので、
 *   padding で逃がす必要がない。ここを普通の block レイアウトに戻さないこと。
 *
 * 【排他選択】`ChoiceOpt.exclusive` が付いた項目 (「なし」) を選ぶと他が全て外れ、
 *   他を選ぶと exclusive 側が外れる。以前は排他処理が無く「なし」と「高血圧」を
 *   同時に選べた。
 *
 * いずれもモーダルは body 直下へ動的生成し、Promise で結果を返す。
 * キャンセル時は null を返す。
 */

export interface ChoiceItem {
  label: string;
  /** AppIcon / icon-svg の意味名 (絵文字は本番素材にしない)。 */
  icon?: string;
  /** 選ぶと他の選択を全て解除する (「なし」)。 */
  exclusive?: boolean;
  /** ラベルの下に出す 1 行の補足。 */
  note?: string;
  /** 分類見出し (13 件以上のとき sticky 見出しとして使う)。 */
  group?: string;
  /** 検索用の読み。漢字が読めない/打てない人のために持つ。 */
  kana?: string;
}

export interface ListPickerArgs {
  title: string;
  subtitle?: string;
  options: ChoiceItem[];
  multi?: boolean;
  /** 初期選択 (label の配列) */
  initial?: string[];
  /**
   * 「中止」を押したときの処理。渡すとヘッダ右上に中止ボタンを出す。
   * 選択画面は全画面/シートで問診の中止ボタンを覆い隠すため、ここからも中止できるようにする
   * (発注者指示 2026-08)。呼ばれた時点でこの選択画面は閉じている (キャンセル扱い)。
   */
  onAbort?: () => void;
}

/**
 * 画面上部に残す領域 (問診ヘッダ) の高さを測り、CSS 変数 `--lp-top` に入れる。
 *
 * 【なぜ】全画面の選択画面を `inset: 0` で開くと**画面トップの進捗バーごと隠れて**
 *   「あとどのくらいで終わるか」が分からなくなる。これは仕様上の制約ではなく
 *   こちらのレイアウトの選択なので、**ヘッダの下から開く**ようにして実物を見せる。
 *   モーダル側に進捗バーを複製する案は、**回答選択肢の上に別の進捗が出て紛らわしい**ため
 *   撤回した (発注者判断 2026-08)。
 *
 * スクリムにも同じ offset を掛けるのでヘッダは暗くならず、数値がそのまま読める。
 * アンカーが無いページでは 0 (=従来どおり全面) にフォールバックする。
 */
const TOP_ANCHOR_SELECTOR = '#chat-header';

function applyTopAnchor(root: HTMLElement): void {
  const anchor = document.querySelector<HTMLElement>(TOP_ANCHOR_SELECTOR);
  const top = anchor ? Math.max(0, Math.round(anchor.getBoundingClientRect().bottom)) : 0;
  root.style.setProperty('--lp-top', `${top}px`);
}

/** レイアウトの切替しきい値 (件数)。 */
const SHEET_MAX = 7;
const FULL_MAX = 12;

type Layout = 'sheet' | 'full' | 'search';

const layoutFor = (n: number): Layout =>
  n <= SHEET_MAX ? 'sheet' : n <= FULL_MAX ? 'full' : 'search';

/** 開いているピッカーの強制クローズ関数 (音声回答で先に進んだ時などに使用) */
const activeClosers = new Set<() => void>();

/** 開いている全ピッカーを閉じる (キャンセル扱い) */
export function closeAllPickers(): void {
  for (const c of [...activeClosers]) c();
}

/** カタカナ→ひらがな + 小文字化 + 空白除去。検索の突合用。 */
function normalize(s: string): string {
  return s
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase()
    .replace(/[\s　]/g, '');
}

/**
 * 選択肢モーダルを開く。
 * @returns 選択された label 配列。キャンセルは null。
 */
export function openListPicker(args: ListPickerArgs): Promise<string[] | null> {
  const { title, subtitle, options, multi = false, onAbort } = args;
  const layout = layoutFor(options.length);
  const selected = new Set(args.initial ?? []);

  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'lp-root';
    root.dataset.layout = layout;

    const abortBtn = onAbort
      ? `<button type="button" class="lp-abort" data-lp-abort>${iconSvg('blocked')}<span>中止</span></button>`
      : '';

    // ヘッダはシート用 / 全画面用の両方を描いておき、CSS が data-layout で出し分ける。
    // こうしておくと「入りきらないので全画面へ昇格」を data-layout の差し替えだけで行える。
    const headHtml = `
      <div class="sheet-handle"></div>
      <div class="lp-bar">
        <button type="button" class="lp-back" data-lp-cancel aria-label="戻る">${iconSvg('prev')}</button>
        <h2 class="lp-title lp-title-bar">${escapeHtml(title)}</h2>
        ${abortBtn}
      </div>
      <div class="lp-sheet-head">
        <h2 class="lp-title lp-title-sheet">${escapeHtml(title)}</h2>
        ${abortBtn}
      </div>`;

    const searchHtml =
      layout === 'search'
        ? `<div class="lp-search">
             <span class="lp-search-ico" aria-hidden="true">${iconSvg('search')}</span>
             <input type="search" class="lp-search-input" data-lp-search
                    placeholder="名称を検索" aria-label="選択肢を名称で検索" enterkeyhint="search" />
           </div>`
        : '';

    root.innerHTML = `
      <div class="sheet-backdrop" data-lp-cancel></div>
      <div class="lp-panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="lp-head">
          ${headHtml}
          <p class="lp-sub">${escapeHtml(subtitle ?? (multi ? 'あてはまるものをすべて選んでください' : 'タップすると回答して次へ進みます'))}</p>
          ${searchHtml}
        </div>
        <div class="lp-scroll" data-lp-scroll>
          ${layout === 'search' ? `<p class="lp-count">全${options.length}件</p>` : ''}
          <div class="lp-items" data-lp-items></div>
          <p class="lp-empty" data-lp-empty hidden>該当する項目がありません</p>
        </div>
        <div class="lp-foot">
          <p class="lp-more" data-lp-more hidden></p>
          ${
            multi
              ? `<div class="lp-actions">
                   <span class="lp-selected" data-lp-selected>0件選択中</span>
                   <button type="button" class="btn-primary lp-confirm" data-lp-confirm>この内容で回答</button>
                 </div>`
              : `<div class="lp-actions">
                   <button type="button" class="btn-secondary lp-cancel" data-lp-cancel>キャンセル</button>
                 </div>`
          }
        </div>
      </div>
    `;
    applyTopAnchor(root);
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    const panel = root.querySelector<HTMLElement>('.lp-panel')!;
    const scroll = root.querySelector<HTMLElement>('[data-lp-scroll]')!;
    const itemsBox = root.querySelector<HTMLElement>('[data-lp-items]')!;
    const emptyEl = root.querySelector<HTMLElement>('[data-lp-empty]')!;
    const moreEl = root.querySelector<HTMLElement>('[data-lp-more]')!;
    const selectedEl = root.querySelector<HTMLElement>('[data-lp-selected]');
    const searchEl = root.querySelector<HTMLInputElement>('[data-lp-search]');

    // ── 描画 (分類見出しは 13 件以上のときだけ出す) ───────────────
    const useGroups = layout === 'search' && options.some((o) => o.group);
    // 1 つでもアイコンを持つ選択肢があれば、全行にアイコン枠を確保してラベルの頭を揃える
    // (一部だけアイコンがあると、その行だけ文字が右へずれる)。
    const anyIcon = options.some((o) => o.icon);
    let lastGroup = '';
    options.forEach((o, i) => {
      if (useGroups && o.group && o.group !== lastGroup) {
        const h = document.createElement('div');
        h.className = 'lp-group';
        h.dataset.group = o.group;
        h.textContent = o.group;
        itemsBox.appendChild(h);
        lastGroup = o.group;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lp-item';
      btn.dataset.index = String(i);
      btn.dataset.label = o.label;
      btn.dataset.hay = normalize(`${o.label} ${o.kana ?? ''}`);
      if (o.exclusive) btn.dataset.exclusive = '1';
      btn.setAttribute('role', multi ? 'checkbox' : 'radio');
      btn.setAttribute('aria-checked', String(selected.has(o.label)));
      if (selected.has(o.label)) btn.classList.add('on');
      btn.innerHTML = `
        ${anyIcon ? `<span class="lp-ico" aria-hidden="true">${o.icon ? iconSvg(o.icon) : ''}</span>` : ''}
        <span class="lp-text">
          <span class="lp-label">${escapeHtml(o.label)}</span>
          ${o.note ? `<span class="lp-note">${escapeHtml(o.note)}</span>` : ''}
        </span>
        <span class="lp-mark" aria-hidden="true">${iconSvg('check')}</span>
      `;
      itemsBox.appendChild(btn);
    });

    const itemEls = (): HTMLElement[] =>
      Array.from(itemsBox.querySelectorAll<HTMLElement>('.lp-item'));

    function renderSelectedCount(): void {
      if (!selectedEl) return;
      selectedEl.textContent = `${selected.size}件選択中`;
    }
    renderSelectedCount();

    // ── ③ 残数「↓ あと N 件」 ───────────────────────────────────
    function updateMore(): void {
      const fold = scroll.scrollTop + scroll.clientHeight;
      // 下端より下にはみ出している (＝まだ読めていない) 項目を数える
      const below = itemEls().filter(
        (el) => !el.hidden && el.offsetTop + el.offsetHeight > fold + 2,
      ).length;
      moreEl.hidden = below === 0;
      moreEl.innerHTML = below === 0 ? '' : `${iconSvg('expand')}<span>あと ${below} 件</span>`;
    }

    // ── ① 見切れ (peek): 最下部の行をわざと半分だけ見せる ───────────
    // 「切れている＝続きがある」は説明不要で伝わる。スクロール可能なときだけ効かせる。
    //
    // 行ピッチから逆算しない。分類見出しが挟まると行間が一定でなくなり、
    // 見切れ量が狂う (実測 2026-08: 27件で 0.89＝ほぼ切れていない)。
    // **実際に下端をまたぐ行を見つけ、その行が PEEK 割合だけ見える高さ**に直接合わせる。
    /**
     * 「はみ出し」とみなす余白 (px)。リスト下端の padding だけで 2〜8px 溢れることがあり、
     * それで全画面へ昇格したり見切れを付けたりすると、全部見えているのに画面が切り替わる。
     */
    const OVERFLOW_TOLERANCE = 12;

    /**
     * 入りきらないボトムシートは全画面へ昇格する (発注者指示 2026-08)。
     * 件数が少なくてもラベルが長いと 2 行になり、シートの 80vh に収まらないことがある。
     * その場合はシートで狭く見せず、最初から全画面で開く。
     */
    function promoteIfNeeded(): void {
      if (root.dataset.layout !== 'sheet') return;
      scroll.style.maxHeight = '';
      if (scroll.scrollHeight > scroll.clientHeight + OVERFLOW_TOLERANCE) root.dataset.layout = 'full';
    }

    const PEEK = 0.45;
    function applyPeek(): void {
      scroll.style.maxHeight = '';
      const els = itemEls().filter((el) => !el.hidden);
      if (els.length < 2) return;
      const avail = scroll.clientHeight;
      if (scroll.scrollHeight <= avail + OVERFLOW_TOLERANCE) return; // 収まっている＝何もしない

      // 下端をまたぐ行。無ければ (行の境界がちょうど下端の場合) その次の行を使う。
      let cut = els.find((el) => el.offsetTop < avail && el.offsetTop + el.offsetHeight > avail);
      if (!cut) cut = els.find((el) => el.offsetTop >= avail);
      if (!cut) return;

      const h = Math.round(cut.offsetTop + cut.offsetHeight * PEEK);
      // 1 行しか見えない高さまで縮めない (選びにくくなる)
      if (h < cut.offsetHeight * 2) return;
      scroll.style.maxHeight = `${h}px`;
    }

    // ── 検索 (13 件以上のときだけ) ──────────────────────────────
    function applyFilter(): void {
      const q = normalize(searchEl?.value ?? '');
      let hit = 0;
      for (const el of itemEls()) {
        const show = q === '' || (el.dataset.hay ?? '').includes(q);
        el.hidden = !show;
        if (show) hit++;
      }
      // 見出しは、配下に表示中の項目が 1 つも無ければ隠す
      itemsBox.querySelectorAll<HTMLElement>('.lp-group').forEach((h) => {
        let n = 0;
        for (let el = h.nextElementSibling; el; el = el.nextElementSibling) {
          if (el.classList.contains('lp-group')) break;
          if (!(el as HTMLElement).hidden) n++;
        }
        h.hidden = n === 0;
      });
      emptyEl.hidden = hit > 0;
      scroll.scrollTop = 0;
      applyPeek();
      updateMore();
    }
    searchEl?.addEventListener('input', applyFilter);

    // ── 選択 ────────────────────────────────────────────────────
    function syncMarks(): void {
      for (const el of itemEls()) {
        const on = selected.has(el.dataset.label ?? '');
        el.classList.toggle('on', on);
        el.setAttribute('aria-checked', String(on));
      }
      renderSelectedCount();
    }

    itemsBox.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.lp-item');
      if (!item) return;
      const label = item.dataset.label ?? '';

      if (!multi) {
        // 単一選択はタップで即確定 (chip と同じ操作感。決定ボタンを挟まない)
        close([label]);
        return;
      }

      if (selected.has(label)) {
        selected.delete(label);
      } else {
        if (item.dataset.exclusive === '1') {
          // 「なし」を選んだら他を全て解除
          selected.clear();
        } else {
          // 他を選んだら「なし」を解除
          for (const el of itemEls()) {
            if (el.dataset.exclusive === '1') selected.delete(el.dataset.label ?? '');
          }
        }
        selected.add(label);
      }
      syncMarks();
    });

    // ── 後始末 ──────────────────────────────────────────────────
    let settled = false;
    function close(result: string[] | null): void {
      if (settled) return;
      settled = true;
      activeClosers.delete(forceClose);
      scroll.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      root.remove();
      resolve(result);
    }
    const forceClose = (): void => close(null);
    activeClosers.add(forceClose);

    const onScroll = (): void => updateMore();
    const onResize = (): void => { applyTopAnchor(root); promoteIfNeeded(); applyPeek(); updateMore(); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(null); };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);

    root.querySelectorAll('[data-lp-cancel]').forEach((b) =>
      b.addEventListener('click', () => close(null)),
    );
    root.querySelector('[data-lp-confirm]')?.addEventListener('click', () => {
      close([...selected]);
    });
    root.querySelectorAll('[data-lp-abort]').forEach((b) =>
      b.addEventListener('click', () => {
        close(null); // 中止確認の裏に選択画面を残さない
        onAbort?.();
      }),
    );

    // 1 フレーム目はまだレイアウトが落ち着いておらず、見切れの計算がずれる
    // (実測 2026-08: 高さ 588px に対し 626px を算出＝max-height が効かず切れない)。
    // applyPeek は毎回 max-height を空にして測り直す = 何度呼んでも同じ結果になるので、
    // 2 フレーム待ってからもう一度当てる。
    requestAnimationFrame(() => {
      promoteIfNeeded();
      applyPeek();
      updateMore();
      panel.focus?.();
      requestAnimationFrame(() => {
        promoteIfNeeded();
        applyPeek();
        updateMore();
      });
    });
  });
}

// ── アクションシート (「中止」の 3 択など) ──────────────────────

export interface SheetAction {
  /** 呼び出し側が結果を判別するためのキー */
  key: string;
  label: string;
  /** ラベルの下に出す 1 行の補足 */
  note?: string;
  /** icon-svg の意味名 */
  icon?: string;
  /** 見た目の強さ。'primary'=主操作 / 'danger'=消える操作 / 既定=通常 */
  tone?: 'primary' | 'danger';
}

/**
 * 選択肢を縦に並べただけのボトムシート。
 * 中止の 3 択 (記憶して中止 / 全消しして中止 / 問診に戻る) に使う。
 * 背景タップ・Esc は「何もしない」= null を返す (誤操作で回答を失わせない)。
 */
export function openActionSheet(args: {
  title: string;
  description?: string;
  actions: SheetAction[];
}): Promise<string | null> {
  const { title, description, actions } = args;
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'lp-root';
    root.dataset.layout = 'sheet';
    root.innerHTML = `
      <div class="sheet-backdrop" data-as-cancel></div>
      <div class="lp-panel as-panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="lp-head">
          <div class="sheet-handle"></div>
          <h2 class="lp-title lp-title-sheet">${escapeHtml(title)}</h2>
          ${description ? `<p class="lp-sub">${escapeHtml(description)}</p>` : ''}
        </div>
        <div class="lp-scroll">
          <div class="lp-items">
            ${actions
              .map(
                (a) => `
              <button type="button" class="lp-item as-item${a.tone ? ` as-${a.tone}` : ''}" data-as-key="${escapeAttr(a.key)}">
                ${a.icon ? `<span class="lp-ico" aria-hidden="true">${iconSvg(a.icon)}</span>` : ''}
                <span class="lp-text">
                  <span class="lp-label">${escapeHtml(a.label)}</span>
                  ${a.note ? `<span class="lp-note">${escapeHtml(a.note)}</span>` : ''}
                </span>
              </button>`,
              )
              .join('')}
          </div>
        </div>
      </div>
    `;
    applyTopAnchor(root);
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    let settled = false;
    function close(key: string | null): void {
      if (settled) return;
      settled = true;
      activeClosers.delete(forceClose);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      root.remove();
      resolve(key);
    }
    const forceClose = (): void => close(null);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(null); };
    activeClosers.add(forceClose);
    document.addEventListener('keydown', onKey);

    root.querySelectorAll('[data-as-cancel]').forEach((b) =>
      b.addEventListener('click', () => close(null)),
    );
    root.querySelectorAll<HTMLElement>('[data-as-key]').forEach((b) =>
      b.addEventListener('click', () => close(b.dataset.asKey ?? null)),
    );
  });
}

// ── マトリクス選択 (行 × 列) ───────────────────────────────────

export interface MatrixPickerArgs {
  title: string;
  rows: string[];
  cols: ChoiceItem[];
  /** 初期値 row -> col label */
  initial?: Record<string, string>;
  /** 「中止」を押したときの処理。渡すとヘッダ右端に中止ボタンを出す。 */
  onAbort?: () => void;
}

/**
 * マトリクス選択モーダル。各行 (項目) について 1 列 (頻度) をタップ選択する。
 * @returns row -> col label の Record。キャンセルは null。
 */
export function openMatrixPicker(args: MatrixPickerArgs): Promise<Record<string, string> | null> {
  const { title, rows, cols, onAbort } = args;
  const picked: Record<string, string> = { ...(args.initial ?? {}) };

  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'lp-root';
    // data-layout を付けないと CSS の出し分け (:not([data-layout='sheet'])) に当たって
    // ハンドル・見出し・中止ボタン・スクリムが全部消える (実測 2026-08)。
    root.dataset.layout = 'sheet';
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
      <div class="sheet-backdrop" data-lp-cancel></div>
      <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="sheet-handle"></div>
        <div class="lp-sheet-head">
          <h2 class="lp-title lp-title-sheet">${escapeHtml(title)}</h2>
          ${onAbort ? `<button type="button" class="lp-abort" data-lp-abort>${iconSvg('blocked')}<span>中止</span></button>` : ''}
        </div>
        <p class="mb-3 mt-1 text-sm text-slate-600">各項目の頻度をタップで選んでください</p>
        <div class="matrix-wrap" data-matrix>${rowsHtml}</div>
        <div class="mt-4 flex gap-2">
          <button type="button" class="btn-secondary flex-1" data-lp-cancel>キャンセル</button>
          <button type="button" class="btn-primary flex-1" data-lp-confirm>決定</button>
        </div>
      </div>
    `;
    applyTopAnchor(root);
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
    root.querySelectorAll('[data-lp-cancel]').forEach((b) =>
      b.addEventListener('click', () => close(null)),
    );
    root.querySelectorAll('[data-lp-abort]').forEach((b) =>
      b.addEventListener('click', () => { close(null); onAbort?.(); }),
    );
    root.querySelector('[data-lp-confirm]')!.addEventListener('click', () => close(picked));
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
