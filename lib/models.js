'use strict';

const { query } = require('./db');

async function upsertUser(claims) {
  const name =
    claims.name ||
    [claims.given_name, claims.family_name].filter(Boolean).join(' ') ||
    claims.preferred_username ||
    (claims.email ? claims.email.split('@')[0] : 'Usuario');
  const { rows } = await query(
    `INSERT INTO fund.users (id, name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, last_login_at = now()
     RETURNING id, name, email, wallet_address`,
    [claims.sub, name.slice(0, 120), claims.email || null]
  );
  return rows[0];
}

async function getUser(id) {
  const { rows } = await query('SELECT id, name, email, wallet_address FROM fund.users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function setWallet(userId, address) {
  await query('UPDATE fund.users SET wallet_address = $2 WHERE id = $1', [userId, address ? address.toLowerCase() : null]);
}

const PROPOSAL_COLUMNS = `p.id, p.user_id, p.title, p.summary, p.description, p.goal_tokens,
  p.initial_price::text AS initial_price, p.publisher_address, p.status, p.admin_note, p.onchain_id,
  p.create_tx, p.development_date, p.app_url, p.created_at, p.decided_at, u.name AS user_name`;

async function createProposal(userId, data) {
  const { rows } = await query(
    `INSERT INTO fund.proposals (user_id, title, summary, description, goal_tokens, initial_price, publisher_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, data.title, data.summary, data.description, data.goalTokens, data.initialPrice, data.publisherAddress.toLowerCase()]
  );
  return rows[0].id;
}

async function getProposal(id) {
  const { rows } = await query(
    `SELECT ${PROPOSAL_COLUMNS} FROM fund.proposals p JOIN fund.users u ON u.id = p.user_id WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function proposalByOnchainId(onchainId) {
  const { rows } = await query(
    `SELECT ${PROPOSAL_COLUMNS} FROM fund.proposals p JOIN fund.users u ON u.id = p.user_id WHERE p.onchain_id = $1`,
    [onchainId]
  );
  return rows[0] || null;
}

async function publishedProposals() {
  const { rows } = await query(
    `SELECT ${PROPOSAL_COLUMNS} FROM fund.proposals p JOIN fund.users u ON u.id = p.user_id
     WHERE p.status = 'published' AND p.onchain_id IS NOT NULL`
  );
  return rows;
}

async function proposalsByStatus(statuses) {
  const { rows } = await query(
    `SELECT ${PROPOSAL_COLUMNS} FROM fund.proposals p JOIN fund.users u ON u.id = p.user_id
     WHERE p.status = ANY($1) ORDER BY p.created_at DESC`,
    [statuses]
  );
  return rows;
}

async function proposalsByUser(userId) {
  const { rows } = await query(
    `SELECT ${PROPOSAL_COLUMNS} FROM fund.proposals p JOIN fund.users u ON u.id = p.user_id
     WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows;
}

async function decideProposal(id, status, note) {
  const { rowCount } = await query(
    `UPDATE fund.proposals SET status = $2, admin_note = $3, decided_at = now()
     WHERE id = $1 AND status IN ('pending', 'approved')`,
    [id, status, note || null]
  );
  return rowCount === 1;
}

async function markPublished(id, onchainId, txHash) {
  const { rowCount } = await query(
    `UPDATE fund.proposals SET status = 'published', onchain_id = $2, create_tx = $3
     WHERE id = $1 AND status = 'approved'`,
    [id, onchainId, txHash]
  );
  return rowCount === 1;
}

async function setDevelopment(id, date, appUrl) {
  await query('UPDATE fund.proposals SET development_date = $2, app_url = $3 WHERE id = $1', [id, date || null, appUrl || null]);
}

module.exports = {
  upsertUser,
  getUser,
  setWallet,
  createProposal,
  getProposal,
  proposalByOnchainId,
  publishedProposals,
  proposalsByStatus,
  proposalsByUser,
  decideProposal,
  markPublished,
  setDevelopment,
};
