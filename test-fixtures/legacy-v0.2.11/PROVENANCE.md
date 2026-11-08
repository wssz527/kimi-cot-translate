# v0.2.11 runtime fixture

Byte-for-byte copies of the five files a v0.2.11 install deploys, taken from the
`v0.2.11` tag:

    git show v0.2.11:runtime.mjs > test-fixtures/legacy-v0.2.11/runtime.mjs

The upgrade tests run this unmodified code as the entry point, so the migration
is exercised against the real updater and deploy path of that release rather
than a re-implementation of it. The files are test data only and are never
packaged: `runtime-manifest.json` and the release bundles list their own files.
