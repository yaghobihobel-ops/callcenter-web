/* lib/db.js — MariaDB pool + schema v3 */
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.CC_DB_HOST || "127.0.0.1",
  port: parseInt(process.env.CC_DB_PORT || "3306", 10),
  user: process.env.CC_DB_USER || "callcenter",
  password: process.env.CC_DB_PASS || "Cclt!2026#Rm8$zq",
  database: process.env.CC_DB_NAME || "callcenter",
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4_general_ci",
  timezone: "+03:30",
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  pass_hash VARCHAR(100) NOT NULL,
  name VARCHAR(120) NOT NULL,
  role ENUM('admin','operator') NOT NULL DEFAULT 'operator',
  sip_ext VARCHAR(10),
  active TINYINT DEFAULT 1,
  pause_reason VARCHAR(40) DEFAULT '',
  last_active DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS calls (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unique_id VARCHAR(64) UNIQUE,
  direction VARCHAR(10) DEFAULT 'inbound',
  visitor_name VARCHAR(120),
  visitor_phone VARCHAR(40),
  visitor_email VARCHAR(120),
  visitor_ip VARCHAR(45),
  visitor_id VARCHAR(64),
  page_url VARCHAR(500),
  user_agent VARCHAR(300),
  status ENUM('waiting','ringing','answered','missed','completed') DEFAULT 'waiting',
  disposition VARCHAR(40) DEFAULT '',
  started_at DATETIME,
  answered_at DATETIME,
  ended_at DATETIME,
  wait_sec INT DEFAULT 0,
  duration_sec INT DEFAULT 0,
  operator_ext VARCHAR(10),
  transferred_to VARCHAR(10) DEFAULT '',
  survey_rating TINYINT,
  recording_path VARCHAR(255),
  notes TEXT,
  INDEX idx_started (started_at),
  INDEX idx_status (status),
  INDEX idx_visitor (visitor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS call_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  call_id INT,
  event VARCHAR(40),
  payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_call (call_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS surveys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  unique_id VARCHAR(64),
  rating TINYINT,
  source VARCHAR(20) DEFAULT 'ivr',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_uid (unique_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS visitors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  visitor_id VARCHAR(64),
  ip VARCHAR(45),
  name VARCHAR(120),
  phone VARCHAR(40),
  email VARCHAR(120),
  page_url VARCHAR(500),
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vid (visitor_id),
  INDEX idx_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  skey VARCHAR(64) PRIMARY KEY,
  sval TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS callbacks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  call_id INT NULL,
  phone VARCHAR(40) NOT NULL,
  name VARCHAR(120) DEFAULT '',
  reason VARCHAR(255) DEFAULT '',
  status ENUM('new','assigned','done','failed') DEFAULT 'new',
  assigned_to VARCHAR(10) DEFAULT '',
  assigned_by VARCHAR(10) DEFAULT '',
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  done_at DATETIME NULL,
  INDEX idx_cbstatus (status),
  INDEX idx_cbphone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS chat_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel VARCHAR(60) NOT NULL,
  from_ext VARCHAR(10) DEFAULT '',
  from_name VARCHAR(120) DEFAULT '',
  kind VARCHAR(10) DEFAULT 'user',
  body VARCHAR(2000) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat (channel, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quality_samples (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ext VARCHAR(16) DEFAULT '',
  unique_id VARCHAR(64) DEFAULT '',
  side VARCHAR(10) DEFAULT 'agent',
  rtt_ms INT DEFAULT 0,
  jitter_ms INT DEFAULT 0,
  loss_pct FLOAT DEFAULT 0,
  mos FLOAT DEFAULT 0,
  detail VARCHAR(500) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qs (ext, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS op_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ext VARCHAR(10) DEFAULT '',
  kind VARCHAR(30) DEFAULT '',
  detail VARCHAR(500) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_oe (ext, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function initSchema() {
  const conn = await pool.getConnection();
  for (const stmt of SCHEMA.split(";")) {
    const s = stmt.trim();
    if (s) await conn.query(s);
  }
  /* guarded column additions (older installs) */
  const addCols = [
    ["calls", "disposition", "VARCHAR(40) DEFAULT ''"],
    ["calls", "transferred_to", "VARCHAR(10) DEFAULT ''"],
    ["users", "pause_reason", "VARCHAR(40) DEFAULT ''"],
    ["users", "last_active", "DATETIME NULL"],
  ];
  for (const [tbl, col, def] of addCols) {
    try {
      const [c] = await conn.query(
        `SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
        [tbl, col]);
      if (!c[0].n) await conn.query(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`);
    } catch (e) { console.error("[schema]", tbl + "." + col, e.message); }
  }
  conn.release();
}

async function q(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = { pool, q, initSchema };
