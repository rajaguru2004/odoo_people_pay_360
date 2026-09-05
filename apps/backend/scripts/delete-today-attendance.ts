import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function deleteTodayAttendance() {
  try {
    // Get today's date in UTC (start and end of day)
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0,
    );
    const endOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );

    console.log('🗑️  Deleting attendance records for today...');
    console.log(
      'Date range:',
      startOfDay.toISOString(),
      'to',
      endOfDay.toISOString(),
    );

    const result = await prisma.attendance.deleteMany({
      where: {
        date: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    console.log(`✅ Deleted ${result.count} attendance records for today`);
  } catch (error) {
    console.error('❌ Error deleting attendance records:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

deleteTodayAttendance()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
