import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // Required for canonical URLs, Open Graph absolute URLs, and the sitemap.
  site: 'https://lucaseatsbig.com',
  output: 'server',
  adapter: cloudflare({
    platformProxy: { enabled: true }
  }),
  integrations: [
    sitemap({
      // Admin pages are auth-gated and shouldn't appear in search; the API is
      // not user-facing. Dynamic restaurant pages live in a separate runtime
      // sitemap (/sitemap-restaurants.xml) since the sitemap integration only
      // auto-discovers static routes.
      filter: (page) => !page.includes('/admin') && !page.includes('/api/'),
    }),
  ],
});
