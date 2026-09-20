import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';

export const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions');

export interface SessionFile {
  file: string;
  /** The per-cwd directory name pi files the session under. */
  project: string;
  bytes: number;
}

export interface LoadedSession extends SessionFile {
  id: string;
  /**
   * The leaf-to-root path before the first real compaction. Compaction never
   * deletes entries, so this is the raw history the agent actually saw, with
   * no earlier summary having shaped its behaviour.
   */
  clean: SessionEntry[];
}

export function listSessionFiles(dir: string = SESSIONS_DIR): SessionFile[] {
  const files: SessionFile[] = [];
  for (const project of readdirSync(dir)) {
    const projectDir = join(dir, project);
    let names: string[];
    try {
      names = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(projectDir, name);
      files.push({ file, project, bytes: statSync(file).size });
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

/** Follows `parentId` from the newest entry back to the root. */
function mainPath(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let cursor: SessionEntry | undefined = entries[entries.length - 1];
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path.reverse();
}

export function loadSession(source: SessionFile): LoadedSession | undefined {
  const parsed = parseSessionEntries(readFileSync(source.file, 'utf8'));
  migrateSessionEntries(parsed);
  const header = parsed.find(entry => entry.type === 'session');
  const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== 'session');
  if (entries.length === 0) return undefined;
  const path = mainPath(entries);
  const firstCompaction = path.findIndex(entry => entry.type === 'compaction');
  return {
    ...source,
    id: header?.type === 'session' ? header.id : basename(source.file, '.jsonl'),
    clean: firstCompaction < 0 ? path : path.slice(0, firstCompaction),
  };
}
