import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { insertPhoto } from '../../../lib/db';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — client resizes well below this
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const reviewId = Number(form.get('review_id'));
  const file = form.get('file');
  const width = Number(form.get('width')) || null;
  const height = Number(form.get('height')) || null;
  const makeCover = form.get('make_cover') === '1';

  if (!Number.isFinite(reviewId)) {
    return json({ error: 'Missing or invalid review_id' }, 400);
  }
  if (!(file instanceof File)) {
    return json({ error: 'Missing file' }, 400);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return json({ error: `Unsupported file type: ${file.type}` }, 400);
  }
  if (file.size === 0) return json({ error: 'Empty file' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'File too large' }, 413);

  // Verify review exists (middleware handles auth; we still want a sane FK).
  const rv = await env.DB
    .prepare('SELECT id FROM reviews WHERE id = ?')
    .bind(reviewId)
    .first();
  if (!rv) return json({ error: 'Review not found' }, 404);

  const ext = extensionFor(file.type);
  const key = `reviews/${reviewId}/${crypto.randomUUID()}${ext}`;

  const body = await file.arrayBuffer();
  await env.PHOTOS.put(key, body, {
    httpMetadata: { contentType: file.type },
  });

  const id = await insertPhoto(env.DB, reviewId, key, null, width, height, makeCover);

  return json({
    id,
    r2_key: key,
    alt: null,
    is_cover: makeCover,
    width,
    height,
  });
};

function extensionFor(type: string): string {
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/png') return '.png';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/heic') return '.heic';
  if (type === 'image/heif') return '.heif';
  return '';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
