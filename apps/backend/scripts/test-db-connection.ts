import { PrismaClient } from '@prisma/client';

async function queryDB(url: string, label: string) {
  console.log(`\n--- Querying ${label} ---`);
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: url,
      },
    },
  });

  try {
    const userCount = await prisma.user.count();
    console.log(`User count: ${userCount}`);

    const targetUser = await prisma.user.findFirst({
      where: {
        email: {
          contains: 'rajaguru20042@gmail.com',
          mode: 'insensitive'
        }
      },
      include: {
        employee: true
      }
    });

    if (targetUser) {
      console.log(`Found target user: ID = ${targetUser.id}, Email = ${targetUser.email}`);
      if (targetUser.employee) {
        console.log(`Associated Employee: ID = ${targetUser.employee.id}, Name = ${targetUser.employee.fullName}, Email = ${targetUser.employee.email}`);
        
        // Count approved leave requests for this employee
        const approvedCount = await prisma.leaveRequest.count({
          where: {
            employeeId: targetUser.employee.id,
            status: 'Approved' // wait, check if casing is 'APPROVED' or 'Approved' or 'approved'
          }
        });
        
        const approvedCountAllCases = await prisma.leaveRequest.count({
          where: {
            employeeId: targetUser.employee.id,
            status: {
              in: ['APPROVED', 'Approved', 'approved']
            }
          }
        });

        console.log(`Approved Leave Requests: status="Approved": ${approvedCount}, status (any-case APPROVED): ${approvedCountAllCases}`);
      } else {
        console.log(`No associated employee for target user.`);
      }
    } else {
      console.log(`Target user rajaguru20042@gmail.com not found!`);
    }

    // Also let's check general LeaveRequest statuses in the DB
    const leaveRequestsGroup = await prisma.leaveRequest.groupBy({
      by: ['status'],
      _count: {
        id: true
      }
    });
    console.log('All Leave requests in DB grouped by status:', leaveRequestsGroup);

  } catch (err: any) {
    console.error(`Error querying: ${err.message || err}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const envUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@103.186.221.20:8068/myappdb?schema=public';
  await queryDB(envUrl, 'Env DATABASE_URL');
  
  const localUrl = 'postgresql://postgres:postgres@127.0.0.1:8068/myappdb?schema=public';
  await queryDB(localUrl, 'Localhost 127.0.0.1:8068');
}

main().catch(console.error);
