import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

const NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
const ALLOWED_WIDTHS = new Set([200, 320, 400, 600, 800, 1200, 1600]);

const REFERER = 'https://lucaseatsbig.com';

function fetchMedia(name: string, w: number, apiKey: string): Promise<Response> {
  // Google's media endpoint 302-redirects to the image bytes; fetch follows it.
  return fetch(
    `https://places.googleapis.com/v1/${name}/media?key=${apiKey}&maxWidthPx=${w}`,
    { headers: { Referer: REFERER } }
  );
}

// Google Places (New) photo resource names rotate and eventually become invalid.
// The place id is embedded in the name (`places/{placeId}/photos/{ref}`), so we
// can re-resolve a current photo name for the same place without any extra context.
async function resolveFreshPhotoName(staleName: string, apiKey: string): Promise<string | null> {
  const placeId = staleName.split('/')[1];
  if (!placeId) return null;
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'photos',
        Referer: REFERER,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { photos?: { name?: string }[] };
    return data.photos?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const name = url.searchParams.get('name') ?? '';
  const w = Number(url.searchParams.get('w')) || 1200;

  if (!NAME_RE.test(name)) return new Response('Bad name', { status: 400 });
  if (!ALLOWED_WIDTHS.has(w)) return new Response('Bad width', { status: 400 });

  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return new Response('Not configured', { status: 500 });

  // Cache is keyed on the requested (possibly stale) name, so repeat hits for a
  // name we've already healed are served from cache without touching Google.
  const cacheKey = new Request(
    `https://places-photo.lucaseatsbig.invalid/?name=${encodeURIComponent(name)}&w=${w}`
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const cfContext = (locals as { cfContext?: { waitUntil?: (p: Promise<unknown>) => void } })
    ?.cfContext;

  let upstream = await fetchMedia(name, w, apiKey);

  // Stale photo reference: re-resolve a fresh name for the same place, retry, and
  // (in the background) persist the new name so the rendered HTML self-corrects.
  if (!upstream.ok) {
    const freshName = await resolveFreshPhotoName(name, apiKey);
    if (freshName && freshName !== name && NAME_RE.test(freshName)) {
      const retry = await fetchMedia(freshName, w, apiKey);
      if (retry.ok) {
        upstream = retry;
        const persist = env.DB.prepare(
          'UPDATE restaurants SET hero_photo_name = ?1 WHERE hero_photo_name = ?2'
        )
          .bind(freshName, name)
          .run()
          .catch(() => {});
        if (cfContext?.waitUntil) cfContext.waitUntil(persist);
      }
    }
  }

  if (!upstream.ok) return new Response('Upstream error', { status: 502 });

  const body = await upstream.arrayBuffer();
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=2592000, immutable');

  const response = new Response(body, { headers });

  const putPromise = cache.put(cacheKey, response.clone());
  if (cfContext?.waitUntil) cfContext.waitUntil(putPromise);
  else await putPromise;

  return response;
};
