// ============================================================
// sync-announcements — HP/EC `news` → diagnosis.announcements 片方向 pull 同期
//
// 方式 (案A 確定 / v0.9): pull 型。HP の `news-feed` Edge Function を呼び、
//   announcements 形に整形済みの news を取得して #2 diagnosis.announcements へ upsert。
//   突合キー: source_news_id (= news.id)。冪等。
//
// v0.5→v0.9 の変更: 取得元が app_bridge.announcement_source ビューから
//   HP の news-feed Edge Function (HTTP) に変更。差分 pull (since) に対応。
//
// 削除突合 (A-6 v1.0): HP `news` は削除追跡が無いため、フル同期 (since 未指定) 時に
//   feed に存在しない news 由来 announcement を visible_on_web=false へ論理削除する。
//   → 日次はフル同期 (SYNC_SINCE 未指定) を推奨。SYNC_SINCE 指定時は差分のみで突合しない。
//
// cadence: 日次フル (推奨) 〜 短間隔は差分 (pg_cron / スケジューラから起動)。
//
// 必要な env:
//   HP_EDGE_BASE_URL          … HP #1 Edge Function ベース URL
//   RESOLVE_SHARED_SECRET     … x-resolve-secret ヘッダ (HP 生成・Vault 共有)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY … #2 (本プロジェクト、自動付与)
//   SYNC_SINCE (任意)         … 差分 pull の updated_at 下限 (ISO8601)。未指定=全件+削除突合。
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface NewsFeedItem {
  source_news_id: string;
  title: string;
  body: string;
  image_url: string | null;
  link_url: string | null;
  link_text: string | null;
  published_at: string;
  published_until: string | null;
  updated_at: string | null;
  // HP に visible_on_web を載せてもらう場合に使用 (案A v0.9 で依頼)。
  // 未提供時は true 扱い (news → HP+Web 表示)。論理削除は false で届く想定。
  visible_on_web?: boolean;
}

Deno.serve(async (_req) => {
  try {
    const edgeBase = Deno.env.get("HP_EDGE_BASE_URL");
    const secret = Deno.env.get("RESOLVE_SHARED_SECRET");
    if (!edgeBase) throw new Error("HP_EDGE_BASE_URL is not configured");

    // 1) HP news-feed を取得 (差分 pull 対応: since)
    const since = Deno.env.get("SYNC_SINCE");
    const url = new URL(`${edgeBase}/functions/v1/news-feed`);
    if (since) url.searchParams.set("since", since);
    const feedRes = await fetch(url.toString(), {
      method: "GET",
      headers: { ...(secret ? { "x-resolve-secret": secret } : {}) },
    });
    if (!feedRes.ok) throw new Error(`news-feed HTTP ${feedRes.status}`);
    const feed = (await feedRes.json()) as { success: boolean; data: NewsFeedItem[]; error?: string };
    if (!feed.success) throw new Error(feed.error ?? "news-feed failed");

    // 2) announcements 形へマッピング (category='news' 固定)
    //    フラグ: news → HP+Web。visible_on_web は feed があれば尊重 (論理削除/掲載面トグル)。
    const rows = (feed.data ?? []).map((n) => ({
      source_news_id: n.source_news_id,
      category: "news" as const,
      title: n.title,
      body: n.body,
      image_url: n.image_url,
      link_url: n.link_url,
      link_text: n.link_text,
      published_at: n.published_at,
      published_until: n.published_until ?? null,
      visible_on_hp: true,
      visible_on_web: n.visible_on_web ?? true,
    }));

    // 3) #2 diagnosis.announcements へ source_news_id を突合キーに冪等 upsert
    const diagnosis = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "diagnosis" } },
    );

    let upserted = 0;
    if (rows.length > 0) {
      const { error: upErr, count } = await diagnosis
        .from("announcements")
        .upsert(rows, { onConflict: "source_news_id", count: "exact" });
      if (upErr) throw upErr;
      upserted = count ?? rows.length;
    }

    // 4) 削除突合 (reconciliation) — A-6 v1.0:
    //    HP `news` は削除追跡が無く feed から消えることで削除を表す。
    //    フル同期時 (since 未指定) のみ、feed に存在しない news 由来 announcement を
    //    visible_on_web=false に論理削除する。
    let hidden = 0;
    if (!since) {
      const ids = rows.map((r) => r.source_news_id);
      let q = diagnosis
        .from("announcements")
        .update({ visible_on_web: false }, { count: "exact" })
        .eq("category", "news")
        .eq("visible_on_web", true)
        .not("source_news_id", "is", null);
      if (ids.length > 0) {
        q = q.not("source_news_id", "in", `(${ids.join(",")})`);
      }
      const { error: recErr, count } = await q;
      if (recErr) throw recErr;
      hidden = count ?? 0;
    }

    return Response.json({ success: true, data: { fetched: rows.length, upserted, hidden } });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
});
