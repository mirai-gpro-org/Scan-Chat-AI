/**
 * admin: AI疾病予防報告書の **抽出監査** を返す API。
 *
 * 正本: `docs/elith/ai_prevention_report_generation_spec.md` §1.3.6
 *
 * 【なぜ要るか】受領テキストからの抽出はフォーマット依存で **fail-safe** (拾えなければ
 *   何も出さない) にしてある。誤った要点は出ないが、**黙って空になる**ので、
 *   それだけでは形式変更に気づけない。実際 Stage2 → Stage3 で `判定区分` と `[pN]` が消え、
 *   `elith-report-highlights.ts` が無言で空になる状態になった (§5.2)。
 *   → **何を認識し、何を拾えなかったかを admin から見えるようにする。**
 *   スキャン側の `vqa_audit` と同じ流儀。
 *
 * 【表示データには混ぜない】監査はここだけで返す。`/report` の紙面には出さない。
 *
 * 【責務の分界】UI は wellfort-site 側 (CLAUDE.md「admin UI は wellfort-site に置く」)。
 *   本ファイルは API のみ。認可は Bearer ADMIN_API_KEY。
 */

import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { loadReportVM } from '../../../../lib/elith-report-queries';
import { resolveChapters } from '../../../../lib/report-sections';
import { refreshConfig, cfg } from '../../../../lib/app-config';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const diagnosticUserId = (url.searchParams.get('diagnostic_user_id') ?? '').trim();
  if (diagnosticUserId && !UUID_RE.test(diagnosticUserId)) {
    return json({ ok: false, error: 'invalid diagnostic_user_id' }, 400);
  }

  await refreshConfig();

  /*
    **表示と同じ経路で組み立てる。** 監査だけ別の読み方をすると、
    「監査は緑なのに画面が空」を検知できない。
    `diagnostic_user_id` を省くとサンプル (2026-08-26 受領分) の監査が返る。
  */
  const vm = await loadReportVM(diagnosticUserId || null);
  const resolved = resolveChapters();

  return json({
    ok: true,
    is_sample: vm.isSample,
    issued_on: vm.cover.issuedOn,
    template_version: vm.cover.templateVersion,
    type: vm.type,
    wellness_age: vm.cover.wellnessAge,

    // 受領データから何を認識できたか
    recognized_sections: vm.audit.recognizedSections,
    topics: vm.audit.topicCount,
    measurements: vm.audit.measurementCount,
    references: vm.audit.referenceCount,

    // 何を出さなかったか。**材料が無い章は出さない**のが仕様なので、
    // ここが空でないこと自体は異常ではない。何が落ちたかを見えるようにするだけ。
    chapters_shown: vm.chapters.map((c) => c.key),
    chapters_skipped: vm.audit.skippedChapters,
    chapters_hidden: vm.audit.hiddenChapters,

    // 気づきたい異常 (同名別値・本文にしかない値・ウェルネス年齢の不一致・未知の章キー)
    anomalies: vm.audit.anomalies,

    // 現在の章立て設定 (app_config)。**空 = コード既定**。
    config: {
      order: cfg('report.sections.order'),
      hidden: cfg('report.sections.hidden'),
      labels: cfg('report.sections.labels'),
      collapsed: cfg('report.sections.collapsed'),
      unknown_keys: resolved.unknown,
    },
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
