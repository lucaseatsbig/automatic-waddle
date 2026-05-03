import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getRestaurantBySlug } from '../../../lib/db';
import { fetchPlacePhotos, placePhotoUrl } from '../../../lib/places';

// Crops/resizes a restaurant's hero photo to 1200×630 (Open Graph's
// recommended aspect ratio) using the Cloudflare Images binding. Without this
// step, social-card scrapers receive whatever shape the source photo is —
// Google Places photos in particular vary wildly and look giant in iMessage.
export const prerender = false;

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

export const GET: APIRoute = async ({ params, request }) => {
  const slug = params.slug;
  if (!slug) return new Response('Not found', { status: 404 });

  const restaurant = await getRestaurantBySlug(env.DB, slug);
  if (!restaurant) return new Response('Not found', { status: 404 });

  // Mirror the detail page's hero priority: Google Places first (almost
  // always present), uploaded R2 cover as fallback.
  let sourceUrl: string | null = null;
  if (restaurant.place_id && env.GOOGLE_MAPS_API_KEY) {
    try {
      const photos = await fetchPlacePhotos(restaurant.place_id, env.GOOGLE_MAPS_API_KEY);
      if (photos.length > 0) {
        const path = placePhotoUrl(photos[0].name, 1600);
        sourceUrl = new URL(path, request.url).toString();
      }
    } catch {
      // Ignore and fall through to R2 fallback.
    }
  }
  if (!sourceUrl) {
    for (const rv of restaurant.reviews) {
      const cover = rv.photos.find((p) => p.is_cover) ?? rv.photos[0];
      if (cover && env.PUBLIC_PHOTOS_URL) {
        sourceUrl = `${env.PUBLIC_PHOTOS_URL}/${cover.r2_key}`;
        break;
      }
    }
  }
  if (!sourceUrl) return new Response('No photo for this restaurant', { status: 404 });

  const upstream = await fetch(sourceUrl);
  if (!upstream.ok || !upstream.body) {
    return new Response('Upstream error', { status: 502 });
  }

  // The IMAGES binding is auto-attached by @astrojs/cloudflare at deploy time
  // (see build log: "Enabling image processing with Cloudflare Images for
  // production with the IMAGES Images binding"). Cast to access it without
  // expanding the project-wide Env type.
  const images = (env as unknown as { IMAGES: Images }).IMAGES;
  if (!images) return new Response('Image transform not available', { status: 500 });

  const transformed = await images
    .input(upstream.body)
    .transform({ width: OG_WIDTH, height: OG_HEIGHT, fit: 'cover' })
    .output({ format: 'image/jpeg', quality: 85 });

  return new Response(transformed.image(), {
    headers: {
      'Content-Type': transformed.contentType(),
      // OG images are stable per restaurant unless the hero photo changes —
      // a day's edge cache is plenty and shaves repeat scrape traffic.
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  });
};

// Local type stub — the workers-types `Images` interface isn't pulled in by
// our existing config. This is the minimum surface we use here.
interface Images {
  input(stream: ReadableStream): ImagesTransform;
}
interface ImagesTransform {
  transform(opts: { width: number; height: number; fit: 'cover' | 'contain' | 'scale-down' }): ImagesTransform;
  output(opts: { format: string; quality?: number }): Promise<ImagesOutput>;
}
interface ImagesOutput {
  image(): ReadableStream;
  contentType(): string;
}
