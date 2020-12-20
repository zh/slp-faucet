# SLP Faucet Example

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/simpleledger/slp-faucet)

This project is an example of an SLP faucet website. Users can enter their SLP address and the server will send the token quantity specified within the environment variables (i.e., per `TOKENQTY` and `TOKENID`) to the user's address.

## Faucet Capacity

The admin can initiate this distribution by entering the `DISTRIBUTE_SECRET` environment variable into the site's address input field.

### Fungible tokens

This faucet can service 900 transactions per block (i.e., 50 txn limit/block x 18 addresses = 900). The faucet admin can automatically distribute tokens and the BCH (for paying transaction fees) evenly across the first 18 addresses located at the `m/44'/245'/0'/0/X` HD path, where `X` is an address index in the range 0 to 17.

NOTE: You will need to wait 1 block confirmation after distribution step before the faucet will be able to be used. This is because address selection is based on finding the first address with a unconfirmed balance of 0 BCH.

### Non-fungible tokens (NFT)

All generated NFT tokens are children of a parent NFT Group token.
Because all NFTs are generated 'one-the-fly', one by one, the distribution of the tokens
will be slower that for fungible ones.

## Setup

- Use Electron Cash SLP or other SLP wallet to store faucet token & BCH coins, then use the mnemonic for that wallet for the faucet in the `MNEMONIC` environmental variable.
- To generate children non-fungible tokens (NFTs), set `TOKENID` to the group (parent) token Id and set `NFT=yes`. In this case `TOKENQTY` will be ignored and only one uniq non-fungible token will be generated.
- For NFT tokens (`NFT=yes`) you can also provide name, ticker, document URI and hash as
  `NFTNAME`, `NFTTICKER`, `DOCUMENTURI` and `DOCUMENTHASH`

- Create a new `.env` file with the following environment variables:

```
MNEMONIC=______
TOKENID=_______
TOKENQTY=______
DISTRIBUTE_SECRET=______
PORT=______
NFT=no
DOCUMENTURI=https://github.com/simpleledger/slp-faucet
DOCUMENTHASH=______
NFTNAME=______
NFTTICKER=______
```

## Run the web app locally:

```
$ npm i
$ node server.js
```

## Build Source

If you want to modify the source (i.e., the `*.ts` files), you will need to rebuild using `tsc` before running the app. TypeScript needs to be installed globally via `npm install -g typescript`.
