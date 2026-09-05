import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const employees = await prisma.employee.findMany({
      include: {
        attendances: {
          orderBy: { date: 'desc' },
          take: 5,
        },
      },
    });

    console.log('--- ALL EMPLOYEES & THEIR ATTENDANCES (LAST 5) ---');
    for (const emp of employees) {
      console.log(`Employee: ${emp.fullName} (${emp.email}) - ID: ${emp.id}`);
      if (emp.attendances.length === 0) {
        console.log('  No attendance records');
      }
      for (const att of emp.attendances) {
        console.log(`  Attendance Date: ${att.date.toISOString()}`);
        console.log(
          `    Check-In:  ${att.checkIn ? att.checkIn.toISOString() : 'null'}`,
        );
        console.log(
          `    Check-Out: ${att.checkOut ? att.checkOut.toISOString() : 'null'}`,
        );
        console.log(`    Status:    ${att.status}`);
      }
    }
  } catch (error) {
    console.error('Error querying DB:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
