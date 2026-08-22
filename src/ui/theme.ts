import { Platform, StyleSheet } from 'react-native';

/**
 * Design tokens from the approved canvas.
 *
 * Three rules the whole UI obeys:
 *   1. Colour means urgency. Nothing else in the app is coloured.
 *   2. No badge, chip or pill unless a number must sit beside a word.
 *   3. Body text never below 14 px. Rows, not cards.
 */
export const C = {
  paper: '#FAF9F7',
  card: '#FFFFFF',
  line: '#E6E3DE',
  lineSoft: '#F0EEEA',
  ink: '#1A1917',
  soft: '#6B6862',
  faint: '#9C978E',
  hairline: '#C7C2B9',
  action: '#16324F',
  now: '#D0342C',
  soon: '#C2820E',
  wait: '#2E7D4F',
  gone: '#33312D',
} as const;

/** Triage is protocol, not decoration — never hard-code these in a component. */
export const TRIAGE_COLOR: Record<number, string> = {
  0: C.now,
  1: C.soon,
  2: C.wait,
  3: C.gone,
  4: C.faint,
};

export const mono = Platform.select({ android: 'monospace', default: 'Menlo' });

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.paper },
  body: { padding: 22, paddingBottom: 40, gap: 18 },

  title: { fontSize: 26, fontWeight: '600', color: C.ink, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: C.faint },
  sectionLabel: { fontSize: 15, fontWeight: '500', color: C.ink },

  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rowText: { fontSize: 16, color: C.ink },
  meta: { fontSize: 14, color: C.soft },
  quiet: { fontSize: 13, color: C.faint, lineHeight: 19 },
  code: { fontSize: 12, color: C.faint, fontFamily: mono },

  divider: { height: 1, backgroundColor: C.lineSoft },
  bar: { width: 4, height: 42, borderRadius: 999 },
  dot: { width: 9, height: 9, borderRadius: 999 },

  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: C.lineSoft,
  },

  primary: {
    height: 60,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 17, fontWeight: '600', color: '#FFFFFF' },

  tile: {
    height: 74,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.line,
  },
  tileText: { fontSize: 15, fontWeight: '500', color: C.ink },

  panel: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },

  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: C.line,
    backgroundColor: C.paper,
    paddingTop: 10,
    paddingBottom: 22,
    paddingHorizontal: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 5 },
  tabLabel: { fontSize: 11, color: C.faint },
  tabLabelActive: { fontSize: 11, color: C.ink, fontWeight: '500' },
});
