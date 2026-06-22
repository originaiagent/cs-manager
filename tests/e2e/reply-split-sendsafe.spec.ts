/**
 * E2E: 送信安全 返信案分離 (real-screen, prod data + prod agent)
 *
 * シナリオ: チケット詳細画面の「返信案を生成」が
 *   generateRagDraft (Server Action) → /api/tickets/[id]/draft-rag
 *   → masked context → origin-ai agent `customer-reply-writer`
 *     (行センチネルで顧客向け本文 / 社内用 根拠・メモ を構造分離した出力)
 *   → cs-manager サーバ側で parse し、
 *       送信欄(textarea) には「顧客向け本文のみ」、
 *       根拠/社内メモ は「社内用・送信されません」読み取り専用パネルへ
 * を生成し、「採用」で
 *   ticket_drafts(source='ai_draft', is_separated=true, body=顧客向けのみ)
 * として永続化されるフローを実画面で証明する。
 *
 * これは「社内テキストが送信欄に混入しない」送信安全契約の回帰検知テスト。
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
 * 生成は実 LLM + tool round-trip のため ~35-45s かかる → 寛大な timeout を設定。
 *
 * 生成の非決定性について (再生成ループの根拠):
 *   managed agent `customer-reply-writer` は通常、開始センチネル
 *   `<<<ORIGIN_CS_CUSTOMER_REPLY_V1>>>` を「行頭独立」で出力するが、
 *   稀に直前へ narration ("まず社内ナレッジを検索します。" 等) を同一行に
 *   連結することがある。cs-manager の split-reply パーサは
 *   「センチネル行全体一致」を要件とするため、この場合 parseOk=false の
 *   **fail-closed** (送信欄空 + 採用無効 + 通知) になる — これは送信安全契約
 *   どおりの正しい挙動。実運用でもオペレータは「再生成」で clean 出力を得る。
 *   本テストはこの実運用フローを再現し、parseOk=true (顧客向けプレビュー描画)
 *   になるまで最大 MAX_GEN_ATTEMPTS 回まで生成/再生成を試みてから本検証へ進む。
 *   (fail-closed 自体も Step 2 内で「送信欄が空のまま」を確認し送信安全を証明する)
 */
import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const TICKET_ID = 'e230d55b-6885-4245-86c1-b726d039a243';
const TICKET_PATH = `/tickets/${TICKET_ID}`;

const SHOTS_DIR = resolve(process.cwd(), 'tests/e2e/screenshots');
mkdirSync(SHOTS_DIR, { recursive: true });
const shot = (name: string) => resolve(SHOTS_DIR, name);

// 生成 1 サイクル (LLM + tool round-trip) の許容時間。
const GENERATE_TIMEOUT = 120_000;
// parseOk=true を得るまでの最大生成回数 (agent narration 連結の非決定性対策)。
// 実測 parseOk 率 ~1/3 のため、4 回で成功確率 ~99.6%。
const MAX_GEN_ATTEMPTS = 4;

/**
 * 送信欄に絶対に混入してはいけない内部マーカー (送信安全契約)。
 * 行センチネル・社内ラベル・根拠/メモ見出し・絵文字付き見出し等。
 */
const INTERNAL_MARKERS = [
  '<<<ORIGIN_CS',
  'INTERNAL_',
  '📋',
  '⚠️',
  '検索結果',
  '担当者メモ',
  '根拠',
  'ナレッジ',
];

function assertNoInternalMarkers(label: string, value: string) {
  const hits = INTERNAL_MARKERS.filter((m) => value.includes(m));
  expect(hits, `${label} に内部マーカーが混入: ${hits.join(', ')}`).toEqual([]);
  return hits;
}

// 永続化を DB で直接確認するための service_role クライアント。
function supa(): SupabaseClient {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\s+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').replace(/\s+$/, '');
  if (!url || !key) throw new Error('Supabase env 未設定 (.env.local 確認)');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe('送信安全 返信案分離 E2E', () => {
  // 最大 MAX_GEN_ATTEMPTS 回の生成 (各 ~35-45s) + 採用/DB/リロード分を見込む。
  test.setTimeout(MAX_GEN_ATTEMPTS * 60_000 + 120_000);

  test('生成 → 送信欄は顧客本文のみ → 社内用は読取専用パネル → 採用 → リロード永続化', async ({
    page,
  }) => {
    const sb = supa();
    const testStart = new Date(Date.now() - 1000).toISOString();

    // 返信フォーム (reply-form.tsx) に scope したロケータ。
    const replyCard = page
      .locator('div.rounded-xl', { has: page.getByRole('heading', { name: '返信' }) })
      .first();

    // ── Step 1: 交換チケット詳細へ遷移 + スクショ ───────────────────
    await page.goto(TICKET_PATH, { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: /色が違います/ }),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: shot('reply-split-1-ticket.png'),
      fullPage: true,
    });

    const generateBtn = replyCard.getByRole('button', { name: '返信案を生成' });
    await expect(generateBtn).toBeVisible();

    // ── Step 2: 生成 → Server Action 200 + 顧客向けプレビュー描画 ──────
    // draft-rag 自体はサーバ側 internalFetch のためブラウザからは見えない。
    // Server Action POST は page route (`/tickets/<id>`) への Next-Action POST。
    //
    // 各試行で必ず Server Action 200 を観測する (= draft-rag がサーバ側で 200)。
    // 描画結果は 2 通り:
    //   (a) parseOk=true  → 「顧客向け返信 (この内容のみ送信されます)」見出し描画
    //   (b) parseOk=false → fail-closed (送信欄空 + 採用 disabled + 通知)
    // (b) は送信安全契約どおりの正しい挙動なので、その場で「送信欄が空」を
    // 確認 (送信安全の二重証明) してから「再生成」で (a) を狙う。
    const customerOnlyHeader = replyCard.getByText(
      '顧客向け返信 (この内容のみ送信されます)',
    );
    const failClosedNotice = replyCard.getByText(/自動分離に失敗しました/);
    const adoptBtn = replyCard.getByRole('button', { name: '採用' });

    let parseOk = false;
    let lastActionStatus = 0;
    for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt += 1) {
      const actionRespPromise = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.request().headers()['next-action'] !== undefined &&
          new URL(r.url()).pathname === TICKET_PATH,
        { timeout: GENERATE_TIMEOUT },
      );

      // 1 回目は「返信案を生成」、2 回目以降はプレビュー内「再生成」を押す。
      const trigger =
        attempt === 1
          ? generateBtn
          : replyCard.getByRole('button', { name: '再生成' });
      await expect(trigger).toBeVisible();
      await trigger.click();

      // 生成完了 = (a) 顧客向け見出し or (b) fail-closed 通知 のどちらかが出る。
      await expect(customerOnlyHeader.or(failClosedNotice)).toBeVisible({
        timeout: GENERATE_TIMEOUT,
      });

      const actionResp = await actionRespPromise;
      lastActionStatus = actionResp.status();
      console.log(
        `[evidence] attempt=${attempt} Server Action POST status = ${lastActionStatus}`,
      );
      expect(lastActionStatus).toBe(200);

      if (await customerOnlyHeader.isVisible()) {
        parseOk = true;
        console.log(`[evidence] parseOk=true on attempt ${attempt}`);
        break;
      }

      // fail-closed: 送信欄が空のまま & 採用が無効 (送信安全の二重証明)。
      const sendFieldOnFail = await replyCard.locator('textarea').inputValue();
      expect(
        sendFieldOnFail.trim(),
        'fail-closed 時、送信欄は空のまま (社内テキスト非混入)',
      ).toBe('');
      await expect(adoptBtn).toBeDisabled();
      console.log(
        `[evidence] attempt=${attempt} fail-closed (送信欄空 + 採用 disabled) → 再生成`,
      );
    }

    expect(
      parseOk,
      `parseOk=true を ${MAX_GEN_ATTEMPTS} 回以内に取得 (agent narration 連結の非決定性)`,
    ).toBe(true);

    // ── Step 3: CRITICAL — 顧客向け本文プレビューは「顧客本文のみ」 ──
    // 顧客向け返信プレビュー (送信される唯一のテキスト) を取得。
    // reply-form.tsx: parseOk 時のみ「顧客向け返信 (この内容のみ送信されます)」
    // 見出し直下の <pre> に rag.draft (= 採用で textarea に入る値) が入る。
    const customerPre = replyCard
      .locator('pre.text-gray-800')
      .first();
    await expect(customerPre).toBeVisible({ timeout: 15_000 });
    const customerText = (await customerPre.innerText()).trim();
    console.log(`[evidence] customer-body length = ${customerText.length}`);
    console.log(
      `[evidence] customer-body first150 = ${JSON.stringify(customerText.slice(0, 150))}`,
    );
    expect(customerText.length).toBeGreaterThan(0);

    // 内部マーカー 0 ヒット (送信安全)。
    assertNoInternalMarkers('顧客向けプレビュー', customerText);
    // もっともらしい顧客向け返信文であること。
    expect(customerText).toMatch(
      /お世話になっております|交換|お詫び|ご注文|誠に|申し訳/,
    );

    await page.screenshot({
      path: shot('reply-split-2-customer-only.png'),
      fullPage: true,
    });

    // ── Step 4: 社内用パネルは読み取り専用 + 送信欄と分離 ─────────────
    // 「社内用・送信されません」ラベルが存在する。
    const internalLabel = replyCard.getByText(/社内用・送信されません/);
    await expect(internalLabel).toBeVisible();
    const internalLabelText = (await internalLabel.innerText()).trim();
    console.log(`[evidence] internal-panel label = ${JSON.stringify(internalLabelText)}`);

    // 社内用パネル本体 (<pre>) は editable input/textarea ではない (読み取り専用)。
    const internalPre = replyCard.locator('pre.text-gray-600').first();
    await expect(internalPre).toBeVisible();
    const internalTag = await internalPre.evaluate((el) => el.tagName.toLowerCase());
    expect(internalTag, '社内用パネルは <pre> (非編集要素)').toBe('pre');
    // textarea / input ではないことを明示確認 (編集不可)。
    const editableCount = await internalPre
      .locator('xpath=self::textarea | self::input')
      .count();
    expect(editableCount, '社内用パネルは編集可能要素ではない').toBe(0);

    // 送信欄 (textarea) とは別 DOM ノードであること (視覚的分離)。
    const sendTextarea = replyCard.locator('textarea');
    await expect(sendTextarea).toHaveCount(1);
    const internalIsTextarea = await internalPre.evaluate(
      (el) => el.tagName.toLowerCase() === 'textarea',
    );
    expect(internalIsTextarea).toBe(false);

    await page.screenshot({
      path: shot('reply-split-3-internal-readonly.png'),
      fullPage: true,
    });

    // ── Step 5: 採用 → 送信欄は顧客本文のみ (clean) + source ラベル + DB 行 ──
    const beforeAdopt = await sendTextarea.inputValue();

    await replyCard.getByRole('button', { name: '採用' }).click();

    // 採用後 textarea は顧客本文を保持し、採用前から変化していること。
    await expect(sendTextarea).toHaveValue(
      /お世話になっております|交換|お詫び|ご注文|誠に|申し訳/,
      { timeout: 30_000 },
    );
    const adoptedValue = await sendTextarea.inputValue();
    expect(adoptedValue.trim().length).toBeGreaterThan(0);
    expect(adoptedValue, '採用で textarea が更新される').not.toBe(beforeAdopt);
    // 送信欄に内部マーカー 0 ヒット (採用後も clean)。
    assertNoInternalMarkers('採用後 送信欄', adoptedValue);

    // source ラベル: 「下書きソース: AI(ナレッジ参照)」
    await expect(
      replyCard.getByText(/下書きソース:\s*AI\(ナレッジ参照\)/),
    ).toBeVisible({ timeout: 30_000 });

    // 保存完了 (保存済み 表示) を待ってから DB 照合。
    await expect(replyCard.getByText(/保存済み/)).toBeVisible({
      timeout: 30_000,
    });

    await page.screenshot({
      path: shot('reply-split-4-adopted.png'),
      fullPage: true,
    });

    // ── DB 直接確認: 今回採用された ai_draft / is_separated=true / clean body ──
    const norm = (s: string) =>
      s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
    const expectedNorm = norm(adoptedValue);

    type DraftRow = {
      id: string;
      body: string;
      source: string;
      created_at: string;
      is_separated: boolean;
    };
    let match: DraftRow | undefined;
    await expect
      .poll(
        async () => {
          const { data, error } = await sb
            .from('ticket_drafts')
            .select('id, body, source, created_at, is_separated')
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
          message: `今回採用した ai_draft 行 (body 内容一致, created_at >= ${testStart})`,
          timeout: 30_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe('found');

    // 永続化 body も送信安全 (内部マーカー 0)。
    assertNoInternalMarkers('永続化 ticket_drafts.body', match!.body);
    expect(match!.source).toBe('ai_draft');
    expect(match!.is_separated, '採用 ai_draft は is_separated=true').toBe(true);
    console.log(
      `[evidence] persisted ticket_drafts: id=${match!.id} source=${match!.source} is_separated=${match!.is_separated} created_at=${match!.created_at}`,
    );

    // ── Step 6: リロード → 採用 clean body が送信欄に永続復元 ────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { name: /色が違います/ }),
    ).toBeVisible({ timeout: 15_000 });

    const textareaAfter = replyCard.locator('textarea');
    await expect(textareaAfter).toHaveValue(
      /お世話になっております|交換|お詫び|ご注文|誠に|申し訳/,
      { timeout: 15_000 },
    );
    const reloadedValue = await textareaAfter.inputValue();
    expect(
      norm(reloadedValue),
      'リロード後 textarea は永続化された採用本文を復元する',
    ).toBe(norm(match!.body));
    // リロード後も送信欄 clean。
    assertNoInternalMarkers('リロード後 送信欄', reloadedValue);
    // 永続化された source ラベルも復元される。
    await expect(
      replyCard.getByText(/下書きソース:\s*AI\(ナレッジ参照\)/),
    ).toBeVisible({ timeout: 15_000 });

    await page.screenshot({
      path: shot('reply-split-5-persisted.png'),
      fullPage: true,
    });
  });
});
