const { ethers, bn, ethersMulticall, dayjs } = require('../lib');
const { ethereum, toFloat, tokens, coingecko } = require('../utils');
const { getMasterChefStakingToken } = require('../utils/masterChef/masterChefStakingToken');
const masterChefABI = require('./abi/masterChefABI.json');
const masterChefSavedPools = require('./abi/masterChefPools.json');
const MasterChefJoeLpRestakeABI = require('./abi/MasterChefJoeLpRestakeABI.json');

const masterChefAddress = '0x1495b7e8d7E9700Bd0726F1705E864265724f6e2';

module.exports = {
  masterChef: async (provider, contractAddress, initOptions = ethereum.defaultOptions()) => {
    const options = {
      ...ethereum.defaultOptions(),
      ...initOptions,
    };
    const blockTag = options.blockNumber === 'latest' ? 'latest' : parseInt(options.blockNumber, 10);
    const network = (await provider.detectNetwork()).chainId;
    const block = await provider.getBlock(blockTag);
    const blockNumber = block.number;
    const avgBlockTime = await ethereum.getAvgBlockTime(provider, blockNumber);
    const rewardTokenFunctionName = 'joe';

    const masterChiefContract = new ethers.Contract(masterChefAddress, masterChefABI, provider);

    let poolIndex = -1;

    let masterChefPools = masterChefSavedPools;
    if (!masterChefSavedPools || masterChefSavedPools.length === 0) {
      const totalPools = await masterChiefContract.poolLength();
      masterChefPools = (
        await Promise.all(new Array(totalPools.toNumber()).fill(1).map((_, i) => masterChiefContract.poolInfo(i)))
      ).map((p, i) => ({
        index: i,
        stakingToken: p.lpToken,
      }));
    }

    const foundPoolIndex = masterChefPools.find((p) => p.stakingToken.toLowerCase() === contractAddress.toLowerCase());

    poolIndex = foundPoolIndex !== undefined ? foundPoolIndex.index : -1;

    if (poolIndex === -1) {
      throw new Error('Pool is not found');
    }
    const pool = await masterChiefContract.poolInfo(poolIndex);

    const stakingToken = contractAddress.toLowerCase();
    const rewardsToken = (await masterChiefContract[rewardTokenFunctionName]()).toLowerCase();

    const [stakingTokenDecimals, rewardsTokenDecimals] = await Promise.all([
      ethereum
        .erc20(provider, stakingToken)
        .decimals()
        .then((res) => Number(res.toString())),
      ethereum
        .erc20(provider, rewardsToken)
        .decimals()
        .then((res) => Number(res.toString())),
    ]);

    const [rewardTokenPerBlock, totalAllocPoint] = await Promise.all([
      await masterChiefContract[`${rewardTokenFunctionName}PerSec`](),
      await masterChiefContract.totalAllocPoint(),
    ]);

    const rewardPerBlock = toFloat(
      new bn(pool.allocPoint.toString())
        .multipliedBy(rewardTokenPerBlock.toString())
        .dividedBy(totalAllocPoint.toString()),
      rewardsTokenDecimals
    );

    const rewardTokenUSD = await coingecko.getPriceUSDByContract(
      coingecko.platformByEthereumNetwork(network),
      blockTag === 'latest',
      block,
      rewardsToken
    );

    const totalLocked = toFloat(
      await ethereum.erc20(provider, contractAddress).balanceOf(masterChefAddress),
      stakingTokenDecimals
    );

    const masterChiefStakingToken = await getMasterChefStakingToken(provider, stakingToken, network, blockTag, block);

    const tvl = new bn(totalLocked).multipliedBy(masterChiefStakingToken.getUSD());

    let aprBlock = rewardPerBlock.multipliedBy(rewardTokenUSD).div(tvl);
    if (!aprBlock.isFinite()) aprBlock = new bn(0);

    const blocksPerDay = new bn((1000 * 60 * 60 * 24) / avgBlockTime);
    const aprDay = aprBlock.multipliedBy(blocksPerDay);
    const aprWeek = aprBlock.multipliedBy(blocksPerDay.multipliedBy(7));
    const aprMonth = aprBlock.multipliedBy(blocksPerDay.multipliedBy(30));
    const aprYear = aprBlock.multipliedBy(blocksPerDay.multipliedBy(365));

    return {
      staking: {
        token: stakingToken,
        decimals: stakingTokenDecimals,
      },
      reward: {
        token: rewardsToken,
        decimals: rewardsTokenDecimals,
      },
      metrics: {
        tvl: tvl.toString(10),
        aprDay: aprDay.toString(10),
        aprWeek: aprWeek.toString(10),
        aprMonth: aprMonth.toString(10),
        aprYear: aprYear.toString(10),
        rewardPerDay: rewardPerBlock.multipliedBy(blocksPerDay).toString(),
      },
      wallet: async (walletAddress) => {
        const { amount, rewardDebt } = await masterChiefContract.userInfo(poolIndex, walletAddress);
        const { accJoePerShare } = await masterChiefContract.poolInfo(poolIndex);
        const balance = toFloat(amount, ethereum.uniswap.pairDecimals);
        const earned = toFloat(
          new bn(amount.toString())
            .multipliedBy(accJoePerShare.toString())
            .div(new bn(10).pow(12))
            .minus(rewardDebt.toString())
            .toString(10),
          rewardsTokenDecimals
        );
        const reviewedBalance = masterChiefStakingToken.reviewBalance(balance.toString(10));

        const earnedUSD = earned.multipliedBy(rewardTokenUSD);

        return {
          staked: reviewedBalance.reduce((res, b) => {
            res[b.token] = {
              balance: b.balance,
              usd: b.usd,
            };
            return res;
          }, {}),
          earned: {
            [rewardsToken]: {
              balance: earned.toString(10),
              usd: earnedUSD.toString(10),
            },
          },
          metrics: {
            staking: balance.toString(10),
            stakingUSD: balance.multipliedBy(masterChiefStakingToken.getUSD()).toString(10),
            earned: earned.toString(10),
            earnedUSD: earnedUSD.toString(10),
          },
          tokens: tokens(
            ...reviewedBalance.map((b) => ({
              token: b.token,
              data: {
                balance: b.balance,
                usd: b.usd,
              },
            })),
            {
              token: rewardsToken,
              data: {
                balance: earned.toString(10),
                usd: earnedUSD.toString(10),
              },
            }
          ),
        };
      },

      actions: async (walletAddress) => {
        if (options.signer === null) {
          throw new Error('Signer not found, use options.signer for use actions');
        }
        const { signer } = options;
        const stakingTokenContract = ethereum.erc20(provider, stakingToken).connect(signer);
        const stakingContract = masterChiefContract.connect(signer);

        return {
          stake: {
            can: async (amount) => {
              const balance = await stakingTokenContract.balanceOf(walletAddress);
              if (new bn(amount).isGreaterThan(balance.toString())) {
                return Error('Amount exceeds balance');
              }

              return true;
            },
            send: async (amount) => {
              await stakingTokenContract.approve(masterChefAddress, amount);
              await stakingContract.deposit(poolIndex, amount);
            },
          },
          unstake: {
            can: async (amount) => {
              const userInfo = await stakingContract.userInfo(poolIndex, walletAddress);
              if (new bn(amount).isGreaterThan(userInfo.amount.toString())) {
                return Error('Amount exceeds balance');
              }

              return true;
            },
            send: async (amount) => {
              await stakingContract.withdraw(poolIndex, amount);
            },
          },
          claim: {
            can: async () => {
              const { amount, rewardDebt } = await masterChiefContract.userInfo(poolIndex, walletAddress);
              const { accJoePerShare } = await masterChiefContract.poolInfo(poolIndex);
              const earned = new bn(amount.toString())
                .multipliedBy(accJoePerShare.toString())
                .div(new bn(10).pow(12))
                .minus(rewardDebt.toString());
              if (earned.isLessThanOrEqualTo(0)) {
                return Error('No earnings');
              }
              return true;
            },
            send: async () => {
              // https://github.com/sushiswap/sushiswap-interface/blob/05324660917f44e3c360dc7e2892b2f58e21647e/src/features/farm/useMasterChef.ts#L64
              await stakingContract.deposit(poolIndex, 0);
            },
          },
          exit: {
            can: async () => {
              const userInfo = await stakingContract.userInfo(poolIndex, walletAddress);
              if (new bn(userInfo.amount.toString()).isLessThanOrEqualTo(0)) {
                return Error('No LP in contract');
              }

              return true;
            },
            send: async () => {
              const userInfo = await stakingContract.userInfo(poolIndex, walletAddress);
              await stakingContract.withdraw(poolIndex, userInfo.amount.toString());
            },
          },
        };
      },
    };
  },
  automates: {
    MasterChefJoeLpRestake: async (signer, contractAddress) => {
      const automate = new ethers.Contract(contractAddress, MasterChefJoeLpRestakeABI, signer);
      const stakingAddress = await automate.staking();
      const staking = new ethers.Contract(stakingAddress, masterChefABI, signer);
      const stakingTokenAddress = await automate.stakingToken();
      const stakingToken = ethereum.erc20(signer, stakingTokenAddress);
      const poolId = await automate.pool().then((v) => v.toString());

      const deposit = async () => {
        const signerAddress = await signer.getAddress();
        const signerBalance = await stakingToken.balanceOf(signerAddress);
        if (signerBalance.toString() !== '0') {
          await (await stakingToken.transfer(automate.address, signerBalance)).wait();
        }
        const automateBalance = await stakingToken.balanceOf(automate.address);
        if (automateBalance.toString() !== '0') {
          await (await automate.deposit()).wait();
        }
      };
      const refund = async () => {
        return automate.refund();
      };
      const migrate = async () => {
        const signerAddress = await signer.getAddress();
        const userInfo = await staking.userInfo(poolId, signerAddress);
        await (await staking.withdraw(poolId, userInfo.amount.toString())).wait();
        return deposit();
      };
      const runParams = async () => {
        const multicall = new ethersMulticall.Provider(signer, await signer.getChainId());
        const automateMulticall = new ethersMulticall.Contract(contractAddress, MasterChefJoeLpRestakeABI);
        const stakingMulticall = new ethersMulticall.Contract(stakingAddress, masterChefABI);
        const stakingTokenMulticall = new ethersMulticall.Contract(stakingTokenAddress, ethereum.uniswap.pairABI);
        const [
          infoAddress,
          slippagePercent,
          deadlineSeconds,
          token0Address,
          token1Address,
          rewardTokenAddress,
          { amount, rewardDebt },
          { accJoePerShare },
        ] = await multicall.all([
          automateMulticall.info(),
          automateMulticall.slippage(),
          automateMulticall.deadline(),
          stakingTokenMulticall.token0(),
          stakingTokenMulticall.token1(),
          automateMulticall.rewardToken(),
          stakingMulticall.userInfo(poolId, contractAddress),
          stakingMulticall.poolInfo(poolId),
        ]);
        const earned = new bn(amount.toString())
          .multipliedBy(accJoePerShare.toString())
          .div(new bn(10).pow(12))
          .minus(rewardDebt.toString());
        if (earned.toString(10) === '0') return new Error('No earned');
        const routerAddress = await ethereum.dfh
          .storage(signer, infoAddress)
          .getAddress(ethereum.dfh.storageKey('Joe:Contract:Router2'));
        const router = ethereum.uniswap.router(signer, routerAddress);

        const slippage = 1 - slippagePercent / 10000;
        const token0AmountIn = new bn(earned.toString(10)).div(2).toFixed(0);
        let token0Min = new bn(token0AmountIn).multipliedBy(slippage).toFixed(0);
        if (token0Address.toLowerCase() !== rewardTokenAddress.toLowerCase()) {
          const [, amountOut] = await router.getAmountsOut(token0AmountIn, [rewardTokenAddress, token0Address]);
          token0Min = new bn(amountOut.toString()).multipliedBy(slippage).toFixed(0);
        }
        const token1AmountIn = new bn(earned.toString(10)).minus(token0AmountIn).toFixed(0);
        let token1Min = new bn(token1AmountIn).multipliedBy(slippage).toFixed(0);
        if (token1Address.toLowerCase() !== rewardTokenAddress.toLowerCase()) {
          const [, amountOut] = await router.getAmountsOut(token1AmountIn, [rewardTokenAddress, token1Address]);
          token1Min = new bn(amountOut.toString()).multipliedBy(slippage).toFixed(0);
        }
        const deadline = dayjs().add(deadlineSeconds, 'seconds').unix();

        const gasLimit = await automate.estimateGas.run(0, deadline, [token0Min, token1Min]);
        const gasPrice = await signer.getGasPrice();
        const gasFee = new bn(gasLimit.toString()).multipliedBy(gasPrice.toString()).toFixed(0);

        return [gasFee, deadline, [token0Min, token1Min]];
      };
      const run = async () => {
        return automate.run.apply(automate, await runParams());
      };

      return {
        contract: stakingAddress,
        deposit,
        refund,
        migrate,
        runParams,
        run,
      };
    },
  },
};
