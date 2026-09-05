import api from '../lib/axios';
import { Notification, NotificationResponse, UnreadCountResponse } from '../types/notification';

const notificationService = {
    // Get all notifications
    getAll: async (unreadOnly: boolean = false) => {
        const response = await api.get<NotificationResponse>('/notifications', {
            params: { unreadOnly },
        });
        return response;
    },

    // Get unread count
    getUnreadCount: async () => {
        const response = await api.get<UnreadCountResponse>('/notifications/unread-count');
        return response;
    },

    // Mark as read
    markAsRead: async (id: string) => {
        const response = await api.post(`/notifications/${id}/read`);
        return response;
    },

    // Mark all as read
    markAllAsRead: async () => {
        const response = await api.post('/notifications/read-all');
        return response;
    },

    // Delete notification
    delete: async (id: string) => {
        const response = await api.delete(`/notifications/${id}`);
        return response;
    },

    // Delete all notifications
    deleteAll: async () => {
        const response = await api.delete('/notifications');
        return response;
    },
};

export default notificationService;
