# Crash log fixtures (M-9, SPEC CRS-1, AC-2)

Each `.log` is a boot log or crash report; `test/diagnose.test.ts` holds the expected diagnosis.

| file | source |
| --- | --- |
| `fabric-missing-dependency.log` | **real**: Fabric 1.21.1 server, Waystones without Balm and Fabric API (2026-11-03) |
| `fabric-wrong-minecraft.log` | **real**: Fabric 1.21.1 server with Lithium built for 1.20.1 (2026-11-03) |
| `fabric-client-breaks.log` | **real**: Fabric 1.21.1 client test (HeadlessMC), Xaero's Maps x Waystones 2.12.1 breaks Xaero's Minimap >=26.2.0 (2026-11-03) |
| `fabric-breaks-before.log` | **real**: Fabric 1.21.1 server, Xaero's World Map 1.47.0 breaks Xaero's Minimap before 26.4.0 (the live Fix a crash run, 2026-11-10; path replaced) |
| `fabric-server-ok.log` | **real**: clean Fabric 1.21.1 server boot to `Done (` (scratch path replaced) |
| the others | **constructed** from the message formats the loaders and the JVM print; replace each with a real log when one turns up |

Notes: Fabric quietly keeps the newest of two copies of the same mod (seen live), so a duplicate
jar is not a Fabric boot failure.
