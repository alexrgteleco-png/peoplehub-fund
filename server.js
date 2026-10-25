'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool, migrate } = require('./lib/db');
const { mountAuthRoutes, requireLogin, isConfigured: authConfigured } = require('./lib/oidc');
const { csrfToken, verifyCsrf, securityHeaders } = require('./lib/security');
const chain = require('./lib/chain');
const models = require('./lib/models');
const views = require('./lib/views');

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const WEEK = 7 * 24 * 60 * 60;

if (!process.env.SESSION_SECRET && isProduction) {
  console.error('Falta la variable SESSION_SECRET');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(express.json({ limit: '10kb' }));

app.get('/healthz', (req, res) => res.send('ok'));

app.use(
  session({
    name: 'sid',
    store: new PgSession({ pool, schemaName: 'fund', tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'solo-para-desarrollo-local',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 30 * 24 * 60 * 60 * 1000 },
  })
);

const isAdmin = (user) => Boolean(user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()));

app.use((req, res, next) => {
  const user = req.session.user || null;
  res.locals.ctx = {
    user,
    isAdmin: isAdmin(user),
    path: req.originalUrl,
    get csrf() {
      return csrfToken(req);
    },
    flash: req.session.flash || null,
  };
  delete req.session.flash;
  next();
});

app.use(verifyCsrf);

mountAuthRoutes(app, { onLogin: (claims) => models.upsertUser(claims) });

const flash = (req, type, message) => {
  req.session.flash = { type, message };
};
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, page, status = 200) => res.status(status).send(String(page));
const parseId = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);

function requireAdmin(req, res, next) {
  if (!req.session.user) return requireLogin(req, res, next);
  if (!isAdmin(req.session.user)) {
    return send(res, views.errorPage(res.locals.ctx, { status: 403, message: 'Esta sección es solo para administración.' }), 403);
  }
  next();
}

// Proyectos de la blockchain con sus textos de la base de datos.
async function loadItems() {
  if (!chain.isConfigured()) return { items: [], configured: false, error: false };
  try {
    const [projects, metas] = await Promise.all([chain.listProjects(), models.publishedProposals()]);
    const byId = new Map(metas.map((m) => [m.onchain_id, m]));
    return { items: projects.map((p) => ({ project: p, meta: byId.get(p.id) || null })), configured: true, error: false };
  } catch (err) {
    console.error('Error leyendo la blockchain:', err.message);
    return { items: [], configured: true, error: true };
  }
}

// ---------------------------------------------------------------- páginas públicas

app.get(
  '/',
  asyncRoute(async (req, res) => {
    const tab = ['funding', 'active', 'schedule', 'failed'].includes(req.query.tab) ? req.query.tab : 'funding';
    const data = await loadItems();
    send(res, views.homePage(res.locals.ctx, { ...data, tab }));
  })
);

app.get('/como-funciona', (req, res) => send(res, views.howPage(res.locals.ctx)));

app.get(
  '/projects/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const notFound = () => send(res, views.errorPage(res.locals.ctx, { status: 404, message: 'Este proyecto no existe.' }), 404);
    if (!id || !chain.isConfigured()) return notFound();
    let project;
    try {
      project = await chain.getProject(id);
    } catch (err) {
      console.error(err.message);
      return send(res, views.errorPage(res.locals.ctx, { status: 503, message: 'No se ha podido leer la blockchain. Inténtalo en unos segundos.' }), 503);
    }
    if (!project) return notFound();
    const meta = await models.proposalByOnchainId(id);
    const wallet = req.session.user && req.session.user.wallet_address;
    const epoch = Math.floor(Date.now() / 1000 / WEEK);
    let position = null;
    let voted = false;
    let error = false;
    if (wallet) {
      try {
        [position, voted] = await Promise.all([chain.position(id, wallet), chain.hasVoted(id, epoch, wallet)]);
      } catch (err) {
        console.error(err.message);
        error = true;
      }
    }
    send(res, views.projectPage(res.locals.ctx, {
      project,
      meta,
      position,
      voted,
      epochEnds: new Date((epoch + 1) * WEEK * 1000),
      configured: true,
      error,
    }));
  })
);

app.get(
  '/comprar',
  asyncRoute(async (req, res) => {
    let sale = null;
    let error = false;
    if (chain.isConfigured()) {
      try {
        sale = await chain.saleInfo();
      } catch (err) {
        console.error(err.message);
        error = true;
      }
    }
    send(res, views.buyPage(res.locals.ctx, { sale, configured: chain.isConfigured(), error }));
  })
);

// ---------------------------------------------------------------- propuestas

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function readProposal(body) {
  const data = {
    title: String(body.title || '').trim(),
    summary: String(body.summary || '').trim(),
    description: String(body.description || '').replace(/\r\n/g, '\n').trim(),
    goalTokens: String(body.goalTokens || '').trim(),
    initialPrice: String(body.initialPrice || '').trim().replace(',', '.'),
    publisherAddress: String(body.publisherAddress || '').trim(),
  };
  const errors = {};
  if (data.title.length < 3 || data.title.length > 120) errors.title = 'Entre 3 y 120 caracteres.';
  if (data.summary.length < 10 || data.summary.length > 280) errors.summary = 'Entre 10 y 280 caracteres.';
  if (data.description.length > 8000) errors.description = 'Máximo 8.000 caracteres.';
  const goal = Number(data.goalTokens);
  if (!/^\d+$/.test(data.goalTokens) || goal < 1000 || goal > 100000) errors.goalTokens = 'Un número entero entre 1.000 y 100.000.';
  if (!/^\d+(\.\d{1,2})?$/.test(data.initialPrice) || Number(data.initialPrice) < 0.01) errors.initialPrice = 'Mínimo 0,01 PHUB, con dos decimales como mucho.';
  if (!ADDRESS_RE.test(data.publisherAddress)) errors.publisherAddress = 'Debe ser una dirección pública válida (0x seguido de 40 caracteres).';
  return { data: { ...data, goalTokens: goal }, errors };
}

app.get('/proposals/new', requireLogin, (req, res) => send(res, views.proposalFormPage(res.locals.ctx, {})));

app.post(
  '/proposals',
  requireLogin,
  asyncRoute(async (req, res) => {
    const { data, errors } = readProposal(req.body);
    if (Object.keys(errors).length) {
      return send(res, views.proposalFormPage(res.locals.ctx, { data: { ...data, goalTokens: req.body.goalTokens }, errors }), 422);
    }
    await models.createProposal(req.session.user.id, data);
    flash(req, 'success', '¡Propuesta enviada! Te avisaremos aquí cuando el equipo la revise.');
    res.redirect('/mine');
  })
);

// ---------------------------------------------------------------- mi área y wallet

app.get(
  '/mine',
  requireLogin,
  asyncRoute(async (req, res) => {
    const user = req.session.user;
    const proposals = await models.proposalsByUser(user.id);
    let balances = null;
    let positions = [];
    let error = false;
    if (chain.isConfigured() && user.wallet_address) {
      try {
        balances = await chain.balances(user.wallet_address);
        const { items } = await loadItems();
        const withPos = await Promise.all(items.map(async (i) => ({ ...i, position: await chain.position(i.project.id, user.wallet_address) })));
        positions = withPos.filter((x) => x.position.stake > 0n || x.position.pending > 0n);
      } catch (err) {
        console.error(err.message);
        error = true;
      }
    }
    send(res, views.minePage(res.locals.ctx, { proposals, balances, positions, configured: chain.isConfigured(), error }));
  })
);

app.post(
  '/wallet',
  requireLogin,
  asyncRoute(async (req, res) => {
    const address = String(req.body.address || '').trim();
    if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'Dirección no válida' });
    await models.setWallet(req.session.user.id, address);
    req.session.user = { ...req.session.user, wallet_address: address.toLowerCase() };
    res.json({ ok: true, address: address.toLowerCase() });
  })
);

// ---------------------------------------------------------------- administración

app.get(
  '/admin',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const [pending, approved, published, data] = await Promise.all([
      models.proposalsByStatus(['pending']),
      models.proposalsByStatus(['approved']),
      models.proposalsByStatus(['published']),
      loadItems(),
    ]);
    let owner = null;
    if (chain.isConfigured()) owner = await chain.projectsOwner().catch(() => null);
    send(res, views.adminPage(res.locals.ctx, { pending, approved, published, items: data.items, owner, configured: chain.isConfigured() }));
  })
);

app.post(
  '/admin/proposals/:id/decide',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const decision = req.body.decision === 'approved' ? 'approved' : req.body.decision === 'rejected' ? 'rejected' : null;
    if (!id || !decision) return res.redirect('/admin');
    await models.decideProposal(id, decision, String(req.body.note || '').trim().slice(0, 300));
    flash(req, 'success', decision === 'approved' ? 'Propuesta aceptada. Publícala en la blockchain para abrir su financiación.' : 'Propuesta rechazada.');
    res.redirect('/admin');
  })
);

// Tras firmar createProject en su wallet, el admin envía el hash; el servidor lo comprueba en la blockchain.
app.post(
  '/admin/proposals/:id/link',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const txHash = String(req.body.txHash || '');
    if (!id || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: 'Datos no válidos' });
    const proposal = await models.getProposal(id);
    if (!proposal || proposal.status !== 'approved') return res.status(409).json({ error: 'La propuesta no está pendiente de publicar' });
    const created = await chain.readProjectCreated(txHash);
    if (created.pending) return res.status(202).json({ pending: true });
    const goalOk = created.goal === BigInt(proposal.goal_tokens) * chain.UNIT;
    const publisherOk = created.publisher.toLowerCase() === proposal.publisher_address.toLowerCase();
    if (!goalOk || !publisherOk) return res.status(422).json({ error: 'El proyecto creado no coincide con la propuesta' });
    await models.markPublished(id, created.id, txHash);
    req.session.flash = { type: 'success', message: `Proyecto publicado en la blockchain con el número ${created.id}. Tiene 7 días para financiarse.` };
    res.json({ ok: true, onchainId: created.id });
  })
);

app.post(
  '/admin/proposals/:id/development',
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.redirect('/admin');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.developmentDate || '') ? req.body.developmentDate : null;
    const url = /^https:\/\/\S+$/.test(req.body.appUrl || '') ? req.body.appUrl.slice(0, 300) : null;
    await models.setDevelopment(id, date, url);
    flash(req, 'success', 'Datos de desarrollo guardados.');
    res.redirect('/admin');
  })
);

// ---------------------------------------------------------------- errores

app.use((req, res) => send(res, views.errorPage(res.locals.ctx, { status: 404, message: 'Esta página no existe.' }), 404));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (req.accepts(['html', 'json']) === 'json') return res.status(500).json({ error: 'Error inesperado' });
  const ctx = res.locals.ctx || { user: null, path: req.originalUrl, csrf: '' };
  send(res, views.errorPage(ctx, { status: 500, message: 'Ha ocurrido un error inesperado. Inténtalo de nuevo en unos segundos.' }), 500);
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PeopleHub Fund escuchando en el puerto ${PORT} · red ${chain.NETWORK.name}`);
      if (!authConfigured()) console.warn('Aviso: el login con Keycloak no está configurado (variables OIDC_*).');
      if (!chain.isConfigured()) console.warn('Aviso: contratos no configurados (PHUB_ADDRESS, SALE_ADDRESS, PROJECTS_ADDRESS).');
    });
  })
  .catch((err) => {
    console.error('No se pudo preparar la base de datos:', err);
    process.exit(1);
  });
