/**
 * P.A.T.R.O.L. — Peer-to-peer Aid, Tracking, & Remote Offline Link
 *
 * Offline-first disaster coordination over connectionless BLE advertisement
 * gossip. No cell, no Wi-Fi, no internet, no infrastructure.
 *
 * The designed screens are the app; Diagnostics keeps the hop counts and packet
 * trace that make a mesh problem answerable in the field.
 */

import { useState } from 'react';
import { Pressable, StatusBar, Text, View } from 'react-native';

import { C, s } from './src/ui/theme';
import { Glyph } from './src/ui/icons';
import { useMesh } from './src/state/useMesh';
import { BuzzAlert } from './src/ui/BuzzAlert';
import { RequestScreen } from './src/ui/screens/RequestScreen';
import { IncidentsScreen } from './src/ui/screens/IncidentsScreen';
import { NetworkScreen } from './src/ui/screens/NetworkScreen';
import { DiagnosticsScreen } from './src/ui/screens/DiagnosticsScreen';

type Tab = 'request' | 'incidents' | 'network' | 'diagnostics';

const TABS: Array<[Tab, string, 'plus' | 'list' | 'wave' | 'wrench']> = [
  ['request', 'Request', 'plus'],
  ['incidents', 'Incidents', 'list'],
  ['network', 'Network', 'wave'],
  ['diagnostics', 'Checks', 'wrench'],
];

export default function App() {
  const mesh = useMesh();
  const [tab, setTab] = useState<Tab>('request');

  return (
    <View style={s.screen}>
      <StatusBar barStyle="dark-content" backgroundColor={C.paper} />

      <View style={{ flex: 1, paddingTop: 34 }}>
        {tab === 'request' && <RequestScreen mesh={mesh} />}
        {tab === 'incidents' && <IncidentsScreen mesh={mesh} />}
        {tab === 'network' && <NetworkScreen mesh={mesh} />}
        {tab === 'diagnostics' && <DiagnosticsScreen mesh={mesh} />}
      </View>

      {/*
        Rendered above the tabs and outside them: being rung is not a screen you
        navigate to. It takes over whatever the person was doing, because a
        rescuer is standing over them trying to find this phone.
      */}
      {mesh.buzzing && (
        <BuzzAlert
          buzz={mesh.buzzing}
          endsAt={mesh.ringEndsAt}
          fix={mesh.fix}
          onSilence={mesh.silenceBuzz}
        />
      )}

      <View style={s.tabBar}>
        {TABS.map(([key, label, icon]) => {
          const on = tab === key;
          return (
            <Pressable key={key} style={s.tab} onPress={() => setTab(key)}>
              <Glyph name={icon} color={on ? C.ink : C.faint} size={20} />
              <Text style={on ? s.tabLabelActive : s.tabLabel}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
