-- ============================================================================
-- Phase 2.0: チャネルUIガワ拡張 — Amazon / Yahoo / メール / LINE / 自社EC
--   - channels に 5行追加 (status='inactive') ※ cron sync は 'active' 限定
--   - 各チャネル 4 ticket × 5 = 20 ticket、message は inbound + 一部 outbound
--   - 冪等: external_id / channel_message_id を ON CONFLICT DO NOTHING
--   - Gemini 指摘反映: created_at を分散させて inbox 並びを自然に
-- ============================================================================

-- channels (inactive)
insert into public.channels (code, display_name, status, config) values
  ('amazon', 'Amazon',           'inactive', jsonb_build_object('phase','2.0_shell_only')),
  ('yahoo',  'Yahoo!ショッピング', 'inactive', jsonb_build_object('phase','2.0_shell_only')),
  ('email',  'メール',            'inactive', jsonb_build_object('phase','2.0_shell_only')),
  ('line',   '公式LINE',          'inactive', jsonb_build_object('phase','2.0_shell_only')),
  ('own_ec', '自社ECサイト',      'inactive', jsonb_build_object('phase','2.0_shell_only'))
on conflict (code) do nothing;

-- tickets + messages
do $$
declare
  v_now    timestamptz := now();
  rec_chan record;
begin
  -- 各チャネル ID を取得しながら処理
  for rec_chan in
    select id, code from public.channels
    where code in ('amazon','yahoo','email','line','own_ec')
  loop
    -- ----- tickets (4件 × 1チャネル) -----------------------------------------
    -- 共通テンプレ: defect / shipping / usage / other
    insert into public.tickets (
      channel_id, external_id, customer_name, customer_email, subject,
      status, product_id, case_category, defect_type, channel_meta, created_at
    )
    select
      rec_chan.id,
      rec_chan.code || '-seed-' || lpad(seq::text, 3, '0'),
      cust_name,
      cust_email,
      subject,
      status,
      product_id,
      case_category,
      defect_type,
      jsonb_build_object('order_number', order_number, 'seed', true, 'phase', '2.0'),
      v_now - offset_iv
    from (
      values
        -- 1: defect / size_mismatch / untouched / クールリング(3)
        (1,
         (case rec_chan.code
            when 'amazon' then '山本 健'
            when 'yahoo'  then '林 直樹'
            when 'email'  then '斎藤 義孝'
            when 'line'   then '横山 翔太'
            when 'own_ec' then '武田 達也'
          end),
         (case rec_chan.code
            when 'amazon' then 'ken.yamamoto@example.com'
            when 'yahoo'  then 'naoki.hayashi@example.com'
            when 'email'  then 'yoshitaka.saito@example.com'
            when 'line'   then 'shota.yokoyama@example.com'
            when 'own_ec' then 'tatsuya.takeda@example.com'
          end),
         (case rec_chan.code
            when 'amazon' then '【至急】サイズ違いの商品が届きました'
            when 'yahoo'  then 'サイズ違いの商品が届きました(Yahoo)'
            when 'email'  then 'お世話になっております。サイズ違いの商品到着について'
            when 'line'   then 'サイズ違ったよ'
            when 'own_ec' then '商品サイズ違いのご報告'
          end),
         'untouched',
         '3',
         'defect',
         'size_mismatch',
         '2026-05-01-' || upper(rec_chan.code) || '-001',
         interval '7 hours'
        ),
        -- 2: shipping / null / in_progress / アイマスク(6)
        (2,
         (case rec_chan.code
            when 'amazon' then '松本 凛'
            when 'yahoo'  then '藤田 さくら'
            when 'email'  then '山口 真奈美'
            when 'line'   then '三浦 杏'
            when 'own_ec' then '大西 ゆうこ'
          end),
         (case rec_chan.code
            when 'amazon' then 'rin.matsumoto@example.com'
            when 'yahoo'  then 'sakura.fujita@example.com'
            when 'email'  then 'manami.yamaguchi@example.com'
            when 'line'   then 'an.miura@example.com'
            when 'own_ec' then 'yuko.onishi@example.com'
          end),
         (case rec_chan.code
            when 'amazon' then '配送日変更のお願い'
            when 'yahoo'  then '配送日を変更したい(Yahoo)'
            when 'email'  then '配送日変更のご相談'
            when 'line'   then '配送日変えたいです！'
            when 'own_ec' then '配送日変更のお願い'
          end),
         'in_progress',
         '6',
         'shipping',
         null,
         '2026-05-02-' || upper(rec_chan.code) || '-002',
         interval '1 day 4 hours'
        ),
        -- 3: usage / null / done / ナノ歯ブラシ(2)
        (3,
         (case rec_chan.code
            when 'amazon' then '井上 大輔'
            when 'yahoo'  then '岡本 蓮'
            when 'email'  then '加藤 慎一'
            when 'line'   then '平野 一輝'
            when 'own_ec' then '池田 拓海'
          end),
         (case rec_chan.code
            when 'amazon' then 'daisuke.inoue@example.com'
            when 'yahoo'  then 'ren.okamoto@example.com'
            when 'email'  then 'shinichi.kato@example.com'
            when 'line'   then 'kazuki.hirano@example.com'
            when 'own_ec' then 'takumi.ikeda@example.com'
          end),
         (case rec_chan.code
            when 'amazon' then '使い方を教えてください'
            when 'yahoo'  then '使い方が分からない(Yahoo購入分)'
            when 'email'  then '商品の使い方についてのお問い合わせ'
            when 'line'   then '使い方おしえて'
            when 'own_ec' then '使い方を教えてほしい'
          end),
         'done',
         '2',
         'usage',
         null,
         '2026-04-28-' || upper(rec_chan.code) || '-003',
         interval '4 days'
        ),
        -- 4: other / null / untouched / 魔法のテープ(5)
        (4,
         (case rec_chan.code
            when 'amazon' then '清水 理恵'
            when 'yahoo'  then '木村 美和'
            when 'email'  then '阿部 香織'
            when 'line'   then '久保田 楓'
            when 'own_ec' then '西村 由紀'
          end),
         (case rec_chan.code
            when 'amazon' then 'rie.shimizu@example.com'
            when 'yahoo'  then 'miwa.kimura@example.com'
            when 'email'  then 'kaori.abe@example.com'
            when 'line'   then 'kaede.kubota@example.com'
            when 'own_ec' then 'yuki.nishimura@example.com'
          end),
         (case rec_chan.code
            when 'amazon' then '注文をキャンセルしたい'
            when 'yahoo'  then '注文キャンセル希望(Yahoo)'
            when 'email'  then 'ご注文のキャンセルについて'
            when 'line'   then '注文キャンセルしたい'
            when 'own_ec' then '注文のキャンセル希望'
          end),
         'untouched',
         '5',
         'other',
         null,
         '2026-05-03-' || upper(rec_chan.code) || '-004',
         interval '2 hours'
        )
    ) as v(seq, cust_name, cust_email, subject, status, product_id, case_category, defect_type, order_number, offset_iv)
    on conflict (channel_id, external_id) do nothing;

    -- ----- inbound message (各 ticket 1件) ----------------------------------
    insert into public.messages (ticket_id, direction, body, sender_name, sent_at, channel_message_id, attachments)
    select t.id, 'inbound',
      case
        when t.case_category = 'defect' and rec_chan.code = 'line' then E'届いた商品サイズが違ってた！\n交換できる？'
        when t.case_category = 'defect' and rec_chan.code = 'amazon' then E'お世話になります。\n本日Amazonで購入した商品が届きましたが、注文と異なるサイズが入っておりました。交換のご対応をお願いいたします。'
        when t.case_category = 'defect' and rec_chan.code = 'yahoo' then E'お世話になっております。\nYahoo!ショッピングで購入した商品が届きましたが、注文と異なるサイズでした。交換していただけますでしょうか。'
        when t.case_category = 'defect' and rec_chan.code = 'email' then E'お世話になっております。\nこの度貴社の商品を購入させていただきましたが、注文と異なるサイズの商品が届きましたため、ご連絡を差し上げました次第です。お手数ですが、ご対応の程よろしくお願いいたします。'
        when t.case_category = 'defect' and rec_chan.code = 'own_ec' then E'お世話になっております。\n貴社ECサイトで購入した商品が届きましたが、サイズが違っておりました。交換のご対応をお願いします。'
        when t.case_category = 'shipping' and rec_chan.code = 'line' then E'配送日を変えたいです！\n来週金曜にできますか？'
        when t.case_category = 'shipping' then E'お世話になっております。\nご注文いただいた商品の配送日を当初希望から変更したく、ご連絡いたしました。新しい希望日は来週金曜日です。'
        when t.case_category = 'usage' and rec_chan.code = 'line' then E'使い方が分からなくて困ってます。\n説明書見てもピンとこないので教えてください。'
        when t.case_category = 'usage' then E'お世話になっております。\n先日購入した商品の使い方が分からず困っております。説明書を拝見しましたがご教示いただけますでしょうか。'
        when t.case_category = 'other' and rec_chan.code = 'line' then E'注文キャンセルしたいんですけど可能ですか？'
        when t.case_category = 'other' then E'お世話になっております。\n本日いただいた注文をキャンセルしたく、ご連絡いたしました。可能でしょうか。'
        else t.subject
      end,
      t.customer_name,
      t.created_at,
      'inquiry:' || t.external_id,
      '[]'::jsonb
    from public.tickets t
    where t.channel_id = rec_chan.id
      and t.external_id like rec_chan.code || '-seed-%'
    on conflict (ticket_id, channel_message_id) do nothing;

    -- ----- in_progress に follow-up inbound + outbound 1 件 -----------------
    insert into public.messages (ticket_id, direction, body, sender_name, sent_at, channel_message_id, attachments)
    select t.id, 'inbound',
      case rec_chan.code when 'line' then E'返事まだですか？' else E'追記です。状況をお知らせいただけますと幸いです。' end,
      t.customer_name,
      t.created_at + interval '3 hours',
      'inquiry:' || t.external_id || ':followup',
      '[]'::jsonb
    from public.tickets t
    where t.channel_id = rec_chan.id
      and t.external_id like rec_chan.code || '-seed-%'
      and t.status = 'in_progress'
    on conflict (ticket_id, channel_message_id) do nothing;

    insert into public.messages (ticket_id, direction, body, sender_name, sent_at, channel_message_id, attachments)
    select t.id, 'outbound',
      case
        when rec_chan.code = 'line'
          then E'お問い合わせありがとうございます。配送日の変更承知しました。配送センターと確認のうえ改めてご連絡します。'
        else
          E'お問い合わせありがとうございます。\n配送日変更のご希望承りました。配送センターへ確認のうえ改めてご連絡いたします。\n\nオリジンツリー カスタマーサポート'
      end,
      'CSサポート',
      t.created_at + interval '5 hours',
      'reply:' || t.external_id || ':1',
      '[]'::jsonb
    from public.tickets t
    where t.channel_id = rec_chan.id
      and t.external_id like rec_chan.code || '-seed-%'
      and t.status = 'in_progress'
    on conflict (ticket_id, channel_message_id) do nothing;

    -- ----- done に outbound 1件 + resolved_at -------------------------------
    insert into public.messages (ticket_id, direction, body, sender_name, sent_at, channel_message_id, attachments)
    select t.id, 'outbound',
      case
        when rec_chan.code = 'line'
          then E'お問い合わせありがとうございます。使い方は以下のページをご確認ください。\nhttps://example.com/usage-guide'
        else
          E'お問い合わせありがとうございます。\n商品の使い方は以下のページに詳細を掲載しております。ご確認ください。\nhttps://example.com/usage-guide\n\nオリジンツリー カスタマーサポート'
      end,
      'CSサポート',
      t.created_at + interval '4 hours',
      'reply:' || t.external_id || ':1',
      '[]'::jsonb
    from public.tickets t
    where t.channel_id = rec_chan.id
      and t.external_id like rec_chan.code || '-seed-%'
      and t.status = 'done'
    on conflict (ticket_id, channel_message_id) do nothing;

    update public.tickets
    set resolved_at = created_at + interval '5 hours'
    where channel_id = rec_chan.id
      and external_id like rec_chan.code || '-seed-%'
      and status = 'done'
      and resolved_at is null;
  end loop;
end $$;
