import { assert } from 'chai'
import p from 'es6-promisify'
import Web3 from 'web3'
import MerkleTree, { checkProof, merkleRoot } from 'merkle-tree-solidity'
import { sha3 } from 'ethereumjs-util'
import setup from './setup'
import { parseChannel, getFingerprint, getRoot, solSha3, parseLogAddress,
  verifySignature, makeUpdate, verifyUpdate, parseBN } from './channel'
import { wait } from './utils'

const web3 = new Web3()

// goal - usable node.js middleware library for impression tracking
// ACF will be registrar first and operate adMarket first
// need to test out what auditing looks like
// reference implementation. 2 weeks till completion.
// offchain storage combines with this.
// need to manage state machine between both nodes, interaction with adMarket
// preference is to use redux + mori + some persistance (check my stars)

describe('AdMarket', async () => {

  let adMarket, eth, accounts, web3
  let snapshotId, filter

  before(async () => {
    let result = await setup()
    adMarket = result.adMarket
    eth = result.eth
    accounts = result.accounts
    web3 = result.web3
  })

  beforeEach(async () => {
    let res = await p(web3.currentProvider.sendAsync.bind(web3.currentProvider))({
      jsonrpc: '2.0',
      method: 'evm_snapshot',
      id: new Date().getTime()
    })
    snapshotId = res.result
    filter = web3.eth.filter({ address: adMarket.address, fromBlock: 0 })
  })

  afterEach(async () => {
    await p(filter.stopWatching.bind(filter))()
    await p(web3.currentProvider.sendAsync.bind(web3.currentProvider))({
      jsonrpc: '2.0',
      method: 'evm_revert',
      params: [snapshotId],
      id: new Date().getTime()
    })
  })

  it('setup', async () => {
    // channelCount should start at 0
    const channelCount = await adMarket.channelCount()
    assert.equal(+channelCount[0].toString(), 0)
  })

  it('registerDemand', async () => {
    const demand = accounts[1]
    const url = 'foo'
    await adMarket.registerDemand(demand, url)
    const result = await adMarket.registeredDemand(demand)
    assert.equal(result[0], url)

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[0].topics[1])
    assert.equal(logAddress, demand)
  })

  it('registerSupply', async () => {
    const supply = accounts[1]
    await adMarket.registerSupply(supply)
    const result = await adMarket.registeredSupply(supply)
    assert.equal(result[0], true)

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[0].topics[1])
    assert.equal(logAddress, supply)
  })

  it('registerArbiter', async () => {
    const arbiter = accounts[1]
    const url = 'foo'
    await adMarket.registerArbiter(arbiter, url)
    const result = await adMarket.registeredArbiter(arbiter)
    assert.equal(result[0], url)

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[0].topics[1])
    assert.equal(logAddress, arbiter)
  })

  it('deregisterDemand', async () => {
    const demand = accounts[1]
    const url = 'foo'
    await adMarket.registerDemand(demand, url)
    await adMarket.deregisterDemand(demand)
    const result = await adMarket.registeredDemand(demand)
    assert.equal(result[0], '')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, demand)
  })

  it('deregisterSupply', async () => {
    const supply = accounts[1]
    const url = 'foo'
    await adMarket.registerSupply(supply)
    await adMarket.deregisterSupply(supply)
    const result = await adMarket.registeredSupply(supply)
    assert.equal(result[0], '')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, supply)
  })

  it('deregisterArbiter', async () => {
    const arbiter = accounts[1]
    const url = 'foo'
    await adMarket.registerArbiter(arbiter, url)
    await adMarket.deregisterArbiter(arbiter)
    const result = await adMarket.registeredArbiter(arbiter)
    assert.equal(result[0], '')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, arbiter)
  })

  it('updateDemandUrl', async () => {
    const demand = accounts[1]
    const url = 'foo'
    await adMarket.registerDemand(demand, url)
    await adMarket.updateDemandUrl('bar', { from: demand })
    const result = await adMarket.registeredDemand(demand)
    assert.equal(result[0], 'bar')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, demand)
  })

  it('updateArbiterUrl', async () => {
    const arbiter = accounts[1]
    const url = 'foo'
    await adMarket.registerArbiter(arbiter, url)
    await adMarket.updateArbiterUrl('bar', { from: arbiter })
    const result = await adMarket.registeredArbiter(arbiter)
    assert.equal(result[0], 'bar')

    const logs = await p(filter.get.bind(filter))()
    const logAddress = parseLogAddress(logs[1].topics[1])
    assert.equal(logAddress, arbiter)
  })

  it('openChannel', async () => {
    const demand = accounts[1]
    const supply = accounts[2]
    const arbiter = accounts[3]
    const demandUrl = 'foo'
    const arbiterUrl = 'bar'
    const channelId = solSha3(0)
    await adMarket.registerDemand(demand, demandUrl)
    await adMarket.registerSupply(supply)
    await adMarket.registerArbiter(arbiter, arbiterUrl)

    const blockNumber = await p(web3.eth.getBlockNumber.bind(web3.eth))()
    const channelTimeout = parseBN((await p(adMarket.channelTimeout)())[0])
    const expiration = blockNumber + channelTimeout + 1

    await adMarket.openChannel(supply, arbiter, { from: demand })

    const channel = parseChannel(await adMarket.getChannel(channelId))

    assert.equal(channel.contractId, adMarket.address)
    assert.equal(channel.channelId, channelId)
    assert.equal(channel.demand, demand)
    assert.equal(channel.supply, supply)
    assert.equal(channel.arbiter, arbiter)
    assert.equal(parseInt(channel.root, 16), 0)
    assert.equal(channel.state, 0)
    assert.equal(channel.expiration, expiration)
    assert.equal(channel.challengeTimeout, 0)
    assert.equal(parseInt(channel.proposedRoot, 16), 0)
  })

  it('proposeCheckpointChannel', async () => {
    const demand = accounts[1]
    const supply = accounts[2]
    const arbiter = accounts[3]
    const demandUrl = 'foo'
    const arbiterUrl = 'bar'
    const channelId = solSha3(0)
    await adMarket.registerDemand(demand, demandUrl)
    await adMarket.registerSupply(supply)
    await adMarket.registerArbiter(arbiter, arbiterUrl)
    await adMarket.openChannel(supply, arbiter, { from: demand })
    const channel = parseChannel(await adMarket.getChannel(channelId))

    const blockNumber = await p(web3.eth.getBlockNumber.bind(web3.eth))()
    const challengePeriod = parseBN((await p(adMarket.challengePeriod)())[0])
    const challengeTimeout = blockNumber + challengePeriod + 1

    const proposedRoot = solSha3('wut')
    channel.root = proposedRoot
    const fingerprint = getFingerprint(channel)
    const sig = await p(web3.eth.sign)(demand, fingerprint)
    await adMarket.proposeCheckpointChannel(
      channelId, proposedRoot, sig, { from: demand }
    )

    const updatedChannel = parseChannel(await adMarket.getChannel(channelId))
    assert.equal(updatedChannel.state, 1)
    assert.equal(updatedChannel.challengeTimeout, challengeTimeout)
    assert.equal(updatedChannel.proposedRoot, proposedRoot)
  })

  it('challengeCheckpointChannel', async () => {
    const demand = accounts[1]
    const supply = accounts[2]
    const arbiter = accounts[3]
    const demandUrl = 'foo'
    const arbiterUrl = 'bar'
    await adMarket.registerDemand(demand, demandUrl)
    await adMarket.registerSupply(supply)
    await adMarket.registerArbiter(arbiter, arbiterUrl)
    await adMarket.openChannel(supply, arbiter, { from: demand })
    const channel = parseChannel(await adMarket.getChannel(channelId))

    // todo make channel

    const input = {
      impressionId: web3.sha3('bar'),
      impressionPrice: 2
    }



  })

  it('verifySignature', async () => {
    const channel = {
      contractId: '0x12345123451234512345',
      channelId: web3.sha3('foo'),
      demand: '0x11111111111111111111',
      supply: '0x22222222222222222222',
      impressionId: 'foo',
      impressionPrice: 1,
      impressions: 1000,
      balance: 1000
    }

    channel.root = getRoot(channel, web3.sha3('foo'))

    const fingerprint = getFingerprint(channel)
    const sig = await p(web3.eth.sign)(accounts[0], fingerprint)
    assert.ok(verifySignature(channel, sig, accounts[0]))
  })
})