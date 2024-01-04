// @ts-check
import { deeplyFulfilledObject } from '@agoric/internal';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { defangAndTrim, stringify } from './code-gen.js';
import {
  makeCoreProposalBehavior,
  makeEnactCoreProposalsFromBundleRef,
} from './coreProposalBehavior.js';

/**
 * @typedef {string | { module: string, entrypoint: string, args?: Array<unknown> }} ConfigProposal
 */

const { details: X, Fail } = assert;

const req = createRequire(import.meta.url);

/**
 * @param {(ModuleSpecifier | FilePath)[]} paths
 * @typedef {string} ModuleSpecifier
 * @typedef {string} FilePath
 */
const pathResolve = (...paths) => {
  const fileName = paths.pop();
  assert(fileName, '>=1 paths required');
  try {
    return req.resolve(fileName, {
      paths,
    });
  } catch (e) {
    return path.resolve(...paths, fileName);
  }
};

const findModule = (initDir, srcSpec) =>
  srcSpec.match(/^(\.\.?)?\//)
    ? pathResolve(initDir, srcSpec)
    : req.resolve(srcSpec);

/**
 * @param {{ bundleID?: string, bundleName?: string }} handle - mutated then hardened
 * @param {string} sourceSpec - the specifier of a module to load
 * @param {number} sequence - the sequence number of the proposal
 * @param {string} piece - the piece of the proposal
 * @returns {Promise<[string, any]>}
 */
const namedHandleToBundleSpec = async (handle, sourceSpec, sequence, piece) => {
  handle.bundleName = `coreProposal${sequence}_${piece}`;
  harden(handle);
  return harden([handle.bundleName, { sourceSpec }]);
};

/**
 * Format core proposals to be run at bootstrap:
 * SwingSet `bundles` configuration
 * and `code` to execute them, interpolating functions
 * such as `makeCoreProposalBehavior`.
 *
 * Core proposals are proposals for use with swingset-core-eval.
 * In production, they are triggered by BLD holder governance decisions,
 * but for sim-chain and such, they can be declared statically in
 * the chain configuration, in which case they are run at bootstrap.
 *
 * @param {ConfigProposal[]} coreProposals - governance
 * proposals to run at chain bootstrap for scenarios such as sim-chain.
 * @param {FilePath} [dirname]
 * @param {object} [opts]
 * @param {typeof makeEnactCoreProposalsFromBundleRef} [opts.makeEnactCoreProposals]
 * @param {(i: number) => number} [opts.getSequenceForProposal]
 * @param {typeof namedHandleToBundleSpec} [opts.handleToBundleSpec]
 */
export const extractCoreProposalBundles = async (
  coreProposals,
  dirname = '.',
  opts,
) => {
  const {
    makeEnactCoreProposals = makeEnactCoreProposalsFromBundleRef,
    getSequenceForProposal = i => i,
    handleToBundleSpec = namedHandleToBundleSpec,
  } = opts || {};

  dirname = pathResolve(dirname);
  dirname = await fs.promises
    .stat(dirname)
    .then(stbuf => (stbuf.isDirectory() ? dirname : path.dirname(dirname)));

  /** @type {Map<{ bundleID?: string, bundleName?: string }, { source: string, bundle?: string }>} */
  const bundleHandleToAbsolutePaths = new Map();

  const bundleToSource = new Map();
  const extracted = await Promise.all(
    coreProposals.map(async (coreProposal, i) => {
      // console.debug(`Parsing core proposal:`, coreProposal);

      /** @type {string} */
      let entrypoint;
      /** @type {unknown[]} */
      let args;
      /** @type {string} */
      let module;
      if (typeof coreProposal === 'string') {
        module = coreProposal;
        entrypoint = 'defaultProposalBuilder';
        args = [];
      } else {
        ({ module, entrypoint, args = [] } = coreProposal);
      }

      typeof module === 'string' ||
        Fail`coreProposal module ${module} must be string`;
      typeof entrypoint === 'string' ||
        Fail`coreProposal entrypoint ${entrypoint} must be string`;
      Array.isArray(args) || Fail`coreProposal args ${args} must be array`;

      const thisProposalBundleHandles = new Set();
      assert(getSequenceForProposal);
      const thisProposalSequence = getSequenceForProposal(i);
      const initPath = findModule(dirname, module);
      const initDir = path.dirname(initPath);
      /** @type {Record<string, import('./externalTypes.js').ProposalBuilder>} */
      const ns = await import(initPath);
      const install = (srcSpec, bundlePath) => {
        const absoluteSrc = findModule(initDir, srcSpec);
        const bundleHandle = {};
        const absolutePaths = { source: absoluteSrc };
        if (bundlePath) {
          const absoluteBundle = pathResolve(initDir, bundlePath);
          absolutePaths.bundle = absoluteBundle;
          const oldSource = bundleToSource.get(absoluteBundle);
          if (oldSource) {
            assert.equal(
              oldSource,
              absoluteSrc,
              X`${bundlePath} already installed from ${oldSource}, now ${absoluteSrc}`,
            );
          } else {
            bundleToSource.set(absoluteBundle, absoluteSrc);
          }
        }
        // Don't harden the bundleHandle since we need to set the bundleName on
        // its unique identity later.
        thisProposalBundleHandles.add(bundleHandle);
        bundleHandleToAbsolutePaths.set(bundleHandle, harden(absolutePaths));
        return bundleHandle;
      };
      /** @type {import('./externalTypes.js').PublishBundleRef} */
      const publishRef = async handleP => {
        const handle = await handleP;
        // eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error -- https://github.com/Agoric/agoric-sdk/issues/4620 */
        // @ts-ignore xxx types
        bundleHandleToAbsolutePaths.has(handle) ||
          Fail`${handle} not in installed bundles`;
        return handle;
      };
      const proposal = await ns[entrypoint](
        {
          publishRef,
          // @ts-expect-error not statically verified to return a full obj
          install,
        },
        ...args,
      );

      // Add the proposal bundle handles in sorted order.
      const bundleSpecEntries = await Promise.all(
        [...thisProposalBundleHandles.keys()]
          .map(handle => [handle, bundleHandleToAbsolutePaths.get(handle)])
          .sort(([_hnda, { source: a }], [_hndb, { source: b }]) => {
            if (a < b) {
              return -1;
            }
            if (a > b) {
              return 1;
            }
            return 0;
          })
          .map(async ([handle, absolutePaths], j) => {
            // Transform the bundle handle identity into a bundleName reference.
            const specEntry = await handleToBundleSpec(
              handle,
              absolutePaths.source,
              thisProposalSequence,
              String(j),
            );
            harden(handle);
            return specEntry;
          }),
      );

      // Now that we've assigned all the bundleNames and hardened the
      // handles, we can extract the behavior bundle.
      const { sourceSpec, getManifestCall } = await deeplyFulfilledObject(
        harden(proposal),
      );

      const behaviorSource = pathResolve(initDir, sourceSpec);
      const behaviors = await import(behaviorSource);
      const [exportedGetManifest, ...manifestArgs] = getManifestCall;
      assert(
        exportedGetManifest in behaviors,
        `behavior ${behaviorSource} missing ${exportedGetManifest}`,
      );
      const { manifest: overrideManifest } = await behaviors[
        exportedGetManifest
      ](harden({ restoreRef: () => null }), ...manifestArgs);

      const behaviorBundleHandle = {};
      const specEntry = await handleToBundleSpec(
        behaviorBundleHandle,
        behaviorSource,
        thisProposalSequence,
        'behaviors',
      );
      bundleSpecEntries.unshift(specEntry);

      bundleHandleToAbsolutePaths.set(
        behaviorBundleHandle,
        harden({
          source: behaviorSource,
        }),
      );

      return harden({
        ref: behaviorBundleHandle,
        call: getManifestCall,
        overrideManifest,
        bundleSpecs: bundleSpecEntries,
      });
    }),
  );

  // Extract all the bundle specs in already-sorted order.
  const bundles = Object.fromEntries(
    extracted.flatMap(({ bundleSpecs }) => bundleSpecs),
  );
  harden(bundles);

  // Extract the manifest references and calls.
  const makeCPArgs = extracted.map(({ ref, call, overrideManifest }) => ({
    ref,
    call,
    overrideManifest,
  }));
  harden(makeCPArgs);

  const code = `\
// This is generated by @agoric/deploy-script-support/src/extract-proposal.js - DO NOT EDIT
/* eslint-disable */

const makeCoreProposalArgs = harden(${stringify(makeCPArgs, true)});

const makeCoreProposalBehavior = ${makeCoreProposalBehavior};

(${makeEnactCoreProposals})({ makeCoreProposalArgs, E });
`;

  // console.debug('created bundles from proposals:', coreProposals, bundles);
  return {
    bundles,
    code: defangAndTrim(code),
    bundleHandleToAbsolutePaths,
  };
};
