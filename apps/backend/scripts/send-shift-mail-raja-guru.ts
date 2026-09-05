import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TimezoneService } from '../src/common/timezone/timezone.service';

async function main() {
  console.log('🚀 Bootstrapping NestJS Application Context...');
  const app = await NestFactory.createApplicationContext(AppModule);

  const prisma = app.get(PrismaService);
  const mailService = app.get(MailService);
  const timezoneService = app.get(TimezoneService);

  try {
    console.log('🔍 Fetching employee "Raja Guru R"...');
    const employee = await prisma.employee.findFirst({
      where: {
        fullName: {
          contains: 'Raja Guru',
          mode: 'insensitive',
        },
      },
      include: {
        workSchedules: {
          orderBy: { date: 'desc' },
          take: 1,
        },
      },
    });

    if (!employee) {
      console.error('❌ Employee "Raja Guru" not found.');
      return;
    }

    console.log(`✅ Found employee: ${employee.fullName} (${employee.email})`);

    const schedule = employee.workSchedules[0];
    if (!schedule) {
      console.error('❌ No work schedule found for employee.');
      return;
    }

    console.log(
      `📅 Latest Schedule found: Date=${schedule.date.toISOString().split('T')[0]} | Shift=${schedule.shiftType}`,
    );

    // Resolve timezone
    const tz = await timezoneService.getEffectiveTZ(employee.timezone);
    console.log(`🌍 Effective Timezone: ${tz}`);

    // Format times (flexible shifts have no fixed start/end)
    const startTimeStr =
      schedule.startTime?.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: tz,
      }) ?? 'N/A';
    const endTimeStr =
      schedule.endTime?.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: tz,
      }) ?? 'N/A';

    console.log(`⏰ Formatted Start Time: ${startTimeStr}`);
    console.log(`⏰ Formatted End Time: ${endTimeStr}`);

    // Fetch company settings
    const companyNameSetting = await prisma.systemSetting.findUnique({
      where: { key: 'company_name' },
    });
    const companyLogoUrlSetting = await prisma.systemSetting.findUnique({
      where: { key: 'company_logo_url' },
    });
    const companyName = companyNameSetting?.value || 'The Company';
    const companyLogoUrl = companyLogoUrlSetting?.value || '';

    // Send the email
    console.log('📧 Sending shift reminder email...');
    await mailService.sendMail({
      to: employee.email,
      subject: `🔔 [TEST] Upcoming Shift Reminder: Starts in 5 Minutes`,
      template: 'shift-prior-reminder',
      context: {
        employeeName: employee.fullName,
        shiftType: schedule.shiftType,
        startTime: startTimeStr,
        endTime: endTimeStr,
        offsetMins: 5,
        companyName,
        companyLogoUrl,
      },
    });

    console.log('🎉 Email sent successfully!');
  } catch (error) {
    console.error('❌ Error executing script:', error);
  } finally {
    await app.close();
  }
}

main().catch(console.error);
