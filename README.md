# PeopleHub Fund

La fábrica de apps de [theaipeoplehub](https://theaipeoplehub.com): quien tiene una idea y quien sabe
desarrollarla trabajan juntos, y la comunidad decide qué se construye. Las apps terminadas (como
WhatWhenAndWhere) se publican en la plataforma.

## Fase 1 (actual): créditos internos, sin blockchain

- Todo funciona con **créditos a precio unitario**: 1 crédito = 1 voto = 1 unidad de participación.
- Los créditos **no se compran ni se canjean por dinero**: no son un activo financiero. Cada usuario
  recibe `WELCOME_CREDITS` al registrarse (1.000 por defecto) y la administración puede conceder más.
- Cada cambio de saldo queda en un libro de movimientos (`fund.ledger`); las operaciones bloquean el
  proyecto dentro de una transacción para que los saldos nunca se descuadren.

### Ciclo de un proyecto

1. **Crear:** meta (1.000–100.000 créditos), precio inicial de acceso a la app, periodo de desarrollo
   (7–365 días) y cómo se elige el desarrollador: **invitar por email** o **candidatura abierta**
   (días de candidatura y votos necesarios).
2. **Revisión:** la administración acepta o rechaza. Al aceptar empiezan 7 días de financiación y la
   selección de desarrollador.
3. **Financiación:** cada crédito aportado es un voto y una participación. Si se llega a la meta, el
   proyecto pasa a activo; si no, se devuelve todo automáticamente.
4. **Desarrollador (único):** en candidatura, cada voto cuesta 1 crédito (va a la plataforma) y cada
   usuario vota una vez; el primero que llega a los votos fijados queda elegido al momento. Si nadie
   llega, al vencer gana el más votado. Su periodo empieza cuando el proyecto está activo: recibe la
   financiación y el 28 % de cada nueva inversión. Al terminar, el creador puede elegir otro.
5. **Proyecto activo:** cada inversión se reparte 60 % participación · 10 % inversores previos ·
   28 % desarrollo · 2 % comisión. Cada compra de acceso a la app: 95 % participantes · 5 % comisión.
6. **Precio semanal:** los participantes votan +50/+30/+10/0/−10/−30/−50 %; se aplica la media
   ponderada por participación al empezar la semana siguiente.

### Ranking de desarrolladores

ELO (base 1.500) actualizado al instante: sube con apoyos y ventas de sus proyectos, con los votos de
sus candidaturas y al ganar una elección (duelo contra cada candidato con votos); baja si pierde una
elección o si su proyecto no se financia.

### Rutas

| Ruta | Contenido |
| --- | --- |
| `/` | Proyectos más apoyados, activos y no financiados |
| `/projects/new` | Crear proyecto |
| `/projects/:id` | Detalle: apoyar/invertir, candidatos y votos, invitación, precio, acceso a la app |
| `/mine` | Saldo, movimientos, proyectos, apoyos, candidaturas e invitaciones |
| `/desarrolladores` | Ranking ELO |
| `/admin` | Revisar proyectos, conceder créditos, resumen |
| `/como-funciona` | Reglas |

### Variables de entorno

| Variable | Para qué |
| --- | --- |
| `DATABASE_URL`, `SESSION_SECRET` | Base de datos (esquema `fund`) y sesiones |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Login único con Keycloak |
| `ADMIN_EMAILS` | Emails con acceso a `/admin` (separados por comas) |
| `WELCOME_CREDITS` | Créditos de bienvenida (1.000 por defecto) |
| `PLATFORM_URL` | Enlaces al portal y textos legales |

## Fase 2 (futura): tokenización

Está previsto convertir los créditos en el token PeopleHub (PHUB) en la red Base cuando exista el marco
legal adecuado (MiCA / CNMV, posible licencia de financiación participativa) y una auditoría de los
contratos. Todo lo de esa fase está en `contracts/`: los contratos Solidity con sus pruebas, el script
de despliegue y el código web de wallet (`contracts/web/`). Las pruebas siguen ejecutándose en GitHub
Actions para que no se queden obsoletos.

## Contratos de la fase 2 (`contracts/`)

| Contrato | Qué hace |
| --- | --- |
| `PeopleHubToken` | ERC-20 «PeopleHub» (PHUB) con suministro fijo de 100.000.000 emitido una vez a la wallet del propietario. Sin emisión posterior. |
| `PeopleHubSale` | Venta de PHUB a cambio de USDC. Los PHUB salen de la tesorería del propietario y los USDC van a ella. Nace desactivada. |
| `PeopleHubProjects` | Financiación de proyectos, repartos, compra de acceso a apps y votación semanal de precio. |

### Reglas de `PeopleHubProjects`

1. **Alta:** el admin acepta una propuesta y crea el proyecto con la meta elegida por el publicador
   (1.000–100.000 PHUB) y el precio inicial de la app. Se abre un plazo de **7 días**.
2. **Financiación:** invertir es votar; cada PHUB cuenta íntegro como participación. Si se llega a la
   meta, el proyecto pasa a **Activo** y la meta va a la wallet de desarrollo. Si no, cada inversor
   **recupera** sus tokens con `claimRefund`.
3. **Inversión en proyecto activo:** 60 % participación del inversor (bloqueada), 10 % inversores
   previos, 28 % desarrollo, 2 % comisión.
4. **Compra de acceso a la app:** 5 % comisión, 95 % repartido entre participantes.
5. **Precio semanal:** los participantes votan +50, +30, +10, 0, −10, −30 o −50 %. Se aplica la
   media ponderada por participación. Precio mínimo: 0,01 PHUB.
6. **Seguridad:** el admin puede pausar inversiones, compras y votos; los reembolsos y la retirada
   de recompensas siguen disponibles siempre.

Las pruebas (`contracts/test`) se ejecutan en GitHub Actions en cada cambio.

### Desplegar en Base Sepolia (testnet)

```bash
cd contracts
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
OWNER_ADDRESS=0xTU_WALLET \
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast --private-key $DEPLOYER_KEY
```

`DEPLOYER_KEY` es una wallet desechable con un poco de ETH de testnet para el gas; nunca uses la clave
de tu wallet principal en un terminal. Comprueba la dirección de USDC en la documentación de Circle
antes de desplegar.
