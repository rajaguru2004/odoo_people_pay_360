export type NotificationType =
    | 'INFO'
    | 'SUCCESS'
    | 'WARNING'
    | 'ERROR'
    | 'LEAVE_APPROVED'
    | 'LEAVE_REJECTED'
    | 'OVERTIME_APPROVED'
    | 'OVERTIME_REJECTED'
    | 'PAYROLL_GENERATED'
    | 'CONTRACT_EXPIRING'
    | 'REWARD_RECEIVED'
    | 'DISCIPLINE_ISSUED'
    | 'VISA_EXPIRING'
    | 'VISA_EXPIRED'
    | 'VISA_RENEWED';

export interface Notification {
    id: string;
    userId: string;
    title: string;
    message: string;
    type: NotificationType;
    link?: string;
    isRead: boolean;
    readAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface NotificationResponse {
    success: boolean;
    data: Notification[];
}

export interface UnreadCountResponse {
    success: boolean;
    data: {
        count: number;
    };
}
