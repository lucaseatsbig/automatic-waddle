import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// Runtime sitemap for restaurant detail pages. The static @astrojs/sitemap
// integration can't enumerate these because they're dynamic ([slug]) and
// output is 'server'. Search engines pick this up via robots.txt.
export const prerender = false;

export const GET: APIRoute = async () => {
  const { results } = await env.DB.prepare(
    `SELECT res.slug, res.updated_at,
            MAX(rv.updated_at) AS latest_review_updated
     FROM restaurants res
     LEFT JOIN reviews rv ON rv.restaurant_id = res.id AND rv.status = 'published'
     GROUP BY res.id
     ORDER BY res.name`
  ).all<{ slug: string; updated_at: number | null; latest_review_updated: number | null }>();

  const baseUrl = 'https://lucaseatsbig.com';
  const urls = results.map((r) => {
    const ts = Math.max(r.updated_at ?? 0, r.latest_review_updated ?? 0);
    const lastmod = ts > 0 ? new Date(ts * 1000).toISOString() : null;
    return `  <url>
    <loc>${baseUrl}/restaurants/${r.slug}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
  </url>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};
