/**
 * E2E: 構造化 社内用パネル (real-screen, prod data + prod agent)
 *
 * シナリオ: チケット詳細画面の「返信案を生成」(parseOk=true 経路) で描画される
 *   読み取り専用「社内用・送信されません」パネルが、新しい構造化 UI:
 *     - 関連ナレッジ候補 = 行 (日本語タイトル + Info アイコン + ExternalLink リンク)
 *     - Info アイコン → ポップオーバー (タイトル/想定問い合わせ/対応方針/ステータス + リンク)
 *     - リンク → /knowledge/<full-UUID> (実記事 200)
 *     - 対応メモ (箇条書き)
 *   を表示し、かつ:
 *     - パネル内に英語マーカー (<<<ORIGIN_CS… / INTERNAL_ / END_ORIGIN_CS) や
 *       ツールナレーション (「まず社内ナレッジを検索します」) を出さない
 *     - 送信欄 (textarea) には顧客向け返信のみが入る (社内テキスト非混入)
 * を実画面で証明する。
 *
 * 設計参照: reply-form.tsx / knowledge-meta-popover.tsx (実態優先で selector を実装)。
 * 既存構造ミラー: reply-split-sendsafe.spec.ts。
 *
 * 前提: LOCAL dev server (:3000)。.env.local の NEXT_PUBLIC_CORE_AUTH_ENABLED
 *   未設定/OFF のためログインゲート無し。ORIGIN_AI / Core は prod を指す。
 *
 * 生成の非決定性: managed agent はまれに開始センチネルへ narration を連結し
 *   parseOk=false (fail-closed) になる。構造化パネルは parseOk=true 経路でのみ
 *   描画されるため、parseOk=true (顧客向け見出し描画) になるまで最大
 *   MAX_GEN_ATTEMPTS 回 生成/再生成を試みてから本検証へ進む。
 */
import { test, expect, type Locator } from '@playwright/test';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

// キャンセル系 seeded ticket (subject「注文をキャンセルしたいです」)。
const TICKET_ID = '79f59f03-cbf1-40c0-bdb2-698d3cb667ea';
const TICKET_PATH = `/tickets/${TICKET_ID}`;

const SHOTS_DIR = resolve(process.cwd(), 'tests/e2e/screenshots');
mkdirSync(SHOTS_DIR, { recursive: true });
const shot = (name: string) => resolve(SHOTS_DIR, name);

// 生成 1 サイクル (LLM + tool round-trip) の許容時間。
// dev server の server-action 初回コンパイル + prod agent の遅延ぶれを吸収するため
// 直接計測値 (~35s) に対し十分な余裕を取る。
const GENERATE_TIMEOUT = 180_000;
// parseOk=true を得るまでの最大生成回数 (agent narration 連結の非決定性対策)。
const MAX_GEN_ATTEMPTS = 4;

// full UUID (36 文字、ハイフン込み) 判定。reply-form のリンクは /knowledge/<full-id>。
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 社内用パネル内に絶対に出してはいけない英語マーカー / ナレーション。
 * (送信欄ではなく「社内用パネルのテキスト」に対する契約。)
 */
const PANEL_FORBIDDEN = [
  '<<<ORIGIN_CS',
  'INTERNAL_',
  'END_ORIGIN_CS',
  'まず社内ナレッジを検索します',
];

/**
 * 送信欄 (textarea) に絶対に混入してはいけない内部マーカー (送信安全契約)。
 */
const SEND_FORBIDDEN = [
  '<<<ORIGIN_CS',
  'INTERNAL_',
  '📋',
  '⚠️',
  '検索結果',
  '担当者メモ',
  '根拠',
];

function assertNoMarkers(label: string, value: string, markers: string[]) {
  const hits = markers.filter((m) => value.includes(m));
  expect(hits, `${label} に禁止マーカーが混入: ${hits.join(', ')}`).toEqual([]);
  return hits;
}

test.describe('構造化 社内用パネル E2E', () => {
  test.setTimeout(MAX_GEN_ATTEMPTS * GENERATE_TIMEOUT + 120_000);

  test('生成 → 社内用パネルは構造化 (関連ナレッジ候補/Info popup/リンク/対応メモ) + 送信欄は顧客本文のみ', async ({
    page,
  }) => {
    // reply-form.tsx に scope したロケータ (h3「返信」を持つ rounded-xl カード)。
    const replyCard: Locator = page
      .locator('div.rounded-xl', {
        has: page.getByRole('heading', { name: '返信' }),
      })
      .first();

    // ── Step 1: キャンセル系 ticket 詳細へ遷移 → 生成 (parseOk=true まで再生成) ──
    // hydration 保証: domcontentloaded で素早く描画を待ち、networkidle (timeout 明示)
    // で React Server Action バインドの hydration を待つ。
    // (hydration 前にクリックすると onClick が失われ Server Action POST が発火しない。)
    await page.goto(TICKET_PATH, { waitUntil: 'domcontentloaded' });
    await expect(replyCard).toBeVisible({ timeout: 15_000 });
    await page
      .waitForLoadState('networkidle', { timeout: 30_000 })
      .catch(() => {
        // prod data の遅延応答で networkidle に達しない場合があるが、
        // 以降の generateBtn enabled + Server Action POST 観測で hydration を担保する。
      });

    const generateBtn = replyCard.getByRole('button', { name: '返信案を生成' });
    await expect(generateBtn).toBeVisible();
    await expect(generateBtn).toBeEnabled();

    const customerOnlyHeader = replyCard.getByText(
      '顧客向け返信 (この内容のみ送信されます)',
    );
    const failClosedNotice = replyCard.getByText(/自動分離に失敗しました/);

    // 生成前の送信欄値 (過去採用ドラフトの復元値 or 空)。fail-closed 不変条件の基準。
    const sendBeforeGen = await replyCard.locator('textarea').inputValue();
    assertNoMarkers('生成前 送信欄', sendBeforeGen, SEND_FORBIDDEN);

    let parseOk = false;
    for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt += 1) {
      const actionRespPromise = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.request().headers()['next-action'] !== undefined &&
          new URL(r.url()).pathname === TICKET_PATH,
        { timeout: GENERATE_TIMEOUT },
      );

      const trigger =
        attempt === 1
          ? generateBtn
          : replyCard.getByRole('button', { name: '再生成' });
      await expect(trigger).toBeVisible();
      await trigger.click();

      await expect(customerOnlyHeader.or(failClosedNotice)).toBeVisible({
        timeout: GENERATE_TIMEOUT,
      });

      const actionResp = await actionRespPromise;
      const status = actionResp.status();
      console.log(`[evidence] attempt=${attempt} Server Action POST = ${status}`);
      expect(status).toBe(200);

      if (await customerOnlyHeader.isVisible()) {
        parseOk = true;
        console.log(`[evidence] parseOk=true on attempt ${attempt}`);
        break;
      }

      // fail-closed: 送信欄は生成前から不変 (送信安全契約どおり)。
      const sendOnFail = await replyCard.locator('textarea').inputValue();
      expect(sendOnFail, 'fail-closed 時、送信欄は生成前から不変').toBe(
        sendBeforeGen,
      );
      console.log(`[evidence] attempt=${attempt} fail-closed → 再生成`);
    }

    expect(
      parseOk,
      `parseOk=true を ${MAX_GEN_ATTEMPTS} 回以内に取得 (構造化パネル描画の前提)`,
    ).toBe(true);

    await page.screenshot({
      path: shot('internal-panel-1-generated.png'),
      fullPage: true,
    });

    // 社内用パネル領域 (「社内用・送信されません」ラベルの祖先 space-y-3 ブロック)。
    const internalLabel = replyCard.getByText(/社内用・送信されません/);
    await expect(internalLabel).toBeVisible();
    const internalPanel = internalLabel.locator('xpath=ancestor::div[1]');
    await expect(internalPanel).toBeVisible();

    // ── Step 2: 社内用パネルに英語マーカー / ナレーション無し ──────────
    const panelText = await internalPanel.innerText();
    console.log(
      `[evidence] internal-panel text first200 = ${JSON.stringify(panelText.slice(0, 200))}`,
    );
    assertNoMarkers('社内用パネル', panelText, PANEL_FORBIDDEN);
    await page.screenshot({
      path: shot('internal-panel-2-no-markers.png'),
      fullPage: true,
    });

    // ── Step 3: 関連ナレッジ候補 行 (日本語タイトル + Info ボタン + リンク) ──
    const knowledgeHeading = internalPanel.getByText(/関連ナレッジ候補/);
    await expect(knowledgeHeading).toBeVisible();
    // 行 = グレー枠 li。Info ボタン (aria-label 記事の詳細を表示) を持つ li。
    const rows = internalPanel.locator('li', {
      has: page.getByRole('button', { name: '記事の詳細を表示' }),
    });
    const rowCount = await rows.count();
    console.log(`[evidence] grounding row count = ${rowCount}`);
    expect(rowCount, '関連ナレッジ候補 行 >= 1').toBeGreaterThanOrEqual(1);

    const firstRow = rows.first();
    const firstRowTitle = (await firstRow.locator('span.truncate').first().innerText()).trim();
    console.log(`[evidence] first grounding row title = ${JSON.stringify(firstRowTitle)}`);
    expect(firstRowTitle.length, '行に日本語タイトルがある').toBeGreaterThan(0);
    expect(
      /[ぁ-んァ-ヶ一-龯]/.test(firstRowTitle),
      '行タイトルに日本語が含まれる',
    ).toBe(true);

    const infoBtn = firstRow.getByRole('button', { name: '記事の詳細を表示' });
    await expect(infoBtn).toBeVisible();
    const rowLink = firstRow.getByRole('link', { name: 'ナレッジ詳細を開く' });
    await expect(rowLink).toBeVisible();
    // href を今のうちに取得 (後段の「編集」クリックでパネルが消えるため)。
    const href = await rowLink.getAttribute('href');
    console.log(`[evidence] grounding row link href = ${href}`);

    // ── Step 4: Info popup 開閉 + メタラベル + 実コンテンツ ────────────
    await infoBtn.click();
    const dialog = page.getByRole('dialog', { name: 'ナレッジ記事の詳細' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // メタラベル (knowledge-meta-popover.tsx: 想定問い合わせ/対応方針/ステータス)。
    await expect(dialog.getByText('想定問い合わせ')).toBeVisible();
    await expect(dialog.getByText('対応方針')).toBeVisible();
    await expect(dialog.getByText('ステータス')).toBeVisible();
    const dialogText = (await dialog.innerText()).trim();
    console.log(
      `[evidence] popup meta first300 = ${JSON.stringify(dialogText.slice(0, 300))}`,
    );
    // ダイアログにタイトル (h4) + 実コンテンツがある。
    const dialogTitle = (await dialog.getByRole('heading').first().innerText()).trim();
    console.log(`[evidence] popup title = ${JSON.stringify(dialogTitle)}`);
    expect(dialogText.length).toBeGreaterThan(20);
    // popup 内にも詳細リンクがある。
    const popupLink = dialog.getByRole('link', { name: 'ナレッジ詳細を開く' });
    await expect(popupLink).toBeVisible();
    await page.screenshot({
      path: shot('internal-panel-3-popup-open.png'),
      fullPage: true,
    });

    // 閉じる (X ボタン) → 消える。
    await dialog.getByRole('button', { name: '閉じる' }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await page.screenshot({
      path: shot('internal-panel-4-popup-closed.png'),
      fullPage: true,
    });

    // ── 対応メモ (箇条書き) セクション — Done条件: 見出し + li >= 1 を必須検証 ──
    // (codex review #1: 表示ログだけでは internalNotesText が空に壊れても通るため必須化。)
    const notesHeading = internalPanel.getByText(/対応メモ/);
    await expect(notesHeading).toBeVisible();
    // 対応メモ見出し直下の ul.list-disc の li (箇条書き行)。
    const notesItems = internalPanel.locator('ul.list-disc > li');
    const notesCount = await notesItems.count();
    console.log(`[evidence] 対応メモ 箇条書き li count = ${notesCount}`);
    expect(notesCount, '対応メモ 箇条書き行 >= 1').toBeGreaterThanOrEqual(1);
    const firstNote = (await notesItems.first().innerText()).trim();
    console.log(`[evidence] 対応メモ first item = ${JSON.stringify(firstNote.slice(0, 80))}`);
    expect(firstNote.length).toBeGreaterThan(0);

    // ── Step 6 (先取り): Regression — 送信欄 textarea は顧客本文のみ (clean) ──
    // 記事ページへ遷移すると ticket ページの client state (rag preview) が破棄される
    // ため、採用→送信欄検証を「記事遷移前」に実施する。
    const sendTextarea = replyCard.locator('textarea');
    await expect(sendTextarea).toHaveCount(1);
    // 顧客向けプレビュー <pre> (送信される唯一のテキスト) を取得。
    const customerPre = replyCard.locator('pre.text-gray-800').first();
    await expect(customerPre).toBeVisible();
    const customerText = (await customerPre.innerText()).trim();
    console.log(
      `[evidence] customer-body first120 = ${JSON.stringify(customerText.slice(0, 120))}`,
    );
    assertNoMarkers('顧客向けプレビュー', customerText, SEND_FORBIDDEN);
    expect(customerText.length).toBeGreaterThan(0);
    expect(
      /お世話になっております|お世話になります|キャンセル|承り|ご注文|誠に|申し訳|ご連絡/.test(
        customerText,
      ),
      'もっともらしい顧客向け返信文',
    ).toBe(true);

    // codex review #2: 「送信欄は顧客本文のみ」契約を強検証する。
    // 「編集」クリック → textarea にプレビュー本文 (= 送信される唯一のテキスト) が入る。
    // (採用は DB 保存を伴うため、送信欄混入の検証目的では副作用の小さい「編集」を使う。)
    await replyCard.getByRole('button', { name: '編集' }).click();
    await expect(sendTextarea).not.toHaveValue('', { timeout: 15_000 });
    const sendValue = (await sendTextarea.inputValue()).trim();
    console.log(
      `[evidence] send-field (textarea) first120 = ${JSON.stringify(sendValue.slice(0, 120))}`,
    );
    // 送信欄に禁止マーカー 0 ヒット (送信安全)。
    const sendHits = assertNoMarkers('送信欄 textarea', sendValue, SEND_FORBIDDEN);
    console.log(`[evidence] send-field marker hits = ${sendHits.length}`);
    expect(sendValue.length).toBeGreaterThan(0);
    // 送信欄 = 顧客向けプレビューと正規化一致 (社内テキスト非混入の証明)。
    const norm = (s: string) =>
      s.replace(/\r\n/g, '\n').replace(/[ \t　]+/g, '').trim();
    expect(
      norm(sendValue),
      '送信欄 textarea は顧客向けプレビューと一致 (社内テキスト非混入)',
    ).toBe(norm(customerText));
    await page.screenshot({
      path: shot('internal-panel-6-send-clean.png'),
      fullPage: true,
    });

    // ── Step 5: リンク href = /knowledge/<full-UUID> → 実記事 200 ──────
    // (client state を破棄する full navigation のため最後に実施。href は Step 3 で取得済み。)
    expect(href, 'リンク href は /knowledge/<uuid>').toMatch(
      /^\/knowledge\/[0-9a-f-]{36}$/i,
    );
    const uuid = href!.replace('/knowledge/', '');
    expect(UUID_RE.test(uuid), `full 36-char UUID (8文字短縮でない): ${uuid}`).toBe(
      true,
    );

    // 別タブを開かず page.goto で直接ロード → 200 + 詳細描画 (404/notFound でない)。
    const resp = await page.goto(href!, { waitUntil: 'networkidle' });
    console.log(`[evidence] /knowledge/${uuid} status = ${resp?.status()}`);
    expect(resp?.status(), 'ナレッジ詳細ページは 200').toBe(200);
    // notFound でない証拠: 「ナレッジ一覧に戻る」リンク (詳細ページ固有) が見える。
    await expect(
      page.getByRole('link', { name: /ナレッジ一覧に戻る/ }),
    ).toBeVisible({ timeout: 10_000 });
    // 記事タイトル h1 が見える (実記事)。
    const detailHeading = page.locator('h1').first();
    await expect(detailHeading).toBeVisible({ timeout: 10_000 });
    const detailTitle = (await detailHeading.innerText()).trim();
    console.log(`[evidence] article page h1 = ${JSON.stringify(detailTitle)}`);
    expect(detailTitle.length).toBeGreaterThan(0);
    await page.screenshot({
      path: shot('internal-panel-5-article.png'),
      fullPage: true,
    });
  });
});
