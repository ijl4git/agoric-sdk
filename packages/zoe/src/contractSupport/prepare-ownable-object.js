import {
  M,
  getCopyMapEntries,
  getInterfaceGuardPayload,
  mustMatch,
} from '@endo/patterns';
import { prepareExoClass } from '@agoric/vat-data';
import { OfferHandlerI } from '../typeGuards.js';

/** @typedef {import('@agoric/vat-data').Baggage} Baggage */

const { fromEntries } = Object;

const TransferProposalShape = M.splitRecord({
  give: {},
  want: {},
  exit: {
    onDemand: {},
  },
});

export const makePrepareOwnableClass = zcf => {
  /**
   * @template {object} CustomDetails
   * @template {object} State
   * @template {Record<PropertyKey, CallableFunction>} T methods
   * @param {Baggage} baggage
   * @param {string} kindName
   * @param {import('@endo/patterns').InterfaceGuard} interfaceGuard
   *   Does not itself provide guards for
   *   - `getCustomDetails`
   *   - `makeTranferInvitation`.
   *
   *   Rather, those guards are automatically added
   * @param {(customDetails: CustomDetails) => State} init
   * @param {T & ThisType<{
   *   self: T,
   *   state: State,
   * }>} methods
   *   Does not itself provide the
   *   - `makeTransferInvitation` method.
   *
   *   Rather, that method is atomatically added.
   *   The `methods` parameter must contain a method for
   *   - `getCustomDetails`
   *   whose return result will be used to call the `init` function.
   * @param {import('@agoric/vat-data').DefineKindOptions<{
   *   self: T,
   *   state: State
   * }> & {
   *   detailsShape?: any,
   * }} [options]
   *   If `detailsShape` is provided, it will be used to guard the returns of
   *   `getCustomDetails`.
   * @returns {(customDetails: CustomDetails) => (T & import('@endo/eventual-send').RemotableBrand<{}, T>)}
   */
  const prepareOwnableClass = (
    baggage,
    kindName,
    interfaceGuard,
    init,
    methods,
    options = {},
  ) => {
    const { detailsShape = M.any(), ...restOptions } = options;
    // TODO what about interfaceGuardPayload options?
    const {
      interfaceName,
      methodGuards,
      symbolMethodGuards = undefined,
    } = getInterfaceGuardPayload(interfaceGuard);

    let ownableInterfaceMethodGuards;
    if (symbolMethodGuards === undefined) {
      ownableInterfaceMethodGuards = harden({
        ...methodGuards,
        getCustomDetails: M.call().returns(detailsShape),
        makeTransferInvitation: M.call().returns(M.promise()),
      });
    } else {
      ownableInterfaceMethodGuards = harden({
        ...methodGuards,
        ...fromEntries(getCopyMapEntries(symbolMethodGuards)),
        getCustomDetails: M.call().returns(detailsShape),
        makeTransferInvitation: M.call().returns(M.promise()),
      });
    }

    const ownableInterfaceGuard = M.interface(
      `Ownable_${interfaceName}`,
      ownableInterfaceMethodGuards,
    );

    let revokeTransferHandler;

    const makeTransferHandler = prepareExoClass(
      baggage,
      'TransferHandler',
      OfferHandlerI,
      customDetails => {
        customDetails;
      },
      {
        handle(seat) {
          const {
            self,
            // @ts-expect-error TODO should type `state`
            state: { customDetails },
          } = this;
          seat.exit();
          revokeTransferHandler(self);
          // eslint-disable-next-line no-use-before-define
          return makeOwnableObject(customDetails);
        },
      },
      {
        receiveRevoker(revoke) {
          revokeTransferHandler = revoke;
        },
      },
    );

    let revokeOwnableObject;

    const makeTransferInvitation = () => {
      // @ts-expect-error TODO Should use `ThisType`
      const { self } = this;
      const customDetails = self.getCustomDetails();
      const transferHandler = makeTransferHandler(customDetails);

      const invitation = zcf.makeInvitation(
        // eslint-disable-next-line no-use-before-define
        transferHandler,
        'transfer',
        customDetails,
        TransferProposalShape,
      );
      revokeOwnableObject(self);
      return invitation;
    };

    const initWrapper = customDetails => {
      mustMatch(customDetails, detailsShape, 'makeOwnableObject');
      return init(customDetails);
    };

    const makeOwnableObject = prepareExoClass(
      baggage,
      // Might be upgrading from a previous non-ownable class of the same
      // kindName.
      kindName,
      ownableInterfaceGuard,
      initWrapper,
      {
        ...methods,
        makeTransferInvitation,
      },
      {
        ...restOptions,
        receiveRevoker(revoke) {
          revokeOwnableObject = revoke;
        },
      },
    );

    return makeOwnableObject;
  };
  return harden(prepareOwnableClass);
};
harden(makePrepareOwnableClass);
