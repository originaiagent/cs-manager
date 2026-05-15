-- ============================================================================
-- Phase 3.x ガワ実装用 ダミー seed
--   - sales_stats_cache  : 6製品 × 3期間 = 18行
--   - knowledge_articles : 18件 (company 4 / store 6 / product 8)
--   - improvement_suggestions : 6件
--   - product_improvement_proposals : 4件
--   - 冪等性: 一意キーがある sales_stats_cache は ON CONFLICT、
--             knowledge_articles は title 一意 + scope の自然キー化、
--             improvement_suggestions / product_improvement_proposals は
--             既存カウントで判定 (再実行時はスキップ)
-- ============================================================================

-- ----- sales_stats_cache ----------------------------------------------------
insert into public.sales_stats_cache (product_id, period, sales_count, as_of, synced_at) values
  -- product 3 (クールリング) — 不良率超過候補 (defect 6件 / 30d=80 → 7.5%)
  ('3',  '30d',   80, now(), now()),
  ('3',  '90d',  300, now(), now()),
  ('3',  'all', 4500, now(), now()),
  -- product 2 (ナノ歯ブラシ)
  ('2',  '30d',  120, now(), now()),
  ('2',  '90d',  400, now(), now()),
  ('2',  'all', 8000, now(), now()),
  -- product 5 (魔法のテープ)
  ('5',  '30d',   90, now(), now()),
  ('5',  '90d',  320, now(), now()),
  ('5',  'all', 6500, now(), now()),
  -- product 6 (アイマスク)
  ('6',  '30d',   60, now(), now()),
  ('6',  '90d',  200, now(), now()),
  ('6',  'all', 3500, now(), now()),
  -- product 10 (壁保護シート 44*5)
  ('10', '30d',   50, now(), now()),
  ('10', '90d',  180, now(), now()),
  ('10', 'all', 2000, now(), now()),
  -- product 16 (ペットケアセット グレー)
  ('16', '30d',   25, now(), now()),
  ('16', '90d',   80, now(), now()),
  ('16', 'all',  900, now(), now())
on conflict (product_id, period) do nothing;

-- ----- knowledge_articles --------------------------------------------------
-- 冪等化: 同じ title が既にある場合はスキップ (title はガワでは一意とみなす)
insert into public.knowledge_articles (
  storage_scope, storage_store_id, storage_product_id,
  applies_to_stores, applies_to_products, applies_to_categories, applies_to_defect_types,
  title, question, answer, body_markdown, tags, status, reference_count
)
select * from (values
  -- ===== company (4件) =====
  ('company'::text, null::text, null::text,
   '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[],
   '返品・交換ポリシー基本'::text,
   'お客様より返品・交換のご依頼を受けたとき、何日以内であれば対応できますか?'::text,
   E'商品到着後 8日以内であれば未開封・未使用に限り返品可能です。サイズ違い・初期不良の場合は到着後 30日以内まで交換対応可。詳細条件は社内ポリシーに準拠してください。'::text,
   E'## 返品・交換の基本ポリシー\n- 通常返品: 8日以内\n- 不良/サイズ違い: 30日以内\n- 着払い対応: 弊社責によるもののみ'::text,
   '{ポリシー,返品,交換,公式}'::text[],
   'published'::text, 27),

  ('company', null, null,
   '{}', '{}', '{}', '{}',
   '返金タイミング',
   '返金の処理日数を教えてください',
   E'クレジットカード: 締日翌月 / 銀行振込: 5営業日以内 / Amazon Pay: 即時。決済手段により異なります。',
   E'## 返金タイミング表\n| 決済手段 | 返金タイミング |\n|---|---|\n| クレジットカード | 締日翌月 |\n| 銀行振込 | 5営業日 |\n| Amazon Pay | 即時 |\n| 楽天ペイ | 5〜10日 |',
   '{返金,会計,公式}',
   'published', 11),

  ('company', null, null,
   '{}', '{}', '{}', '{}',
   '営業時間・休業日',
   'CS の対応時間を教えてください',
   E'平日 9:30〜18:00 (土日祝・年末年始・夏季休業を除く)。LINE は自動応答 24h、有人対応は同じ時間帯。',
   E'## 営業日カレンダー\n- 平日 9:30〜18:00\n- 年末年始: 12/30〜1/3\n- お盆休業: 8/13〜8/16',
   '{営業時間,体制,公式}',
   'published', 5),

  ('company', null, null,
   '{}', '{}', '{}', '{}',
   '個人情報・カード情報の取扱',
   'お客様のカード情報を直接やり取りしてもよいですか?',
   E'カード番号やセキュリティコードは絶対に直接やり取りしないでください。決済代行のサポート窓口へ案内してください。',
   E'## NG 行動\n- カード番号を返信文中に書かせる\n- 添付画像で番号送付を依頼する\n- メモに残す\n## OK 行動\n- 決済代行のサポート窓口を案内\n- 弊社では番号を扱えない旨明示',
   '{セキュリティ,個人情報,コンプライアンス}',
   'published', 3),

  -- ===== store (6件、各チャネル 1件) =====
  ('store', 'rakuten', null,
   '{rakuten}', '{}', '{}', '{}',
   '楽天 R-MessE 規約遵守事項',
   '楽天 R-MessE で禁止されている文言や対応はありますか?',
   E'楽天では「楽天会員」以外の表現を避ける、外部リンク誘導を禁止、二重価格表示禁止 等のガイドラインがあります。直接本文中で楽天外のサイトに誘導しないでください。',
   E'## R-MessE 注意点\n- 外部 EC への直接誘導禁止\n- ポイント関連の不確かな案内禁止\n- ガイドライン違反は店舗評価に直結',
   '{楽天,規約,ガイドライン}',
   'published', 18),

  ('store', 'amazon', null,
   '{amazon}', '{}', '{}', '{}',
   'Amazon FBA 返品処理ガイド',
   'Amazon FBA 経由で出荷した商品の返品手続きはどう案内しますか?',
   E'返品リクエストは Amazon マーケットプレイス側のフローで完結することがほとんどです。お客様には「Amazon の返品手続きから手続きください」とご案内し、弊社直接は対応不要です。',
   E'## FBA 返品の基本\n- 原則 Amazon フロー\n- 例外: 商品瑕疵の交換は弊社負担で再送\n- マケプレ評価対策で迅速対応必須',
   '{Amazon,FBA,返品}',
   'published', 9),

  ('store', 'yahoo', null,
   '{yahoo}', '{}', '{}', '{}',
   'Yahoo!ショッピング 決済関連FAQ',
   'Yahoo の決済不具合・PayPay 残高エラーについて',
   E'PayPay 残高不足や認証エラーは Yahoo!カスタマーサポートへ。弊社からは決済キャンセル → 再注文の案内のみ。',
   E'## 決済エラー対応\n- 残高不足 → Yahoo CS / 再注文案内\n- 認証エラー → 数分待機後リトライ\n- 弊社で決済操作は不可',
   '{Yahoo,決済,PayPay}',
   'published', 7),

  ('store', 'email', null,
   '{email}', '{}', '{}', '{}',
   'メール対応の署名・テンプレート',
   'メール返信時の標準署名と冒頭挨拶を教えてください',
   E'件名は「Re:」を残し、本文冒頭は「お世話になっております。オリジンツリー カスタマーサポートでございます。」、末尾は「オリジンツリー カスタマーサポート / 営業時間 9:30〜18:00 (土日祝休) / TEL 03-XXXX-XXXX」を必ず付与。',
   E'## メール標準テンプレ\n```\nお世話になっております。\nオリジンツリー カスタマーサポートでございます。\n\n[本文]\n\nオリジンツリー カスタマーサポート\n営業時間 9:30〜18:00 (土日祝休)\n```',
   '{メール,署名,テンプレート}',
   'published', 22),

  ('store', 'line', null,
   '{line}', '{}', '{}', '{}',
   '公式LINE 文体ガイドライン',
   'LINE 返信時のトーンとルールは?',
   E'敬語ベースだがメールより親しみのある「ですます調」、絵文字は控えめ (1メッセに 1個まで)。スタンプは緊急時以外不可。改行は短めに。',
   E'## LINE 文体\n- 敬語ベース、堅すぎない\n- 絵文字 1個まで\n- スタンプ × (緊急時除く)\n- 改行は 2〜3行で',
   '{LINE,トーン,ガイドライン}',
   'published', 14),

  ('store', 'own_ec', null,
   '{own_ec}', '{}', '{}', '{}',
   '自社EC会員ランクと特典案内',
   '自社ECの会員ランク制度と各ランクの特典を教えてください',
   E'ブロンズ/シルバー/ゴールド/プラチナの 4ランク。年間購入額で自動昇格。プラチナ会員は送料無料 + ポイント 2倍。',
   E'## 会員ランク早見\n| ランク | 条件 | 主な特典 |\n|---|---|---|\n| ブロンズ | 会員登録 | 通常 |\n| シルバー | 年 1万円〜 | ポイント 1.5倍 |\n| ゴールド | 年 5万円〜 | 送料無料(条件あり) |\n| プラチナ | 年 10万円〜 | 送料無料 + 2倍ポイント |',
   '{自社EC,会員制度,特典}',
   'published', 6),

  -- ===== product (8件) =====
  ('product', null, '3',
   '{}', '{3}', '{defect}', '{size_mismatch}',
   'クールリング サイズ違いの確認方法',
   'クールリングのサイズが違う、と問い合わせがあったときの確認手順',
   E'1) お客様が注文時に選択したサイズを楽天/Amazon等の管理画面で確認 → 2) 同梱伝票の SKU 末尾コードを再確認 → 3) 一致しない場合は再送 + 着払いで返送 (送料弊社負担)。',
   E'## 確認フロー\n1. 注文管理画面で注文サイズ確認\n2. 同梱伝票の SKU 末尾確認\n3. 違う場合は再送 + 着払い返送\n## SKU 末尾サイズ対応表\n- -S: スモール\n- -M: ミディアム\n- -L: ラージ',
   '{クールリング,サイズ,不良対応}',
   'published', 24),

  ('product', null, '3',
   '{}', '{3}', '{usage}', '{}',
   'クールリング 使用方法と注意事項',
   '使い方が分からないと問い合わせが来た場合の標準回答',
   E'冷凍庫で 2時間以上冷却 → 首/手首/足首に巻く → 30分程度で再冷却推奨。0℃以下になるため肌に長時間当てると凍傷の恐れがあるため、薄手のタオル越しに使用を推奨してください。',
   E'## 使い方の標準手順\n1. 冷凍庫 2時間以上\n2. 首/手首/足首に装着\n3. 30分で再冷却\n## 注意事項\n- 凍傷リスクあり (タオル越し推奨)\n- 1歳未満の乳児は使用不可',
   '{クールリング,使い方,注意}',
   'published', 31),

  ('product', null, '2',
   '{}', '{2}', '{usage}', '{}',
   'ナノ歯ブラシ 替えブラシの取り付け',
   '替えブラシをどう取り付けるか問い合わせ',
   E'本体下部のキャップを反時計回りに 1/4 回転で外し、ブラシ突起をスロットに合わせて押し込む → 時計回りで固定。LED が緑点灯すれば認識成功。',
   E'## 取付手順\n1. キャップを反時計回り 1/4回転\n2. ブラシ突起をスロットへ\n3. 時計回りで固定\n4. LED 緑点灯で認識成功',
   '{ナノ歯ブラシ,替えブラシ,取付}',
   'published', 12),

  ('product', null, '6',
   '{}', '{6}', '{usage}', '{}',
   'アイマスク 洗濯方法',
   'アイマスクを洗ってよいか問い合わせ',
   E'外側カバーは取り外して 30℃以下の水で手洗い可。中綿は洗濯不可、消毒スプレーで対応。乾燥機は変形のため使用禁止。',
   E'## 洗濯OK/NG\n- カバー: 30℃手洗い OK / 乾燥機 NG\n- 中綿: 水洗い NG (消毒スプレー)',
   '{アイマスク,洗濯,メンテ}',
   'published', 8),

  ('product', null, '5',
   '{}', '{5}', '{usage}', '{}',
   '魔法のテープ 貼り付け面の準備',
   '上手く貼り付かない場合のチェックポイント',
   E'1) 貼り付け面の埃・油分をアルコールで拭き取り完全乾燥 → 2) 圧着 (5kg 体重 30秒) → 3) 24時間後に本格使用。湿気・低温時 (5℃未満) は粘着力低下。',
   E'## 失敗しないコツ\n1. アルコール拭き → 乾燥\n2. 圧着 30秒\n3. 24h 養生\n## NG 環境\n- 低温 (5℃未満)\n- 高湿度 (浴室直貼り不可)',
   '{魔法のテープ,貼り付け,DIY}',
   'published', 17),

  ('product', null, '10',
   '{}', '{10}', '{defect,usage}', '{size_mismatch}',
   '壁保護シート サイズ選びガイド',
   'どのサイズを買えばよいか分からない',
   E'保護したい範囲を計測 → 余裕 +10cm を加算 → 該当する 44cm幅 / 90cm幅 から選択。長さは 2.5m / 5m / 10m。家具裏は 44幅、壁全面は 90幅推奨。',
   E'## サイズ早見表\n| 用途 | 幅 | 長さ |\n|---|---|---|\n| 家具裏 | 44cm | 2.5m |\n| 部分壁 | 44cm | 5m |\n| 全面壁 | 90cm | 5〜10m |',
   '{壁保護シート,サイズ,選び方}',
   'published', 19),

  ('product', null, '16',
   '{}', '{16}', '{defect,usage}', '{color_mismatch}',
   'ペットケアセット 各色の特徴',
   '色違いの問い合わせや好みの色を聞かれた場合',
   E'グレー: 中型〜大型犬向け汎用 / ブルー: 短毛種向け抜け毛取りに優れる / ピンク: 子犬・小型犬向け柔らか毛 / グリーン: 長毛種向けロング刃 / 蜂(イエロー): 限定色、機能はグレーと同等。',
   E'## カラー機能差\n- グレー: 汎用\n- ブルー: 短毛抜け毛◎\n- ピンク: 小型犬◎\n- グリーン: 長毛◎\n- 蜂: 機能=グレー (限定)',
   '{ペットケア,カラー,選び方}',
   'published', 9),

  ('product', null, '3',
   '{}', '{3}', '{usage}', '{}',
   'クールリング 効果が出ないときのチェック',
   '冷たく感じない・効果が薄いと言われたとき',
   E'1) 冷凍時間が足りない (推奨 2h+) → 2) 直射日光下では 15分で温まる → 3) 装着位置が血管の太い箇所 (首/手首/足首) でない → 4) 個体差 (室温 30℃以上だと体感差)。',
   E'## 体感の薄いケース\n- 冷凍 2h 未満\n- 屋外直射日光\n- 装着位置不適\n- 高室温',
   '{クールリング,効果,FAQ}',
   'draft', 0)
) as v(
  storage_scope, storage_store_id, storage_product_id,
  applies_to_stores, applies_to_products, applies_to_categories, applies_to_defect_types,
  title, question, answer, body_markdown, tags, status, reference_count
)
where not exists (
  select 1 from public.knowledge_articles existing
  where existing.title = v.title
);

-- ----- improvement_suggestions --------------------------------------------
-- 冪等化: 既に行があれば追加しない (count=0 のときだけ投入)
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.improvement_suggestions;
  if v_count > 0 then return; end if;

  insert into public.improvement_suggestions
    (target_type, target_product_id, current_content_ref, suggested_change, reasoning, source_data_summary, status)
  values
    ('manual', '3', 'manual:cool-ring/section-2-size',
     E'説明書のサイズ選定セクションに、SKU 末尾コードと対応サイズの早見表を追加する',
     E'過去30日のサイズ違い問い合わせが 6件中 4件、説明書からサイズ判定できず注文ミスにつながったケース。',
     jsonb_build_object('defect_count_30d', 6, 'product_id', '3', 'top_defect_type', 'size_mismatch', 'sample_tickets', 4),
     'draft'),

    ('faq', '3', 'faq:cool-ring/q-size-mismatch',
     E'よくある質問に「届いた商品のサイズが違う場合のセルフチェック手順」を新設',
     E'問い合わせ前に SKU 確認 + 注文画面確認で半数は自己解決可能と推測。',
     jsonb_build_object('defect_count_30d', 6, 'self_resolvable_estimate', 0.5),
     'draft'),

    ('manual', '10', 'manual:wall-sheet/cover',
     E'説明書のカバー裏面に「サイズ別用途早見表」を印刷追加',
     E'壁保護シートはサイズ展開が 6種類あり、用途と紐づかないため毎月数件ミス購入が発生。',
     jsonb_build_object('defect_count_30d', 1, 'historical_avg', 3, 'product_id', '10'),
     'accepted'),

    ('faq', '16', 'faq:pet-care/color-faq',
     E'FAQ に「カラー機能差比較表」を追加し、注文前のミス削減を図る',
     E'ペットケアセットは 5色 × 機能差があり、注文ミスが多発。',
     jsonb_build_object('defect_count_30d', 1, 'product_id', '16', 'top_defect_type', 'color_mismatch'),
     'draft'),

    ('manual', '6', 'manual:eye-mask/cleaning',
     E'説明書に「カバー外側のみ手洗い可、中綿は洗濯不可」を太字で再強調',
     E'問い合わせ件数は少ないが、誤洗濯による中綿変形クレームが発生。',
     jsonb_build_object('claim_count_90d', 2, 'product_id', '6'),
     'rejected'),

    ('faq', '5', 'faq:tape/cancellation',
     E'FAQ に「貼り付け失敗時の交換手続き」を追加',
     E'貼り付けミス → 返品要望が散見、再送ガイドが不足。',
     jsonb_build_object('cancel_request_count_90d', 5, 'product_id', '5'),
     'editing');
end $$;

-- ----- product_improvement_proposals -------------------------------------
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.product_improvement_proposals;
  if v_count > 0 then return; end if;

  insert into public.product_improvement_proposals
    (product_id, defect_rate, threshold_at_trigger, defect_breakdown, suggested_changes, reasoning, status)
  values
    ('3', 0.075, 0.05,
     jsonb_build_object('size_mismatch', 6, 'other', 0),
     jsonb_build_object(
       'design',     'SKU 表記を分かりやすく改修。同梱ラベルにサイズ大きく印字。',
       'material',   '変更不要。',
       'inspection', '出荷時の SKU 末尾コードと選択サイズ自動照合のしくみ導入。',
       'package',    '化粧箱表面のサイズ表記を 12pt → 18pt に拡大。',
       'other',      'カスタマー向け「サイズ確認動画」をECページに追加。'
     ),
     E'30日不良率 7.5% (6件 / 80販売) で閾値 5% を超過。原因は SKU と注文サイズの照合不足が多数。',
     'in_review'),

    ('3', 0.075, 0.05,
     jsonb_build_object('size_mismatch', 6),
     jsonb_build_object(
       'design',     '色だけでサイズが視認できる帯状デザインを追加。',
       'inspection', 'ピッキング担当の二重チェックを必須化。'
     ),
     E'代替案: 帯状デザインで視認性を上げる方向。コスト低、効果中。',
     'draft'),

    ('10', 0.02, 0.05,
     jsonb_build_object('size_mismatch', 1),
     jsonb_build_object(
       'design',     '商品写真にサイズ比較人物写真を追加。',
       'package',    '外装に対応サイズを大きく印字。'
     ),
     E'閾値未達だが慢性的にサイズ違いがあるため予防的提案。',
     'draft'),

    ('16', 0.04, 0.05,
     jsonb_build_object('color_mismatch', 1),
     jsonb_build_object(
       'design',     '色名を商品ページのカートボタン直前に再表記。',
       'inspection', '出荷時の色コードシール検査を追加。',
       'package',    'パッケージ側面の色シール拡大。'
     ),
     E'閾値超過寸前 (4%)。色違いの実害は再送+着払い+顧客満足度低下。',
     'draft');
end $$;
