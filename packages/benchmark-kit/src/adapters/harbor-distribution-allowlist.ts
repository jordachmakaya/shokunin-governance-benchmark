/**
 * @fileoverview Lab-controlled Harbor distribution authority (ZB2.2-R5).
 *
 * R4 let the expected binary hash travel with executor-chosen adapter
 * options, so a fake binary could supply its own hash and become
 * `pinned-hash-verified` (SELF_ATTESTED_FAKE_PINNED). R5 anchors trust here:
 * this module is lab-owned source, part of the sealed ZB2 BoxedZone, and the
 * ONLY authority consulted alongside the experiment manifest. A fake binary
 * cannot add itself to this list.
 */

/** Officially pinned Harbor harness version. */
export const PINNED_HARBOR_VERSION = "0.1.2";

/**
 * SHA-256 of the official Harbor 0.1.2 distribution wheel vendored in
 * `tests/fixtures/harbor/vendor/harbor-0.1.2-py3-none-any.whl`.
 * Verified offline via `sha256sum`; runner environments install Harbor with
 * `--with-requirements requirements.lock --with <this wheel>`, so the wheel
 * hash transitively authenticates the executed `harbor.cli.sb.main` module.
 */
export const OFFICIAL_HARBOR_WHEEL_SHA256 =
  "1478347edbfcc1ced2122815a67392dada4a40d715972a2e5a280858d457b7a5";

export const OFFICIAL_HARBOR_WHEEL_FILE = "harbor-0.1.2-py3-none-any.whl";

/**
 * Distribution identity levels. Only `manifest-pinned-verified` (binary hash
 * equals the experiment-manifest value) authenticates a host binary for G2.
 * `cli-shape-only` means the executable answered the genuine Typer CLI
 * probes but no binary hash was pinned/verified (unit-test doubles, the
 * uv-launched wire-test double). It is NEVER sufficient for G2 sealing.
 */
export type HarborDistributionIdentity =
  | "manifest-pinned-verified"
  | "cli-shape-only";

export interface HarborDistributionAttestation {
  readonly identity: HarborDistributionIdentity;
  readonly harborVersion: string | undefined;
  readonly harborBinarySha256: string | undefined;
  readonly versionSource: "importlib" | "help-text" | "unresolved";
}
