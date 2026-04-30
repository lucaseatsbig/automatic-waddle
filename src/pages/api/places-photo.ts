import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

const NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
const ALLOWED_WIDTHS = new Set([200, 400, 600, 800, 1200, 1600]);

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const name = url.searchParams.get('name') ?? '';
  const w = Number(url.searchParams.get('w')) || 1200;

  if (!NAME_RE.test(name)) return new Response('Bad name', { status: 400 });
  if (!ALLOWED_WIDTHS.has(w)) return new Response('Bad width', { status: 400 });

  const apiKey = env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return new Response('Not configured', { status: 500 });

  const cacheKey = new Request(
    `https://places-photo.lucaseatsbig.invalid/?name=${encodeURIComponent(name)}&w=${w}`
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(
    `https://places.googleapis.com/v1/${name}/media?key=${apiKey}&maxWidthPx=${w}`,
    { headers: { Referer: 'https://lucaseatsbig.com' } }
  );
  if (!upstream.ok) return new Response('Upstream error', { status: 502 });

  const body = await upstream.arrayBuffer();
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=2592000, immutable');

  const response = new Response(body, { headers });

  const cfContext = (locals as { cfContext?: { waitUntil?: (p: Promise<unknown>) => void } })
    ?.cfContext;
  const putPromise = cache.put(cacheKey, response.clone());
  if (cfContext?.waitUntil) cfContext.waitUntil(putPromise);
  else await putPromise;

  return response;
};
