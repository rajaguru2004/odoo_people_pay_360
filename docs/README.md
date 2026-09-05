# Documentation

| Document | Covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Request lifecycle, auth model, data conventions, module aggregates, frontend state split, theming, testing strategy, configuration |
| [../README.md](../README.md) | Stack, layout, ports, getting started, commands |
| [../CLAUDE.md](../CLAUDE.md) | Short working notes and the non-obvious rules |
| [MIGRATION.md](MIGRATION.md) | Status of the three HR modules, what was verified, what is still open |
| [MIGRATION-GAPS.md](MIGRATION-GAPS.md) | Screen-depth audit against the system ported from, per area |
| [schedules-walkthrough.md](schedules-walkthrough.md) | Schedules: entry points, roster rules, data, seed, tests, and what changed from HRM |
| [interconnections-schedules.md](interconnections-schedules.md) | Which modules Schedules touches, the contract with each, and what is pending on the platform |
| [leave-overtime-walkthrough.md](leave-overtime-walkthrough.md) | Leave & Overtime: entry points, the balance and tier rules, data, seed, tests, and what changed from HRM |
| [interconnections-leave-overtime.md](interconnections-leave-overtime.md) | Which modules Leave & Overtime touches, the contract with each, and the seams payroll, approvals, notifications and storage will plug into |
| [interconnections-leave-encashment.md](interconnections-leave-encashment.md) | The deferred encashment and carry-forward module: models owed, the one-way payroll seam, and the four money rules |

Add feature docs and trackers here as the platform grows — one file per
subsystem, named for the subsystem rather than for the sprint that produced it.
