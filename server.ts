import * as dotenv from "dotenv";
dotenv.config();

import * as express from "express";
const app = express();

import BigNumber from "bignumber.js";
import * as bodyParser from "body-parser";
import * as slpjs from "slpjs";
import { SlpFaucetHandler } from "./slpfaucet";

const slpFaucet = new SlpFaucetHandler(process.env.MNEMONIC!);
const faucetQty = parseInt(process.env.TOKENQTY!);

app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");

app.get("/", (req, res) => {
    res.render("index", { txid: null, error: null });
});

app.post("/", async (req, res) => {
    const address = req.body.address;

    if (address === process.env.DISTRIBUTE_SECRET!) {
        try {
            await slpFaucet.evenlyDistributeBch();
        } catch (err) {
            console.log("distribute bch: ", err);
            res.render("index", { txid: null, error: err.message });
            return;
        }

        if (process.env.NFT === 'no') {
            try {
                await slpFaucet.evenlyDistributeTokens(process.env.TOKENID!);
            } catch (err) {
                console.log("distribute slp: ", err);
                res.render("index", { txid: null, error: err.message });
                return;
            }
        }

        slpFaucet.currentFaucetAddressIndex = 0;
        res.render("index", { txid: null, error: "Token distribution instantiated..." });
        return;
    }

    try {
        if (!slpjs.Utils.isSlpAddress(address)) {
            res.render("index", { txid: null, error: "Not a SLP Address." });
            return;
        }
    } catch (error) {
        res.render("index", { txid: null, error: "Not a SLP Address." });
        return;
    }

    // always refill with burn tokens
    if (process.env.NFT === 'yes') {
        try {
            await slpFaucet.evenlyDistributeGroupNFTs(process.env.TOKENID!);
        } catch (err) {
            console.log("distribute slp: ", err);
            res.render("index", { txid: null, error: err.message });
            return;
        }
    }

    let changeAddr: { address: string, balance: slpjs.SlpBalancesResult };
    try {
        changeAddr = await slpFaucet.selectFaucetAddressForTokens(process.env.TOKENID!);
    } catch (error) {
        res.render("index", { txid: null, error: "Faucet is temporarily empty :(" });
        return;
    }

    let sendTxId: string;
    try {
        let inputs: slpjs.SlpAddressUtxoResult[] = [];
        if (process.env.NFT === 'yes') {
            const groupUtxo = await slpFaucet.findUtxo(process.env.TOKENID!, changeAddr.address);
            if (!groupUtxo) {
                console.log('No Group Token available for burn');
                return
            }
            inputs = [groupUtxo, ...changeAddr.balance.nonSlpUtxos];
        } else {
            inputs = [...changeAddr.balance.nonSlpUtxos, ...changeAddr.balance.slpTokenUtxos[process.env.TOKENID!]];
        }
        inputs.map((i) => i.wif = slpFaucet.wifs[changeAddr.address]);
        if (process.env.NFT === 'yes') {
            sendTxId = await slpFaucet.nftChildTokenSend(process.env.TOKENID!, inputs, address, changeAddr.address);
        } else {
            // fungible tokens
            sendTxId = await slpFaucet.simpleTokenSend(process.env.TOKENID!, new BigNumber(faucetQty), inputs, address, changeAddr.address);
        }
    } catch (error) {
        console.log(error);
        res.render("index", { txid: null, error: "Server error." });
        return;
    }
    const re = /^([A-Fa-f0-9]{2}){32,32}$/;
    if (typeof sendTxId !== "string" || !re.test(sendTxId)) {
        res.render("index", { txid: null, error: sendTxId });
        return;
    }

    res.render("index", { txid: sendTxId, error: null });
});

app.listen(process.env.PORT, () => {
    console.log("SLP faucet server listening on port " + process.env.PORT + "!");
});
