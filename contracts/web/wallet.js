// PeopleHub Fund · conexión con la wallet del usuario (EIP-1193) y firma de operaciones.
// Funciona con cualquier wallet que inyecte window.ethereum (MetaMask, Coinbase Wallet, Rabby…).
// Un proveedor de wallets integradas (p. ej. Privy) expone la misma interfaz y puede sustituirla.
(function () {
  'use strict';

  var configEl = document.getElementById('chain-config');
  if (!configEl) return;
  var CFG = JSON.parse(configEl.textContent);
  var statusEl = document.getElementById('tx-status');
  var UNIT = 10n ** 18n;

  // ---------------------------------------------------------------- utilidades
  function setStatus(message, type) {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || '';
    statusEl.className = 'tx-status' + (type ? ' tx-' + type : '');
    if (message) statusEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function toUnits(text, decimals) {
    var clean = String(text).trim().replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error('Escribe una cantidad válida.');
    var parts = clean.split('.');
    var frac = (parts[1] || '');
    if (frac.length > decimals) throw new Error('Demasiados decimales.');
    return BigInt(parts[0]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  }

  function formatUnits(v, decimals, maxFrac) {
    var base = 10n ** BigInt(decimals);
    var ints = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    var frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
    return ints + (frac ? ',' + frac : '');
  }

  function word(v) {
    var n = BigInt(v);
    if (n < 0n) n = (1n << 256n) + n; // complemento a dos para int256
    return n.toString(16).padStart(64, '0');
  }

  function addr(a) {
    return String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  }

  function data(name, args) {
    return CFG.selectors[name] + (args || []).map(function (a) {
      return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? addr(a) : word(a);
    }).join('');
  }

  function provider() {
    if (window.ethereum) return window.ethereum;
    throw new Error('No se ha encontrado ninguna wallet en este navegador. Instala Coinbase Wallet o MetaMask y recarga la página.');
  }

  async function ensureChain(eth) {
    var current = await eth.request({ method: 'eth_chainId' });
    if (current.toLowerCase() === CFG.chainId.toLowerCase()) return;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.chainId }] });
    } catch (err) {
      if (err && err.code === 4902) {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CFG.chainId,
            chainName: CFG.networkName,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [CFG.rpc],
            blockExplorerUrls: CFG.explorer ? [CFG.explorer] : [],
          }],
        });
      } else {
        throw new Error('Cambia tu wallet a la red ' + CFG.networkName + '.');
      }
    }
  }

  async function account() {
    var eth = provider();
    var accounts = await eth.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) throw new Error('La wallet no ha compartido ninguna cuenta.');
    await ensureChain(eth);
    var from = accounts[0].toLowerCase();
    if (CFG.linkedWallet && CFG.linkedWallet.toLowerCase() !== from) {
      throw new Error('Tu wallet activa (' + from.slice(0, 6) + '…) no es la vinculada a tu cuenta. Cámbiala en la wallet o pulsa «Cambiar de wallet».');
    }
    return { eth: eth, from: from };
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function sendTx(ctx, to, callData, label) {
    setStatus(label + ': confirma la operación en tu wallet…', 'pending');
    var hash = await ctx.eth.request({ method: 'eth_sendTransaction', params: [{ from: ctx.from, to: to, data: callData }] });
    setStatus(label + ': esperando confirmación de la red…', 'pending');
    for (var i = 0; i < 90; i++) {
      var receipt = await ctx.eth.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (receipt) {
        if (receipt.status !== '0x1') throw new Error(label + ': la operación ha fallado en la blockchain.');
        return hash;
      }
      await sleep(2000);
    }
    throw new Error(label + ': la red está tardando. Revisa tu wallet y recarga la página en un rato.');
  }

  async function post(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(Object.assign({ _csrf: CFG.csrf }, body)),
    });
    var json = {};
    try { json = await res.json(); } catch (e) { /* respuesta vacía */ }
    if (!res.ok && res.status !== 202) throw new Error(json.error || 'Error del servidor (' + res.status + ').');
    return { status: res.status, body: json };
  }

  function explain(err) {
    if (err && (err.code === 4001 || /reject|denied/i.test(err.message || ''))) return 'Has cancelado la operación en tu wallet.';
    return (err && err.message) || 'Ha ocurrido un error.';
  }

  // ---------------------------------------------------------------- acciones
  var A = CFG.addresses;

  var actions = {
    connect: async function () {
      var eth = provider();
      setStatus('Conectando con tu wallet…', 'pending');
      var accounts = await eth.request({ method: 'eth_requestAccounts' });
      await ensureChain(eth);
      await post('/wallet', { address: accounts[0] });
      setStatus('Wallet vinculada. Actualizando…', 'ok');
      location.reload();
    },

    invest: async function (el, form) {
      var amount = toUnits(form.amount.value, 18);
      if (amount <= 0n) throw new Error('La cantidad debe ser mayor que cero.');
      var ctx = await account();
      await sendTx(ctx, A.phub, data('approve', [A.projects, amount]), 'Paso 1 de 2 · autorizar PHUB');
      await sendTx(ctx, A.projects, data('invest', [el.dataset.project, amount]), 'Paso 2 de 2 · invertir');
      return 'Inversión realizada.';
    },

    refund: async function (el) {
      var ctx = await account();
      await sendTx(ctx, A.projects, data('claimRefund', [el.dataset.project]), 'Recuperar tokens');
      return 'Tokens recuperados.';
    },

    claim: async function (el) {
      var ctx = await account();
      await sendTx(ctx, A.projects, data('claimRewards', [el.dataset.project]), 'Retirar ganancias');
      return 'Ganancias retiradas a tu wallet.';
    },

    buyAccess: async function (el) {
      var price = BigInt(el.dataset.price);
      var ctx = await account();
      await sendTx(ctx, A.phub, data('approve', [A.projects, price]), 'Paso 1 de 2 · autorizar PHUB');
      await sendTx(ctx, A.projects, data('buyAccess', [el.dataset.project, price]), 'Paso 2 de 2 · comprar acceso');
      return 'Ya tienes acceso a la app.';
    },

    vote: async function (el) {
      var ctx = await account();
      await sendTx(ctx, A.projects, data('votePrice', [el.dataset.project, BigInt(el.dataset.percent)]), 'Votar precio');
      return 'Voto registrado. ¡Gracias por participar!';
    },

    buyPhub: async function (el, form) {
      var amount = toUnits(form.amount.value, 18);
      if (amount <= 0n) throw new Error('La cantidad debe ser mayor que cero.');
      var price = BigInt(el.dataset.price);
      var cost = (amount * price + UNIT - 1n) / UNIT;
      if (!confirm('Vas a pagar ' + formatUnits(cost, 6, 2) + ' USDC por ' + formatUnits(amount, 18, 2) + ' PHUB. ¿Continuar?')) return null;
      var ctx = await account();
      await sendTx(ctx, A.usdc, data('approve', [A.sale, cost]), 'Paso 1 de 2 · autorizar USDC');
      await sendTx(ctx, A.sale, data('buy', [amount, cost]), 'Paso 2 de 2 · comprar PHUB');
      return 'Compra realizada: los PHUB ya están en tu wallet.';
    },

    createProject: async function (el, form) {
      var dev = form.devWallet.value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(dev)) throw new Error('La wallet de desarrollo no es una dirección válida.');
      var goal = BigInt(el.dataset.goal) * UNIT;
      var price = toUnits(el.dataset.price, 18);
      var eth = provider();
      var accounts = await eth.request({ method: 'eth_requestAccounts' });
      await ensureChain(eth);
      var ctx = { eth: eth, from: accounts[0].toLowerCase() };
      var hash = await sendTx(ctx, A.projects, data('createProject', [el.dataset.publisher, goal, price, dev]), 'Publicar proyecto');
      setStatus('Registrando el proyecto…', 'pending');
      for (var i = 0; i < 20; i++) {
        var r = await post('/admin/proposals/' + el.dataset.proposal + '/link', { txHash: hash });
        if (r.status !== 202) {
          location.href = '/projects/' + r.body.onchainId;
          return null;
        }
        await sleep(2000);
      }
      throw new Error('El proyecto se creó, pero no se pudo registrar. Recarga la página.');
    },
  };

  async function run(name, el, form) {
    var buttons = (form || el).querySelectorAll ? (form || el).querySelectorAll('button') : [];
    var all = [el].concat(Array.prototype.slice.call(buttons));
    all.forEach(function (b) { if (b && 'disabled' in b) b.disabled = true; });
    try {
      var message = await actions[name](el, form);
      if (message) {
        setStatus(message + ' Actualizando…', 'ok');
        setTimeout(function () { location.reload(); }, 1200);
      } else {
        setStatus('', null);
      }
    } catch (err) {
      setStatus(explain(err), 'error');
    } finally {
      all.forEach(function (b) { if (b && 'disabled' in b) b.disabled = false; });
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('button[data-action]');
    if (!el || !actions[el.dataset.action]) return;
    e.preventDefault();
    if (!CFG.configured && el.dataset.action !== 'connect') {
      setStatus('Los contratos todavía no están desplegados.', 'error');
      return;
    }
    run(el.dataset.action, el, null);
  });

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-action]');
    if (!form || !actions[form.dataset.action]) return;
    e.preventDefault();
    if (!CFG.configured) {
      setStatus('Los contratos todavía no están desplegados.', 'error');
      return;
    }
    run(form.dataset.action, form, form);
  });

  // Presupuesto en vivo en la página de compra.
  var buyForm = document.querySelector('form[data-action="buyPhub"]');
  if (buyForm) {
    var quote = buyForm.querySelector('[data-quote]');
    buyForm.amount.addEventListener('input', function () {
      try {
        var amount = toUnits(buyForm.amount.value || '0', 18);
        var cost = (amount * BigInt(buyForm.dataset.price) + UNIT - 1n) / UNIT;
        quote.textContent = 'Pagarás ' + formatUnits(cost, 6, 2) + ' USDC. Tu wallet te pedirá dos firmas.';
      } catch (err) {
        quote.textContent = 'Escribe una cantidad válida.';
      }
    });
  }
})();
