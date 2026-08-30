/**
 * admin: **デモ用アカウント**の一覧取得 / 追加 / 削除 API。
 *
 * 正本: `docs/operations/デモ用アカウント_仕様書.md`
 *
 * 【なぜ専用の口か】`/api/admin/config` の汎用モーダルでも `demo.account_uids` は
 * 編集できるが、**テキスト 1 行の塊を手で書き換える**形になる。
 * デモ用アカウントは **PR・お披露目で増えていく**運用なので、
 * 「いま誰が登録されているか」「1 件足す / 1 件外す」を安全にできる口を分けた。
 *
 * 【扱うのは uid だけ】`diagnostic_user_id` は **PII を含まない**。
 * 氏名・メールはここでは一切扱わない (PII は Wellfort 側にしか置かない取り決め)。
 *
 * 【admin 権限とは別物】この API は「デモ用アカウントを**管理する**」ためのもので、
 * **管理者にデモを見せるためのものではない**。デモの資格は uid の登録だけで決まり、
 * admin であることは資格にならない (仕様書 §2)。
 *
 *   GET    → { ok, rows:[{uid,label,source}], disabledGlobally, configRaw }
 *   POST   → { add:[{uid,label}] } または { remove:[uid] } → 更新後の一覧を返す
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY (`api-auth.ts`・キー未設定の本番は拒否)。
 * UI は wellfort-site 側 (`/admin/demo-accounts`)。**このリポジトリに admin 画面は作らない。**
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { refreshConfig, setConfig } from '../../../lib/app-config';
import { isUuid, listDemoAccounts, parseEntries } from '../../../lib/demo-accounts';

export const prerender = false;

const KEY = 'demo.account_uids';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 一覧は必ず**最新を取りに行ってから**返す (TTL 45 秒の残りで古い値を見せない)。 */
async function snapshot() {
  await refreshConfig(true);
  return listDemoAccounts();
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    return json({ ok: true, ...(await snapshot()) });
  } catch (e) {
    return json({ ok: false, error: 'list_failed', detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { add?: unknown; remove?: unknown; updated_by?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const add = Array.isArray(body.add) ? body.add : [];
  const remove = Array.isArray(body.remove) ? body.remove.map((v) => String(v).trim().toLowerCase()) : [];
  if (add.length === 0 && remove.length === 0) {
    return json({ ok: false, error: 'add_or_remove_required' }, 400);
  }

  const cur = await snapshot();
  // **編集できるのは app_config 由来だけ。** 組み込みと env はここからは動かせない。
  const entries = parseEntries(cur.configRaw);

  const rejected: { uid: string; reason: string }[] = [];

  for (const raw of add) {
    const uid = String((raw as { uid?: unknown })?.uid ?? raw ?? '').trim().toLowerCase();
    // **ラベルに改行と `#` を入れない** — 保存形式が 1 行 1 件なので行が壊れる。
    const label = String((raw as { label?: unknown })?.label ?? '').replace(/[\r\n#]/g, ' ').trim().slice(0, 80);
    if (!isUuid(uid)) { rejected.push({ uid, reason: 'uid の形式が違う' }); continue; }
    if (cur.rows.some((r) => r.uid === uid && r.source !== 'config')) {
      // 組み込み / env に既にある = すでにデモが出る。二重に足しても意味が無い。
      rejected.push({ uid, reason: '組み込み / env に既に登録されている (追加不要)' });
      continue;
    }
    const at = entries.findIndex((e) => e.uid === uid);
    if (at >= 0) entries[at] = { uid, label: label || entries[at].label };
    else entries.push({ uid, label });
  }

  for (const uid of remove) {
    if (cur.rows.some((r) => r.uid === uid && r.source !== 'config')) {
      rejected.push({ uid, reason: '組み込み / env は画面から外せない (コード / Vercel env を直す)' });
      continue;
    }
    const at = entries.findIndex((e) => e.uid === uid);
    if (at < 0) rejected.push({ uid, reason: '登録されていない' });
    else entries.splice(at, 1);
  }

  // 保存形式は **1 行 1 件 + `#` 注釈**。人が読める形で残す (admin が直接編集しても壊れない)。
  const value = entries.map((e) => (e.label ? `${e.uid}  # ${e.label}` : e.uid)).join('\n');

  /*
   * **中身が変わらないなら保存しない。**
   * 全件が却下されたリクエスト (形式違い / 組み込みを外そうとした 等) でも書きに行くと、
   * 保存の失敗が返って**却下理由が見えなくなる**。理由が伝わらないと admin は原因を追えない。
   */
  if (value !== cur.configRaw) {
    const updatedBy = typeof body.updated_by === 'string' ? body.updated_by : undefined;
    const r = await setConfig({ [KEY]: value }, updatedBy);
    if (!r.ok) return json({ ok: false, error: 'save_failed', detail: r, rejected }, 400);
  }

  return json({ ok: true, ...(await snapshot()), rejected });
};
