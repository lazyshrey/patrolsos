/**
 * The offline map.
 *
 * North up, metres across, you in the middle. Every phone the mesh has heard
 * of, drawn at its true bearing and true distance, with the links between them.
 * No tiles, no basemap, no network — there is none to be had — just the
 * geometry, which is the part you can walk on.
 *
 * HOW IT STAYS FLUID WITHOUT A GESTURE LIBRARY
 * -------------------------------------------
 * react-native-svg, reanimated and gesture-handler are all absent by design:
 * this app has to build with nothing but Expo's core. So the whole scene is
 * laid out once in world pixels inside a single layer, and pan and pinch only
 * ever write to that layer's transform. Dragging never re-renders React — it
 * writes three Animated values — which is what keeps it smooth on a cheap phone
 * with a mesh running behind it.
 *
 * Markers counter-scale against the same zoom value, so dots and labels hold
 * their size on screen while the distances between them stretch. Accuracy
 * circles deliberately do NOT: they are drawn in metres, and a metre has to
 * stay a metre or the circle would be a lie.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  PanResponder,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { C, mono, TRIAGE_COLOR } from '../theme';
import { callsign } from '../../services/nodeIdentity';
import { formatDistance } from '../../core/geo';
import {
  boundsOf,
  compassPoint,
  fitBounds,
  rangeRings,
  scaleBar,
  type Fit,
} from '../../core/mapProjection';
import type { MapMarker, MapScene } from '../../core/mapScene';
import { BasemapLayer } from './BasemapLayer';
import { useMapPack } from './basemapSource';

/**
 * Absolute limits on the map's scale, in screen pixels per metre.
 *
 * These are not per-gesture limits. Zoom is folded into the frame every time a
 * gesture ends (see commitFrame), so what the user is really moving between is
 * "the whole country fits on screen" and "four pixels to the metre", which is
 * finer than any GPS fix on a phone deserves.
 */
const MIN_PX_PER_M = 8e-5;
const MAX_PX_PER_M = 4;

/** Range rings stop meaning anything once the view is kilometres across. */
const RINGS_MAX_SPAN_M = 6000;
/** Below this much finger travel, a touch is a tap and not a drag. */
const TAP_SLOP_PX = 8;
const TAP_MS = 320;
/** How close a tap has to land, in screen pixels, to pick a marker. */
const TAP_TARGET_PX = 34;

/** Marker box. Fixed size so nothing has to overflow its parent to be centred. */
const BOX_W = 132;
const BOX_H = 96;
const BOX_CX = BOX_W / 2;
const BOX_CY = BOX_H / 2;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function touchDistance(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }) {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

export function markerName(m: MapMarker): string {
  if (m.kind === 'self') return 'You';
  if (m.nodeId != null) return callsign(m.nodeId);
  return m.label;
}

const IDLE_FIT: Fit = { pxPerM: 1, centre: { x: 0, y: 0 } };

/** Re-framing on a sub-metre change would make the map twitch every tick. */
function sameFit(a: Fit, b: Fit): boolean {
  return (
    Math.abs(a.pxPerM - b.pxPerM) / Math.max(a.pxPerM, b.pxPerM) < 0.02 &&
    Math.abs(a.centre.x - b.centre.x) < 1.5 &&
    Math.abs(a.centre.y - b.centre.y) < 1.5
  );
}

export function MeshMap({
  scene,
  running,
  height,
  expanded = false,
  onToggleExpand,
  onRing,
}: {
  scene: MapScene;
  running: boolean;
  /** Ignored when `expanded` — a full-screen map fills whatever it is given. */
  height?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onRing?: (nodeId: number) => void;
}) {
  const pack = useMapPack();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  /** Zoom mirrored into React state, purely so the scale bar can be honest. */
  const [zoomLabel, setZoomLabel] = useState(1);

  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const k = useRef(new Animated.Value(1)).current;
  const inv = useMemo(() => Animated.divide(1, k), [k]);

  // Animated values cannot be read synchronously, and the gesture maths needs
  // the current numbers on every frame — so they are mirrored into refs. This
  // is also why nothing here uses the native driver: the listener has to fire
  // in step with setValue, not a frame later on another thread.
  const live = useRef({ tx: 0, ty: 0, k: 1 });
  useEffect(() => {
    const a = tx.addListener(({ value }) => (live.current.tx = value));
    const b = ty.addListener(({ value }) => (live.current.ty = value));
    const c = k.addListener(({ value }) => (live.current.k = value));
    return () => {
      tx.removeListener(a);
      ty.removeListener(b);
      k.removeListener(c);
    };
  }, [tx, ty, k]);

  // ---------------------------------------------------------------------------
  // Framing
  // ---------------------------------------------------------------------------
  // The map re-frames itself while nobody has touched it, so a phone lying on a
  // table keeps everything in view as the mesh grows. The moment somebody
  // drags, it stops moving under their hand until they ask for it back.
  const touched = useRef(false);
  const [frame, setFrame] = useState<Fit>(IDLE_FIT);

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const markersRef = useRef(scene.markers);
  markersRef.current = scene.markers;
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const fitNow = useCallback((): Fit => {
    const { w, h } = sizeRef.current;
    if (w === 0) return IDLE_FIT;
    const pts = markersRef.current.map((m) => ({ x: m.x, y: m.y, radiusM: m.accuracyM }));
    return fitBounds(boundsOf(pts, 80), w, h, 56, 4);
  }, []);

  useEffect(() => {
    if (touched.current || size.w === 0) return;
    const next = fitNow();
    setFrame((prev) => (sameFit(prev, next) ? prev : next));
  }, [scene.markers, size.w, size.h, fitNow]);

  const recentre = useCallback(() => {
    touched.current = false;
    setSelected(null);
    setFrame(fitNow());
    Animated.parallel([
      Animated.spring(tx, { toValue: 0, useNativeDriver: false, friction: 9, tension: 60 }),
      Animated.spring(ty, { toValue: 0, useNativeDriver: false, friction: 9, tension: 60 }),
      Animated.spring(k, { toValue: 1, useNativeDriver: false, friction: 9, tension: 60 }),
    ]).start(() => setZoomLabel(1));
  }, [tx, ty, k, fitNow]);

  /**
   * Fold the current pan and zoom into the frame itself, then reset the
   * transform to identity.
   *
   * REQUIRED, not tidiness. The layer is laid out in world pixels at
   * frame.pxPerM, and the basemap covers a whole country: at mesh scale, India
   * is billions of pixels wide, which is past the precision an SVG path or a
   * native transform will survive. Re-basing on every gesture end keeps the
   * numbers near the viewport no matter how far out the user zooms. It is
   * visually a no-op — the algebra below places every point exactly where it
   * already was.
   */
  const commitFrame = useCallback(() => {
    const { tx: t, ty: u, k: z } = live.current;
    if (Math.abs(z - 1) < 1e-6 && t === 0 && u === 0) return;

    const f = frameRef.current;
    // The world-pixel point sitting at the middle of the viewport right now.
    const wx = -t / z;
    const wy = -u / z;

    tx.setValue(0);
    ty.setValue(0);
    k.setValue(1);
    setZoomLabel(1);
    touched.current = true;
    setFrame({
      pxPerM: clamp(f.pxPerM * z, MIN_PX_PER_M, MAX_PX_PER_M),
      centre: { x: f.centre.x + wx / f.pxPerM, y: f.centre.y - wy / f.pxPerM },
    });
  }, [tx, ty, k]);

  /** Gesture bounds for k, derived from the absolute scale limits. */
  const zoomBounds = useCallback(() => {
    const p = frameRef.current.pxPerM;
    return { lo: MIN_PX_PER_M / p, hi: MAX_PX_PER_M / p };
  }, []);

  /** Frame the whole region, so the basemap has something to show. */
  const showRegion = useCallback(() => {
    const { w } = sizeRef.current;
    if (w === 0) return;
    const self = markersRef.current.find((m) => m.kind === 'self');
    const centre = self ? { x: self.x, y: self.y } : frameRef.current.centre;
    tx.setValue(0);
    ty.setValue(0);
    k.setValue(1);
    setZoomLabel(1);
    setSelected(null);
    touched.current = true;
    // 200 km across: far enough for highways, rivers and a few cities to mean
    // something, close enough that you can still see which town you are in.
    setFrame({ pxPerM: w / 200_000, centre });
  }, [tx, ty, k]);

  const zoomBy = useCallback(
    (ratio: number) => {
      touched.current = true;
      const b = zoomBounds();
      const next = clamp(live.current.k * ratio, b.lo, b.hi);
      // Zoom about the middle of the viewport, which is where the eye is.
      const factor = next / live.current.k;
      const opts = { duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false };
      Animated.parallel([
        Animated.timing(k, { toValue: next, ...opts }),
        Animated.timing(tx, { toValue: live.current.tx * factor, ...opts }),
        Animated.timing(ty, { toValue: live.current.ty * factor, ...opts }),
      ]).start(() => {
        setZoomLabel(next);
        commitFrame();
      });
    },
    [k, tx, ty, zoomBounds, commitFrame]
  );

  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------

  const gesture = useRef({
    startTx: 0,
    startTy: 0,
    startK: 1,
    startDist: 0,
    /** World-pixel point that must stay under the fingers while pinching. */
    anchor: { x: 0, y: 0 },
    startedAt: 0,
    moved: 0,
  }).current;

  /** Screen pixels -> world pixels (the layer's own untransformed space). */
  const toWorld = useCallback((sx: number, sy: number) => {
    const { w, h } = sizeRef.current;
    const { tx: t, ty: u, k: z } = live.current;
    return { x: (sx - w / 2 - t) / z, y: (sy - h / 2 - u) / z };
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2 || g.numberActiveTouches === 2,
        onPanResponderTerminationRequest: () => false,

        onPanResponderGrant: (e) => {
          gesture.startTx = live.current.tx;
          gesture.startTy = live.current.ty;
          gesture.startK = live.current.k;
          gesture.startedAt = Date.now();
          gesture.moved = 0;
          gesture.startDist = 0;

          const t = e.nativeEvent.touches;
          if (t.length === 2) {
            gesture.startDist = touchDistance(t[0], t[1]);
            gesture.anchor = toWorld(
              (t[0].locationX + t[1].locationX) / 2,
              (t[0].locationY + t[1].locationY) / 2
            );
          }
        },

        onPanResponderMove: (e, g) => {
          gesture.moved = Math.max(gesture.moved, Math.hypot(g.dx, g.dy));
          const t = e.nativeEvent.touches;
          const { w, h } = sizeRef.current;

          if (t.length === 2) {
            const d = touchDistance(t[0], t[1]);
            const mx = (t[0].locationX + t[1].locationX) / 2;
            const my = (t[0].locationY + t[1].locationY) / 2;

            // A pinch often begins mid-drag, when the second finger lands late.
            if (gesture.startDist === 0) {
              gesture.startDist = d;
              gesture.startK = live.current.k;
              gesture.anchor = toWorld(mx, my);
              return;
            }

            // Keep whatever was between the fingers between the fingers. This
            // one line is the difference between a map and a fight.
            const b = zoomBounds();
            const next = clamp((gesture.startK * d) / gesture.startDist, b.lo, b.hi);
            k.setValue(next);
            tx.setValue(mx - w / 2 - gesture.anchor.x * next);
            ty.setValue(my - h / 2 - gesture.anchor.y * next);
            touched.current = true;
            return;
          }

          tx.setValue(gesture.startTx + g.dx);
          ty.setValue(gesture.startTy + g.dy);
          if (gesture.moved > TAP_SLOP_PX) touched.current = true;
        },

        onPanResponderRelease: (e) => {
          setZoomLabel(live.current.k);
          const quick = Date.now() - gesture.startedAt < TAP_MS;
          if (!quick || gesture.moved > TAP_SLOP_PX) {
            commitFrame();
            return;
          }

          // A tap. Pick what is under the finger by SCREEN distance, so the hit
          // area stays thumb-sized however far the map is zoomed out.
          const { locationX, locationY } = e.nativeEvent;
          const world = toWorld(locationX, locationY);
          const z = live.current.k;
          const f = frameRef.current;

          let best: MapMarker | null = null;
          let bestPx = Infinity;
          for (const m of markersRef.current) {
            const wx = (m.x - f.centre.x) * f.pxPerM;
            const wy = -(m.y - f.centre.y) * f.pxPerM;
            const px = Math.hypot(wx - world.x, wy - world.y) * z;
            if (px < bestPx) {
              bestPx = px;
              best = m;
            }
          }
          setSelected(best && bestPx <= TAP_TARGET_PX ? best.id : null);
        },
      }),
    [gesture, k, tx, ty, toWorld, zoomBounds, commitFrame]
  );

  // ---------------------------------------------------------------------------
  // Derived geometry
  // ---------------------------------------------------------------------------

  const W2 = size.w / 2;
  const H2 = size.h / 2;

  /** World pixels for a projected point, relative to the framed centre. */
  const place = useCallback(
    (p: { x: number; y: number }) => ({
      x: (p.x - frame.centre.x) * frame.pxPerM,
      // North is up and screen y grows downward. This minus sign is the map.
      y: -(p.y - frame.centre.y) * frame.pxPerM,
    }),
    [frame]
  );

  const self = scene.markers.find((m) => m.kind === 'self') ?? null;
  const selfAt = self ? place(self) : null;

  const pxPerM = frame.pxPerM * zoomLabel;
  const bar = scaleBar(pxPerM, Math.min(110, Math.max(48, size.w * 0.3)));
  const rings = useMemo(() => {
    if (!selfAt || size.w === 0) return [];
    // Once the view is kilometres across, rings around you say nothing useful
    // and just add clutter over the basemap. The scale bar takes over.
    if (size.w / pxPerM > RINGS_MAX_SPAN_M) return [];
    // Reach the corners: half the viewport diagonal, in metres.
    return rangeRings(Math.hypot(size.w, size.h) / 2 / pxPerM);
  }, [selfAt, size.w, size.h, pxPerM]);

  const chosen = scene.markers.find((m) => m.id === selected) ?? null;
  /** Controls step aside rather than sit under the detail card. */
  const controlsBottom = chosen ? 172 : 12;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height: hh } = e.nativeEvent.layout;
    setSize((prev) => (prev.w === width && prev.h === hh ? prev : { w: width, h: hh }));
  };

  return (
    <View
      onLayout={onLayout}
      style={{
        ...(expanded ? { flex: 1 } : { height }),
        borderRadius: expanded ? 0 : 16,
        overflow: 'hidden',
        backgroundColor: '#F4F2EE',
        borderWidth: expanded ? 0 : 1,
        borderColor: C.line,
      }}
    >
      {/* The world. Everything below moves together under one transform. */}
      <Animated.View
        {...pan.panHandlers}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          // Panned content lives outside this layer's own box by definition.
          overflow: 'visible',
          transform: [{ translateX: tx }, { translateY: ty }, { scale: k }],
        }}
      >
        {/*
          Underneath everything, and inside the same transform, so a drag moves
          the country and the people on it as one thing.
        */}
        {scene.origin && (
          <BasemapLayer pack={pack} origin={scene.origin} frame={frame} size={size} />
        )}

        {selfAt &&
          rings.map((r) => {
            const rad = r * frame.pxPerM;
            return (
              <View
                key={r}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: W2 + selfAt.x - rad,
                  top: H2 + selfAt.y - rad,
                  width: rad * 2,
                  height: rad * 2,
                  borderRadius: rad,
                  borderWidth: 1,
                  borderColor: C.line,
                }}
              />
            );
          })}

        {/*
          A ring with no number on it is decoration.

          The label rides the ring's north-west crossing, and that is not an
          aesthetic choice: every control on this map lives on the right edge or
          along the bottom, so a label placed anywhere else eventually slides
          under a button and gets cut in half.
        */}
        {selfAt &&
          rings.map((r) => (
            <Animated.View
              key={`ring:${r}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: W2 + selfAt.x - r * frame.pxPerM * Math.SQRT1_2 - 40,
                top: H2 + selfAt.y - r * frame.pxPerM * Math.SQRT1_2 - 9,
                width: 80,
                height: 18,
                alignItems: 'center',
                justifyContent: 'center',
                transform: [{ scale: inv }],
              }}
            >
              <View
                style={{
                  paddingHorizontal: 5,
                  borderRadius: 4,
                  backgroundColor: 'rgba(244,242,238,0.9)',
                }}
              >
                <Text style={{ fontSize: 10, color: C.faint, fontFamily: mono }}>
                  {r >= 1000 ? `${r / 1000} km` : `${r} m`}
                </Text>
              </View>
            </Animated.View>
          ))}

        {scene.links.map((l) => {
          const a = place(l.from);
          const b = place(l.to);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 0.5) return null;
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          return (
            <Animated.View
              key={l.id}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: W2 + a.x + dx / 2 - len / 2,
                top: H2 + a.y + dy / 2 - 1,
                width: len,
                height: 2,
                borderRadius: 1,
                backgroundColor: l.own ? C.action : C.hairline,
                opacity: 0.16 + l.strength * (l.own ? 0.64 : 0.4),
                // Rotate, then undo the zoom on thickness alone: a link's length
                // is a real distance, its width is only ink.
                transform: [{ rotate: `${angle}deg` }, { scaleY: inv }],
              }}
            />
          );
        })}

        {/* Uncertainty first, so no circle is ever drawn over a marker. */}
        {scene.markers
          .filter((m) => m.accuracyM > 0)
          .map((m) => {
            const p = place(m);
            const rad = m.accuracyM * frame.pxPerM;
            return (
              <View
                key={`acc:${m.id}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: W2 + p.x - rad,
                  top: H2 + p.y - rad,
                  width: rad * 2,
                  height: rad * 2,
                  borderRadius: rad,
                  backgroundColor: 'rgba(194,130,14,0.09)',
                  borderWidth: 1,
                  borderColor: 'rgba(194,130,14,0.35)',
                }}
              />
            );
          })}

        {scene.markers.map((m) => {
          const p = place(m);
          return (
            <Animated.View
              key={m.id}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: W2 + p.x - BOX_CX,
                top: H2 + p.y - BOX_CY,
                width: BOX_W,
                height: BOX_H,
                // The box is centred on the fix, so counter-scaling pivots
                // exactly there and the dot never drifts off its own position.
                transform: [{ scale: inv }],
              }}
            >
              <Marker marker={m} running={running} selected={m.id === selected} />
            </Animated.View>
          );
        })}
      </Animated.View>

      {/* --- screen-fixed furniture ------------------------------------- */}

      <View pointerEvents="none" style={{ position: 'absolute', left: 12, top: 10 }}>
        <NorthArrow />
      </View>

      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 12, bottom: controlsBottom }}
      >
        <View
          style={{
            width: bar.px,
            height: 6,
            borderColor: C.soft,
            borderWidth: 1,
            borderTopWidth: 0,
          }}
        />
        <Text style={{ fontSize: 11, color: C.soft, paddingTop: 3, fontFamily: mono }}>
          {bar.meters >= 1000 ? `${bar.meters / 1000} km` : `${bar.meters} m`}
        </Text>
      </View>

      {onToggleExpand && (
        <View style={{ position: 'absolute', right: 10, top: 10 }}>
          <MapButton label={expanded ? 'Done' : 'Expand'} onPress={onToggleExpand} wide />
        </View>
      )}

      <View
        style={{
          position: 'absolute',
          right: 10,
          bottom: controlsBottom,
          gap: 8,
          alignItems: 'flex-end',
        }}
      >
        <MapButton label="+" onPress={() => zoomBy(1.8)} />
        <MapButton label="−" onPress={() => zoomBy(1 / 1.8)} />
        <MapButton label="Region" onPress={showRegion} wide />
        <MapButton label={scene.anchoredToSelf ? 'Centre' : 'Fit'} onPress={recentre} wide />
      </View>

      {scene.origin == null && (
        <Empty
          title="Nothing to place yet"
          body={
            running
              ? 'Waiting for a satellite fix, or for a phone that has one. The map draws itself the moment either arrives.'
              : 'Start the mesh from Checks. The map needs a position — this phone’s, or one from somebody near it.'
          }
        />
      )}

      {scene.origin != null && scene.markers.length <= 1 && (
        <Empty
          title="You are the only phone here"
          body="Anyone the mesh hears will appear at their real bearing and distance from you, with no network involved."
        />
      )}

      {chosen && (
        <Detail
          marker={chosen}
          running={running}
          onClose={() => setSelected(null)}
          onRing={onRing}
        />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

function Marker({
  marker,
  running,
  selected,
}: {
  marker: MapMarker;
  running: boolean;
  selected: boolean;
}) {
  const m = marker;
  const pulse = useRef(new Animated.Value(0)).current;

  // Two things pulse, and both mean "right now": a phone whose alarm is
  // sounding, and this phone while it is advertising into the dark.
  const alive = m.ringing || (m.kind === 'self' && running);
  useEffect(() => {
    if (!alive) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: m.ringing ? 1100 : 2600,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [alive, m.ringing, pulse]);

  const tint =
    m.kind === 'incident'
      ? TRIAGE_COLOR[m.triage ?? 4]
      : m.ringing
        ? C.now
        : m.kind === 'self'
          ? C.action
          : m.kind === 'estimate'
            ? C.soon
            : C.ink;

  // A peer we have not heard from in a while is still drawn — it was real —
  // but faded, because the person may have walked away minutes ago.
  const stale = m.kind === 'direct' || m.kind === 'relayed' ? Date.now() - m.at > 90_000 : false;

  return (
    <>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: BOX_CX - 15,
          top: BOX_CY - 15,
          width: 30,
          height: 30,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {alive && (
          <Animated.View
            style={{
              position: 'absolute',
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: m.ringing ? C.now : C.action,
              opacity: pulse.interpolate({
                inputRange: [0, 1],
                outputRange: [m.ringing ? 0.5 : 0.17, 0],
              }),
              transform: [
                {
                  scale: pulse.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.55, m.ringing ? 3.4 : 4.4],
                  }),
                },
              ],
            }}
          />
        )}

        {m.kind === 'self' ? (
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              backgroundColor: C.action,
              borderWidth: 3,
              borderColor: C.card,
            }}
          />
        ) : m.kind === 'incident' ? (
          // A report is the one thing on this map that is not a phone, so it is
          // the one shape that is not a circle.
          <View
            style={{
              width: 14,
              height: 14,
              backgroundColor: tint,
              borderWidth: 2,
              borderColor: C.card,
              transform: [{ rotate: '45deg' }],
            }}
          />
        ) : (
          <View
            style={{
              width: 15,
              height: 15,
              borderRadius: 8,
              // Filled means we hear it ourselves. Hollow means relayed, or
              // worked out from other people's signal reports — less certain,
              // and the shape says so before the label does.
              backgroundColor: m.kind === 'direct' ? tint : C.card,
              borderWidth: m.kind === 'direct' ? 2.5 : 2,
              borderColor: m.kind === 'direct' ? C.card : tint,
              opacity: stale ? 0.45 : 1,
            }}
          />
        )}
      </View>

      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: BOX_CY + 12,
          alignItems: 'center',
        }}
      >
        <View
          style={{
            paddingHorizontal: 5,
            paddingVertical: 1,
            borderRadius: 5,
            backgroundColor: selected ? C.ink : 'rgba(244,242,238,0.82)',
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              fontSize: 10,
              fontWeight: selected ? '700' : '500',
              color: selected ? C.card : C.soft,
              opacity: stale ? 0.6 : 1,
            }}
          >
            {markerName(m)}
          </Text>
        </View>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Furniture
// ---------------------------------------------------------------------------

function NorthArrow() {
  return (
    <View style={{ alignItems: 'center', width: 26 }}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: 5,
          borderRightWidth: 5,
          borderBottomWidth: 11,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: C.soft,
        }}
      />
      <Text style={{ fontSize: 10, fontWeight: '700', color: C.soft, marginTop: 1 }}>N</Text>
    </View>
  );
}

function MapButton({
  label,
  onPress,
  wide,
}: {
  label: string;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minWidth: 34,
        height: 34,
        paddingHorizontal: wide ? 11 : 0,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? C.lineSoft : 'rgba(255,255,255,0.94)',
        borderWidth: 1,
        borderColor: C.line,
      })}
    >
      <Text style={{ fontSize: wide ? 13 : 19, fontWeight: '600', color: C.ink }}>{label}</Text>
    </Pressable>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 48,
      }}
    >
      <Text style={{ fontSize: 15, fontWeight: '600', color: C.soft, textAlign: 'center' }}>
        {title}
      </Text>
      <Text
        style={{
          fontSize: 12.5,
          color: C.faint,
          textAlign: 'center',
          lineHeight: 18,
          paddingTop: 5,
        }}
      >
        {body}
      </Text>
    </View>
  );
}

/**
 * What is under the finger.
 *
 * Distance and direction come first, and in that order, because the only reason
 * to tap a marker is that you are about to walk towards it.
 */
function Detail({
  marker,
  onClose,
  onRing,
  running,
}: {
  marker: MapMarker;
  onClose: () => void;
  onRing?: (nodeId: number) => void;
  running: boolean;
}) {
  const m = marker;
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    rise.setValue(0);
    Animated.spring(rise, { toValue: 1, useNativeDriver: true, friction: 11, tension: 90 }).start();
  }, [m.id, rise]);

  const canRing = onRing != null && m.nodeId != null && m.kind !== 'self' && m.kind !== 'incident';

  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: 10,
        right: 10,
        bottom: 10,
        backgroundColor: C.card,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: m.ringing ? C.now : C.line,
        padding: 13,
        gap: 6,
        opacity: rise,
        transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: C.ink }}>
          {markerName(m)}
        </Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={{ fontSize: 13, color: C.faint }}>Close</Text>
        </Pressable>
      </View>

      <Text style={{ fontSize: 14, color: C.ink }}>
        {m.kind === 'self'
          ? 'You are here.'
          : m.distanceM == null
            ? 'Distance unknown — this phone has no fix to measure from.'
            : `${formatDistance(m.distanceM)} ${compassPoint(m.bearingDeg ?? 0)}${
                m.accuracyM > 0 ? `, give or take ${Math.round(m.accuracyM)} m` : ''
              }`}
      </Text>

      <Text style={{ fontSize: 13, color: C.faint, lineHeight: 18 }}>
        {m.detail}
        {m.battery != null ? ` Battery ${m.battery}%.` : ''}
      </Text>

      <Text style={{ fontSize: 11.5, color: C.faint, fontFamily: mono }}>
        {m.lat.toFixed(5)}, {m.lon.toFixed(5)}
      </Text>

      {canRing && (
        <Pressable
          onPress={() => onRing!(m.nodeId!)}
          disabled={!running}
          style={{
            height: 42,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: m.ringing ? C.now : C.line,
            backgroundColor: m.ringing ? '#FFF4F3' : C.paper,
            marginTop: 2,
          }}
        >
          <Text
            style={{
              fontSize: 14,
              fontWeight: '600',
              color: running ? (m.ringing ? C.now : C.action) : C.faint,
            }}
          >
            {m.ringing ? 'Ringing — walk towards the sound' : 'Ring this phone'}
          </Text>
        </Pressable>
      )}
    </Animated.View>
  );
}
