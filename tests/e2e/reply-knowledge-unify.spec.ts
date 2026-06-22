/**
 * E2E: 統合ナレッジ参照 返信案生成 (real-screen, prod data + prod agent)
 *
 * シナリオ: チケット詳細画面の単一「返信案を生成」ボタンが
 *   generateRagDraft (Server Action) → /api/tickets/[id]/draft-rag
 *   → masked context → origin-ai agent `customer-reply-writer`
 *   → cs-manager prod `knowledge_search` MCP tool → ナレッジ参照ドラフト
 * を生成し、「採用」で ticket_drafts(source='ai_draft') として永続化される
 * フローを実画面で証明する。
 *
 * 前提: LOCAL dev server (:3000) を起動済み。.env.local の
 *   NEXT_PUBLIC_CORE_AUTH_ENABLED が OFF のためログインゲート無し、
 *   ORIGIN_AI_URL / Core creds は prod を指すため agent + knowledge_search は
 *   prod を叩き、ドラフトは共有 prod Supabase に保存される。
 *
 * 注意 (POST200 観測について):
 *   /api/tickets/[id]/draft-rag への POST は generateRagDraft という
 *   **Server Action** 内で internalFetch (サーバ側) として実行される。
 *   ブラウザは draft-rag を直接叩かないため draft-rag への
 *   waitForResponse はヒットしない。ブラウザから観測可能なのは
 *   Server Action 呼び出し (page route `/tickets/[id]` への Next-Action POST)
 *   であり、これが 200 を返すこと + プレビューが描画されること
 *   (= draft-rag がサーバ側で 200 を返した場合のみ描画される) で
 *   end-to-end の成功を証明する。
 *
 * 生成は実 LLM + tool round-trip のため ~40s かかる → 寛大な timeout を設定。
 */
import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const TICKET_ID = 'ac68db96-b9c9-485d-bb20-057e38d3294a';
const TICKET_PATH = `/tickets/${TICKET_ID}`;

const SHOTS_DIR = resolve(process.cwd(), 'tests/e2e/screenshots');
mkdirSync(SHOTS_DIR, { recursive: true });
const shot = (name: string) => resolve(SHOTS_DIR, name);

// 生成 1 サイクル (LLM + tool round-trip) の許容時間。
const GENERATE_TIMEOUT = 120_000;

// 永続化を DB で直接確認するための service_role クライアント。
// (採用ドラフトが「今回」保存されたことを誤合格なく証明するため)
function supa(): SupabaseClient {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\s+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').replace(/\s+$/, '');
  if (!url || !key) throw new Error('Supabase env 未設定 (.env.local 確認)');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe('統合ナレッジ参照 返信案生成 E2E', () => {
  // 生成ステップを含むため test 全体の timeout を引き上げる
  test.setTimeout(GENERATE_TIMEOUT + 60_000);

  test('単一ボタンで生成 → 採用 → リロード永続化', async ({ page }) => {
    const sb = supa();
    // 採用が「今回」保存されたことを証明するための基準時刻。
    const testStart = new Date(Date.now() - 1000).toISOString();

    // 返信フォーム (reply-form.tsx) に scope したロケータ群。
    // 「返信」見出しを持つカードに限定し、構造変更耐性を上げる。
    const replyCard = page
      .locator('div.rounded-xl', { has: page.getByRole('heading', { name: '返信' }) })
      .first();

    // ── Check 1: チケット詳細へ遷移 ────────────────────────────────
    await page.goto(TICKET_PATH, { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: /商品が届きません/ }),
    ).toBeVisible({ timeout: 15_000 });

    // ── Check 2: 「返信案を生成」ボタンがちょうど 1 つ。旧 2 ボタン UI が無い ──
    const generateBtn = replyCard.getByRole('button', { name: '返信案を生成' });
    await expect(generateBtn).toHaveCount(1);
    await expect(generateBtn).toBeVisible();
    // 旧 UI (AIドラフト生成 / RAG返信案生成) が消えていること
    await expect(
      page.getByRole('button', { name: 'AIドラフト生成' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'RAG返信案生成' }),
    ).toHaveCount(0);
    await page.screenshot({ path: shot('reply-unify-1-single-button.png'), fullPage: true });

    // ── Check 3: クリック → ドラフトプレビュー描画 ───────────────────
    // Server Action POST (page route への Next-Action POST) の 200 を観測。
    // draft-rag 自体はサーバ側 internalFetch のためブラウザからは見えない。
    // Server Action POST は page route (`/tickets/<id>`) への Next-Action POST。
    // next-action header 必須 + 末尾 path 完全一致で限定し、誤捕捉を防ぐ。
    const actionRespPromise = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.request().headers()['next-action'] !== undefined &&
        new URL(r.url()).pathname === TICKET_PATH,
      { timeout: GENERATE_TIMEOUT },
    );

    await generateBtn.click();

    // プレビュー枠 (ナレッジ参照 AI) が描画されるまで待つ
    const previewHeader = replyCard.getByText('返信案 (ナレッジ参照 AI)');
    await expect(previewHeader).toBeVisible({ timeout: GENERATE_TIMEOUT });

    const actionResp = await actionRespPromise;
    const actionStatus = actionResp.status();
    console.log(`[evidence] Server Action POST status = ${actionStatus} (${actionResp.url()})`);
    expect(actionStatus).toBe(200);

    // プレビュー本文 (pre) を取得 — 非空 + ナレッジ由来の配送内容
    const previewPre = replyCard.locator('pre.whitespace-pre-wrap').first();
    await expect(previewPre).toBeVisible();
    const draftText = (await previewPre.innerText()).trim();
    console.log(`[evidence] draft length = ${draftText.length}`);
    console.log(`[evidence] draft snippet = ${draftText.slice(0, 200)}`);
    expect(draftText.length).toBeGreaterThan(0);
    // ナレッジ参照 (配送関連: 楽天最強配送遅延) の内容を反映していること
    expect(draftText).toMatch(/最強配送|発送|日本郵便|配送/);

    await page.screenshot({ path: shot('reply-unify-2-preview.png'), fullPage: true });

    // ── Check 4: 「採用」→ textarea に反映 + source ラベルが AI(ナレッジ参照) ──
    // 採用前の textarea 値 (前回ドラフト or 空) を控え、採用で変化することを確認する。
    const textarea = replyCard.locator('textarea');
    const beforeAdopt = await textarea.inputValue();

    await replyCard.getByRole('button', { name: '採用' }).click();

    // 採用後 textarea が、生成本文 (キーワード一致) を保持し、採用前から変化していること。
    // textarea は setBody(rag.draft) の raw 値を保持するため、これを永続化照合の真値とする
    // (preview <pre> の innerText は空白正規化が入りうるため raw 比較には使わない)。
    await expect(textarea).toHaveValue(/最強配送|発送|日本郵便|配送/, {
      timeout: 30_000,
    });
    const adoptedValue = await textarea.inputValue();
    expect(adoptedValue.trim().length).toBeGreaterThan(0);
    expect(adoptedValue, '採用で textarea が更新される').not.toBe(beforeAdopt);
    const expectedAdopted = adoptedValue;

    // source ラベル: 「下書きソース: AI(ナレッジ参照)」
    await expect(
      replyCard.getByText(/下書きソース:\s*AI\(ナレッジ参照\)/),
    ).toBeVisible({ timeout: 30_000 });

    // 採用 = 楽観的 UI 更新 (setBody/setSource) → await saveDraft の順なので、
    // UI 反映後に保存が完了したことを「保存済み」表示で待ってから DB 照合する。
    await expect(
      replyCard.getByText(/保存済み/),
    ).toBeVisible({ timeout: 30_000 });

    await page.screenshot({ path: shot('reply-unify-3-adopted.png'), fullPage: true });

    // ── DB 直接確認: 採用が「今回」保存された行であることを証明 ───────────
    // 過去 ai_draft や並行生成行での誤合格を排除するため、
    //   source='ai_draft' かつ created_at >= testStart かつ body が採用本文と内容一致
    // する行が「存在する」ことを確認する (latest 1 行に依存しない)。
    // 改行コード/末尾空白の正規化のみ行い比較 (controlled textarea / 保存経路で
    // \r\n→\n 等の正規化が入りうるため、byte 厳密一致ではなく正規化一致で判定)。
    const norm = (s: string) =>
      s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    const expectedNorm = norm(expectedAdopted);

    // 保存は非同期 (await saveDraft) のため、DB 反映を最大 30s poll で待つ
    // (保存完了前に query が走る race を排除)。
    type DraftRow = { id: string; body: string; source: string; created_at: string };
    let match: DraftRow | undefined;
    await expect
      .poll(
        async () => {
          const { data, error } = await sb
            .from('ticket_drafts')
            .select('id, body, source, created_at')
            .eq('ticket_id', TICKET_ID)
            .eq('source', 'ai_draft')
            .gte('created_at', testStart)
            .order('created_at', { ascending: false })
            .limit(10);
          if (error) throw new Error(`ticket_drafts 取得失敗: ${error.message}`);
          match = (data as DraftRow[] | null)?.find(
            (r) => norm(r.body) === expectedNorm,
          );
          return match ? 'found' : 'not-yet';
        },
        {
          message: `今回採用した ai_draft 行 (body 内容一致, created_at >= ${testStart}) が保存される`,
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe('found');
    expect(match!.body).toMatch(/最強配送|発送|日本郵便|配送/);
    console.log(
      `[evidence] persisted ticket_drafts: id=${match!.id} source=${match!.source} created_at=${match!.created_at}`,
    );

    // ── Check 5: リロード → 採用ドラフトが永続化 (DB 行 + GET 経由 UI 復元) ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: /商品が届きません/ }),
    ).toBeVisible({ timeout: 15_000 });

    const textareaAfter = replyCard.locator('textarea');
    // リロード後も採用本文が復元されること (= DB→GET→UI)。
    // ナレッジ内容の一致 + 永続化行 (match.body) との正規化一致で証明する。
    await expect(textareaAfter).toHaveValue(/最強配送|発送|日本郵便|配送/, {
      timeout: 15_000,
    });
    const reloadedValue = await textareaAfter.inputValue();
    expect(
      norm(reloadedValue),
      'リロード後 textarea は永続化された採用本文を復元する',
    ).toBe(norm(match!.body));
    // 永続化された source ラベルも復元される
    await expect(
      replyCard.getByText(/下書きソース:\s*AI\(ナレッジ参照\)/),
    ).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: shot('reply-unify-4-persisted.png'), fullPage: true });
  });
});
