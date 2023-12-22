import path from 'path';
import sqlite3 from 'better-sqlite3';
import { gunzipSync } from 'zlib';
import test from 'ava';

import { initSwingStore } from '../src/index.js';

import { tmpDir } from './util.js';

test('when spans are not compressed on rollover', async t => {
  const [dbDir, cleanup] = await tmpDir('testdb');
  t.teardown(cleanup);
  // const dbDir = 't-db';

  const ss = initSwingStore(dbDir);
  const ts = ss.kernelStorage.transcriptStore;

  const db = sqlite3(path.join(dbDir, 'swingstore.sqlite'));
  const sqlGetSpans = db.prepare(
    'SELECT vatID, startPos, endPos, incarnation, isCurrent FROM transcriptSpans ORDER BY startPos',
  );
  const sqlGetItems = db.prepare(
    'SELECT * FROM transcriptItems ORDER BY position',
  );
  const sqlGetCompressedSpans = db.prepare(
    'SELECT vatID, startPos, endPos, incarnation FROM transcriptCompressedSpans ORDER BY startPos',
  );
  const vatID = 'v1';
  let spans;
  let items;
  let compressedSpans;

  // to start with, turn automatic compression off
  ss.debug.setEnableTranscriptRolloverCompression(false);

  // build a DB with four spans (one in an old incarnation, two historical but
  // current incarnation, only one inUse)
  ts.initTranscript(vatID);
  await ss.hostStorage.commit();

  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 0, incarnation: 0, isCurrent: 1 },
  ]);
  t.deepEqual(items, []);
  t.deepEqual(compressedSpans, []);

  // incarnation 0
  ts.addItem(vatID, 'start-worker'); // 0
  ts.addItem(vatID, 'shutdown-worker'); // 1
  await ss.hostStorage.commit();

  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
  ]);
  t.deepEqual(compressedSpans, []);

  ts.rolloverIncarnation(vatID);
  await ss.hostStorage.commit();

  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 2, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
  ]);
  t.deepEqual(compressedSpans, []);

  // incarnation 1
  ts.addItem(vatID, 'start-worker'); // 2
  ts.addItem(vatID, 'delivery1'); // 3
  ts.addItem(vatID, 'save-snapshot'); // 4
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
    { vatID, position: 2, item: 'start-worker', incarnation: 1 },
    { vatID, position: 3, item: 'delivery1', incarnation: 1 },
    { vatID, position: 4, item: 'save-snapshot', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, []);

  ts.rolloverSpan(vatID); // range= 2..5
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 5, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
    { vatID, position: 2, item: 'start-worker', incarnation: 1 },
    { vatID, position: 3, item: 'delivery1', incarnation: 1 },
    { vatID, position: 4, item: 'save-snapshot', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, []);

  ts.addItem(vatID, 'load-snapshot'); // 5
  ts.addItem(vatID, 'delivery2'); // 6
  ts.addItem(vatID, 'save-snapshot'); // 7
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 8, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
    { vatID, position: 2, item: 'start-worker', incarnation: 1 },
    { vatID, position: 3, item: 'delivery1', incarnation: 1 },
    { vatID, position: 4, item: 'save-snapshot', incarnation: 1 },
    { vatID, position: 5, item: 'load-snapshot', incarnation: 1 },
    { vatID, position: 6, item: 'delivery2', incarnation: 1 },
    { vatID, position: 7, item: 'save-snapshot', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, []);

  ts.rolloverSpan(vatID); // range= 5..8
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 8, incarnation: 1, isCurrent: null },
    { vatID, startPos: 8, endPos: 8, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
    { vatID, position: 2, item: 'start-worker', incarnation: 1 },
    { vatID, position: 3, item: 'delivery1', incarnation: 1 },
    { vatID, position: 4, item: 'save-snapshot', incarnation: 1 },
    { vatID, position: 5, item: 'load-snapshot', incarnation: 1 },
    { vatID, position: 6, item: 'delivery2', incarnation: 1 },
    { vatID, position: 7, item: 'save-snapshot', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, []);

  ts.addItem(vatID, 'load-snapshot'); // 8
  ts.addItem(vatID, 'delivery3'); // 9
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 8, incarnation: 1, isCurrent: null },
    { vatID, startPos: 8, endPos: 10, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
    { vatID, position: 2, item: 'start-worker', incarnation: 1 },
    { vatID, position: 3, item: 'delivery1', incarnation: 1 },
    { vatID, position: 4, item: 'save-snapshot', incarnation: 1 },
    { vatID, position: 5, item: 'load-snapshot', incarnation: 1 },
    { vatID, position: 6, item: 'delivery2', incarnation: 1 },
    { vatID, position: 7, item: 'save-snapshot', incarnation: 1 },
    { vatID, position: 8, item: 'load-snapshot', incarnation: 1 },
    { vatID, position: 9, item: 'delivery3', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, []);

  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  for (const { startPos, endPos, incarnation, isCurrent } of spans) {
    if (!isCurrent) {
      ss.debug.compressSpan(vatID, startPos, endPos, incarnation);
    }
  }
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(items, [
    { vatID, position: 8, item: 'load-snapshot', incarnation: 1 },
    { vatID, position: 9, item: 'delivery3', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0 },
    { vatID, startPos: 2, endPos: 5, incarnation: 1 },
    { vatID, startPos: 5, endPos: 8, incarnation: 1 },
  ]);
});

test('when spans are compressed on rollover', async t => {
  const [dbDir, cleanup] = await tmpDir('testdb');
  t.teardown(cleanup);
  // const dbDir = 't-db';

  const ss = initSwingStore(dbDir);
  const ts = ss.kernelStorage.transcriptStore;

  const db = sqlite3(path.join(dbDir, 'swingstore.sqlite'));
  const sqlGetSpans = db.prepare(
    'SELECT vatID, startPos, endPos, incarnation, isCurrent FROM transcriptSpans ORDER BY startPos',
  );
  const sqlGetItems = db.prepare(
    'SELECT * FROM transcriptItems ORDER BY position',
  );
  const sqlGetCompressedSpans = db.prepare(
    'SELECT vatID, startPos, endPos, incarnation FROM transcriptCompressedSpans ORDER BY startPos',
  );
  const sqlGetCompressedSpanBlobs = db.prepare(
    'SELECT items FROM transcriptCompressedSpans ORDER BY startPos',
  );
  sqlGetCompressedSpanBlobs.pluck();

  const vatID = 'v1';
  let spans;
  let items;
  let compressedSpans;
  const spanItems = [];

  // build a DB with four spans (one in an old incarnation, two historical but
  // current incarnation, only one inUse)
  ts.initTranscript(vatID);
  await ss.hostStorage.commit();

  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 0, incarnation: 0, isCurrent: 1 },
  ]);
  t.deepEqual(items, []);
  t.deepEqual(compressedSpans, []);

  // incarnation 0
  ts.addItem(vatID, 'start-worker'); // 0
  ts.addItem(vatID, 'shutdown-worker'); // 1
  spanItems.push('start-worker\nshutdown-worker\n');
  await ss.hostStorage.commit();

  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 0, item: 'start-worker', incarnation: 0 },
    { vatID, position: 1, item: 'shutdown-worker', incarnation: 0 },
  ]);
  t.deepEqual(compressedSpans, []);

  ts.rolloverIncarnation(vatID);
  await ss.hostStorage.commit();

  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 2, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, []);
  t.deepEqual(compressedSpans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0 },
  ]);

  // incarnation 1
  ts.addItem(vatID, 'start-worker'); // 2
  ts.addItem(vatID, 'delivery1'); // 3
  ts.addItem(vatID, 'save-snapshot'); // 4
  spanItems.push('start-worker\ndelivery1\nsave-snapshot\n');
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 2, item: 'start-worker', incarnation: 1 },
    { vatID, position: 3, item: 'delivery1', incarnation: 1 },
    { vatID, position: 4, item: 'save-snapshot', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0 },
  ]);

  ts.rolloverSpan(vatID); // range= 2..5
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 5, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, []);
  t.deepEqual(compressedSpans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0 },
    { vatID, startPos: 2, endPos: 5, incarnation: 1 },
  ]);

  ts.addItem(vatID, 'load-snapshot'); // 5
  ts.addItem(vatID, 'delivery2'); // 6
  ts.addItem(vatID, 'save-snapshot'); // 7
  spanItems.push('load-snapshot\ndelivery2\nsave-snapshot\n');
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 8, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 5, item: 'load-snapshot', incarnation: 1 },
    { vatID, position: 6, item: 'delivery2', incarnation: 1 },
    { vatID, position: 7, item: 'save-snapshot', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0 },
    { vatID, startPos: 2, endPos: 5, incarnation: 1 },
  ]);

  ts.rolloverSpan(vatID); // range= 5..8
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 8, incarnation: 1, isCurrent: null },
    { vatID, startPos: 8, endPos: 8, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, []);
  t.deepEqual(compressedSpans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0 },
    { vatID, startPos: 2, endPos: 5, incarnation: 1 },
    { vatID, startPos: 5, endPos: 8, incarnation: 1 },
  ]);

  ts.addItem(vatID, 'load-snapshot'); // 8
  ts.addItem(vatID, 'delivery3'); // 9
  await ss.hostStorage.commit();
  spans = [...sqlGetSpans.iterate()];
  items = [...sqlGetItems.iterate()];
  compressedSpans = [...sqlGetCompressedSpans.iterate()];
  t.deepEqual(spans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0, isCurrent: null },
    { vatID, startPos: 2, endPos: 5, incarnation: 1, isCurrent: null },
    { vatID, startPos: 5, endPos: 8, incarnation: 1, isCurrent: null },
    { vatID, startPos: 8, endPos: 10, incarnation: 1, isCurrent: 1 },
  ]);
  t.deepEqual(items, [
    { vatID, position: 8, item: 'load-snapshot', incarnation: 1 },
    { vatID, position: 9, item: 'delivery3', incarnation: 1 },
  ]);
  t.deepEqual(compressedSpans, [
    { vatID, startPos: 0, endPos: 2, incarnation: 0 },
    { vatID, startPos: 2, endPos: 5, incarnation: 1 },
    { vatID, startPos: 5, endPos: 8, incarnation: 1 },
  ]);

  const blobItems = sqlGetCompressedSpanBlobs
    .all()
    .map(blob => gunzipSync(blob))
    .map(buf => buf.toString());
  t.deepEqual(blobItems, spanItems);
});
