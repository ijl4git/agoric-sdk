// @ts-check
import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';
import { eventLoopIteration } from '@agoric/notifier/tools/testSupports.js';
import { makeAgoricNamesRemotesFromFakeStorage } from '@agoric/vats/tools/board-utils.js';
import { Offers } from '@agoric/inter-protocol/src/clientSupport.js';
import { makeWalletFactoryDriver } from '../../tools/drivers';
import { makeSwingsetTestKit } from '../../tools/supports';
import {
  restartWalletFactoryScript,
  sendInvitationScript,
  upgradeZoeScript,
} from './wallet-scripts.js';

const { Fail } = assert;

/**
 * @type {import('ava').TestFn<
 *   Awaited<ReturnType<typeof makeTestContext>>
 * >}
 */
const test = anyTest;

// main/production config doesn't have initialPrice, upon which 'open vaults' depends
const PLATFORM_CONFIG = '@agoric/vm-config/decentral-itest-vaults-config.json';

const makeTestContext = async t => {
  const swingsetTestKit = await makeSwingsetTestKit(t.log, 'bundles/wallet', {
    configSpecifier: PLATFORM_CONFIG,
  });

  const { runUtils, storage } = swingsetTestKit;
  console.timeLog('DefaultTestContext', 'swingsetTestKit');
  const { EV } = runUtils;

  // vaultFactoryKit is one of the last things produced in bootstrap.
  await EV.vat('bootstrap').consumeItem('vaultFactoryKit');

  await eventLoopIteration();
  // wait for bootstrap to settle before looking in storage for brands etc.
  const agoricNamesRemotes = makeAgoricNamesRemotesFromFakeStorage(
    swingsetTestKit.storage,
  );
  agoricNamesRemotes.brand.ATOM || Fail`ATOM brand not yet defined`;

  const walletFactoryDriver = await makeWalletFactoryDriver(
    runUtils,
    storage,
    agoricNamesRemotes,
  );

  return {
    walletFactoryDriver,
    runUtils,
    agoricNamesRemotes,
  };
};

test.before(async t => (t.context = await makeTestContext(t)));

/**
 * @param {import('ava').ExecutionContext<Awaited<ReturnType<typeof makeTestContext>>>} t
 */
const makeScenario = async t => {
  const { agoricNamesRemotes } = t.context;

  const findPurse = (current, _brand = agoricNamesRemotes.brand.Invitation) => {
    // getCurrentWalletRecord and agoricNamesRemotes
    // aren't using the same marshal context. hmm.
    //     return (
    //       current.purses.find(p => p.brand === brand) ||
    //       Fail`brand ${brand} not found`
    //     );
    return current.purses[0];
  };

  const { EV } = t.context.runUtils;
  /** @type {ERef<import('@agoric/vats/src/types.js').BridgeHandler>} */
  const coreEvalBridgeHandler = await EV.vat('bootstrap').consumeItem(
    'coreEvalBridgeHandler',
  );

  const runCoreEval = async evals => {
    const bridgeMessage = {
      type: 'CORE_EVAL',
      evals,
    };
    await EV(coreEvalBridgeHandler).fromBridge(bridgeMessage);
  };

  return { findPurse, runCoreEval };
};

test('update purse balance across zoe upgrade', async t => {
  const { walletFactoryDriver } = t.context;
  const { findPurse, runCoreEval } = await makeScenario(t);

  t.log('provision a smartWallet for an oracle operator');
  const oraAddr = 'agoric1oracle-operator';
  const oraWallet = await walletFactoryDriver.provideSmartWallet(oraAddr);

  t.log('upgrade zoe');
  await runCoreEval([
    {
      json_permits: JSON.stringify({
        consume: { vatStore: true, vatAdminSvc: true },
      }),
      js_code: `(${upgradeZoeScript})()`,
    },
  ]);

  t.log('send an invitation to the oracle operator');
  await runCoreEval([
    {
      json_permits: JSON.stringify({
        consume: { namesByAddressAdmin: true, zoe: true },
        instance: { consume: { reserve: true } },
      }),
      js_code: `(${sendInvitationScript})()`.replace('ADDRESS', oraAddr),
    },
  ]);

  const current = oraWallet.getCurrentWalletRecord();
  t.log(
    'invitation balance after sending invitation',
    findPurse(current).balance,
  );
  t.notDeepEqual(findPurse(current).balance.value, [], 'invitation set');
});

test('update purse balance across walletFactory upgrade', async t => {
  const { walletFactoryDriver } = t.context;
  const { findPurse, runCoreEval } = await makeScenario(t);

  t.log('provision a smartWallet for another oracle operator');
  const oraAddr = 'agoric1oracle-operator2';
  const oraWallet = await walletFactoryDriver.provideSmartWallet(oraAddr);

  t.log('upgrade (restart) walletFactory');
  await runCoreEval([
    {
      json_permits: JSON.stringify({
        consume: { instancePrivateArgs: true, walletFactoryStartResult: true },
      }),
      js_code: `(${restartWalletFactoryScript})()`,
    },
  ]);

  t.log('send an invitation to the oracle operator');
  await runCoreEval([
    {
      json_permits: JSON.stringify({
        consume: { namesByAddressAdmin: true, zoe: true },
        instance: { consume: { reserve: true } },
      }),
      js_code: `(${sendInvitationScript})()`.replace('ADDRESS', oraAddr),
    },
  ]);

  const current = oraWallet.getCurrentWalletRecord();
  t.log(
    'invitation balance after sending invitation',
    findPurse(current).balance,
  );
  t.notDeepEqual(findPurse(current).balance.value, [], 'invitation set');
});

test.todo('smartWallet created before upgrade works after');

test.failing('offer lasts across zoe upgrade', async t => {
  const { walletFactoryDriver, agoricNamesRemotes } = t.context;
  const { runCoreEval } = await makeScenario(t);

  t.log('provision a smartWallet for a bidder');
  const bidderAddr = 'agoric1bidder';
  const bidderWallet = await walletFactoryDriver.provideSmartWallet(bidderAddr);

  console.log(
    '======== before IST swap',
    bidderWallet.getCurrentWalletRecord(),
  );

  await bidderWallet.sendOffer(
    Offers.psm.swap(
      agoricNamesRemotes,
      agoricNamesRemotes.instance['psm-IST-USDC_axl'],
      { offerId: `print-ist1`, wantMinted: 1_000, pair: ['IST', 'USDC_axl'] },
    ),
  );
  console.log(
    '======= IST swap done; bidding...',
    bidderWallet.getCurrentWalletRecord(),
  );

  const offerId = 'bid1';
  await bidderWallet.sendOfferMaker(Offers.auction.Bid, {
    offerId,
    give: '10 IST',
    maxBuy: '1000000 ATOM',
    price: 5,
  });
  console.log(
    'bid placed; upgrading...',
    bidderWallet.getCurrentWalletRecord(),
  );

  t.log('upgrade zoe');
  await runCoreEval([
    {
      json_permits: JSON.stringify({
        consume: { vatStore: true, vatAdminSvc: true },
      }),
      js_code: `(${upgradeZoeScript})()`,
    },
  ]);

  const updateAfterUpgrade = bidderWallet.getLatestUpdateRecord();
  t.is(updateAfterUpgrade.updated, 'offerStatus');
  t.is(
    updateAfterUpgrade.updated === 'offerStatus' &&
      updateAfterUpgrade.status.error,
    undefined,
  );

  console.log('======= upgraded update', bidderWallet.getLatestUpdateRecord());

  console.log(
    '========= upgraded current',
    bidderWallet.getCurrentWalletRecord(),
  );

  t.fail('todo');
});
