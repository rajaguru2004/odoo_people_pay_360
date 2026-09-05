import { create } from 'zustand';
import { CheckCircle, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
    id: string;
    type: ToastType;
    message: string;
    duration?: number;
}

interface ToastStore {
    toasts: Toast[];
    addToast: (toast: Omit<Toast, 'id'>) => void;
    removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
    toasts: [],
    addToast: (toast) => {
        const id = Math.random().toString(36).substring(7);
        const newToast = { ...toast, id };

        set((state) => ({
            toasts: [...state.toasts, newToast],
        }));

        // Auto remove after duration
        setTimeout(() => {
            set((state) => ({
                toasts: state.toasts.filter((t) => t.id !== id),
            }));
        }, toast.duration || 4000);
    },
    removeToast: (id) =>
        set((state) => ({
            toasts: state.toasts.filter((t) => t.id !== id),
        })),
}));

// Helper function
export const toast = {
    success: (message: string, duration?: number) =>
        useToastStore.getState().addToast({ type: 'success', message, duration }),
    error: (message: string, duration?: number) =>
        useToastStore.getState().addToast({ type: 'error', message, duration }),
    info: (message: string, duration?: number) =>
        useToastStore.getState().addToast({ type: 'info', message, duration }),
    warning: (message: string, duration?: number) =>
        useToastStore.getState().addToast({ type: 'warning', message, duration }),
};

// Toast Container Component
export function ToastContainer() {
    const { toasts, removeToast } = useToastStore();

    return (
        // `end-*` rather than `right-*` so the stack moves to the left edge
        // under dir="rtl", and a safe-area top inset so a notched phone does
        // not put the first toast under the status bar / dynamic island.
        <div className="fixed top-[calc(env(safe-area-inset-top)+1rem)] end-4 md:top-6 md:end-6 z-[100] flex flex-col gap-3 pointer-events-none">
            {toasts.map((toast) => (
                <div
                    key={toast.id}
                    // The suite has to be able to assert WHICH kind of toast the
                    // user saw. The visible text is next-intl (en + ar), and the
                    // colour is a Tailwind class, so the type is exposed as data.
                    data-testid="toast"
                    data-toast-type={toast.type}
                    // `min-w-[320px]` plus the container's 24px inset demanded
                    // 344px+ of a 390px screen and was one of the few things
                    // left that could force the page into horizontal scroll.
                    className={`pointer-events-auto px-4 py-3 md:px-6 md:py-4 rounded-xl shadow-2xl flex items-center gap-3 w-[min(24rem,calc(100vw-2rem))] md:w-auto md:min-w-[320px] md:max-w-md animate-in slide-in-from-right duration-300 ${toast.type === 'success'
                            ? 'bg-green-600 text-white'
                            : toast.type === 'error'
                                ? 'bg-red-600 text-white'
                                : toast.type === 'warning'
                                    ? 'bg-yellow-600 text-white'
                                    : 'bg-blue-600 text-white'
                        }`}
                >
                    {toast.type === 'success' && <CheckCircle size={20} className="flex-shrink-0" />}
                    {toast.type === 'error' && <AlertTriangle size={20} className="flex-shrink-0" />}
                    {toast.type === 'info' && <Info size={20} className="flex-shrink-0" />}
                    {toast.type === 'warning' && <AlertTriangle size={20} className="flex-shrink-0" />}

                    <span className="font-medium flex-1">{toast.message}</span>

                    <button
                        data-testid="toast-dismiss"
                        onClick={() => removeToast(toast.id)}
                        className="ml-2 hover:opacity-80 transition-opacity flex-shrink-0"
                    >
                        <X size={18} />
                    </button>
                </div>
            ))}
        </div>
    );
}
