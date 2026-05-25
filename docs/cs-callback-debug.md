# cs-manager OIDC callback "Token exchange rejected" — 原因と修正 (2026-05-25)

## 症状
木元手動ログイン → origin-core ログイン画面まで正常 → 認証成功 → `/api/auth/callback?code=...` 帰還 →
レスポンス `{"error":"Token exchange rejected"}`。

callback の token 交換 (`POST {issuer}/auth/v1/oauth/token`) で Core が 401 を返していた。

## 切り分け
Core の token endpoint に **cs-manager の実 client_id + 実 client_secret**(Core `/api/credentials`
から取得)+ bogus な authorization code を POST して、エラー種別で client 認証 vs code を切り分けた。

| client | 送信 | レスポンス | 意味 |
|---|---|---|---|
| cs-manager (修正前) | 実 secret + bogus code | `invalid_credentials / invalid client credentials` | **client 認証失敗** |
| factory-management (稼働中) | 実 secret + bogus code | `invalid_grant / Invalid authorization code` | client 認証通過 (code だけ NG) |

→ cs-manager は client_secret の照合段階で落ちている。redirect_uri / PKCE / code ではない。

## 根本原因
cs-manager の OAuth client は手動 SQL でプロビジョニングしており、`client_secret_hash` を
**標準 base64**(`encode(sha256(secret), 'base64')` → `+` `/` を含む)で格納していた。
一方 **GoTrue は client_secret を base64URL**(`RawURLEncoding` → `-` `_`、パディング無し)で
ハッシュ照合する。

- GoTrue が登録した全 client の `client_secret_hash` は `+/` を含まない(= base64url)。
- factory / ec / logi は secret の sha256 出力にたまたま `+/` に化けるバイトが無く、
  標準 base64 と base64url が一致したため、手動確認時に「方式一致」と誤認した。
- cs-manager の secret は sha256 出力に該当バイトを含み、標準 base64 では `+` `/`、
  base64url では `-` `_` となる。格納値(`+/`)と GoTrue の計算値(`-_`)が食い違い、
  常に `invalid client credentials` で拒否されていた。

## 修正 (Core データのみ・コード変更/再デプロイ不要)
Vault の secret は正しいので、格納済みハッシュのエンコードだけを base64URL に直した。

```sql
UPDATE auth.oauth_clients oc
SET client_secret_hash = translate(rtrim(encode(digest(secret,'sha256'),'base64'),'='), '+/', '-_')
... WHERE client_name='CS Manager';
```

修正後、同じ probe で `invalid_grant`(client 認証通過)を確認。

## 再発防止 (learning)
手動で `auth.oauth_clients` を INSERT する場合、`client_secret_hash` は必ず
**base64URL(RawURLEncoding, パディング無し)** で格納すること。
標準 base64 だと secret 次第で `+/` 混入時のみ不定期に失敗する(他ツールは GoTrue admin API
発行のため本事象の影響なし)。

## 残作業
木元再ログイン → cs-manager ホーム到達確認 → backlog `59836c91` を done。
