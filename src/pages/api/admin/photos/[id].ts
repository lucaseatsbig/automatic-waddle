import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deletePhoto, setPhotoCover } from '../../../../lib/db';

export const DELETE: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return json({ error: 'Bad id' }, 400);

  const r2Key = await deletePhoto(env.DB, id);
  if (!r2Key) return json({ error: 'Not found' }, 404);
  await env.PHOTOS.delete(r2Key);
  return json({ ok: true });
};

export const POST: APIRoute = async ({ params, request }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return json({ error: 'Bad id' }, 400);

  const form = await request.formData();
  const action = form.get('action');
  if (action === 'cover') {
    await setPhotoCover(env.DB, id);
    return json({ ok: true });
  }
  return json({ error: 'Unknown action' }, 400);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
