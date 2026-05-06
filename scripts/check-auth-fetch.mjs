#!/usr/bin/env node
/**
 * 書き込み系 API への raw `fetch()` 呼び出しを検出する CI チェッカー。
 *
 * 検出条件:
 *   1. 直接 `fetch(...)` を呼んでいる（呼び出し名が "fetch" の関数呼び出し）
 *   2. URL 引数が apiUrlPattern にマッチする文字列リテラル / テンプレートリテラル
 *      （デフォルト: `/api/...` で開始）
 *   3. `method` が POST / PUT / PATCH / DELETE
 *   4. publicPrefixes に該当しない
 *   5. options.headers に `Authorization: Bearer ...` リテラル、
 *      または authHelpers 関数呼び出し（例: authHeaders()）、
 *      または `...authHelpers(...)` の spread が含まれていない
 *
 * 動作モード:
 *   - sourceRoots（デフォルト ["client/src", "src"]）が 1 つも存在しない → SKIP（exit 0）
 *   - sourceRoots は存在するが `typescript` パッケージが import できない → ERROR（exit 1）
 *   - 違反検出 → exit 1
 *   - それ以外 → exit 0
 *
 * 設定ファイル: リポ root の `auth-fetch.config.json`（任意）
 *   {
 *     "sourceRoots":    string[]  // 走査対象ディレクトリ（リポ相対）
 *     "publicPrefixes": string[]  // 認証不要として除外する URL プレフィックス
 *     "authHelpers":    string[]  // 認証付き fetch ヘルパー関数名
 *     "apiUrlPattern":  string    // API URL 判定用 RegExp（文字列で指定）
 *   }
 *
 * 共通の正解は 各リポの `lib/auth-fetch.ts`（authFetch ヘルパー）を使うこと。
 * 参考実装: origin-core の `client/src/lib/auth-fetch.ts`
 */
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), "auth-fetch.config.json");
const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};

const SOURCE_ROOTS = (Array.isArray(config.sourceRoots) && config.sourceRoots.length > 0)
  ? config.sourceRoots
  : ["client/src", "src"];
const PUBLIC_PREFIXES = Array.isArray(config.publicPrefixes) ? config.publicPrefixes : [];
const AUTH_HELPERS = (Array.isArray(config.authHelpers) && config.authHelpers.length > 0)
  ? config.authHelpers
  : ["authFetch", "authHeaders"];
const API_URL_PATTERN = new RegExp(config.apiUrlPattern ?? "^/api(/|$)");
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const existingRoots = SOURCE_ROOTS
  .map((p) => resolve(process.cwd(), p))
  .filter((p) => existsSync(p) && statSync(p).isDirectory());

if (existingRoots.length === 0) {
  console.log(`[check-auth-fetch] SKIP — no source roots found (looked for: ${SOURCE_ROOTS.join(", ")}).`);
  process.exit(0);
}

let ts;
try {
  ts = (await import("typescript")).default;
} catch {
  console.error(
    `[check-auth-fetch] ERROR — source roots exist (${existingRoots.map((p) => relative(process.cwd(), p)).join(", ")}) but the \`typescript\` package is not installed.\n` +
    `Install it with: npm i -D typescript`,
  );
  process.exit(1);
}

const escapedHelpers = AUTH_HELPERS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const authHelperRegex = new RegExp(`^(${escapedHelpers.join("|")})$`);

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, files);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function literalString(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => "${...}" + s.literal.text).join("");
  }
  return null;
}

function isApiUrl(url) {
  if (!url) return false;
  if (url.startsWith("${...}")) return false;
  return API_URL_PATTERN.test(url);
}

function isPublic(url) {
  if (!url) return false;
  return PUBLIC_PREFIXES.some((p) => url.startsWith(p));
}

function findOptionsProperty(objectLit, name) {
  for (const prop of objectLit.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop.initializer;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) {
      return prop.name;
    }
  }
  return null;
}

function isAuthHelperCall(expr) {
  if (!expr) return false;
  if (ts.isAwaitExpression(expr)) return isAuthHelperCall(expr.expression);
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return authHelperRegex.test(expr.expression.text);
  }
  return false;
}

function hasBearerInHeaders(headersExpr) {
  if (!headersExpr) return false;
  if (ts.isAwaitExpression(headersExpr)) return hasBearerInHeaders(headersExpr.expression);
  if (ts.isCallExpression(headersExpr)) return isAuthHelperCall(headersExpr);
  if (ts.isObjectLiteralExpression(headersExpr)) {
    for (const prop of headersExpr.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        prop.name &&
        ((ts.isStringLiteral(prop.name) && /^Authorization$/i.test(prop.name.text)) ||
          (ts.isIdentifier(prop.name) && /^Authorization$/i.test(prop.name.text)))
      ) {
        const v = prop.initializer;
        const lit = literalString(v);
        if (lit && /^Bearer/i.test(lit)) return true;
      }
      if (ts.isSpreadAssignment(prop)) {
        if (isAuthHelperCall(prop.expression)) return true;
      }
    }
    return false;
  }
  return false;
}

const violations = [];
for (const root of existingRoots) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      src,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "fetch"
      ) {
        const [urlArg, optsArg] = node.arguments;
        const url = literalString(urlArg);
        if (url && isApiUrl(url) && !isPublic(url) && optsArg && ts.isObjectLiteralExpression(optsArg)) {
          const methodNode = findOptionsProperty(optsArg, "method");
          const method = methodNode ? literalString(methodNode) : null;
          if (method && WRITE_METHODS.has(method.toUpperCase())) {
            const headersNode = findOptionsProperty(optsArg, "headers");
            const ok = headersNode && hasBearerInHeaders(headersNode);
            if (!ok) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
              violations.push({ file: relative(process.cwd(), file), line: line + 1, method: method.toUpperCase(), url });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
}

if (violations.length > 0) {
  console.error(`\n[check-auth-fetch] ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.method}] ${v.url}`);
  }
  console.error(`\nUse an authenticated fetch helper (e.g. \`authFetch\`) instead of raw fetch() for write methods.`);
  console.error(`See docs/auth-fetch-checker.md for details.`);
  process.exit(1);
}
console.log(`[check-auth-fetch] OK — no raw fetch() write calls without auth header.`);
