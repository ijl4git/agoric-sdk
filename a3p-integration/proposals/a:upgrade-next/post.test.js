import test from 'ava';

import { agd } from '@agoric/synthetic-chain/src/lib/cliHelper.js';

test('Ensure MaxBytes param was updated', async t => {
  const { value: rawParams } = await agd.query(
    'params',
    'subspace',
    'baseapp',
    'BlockParams',
  );
  const blockParams = JSON.parse(rawParams);
  t.is(blockParams.max_bytes, '5242880');
});
