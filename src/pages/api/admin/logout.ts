import type { APIRoute } from 'astro';
import { sessionClearCookie } from '../../../lib/auth';

export const POST: APIRoute = async ({ request }) => {
  const secure = new URL(request.url).protocol === 'https:';
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/',
      'Set-Cookie': sessionClearCookie(secure),
    },
  });
};
