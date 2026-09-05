import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const employees = await prisma.employee.findMany({
      where: {
        fullName: {
          contains: 'Raja Guru',
          mode: 'insensitive',
        },
      },
      include: {
        workSchedules: {
          orderBy: { date: 'desc' },
          take: 5,
        },
      },
    });

    console.log(`Found ${employees.length} employees matching "Raja Guru":`);
    for (const emp of employees) {
      console.log(`- ID: ${emp.id}`);
      console.log(`  Name: ${emp.fullName}`);
      console.log(`  Email: ${emp.email}`);
      console.log(`  Timezone: ${emp.timezone}`);
      console.log(`  Schedules (last 5):`);
      for (const sched of emp.workSchedules) {
        console.log(
          `    * Date: ${sched.date.toISOString().split('T')[0]} | Shift: ${sched.shiftType} | Start: ${sched.startTime?.toISOString() ?? 'flexible'} | End: ${sched.endTime?.toISOString() ?? 'flexible'}`,
        );
      }
    }
  } catch (error) {
    console.error('Error finding employee:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
