'use strict';

const { html, raw } = require('./html');
const { formatLong, formatShort } = require('./time');
const chain = require('./chain');

const PLATFORM_URL = (process.env.PLATFORM_URL || '').replace(/\/$/, '');
const fmt = (v, d = 18, f = 2) => chain.formatUnits(v, d, f);

const STATUS_LABEL = {
  funding: 'En financiación',
  active: 'Activo',
  failed: 'No financiado',
};

// Versión de los archivos estáticos: cambia en cada despliegue y evita que el navegador use CSS/JS antiguos.
const ASSET_VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 10);
const asset = (path) => `${path}?v=${ASSET_VERSION}`;

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function csrfField(ctx) {
  return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;
}

function shortAddress(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

function addressLink(a) {
  if (!a) return '';
  return chain.NETWORK.explorer
    ? html`<a href="${chain.NETWORK.explorer}/address/${a}" target="_blank" rel="noopener noreferrer" class="mono">${shortAddress(a)}</a>`
    : html`<span class="mono">${shortAddress(a)}</span>`;
}

function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => html`<p>${p.split('\n').map((line, i) => (i === 0 ? html`${line}` : html`<br>${line}`))}</p>`);
}

// Configuración que necesita wallet.js en el navegador (no contiene secretos).
function chainConfig(ctx) {
  const config = {
    configured: chain.isConfigured(),
    chainId: '0x' + chain.CHAIN_ID.toString(16),
    networkName: chain.NETWORK.name,
    rpc: chain.RPC_URL,
    explorer: chain.NETWORK.explorer,
    addresses: chain.ADDRESSES,
    selectors: chain.SELECTORS,
    linkedWallet: ctx.user ? ctx.user.wallet_address || null : null,
    csrf: ctx.user ? ctx.csrf : null,
  };
  return raw(`<script type="application/json" id="chain-config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`);
}

function layout(ctx, { title, body, active = '' }) {
  const user = ctx.user;
  return html`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title ? `${title} · PeopleHub Fund` : 'PeopleHub Fund'}</title>
  <meta name="description" content="Propón proyectos, invierte PeopleHub y decide qué construye theaipeoplehub.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="${asset('/styles.css')}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
  ${chain.NETWORK.testnet ? html`<div class="netbar">Red de pruebas · ${chain.NETWORK.name} · los tokens no tienen valor real</div>` : ''}
  <header class="topbar">
    <div class="wrap topbar-inner">
      <a class="brand" href="/">
        <span class="brand-mark" aria-hidden="true">PH</span>
        <span class="brand-name">PeopleHub <strong>Fund</strong></span>
      </a>
      <nav class="nav" aria-label="Principal">
        <a href="/" class="${active === 'projects' ? 'active' : ''}">Proyectos</a>
        <a href="/como-funciona" class="${active === 'how' ? 'active' : ''} hide-sm">Cómo funciona</a>
        <a href="/comprar" class="${active === 'buy' ? 'active' : ''}">Comprar PHUB</a>
        ${user && ctx.isAdmin ? html`<a href="/admin" class="${active === 'admin' ? 'active' : ''}">Admin</a>` : ''}
        ${user
          ? html`<a href="/mine" class="account-link ${active === 'mine' ? 'active' : ''}" title="Mi área"><span class="avatar" aria-hidden="true">${initials(user.name)}</span><span class="hide-sm">Mi área</span></a>`
          : html`<a href="/login?returnTo=${encodeURIComponent(ctx.path)}" class="button button-small">Entrar</a>`}
      </nav>
    </div>
  </header>
  ${ctx.flash ? html`<div class="wrap"><p class="flash flash-${ctx.flash.type}" role="status">${ctx.flash.message}</p></div>` : ''}
  <div class="wrap"><p class="tx-status" id="tx-status" role="status" aria-live="polite" hidden></p></div>
  <main class="wrap">
    ${body}
  </main>
  <footer class="footer">
    <div class="wrap footer-inner">
      <span>Una app de ${PLATFORM_URL ? html`<a href="${PLATFORM_URL}">theaipeoplehub</a>` : 'theaipeoplehub'} · Contratos en ${chain.NETWORK.name}</span>
      <span><a href="/como-funciona#riesgos">Riesgos</a>${PLATFORM_URL ? html` · <a href="${PLATFORM_URL}/privacidad">Privacidad</a> · <a href="${PLATFORM_URL}/aviso-legal">Aviso legal</a>` : ''}</span>
    </div>
  </footer>
  ${chainConfig(ctx)}
  <script src="${asset('/wallet.js')}" defer></script>
</body>
</html>`;
}

function notDeployed() {
  return html`<div class="notice">
    <strong>Los contratos de PeopleHub todavía no están desplegados.</strong>
    Ya puedes proponer proyectos; la financiación, las inversiones y los votos se activarán en cuanto los contratos estén en la red.
  </div>`;
}

function chainError() {
  return html`<div class="notice notice-error">No se ha podido leer la blockchain en este momento. Recarga la página en unos segundos.</div>`;
}

function progress(raised, goal) {
  const pct = goal > 0n ? Number((raised * 1000n) / goal) / 10 : 0;
  // <progress> nativo: evita estilos en línea, que bloquea la política de seguridad (CSP).
  return html`<progress class="progress" max="100" value="${Math.min(100, pct)}" aria-label="Financiación conseguida: ${pct} %">${pct} %</progress>`;
}

function timeLeft(deadline) {
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return 'Plazo terminado';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `Quedan ${Math.floor(h / 24)} días`;
  if (h >= 1) return `Quedan ${h} h`;
  return `Quedan ${Math.max(1, Math.floor(ms / 60_000))} min`;
}

function projectCard(item) {
  const { project: p, meta } = item;
  return html`<li>
    <a class="project-card status-${p.status}" href="/projects/${p.id}">
      <div class="project-card-top">
        <span class="badge badge-${p.status}">${STATUS_LABEL[p.status] || p.status}</span>
        ${meta && meta.development_date ? html`<span class="badge badge-dev">Desarrollo: ${formatShort(meta.development_date).replace(/,.*$/, '')}</span>` : ''}
      </div>
      <h3>${meta ? meta.title : `Proyecto #${p.id}`}</h3>
      ${meta ? html`<p class="subtle">${meta.summary}</p>` : ''}
      ${p.status === 'funding'
        ? html`${progress(p.raised, p.goal)}
            <p class="meta"><strong>${fmt(p.raised, 18, 0)}</strong> de ${fmt(p.goal, 18, 0)} PHUB · ${timeLeft(p.deadline)}</p>`
        : p.status === 'active'
          ? html`<p class="meta"><strong>${fmt(p.totalStake, 18, 0)}</strong> PHUB en participaciones · acceso a ${fmt(p.price)} PHUB</p>`
          : html`<p class="meta">No alcanzó la meta de ${fmt(p.goal, 18, 0)} PHUB · los inversores pueden recuperar sus tokens</p>`}
    </a>
  </li>`;
}

function homePage(ctx, { items, configured, error, tab }) {
  const funding = items.filter((i) => i.project.status === 'funding').sort((a, b) => (b.project.raised > a.project.raised ? 1 : b.project.raised < a.project.raised ? -1 : 0));
  const active = items.filter((i) => i.project.status === 'active').sort((a, b) => (b.project.totalStake > a.project.totalStake ? 1 : -1));
  const schedule = active
    .filter((i) => i.meta && i.meta.development_date)
    .sort((a, b) => new Date(a.meta.development_date) - new Date(b.meta.development_date));
  const failed = items.filter((i) => i.project.status === 'failed');
  const lists = { funding, active, schedule, failed };
  const list = lists[tab] || funding;
  const empty = {
    funding: 'No hay proyectos buscando financiación ahora mismo.',
    active: 'Todavía no hay proyectos activos.',
    schedule: 'La agenda de desarrollo está vacía.',
    failed: 'Ningún proyecto se ha quedado sin financiar.',
  };
  const body = html`
    <section class="hero">
      <h1>Tú decides qué construimos.</h1>
      <p class="lead">Propón una app, invierte PeopleHub (PHUB) en las que te gustan y participa en lo que generan. Los proyectos más votados pasan a la agenda de desarrollo.</p>
      <div class="hero-actions">
        <a class="button button-large" href="/proposals/new">Proponer un proyecto</a>
        <a class="button button-large button-ghost" href="/como-funciona">Cómo funciona</a>
      </div>
    </section>
    ${!configured ? notDeployed() : error ? chainError() : ''}
    ${configured && !error
      ? html`<nav class="tabs" aria-label="Filtrar proyectos">
          <a href="/" class="${!tab || tab === 'funding' ? 'active' : ''}">Más votados <span class="count">${funding.length}</span></a>
          <a href="/?tab=active" class="${tab === 'active' ? 'active' : ''}">Activos <span class="count">${active.length}</span></a>
          <a href="/?tab=schedule" class="${tab === 'schedule' ? 'active' : ''}">Agenda de desarrollo <span class="count">${schedule.length}</span></a>
          ${failed.length ? html`<a href="/?tab=failed" class="${tab === 'failed' ? 'active' : ''}">No financiados <span class="count">${failed.length}</span></a>` : ''}
        </nav>
        ${list.length ? html`<ul class="project-grid">${list.map(projectCard)}</ul>` : html`<div class="empty"><p>${empty[tab] || empty.funding}</p><a class="button" href="/proposals/new">Propón el primero</a></div>`}`
      : ''}`;
  return layout(ctx, { body, active: 'projects' });
}

function walletBlock(ctx) {
  const linked = ctx.user && ctx.user.wallet_address;
  return html`<div class="wallet-box" data-wallet-box>
    ${linked
      ? html`<p>Tu wallet: ${addressLink(linked)}</p>`
      : html`<p>Para invertir, votar o comprar necesitas vincular tu wallet.</p>`}
    <button type="button" class="button button-ghost button-small" data-action="connect">${linked ? 'Cambiar de wallet' : 'Conectar wallet'}</button>
  </div>`;
}

function projectPage(ctx, { project: p, meta, position, voted, epochEnds, configured, error }) {
  const user = ctx.user;
  const title = meta ? meta.title : `Proyecto #${p.id}`;
  const wei = (v) => v.toString();
  const body = html`
    <p class="back"><a href="/">← Todos los proyectos</a></p>
    <article class="project">
      <header class="project-header">
        <span class="badge badge-${p.status}">${STATUS_LABEL[p.status] || p.status}</span>
        <h1>${title}</h1>
        ${meta ? html`<p class="lead">${meta.summary}</p>` : ''}
        <p class="subtle">Publicado por ${meta ? meta.user_name : 'un usuario'} · wallet ${addressLink(p.publisher)}</p>
      </header>

      <div class="project-layout">
        <div class="project-main">
          ${meta && meta.description ? html`<div class="description">${paragraphs(meta.description)}</div>` : ''}
          <dl class="facts">
            <div><dt>Meta de financiación</dt><dd>${fmt(p.goal, 18, 0)} PHUB</dd></div>
            <div><dt>${p.status === 'funding' ? 'Conseguido' : 'Participaciones'}</dt><dd>${fmt(p.status === 'funding' ? p.raised : p.totalStake, 18, 0)} PHUB</dd></div>
            <div><dt>Precio de acceso a la app</dt><dd>${fmt(p.price)} PHUB</dd></div>
            <div><dt>${p.status === 'funding' ? 'Plazo' : 'Fecha de desarrollo'}</dt><dd>${p.status === 'funding' ? html`${timeLeft(p.deadline)}<br><span class="subtle small">hasta el ${formatLong(p.deadline).toLowerCase()}</span>` : meta && meta.development_date ? formatLong(meta.development_date).replace(/,\s*\d{2}:\d{2}$/, '') : 'Pendiente'}</dd></div>
          </dl>
          ${p.status === 'funding' ? progress(p.raised, p.goal) : ''}

          <section class="card rules">
            <h2>Reglas de este proyecto</h2>
            ${p.status === 'funding'
              ? html`<p>Invertir es votar: cada PHUB cuenta como un voto y como tu participación. Si se alcanzan ${fmt(p.goal, 18, 0)} PHUB antes de que acabe el plazo, el proyecto pasa a activo. Si no, recuperas tus tokens.</p>`
              : html`<p>Cada nueva inversión se reparte: <strong>60 %</strong> tu participación, <strong>10 %</strong> para los inversores previos, <strong>28 %</strong> para el desarrollo y <strong>2 %</strong> de comisión. Cada compra de acceso a la app reparte el <strong>95 %</strong> entre los participantes.</p>`}
          </section>

          ${p.status === 'active'
            ? html`<section class="card" aria-labelledby="vote-title">
                <h2 id="vote-title">Votación semanal del precio</h2>
                <p class="subtle">Los participantes votan cada semana cuánto sube o baja el precio de acceso. Se aplica la media ponderada por participación. Esta votación cierra el ${formatLong(epochEnds).toLowerCase()}.</p>
                ${!user
                  ? html`<p><a href="/login?returnTo=${encodeURIComponent(`/projects/${p.id}`)}">Entra</a> para votar.</p>`
                  : !position || position.stake === 0n
                    ? html`<p class="subtle">Necesitas participación en el proyecto para votar.</p>`
                    : voted
                      ? html`<p><strong>Ya has votado esta semana.</strong></p>`
                      : html`<div class="vote-options">
                          ${[50, 30, 10, 0, -10, -30, -50].map(
                            (v) => html`<button type="button" class="vote ${v > 0 ? 'up' : v < 0 ? 'down' : ''}" data-action="vote" data-project="${p.id}" data-percent="${v}">${v > 0 ? '+' : ''}${v} %</button>`
                          )}
                        </div>`}
              </section>`
            : ''}
        </div>

        <aside class="project-side">
          <div class="card">
            ${!configured ? notDeployed() : error ? chainError() : ''}
            ${!user
              ? html`<a class="button button-block" href="/login?returnTo=${encodeURIComponent(`/projects/${p.id}`)}">Entra para participar</a>`
              : html`${walletBlock(ctx)}
                ${position
                  ? html`<dl class="mini-facts">
                      <div><dt>Tu participación</dt><dd>${fmt(position.stake)} PHUB</dd></div>
                      ${p.status !== 'funding' ? html`<div><dt>Ganancias pendientes</dt><dd>${fmt(position.pending)} PHUB</dd></div>` : ''}
                    </dl>`
                  : ''}
                ${p.status === 'funding' || p.status === 'active'
                  ? html`<form class="action-form" data-action="invest" data-project="${p.id}">
                      <label for="amount">Invertir PHUB</label>
                      <div class="input-row">
                        <input id="amount" name="amount" inputmode="decimal" placeholder="${p.status === 'funding' ? 'Máx. ' + fmt(p.goal - p.raised, 18, 0) : 'Cantidad'}" required>
                        <button type="submit" class="button">Invertir</button>
                      </div>
                      <p class="hint">Tu wallet te pedirá dos firmas: autorizar los PHUB e invertirlos.</p>
                    </form>`
                  : ''}
                ${p.status === 'failed' && position && position.stake > 0n
                  ? html`<button type="button" class="button button-block" data-action="refund" data-project="${p.id}">Recuperar mis ${fmt(position.stake)} PHUB</button>`
                  : ''}
                ${position && position.pending > 0n
                  ? html`<button type="button" class="button button-ghost button-block" data-action="claim" data-project="${p.id}">Retirar ${fmt(position.pending)} PHUB de ganancias</button>`
                  : ''}`}
          </div>

          ${p.status === 'active'
            ? html`<div class="card access-card">
                <h2>Acceso a la app</h2>
                <p class="big-number">${fmt(p.price)} <span>PHUB</span></p>
                ${meta && meta.app_url ? html`<p><a href="${meta.app_url}" target="_blank" rel="noopener noreferrer">Ver la app ↗</a></p>` : ''}
                ${!user
                  ? ''
                  : position && position.hasAccess
                    ? html`<p class="ok">Ya tienes acceso a esta app.</p>`
                    : html`<button type="button" class="button button-block" data-action="buyAccess" data-project="${p.id}" data-price="${wei(p.price)}">Comprar acceso</button>`}
              </div>`
            : ''}
        </aside>
      </div>
    </article>`;
  return layout(ctx, { title, body, active: 'projects' });
}

function proposalFormPage(ctx, { data = {}, errors = {} }) {
  const field = (name) => (errors[name] ? html`<p class="field-error" id="${name}-error">${errors[name]}</p>` : '');
  const invalid = (name) => (errors[name] ? raw(` aria-invalid="true" aria-describedby="${name}-error"`) : '');
  const body = html`
    <div class="narrow">
      <p class="back"><a href="/">← Proyectos</a></p>
      <h1>Proponer un proyecto</h1>
      <p class="subtle">El equipo revisa cada propuesta. Si se acepta, se publica con 7 días para conseguir la financiación.</p>
      <form method="post" action="/proposals" class="form" novalidate>
        ${csrfField(ctx)}
        <label for="title">Nombre del proyecto</label>
        <input id="title" name="title" maxlength="120" required value="${data.title || ''}" placeholder="Ej.: Descifra, cartas oficiales explicadas"${invalid('title')}>
        ${field('title')}

        <label for="summary">Resumen en una frase</label>
        <input id="summary" name="summary" maxlength="280" required value="${data.summary || ''}" placeholder="Qué problema resuelve y para quién"${invalid('summary')}>
        ${field('summary')}

        <label for="description">Descripción <span class="optional">(opcional)</span></label>
        <textarea id="description" name="description" rows="8" maxlength="8000" placeholder="Cómo funcionaría, qué hace falta construir, por qué lo usaría la gente…"${invalid('description')}>${data.description || ''}</textarea>
        ${field('description')}

        <div class="grid-2">
          <div>
            <label for="goalTokens">Financiación necesaria (PHUB)</label>
            <input id="goalTokens" name="goalTokens" type="number" min="1000" max="100000" step="1" required value="${data.goalTokens || ''}" placeholder="1.000 – 100.000"${invalid('goalTokens')}>
            ${field('goalTokens')}
          </div>
          <div>
            <label for="initialPrice">Precio inicial de acceso (PHUB)</label>
            <input id="initialPrice" name="initialPrice" inputmode="decimal" required value="${data.initialPrice || ''}" placeholder="Ej.: 25"${invalid('initialPrice')}>
            ${field('initialPrice')}
          </div>
        </div>

        <label for="publisherAddress">Tu wallet de publicador</label>
        <input id="publisherAddress" name="publisherAddress" class="mono" required value="${data.publisherAddress || (ctx.user && ctx.user.wallet_address) || ''}" placeholder="0x…"${invalid('publisherAddress')}>
        ${field('publisherAddress')}
        <p class="hint">Dirección pública (0x…) que figurará como publicadora del proyecto.</p>

        <div class="form-actions">
          <button type="submit" class="button">Enviar propuesta</button>
          <a class="button button-ghost" href="/">Cancelar</a>
        </div>
      </form>
    </div>`;
  return layout(ctx, { title: 'Proponer un proyecto', body });
}

const PROPOSAL_STATUS = {
  pending: 'En revisión',
  approved: 'Aceptada, pendiente de publicar',
  rejected: 'Rechazada',
  published: 'Publicada',
};

function minePage(ctx, { proposals, balances, positions, configured, error }) {
  const body = html`
    <h1>Mi área</h1>
    <div class="mine-grid">
      <section class="card">
        <h2>Mi wallet</h2>
        ${walletBlock(ctx)}
        ${balances
          ? html`<dl class="mini-facts">
              <div><dt>PeopleHub</dt><dd>${fmt(balances.phub)} PHUB</dd></div>
              <div><dt>USDC</dt><dd>${fmt(balances.usdc, 6)} USDC</dd></div>
              <div><dt>ETH (para el gas)</dt><dd>${fmt(balances.eth, 18, 5)} ETH</dd></div>
            </dl>`
          : ''}
        ${!configured ? notDeployed() : error ? chainError() : ''}
        <p class="hint">Tu wallet es solo tuya: nunca te pediremos tu frase de recuperación ni tu clave privada.</p>
      </section>
      <section class="card">
        <h2>Mis inversiones</h2>
        ${positions && positions.length
          ? html`<ul class="plain-list">${positions.map(
              (x) => html`<li><a href="/projects/${x.project.id}">${x.meta ? x.meta.title : `Proyecto #${x.project.id}`}</a><span>${fmt(x.position.stake)} PHUB${x.position.pending > 0n ? html` · <strong>${fmt(x.position.pending)} por retirar</strong>` : ''}</span></li>`
            )}</ul>`
          : html`<p class="subtle">Aún no has invertido en ningún proyecto.</p>`}
      </section>
    </div>
    <section class="card">
      <h2>Mis propuestas</h2>
      ${proposals.length
        ? html`<ul class="plain-list">${proposals.map(
            (pr) => html`<li>
              ${pr.onchain_id ? html`<a href="/projects/${pr.onchain_id}">${pr.title}</a>` : html`<span>${pr.title}</span>`}
              <span class="badge badge-${pr.status}">${PROPOSAL_STATUS[pr.status]}</span>
              ${pr.admin_note ? html`<span class="subtle small">${pr.admin_note}</span>` : ''}
            </li>`
          )}</ul>`
        : html`<p class="subtle">No has enviado propuestas.</p>`}
      <p><a class="button button-small" href="/proposals/new">Proponer un proyecto</a></p>
    </section>
    <form method="post" action="/logout">${csrfField(ctx)}<button type="submit" class="button button-ghost button-small">Cerrar sesión</button></form>`;
  return layout(ctx, { title: 'Mi área', body, active: 'mine' });
}

function buyPage(ctx, { sale, configured, error }) {
  const body = html`
    <div class="narrow">
      <h1>Comprar PeopleHub (PHUB)</h1>
      <p class="lead">Los PHUB se pagan con USDC en ${chain.NETWORK.name} y llegan directamente a tu wallet.</p>
      ${!configured ? notDeployed() : error ? chainError() : ''}
      ${sale && !sale.enabled
        ? html`<div class="notice"><strong>La venta de PHUB todavía no está abierta.</strong> Se activará cuando esté lista la parte legal. Mientras tanto puedes proponer proyectos.</div>`
        : ''}
      ${sale && sale.enabled
        ? html`<div class="card">
            <p>Precio: <strong>${fmt(sale.priceUsdcPerToken, 6, 4)} USDC</strong> por PHUB.</p>
            ${!ctx.user
              ? html`<a class="button" href="/login?returnTo=/comprar">Entra para comprar</a>`
              : html`${walletBlock(ctx)}
                <form class="action-form" data-action="buyPhub" data-price="${sale.priceUsdcPerToken.toString()}">
                  <label for="phub">¿Cuántos PHUB quieres?</label>
                  <div class="input-row">
                    <input id="phub" name="amount" inputmode="decimal" required placeholder="Ej.: 1000">
                    <button type="submit" class="button">Comprar</button>
                  </div>
                  <p class="hint" data-quote>Tu wallet te pedirá dos firmas: autorizar los USDC y comprar.</p>
                </form>`}
          </div>`
        : ''}
      <p class="subtle small">Comprar criptoactivos conlleva riesgo de pérdida total. Lee los <a href="/como-funciona#riesgos">riesgos</a> antes de comprar.</p>
    </div>`;
  return layout(ctx, { title: 'Comprar PHUB', body, active: 'buy' });
}

function adminPage(ctx, { pending, approved, published, items, owner, configured }) {
  const byOnchain = new Map(items.map((i) => [i.project.id, i.project]));
  const body = html`
    <h1>Administración</h1>
    ${!configured ? notDeployed() : ''}
    ${owner ? html`<p class="subtle">Wallet administradora de los contratos: ${addressLink(owner)}. Para publicar proyectos debes conectar esa wallet.</p>` : ''}

    <section class="card">
      <h2>Propuestas por revisar <span class="count">${pending.length}</span></h2>
      ${pending.length
        ? pending.map(
            (pr) => html`<div class="admin-item">
              <h3>${pr.title}</h3>
              <p>${pr.summary}</p>
              ${pr.description ? html`<details><summary>Descripción</summary>${paragraphs(pr.description)}</details>` : ''}
              <p class="subtle small">De ${pr.user_name} · meta ${pr.goal_tokens.toLocaleString('es-ES')} PHUB · precio inicial ${pr.initial_price} PHUB · wallet ${addressLink(pr.publisher_address)}</p>
              <form method="post" action="/admin/proposals/${pr.id}/decide" class="admin-form">
                ${csrfField(ctx)}
                <input name="note" maxlength="300" placeholder="Nota para quien propone (opcional)">
                <button name="decision" value="approved" class="button button-small">Aceptar</button>
                <button name="decision" value="rejected" class="button button-small button-ghost">Rechazar</button>
              </form>
            </div>`
          )
        : html`<p class="subtle">No hay propuestas pendientes.</p>`}
    </section>

    <section class="card">
      <h2>Aceptadas, por publicar en la blockchain <span class="count">${approved.length}</span></h2>
      ${approved.length
        ? approved.map(
            (pr) => html`<div class="admin-item">
              <h3>${pr.title}</h3>
              <p class="subtle small">Meta ${pr.goal_tokens.toLocaleString('es-ES')} PHUB · precio ${pr.initial_price} PHUB · publicador ${addressLink(pr.publisher_address)}</p>
              ${configured
                ? html`<form class="action-form admin-form" data-action="createProject" data-proposal="${pr.id}" data-publisher="${pr.publisher_address}" data-goal="${pr.goal_tokens}" data-price="${pr.initial_price}">
                    <input name="devWallet" class="mono" required placeholder="Wallet de desarrollo 0x…" value="${owner || ''}" aria-label="Wallet de desarrollo">
                    <button type="submit" class="button button-small">Publicar (7 días de financiación)</button>
                  </form>`
                : ''}
            </div>`
          )
        : html`<p class="subtle">Nada pendiente de publicar.</p>`}
    </section>

    <section class="card">
      <h2>Proyectos publicados</h2>
      ${published.length
        ? published.map((pr) => {
            const p = byOnchain.get(pr.onchain_id);
            return html`<div class="admin-item">
              <h3><a href="/projects/${pr.onchain_id}">${pr.title}</a> ${p ? html`<span class="badge badge-${p.status}">${STATUS_LABEL[p.status]}</span>` : ''}</h3>
              <form method="post" action="/admin/proposals/${pr.id}/development" class="admin-form">
                ${csrfField(ctx)}
                <label class="small">Fecha de desarrollo <input type="date" name="developmentDate" value="${pr.development_date ? new Date(pr.development_date).toISOString().slice(0, 10) : ''}"></label>
                <label class="small">URL de la app <input type="url" name="appUrl" value="${pr.app_url || ''}" placeholder="https://…"></label>
                <button class="button button-small button-ghost">Guardar</button>
              </form>
            </div>`;
          })
        : html`<p class="subtle">Aún no hay proyectos publicados.</p>`}
    </section>`;
  return layout(ctx, { title: 'Administración', body, active: 'admin' });
}

function howPage(ctx) {
  const body = html`
    <div class="narrow prose">
      <h1>Cómo funciona PeopleHub Fund</h1>
      <p class="lead">Una forma abierta de decidir qué apps construye theaipeoplehub y de participar en lo que generan.</p>
      <ol class="steps-list">
        <li><strong>Propón.</strong> Cualquiera puede proponer un proyecto con su meta de financiación (entre 1.000 y 100.000 PHUB) y el precio inicial de la app.</li>
        <li><strong>Revisión.</strong> El equipo acepta las propuestas viables y las publica: desde ese momento hay 7 días para financiarlas.</li>
        <li><strong>Invierte y vota.</strong> Cada PHUB invertido es un voto. Si se alcanza la meta, el proyecto pasa a activo y los tokens se destinan al desarrollo. Si no, cada inversor recupera los suyos.</li>
        <li><strong>Proyecto activo.</strong> Se puede seguir invirtiendo. Cada inversión se reparte: 60 % tu participación, 10 % para los inversores previos, 28 % para el desarrollo y 2 % de comisión.</li>
        <li><strong>La app sale a la venta.</strong> Quien compra el acceso paga en PHUB: el 95 % se reparte entre los participantes y el 5 % es comisión.</li>
        <li><strong>Precio semanal.</strong> Cada semana los participantes votan si el precio sube o baja (+50, +30, +10, 0, −10, −30 o −50 %). Se aplica la media ponderada por participación.</li>
      </ol>
      <h2>Tu wallet</h2>
      <p>Cada operación con tokens la firmas tú desde tu wallet. theaipeoplehub nunca tiene acceso a tus fondos ni a tus claves. Las reglas están escritas en contratos públicos que cualquiera puede revisar.</p>
      <h2 id="riesgos">Riesgos</h2>
      <ul>
        <li>El valor de PHUB puede bajar o llegar a cero. Invierte solo lo que puedas permitirte perder.</li>
        <li>Un proyecto puede no salir adelante o no generar ventas, y entonces no habrá ganancias que repartir.</li>
        <li>La participación del 60 % queda bloqueada en el contrato: no se puede retirar.</li>
        <li>Las operaciones en blockchain son irreversibles. Si pierdes el acceso a tu wallet, nadie puede recuperarlo por ti.</li>
        <li>La regulación de los criptoactivos está cambiando y puede afectar al servicio.</li>
      </ul>
    </div>`;
  return layout(ctx, { title: 'Cómo funciona', body, active: 'how' });
}

function errorPage(ctx, { status, message }) {
  const body = html`<div class="empty"><h1>${status === 404 ? 'No encontrado' : 'Algo ha fallado'}</h1><p>${message}</p><a class="button" href="/">Volver</a></div>`;
  return layout(ctx, { title: 'Error', body });
}

module.exports = { homePage, projectPage, proposalFormPage, minePage, buyPage, adminPage, howPage, errorPage };
