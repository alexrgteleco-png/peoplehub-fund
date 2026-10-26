'use strict';

const fs = require('fs');
const path = require('path');
const pg = require('pg');

const { Pool } = pg;
// bigint (int8) llega como texto por defecto; nuestros importes caben de sobra en un Number.
if (pg.types) pg.types.setTypeParser(20, (v) => Number(v));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta la variable DATABASE_URL');
  process.exit(1);
}

// La URL interna de Render no usa TLS; la externa (*.render.com) sí lo exige.
const useSsl = process.env.DATABASE_SSL === 'true' || /\.render\.com/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DATABASE_POOL_MAX || 5),
});

pool.on('error', (err) => console.error('Error en el pool de PostgreSQL:', err.message));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

function query(text, params) {
  return pool.query(text, params);
}

// Ejecuta fn(client) en una transacción; deshace todo si algo falla.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx, migrate };
