/**
 * Canned descriptions. The 20-byte packet has no room for free text, so a
 * report carries a preset index instead.
 *
 * This is a feature, not only a constraint: tapping a chip is faster than
 * typing during an emergency, and a fixed vocabulary makes deduplication
 * deterministic instead of fuzzy string matching.
 *
 * Index must stay < 256. NEVER reorder or delete an entry once devices are in
 * the field — the index is the wire value.
 */

import { Category } from '../types';

export const DESC_PRESETS: readonly string[] = [
  'Unspecified', // 0
  // Medical 1-7
  'Trapped under debris',
  'Severe bleeding',
  'Unconscious',
  'Broken bones',
  'Burns',
  'Medication needed',
  'Difficulty breathing',
  // Water 8-11
  'No clean water',
  'Water supply contaminated',
  'Dehydration',
  'Need water containers',
  // Food 12-15
  'No food',
  'Infant formula needed',
  'Cooking fuel needed',
  'Food spoiled',
  // Shelter 16-19
  'Home destroyed',
  'Need shelter space',
  'No blankets',
  'Exposed to weather',
  // Evacuation / rescue 20-23
  'Rising water, cut off',
  'Cannot move without help',
  'Road blocked',
  'Need transport out',
  // Missing 24-26
  'Person missing',
  'Children separated',
  'Looking for family',
  // Fire 27-29
  'Building on fire',
  'Gas leak',
  'Smoke inhalation',
  // Structural 30-32
  'Building collapsed',
  'Structure unstable',
  'Power line down',
];

export const PRESETS_BY_CATEGORY: Record<number, number[]> = {
  [Category.MEDICAL]: [1, 2, 3, 4, 5, 6, 7],
  [Category.WATER]: [8, 9, 10, 11],
  [Category.FOOD]: [12, 13, 14, 15],
  [Category.SHELTER]: [16, 17, 18, 19],
  [Category.EVACUATION]: [20, 21, 22, 23],
  [Category.MISSING]: [24, 25, 26],
  [Category.FIRE]: [27, 28, 29],
  [Category.STRUCTURAL]: [30, 31, 32],
};

export function describe(preset: number): string {
  return DESC_PRESETS[preset] ?? DESC_PRESETS[0];
}

export const CATEGORY_LABEL: Record<number, string> = {
  [Category.MEDICAL]: 'Medical',
  [Category.WATER]: 'Water',
  [Category.FOOD]: 'Food',
  [Category.SHELTER]: 'Shelter',
  [Category.EVACUATION]: 'Rescue',
  [Category.MISSING]: 'Missing',
  [Category.FIRE]: 'Fire',
  [Category.STRUCTURAL]: 'Structural',
  [Category.RESOURCE_OFFER]: 'Supply offer',
  [Category.DISPATCH]: 'Dispatch',
  [Category.GOSSIP_DIGEST]: 'Digest',
};

/** Plain-language urgency, as agreed in the design pass. */
export const TRIAGE_LABEL: Record<number, string> = {
  0: 'Now',
  1: 'Soon',
  2: 'Can wait',
  3: 'Deceased',
  4: 'Unknown',
};

export const STATUS_LABEL: Record<number, string> = {
  0: 'Reported',
  1: 'Seen by base',
  2: 'On the way',
  3: 'Resolved',
};
