'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Bell, Check, CheckCheck, Trash2, X } from 'lucide-react';
import notificationService from '@/services/notificationService';
import { Notification } from '@/types/notification';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useAuthStore } from '@/store/authStore';

export default function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const { isAuthenticated } = useAuthStore();

    useEffect(() => {
        if (!isAuthenticated) return;
        fetchUnreadCount();
        const interval = setInterval(fetchUnreadCount, 30000); // Poll every 30s
        return () => clearInterval(interval);
    }, [isAuthenticated]);

    useEffect(() => {
        if (isOpen) {
            fetchNotifications();
        }
    }, [isOpen]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchUnreadCount = async () => {
        if (!isAuthenticated) return;
        try {
            // Axios interceptor unwraps response.data, so result shape is: { success, data: { count } }
            const response: any = await notificationService.getUnreadCount();
            const count = response?.data?.count ?? response?.count;
            setUnreadCount(typeof count === 'number' ? count : 0);
        } catch {
            // Silently ignore – unauthenticated or network errors
            setUnreadCount(0);
        }
    };

    const fetchNotifications = async () => {
        if (!isAuthenticated) return;
        try {
            setLoading(true);
            const response = await notificationService.getAll();
            // Axios interceptor unwraps response.data: shape is { success, data: Notification[] }
            const list = response?.data ?? response;
            if (Array.isArray(list)) {
                setNotifications(list);
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

    const handleMarkAsRead = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await notificationService.markAsRead(id);
            setNotifications((prev) =>
                prev.map((n) => (n.id === id ? { ...n, isRead: true } : n))
            );
            setUnreadCount((prev) => Math.max(0, prev - 1));
        } catch (error) {
            console.error('Failed to mark as read:', error);
        }
    };

    const handleMarkAllAsRead = async () => {
        try {
            await notificationService.markAllAsRead();
            setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
            setUnreadCount(0);
        } catch (error) {
            console.error('Failed to mark all as read:', error);
        }
    };

    const handleDelete = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await notificationService.delete(id);
            setNotifications((prev) => prev.filter((n) => n.id !== id));
            fetchUnreadCount();
        } catch (error) {
            console.error('Failed to delete notification:', error);
        }
    };

    const handleNotificationClick = async (notification: Notification) => {
        if (!notification.isRead) {
            await handleMarkAsRead(notification.id, {} as React.MouseEvent);
        }
        if (notification.link) {
            router.push(notification.link);
            setIsOpen(false);
        }
    };

    const getNotificationIcon = (type: string) => {
        const iconClass = 'w-10 h-10 rounded-full flex items-center justify-center';
        switch (type) {
            case 'SUCCESS':
            case 'LEAVE_APPROVED':
            case 'OVERTIME_APPROVED':
            case 'REWARD_RECEIVED':
                return <div className={`${iconClass} bg-green-100 text-green-600`}>✓</div>;
            case 'ERROR':
            case 'LEAVE_REJECTED':
            case 'OVERTIME_REJECTED':
            case 'DISCIPLINE_ISSUED':
                return <div className={`${iconClass} bg-red-100 text-red-600`}>✕</div>;
            case 'WARNING':
            case 'CONTRACT_EXPIRING':
            case 'VISA_EXPIRING':
                return <div className={`${iconClass} bg-yellow-100 text-yellow-600`}>⚠</div>;
            case 'VISA_EXPIRED':
                return <div className={`${iconClass} bg-red-100 text-red-600`}>✕</div>;
            case 'VISA_RENEWED':
                return <div className={`${iconClass} bg-green-100 text-green-600`}>✓</div>;
            case 'PAYROLL_GENERATED':
                return <div className={`${iconClass} bg-brand-primary-light/20 text-brand-primary`}>💰</div>;
            default:
                return <div className={`${iconClass} bg-gray-100 text-gray-600`}>ℹ</div>;
        }
    };

    return (
        <div className="relative" ref={dropdownRef}>
            {/* Bell Icon */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="relative p-2 hover:bg-slate-100 rounded-lg transition-colors"
            >
                <Bell size={20} className="text-slate-600" />
                {unreadCount > 0 && (
                    <span className="absolute top-0 right-0 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-bold">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {/* Dropdown */}
            {isOpen && (
                <div className="fixed sm:absolute left-4 right-4 sm:left-auto sm:right-0 top-16 sm:top-auto mt-0 sm:mt-2 w-auto sm:w-96 bg-white rounded-xl shadow-2xl border border-slate-200 z-50 max-h-[70vh] sm:max-h-150 flex flex-col">
                    {/* Header */}
                    <div className="p-4 border-b border-slate-200 flex items-center justify-between">
                        <div>
                            <h3 className="font-bold text-lg text-slate-800">Notifications</h3>
                            <p className="text-sm text-slate-500">{unreadCount} haven't read yet</p>
                        </div>
                        {unreadCount > 0 && (
                            <button
                                onClick={handleMarkAllAsRead}
                                className="text-sm text-brand-primary hover:text-brand-primary font-medium flex items-center gap-1"
                            >
                                <CheckCheck size={16} />
                                Mark all as read
                            </button>
                        )}
                    </div>

                    {/* Notifications List */}
                    <div className="overflow-y-auto flex-1">
                        {loading ? (
                            <div className="p-8 text-center">
                                <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
                                <p className="text-sm text-slate-500 mt-2">Loading...</p>
                            </div>
                        ) : !notifications || notifications.length === 0 ? (
                            <div className="p-8 text-center">
                                <Bell size={48} className="text-slate-300 mx-auto mb-3" />
                                <p className="text-slate-400 font-medium">No notifications</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-slate-100">
                                {notifications.map((notification) => (
                                    <div
                                        key={notification.id}
                                        onClick={() => handleNotificationClick(notification)}
                                        className={`p-4 hover:bg-slate-50 transition-colors cursor-pointer ${!notification.isRead ? 'bg-brand-primary-light/10' : ''
                                            }`}
                                    >
                                        <div className="flex gap-3">
                                            {getNotificationIcon(notification.type)}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-start justify-between gap-2">
                                                    <h4
                                                        className={`text-sm font-semibold ${!notification.isRead ? 'text-slate-900' : 'text-slate-700'
                                                            }`}
                                                    >
                                                        {notification.title}
                                                    </h4>
                                                    {!notification.isRead && (
                                                        <div className="w-2 h-2 bg-brand-primary rounded-full shrink-0 mt-1"></div>
                                                    )}
                                                </div>
                                                <p className="text-sm text-slate-600 mt-1 line-clamp-2">
                                                    {notification.message}
                                                </p>
                                                <div className="flex items-center justify-between mt-2">
                                                    <span className="text-xs text-slate-400">
                                                        {formatDistanceToNow(new Date(notification.createdAt), {
                                                            addSuffix: true,
                                                            locale: enUS,
                                                        })}
                                                    </span>
                                                    <div className="flex gap-1">
                                                        {!notification.isRead && (
                                                            <button
                                                                onClick={(e) => handleMarkAsRead(notification.id, e)}
                                                                className="p-1 hover:bg-slate-200 rounded text-slate-500 hover:text-brand-primary"
                                                                title="Mark as read"
                                                            >
                                                                <Check size={14} />
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={(e) => handleDelete(notification.id, e)}
                                                            className="p-1 hover:bg-slate-200 rounded text-slate-500 hover:text-red-600"
                                                            title="Delete"
                                                        >
                                                            <Trash2 size={14} />
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

                    {/* Footer */}
                    {notifications.length > 0 && (
                        <div className="p-3 border-t border-slate-200 text-center">
                            <button
                                onClick={() => {
                                    router.push('/dashboard/notifications');
                                    setIsOpen(false);
                                }}
                                className="text-sm text-brand-primary hover:text-brand-primary font-medium"
                            >
                                See all announcements
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
