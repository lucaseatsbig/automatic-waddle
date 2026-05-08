import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  createRestaurant,
  createReview,
  findRestaurantByName,
  getOrCreateLocationByName,
  insertPhoto,
  invalidateReferenceCache,
  type RestaurantInput,
  type ReviewInput,
} from '../../../lib/db';
import { parseRestaurantForm, parseReviewForm } from '../../../lib/form-helpers';
import { fetchPlacePhotos } from '../../../lib/places';
import { uniqueSlug } from '../../../lib/slug';

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const mode = form.get('mode') === 'wishlist' ? 'wishlist' : 'visit';

  const rest = parseRestaurantForm(form);
  if (!rest.name) return new Response('Name is required.', { status: 400 });

  const existing = await findRestaurantByName(env.DB, rest.name);

  let restaurantId: number;
  let restaurantSlug: string;

  if (existing) {
    restaurantId = existing.id;
    const row = await env.DB
      .prepare('SELECT slug FROM restaurants WHERE id = ?')
      .bind(restaurantId)
      .first<{ slug: string }>();
    restaurantSlug = row!.slug;

    if (mode === 'wishlist') {
      const note = (form.get('wishlist_note') ?? '').toString().trim();
      if (note) {
        await env.DB
          .prepare('UPDATE restaurants SET wishlist_note = ?, updated_at = unixepoch() WHERE id = ?')
          .bind(note, restaurantId)
          .run();
      }
    }
  } else {
    const slug = await uniqueSlug(env.DB, 'restaurants', rest.slug || rest.name);
    const location_id = await getOrCreateLocationByName(env.DB, rest.location_name);
    const wishlistNote =
      mode === 'wishlist' ? ((form.get('wishlist_note') ?? '').toString().trim() || null) : null;
    // If a Google place_id is present but no maps_url, derive the canonical link.
    const mapsUrl =
      rest.maps_url ??
      (rest.place_id ? `https://www.google.com/maps/place/?q=place_id:${rest.place_id}` : null);
    const input: RestaurantInput = {
      slug,
      name: rest.name,
      cuisine: rest.cuisine,
      location_id,
      address: rest.address,
      price_tier: rest.price_tier,
      website_url: rest.website_url,
      maps_url: mapsUrl,
      place_id: rest.place_id,
      lat: rest.lat,
      lng: rest.lng,
      wishlist_note: wishlistNote,
      tag_ids: rest.tag_ids,
      meal_types: rest.meal_types,
    };
    restaurantId = await createRestaurant(env.DB, input);
    restaurantSlug = slug;
    // A new restaurant may introduce a previously-unseen cuisine or location,
    // both of which feed the FilterBar's memoized reference lists.
    invalidateReferenceCache();

    if (input.place_id && env.GOOGLE_MAPS_API_KEY) {
      const placeId = input.place_id;
      const apiKey = env.GOOGLE_MAPS_API_KEY;
      const newId = restaurantId;
      const fetchHero = async () => {
        const photos = await fetchPlacePhotos(placeId, apiKey);
        const name = photos[0]?.name;
        if (name) {
          await env.DB
            .prepare('UPDATE restaurants SET hero_photo_name = ? WHERE id = ?')
            .bind(name, newId)
            .run();
        }
      };
      const cfContext = (locals as { cfContext?: { waitUntil?: (p: Promise<unknown>) => void } })
        ?.cfContext;
      if (cfContext?.waitUntil) cfContext.waitUntil(fetchHero());
      else await fetchHero();
    }
  }

  if (mode === 'wishlist') {
    return redirect('/admin');
  }

  const review = parseReviewForm(form);
  const slugBase = review.visit_date
    ? `${restaurantSlug}-${review.visit_date}`
    : `${restaurantSlug}-undated`;
  const reviewSlug = await uniqueSlug(env.DB, 'reviews', slugBase);
  const reviewInput: ReviewInput = {
    restaurant_id: restaurantId,
    slug: reviewSlug,
    ...review,
  };
  const reviewId = await createReview(env.DB, reviewInput);

  // Upload any photos attached to the form. First one becomes the cover.
  const photoFiles = form.getAll('photos').filter((p): p is File => p instanceof File && p.size > 0);
  const widths = form.getAll('photos_width').map((v) => Number(v) || null);
  const heights = form.getAll('photos_height').map((v) => Number(v) || null);

  for (let i = 0; i < photoFiles.length; i++) {
    const file = photoFiles[i];
    if (!ALLOWED_PHOTO_TYPES.has(file.type)) continue;
    if (file.size > MAX_PHOTO_BYTES) continue;

    const ext = extensionFor(file.type);
    const key = `reviews/${reviewId}/${crypto.randomUUID()}${ext}`;
    const body = await file.arrayBuffer();
    await env.PHOTOS.put(key, body, { httpMetadata: { contentType: file.type } });
    await insertPhoto(env.DB, reviewId, key, null, widths[i] ?? null, heights[i] ?? null, i === 0);
  }

  return redirect('/admin');
};

function extensionFor(type: string): string {
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/png') return '.png';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/heic') return '.heic';
  if (type === 'image/heif') return '.heif';
  return '';
}
