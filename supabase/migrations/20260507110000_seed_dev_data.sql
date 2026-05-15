-- ============================================================================
-- Phase 1.2: 開発用 seed データ
--   - 楽天 R-MessE 風のダミーチケット 8件 + メッセージ
--   - 冪等: external_id / channel_message_id を使った ON CONFLICT DO NOTHING
--   - 製品IDは Core (origin-core) の実在 ID を文字列で格納（B案原則: マスタコピー禁止）
--     使用 ID: '2' (ナノ歯ブラシ), '3' (クールリング), '5' (魔法のテープ),
--               '6' (アイマスク), '10' (壁保護シート 44*5), '16' (ペットケアセット グレー)
-- ============================================================================

-- 楽天チャネルの ID を使い回すため一時テーブルにロード
do $$
declare
  v_rakuten_id uuid;
  v_now timestamptz := now();
begin
  select id into v_rakuten_id from public.channels where code = 'rakuten' limit 1;
  if v_rakuten_id is null then
    raise exception 'rakuten channel not found; run init migration first';
  end if;

  -- ----- tickets ---------------------------------------------------------
  insert into public.tickets (
    channel_id, external_id, customer_name, customer_email, subject,
    status, product_id, case_category, defect_type, channel_meta, created_at
  ) values
    (v_rakuten_id, 'rakuten-seed-001', '山田 太郎', 'taro.yamada@example.com',
     'サイズ違いが届きました', 'untouched', '3', 'defect', 'size_mismatch',
     jsonb_build_object('order_number','2026-04-30-RAKU-001','seed',true),
     v_now - interval '6 hours'),

    (v_rakuten_id, 'rakuten-seed-002', '佐藤 花子', 'hanako.sato@example.com',
     '配送日を変更したい', 'untouched', '6', 'shipping', null,
     jsonb_build_object('order_number','2026-04-30-RAKU-002','seed',true),
     v_now - interval '5 hours'),

    (v_rakuten_id, 'rakuten-seed-003', '鈴木 一郎', 'ichiro.suzuki@example.com',
     '使い方がわからないので教えてほしい', 'untouched', '2', 'usage', null,
     jsonb_build_object('order_number','2026-04-30-RAKU-003','seed',true),
     v_now - interval '4 hours'),

    (v_rakuten_id, 'rakuten-seed-004', '高橋 翔', 'sho.takahashi@example.com',
     '領収書の宛名変更をお願いします', 'untouched', '5', 'other', null,
     jsonb_build_object('order_number','2026-04-30-RAKU-004','seed',true),
     v_now - interval '3 hours'),

    (v_rakuten_id, 'rakuten-seed-005', '田中 美咲', 'misaki.tanaka@example.com',
     'サイズ違いが届きました(再送依頼)', 'in_progress', '10', 'defect', 'size_mismatch',
     jsonb_build_object('order_number','2026-04-29-RAKU-005','seed',true),
     v_now - interval '1 day'),

    (v_rakuten_id, 'rakuten-seed-006', '渡辺 健', 'ken.watanabe@example.com',
     '色違いの商品が届いた', 'in_progress', '16', 'defect', 'color_mismatch',
     jsonb_build_object('order_number','2026-04-29-RAKU-006','seed',true),
     v_now - interval '1 day 2 hours'),

    (v_rakuten_id, 'rakuten-seed-007', '中村 裕子', 'yuko.nakamura@example.com',
     '使い方を改めて教えてください', 'done', '3', 'usage', null,
     jsonb_build_object('order_number','2026-04-25-RAKU-007','seed',true),
     v_now - interval '5 days'),

    (v_rakuten_id, 'rakuten-seed-008', '小林 雅人', 'masato.kobayashi@example.com',
     '配送日変更の希望', 'done', '2', 'shipping', null,
     jsonb_build_object('order_number','2026-04-24-RAKU-008','seed',true),
     v_now - interval '6 days')
  on conflict (channel_id, external_id) do nothing;

  -- ----- messages --------------------------------------------------------
  -- inbound: 各チケット 1〜2 件
  insert into public.messages (ticket_id, direction, body, sender_name, sent_at, channel_message_id, attachments)
  select t.id, 'inbound',
    case t.external_id
      when 'rakuten-seed-001' then E'お世話になっております。\n本日商品が届きましたが、注文したサイズと違うものが入っていました。交換していただけますでしょうか。'
      when 'rakuten-seed-002' then E'お世話になります。\n配送日を当初の希望から変更したいのですが、可能でしょうか。新しい希望日は来週金曜日です。'
      when 'rakuten-seed-003' then E'はじめまして。\n商品は届いたのですが、使い方がわからずに困っています。説明書を見ても理解できなかったため、ご教示いただけると幸いです。'
      when 'rakuten-seed-004' then E'いつもお世話になっております。\n領収書の宛名を「株式会社サンプル」に変更したいです。再発行をお願いできますでしょうか。'
      when 'rakuten-seed-005' then E'先日商品が届きましたが、別サイズが混入しておりました。再送のご対応をお願いします。'
      when 'rakuten-seed-006' then E'届いた商品の色が注文と異なります。グレーをお願いしたのですがブルーが届きました。'
      when 'rakuten-seed-007' then E'前回ご教示いただいた使い方ですが、再度確認したいです。'
      when 'rakuten-seed-008' then E'配送日を週末に変更したいです。'
    end,
    t.customer_name,
    t.created_at,
    'inquiry:' || t.external_id,
    '[]'::jsonb
  from public.tickets t
  where t.channel_id = v_rakuten_id
    and t.external_id like 'rakuten-seed-%'
  on conflict (ticket_id, channel_message_id) do nothing;

  -- 一部チケットに追加の inbound（フォローアップ）
  insert into public.messages (ticket_id, direction, body, sender_name, sent_at, channel_message_id, attachments)
  select t.id, 'inbound',
    E'追記です。状況のご連絡をいただけますと幸いです。',
    t.customer_name,
    t.created_at + interval '2 hours',
    'inquiry:' || t.external_id || ':followup',
    '[]'::jsonb
  from public.tickets t
  where t.channel_id = v_rakuten_id
    and t.external_id in ('rakuten-seed-005','rakuten-seed-006')
  on conflict (ticket_id, channel_message_id) do nothing;

  -- in_progress / done のチケットには outbound 1件
  insert into public.messages (ticket_id, direction, body, sender_name, sent_at, channel_message_id, attachments)
  select t.id, 'outbound',
    case t.external_id
      when 'rakuten-seed-005' then E'お問い合わせありがとうございます。\n至急別サイズの再送手配を進めております。発送状況を改めてご連絡いたします。\n\nオリジンツリー カスタマーサポート'
      when 'rakuten-seed-006' then E'お問い合わせありがとうございます。\nご注文いただいた色と異なる商品が届きました件、深くお詫び申し上げます。色違い商品を本日中に手配いたします。\n\nオリジンツリー カスタマーサポート'
      when 'rakuten-seed-007' then E'お問い合わせありがとうございます。\n以下のリンクに使い方の詳細を掲載しております。ご確認ください。\nhttps://example.com/usage-guide-coolring\n\nオリジンツリー カスタマーサポート'
      when 'rakuten-seed-008' then E'お問い合わせありがとうございます。\n配送日変更を承りました。\n\nオリジンツリー カスタマーサポート'
    end,
    'CSサポート',
    t.created_at + interval '3 hours',
    'reply:' || t.external_id || ':1',
    '[]'::jsonb
  from public.tickets t
  where t.channel_id = v_rakuten_id
    and t.external_id in ('rakuten-seed-005','rakuten-seed-006','rakuten-seed-007','rakuten-seed-008')
  on conflict (ticket_id, channel_message_id) do nothing;

  -- done のチケットは resolved_at を埋める
  update public.tickets
  set resolved_at = created_at + interval '4 hours'
  where channel_id = v_rakuten_id
    and external_id in ('rakuten-seed-007','rakuten-seed-008')
    and resolved_at is null;
end $$;
