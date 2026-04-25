import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createSessionToken, sessionSetCookie } from '../../../lib/auth';

export const POST: APIRoute = async ({ request, redirect }) => {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return new Response('Admin not configured (missing ADMIN_PASSWORD or SESSION_SECRET).', {
      status: 500,
    });
  }

  const form = await request.formData();
  const password = form.get('password');
  const nextRaw = form.get('next');
  const next =
    typeof nextRaw === 'string' && nextRaw.startsWith('/') && !nextRaw.startsWith('//')
      ? nextRaw
      : '/admin';

  if (typeof password !== 'string' || password !== env.ADMIN_PASSWORD) {
    return redirect(`/admin/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const token = await createSessionToken(env.SESSION_SECRET);
  const secure = new URL(request.url).protocol === 'https:';

  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      'Set-Cookie': sessionSetCookie(token, secure),
    },
  });
};
