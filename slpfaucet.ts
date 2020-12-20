import BigNumber from "bignumber.js";
import { BITBOX } from "bitbox-sdk";
import { GrpcClient } from "grpc-bchrpc-node";
import * as slpjs from "slpjs";
import { BchdNetwork, BchdValidator, Utils } from "slpjs";

const bitbox = new BITBOX({restURL: 'https://bchd.fountainhead.cash'});
const client = new GrpcClient({url: 'bchd.fountainhead.cash' });
const validator = new BchdValidator(client, console);

export class SlpFaucetHandler {
    public addresses: string[];
    public wifs: { [key: string]: string };
    public network: BchdNetwork;
    public currentFaucetAddressIndex = 0;

    private unconfirmedChainLength = new Map<string, number>();
    private blockHeight = 0;

    constructor(mnemonic: string) {
        const masterNode = bitbox.HDNode.fromSeed(bitbox.Mnemonic.toSeed(mnemonic!)).derivePath("m/44'/245'/0'");
        this.addresses = [];
        this.wifs = {};
        for (let i = 0; i < 18; i++) {
            const childNode = masterNode.derivePath("0/" + i);
            const address = Utils.toSlpAddress(bitbox.ECPair.toCashAddress(bitbox.ECPair.fromWIF(bitbox.HDNode.toWIF(childNode))));
            this.wifs[address] = bitbox.HDNode.toWIF(childNode);
            this.addresses.push(address);
            this.unconfirmedChainLength.set(address, 0);
        }
        this.network = new BchdNetwork({ BITBOX: bitbox, validator, logger: console, client: validator.client });
    }

    get currentAddress() {
        return this.addresses[this.currentFaucetAddressIndex];
    }

    public bchUtxos(balances: R[]): slpjs.SlpAddressUtxoResult[] {
        const utxos: slpjs.SlpAddressUtxoResult[] = [];
        // add input BCH (non-token) UTXOs
        const bchBalances = balances.filter((i) => i.result.nonSlpUtxos.length > 0);
        if (bchBalances.length === 0) {
            throw Error("BCH balance in faucet wallet is 0.");
        }
        bchBalances.map((i) => i.result.nonSlpUtxos.forEach((j) => j.wif = this.wifs[ i.address as any]));
        bchBalances.forEach((a) => a.result.nonSlpUtxos.forEach((txo) => utxos.push(txo)));
        return utxos;
    }

    public tokenUtxos(tokenBalances: R[], tokenId: string): slpjs.SlpAddressUtxoResult[] {
        const utxos: slpjs.SlpAddressUtxoResult[] = [];
        tokenBalances.map<void>((i) =>
            i.result.slpTokenUtxos[tokenId].forEach((j) => j.wif = this.wifs[ i.address as any]));
        tokenBalances.forEach((a) => {
            try {
                a.result.slpTokenUtxos[tokenId].forEach((txo) => utxos.push(txo));
            } catch (_) { }
        });

        if (tokenBalances.length === 0) {
            throw Error("Token balance in faucet wallet is 0.");
        }
        return utxos;
    }

    public async findUtxo(groupId: string, address: string): Promise<slpjs.SlpAddressUtxoResult | undefined> {
        let burnUtxo: slpjs.SlpAddressUtxoResult | undefined;
        const balance = (await this.network.getAllSlpBalancesAndUtxos(address) as slpjs.SlpBalancesResult);
            if (balance.slpTokenUtxos[groupId]) {
                balance.slpTokenUtxos[groupId].forEach(txo => {
                    if (!burnUtxo && txo.slpUtxoJudgementAmount.isEqualTo(1)) {
                        burnUtxo = txo;
                    }
                });
            }
        return burnUtxo;
    }

    public async evenlyDistributeGroupNFTs(groupId: string) {
        if (this.addresses.length > 19) {
            throw Error("Cannot split token to more than 19 addresses");
        }

        const parentAccount = (await this.network.getAllSlpBalancesAndUtxos(this.addresses[0]) as slpjs.SlpBalancesResult);
        if (parentAccount.nonSlpUtxos.length === 0 || !parentAccount.slpTokenUtxos[groupId]) {
            throw Error("There are no NFT Group tokens available");
        }

        // find addresses without UTXO ready to be burned
        const emptyAddresses: string[] = [];
        const emptyAmounts: BigNumber[] = [];
        for (let i = 1; i < this.addresses.length; i++) {
            const burnUtxo = await this.findUtxo(groupId, this.addresses[i]);
            if (!burnUtxo) {
                emptyAddresses.push(this.addresses[i]);
                emptyAmounts.push(new BigNumber(1));
            }
        }
        // send utxo with qty=1 to all addresses
        if (emptyAddresses.length > 0) {
            let inputs: slpjs.SlpAddressUtxoResult[] = [];
            inputs = [...parentAccount.nonSlpUtxos, ...parentAccount.slpTokenUtxos[groupId]];
            inputs.map((i) => i.wif = this.wifs[this.addresses[0] as any]);
            const burnTxId = await this.network.simpleTokenSend(
                groupId,
                emptyAmounts,
                inputs,
                emptyAddresses,
                this.addresses[0]
            );
            console.log(`burnTx: ${burnTxId}`);
        } else {
            console.log('All addresses already loaded, nothing to do');
        }
    }

    public async evenlyDistributeTokens(tokenId: string): Promise<string> {
        // TODO: use a threshold to determine if split should be made automatically

        if (this.addresses.length > 19) {
            throw Error("Cannot split token to more than 19 addresses");
        }

        const utxos: slpjs.SlpAddressUtxoResult[] = [];
        const balances = ((await this.network.getAllSlpBalancesAndUtxos(this.addresses)) as R[]);

        // add input token UTXOs
        const tokenBalances = balances.filter((i) => {
            try {
                return i.result.slpTokenBalances[tokenId].isGreaterThan(0);
            } catch (_) {
                return false;
            }
        });

        const tokenUtxos = await this.tokenUtxos(tokenBalances, tokenId);
        const bchUtxos = await this.bchUtxos(balances);
        utxos.push(...bchUtxos, ...tokenUtxos);

        const totalToken: BigNumber = tokenBalances.reduce((t, v) => t = t.plus(v.result.slpTokenBalances[tokenId]), new BigNumber(0));
        console.log("total token amount to distribute:", totalToken.toFixed());
        console.log("spread amount", totalToken.dividedToIntegerBy(this.addresses.length).toFixed());
        await this.increaseChainLength();
        return await this.network.simpleTokenSend(
            tokenId,
            Array(this.addresses.length).fill(totalToken.dividedToIntegerBy(this.addresses.length)),
            utxos, this.addresses,
            this.addresses[0]
        );
    }

    public async evenlyDistributeBch(): Promise<string> {
        // TODO: use a threshold to determine if split should be made automatically

        // spread the bch across all of the addresses
        const utxos: slpjs.SlpAddressUtxoResult[] = [];
        const balances = ((await this.network.getAllSlpBalancesAndUtxos(this.addresses)) as R[]);

        const bchBalances = balances.filter((i) => i.result.nonSlpUtxos.length > 0);
        const bchUtxos = await this.bchUtxos(balances);
        utxos.push(...bchUtxos);

        const totalBch = bchBalances.reduce((t, v) => t = t.plus(v.result.satoshis_available_bch), new BigNumber(0));
        const sendCost = this.network.slp.calculateSendCost(0, utxos.length, this.addresses.length, this.addresses[0], 1, false); // rough overestimate
        console.log("estimated send cost:", sendCost);
        console.log("total BCH to distribute:", totalBch.toFixed());
        console.log("spread amount:", totalBch.minus(sendCost).dividedToIntegerBy(this.addresses.length).toFixed());
        await this.increaseChainLength();
        return await this.network.simpleBchSend(
            Array(this.addresses.length).fill(totalBch.minus(sendCost).dividedToIntegerBy(this.addresses.length)),
            utxos,
            this.addresses,
            this.addresses[0]
        );
    }

    public async selectFaucetAddressForTokens(tokenId: string): Promise<{ address: string, balance: slpjs.SlpBalancesResult }> {
        const addresses = this.addresses.filter((_, i) => i >= this.currentFaucetAddressIndex).map((a) => Utils.toCashAddress(a));
        const indexFrom = (process.env.NFT === 'no') ? 0 : 1;
        for (let i = indexFrom; i < addresses.length; i++) {
            if (this.unconfirmedChainLength.get(this.addresses[i])! > 49) {
                continue;
            }

            const bals = (await this.network.getAllSlpBalancesAndUtxos(addresses[i]) as slpjs.SlpBalancesResult);
            if (bals.nonSlpUtxos.length === 0 || !bals.slpTokenUtxos[tokenId]) {
                continue;
            }

            console.log("-----------------------------------");
            console.log("Address Index: ", this.currentFaucetAddressIndex);

            console.log(`Unconfirmed chain length: ${this.unconfirmedChainLength.get(this.currentAddress)}`);

            console.log("cash address:", Utils.toCashAddress(addresses[i]));
            console.log("Processing this address' UTXOs with SLP validator...");
            const addressFrom = (process.env.NFT === 'no') ? 0 : i;
            const sendCost = this.network.slp.calculateSendCost(60, bals.nonSlpUtxos.length + bals.slpTokenUtxos[tokenId].length, 3, addresses[addressFrom]) - 546;
            console.log("Token input quantity: ", bals.slpTokenBalances[tokenId].toFixed());
            console.log("BCH (satoshis_available_bch):", bals.satoshis_available_bch);
            console.log("Estimated send cost (satoshis):", sendCost);
            if (bals.slpTokenBalances[tokenId].isGreaterThan(0) === true && bals.satoshis_available_bch > sendCost) {
                console.log("Using address index:", this.currentFaucetAddressIndex);
                console.log("-----------------------------------");
                return { address: Utils.toSlpAddress(addresses[i]), balance: bals };
            }
            console.log("Address index", this.currentFaucetAddressIndex, "has insufficient BCH to fuel token transaction, trying the next index.");
            console.log("-----------------------------------");
            this.currentFaucetAddressIndex++;
        }
        throw Error("There are no addresses with sufficient balance");
    }

    public async simpleTokenSend(tokenId: string, sendAmount: BigNumber, inputUtxos: slpjs.SlpAddressUtxoResult[], tokenReceiverAddresses: string | string[], changeReceiverAddress: string): Promise<string> {
        await this.increaseChainLength();
        return await this.network.simpleTokenSend(tokenId, sendAmount, inputUtxos, tokenReceiverAddresses, changeReceiverAddress);
    }

    public async nftChildTokenSend(groupId: string, inputUtxos: slpjs.SlpAddressUtxoResult[], tokenReceiverAddress: string, changeReceiverAddress: string): Promise<string> {
        // TODO: get these from .env
        const name = process.env.NFTNAME! || "SLP Faucet NFT";
        const ticker = process.env.NFTTICKER! || "SFNFT";
        const documentUri: string|null = process.env.DOCUMENTURI!;
        const documentHash: Buffer|null = Buffer.from(process.env.DOCUMENTHASH!);

        await this.increaseChainLength();
        return await this.network.simpleNFT1ChildGenesis(
            groupId,
            name,
            ticker,
            documentUri,
            documentHash,
            tokenReceiverAddress,
            changeReceiverAddress,
            inputUtxos,
        );
    }

    private async increaseChainLength() {
        const height = (await client.getBlockchainInfo()).getBestHeight();
        if (height !== this.blockHeight) {
            this.blockHeight = height;
            this.unconfirmedChainLength.forEach((_, addr) => this.unconfirmedChainLength.set(addr, 0));
        }
        const len = this.unconfirmedChainLength.get(this.currentAddress)!;
        this.unconfirmedChainLength.set(this.currentAddress, len + 1);
    }
}

interface R { address: string; result: slpjs.SlpBalancesResult; }
