import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { isAuthenticated } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  const isAdminPage = path.startsWith('/admin');
  const isAdminApi = path.startsWith('/api/admin');
  const isLoginPage = path === '/admin/login';
  const isLoginApi = path === '/api/admin/login';

  if ((isAdminPage && !isLoginPage) || (isAdminApi && !isLoginApi)) {
    const ok = await isAuthenticated(context.request, env.SESSION_SECRET);
    if (!ok) {
      if (isAdminApi) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const next = encodeURIComponent(path + url.search);
      return context.redirect(`/admin/login?next=${next}`);
    }
  }

  return next();
});
