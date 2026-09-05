import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--commit');

async function main() {
  console.log(`=== Leave Requests Database Cleanup ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (No changes will be made)' : 'COMMIT (DELETIVE MODE)'}\n`);

  try {
    // 1. Resolve employee
    const targetEmail = 'rajaguru20042@gmail.com';
    const employee = await prisma.employee.findUnique({
      where: { email: targetEmail },
    });

    if (!employee) {
      console.error(`❌ Employee with email ${targetEmail} not found!`);
      return;
    }
    console.log(`👤 Found target employee: ${employee.fullName} (ID: ${employee.id})`);

    // 2. Query approved leaves for the employee
    const approvedLeaves = await prisma.leaveRequest.findMany({
      where: {
        employeeId: employee.id,
        status: 'APPROVED',
      },
    });

    console.log(`📋 Approved leave requests for ${targetEmail}: ${approvedLeaves.length}`);
    approvedLeaves.forEach((req) => {
      console.log(`  - ID: ${req.id} | Dates: ${req.startDate.toISOString().split('T')[0]} to ${req.endDate.toISOString().split('T')[0]} | Days: ${req.totalDays} | Reason: "${req.reason}"`);
    });

    // 3. Query all cancelled leaves in the DB
    const cancelledLeaves = await prisma.leaveRequest.findMany({
      where: {
        status: 'CANCELLED',
      },
    });

    console.log(`\n📋 Cancelled leave requests database-wide: ${cancelledLeaves.length}`);
    if (cancelledLeaves.length > 0) {
      console.log(`  (Sample of up to 5 cancelled requests):`);
      cancelledLeaves.slice(0, 5).forEach((req) => {
        console.log(`  - ID: ${req.id} | Employee ID: ${req.employeeId} | Dates: ${req.startDate.toISOString().split('T')[0]} to ${req.endDate.toISOString().split('T')[0]} | Reason: "${req.reason}"`);
      });
    }

    if (DRY_RUN) {
      console.log(`\n💡 To perform the actual deletion, run the script with the --commit flag:`);
      console.log(`   npx ts-node scripts/clean-leaves.ts --commit`);
    } else {
      console.log(`\n⚠️  Deleting records...`);

      const deletedApproved = await prisma.leaveRequest.deleteMany({
        where: {
          employeeId: employee.id,
          status: 'APPROVED',
        },
      });

      const deletedCancelled = await prisma.leaveRequest.deleteMany({
        where: {
          status: 'CANCELLED',
        },
      });

      console.log(`\n✅ Deletion complete:`);
      console.log(`   - Deleted ${deletedApproved.count} approved leave requests for ${targetEmail}`);
      console.log(`   - Deleted ${deletedCancelled.count} cancelled leave requests database-wide`);
    }
  } catch (error) {
    console.error('❌ Error during database operations:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
