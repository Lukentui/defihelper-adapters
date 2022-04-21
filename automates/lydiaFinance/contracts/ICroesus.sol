// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.8.6;

interface ICroesus {
  struct UserInfo {
    uint256 amount;
    uint256 rewardDebt;
  }

  struct PoolInfo {
    address lpToken;
    uint256 allocPoint;
    uint256 lastRewardTimestamp;
    uint256 accLydPerShare;
  }

  function lyd() external view returns (address);

  function poolInfo(uint256 pool) external view returns (PoolInfo memory);

  function userInfo(uint256 pool, address user) external view returns (UserInfo memory);

  function pendingLyd(uint256 pool, address user) external view returns (uint256);

  function deposit(uint256 pool, uint256 amount) external;

  function enterStaking(uint256 amount) external;

  function withdraw(uint256 pool, uint256 amount) external;

  function leaveStaking(uint256 amount) external;

  function emergencyWithdraw(uint256 pool) external;
}
