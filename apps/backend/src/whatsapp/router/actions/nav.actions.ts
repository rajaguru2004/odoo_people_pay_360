import { Role } from '../../../mcp/tool.types';
import { WhatsAppActionDef } from '../action.types';
import { buildGroupMenu } from '../../render/menu-renderer';
import { menuGroup } from '../menu-groups';
import { outbound } from '../../render/wa-format';

const ALL: Role[] = ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'];

/**
 * Navigation.
 *
 * These call no tool: they move around the menu the caller can already see.
 * That is what `localRender` is for, and why boot invariant 10 forbids them a
 * tool, a flow or a confirmation — navigating is not acting, and a navigation
 * step that could write would be a very surprising thing to tap.
 *
 * Hidden, because they are reachable only by tapping a row the renderer put
 * there; a section is not something anyone would type.
 */
export function navActions(): WhatsAppActionDef[] {
  return [
    {
      key: 'menu.section',
      menuLabel: 'Menu section',
      roles: ALL,
      requiresEmployee: false,
      sensitivity: 'normal',
      keywords: [],
      hidden: true,
      confirmPolicy: 'none',
      localRender: (ctx) => {
        const group = menuGroup(ctx.params.g);
        if (!group) {
          return outbound('That section is no longer available. Reply MENU for the full list.');
        }

        // Filtered from the caller's own visible catalogue, never from the
        // registry directly — a section must not become a way around the role
        // checks, the denylist or the mutations kill switch.
        const built = buildGroupMenu(
          group,
          ctx.visibleActions.filter((a) => a.menuGroup === group.key),
        );
        return { plain: built.plain, menu: built.menu, list: built.list };
      },
      render: () => outbound(''),
    },
  ];
}
