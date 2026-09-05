'use client';

import DashboardLayout from '@/components/dashboard/DashboardLayout';
import { ToastContainer } from '@/lib/toast';

export default function DashboardV2RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <DashboardLayout disableMainScroll>
      {children}
      <ToastContainer />
    </DashboardLayout>
  );
}
