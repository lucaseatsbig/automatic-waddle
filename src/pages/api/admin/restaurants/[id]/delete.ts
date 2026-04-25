import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteRestaurant } from '../../../../../lib/db';

export const POST: APIRoute = async ({ params, redirect }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const r2Keys = await deleteRestaurant(env.DB, id);
  if (r2Keys.length > 0) {
    await Promise.all(r2Keys.map((k) => env.PHOTOS.delete(k)));
  }
  return redirect('/admin');
};
