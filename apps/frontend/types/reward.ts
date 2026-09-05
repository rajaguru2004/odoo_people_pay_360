export type RewardType = 'BONUS' | 'CERTIFICATE' | 'PROMOTION' | 'OTHER';

export interface Reward {
  id: string;
  employeeId: string;
  reason: string;
  amount: number;
  rewardDate: string;
  rewardType: RewardType;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    department?: {
      name: string;
    };
  };
  creator?: {
    id: string;
    email: string;
  };
}

export interface CreateRewardData {
  employeeId: string;
  reason: string;
  amount: number;
  rewardDate: string;
  rewardType?: RewardType;
}

export interface RewardStats {
  totalRewards: number;
  totalAmount: number;
  byType: {
    type: RewardType;
    count: number;
    amount: number;
  }[];
}
