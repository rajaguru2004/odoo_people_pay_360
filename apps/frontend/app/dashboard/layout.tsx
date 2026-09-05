'use client';

import DashboardLayout from '@/components/dashboard/DashboardLayout';
import { ToastContainer } from '@/lib/toast';

export default function DashboardRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <DashboardLayout>
      {children}
      <ToastContainer />
    </DashboardLayout>
  );
}
