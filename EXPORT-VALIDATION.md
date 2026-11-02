# Code-only export validation — 2026-11-02

This is validation of the exported subset, not a full LineDog release acceptance.

| Check performed | Result |
| --- | --- |
| Original source identity | 296 original Git blobs match the frozen source-tree inventory; version metadata consistently 1.3.8 |
| Export allowlist | 106 imported text files; 104 byte-identical, 2 Rust files contain only neutralized synthetic geographic test fixtures |
| Dependency installation | `npm ci --ignore-scripts --no-audit --no-fund` succeeded; offline attempt first failed due to missing cache entry |
| TypeScript | `npm run typecheck` passed |
| Original frontend tests | `npm test -- --reporter=json` exited 1: 370 assertions passed, 8 failed; 378 assertions collected. 12 of 32 test files failed or could not load. Vitest aggregate suite counts include nested suites (75 passed / 16 failed). |
| Failure classification | All 8 assertion failures and 9 file-load failures refer to excluded `manifest.json`, `home/home-manifest.json` or `character-manifest-v2.schema.json`; no claim is made about tests that could not be collected |
| Production build | `npm run build` exited 1 after successful TypeScript and 47 transformed modules: original Vite asset plugin cannot open the excluded character manifest |
| Native checks / installer / desktop UI | Not run for this export; missing native icons/tray data also prevent the original native build |

The original source's historical 663 frontend and 101 Rust passing tests are not current results for this branch. No live model/search/weather call or application installation was performed.

## Publication review

Every imported path is classified explicitly in `PUBLIC-SOURCE-MANIFEST.json`, decoded as UTF-8 text and hashed against the fixed source inventory. Review scanned all imported file contents for private-key headers, common credential token formats, literal credential assignments, personal machine paths, URLs, copyright statements and embedded images. No actual credential or personal machine path was found. Windows `publicKeyToken` is a public assembly identifier, not a secret. Example credentials/URLs are test fixtures. Lockfile download hosts are public dependency registries. Geographic weather fixtures were neutralized for this export.

The only inline SVG found is the small original generic parachute accessory in `src/parachute-renderer.ts`, covered by the source MIT license. It contains no dog or Home artwork. The original MIT and historical asset notices are preserved verbatim; no third-party artwork is relicensed. The repository does not vendor third-party dependencies.

All private visual files, manifests, native icons, private Git history, internal agent rules, original local evidence/documentation and install/publish scripts are excluded. Only the existing public main history is used as a parent; already-existing public ancestor contents are not rewritten. The new snapshot tree contains no character or icon asset files.

Run `python scripts/verify-code-export.py` to verify imported file hashes and the explicit snapshot path allowlist. This integrity check does not prove absence of every possible secret or confer asset rights.
