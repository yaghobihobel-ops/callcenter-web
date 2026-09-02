/* lib/db.js — MySQL pool + schema */
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
  started_at DATETIME,
  answered_at DATETIME,
  ended_at DATETIME,
  wait_sec INT DEFAULT 0,
  duration_sec INT DEFAULT 0,
  operator_ext VARCHAR(10),
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
`;

async function initSchema() {
  const conn = await pool.getConnection();
  for (const stmt of SCHEMA.split(";")) {
    const s = stmt.trim();
    if (s) await conn.query(s);
  }
  conn.release();
}

async function q(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

module.exports = { pool, q, initSchema };
