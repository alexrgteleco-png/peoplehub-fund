# PeopleHub Fund

Financiación pública de proyectos de [theaipeoplehub](https://theaipeoplehub.com) con el token
**PeopleHub (PHUB)** en la red **Base**.

> **Estado:** contratos en desarrollo y pruebas. La venta de tokens está **desactivada** por defecto y
> no debe activarse en la red principal hasta contar con asesoramiento legal (MiCA / CNMV) y una
> auditoría independiente de los contratos.

## Contratos (`contracts/`)

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
