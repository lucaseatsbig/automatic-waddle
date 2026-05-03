import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// Runtime sitemap for /guides/[slug] pages — same shape as
// /sitemap-restaurants.xml. Search engines pick this up via robots.txt.
export const prerender = false;

export const GET: APIRoute = async () => {
  const { results } = await env.DB.prepare(
    `SELECT slug, COALESCE(published_at, generated_at) AS lastmod_ts
       FROM posts
      WHERE status = 'published'
      ORDER BY slug`
  ).all<{ slug: string; lastmod_ts: number | null }>();

  const baseUrl = 'https://lucaseatsbig.com';

  const urls = [
    `  <url>
    <loc>${baseUrl}/guides</loc>
  </url>`,
    ...results.map((r) => {
      const lastmod = r.lastmod_ts
        ? new Date(r.lastmod_ts * 1000).toISOString()
        : null;
      return `  <url>
    <loc>${baseUrl}/guides/${r.slug}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
  </url>`;
    }),
  ];

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
