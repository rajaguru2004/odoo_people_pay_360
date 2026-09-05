/**
 * One-off backfill: seed the 4 preset ProjectRoles for every existing project
 * and map each existing ProjectMember.role (enum) onto its new roleId.
 * Idempotent — safe to re-run. Run: npx ts-node prisma/backfill-project-roles.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  presetRolesCreateData,
  OWNER_ROLE_SLUG,
} from '../src/projects/rbac/permissions.constants';

const prisma = new PrismaClient();

async function main() {
  const projects = await prisma.project.findMany({ select: { id: true } });
  console.log(`Backfilling roles for ${projects.length} projects...`);

  let rolesCreated = 0;
  let membersMapped = 0;

  for (const { id: projectId } of projects) {
    // Seed any missing preset roles (idempotent on [projectId, slug]).
    for (const role of presetRolesCreateData()) {
      const res = await prisma.projectRole.upsert({
        where: { projectId_slug: { projectId, slug: role.slug } },
        update: {}, // leave existing (possibly edited) roles untouched
        create: { ...role, projectId },
      });
      if (res) rolesCreated++;
    }

    const roles = await prisma.projectRole.findMany({ where: { projectId } });
    const ownerRole = roles.find((r) => r.slug === OWNER_ROLE_SLUG);
    const defaultRole =
      roles.find((r) => r.isDefault) ?? roles.find((r) => r.slug === 'member');

    const members = await prisma.projectMember.findMany({
      where: { projectId, roleId: null },
      select: { id: true, role: true },
    });
    for (const m of members) {
      const slug = String(m.role).toLowerCase();
      const match = roles.find((r) => r.slug === slug);
      const target = match ?? defaultRole ?? ownerRole;
      if (!target) continue;
      await prisma.projectMember.update({
        where: { id: m.id },
        data: { roleId: target.id },
      });
      membersMapped++;
    }
  }

  console.log(`Done. preset upserts: ${rolesCreated}, members mapped: ${membersMapped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
