import { Address, BigDecimal, BigInt, ethereum, log } from '@graphprotocol/graph-ts'
import {
  Deposit as DepositEvent,
  Withdraw as WithdrawEvent,
} from '../../generated/templates/BeefyCLVault/BeefyVaultConcLiq'
import { getBeefyCLVault, getBeefyCLVaultSnapshot, isVaultRunning } from '../entity/vault'
import { getTransaction } from '../entity/transaction'
import { getBeefyCLProtocol, getBeefyCLProtocolSnapshot } from '../entity/protocol'
import { getInvestor, getInvestorSnapshot } from '../entity/investor'
import { ZERO_BD, ZERO_BI, tokenAmountToBigNumber, bnToBd, ZERO_BN, bdToBn } from '../utils/decimal'
import { BeefyVaultConcLiq as BeefyCLVaultContract } from '../../generated/templates/BeefyCLVault/BeefyVaultConcLiq'
import { StrategyPassiveManagerUniswap as BeefyCLStrategyContract } from '../../generated/templates/BeefyCLStrategy/StrategyPassiveManagerUniswap'
import { PERIODS } from '../utils/time'
import { getToken } from '../entity/token'
import { getInvestorPosition, getInvestorPositionSnapshot } from '../entity/position'
import { ADDRESS_ZERO } from '../utils/address'
import { sqrtPriceX96ToPriceInToken1 } from '../utils/uniswap'

export { handleVaultInitialized as handleInitialized } from '../vault-lifecycle'
export { handleVaultOwnershipTransferred as handleOwnershipTransferred } from '../ownership'

export function handleDeposit(event: DepositEvent): void {
  updateUserPosition(event, event.params.user, true)
}

export function handleWithdraw(event: WithdrawEvent): void {
  updateUserPosition(event, event.params.user, false)
}
// export function handleTransfer(event: Transfer): void {
// let sharesDelta = event.params.value
// let underlyingDelta0 = BigInt.fromI32(0)
// let underlyingDelta1 = BigInt.fromI32(0)
//
// TODO: this will fetch accounts and vaults twice
// updateUserPosition(event, event.params.to, sharesDelta, underlyingDelta0, underlyingDelta1)
// updateUserPosition(event, event.params.from, sharesDelta.neg(), underlyingDelta0.neg(), underlyingDelta1.neg())
// }

function updateUserPosition(event: ethereum.Event, investorAddress: Address, isDeposit: boolean): void {
  const periods = PERIODS
  let vault = getBeefyCLVault(event.address)
  if (!isVaultRunning(vault)) {
    log.error('updateUserPosition: vault {} not active at block {}: {}', [
      vault.id.toHexString(),
      event.block.number.toString(),
      vault.lifecycle,
    ])
    return
  }

  const sharesToken = getToken(vault.sharesToken)
  const token0 = getToken(vault.underlyingToken0)
  const token1 = getToken(vault.underlyingToken1)

  let tx = getTransaction(event.block, event.transaction, event.receipt)
  tx.save()

  let investor = getInvestor(investorAddress)

  ///////
  // fetch data on chain
  // TODO: use multicall3 to fetch all data in one call
  const vaultContract = BeefyCLVaultContract.bind(Address.fromBytes(vault.id))
  const strategyContract = BeefyCLStrategyContract.bind(Address.fromBytes(vault.strategy))

  // current price
  const sqrtPriceRes = strategyContract.try_price() // TODO: replace with "try_sqrtPrice()" when new strats are deployed
  if (sqrtPriceRes.reverted) {
    log.error('updateUserPosition: price() reverted for strategy {}', [vault.strategy.toHexString()])
    throw Error('updateUserPosition: price() reverted')
  }
  const sqrtPriceRaw = sqrtPriceRes.value

  // range the strategy is covering
  const rangeRes = strategyContract.try_positionMain() // TODO: use "try_range()" when new strats are deployed
  if (rangeRes.reverted) {
    log.error('updateUserPosition: range() reverted for strategy {}', [vault.strategy.toHexString()])
    throw Error('updateUserPosition: range() reverted')
  }
  const rangeRaw = rangeRes.value
  // TODO: this is just wrong
  const rangeMinTokenPrice = sqrtPriceX96ToPriceInToken1(BigInt.fromI32(rangeRaw.value0), token0, token1)
  const rangeMaxTokenPrice = sqrtPriceX96ToPriceInToken1(BigInt.fromI32(rangeRaw.value1), token0, token1)

  // balances of the vault
  const balancesRes = strategyContract.try_balances()
  if (balancesRes.reverted) {
    log.error('updateUserPosition: balances() reverted for strategy {}', [vault.strategy.toHexString()])
    throw Error('updateUserPosition: balances() reverted')
  }
  const balancesRaw = balancesRes.value

  // get the new investor deposit value
  const investorBalanceRes = vaultContract.try_balanceOf(investorAddress)
  if (investorBalanceRes.reverted) {
    log.error('updateUserPosition: balanceOf() reverted for vault {}', [vault.id.toHexString()])
    throw Error('updateUserPosition: balanceOf() reverted')
  }
  const investorBalanceRaw = investorBalanceRes.value

  let previewWithdraw0Raw = BigInt.fromI32(0)
  let previewWithdraw1Raw = BigInt.fromI32(0)
  if (investorBalanceRaw.gt(ZERO_BI)) {
    const previewWithdrawRes = vaultContract.try_previewWithdraw(investorBalanceRaw)
    if (previewWithdrawRes.reverted) {
      log.error('updateUserPosition: previewWithdraw() reverted for vault {}', [vault.id.toHexString()])
      throw Error('updateUserPosition: previewWithdraw() reverted')
    }
    previewWithdraw0Raw = previewWithdrawRes.value.value0
    previewWithdraw1Raw = previewWithdrawRes.value.value1
  }

  ///////
  // compute derived values
  const currentTokenPrices = sqrtPriceX96ToPriceInToken1(sqrtPriceRaw, token0, token1)
  const isNewInvestor = investor.lastInteractionTimestamp.equals(ZERO_BI)
  const token0PriceInNative = ZERO_BN // TODO
  const token1PriceInNative = ZERO_BN // TODO
  const nativePriceUSD = ZERO_BN // TODO
  const investmentValueUSD = ZERO_BN // TODO
  const txGasFeeUSD = bdToBn(tx.gasFee).mul(nativePriceUSD)
  const token0PriceInUSD = token0PriceInNative.mul(nativePriceUSD)
  const token1PriceInUSD = token1PriceInNative.mul(nativePriceUSD)

  ///////
  // update vault entities
  const balance0Dec = tokenAmountToBigNumber(balancesRaw.value0, token0)
  const balance1Dec = tokenAmountToBigNumber(balancesRaw.value1, token1)
  vault.currentPriceOfToken0InToken1 = bnToBd(currentTokenPrices[1])
  vault.priceRangeMin1 = bnToBd(rangeMinTokenPrice[1])
  vault.priceRangeMax1 = bnToBd(rangeMaxTokenPrice[1])
  vault.priceRangeMin1USD = vault.priceRangeMin1.times(token1PriceInUSD)
  vault.priceRangeMax1USD = vault.priceRangeMax1.times(token1PriceInUSD)
  vault.underlyingAmount0 = balance0Dec
  vault.underlyingAmount1 = balance1Dec
  vault.underlyingAmount0USD = vault.underlyingAmount0.times(token0PriceInUSD)
  vault.underlyingAmount1USD = vault.underlyingAmount1.times(token1PriceInUSD)
  vault.totalValueLockedUSD = vault.underlyingAmount0USD.plus(investmentValueUSD)
  if (isDeposit) {
    vault.totalDepositCount += 1
  } else {
    vault.totalWithdrawCount += 1
  }
  vault.save()
  for (let i = 0; i < periods.length; i++) {
    const vaultSnapshot = getBeefyCLVaultSnapshot(vault, event.block.timestamp, periods[i])
    vaultSnapshot.currentPriceOfToken0InToken1 = vault.currentPriceOfToken0InToken1
    vaultSnapshot.priceRangeMin1 = vault.priceRangeMax1
    vaultSnapshot.priceRangeMax1 = vault.priceRangeMax1
    vaultSnapshot.priceRangeMin1USD = vault.priceRangeMax1USD
    vaultSnapshot.priceRangeMax1USD = vault.priceRangeMax1USD
    vaultSnapshot.underlyingAmount0 = vault.underlyingAmount0
    vaultSnapshot.underlyingAmount1 = vault.underlyingAmount1
    vaultSnapshot.underlyingAmount0USD = vault.underlyingAmount0USD
    vaultSnapshot.underlyingAmount1USD = vault.underlyingAmount1USD
    vaultSnapshot.totalValueLockedUSD = vault.totalValueLockedUSD
    if (isDeposit) {
      vaultSnapshot.depositCount += 1
    } else {
      vaultSnapshot.withdrawCount += 1
    }
    vaultSnapshot.save()
  }

  ///////
  // update protocol entities
  const protocol = getBeefyCLProtocol()
  protocol.transactionCount += 1
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(investmentValueUSD)
  if (isNewInvestor) {
    protocol.activeInvestorCount += 1
  }
  protocol.save()
  for (let i = 0; i < periods.length; i++) {
    const protocolSnapshot = getBeefyCLProtocolSnapshot(event.block.timestamp, periods[i])
    protocolSnapshot.totalValueLockedUSD = protocolSnapshot.totalValueLockedUSD.plus(investmentValueUSD)
    if (isNewInvestor) {
      protocolSnapshot.newInvestorCount += 1
    }
    if (investor.lastInteractionTimestamp.lt(protocolSnapshot.roundedTimestamp)) {
      protocolSnapshot.activeInvestorCount += 1
    }
    protocolSnapshot.totalTransactionCount += 1
    protocolSnapshot.investorTransactionsCount += 1
    protocolSnapshot.totalGasSpent = protocolSnapshot.totalGasSpent.plus(tx.gasFee)
    protocolSnapshot.totalGasSpentUSD = protocolSnapshot.totalGasSpentUSD.plus(txGasFeeUSD)
    protocolSnapshot.investorGasSpent = protocolSnapshot.investorGasSpent.plus(tx.gasFee)
    protocolSnapshot.investorGasSpentUSD = protocolSnapshot.investorGasSpentUSD.plus(txGasFeeUSD)
    protocolSnapshot.save()
  }

  ///////
  // update investor positions
  const position = getInvestorPosition(vault, investor)
  const isNewPosition = position.sharesBalance.equals(ZERO_BD)
  let timeSinceLastPositionUpdate = ZERO_BI
  if (!isNewPosition) {
    timeSinceLastPositionUpdate = event.block.timestamp.minus(position.lastUpdated)
  }
  if (position.createdWith.equals(ADDRESS_ZERO)) {
    position.createdWith = tx.id
  }
  if (!position.sharesBalance.equals(ZERO_BD)) {
    position.timeWeightedPositionValueUSD = position.timeWeightedPositionValueUSD.plus(
      position.positionValueUSD.times(BigDecimal.fromString(timeSinceLastPositionUpdate.toString())),
    )
    position.totalActiveTime = position.totalActiveTime.plus(timeSinceLastPositionUpdate)
  }
  position.sharesBalance = tokenAmountToBigNumber(investorBalanceRaw, sharesToken)
  const previousPositionValueUSD = position.positionValueUSD
  position.underlyingBalance0 = tokenAmountToBigNumber(previewWithdraw0Raw, token0)
  position.underlyingBalance1 = tokenAmountToBigNumber(previewWithdraw1Raw, token1)
  position.underlyingBalance0USD = position.underlyingBalance0.times(token0PriceInUSD)
  position.underlyingBalance1USD = position.underlyingBalance1.times(token1PriceInUSD)
  position.positionValueUSD = position.underlyingBalance0USD.plus(position.underlyingBalance1USD)
  const positionChangeUSD = position.positionValueUSD.minus(previousPositionValueUSD)
  position.lastUpdated = event.block.timestamp
  position.save()
  for (let i = 0; i < periods.length; i++) {
    const positionSnapshot = getInvestorPositionSnapshot(vault, investor, event.block.timestamp, periods[i])
    positionSnapshot.sharesBalance = position.sharesBalance
    positionSnapshot.underlyingBalance0 = position.underlyingBalance0
    positionSnapshot.underlyingBalance1 = position.underlyingBalance1
    positionSnapshot.underlyingBalance0USD = position.underlyingBalance0USD
    positionSnapshot.underlyingBalance1USD = position.underlyingBalance1USD
    positionSnapshot.positionValueUSD = position.positionValueUSD
    positionSnapshot.save()
  }

  ///////
  // update investor entities
  investor.lastInteractionTimestamp = event.block.timestamp
  if (isNewPosition) {
    investor.activePositionCount += 1
  } else if (position.sharesBalance.equals(ZERO_BD)) {
    investor.activePositionCount -= 1
  }
  investor.investedDuration = investor.investedDuration.plus(timeSinceLastPositionUpdate)
  investor.totalPositionValueUSD = investor.totalPositionValueUSD.plus(positionChangeUSD)
  investor.timeWeightedPositionValueUSD = investor.timeWeightedPositionValueUSD.plus(
    investor.totalPositionValueUSD.times(BigDecimal.fromString(timeSinceLastPositionUpdate.toString())),
  )
  investor.totalInteractionsCount += 1
  investor.save()
  for (let i = 0; i < periods.length; i++) {
    const investorSnapshot = getInvestorSnapshot(investor, event.block.timestamp, periods[i])
    investorSnapshot.totalPositionValueUSD = investor.totalPositionValueUSD
    investorSnapshot.timeWeightedPositionValueUSD = investor.timeWeightedPositionValueUSD
    investorSnapshot.interactionsCount += 1
    investorSnapshot.save()
  }
}