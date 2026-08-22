/**
 * Local persistence.
 *
 * A disaster tool that forgets everything when the app is killed is not a
 * disaster tool. Phones get dropped, batteries die, Android kills backgrounded
 * apps aggressively — and a report that only exists in RAM dies with it.
 *
 * Three things survive a restart:
 *   - the node id, so a phone stays the same device to its neighbours
 *   - incidents, so the store is not rebuilt from scratch every launch
 *   - the outbox, so an undelivered report keeps trying
 *
 * Every function swallows its own errors and degrades to in-memory behaviour.
 * Storage failing must never stop the radio.
 */

import * as SQLite from 'expo-sqlite';
import type { Incident } from '../types';
import type { OutboxEntry } from '../core/outbox';
import { decodePacket, encodePacket } from '../proto/codec';
import { toBase64, fromBase64 } from './base64';

let db: SQLite.SQLiteDatabase | null = null;
let ready = false;

export async function initStorage(): Promise<boolean> {
  if (ready) return true;
  try {
    db = await SQLite.openDatabaseAsync('patrol.db');
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incidents (
        packetId     INTEGER PRIMARY KEY NOT NULL,
        lat          REAL    NOT NULL,
        lon          REAL    NOT NULL,
        category     INTEGER NOT NULL,
        triage       INTEGER NOT NULL,
        casualties   INTEGER NOT NULL,
        status       INTEGER NOT NULL,
        lamport      INTEGER NOT NULL,
        descPreset   INTEGER NOT NULL,
        originNodeId INTEGER NOT NULL,
        firstSeen    INTEGER NOT NULL,
        lastSeen     INTEGER NOT NULL,
        hops         INTEGER NOT NULL,
        reportCount  INTEGER NOT NULL,
        mine         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_lastSeen ON incidents(lastSeen);
      CREATE TABLE IF NOT EXISTS outbox (
        packetId    INTEGER PRIMARY KEY NOT NULL,
        packet      TEXT    NOT NULL,
        createdAt   INTEGER NOT NULL,
        echoes      INTEGER NOT NULL,
        firstEchoAt INTEGER,
        state       TEXT    NOT NULL
      );
    `);
    ready = true;
    return true;
  } catch {
    db = null;
    ready = false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

export async function loadNodeId(): Promise<number | null> {
  if (!db) return null;
  try {
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      'nodeId'
    );
    const n = row ? Number(row.value) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 254 ? n : null;
  } catch {
    return null;
  }
}

export async function saveNodeId(nodeId: number): Promise<void> {
  if (!db) return;
  try {
    await db.runAsync(
      'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)',
      'nodeId',
      String(nodeId)
    );
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export async function loadIncidents(): Promise<Incident[]> {
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<Record<string, number>>(
      'SELECT * FROM incidents ORDER BY lastSeen DESC LIMIT 2000'
    );
    return rows.map((r) => ({
      packetId: r.packetId,
      lat: r.lat,
      lon: r.lon,
      category: r.category,
      triage: r.triage,
      casualties: r.casualties,
      status: r.status,
      lamport: r.lamport,
      descPreset: r.descPreset,
      originNodeId: r.originNodeId,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      hops: r.hops,
      reportCount: r.reportCount,
      mine: r.mine === 1,
    })) as Incident[];
  } catch {
    return [];
  }
}

export async function saveIncidents(incidents: Incident[]): Promise<void> {
  if (!db || incidents.length === 0) return;
  try {
    await db.withTransactionAsync(async () => {
      for (const i of incidents) {
        await db!.runAsync(
          `INSERT OR REPLACE INTO incidents
           (packetId, lat, lon, category, triage, casualties, status, lamport,
            descPreset, originNodeId, firstSeen, lastSeen, hops, reportCount, mine)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          i.packetId,
          i.lat,
          i.lon,
          i.category,
          i.triage,
          i.casualties,
          i.status,
          i.lamport,
          i.descPreset,
          i.originNodeId,
          i.firstSeen,
          i.lastSeen,
          i.hops,
          i.reportCount,
          i.mine ? 1 : 0
        );
      }
    });
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export async function loadOutbox(): Promise<OutboxEntry[]> {
  if (!db) return [];
  try {
    const rows = await db.getAllAsync<{
      packetId: number;
      packet: string;
      createdAt: number;
      echoes: number;
      firstEchoAt: number | null;
      state: string;
    }>('SELECT * FROM outbox ORDER BY createdAt DESC LIMIT 200');

    const out: OutboxEntry[] = [];
    for (const r of rows) {
      const packet = decodePacket(fromBase64(r.packet));
      if (!packet) continue;
      out.push({
        packetId: r.packetId,
        packet,
        createdAt: r.createdAt,
        echoes: r.echoes,
        firstEchoAt: r.firstEchoAt,
        lastBroadcastAt: r.createdAt,
        state: r.state as OutboxEntry['state'],
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveOutbox(entries: OutboxEntry[]): Promise<void> {
  if (!db || entries.length === 0) return;
  try {
    await db.withTransactionAsync(async () => {
      for (const e of entries) {
        await db!.runAsync(
          `INSERT OR REPLACE INTO outbox
           (packetId, packet, createdAt, echoes, firstEchoAt, state)
           VALUES (?,?,?,?,?,?)`,
          e.packetId,
          toBase64(encodePacket(e.packet)),
          e.createdAt,
          e.echoes,
          e.firstEchoAt,
          e.state
        );
      }
    });
  } catch {
    /* non-fatal */
  }
}

/** Wipe everything. Used by the reset control in Diagnostics. */
export async function clearAll(): Promise<void> {
  if (!db) return;
  try {
    await db.execAsync('DELETE FROM incidents; DELETE FROM outbox;');
  } catch {
    /* non-fatal */
  }
}

export function isStorageReady(): boolean {
  return ready;
}
