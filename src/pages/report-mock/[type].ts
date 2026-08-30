import type { APIRoute } from 'astro';
import type1 from '../../../docs/elith/mock/ai_prevention_report_type1.html?raw';
import type2 from '../../../docs/elith/mock/ai_prevention_report_type2.html?raw';

/**
 * 紙面モックをそのまま配信する口 (テストフェーズ限定)。
 *
 * 【目的】**タイプ1 (コースプラン) を関係者に先に見てもらう** (発注者指示 2026-08-30)。
 *   タイプ1 は該当検体の JSON が Elith から未受領で、**実装は v0.2** (仕様書 §2.1)。
 *   ここで出しているのは**モックそのもの**であって、実装ではない。
 *   **PDF から推測して紙面を作り込まない**という線 (引継ぎ書 §2-2) を越えないための形。
 *
 * 【中身に手を入れない】`docs/elith/mock/*.html` を **1 バイトも書き換えずに**返す。
 *   モックが紙面の正 (仕様書 §2) なので、配信用の写しを作ると正が 2 つになる。
 *   前に付けるのは doctype と charset/viewport だけ — Artifact で公開したときの
 *   外枠と同じで、**中身の表示モードを揃えるためのもの** (無いと quirks mode になる)。
 *
 * 【個人情報は無い】タイプ1 は「（ご本人氏名）様」、タイプ2 は合成検体。
 *   実顧客のデータはこの経路に一切乗らない (DB を引かない)。
 *
 * 【総合テストで閉じる】入口は `/dashboard` の「デバッグ (テストフェーズ確認用)」。
 *   **デバッグ欄を遮蔽するときに、この口も一緒に閉じる。**
 */
export const prerender = false;

const MOCKS: Record<string, { html: string; label: string }> = {
  '1': { html: type1, label: 'タイプ1 コースプラン' },
  '2': { html: type2, label: 'タイプ2 単品購入相当' },
};

/** Artifact で公開したときの外枠と同じ最小の頭。中身には触らない。 */
const HEAD = '<!doctype html><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">';

export const GET: APIRoute = ({ params }) => {
  const mock = MOCKS[params.type ?? ''];
  if (!mock) {
    return new Response('紙面モックは /report-mock/1 (コースプラン) と /report-mock/2 (単品購入相当) だけです。', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(HEAD + mock.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // 未完成の紙面案なので検索に載せない
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'no-store',
    },
  });
};
