import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { C, s, TRIAGE_COLOR } from '../theme';
import { STATUS_LABEL, TRIAGE_LABEL, describe } from '../../proto/presets';
import { formatDistance, haversineMeters } from '../../core/geo';
import type { Cluster } from '../../core/deduplicator';
import type { MeshState } from '../../state/useMesh';
import { Status } from '../../types';

type Filter = 'open' | 'all' | 'mine';

function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

export function IncidentsScreen({ mesh }: { mesh: MeshState }) {
  const [filter, setFilter] = useState<Filter>('open');
  const [open, setOpen] = useState<number | null>(null);

  const all = mesh.clusters;
  const shown = all.filter((c) => {
    if (filter === 'open') return c.status !== Status.RESOLVED;
    if (filter === 'mine') return c.mine;
    return true;
  });

  const openCount = all.filter((c) => c.status !== Status.RESOLVED).length;
  const resolved = all.length - openCount;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 22, paddingTop: 22, gap: 4 }}>
        <Text style={s.title}>Incidents</Text>
        <Text style={s.subtitle}>
          {openCount} open · {resolved} resolved
        </Text>
      </View>

      <View
        style={{
          flexDirection: 'row',
          gap: 22,
          paddingHorizontal: 22,
          paddingTop: 18,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
        }}
      >
        {(['open', 'all', 'mine'] as Filter[]).map((f) => (
          <Pressable key={f} onPress={() => setFilter(f)} style={{ paddingBottom: 11 }}>
            <Text
              style={{
                fontSize: 15,
                color: filter === f ? C.ink : C.faint,
                fontWeight: filter === f ? '500' : '400',
                borderBottomWidth: filter === f ? 2 : 0,
                borderBottomColor: C.ink,
                paddingBottom: 9,
                marginBottom: -11,
              }}
            >
              {f === 'open' ? 'Open' : f === 'all' ? 'All' : 'Mine'}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 40 }}>
        {shown.length === 0 && (
          <Text style={[s.quiet, { paddingTop: 24 }]}>
            {mesh.running
              ? 'Nothing yet. Reports from nearby phones will appear here.'
              : 'The mesh is off. Turn it on from Request help.'}
          </Text>
        )}

        {shown.map((c) => (
          <Row
            key={c.id}
            cluster={c}
            here={mesh.fix}
            expanded={open === c.id}
            onPress={() => setOpen(open === c.id ? null : c.id)}
            onAdvance={() => {
              const next = Math.min(c.status + 1, 3) as Status;
              mesh.setStatus(c.id, next);
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function Row({
  cluster,
  here,
  expanded,
  onPress,
  onAdvance,
}: {
  cluster: Cluster;
  here: { lat: number; lon: number } | null;
  expanded: boolean;
  onPress: () => void;
  onAdvance: () => void;
}) {
  const resolved = cluster.status === Status.RESOLVED;
  const dist =
    here && (cluster.lat !== 0 || cluster.lon !== 0)
      ? formatDistance(haversineMeters(here, cluster))
      : null;

  return (
    <Pressable onPress={onPress} style={[s.listRow, { opacity: resolved ? 0.6 : 1 }]}>
      <View style={[s.bar, { backgroundColor: TRIAGE_COLOR[cluster.triage] }]} />

      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text
            style={{
              fontSize: 16,
              fontWeight: '500',
              color: resolved ? C.soft : C.ink,
              flexShrink: 1,
            }}
          >
            {describe(cluster.members[0].descPreset)}
          </Text>
          {cluster.reportCount > 1 && (
            <Text style={{ fontSize: 13, color: C.faint }}>{cluster.reportCount} reports</Text>
          )}
        </View>

        <Text style={s.meta}>
          {cluster.casualties} {cluster.casualties === 1 ? 'person' : 'people'}
          {dist ? ` · ${dist} away` : ''} · {ago(cluster.lastSeen)}
        </Text>

        {cluster.status !== Status.REPORTED && (
          <Text style={{ fontSize: 13, color: TRIAGE_COLOR[cluster.triage] }}>
            {STATUS_LABEL[cluster.status]}
          </Text>
        )}

        {expanded && (
          <View style={{ gap: 10, paddingTop: 8 }}>
            <Text style={s.code}>
              {TRIAGE_LABEL[cluster.triage]} · {cluster.minHops} hop
              {cluster.minHops === 1 ? '' : 's'} away · from node {cluster.members[0].originNodeId}
            </Text>
            {!resolved && (
              <Pressable
                onPress={onAdvance}
                style={{
                  height: 46,
                  borderRadius: 12,
                  backgroundColor: C.action,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '500' }}>
                  {cluster.status === Status.REPORTED
                    ? 'Acknowledge'
                    : cluster.status === Status.ACKNOWLEDGED
                      ? 'Send a team'
                      : 'Mark resolved'}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}
