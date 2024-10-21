import { DeployHelper } from "../../../helpers/DeployHelper";
import hre, { ethers } from "hardhat";
import { UniversalVerifierContractMigrationHelper } from "../../../helpers/UniversalVerifierContractMigrationHelper";
import * as universalVerifierArtifact from "../../../artifacts/contracts/verifiers/UniversalVerifier.sol/UniversalVerifier.json";
import * as stateArtifact from "../../../artifacts/contracts/state/State.sol/State.json";
import { expect } from "chai";
import { Contract } from "ethers";
import { StateContractMigrationHelper } from "../../../helpers/StateContractMigrationHelper";
import {
  setZKPRequest_KYCAgeCredential,
  submitZKPResponses_KYCAgeCredential,
} from "./helpers/testVerifier";
import {
  getConfig,
  getStateContractAddress,
  removeLocalhostNetworkIgnitionFiles,
  verifyContract,
  waitNotToInterfereWithHardhatIgnition,
} from "../../../helpers/helperUtils";
import { contractsInfo } from "../../../helpers/constants";
import fs from "fs";
import path from "path";

const removePreviousIgnitionFiles = true;
const upgradeStateContract = false;
const impersonate = false;

const config = getConfig();

const chainId = hre.network.config.chainId;
const network = hre.network.name;
let stateContractAddress = contractsInfo.STATE.unifiedAddress;

async function getSigners(useImpersonation: boolean): Promise<any> {
  if (useImpersonation) {
    const proxyAdminOwnerSigner = await ethers.getImpersonatedSigner(config.ledgerAccount);
    const universalVerifierOwnerSigner = await ethers.getImpersonatedSigner(config.ledgerAccount);
    return { proxyAdminOwnerSigner, universalVerifierOwnerSigner };
  } else {
    const [signer] = await ethers.getSigners();
    const proxyAdminOwnerSigner = signer;
    const universalVerifierOwnerSigner = signer;

    return { proxyAdminOwnerSigner, universalVerifierOwnerSigner };
  }
}

async function main() {
  const deployStrategy: "basic" | "create2" =
    config.deployStrategy == "create2" ? "create2" : "basic";

  console.log("Starting Universal Verifier Contract Upgrade");

  if (!ethers.isAddress(config.ledgerAccount)) {
    throw new Error("LEDGER_ACCOUNT is not set");
  }
  stateContractAddress = getStateContractAddress();

  const { proxyAdminOwnerSigner, universalVerifierOwnerSigner } = await getSigners(impersonate);

  console.log("Proxy Admin Owner Address: ", await proxyAdminOwnerSigner.getAddress());
  console.log(
    "Universal Verifier Owner Address: ",
    await universalVerifierOwnerSigner.getAddress(),
  );
  const deployerHelper = await DeployHelper.initialize(
    [proxyAdminOwnerSigner, universalVerifierOwnerSigner],
    true,
  );

  if (removePreviousIgnitionFiles) {
    removeLocalhostNetworkIgnitionFiles(network, chainId);
  }

  if (upgradeStateContract) {
    await upgradeState(deployerHelper, proxyAdminOwnerSigner);
  }

  const universalVerifierMigrationHelper = new UniversalVerifierContractMigrationHelper(
    deployerHelper,
    proxyAdminOwnerSigner,
  );

  const universalVerifierContract = await universalVerifierMigrationHelper.getInitContract({
    contractNameOrAbi: universalVerifierArtifact.abi,
    address: contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress,
  });

  const universalVerifierOwnerAddressBefore = await universalVerifierContract.owner();
  console.log("Owner Address Before Upgrade: ", universalVerifierOwnerAddressBefore);
  const dataBeforeUpgrade =
    await universalVerifierMigrationHelper.getDataFromContract(universalVerifierContract);

  const whitelistedValidators = dataBeforeUpgrade.validators;

  for (const validator of whitelistedValidators) {
    expect(await universalVerifierContract.isWhitelistedValidator(validator)).to.equal(true);
  }

  const verifierLib = await deployerHelper.deployVerifierLib();
  const txVerifLib = await verifierLib.deploymentTransaction();
  await waitNotToInterfereWithHardhatIgnition(txVerifLib);

  await verifyContract(await verifierLib.getAddress(), contractsInfo.VERIFIER_LIB.verificationOpts);

  // **** Upgrade Universal Verifier ****
  await universalVerifierMigrationHelper.upgradeContract(universalVerifierContract, {
    verifierLibAddress: await verifierLib.getAddress(),
  });
  // ************************
  console.log("Checking data after upgrade");

  await verifyContract(
    await universalVerifierContract.getAddress(),
    contractsInfo.UNIVERSAL_VERIFIER.verificationOpts,
  );

  const dataAfterUpgrade =
    await universalVerifierMigrationHelper.getDataFromContract(universalVerifierContract);
  universalVerifierMigrationHelper.checkData(dataBeforeUpgrade, dataAfterUpgrade);
  const universalVerifierOwnerAddressAfter = await universalVerifierContract.owner();

  for (const validator of whitelistedValidators) {
    expect(await universalVerifierContract.isWhitelistedValidator(validator)).to.equal(true);
  }

  expect(universalVerifierOwnerAddressBefore).to.equal(universalVerifierOwnerAddressAfter);
  console.log("Verifier Contract Upgrade Finished");

  const state = await ethers.getContractAt(
    stateArtifact.abi,
    stateContractAddress,
    universalVerifierOwnerSigner,
  );

  console.log("Id Type configured in state: ", await state.getDefaultIdType());

  const crossChainProofValidatorAddress = await state.getCrossChainProofValidator();
  console.log("crossChainProofValidatorAddress: ", crossChainProofValidatorAddress);

  const tx = await universalVerifierContract.setState(state);
  await tx.wait();

  console.log("Upgrading validators and adding them to whitelist...");

  const validators = [
    {
      validatorContractAddress: contractsInfo.VALIDATOR_MTP.unifiedAddress,
      validatorContractName: contractsInfo.VALIDATOR_MTP.name,
      validatorVerification: contractsInfo.VALIDATOR_MTP.verificationOpts,
    },
    {
      validatorContractAddress: contractsInfo.VALIDATOR_SIG.unifiedAddress,
      validatorContractName: contractsInfo.VALIDATOR_SIG.name,
      validatorVerification: contractsInfo.VALIDATOR_SIG.verificationOpts,
    },
    {
      validatorContractAddress: contractsInfo.VALIDATOR_V3.unifiedAddress,
      validatorContractName: contractsInfo.VALIDATOR_V3.name,
      validatorVerification: contractsInfo.VALIDATOR_V3.verificationOpts,
    },
  ];

  for (const v of validators) {
    const { validator } = await deployerHelper.upgradeValidator(
      v.validatorContractAddress as string,
      v.validatorContractName,
    );
    await validator.waitForDeployment();
    console.log(`Validator ${v.validatorContractName} version:`, await validator.version());

    await verifyContract(await validator.getAddress(), v.validatorVerification);

    const isWhitelisted = await universalVerifierContract.isWhitelistedValidator(
      v.validatorContractAddress,
    );
    if (!isWhitelisted) {
      console.log(`Adding validator ${v.validatorContractName} to whitelist...`);
      const addToWhiteListTx = await universalVerifierContract.addValidatorToWhitelist(
        v.validatorContractAddress,
      );
      await addToWhiteListTx.wait();
    }
  }

  const pathOutputJson = path.join(
    __dirname,
    `../../deployments_output/deploy_universal_verifier_output_${chainId}_${network}.json`,
  );
  const outputJson = {
    proxyAdminOwnerAddress: await proxyAdminOwnerSigner.getAddress(),
    universalVerifier: await universalVerifierContract.getAddress(),
    verifierLib: await verifierLib.getAddress(),
    state: stateContractAddress,
    network: network,
    chainId,
    deployStrategy,
  };
  fs.writeFileSync(pathOutputJson, JSON.stringify(outputJson, null, 1));

  console.log("Testing verifiation with submitZKPResponseV2 after migration...");
  await testVerification(universalVerifierContract, contractsInfo.VALIDATOR_V3.unifiedAddress);
}

async function onlyTestVerification() {
  const { universalVerifierOwnerSigner } = await getSigners(impersonate);
  const universalVerifierContract = await ethers.getContractAt(
    universalVerifierArtifact.abi,
    contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress,
    universalVerifierOwnerSigner,
  );
  console.log("Testing verifiation with submitZKPResponseV2 after migration...");
  await testVerification(universalVerifierContract, contractsInfo.VALIDATOR_V3.unifiedAddress);
}

async function upgradeState(deployHelper: DeployHelper, signer: any) {
  const stateMigrationHelper = new StateContractMigrationHelper(deployHelper, signer);

  const stateContract = await stateMigrationHelper.getInitContract({
    contractNameOrAbi: stateArtifact.abi,
    address: stateContractAddress,
  });

  // **** Upgrade State ****
  await stateMigrationHelper.upgradeContract(stateContract, {
    redeployCrossChainProofValidator: true,
    smtLibAddress: contractsInfo.SMT_LIB.unifiedAddress,
    poseidon1Address: contractsInfo.POSEIDON_1.unifiedAddress,
  }); // first upgrade we need deploy oracle proof validator
  // ************************
  // If testing with forked zkevm network wait for 1 confirmation, otherwise is waiting forever
  const waitConfirmations = network === "localhost" || network === "hardhat" ? 1 : 5;
  switch (chainId) {
    case 1101: // polygon zkevm
      console.log("Setting default id type to 0x0214");
      const tx1 = await stateContract.setDefaultIdType("0x0214");
      // ignition needs 5 confirmations for deployment/upgrade transactions to work
      await tx1.wait(waitConfirmations);
      break;
    case 2442: // polygon cardona
      console.log("Setting default id type to 0x0215");
      const tx2 = await stateContract.setDefaultIdType("0x0215");
      // ignition needs 5 confirmations for deployment/upgrade transactions to work
      await tx2.wait(waitConfirmations);
      break;
    default:
      break;
  }

  await verifyContract(await stateContract.getAddress(), contractsInfo.STATE.verificationOpts);
  console.log("State Contract Upgrade Finished");
}

async function testVerification(verifier: Contract, validatorV3Address: string) {
  const requestId = 112233;
  await setZKPRequest_KYCAgeCredential(requestId, verifier, validatorV3Address);
  await submitZKPResponses_KYCAgeCredential(requestId, verifier, {
    stateContractAddress: stateContractAddress,
    verifierContractAddress: contractsInfo.UNIVERSAL_VERIFIER.unifiedAddress,
  });
}

// onlyTestVerification() // Use this to only test verification after upgrade
main() // Use this to upgrade and test verification
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });