---
name: android-emulator-selftest
description: Use this skill when Android client changes need repo-standard self-testing on the local Android emulator, including debug APK build, emulator install, app launch, hub/demo probe verification, and refreshing temp_docs/apk with the latest debug APK.
---

# Android Emulator Self-Test

Use this skill whenever an Android client feature, bug fix, UI change, connectivity change, or packaging change is completed and needs standard project self-test coverage.

## Trigger

Use this skill when:

- Android UI or behavior changed
- Android networking or hub connectivity changed
- The user asks for APK delivery or refresh
- The project needs the required post-feature Android self-test

## Required outcome

Complete all of the following unless blocked by an explicit environment issue:

1. Build the debug APK
2. Ensure a local emulator is available
3. Install the APK on the emulator
4. Launch the app
5. Run at least one probe against a reachable hub/demo agent flow
6. Refresh `temp_docs/apk/agentlink-debug.apk`
7. Report exactly what passed and what was blocked

## Standard workflow

1. Read `docs/guides/android-debug.md` if the current failure mode is unclear.
2. Prefer the bundled script:
   `./.agents/skills/android-emulator-selftest/scripts/run_selftest.sh`
3. If the script fails, inspect the failing step before retrying. Do not silently skip emulator verification.
4. If the hub or demo agent is not running, start temporary local instances for the test.
5. After success, verify that `temp_docs/apk/agentlink-debug.apk` exists and matches the latest build output timestamp.

## Notes

- Prefer the emulator serial `emulator-5554` when multiple ADB aliases point to the same emulator.
- Keep console output in English.
- Do not use this skill for release signing or store publishing.
- If emulator install succeeds but interactive UI validation is flaky, the minimum acceptable fallback is a debug probe plus log verification.

## Script entrypoint

- Main script: `scripts/run_selftest.sh`
- The script is responsible for build, install, launch, probe, and APK refresh.
