import { test } from '@agoric/swingset-vat/tools/prepare-test-env-ava.js';

import path from 'path';

import bundleSource from '@endo/bundle-source';
import { E } from '@endo/eventual-send';

import { makeZoeForTest } from '../../../tools/setup-zoe.js';
import { makeFakeVatAdmin } from '../../../tools/fakeVatAdmin.js';

const filename = new URL(import.meta.url).pathname;
const dirname = path.dirname(filename);

const root = `${dirname}/../../../src/contracts/ownable-counter.js`;

test('zoe - ownable-counter contract', async t => {
  const { admin: fakeVatAdmin, vatAdminState } = makeFakeVatAdmin();
  const zoe = makeZoeForTest(fakeVatAdmin);
  // Pack the contract.
  const bundle = await bundleSource(root);
  vatAdminState.installBundle('b1-ownable-counter', bundle);
  const installation = await E(zoe).installBundleID('b1-ownable-counter');

  const { creatorFacet: firstCounter, publicFacet: viewCounter } = await E(
    zoe,
  ).startInstance(
    installation,
    undefined,
    undefined,
    harden({
      count: 3n,
    }),
    'c1-ownable-counter',
  );

  t.is(await E(firstCounter).incr(), 4n);
  t.is(await E(viewCounter).view(), 4n);
});
