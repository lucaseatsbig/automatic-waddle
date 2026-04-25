/// <reference path="../.astro/types.d.ts" />

interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  PUBLIC_PHOTOS_URL?: string;
  GOOGLE_MAPS_API_KEY?: string;
}
