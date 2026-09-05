-- Add FLEXIBLE to ShiftType enum (own migration: an added enum value cannot be used in the same transaction it is created in)
ALTER TYPE "ShiftType" ADD VALUE IF NOT EXISTS 'FLEXIBLE';
