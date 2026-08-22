const NATO = [
  'ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT', 'GOLF', 'HOTEL',
  'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE', 'NOVEMBER', 'OSCAR', 'PAPA',
];

/**
 * u8 node id, 1..254 (0 and 255 stay reserved).
 *
 * Regenerated each launch for now — persisting it needs a storage dependency
 * and a rebuild, and the id is shown on screen so it stays easy to tell three
 * test phones apart.
 */
export function generateNodeId(): number {
  return 1 + Math.floor(Math.random() * 254);
}

export function callsign(nodeId: number): string {
  return `${NATO[nodeId % NATO.length]}-${nodeId}`;
}
