var express = require("express");
var router = express.Router();

const {
  makeRandomPrivKey,
  privateKeyToString,
  getAddressFromPrivateKey,
  TransactionVersion,
  StacksTestnet,
  uintCV,
  tupleCV,
  makeContractCall,
  bufferCV,
  serializeCV,
  deserializeCV,
  cvToString,
  makeContractSTXPostCondition,
} = require("@blockstack/stacks-transactions");
const {
  InfoApi,
  AccountsApi,
  SmartContractsApi,
  Configuration,
  TransactionsApi,
} = require("@stacks/blockchain-api-client");
const c32 = require("c32check");

// by default will try to access a local node @ localhost:20443
const apiConfig = new Configuration({
  fetchApi: fetch,
  // basePath: "http://localhost:20443",
  basePath: "https://stacks-node-api.blockstack.org",
});

// generate random key
const privateKey = makeRandomPrivKey();

// get Stacks address
const principal = getAddressFromPrivateKey(
  privateKeyToString(privateKey),
  TransactionVersion.Testnet
);

/* GET stacking info. */
router.get("/info", async function (req, res, next) {
  const info = new InfoApi(apiConfig);

  const poxInfo = await info.getPoxInfo();
  const coreInfo = await info.getCoreApiInfo();
  const blocktimeInfo = await info.getNetworkBlockTimes();

  console.log({ poxInfo, coreInfo, blocktimeInfo });

  // will Stacking be executed in the next cycle?
  const stackingExecution = poxInfo.rejection_votes_left_required > 0;

  // how long (in seconds) is a Stacking cycle?
  const cycleDuration =
    poxInfo.reward_cycle_length * blocktimeInfo.testnet.target_block_time;

  // how much time is left (in seconds) until the next cycle begins?
  const secondsToNextCycle =
    (poxInfo.reward_cycle_length -
      ((coreInfo.burn_block_height - poxInfo.first_burnchain_block_height) %
        poxInfo.reward_cycle_length)) *
    blocktimeInfo.testnet.target_block_time;

  // the actual datetime of the next cycle start
  const nextCycleStartingAt = new Date();
  nextCycleStartingAt.setSeconds(
    nextCycleStartingAt.getSeconds() + secondsToNextCycle
  );

  // this would be provided by the user
  let numberOfCycles = 3;

  // the projected datetime for the unlocking of tokens
  const unlockingAt = new Date(nextCycleStartingAt);
  unlockingAt.setSeconds(
    unlockingAt.getSeconds() +
      poxInfo.reward_cycle_length *
        numberOfCycles *
        blocktimeInfo.testnet.target_block_time
  );

  res.json({
    stackingExecution,
    cycleDuration,
    secondsToNextCycle,
    nextCycleStartingAt,
    numberOfCycles,
    unlockingAt,
    minimumUSTX: poxInfo.min_amount_ustx,
  });
});

/* GET cycle details. */
router.get("/user", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const accounts = new AccountsApi(apiConfig);

  const poxInfo = await info.getPoxInfo();

  const accountBalance = await accounts.getAccountBalance({
    principal,
  });

  const accountSTXBalance = accountBalance.stx.balance;

  // enough balance for participation?
  const canParticipate = accountSTXBalance >= poxInfo.min_amount_ustx;

  res.json({
    stxAddress: principal,
    btcAddress: c32.c32ToB58(principal),
    accountSTXBalance,
    canParticipate,
  });
});

/* GET eligibility details. */
router.get("/eligible", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const smartContracts = new SmartContractsApi(apiConfig);
  const poxInfo = await info.getPoxInfo();

  const stacksAddress = poxInfo.contract_id.split(".")[0];
  const contractName = poxInfo.contract_id.split(".")[1];
  const functionName = "can-stack-stx";

  let microSTXoLockup = poxInfo.min_amount_ustx;
  let numberOfCycles = 3;

  // note: if this isn't working, check the local node logs:
  // https://docs.blockstack.org/mining

  // generate BTC from Stacks address
  const hashbytes = bufferCV(
    Buffer.from(c32.c32addressDecode(principal)[1], "hex")
  );
  const version = bufferCV(Buffer.from("01", "hex"));

  const isEligible = await smartContracts.callReadOnlyFunction({
    stacksAddress,
    contractName,
    functionName,
    readOnlyFunctionArgs: {
      sender: principal,
      arguments: [
        `0x${serializeCV(
          tupleCV({
            hashbytes,
            version,
          })
        ).toString("hex")}`,
        `0x${serializeCV(uintCV(microSTXoLockup)).toString("hex")}`,
        `0x${serializeCV(uintCV(poxInfo.reward_cycle_id)).toString("hex")}`,
        `0x${serializeCV(uintCV(numberOfCycles)).toString("hex")}`,
      ],
    },
  });

  const response = cvToString(
    deserializeCV(Buffer.from(isEligible.result.slice(2), "hex"))
  );

  if (response.startsWith(`(err `)) {
    // error cases
    return res.json({ isEligible: false });
  }
  // success
  res.json({ isEligible: true });
});

/* GET stack STX */
router.get("/stack", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const tx = new TransactionsApi(apiConfig);
  const poxInfo = await info.getPoxInfo();

  let microSTXoLockup = poxInfo.min_amount_ustx;
  let numberOfCycles = 3;

  // generate BTC from Stacks address
  const hashbytes = bufferCV(
    Buffer.from(c32.c32addressDecode(principal)[1], "hex")
  );
  const version = bufferCV(Buffer.from("01", "hex"));

  const contractAddress = poxInfo.contract_id.split(".")[0];
  const contractName = poxInfo.contract_id.split(".")[1];
  const functionName = "stack-stx";
  const network = new StacksTestnet();

  const txOptions = {
    contractAddress,
    contractName,
    functionName,
    functionArgs: [
      uintCV(microSTXoLockup),
      tupleCV({
        hashbytes,
        version,
      }),
      uintCV(numberOfCycles),
    ],
    senderKey: privateKey.data.toString("hex"),
    validateWithAbi: true,
    network,
  };

  const transaction = await makeContractCall(txOptions);

  const rawTx = transaction.serialize().toString("hex");

  const contractCall = await tx.postCoreNodeTransactions({
    body: rawTx,
  });

  console.log(contractCall);

  res.json({ contractCall });
});

/* GET stacker info */
router.get("/stacker-info", async function (req, res, next) {
  const info = new InfoApi(apiConfig);
  const smartContracts = new SmartContractsApi(apiConfig);
  const poxInfo = await info.getPoxInfo();

  const contractAddress = poxInfo.contract_id.split(".")[0];
  const contractName = poxInfo.contract_id.split(".")[1];
  const functionName = "get-stacker-info";

  const stackingInfo = await smartContracts.callReadOnlyFunction({
    contractAddress,
    contractName,
    functionName,
    readOnlyFunctionArgs: {
      sender: principal,
      arguments: [
        `0x${serializeCV(standardPrincipalCV(principal)).toString("hex")}`,
      ],
    },
  });

  const response = cvToString(
    deserializeCV(Buffer.from(stackingInfo.result.slice(2), "hex"))
  );

  res.json({ response });
});

module.exports = router;
