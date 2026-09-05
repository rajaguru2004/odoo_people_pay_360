'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useState, useEffect } from 'react';
import { useBrandingStore } from '@/store/brandingStore';
import { useBranchStore } from '@/store/branchStore';

export function ReactQueryProvider({ children }: { children: React.ReactNode }) {
    // Fetch branding configurations on mount
    useEffect(() => {
        useBrandingStore.getState().fetchBranding();
    }, []);

    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: 60 * 1000, // 1 minute
                        gcTime: 5 * 60 * 1000, // 5 minutes (formerly cacheTime)
                        refetchOnWindowFocus: false,
                        refetchOnReconnect: false,
                        retry: 1,
                    },
                },
            })
    );

    // Multi-branch: switching the active branch re-scopes the entire app, so
    // drop all cached server data and refetch under the new branch context.
    useEffect(() => {
        let prev = useBranchStore.getState().selectedBranchId;
        const unsub = useBranchStore.subscribe((state) => {
            if (state.selectedBranchId !== prev) {
                prev = state.selectedBranchId;
                queryClient.invalidateQueries();
            }
        });
        return unsub;
    }, [queryClient]);

    return (
        <QueryClientProvider client={queryClient}>
            {children}
        </QueryClientProvider>
    );
}
