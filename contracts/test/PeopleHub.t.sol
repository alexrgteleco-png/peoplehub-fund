// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PeopleHubToken} from "../src/PeopleHubToken.sol";
import {PeopleHubSale} from "../src/PeopleHubSale.sol";
import {PeopleHubProjects} from "../src/PeopleHubProjects.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract PeopleHubTest is Test {
    PeopleHubToken phub;
    MockUSDC usdc;
    PeopleHubSale sale;
    PeopleHubProjects projects;

    address owner = makeAddr("owner"); // tu wallet: tesorería y admin
    address dev = makeAddr("dev");
    address publisher = makeAddr("publisher");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address buyer = makeAddr("buyer");

    uint256 constant GOAL = 1_000 ether;
    uint256 constant PRICE = 100 ether;

    function setUp() public {
        // Fecha realista para que la semana de votación no sea la cero.
        vm.warp(1_790_000_000);
        phub = new PeopleHubToken(owner);
        usdc = new MockUSDC();
        sale = new PeopleHubSale(owner, phub, usdc, owner, 10_000); // 0,01 USDC por PHUB
        projects = new PeopleHubProjects(owner, phub, owner);

        // El propietario reparte PHUB de prueba y aprueba la venta.
        vm.startPrank(owner);
        phub.approve(address(sale), type(uint256).max);
        phub.transfer(alice, 100_000 ether);
        phub.transfer(bob, 100_000 ether);
        phub.transfer(carol, 100_000 ether);
        phub.transfer(buyer, 10_000 ether);
        vm.stopPrank();

        address[4] memory users = [alice, bob, carol, buyer];
        for (uint256 i = 0; i < users.length; i++) {
            vm.prank(users[i]);
            phub.approve(address(projects), type(uint256).max);
        }
    }

    function _create() internal returns (uint256 id) {
        vm.prank(owner);
        id = projects.createProject(publisher, GOAL, PRICE, dev);
    }

    function _createActive() internal returns (uint256 id) {
        id = _create();
        vm.prank(alice);
        projects.invest(id, 600 ether);
        vm.prank(bob);
        projects.invest(id, 400 ether);
    }

    // ------------------------------------------------------------ token

    function test_TokenSupplyGoesToOwner() public view {
        assertEq(phub.totalSupply(), 100_000_000 ether);
        assertEq(phub.name(), "PeopleHub");
        assertEq(phub.symbol(), "PHUB");
        assertEq(phub.balanceOf(owner), 100_000_000 ether - 310_000 ether);
    }

    // ------------------------------------------------------------ venta

    function test_SaleDisabledByDefault() public {
        usdc.mint(carol, 1_000e6);
        vm.startPrank(carol);
        usdc.approve(address(sale), type(uint256).max);
        vm.expectRevert("Sale: venta desactivada");
        sale.buy(100 ether, 1e6);
        vm.stopPrank();
    }

    function test_SaleBuyMovesFundsToTreasury() public {
        vm.prank(owner);
        sale.setSalesEnabled(true);
        usdc.mint(carol, 1_000e6);
        uint256 before = phub.balanceOf(carol);
        vm.startPrank(carol);
        usdc.approve(address(sale), type(uint256).max);
        sale.buy(1_000 ether, 10e6); // 1.000 PHUB × 0,01 = 10 USDC
        vm.stopPrank();
        assertEq(phub.balanceOf(carol) - before, 1_000 ether);
        assertEq(usdc.balanceOf(owner), 10e6);
        assertEq(usdc.balanceOf(address(sale)), 0);
    }

    function test_SaleRespectsMaxPrice() public {
        vm.prank(owner);
        sale.setSalesEnabled(true);
        usdc.mint(carol, 1_000e6);
        vm.startPrank(carol);
        usdc.approve(address(sale), type(uint256).max);
        vm.expectRevert("Sale: precio por encima del maximo");
        sale.buy(1_000 ether, 9e6);
        vm.stopPrank();
    }

    function test_OnlyOwnerControlsSale() public {
        vm.prank(alice);
        vm.expectRevert();
        sale.setSalesEnabled(true);
    }

    // ------------------------------------------------------------ creación

    function test_GoalLimits() public {
        vm.startPrank(owner);
        vm.expectRevert("Projects: meta fuera de rango");
        projects.createProject(publisher, 999 ether, PRICE, dev);
        vm.expectRevert("Projects: meta fuera de rango");
        projects.createProject(publisher, 100_001 ether, PRICE, dev);
        projects.createProject(publisher, 100_000 ether, PRICE, dev);
        vm.stopPrank();
    }

    function test_OnlyOwnerCreatesProjects() public {
        vm.prank(alice);
        vm.expectRevert();
        projects.createProject(publisher, GOAL, PRICE, dev);
    }

    // ------------------------------------------------------------ financiación

    function test_FundingReachesGoalAndActivates() public {
        uint256 id = _createActive();
        assertEq(uint256(projects.statusOf(id)), uint256(PeopleHubProjects.Status.Active));
        assertEq(phub.balanceOf(dev), GOAL);
        (uint256 aliceStake,,) = projects.positions(id, alice);
        assertEq(aliceStake, 600 ether);
    }

    function test_FundingCapsAtGoal() public {
        uint256 id = _create();
        uint256 before = phub.balanceOf(alice);
        vm.prank(alice);
        uint256 accepted = projects.invest(id, 5_000 ether);
        assertEq(accepted, GOAL);
        assertEq(before - phub.balanceOf(alice), GOAL);
    }

    function test_RefundWhenGoalNotReachedIn7Days() public {
        uint256 id = _create();
        vm.prank(alice);
        projects.invest(id, 300 ether);
        uint256 before = phub.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert("Projects: no hay reembolso");
        projects.claimRefund(id);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(bob);
        vm.expectRevert("Projects: no admite inversiones");
        projects.invest(id, 700 ether);

        vm.prank(alice);
        projects.claimRefund(id);
        assertEq(phub.balanceOf(alice) - before, 300 ether);
        vm.prank(alice);
        vm.expectRevert("Projects: nada que devolver");
        projects.claimRefund(id);
    }

    function test_AdminCancelAllowsRefund() public {
        uint256 id = _create();
        vm.prank(alice);
        projects.invest(id, 300 ether);
        vm.prank(owner);
        projects.cancelProject(id);
        uint256 before = phub.balanceOf(alice);
        vm.prank(alice);
        projects.claimRefund(id);
        assertEq(phub.balanceOf(alice) - before, 300 ether);
    }

    // ------------------------------------------------------------ inversión en activo

    function test_ActiveInvestmentSplit() public {
        uint256 id = _createActive();
        uint256 devBefore = phub.balanceOf(dev);
        uint256 feeBefore = phub.balanceOf(owner);

        vm.prank(carol);
        projects.invest(id, 1_000 ether);

        assertEq(phub.balanceOf(dev) - devBefore, 280 ether, "28% desarrollo");
        assertEq(phub.balanceOf(owner) - feeBefore, 20 ether, "2% comision");
        (uint256 carolStake,,) = projects.positions(id, carol);
        assertEq(carolStake, 600 ether, "60% participacion");
        // 10% (100 PHUB) para alice (600) y bob (400)
        assertEq(projects.pendingRewards(id, alice), 60 ether);
        assertEq(projects.pendingRewards(id, bob), 40 ether);
        assertEq(projects.pendingRewards(id, carol), 0);
    }

    function test_ClaimRewards() public {
        uint256 id = _createActive();
        vm.prank(carol);
        projects.invest(id, 1_000 ether);
        uint256 before = phub.balanceOf(alice);
        vm.prank(alice);
        projects.claimRewards(id);
        assertEq(phub.balanceOf(alice) - before, 60 ether);
        assertEq(projects.pendingRewards(id, alice), 0);
    }

    // ------------------------------------------------------------ compra de acceso

    function test_BuyAccessSplit() public {
        uint256 id = _createActive();
        uint256 feeBefore = phub.balanceOf(owner);
        vm.prank(buyer);
        projects.buyAccess(id, PRICE);
        assertTrue(projects.hasAccess(id, buyer));
        assertEq(phub.balanceOf(owner) - feeBefore, 5 ether, "5% comision");
        assertEq(projects.pendingRewards(id, alice), 57 ether, "95% x 60%");
        assertEq(projects.pendingRewards(id, bob), 38 ether, "95% x 40%");

        vm.prank(buyer);
        vm.expectRevert("Projects: ya tienes acceso");
        projects.buyAccess(id, PRICE);
    }

    function test_BuyAccessRequiresActive() public {
        uint256 id = _create();
        vm.prank(buyer);
        vm.expectRevert("Projects: proyecto no activo");
        projects.buyAccess(id, PRICE);
    }

    // ------------------------------------------------------------ votación de precio

    function test_WeightedPriceVote() public {
        uint256 id = _createActive(); // alice 600, bob 400
        vm.prank(alice);
        projects.votePrice(id, 50);
        vm.prank(bob);
        projects.votePrice(id, -50);

        vm.prank(alice);
        vm.expectRevert("Projects: ya has votado esta semana");
        projects.votePrice(id, 10);

        vm.warp(block.timestamp + 7 days);
        projects.finalizePriceVote(id);
        // media ponderada: (600×50 − 400×50)/1000 = +10 % → 110 PHUB
        assertEq(projects.getProject(id).price, 110 ether);
    }

    function test_InvalidVoteOption() public {
        uint256 id = _createActive();
        vm.prank(alice);
        vm.expectRevert("Projects: opcion de voto no valida");
        projects.votePrice(id, 20);
    }

    function test_VoteRequiresStake() public {
        uint256 id = _createActive();
        vm.prank(carol);
        vm.expectRevert("Projects: sin participacion");
        projects.votePrice(id, 10);
    }

    function test_NoVotesKeepsPrice() public {
        uint256 id = _createActive();
        vm.warp(block.timestamp + 21 days);
        projects.finalizePriceVote(id);
        assertEq(projects.getProject(id).price, PRICE);
    }

    function test_PriceFloor() public {
        vm.prank(owner);
        uint256 id = projects.createProject(publisher, GOAL, 0.01 ether, dev);
        vm.prank(alice);
        projects.invest(id, GOAL);
        vm.prank(alice);
        projects.votePrice(id, -50);
        vm.warp(block.timestamp + 7 days);
        projects.finalizePriceVote(id);
        assertEq(projects.getProject(id).price, 0.01 ether);
    }

    function test_NewWeekAllowsNewVote() public {
        uint256 id = _createActive();
        vm.prank(alice);
        projects.votePrice(id, 10);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        projects.votePrice(id, 10); // aplica la semana anterior (+10 %) y abre la nueva
        assertEq(projects.getProject(id).price, 110 ether);
    }

    // ------------------------------------------------------------ seguridad

    function test_PauseBlocksInvestButNotClaims() public {
        uint256 id = _createActive();
        vm.prank(carol);
        projects.invest(id, 1_000 ether);
        vm.prank(owner);
        projects.pause();
        vm.prank(carol);
        vm.expectRevert();
        projects.invest(id, 100 ether);
        vm.prank(alice);
        projects.claimRewards(id); // retirar sigue siendo posible
    }

    /// @notice El contrato siempre tiene saldo para pagar todas las recompensas pendientes.
    function testFuzz_SolvencyAfterActivity(uint96 a, uint96 b, uint8 sales) public {
        uint256 amountA = bound(uint256(a), 1 ether, 50_000 ether);
        uint256 amountB = bound(uint256(b), 1 ether, 50_000 ether);
        uint256 id = _createActive();
        vm.prank(carol);
        projects.invest(id, amountA);
        vm.prank(alice);
        projects.invest(id, amountB);
        uint256 n = bound(uint256(sales), 0, 20);
        for (uint256 i = 0; i < n; i++) {
            address u = address(uint160(0x1000 + i));
            vm.prank(owner);
            phub.transfer(u, PRICE);
            vm.startPrank(u);
            phub.approve(address(projects), PRICE);
            projects.buyAccess(id, PRICE);
            vm.stopPrank();
        }
        uint256 owed = projects.pendingRewards(id, alice) + projects.pendingRewards(id, bob)
            + projects.pendingRewards(id, carol);
        assertLe(owed, phub.balanceOf(address(projects)));
        vm.prank(alice);
        projects.claimRewards(id);
        vm.prank(bob);
        projects.claimRewards(id);
        if (projects.pendingRewards(id, carol) > 0) {
            vm.prank(carol);
            projects.claimRewards(id);
        }
    }
}
