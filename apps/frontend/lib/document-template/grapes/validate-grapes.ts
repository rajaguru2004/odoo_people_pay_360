import { TokenManifest, ValidationIssue } from '@/types/document-template';
import { collectionPaths, didYouMean, manifestPaths } from '../validate';
import { collectChipPaths, collectEachPaths } from './chips';

/**
 * Validation for a grapes-dialect draft — the v2 twin of `validateDoc`.
 *
 * Same philosophy: ERRORS block publish because the document would be wrong;
 * WARNINGS never block because they merely might be. Shares
 * `manifestPaths`/`collectionPaths`/`didYouMean` with the v1 validator so the
 * two can never disagree about what a known field is.
 */
export function validateGrapesHtml(
  html: string,
  manifest: TokenManifest | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const text = html ?? '';

  if (!text.replace(/<[^>]*>/g, '').trim() && !/data-var|data-each|img/.test(text)) {
    issues.push({
      level: 'error',
      code: 'EMPTY_BLOCK',
      blockId: null,
      message: 'This template has no content yet. Add something before publishing.',
    });
  }

  if (!manifest) return issues;

  const known = manifestPaths(manifest);
  const collections = collectionPaths(manifest);
  const collectionFieldSets = new Map(
    manifest.collections.map((c) => [c.path, new Set(c.fields.map((f) => f.name))]),
  );

  const isKnownAbsolute = (path: string): boolean => {
    if (known.has(path)) return true;
    if (path.startsWith('custom.')) return true;
    return [...known].some((k) => path.startsWith(`${k}.`));
  };

  for (const chip of collectChipPaths(text)) {
    if (chip.inEach) {
      // A relative chip is valid when ANY collection on the page declares the
      // field — the compiler scopes it to its actual ancestor; validation is
      // advisory here and the server rejects genuinely impossible shapes.
      const inSomeCollection = [...collectionFieldSets.values()].some((fields) =>
        fields.has(chip.path),
      );
      if (inSomeCollection || isKnownAbsolute(chip.path)) continue;
    } else if (isKnownAbsolute(chip.path)) {
      continue;
    }
    const suggestion = didYouMean(chip.path, known);
    issues.push({
      level: 'error',
      code: 'UNKNOWN_TOKEN',
      blockId: null,
      message: `"${chip.path}" is not a field this document can fill in.`,
      detail: suggestion ? `Did you mean "${suggestion}"?` : undefined,
    });
  }

  for (const each of collectEachPaths(text)) {
    if (!collections.has(each)) {
      issues.push({
        level: 'error',
        code: 'UNBOUND_COLLECTION',
        blockId: null,
        message: `"${each}" is not a list this document can repeat over.`,
      });
    }
  }

  // Typed braces are HARMLESS (the server prints them as literal text), so
  // this is a warning, not an error: the admin probably wanted a field.
  const strippedTags = text.replace(/<[^>]*>/g, ' ');
  if (/\{\{/.test(strippedTags)) {
    issues.push({
      level: 'warning',
      code: 'MALFORMED_TOKEN',
      blockId: null,
      message:
        'Text like "{{…}}" will print exactly as typed. To insert a field, type @ and pick it from the list.',
    });
  }

  return issues;
}
