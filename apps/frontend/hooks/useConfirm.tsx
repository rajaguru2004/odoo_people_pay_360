'use client';

import { useState, useCallback } from 'react';
import ConfirmModal from '@/components/common/ConfirmModal';

interface ConfirmOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'danger' | 'warning' | 'info' | 'success';
}

export function useConfirm() {
    const [isOpen, setIsOpen] = useState(false);
    const [options, setOptions] = useState<ConfirmOptions>({
        title: '',
        message: '',
    });
    const [loading, setLoading] = useState(false);
    const [resolvePromise, setResolvePromise] = useState<((value: boolean) => void) | null>(null);

    const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
        setOptions(opts);
        setIsOpen(true);
        setLoading(false);

        return new Promise((resolve) => {
            setResolvePromise(() => resolve);
        });
    }, []);

    const handleConfirm = useCallback(async () => {
        setLoading(true);
        if (resolvePromise) {
            resolvePromise(true);
        }
        // Don't close immediately, let the caller handle it
    }, [resolvePromise]);

    const handleCancel = useCallback(() => {
        if (resolvePromise) {
            resolvePromise(false);
        }
        setIsOpen(false);
        setLoading(false);
    }, [resolvePromise]);

    const closeModal = useCallback(() => {
        setIsOpen(false);
        setLoading(false);
    }, []);

    const ConfirmDialog = useCallback(
        () => (
            <ConfirmModal
                isOpen={isOpen}
                onClose={handleCancel}
                onConfirm={handleConfirm}
                title={options.title}
                message={options.message}
                confirmText={options.confirmText}
                cancelText={options.cancelText}
                type={options.type}
                loading={loading}
            />
        ),
        [isOpen, options, loading, handleCancel, handleConfirm]
    );

    return { confirm, ConfirmDialog, closeModal, setLoading };
}
