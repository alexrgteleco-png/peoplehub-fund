// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PeopleHubToken} from "../src/PeopleHubToken.sol";
import {PeopleHubSale} from "../src/PeopleHubSale.sol";
import {PeopleHubProjects} from "../src/PeopleHubProjects.sol";

/// @notice Despliega los tres contratos.
///
/// Variables de entorno:
///   OWNER_ADDRESS        tu wallet: recibe los 100M PHUB, es admin y tesorería (obligatoria)
///   USDC_ADDRESS         dirección de USDC en la red elegida (obligatoria)
///   SALE_PRICE_USDC      precio en unidades de USDC (6 decimales) por 1 PHUB; por defecto 10000 = 0,01 USDC
///
/// La wallet que firma el despliegue solo paga el gas: no recibe tokens ni permisos.
/// Ejemplo (Base Sepolia):
///   forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    function run() external {
        address owner = vm.envAddress("OWNER_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 price = vm.envOr("SALE_PRICE_USDC", uint256(10_000));

        vm.startBroadcast();
        PeopleHubToken phub = new PeopleHubToken(owner);
        PeopleHubSale sale = new PeopleHubSale(owner, phub, IERC20(usdc), owner, price);
        PeopleHubProjects projects = new PeopleHubProjects(owner, phub, owner);
        vm.stopBroadcast();

        console2.log("PHUB (PeopleHubToken):", address(phub));
        console2.log("PeopleHubSale:        ", address(sale));
        console2.log("PeopleHubProjects:    ", address(projects));
        console2.log("Propietario y tesoreria:", owner);
        console2.log("La venta queda DESACTIVADA. Para venderla, la tesoreria debe aprobar PHUB a PeopleHubSale.");
    }
}
