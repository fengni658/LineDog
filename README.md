# LineDog 1.3.8 代码快照（不含角色素材）

This branch publishes a selected code snapshot of LineDog 1.3.8. It is **not a complete, reproducible official 1.3.8 distribution** and contains no installer or character artwork.

## Source identity and export changes

The source commit is `2133a90e42f1b69511b88368931872701949b588`, tree `6945d66ea290527bfe927ad12db22d70b0ceeb00`. The private source history was not imported. This branch starts from the existing public LineDog history at `f6cc562`.

`PUBLIC-SOURCE-MANIFEST.json` is the deterministic file allowlist: each entry records the original Git blob, original SHA-256 and exported SHA-256. Product TypeScript/Rust logic, dependency locks and tests are retained. The only adaptations in imported files neutralize geographic names/coordinates in synthetic Rust weather test fixtures. This README and the export/validation documents are new; the original internal README and installation documentation are excluded. No runtime replacement artwork was created.

## Missing assets and build limitations

All `public/**` content is excluded, including character PNGs, Home artwork, reference/candidate/promotion material, schemas and asset manifests. All `src-tauri/icons/**` files are excluded, including the tray RGBA. No license for these omitted materials is granted by this export. Do not copy them from private sources without the necessary rights.

Consequently the original application cannot run or bundle from this branch as supplied. The Vite production asset plugin expects `public/character/manifest.json`, its declared frames and `home/home-manifest.json` / `home.png`; native builds additionally require the configured icons and `linedog-tray.rgba`. Some original tests load the omitted manifests and therefore fail during collection or execution. These failures are retained and documented, rather than replacing original fixtures with invented official assets. An independently licensed asset implementation would require its own validation and would be a modified version.

## Development and checks

Prerequisites: Node.js/npm; native development additionally requires Windows, Rust and the Tauri 2 Windows toolchain. Run `npm ci --ignore-scripts`, then `npm run typecheck` and `npm test`. `npm run build` exercises the original build and is expected to report missing assets. `npm run tauri:dev` also needs assets/icons and user-provided configuration. This code can optionally call compatible model, search and weather services; no account, API credential or private configuration is included. Running tests is separate from accepting desktop behavior.

See `EXPORT-VALIDATION.md` for checks actually performed on this export. Historical full-source test results do not establish results for this asset-free branch.

## Licensing

Code and nonvisual software files retain the original MIT `LICENSE`, copyright 2026 fengni658. Dependencies retain their own licenses and are referenced by the lockfiles, not vendored. `ASSET-LICENSE.md` and `FREEWARE-NOTICE.txt` are preserved verbatim as historical notices about omitted materials; they do not assert that this branch includes artwork or resolve third-party rights to it. The small original vector parachute accessory is implemented in MIT source code; no dog or Home image is embedded in it.
