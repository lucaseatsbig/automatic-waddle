export type TagCategory = 'vibe' | 'dietary' | 'other';
export type MealType = 'breakfast' | 'brunch' | 'lunch' | 'dinner' | 'dessert' | 'snack' | 'drinks';
export type ReviewStatus = 'draft' | 'published';

export interface Location {
  id: number;
  slug: string;
  name: string;
}

export interface Tag {
  id: number;
  slug: string;
  label: string;
  category: TagCategory;
}

export interface RestaurantCardData {
  id: number;
  slug: string;
  name: string;
  cuisine: string | null;
  location: string | null;
  price_tier: number | null;
  wishlist_note: string | null;
  visited: boolean;
  review_count: number;
  avg_overall: number | null;
  latest_visit_date: string | null;
  latest_meal_type: string | null;
  cover_r2_key: string | null;
  hero_photo_name: string | null;
  lat: number | null;
  lng: number | null;
  tags: { slug: string; label: string; category: TagCategory }[];
}

export type SortOption = 'rating' | 'recent' | 'name';

export interface Filters {
  q?: string;
  cuisines?: string[];
  meal?: MealType;
  locations?: string[];
  regions?: string[];
  visited?: 'yes' | 'no';
  price?: number[];
  minRating?: number;
  vibes?: string[];
  dietary?: string[];
  sort?: SortOption;
}

export interface AdminRestaurantRow {
  id: number;
  slug: string;
  name: string;
  cuisine: string | null;
  location: string | null;
  price_tier: number | null;
  review_count: number;
  published_count: number;
  draft_count: number;
  latest_visit_date: string | null;
}

export interface RestaurantEditData {
  id: number;
  slug: string;
  name: string;
  cuisine: string | null;
  location_id: number | null;
  address: string | null;
  price_tier: number | null;
  website_url: string | null;
  maps_url: string | null;
  place_id: string | null;
  lat: number | null;
  lng: number | null;
  wishlist_note: string | null;
  tag_ids: number[];
}

export interface ReviewEditData {
  id: number;
  restaurant_id: number;
  restaurant_name: string;
  slug: string;
  visit_date: string | null;
  meal_type: MealType | null;
  rating_overall: number;
  rating_size: number | null;
  commentary: string | null;
  would_return: boolean;
  instagram_url: string | null;
  status: ReviewStatus;
  standout_items: { id: number; name: string; note: string | null; is_standout: boolean; sort_order: number }[];
  photos: { id: number; r2_key: string; alt: string | null; is_cover: boolean; sort_order: number }[];
}

export interface ReviewListRow {
  id: number;
  slug: string;
  visit_date: string | null;
  meal_type: string | null;
  rating_overall: number;
  status: ReviewStatus;
}

export interface ReviewDetail {
  id: number;
  visit_date: string | null;
  meal_type: MealType | null;
  rating_overall: number | null;
  rating_size: number | null;
  commentary: string | null;
  would_return: boolean;
  instagram_url: string | null;
  standout_items: { name: string; note: string | null; is_standout: boolean }[];
  photos: { r2_key: string; alt: string | null; is_cover: boolean }[];
}

export interface RestaurantDetail {
  id: number;
  slug: string;
  name: string;
  cuisine: string | null;
  location: string | null;
  address: string | null;
  price_tier: number | null;
  website_url: string | null;
  maps_url: string | null;
  place_id: string | null;
  lat: number | null;
  lng: number | null;
  wishlist_note: string | null;
  tags: { slug: string; label: string; category: TagCategory }[];
  reviews: ReviewDetail[];
  visit_count: number;
  avg_overall: number | null;
  latest_visit_date: string | null;
}
