'use strict';

// Motor de PeopleHub Fund · fase 1 (créditos internos, sin blockchain).
// Todos los importes están en céntimos de crédito (1 crédito = 100). Cada cambio de saldo
// deja una línea en fund.ledger. Las operaciones bloquean el proyecto (FOR UPDATE) dentro
// de una transacción, así que dos usuarios a la vez no pueden descuadrar los saldos.

const { query, tx } = require('./db');

const CENT = 100;
const FUNDING_DAYS = 7;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WELCOME_CREDITS = Number(process.env.WELCOME_CREDITS || 1000);
const PLATFORM = 'platform';

// Repartos (en puntos básicos).
const SPLIT = { stake: 6000, previous: 1000, development: 2800, fee: 200 };
const SALE_FEE_BPS = 500;
const VOTE_COST_CENTS = 1 * CENT;
const PRICE_OPTIONS = [50, 30, 10, 0, -10, -30, -50];

// ELO
const ELO_BASE = 1500;
const K = { investment: 8, sale: 8, vote: 4, selection: 16, failure: 16 };

class UserError extends Error {}

const currentWeek = () => Math.floor(Date.now() / WEEK_MS);
const bps = (cents, b) => Math.floor((cents * b) / 10000);

// ---------------------------------------------------------------- saldos

async function credit(c, userId, cents, kind, projectId = null, note = null) {
  if (cents <= 0) return;
  await c.query('UPDATE fund.users SET balance_cents = balance_cents + $2 WHERE id = $1', [userId, cents]);
  await c.query(
    'INSERT INTO fund.ledger (user_id, project_id, amount_cents, kind, note) VALUES ($1, $2, $3, $4, $5)',
    [userId, projectId, cents, kind, note]
  );
}

async function debit(c, userId, cents, kind, projectId = null, note = null) {
  const { rows } = await c.query(
    'UPDATE fund.users SET balance_cents = balance_cents - $2 WHERE id = $1 AND balance_cents >= $2 RETURNING balance_cents',
    [userId, cents]
  );
  if (!rows.length) throw new UserError('No tienes créditos suficientes.');
  await c.query(
    'INSERT INTO fund.ledger (user_id, project_id, amount_cents, kind, note) VALUES ($1, $2, $3, $4, $5)',
    [userId, projectId, -cents, kind, note]
  );
}

// Reparte `cents` entre los participantes del proyecto en proporción a su participación.
// Lo que sobra por redondeo va a la plataforma.
async function distribute(c, p, cents, kind, note) {
  if (cents <= 0) return;
  if (p.total_stake_cents <= 0) {
    await credit(c, PLATFORM, cents, kind, p.id, note);
    return;
  }
  const share = 'floor($2::numeric * s.stake_cents / $3)::bigint';
  const args = [p.id, cents, p.total_stake_cents];
  const { rows } = await c.query(
    `SELECT coalesce(sum(${share}), 0)::bigint AS total FROM fund.stakes s WHERE s.project_id = $1 AND s.stake_cents > 0`,
    args
  );
  const paid = Number(rows[0].total);
  await c.query(
    `UPDATE fund.users u SET balance_cents = u.balance_cents + x.amt
     FROM (SELECT s.user_id, ${share} AS amt FROM fund.stakes s WHERE s.project_id = $1 AND s.stake_cents > 0) x
     WHERE u.id = x.user_id AND x.amt > 0`,
    args
  );
  await c.query(
    `UPDATE fund.stakes s SET earned_cents = s.earned_cents + ${share}
     WHERE s.project_id = $1 AND s.stake_cents > 0`,
    args
  );
  await c.query(
    `INSERT INTO fund.ledger (user_id, project_id, amount_cents, kind, note)
     SELECT s.user_id, $1, ${share}, $4, $5 FROM fund.stakes s
     WHERE s.project_id = $1 AND s.stake_cents > 0 AND ${share} > 0`,
    [...args, kind, note]
  );
  await credit(c, PLATFORM, cents - paid, 'redondeo', p.id);
}

// ---------------------------------------------------------------- ELO

async function ensureRating(c, userId) {
  await c.query('INSERT INTO fund.developer_ratings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const { rows } = await c.query('SELECT rating FROM fund.developer_ratings WHERE user_id = $1', [userId]);
  return Number(rows[0].rating);
}

async function fieldRating(c, exceptId) {
  const { rows } = await c.query(
    'SELECT avg(rating) AS r FROM fund.developer_ratings WHERE user_id <> $1',
    [exceptId]
  );
  return rows[0].r === null ? ELO_BASE : Number(rows[0].r);
}

const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

async function applyRating(c, userId, delta, won) {
  await c.query(
    `UPDATE fund.developer_ratings SET rating = rating + $2,
       wins = wins + $3, losses = losses + $4, updated_at = now()
     WHERE user_id = $1`,
    [userId, delta, won ? 1 : 0, won ? 0 : 1]
  );
}

// Resultado contra la media del resto de desarrolladores.
async function eloVsField(c, userId, won, k) {
  const r = await ensureRating(c, userId);
  const field = await fieldRating(c, userId);
  await applyRating(c, userId, k * ((won ? 1 : 0) - expected(r, field)), won);
}

// Duelo entre dos desarrolladores (p. ej. el elegido frente a los demás candidatos).
async function eloDuel(c, winnerId, loserId, k) {
  const rw = await ensureRating(c, winnerId);
  const rl = await ensureRating(c, loserId);
  const delta = k * (1 - expected(rw, rl));
  await applyRating(c, winnerId, delta, true);
  await applyRating(c, loserId, -delta, false);
}

// ---------------------------------------------------------------- ciclo de vida del proyecto

async function lockProject(c, id) {
  const { rows } = await c.query('SELECT * FROM fund.projects WHERE id = $1 FOR UPDATE', [id]);
  if (!rows.length) throw new UserError('Este proyecto no existe.');
  return rows[0];
}

async function save(c, p) {
  await c.query(
    `UPDATE fund.projects SET
       status = $2, raised = $3, total_stake_cents = $4, dev_fund_cents = $5, dev_status = $6,
       developer_id = $7, invited_email = $8, candidacy_ends_at = $9, dev_started_at = $10, dev_ends_at = $11,
       vote_week = $12, vote_weighted_sum = $13, vote_total_weight = $14, price_cents = $15,
       activated_at = $16, funding_ends_at = $17, dev_round = $18, dev_mode = $19,
       candidacy_days = $20, votes_required = $21, decided_at = $22, admin_note = $23, app_url = $24
     WHERE id = $1`,
    [
      p.id, p.status, p.raised, p.total_stake_cents, p.dev_fund_cents, p.dev_status,
      p.developer_id, p.invited_email, p.candidacy_ends_at, p.dev_started_at, p.dev_ends_at,
      p.vote_week, p.vote_weighted_sum, p.vote_total_weight, p.price_cents,
      p.activated_at, p.funding_ends_at, p.dev_round, p.dev_mode,
      p.candidacy_days, p.votes_required, p.decided_at, p.admin_note, p.app_url,
    ]
  );
}

async function payDevFund(c, p) {
  if (p.dev_status === 'active' && p.developer_id && p.dev_fund_cents > 0) {
    await credit(c, p.developer_id, p.dev_fund_cents, 'desarrollo', p.id, 'Fondo de desarrollo del proyecto');
    p.dev_fund_cents = 0;
  }
}

async function startPeriod(c, p) {
  const now = new Date();
  p.dev_status = 'active';
  p.dev_started_at = now;
  p.dev_ends_at = new Date(now.getTime() + p.dev_period_days * 864e5);
  await payDevFund(c, p);
}

async function selectDeveloper(c, p, userId) {
  p.developer_id = userId;
  p.dev_status = 'selected';
  p.candidacy_ends_at = p.candidacy_ends_at && new Date(p.candidacy_ends_at) > new Date() ? new Date() : p.candidacy_ends_at;
  await ensureRating(c, userId);
  // El elegido gana un duelo frente a cada candidato que tuvo votos.
  const { rows } = await c.query(
    'SELECT user_id FROM fund.candidates WHERE project_id = $1 AND round = $2 AND user_id <> $3 AND votes > 0',
    [p.id, p.dev_round, userId]
  );
  for (const r of rows) await eloDuel(c, userId, r.user_id, K.selection);
  if (p.status === 'active') await startPeriod(c, p);
}

async function activate(c, p) {
  p.status = 'active';
  p.activated_at = new Date();
  p.vote_week = currentWeek();
  p.dev_fund_cents += p.goal * CENT;
  if (p.dev_status === 'selected') await startPeriod(c, p);
}

// Aplica los cambios que dependen del tiempo (plazos vencidos, semana de votación nueva).
async function sync(c, p) {
  const now = new Date();
  let changed = false;

  // 1. Plazo de financiación vencido sin llegar a la meta: se devuelve todo.
  if (p.status === 'funding' && p.funding_ends_at && new Date(p.funding_ends_at) < now && p.raised < p.goal) {
    const { rows } = await c.query(
      'SELECT user_id, funding_cents FROM fund.stakes WHERE project_id = $1 AND funding_cents > 0',
      [p.id]
    );
    for (const s of rows) await credit(c, s.user_id, Number(s.funding_cents), 'reembolso', p.id, 'No se alcanzó la meta');
    await c.query('UPDATE fund.stakes SET stake_cents = 0, funding_cents = 0 WHERE project_id = $1', [p.id]);
    p.status = 'failed';
    p.total_stake_cents = 0;
    if (p.developer_id && ['selected', 'active'].includes(p.dev_status)) {
      await eloVsField(c, p.developer_id, false, K.failure);
    }
    if (['invited', 'candidacy', 'selected'].includes(p.dev_status)) p.dev_status = 'none';
    changed = true;
  }

  // 2. Candidatura vencida: gana el más votado (si alguien tiene votos).
  if (p.dev_status === 'candidacy' && p.candidacy_ends_at && new Date(p.candidacy_ends_at) < now) {
    const { rows } = await c.query(
      `SELECT user_id FROM fund.candidates WHERE project_id = $1 AND round = $2 AND votes > 0
       ORDER BY votes DESC, created_at ASC LIMIT 1`,
      [p.id, p.dev_round]
    );
    if (rows.length && p.status !== 'failed') await selectDeveloper(c, p, rows[0].user_id);
    else p.dev_status = 'none';
    changed = true;
  }

  // 3. Periodo de desarrollo terminado.
  if (p.dev_status === 'active' && p.dev_ends_at && new Date(p.dev_ends_at) < now) {
    p.dev_status = 'finished';
    changed = true;
  }

  // 4. Semana nueva: se aplica la votación de precio de la anterior.
  if (p.status === 'active' && p.vote_week < currentWeek()) {
    if (p.vote_total_weight > 0) {
      const avgBps = Math.trunc((p.vote_weighted_sum * 100) / p.vote_total_weight);
      p.price_cents = Math.max(1, Math.round((p.price_cents * (10000 + avgBps)) / 10000));
      await c.query(
        'INSERT INTO fund.price_history (project_id, week, avg_bps, price_cents) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [p.id, p.vote_week, avgBps, p.price_cents]
      );
    }
    p.vote_week = currentWeek();
    p.vote_weighted_sum = 0;
    p.vote_total_weight = 0;
    changed = true;
  }

  if (changed) await save(c, p);
  return p;
}

// Bloquea el proyecto, aplica plazos y ejecuta fn dentro de la misma transacción.
function withProject(id, fn) {
  return tx(async (c) => {
    const p = await lockProject(c, id);
    await sync(c, p);
    const result = await fn(c, p);
    await save(c, p);
    return result;
  });
}

let lastSyncAll = 0;
async function syncAll(force = false) {
  if (!force && Date.now() - lastSyncAll < 60_000) return;
  lastSyncAll = Date.now();
  const { rows } = await query(
    `SELECT id FROM fund.projects WHERE
       (status = 'funding' AND funding_ends_at < now() AND raised < goal)
       OR (dev_status = 'candidacy' AND candidacy_ends_at < now())
       OR (dev_status = 'active' AND dev_ends_at < now())
       OR (status = 'active' AND vote_week < $1)`,
    [currentWeek()]
  );
  for (const r of rows) {
    await tx(async (c) => sync(c, await lockProject(c, r.id))).catch((err) => console.error('sync', r.id, err.message));
  }
}

// ---------------------------------------------------------------- usuarios

async function upsertUser(claims) {
  const name =
    claims.name ||
    [claims.given_name, claims.family_name].filter(Boolean).join(' ') ||
    claims.preferred_username ||
    (claims.email ? claims.email.split('@')[0] : 'Usuario');
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO fund.users (id, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, last_login_at = now()
       RETURNING id, name, email`,
      [claims.sub, name.slice(0, 120), claims.email ? claims.email.toLowerCase() : null]
    );
    const welcome = await c.query(
      'UPDATE fund.users SET welcome_granted = true WHERE id = $1 AND NOT welcome_granted RETURNING id',
      [claims.sub]
    );
    if (welcome.rows.length && WELCOME_CREDITS > 0) {
      await credit(c, claims.sub, WELCOME_CREDITS * CENT, 'bienvenida', null, 'Créditos de bienvenida');
    }
    return rows[0];
  });
}

async function getBalance(userId) {
  const { rows } = await query('SELECT balance_cents FROM fund.users WHERE id = $1', [userId]);
  return rows.length ? Number(rows[0].balance_cents) : 0;
}

async function grantCredits(email, credits, note) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT id, name FROM fund.users WHERE lower(email) = lower($1)', [email]);
    if (!rows.length) throw new UserError('No hay ningún usuario con ese email. Debe haber entrado antes en PeopleHub Fund.');
    await credit(c, rows[0].id, credits * CENT, 'concesion', null, note || 'Concesión de la plataforma');
    return rows[0];
  });
}

// ---------------------------------------------------------------- proyectos

async function createProject(creatorId, d) {
  const { rows } = await query(
    `INSERT INTO fund.projects (creator_id, title, summary, description, goal, price_cents,
       dev_period_days, dev_mode, invited_email, candidacy_days, votes_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      creatorId, d.title, d.summary, d.description, d.goal, d.priceCents, d.devPeriodDays, d.devMode,
      d.devMode === 'assigned' ? d.invitedEmail.toLowerCase() : null,
      d.devMode === 'open' ? d.candidacyDays : null,
      d.devMode === 'open' ? d.votesRequired : null,
    ]
  );
  return rows[0].id;
}

function openSelection(p) {
  if (p.dev_mode === 'assigned') {
    p.dev_status = 'invited';
    p.candidacy_ends_at = null;
  } else {
    p.dev_status = 'candidacy';
    p.candidacy_ends_at = new Date(Date.now() + p.candidacy_days * 864e5);
  }
  p.developer_id = null;
}

async function decideProject(id, approve, note) {
  return withProject(id, async (c, p) => {
    if (p.status !== 'pending') throw new UserError('Este proyecto ya estaba decidido.');
    p.decided_at = new Date();
    p.admin_note = note || null;
    if (!approve) {
      p.status = 'rejected';
      return;
    }
    p.status = 'funding';
    p.funding_ends_at = new Date(Date.now() + FUNDING_DAYS * 864e5);
    openSelection(p);
  });
}

async function invest(userId, id, credits) {
  return withProject(id, async (c, p) => {
    if (p.status === 'funding') {
      const accepted = Math.min(credits, p.goal - p.raised);
      if (accepted <= 0) throw new UserError('Este proyecto ya ha alcanzado su meta.');
      const cents = accepted * CENT;
      await debit(c, userId, cents, 'inversion', p.id, 'Financiación del proyecto');
      await c.query(
        `INSERT INTO fund.stakes (project_id, user_id, stake_cents, funding_cents, invested_cents) VALUES ($1, $2, $3, $3, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET stake_cents = fund.stakes.stake_cents + $3,
           funding_cents = fund.stakes.funding_cents + $3, invested_cents = fund.stakes.invested_cents + $3`,
        [p.id, userId, cents]
      );
      p.raised += accepted;
      p.total_stake_cents += cents;
      if (p.developer_id && ['selected', 'active'].includes(p.dev_status)) await eloVsField(c, p.developer_id, true, K.investment);
      if (p.raised >= p.goal) await activate(c, p);
      return { accepted, activated: p.status === 'active' };
    }
    if (p.status === 'active') {
      const cents = credits * CENT;
      await debit(c, userId, cents, 'inversion', p.id, 'Inversión en proyecto activo');
      const previous = bps(cents, SPLIT.previous);
      const development = bps(cents, SPLIT.development);
      const fee = bps(cents, SPLIT.fee);
      const stake = cents - previous - development - fee; // 60 % (absorbe el redondeo)
      // Primero cobran los inversores previos; después se suma la nueva participación.
      await distribute(c, p, previous, 'reparto', 'Reparto por nueva inversión (10 %)');
      await c.query(
        `INSERT INTO fund.stakes (project_id, user_id, stake_cents, invested_cents) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, user_id) DO UPDATE SET stake_cents = fund.stakes.stake_cents + $3,
           invested_cents = fund.stakes.invested_cents + $4`,
        [p.id, userId, stake, cents]
      );
      p.total_stake_cents += stake;
      p.dev_fund_cents += development;
      await payDevFund(c, p);
      await credit(c, PLATFORM, fee, 'comision', p.id, 'Comisión 2 %');
      if (p.developer_id && p.dev_status === 'active') await eloVsField(c, p.developer_id, true, K.investment);
      return { accepted: credits, stake };
    }
    throw new UserError('Este proyecto no admite inversiones ahora mismo.');
  });
}

async function buyAccess(userId, id) {
  return withProject(id, async (c, p) => {
    if (p.status !== 'active') throw new UserError('La app de este proyecto aún no está disponible.');
    if (userId === p.creator_id || userId === p.developer_id) throw new UserError('Ya tienes acceso como creador o desarrollador.');
    const exists = await c.query('SELECT 1 FROM fund.access WHERE project_id = $1 AND user_id = $2', [p.id, userId]);
    if (exists.rows.length) throw new UserError('Ya tienes acceso a esta app.');
    const price = p.price_cents;
    await debit(c, userId, price, 'compra', p.id, 'Acceso a la app');
    await c.query('INSERT INTO fund.access (project_id, user_id, price_cents) VALUES ($1, $2, $3)', [p.id, userId, price]);
    const fee = bps(price, SALE_FEE_BPS);
    await credit(c, PLATFORM, fee, 'comision', p.id, 'Comisión 5 %');
    await distribute(c, p, price - fee, 'reparto', 'Reparto por venta de la app (95 %)');
    if (p.developer_id && ['active', 'finished'].includes(p.dev_status)) await eloVsField(c, p.developer_id, true, K.sale);
  });
}

async function votePrice(userId, id, percent) {
  if (!PRICE_OPTIONS.includes(percent)) throw new UserError('Opción de voto no válida.');
  return withProject(id, async (c, p) => {
    if (p.status !== 'active') throw new UserError('Solo se vota el precio de proyectos activos.');
    const { rows } = await c.query('SELECT stake_cents FROM fund.stakes WHERE project_id = $1 AND user_id = $2', [p.id, userId]);
    const weight = rows.length ? Number(rows[0].stake_cents) : 0;
    if (weight <= 0) throw new UserError('Necesitas participación en el proyecto para votar el precio.');
    const ins = await c.query(
      `INSERT INTO fund.price_votes (project_id, week, user_id, percent, weight) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING week`,
      [p.id, p.vote_week, userId, percent, weight]
    );
    if (!ins.rows.length) throw new UserError('Ya has votado el precio esta semana.');
    p.vote_weighted_sum += percent * weight;
    p.vote_total_weight += weight;
  });
}

// ---------------------------------------------------------------- desarrollador

async function applyAsDeveloper(userId, id, pitch) {
  return withProject(id, async (c, p) => {
    if (p.dev_status !== 'candidacy') throw new UserError('La candidatura de este proyecto no está abierta.');
    const ins = await c.query(
      'INSERT INTO fund.candidates (project_id, user_id, pitch, round) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id',
      [p.id, userId, pitch, p.dev_round]
    );
    if (!ins.rows.length) throw new UserError('Ya te has presentado a este proyecto.');
    await ensureRating(c, userId);
  });
}

async function voteCandidate(voterId, id, candidateId) {
  return withProject(id, async (c, p) => {
    if (p.dev_status !== 'candidacy') throw new UserError('La votación de desarrollador ya está cerrada.');
    if (voterId === candidateId) throw new UserError('No puedes votarte a ti mismo.');
    const cand = await c.query(
      'SELECT votes FROM fund.candidates WHERE project_id = $1 AND round = $2 AND user_id = $3 FOR UPDATE',
      [p.id, p.dev_round, candidateId]
    );
    if (!cand.rows.length) throw new UserError('Ese candidato no existe.');
    const ins = await c.query(
      'INSERT INTO fund.candidate_votes (project_id, round, voter_id, candidate_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING voter_id',
      [p.id, p.dev_round, voterId, candidateId]
    );
    if (!ins.rows.length) throw new UserError('Ya has votado en esta candidatura.');
    await debit(c, voterId, VOTE_COST_CENTS, 'voto', p.id, 'Voto a candidato a desarrollador');
    await credit(c, PLATFORM, VOTE_COST_CENTS, 'voto', p.id, 'Voto a candidato');
    const votes = Number(cand.rows[0].votes) + 1;
    await c.query('UPDATE fund.candidates SET votes = $4 WHERE project_id = $1 AND round = $2 AND user_id = $3', [p.id, p.dev_round, candidateId, votes]);
    await eloVsField(c, candidateId, true, K.vote);
    if (votes >= p.votes_required) {
      await selectDeveloper(c, p, candidateId);
      return { selected: true };
    }
    return { selected: false, votes };
  });
}

async function respondInvitation(userId, email, id, accept) {
  return withProject(id, async (c, p) => {
    if (p.dev_status !== 'invited' || !email || p.invited_email !== email.toLowerCase()) {
      throw new UserError('No tienes ninguna invitación pendiente en este proyecto.');
    }
    if (accept) {
      await selectDeveloper(c, p, userId);
    } else {
      p.dev_status = 'declined';
      p.invited_email = null;
    }
  });
}

async function restartSelection(userId, id, d) {
  return withProject(id, async (c, p) => {
    if (p.creator_id !== userId) throw new UserError('Solo quien creó el proyecto puede elegir desarrollador.');
    if (!['funding', 'active'].includes(p.status)) throw new UserError('Este proyecto no admite cambios de desarrollador.');
    if (!['none', 'declined', 'finished'].includes(p.dev_status)) throw new UserError('El proyecto ya tiene una selección de desarrollador en curso.');
    p.dev_round += 1;
    p.dev_mode = d.devMode;
    p.dev_period_days = d.devPeriodDays;
    p.invited_email = d.devMode === 'assigned' ? d.invitedEmail.toLowerCase() : null;
    p.candidacy_days = d.devMode === 'open' ? d.candidacyDays : p.candidacy_days;
    p.votes_required = d.devMode === 'open' ? d.votesRequired : p.votes_required;
    p.dev_started_at = null;
    p.dev_ends_at = null;
    await c.query('UPDATE fund.projects SET dev_period_days = $2 WHERE id = $1', [p.id, d.devPeriodDays]);
    openSelection(p);
  });
}

async function setAppUrl(userId, isAdmin, id, url) {
  return withProject(id, async (c, p) => {
    if (!isAdmin && userId !== p.creator_id && userId !== p.developer_id) throw new UserError('No puedes cambiar este proyecto.');
    p.app_url = url || null;
  });
}

// ---------------------------------------------------------------- lecturas

const PROJECT_COLUMNS = `p.*, cu.name AS creator_name, du.name AS developer_name, dr.rating AS developer_rating,
  (SELECT count(*)::int FROM fund.stakes s WHERE s.project_id = p.id AND s.invested_cents > 0) AS backers`;

const PROJECT_FROM = `fund.projects p
  JOIN fund.users cu ON cu.id = p.creator_id
  LEFT JOIN fund.users du ON du.id = p.developer_id
  LEFT JOIN fund.developer_ratings dr ON dr.user_id = p.developer_id`;

async function listProjects(statuses) {
  await syncAll();
  const { rows } = await query(
    `SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE p.status = ANY($1) ORDER BY p.created_at DESC`,
    [statuses]
  );
  return rows;
}

async function getProject(id, viewerId = null) {
  await tx(async (c) => sync(c, await lockProject(c, id))).catch((err) => {
    if (!(err instanceof UserError)) throw err;
  });
  const { rows } = await query(`SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE p.id = $1`, [id]);
  const p = rows[0];
  if (!p) return null;
  const [candidates, history, mine] = await Promise.all([
    query(
      `SELECT c.user_id, c.pitch, c.votes, c.created_at, u.name, coalesce(r.rating, ${ELO_BASE}) AS rating
       FROM fund.candidates c JOIN fund.users u ON u.id = c.user_id
       LEFT JOIN fund.developer_ratings r ON r.user_id = c.user_id
       WHERE c.project_id = $1 AND c.round = $2 ORDER BY c.votes DESC, c.created_at ASC`,
      [id, p.dev_round]
    ),
    query('SELECT week, avg_bps, price_cents, created_at FROM fund.price_history WHERE project_id = $1 ORDER BY week DESC LIMIT 8', [id]),
    viewerId
      ? query(
          `SELECT
             (SELECT row_to_json(s) FROM fund.stakes s WHERE s.project_id = $1 AND s.user_id = $2) AS stake,
             EXISTS (SELECT 1 FROM fund.access a WHERE a.project_id = $1 AND a.user_id = $2) AS has_access,
             (SELECT percent FROM fund.price_votes v WHERE v.project_id = $1 AND v.week = $3 AND v.user_id = $2) AS price_vote,
             (SELECT candidate_id FROM fund.candidate_votes v WHERE v.project_id = $1 AND v.round = $4 AND v.voter_id = $2) AS candidate_vote,
             (SELECT balance_cents FROM fund.users WHERE id = $2) AS balance_cents`,
          [id, viewerId, p.vote_week, p.dev_round]
        )
      : Promise.resolve({ rows: [null] }),
  ]);
  const m = mine.rows[0];
  return {
    project: p,
    candidates: candidates.rows,
    history: history.rows,
    viewer: m
      ? {
          stake: m.stake ? { stake: Number(m.stake.stake_cents), invested: Number(m.stake.invested_cents), earned: Number(m.stake.earned_cents) } : null,
          hasAccess: m.has_access || viewerId === p.creator_id || viewerId === p.developer_id,
          priceVote: m.price_vote,
          candidateVote: m.candidate_vote,
          balance: Number(m.balance_cents || 0),
        }
      : null,
  };
}

async function myArea(userId, email) {
  await syncAll();
  const [user, ledger, created, stakes, candidacies, invitations, developing] = await Promise.all([
    query('SELECT balance_cents FROM fund.users WHERE id = $1', [userId]),
    query(
      `SELECT l.amount_cents, l.kind, l.note, l.created_at, l.project_id, p.title
       FROM fund.ledger l LEFT JOIN fund.projects p ON p.id = l.project_id
       WHERE l.user_id = $1 ORDER BY l.id DESC LIMIT 40`,
      [userId]
    ),
    query(`SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE p.creator_id = $1 ORDER BY p.created_at DESC`, [userId]),
    query(
      `SELECT s.stake_cents, s.invested_cents, s.earned_cents, p.id, p.title, p.status
       FROM fund.stakes s JOIN fund.projects p ON p.id = s.project_id
       WHERE s.user_id = $1 AND s.invested_cents > 0 ORDER BY p.created_at DESC`,
      [userId]
    ),
    query(
      `SELECT c.votes, p.id, p.title, p.dev_status, p.developer_id, p.votes_required, p.candidacy_ends_at
       FROM fund.candidates c JOIN fund.projects p ON p.id = c.project_id AND c.round = p.dev_round
       WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
      [userId]
    ),
    email
      ? query(`SELECT p.id, p.title, p.dev_period_days FROM fund.projects p WHERE p.dev_status = 'invited' AND p.invited_email = $1`, [email.toLowerCase()])
      : Promise.resolve({ rows: [] }),
    query(`SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE p.developer_id = $1 ORDER BY p.dev_started_at DESC NULLS FIRST`, [userId]),
  ]);
  return {
    balance: user.rows.length ? Number(user.rows[0].balance_cents) : 0,
    ledger: ledger.rows,
    created: created.rows,
    stakes: stakes.rows,
    candidacies: candidacies.rows,
    invitations: invitations.rows,
    developing: developing.rows,
  };
}

async function ranking() {
  const { rows } = await query(
    `SELECT r.user_id, r.rating, r.wins, r.losses, u.name,
       (SELECT count(*)::int FROM fund.projects p WHERE p.developer_id = r.user_id AND p.dev_status IN ('active', 'finished', 'selected')) AS projects,
       (SELECT coalesce(sum(s.invested_cents), 0)::bigint FROM fund.stakes s JOIN fund.projects p ON p.id = s.project_id
          WHERE p.developer_id = r.user_id) AS support_cents
     FROM fund.developer_ratings r JOIN fund.users u ON u.id = r.user_id
     ORDER BY r.rating DESC, r.wins DESC LIMIT 100`
  );
  return rows;
}

async function adminOverview() {
  await syncAll();
  const [pending, all, platform, totals] = await Promise.all([
    query(`SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE p.status = 'pending' ORDER BY p.created_at ASC`),
    query(`SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE p.status <> 'pending' ORDER BY p.created_at DESC LIMIT 100`),
    query(`SELECT balance_cents FROM fund.users WHERE id = 'platform'`),
    query(`SELECT count(*)::int AS users, coalesce(sum(balance_cents), 0)::bigint AS circulating FROM fund.users WHERE id <> 'platform'`),
  ]);
  return {
    pending: pending.rows,
    all: all.rows,
    platformBalance: platform.rows.length ? Number(platform.rows[0].balance_cents) : 0,
    users: totals.rows[0].users,
    circulating: Number(totals.rows[0].circulating),
  };
}

module.exports = {
  CENT,
  FUNDING_DAYS,
  WELCOME_CREDITS,
  PRICE_OPTIONS,
  SPLIT,
  SALE_FEE_BPS,
  ELO_BASE,
  UserError,
  currentWeek,
  upsertUser,
  getBalance,
  grantCredits,
  createProject,
  decideProject,
  invest,
  buyAccess,
  votePrice,
  applyAsDeveloper,
  voteCandidate,
  respondInvitation,
  restartSelection,
  setAppUrl,
  listProjects,
  getProject,
  myArea,
  ranking,
  adminOverview,
  syncAll,
};
