# M3切替記録: 分類2cronのembed経路ON（2026-07-19）

- env `CLASSIFY_VIA_EMBED=true` を本番投入（トム承認・G1裁定込み全PASS後）
- 戻す手順: Vercel env から CLASSIFY_VIA_EMBED を削除（または false）→ redeploy。即時可逆
- 検証: origin-ai 側 ai_embed_runs に source_tool=cs-manager / cs:classify-defect / cs:classify-return-comment の completed が積まれること・ticket_defect_causes / fba_return_symptoms の書込継続
- 経緯・合否: origin-ai docs/ops/m2-adjudication/ 参照
