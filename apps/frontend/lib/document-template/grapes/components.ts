/**
 * ESS component types for GrapesJS.
 *
 * The one that matters is `ess-variable`: its `isComponent` hook fires on
 * EVERY re-parse — paste, RTE-disable sync, project reload — which is what
 * makes a chip become a chip again after copy/paste and undo, rather than
 * degrading into an editable span whose braces would then be neutralised by
 * the server.
 *
 * Kept GrapesJS-facing and thin: everything pure (chip HTML, block defs,
 * validation) lives in the sibling modules so it stays node-testable.
 */

// GrapesJS's editor type is huge and its exact shape is not what we test;
// touchpoints are typed narrowly to what we actually call.
// Structurally loose on purpose: GrapesJS's own signatures return rich model
// objects we never use, and pinning them here would couple this module to the
// library's type surface across upgrades.
export interface GrapesEditorLike {
  DomComponents: {
    addType(name: string, def: unknown): unknown;
  };
  BlockManager: {
    add(id: string, def: unknown): unknown;
  };
}

export function registerEssComponents(editor: GrapesEditorLike): void {
  editor.DomComponents.addType('ess-variable', {
    // The survival hook: any span carrying data-var IS a chip, whatever
    // produced it. Without this, a pasted chip is a plain span and dies.
    isComponent: (el: HTMLElement) =>
      el?.dataset?.var !== undefined ? { type: 'ess-variable' } : undefined,
    model: {
      defaults: {
        tagName: 'span',
        // contenteditable=false on the ELEMENT (kept by the exporter) is what
        // makes the chip caret-atomic inside an editable host: arrow keys skip
        // it, one Backspace removes it whole.
        draggable: true,
        droppable: false,
        editable: false,
        layerable: false,
        selectable: true,
        attributes: { contenteditable: 'false', class: 'ess-var-chip' },
      },
    },
  });

  editor.DomComponents.addType('ess-page-break', {
    isComponent: (el: HTMLElement) =>
      el?.dataset?.pageBreak !== undefined ? { type: 'ess-page-break' } : undefined,
    model: {
      defaults: {
        tagName: 'div',
        droppable: false,
        editable: false,
        attributes: { 'data-page-break': 'true' },
      },
    },
  });
}

import type { EssBlockDef } from './blocks';

export function registerEssBlocks(editor: GrapesEditorLike, defs: EssBlockDef[]): void {
  for (const def of defs) {
    editor.BlockManager.add(def.id, {
      label: def.label,
      category: def.category,
      content: def.content,
      // Click-to-add is the deterministic path (and the Playwright path);
      // dragging still works but is never required.
      activate: true,
      select: true,
    });
  }
}
