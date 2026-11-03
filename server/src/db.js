import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

// status: missing | processing | ready | warning | error
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT,
      place TEXT,
      admin_token TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      player_token TEXT UNIQUE NOT NULL,
      player_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS talks (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      starts_at TEXT,
      duration_min INTEGER NOT NULL DEFAULT 20,
      title TEXT NOT NULL,
      speaker TEXT,
      speaker_token TEXT UNIQUE NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      file_name TEXT,
      file_ext TEXT,
      file_size INTEGER,
      has_pdf INTEGER NOT NULL DEFAULT 0,
      page_count INTEGER,
      notes TEXT,
      issues TEXT,
      status TEXT NOT NULL DEFAULT 'missing',
      uploaded_at TEXT
    );
    -- audience questions (Q&A), one list per talk/panel
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY,
      talk_id INTEGER NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      author TEXT,
      text TEXT NOT NULL,
      votes INTEGER NOT NULL DEFAULT 0,
      answered_at TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS question_votes (
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      voter TEXT NOT NULL,
      PRIMARY KEY (question_id, voter)
    );
    -- partner loop: photos and videos shown during breaks and between talks
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE, -- NULL = all rooms
      kind TEXT NOT NULL,                                      -- image | video
      file_name TEXT,
      file_ext TEXT NOT NULL,
      file_size INTEGER,
      duration_sec INTEGER NOT NULL DEFAULT 8,                 -- images only
      position INTEGER NOT NULL DEFAULT 0
    );
  `);
  // kind: talk | break
  const cols = db.prepare("PRAGMA table_info(talks)").all().map(c => c.name);
  if (!cols.includes("kind")) db.exec("ALTER TABLE talks ADD COLUMN kind TEXT NOT NULL DEFAULT 'talk'");
  // presentation imported from a link (Google Slides); kept so it can be re-imported
  if (!cols.includes("source_url")) db.exec("ALTER TABLE talks ADD COLUMN source_url TEXT");
  if (!cols.includes("uploaded_by")) db.exec("ALTER TABLE talks ADD COLUMN uploaded_by TEXT");
  // organizer looked at the warnings and said "fine" (reset by a new upload)
  if (!cols.includes("reviewed_at")) db.exec("ALTER TABLE talks ADD COLUMN reviewed_at TEXT");
  // panels (kind = 'panel'): moderator + panelists, optional background image/video
  if (!cols.includes("moderator")) db.exec("ALTER TABLE talks ADD COLUMN moderator TEXT");
  if (!cols.includes("panelists")) db.exec("ALTER TABLE talks ADD COLUMN panelists TEXT");
  if (!cols.includes("bg_ext")) db.exec("ALTER TABLE talks ADD COLUMN bg_ext TEXT");
  // videos on slides (JSON): position, start, embedded file / online link / missing (see analyze.js)
  if (!cols.includes("videos")) db.exec("ALTER TABLE talks ADD COLUMN videos TEXT");
  if (!cols.includes("notes_manual")) db.exec("ALTER TABLE talks ADD COLUMN notes_manual INTEGER NOT NULL DEFAULT 0");
  // Q&A: public token for the audience page, can be switched off per talk
  if (!cols.includes("qa_token")) db.exec("ALTER TABLE talks ADD COLUMN qa_token TEXT");
  if (!cols.includes("qa_enabled")) db.exec("ALTER TABLE talks ADD COLUMN qa_enabled INTEGER NOT NULL DEFAULT 1");
  for (const r of db.prepare("SELECT id FROM talks WHERE qa_token IS NULL").all()) {
    db.prepare("UPDATE talks SET qa_token = ? WHERE id = ?").run(crypto.randomBytes(9).toString("base64url"), r.id);
  }
  // mode: single (one room, simplified UI) | multi
  const ecols = db.prepare("PRAGMA table_info(events)").all().map(c => c.name);
  if (!ecols.includes("mode")) db.exec("ALTER TABLE events ADD COLUMN mode TEXT NOT NULL DEFAULT 'multi'");
  // billing (hosted version only): trial → ordered (active, invoice sent) → paid
  for (const [col, def] of [["billing_status", "TEXT NOT NULL DEFAULT 'trial'"], ["billing", "TEXT"], ["invoice_id", "INTEGER"],
    ["invoice_number", "TEXT"], ["invoice_url", "TEXT"], ["price", "INTEGER"], ["ordered_at", "TEXT"], ["paid_at", "TEXT"]]) {
    if (!ecols.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def}`);
  }
  // upload deadline for speakers; public page with shared slides after the event
  for (const [col, def] of [["deadline", "TEXT"], ["public_token", "TEXT"], ["public_enabled", "INTEGER NOT NULL DEFAULT 0"], ["sign_ext", "TEXT"]]) {
    if (!ecols.includes(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def}`);
  }
  for (const r of db.prepare("SELECT id FROM events WHERE public_token IS NULL").all()) {
    db.prepare("UPDATE events SET public_token = ? WHERE id = ?").run(crypto.randomBytes(9).toString("base64url"), r.id);
  }
  // speaker agrees to show their slides on the public page
  if (!cols.includes("share_slides")) db.exec("ALTER TABLE talks ADD COLUMN share_slides INTEGER NOT NULL DEFAULT 0");
  // phone as speaker monitor + clicker: one secret link per room
  const rcols = db.prepare("PRAGMA table_info(rooms)").all().map(c => c.name);
  if (!rcols.includes("remote_token")) db.exec("ALTER TABLE rooms ADD COLUMN remote_token TEXT");
  for (const r of db.prepare("SELECT id FROM rooms WHERE remote_token IS NULL").all()) {
    db.prepare("UPDATE rooms SET remote_token = ? WHERE id = ?").run(crypto.randomBytes(12).toString("base64url"), r.id);
  }
  // live polls: one question, either choices or free words (word cloud)
  db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY,
      talk_id INTEGER NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options TEXT,
      open INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      voter TEXT NOT NULL,
      answer TEXT NOT NULL,
      PRIMARY KEY (poll_id, voter)
    );`);
  // lookups by parent and by secret link stay fast with hundreds of events
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rooms_event ON rooms(event_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_remote ON rooms(remote_token);
    CREATE INDEX IF NOT EXISTS idx_talks_event ON talks(event_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_talks_room ON talks(room_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_talks_qa ON talks(qa_token);
    CREATE INDEX IF NOT EXISTS idx_events_public ON events(public_token);
    CREATE INDEX IF NOT EXISTS idx_questions_talk ON questions(talk_id);
    CREATE INDEX IF NOT EXISTS idx_polls_talk ON polls(talk_id);
    CREATE INDEX IF NOT EXISTS idx_media_event ON media(event_id);`);
  return db;
}
