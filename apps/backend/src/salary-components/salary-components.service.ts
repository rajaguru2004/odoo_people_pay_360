import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { CreateSalaryComponentDto } from './dto/create-salary-component.dto';
import { UpdateSalaryComponentDto } from './dto/update-salary-component.dto';

@Injectable()
export class SalaryComponentsService {
  constructor(private prisma: PrismaService) {}

  async create(createDto: CreateSalaryComponentDto) {
    // Validate employee exists
    const employee = await this.prisma.employee.findUnique({
      where: { id: String(createDto.employeeId) },
    });

    if (!employee) {
      throw new NotFoundException(
        `Employee with ID ${createDto.employeeId} not found`,
      );
    }

    // Branch guard: a scoped caller cannot add a salary component for an
    // out-of-branch employee.
    assertInBranch(employee.branchId);

    // BASIC: only one active allowed
    if (createDto.componentType === 'BASIC') {
      const existing = await this.prisma.salaryComponent.findFirst({
        where: {
          employeeId: String(createDto.employeeId),
          componentType: 'BASIC',
          isActive: true,
        },
      });

      if (existing) {
        throw new BadRequestException(
          'Employee already has a basic salary. Please update instead of creating a new one.',
        );
      }
    }

    // PAYROLL_CONFIG: singleton per employee — deactivate any existing before creating new
    if (createDto.componentType === 'PAYROLL_CONFIG') {
      await this.prisma.salaryComponent.updateMany({
        where: {
          employeeId: String(createDto.employeeId),
          componentType: 'PAYROLL_CONFIG',
          isActive: true,
        },
        data: { isActive: false },
      });
    }

    const component = await this.prisma.salaryComponent.create({
      data: {
        employeeId: String(createDto.employeeId),
        componentType: createDto.componentType,
        // PAYROLL_CONFIG stores overrides in note (JSON); amount is always 0
        amount:
          createDto.componentType === 'PAYROLL_CONFIG' ? 0 : createDto.amount,
        effectiveDate: createDto.effectiveDate
          ? new Date(createDto.effectiveDate)
          : new Date(),
        note: createDto.note,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
          },
        },
      },
    });

    return {
      success: true,
      message: 'Salary component created successfully',
      data: component,
    };
  }

  async findAll(
    employeeId?: string,
    componentType?: string,
    isActive?: boolean,
    page: number = 1,
    limit: number = 20,
  ) {
    const where: any = {};

    if (employeeId) where.employeeId = employeeId;
    if (componentType) where.componentType = componentType;
    if (isActive !== undefined) where.isActive = isActive;

    const skip = (page - 1) * limit;

    const [components, total] = await Promise.all([
      this.prisma.salaryComponent.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              department: {
                select: { name: true },
              },
            },
          },
        },
        orderBy: [{ employeeId: 'asc' }, { effectiveDate: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.salaryComponent.count({ where }),
    ]);

    return {
      success: true,
      data: components,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const component = await this.prisma.salaryComponent.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            branchId: true,
            department: {
              select: { name: true },
            },
          },
        },
      },
    });

    if (!component) {
      throw new NotFoundException(`Salary component with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(component.employee.branchId);

    return {
      success: true,
      data: component,
    };
  }

  async findByEmployee(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const components = await this.prisma.salaryComponent.findMany({
      where: {
        employeeId,
        isActive: true,
      },
      orderBy: { componentType: 'asc' },
    });

    // Calculate total salary
    const totalSalary = components.reduce(
      (sum, comp) => sum + Number(comp.amount),
      0,
    );

    return {
      success: true,
      data: {
        employee: {
          id: employee.id,
          employeeCode: employee.employeeCode,
          fullName: employee.fullName,
        },
        components,
        totalSalary,
      },
    };
  }

  async update(id: string, updateDto: UpdateSalaryComponentDto) {
    const existing = await this.prisma.salaryComponent.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });

    if (!existing) {
      throw new NotFoundException(`Salary component with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(existing.employee.branchId);

    // Changing the AMOUNT is a pay change, so it is append-only: the current row
    // is retired and a new active one takes its place, exactly as
    // EmployeeBankDetail does. Editing in place rewrote history — the payslip
    // that had already been produced from the old figure no longer had a row
    // that explained it, and the only trace left was an audit entry.
    //
    // Everything else (note, isActive, componentType, effectiveDate on its own)
    // is metadata and is still edited in place.
    const amountChanged =
      updateDto.amount !== undefined &&
      Number(updateDto.amount) !== Number(existing.amount);

    const include = {
      employee: {
        select: { id: true, employeeCode: true, fullName: true },
      },
    };

    if (amountChanged && existing.isActive) {
      const [, created] = await this.prisma.$transaction([
        this.prisma.salaryComponent.update({
          where: { id },
          data: { isActive: false },
        }),
        this.prisma.salaryComponent.create({
          data: {
            employeeId: existing.employeeId,
            componentType: updateDto.componentType ?? existing.componentType,
            amount: updateDto.amount!,
            effectiveDate: updateDto.effectiveDate
              ? new Date(updateDto.effectiveDate)
              : new Date(),
            note: updateDto.note ?? existing.note,
            isActive: true,
          },
          include,
        }),
      ]);

      return {
        success: true,
        message:
          'Salary component amended. The previous amount was retired and a new one now applies.',
        data: created,
      };
    }

    const component = await this.prisma.salaryComponent.update({
      where: { id },
      data: {
        ...updateDto,
        effectiveDate: updateDto.effectiveDate
          ? new Date(updateDto.effectiveDate)
          : undefined,
      },
      include,
    });

    return {
      success: true,
      message: 'Salary component updated successfully',
      data: component,
    };
  }

  async deactivate(id: string) {
    const existing = await this.prisma.salaryComponent.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });

    if (!existing) {
      throw new NotFoundException(`Salary component with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(existing.employee.branchId);

    const component = await this.prisma.salaryComponent.update({
      where: { id },
      data: { isActive: false },
    });

    return {
      success: true,
      message: 'Salary component deactivated successfully',
      data: component,
    };
  }

  async remove(id: string) {
    const existing = await this.prisma.salaryComponent.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });

    if (!existing) {
      throw new NotFoundException(`Salary component with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(existing.employee.branchId);

    // A hard delete destroys the row a produced payslip was calculated from. Once
    // this employee has ANY locked payroll, the component is part of a paid
    // record and must be retired rather than erased — `POST :id/deactivate` is
    // the door for that, and it is what the caller is pointed at here. Before a
    // single run is locked there is nothing to explain, so a mistyped component
    // can still be removed outright.
    const lockedRuns = await this.prisma.payrollItem.count({
      where: {
        employeeId: existing.employeeId,
        payroll: { status: 'LOCKED' },
      },
    });
    if (lockedRuns > 0) {
      throw new BadRequestException(
        'This employee has locked payroll history, so a salary component can no longer be deleted. Deactivate it instead.',
      );
    }

    await this.prisma.salaryComponent.delete({
      where: { id },
    });

    return {
      success: true,
      message: 'Salary component deleted successfully',
    };
  }

  // Helper method for payroll calculation
  async getActiveComponentsByEmployee(employeeId: string) {
    return this.prisma.salaryComponent.findMany({
      where: {
        employeeId,
        isActive: true,
      },
    });
  }

  // Calculate total salary for an employee
  async calculateTotalSalary(employeeId: string): Promise<number> {
    const components = await this.getActiveComponentsByEmployee(employeeId);
    return components.reduce((sum, comp) => sum + Number(comp.amount), 0);
  }
}
