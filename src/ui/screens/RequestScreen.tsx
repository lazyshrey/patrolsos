import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SendConfirmation } from '../SendConfirmation';

import { C, s, TRIAGE_COLOR } from '../theme';
import { Category, Triage } from '../../types';
import { PRESETS_BY_CATEGORY, describe } from '../../proto/presets';
import type { MeshState } from '../../state/useMesh';

const CATEGORIES: Array<[Category, string]> = [
  [Category.MEDICAL, 'Medical'],
  [Category.WATER, 'Water'],
  [Category.FOOD, 'Food'],
  [Category.SHELTER, 'Shelter'],
  [Category.EVACUATION, 'Rescue'],
  [Category.MISSING, 'Missing'],
  [Category.FIRE, 'Fire'],
  [Category.STRUCTURAL, 'Building'],
];

const URGENCY: Array<[Triage, string, string]> = [
  [Triage.RED, 'Now', 'life at risk'],
  [Triage.YELLOW, 'Soon', 'hours'],
  [Triage.GREEN, 'Can wait', 'stable'],
];

export function RequestScreen({ mesh }: { mesh: MeshState }) {
  const [category, setCategory] = useState<Category>(Category.MEDICAL);
  const [triage, setTriage] = useState<Triage>(Triage.RED);
  const [people, setPeople] = useState(1);
  const [preset, setPreset] = useState<number>(1);
  const [sentId, setSentId] = useState<number | null>(null);

  const presets = PRESETS_BY_CATEGORY[category] ?? [0];

  function pickCategory(c: Category) {
    setCategory(c);
    setPreset((PRESETS_BY_CATEGORY[c] ?? [0])[0]);
  }

  function send() {
    const id = mesh.report({ category, triage, casualties: people, descPreset: preset });
    if (id != null) setSentId(id);
  }

  const sentEntry = sentId != null ? (mesh.outbox.find((e) => e.packetId === sentId) ?? null) : null;

  const gpsLine = mesh.fix
    ? `Location found, accurate to ${Math.round(mesh.fix.acc)} m`
    : 'No location yet — your report still sends';

  if (sentId != null) {
    return (
      <SendConfirmation
        entry={sentEntry}
        colour={TRIAGE_COLOR[triage]}
        onDone={() => setSentId(null)}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={s.body}>
      <View style={{ gap: 6 }}>
        <Text style={s.title}>Request help</Text>
        <View style={s.row}>
          <View style={[s.dot, { backgroundColor: mesh.fix ? C.wait : C.soon }]} />
          <Text style={s.subtitle}>{gpsLine}</Text>
        </View>
      </View>

      {!mesh.running && (
        <View style={s.panel}>
          <Text style={s.sectionLabel}>The mesh is off</Text>
          <Text style={s.quiet}>
            Turn it on to reach nearby phones. No signal or internet is needed.
          </Text>
          <Pressable
            style={[s.primary, { backgroundColor: C.action, height: 52 }]}
            onPress={mesh.start}
            disabled={mesh.busy}
          >
            <Text style={s.primaryText}>{mesh.busy ? 'Starting…' : 'Turn on'}</Text>
          </Pressable>
        </View>
      )}

      <View style={{ gap: 11 }}>
        <Text style={s.sectionLabel}>What do you need?</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
          {CATEGORIES.map(([c, label]) => {
            const on = c === category;
            return (
              <Pressable
                key={c}
                onPress={() => pickCategory(c)}
                style={[
                  s.tile,
                  { width: '47.5%', backgroundColor: on ? C.ink : C.card, borderColor: on ? C.ink : C.line },
                ]}
              >
                <Text style={[s.tileText, { color: on ? '#FFFFFF' : C.ink }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ gap: 11 }}>
        <Text style={s.sectionLabel}>How urgent?</Text>
        <View
          style={{
            flexDirection: 'row',
            borderRadius: 14,
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.card,
            overflow: 'hidden',
          }}
        >
          {URGENCY.map(([t, label, hint], i) => {
            const on = t === triage;
            return (
              <Pressable
                key={t}
                onPress={() => setTriage(t)}
                style={{
                  flex: 1,
                  height: 62,
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 2,
                  backgroundColor: on ? TRIAGE_COLOR[t] : 'transparent',
                  borderLeftWidth: i === 0 ? 0 : 1,
                  borderLeftColor: C.line,
                }}
              >
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: on ? '600' : '500',
                    color: on ? '#FFFFFF' : C.ink,
                  }}
                >
                  {label}
                </Text>
                <Text style={{ fontSize: 11, color: on ? '#FFFFFFCC' : C.faint }}>{hint}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={s.row}>
        <Text style={[s.sectionLabel, { flex: 1 }]}>How many people?</Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            borderRadius: 12,
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.card,
            overflow: 'hidden',
          }}
        >
          <Pressable
            onPress={() => setPeople((n) => Math.max(1, n - 1))}
            style={{ width: 50, height: 50, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 22, color: C.soft }}>−</Text>
          </Pressable>
          <Text style={{ fontSize: 18, fontWeight: '600', minWidth: 34, textAlign: 'center' }}>
            {people}
          </Text>
          <Pressable
            onPress={() => setPeople((n) => Math.min(254, n + 1))}
            style={{ width: 50, height: 50, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 22, color: C.ink }}>+</Text>
          </Pressable>
        </View>
      </View>

      <View style={{ gap: 9 }}>
        <Text style={s.sectionLabel}>What is happening?</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {presets.map((p) => {
            const on = p === preset;
            return (
              <Pressable
                key={p}
                onPress={() => setPreset(p)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 11,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: on ? C.ink : C.line,
                  backgroundColor: on ? C.ink : C.card,
                }}
              >
                <Text style={{ fontSize: 14, color: on ? '#FFFFFF' : C.soft }}>{describe(p)}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ gap: 10 }}>
        <Pressable
          style={[s.primary, { backgroundColor: mesh.running ? TRIAGE_COLOR[triage] : C.hairline }]}
          onPress={send}
          disabled={!mesh.running}
        >
          <Text style={s.primaryText}>Send</Text>
        </Pressable>
        <Text style={[s.quiet, { textAlign: 'center' }]}>
          Works with no signal. Passes phone to phone until it reaches help.
        </Text>
      </View>
    </ScrollView>
  );
}
