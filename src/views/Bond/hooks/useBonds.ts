import { useQuery } from "react-query";
import { NetworkId } from "src/constants";
import { BOND_DEPOSITORY_CONTRACT } from "src/constants/contracts";
import { OHM_TOKEN } from "src/constants/tokens";
import { getTokenByAddress } from "src/helpers/contracts/getTokenByAddress";
import { LPToken } from "src/helpers/contracts/LPToken";
import { Token } from "src/helpers/contracts/Token";
import { DecimalBigNumber } from "src/helpers/DecimalBigNumber/DecimalBigNumber";
import { assert } from "src/helpers/types/assert";
import { useTestableNetworks } from "src/hooks/useTestableNetworks";

export interface Bond {
  /**
   * Market id of this bond
   */
  id: string;
  /**
   * The token the market buys from the protocol
   */
  baseToken: Token;
  /**
   * The token that the market sells to the protocol
   */
  quoteToken: LPToken | Token;

  /**
   * The discount relative to the current market price of the token being sold
   */
  discount: DecimalBigNumber;
  /**
   * The duration until the bond matures in seconds
   */
  duration: number;
  /**
   * Boolean describing whether this bond is
   * either fixed-term, or fixed-expiration
   */
  isFixedTerm: boolean;
  /**
   * A boolean describing whether or not this bond is
   * sold out at the current point in time.
   */
  isSoldOut: boolean;
  /**
   * Price of the bond
   */
  price: {
    inUsd: DecimalBigNumber;
    inBaseToken: DecimalBigNumber;
  };
  /*
   * Capacity is the number of tokens
   * left available for purchase
   */
  capacity: {
    inBaseToken: DecimalBigNumber;
    inQuoteToken: DecimalBigNumber;
  };
  /*
   * Max payout is the number of tokens left available
   * in this specific deposit interval.
   */
  maxPayout: {
    inBaseToken: DecimalBigNumber;
    inQuoteToken: DecimalBigNumber;
  };
}

export const useBonds = <TData = Bond[]>(select?: (data: Bond[]) => TData) => {
  const networks = useTestableNetworks();

  const args = [networks.MAINNET] as const;
  return useQuery<Bond[], Error, TData>(bondsQueryKey(...args), () => fetchBonds(...args), { select });
};

export const bondsQueryKey = (networkId: NetworkId) => ["useBonds", networkId];

export const fetchBonds = async (networkId: NetworkId.MAINNET | NetworkId.TESTNET_RINKEBY) => {
  const contract = BOND_DEPOSITORY_CONTRACT.getEthersContract(networkId);

  const markets = await contract.liveMarkets().then(ids => ids.map(id => id.toString()));

  const promises = await Promise.allSettled(
    markets.map(async id => {
      const [market, terms] = await Promise.all([contract.markets(id), contract.terms(id)]);

      const baseToken = OHM_TOKEN;
      const quoteToken = getTokenByAddress(market.quoteToken);
      assert(quoteToken, `Unknown token address: ${market.quoteToken}`);

      const [baseTokenPerUsd, quoteTokenPerUsd, quoteTokenPerBaseToken] = await Promise.all([
        baseToken.getPrice(NetworkId.MAINNET),
        quoteToken.getPrice(NetworkId.MAINNET),
        contract.marketPrice(id).then(price => new DecimalBigNumber(price, baseToken.decimals)),
      ]);

      const priceInUsd = quoteTokenPerUsd.mul(quoteTokenPerBaseToken);
      const discount = baseTokenPerUsd.sub(priceInUsd).div(baseTokenPerUsd, 9);

      /**
       * Bonds mature with a cliff at a set timestamp
       * prior to the expiry timestamp, no payout tokens are accessible to the user
       * after the expiry timestamp, the entire payout can be redeemed
       *
       * there are two types of bonds: fixed-term and fixed-expiration
       *
       * fixed-term bonds mature in a set amount of time from deposit
       * i.e. term = 1 week. when alice deposits on day 1, her bond
       * expires on day 8. when bob deposits on day 2, his bond expires day 9.
       *
       * fixed-expiration bonds mature at a set timestamp
       * i.e. expiration = day 10. when alice deposits on day 1, her term
       * is 9 days. when bob deposits on day 2, his term is 8 days.
       */
      const duration = terms.fixedTerm ? terms.vesting : terms.conclusion - Date.now() / 1000;

      /*
       * each market is initialized with a capacity
       *
       * this is either the number of OHM that the market can sell
       * (if capacity in quote is false),
       *
       * or the number of quote tokens that the market can buy
       * (if capacity in quote is true)
       */
      const capacity = new DecimalBigNumber(
        market.capacity,
        market.capacityInQuote ? quoteToken.decimals : baseToken.decimals,
      );

      const capacityInQuoteToken = market.capacityInQuote ? capacity : capacity.mul(quoteTokenPerBaseToken); // Convert to quoteToken if capacity is denominated in baseToken

      const capacityInBaseToken = market.capacityInQuote
        ? capacity.div(quoteTokenPerBaseToken, baseToken.decimals) // Convert to baseToken if capacity is denominated in quoteToken
        : capacity;

      /*
       * maxPayout is the amount of capacity that should be utilized in a deposit
       * interval. for example, if capacity is 1,000 OHM, there are 10 days to conclusion,
       * and the preferred deposit interval is 1 day, max payout would be 100 OHM.
       */
      const maxPayoutInBaseToken = new DecimalBigNumber(market.maxPayout, baseToken.decimals);
      const maxPayoutInQuoteToken = maxPayoutInBaseToken.mul(quoteTokenPerBaseToken);

      /**
       * Bonds are sold out if either there is no capacity left,
       * or the maximum has been paid out for a specific interval.
       */
      const ONE = new DecimalBigNumber("1", 0);
      const isSoldOut = ONE.gt(capacityInBaseToken) || ONE.gt(maxPayoutInBaseToken);

      return {
        id,
        baseToken,
        quoteToken,
        discount,
        duration,
        isSoldOut,
        isFixedTerm: terms.fixedTerm,
        price: {
          inUsd: priceInUsd,
          inBaseToken: quoteTokenPerBaseToken,
        },
        capacity: {
          inBaseToken: capacityInBaseToken,
          inQuoteToken: capacityInQuoteToken,
        },
        maxPayout: {
          inBaseToken: maxPayoutInBaseToken,
          inQuoteToken: maxPayoutInQuoteToken,
        },
      };
    }),
  );

  return promises
    .filter(({ status }) => status === "fulfilled")
    .map(promise => (promise as PromiseFulfilledResult<Bond>).value);
};