// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title PeopleHub (PHUB)
/// @notice Token de theaipeoplehub. Suministro fijo de 100.000.000 PHUB emitido
///         una sola vez a la wallet del propietario. No existe función de emisión
///         adicional: nadie puede crear más tokens después del despliegue.
contract PeopleHubToken is ERC20, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 100_000_000 ether;

    constructor(address initialHolder) ERC20("PeopleHub", "PHUB") ERC20Permit("PeopleHub") {
        require(initialHolder != address(0), "PHUB: holder cero");
        _mint(initialHolder, TOTAL_SUPPLY);
    }
}
