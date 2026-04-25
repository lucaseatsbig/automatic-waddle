export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export async function uniqueSlug(
  db: D1Database,
  table: 'restaurants' | 'reviews',
  desired: string,
  excludeId?: number
): Promise<string> {
  const base = slugify(desired);
  let candidate = base;
  let n = 1;
  while (true) {
    const row = await db
      .prepare(`SELECT id FROM ${table} WHERE slug = ? LIMIT 1`)
      .bind(candidate)
      .first<{ id: number }>();
    if (!row || row.id === excludeId) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}
