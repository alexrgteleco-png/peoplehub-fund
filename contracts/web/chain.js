'use strict';

// Lectura de los contratos PeopleHub mediante JSON-RPC, sin dependencias externas.
// Las escrituras (invertir, votar, comprar) las firma cada usuario en su wallet desde el navegador.

const { keccak256 } = require('./keccak');

const CHAIN_ID = Number(process.env.CHAIN_ID || 84532); // Base Sepolia por defecto
const CHAINS = {
  84532: { name: 'Base Sepolia (pruebas)', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', testnet: true },
  8453: { name: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', testnet: false },
};
const NETWORK = CHAINS[CHAIN_ID] || { name: `Red ${CHAIN_ID}`, rpc: '', explorer: '', testnet: true };
const RPC_URL = process.env.RPC_URL || NETWORK.rpc;

const ADDRESSES = {
  phub: (process.env.PHUB_ADDRESS || '').toLowerCase(),
  sale: (process.env.SALE_ADDRESS || '').toLowerCase(),
  projects: (process.env.PROJECTS_ADDRESS || '').toLowerCase(),
  usdc: (process.env.USDC_ADDRESS || (CHAIN_ID === 8453 ? '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' : '0x036cbd53842c5426634e7929541ec2318f3dcf7e')).toLowerCase(),
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (a) => ADDRESS_RE.test(String(a || ''));

function isConfigured() {
  return Boolean(RPC_URL && isAddress(ADDRESSES.phub) && isAddress(ADDRESSES.sale) && isAddress(ADDRESSES.projects));
}

function selector(signature) {
  return '0x' + keccak256(Buffer.from(signature)).subarray(0, 4).toString('hex');
}

function topic(signature) {
  return '0x' + keccak256(Buffer.from(signature)).toString('hex');
}

// Firmas usadas por el servidor (lectura) y por el navegador (escritura).
const SIGNATURES = {
  // PHUB / USDC (ERC-20)
  balanceOf: 'balanceOf(address)',
  approve: 'approve(address,uint256)',
  allowance: 'allowance(address,address)',
  // Venta
  salesEnabled: 'salesEnabled()',
  priceUsdcPerToken: 'priceUsdcPerToken()',
  buy: 'buy(uint256,uint256)',
  // Proyectos
  projectCount: 'projectCount()',
  getProject: 'getProject(uint256)',
  statusOf: 'statusOf(uint256)',
  positions: 'positions(uint256,address)',
  pendingRewards: 'pendingRewards(uint256,address)',
  hasAccess: 'hasAccess(uint256,address)',
  hasVoted: 'hasVoted(uint256,uint64,address)',
  currentEpoch: 'currentEpoch()',
  owner: 'owner()',
  createProject: 'createProject(address,uint256,uint256,address)',
  invest: 'invest(uint256,uint256)',
  claimRefund: 'claimRefund(uint256)',
  claimRewards: 'claimRewards(uint256)',
  buyAccess: 'buyAccess(uint256,uint256)',
  votePrice: 'votePrice(uint256,int256)',
  finalizePriceVote: 'finalizePriceVote(uint256)',
};

const SELECTORS = Object.fromEntries(Object.entries(SIGNATURES).map(([k, s]) => [k, selector(s)]));
const TOPIC_PROJECT_CREATED = topic('ProjectCreated(uint256,address,uint256,uint256,uint64)');

const STATUS = ['none', 'funding', 'active', 'failed'];

// ---------- codificación ABI (solo tipos estáticos) ----------
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const encUint = (v) => word(BigInt(v).toString(16));
const encAddress = (a) => word(String(a).toLowerCase().replace(/^0x/, ''));

function encodeCall(name, args = []) {
  const types = SIGNATURES[name].match(/\((.*)\)/)[1].split(',').filter(Boolean);
  const data = types.map((t, i) => (t === 'address' ? encAddress(args[i]) : encUint(args[i]))).join('');
  return SELECTORS[name] + data;
}

function words(hex) {
  const clean = String(hex || '0x').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) out.push(clean.slice(i, i + 64));
  return out;
}

const decUint = (w) => BigInt('0x' + w);
const decInt = (w) => {
  const v = BigInt('0x' + w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
};
const decAddress = (w) => '0x' + w.slice(24);
const decBool = (w) => BigInt('0x' + w) !== 0n;

// ---------- RPC ----------
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result;
}

async function call(to, name, args) {
  return rpc('eth_call', [{ to, data: encodeCall(name, args) }, 'latest']);
}

// ---------- lecturas de alto nivel ----------
async function projectCount() {
  return Number(decUint(words(await call(ADDRESSES.projects, 'projectCount'))[0]));
}

async function getProject(id) {
  const [w, statusWords] = await Promise.all([
    call(ADDRESSES.projects, 'getProject', [id]).then(words),
    call(ADDRESSES.projects, 'statusOf', [id]).then(words),
  ]);
  if (w.length < 12) return null;
  const p = {
    id,
    publisher: decAddress(w[0]),
    devWallet: decAddress(w[1]),
    storedStatus: STATUS[Number(decUint(w[2]))],
    status: STATUS[Number(decUint(statusWords[0]))],
    deadline: new Date(Number(decUint(w[3])) * 1000),
    goal: decUint(w[4]),
    raised: decUint(w[5]),
    totalStake: decUint(w[6]),
    price: decUint(w[8]),
    voteEpoch: Number(decUint(w[9])),
    voteWeightedSum: decInt(w[10]),
    voteTotalWeight: decUint(w[11]),
  };
  if (p.status === 'none') return null;
  return p;
}

async function listProjects() {
  const count = await projectCount();
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const projects = await Promise.all(ids.map((id) => getProject(id)));
  return projects.filter(Boolean);
}

async function position(id, account) {
  const [pos, pending, access] = await Promise.all([
    call(ADDRESSES.projects, 'positions', [id, account]).then(words),
    call(ADDRESSES.projects, 'pendingRewards', [id, account]).then(words),
    call(ADDRESSES.projects, 'hasAccess', [id, account]).then(words),
  ]);
  return { stake: decUint(pos[0]), pending: decUint(pending[0]), hasAccess: decBool(access[0]) };
}

async function hasVoted(id, epoch, account) {
  return decBool(words(await call(ADDRESSES.projects, 'hasVoted', [id, epoch, account]))[0]);
}

async function currentEpoch() {
  return Number(decUint(words(await call(ADDRESSES.projects, 'currentEpoch'))[0]));
}

async function balances(account) {
  const [phub, usdc, eth] = await Promise.all([
    call(ADDRESSES.phub, 'balanceOf', [account]).then((r) => decUint(words(r)[0])),
    call(ADDRESSES.usdc, 'balanceOf', [account]).then((r) => decUint(words(r)[0])).catch(() => 0n),
    rpc('eth_getBalance', [account, 'latest']).then((r) => BigInt(r)),
  ]);
  return { phub, usdc, eth };
}

async function saleInfo() {
  const [enabled, price] = await Promise.all([
    call(ADDRESSES.sale, 'salesEnabled').then((r) => decBool(words(r)[0])),
    call(ADDRESSES.sale, 'priceUsdcPerToken').then((r) => decUint(words(r)[0])),
  ]);
  return { enabled, priceUsdcPerToken: price };
}

async function projectsOwner() {
  return decAddress(words(await call(ADDRESSES.projects, 'owner'))[0]);
}

// Comprueba en la blockchain que una transacción creó un proyecto y devuelve su id y datos.
async function readProjectCreated(txHash) {
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) return { pending: true };
  if (receipt.status !== '0x1') throw new Error('La transacción falló en la blockchain.');
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === ADDRESSES.projects && l.topics[0] === TOPIC_PROJECT_CREATED
  );
  if (!log) throw new Error('La transacción no creó ningún proyecto.');
  const data = words(log.data);
  return {
    id: Number(BigInt(log.topics[1])),
    publisher: decAddress(log.topics[2].replace(/^0x/, '')),
    goal: decUint(data[0]),
    price: decUint(data[1]),
  };
}

// ---------- formato ----------
const UNIT = 10n ** 18n;

function toUnits(text, decimals = 18) {
  const clean = String(text).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error('Cantidad no válida');
  const [ints, frac = ''] = clean.split('.');
  if (frac.length > decimals) throw new Error('Demasiados decimales');
  return BigInt(ints) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
}

function formatUnits(value, decimals = 18, maxFraction = 2) {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const ints = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  const intText = ints.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '−' : ''}${intText}${frac ? ',' + frac : ''}`;
}

module.exports = {
  CHAIN_ID,
  NETWORK,
  RPC_URL,
  ADDRESSES,
  SELECTORS,
  STATUS,
  UNIT,
  isAddress,
  isConfigured,
  encodeCall,
  listProjects,
  getProject,
  position,
  hasVoted,
  currentEpoch,
  balances,
  saleInfo,
  projectsOwner,
  readProjectCreated,
  toUnits,
  formatUnits,
};
