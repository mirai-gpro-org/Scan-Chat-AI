/**
 * HP/EC #1 `app_bridge` スキーマの型 (手書き)。
 *
 * Web は #1 の app_bridge のみを read-only で参照する (生 PII テーブルは参照しない)。
 * 列定義は統合仕様書「web連携_統合仕様書.md」§5 に準拠。
 *   - customer_account / subscription / kit_shipment (3 テーブル)
 * ※ news の取得は app_bridge ビューではなく HP の news-feed Edge Function 経由
 *   (案A v0.9)。`supabase/functions/sync-announcements` を参照。
 */

export type BridgeDatabase = {
  app_bridge: {
    Tables: {
      customer_account: {
        Row: {
          diagnostic_user_id: string;
          hp_customer_id: string;
          display_name: string | null;
          sex: string | null;
          birth_year: number | null;
          status: string;
          synced_at: string | null;
          source_updated_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      subscription: {
        Row: {
          diagnostic_user_id: string;
          plan_code: string | null;
          plan_name: string | null;
          status: string;
          started_at: string | null;
          next_test_at: string | null;
          last_test_at: string | null;
          synced_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      kit_shipment: {
        Row: {
          id: string;
          diagnostic_user_id: string;
          order_id: string | null;
          test_type: string;
          shipping_status: string | null;
          instruction_sent_at: string | null;
          shipped_at: string | null;
          tracking_no: string | null;
          delivered_at: string | null;
          user_received_at: string | null;
          user_returned_at: string | null;
          synced_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type BridgeCustomerAccount = BridgeDatabase['app_bridge']['Tables']['customer_account']['Row'];
export type BridgeSubscription    = BridgeDatabase['app_bridge']['Tables']['subscription']['Row'];
export type BridgeKitShipment     = BridgeDatabase['app_bridge']['Tables']['kit_shipment']['Row'];
