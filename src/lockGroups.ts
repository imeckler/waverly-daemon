import * as fs from 'fs';
import { ZWaveNode } from 'zwave-js';
import { LockServerInfo } from '@waverly/sauna-protocol';
import { LockManager } from './lockManager';
import { BookingWebSocketClient } from './bookingWebSocketClient';
import { registerLock, unregisterLock } from './lockRegistry';

// ---------------------------------------------------------------------------
// The lock servers the daemon serves, and which lock nodes belong to each.
//
// config.json names the nodes at build time, but a lock that is re-paired
// gets a new node id, and config.json is baked into the image. The mapping
// the daemon actually runs with is config.json plus an overrides file in the
// one writable directory it has (the Z-Wave cache), which assisted pairing
// maintains. Groups are registered here as they come up so a lock can be
// adopted or retired at runtime without a restart.
// ---------------------------------------------------------------------------

export interface LockServerConfig {
  serverUrl: string;
  lockNodeIds: number[];
  description?: string;
}

export const LOCK_NODES_FILE = './zwave-cache/lock-nodes.json';

interface LockNodeOverrides {
  /** serverUrl -> the node ids that server's locks currently have */
  overrides: Record<string, number[]>;
  updatedAt: string;
}

/** Replace each server's node list with the saved one, where a saved one exists. */
export function applyLockNodeOverrides(servers: LockServerConfig[], file: string = LOCK_NODES_FILE): LockServerConfig[] {
  let saved: LockNodeOverrides | null = null;
  try {
    if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as LockNodeOverrides;
  } catch (e) {
    console.error(`Could not read lock node overrides from ${file}; using config.json as is:`, e);
  }
  if (!saved?.overrides) return servers;
  return servers.map(server => {
    const ids = saved!.overrides[server.serverUrl];
    if (!Array.isArray(ids)) return server;
    console.log(`Lock nodes for ${server.serverUrl}: ${ids.join(', ')} (from ${file}, saved ${saved!.updatedAt})`);
    return { ...server, lockNodeIds: ids };
  });
}

export interface LockGroup {
  serverUrl: string;
  description: string | null;
  managers: LockManager[];
  wsClient: Pick<BookingWebSocketClient, 'reconnect'>;
}

const groups = new Map<string, LockGroup>();
let overridesFile = LOCK_NODES_FILE;

/** Tests point this at a scratch file. */
export function setOverridesFile(path: string): void {
  overridesFile = path;
}

export function registerLockGroup(group: LockGroup): void {
  groups.set(group.serverUrl, group);
}

export function lockGroups(): LockGroup[] {
  return [...groups.values()];
}

export function allLockManagers(): LockManager[] {
  return lockGroups().flatMap(g => g.managers);
}

export function listLockServers(): LockServerInfo[] {
  return lockGroups().map(g => ({
    serverUrl: g.serverUrl,
    description: g.description,
    lockNodeIds: g.managers.map(m => m.lock.id),
  }));
}

function saveOverrides(): void {
  const overrides: Record<string, number[]> = {};
  for (const g of lockGroups()) overrides[g.serverUrl] = g.managers.map(m => m.lock.id);
  const data: LockNodeOverrides = { overrides, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(overridesFile, JSON.stringify(data, null, 2) + '\n');
    console.log(`Saved lock node mapping to ${overridesFile}: ${JSON.stringify(overrides)}`);
  } catch (e) {
    console.error(`Could not save lock node mapping to ${overridesFile}:`, e);
  }
}

/**
 * Drop a lock from whichever server it belongs to: its timers stop, it leaves
 * the admin registry, and the mapping is saved. Returns whether it was managed.
 */
export function retireLock(nodeId: number): boolean {
  let found = false;
  for (const g of lockGroups()) {
    const i = g.managers.findIndex(m => m.lock.id === nodeId);
    if (i === -1) continue;
    found = true;
    const [m] = g.managers.splice(i, 1);
    m.retire();
    console.log(`Lock ${nodeId} retired from ${g.serverUrl}`);
  }
  unregisterLock(nodeId);
  if (found) saveOverrides();
  return found;
}

/**
 * Take a freshly included lock on for a server. If it replaces another lock
 * that is still managed, that one is retired first. The server's booking
 * socket is reconnected so the server resends every live access grant, which
 * is how the new lock learns the codes it should hold.
 */
export function adoptLock(serverUrl: string, node: ZWaveNode, replacesNodeId: number | null): LockManager {
  const g = groups.get(serverUrl);
  if (!g) throw new Error(`No lock server ${serverUrl}`);
  if (replacesNodeId !== null && replacesNodeId !== node.id) retireLock(replacesNodeId);
  if (g.managers.some(m => m.lock.id === node.id)) {
    throw new Error(`Lock ${node.id} is already managed for ${serverUrl}`);
  }
  registerLock(node);
  const manager = new LockManager(node);
  g.managers.push(manager);
  console.log(`Lock ${node.id} adopted for ${serverUrl}; reconnecting to reload its access grants`);
  saveOverrides();
  g.wsClient.reconnect();
  return manager;
}

/** Tests: forget every group. */
export function resetLockGroups(): void {
  groups.clear();
}
