/// <reference path="../.astro/types.d.ts" />

interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  PUBLIC_PHOTOS_URL?: string;
  GOOGLE_MAPS_API_KEY?: string;
  /** Anthropic API key — only required by the offline guide-generation
   *  script (`scripts/generate-cuisine-guides.mjs`). The runtime worker
   *  doesn't call Claude directly. */
  ANTHROPIC_API_KEY?: string;
}
