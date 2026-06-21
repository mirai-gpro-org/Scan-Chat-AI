// ============================================================
// sync-announcements — HP/EC `news` → diagnosis.announcements 片方向 pull 同期
//
// 方式 (HP/EC「web連携_IF仕様とマッピング」v0.4 合意): pull 型。
//   #2 (本 Edge Function) が #1 `app_bridge.announcement_source` ビュー
//   (news を read-only 公開) を取得し、diagnosis.announcements へ upsert する。
//   突合キー: source_news_id (= news.id)。冪等。
//
// cadence: 日次〜数十分 (pg_cron / スケジューラから起動)。
//
// 必要な env:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   … #2 (本プロジェクト、自動付与)
//   HP_BRIDGE_SUPABASE_URL / HP_BRIDGE_READONLY_KEY … #1 app_bridge 読み取り専用ロール
//
// ※ ドラフト: #1 接続情報・ビュー列が確定し次第、列マッピングを最終化する。
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (_req) => {
  try {
    // --- #1 (HP/EC) app_bridge 読み取り専用クライアント ---
    const bridge = createClient(
      Deno.env.get("HP_BRIDGE_SUPABASE_URL")!,
      Deno.env.get("HP_BRIDGE_READONLY_KEY")!,
      { db: { schema: "app_bridge" } },
    );

    // --- #2 (本プロジェクト) diagnosis 書込みクライアント ---
    const diagnosis = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { db: { schema: "diagnosis" } },
    );

    // 1) HP `news` を app_bridge ビュー経由で取得
    //    想定列: source_news_id(=news.id) / title / content / image_url /
    //            link_url / link_text / published_at / created_at / updated_at
    const { data: source, error: srcErr } = await bridge
      .from("announcement_source")
      .select(
        "source_news_id, title, content, image_url, link_url, link_text, published_at",
      );
    if (srcErr) throw srcErr;

    // 2) announcements 形へマッピング (content→body, category='news' 固定)
    //    HP news は HP/Web 双方掲載対象として visible_on_* を true にする。
    const rows = (source ?? []).map((n) => ({
      source_news_id: n.source_news_id,
      category: "news" as const,
      title: n.title,
      body: n.content,
      image_url: n.image_url,
      link_url: n.link_url,
      link_text: n.link_text,
      published_at: n.published_at,
      published_until: null, // news に終了日カラムは無い (HP 回答) = 無期限
      visible_on_hp: true,
      visible_on_web: true,
    }));

    // 3) source_news_id を突合キーに冪等 upsert
    let upserted = 0;
    if (rows.length > 0) {
      const { error: upErr, count } = await diagnosis
        .from("announcements")
        .upsert(rows, { onConflict: "source_news_id", count: "exact" });
      if (upErr) throw upErr;
      upserted = count ?? rows.length;
    }

    return Response.json({ success: true, data: { fetched: rows.length, upserted } });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
});
