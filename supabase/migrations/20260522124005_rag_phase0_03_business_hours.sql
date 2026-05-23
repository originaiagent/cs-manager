CREATE TABLE IF NOT EXISTS public.business_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID,                       -- NULL = 全チャネル共通
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sun..6=Sat
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  is_holiday BOOLEAN DEFAULT false,
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.first_response_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,                 -- general/complaint/inquiry/urgent
  channel_id UUID,
  body_template TEXT NOT NULL,            -- {{customer_name}} {{product_name}} placeholders
  is_active BOOLEAN DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.is_within_business_hours(
  channel_id_param UUID,
  check_time TIMESTAMPTZ DEFAULT now()
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $fn$
DECLARE
  v_tz TEXT;
  v_local TIMESTAMP;
  v_dow INT;
  v_time TIME;
  v_match BOOLEAN;
BEGIN
  SELECT bh.timezone INTO v_tz
  FROM public.business_hours bh
  WHERE (bh.channel_id = channel_id_param OR bh.channel_id IS NULL)
  ORDER BY (bh.channel_id IS NOT NULL) DESC
  LIMIT 1;
  IF v_tz IS NULL THEN v_tz := 'Asia/Tokyo'; END IF;

  v_local := check_time AT TIME ZONE v_tz;
  v_dow := EXTRACT(DOW FROM v_local)::INT;
  v_time := v_local::TIME;

  SELECT EXISTS (
    SELECT 1 FROM public.business_hours bh
    WHERE (bh.channel_id = channel_id_param OR bh.channel_id IS NULL)
      AND bh.day_of_week = v_dow
      AND COALESCE(bh.is_holiday, false) = false
      AND (bh.effective_from IS NULL OR bh.effective_from <= v_local::DATE)
      AND (bh.effective_to IS NULL OR bh.effective_to >= v_local::DATE)
      AND v_time >= bh.open_time AND v_time < bh.close_time
  ) INTO v_match;

  RETURN COALESCE(v_match, false);  -- 営業時間定義が無い時は「時間外」。自動送信の最終ガードは rag_config.rakuten_auto_send_enabled
END
$fn$;
