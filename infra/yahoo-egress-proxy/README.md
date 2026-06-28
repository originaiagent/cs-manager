# Yahoo egress fixed-IP proxy

cs-manager runs on Vercel, whose egress source IP changes on every request. Yahoo!
ショッピング/セラー API の利用申請は **固定グローバルIPの登録**を要求する。本ディレクトリは、
cs-manager の **Yahoo 宛通信だけ**を経由させる「固定IP送信専用フォワードプロキシ」を GCP に
1個立てるための IaC と運用手順。

最終成果: cs-manager → Yahoo の通信が、下記の固定IPから出る。他チャネル(楽天/メール/LINE)は
従来どおり素通り(プロキシ非経由)。

## 確保した固定IP（Yahoo申請フォームにそのまま転記する値）

```
104.198.123.146
```

- GCP project: `logistics-app-481912` / region: `asia-northeast1`(東京)
- reserved static external IP name: `yahoo-egress-proxy-ip`(status: IN_USE, VM に固定割当)
- geolocation: Japan / Tokyo（ISP: Google LLC）

## 構成

```
cs-manager (Vercel, Next.js)
  └─ undici ProxyAgent dispatcher（Yahoo fetch だけに注入）
       └─ http://104.198.123.146:8888  (BasicAuth)
            └─ tinyproxy (forward proxy / GCE e2-micro, Debian 12, asia-northeast1-a)
                 └─ egress = 104.198.123.146（VMの外部IP=予約済静的IP）
                      └─ Yahoo API ドメインのみ（destination whitelist）
```

- VM: `yahoo-egress-proxy`（e2-micro, asia-northeast1-a, network tag `yahoo-egress-proxy`）
- proxy: tinyproxy（port 8888）
- VM SA: `yahoo-egress-proxy-sa@logistics-app-481912.iam`（**最小権限**: 当該 Secret のみ
  `secretmanager.secretAccessor`）

## ロックダウン（オープンプロキシ厳禁）

| 層 | 制御 |
|----|------|
| 認証 | `BasicAuth`（未認証は 407）。`Allow` 行なし=送信元IP制限はしない（Vercel egress は動的で広域・共有のため送信元制限が不可。認証に一本化） |
| 宛先 | `Filter` + `FilterType ere` + `FilterDefaultDeny Yes` で **Yahoo APIドメインのみ**許可。他は拒否 |
| ポート | `ConnectPort 443` で CONNECT(HTTPS) トンネルを 443 限定 |
| Firewall | `tcp:8888` は 0.0.0.0/0（上記で多層防御）/ `tcp:22` は IAP range `35.235.240.0/20` のみ（公開SSHなし） |
| ブルートフォース | 40字ランダムBasicAuth + fail2ban（10回/600s で 1h ban） |

許可ドメイン（`/etc/tinyproxy/filter`、ERE・完全一致）:
`circus.shopping.yahooapis.jp` / `auth.login.yahoo.co.jp` / `api.login.yahoo.co.jp`
（Yahoo 側ドメイン追加時は startup-script の filter に1行足して VM を再起動）

> 残リスク: BasicAuth は plain HTTP プロキシ上を流れる（CONNECT先=Yahooは TLS だが、プロキシ認証
> ヘッダ自体は平文）。今回は「Yahoo限定 filter + fail-closed + 強パスワード + 非標準ポート」で
> 非ブロッカーと判断（codex APPROVE 2026-06-28）。将来 TLS 終端付き proxy / mTLS に上げる余地あり。

## 秘密の持ち方（canonical は二重、同値）

BasicAuth `user:pass` は2か所に同値で保持する:

1. **origin-core Vault** `service_code=yahoo_egress_proxy`（fields: host/port/username/password）
   → cs-manager が `CORE_CREDENTIAL_KEY` 経由で取得し proxy 認証に使う。
2. **GCP Secret Manager** `yahoo-egress-proxy-basicauth`（`user:pass` 1行）
   → VM の startup-script が boot 時に SA 経由で取得し tinyproxy BasicAuth をレンダリング。

コード/env にハードコードしない。startup-script は secret 取り扱い区間を `set +x` し、
serial/journal に値を出さない。

### ローテーション手順

```bash
NEWPASS=$(openssl rand -base64 30)
# 1) Core Vault を更新（origin-core DB / vault.update_secret で yahoo_egress_proxy の password を差替え）
# 2) Secret Manager を更新
printf 'csmanager:%s' "$NEWPASS" | gcloud secrets versions add yahoo-egress-proxy-basicauth --data-file=- --project=logistics-app-481912
# 3) VM に反映（startup-script 再実行）
gcloud compute instances reset yahoo-egress-proxy --zone=asia-northeast1-a --project=logistics-app-481912
# cs-manager 側は 5分TTLキャッシュ失効後に新値で接続
```

## 自己回復 / 監視

- tinyproxy: systemd `Restart=always`（drop-in）+ boot 時 enable。
- startup-script は **毎boot冪等に再実行** → reboot後も config 再生成 + サービス復帰。実測: reset 後
  ~16s で復帰（unauth→407 / Yahoo→200）。
- VM scheduling: `automaticRestart=true`, `onHostMaintenance=MIGRATE`（ホスト障害/メンテで自動復帰）。
- **SPOF 注意**: 単一 VM。プロセス/ホスト障害は上記で自動復帰するが、ゾーン障害は対象外。
  重要度が上がったら MIG + health check 化を検討。

### 死活確認（本番疎通レシピ = 固定IP経由を再現確認する手順）

```bash
# 1) 静的IPが固定で IN_USE であること
gcloud compute addresses describe yahoo-egress-proxy-ip --region=asia-northeast1 \
  --project=logistics-app-481912 --format='value(address,status)'   # => 104.198.123.146  IN_USE

# 2) 未認証は弾かれる（オープンでない）
curl -s -o /dev/null -w '%{http_connect}\n' -x http://104.198.123.146:8888 \
  https://circus.shopping.yahooapis.jp/                              # => 407

# 3) Yahoo 以外は弾かれる
curl -s -o /dev/null -w '%{http_connect}\n' -x http://csmanager:<PASS>@104.198.123.146:8888 \
  https://example.com/                                               # => 403

# 4) 認証ありで Yahoo に到達できる（固定IP経由）
curl -s -o /dev/null -w 'connect=%{http_connect} http=%{http_code}\n' \
  -x http://csmanager:<PASS>@104.198.123.146:8888 \
  https://circus.shopping.yahooapis.jp/                              # => connect=200 http=404

# 5) 送信元が固定IPであることの実測（echo。本番ACLはYahoo限定なので検証時のみ一時許可）
#   VM 上で: sudo sh -c 'echo "^api\.ipify\.org$" >> /etc/tinyproxy/filter' && sudo systemctl reload tinyproxy
curl -s -x http://csmanager:<PASS>@104.198.123.146:8888 https://api.ipify.org   # => 104.198.123.146
#   検証後: VM 上で当該行を削除し reload（Yahoo限定へ戻す）。reset でも自動復元される。

# 管理SSH（IAP 経由のみ）
gcloud compute ssh yahoo-egress-proxy --zone=asia-northeast1-a \
  --project=logistics-app-481912 --tunnel-through-iap
```

`<PASS>` は Core Vault / Secret Manager の値（ここには書かない）。

## 再構築

```bash
# Secret Manager に user:pass を投入（Core Vault と同値）してから:
./provision.sh
```

`provision.sh` は idempotent（既存リソースは skip）。`startup-script.sh` が VM 上の tinyproxy を構成する。

## cs-manager 側の配線

`src/channels/yahoo/egress.ts` が Core `yahoo_egress_proxy` を取得して undici `ProxyAgent` を構築し、
Yahoo の `YahooTalkClient.fetchImpl` にだけ注入する。proxy 取得不能時は **fail-closed**（直fetchに
落とさない=IP漏れ防止。Yahoo同期はその回スキップ）。他チャネルは無改変=非経由。詳細はリポジトリの
当該コードと `app/api/diag/yahoo-egress` を参照。
