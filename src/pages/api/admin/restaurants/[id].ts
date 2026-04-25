import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOrCreateLocationByName, updateRestaurant } from '../../../../lib/db';
import { uniqueSlug } from '../../../../lib/slug';
import { parseRestaurantForm } from '../../../../lib/form-helpers';

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return new Response('Bad id', { status: 400 });

  const form = await request.formData();
  const parsed = parseRestaurantForm(form);
  if (!parsed.name) return new Response('Name is required.', { status: 400 });

  const slug = await uniqueSlug(env.DB, 'restaurants', parsed.slug || parsed.name, id);
  const location_id = await getOrCreateLocationByName(env.DB, parsed.location_name);
  await updateRestaurant(env.DB, id, {
    slug,
    name: parsed.name,
    cuisine: parsed.cuisine,
    location_id,
    address: parsed.address,
    price_tier: parsed.price_tier,
    website_url: parsed.website_url,
    maps_url: parsed.maps_url,
    place_id: parsed.place_id,
    lat: parsed.lat,
    lng: parsed.lng,
    wishlist_note: parsed.wishlist_note,
    tag_ids: parsed.tag_ids,
  });
  return redirect(`/admin/restaurants/${id}`);
};
