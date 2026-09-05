import { redirect } from 'next/navigation';

/**
 * The root is not a page of its own.
 *
 * Redirecting rather than rendering the login screen here keeps ONE canonical
 * URL for signing in — otherwise `/` and `/login` are two routes showing the
 * same form, and the post-401 redirect check in lib/axios.ts (which looks for
 * `/login` in the path) would loop on `/`.
 */
export default function RootPage() {
  redirect('/login');
}
