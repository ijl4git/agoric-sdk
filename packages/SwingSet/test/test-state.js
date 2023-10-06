// @ts-nocheck
/* eslint-disable no-useless-concat */
// eslint-disable-next-line import/order
import { test } from '../tools/prepare-test-env-ava.js';

import { createHash } from 'crypto';
import { initSwingStore } from '@agoric/swing-store';
import makeKernelKeeper from '../src/kernel/state/kernelKeeper.js';
import { makeKernelStats } from '../src/kernel/state/stats.js';
import { KERNEL_STATS_METRICS } from '../src/kernel/metrics.js';
import { kser, kslot } from '../src/lib/kmarshal.js';
import {
  enumeratePrefixedKeys,
  getPrefixedValues,
  deletePrefixedKeys,
} from '../src/kernel/state/storageHelper.js';

const ignoredStateKeys = ['activityhash', 'kernelStats', 'local.kernelStats'];

function checkState(t, dump, expected) {
  const state = dump().kvEntries;
  const got = [];
  for (const key of Object.getOwnPropertyNames(state)) {
    if (!ignoredStateKeys.includes(key)) {
      // the hash is just too annoying to compare against
      got.push([key, state[key]]);
    }
  }
  function compareStrings(a, b) {
    if (a > b) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
    return 0;
  }
  t.deepEqual(got.sort(compareStrings), expected.sort(compareStrings));
}

async function testStorage(t, s, dump, commit) {
  t.falsy(s.has('missing'));
  t.is(s.get('missing'), undefined);

  s.set('foo', 'f');
  t.truthy(s.has('foo'));
  t.is(s.get('foo'), 'f');

  s.set('foo2', 'f2');
  s.set('foo1', 'f1');
  s.set('foo3', 'f3');
  t.deepEqual(s.getNextKey('d-early'), 'foo');
  t.deepEqual(s.getNextKey('foo'), 'foo1');
  t.deepEqual(s.getNextKey('foo1'), 'foo2');
  t.deepEqual(s.getNextKey('foo2'), 'foo3');
  t.deepEqual(s.getNextKey('foo3'), undefined);
  t.deepEqual(s.getNextKey('late'), undefined);

  s.delete('foo2');
  t.falsy(s.has('foo2'));
  t.is(s.get('foo2'), undefined);
  t.deepEqual(s.getNextKey('foo1'), 'foo3');

  if (commit) {
    checkState(t, dump, []);
    await commit();
  }
  checkState(t, dump, [
    ['foo', 'f'],
    ['foo1', 'f1'],
    ['foo3', 'f3'],
  ]);
}

test('storageInMemory', async t => {
  const { kernelStorage, debug } = initSwingStore(null);
  await testStorage(t, kernelStorage.kvStore, debug.dump, null);
});

test('storage helpers', t => {
  const { kernelStorage, debug } = initSwingStore(null);
  const kv = kernelStorage.kvStore;

  kv.set('foo.0', 'f0');
  kv.set('foo.1', 'f1');
  kv.set('foo.2', 'f2');
  kv.set('foo.3', 'f3');
  // omit foo.4
  kv.set('foo.5', 'f5');
  checkState(t, debug.dump, [
    ['foo.0', 'f0'],
    ['foo.1', 'f1'],
    ['foo.2', 'f2'],
    ['foo.3', 'f3'],
    ['foo.5', 'f5'],
  ]);

  t.deepEqual(Array.from(getPrefixedValues(kv, 'foo.')), [
    'f0',
    'f1',
    'f2',
    'f3',
  ]);

  deletePrefixedKeys(kv, 'foo.');
  t.falsy(kv.has('foo.0'));
  t.falsy(kv.has('foo.1'));
  t.falsy(kv.has('foo.2'));
  t.falsy(kv.has('foo.3'));
  t.falsy(kv.has('foo.4'));
  // `getPrefixedValues` and `deletePrefixedKeys` both work by counting from
  // zero, so if there is a gap in the key sequence (e.g., 'foo.4' in the
  // above), they stop counting when they hit it
  t.truthy(kv.has('foo.5'));
  checkState(t, debug.dump, [['foo.5', 'f5']]);

  // now check lexicographic ordering with enumeratePrefixedKeys
  kv.set('bar', 'b');
  kv.set('bar.1', 'b1');
  kv.set('bar.3', 'b3');
  kv.set('bar.5', 'b5');
  kv.set('cab.2', 'c');

  t.deepEqual(Array.from(enumeratePrefixedKeys(kv, 'bar')), [
    'bar.1',
    'bar.3',
    'bar.5',
  ]);

  t.deepEqual(Array.from(enumeratePrefixedKeys(kv, 'bar', 'bar.1')), []);
  t.deepEqual(Array.from(enumeratePrefixedKeys(kv, 'bar', 'bar.4')), [
    'bar.1',
    'bar.3',
  ]);
  t.deepEqual(Array.from(enumeratePrefixedKeys(kv, 'bar', 'bar.5')), [
    'bar.1',
    'bar.3',
  ]);
  t.deepEqual(Array.from(enumeratePrefixedKeys(kv, 'bar', 'bar.6')), [
    'bar.1',
    'bar.3',
    'bar.5',
  ]);
});

function buildKeeperStorageInMemory() {
  const { kernelStorage, debug } = initSwingStore(null);
  return {
    ...debug, // serialize, dump
    ...kernelStorage,
  };
}

function duplicateKeeper(serialize) {
  const serialized = serialize();
  const { kernelStorage } = initSwingStore(null, { serialized });
  const kernelKeeper = makeKernelKeeper(kernelStorage, null);
  kernelKeeper.loadStats();
  return kernelKeeper;
}

test('kernelStorage param guards', async t => {
  const { kvStore } = buildKeeperStorageInMemory();
  const expv = { message: /value must be a string/ };
  const expk = { message: /key must be a string/ };
  const exppk = { message: /previousKey must be a string/ };
  t.throws(() => kvStore.set('foo', true), expv);
  t.throws(() => kvStore.set(true, 'foo'), expk);
  t.throws(() => kvStore.has(true), expk);
  t.throws(() => kvStore.getNextKey(true), exppk);
  t.throws(() => kvStore.get(true), expk);
  t.throws(() => kvStore.delete(true), expk);
});

test('kernel state', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  t.truthy(!k.getInitialized());
  k.createStartingKernelState({ defaultManagerType: 'local' });
  k.setInitialized();

  k.emitCrankHashes();
  checkState(t, store.dump, [
    ['crankNumber', '0'],
    ['initialized', 'true'],
    ['gcActions', '[]'],
    ['runQueue', '[1,1]'],
    ['acceptanceQueue', '[1,1]'],
    ['reapQueue', '[]'],
    ['vat.nextID', '1'],
    ['vat.nextUpgradeID', '1'],
    ['vat.names', '[]'],
    ['vat.dynamicIDs', '[]'],
    ['device.names', '[]'],
    ['device.nextID', '7'],
    ['ko.nextID', '20'],
    ['kd.nextID', '30'],
    ['kp.nextID', '40'],
    ['kernel.defaultManagerType', 'local'],
    ['kernel.defaultReapInterval', '1'],
    ['kernel.snapshotInitial', '3'],
    ['kernel.snapshotInterval', '200'],
    ['meter.nextID', '1'],
  ]);
});

test('kernelKeeper vat names', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  const v1 = k.allocateVatIDForNameIfNeeded('vatname5');
  const v2 = k.allocateVatIDForNameIfNeeded('Frank');
  t.is(v1, 'v1');
  t.is(v2, 'v2');

  k.emitCrankHashes();
  checkState(t, store.dump, [
    ['crankNumber', '0'],
    ['gcActions', '[]'],
    ['runQueue', '[1,1]'],
    ['acceptanceQueue', '[1,1]'],
    ['reapQueue', '[]'],
    ['vat.nextID', '3'],
    ['vat.nextUpgradeID', '1'],
    ['vat.names', JSON.stringify(['vatname5', 'Frank'])],
    ['vat.dynamicIDs', '[]'],
    ['device.names', '[]'],
    ['device.nextID', '7'],
    ['ko.nextID', '20'],
    ['kd.nextID', '30'],
    ['kp.nextID', '40'],
    ['vat.name.vatname5', 'v1'],
    ['vat.name.Frank', 'v2'],
    ['kernel.defaultManagerType', 'local'],
    ['kernel.defaultReapInterval', '1'],
    ['kernel.snapshotInitial', '3'],
    ['kernel.snapshotInterval', '200'],
    ['meter.nextID', '1'],
  ]);
  t.deepEqual(k.getStaticVats(), [
    ['Frank', 'v2'],
    ['vatname5', 'v1'],
  ]);
  t.is(k.getVatIDForName('Frank'), v2);
  t.is(k.allocateVatIDForNameIfNeeded('Frank'), v2);

  const k2 = duplicateKeeper(store.serialize);
  t.deepEqual(k.getStaticVats(), [
    ['Frank', 'v2'],
    ['vatname5', 'v1'],
  ]);
  t.is(k2.getVatIDForName('Frank'), v2);
  t.is(k2.allocateVatIDForNameIfNeeded('Frank'), v2);
});

test('kernelKeeper device names', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  const d7 = k.allocateDeviceIDForNameIfNeeded('devicename5');
  const d8 = k.allocateDeviceIDForNameIfNeeded('Frank');
  t.is(d7, 'd7');
  t.is(d8, 'd8');

  k.emitCrankHashes();
  checkState(t, store.dump, [
    ['crankNumber', '0'],
    ['gcActions', '[]'],
    ['runQueue', '[1,1]'],
    ['acceptanceQueue', '[1,1]'],
    ['reapQueue', '[]'],
    ['vat.nextID', '1'],
    ['vat.nextUpgradeID', '1'],
    ['vat.names', '[]'],
    ['vat.dynamicIDs', '[]'],
    ['device.nextID', '9'],
    ['device.names', JSON.stringify(['devicename5', 'Frank'])],
    ['ko.nextID', '20'],
    ['kd.nextID', '30'],
    ['kp.nextID', '40'],
    ['device.name.devicename5', 'd7'],
    ['device.name.Frank', 'd8'],
    ['kernel.defaultManagerType', 'local'],
    ['kernel.defaultReapInterval', '1'],
    ['kernel.snapshotInitial', '3'],
    ['kernel.snapshotInterval', '200'],
    ['meter.nextID', '1'],
  ]);
  t.deepEqual(k.getDevices(), [
    ['Frank', 'd8'],
    ['devicename5', 'd7'],
  ]);
  t.is(k.getDeviceIDForName('Frank'), d8);
  t.is(k.allocateDeviceIDForNameIfNeeded('Frank'), d8);

  const k2 = duplicateKeeper(store.serialize);
  t.deepEqual(k.getDevices(), [
    ['Frank', 'd8'],
    ['devicename5', 'd7'],
  ]);
  t.is(k2.getDeviceIDForName('Frank'), d8);
  t.is(k2.allocateDeviceIDForNameIfNeeded('Frank'), d8);
});

test('kernelKeeper runQueue', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  t.is(k.getRunQueueLength(), 0);
  t.is(k.getNextRunQueueMsg(), undefined);

  k.addToRunQueue({ type: 'send', stuff: 'awesome' });
  t.is(k.getRunQueueLength(), 1);

  k.addToRunQueue({ type: 'notify', stuff: 'notifawesome' });
  t.is(k.getRunQueueLength(), 2);

  k.emitCrankHashes();
  const k2 = duplicateKeeper(store.serialize);

  t.deepEqual(k.getNextRunQueueMsg(), { type: 'send', stuff: 'awesome' });
  t.is(k.getRunQueueLength(), 1);

  t.deepEqual(k.getNextRunQueueMsg(), {
    type: 'notify',
    stuff: 'notifawesome',
  });
  t.is(k.getRunQueueLength(), 0);
  t.is(k.getNextRunQueueMsg(), undefined);

  t.deepEqual(k2.getNextRunQueueMsg(), { type: 'send', stuff: 'awesome' });
  t.is(k2.getRunQueueLength(), 1);

  t.deepEqual(k2.getNextRunQueueMsg(), {
    type: 'notify',
    stuff: 'notifawesome',
  });
  t.is(k2.getRunQueueLength(), 0);
  t.is(k2.getNextRunQueueMsg(), undefined);
});

test('kernelKeeper promises', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  const p1 = k.addKernelPromiseForVat('v4');
  t.deepEqual(k.getKernelPromise(p1), {
    state: 'unresolved',
    policy: 'ignore',
    refCount: 0,
    queue: [],
    subscribers: [],
    decider: 'v4',
  });
  t.truthy(k.hasKernelPromise(p1));
  t.falsy(k.hasKernelPromise('kp99'));

  k.emitCrankHashes();
  let k2 = duplicateKeeper(store.serialize);

  t.deepEqual(k2.getKernelPromise(p1), {
    state: 'unresolved',
    policy: 'ignore',
    refCount: 0,
    queue: [],
    subscribers: [],
    decider: 'v4',
  });
  t.truthy(k2.hasKernelPromise(p1));

  k.clearDecider(p1);
  t.deepEqual(k.getKernelPromise(p1), {
    state: 'unresolved',
    policy: 'ignore',
    refCount: 0,
    queue: [],
    subscribers: [],
    decider: undefined,
  });

  k.emitCrankHashes();
  k2 = duplicateKeeper(store.serialize);
  t.deepEqual(k2.getKernelPromise(p1), {
    state: 'unresolved',
    policy: 'ignore',
    refCount: 0,
    queue: [],
    subscribers: [],
    decider: undefined,
  });

  k.setDecider(p1, 'v7');
  t.deepEqual(k.getKernelPromise(p1), {
    state: 'unresolved',
    policy: 'ignore',
    refCount: 0,
    queue: [],
    subscribers: [],
    decider: 'v7',
  });

  k.addSubscriberToPromise(p1, 'v5');
  t.deepEqual(k.getKernelPromise(p1).subscribers, ['v5']);
  k.addSubscriberToPromise(p1, 'v3');
  t.deepEqual(k.getKernelPromise(p1).subscribers, ['v3', 'v5']);

  const expectedAcceptanceQueue = [];
  const m1 = { methargs: kser(['m1', []]) };
  k.addMessageToPromiseQueue(p1, m1);
  k.incrementRefCount(p1);
  t.deepEqual(k.getKernelPromise(p1).refCount, 1);
  expectedAcceptanceQueue.push({ type: 'send', target: 'kp40', msg: m1 });

  const m2 = { methargs: kser(['m2', []]) };
  k.addMessageToPromiseQueue(p1, m2);
  k.incrementRefCount(p1);
  t.deepEqual(k.getKernelPromise(p1).queue, [m1, m2]);
  t.deepEqual(k.getKernelPromise(p1).refCount, 2);
  expectedAcceptanceQueue.push({ type: 'send', target: 'kp40', msg: m2 });

  k.emitCrankHashes();
  k2 = duplicateKeeper(store.serialize);
  t.deepEqual(k2.getKernelPromise(p1).queue, [m1, m2]);

  const ko = k.addKernelObject('v1');
  t.is(k.getStats().kernelObjects, 1);
  // when we resolve the promise, all its queued messages are moved to the
  // run-queue, and its refcount remains the same
  const resolution = kser(kslot(ko));
  k.resolveKernelPromise(p1, false, resolution);
  t.deepEqual(k.getKernelPromise(p1), {
    state: 'fulfilled',
    refCount: 2,
    data: resolution,
  });
  t.truthy(k.hasKernelPromise(p1));
  // all the subscriber/queue stuff should be gone
  k.emitCrankHashes();

  checkState(t, store.dump, [
    ['crankNumber', '0'],
    ['device.nextID', '7'],
    ['vat.nextID', '1'],
    ['vat.nextUpgradeID', '1'],
    ['vat.names', '[]'],
    ['vat.dynamicIDs', '[]'],
    ['device.names', '[]'],
    ['gcActions', '[]'],
    ['runQueue', '[1,1]'],
    ['acceptanceQueue', '[1,3]'],
    ['acceptanceQueue.1', JSON.stringify(expectedAcceptanceQueue[0])],
    ['acceptanceQueue.2', JSON.stringify(expectedAcceptanceQueue[1])],
    ['reapQueue', '[]'],
    ['kd.nextID', '30'],
    ['ko.nextID', '21'],
    ['kp.nextID', '41'],
    ['kp40.data.body', '#"$0.Alleged: undefined"'],
    ['kp40.data.slots', ko],
    ['kp40.state', 'fulfilled'],
    ['kp40.refCount', '2'],
    [`${ko}.owner`, 'v1'],
    [`${ko}.refCount`, '1,1'],
    ['kernel.defaultManagerType', 'local'],
    ['kernel.defaultReapInterval', '1'],
    ['kernel.snapshotInitial', '3'],
    ['kernel.snapshotInterval', '200'],
    ['meter.nextID', '1'],
  ]);

  k.deleteKernelObject(ko);
  t.is(k.getStats().kernelObjects, 0);
});

test('kernelKeeper promise resolveToData', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  const p1 = k.addKernelPromiseForVat('v4');
  const o1 = k.addKernelObject('v1');
  const resolution = kser(kslot(o1));
  k.resolveKernelPromise(p1, false, resolution);
  t.deepEqual(k.getKernelPromise(p1), {
    state: 'fulfilled',
    refCount: 0,
    data: kser(kslot(o1)),
  });
});

test('kernelKeeper promise reject', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  const p1 = k.addKernelPromiseForVat('v4');
  const o1 = k.addKernelObject('v1');
  const resolution = kser(kslot(o1));
  k.resolveKernelPromise(p1, true, resolution);
  t.deepEqual(k.getKernelPromise(p1), {
    state: 'rejected',
    refCount: 0,
    data: kser(kslot(o1)),
  });
});

test('vatKeeper', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  const v1 = k.allocateVatIDForNameIfNeeded('name1');
  const vk = k.provideVatKeeper(v1);
  // TODO: confirm that this level of caching is part of the API
  t.is(vk, k.provideVatKeeper(v1));

  const vatExport1 = 'o+4';
  const kernelExport1 = vk.mapVatSlotToKernelSlot(vatExport1);
  t.is(kernelExport1, 'ko20');
  t.is(vk.mapVatSlotToKernelSlot(vatExport1), kernelExport1);
  t.is(vk.mapKernelSlotToVatSlot(kernelExport1), vatExport1);
  t.is(vk.nextDeliveryNum(), 0n);
  t.is(vk.nextDeliveryNum(), 0n); // incremented only by addToTranscript

  k.emitCrankHashes();
  let vk2 = duplicateKeeper(store.serialize).provideVatKeeper(v1);
  t.is(vk2.mapVatSlotToKernelSlot(vatExport1), kernelExport1);
  t.is(vk2.mapKernelSlotToVatSlot(kernelExport1), vatExport1);
  t.is(vk2.nextDeliveryNum(), 0n);

  const kernelImport2 = k.addKernelObject('v1', 25);
  const vatImport2 = vk.mapKernelSlotToVatSlot(kernelImport2);
  t.is(vatImport2, 'o-50');
  t.is(vk.mapKernelSlotToVatSlot(kernelImport2), vatImport2);
  t.is(vk.mapVatSlotToKernelSlot(vatImport2), kernelImport2);

  k.emitCrankHashes();
  vk2 = duplicateKeeper(store.serialize).provideVatKeeper(v1);
  t.is(vk2.mapKernelSlotToVatSlot(kernelImport2), vatImport2);
  t.is(vk2.mapVatSlotToKernelSlot(vatImport2), kernelImport2);
});

test('vatKeeper.getOptions', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });

  const v1 = k.allocateVatIDForNameIfNeeded('name1');
  const vk = k.provideVatKeeper(v1);
  const bundleID =
    'b1-00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
  vk.setSourceAndOptions(
    { bundleID },
    {
      workerOptions: { type: 'local' },
      name: 'fred',
    },
  );
  const { name } = vk.getOptions();
  t.is(name, 'fred');
});

test('XS vatKeeper defaultManagerType', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'xs-worker' });
  t.is(k.getDefaultManagerType(), 'xs-worker');
});

test('meters', async t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });
  const m1 = k.allocateMeter(100n, 10n);
  const m2 = k.allocateMeter(200n, 150n);
  t.not(m1, m2);
  k.deleteMeter(m2);
  t.deepEqual(k.getMeter(m1), { remaining: 100n, threshold: 10n });
  // checkMeter has no side-effects
  t.is(k.checkMeter(m1, 10n), true);
  t.is(k.checkMeter(m1, 100n), true);
  t.is(k.checkMeter(m1, 101n), false);
  t.is(k.checkMeter(m1, 10n), true);

  t.is(k.checkMeter(m1, 10n), true);
  t.is(k.deductMeter(m1, 10n), false);
  t.is(k.checkMeter(m1, 10n), true);
  t.is(k.deductMeter(m1, 10n), false);
  t.deepEqual(k.getMeter(m1), { remaining: 80n, threshold: 10n });
  t.is(k.checkMeter(m1, 70n), true);
  t.is(k.deductMeter(m1, 70n), false);
  t.is(k.checkMeter(m1, 1n), true);
  t.is(k.deductMeter(m1, 1n), true);
  t.deepEqual(k.getMeter(m1), { remaining: 9n, threshold: 10n });
  t.is(k.checkMeter(m1, 1n), true);
  t.is(k.deductMeter(m1, 1n), false);
  t.is(k.checkMeter(m1, 9n), false);
  t.is(k.deductMeter(m1, 9n), false);
  t.deepEqual(k.getMeter(m1), { remaining: 0n, threshold: 10n });
  t.is(k.checkMeter(m1, 2n), false);
  t.is(k.deductMeter(m1, 2n), false);
  t.deepEqual(k.getMeter(m1), { remaining: 0n, threshold: 10n });
  k.addMeterRemaining(m1, 50n);
  t.deepEqual(k.getMeter(m1), { remaining: 50n, threshold: 10n });
  t.is(k.checkMeter(m1, 30n), true);
  t.is(k.deductMeter(m1, 30n), false);
  t.is(k.checkMeter(m1, 25n), false);
  t.is(k.deductMeter(m1, 25n), true);
  t.deepEqual(k.getMeter(m1), { remaining: 0n, threshold: 10n });

  k.addMeterRemaining(m1, 50n);
  k.setMeterThreshold(m1, 40n);
  t.deepEqual(k.getMeter(m1), { remaining: 50n, threshold: 40n });
  t.is(k.checkMeter(m1, 10n), true);
  t.is(k.deductMeter(m1, 10n), false);
  t.is(k.checkMeter(m1, 10n), true);
  t.is(k.deductMeter(m1, 10n), true);
  t.deepEqual(k.getMeter(m1), { remaining: 30n, threshold: 40n });

  const m3 = k.allocateMeter('unlimited', 10n);
  k.setMeterThreshold(m3, 5n);
  t.deepEqual(k.getMeter(m3), { remaining: 'unlimited', threshold: 5n });
  t.is(k.checkMeter(m3, 1000n), true);
  t.is(k.deductMeter(m3, 1000n), false);
  t.deepEqual(k.getMeter(m3), { remaining: 'unlimited', threshold: 5n });
});

const testCrankHasherStats = makeKernelStats(KERNEL_STATS_METRICS);
testCrankHasherStats.initializeStats();
const { consensusStats: testCrankHasherConsensusStats } =
  testCrankHasherStats.getSerializedStats();

/**
 * Wraps a base sha256 hasher always appending the initial kernel stats
 * before generating the digest.
 * Assumes tests do not perform complex kernelKeeper operations that
 * change the stats.
 *
 * @param {string} [algorithm]
 */
const makeTestCrankHasher = (algorithm = 'sha256') => {
  const h = createHash(algorithm);
  const update = h.update.bind(h);
  const digest = (encoding = 'hex') => {
    update('add\n' + 'kernelStats\n' + `${testCrankHasherConsensusStats}\n`);
    return h.digest(encoding);
  };

  return {
    update,
    digest,
  };
};

test('crankhash - initial state and additions', t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });
  k.emitCrankHashes();
  // the initial state additions happen to hash to this:
  const initialActivityHash = store.kvStore.get('activityhash');
  t.snapshot(initialActivityHash, 'initial state');

  // a crank which sets a single key produces a stable crankhash, which does
  // not depend upon the earlier activityhash of kernel state
  k.kvStore.set('one', '1');
  let h = makeTestCrankHasher('sha256');
  h.update('add\n' + 'one\n' + '1\n');
  const expCrankhash = h.digest('hex');
  t.is(
    expCrankhash,
    '136550ffca718f8097396cbecb511aa2320d9ddc9bda5cebbafb64081b29e1e6',
  );

  h = createHash('sha256');
  h.update('activityhash\n');
  h.update(`${initialActivityHash}\n${expCrankhash}\n`);
  const expectedActivityHash = h.digest('hex');
  t.snapshot(expectedActivityHash, 'expected activityhash');

  const { crankhash, activityhash } = k.emitCrankHashes();
  t.is(crankhash, expCrankhash);
  t.is(activityhash, expectedActivityHash);
  t.is(store.kvStore.get('activityhash'), expectedActivityHash);

  t.log(`\
This test fails under maintenance of initial kernel state.
If these changes are expected, run:
  yarn test --update-snapshots test/test-state.js
Then commit the changes in .../snapshots/ path.
`);
});

test('crankhash - skip keys', t => {
  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });
  k.emitCrankHashes();

  k.kvStore.set('one', '1');
  const h = makeTestCrankHasher('sha256');
  h.update('add\n' + 'one\n' + '1\n');
  const expCrankhash = h.digest('hex');
  t.is(
    expCrankhash,
    '136550ffca718f8097396cbecb511aa2320d9ddc9bda5cebbafb64081b29e1e6',
  );
  t.is(k.emitCrankHashes().crankhash, expCrankhash);

  // certain local keys are excluded from consensus, and should not affect
  // the hash
  k.kvStore.set('one', '1');
  k.kvStore.set('local.doNotHashMe', 'random nonsense');
  t.throws(() => k.kvStore.set('host.foo', 'bar'));
  t.is(k.emitCrankHashes().crankhash, expCrankhash);
});

test('crankhash - duplicate set', t => {
  // setting the same key multiple times counts as divergence, because we
  // hash as we add/delete, not just the accumulated additions/deletions set

  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });
  k.emitCrankHashes();

  k.kvStore.set('one', '1');
  const h = makeTestCrankHasher('sha256');
  h.update('add\n' + 'one\n' + '1\n');
  const expCrankhash = h.digest('hex');
  t.is(
    expCrankhash,
    '136550ffca718f8097396cbecb511aa2320d9ddc9bda5cebbafb64081b29e1e6',
  );
  t.is(k.emitCrankHashes().crankhash, expCrankhash);

  k.kvStore.set('one', '1');
  k.kvStore.set('one', '1');
  const h2 = makeTestCrankHasher('sha256');
  h2.update('add\n' + 'one\n' + '1\n');
  h2.update('add\n' + 'one\n' + '1\n');
  const expCrankhash2 = h2.digest('hex');
  t.is(
    expCrankhash2,
    '2b60f31547515d4887ff62871fbf27a99a4091ec1564f6aaefe89f41131245eb',
  );
  t.is(k.emitCrankHashes().crankhash, expCrankhash2);
});

test('crankhash - set and delete', t => {
  // setting and deleting a key is different than never setting it

  const store = buildKeeperStorageInMemory();
  const k = makeKernelKeeper(store, null);
  k.createStartingKernelState({ defaultManagerType: 'local' });
  k.emitCrankHashes();

  const h1 = makeTestCrankHasher('sha256');
  const expCrankhash1 = h1.digest('hex');
  t.is(k.emitCrankHashes().crankhash, expCrankhash1); // empty

  const h2 = makeTestCrankHasher('sha256');
  h2.update('add\n' + 'one\n' + '1\n');
  h2.update('delete\n' + 'one\n');
  const expCrankhash2 = h2.digest('hex');

  k.kvStore.set('one', '1');
  k.kvStore.delete('one');
  t.is(k.emitCrankHashes().crankhash, expCrankhash2);

  t.not(expCrankhash1, expCrankhash2);
});

test('stats - can increment and decrement', t => {
  const { incStat, decStat, initializeStats, getStats, getSerializedStats } =
    makeKernelStats([
      {
        key: 'testCounter',
        name: 'test_counter',
        description: 'test counter stat',
        metricType: 'counter',
      },
      {
        key: 'testGauge',
        name: 'test_gauge',
        description: 'test gauge stat',
        metricType: 'gauge',
      },
    ]);

  t.throws(() => getSerializedStats());
  t.throws(() => incStat('testCounter'));
  initializeStats();
  const expectedStats = {
    testCounter: 0,
    testGauge: 0,
    testGaugeDown: 0,
    testGaugeUp: 0,
    testGaugeMax: 0,
  };
  t.deepEqual(getStats(), expectedStats);
  t.throws(() => incStat('invalidStat'));

  incStat('testCounter');
  expectedStats.testCounter += 1;
  t.deepEqual(getStats(), expectedStats);

  incStat('testGauge');
  expectedStats.testGauge += 1;
  expectedStats.testGaugeUp += 1;
  expectedStats.testGaugeMax += 1;
  t.deepEqual(getStats(), expectedStats);

  t.throws(() => decStat('testCounter'));

  decStat('testGauge');
  expectedStats.testGauge -= 1;
  expectedStats.testGaugeDown += 1;
  t.deepEqual(getStats(), expectedStats);

  incStat('testGauge', 5);
  expectedStats.testGauge += 5;
  expectedStats.testGaugeUp += 5;
  expectedStats.testGaugeMax = 5;
  t.deepEqual(getStats(), expectedStats);

  decStat('testGauge', 3);
  expectedStats.testGauge -= 3;
  expectedStats.testGaugeDown += 3;
  t.deepEqual(getStats(), expectedStats);
});

test('stats - can load and save existing stats', t => {
  const { incStat, loadFromSerializedStats, getSerializedStats, getStats } =
    makeKernelStats([
      {
        key: 'testLocal',
        name: 'test_local',
        description: 'test local stat',
        metricType: 'counter',
      },
      {
        key: 'testConsensus',
        name: 'test_consensus',
        description: 'test consensus stat',
        metricType: 'counter',
        consensus: true,
      },
    ]);

  const consensusStats = { testConsensus: 5 };
  const localStats = { testLocal: 7 };

  // Can load consensus and local
  loadFromSerializedStats({
    consensusStats: JSON.stringify(consensusStats),
    localStats: JSON.stringify(localStats),
  });
  t.deepEqual(getStats(), { ...localStats, ...consensusStats });
  t.deepEqual(getStats(true), consensusStats);
  t.deepEqual(JSON.parse(getSerializedStats().localStats), localStats);
  t.deepEqual(JSON.parse(getSerializedStats().consensusStats), consensusStats);

  // Accepts missing local stats
  loadFromSerializedStats({
    consensusStats: JSON.stringify(consensusStats),
  });
  t.deepEqual(getStats(), { testLocal: 0, ...consensusStats });
  t.deepEqual(JSON.parse(getSerializedStats().localStats), { testLocal: 0 });

  // Accepts missing entries from loaded stats
  loadFromSerializedStats({
    consensusStats: '{}',
    localStats: '{}',
  });
  t.deepEqual(getStats(), { testLocal: 0, testConsensus: 0 });

  // Extra local stats are preserved but cannot be changed
  localStats.extraLocal = 11;
  loadFromSerializedStats({
    consensusStats: JSON.stringify(consensusStats),
    localStats: JSON.stringify(localStats),
  });
  t.deepEqual(getStats(), { ...localStats, ...consensusStats });
  t.deepEqual(JSON.parse(getSerializedStats().localStats), localStats);
  t.throws(() => incStat('extraLocal'));
  delete localStats.extraLocal;

  // Extra consensus stats are removed
  loadFromSerializedStats({
    consensusStats: JSON.stringify({ ...consensusStats, extraConsensus: 11 }),
    localStats: JSON.stringify(localStats),
  });
  t.deepEqual(getStats(), { ...localStats, ...consensusStats });
  t.deepEqual(JSON.parse(getSerializedStats().consensusStats), consensusStats);

  // Promoting a local metric to consensus shadows old local stats
  // and ignores their value for initialization
  loadFromSerializedStats({
    consensusStats: JSON.stringify({}),
    localStats: JSON.stringify({ ...localStats, testConsensus: 11 }),
  });
  t.deepEqual(getStats(), { testConsensus: 0, ...localStats });
  t.deepEqual(getStats(true), { testConsensus: 0 });
  incStat('testConsensus');
  t.deepEqual(getStats(), { testConsensus: 1, ...localStats });
  t.deepEqual(JSON.parse(getSerializedStats().localStats), {
    ...localStats,
    testConsensus: 11,
  });

  // Demoting a consensus metric to local (re)sets the initial local value
  loadFromSerializedStats({
    consensusStats: JSON.stringify({ ...consensusStats, ...localStats }),
    localStats: JSON.stringify({ testLocal: 1 }),
  });
  t.deepEqual(getStats(), { ...consensusStats, ...localStats });
  t.deepEqual(getStats(true), consensusStats);
  incStat('testLocal');
  localStats.testLocal += 1;
  t.deepEqual(getStats(), { ...consensusStats, ...localStats });
  t.deepEqual(JSON.parse(getSerializedStats().consensusStats), consensusStats);
  t.deepEqual(JSON.parse(getSerializedStats().localStats), localStats);
});
