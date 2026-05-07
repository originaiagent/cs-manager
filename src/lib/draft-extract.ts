/**
 * origin-ai のスキル実行結果から CS返信ドラフト本文だけを抽出する。
 *
 * origin-ai の DAG executor は最終ステップに STRUCTURED_OUTPUT_INSTRUCTION を付与し、
 * LLM 出力には「サマリー」「カテゴリ別の詳細」「返信ドラフト本文」「JSON ブロック」が
 * 混在する。ここでは draft 部分だけをユーザに見せたいので段階的に取り出す:
 *
 * 1. ```json ブロック内に data.draft があればそれを採用
 * 2. なければ本文の見出し「返信ドラフト本文」以降から JSON ブロック直前までを切り出す
 * 3. それも無理なら全文をそのまま返す (UI 側で目視可能)
 */

export function extractDraftFromAiResponse(
  rawMessage: string,
  structuredOutput: Record<string, unknown> | null | undefined,
): string {
  // 1. structured_output (validator が抜き出してくれた構造化データ) 優先
  if (structuredOutput && typeof structuredOutput === 'object') {
    const data = (structuredOutput as any).data;
    if (data && typeof data === 'object') {
      if (typeof data.draft === 'string' && data.draft.trim()) {
        return data.draft.trim();
      }
      if (typeof data.body === 'string' && data.body.trim()) {
        return data.body.trim();
      }
    }
  }

  // 2. ```json ブロック内 data.draft 抽出
  const jsonMatch = rawMessage.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const draft = parsed?.data?.draft ?? parsed?.draft;
      if (typeof draft === 'string' && draft.trim()) {
        return draft.trim();
      }
    } catch {
      // continue
    }
  }

  // 3. 「返信ドラフト本文」セクション抽出
  const sectionRe = /(?:^|\n)(?:#+\s*\d*\.?\s*)?返信ドラフト本文\s*\n([\s\S]*?)(?:\n```json|\n#+\s*\S|$)/;
  const sectionMatch = rawMessage.match(sectionRe);
  if (sectionMatch?.[1]) {
    return sectionMatch[1].replace(/^\s*-{3,}\s*$/gm, '').trim();
  }

  // 4. fallback: 全文
  return rawMessage.trim();
}
