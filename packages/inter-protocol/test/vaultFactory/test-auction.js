import { test as unknownTest } from '@agoric/zoe/tools/prepare-test-env-ava.js';

import { makeTracer } from '@agoric/internal';
import { TimeMath } from '@agoric/time';
import { SECONDS_PER_DAY } from '../../src/proposals/econ-behaviors.js';
import {
  makeAuctioneerDriver,
  makeDriverContext,
  makeManagerDriver,
} from './driver.js';

/**
 * @typedef {import('./driver.js').DriverContext & {
 * }} Context
 */
/** @type {import('ava').TestFn<Context>} */
const test = unknownTest;

const trace = makeTracer('TestAuct');

test.before(async t => {
  // make interest slow because it's not the behavior under test
  t.context = await makeDriverContext({
    interestTiming: {
      chargingPeriod: SECONDS_PER_DAY,
      recordingPeriod: SECONDS_PER_DAY,
    },
  });
  trace(t, 'CONTEXT');
});

test('reset auction params', async t => {
  const md = await makeManagerDriver(t);
  await md.setGovernedParam('ChargingPeriod', 10_000n);
  const ad = await makeAuctioneerDriver(t);

  const coerceRel = n =>
    TimeMath.coerceRelativeTimeRecord(n, t.context.timer.getTimerBrand());

  // XXX source from config
  const freq = 3600n;
  const delay = 2n;
  const schedule1 = {
    startTime: { absValue: freq + delay },
  };

  await ad.assertSchedulesLike(null, schedule1);
  await ad.advanceTimerByStartFrequency();
  t.log('"considering liquidation" fired'); // XXX verified by looking at console output
  const schedule2 = {
    startTime: { absValue: schedule1.startTime.absValue + freq },
  };
  await ad.assertSchedulesLike(schedule1, schedule2);

  // break params
  await ad.setGovernedParam('StartFrequency', coerceRel(0));

  debugger;
  // skip twice
  console.log('DEBUG advance 1 after breaking params');
  await ad.advanceTimerByStartFrequency();
  console.log('DEBUG advance 2 after breaking params');
  await ad.advanceTimerByStartFrequency();
  console.log('DEBUG advanced twice');
  t.log('"schedules killed');
  await ad.assertSchedulesLike(null, null);

  // restore valid params
  debugger;
  console.log('DEBUG settting bad StartFrequency again');
  await ad.setGovernedParam('StartFrequency', coerceRel(3600));
  console.log('DEBUG set bad StartFrequency complete');

  // try triggering another liquidation
  // await ad.advanceTimerByStartFrequency();
  // t.log('"considering liquidation" fired a second time'); // XXX verified by looking at console output

  await ad.assertSchedulesLike(
    { startTime: { absValue: schedule2.startTime.absValue + freq } },
    { startTime: { absValue: schedule2.startTime.absValue + 2n * freq } },
  );
});
