/**
 * AI 問診の system instruction に注入するためのユーザー文脈を生成する。
 *
 * セキュリティ:
 *   - Service role key で読むため、サーバ側 (Astro SSR / API route) からのみ呼ぶこと。
 *   - 戻り値は LLM の prompt に入る。PII は氏名・年齢・性別程度に留め、生年月日・住所等は載せない。
 *
 * 出力サイズ目安: 400 〜 800 字 (token 数を抑えるため要約・圧縮する)。
 */

import { getServerSupabase } from './supabase';
import {
  extractMetricCards,
  extractUrgentAlert,
  type ElithSection,
} from './elith-parser';

export async function buildUserContextForChat(
  diagnosticUserId: string | null | undefined,
): Promise<string | null> {
  if (!diagnosticUserId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) return null;

  const sb = getServerSupabase();
  if (!sb) return null;

  const [{ data: customer }, { data: latestResult }] = await Promise.all([
    sb
      .schema('customer')
      .from('customer_profiles')
      .select('family_name, given_name, date_of_birth, sex')
      .eq('diagnostic_user_id', diagnosticUserId)
      .maybeSingle(),
    sb
      .schema('diagnosis')
      .from('diagnosis_results')
      .select('received_at, summary_text, report, status')
      .eq('diagnostic_user_id', diagnosticUserId)
      .eq('status', 'published')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!customer && !latestResult) return null;

  const lines: string[] = [];
  lines.push('【問診相手のコンテキスト — 検査結果から取得済】');

  if (customer) {
    const parts: string[] = [`${customer.family_name}${customer.given_name ?? ''}さん`];
    const age = customer.date_of_birth ? calcAge(customer.date_of_birth) : null;
    if (age != null) parts.push(`${age}歳`);
    const sex = sexLabel(customer.sex);
    if (sex) parts.push(sex);
    lines.push(`- 対象: ${parts.join('・')}`);
  }

  if (latestResult?.received_at) {
    const d = new Date(latestResult.received_at);
    lines.push(`- 直近 AI 診断: ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 受領`);
  }

  if (latestResult?.summary_text) {
    lines.push(`- サマリー: 「${compress(latestResult.summary_text, 280)}」`);
  }

  const sections = (latestResult?.report as ElithSection[] | null) ?? [];
  if (sections.length > 0) {
    const metrics = extractMetricCards(sections);
    const notable = metrics.filter((m) => m.level !== 'normal');
    if (notable.length > 0) {
      lines.push('- 注目指標:');
      for (const m of notable.slice(0, 5)) {
        const v = `${m.value}${m.unit ? ' ' + m.unit : ''}`;
        const lvl = levelLabel(m.level);
        lines.push(`  - ${m.label} ${v}${lvl ? ` (${lvl})` : ''}`);
      }
    }

    const alert = extractUrgentAlert(sections);
    if (alert) {
      lines.push(`- 緊急留意: ${compress(alert.body || alert.title, 200)}`);
    }
  }

  lines.push('');
  lines.push('上記コンテキストは問診の前提知識として保持し、');
  lines.push('・ユーザーの過去検査の話題が出たら自然に呼応してよい');
  lines.push('・気になる指標があれば、関連セクション (食生活/運動 等) の質問でさり気なく気遣いを差し込んでよい');
  lines.push('禁則:');
  lines.push('・コンテキスト自体を暗唱・列挙しない (聞かれたら「お持ちの検査結果から参考にさせていただいています」程度に留める)');
  lines.push('・診断・処方は絶対にしない');
  lines.push('・問診票 (Q1-1 〜 Q5-2) の質問順は変えない、項目を統合しない');
  lines.push('');

  return lines.join('\n');
}

function calcAge(birth: string): number | null {
  const d = new Date(birth);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age >= 0 ? age : null;
}

function sexLabel(s: string | null | undefined): string | null {
  if (s === 'male') return '男性';
  if (s === 'female') return '女性';
  return null;
}

function levelLabel(level: string): string | null {
  switch (level) {
    case 'high':           return '高';
    case 'slightly_high':  return 'やや高';
    case 'low':            return '低';
    case 'slightly_low':   return 'やや低';
    default:               return null;
  }
}

function compress(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '…';
}
