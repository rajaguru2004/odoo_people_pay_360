'use client';

import { AlertTriangle } from 'lucide-react';
import Sheet from './Sheet';

/**
 * "Are you sure?", app-wide.
 *
 * Rebuilt on `components/common/Sheet.tsx` rather than on its own
 * `fixed inset-0`, which makes it the kit's first consumer and its real
 * integration test: 32 files reach this dialog, so `route-matrix` and the
 * lifecycle specs exercise the sheet mechanics — portal, `<main>` lock, Escape,
 * focus trap — for free.
 *
 * **Two things here are load-bearing and must not be tidied.**
 *
 * 1. The buttons stay **direct children** of the sheet's footer. A spec that
 *    has to READ the message — the thing under test, and so not matchable by
 *    its own text — reaches the panel by walking two ancestors up from
 *    `confirm-modal-confirm` (button → footer → panel), and one more wrapper
 *    breaks that walk.
 * 2. At ≥768px this renders the same box it always did — same width, padding,
 *    borders and colours. The phone gets `h-12` buttons and a bottom sheet;
 *    desktop gets `md:h-auto md:py-2`, which is the class it had. The one
 *    deliberate desktop change is the close button, now a 44px target instead
 *    of a bare 20px glyph.
 */

interface ConfirmModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'danger' | 'warning' | 'info' | 'success';
    loading?: boolean;
}

const TYPE_STYLES = {
    danger: { icon: 'bg-status-error-bg text-status-error', button: 'bg-status-error hover:opacity-90' },
    warning: { icon: 'bg-status-warning-bg text-status-warning', button: 'bg-status-warning hover:opacity-90' },
    info: { icon: 'bg-status-info-bg text-status-info', button: 'bg-status-info hover:opacity-90' },
    success: { icon: 'bg-status-success-bg text-status-success', button: 'bg-status-success hover:opacity-90' },
} as const;

/** Shared by both footer buttons: 48px on a phone, the previous box at ≥768px. */
const FOOTER_BUTTON =
    'inline-flex h-12 touch-manipulation items-center justify-center rounded-lg px-4 ' +
    'transition-colors disabled:opacity-50 md:h-auto md:py-2';

export default function ConfirmModal({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    type = 'warning',
    loading = false,
}: ConfirmModalProps) {
    const style = TYPE_STYLES[type] || TYPE_STYLES.warning;

    return (
        <Sheet
            open={isOpen}
            onClose={onClose}
            title={title}
            icon={
                <div className={`p-2 rounded-lg ${style.icon}`}>
                    <AlertTriangle className="h-6 w-6" />
                </div>
            }
            footer={
                <>
                    <button
                        onClick={onClose}
                        disabled={loading}
                        className={`${FOOTER_BUTTON} border border-surface-border text-text-body hover:bg-surface-page`}
                    >
                        {cancelText}
                    </button>
                    <button
                        data-testid="confirm-modal-confirm"
                        onClick={onConfirm}
                        disabled={loading}
                        className={`${FOOTER_BUTTON} text-white ${style.button}`}
                    >
                        {loading ? (
                            <span className="flex items-center gap-2">
                                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                <span>Processing...</span>
                            </span>
                        ) : (
                            confirmText
                        )}
                    </button>
                </>
            }
        >
            <p className="text-text-body">{message}</p>
        </Sheet>
    );
}
