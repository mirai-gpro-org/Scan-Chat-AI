/**
 * 統合 Database 型 — 2 schema (customer / diagnosis) を Supabase JS クライアント用に統合。
 *
 * supabase gen types で各スキーマを別ファイルに生成した後、これを介して
 * createClient<Database>() に渡す。
 *
 * 再生成手順 (PowerShell):
 *   supabase gen types typescript --local --schema customer  | Out-File -Encoding utf8 src/types/supabase-customer.ts
 *   supabase gen types typescript --local --schema diagnosis | Out-File -Encoding utf8 src/types/supabase-diagnosis.ts
 */

import type { Database as CustomerDB } from './supabase-customer';
import type { Database as DiagnosisDB } from './supabase-diagnosis';

export type Database = {
  customer: CustomerDB['customer'];
  diagnosis: DiagnosisDB['diagnosis'];
};

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// 型エイリアス (各テーブルの Row 型をすぐ使えるように)
export type CustomerProfile  = Database['customer']['Tables']['customer_profiles']['Row'];
export type LabCompany       = Database['customer']['Tables']['lab_companies']['Row'];
export type SubscriptionPlan = Database['customer']['Tables']['subscription_plans']['Row'];
export type Subscription     = Database['customer']['Tables']['subscriptions']['Row'];
export type KitShipment      = Database['customer']['Tables']['kit_shipments']['Row'];
export type LabTest          = Database['customer']['Tables']['lab_tests']['Row'];

export type AppUser              = Database['diagnosis']['Tables']['app_users']['Row'];
export type TestArtifact         = Database['diagnosis']['Tables']['test_artifacts']['Row'];
export type TestArtifactFile     = Database['diagnosis']['Tables']['test_artifact_files']['Row'];
export type DiagnosisResult      = Database['diagnosis']['Tables']['diagnosis_results']['Row'];
