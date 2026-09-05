import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ToolRegistryService } from '../../mcp/tool-registry.service';
import { Role } from '../../mcp/tool.types';
import { WhatsAppActionDef } from './action.types';
import { essActions } from './actions/ess.actions';
import { approvalActions } from './actions/approval.actions';
import { navActions } from './actions/nav.actions';
import { groupOrder, menuGroup } from './menu-groups';
import { isDeniedTool } from './whatsapp-tool-denylist';
import { normaliseText } from './normalise-text';
import { DECISION_ACTIONS } from '../approvals/decision-actions';

/**
 * The WhatsApp action catalogue, validated at boot.
 *
 * These checks are the security backbone of the channel: they are what makes
 * "WhatsApp can only do a fixed, reviewed set of things" a property of the
 * process rather than a claim in a document. A violation is a startup crash,
 * not a warning, because a half-registered router would silently expose or
 * silently drop actions.
 */
@Injectable()
export class ActionRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ActionRegistryService.name);

  private actions: WhatsAppActionDef[] = [];
  private byKey = new Map<string, WhatsAppActionDef>();
  private byKeyword = new Map<string, WhatsAppActionDef>();

  constructor(private readonly tools: ToolRegistryService) {}

  onModuleInit(): void {
    const defs = [...essActions(), ...approvalActions(), ...navActions()];

    for (const def of defs) {
      // 1. Unique keys — a duplicate silently shadows an action.
      if (this.byKey.has(def.key)) {
        throw new Error(`WhatsApp action '${def.key}' is registered twice.`);
      }

      // 2. Unique keywords — otherwise which action a word runs depends on
      //    registration order, which nobody reviewing a diff would notice.
      for (const kw of def.keywords) {
        const norm = kw.trim().toLowerCase();
        const clash = this.byKeyword.get(norm);
        if (clash) {
          throw new Error(
            `WhatsApp keyword '${norm}' is claimed by both '${clash.key}' and '${def.key}'.`,
          );
        }
        this.byKeyword.set(norm, def);
      }

      // 10. A local renderer navigates; it does not act.
      //
      //     Checked BEFORE the tool rules below so the failure names the real
      //     problem: without this ordering, a local renderer that asks for
      //     confirmation reports "has no tool but requests confirmation",
      //     which sends the reader looking for a missing tool.
      if (def.localRender) {
        if (def.tool) {
          throw new Error(
            `WhatsApp action '${def.key}' has both a tool and a local renderer.`,
          );
        }
        if (def.flow) {
          throw new Error(
            `WhatsApp action '${def.key}' cannot collect input through a flow and render locally.`,
          );
        }
        if (def.confirmPolicy !== 'none') {
          throw new Error(
            `WhatsApp action '${def.key}' renders locally and cannot request confirmation.`,
          );
        }
      } else if (!def.tool && !def.needsActionToken) {
        // The silent no-op guard: execute() returns immediately for an action
        // with no tool, so one without a local renderer replies with nothing
        // at all and looks, from every log, like it worked.
        throw new Error(
          `WhatsApp action '${def.key}' has neither a tool nor a local renderer, so it can never reply.`,
        );
      }

      // 11. Every visible action lands in a declared section. A typo'd group
      //     would otherwise sort last and read as an unexplained "Other".
      if (!def.hidden && !menuGroup(def.menuGroup)) {
        throw new Error(
          `WhatsApp action '${def.key}' has unknown menuGroup '${def.menuGroup ?? ''}'.`,
        );
      }

      if (def.tool) {
        const toolDef = this.tools.getByName(def.tool.name);

        // 3. The tool must exist. A renamed tool would otherwise fail at the
        //    moment a user tries the action, in production.
        if (!toolDef) {
          throw new Error(
            `WhatsApp action '${def.key}' maps to unknown tool '${def.tool.name}'.`,
          );
        }

        // 4. The action cannot be reachable by a role the tool itself refuses.
        const extra = def.roles.filter((r) => !toolDef.roles.includes(r as Role));
        if (extra.length) {
          throw new Error(
            `WhatsApp action '${def.key}' allows roles [${extra.join(', ')}] that tool ` +
              `'${def.tool.name}' does not.`,
          );
        }

        // 5. Destructive tools are structurally unreachable over WhatsApp.
        if (toolDef.kind === 'destructive') {
          throw new Error(
            `WhatsApp action '${def.key}' maps to destructive tool '${def.tool.name}'. ` +
              'Destructive operations are web-only.',
          );
        }

        // 6. Explicit denylist, as a second lock over allowlist-by-construction.
        if (isDeniedTool(def.tool.name)) {
          throw new Error(
            `WhatsApp action '${def.key}' maps to '${def.tool.name}', which is on the ` +
              'WhatsApp denylist.',
          );
        }

        // 7. A read cannot be gated, and a write cannot be ungated.
        if (def.confirmPolicy === 'none' && toolDef.kind !== 'read') {
          throw new Error(
            `WhatsApp action '${def.key}' skips confirmation but '${def.tool.name}' is a write.`,
          );
        }

        // 8. THE auto-confirm invariant.
        //
        //    Confirming on the first call is only defensible when the call
        //    carries no user-supplied argument at all: the preview would render
        //    an empty object, and a confirmation with no information in it
        //    trains people to tap YES reflexively — which weakens every real
        //    confirmation elsewhere. "CHECK IN" is the act, not a request for
        //    a plan.
        //
        //    What matters is the CALL, not the tool's signature. A tool may
        //    accept optional coordinates; the invariant is that this action can
        //    never populate them. So three things must hold:
        //      - no flow (a flow exists precisely to collect arguments),
        //      - no static args,
        //      - every remaining tool parameter is optional, so `{confirm:true}`
        //        alone is a valid call.
        //
        //    Enforced mechanically: a future author cannot widen this by
        //    editing one line, they would have to defeat this check.
        if (def.confirmPolicy === 'implicit') {
          if (toolDef.kind !== 'write') {
            throw new Error(
              `WhatsApp action '${def.key}' auto-confirms but '${def.tool.name}' is not a plain write.`,
            );
          }
          if (def.flow) {
            throw new Error(
              `WhatsApp action '${def.key}' auto-confirms but collects input through a flow.`,
            );
          }
          if (Object.keys(def.tool.staticArgs ?? {}).length > 0) {
            throw new Error(
              `WhatsApp action '${def.key}' auto-confirms but passes static arguments.`,
            );
          }
          // 13. Same reasoning as static args: a preview that renders "{}" is
          //     what makes auto-confirm defensible, and a dynamic argument is
          //     still an argument the preview would have had to show.
          if (def.tool.dynamicArgs) {
            throw new Error(
              `WhatsApp action '${def.key}' auto-confirms but derives arguments.`,
            );
          }
          // 8b. Narrow second exception: arguments that can only arrive as a
          //     WhatsApp attachment. Sharing a location is itself a deliberate,
          //     separately-confirmed act, so a preview adds nothing.
          if (def.implicitFromAttachment) {
            if (!def.hidden) {
              throw new Error(
                `WhatsApp action '${def.key}' is attachment-driven and must be hidden from menus.`,
              );
            }
            this.actions.push(def);
            this.byKey.set(def.key, def);
            continue;
          }

          const required = Object.entries(toolDef.inputSchema)
            .filter(([k]) => k !== toolDef.selfScope?.param && k !== 'confirm')
            .filter(([, schema]) => !isOptionalSchema(schema))
            .map(([k]) => k);
          if (required.length > 0) {
            throw new Error(
              `WhatsApp action '${def.key}' auto-confirms, but '${def.tool.name}' requires ` +
                `[${required.join(', ')}]. Auto-confirm is allowed only when the call carries ` +
                'no user-supplied argument.',
            );
          }
        }

        // 9. Sensitive actions always show what they are about to do.
        if (def.sensitivity === 'sensitive' && def.confirmPolicy === 'implicit') {
          throw new Error(`WhatsApp action '${def.key}' is sensitive and cannot auto-confirm.`);
        }
      } else if (def.confirmPolicy !== 'none' && !def.needsActionToken) {
        throw new Error(
          `WhatsApp action '${def.key}' has no tool but requests confirmation.`,
        );
      }

      this.actions.push(def);
      this.byKey.set(def.key, def);
    }

    // 12. Every decidable request type names actions that actually exist and
    //     are actually token-gated. Without this, adding a row to
    //     DECISION_ACTIONS would mint capabilities pointing at nothing, and the
    //     first person to find out would be an approver tapping a dead button.
    for (const [requestType, pair] of Object.entries(DECISION_ACTIONS)) {
      for (const { actionKey: key, toolName } of [pair.approve, pair.reject]) {
        const def = this.byKey.get(key);
        if (!def) {
          throw new Error(
            `DECISION_ACTIONS['${requestType}'] names unregistered action '${key}'.`,
          );
        }
        if (!def.needsActionToken) {
          throw new Error(
            `Decision action '${key}' must require a server-side token: the request id ` +
              'must never come from the wire.',
          );
        }
        if (!def.hidden) {
          throw new Error(
            `Decision action '${key}' must be hidden — it is reachable only from a token.`,
          );
        }
        if (def.tool?.name !== toolName) {
          throw new Error(
            `DECISION_ACTIONS['${requestType}'] says '${key}' runs '${toolName}', but the ` +
              `action runs '${def.tool?.name ?? 'nothing'}'.`,
          );
        }
      }
    }

    // 14. Every visible menu LABEL is routable as typed text.
    //
    //     Registered automatically rather than asked of each author, because
    //     the failure is invisible in review and obvious in use: somebody
    //     reads "My company items" in the menu, types it, and is told "I did
    //     not understand that". Eight of twenty-four labels were unroutable
    //     before this existed.
    //
    //     Normalised with the ROUTER's own function, so "routable" means the
    //     same thing here as it does when the message actually arrives. An
    //     explicit keyword always wins; a genuine collision between two
    //     different actions is a crash, not a silent shadowing.
    for (const def of this.actions) {
      if (def.hidden) continue;
      const norm = normaliseText(def.menuLabel);
      if (!norm) continue;

      const owner = this.byKeyword.get(norm);
      if (!owner) {
        this.byKeyword.set(norm, def);
      } else if (owner.key !== def.key) {
        throw new Error(
          `WhatsApp menu label '${def.menuLabel}' (${def.key}) collides with keyword ` +
            `claimed by '${owner.key}'.`,
        );
      }
    }

    this.logger.log(
      `WhatsApp router: ${this.actions.length} actions registered (${this.byKeyword.size} keywords).`,
    );
  }

  getAll(): WhatsAppActionDef[] {
    return this.actions;
  }

  getByKey(key: string): WhatsAppActionDef | undefined {
    return this.byKey.get(key);
  }

  getByKeyword(word: string): WhatsAppActionDef | undefined {
    return this.byKeyword.get(word.trim().toLowerCase());
  }

  /** Anchored patterns, in registration order. */
  matchPattern(text: string): WhatsAppActionDef | undefined {
    for (const def of this.actions) {
      for (const re of def.patterns ?? []) {
        if (re.test(text)) return def;
      }
    }
    return undefined;
  }

  /**
   * Actions a caller may see. Role and employee-link are pre-filters for the
   * menu only — the tool executor re-checks both.
   */
  visibleFor(role: string, hasEmployee: boolean, disabled: Set<string>): WhatsAppActionDef[] {
    return this.actions
      .filter((a) => !a.hidden)
      .filter((a) => !disabled.has(a.key))
      .filter((a) => a.roles.includes(role as Role))
      .filter((a) => !a.requiresEmployee || hasEmployee)
      .sort(
        (a, b) =>
          groupOrder(a.menuGroup) - groupOrder(b.menuGroup) ||
          (a.menuOrder ?? 99) - (b.menuOrder ?? 99) ||
          a.key.localeCompare(b.key),
      );
  }
}

/**
 * Whether a zod schema accepts `undefined`.
 *
 * Probed by parsing rather than by inspecting internals, so it stays correct
 * across zod versions and wrapper types (`.optional()`, `.default()`,
 * `.nullish()`), all of which make an argument omittable at the call site.
 */
function isOptionalSchema(schema: unknown): boolean {
  const s = schema as { safeParse?: (v: unknown) => { success: boolean } };
  if (typeof s?.safeParse !== 'function') return false;
  return s.safeParse(undefined).success;
}
