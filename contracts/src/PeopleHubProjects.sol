// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Financiación de proyectos de theaipeoplehub con PHUB
/// @notice Ciclo de vida de un proyecto:
///   1. El propietario (admin) acepta una propuesta y la crea aquí con la meta (1.000–100.000 PHUB)
///      y el precio inicial de la app que eligió el publicador. Se abre un plazo de 7 días.
///   2. Fase de financiación: cada PHUB invertido es un voto y cuenta íntegro como participación.
///      Si se alcanza la meta, el proyecto pasa a Activo y la meta completa va a la wallet de desarrollo.
///      Si vence el plazo sin alcanzarla, el proyecto fracasa y cada inversor recupera sus tokens.
///   3. Proyecto activo: cada nueva inversión se reparte así:
///        60 % participación del nuevo inversor (queda bloqueado en el contrato),
///        10 % para los inversores previos, en proporción a su participación,
///        28 % para la wallet de desarrollo del proyecto,
///         2 % de comisión para la tesorería del propietario.
///   4. Los usuarios finales compran el acceso a la app pagando su precio en PHUB:
///         5 % comisión, 95 % repartido entre los participantes.
///   5. Cada semana los participantes votan el cambio de precio (+50, +30, +10, 0, -10, -30, -50 %).
///      El cambio aplicado es la media de los votos ponderada por participación.
/// @dev Los repartos usan un acumulador de recompensa por unidad de participación (O(1) por operación).
///      Los participantes retiran lo acumulado con `claimRewards`.
contract PeopleHubProjects is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constantes
    uint256 public constant MIN_GOAL = 1_000 ether;
    uint256 public constant MAX_GOAL = 100_000 ether;
    uint256 public constant FUNDING_PERIOD = 7 days;
    uint256 public constant VOTE_PERIOD = 7 days;
    uint256 public constant MIN_PRICE = 0.01 ether;

    uint256 private constant BPS = 10_000;
    uint256 public constant STAKE_BPS = 6_000;
    uint256 public constant PREVIOUS_INVESTORS_BPS = 1_000;
    uint256 public constant DEVELOPMENT_BPS = 2_800;
    uint256 public constant INVEST_FEE_BPS = 200;
    uint256 public constant SALE_FEE_BPS = 500;

    uint256 private constant PRECISION = 1e18;

    enum Status {
        None,
        Funding,
        Active,
        Failed
    }

    struct Project {
        address publisher;
        address devWallet;
        Status status;
        uint64 deadline;
        uint256 goal;
        uint256 raised; // PHUB aportados en la fase de financiación
        uint256 totalStake; // suma de participaciones
        uint256 accRewardPerStake; // recompensa acumulada por unidad de participación (x1e18)
        uint256 price; // precio de acceso a la app, en PHUB (18 decimales)
        // votación semanal de precio
        uint64 voteEpoch;
        int256 voteWeightedSum;
        uint256 voteTotalWeight;
    }

    struct Position {
        uint256 stake;
        uint256 rewardDebt;
        uint256 credited; // recompensas pendientes de retirar
    }

    IERC20 public immutable phub;
    address public feeRecipient;
    uint256 public projectCount;

    mapping(uint256 => Project) public projects;
    mapping(uint256 => mapping(address => Position)) public positions;
    mapping(uint256 => mapping(address => bool)) public hasAccess;
    mapping(uint256 => mapping(uint64 => mapping(address => bool))) public hasVoted;

    // ---------------------------------------------------------------- eventos
    event ProjectCreated(uint256 indexed id, address indexed publisher, uint256 goal, uint256 price, uint64 deadline);
    event Invested(uint256 indexed id, address indexed investor, uint256 amount, uint256 stakeAdded);
    event ProjectActivated(uint256 indexed id, uint256 raised);
    event ProjectFailed(uint256 indexed id);
    event Refunded(uint256 indexed id, address indexed investor, uint256 amount);
    event AccessPurchased(uint256 indexed id, address indexed buyer, uint256 price);
    event RewardsDistributed(uint256 indexed id, uint256 amount);
    event RewardsClaimed(uint256 indexed id, address indexed investor, uint256 amount);
    event PriceVoted(uint256 indexed id, address indexed voter, uint64 epoch, int256 percent, uint256 weight);
    event PriceUpdated(uint256 indexed id, uint64 epoch, int256 averagePercentBps, uint256 newPrice);
    event FeeRecipientChanged(address newRecipient);
    event DevWalletChanged(uint256 indexed id, address newWallet);

    constructor(address owner_, IERC20 phub_, address feeRecipient_) Ownable(owner_) {
        require(address(phub_) != address(0), "Projects: token cero");
        require(feeRecipient_ != address(0), "Projects: comision cero");
        phub = phub_;
        feeRecipient = feeRecipient_;
    }

    // ================================================================ admin

    /// @notice Crea un proyecto aceptado por el admin y abre su plazo de financiación.
    function createProject(address publisher, uint256 goal, uint256 initialPrice, address devWallet)
        external
        onlyOwner
        whenNotPaused
        returns (uint256 id)
    {
        require(publisher != address(0) && devWallet != address(0), "Projects: direccion cero");
        require(goal >= MIN_GOAL && goal <= MAX_GOAL, "Projects: meta fuera de rango");
        require(initialPrice >= MIN_PRICE, "Projects: precio demasiado bajo");
        id = ++projectCount;
        Project storage p = projects[id];
        p.publisher = publisher;
        p.devWallet = devWallet;
        p.status = Status.Funding;
        p.deadline = uint64(block.timestamp + FUNDING_PERIOD);
        p.goal = goal;
        p.price = initialPrice;
        emit ProjectCreated(id, publisher, goal, initialPrice, p.deadline);
    }

    /// @notice Cancela un proyecto que aún está en financiación. Los inversores recuperan sus tokens.
    function cancelProject(uint256 id) external onlyOwner {
        Project storage p = projects[id];
        require(p.status == Status.Funding, "Projects: no esta en financiacion");
        p.status = Status.Failed;
        emit ProjectFailed(id);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Projects: comision cero");
        feeRecipient = newRecipient;
        emit FeeRecipientChanged(newRecipient);
    }

    function setDevWallet(uint256 id, address newWallet) external onlyOwner {
        require(projects[id].status != Status.None, "Projects: no existe");
        require(newWallet != address(0), "Projects: direccion cero");
        projects[id].devWallet = newWallet;
        emit DevWalletChanged(id, newWallet);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ================================================================ inversión

    /// @notice Invierte PHUB en un proyecto. En financiación se acepta como máximo lo que falta
    ///         para la meta; el resto no se cobra.
    /// @return accepted PHUB realmente cobrados.
    function invest(uint256 id, uint256 amount) external nonReentrant whenNotPaused returns (uint256 accepted) {
        require(amount > 0, "Projects: cantidad cero");
        Project storage p = projects[id];
        _syncStatus(id, p);

        if (p.status == Status.Funding) {
            uint256 remaining = p.goal - p.raised;
            accepted = amount < remaining ? amount : remaining;
            phub.safeTransferFrom(msg.sender, address(this), accepted);
            Position storage pos = positions[id][msg.sender];
            pos.stake += accepted;
            p.totalStake += accepted;
            p.raised += accepted;
            emit Invested(id, msg.sender, accepted, accepted);
            if (p.raised == p.goal) {
                p.status = Status.Active;
                p.voteEpoch = _currentEpoch();
                phub.safeTransfer(p.devWallet, p.goal);
                emit ProjectActivated(id, p.goal);
            }
        } else if (p.status == Status.Active) {
            accepted = amount;
            phub.safeTransferFrom(msg.sender, address(this), amount);

            uint256 toPrevious = (amount * PREVIOUS_INVESTORS_BPS) / BPS;
            uint256 toDevelopment = (amount * DEVELOPMENT_BPS) / BPS;
            uint256 toFee = (amount * INVEST_FEE_BPS) / BPS;
            uint256 toStake = amount - toPrevious - toDevelopment - toFee; // 60 % (absorbe el redondeo)

            // Primero se reparte entre los inversores previos, después se suma la nueva participación.
            _distribute(id, p, toPrevious);

            Position storage pos = positions[id][msg.sender];
            _accrue(p, pos);
            pos.stake += toStake;
            p.totalStake += toStake;
            pos.rewardDebt = (pos.stake * p.accRewardPerStake) / PRECISION;

            phub.safeTransfer(p.devWallet, toDevelopment);
            phub.safeTransfer(feeRecipient, toFee);
            emit Invested(id, msg.sender, amount, toStake);
        } else {
            revert("Projects: no admite inversiones");
        }
    }

    /// @notice Devuelve los tokens invertidos si el proyecto no alcanzó la meta en plazo o se canceló.
    function claimRefund(uint256 id) external nonReentrant {
        Project storage p = projects[id];
        _syncStatus(id, p);
        require(p.status == Status.Failed, "Projects: no hay reembolso");
        Position storage pos = positions[id][msg.sender];
        uint256 amount = pos.stake;
        require(amount > 0, "Projects: nada que devolver");
        pos.stake = 0;
        p.totalStake -= amount;
        p.raised -= amount;
        phub.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ================================================================ compra de acceso

    /// @notice Compra el acceso a la app de un proyecto activo al precio vigente.
    function buyAccess(uint256 id, uint256 maxPrice) external nonReentrant whenNotPaused {
        Project storage p = projects[id];
        require(p.status == Status.Active, "Projects: proyecto no activo");
        require(!hasAccess[id][msg.sender], "Projects: ya tienes acceso");
        _applyPendingPriceVote(id, p);
        uint256 price = p.price;
        require(price <= maxPrice, "Projects: precio por encima del maximo");
        phub.safeTransferFrom(msg.sender, address(this), price);
        hasAccess[id][msg.sender] = true;
        uint256 fee = (price * SALE_FEE_BPS) / BPS;
        phub.safeTransfer(feeRecipient, fee);
        _distribute(id, p, price - fee);
        emit AccessPurchased(id, msg.sender, price);
    }

    // ================================================================ recompensas

    function claimRewards(uint256 id) external nonReentrant returns (uint256 amount) {
        Project storage p = projects[id];
        Position storage pos = positions[id][msg.sender];
        _accrue(p, pos);
        amount = pos.credited;
        require(amount > 0, "Projects: nada que retirar");
        pos.credited = 0;
        phub.safeTransfer(msg.sender, amount);
        emit RewardsClaimed(id, msg.sender, amount);
    }

    function pendingRewards(uint256 id, address account) external view returns (uint256) {
        Project storage p = projects[id];
        Position storage pos = positions[id][account];
        return pos.credited + (pos.stake * p.accRewardPerStake) / PRECISION - pos.rewardDebt;
    }

    // ================================================================ votación de precio

    /// @notice Vota el cambio de precio de la semana. `percent` ∈ {50, 30, 10, 0, -10, -30, -50}.
    ///         El peso del voto es la participación en el momento de votar.
    function votePrice(uint256 id, int256 percent) external whenNotPaused {
        require(_isAllowedPercent(percent), "Projects: opcion de voto no valida");
        Project storage p = projects[id];
        require(p.status == Status.Active, "Projects: proyecto no activo");
        uint256 weight = positions[id][msg.sender].stake;
        require(weight > 0, "Projects: sin participacion");
        _applyPendingPriceVote(id, p);
        uint64 epoch = p.voteEpoch;
        require(!hasVoted[id][epoch][msg.sender], "Projects: ya has votado esta semana");
        hasVoted[id][epoch][msg.sender] = true;
        p.voteWeightedSum += percent * int256(weight);
        p.voteTotalWeight += weight;
        emit PriceVoted(id, msg.sender, epoch, percent, weight);
    }

    /// @notice Aplica el resultado de la votación de la semana anterior, si la hay. Cualquiera puede llamarla.
    function finalizePriceVote(uint256 id) external {
        Project storage p = projects[id];
        require(p.status == Status.Active, "Projects: proyecto no activo");
        _applyPendingPriceVote(id, p);
    }

    function currentEpoch() external view returns (uint64) {
        return _currentEpoch();
    }

    // ================================================================ vistas

    function getProject(uint256 id) external view returns (Project memory) {
        return projects[id];
    }

    function statusOf(uint256 id) public view returns (Status) {
        Project storage p = projects[id];
        if (p.status == Status.Funding && block.timestamp > p.deadline) return Status.Failed;
        return p.status;
    }

    // ================================================================ internas

    function _currentEpoch() internal view returns (uint64) {
        return uint64(block.timestamp / VOTE_PERIOD);
    }

    function _isAllowedPercent(int256 x) internal pure returns (bool) {
        return x == 50 || x == 30 || x == 10 || x == 0 || x == -10 || x == -30 || x == -50;
    }

    /// @dev Marca como fallido un proyecto cuyo plazo venció sin alcanzar la meta.
    function _syncStatus(uint256 id, Project storage p) internal {
        if (p.status == Status.Funding && block.timestamp > p.deadline) {
            p.status = Status.Failed;
            emit ProjectFailed(id);
        }
    }

    function _accrue(Project storage p, Position storage pos) internal {
        uint256 accumulated = (pos.stake * p.accRewardPerStake) / PRECISION;
        pos.credited += accumulated - pos.rewardDebt;
        pos.rewardDebt = accumulated;
    }

    function _distribute(uint256 id, Project storage p, uint256 amount) internal {
        if (amount == 0) return;
        // Un proyecto activo siempre tiene participación (la de la financiación inicial).
        p.accRewardPerStake += (amount * PRECISION) / p.totalStake;
        emit RewardsDistributed(id, amount);
    }

    /// @dev Si la votación abierta pertenece a una semana ya terminada, aplica su resultado
    ///      y abre la votación de la semana actual.
    function _applyPendingPriceVote(uint256 id, Project storage p) internal {
        uint64 nowEpoch = _currentEpoch();
        if (p.voteEpoch >= nowEpoch) return;
        uint64 closed = p.voteEpoch;
        if (p.voteTotalWeight > 0) {
            // Media ponderada en puntos básicos de porcentaje (p. ej. 1500 = +15 %).
            int256 avgBps = (p.voteWeightedSum * 100) / int256(p.voteTotalWeight);
            int256 newPrice = (int256(p.price) * (10_000 + avgBps)) / 10_000;
            uint256 price = newPrice < int256(MIN_PRICE) ? MIN_PRICE : uint256(newPrice);
            p.price = price;
            emit PriceUpdated(id, closed, avgBps, price);
        }
        p.voteEpoch = nowEpoch;
        p.voteWeightedSum = 0;
        p.voteTotalWeight = 0;
    }
}
