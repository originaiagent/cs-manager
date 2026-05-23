#!/usr/bin/env node
/**
 * tool_access ゲート検証 (mock / self-signed JWT)。
 *
 * cs-manager の認可は Core JWT の app_metadata.tool_access['cs-manager'] === true
 * (fail-closed)。本スクリプトは Node 組込 crypto で HS256 の self-signed JWT を生成し、
 * その payload.app_metadata を hasToolAccess ロジックへ通して grant/deny を検証する。
 *
 * real Core-login E2E (JWKS provider 登録 + フラグ ON) は PENDING のため faked しない。
 * ここで検証するのは「claim 形状 → 認可判定」の純ロジック。
 *
 * 実行: node scripts/verify-tool-access-gate.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'

const TOOL_KEY = 'cs-manager'

// src/lib/auth/core-auth-config.ts の hasToolAccess と同一ロジック (fail-closed)。
function hasToolAccess(appMetadata) {
  const toolAccess = appMetadata?.tool_access
  if (!toolAccess || typeof toolAccess !== 'object' || Array.isArray(toolAccess)) {
    return false
  }
  return toolAccess[TOOL_KEY] === true
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// HS256 self-signed JWT (テスト専用; 本番 JWKS 検証は Supabase 側)。
function signMockJwt(claims, secret = 'cs-manager-test-secret') {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000), ...claims }))
  const data = `${header}.${payload}`
  const sig = b64url(createHmac('sha256', secret).update(data).digest())
  return `${data}.${sig}`
}

function decodePayload(jwt) {
  const [, payload] = jwt.split('.')
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
}

test('GRANT: self-signed JWT with tool_access[cs-manager]=true', () => {
  const jwt = signMockJwt({ sub: 'u1', app_metadata: { tool_access: { 'cs-manager': true }, is_admin: false } })
  const { app_metadata } = decodePayload(jwt)
  assert.equal(hasToolAccess(app_metadata), true)
})

test('DENY: tool_access[cs-manager]=false', () => {
  const jwt = signMockJwt({ sub: 'u2', app_metadata: { tool_access: { 'cs-manager': false } } })
  assert.equal(hasToolAccess(decodePayload(jwt).app_metadata), false)
})

test('DENY: key absent (other tools only)', () => {
  const jwt = signMockJwt({ sub: 'u3', app_metadata: { tool_access: { 'ec-manager': true, 'ys-staff-tool': true } } })
  assert.equal(hasToolAccess(decodePayload(jwt).app_metadata), false)
})

test('DENY: tool_access missing entirely', () => {
  const jwt = signMockJwt({ sub: 'u4', app_metadata: { is_admin: true } })
  assert.equal(hasToolAccess(decodePayload(jwt).app_metadata), false)
})

test('DENY: tool_access is array (type abuse)', () => {
  assert.equal(hasToolAccess({ tool_access: ['cs-manager'] }), false)
})

test('DENY: truthy-but-not-true values (fail-closed)', () => {
  assert.equal(hasToolAccess({ tool_access: { 'cs-manager': 'true' } }), false)
  assert.equal(hasToolAccess({ tool_access: { 'cs-manager': 1 } }), false)
  assert.equal(hasToolAccess({ tool_access: { 'cs-manager': {} } }), false)
})

test('DENY: null / undefined app_metadata', () => {
  assert.equal(hasToolAccess(null), false)
  assert.equal(hasToolAccess(undefined), false)
})
