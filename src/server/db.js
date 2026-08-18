const { neon } = require('@neondatabase/serverless');
const logger = require('./logger');

const NEON_URL = process.env.NEON_DATABASE_URL;
const sql = NEON_URL ? neon(NEON_URL) : null;

async function initDatabase() {
  if (!sql) {
    logger.warn('NEON_DATABASE_URL is not set; ownership history and admin analytics are disabled.');
    return;
  }
  try {
    await Promise.all([
      sql`
        CREATE TABLE IF NOT EXISTS ownership_snapshots (
          id SERIAL PRIMARY KEY,
          timestamp BIGINT NOT NULL,
          players JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => sql`CREATE INDEX IF NOT EXISTS idx_ownership_timestamp ON ownership_snapshots(timestamp)`),

      sql`
        CREATE TABLE IF NOT EXISTS admin_page_views (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(64) NOT NULL,
          path VARCHAR(512) NOT NULL,
          referrer VARCHAR(1024),
          ip_hash VARCHAR(128),
          country VARCHAR(8),
          city VARCHAR(128),
          continent VARCHAR(32),
          device_type VARCHAR(16),
          browser VARCHAR(64),
          os VARCHAR(64),
          os_version VARCHAR(64),
          status_code INT,
          response_time_ms INT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => Promise.all([
        sql`CREATE INDEX IF NOT EXISTS idx_pv_created ON admin_page_views(created_at)`,
        sql`CREATE INDEX IF NOT EXISTS idx_pv_session ON admin_page_views(session_id)`,
        sql`CREATE INDEX IF NOT EXISTS idx_pv_country ON admin_page_views(country)`
      ])),

      sql`
        CREATE TABLE IF NOT EXISTS admin_visitor_sessions (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(64) UNIQUE NOT NULL,
          ip_hash VARCHAR(128),
          country VARCHAR(8),
          city VARCHAR(128),
          continent VARCHAR(32),
          device_type VARCHAR(16),
          browser VARCHAR(64),
          os VARCHAR(64),
          os_version VARCHAR(64),
          first_page VARCHAR(512),
          last_page VARCHAR(512),
          page_count INT DEFAULT 1,
          is_returning BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          last_active_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => Promise.all([
        sql`CREATE INDEX IF NOT EXISTS idx_vs_created ON admin_visitor_sessions(created_at)`,
        sql`CREATE INDEX IF NOT EXISTS idx_vs_country ON admin_visitor_sessions(country)`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS last_referrer VARCHAR(1024)`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR(64)`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS visit_count INT DEFAULT 1`,
        sql`ALTER TABLE admin_visitor_sessions ADD COLUMN IF NOT EXISTS unique_visit_days INT DEFAULT 1`
      ])),

      sql`
        CREATE TABLE IF NOT EXISTS admin_daily_stats (
          id SERIAL PRIMARY KEY,
          date DATE UNIQUE NOT NULL,
          unique_visitors INT DEFAULT 0,
          page_views INT DEFAULT 0,
          top_country VARCHAR(8),
          top_page VARCHAR(512),
          avg_response_time_ms INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.then(() => sql`CREATE INDEX IF NOT EXISTS idx_ds_date ON admin_daily_stats(date)`),

      sql`
        CREATE TABLE IF NOT EXISTS ownership_snapshot_lock (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE,
          last_timestamp BIGINT NOT NULL
        )
      `.then(() => sql`INSERT INTO ownership_snapshot_lock (id, last_timestamp) VALUES (TRUE, 0) ON CONFLICT (id) DO NOTHING`),

      sql`
        CREATE TABLE IF NOT EXISTS ai_team (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(64) NOT NULL,
          squad JSONB NOT NULL,
          lineup JSONB NOT NULL,
          formation VARCHAR(10) NOT NULL,
          team_cost NUMERIC(5,1) NOT NULL,
          team_xpts NUMERIC(7,1) NOT NULL,
          strategy VARCHAR(20) NOT NULL DEFAULT 'balanced',
          budget NUMERIC(5,1) NOT NULL DEFAULT 100,
          horizon INT NOT NULL DEFAULT 5,
          is_locked BOOLEAN DEFAULT FALSE,
          locked_at TIMESTAMP,
          transfers JSONB NOT NULL DEFAULT '{"plan":[]}'::jsonb,
          chips JSONB NOT NULL DEFAULT '{"schedule":[]}'::jsonb,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `.then(async () => {
        await sql`ALTER TABLE ai_team ADD COLUMN IF NOT EXISTS transfers JSONB NOT NULL DEFAULT '{"plan":[]}'::jsonb`;
        await sql`ALTER TABLE ai_team ADD COLUMN IF NOT EXISTS chips JSONB NOT NULL DEFAULT '{"schedule":[]}'::jsonb`;
        await sql`DELETE FROM ai_team older USING ai_team newer WHERE older.session_id = newer.session_id AND older.id < newer.id`;
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_aiteam_session_unique ON ai_team(session_id)`;
      })
    ]);

    logger.info('Database initialized successfully');
  } catch (e) {
    logger.error({ err: e }, 'Database init error');
  }
}

module.exports = { sql, initDatabase };
