import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Login - Ess Portal",
    description: "Log in to the Employee Self-Service Portal",
};

import PageTransition from "@/components/common/PageTransition";

export default function AuthLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return <PageTransition>{children}</PageTransition>;
}
