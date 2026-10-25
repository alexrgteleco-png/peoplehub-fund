// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Venta de PHUB a cambio de USDC
/// @notice Los PHUB salen de la wallet de tesorería del propietario (que debe aprobar
///         a este contrato) y los USDC van directamente a esa misma tesorería.
///         El contrato nunca guarda fondos. La venta nace DESACTIVADA y solo el
///         propietario puede activarla, cuando tenga el visto bueno legal.
contract PeopleHubSale is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable phub;
    IERC20 public immutable usdc;

    /// @notice Wallet que entrega los PHUB y recibe los USDC.
    address public treasury;

    /// @notice Precio en unidades de USDC (6 decimales) por 1 PHUB entero.
    ///         Ejemplo: 10_000 = 0,01 USDC por PHUB.
    uint256 public priceUsdcPerToken;

    /// @notice Interruptor general de la venta. Falso al desplegar.
    bool public salesEnabled;

    event Bought(address indexed buyer, uint256 phubAmount, uint256 usdcPaid);
    event PriceChanged(uint256 newPrice);
    event SalesEnabledChanged(bool enabled);
    event TreasuryChanged(address newTreasury);

    constructor(address owner_, IERC20 phub_, IERC20 usdc_, address treasury_, uint256 price_) Ownable(owner_) {
        require(address(phub_) != address(0) && address(usdc_) != address(0), "Sale: token cero");
        require(treasury_ != address(0), "Sale: tesoreria cero");
        require(price_ > 0, "Sale: precio cero");
        phub = phub_;
        usdc = usdc_;
        treasury = treasury_;
        priceUsdcPerToken = price_;
    }

    /// @notice Coste en USDC de `phubAmount` (18 decimales), redondeado hacia arriba.
    function quote(uint256 phubAmount) public view returns (uint256) {
        return (phubAmount * priceUsdcPerToken + 1 ether - 1) / 1 ether;
    }

    /// @notice Compra `phubAmount` PHUB pagando como máximo `maxUsdc`.
    function buy(uint256 phubAmount, uint256 maxUsdc) external nonReentrant {
        require(salesEnabled, "Sale: venta desactivada");
        require(phubAmount > 0, "Sale: cantidad cero");
        uint256 cost = quote(phubAmount);
        require(cost <= maxUsdc, "Sale: precio por encima del maximo");
        usdc.safeTransferFrom(msg.sender, treasury, cost);
        phub.safeTransferFrom(treasury, msg.sender, phubAmount);
        emit Bought(msg.sender, phubAmount, cost);
    }

    function setSalesEnabled(bool enabled) external onlyOwner {
        salesEnabled = enabled;
        emit SalesEnabledChanged(enabled);
    }

    function setPrice(uint256 newPrice) external onlyOwner {
        require(newPrice > 0, "Sale: precio cero");
        priceUsdcPerToken = newPrice;
        emit PriceChanged(newPrice);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Sale: tesoreria cero");
        treasury = newTreasury;
        emit TreasuryChanged(newTreasury);
    }
}
