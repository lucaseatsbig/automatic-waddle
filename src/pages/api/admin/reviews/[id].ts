import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getReviewForEdit, updateReview, type ReviewInput } from '../../../../lib/db';
import { parseReviewForm } from '../../../../lib/form-helpers';
import { uniqueSlug } from '../../../../lib/slug';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const existing = await getReviewForEdit(env.DB, id);
  if (!existing) return new Response('Not found', { status: 404 });

  const form = await request.formData();
  const parsed = parseReviewForm(form);

  // Keep slug base tied to restaurant slug + date in case date changed.
  const restSlug = await env.DB
    .prepare('SELECT slug FROM restaurants WHERE id = ?')
    .bind(existing.restaurant_id)
    .first<{ slug: string }>();
  const slugBase = parsed.visit_date
    ? `${restSlug?.slug ?? 'review'}-${parsed.visit_date}`
    : `${restSlug?.slug ?? 'review'}-undated`;
  const slug = await uniqueSlug(env.DB, 'reviews', slugBase, id);

  const input: ReviewInput = {
    restaurant_id: existing.restaurant_id,
    slug,
    ...parsed,
  };
  await updateReview(env.DB, id, input);
  return redirect(`/admin/reviews/${id}`);
};
