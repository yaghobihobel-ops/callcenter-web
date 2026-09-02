/* lib/remote.js — Remote DB connector (read-only) for CRM enrichment.
   Default driver: sqlite (firuzo.online Next.js/Prisma DB on this server).
   Also supports mysql. Config stored in settings table (JSON). */
const path = require("path");
const fs = require("fs");

let sqliteDb = null;
let mysqlPool = null;

function defaultConfig() {
  return {
    driver: "sqlite",
    sqlite_path: "/var/www/firuzo_onlin_usr/data/www/firuzo.online/prisma/dev.db",
    mysql: { host: "127.0.0.1", port: 3306, user: "", password: "", database: "" },
    enabled: true,
  };
}

async function getConfig() {
  const { q } = require("./db");
  const rows = await q("SELECT sval FROM settings WHERE skey='remote_db'");
  if (!rows.length) return defaultConfig();
  try { return JSON.parse(rows[0].sval); } catch { return defaultConfig(); }
}

async function saveConfig(cfg) {
  const { q } = require("./db");
  await q("INSERT INTO settings (skey,sval) VALUES ('remote_db',?) ON DUPLICATE KEY UPDATE sval=VALUES(sval)",
    [JSON.stringify(cfg)]);
  closeAll();
}

function closeAll() {
  if (sqliteDb) { try { sqliteDb.close(); } catch {} sqliteDb = null; }
  if (mysqlPool) { try { mysqlPool.end(); } catch {} mysqlPool = null; }
}

async function getSqlite(cfg) {
  if (sqliteDb) return sqliteDb;
  const Database = require("better-sqlite3");
  const p = cfg.sqlite_path;
  if (!p || !fs.existsSync(p)) throw new Error(`sqlite file not found: ${p}`);
  sqliteDb = new Database(p, { readonly: true, fileMustExist: true });
  return sqliteDb;
}

async function getMysql(cfg) {
  if (mysqlPool) return mysqlPool;
  const mysql = require("mysql2/promise");
  mysqlPool = mysql.createPool({ ...cfg.mysql, connectionLimit: 3 });
  return mysqlPool;
}

/* Lookup visitor by phone/email — returns {user, bookings, walletBalance} */
async function lookupCustomer({ phone, email, name }) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { enabled: false };
  try {
    let user = null, bookings = [], walletBalance = null;
    if (cfg.driver === "sqlite") {
      const db = await getSqlite(cfg);
      let row = null;
      if (email) row = db.prepare("SELECT id,email,phone,name,role,createdAt FROM User WHERE email=? LIMIT 1").get(email);
      if (!row && phone) row = db.prepare("SELECT id,email,phone,name,role,createdAt FROM User WHERE phone LIKE ? LIMIT 1").get("%" + String(phone).replace(/\D/g, "").slice(-10) + "%");
      if (row) {
        user = row;
        bookings = db.prepare("SELECT id,type,status,totalAmount,currency,createdAt,details FROM Booking WHERE userId=? ORDER BY createdAt DESC LIMIT 10").all(row.id);
        const w = db.prepare("SELECT balances FROM Wallet WHERE userId=? LIMIT 1").get(row.id);
        if (w) { try { walletBalance = JSON.parse(w.balances); } catch {} }
      } else if (phone) {
        // guests: bookings can't link w/o user — search details JSON for phone
        bookings = db.prepare("SELECT id,type,status,totalAmount,currency,createdAt,details FROM Booking ORDER BY createdAt DESC LIMIT 200").all()
          .filter(b => (b.details || "").includes(String(phone).replace(/\D/g, "").slice(-10))).slice(0, 10);
      }
    } else if (cfg.driver === "mysql") {
      const pool = await getMysql(cfg);
      let rows = [];
      if (email) [rows] = await pool.query("SELECT * FROM ?? WHERE email=? LIMIT 1", [cfg.mysql.user_table || "users", email]);
      if (!rows.length && phone) [rows] = await pool.query("SELECT * FROM ?? WHERE phone LIKE ? LIMIT 1", [cfg.mysql.user_table || "users", "%" + String(phone).replace(/\D/g, "").slice(-10) + "%"]);
      if (rows.length) user = rows[0];
      if (user && cfg.mysql.orders_table) {
        const okey = cfg.mysql.orders_user_key || "user_id";
        const [b] = await pool.query(`SELECT * FROM ?? WHERE ${okey}=? ORDER BY id DESC LIMIT 10`, [cfg.mysql.orders_table, user.id]);
        bookings = b;
      }
    }
    return { enabled: true, user, bookings, walletBalance };
  } catch (e) {
    return { enabled: true, error: e.message, user: null, bookings: [] };
  }
}

module.exports = { getConfig, saveConfig, lookupCustomer, closeAll };
