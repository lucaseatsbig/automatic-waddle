import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { deleteReview, getReviewForEdit } from '../../../../../lib/db';

export const POST: APIRoute = async ({ params, redirect }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const review = await getReviewForEdit(env.DB, id);
  if (!review) return redirect('/admin');

  const r2Keys = await deleteReview(env.DB, id);
  if (r2Keys.length > 0) {
    await Promise.all(r2Keys.map((k) => env.PHOTOS.delete(k)));
  }
  return redirect(`/admin/restaurants/${review.restaurant_id}`);
};
