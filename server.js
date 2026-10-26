'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool, migrate } = require('./lib/db');
const { mountAuthRoutes, requireLogin, isConfigured: authConfigured } = require('./lib/oidc');
const { csrfToken, verifyCsrf, securityHeaders } = require('./lib/security');
const models = require('./lib/models');
const views = require('./lib/views');

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

if (!process.env.SESSION_SECRET && isProduction) {
  console.error('Falta la variable SESSION_SECRET');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
// Los enlaces llevan ?v=<versión>, así que se pueden cachear mucho tiempo sin riesgo.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '30d' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

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
    balance: null,
  };
  delete req.session.flash;
  next();
});

app.use(verifyCsrf);

mountAuthRoutes(app, { onLogin: (claims) => models.upsertUser(claims) });

const flash = (req, type, message) => {
  req.session.flash = { type, message };
};
const send = (res, page, status = 200) => res.status(status).send(String(page));
const parseId = (v) => (/^\d{1,12}$/.test(String(v)) ? Number(v) : null);
const intIn = (v, min, max) => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Carga el saldo del usuario para la cabecera.
async function withBalance(req, res, next) {
  if (req.session.user) {
    try {
      res.locals.ctx.balance = await models.getBalance(req.session.user.id);
    } catch {
      res.locals.ctx.balance = null;
    }
  }
  next();
}
app.use(withBalance);

// Ejecuta una acción del usuario y vuelve a la página con un mensaje.
function action(fn, { back = (req) => req.get('referer') || '/' } = {}) {
  return async (req, res, next) => {
    try {
      const message = await fn(req, res);
      if (res.headersSent) return;
      if (message) flash(req, 'success', message);
      res.redirect(typeof back === 'function' ? back(req) : back);
    } catch (err) {
      if (err instanceof models.UserError) {
        flash(req, 'error', err.message);
        return res.redirect(typeof back === 'function' ? back(req) : back);
      }
      next(err);
    }
  };
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return requireLogin(req, res, next);
  if (!isAdmin(req.session.user)) {
    return send(res, views.errorPage(res.locals.ctx, { status: 403, message: 'Esta sección es solo para administración.' }), 403);
  }
  next();
}

const projectUrl = (req) => `/projects/${req.params.id}`;

// ---------------------------------------------------------------- páginas públicas

const TABS = {
  funding: ['funding'],
  active: ['active'],
  failed: ['failed'],
};

app.get('/', async (req, res, next) => {
  try {
    const tab = TABS[req.query.tab] ? req.query.tab : 'funding';
    const projects = await models.listProjects(['funding', 'active', 'failed']);
    send(res, views.homePage(res.locals.ctx, { projects, tab }));
  } catch (err) {
    next(err);
  }
});

app.get('/como-funciona', (req, res) => send(res, views.howPage(res.locals.ctx)));

app.get('/desarrolladores', async (req, res, next) => {
  try {
    send(res, views.rankingPage(res.locals.ctx, { rows: await models.ranking() }));
  } catch (err) {
    next(err);
  }
});

// /projects/new va antes que /projects/:id para que «new» no se lea como un número.
app.get('/projects/new', requireLogin, (req, res) => send(res, views.projectFormPage(res.locals.ctx, {})));

app.get('/projects/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const data = id && (await models.getProject(id, req.session.user ? req.session.user.id : null));
    const visible = data && (!['pending', 'rejected'].includes(data.project.status) || isAdmin(req.session.user) || (req.session.user && data.project.creator_id === req.session.user.id));
    if (!visible) return send(res, views.errorPage(res.locals.ctx, { status: 404, message: 'Este proyecto no existe.' }), 404);
    const myEmail = req.session.user && req.session.user.email ? req.session.user.email.toLowerCase() : null;
    send(res, views.projectPage(res.locals.ctx, { ...data, invited: Boolean(myEmail && data.project.dev_status === 'invited' && data.project.invited_email === myEmail) }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- crear proyecto

function readDeveloperChoice(body, errors) {
  const d = {
    devMode: body.devMode === 'assigned' ? 'assigned' : 'open',
    devPeriodDays: intIn(body.devPeriodDays, 7, 365),
    invitedEmail: String(body.invitedEmail || '').trim().toLowerCase(),
    candidacyDays: intIn(body.candidacyDays, 1, 30),
    votesRequired: intIn(body.votesRequired, 1, 100),
  };
  if (!d.devPeriodDays) errors.devPeriodDays = 'Entre 7 y 365 días.';
  if (d.devMode === 'assigned' && !EMAIL_RE.test(d.invitedEmail)) errors.invitedEmail = 'Escribe el email de la persona desarrolladora.';
  if (d.devMode === 'open') {
    if (!d.candidacyDays) errors.candidacyDays = 'Entre 1 y 30 días.';
    if (!d.votesRequired) errors.votesRequired = 'Entre 1 y 100 votos.';
  }
  return d;
}

function readProject(body) {
  const errors = {};
  const d = {
    title: String(body.title || '').trim(),
    summary: String(body.summary || '').trim(),
    description: String(body.description || '').replace(/\r\n/g, '\n').trim(),
    goal: intIn(body.goal, 1000, 100000),
    price: String(body.price || '').trim().replace(',', '.'),
  };
  if (d.title.length < 3 || d.title.length > 120) errors.title = 'Entre 3 y 120 caracteres.';
  if (d.summary.length < 10 || d.summary.length > 280) errors.summary = 'Entre 10 y 280 caracteres.';
  if (d.description.length > 8000) errors.description = 'Máximo 8.000 caracteres.';
  if (!d.goal) errors.goal = 'Un número entero entre 1.000 y 100.000.';
  if (!/^\d+(\.\d{1,2})?$/.test(d.price) || Number(d.price) < 0.01 || Number(d.price) > 100000) errors.price = 'Entre 0,01 y 100.000 créditos, con dos decimales como mucho.';
  d.priceCents = Math.round(Number(d.price) * 100);
  Object.assign(d, readDeveloperChoice(body, errors));
  return { data: d, errors };
}

app.post('/projects', requireLogin, async (req, res, next) => {
  try {
    const { data, errors } = readProject(req.body);
    if (Object.keys(errors).length) {
      return send(res, views.projectFormPage(res.locals.ctx, { data: { ...req.body }, errors }), 422);
    }
    await models.createProject(req.session.user.id, data);
    flash(req, 'success', '¡Proyecto enviado! El equipo lo revisará y, al aceptarlo, se abrirán 7 días de financiación.');
    res.redirect('/mine');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- acciones sobre un proyecto

app.post(
  '/projects/:id/invest',
  requireLogin,
  action(async (req) => {
    const credits = intIn(req.body.amount, 1, 1_000_000);
    if (!credits) throw new models.UserError('Escribe un número entero de créditos.');
    const r = await models.invest(req.session.user.id, parseId(req.params.id), credits);
    if (r.activated) return '¡Meta alcanzada! El proyecto ya está activo.';
    if (r.accepted < credits) return `Has invertido ${r.accepted} créditos: era lo que faltaba para la meta.`;
    return `Has invertido ${r.accepted} créditos.`;
  }, { back: projectUrl })
);

app.post(
  '/projects/:id/access',
  requireLogin,
  action(async (req) => {
    await models.buyAccess(req.session.user.id, parseId(req.params.id));
    return '¡Ya tienes acceso a la app!';
  }, { back: projectUrl })
);

app.post(
  '/projects/:id/price-vote',
  requireLogin,
  action(async (req) => {
    const percent = Number(req.body.percent);
    await models.votePrice(req.session.user.id, parseId(req.params.id), percent);
    return 'Voto de precio registrado. Se aplicará al empezar la semana próxima.';
  }, { back: projectUrl })
);

app.post(
  '/projects/:id/apply',
  requireLogin,
  action(async (req) => {
    const pitch = String(req.body.pitch || '').trim();
    if (pitch.length < 10 || pitch.length > 1000) throw new models.UserError('Cuenta en 10 a 1.000 caracteres por qué eres buena opción.');
    await models.applyAsDeveloper(req.session.user.id, parseId(req.params.id), pitch);
    return 'Te has presentado como candidato a desarrollador.';
  }, { back: projectUrl })
);

app.post(
  '/projects/:id/candidates/vote',
  requireLogin,
  action(async (req) => {
    const r = await models.voteCandidate(req.session.user.id, parseId(req.params.id), String(req.body.candidate || ''));
    return r.selected ? '¡Voto registrado! El candidato ha alcanzado los votos necesarios y ya es el desarrollador.' : 'Voto registrado (1 crédito).';
  }, { back: projectUrl })
);

app.post(
  '/projects/:id/invitation',
  requireLogin,
  action(async (req) => {
    const accept = req.body.decision === 'accept';
    await models.respondInvitation(req.session.user.id, req.session.user.email, parseId(req.params.id), accept);
    return accept ? 'Ahora eres el desarrollador de este proyecto.' : 'Has rechazado la invitación.';
  }, { back: projectUrl })
);

app.post(
  '/projects/:id/developer',
  requireLogin,
  action(async (req) => {
    const errors = {};
    const d = readDeveloperChoice(req.body, errors);
    const first = Object.values(errors)[0];
    if (first) throw new models.UserError(first);
    await models.restartSelection(req.session.user.id, parseId(req.params.id), d);
    return d.devMode === 'assigned' ? 'Invitación enviada al desarrollador.' : 'Candidatura abierta.';
  }, { back: projectUrl })
);

app.post(
  '/projects/:id/app-url',
  requireLogin,
  action(async (req) => {
    const url = String(req.body.appUrl || '').trim();
    if (url && !/^https:\/\/\S{3,300}$/.test(url)) throw new models.UserError('La dirección debe empezar por https://');
    await models.setAppUrl(req.session.user.id, isAdmin(req.session.user), parseId(req.params.id), url);
    return 'Enlace de la app guardado.';
  }, { back: projectUrl })
);

// ---------------------------------------------------------------- mi área

app.get('/mine', requireLogin, async (req, res, next) => {
  try {
    const data = await models.myArea(req.session.user.id, req.session.user.email);
    send(res, views.minePage(res.locals.ctx, data));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- administración

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    send(res, views.adminPage(res.locals.ctx, await models.adminOverview()));
  } catch (err) {
    next(err);
  }
});

app.post(
  '/admin/projects/:id/decide',
  requireAdmin,
  action(async (req) => {
    const approve = req.body.decision === 'approve';
    await models.decideProject(parseId(req.params.id), approve, String(req.body.note || '').trim().slice(0, 300));
    return approve ? 'Proyecto aceptado: empieza su financiación de 7 días.' : 'Proyecto rechazado.';
  }, { back: '/admin' })
);

app.post(
  '/admin/credits',
  requireAdmin,
  action(async (req) => {
    const email = String(req.body.email || '').trim();
    const credits = intIn(req.body.credits, 1, 1_000_000);
    if (!EMAIL_RE.test(email) || !credits) throw new models.UserError('Indica un email válido y un número entero de créditos.');
    const user = await models.grantCredits(email, credits, String(req.body.note || '').trim().slice(0, 200));
    return `Concedidos ${credits} créditos a ${user.name}.`;
  }, { back: '/admin' })
);

// ---------------------------------------------------------------- errores

app.use((req, res) => send(res, views.errorPage(res.locals.ctx, { status: 404, message: 'Esta página no existe.' }), 404));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const ctx = res.locals.ctx || { user: null, path: req.originalUrl, csrf: '' };
  send(res, views.errorPage(ctx, { status: 500, message: 'Ha ocurrido un error inesperado. Inténtalo de nuevo en unos segundos.' }), 500);
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PeopleHub Fund escuchando en el puerto ${PORT} · fase 1 (créditos internos, sin blockchain)`);
      if (!authConfigured()) console.warn('Aviso: el login con Keycloak no está configurado (variables OIDC_*).');
    });
    // Aplica plazos vencidos aunque nadie visite la web.
    setInterval(() => models.syncAll(true).catch((err) => console.error('syncAll', err.message)), 5 * 60 * 1000).unref();
  })
  .catch((err) => {
    console.error('No se pudo preparar la base de datos:', err);
    process.exit(1);
  });
