import { BadRequestException } from '@nestjs/common';
import { GarnishmentsService } from './garnishments.service';

/**
 * The rung the recovery ladder was missing.
 *
 * `PayrollItem.garnishment` and `CycleContext.garnishment` both existed and
 * payroll passed a hard-coded `0`, so the requirement doc's headline case —
 * statutory deductions, garnishments and recoveries competing for one limited
 * net salary — could not be exercised even in principle.
 *
 * `takeFor` is pure, so the arithmetic is a table here rather than a database
 * fixture. What it has to get right is the two bounds: an order stops at its
 * cap, and no combination of orders can produce a negative payslip.
 */
describe('GarnishmentsService.takeFor', () => {
  const order = (over: Record<string, unknown> = {}) =>
    ({
      id: `ord-${Math.random().toString(36).slice(2, 8)}`,
      amount: null,
      percentOfNet: null,
      totalCap: null,
      collected: 0,
      ...over,
    }) as any;

  it('takes a fixed amount', () => {
    const result = GarnishmentsService.takeFor([order({ amount: 200 })], 1000);
    expect(result.total).toBe(200);
    expect(result.orders).toHaveLength(1);
  });

  it('takes a percentage of net', () => {
    const result = GarnishmentsService.takeFor([order({ percentOfNet: 25 })], 1000);
    expect(result.total).toBe(250);
  });

  it('rounds a percentage to money, not to a float', () => {
    // 33.33% of 1000 is 333.3; a payslip cannot carry a tenth of a unit.
    const result = GarnishmentsService.takeFor([order({ percentOfNet: 33.33 })], 1000);
    expect(result.total).toBe(333.3);
  });

  it('takes nothing when there are no orders', () => {
    const result = GarnishmentsService.takeFor([], 1000);
    expect(result.total).toBe(0);
    expect(result.orders).toHaveLength(0);
  });

  describe('the cap', () => {
    it('stops at what is left of the total cap', () => {
      const result = GarnishmentsService.takeFor(
        [order({ amount: 200, totalCap: 500, collected: 400 })],
        1000,
      );
      expect(result.total).toBe(100);
    });

    it('takes nothing once the cap is reached', () => {
      const result = GarnishmentsService.takeFor(
        [order({ amount: 200, totalCap: 500, collected: 500 })],
        1000,
      );
      expect(result.total).toBe(0);
      expect(result.orders).toHaveLength(0);
    });

    it('ignores a cap that has been over-collected rather than refunding', () => {
      // Recovering money already taken is not this service's decision.
      const result = GarnishmentsService.takeFor(
        [order({ amount: 200, totalCap: 500, collected: 600 })],
        1000,
      );
      expect(result.total).toBe(0);
    });
  });

  describe('the payslip floor', () => {
    it('never takes more than the net pay', () => {
      const result = GarnishmentsService.takeFor([order({ amount: 5000 })], 1000);
      expect(result.total).toBe(1000);
    });

    it('takes nothing at all from zero pay', () => {
      const result = GarnishmentsService.takeFor([order({ amount: 200 })], 0);
      expect(result.total).toBe(0);
    });

    it('shares a short net between orders in order, rather than overdrawing', () => {
      // Two orders of 700 against 1000: the first is honoured in full, the
      // second takes what is left. Between them they cannot create a negative
      // payslip, and what the second could not take it takes next cycle.
      const result = GarnishmentsService.takeFor(
        [order({ amount: 700, id: 'first' }), order({ amount: 700, id: 'second' })],
        1000,
      );
      expect(result.total).toBe(1000);
      expect(result.orders.map((o) => o.take)).toEqual([700, 300]);
    });

    it('stops looking once the net is exhausted', () => {
      const result = GarnishmentsService.takeFor(
        [order({ amount: 1000 }), order({ amount: 500 })],
        1000,
      );
      expect(result.orders).toHaveLength(1);
    });
  });

  describe('a percentage and a fixed order together', () => {
    it('applies both, each against the ORIGINAL net', () => {
      // A percentage order is a share of pay, not a share of what is left after
      // another creditor — compounding them would quietly under-collect the
      // second order.
      const result = GarnishmentsService.takeFor(
        [order({ percentOfNet: 10 }), order({ amount: 150 })],
        1000,
      );
      expect(result.orders.map((o) => o.take)).toEqual([100, 150]);
      expect(result.total).toBe(250);
    });
  });
});

describe('GarnishmentsService — an order has to be followable', () => {
  const service = new GarnishmentsService({
    employee: { findUnique: jest.fn(async () => ({ id: 'e1', branchId: null })) },
    garnishmentOrder: { create: jest.fn(async ({ data }: any) => data) },
  } as any);

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      employeeId: '00000000-0000-4000-8000-000000000001',
      reference: 'CIV/2026/1',
      startDate: '2026-09-01',
      ...over,
    }) as any;

  it('refuses an order that states both an amount and a percentage', async () => {
    await expect(
      service.create(dto({ amount: 100, percentOfNet: 10 })),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses an order that states neither', async () => {
    await expect(service.create(dto())).rejects.toThrow(BadRequestException);
  });

  it('refuses an order that ends before it starts', async () => {
    await expect(
      service.create(dto({ amount: 100, startDate: '2026-09-01', endDate: '2026-08-01' })),
    ).rejects.toThrow(/ends before it starts/i);
  });

  it('accepts a coherent order', async () => {
    await expect(service.create(dto({ amount: 100 }))).resolves.toBeTruthy();
  });
});
