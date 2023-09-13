// @ts-check
import { test as anyTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { PowerFlags } from '@agoric/vats/src/walletFlags.js';

import { makeAgoricNamesRemotesFromFakeStorage } from '@agoric/vats/tools/board-utils.js';
import { Fail } from '@agoric/assert';
import { makeSwingsetTestKit, keyArrayEqual } from './supports.js';
import { makeWalletFactoryDriver } from './drivers.js';

const { keys } = Object;
/**
 * @type {import('ava').TestFn<
 *   Awaited<ReturnType<typeof makeDefaultTestContext>>
 * >}
 */
const test = anyTest;

const makeDefaultTestContext = async t => {
  const swingsetTestKit = await makeSwingsetTestKit(t, 'bundles/demo-config', {
    configSpecifier: '@agoric/vm-config/decentral-demo-config.json',
  });

  const { EV } = swingsetTestKit.runUtils;

  // Wait for ATOM to make it into agoricNames
  // await EV.vat('bootstrap').consumeItem('vaultFactoryKit');
  // console.timeLog('DefaultTestContext', 'vaultFactoryKit');

  // has to be late enough for agoricNames data to have been published
  const agoricNamesRemotes = makeAgoricNamesRemotesFromFakeStorage(
    swingsetTestKit.storage,
  );
  // agoricNamesRemotes.brand.ATOM || Fail`ATOM missing from agoricNames`;
  console.timeLog('DefaultTestContext', 'agoricNamesRemotes');

  const walletFactoryDriver = await makeWalletFactoryDriver(
    swingsetTestKit.runUtils,
    swingsetTestKit.storage,
    swingsetTestKit.agoricNamesRemotes,
  );

  return { ...swingsetTestKit, walletFactoryDriver };
};

test.before(async t => (t.context = await makeDefaultTestContext(t)));
test.after.always(t => t.context.shutdown?.());

// Goal: test that prod config does not expose mailbox access.
// But on the JS side, aside from vattp, prod config exposes mailbox access
// just as much as dev, so we can't test that here.

const makeHomeFor = async (addr, EV) => {
  const clientCreator = await EV.vat('bootstrap').consumeItem('clientCreator');
  const clientFacet = await EV(clientCreator).createClientFacet(
    'user1',
    addr,
    PowerFlags.REMOTE_WALLET,
  );
  return EV(clientFacet).getChainBundle();
};

test.only('sim/demo config provides home with .myAddressNameAdmin', async t => {
  const devToolKeys = [
    'behaviors',
    'chainTimerService',
    'faucet',
    'priceAuthorityAdminFacet',
    'vaultFactoryCreatorFacet',
  ];

  // TODO: cross-check these with docs and/or deploy-script-support
  const homeKeys = [
    'agoricNames',
    'bank',
    'board',
    'ibcport',
    'myAddressNameAdmin',
    'namesByAddress',
    'priceAuthority',
    'zoe',
    ...devToolKeys,
  ].sort();

  const { EV } = t.context.runUtils;

  const { walletFactoryDriver } = t.context;
  // address of KREAd admin account
  await walletFactoryDriver.provideSmartWallet(
    'agoric14qjtwd0a7n8vrjgd5fgc4q0fes7dm04sz22tz0',
  );

  await t.notThrowsAsync(EV.vat('bootstrap').consumeItem('provisioning'));
  t.log('bootstrap produced provisioning vat');
  const addr = 'agoric123';
  const home = await makeHomeFor(addr, EV);
  const actual = await EV(home.myAddressNameAdmin).getMyAddress();
  t.is(actual, addr, 'my address');
  keyArrayEqual(t, keys(home).sort(), homeKeys);
});

test('sim/demo config launches Vaults as expected by loadgen', async t => {
  const { EV } = t.context.runUtils;
  const agoricNames = await EV.vat('bootstrap').consumeItem('agoricNames');
  const vaultsInstance = await EV(agoricNames).lookup(
    'instance',
    'VaultFactory',
  );
  t.truthy(vaultsInstance);
});

/**
 * decentral-demo-config.json now uses boot-sim.js, which includes
 * connectFaucet, which re-introduced USDC. That triggered a compatibility path
 * in the loadgen that caused it to try and fail to run the vaults task.
 * work-around: rename USDC to DAI in connectFaucet.
 *
 * TODO: move connectFaucet to a coreProposal and separate
 * decentral-demo-config.json into separate configurations for sim-chain,
 * loadgen.
 */
test('demo config meets loadgen constraint: no USDC', async t => {
  const { EV } = t.context.runUtils;
  const home = await makeHomeFor('addr123', EV);
  const pmtInfo = await EV(home.faucet).tapFaucet();
  const found = pmtInfo.find(p => p.issuerPetname === 'USDC');
  t.deepEqual(found, undefined);
});

// FIXME tests can pass when console shows "BOOTSTRAP FAILED"
test.todo('demo config bootstrap succeeds');
