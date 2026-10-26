// Comprueba que los selectores que usa la web (lib/chain.js) existen en los contratos compilados.
// Uso (desde contracts/, tras forge build): node script/check-selectors.js
const { execSync } = require('child_process');
const path = require('path');
const { SELECTORS } = require(path.join(__dirname, '..', 'web', 'chain.js'));
const ids = {};
for (const c of ['PeopleHubToken', 'PeopleHubSale', 'PeopleHubProjects']) {
  const out = JSON.parse(execSync(`forge inspect ${c} methodIdentifiers --json`, { encoding: 'utf8' }));
  for (const [sig, id] of Object.entries(out)) ids['0x' + id] = sig;
}
let failed = 0;
for (const [name, sel] of Object.entries(SELECTORS)) {
  if (ids[sel]) console.log(`OK    ${name.padEnd(18)} ${sel} ${ids[sel]}`);
  else { console.log(`FALTA ${name.padEnd(18)} ${sel}`); failed++; }
}
process.exit(failed ? 1 : 0);
