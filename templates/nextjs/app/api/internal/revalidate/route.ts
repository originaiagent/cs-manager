import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { verifyInternalApiKey, CACHE_TAGS, type CacheTag } from '@/lib/cache-verify';

const TAG_SET = new Set<string>(CACHE_TAGS);

export async function POST(request: Request) {
  const auth = verifyInternalApiKey(request.headers.get('x-internal-api-key'));
  if (!auth.ok) {
    console.warn(`[revalidate] auth_failed reason=${auth.reason}`);
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const tags = (body as { tags?: unknown })?.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    return NextResponse.json({ error: 'tags must be an array of strings' }, { status: 400 });
  }

  const accepted: CacheTag[] = [];
  const rejected: string[] = [];
  for (const tag of tags as string[]) {
    if (TAG_SET.has(tag)) {
      revalidateTag(tag);
      accepted.push(tag as CacheTag);
    } else {
      rejected.push(tag);
    }
  }

  return NextResponse.json({ revalidated: true, accepted, rejected, now: Date.now() });
}
