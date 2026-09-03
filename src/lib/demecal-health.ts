/**
 * デメカル無人取得の **監視判定** (Phase C / C-6)。
 * 正本: `docs/lab/demecal_recovery_plan_20260902.md §7.2 C-6`
 *
 * 【この関数がやること】`GET /api/admin/demecal-run` が返した JSON を受け取り、
 * **異常が 1 つでもあるか**を判定して返す。それだけ。
 *
 * 【やらないこと — ここが設計の要】
 *   ・**別の run-state を持たない。** 判断材料は上記 API の応答だけ
 *     (`§1 このAPIを監視のsource of truthとして使う`)。
 *   ・**しきい値を作り直さない。** 「止まっている」の判定は
 *     サーバが返す `health.stale` をそのまま使う。`STALE_DAYS = 8` は
 *     `api/admin/demecal-run.ts:30` の契約であって、こちらの持ち物ではない。
 *     ここで日数を数え直すと、**サーバとクライアントで別々の "止まっている" が
 *     生まれ、片方だけ直して黙ってずれる**。
 *   ・**PII を扱わない。** 見るのは
 *     `result` / `stage` / `health.*` だけ。`error` と `diag` は
 *     API 側で長さを切ってあるが、**監視には出さない**
 *     (原因を追うのは admin の実行ログの仕事。監視の出力は
 *      GitHub Actions のログやメールに載って行き先が広いので、
 *      通す情報を最小に固定しておく)。
 *
 * 【`now` を引数で受ける理由】判定には使わない。
 * それでも受けるのは、**このモジュールから時計への依存を完全に無くす**ため
 * (`§3 client側でDate.now依存を隠さない`)。`Date.now()` を内部で呼ぶと
 * 検査が実行時刻に依存し、境界の検査が「たまたま通る」状態になる。
 * 出力の `evaluated_at` にだけ使う。
 */

/** 監視が検知する状態。**並び順 = 深刻さの順**で、そのまま出力の並びになる。 */
export type DemecalAlertCode =
  | 'MONITOR_SOURCE_ERROR'
  | 'NO_RUN_HISTORY'
  | 'LAST_RUN_FAILED'
  | 'STALE'
  | 'CERT_EXPIRING';

export interface DemecalAlert {
  code: DemecalAlertCode;
  /** 人が読む 1 行。**PII を入れない** (result / stage / 日数 / 残日数だけ)。 */
  detail: string;
}

export type DemecalCertState = 'ok' | 'expiring' | 'unknown';

export interface DemecalHealthVerdict {
  /** アラートが 1 つも無ければ true。checker の exit code はこれだけで決まる。 */
  ok: boolean;
  alerts: DemecalAlert[];
  last_success_at: string | null;
  days_since_success: number | null;
  last_run_result: 'ok' | 'fail' | null;
  last_run_stage: string | null;
  cert_days_left: number | null;
  /**
   * **「未知」と「期限切迫」を分ける** (`§6`)。
   * 古い run や証明書を見ない run では値が無いことがあり、
   * それを期限切迫と同じ扱いにすると**毎日鳴り続けて誰も見なくなる**。
   */
  cert_state: DemecalCertState;
  /** 1 行のまとめ。監視ログに残るのはこれ。 */
  summary: string;
  /** 引数の `now`。判定には使っていない。 */
  evaluated_at: string;
}

/**
 * 証明書の残り日数がこれ未満なら知らせる。
 * **更新は Wellfort 側の手続きが要る**ので、気づいてから動ける余裕として 60 日。
 */
export const CERT_MIN_DAYS = 60;

/** 監視が読む口。checker と doc がずれないようにここに置く。 */
export const DEMECAL_RUN_PATH = '/api/admin/demecal-run';

/* ── 応答の形を確かめる (壊れていたら「正常」に倒さない) ──────────── */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNumOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function sourceError(reason: string, now: Date): DemecalHealthVerdict {
  return {
    ok: false,
    alerts: [{ code: 'MONITOR_SOURCE_ERROR', detail: reason }],
    last_success_at: null,
    days_since_success: null,
    last_run_result: null,
    last_run_stage: null,
    cert_days_left: null,
    cert_state: 'unknown',
    summary: `NG demecal: alerts=MONITOR_SOURCE_ERROR (${reason})`,
    evaluated_at: now.toISOString(),
  };
}

/**
 * `payload` = `GET /api/admin/demecal-run` の応答 (JSON)。
 * `now`     = 判定に使わない基準時刻 (上のコメント)。
 * `getError`= GET そのものが失敗したときの理由。渡すと即 `MONITOR_SOURCE_ERROR`。
 */
export function evaluateDemecalHealth(
  payload: unknown,
  now: Date,
  getError?: string,
): DemecalHealthVerdict {
  if (getError) return sourceError(getError, now);

  if (!isObj(payload)) return sourceError('応答が JSON オブジェクトではありません', now);
  // `ok:false` は API 側が理由を持っている (unauthorized / s3_not_configured)。
  // **中身を推測せずそのまま source error にする。**
  if (payload.ok !== true) {
    const why = typeof payload.error === 'string' ? payload.error : 'ok が true ではありません';
    return sourceError(`API がエラーを返しました: ${why}`, now);
  }
  if (!Array.isArray(payload.runs)) return sourceError('runs が配列ではありません', now);
  const health = payload.health;
  if (!isObj(health)) return sourceError('health がありません', now);
  if (typeof health.stale !== 'boolean') return sourceError('health.stale が真偽値ではありません', now);
  if (!isNumOrNull(health.days_since_success)) return sourceError('health.days_since_success の型が違います', now);
  if (!isNumOrNull(health.cert_days_left)) return sourceError('health.cert_days_left の型が違います', now);
  if (!isStrOrNull(health.last_success_at)) return sourceError('health.last_success_at の型が違います', now);

  const runs = payload.runs;
  const latest = runs.length > 0 ? runs[0] : null;
  let lastResult: 'ok' | 'fail' | null = null;
  let lastStage: string | null = null;
  if (latest !== null) {
    if (!isObj(latest)) return sourceError('runs[0] がオブジェクトではありません', now);
    if (latest.result !== 'ok' && latest.result !== 'fail') {
      // ここを素通しすると**壊れた記録が「正常」になる**。fail-closed。
      return sourceError('runs[0].result が ok / fail ではありません', now);
    }
    lastResult = latest.result;
    lastStage = typeof latest.stage === 'string' && latest.stage !== '' ? latest.stage : null;
  }

  const days = health.days_since_success;
  const certDays = health.cert_days_left;
  const certState: DemecalCertState =
    certDays === null ? 'unknown' : certDays < CERT_MIN_DAYS ? 'expiring' : 'ok';

  const alerts: DemecalAlert[] = [];

  // ① 記録が 1 件も無い。**「まだ動いていない」であって「正常」ではない。**
  if (runs.length === 0) {
    alerts.push({ code: 'NO_RUN_HISTORY', detail: '実行の記録が 1 件もありません' });
  }

  // ② 直近の run が失敗。**③ とは別物**として出す (`§2`)。
  //    最後の成功が昨日でも、今朝の run が落ちていれば知らせる必要がある。
  if (lastResult === 'fail') {
    alerts.push({
      code: 'LAST_RUN_FAILED',
      detail: `直近の実行が失敗しています${lastStage ? ` (stage=${lastStage})` : ''}`,
    });
  }

  // ③ 長期間 成功していない。**判定はサーバの health.stale をそのまま使う。**
  //    記録が 0 件のときもサーバは stale=true を返す (fail-closed) ので
  //    ① と同時に立つ。片方を握り潰すと、それはこちら側での再解釈になる。
  if (health.stale) {
    alerts.push({
      code: 'STALE',
      detail: days === null
        ? '一度も取り込みに成功していません'
        : `最後の成功から ${days} 日経過しています`,
    });
  }

  // ④ 証明書。**未知は鳴らさない** (`§6`)。
  if (certState === 'expiring') {
    alerts.push({ code: 'CERT_EXPIRING', detail: `クライアント証明書の残り ${certDays} 日` });
  }

  const bits = [
    `last_success=${health.last_success_at ?? 'none'}`,
    `days=${days === null ? 'none' : days}`,
    `last_run=${lastResult ?? 'none'}`,
    ...(lastStage ? [`stage=${lastStage}`] : []),
    `runs=${runs.length}`,
    `cert=${certDays === null ? 'unknown' : certDays}`,
  ].join(' ');

  return {
    ok: alerts.length === 0,
    alerts,
    last_success_at: health.last_success_at,
    days_since_success: days,
    last_run_result: lastResult,
    last_run_stage: lastStage,
    cert_days_left: certDays,
    cert_state: certState,
    summary: alerts.length === 0
      ? `OK demecal: ${bits}`
      : `NG demecal: alerts=${alerts.map((a) => a.code).join(',')} ${bits}`,
    evaluated_at: now.toISOString(),
  };
}
