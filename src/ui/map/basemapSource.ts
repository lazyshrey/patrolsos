/**
 * Getting the bundled map pack into memory, once.
 *
 * The pack is a few hundred KB of base64 that decodes into roughly sixty
 * thousand points. That is well under a tenth of a second, but it is a tenth of
 * a second of blocking work on the JS thread, and it must not happen while the
 * Network screen is trying to appear. So it runs after the first paint and the
 * result is held for the life of the process.
 */

import { useEffect, useState } from 'react';

import { fromBase64 } from '../../services/base64';
import { decodeMapPack, type MapPack } from '../../core/mapPack';
import { MAP_PACK_BASE64, MAP_PACK_BBOX, MAP_PACK_COUNTRY } from '../../assets/mapPack';

let cached: MapPack | null = null;
let attempted = false;

export { MAP_PACK_BBOX, MAP_PACK_COUNTRY };

/** True when a position is inside the region the bundled pack covers. */
export function packCovers(lat: number, lon: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = MAP_PACK_BBOX;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

export function useMapPack(): MapPack | null {
  const [pack, setPack] = useState<MapPack | null>(cached);

  useEffect(() => {
    if (cached || attempted) {
      if (cached) setPack(cached);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      attempted = true;
      try {
        cached = decodeMapPack(fromBase64(MAP_PACK_BASE64));
        if (alive) setPack(cached);
      } catch {
        // A corrupt pack must not take the screen down with it. The mesh map
        // works perfectly well with no basemap under it — that is what it did
        // before there was one.
        cached = null;
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  return pack;
}
