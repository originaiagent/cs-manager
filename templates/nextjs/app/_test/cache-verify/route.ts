import { NextResponse } from 'next/server';
import { fetchAllFixtures, resolveToolName, verifyInternalApiKey } from '@/lib/cache-verify';

export async function GET(request: Request) {
  const auth = verifyInternalApiKey(request.headers.get('x-internal-api-key'));
  if (!auth.ok) {
    console.warn(
      `[cache-verify] auth_failed reason=${auth.reason}; ` +
        'returning 404 to hide endpoint. ' +
        'Triage: verify INTERNAL_API_KEY env var on server and X-Internal-API-Key header on caller.',
    );
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const toolName = resolveToolName();
  const coreApiUrl = process.env.CORE_API_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY!;

  if (toolName === 'unknown' || !coreApiUrl) {
    console.error(
      '[cache-verify] missing_config TOOL_NAME (or NEXT_PUBLIC_APP_NAME / ORIGIN_AI_TOOL_NAME) and CORE_API_URL must be set',
    );
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  try {
    const fixtures = await fetchAllFixtures({ coreApiUrl, internalApiKey });
    return NextResponse.json(
      { tool: toolName, fixtures },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[cache-verify] core_fetch_failed', err);
    return NextResponse.json({ error: 'upstream_error' }, { status: 502 });
  }
}
