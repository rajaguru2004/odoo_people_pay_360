export type TravelType = 'DOMESTIC' | 'INTERNATIONAL';

/**
 * Must mirror `TRAVEL_STATUSES` in the backend's
 * `src/travel/dto/query-travel.dto.ts`.
 *
 * `COMPLETED` used to be here and was never written by any code path. It was
 * offered in the status filter, matched nothing, and — once the backend dropped
 * it from the DTO's `@IsIn` — picking it answered 400 while the list silently
 * kept the previous rows. Nothing in the product marks a trip as having
 * happened; there is no completion cron and no screen action for it.
 *
 * If trip completion is built later, add the value back on BOTH sides in the
 * same change as the code that writes it.
 */
export type TravelStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

export type ItineraryMode = 'FLIGHT' | 'TRAIN' | 'ROAD' | 'HOTEL' | 'OTHER';

export interface TravelEmployeeRef {
  id: string;
  employeeCode: string;
  fullName: string;
  email?: string;
  department?: { id?: string; name: string } | null;
}

export interface TravelItineraryLeg {
  id?: string;
  legOrder?: number;
  mode: ItineraryMode;
  fromPlace?: string | null;
  toPlace?: string | null;
  startAt: string;
  endAt?: string | null;
  reference?: string | null;
  notes?: string | null;
}

/** A trip owns the *request*: dates, destination, per-diem snapshot and approval. */
export interface TravelRequest {
  id: string;
  employeeId: string;
  purpose: string;
  travelType: TravelType;
  destination: string;
  country: string | null;
  departureDate: string;
  returnDate: string;
  /** Snapshotted from the destination library at submit, never read live. */
  perDiemRate: string | number | null;
  perDiemDays: number | null;
  estimatedCost: string | number;
  advanceAmount: string | number | null;
  status: TravelStatus;
  approverId: string | null;
  approvedAt: string | null;
  approverRemarks: string | null;
  rejectedReason: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: TravelEmployeeRef;
  approver?: { id: string; email: string } | null;
  itinerary?: TravelItineraryLeg[];
}

export interface OnTripRow {
  id: string;
  destination: string;
  country: string | null;
  travelType: TravelType;
  departureDate: string;
  returnDate: string;
  employee: TravelEmployeeRef;
}

export interface CreateTravelRequestData {
  purpose: string;
  travelType: TravelType;
  destination: string;
  country?: string;
  departureDate: string;
  returnDate: string;
  perDiemDays?: number;
  estimatedCost: number;
  advanceAmount?: number;
  itinerary?: TravelItineraryLeg[];
}

export interface QueryTravelParams {
  status?: TravelStatus;
  employeeId?: string;
  travelType?: TravelType;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}
