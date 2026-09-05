/**
 * The one normalisation, shared by the router and the registry.
 *
 * Exported because ActionRegistryService turns menu labels into keywords, and
 * "routable" has to mean the same thing in both places — if the two rules ever
 * drifted, a label would look routable at boot and not be routable in a chat.
 */
export function normaliseText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufe0f\u2060]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\s]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[?.!]+$/, '');
}
