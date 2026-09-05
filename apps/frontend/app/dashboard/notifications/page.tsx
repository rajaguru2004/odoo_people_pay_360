'use client';

import React, { useEffect, useState } from 'react';
import { Bell, Check, CheckCheck, Trash2, Filter } from 'lucide-react';
import notificationService from '@/services/notificationService';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';
import { Notification } from '@/types/notification';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { enUS } from 'date-fns/locale';

export default function NotificationsPage() {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'all' | 'unread'>('all');
    const router = useRouter();

    const unreadCount = notifications.filter((n) => !n.isRead).length;

    // The one heading for this route, rendered by TopHeader.
    usePageHeader(
        'Notification',
        unreadCount > 0 ? `${unreadCount} unread notification` : 'All notifications have been read',
    );

    useEffect(() => {
        fetchNotifications();
    }, [filter]);

    const fetchNotifications = async () => {
        try {
            setLoading(true);
            const response = await notificationService.getAll(filter === 'unread');
            if (response?.data && Array.isArray(response.data)) {
                setNotifications(response.data);
            } else {
                setNotifications([]);
            }
        } catch (error) {
            console.error('Failed to fetch notifications:', error);
            setNotifications([]);
        } finally {
            setLoading(false);
        }
    };

    const handleMarkAsRead = async (id: string) => {
        try {
            await notificationService.markAsRead(id);
            setNotifications((prev) =>
                prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
            );
        } catch (error) {
            console.error('Failed to mark as read:', error);
        }
    };

    const handleMarkAllAsRead = async () => {
        try {
            await notificationService.markAllAsRead();
            setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
        } catch (error) {
            console.error('Failed to mark all as read:', error);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await notificationService.delete(id);
            setNotifications((prev) => prev.filter((n) => n.id !== id));
        } catch (error) {
            console.error('Failed to delete notification:', error);
        }
    };

    const handleDeleteAll = async () => {
        if (!confirm('Are you sure you want to delete all notifications?')) return;
        try {
            await notificationService.deleteAll();
            setNotifications([]);
        } catch (error) {
            console.error('Failed to delete all notifications:', error);
        }
    };

    const handleNotificationClick = async (notification: Notification) => {
        if (!notification.isRead) {
            await handleMarkAsRead(notification.id);
        }
        if (notification.link) {
            router.push(notification.link);
        }
    };

    const getNotificationIcon = (type: string) => {
        const iconClass = 'w-10 h-10 sm:w-12 sm:h-12 rounded-full flex items-center justify-center text-lg sm:text-xl';
        switch (type) {
            case 'SUCCESS':
            case 'LEAVE_APPROVED':
            case 'OVERTIME_APPROVED':
            case 'REWARD_RECEIVED':
                return <div className={`${iconClass} bg-status-success-bg/40 text-status-success`}>✓</div>;
            case 'ERROR':
            case 'LEAVE_REJECTED':
            case 'OVERTIME_REJECTED':
            case 'DISCIPLINE_ISSUED':
                return <div className={`${iconClass} bg-status-error-bg/40 text-status-error`}>✕</div>;
            case 'WARNING':
            case 'CONTRACT_EXPIRING':
                return <div className={`${iconClass} bg-status-warning-bg/40 text-status-warning`}>⚠</div>;
            case 'PAYROLL_GENERATED':
                return <div className={`${iconClass} bg-brand-primary-light/20 text-brand-primary`}>💰</div>;
            default:
                return <div className={`${iconClass} bg-surface-page text-text-muted`}>ℹ</div>;
        }
    };

    return (
        <>
            <div className="space-y-6" data-testid="ess-notifications">
                {/* Actions only — the title/subtitle live in the sticky TopHeader,
                    declared via usePageHeader above. */}
                <PageActionRow
                    action={
                        <>
                            {unreadCount > 0 && (
                                <button
                                    onClick={handleMarkAllAsRead}
                                    className="flex items-center justify-center gap-2 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors whitespace-nowrap"
                                >
                                    <CheckCheck size={18} />
                                    Read them all
                                </button>
                            )}
                            {notifications.length > 0 && (
                                <button
                                    onClick={handleDeleteAll}
                                    className="flex items-center justify-center gap-2 px-4 py-2 bg-status-error text-text-on-brand rounded-[--radius-button] hover:bg-status-error/90 transition-colors whitespace-nowrap"
                                >
                                    <Trash2 size={18} />
                                    Delete all
                                </button>
                            )}
                        </>
                    }
                />

                {/* Filter */}
                <div className="bg-surface-card rounded-[--radius-card] border border-surface-border p-4">
                    <div className="flex items-center flex-wrap gap-3">
                        <Filter size={20} className="text-text-muted shrink-0" />
                        <button
                            onClick={() => setFilter('all')}
                            className={`px-4 py-2 rounded-[--radius-button] font-medium transition-colors whitespace-nowrap ${filter === 'all'
                                ? 'bg-brand-primary text-text-on-brand'
                                : 'bg-surface-page text-text-body hover:bg-surface-border-light'
                                }`}
                        >
                            All ({notifications.length})
                        </button>
                        <button
                            onClick={() => setFilter('unread')}
                            className={`px-4 py-2 rounded-[--radius-button] font-medium transition-colors whitespace-nowrap ${filter === 'unread'
                                ? 'bg-brand-primary text-text-on-brand'
                                : 'bg-surface-page text-text-body hover:bg-surface-border-light'
                                }`}
                        >
                            Unread ({unreadCount})
                        </button>
                    </div>
                </div>

                {/* Notifications List */}
                <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
                    {loading ? (
                        <div className="p-12 text-center">
                            <div className="w-12 h-12 border-4 border-brand-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
                            <p className="text-text-muted mt-4">Loading notification...</p>
                        </div>
                    ) : notifications.length === 0 ? (
                        <div className="p-12 text-center">
                            <Bell size={64} className="text-text-muted opacity-60 mx-auto mb-4" />
                            <h3 className="text-xl font-semibold text-text-heading mb-2">No notifications</h3>
                            <p className="text-text-muted">
                                {filter === 'unread'
                                    ? 'You have read all notices'
                                    : 'There are no announcements yet'}
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-surface-border-light">
                            {notifications.map((notification) => (
                                <div
                                    key={notification.id}
                                    onClick={() => handleNotificationClick(notification)}
                                    className={`p-4 sm:p-6 hover:bg-surface-page/50 transition-colors cursor-pointer ${!notification.isRead ? 'bg-brand-primary-light/10' : ''
                                        }`}
                                >
                                    <div className="flex gap-3 sm:gap-4">
                                        {getNotificationIcon(notification.type)}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-start justify-between gap-2 sm:gap-4">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <h3
                                                            className={`text-base sm:text-lg font-semibold truncate ${!notification.isRead ? 'text-text-heading' : 'text-text-body'
                                                                }`}
                                                        >
                                                            {notification.title}
                                                        </h3>
                                                        {!notification.isRead && (
                                                            <div className="w-2 h-2 bg-brand-primary rounded-full shrink-0"></div>
                                                        )}
                                                    </div>
                                                    <p className="text-sm sm:text-base text-text-body mt-1">{notification.message}</p>
                                                    <span className="text-xs sm:text-sm text-text-muted mt-2 inline-block">
                                                        {formatDistanceToNow(new Date(notification.createdAt), {
                                                            addSuffix: true,
                                                            locale: enUS,
                                                        })}
                                                    </span>
                                                </div>
                                                <div className="flex gap-1 sm:gap-2 shrink-0">
                                                    {!notification.isRead && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleMarkAsRead(notification.id);
                                                            }}
                                                            className="inline-flex min-w-11 md:min-w-0 items-center justify-center p-1.5 sm:p-2 hover:bg-surface-page rounded-[--radius-button] text-text-muted hover:text-brand-primary transition-colors touch-manipulation"
                                                            title="Mark as read"
                                                        >
                                                            <Check size={18} />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDelete(notification.id);
                                                        }}
                                                        className="inline-flex min-w-11 md:min-w-0 items-center justify-center p-1.5 sm:p-2 hover:bg-surface-page rounded-[--radius-button] text-text-muted hover:text-status-error transition-colors touch-manipulation"
                                                        title="Erase"
                                                    >
                                                        <Trash2 size={18} />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
