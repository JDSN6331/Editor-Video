import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/* ── Projetos (SQLite) ── */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default("Projeto sem título"),
  script: text("script").notNull().default(""),
  musicVolume: integer("music_volume").notNull().default(12),
  narrationVolume: integer("narration_volume").notNull().default(100),
  duckOnly: integer("duck_only", { mode: "boolean" }).notNull().default(true),
  showCaptions: integer("show_captions", { mode: "boolean" }).notNull().default(true),
  maxChars: integer("max_chars").notNull().default(90),
  preset: text("preset").notNull().default("1080p"),
  fps: integer("fps").notNull().default(30),
  kenBurns: integer("ken_burns", { mode: "boolean" }).notNull().default(true),
  thumbTitle: text("thumb_title").notNull().default(""),
  thumbSubtitle: text("thumb_subtitle").notNull().default(""),
  accent: text("accent").notNull().default("#ff7a29"),
  thumbIndex: integer("thumb_index").notNull().default(0),
  imagesJson: text("images_json").notNull().default("[]"),
  narrationJson: text("narration_json"),
  musicJson: text("music_json"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* ── Assets (imagens, narração, música) ── */
export const projectAssets = sqliteTable("project_assets", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'image' | 'narration' | 'music'
  name: text("name").notNull(),
  filePath: text("file_path").notNull().default(""),
  mimeType: text("mime_type").notNull().default("application/octet-stream"),
  data: blob("data", { mode: "buffer" }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/* ── Tipos inferidos ── */
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectAsset = typeof projectAssets.$inferSelect;
export type NewProjectAsset = typeof projectAssets.$inferInsert;
