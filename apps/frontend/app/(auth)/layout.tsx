import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign in — People Pay 360',
  description: 'Sign in to the People Pay 360 HR and payroll platform',
};

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
