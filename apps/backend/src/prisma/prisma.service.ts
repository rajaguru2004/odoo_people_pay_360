import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getBranchContext, getBranchEnforcement } from '../common/branch/branch-context';
import {
  BRANCH_READ_ACTIONS,
  BRANCH_WRITE_MANY_ACTIONS,
  BRANCH_SCOPE,
  buildBranchWhere,
  isDirectRule,
} from '../common/branch/branch-scope.map';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly branchLogger = new Logger('BranchScope');

  constructor() {
    super({
      datasources: {
        db: {
          // Use DATABASE_URL (Transaction Mode) for better connection pooling
          url: process.env.DATABASE_URL,
        },
      },
      log:
        process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
    this.registerBranchScoping();
  }

  /**
   * Fail-closed multi-branch auto-scoping. Reads the request-scoped branch
   * context (AsyncLocalStorage) and AND-composes a branch predicate into every
   * read of a branch-owned model, and stamps branchId onto scalar creates.
   * No context / global / unscoped model / enforcement=off => passthrough.
   */
  private registerBranchScoping() {
    this.$use(async (params, next) => {
      const ctx = getBranchContext();
      if (!ctx || ctx.isAllBranches || !params.model) return next(params);

      const rule = BRANCH_SCOPE[params.model];
      if (!rule) return next(params);

      const mode = getBranchEnforcement();
      if (mode === 'off') return next(params);

      const ids = ctx.effectiveBranchId
        ? [ctx.effectiveBranchId]
        : ctx.accessibleBranchIds;

      const isRead = BRANCH_READ_ACTIONS.has(params.action);
      const isWriteMany = BRANCH_WRITE_MANY_ACTIONS.has(params.action);

      if (isRead || isWriteMany) {
        // Prisma updateMany/deleteMany accept a SCALAR-ONLY `where`; a
        // relation/path predicate would throw. Only auto-scope bulk writes for
        // `direct` models — relation/path models must guard bulk writes with a
        // preceding assertInBranch at the service layer.
        if (isWriteMany && !isDirectRule(rule)) {
          if (mode !== 'shadow') {
            this.branchLogger.warn(
              `skip branch auto-scope on ${params.model}.${params.action} ` +
                `(relation-scoped; guard via assertInBranch at the service)`,
            );
          }
          return next(params);
        }
        if (mode === 'shadow') {
          this.branchLogger.debug(
            `[shadow] would scope ${params.model}.${params.action} -> branch(${ids.join(',') || 'none'})`,
          );
        } else {
          const branchWhere = buildBranchWhere(rule, ids);
          params.args = params.args ?? {};
          params.args.where = params.args.where
            ? { AND: [params.args.where, branchWhere] }
            : branchWhere;
        }
      } else if (
        params.action === 'create' &&
        isDirectRule(rule) &&
        ctx.effectiveBranchId &&
        mode !== 'shadow'
      ) {
        params.args = params.args ?? {};
        const data = params.args.data;
        if (data && !Array.isArray(data) && data.branchId === undefined) {
          data.branchId = ctx.effectiveBranchId;
        }
      }

      return next(params);
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      const dbIp = this.getDatabaseHostOrIp();
      console.log(`✅ Database connected successfully (${dbIp})`);
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    console.log('🔌 Database disconnected');
  }

  // Helper method to ensure connection cleanup
  async cleanupConnections() {
    try {
      await this.$disconnect();
      await this.$connect();
      console.log('🔄 Database connections refreshed');
    } catch (error) {
      console.error('❌ Failed to refresh connections:', error);
    }
  }

  private getDatabaseHostOrIp(): string {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return 'unknown';
    try {
      const parsed = new URL(dbUrl.includes('://') ? dbUrl : `datasource://${dbUrl}`);
      return parsed.hostname || parsed.host || 'unknown';
    } catch {
      // Fallback regex to extract host/IP from typical connection strings
      const match = dbUrl.match(/@([^/:]+)/);
      return match ? match[1] : 'unknown';
    }
  }
}
