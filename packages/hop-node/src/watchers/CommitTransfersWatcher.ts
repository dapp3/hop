import '../moduleAlias'
import BaseWatcher from './classes/BaseWatcher'
import L2Bridge from './classes/L2Bridge'
import { BigNumber } from 'ethers'
import { L1Bridge as L1BridgeContract } from '@hop-protocol/core/contracts/L1Bridge'
import { L2Bridge as L2BridgeContract } from '@hop-protocol/core/contracts/L2Bridge'
import { TxRetryDelayMs, getEnabledNetworks } from 'src/config'

type Config = {
  chainSlug: string
  tokenSymbol: string
  minThresholdAmounts?: {[chain: string]: number}

  bridgeContract?: L1BridgeContract | L2BridgeContract
  dryMode?: boolean
}

class CommitTransfersWatcher extends BaseWatcher {
  siblingWatchers: { [chainId: string]: CommitTransfersWatcher }
  minThresholdAmounts: {[chain: string]: BigNumber} = {}
  commitTxSentAt: { [chainId: number]: number } = {}

  constructor (config: Config) {
    super({
      chainSlug: config.chainSlug,
      tokenSymbol: config.tokenSymbol,
      logColor: 'yellow',
      bridgeContract: config.bridgeContract,
      dryMode: config.dryMode
    })

    if (config.minThresholdAmounts != null) {
      for (const destinationChain in config.minThresholdAmounts) {
        this.minThresholdAmounts[destinationChain] = this.bridge.parseUnits(
          config.minThresholdAmounts[destinationChain]
        )
      }
    }

    // Commit watcher is less time sensitive than others
    this.pollIntervalMs = 6 * 10 * 1000
  }

  async start () {
    const chains = getEnabledNetworks()
    for (const destinationChain of chains) {
      if (this.isL1 || this.chainSlug === destinationChain) {
        continue
      }
      const minThresholdAmount = this.getMinThresholdAmount(this.chainSlugToId(destinationChain))
      this.logger.debug(
        `destination chain ${destinationChain} min threshold amount: ${this.bridge.formatUnits(minThresholdAmount)}`
      )
    }
    await super.start()
  }

  async pollHandler () {
    if (this.isL1) {
      return
    }

    await this.checkTransferSentFromDb()
  }

  async checkTransferSentFromDb () {
    const dbTransfers = await this.db.transfers.getUncommittedTransfers(await this.getFilterRoute())
    if (!dbTransfers.length) {
      return
    }

    this.logger.info(
        `checking ${dbTransfers.length} uncommitted transfers db items`
    )

    const destinationChainIds: number[] = []
    for (const dbTransfer of dbTransfers) {
      const { destinationChainId } = dbTransfer
      if (!destinationChainIds.includes(destinationChainId)) {
        destinationChainIds.push(destinationChainId)
      }
    }

    this.logger.info(
        `checking ${destinationChainIds.length} destinationChainIds of uncommitted transfers`
    )
    for (const destinationChainId of destinationChainIds) {
      await this.checkIfShouldCommit(destinationChainId)
    }
  }

  async checkIfShouldCommit (destinationChainId: number) {
    if (!destinationChainId) {
      throw new Error('destination chain id is required')
    }

    // Define new object on first run after server restart
    if (!this.commitTxSentAt[destinationChainId]) {
      this.commitTxSentAt[destinationChainId] = 0
    }

    // Since we don't know what the transferRootId is yet (we know what it is only after commitTransfers),
    // we can't update attempted timestamp in the db,
    // so we do it in memory here.
    const timestampOk = this.commitTxSentAt[destinationChainId] + TxRetryDelayMs < Date.now()
    if (timestampOk) {
      // This may happen either in the happy path case or if the transaction
      // has been in the mempool for too long and we want to retry
      this.commitTxSentAt[destinationChainId] = 0
    } else {
      this.logger.info(
        `commit tx for chainId ${destinationChainId} is in mempool`
      )
      return
    }

    // We must check on chain because this may run when the DB is syncing and our DB state is incomplete
    const l2Bridge = this.bridge as L2Bridge
    const totalPendingAmount = await l2Bridge.getPendingAmountForChainId(
      destinationChainId
    )
    const formattedPendingAmount = this.bridge.formatUnits(totalPendingAmount)

    const minThresholdAmount = this.getMinThresholdAmount(destinationChainId)
    if (totalPendingAmount.lte(minThresholdAmount)) {
      const formattedThreshold = this.bridge.formatUnits(
        minThresholdAmount
      )
      this.logger.warn(
        `dest ${destinationChainId}: pending amt ${formattedPendingAmount} less than min of ${formattedThreshold}.`
      )
      return
    }

    this.logger.debug(
      `total pending amount for chainId ${destinationChainId}: ${formattedPendingAmount}`
    )

    if (this.dryMode) {
      this.logger.warn(`dry: ${this.dryMode}, skipping commitTransfers`)
      return
    }

    this.logger.debug(
      `sending commitTransfers (destination chain ${destinationChainId}) tx`
    )
    this.commitTxSentAt[destinationChainId] = Date.now()

    try {
      const tx = await l2Bridge.commitTransfers(destinationChainId)
      const sourceChainId = await l2Bridge.getChainId()
      const msg = `L2 (${sourceChainId}) commitTransfers (destination chain ${destinationChainId}) tx: ${tx.hash}`
      this.logger.info(msg)
      this.notifier.info(msg)
    } catch (err) {
      this.logger.error('commitTransfers error:', err.message)
      throw err
    }
  }

  getMinThresholdAmount (destinationChainId: number) {
    return this.minThresholdAmounts[this.chainIdToSlug(destinationChainId)] || BigNumber.from(0)
  }
}

export default CommitTransfersWatcher
