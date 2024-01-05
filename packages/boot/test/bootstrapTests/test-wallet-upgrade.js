// @ts-check
import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';
import { eventLoopIteration } from '@agoric/notifier/tools/testSupports.js';
import { makeAgoricNamesRemotesFromFakeStorage } from '@agoric/vats/tools/board-utils.js';
import { makeWalletFactoryDriver } from '../../tools/drivers';
import { makeSwingsetTestKit } from '../../tools/supports';
import { sendInvitationScript, upgradeZoeScript } from './wallet-scripts.js';

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

test('update purse balance across upgrade', async t => {
  const oraAddr = 'agoric1oracle-operator';
  const { walletFactoryDriver, agoricNamesRemotes } = t.context;
  t.log('provision a smartWallet for an oracle operator');
  const oraWallet = await walletFactoryDriver.provideSmartWallet(oraAddr);

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
      js_code: `(${sendInvitationScript})()`,
    },
  ]);

  const current = oraWallet.getCurrentWalletRecord();
  t.log(
    'invitation balance after sending invitation',
    findPurse(current).balance,
  );
  t.notDeepEqual(findPurse(current).balance.value, [], 'invitation set');
});
