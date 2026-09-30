import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { Buffer } from "node:buffer";
import pg from "pg";
import * as schema from "./schema";

export interface ProjectRecord {
  id: string;
  name: string;
  script: string;
  musicVolume: number;
  narrationVolume: number;
  duckOnly: boolean;
  showCaptions: boolean;
  maxChars: number;
  preset: string;
  fps: number;
  kenBurns: boolean;
  thumbTitle: string;
  thumbSubtitle: string;
  accent: string;
  thumbIndex: number;
  imagesJson: string;
  narrationJson: string | null;
  musicJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSummary = Pick<ProjectRecord, "id" | "name" | "createdAt" | "updatedAt"> & {
  imageCount: number;
  hasNarration: boolean;
  durationSeconds?: number;
};

const SQLITE_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id               TEXT PRIMARY KEY,
    name             TEXT    NOT NULL DEFAULT 'Projeto sem título',
    script           TEXT    NOT NULL DEFAULT '',
    music_volume     INTEGER NOT NULL DEFAULT 12,
    narration_volume INTEGER NOT NULL DEFAULT 100,
    duck_only        INTEGER NOT NULL DEFAULT 1,
    show_captions    INTEGER NOT NULL DEFAULT 1,
    max_chars        INTEGER NOT NULL DEFAULT 90,
    preset           TEXT    NOT NULL DEFAULT '1080p',
    fps              INTEGER NOT NULL DEFAULT 30,
    ken_burns        INTEGER NOT NULL DEFAULT 1,
    thumb_title      TEXT    NOT NULL DEFAULT '',
    thumb_subtitle   TEXT    NOT NULL DEFAULT '',
    accent           TEXT    NOT NULL DEFAULT '#ff7a29',
    thumb_index      INTEGER NOT NULL DEFAULT 0,
    images_json      TEXT    NOT NULL DEFAULT '[]',
    narration_json   TEXT,
    music_json       TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_assets (
    id          TEXT PRIMARY KEY,
    project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type        TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    file_path   TEXT    NOT NULL DEFAULT '',
    mime_type   TEXT    NOT NULL DEFAULT 'application/octet-stream',
    data        BLOB,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`;

const PG_DDL = `
  CREATE TABLE IF NOT EXISTS projects (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT 'Projeto sem título',
    script           TEXT NOT NULL DEFAULT '',
    music_volume     INTEGER NOT NULL DEFAULT 12,
    narration_volume INTEGER NOT NULL DEFAULT 100,
    duck_only        BOOLEAN NOT NULL DEFAULT TRUE,
    show_captions    BOOLEAN NOT NULL DEFAULT TRUE,
    max_chars        INTEGER NOT NULL DEFAULT 90,
    preset           TEXT NOT NULL DEFAULT '1080p',
    fps              INTEGER NOT NULL DEFAULT 30,
    ken_burns        BOOLEAN NOT NULL DEFAULT TRUE,
    thumb_title      TEXT NOT NULL DEFAULT '',
    thumb_subtitle   TEXT NOT NULL DEFAULT '',
    accent           TEXT NOT NULL DEFAULT '#ff7a29',
    thumb_index      INTEGER NOT NULL DEFAULT 0,
    images_json      TEXT NOT NULL DEFAULT '[]',
    narration_json   TEXT,
    music_json       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS project_assets (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    file_path   TEXT NOT NULL DEFAULT '',
    mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
    data        BYTEA,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  ALTER TABLE project_assets
    ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
  ALTER TABLE project_assets
    ADD COLUMN IF NOT EXISTS data BYTEA;
`;

let _sqliteDb: BetterSQLite3Database<typeof schema> | null = null;
let _pgPool: pg.Pool | null = null;
let _tablesInitialized = false;

export function getDatabaseType(): "sqlite" | "postgres" {
  const url = process.env["DATABASE_URL"] || "";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  }
  return "sqlite";
}

function getSqliteInstance() {
  const dataDir = join(process.cwd(), "data");
  const uploadsDir = join(dataDir, "uploads");

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const sqlite = new Database(join(dataDir, "studio.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

export function getDb() {
  if (getDatabaseType() === "postgres") {
    if (!_pgPool) {
      _pgPool = new pg.Pool({
        connectionString: process.env["DATABASE_URL"],
      });
    }
    return _pgPool;
  }

  if (!_sqliteDb) {
    const sqlite = getSqliteInstance();
    _sqliteDb = drizzle(sqlite, { schema });
  }
  return _sqliteDb;
}

export async function ensureTables() {
  if (_tablesInitialized) return;

  if (getDatabaseType() === "postgres") {
    const pool = getDb() as unknown as pg.Pool;
    await pool.query(PG_DDL);
  } else {
    const sqlite = getSqliteInstance();
    sqlite.exec(SQLITE_DDL);
    const assetColumns = sqlite.prepare("PRAGMA table_info(project_assets)").all() as Array<{
      name: string;
    }>;
    if (!assetColumns.some((column) => column.name === "mime_type")) {
      sqlite.exec(
        "ALTER TABLE project_assets ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/octet-stream'",
      );
    }
    if (!assetColumns.some((column) => column.name === "data")) {
      sqlite.exec("ALTER TABLE project_assets ADD COLUMN data BLOB");
    }
  }

  _tablesInitialized = true;
}

interface PersistedAsset {
  id: string;
  type: "image" | "narration" | "music";
  name: string;
  mimeType: string;
  data: Buffer;
  sortOrder: number;
}

function dataUrlToAsset(
  projectId: string,
  type: PersistedAsset["type"],
  name: string,
  dataUrl: string,
  sortOrder: number,
  sourceId?: string,
): PersistedAsset | null {
  const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(dataUrl);
  if (!match?.[2]) return null;
  return {
    id: [projectId, type, sourceId ?? sortOrder].join(":"),
    type,
    name,
    mimeType: match[1] || "application/octet-stream",
    data: Buffer.from(match[2], "base64"),
    sortOrder,
  };
}

function collectProjectAssets(project: ProjectRecord): PersistedAsset[] {
  const assets: PersistedAsset[] = [];
  try {
    const images = JSON.parse(project.imagesJson || "[]") as Array<{
      id?: string;
      name?: string;
      dataUrl?: string;
    }>;
    images.forEach((image, index) => {
      if (!image.dataUrl) return;
      const asset = dataUrlToAsset(
        project.id,
        "image",
        image.name || "imagem-" + (index + 1),
        image.dataUrl,
        index,
        image.id,
      );
      if (asset) assets.push(asset);
    });
  } catch {
    // O JSON legado continua preservado no projeto.
  }

  for (const [type, raw] of [
    ["narration", project.narrationJson],
    ["music", project.musicJson],
  ] as const) {
    if (!raw) continue;
    try {
      const audio = JSON.parse(raw) as { name?: string; dataUrl?: string };
      if (!audio.dataUrl) continue;
      const asset = dataUrlToAsset(project.id, type, audio.name || type, audio.dataUrl, 0, type);
      if (asset) assets.push(asset);
    } catch {
      // O JSON legado continua preservado no projeto.
    }
  }
  return assets;
}

async function syncProjectAssets(project: ProjectRecord) {
  const assets = collectProjectAssets(project);

  if (getDatabaseType() === "postgres") {
    const pool = getDb() as unknown as pg.Pool;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM project_assets WHERE project_id = $1", [project.id]);
      for (const asset of assets) {
        await client.query(
          "INSERT INTO project_assets (id, project_id, type, name, file_path, mime_type, data, sort_order) VALUES ($1, $2, $3, $4, '', $5, $6, $7)",
          [
            asset.id,
            project.id,
            asset.type,
            asset.name,
            asset.mimeType,
            asset.data,
            asset.sortOrder,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const sqlite = getSqliteInstance();
  const replaceAssets = sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM project_assets WHERE project_id = ?").run(project.id);
    const insert = sqlite.prepare(
      "INSERT INTO project_assets (id, project_id, type, name, file_path, mime_type, data, sort_order) VALUES (?, ?, ?, ?, '', ?, ?, ?)",
    );
    for (const asset of assets) {
      insert.run(
        asset.id,
        project.id,
        asset.type,
        asset.name,
        asset.mimeType,
        asset.data,
        asset.sortOrder,
      );
    }
  });
  replaceAssets();
}

/* ── Métodos de Acesso a Dados (CRUD) ── */

export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureTables();

  if (getDatabaseType() === "postgres") {
    const pool = getDb() as unknown as pg.Pool;
    const res = await pool.query(
      `SELECT id, name, created_at as "createdAt", updated_at as "updatedAt", images_json as "imagesJson", narration_json as "narrationJson" 
       FROM projects 
       ORDER BY updated_at DESC`,
    );
    return res.rows.map((row) => {
      let imageCount = 0;
      try {
        imageCount = JSON.parse(row.imagesJson || "[]").length;
      } catch {
        // ignore
      }
      return {
        id: row.id,
        name: row.name,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
        imageCount,
        hasNarration: !!row.narrationJson,
      };
    });
  }

  const sqlite = getSqliteInstance();
  const rows = sqlite
    .prepare(
      `SELECT id, name, created_at as createdAt, updated_at as updatedAt, images_json as imagesJson, narration_json as narrationJson 
       FROM projects 
       ORDER BY updated_at DESC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    imagesJson: string;
    narrationJson: string | null;
  }>;

  return rows.map((row) => {
    let imageCount = 0;
    try {
      imageCount = JSON.parse(row.imagesJson || "[]").length;
    } catch {
      // ignore
    }
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      imageCount,
      hasNarration: !!row.narrationJson,
    };
  });
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  await ensureTables();

  if (getDatabaseType() === "postgres") {
    const pool = getDb() as unknown as pg.Pool;
    const res = await pool.query(
      `SELECT 
        id, name, script, 
        music_volume as "musicVolume", 
        narration_volume as "narrationVolume", 
        duck_only as "duckOnly", 
        show_captions as "showCaptions", 
        max_chars as "maxChars", 
        preset, fps, 
        ken_burns as "kenBurns", 
        thumb_title as "thumbTitle", 
        thumb_subtitle as "thumbSubtitle", 
        accent, 
        thumb_index as "thumbIndex", 
        images_json as "imagesJson", 
        narration_json as "narrationJson", 
        music_json as "musicJson", 
        created_at as "createdAt", 
        updated_at as "updatedAt"
       FROM projects WHERE id = $1`,
      [id],
    );
    if (!res.rows[0]) return null;
    return res.rows[0] as ProjectRecord;
  }

  const sqlite = getSqliteInstance();
  const row = sqlite
    .prepare(
      `SELECT 
        id, name, script, 
        music_volume as musicVolume, 
        narration_volume as narrationVolume, 
        duck_only as duckOnly, 
        show_captions as showCaptions, 
        max_chars as maxChars, 
        preset, fps, 
        ken_burns as kenBurns, 
        thumb_title as thumbTitle, 
        thumb_subtitle as thumbSubtitle, 
        accent, 
        thumb_index as thumbIndex, 
        images_json as imagesJson, 
        narration_json as narrationJson, 
        music_json as musicJson, 
        created_at as createdAt, 
        updated_at as updatedAt
       FROM projects WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    ...(row as unknown as ProjectRecord),
    duckOnly: Boolean(row["duckOnly"]),
    showCaptions: Boolean(row["showCaptions"]),
    kenBurns: Boolean(row["kenBurns"]),
  };
}

export async function saveProject(
  data: Partial<ProjectRecord> & { id: string },
): Promise<ProjectRecord> {
  await ensureTables();

  const current = (await getProject(data.id)) || {
    id: data.id,
    name: "Projeto sem título",
    script: "",
    musicVolume: 12,
    narrationVolume: 100,
    duckOnly: true,
    showCaptions: true,
    maxChars: 90,
    preset: "1080p",
    fps: 30,
    kenBurns: true,
    thumbTitle: "",
    thumbSubtitle: "",
    accent: "#ff7a29",
    thumbIndex: 0,
    imagesJson: "[]",
    narrationJson: null,
    musicJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const updated: ProjectRecord = {
    ...current,
    ...data,
    updatedAt: new Date().toISOString(),
  };

  if (getDatabaseType() === "postgres") {
    const pool = getDb() as unknown as pg.Pool;
    await pool.query(
      `INSERT INTO projects (
        id, name, script, music_volume, narration_volume, duck_only, show_captions,
        max_chars, preset, fps, ken_burns, thumb_title, thumb_subtitle, accent,
        thumb_index, images_json, narration_json, music_json, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        script = EXCLUDED.script,
        music_volume = EXCLUDED.music_volume,
        narration_volume = EXCLUDED.narration_volume,
        duck_only = EXCLUDED.duck_only,
        show_captions = EXCLUDED.show_captions,
        max_chars = EXCLUDED.max_chars,
        preset = EXCLUDED.preset,
        fps = EXCLUDED.fps,
        ken_burns = EXCLUDED.ken_burns,
        thumb_title = EXCLUDED.thumb_title,
        thumb_subtitle = EXCLUDED.thumb_subtitle,
        accent = EXCLUDED.accent,
        thumb_index = EXCLUDED.thumb_index,
        images_json = EXCLUDED.images_json,
        narration_json = EXCLUDED.narration_json,
        music_json = EXCLUDED.music_json,
        updated_at = NOW()`,
      [
        updated.id,
        updated.name,
        updated.script,
        updated.musicVolume,
        updated.narrationVolume,
        updated.duckOnly,
        updated.showCaptions,
        updated.maxChars,
        updated.preset,
        updated.fps,
        updated.kenBurns,
        updated.thumbTitle,
        updated.thumbSubtitle,
        updated.accent,
        updated.thumbIndex,
        updated.imagesJson,
        updated.narrationJson,
        updated.musicJson,
      ],
    );
  } else {
    const sqlite = getSqliteInstance();
    sqlite
      .prepare(
        `INSERT INTO projects (
          id, name, script, music_volume, narration_volume, duck_only, show_captions,
          max_chars, preset, fps, ken_burns, thumb_title, thumb_subtitle, accent,
          thumb_index, images_json, narration_json, music_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          script = excluded.script,
          music_volume = excluded.music_volume,
          narration_volume = excluded.narration_volume,
          duck_only = excluded.duck_only,
          show_captions = excluded.show_captions,
          max_chars = excluded.max_chars,
          preset = excluded.preset,
          fps = excluded.fps,
          ken_burns = excluded.ken_burns,
          thumb_title = excluded.thumb_title,
          thumb_subtitle = excluded.thumb_subtitle,
          accent = excluded.accent,
          thumb_index = excluded.thumb_index,
          images_json = excluded.images_json,
          narration_json = excluded.narration_json,
          music_json = excluded.music_json,
          updated_at = datetime('now')`,
      )
      .run(
        updated.id,
        updated.name,
        updated.script,
        updated.musicVolume,
        updated.narrationVolume,
        updated.duckOnly ? 1 : 0,
        updated.showCaptions ? 1 : 0,
        updated.maxChars,
        updated.preset,
        updated.fps,
        updated.kenBurns ? 1 : 0,
        updated.thumbTitle,
        updated.thumbSubtitle,
        updated.accent,
        updated.thumbIndex,
        updated.imagesJson,
        updated.narrationJson,
        updated.musicJson,
      );
  }

  await syncProjectAssets(updated);
  return updated;
}

export async function deleteProject(id: string): Promise<boolean> {
  await ensureTables();

  if (getDatabaseType() === "postgres") {
    const pool = getDb() as unknown as pg.Pool;
    const res = await pool.query(`DELETE FROM projects WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  const sqlite = getSqliteInstance();
  const res = sqlite.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  return res.changes > 0;
}
