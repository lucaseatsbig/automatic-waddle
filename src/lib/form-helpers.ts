import type { MealType, ReviewStatus } from './types';

function str(form: FormData, key: string): string | null {
  const v = form.get(key);
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

function num(form: FormData, key: string): number | null {
  const s = str(form, key);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function bool(form: FormData, key: string): boolean {
  const v = form.get(key);
  return v === '1' || v === 'on' || v === 'true';
}

function ids(form: FormData, key: string): number[] {
  return form
    .getAll(key)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
}

const VALID_MEALS: readonly MealType[] = [
  'breakfast', 'brunch', 'lunch', 'dinner', 'dessert', 'snack', 'drinks',
];

function mealTypes(form: FormData, key: string): MealType[] {
  const valid = new Set<string>(VALID_MEALS);
  const seen = new Set<MealType>();
  for (const v of form.getAll(key)) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (valid.has(trimmed)) seen.add(trimmed as MealType);
  }
  return [...seen];
}

export function parseRestaurantForm(form: FormData) {
  return {
    name: str(form, 'name') ?? '',
    slug: str(form, 'slug') ?? '',
    cuisine: str(form, 'cuisine'),
    location_name: str(form, 'location_name'),
    address: str(form, 'address'),
    price_tier: num(form, 'price_tier'),
    website_url: str(form, 'website_url'),
    maps_url: str(form, 'maps_url'),
    place_id: str(form, 'place_id'),
    lat: num(form, 'lat'),
    lng: num(form, 'lng'),
    wishlist_note: str(form, 'wishlist_note'),
    tag_ids: ids(form, 'tag_ids'),
    meal_types: mealTypes(form, 'meal_types'),
  };
}

export function parseReviewForm(form: FormData) {
  const meal = str(form, 'meal_type');
  const mealType: MealType | null =
    meal && (VALID_MEALS as readonly string[]).includes(meal) ? (meal as MealType) : null;

  const statusRaw = str(form, 'status');
  const status: ReviewStatus = statusRaw === 'draft' ? 'draft' : 'published';

  // Standout items come in parallel arrays: standout_name[], standout_note[], standout_star[]
  const names = form.getAll('standout_name').map((v) => (typeof v === 'string' ? v.trim() : ''));
  const notes = form.getAll('standout_note').map((v) => (typeof v === 'string' ? v.trim() : ''));
  const stars = form.getAll('standout_star').map((v) => (typeof v === 'string' ? v : ''));

  const items: { name: string; note: string | null; is_standout: boolean }[] = [];
  for (let i = 0; i < names.length; i++) {
    if (!names[i]) continue;
    items.push({
      name: names[i],
      note: notes[i] || null,
      is_standout: stars[i] === '1',
    });
  }

  return {
    visit_date: str(form, 'visit_date'),
    meal_type: mealType,
    rating_overall: num(form, 'rating_overall') ?? 0,
    rating_size: num(form, 'rating_size'),
    commentary: str(form, 'commentary'),
    would_return: bool(form, 'would_return'),
    instagram_url: str(form, 'instagram_url'),
    status,
    standout_items: items,
  };
}
