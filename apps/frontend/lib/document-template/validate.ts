import {
  DocumentTemplateDoc,
  TokenManifest,
  ValidationIssue,
} from '@/types/document-template';
import { collectConditionPaths } from './blocks';

/**
 * Validation for the builder.
 *
 * The split between error and warning is the whole design: an ERROR blocks
 * publishing because the document would be wrong, a WARNING never does because
 * it merely might be. Blocking on warnings trains people to ignore them, and
 * then the errors get ignored too.
 */

/**
 * Paths a table may repeat over.
 *
 * Deliberately NOT the full token set: `earnings` is a list and
 * `employeeName` is a string, and binding a table to a string produces a
 * template that publishes cleanly and then renders nothing. Checking `bind`
 * against every known path let exactly that through.
 */
export function collectionPaths(manifest: TokenManifest): Set<string> {
  const paths = new Set(manifest.collections.map((c) => c.path));
  for (const group of manifest.groups) {
    for (const token of group.tokens) {
      if (token.type === 'table') paths.add(token.path);
    }
  }
  return paths;
}

/** Every token path the manifest declares, including `collection.column`. */
export function manifestPaths(manifest: TokenManifest): Set<string> {
  const paths = new Set<string>();
  for (const group of manifest.groups) {
    for (const token of group.tokens) {
      paths.add(token.path);
      for (const col of token.columns ?? []) paths.add(`${token.path}.${col.name}`);
    }
  }
  for (const collection of manifest.collections) {
    paths.add(collection.path);
    for (const f of collection.fields) paths.add(`${collection.path}.${f.name}`);
  }
  return paths;
}

/**
 * Is this path known?
 *
 * `custom.*` is accepted wholesale: the custom-field set is per-branch
 * configuration that changes without a deploy, so the manifest declares the
 * namespace rather than every member, and validating members here would
 * reject fields that exist.
 */
function isKnown(path: string, known: Set<string>): boolean {
  if (known.has(path)) return true;
  if (path.startsWith('custom.')) return true;
  // `signatory.hr.name` is declared exactly; anything under a declared prefix
  // that itself resolves is fine.
  return [...known].some((k) => path.startsWith(`${k}.`));
}

/** Levenshtein, for "did you mean". Small inputs, so the simple version is fine. */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

export function didYouMean(path: string, known: Set<string>): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of known) {
    const d = distance(path.toLowerCase(), candidate.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  // A suggestion that is barely closer than random is worse than none — it
  // sends the user off to check something irrelevant.
  return best && bestScore <= Math.max(3, Math.floor(path.length / 3)) ? best : null;
}

export function validateDoc(
  doc: DocumentTemplateDoc,
  manifest: TokenManifest | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = manifest ? manifestPaths(manifest) : null;
  const collections = manifest ? collectionPaths(manifest) : null;
  const optional = new Set(
    (manifest?.groups ?? [])
      .flatMap((g) => g.tokens)
      .filter((t) => !t.alwaysPresent)
      .map((t) => t.path),
  );

  if (!doc.body?.length) {
    issues.push({
      level: 'error',
      code: 'EMPTY_BLOCK',
      blockId: null,
      message: 'This template has no content yet. Add at least one block before publishing.',
    });
  }

  const scanText = (blockId: string, text: unknown) => {
    if (typeof text !== 'string') return;

    // A half-typed field, e.g. `{{positio` with no closing braces. Caught
    // BEFORE the manifest check because it is not a token at all — and caught
    // even when the manifest has not loaded, because this is the input that
    // used to be autosaved and then break every render of the template.
    const malformed = text.match(/\{\{(?![^}]*\}\})[^{}]*/g);
    if (malformed?.length) {
      for (const frag of malformed) {
        issues.push({
          level: 'error',
          code: 'MALFORMED_TOKEN',
          blockId,
          message: `"${frag.trim()}" is not finished — a field needs closing braces, like {{employeeName}}.`,
        });
      }
    }

    if (!known) return;
    for (const m of text.matchAll(/\{\{\s*([^}\s#/]+)\s*\}\}/g)) {
      const path = m[1];
      if (isKnown(path, known)) {
        if (optional.has(path)) {
          issues.push({
            level: 'warning',
            code: 'OPTIONAL_NO_FALLBACK',
            blockId,
            message: `"${path}" is not filled in for every employee. It will print blank where there is no value.`,
          });
        }
        continue;
      }
      const suggestion = didYouMean(path, known);
      issues.push({
        level: 'error',
        code: 'UNKNOWN_TOKEN',
        blockId,
        message: `"${path}" is not a field this document can fill in.`,
        detail: suggestion ? `Did you mean "${suggestion}"?` : undefined,
      });
    }
  };

  for (const block of doc.body ?? []) {
    const props = block.props as Record<string, unknown>;
    scanText(block.id, props.html);

    if (block.type === 'text' || block.type === 'heading') {
      const stripped = String(props.html ?? '').replace(/<[^>]*>/g, '').trim();
      if (!stripped) {
        issues.push({
          level: 'warning',
          code: 'EMPTY_BLOCK',
          blockId: block.id,
          message: 'This block is empty and will print as blank space.',
        });
      }
    }

    if (block.type === 'keyValue') {
      for (const row of block.props.rows ?? []) {
        scanText(block.id, row.label);
        scanText(block.id, row.value);
      }
    }

    if (block.type === 'dataTable') {
      if (!block.props.bind) {
        issues.push({
          level: 'error',
          code: 'UNBOUND_COLLECTION',
          blockId: block.id,
          message: 'This table is not connected to any data yet.',
        });
      } else if (collections && !collections.has(block.props.bind)) {
        issues.push({
          level: 'error',
          code: 'UNBOUND_COLLECTION',
          blockId: block.id,
          message: `"${block.props.bind}" is not a list this document can repeat over.`,
        });
      }
      if (!block.props.columns?.length) {
        issues.push({
          level: 'error',
          code: 'NO_COLUMNS',
          blockId: block.id,
          message: 'This table has no columns yet.',
        });
      }
    }

    if (block.visibleWhen && known) {
      for (const path of collectConditionPaths(block.visibleWhen)) {
        if (!isKnown(path, known)) {
          issues.push({
            level: 'error',
            code: 'UNKNOWN_CONDITION_PATH',
            blockId: block.id,
            message: `The rule for showing this block refers to "${path}", which this document does not have.`,
          });
        }
      }
    }
  }

  scanText('footer', doc.footer?.html);
  return issues;
}

/** Publishing is blocked by errors and never by warnings. */
export function canPublish(issues: ValidationIssue[]): boolean {
  return !issues.some((i) => i.level === 'error');
}
