import { StaticJsonRpcProvider, JsonRpcSigner } from "@ethersproject/providers";
import { ethers } from "ethers";

import { abi as ierc20Abi } from "src/abi/IERC20.json";
import { getTokenPrice } from "src/helpers";
import { getBondCalculator } from "src/helpers/BondCalculator";
import { abi as BondCalcContractABI } from "src/abi/BondCalcContract.json";
import { EthContract, PairContract } from "src/typechain";
import { addresses } from "src/constants";
import React from "react";
import callMethodWithPool from "./pools";

export enum NetworkID {
  Mainnet = 56,
  Testnet = 97,
}

export enum BondType {
  StableAsset,
  LP,
}

export interface BondAddresses {
  reserveAddress: string;
  bondAddress: string;
}

export interface NetworkAddresses {
  [NetworkID.Mainnet]: BondAddresses;
  [NetworkID.Testnet]: BondAddresses;
}

export interface Available {
  [NetworkID.Mainnet]?: boolean;
  [NetworkID.Testnet]?: boolean;
}

interface BondOpts {
  name: string; // Internal name used for references
  displayName: string; // Displayname on UI
  isAvailable: Available; // set false to hide
  bondIconSvg: React.ReactNode; //  SVG path for icons
  bondContractABI: ethers.ContractInterface; // ABI for contract
  networkAddrs: NetworkAddresses; // Mapping of network --> Addresses
  bondToken: string; // Unused, but native token to buy the bond.
}

// Technically only exporting for the interface
export abstract class Bond {
  // Standard Bond fields regardless of LP bonds or stable bonds.
  readonly name: string;
  readonly displayName: string;
  readonly type: BondType;
  readonly isAvailable: Available;
  readonly bondIconSvg: React.ReactNode;
  readonly bondContractABI: ethers.ContractInterface; // Bond ABI
  readonly networkAddrs: NetworkAddresses;
  readonly bondToken: string;

  // The following two fields will differ on how they are set depending on bond type
  abstract isLP: Boolean;
  abstract reserveContract: ethers.ContractInterface; // Token ABI
  abstract displayUnits: string;

  // Async method that returns a Promise
  abstract getTreasuryBalance(networkID: NetworkID, provider: StaticJsonRpcProvider): Promise<number>;

  constructor(type: BondType, bondOpts: BondOpts) {
    this.name = bondOpts.name;
    this.displayName = bondOpts.displayName;
    this.type = type;
    this.isAvailable = bondOpts.isAvailable;
    this.bondIconSvg = bondOpts.bondIconSvg;
    this.bondContractABI = bondOpts.bondContractABI;
    this.networkAddrs = bondOpts.networkAddrs;
    this.bondToken = bondOpts.bondToken;
  }

  /**
   * makes isAvailable accessible within Bonds.ts
   * @param networkID
   * @returns boolean
   */
  getAvailability(networkID: NetworkID) {
    return this.isAvailable[networkID];
  }

  getAddressForBond(networkID: NetworkID) {
    return this.networkAddrs[networkID].bondAddress;
  }
  getContractForBond(networkID: NetworkID, provider: StaticJsonRpcProvider | JsonRpcSigner) {
    const bondAddress = this.getAddressForBond(networkID);
    return new ethers.Contract(bondAddress, this.bondContractABI, provider) as EthContract;
  }

  getAddressForReserve(networkID: NetworkID) {
    return this.networkAddrs[networkID].reserveAddress;
  }
  getContractForReserve(networkID: NetworkID, provider: StaticJsonRpcProvider | JsonRpcSigner) {
    const bondAddress = this.getAddressForReserve(networkID);
    return new ethers.Contract(bondAddress, this.reserveContract, provider) as PairContract;
  }

  // TODO (appleseed): improve this logic
  async getBondReservePrice(networkID: NetworkID, provider: StaticJsonRpcProvider | JsonRpcSigner) {
    let marketPrice: number;
    if (this.isLP) {
      // const pairContract = this.getContractForReserve(networkID, provider);
      // const reserves = await pairContract.getReserves();
      const reserves = await callMethodWithPool({ networkID, provider: <any>provider })(this.getAddressForReserve(networkID), <any>this.reserveContract, "getReserves", [])
      marketPrice = Number(reserves[1].toString()) / Number(reserves[0].toString()) / 10 ** 9;
    } else {
      marketPrice = 1//await getTokenPrice("convex-finance");
    }
    return marketPrice;
  }
}

// Keep all LP specific fields/logic within the LPBond class
export interface LPBondOpts extends BondOpts {
  reserveContract: ethers.ContractInterface;
  lpUrl: string;
}

export class LPBond extends Bond {
  readonly isLP = true;
  readonly lpUrl: string;
  readonly reserveContract: ethers.ContractInterface;
  readonly displayUnits: string;

  constructor(lpBondOpts: LPBondOpts) {
    super(BondType.LP, lpBondOpts);

    this.lpUrl = lpBondOpts.lpUrl;
    this.reserveContract = lpBondOpts.reserveContract;
    this.displayUnits = "LP";
  }
  async getTreasuryBalance(networkID: NetworkID, provider: StaticJsonRpcProvider) {

    const tokenAddress = this.getAddressForReserve(networkID);
    const calcAddress = addresses[networkID].BONDINGCALC_ADDRESS
    const callMethod = callMethodWithPool({ networkID, provider })
    const [
      tokenAmount,
      _valuation,
      markdown,
    ] = await Promise.all([
      callMethod(tokenAddress, <any>this.reserveContract, "balanceOf", [addresses[networkID].TREASURY_ADDRESS]).then(e => e[0]),
      callMethod(calcAddress, <any>BondCalcContractABI, "valuation", [tokenAddress, String(1e18)]).then(e => e[0]),
      callMethod(calcAddress, <any>BondCalcContractABI, "markdown", [tokenAddress]).then(e => e[0]),
    ])


    const valuation = (+tokenAmount / 1e18) * +_valuation

    // const tokenAmount = await token.balanceOf(addresses[networkID].TREASURY_ADDRESS);
    // const valuation = await bondCalculator.valuation(tokenAddress, tokenAmount);
    // const markdown = await bondCalculator.markdown(tokenAddress);
    let tokenUSD = (Number(valuation.toString()) / Math.pow(10, 9)) * (Number(markdown.toString()) / Math.pow(10, 18));
    return Number(tokenUSD.toString());
  }
}

// Generic BondClass we should be using everywhere
// Assumes the token being deposited follows the standard ERC20 spec
export interface StableBondOpts extends BondOpts { }
export class StableBond extends Bond {
  readonly isLP = false;
  readonly reserveContract: ethers.ContractInterface;
  readonly displayUnits: string;

  constructor(stableBondOpts: StableBondOpts) {
    super(BondType.StableAsset, stableBondOpts);
    // For stable bonds the display units are the same as the actual token
    this.displayUnits = stableBondOpts.displayName;
    this.reserveContract = ierc20Abi; // The Standard ierc20Abi since they're normal tokens
  }

  async getTreasuryBalance(networkID: NetworkID, provider: StaticJsonRpcProvider) {
    const callMethod = callMethodWithPool({ networkID, provider })
    let tokenAmount = await callMethod(this.getAddressForReserve(networkID), <any>this.reserveContract, "balanceOf", [addresses[networkID].TREASURY_ADDRESS]);
    return Number(tokenAmount.toString()) / Math.pow(10, 18);
  }
}

// These are special bonds that have different valuation methods
export interface CustomBondOpts extends BondOpts {
  reserveContract: ethers.ContractInterface;
  bondType: number;
  lpUrl: string;
  customTreasuryBalanceFunc: (
    this: CustomBond,
    networkID: NetworkID,
    provider: StaticJsonRpcProvider,
  ) => Promise<number>;
}
export class CustomBond extends Bond {
  readonly isLP: Boolean;
  getTreasuryBalance(networkID: NetworkID, provider: StaticJsonRpcProvider): Promise<number> {
    throw new Error("Method not implemented.");
  }
  readonly reserveContract: ethers.ContractInterface;
  readonly displayUnits: string;
  readonly lpUrl: string;

  constructor(customBondOpts: CustomBondOpts) {
    super(customBondOpts.bondType, customBondOpts);

    if (customBondOpts.bondType === BondType.LP) {
      this.isLP = true;
    } else {
      this.isLP = false;
    }
    this.lpUrl = customBondOpts.lpUrl;
    // For stable bonds the display units are the same as the actual token
    this.displayUnits = customBondOpts.displayName;
    this.reserveContract = customBondOpts.reserveContract;
    this.getTreasuryBalance = customBondOpts.customTreasuryBalanceFunc.bind(this);
  }
}
