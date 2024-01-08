// @ts-check
// eslint-disable-next-line import/order
import { test } from '@agoric/swingset-vat/tools/prepare-test-env-ava.js';
import { reincarnate } from '@agoric/swingset-liveslots/tools/setup-vat-data.js';

import { makePromiseKit } from '@endo/promise-kit';
import { E, Far } from '@endo/far';
import { prepareWhenableModule, when } from '@agoric/whenable';
import { makeDurableZone } from '@agoric/zone/durable.js';

import {
  parse,
  unparse,
  prepareEchoConnectionHandler,
  makeLoopbackProtocolHandler,
  makeNetworkProtocol,
  makeRouter,
} from '../src/index.js';

import '../src/types.js';

// eslint-disable-next-line no-constant-condition
const log = false ? console.log : () => { };

const prepareProtocolHandler = (zone, t) => {
  const makeProtocolHandler = zone.exoClass(
    'ProtocolHandler',
    undefined,
    () => {
      let l;
      let lp;
      const nonce = 0;
      return {
        l,
        lp,
        nonce,
      };
    },
    {
      async onCreate(_protocol, _impl) {
        log('created', _protocol, _impl);
      },
      async generatePortID() {
        this.state.nonce += 1;
        return `${this.state.nonce}`;
      },
      async onBind(port, localAddr) {
        t.assert(port, `port is supplied to onBind`);
        t.assert(localAddr, `local address is supplied to onBind`);
      },
      async onConnect(port, localAddr, remoteAddr) {
        t.assert(port, `port is tracked in onConnect`);
        t.assert(localAddr, `local address is supplied to onConnect`);
        t.assert(remoteAddr, `remote address is supplied to onConnect`);
        if (!this.state.lp) {
          const makeEchoConnectionHandler = prepareEchoConnectionHandler(zone);
          return { handler: makeEchoConnectionHandler() };
        }
        const ch = await when(
          this.state.l.onAccept(
            this.state.lp,
            localAddr,
            remoteAddr,
            this.state.l,
          ),
        );
        return { localAddr, handler: ch };
      },
      async onListen(port, localAddr, listenHandler) {
        t.assert(port, `port is tracked in onListen`);
        t.assert(localAddr, `local address is supplied to onListen`);
        t.assert(listenHandler, `listen handler is tracked in onListen`);
        this.state.lp = port;
        this.state.l = listenHandler;
        log('listening', port.getLocalAddress(), listenHandler);
      },
      async onListenRemove(port, localAddr, listenHandler) {
        t.assert(port, `port is tracked in onListen`);
        t.assert(localAddr, `local address is supplied to onListen`);
        t.is(
          listenHandler,
          this.state.lp && this.state.l,
          `listenHandler is tracked in onListenRemove`,
        );
        this.state.lp = undefined;
        log('port done listening', port.getLocalAddress());
      },
      async onRevoke(port, localAddr) {
        t.assert(port, `port is tracked in onRevoke`);
        t.assert(localAddr, `local address is supplied to onRevoke`);
        log('port done revoking', port.getLocalAddress());
      },
    },
  );

  return makeProtocolHandler;
};

const { fakeVomKit } = reincarnate({ relaxDurabilityRules: false });
const provideBaggage = key => {
  const root = fakeVomKit.cm.provideBaggage();
  const zone = makeDurableZone(root);
  return zone.mapStore(`${key} baggage`);
};

test('handled protocol', async t => {
  const zone = makeDurableZone(provideBaggage('network - ibc'));
  const makeProtocolHandler = prepareProtocolHandler(zone, t);
  const protocol = makeNetworkProtocol(zone, makeProtocolHandler());
  const { makeWhenableKit } = prepareWhenableModule(zone);

  const port = await when(protocol.bind('/ibc/*/ordered'));

  const { whenable, settler } = makeWhenableKit();

  /**
   * @param {import('@agoric/base-zone').Zone} zone
   * @param t
   */
  const prepareTestProtocolHandler = (zone, t) => {
    const makeTestProtocolHandler = zone.exoClass(
      'TestProtocolHandler',
      undefined,
      () => ({ settler }),
      {
        async onOpen(connection, localAddr, remoteAddr) {
          t.is(localAddr, '/ibc/*/ordered');
          t.is(remoteAddr, '/ibc/*/ordered/echo');
          const ack = await E(connection).send('ping');
          // log(ack);
          t.is(`${ack}`, 'ping', 'received pong');
          void connection.close();
        },
        async onClose(_connection, reason) {
          t.is(reason, undefined, 'no close reason');
          this.state.settler.resolve(null);
        },
        async onReceive(_connection, bytes) {
          t.is(`${bytes}`, 'ping');
          return 'pong';
        },
      },
    );

    return makeTestProtocolHandler;
  };

  const makeTestProtocolHandler = prepareTestProtocolHandler(zone, t);

  await port.connect('/ibc/*/ordered/echo', makeTestProtocolHandler());
  await whenable.whenable0.shorten();
  port.revoke();
});

test('protocol connection listen', async t => {
  const zone = makeDurableZone(provideBaggage('network'));
  const makeProtocolHandler = prepareProtocolHandler(zone, t);
  const protocol = makeNetworkProtocol(zone, makeProtocolHandler());
  const { makeWhenableKit } = prepareWhenableModule(zone);

  const port = await when(protocol.bind('/net/ordered/ordered/some-portname'));
  const { whenable, settler } = makeWhenableKit();

  /**
   * @param {import('@agoric/base-zone').Zone} zone
   * @param t
   */
  const prepareListenHandler = (zone, t) => {
    const makeListenHandler = zone.exoClass(
      'ListenHandler',
      undefined,
      () => ({ port }),
      {
        async onListen(p, listenHandler) {
          t.is(p, this.state.port, `port is tracked in onListen`);
          t.assert(listenHandler, `listenHandler is tracked in onListen`);
        },
        async onAccept(p, localAddr, remoteAddr, listenHandler) {
          t.assert(localAddr, `local address is passed to onAccept`);
          t.assert(remoteAddr, `remote address is passed to onAccept`);
          t.is(p, this.state.port, `port is tracked in onAccept`);
          t.is(
            listenHandler,
            this.self,
            `listenHandler is tracked in onAccept`,
          );
          let handler;

          const prepareConnectionHandler = zone => {
            const makeConnectionHandler = zone.exoClass(
              'connectionHandler',
              undefined,
              () => ({ settler }),
              {
                async onOpen(
                  connection,
                  _localAddr,
                  _remoteAddr,
                  connectionHandler,
                ) {
                  t.assert(
                    connectionHandler,
                    `connectionHandler is tracked in onOpen`,
                  );
                  handler = connectionHandler;
                  const ack = await when(connection.send('ping'));
                  t.is(`${ack}`, 'ping', 'received pong');
                  await when(connection.close());
                },
                async onClose(c, reason, connectionHandler) {
                  t.is(
                    connectionHandler,
                    handler,
                    `connectionHandler is tracked in onClose`,
                  );
                  handler = undefined;
                  t.assert(c, 'connection is passed to onClose');
                  t.is(reason, undefined, 'no close reason');
                  this.state.settler.resolve(null);
                },
                async onReceive(c, packet, connectionHandler) {
                  t.is(
                    connectionHandler,
                    handler,
                    `connectionHandler is tracked in onReceive`,
                  );
                  t.assert(c, 'connection is passed to onReceive');
                  t.is(`${packet}`, 'ping', 'expected ping');
                  return 'pong';
                },
              },
            );
            return makeConnectionHandler;
          };
          const makeConnectionHandler = prepareConnectionHandler(zone);
          return makeConnectionHandler();
        },
        async onError(p, rej, listenHandler) {
          t.is(p, port, `port is tracked in onError`);
          t.is(listenHandler, this.self, `listenHandler is tracked in onError`);
          t.not(rej, rej, 'unexpected error');
        },
        async onRemove(p, listenHandler) {
          t.is(
            listenHandler,
            this.self,
            `listenHandler is tracked in onRemove`,
          );
          t.is(p, this.state.port, `port is passed to onReset`);
        },
      },
    );

    return makeListenHandler;
  };

  const makeListenHandler = prepareListenHandler(zone, t);
  const listener = makeListenHandler();

  await port.addListener(listener);

  const port2 = await when(protocol.bind('/net/ordered'));
  const makeEchoConnectionHandler = prepareEchoConnectionHandler(zone);
  const connectionHandler = makeEchoConnectionHandler();

  /**
   * @param {import('@agoric/base-zone').Zone} zone
   * @param t
   */
  const prepareHandlerWithOpen = zone => {
    const makeHandlerWithOpen = zone.exoClass(
      'connectionHandlerWithOpen',
      undefined,
      () => ({}),
      {
        async onReceive(_connection, bytes, _connectionHandler) {
          return connectionHandler.onReceive(
            _connection,
            bytes,
            _connectionHandler,
          );
        },
        async onClose(_connection, _reason, _connectionHandler) {
          connectionHandler.onClose(_connection, _reason, _connectionHandler);
        },
        async onOpen(connection, localAddr, remoteAddr, c) {
          void connection.send('ping');
        },
      },
    );

    return makeHandlerWithOpen;
  };

  const makeHandlerWithOpen = prepareHandlerWithOpen(zone);

  await when(
    port2.connect('/net/ordered/ordered/some-portname', makeHandlerWithOpen()),
  );

  await whenable.whenable0.shorten();

  await when(port.removeListener(listener));
  await when(port.revoke());
});

test('loopback protocol', async t => {
  const zone = makeDurableZone(provideBaggage('network'));
  const makeProtocolHandler = prepareProtocolHandler(zone, t);
  const protocol = makeNetworkProtocol(zone, makeProtocolHandler());
  const { makeWhenableKit } = prepareWhenableModule(zone);
  const { whenable, settler } = makeWhenableKit();

  const port = await when(protocol.bind('/loopback/foo'));

  /** @type {ListenHandler} */
  const listener = Far('listener', {
    async onAccept(_p, _localAddr, _remoteAddr, _listenHandler) {
      return Far('connectionHandler', {
        async onReceive(c, packet, _connectionHandler) {
          t.is(`${packet}`, 'ping', 'expected ping');
          return 'pingack';
        },
      });
    },
  });
  await when(port.addListener(listener));

  const port2 = await when(protocol.bind('/loopback/bar'));
  await when(
    port2.connect(
      port.getLocalAddress(),
      Far('opener', {
        async onOpen(c, localAddr, remoteAddr, _connectionHandler) {
          t.is(localAddr, '/loopback/bar/nonce/1');
          t.is(remoteAddr, '/loopback/foo/nonce/2');
          const pingack = await when(c.send('ping'));
          t.is(pingack, 'pingack', 'expected pingack');
          closed.resolve(null);
        },
      }),
    ),
  );

  await closed.promise;

  await port.removeListener(listener);
});

test('routing', async t => {
  const router = makeRouter();
  t.deepEqual(router.getRoutes('/if/local'), [], 'get routes matches none');
  router.register('/if/', 'a');
  t.deepEqual(
    router.getRoutes('/if/foo'),
    [['/if/', 'a']],
    'get routes matches prefix',
  );
  router.register('/if/foo', 'b');
  t.deepEqual(
    router.getRoutes('/if/foo'),
    [
      ['/if/foo', 'b'],
      ['/if/', 'a'],
    ],
    'get routes matches all',
  );
  t.deepEqual(
    router.getRoutes('/if/foob'),
    [['/if/', 'a']],
    'get routes needs separator',
  );
  router.register('/ibc/*/ordered', 'c');
  t.deepEqual(
    router.getRoutes('/if/foo'),
    [
      ['/if/foo', 'b'],
      ['/if/', 'a'],
    ],
    'get routes avoids nonmatching paths',
  );
  t.deepEqual(
    router.getRoutes('/ibc/*/ordered'),
    [['/ibc/*/ordered', 'c']],
    'direct match',
  );
  t.deepEqual(
    router.getRoutes('/ibc/*/ordered/zot'),
    [['/ibc/*/ordered', 'c']],
    'prefix matches',
  );
  t.deepEqual(router.getRoutes('/ibc/*/barfo'), [], 'no match');

  t.throws(
    () => router.unregister('/ibc/*/ordered', 'a'),
    { message: /Router is not registered/ },
    'unregister fails for no match',
  );
  router.unregister('/ibc/*/ordered', 'c');
  t.deepEqual(
    router.getRoutes('/ibc/*/ordered'),
    [],
    'no match after unregistration',
  );
});

test('multiaddr', async t => {
  t.deepEqual(parse('/if/local'), [['if', 'local']]);
  t.deepEqual(parse('/zot'), [['zot']]);
  t.deepEqual(parse('/zot/foo/bar/baz/bot'), [
    ['zot', 'foo'],
    ['bar', 'baz'],
    ['bot'],
  ]);
  for (const str of ['', 'foobar']) {
    t.throws(
      () => parse(str),
      { message: /Error parsing Multiaddr/ },
      `expected failure of ${str}`,
    );
  }
  for (const str of ['/', '//', '/foo', '/foobib/bar', '/k1/v1/k2/v2/k3/v3']) {
    t.is(
      unparse(parse(str)),
      str,
      `round-trip of ${JSON.stringify(str)} matches`,
    );
  }
});
