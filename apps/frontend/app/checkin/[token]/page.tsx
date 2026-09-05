import { redirect } from 'next/navigation';

/**
 * The Discord-only check-in page, superseded by /verify/[token].
 *
 * Kept as a redirect rather than deleted: a `/attendance-checkin` issued in the
 * minutes before this deploy put THIS url in somebody's chat, and the token
 * behind it is still live. Both paths lead to the same page, which asks the
 * server what it needs to collect.
 *
 * @deprecated Remove once no pre-deploy link can still be pending (10 minutes).
 */
export default async function LegacyCheckinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  redirect(`/verify/${token}`);
}
