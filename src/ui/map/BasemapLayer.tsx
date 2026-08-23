/**
 * The offline basemap.
 *
 * Coastline, state borders, rivers, lakes, major roads and cities, drawn from
 * the pack bundled in the APK. No tiles, no requests, no network — the data is
 * already on the phone before the disaster starts, which is the only way a map
 * exists at all in the situation this app is for.
 *
 * WHY IT IS GREY
 * --------------
 * theme.ts sets one rule the whole app obeys: colour means urgency, and nothing
 * else is coloured. A conventional blue-and-green basemap would break it and,
 * worse, would put a large blue river next to a red casualty marker and make
 * them compete. So the basemap is drawn in neutral greys — cool for water, warm
 * for roads — and every drop of colour on screen is still triage.
 *
 * WHY EVERY LAYER IS ONE PATH
 * ---------------------------
 * Thousands of separate <Path> nodes is thousands of native views. Each layer
 * is concatenated into a single path with many subpaths instead, so a country
 * of roads costs six nodes rather than two thousand, and the whole basemap is
 * rebuilt only when the frame changes — never during a drag.
 */

import { useMemo } from 'react';
import { Svg, Path, Circle, Text as SvgText, G } from 'react-native-svg';

import { C } from '../theme';
import type { LatLon } from '../../core/geo';
import { project, unproject, type Fit } from '../../core/mapProjection';
import {
  ranksForSpan,
  selectLines,
  selectPoints,
  type MapPack,
  type LineFeature,
} from '../../core/mapPack';

/**
 * How much bigger than the viewport the basemap is drawn.
 *
 * A drag moves the whole world layer without re-rendering anything, so without
 * margin the basemap would slide away and leave blank paper at the edges until
 * the finger lifted. One extra viewport in each direction is enough to cover
 * any single gesture.
 */
const PAD = 1;

/** Neutral by design — see the note at the top of this file. */
const INK = {
  land: '#EDEBE6',
  coast: '#BDB8AE',
  state: '#DAD5CC',
  water: '#B4BCC1',
  waterFill: '#DCE1E3',
  road: '#D3CCC0',
  roadMajor: '#C0B8AA',
  city: '#8C877E',
};

function pathOf(
  features: LineFeature[],
  origin: LatLon,
  toX: (mx: number) => number,
  toY: (my: number) => number
): string {
  const out: string[] = [];
  for (const f of features) {
    const c = f.coords;
    let d = '';
    for (let i = 0; i < c.length; i += 2) {
      const p = project(origin, { lon: c[i], lat: c[i + 1] });
      // One decimal is a tenth of a pixel. Anything finer is invisible and
      // makes the path string — which crosses the bridge — needlessly long.
      const x = toX(p.x).toFixed(1);
      const y = toY(p.y).toFixed(1);
      d += i === 0 ? `M${x} ${y}` : `L${x} ${y}`;
    }
    out.push(d);
  }
  return out.join('');
}

export function BasemapLayer({
  pack,
  origin,
  frame,
  size,
}: {
  pack: MapPack | null;
  origin: LatLon;
  frame: Fit;
  size: { w: number; h: number };
}) {
  const built = useMemo(() => {
    if (!pack || size.w === 0 || frame.pxPerM <= 0) return null;

    const w = size.w;
    const h = size.h;
    // Metres covered by the padded drawing area.
    const halfW = (w * (1 + 2 * PAD)) / 2 / frame.pxPerM;
    const halfH = (h * (1 + 2 * PAD)) / 2 / frame.pxPerM;

    const sw = unproject(origin, { x: frame.centre.x - halfW, y: frame.centre.y - halfH });
    const ne = unproject(origin, { x: frame.centre.x + halfW, y: frame.centre.y + halfH });
    const bbox: [number, number, number, number] = [sw.lon, sw.lat, ne.lon, ne.lat];

    const spanKm = (w / frame.pxPerM) / 1000;
    const ranks = ranksForSpan(spanKm);

    // Metres -> coordinates inside the padded Svg.
    const toX = (mx: number) => (mx - frame.centre.x) * frame.pxPerM + w / 2 + w * PAD;
    const toY = (my: number) => -(my - frame.centre.y) * frame.pxPerM + h / 2 + h * PAD;

    const lines = (name: string) => selectLines(pack.layers.get(name), bbox, ranks[name] ?? -1);

    const coast = lines('coast');
    const cities = selectPoints(pack.layers.get('city'), bbox, ranks.city ?? -1);

    return {
      w,
      h,
      spanKm,
      coast: pathOf(coast, origin, toX, toY),
      state: pathOf(lines('state'), origin, toX, toY),
      river: pathOf(lines('river'), origin, toX, toY),
      lake: pathOf(lines('lake'), origin, toX, toY),
      road: pathOf(
        lines('road').filter((f) => f.rank > 0),
        origin,
        toX,
        toY
      ),
      roadMajor: pathOf(
        lines('road').filter((f) => f.rank === 0),
        origin,
        toX,
        toY
      ),
      cities: cities.slice(0, 60).map((p) => {
        const m = project(origin, p);
        return { ...p, x: toX(m.x), y: toY(m.y) };
      }),
    };
  }, [pack, origin, frame, size.w, size.h]);

  if (!built) return null;

  const { w, h } = built;
  // Roads get thinner as more of them appear, so a dense area stays readable.
  const roadWidth = built.spanKm > 400 ? 0.7 : built.spanKm > 120 ? 0.9 : 1.1;

  return (
    <Svg
      pointerEvents="none"
      width={w * (1 + 2 * PAD)}
      height={h * (1 + 2 * PAD)}
      style={{ position: 'absolute', left: -w * PAD, top: -h * PAD }}
    >
      {/*
        Land is filled with the closed coastline rings under an even-odd rule,
        so the enclosed sea and the lakes cut out of it read as water rather
        than as land with a line drawn round them.
      */}
      {built.coast !== '' && (
        <Path d={built.coast} fill={INK.land} fillRule="evenodd" stroke="none" />
      )}
      {built.lake !== '' && <Path d={built.lake} fill={INK.waterFill} stroke="none" />}

      {built.state !== '' && (
        <Path d={built.state} fill="none" stroke={INK.state} strokeWidth={0.8} />
      )}
      {built.coast !== '' && (
        <Path d={built.coast} fill="none" stroke={INK.coast} strokeWidth={1.2} />
      )}

      {built.road !== '' && (
        <Path
          d={built.road}
          fill="none"
          stroke={INK.road}
          strokeWidth={roadWidth}
          strokeLinecap="round"
        />
      )}
      {built.roadMajor !== '' && (
        <Path
          d={built.roadMajor}
          fill="none"
          stroke={INK.roadMajor}
          strokeWidth={roadWidth + 0.7}
          strokeLinecap="round"
        />
      )}

      {built.river !== '' && (
        <Path
          d={built.river}
          fill="none"
          stroke={INK.water}
          strokeWidth={1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {built.cities.map((p) => (
        <G key={`${p.name}:${p.lon.toFixed(3)}`}>
          <Circle cx={p.x} cy={p.y} r={p.rank === 0 ? 3 : 2} fill={INK.city} />
          <SvgText
            x={p.x + 5}
            y={p.y + 3.5}
            fill={C.soft}
            fontSize={p.rank === 0 ? 11 : 9.5}
            fontWeight={p.rank === 0 ? '600' : '400'}
          >
            {p.name}
          </SvgText>
        </G>
      ))}
    </Svg>
  );
}
