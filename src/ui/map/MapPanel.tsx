/**
 * The map as it sits on the Network screen.
 *
 * MeshMap knows how to draw a scene and nothing else. This is the piece that
 * decides what belongs in the scene, what the legend has to explain, and what
 * to say about the things that could not be placed — because a map that
 * silently drops the phone with no GPS fix is worse than no map at all.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { C, s, TRIAGE_COLOR } from '../theme';
import { MeshMap } from './MeshMap';
import { buildScene, type MapScene } from '../../core/mapScene';
import { MAP_PACK_COUNTRY, packCovers } from './basemapSource';
import type { MeshState } from '../../state/useMesh';

/** Height of the inline map. Tall enough to read a bearing off, short enough
 * that the list underneath is still visibly there. */
const INLINE_HEIGHT = 320;

export function MapPanel({
  mesh,
  onRing,
}: {
  mesh: MeshState;
  onRing: (nodeId: number) => void;
}) {
  const [full, setFull] = useState(false);
  const [showReports, setShowReports] = useState(true);
  const [showLinks, setShowLinks] = useState(true);

  const scene = useMemo(
    () =>
      buildScene({
        selfNodeId: mesh.nodeId,
        fix: mesh.fix,
        peers: mesh.peers,
        estimates: mesh.estimates,
        clusters: showReports ? mesh.clusters : [],
        answers: mesh.answers,
        observations: mesh.observations,
      }),
    [
      mesh.nodeId,
      mesh.fix,
      mesh.peers,
      mesh.estimates,
      mesh.clusters,
      mesh.answers,
      mesh.observations,
      showReports,
    ]
  );

  const shown: MapScene = showLinks ? scene : { ...scene, links: [] };

  const outsidePack = mesh.fix != null && !packCovers(mesh.fix.lat, mesh.fix.lon);
  const phones = scene.markers.filter((m) => m.kind !== 'incident' && m.kind !== 'self').length;
  const reports = scene.markers.filter((m) => m.kind === 'incident').length;

  const map = (expanded: boolean) => (
    <MeshMap
      scene={shown}
      running={mesh.running}
      height={INLINE_HEIGHT}
      expanded={expanded}
      onToggleExpand={() => setFull((v) => !v)}
      onRing={onRing}
    />
  );

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
        <Text style={[s.sectionLabel, { flex: 1 }]}>Map</Text>
        <Toggle label="Links" on={showLinks} onPress={() => setShowLinks((v) => !v)} />
        <Toggle label="Reports" on={showReports} onPress={() => setShowReports((v) => !v)} />
      </View>

      <Text style={s.quiet}>
        {scene.origin == null
          ? 'Nothing has a position yet.'
          : `${phones} phone${phones === 1 ? '' : 's'} and ${reports} report${
              reports === 1 ? '' : 's'
            } placed. Drag to move, pinch to zoom, tap anything to see how far away it is.`}
      </Text>

      {map(false)}

      <Legend scene={scene} />

      {/*
        Said out loud because it is the whole point, and because the basemap is
        invisible at the zoom this map opens at — somebody has to be told the
        Region button exists, or they will never see that there is a map under
        the dots at all.
      */}
      <Text style={s.quiet}>
        {outsidePack
          ? `The bundled map covers ${MAP_PACK_COUNTRY}, and this phone is outside it, so there is nothing to draw underneath. Positions and distances are unaffected.`
          : `Press Region to pull back to the offline map of ${MAP_PACK_COUNTRY} — coastline, state borders, rivers, highways and cities, all bundled in the app. Nothing is downloaded, ever. It is a country map, so it shows where you are, not which street you are on.`}
      </Text>

      {!scene.anchoredToSelf && scene.origin != null && (
        <Text style={[s.quiet, { color: C.soon }]}>
          This phone has no satellite fix, so the map is centred on everyone else and cannot show
          where you are standing.
        </Text>
      )}

      {scene.unplaced.length > 0 && (
        <View style={{ gap: 2 }}>
          {scene.unplaced.map((u) => (
            <Text key={u.label} style={s.quiet}>
              Not on the map — {u.label}: {u.reason}.
            </Text>
          ))}
        </View>
      )}

      {/*
        Full screen is not decoration. Reading a bearing off a 320 px strip
        while walking is the moment this app is least useful, so the same map
        opens to the whole display with the same gestures and the same state.
      */}
      <Modal
        visible={full}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setFull(false)}
      >
        <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: 34 }}>{map(true)}</View>
      </Modal>
    </View>
  );
}

function Toggle({
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={{
        paddingHorizontal: 11,
        height: 30,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: on ? C.ink : C.line,
        backgroundColor: on ? C.ink : C.card,
      }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: '500', color: on ? C.card : C.faint }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** RED < YELLOW < GREEN < UNKNOWN < BLACK, by urgency — as the feed sorts. */
const RANK_TO_TRIAGE: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 4, 4: 3 };

function severityRank(t: number): number {
  const order: Record<number, number> = { 0: 0, 1: 1, 2: 2, 4: 3, 3: 4 };
  return order[t] ?? 5;
}

/**
 * Only what is actually on screen gets explained. A legend listing five symbols
 * when three are present is a legend nobody finishes reading.
 */
function Legend({ scene }: { scene: MapScene }) {
  const kinds = new Set(scene.markers.map((m) => m.kind));
  const items: Array<[string, ReactNode]> = [];

  if (kinds.has('self')) items.push(['You', <Swatch key="s" fill={C.action} ring />]);
  if (kinds.has('direct')) items.push(['Heard directly', <Swatch key="d" fill={C.ink} ring />]);
  if (kinds.has('relayed')) items.push(['Relayed', <Swatch key="r" outline={C.ink} />]);
  if (kinds.has('estimate'))
    items.push(['Estimated, no fix', <Swatch key="e" outline={C.soon} />]);
  if (kinds.has('incident')) {
    // Colour is urgency everywhere else in this app, so a legend that always
    // draws a red diamond while the only report on screen is green is telling
    // the reader something false about the thing they are looking at. Take the
    // swatch from the most severe report actually placed.
    const worst = scene.markers
      .filter((m) => m.kind === 'incident')
      .reduce((acc, m) => Math.min(acc, severityRank(m.triage ?? 4)), 5);
    items.push(['Report', <Swatch key="i" fill={TRIAGE_COLOR[RANK_TO_TRIAGE[worst] ?? 4]} diamond />]);
  }

  if (items.length === 0) return null;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, rowGap: 8 }}>
      {items.map(([label, glyph]) => (
        <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {glyph}
          <Text style={{ fontSize: 12, color: C.faint }}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

function Swatch({
  fill,
  outline,
  ring,
  diamond,
}: {
  fill?: string;
  outline?: string;
  ring?: boolean;
  diamond?: boolean;
}) {
  return (
    <View
      style={{
        width: 12,
        height: 12,
        borderRadius: diamond ? 0 : 7,
        backgroundColor: fill ?? C.card,
        borderWidth: outline ? 2 : ring ? 2 : 0,
        borderColor: outline ?? C.card,
        transform: diamond ? [{ rotate: '45deg' }] : undefined,
      }}
    />
  );
}
