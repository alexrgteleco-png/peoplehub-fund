'use strict';

const { html, raw } = require('./html');
const { formatLong, formatShort } = require('./time');
const M = require('./models');

const PLATFORM_URL = (process.env.PLATFORM_URL || '').replace(/\/$/, '');

// Versión de los archivos estáticos: cambia en cada despliegue y evita que el navegador use CSS/JS antiguos.
const ASSET_VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 10);
const asset = (p) => `${p}?v=${ASSET_VERSION}`;

const STATUS_LABEL = {
  pending: 'En revisión',
  rejected: 'Rechazado',
  funding: 'En financiación',
  active: 'Activo',
  failed: 'No financiado',
};

const DEV_LABEL = {
  none: 'Sin desarrollador',
  invited: 'Desarrollador invitado',
  candidacy: 'Buscando desarrollador',
  selected: 'Desarrollador elegido',
  active: 'En desarrollo',
  finished: 'Periodo de desarrollo terminado',
  declined: 'Invitación rechazada',
};

const KIND_LABEL = {
  bienvenida: 'Bienvenida',
  concesion: 'Concesión',
  inversion: 'Inversión',
  reparto: 'Reparto',
  desarrollo: 'Desarrollo',
  comision: 'Comisión',
  compra: 'Compra de acceso',
  voto: 'Voto a candidato',
  reembolso: 'Reembolso',
  redondeo: 'Redondeo',
};

// ---------------------------------------------------------------- utilidades

const numberFormat = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
const intFormat = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });

function credits(cents, { sign = false } = {}) {
  const v = Number(cents) / 100;
  const text = numberFormat.format(Math.abs(v));
  const prefix = sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : '';
  return `${prefix}${text}`;
}

const creditsLabel = (cents) => `${credits(cents)} ${Math.abs(Number(cents)) === 100 ? 'crédito' : 'créditos'}`;

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function csrfField(ctx) {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => html`<p>${p.split('\n').map((line, i) => (i === 0 ? html`${line}` : html`<br>${line}`))}</p>`);
}

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const longDate = (d) => lower(formatLong(d));
const shortDay = (d) => formatShort(d).replace(/,.*$/, '');

function timeLeft(date) {
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return 'plazo terminado';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `quedan ${Math.floor(h / 24)} días`;
  if (h >= 1) return `quedan ${h} h`;
  return `quedan ${Math.max(1, Math.floor(ms / 60_000))} min`;
}

function progress(raised, goal) {
  const pct = goal > 0 ? Math.round((raised / goal) * 1000) / 10 : 0;
  return html`<progress class="progress" max="100" value="${Math.min(100, pct)}" aria-label="Financiación conseguida: ${pct} %">${pct} %</progress>`;
}

function badge(status) {
  return html`<span class="badge badge-${status}">${STATUS_LABEL[status] || status}</span>`;
}

function rating(r) {
  return intFormat.format(Math.round(Number(r || M.ELO_BASE)));
}

// ---------------------------------------------------------------- plantilla

function layout(ctx, { title, body, active = '' }) {
  const user = ctx.user;
  return html`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title ? `${title} · PeopleHub Fund` : 'PeopleHub Fund · Ideas y desarrolladores, juntos'}</title>
  <meta name="description" content="La fábrica de apps de theaipeoplehub: propón ideas, apoya proyectos con créditos y elige quién los desarrolla.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="${asset('/styles.css')}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script src="${asset('/app.js')}" defer></script>
</head>
<body>
  <div class="netbar">Fase beta · los créditos son unidades internas sin valor económico: no se compran ni se canjean por dinero</div>
  <header class="topbar">
    <div class="wrap topbar-inner">
      <a class="brand" href="/">
        <span class="brand-mark" aria-hidden="true">PH</span>
        <span class="brand-name">PeopleHub <strong>Fund</strong></span>
      </a>
      <nav class="nav" aria-label="Principal">
        <a href="/" class="${active === 'projects' ? 'active' : ''}">Proyectos</a>
        <a href="/desarrolladores" class="${active === 'ranking' ? 'active' : ''}">Desarrolladores</a>
        <a href="/como-funciona" class="${active === 'how' ? 'active' : ''} hide-sm">Cómo funciona</a>
        ${user && ctx.isAdmin ? html`<a href="/admin" class="${active === 'admin' ? 'active' : ''}">Admin</a>` : ''}
        <a href="/projects/new" class="button button-small">Crear proyecto</a>
        ${user
          ? html`<a href="/mine" class="account-link ${active === 'mine' ? 'active' : ''}" title="Mi área">
              <span class="avatar" aria-hidden="true">${initials(user.name)}</span>
              ${ctx.balance !== null ? html`<span class="balance-chip">${credits(ctx.balance)} <span class="hide-sm">créditos</span></span>` : html`<span class="hide-sm">Mi área</span>`}
            </a>`
          : html`<a href="/login?returnTo=${encodeURIComponent(ctx.path)}">Entrar</a>`}
      </nav>
    </div>
  </header>
  ${ctx.flash ? html`<div class="wrap"><p class="flash flash-${ctx.flash.type}" role="status">${ctx.flash.message}</p></div>` : ''}
  <main class="wrap">
    ${body}
  </main>
  <footer class="footer">
    <div class="wrap footer-inner">
      <span>La fábrica de apps de ${PLATFORM_URL ? html`<a href="${PLATFORM_URL}">theaipeoplehub</a>` : 'theaipeoplehub'}</span>
      <span><a href="/como-funciona">Cómo funciona</a>${PLATFORM_URL ? html` · <a href="${PLATFORM_URL}/privacidad">Privacidad</a> · <a href="${PLATFORM_URL}/aviso-legal">Aviso legal</a>` : ''}</span>
    </div>
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------- portada

function developerLine(p) {
  if (p.developer_id && ['selected', 'active', 'finished'].includes(p.dev_status)) {
    return html`<span class="dev-line">👩‍💻 ${p.developer_name} <span class="elo">${rating(p.developer_rating)}</span></span>`;
  }
  if (p.dev_status === 'candidacy') return html`<span class="dev-line dev-open">Buscando desarrollador · ${timeLeft(p.candidacy_ends_at)}</span>`;
  if (p.dev_status === 'invited') return html`<span class="dev-line">Desarrollador invitado</span>`;
  return html`<span class="dev-line subtle">Sin desarrollador</span>`;
}

function projectCard(p) {
  return html`<li>
    <a class="project-card status-${p.status}" href="/projects/${p.id}">
      <div class="project-card-top">${badge(p.status)}${p.dev_status === 'active' ? html`<span class="badge badge-dev">En desarrollo</span>` : ''}</div>
      <h3>${p.title}</h3>
      <p class="subtle">${p.summary}</p>
      ${p.status === 'funding'
        ? html`${progress(p.raised, p.goal)}
            <p class="meta"><strong>${intFormat.format(p.raised)}</strong> de ${intFormat.format(p.goal)} créditos · ${p.backers} ${p.backers === 1 ? 'apoyo' : 'apoyos'} · ${timeLeft(p.funding_ends_at)}</p>`
        : p.status === 'active'
          ? html`<p class="meta"><strong>${p.backers}</strong> ${p.backers === 1 ? 'apoyo' : 'apoyos'} · acceso a ${creditsLabel(p.price_cents)}</p>`
          : html`<p class="meta">Consiguió ${intFormat.format(p.raised)} de ${intFormat.format(p.goal)} créditos · se devolvió todo</p>`}
      <p class="meta">${developerLine(p)}</p>
    </a>
  </li>`;
}

function homePage(ctx, { projects, tab }) {
  const funding = projects.filter((p) => p.status === 'funding').sort((a, b) => b.raised - a.raised || b.backers - a.backers);
  const active = projects.filter((p) => p.status === 'active').sort((a, b) => b.backers - a.backers);
  const failed = projects.filter((p) => p.status === 'failed');
  const lists = { funding, active, failed };
  const list = lists[tab];
  const body = html`
    <section class="hero">
      <p class="eyebrow">La fábrica de apps de theaipeoplehub</p>
      <h1>Ideas y desarrolladores, juntos.</h1>
      <p class="lead">Propón una app, apóyala con créditos y elige quién la desarrolla. Las más apoyadas se construyen y se publican en la plataforma.</p>
      <div class="hero-actions">
        <a class="button button-large" href="/projects/new">Crear un proyecto</a>
        <a class="button button-large button-ghost" href="/desarrolladores">Ver desarrolladores</a>
      </div>
    </section>
    <nav class="tabs" aria-label="Filtrar proyectos">
      <a href="/" class="${tab === 'funding' ? 'active' : ''}">Más apoyados <span class="count">${funding.length}</span></a>
      <a href="/?tab=active" class="${tab === 'active' ? 'active' : ''}">Activos <span class="count">${active.length}</span></a>
      ${failed.length ? html`<a href="/?tab=failed" class="${tab === 'failed' ? 'active' : ''}">No financiados <span class="count">${failed.length}</span></a>` : ''}
    </nav>
    ${list.length
      ? html`<ul class="project-grid">${list.map(projectCard)}</ul>`
      : html`<div class="empty"><p>${tab === 'active' ? 'Todavía no hay proyectos activos.' : tab === 'failed' ? 'Ningún proyecto se ha quedado sin financiar.' : 'No hay proyectos buscando apoyo ahora mismo.'}</p><a class="button" href="/projects/new">Crea el primero</a></div>`}`;
  return layout(ctx, { body, active: 'projects' });
}

// ---------------------------------------------------------------- formulario de desarrollador (crear y reabrir)

function developerFields(ctx, data, errors) {
  const field = (name) => (errors[name] ? html`<p class="field-error" id="${name}-error">${errors[name]}</p>` : '');
  const invalid = (name) => (errors[name] ? raw(` aria-invalid="true" aria-describedby="${name}-error"`) : '');
  const mode = data.devMode === 'assigned' ? 'assigned' : 'open';
  return html`
    <fieldset class="dev-choice" data-dev-choice>
      <legend>¿Quién lo desarrolla?</legend>
      <label class="radio-card">
        <input type="radio" name="devMode" value="open"${mode === 'open' ? raw(' checked') : ''}>
        <span><strong>Candidatura abierta</strong><span class="subtle">Otros usuarios se presentan y la comunidad vota. Cada voto cuesta 1 crédito.</span></span>
      </label>
      <label class="radio-card">
        <input type="radio" name="devMode" value="assigned"${mode === 'assigned' ? raw(' checked') : ''}>
        <span><strong>Invitar a alguien que conozco</strong><span class="subtle">Le invitas por email y acepta desde su área.</span></span>
      </label>

      <div class="dev-group" data-dev-group="open">
        <div class="grid-2">
          <div>
            <label for="candidacyDays">Días de candidatura</label>
            <input id="candidacyDays" name="candidacyDays" type="number" min="1" max="30" value="${data.candidacyDays || '7'}"${invalid('candidacyDays')}>
            ${field('candidacyDays')}
          </div>
          <div>
            <label for="votesRequired">Votos para quedar elegido</label>
            <input id="votesRequired" name="votesRequired" type="number" min="1" max="100" value="${data.votesRequired || '5'}"${invalid('votesRequired')}>
            ${field('votesRequired')}
          </div>
        </div>
        <p class="hint">El primer candidato que llegue a esos votos queda elegido al momento. Si nadie llega, al acabar el plazo gana el más votado.</p>
      </div>

      <div class="dev-group" data-dev-group="assigned">
        <label for="invitedEmail">Email de la persona desarrolladora</label>
        <input id="invitedEmail" name="invitedEmail" type="email" value="${data.invitedEmail || ''}" placeholder="nombre@ejemplo.com"${invalid('invitedEmail')}>
        ${field('invitedEmail')}
        <p class="hint">Debe tener cuenta en theaipeoplehub con ese email. Puede ser el tuyo si lo vas a desarrollar tú.</p>
      </div>

      <label for="devPeriodDays">Periodo de desarrollo (días)</label>
      <input id="devPeriodDays" name="devPeriodDays" type="number" min="7" max="365" value="${data.devPeriodDays || '90'}"${invalid('devPeriodDays')}>
      ${field('devPeriodDays')}
      <p class="hint">Empieza cuando el proyecto alcanza su meta y hay desarrollador. Durante ese periodo recibe la financiación y el 28 % de cada nueva inversión.</p>
    </fieldset>`;
}

function projectFormPage(ctx, { data = {}, errors = {} }) {
  const field = (name) => (errors[name] ? html`<p class="field-error" id="${name}-error">${errors[name]}</p>` : '');
  const invalid = (name) => (errors[name] ? raw(` aria-invalid="true" aria-describedby="${name}-error"`) : '');
  const body = html`
    <div class="narrow">
      <p class="back"><a href="/">← Proyectos</a></p>
      <h1>Crear un proyecto</h1>
      <p class="subtle">Cuenta tu idea, cuántos créditos necesita y cómo se elegirá a quien la desarrolle. El equipo la revisa antes de publicarla.</p>
      <form method="post" action="/projects" class="form" novalidate>
        ${csrfField(ctx)}
        <label for="title">Nombre del proyecto</label>
        <input id="title" name="title" maxlength="120" required value="${data.title || ''}" placeholder="Ej.: Descifra, cartas oficiales explicadas"${invalid('title')}>
        ${field('title')}

        <label for="summary">Resumen en una frase</label>
        <input id="summary" name="summary" maxlength="280" required value="${data.summary || ''}" placeholder="Qué problema resuelve y para quién"${invalid('summary')}>
        ${field('summary')}

        <label for="description">Descripción <span class="optional">(opcional)</span></label>
        <textarea id="description" name="description" rows="7" maxlength="8000" placeholder="Cómo funcionaría, qué hay que construir, por qué lo usaría la gente…"${invalid('description')}>${data.description || ''}</textarea>
        ${field('description')}

        <div class="grid-2">
          <div>
            <label for="goal">Créditos necesarios</label>
            <input id="goal" name="goal" type="number" min="1000" max="100000" step="1" required value="${data.goal || ''}" placeholder="1.000 – 100.000"${invalid('goal')}>
            ${field('goal')}
          </div>
          <div>
            <label for="price">Precio inicial de acceso a la app</label>
            <input id="price" name="price" inputmode="decimal" required value="${data.price || ''}" placeholder="Ej.: 25 créditos"${invalid('price')}>
            ${field('price')}
          </div>
        </div>

        ${developerFields(ctx, data, errors)}

        <div class="form-actions">
          <button type="submit" class="button">Enviar proyecto</button>
          <a class="button button-ghost" href="/">Cancelar</a>
        </div>
      </form>
    </div>`;
  return layout(ctx, { title: 'Crear un proyecto', body });
}

// ---------------------------------------------------------------- detalle del proyecto

function developerCard(ctx, { project: p, candidates, viewer, invited }) {
  const user = ctx.user;
  const isCreator = user && user.id === p.creator_id;
  const canRestart = isCreator && ['funding', 'active'].includes(p.status) && ['none', 'declined', 'finished'].includes(p.dev_status);
  const alreadyCandidate = user && candidates.some((c) => c.user_id === user.id);

  let content;
  if (['selected', 'active', 'finished'].includes(p.dev_status) && p.developer_id) {
    content = html`
      <div class="dev-profile">
        <span class="avatar avatar-large" aria-hidden="true">${initials(p.developer_name)}</span>
        <div>
          <p class="dev-name">${p.developer_name}</p>
          <p class="subtle small">ELO ${rating(p.developer_rating)} · <a href="/desarrolladores">ver ranking</a></p>
        </div>
      </div>
      ${p.dev_status === 'selected' ? html`<p>Elegido. Su periodo de ${p.dev_period_days} días empezará cuando el proyecto alcance la meta.</p>` : ''}
      ${p.dev_status === 'active' ? html`<p>Desarrollando hasta el <strong>${longDate(p.dev_ends_at)}</strong>. Recibe la financiación y el 28 % de cada nueva inversión.</p>` : ''}
      ${p.dev_status === 'finished' ? html`<p>Su periodo de desarrollo terminó el ${longDate(p.dev_ends_at)}.</p>` : ''}`;
  } else if (p.dev_status === 'invited') {
    content = html`
      <p>Se ha invitado a una persona desarrolladora. Falta que acepte.</p>
      ${invited
        ? html`<div class="invite-box">
            <p><strong>¡Te han invitado a desarrollar este proyecto!</strong> Periodo de ${p.dev_period_days} días desde que alcance la meta.</p>
            <form method="post" action="/projects/${p.id}/invitation" class="inline-actions">
              ${csrfField(ctx)}
              <button name="decision" value="accept" class="button button-small">Aceptar</button>
              <button name="decision" value="decline" class="button button-small button-ghost">Rechazar</button>
            </form>
          </div>`
        : ''}`;
  } else if (p.dev_status === 'candidacy') {
    content = html`
      <p>Candidatura abierta · <strong>${timeLeft(p.candidacy_ends_at)}</strong>. Queda elegido quien llegue a <strong>${p.votes_required} ${p.votes_required === 1 ? 'voto' : 'votos'}</strong>. Cada voto cuesta 1 crédito.</p>
      ${candidates.length
        ? html`<ul class="candidates">${candidates.map(
            (c) => html`<li class="candidate">
              <div class="candidate-head">
                <span class="avatar" aria-hidden="true">${initials(c.name)}</span>
                <div class="candidate-info">
                  <p><strong>${c.name}</strong> <span class="elo">${rating(c.rating)}</span></p>
                  <p class="subtle small">${c.votes} de ${p.votes_required} votos</p>
                </div>
                ${user && user.id !== c.user_id && viewer && !viewer.candidateVote
                  ? html`<form method="post" action="/projects/${p.id}/candidates/vote">
                      ${csrfField(ctx)}
                      <input type="hidden" name="candidate" value="${c.user_id}">
                      <button class="button button-small" data-confirm="¿Votar a ${c.name}? Cuesta 1 crédito y solo puedes votar una vez.">Votar · 1 crédito</button>
                    </form>`
                  : viewer && viewer.candidateVote === c.user_id
                    ? html`<span class="ok small">Tu voto</span>`
                    : ''}
              </div>
              <progress class="progress progress-thin" max="${p.votes_required}" value="${Math.min(c.votes, p.votes_required)}" aria-label="Votos de ${c.name}">${c.votes}</progress>
              <p class="pitch">${c.pitch}</p>
            </li>`
          )}</ul>`
        : html`<p class="subtle">Aún no se ha presentado nadie.</p>`}
      ${!user
        ? html`<p><a href="/login?returnTo=${encodeURIComponent(`/projects/${p.id}`)}">Entra</a> para presentarte o votar.</p>`
        : alreadyCandidate
          ? html`<p class="ok small">Te has presentado a este proyecto.</p>`
          : html`<details class="apply">
              <summary>Presentarme como desarrollador</summary>
              <form method="post" action="/projects/${p.id}/apply" class="form">
                ${csrfField(ctx)}
                <label for="pitch">Por qué eres buena opción</label>
                <textarea id="pitch" name="pitch" rows="4" maxlength="1000" required placeholder="Experiencia, cómo lo plantearías, en cuánto tiempo…"></textarea>
                <button class="button button-small">Enviar candidatura</button>
              </form>
            </details>`}`;
  } else {
    content = html`<p class="subtle">${p.dev_status === 'declined' ? 'La persona invitada rechazó la invitación.' : 'Este proyecto todavía no tiene desarrollador.'}${canRestart ? '' : ' Quien lo creó puede elegir uno nuevo.'}</p>`;
  }

  return html`<section class="card" aria-labelledby="dev-title">
    <h2 id="dev-title">Desarrollador <span class="badge badge-dev-${p.dev_status}">${DEV_LABEL[p.dev_status]}</span></h2>
    ${content}
    ${canRestart
      ? html`<details class="apply"${p.dev_status !== 'finished' ? raw(' open') : ''}>
          <summary>${p.dev_status === 'finished' ? 'Elegir desarrollador para un nuevo periodo' : 'Elegir desarrollador'}</summary>
          <form method="post" action="/projects/${p.id}/developer" class="form">
            ${csrfField(ctx)}
            ${developerFields(ctx, { devPeriodDays: p.dev_period_days, candidacyDays: p.candidacy_days, votesRequired: p.votes_required }, {})}
            <button class="button button-small">Confirmar</button>
          </form>
        </details>`
      : ''}
  </section>`;
}

function projectPage(ctx, data) {
  const { project: p, history, viewer } = data;
  const user = ctx.user;
  const isCreator = user && user.id === p.creator_id;
  const isDev = user && user.id === p.developer_id;
  const body = html`
    <p class="back"><a href="/">← Todos los proyectos</a></p>
    <article class="project">
      <header class="project-header">
        ${badge(p.status)}
        <h1>${p.title}</h1>
        <p class="lead">${p.summary}</p>
        <p class="subtle">Idea de ${p.creator_name}</p>
        ${p.status === 'pending' ? html`<p class="notice">Pendiente de revisión por el equipo. Solo tú y la administración podéis verlo.</p>` : ''}
        ${p.status === 'rejected' ? html`<p class="notice notice-error">Proyecto rechazado.${p.admin_note ? ` Motivo: ${p.admin_note}` : ''}</p>` : ''}
      </header>

      <div class="project-layout">
        <div class="project-main">
          ${p.description ? html`<div class="description">${paragraphs(p.description)}</div>` : ''}
          <dl class="facts">
            <div><dt>Meta de financiación</dt><dd>${intFormat.format(p.goal)} créditos</dd></div>
            <div><dt>${p.status === 'active' ? 'Apoyos' : 'Conseguido'}</dt><dd>${p.status === 'active' ? `${p.backers}` : `${intFormat.format(p.raised)} créditos · ${p.backers} ${p.backers === 1 ? 'apoyo' : 'apoyos'}`}</dd></div>
            <div><dt>Precio de acceso a la app</dt><dd>${creditsLabel(p.price_cents)}</dd></div>
            <div><dt>${p.status === 'funding' ? 'Plazo de financiación' : 'Periodo de desarrollo'}</dt><dd>${p.status === 'funding' ? html`${timeLeft(p.funding_ends_at)}<br><span class="subtle small">hasta el ${longDate(p.funding_ends_at)}</span>` : `${p.dev_period_days} días`}</dd></div>
          </dl>
          ${p.status === 'funding' ? progress(p.raised, p.goal) : ''}

          ${developerCard(ctx, data)}

          ${p.status === 'active'
            ? html`<section class="card" aria-labelledby="vote-title">
                <h2 id="vote-title">Votación semanal del precio</h2>
                <p class="subtle">Quienes tienen participación votan cada semana cuánto sube o baja el precio de acceso. Se aplica la media ponderada por participación al empezar la semana siguiente.</p>
                ${!user
                  ? html`<p><a href="/login?returnTo=${encodeURIComponent(`/projects/${p.id}`)}">Entra</a> para votar.</p>`
                  : !viewer || !viewer.stake || viewer.stake.stake <= 0
                    ? html`<p class="subtle small">Necesitas participación en el proyecto para votar.</p>`
                    : viewer.priceVote !== null && viewer.priceVote !== undefined
                      ? html`<p><strong>Tu voto de esta semana: ${viewer.priceVote > 0 ? '+' : ''}${viewer.priceVote} %</strong></p>`
                      : html`<form method="post" action="/projects/${p.id}/price-vote" class="vote-options">
                          ${csrfField(ctx)}
                          ${M.PRICE_OPTIONS.map((v) => html`<button name="percent" value="${v}" class="vote ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${v} %</button>`)}
                        </form>`}
                ${history.length
                  ? html`<ul class="history">${history.map((h) => html`<li><span>Semana del ${shortDay(h.created_at)}</span><span class="${h.avg_bps > 0 ? 'up' : h.avg_bps < 0 ? 'down' : ''}">${h.avg_bps > 0 ? '+' : ''}${numberFormat.format(h.avg_bps / 100)} %</span><strong>${creditsLabel(h.price_cents)}</strong></li>`)}</ul>`
                  : ''}
              </section>`
            : ''}

          <section class="card rules">
            <h2>Reglas</h2>
            ${p.status === 'active'
              ? html`<p>Cada nueva inversión se reparte: <strong>60 %</strong> tu participación, <strong>10 %</strong> para quienes ya participaban, <strong>28 %</strong> para el desarrollo y <strong>2 %</strong> de comisión. Cada venta del acceso a la app reparte el <strong>95 %</strong> entre los participantes y el 5 % es comisión.</p>`
              : html`<p>Apoyar es votar: cada crédito aportado cuenta como un voto y como tu participación. Si se alcanza la meta en 7 días, el proyecto pasa a activo y la financiación es para el desarrollo. Si no, se devuelve todo.</p>`}
          </section>
        </div>

        <aside class="project-side">
          <div class="card">
            ${!user
              ? html`<p>Entra para apoyar este proyecto. Al registrarte recibes ${intFormat.format(M.WELCOME_CREDITS)} créditos de bienvenida.</p>
                  <a class="button button-block" href="/login?returnTo=${encodeURIComponent(`/projects/${p.id}`)}">Entrar</a>`
              : html`<p class="balance-line">Tu saldo: <strong>${creditsLabel(viewer ? viewer.balance : 0)}</strong></p>
                ${viewer && viewer.stake
                  ? html`<dl class="mini-facts">
                      <div><dt>Has aportado</dt><dd>${creditsLabel(viewer.stake.invested)}</dd></div>
                      <div><dt>Tu participación</dt><dd>${creditsLabel(viewer.stake.stake)}${p.total_stake_cents > 0 ? html` <span class="subtle small">(${numberFormat.format((viewer.stake.stake / p.total_stake_cents) * 100)} %)</span>` : ''}</dd></div>
                      ${viewer.stake.earned > 0 ? html`<div><dt>Has recibido</dt><dd class="ok">${creditsLabel(viewer.stake.earned)}</dd></div>` : ''}
                    </dl>`
                  : ''}
                ${['funding', 'active'].includes(p.status)
                  ? html`<form method="post" action="/projects/${p.id}/invest" class="action-form">
                      ${csrfField(ctx)}
                      <label for="amount">${p.status === 'funding' ? 'Apoyar con créditos' : 'Invertir créditos'}</label>
                      <div class="input-row">
                        <input id="amount" name="amount" type="number" min="1" step="1" required placeholder="${p.status === 'funding' ? `Faltan ${intFormat.format(p.goal - p.raised)}` : 'Cantidad'}">
                        <button type="submit" class="button">${p.status === 'funding' ? 'Apoyar' : 'Invertir'}</button>
                      </div>
                      <p class="hint">1 crédito = 1 voto. ${p.status === 'active' ? 'El 60 % queda como tu participación.' : 'Si no se llega a la meta, se te devuelve.'}</p>
                    </form>`
                  : ''}`}
          </div>

          ${p.status === 'active'
            ? html`<div class="card access-card">
                <h2>Acceso a la app</h2>
                <p class="big-number">${credits(p.price_cents)} <span>créditos</span></p>
                ${p.app_url ? html`<p><a href="${p.app_url}" target="_blank" rel="noopener noreferrer">Abrir la app ↗</a></p>` : html`<p class="subtle small">La app aún no está publicada.</p>`}
                ${!user
                  ? ''
                  : viewer && viewer.hasAccess
                    ? html`<p class="ok">Tienes acceso a esta app.</p>`
                    : html`<form method="post" action="/projects/${p.id}/access">
                        ${csrfField(ctx)}
                        <button class="button button-block" data-confirm="¿Comprar el acceso por ${creditsLabel(p.price_cents)}?">Comprar acceso</button>
                      </form>`}
              </div>`
            : ''}

          ${user && (isCreator || isDev || ctx.isAdmin) && ['funding', 'active'].includes(p.status)
            ? html`<div class="card">
                <h2>Enlace de la app</h2>
                <form method="post" action="/projects/${p.id}/app-url" class="form">
                  ${csrfField(ctx)}
                  <input name="appUrl" type="url" value="${p.app_url || ''}" placeholder="https://…" aria-label="Dirección de la app publicada">
                  <button class="button button-small button-ghost">Guardar</button>
                </form>
              </div>`
            : ''}
        </aside>
      </div>
    </article>`;
  return layout(ctx, { title: p.title, body, active: 'projects' });
}

// ---------------------------------------------------------------- mi área

function minePage(ctx, d) {
  const projectRow = (p) => html`<li><a href="/projects/${p.id}">${p.title}</a><span>${badge(p.status)}</span></li>`;
  const body = html`
    <h1>Mi área</h1>
    <div class="balance-hero card">
      <p class="subtle">Tu saldo</p>
      <p class="big-number">${credits(d.balance)} <span>créditos</span></p>
      <p class="hint">Los créditos sirven para apoyar proyectos, votar candidatos y acceder a apps. No se compran ni se canjean por dinero.</p>
    </div>

    ${d.invitations.length
      ? html`<section class="card invite-box">
          <h2>Invitaciones para desarrollar</h2>
          <ul class="plain-list">${d.invitations.map((p) => html`<li><a href="/projects/${p.id}">${p.title}</a><span>${p.dev_period_days} días · <a href="/projects/${p.id}">Responder</a></span></li>`)}</ul>
        </section>`
      : ''}

    <div class="mine-grid">
      <section class="card">
        <h2>Mis proyectos</h2>
        ${d.created.length ? html`<ul class="plain-list">${d.created.map(projectRow)}</ul>` : html`<p class="subtle">Aún no has creado ningún proyecto.</p>`}
        <p><a class="button button-small" href="/projects/new">Crear proyecto</a></p>
      </section>
      <section class="card">
        <h2>Mis apoyos</h2>
        ${d.stakes.length
          ? html`<ul class="plain-list">${d.stakes.map(
              (s) => html`<li><a href="/projects/${s.id}">${s.title}</a><span>${creditsLabel(s.invested_cents)}${s.earned_cents > 0 ? html` · <span class="ok">+${credits(s.earned_cents)} recibidos</span>` : ''}</span></li>`
            )}</ul>`
          : html`<p class="subtle">Aún no has apoyado ningún proyecto.</p>`}
      </section>
      <section class="card">
        <h2>Como desarrollador</h2>
        ${d.developing.length
          ? html`<ul class="plain-list">${d.developing.map((p) => html`<li><a href="/projects/${p.id}">${p.title}</a><span class="small">${DEV_LABEL[p.dev_status]}${p.dev_status === 'active' ? ` · hasta el ${shortDay(p.dev_ends_at)}` : ''}</span></li>`)}</ul>`
          : html`<p class="subtle">Aún no desarrollas ningún proyecto.</p>`}
        ${d.candidacies.length
          ? html`<h3>Mis candidaturas</h3><ul class="plain-list">${d.candidacies.map(
              (c) => html`<li><a href="/projects/${c.id}">${c.title}</a><span class="small">${c.dev_status === 'candidacy' ? `${c.votes} de ${c.votes_required} votos` : c.developer_id === ctx.user.id ? 'Elegido' : 'Cerrada'}</span></li>`
            )}</ul>`
          : ''}
      </section>
      <section class="card">
        <h2>Movimientos</h2>
        ${d.ledger.length
          ? html`<ul class="ledger">${d.ledger.map(
              (l) => html`<li>
                <span class="ledger-kind">${KIND_LABEL[l.kind] || l.kind}${l.title ? html` · <a href="/projects/${l.project_id}">${l.title}</a>` : ''}</span>
                <span class="ledger-date subtle small">${formatShort(l.created_at)}</span>
                <strong class="${l.amount_cents > 0 ? 'up' : 'down'}">${credits(l.amount_cents, { sign: true })}</strong>
              </li>`
            )}</ul>`
          : html`<p class="subtle">Sin movimientos.</p>`}
      </section>
    </div>
    <form method="post" action="/logout">${csrfField(ctx)}<button type="submit" class="button button-ghost button-small">Cerrar sesión</button></form>`;
  return layout(ctx, { title: 'Mi área', body, active: 'mine' });
}

// ---------------------------------------------------------------- ranking

function rankingPage(ctx, { rows }) {
  const body = html`
    <h1>Ranking de desarrolladores</h1>
    <p class="lead">Clasificación ELO (base 1.500) que se actualiza al instante: suben con cada apoyo y venta de sus proyectos, con los votos de sus candidaturas y al ganar una elección; bajan si pierden una elección o su proyecto no se financia.</p>
    ${rows.length
      ? html`<div class="table-wrap"><table class="ranking">
          <thead><tr><th scope="col">#</th><th scope="col">Desarrollador</th><th scope="col">ELO</th><th scope="col">Victorias</th><th scope="col">Proyectos</th><th scope="col">Apoyo recibido</th></tr></thead>
          <tbody>${rows.map(
            (r, i) => html`<tr class="${i < 3 ? 'top' : ''}">
              <td>${i + 1}</td>
              <td><span class="avatar" aria-hidden="true">${initials(r.name)}</span> ${r.name}</td>
              <td><strong>${rating(r.rating)}</strong></td>
              <td>${r.wins} / ${r.wins + r.losses}</td>
              <td>${r.projects}</td>
              <td>${creditsLabel(r.support_cents)}</td>
            </tr>`
          )}</tbody>
        </table></div>`
      : html`<div class="empty"><p>Todavía no hay desarrolladores en el ranking. Preséntate a un proyecto con candidatura abierta.</p></div>`}`;
  return layout(ctx, { title: 'Desarrolladores', body, active: 'ranking' });
}

// ---------------------------------------------------------------- administración

function adminPage(ctx, d) {
  const devSummary = (p) =>
    p.dev_mode === 'assigned'
      ? `Invitará a ${p.invited_email || '—'} · ${p.dev_period_days} días`
      : `Candidatura de ${p.candidacy_days} días · ${p.votes_required} votos · ${p.dev_period_days} días de desarrollo`;
  const body = html`
    <h1>Administración</h1>
    <div class="stats">
      <div class="card"><p class="subtle small">Usuarios</p><p class="big-number">${intFormat.format(d.users)}</p></div>
      <div class="card"><p class="subtle small">Créditos en manos de usuarios</p><p class="big-number">${credits(d.circulating)}</p></div>
      <div class="card"><p class="subtle small">Saldo de la plataforma</p><p class="big-number">${credits(d.platformBalance)}</p></div>
    </div>

    <section class="card">
      <h2>Proyectos por revisar <span class="count">${d.pending.length}</span></h2>
      ${d.pending.length
        ? d.pending.map(
            (p) => html`<div class="admin-item">
              <h3><a href="/projects/${p.id}">${p.title}</a></h3>
              <p>${p.summary}</p>
              ${p.description ? html`<details><summary>Descripción</summary>${paragraphs(p.description)}</details>` : ''}
              <p class="subtle small">De ${p.creator_name} · meta ${intFormat.format(p.goal)} créditos · acceso a ${creditsLabel(p.price_cents)} · ${devSummary(p)}</p>
              <form method="post" action="/admin/projects/${p.id}/decide" class="admin-form">
                ${csrfField(ctx)}
                <input name="note" maxlength="300" placeholder="Nota para quien lo propone (opcional)" aria-label="Nota">
                <button name="decision" value="approve" class="button button-small">Aceptar y abrir financiación</button>
                <button name="decision" value="reject" class="button button-small button-ghost">Rechazar</button>
              </form>
            </div>`
          )
        : html`<p class="subtle">No hay proyectos pendientes.</p>`}
    </section>

    <section class="card">
      <h2>Conceder créditos</h2>
      <p class="subtle small">Solo para usuarios que ya han entrado en PeopleHub Fund. Los créditos no tienen valor económico.</p>
      <form method="post" action="/admin/credits" class="admin-form">
        ${csrfField(ctx)}
        <input name="email" type="email" required placeholder="email@ejemplo.com" aria-label="Email">
        <input name="credits" type="number" min="1" max="1000000" required placeholder="Créditos" aria-label="Créditos" class="input-small">
        <input name="note" maxlength="200" placeholder="Motivo (opcional)" aria-label="Motivo">
        <button class="button button-small">Conceder</button>
      </form>
    </section>

    <section class="card">
      <h2>Todos los proyectos</h2>
      ${d.all.length
        ? html`<ul class="plain-list">${d.all.map(
            (p) => html`<li><a href="/projects/${p.id}">${p.title}</a><span>${badge(p.status)} <span class="small subtle">${DEV_LABEL[p.dev_status]}${p.developer_name ? ` · ${p.developer_name}` : ''}</span></span></li>`
          )}</ul>`
        : html`<p class="subtle">Aún no hay proyectos.</p>`}
    </section>`;
  return layout(ctx, { title: 'Administración', body, active: 'admin' });
}

// ---------------------------------------------------------------- cómo funciona

function howPage(ctx) {
  const body = html`
    <div class="narrow prose">
      <h1>Cómo funciona PeopleHub Fund</h1>
      <p class="lead">theaipeoplehub es una fábrica de apps: quien tiene una idea y quien sabe desarrollarla trabajan juntos, y la comunidad decide qué se construye. Las apps terminadas se publican en la plataforma, como WhatWhenAndWhere.</p>

      <h2>Créditos</h2>
      <p>Todo funciona con créditos a precio unitario: 1 crédito es 1 voto y 1 unidad de participación. Al registrarte recibes ${intFormat.format(M.WELCOME_CREDITS)} créditos de bienvenida. En esta fase los créditos <strong>no se compran ni se canjean por dinero</strong> y no tienen valor económico.</p>

      <h2>De la idea a la app</h2>
      <ol class="steps-list">
        <li><strong>Crea un proyecto</strong> con su meta (entre 1.000 y 100.000 créditos), el precio inicial de acceso a la app y cómo se elegirá a quien lo desarrolle.</li>
        <li><strong>Revisión.</strong> El equipo acepta los proyectos viables. Desde ese momento hay 7 días para financiarlos y empieza la selección de desarrollador.</li>
        <li><strong>Apoyo.</strong> Cada crédito aportado es un voto. Si se llega a la meta, el proyecto pasa a activo. Si no, se devuelve todo.</li>
        <li><strong>Desarrollo.</strong> Cuando el proyecto está activo y tiene desarrollador, empieza el periodo de desarrollo elegido por quien lo creó. Durante ese periodo, el desarrollador recibe la financiación y el 28 % de cada nueva inversión.</li>
        <li><strong>Publicación.</strong> La app sale con su precio de acceso. Cada compra reparte el 95 % entre quienes participan y el 5 % es comisión.</li>
        <li><strong>Precio semanal.</strong> Cada semana los participantes votan si el precio sube o baja (+50, +30, +10, 0, −10, −30 o −50 %). Se aplica la media ponderada por participación.</li>
      </ol>

      <h2>El desarrollador</h2>
      <p>Cada proyecto tiene un único desarrollador por periodo. Quien crea el proyecto puede <strong>invitar a alguien que conoce</strong> o abrir una <strong>candidatura</strong> durante los días que elija. En la candidatura, cada voto cuesta 1 crédito y cada persona vota una vez: el primer candidato que llega a los votos fijados queda elegido al momento. Si nadie llega, al acabar el plazo gana el más votado.</p>

      <h2>Inversiones en proyectos activos</h2>
      <p>Cada nueva inversión se reparte: 60 % tu participación, 10 % para quienes ya participaban, 28 % para el desarrollo y 2 % de comisión. La participación no se puede retirar: es tu peso en los repartos y en la votación del precio.</p>

      <h2>Ranking de desarrolladores</h2>
      <p>Una clasificación ELO (base 1.500) que se actualiza al instante. Un desarrollador sube con cada apoyo y venta de sus proyectos, con los votos de sus candidaturas y al ganar una elección frente a otros candidatos. Baja si pierde una elección o si su proyecto no se financia.</p>

      <h2>Lo que viene</h2>
      <p>En una fase futura está previsto tokenizar el sistema, siempre que se cuente con el marco legal adecuado. Hasta entonces, todo funciona con créditos internos.</p>
    </div>`;
  return layout(ctx, { title: 'Cómo funciona', body, active: 'how' });
}

function errorPage(ctx, { status, message }) {
  const body = html`<div class="empty"><h1>${status === 404 ? 'No encontrado' : status === 403 ? 'Sin acceso' : 'Algo ha fallado'}</h1><p>${message}</p><a class="button" href="/">Volver</a></div>`;
  return layout(ctx, { title: 'Error', body });
}

module.exports = { homePage, projectPage, projectFormPage, minePage, rankingPage, adminPage, howPage, errorPage, credits };
