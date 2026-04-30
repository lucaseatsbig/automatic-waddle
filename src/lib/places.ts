export interface PlacesPhoto {
  name: string;
  widthPx: number;
  heightPx: number;
  authorAttributions: { displayName: string; uri?: string }[];
}

export async function fetchPlacePhotos(
  placeId: string,
  apiKey: string
): Promise<PlacesPhoto[]> {
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'photos',
        Referer: 'https://lucaseatsbig.com',
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { photos?: PlacesPhoto[] };
    return data.photos ?? [];
  } catch {
    return [];
  }
}

export function placePhotoUrl(name: string, maxWidthPx = 1200): string {
  return `/api/places-photo?name=${encodeURIComponent(name)}&w=${maxWidthPx}`;
}
