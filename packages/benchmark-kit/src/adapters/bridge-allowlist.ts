/**
 * @fileoverview Versioned lab-owned allowlist for the interception bridge
 * (ZB2.2-R8/R8.1).
 *
 * Recording a hash is not authentication: the session must compare the
 * actually-loaded bridge bytes against this mapping and fail closed on
 * mismatch. Entries are added explicitly per bridge release (BRIDGE_VERSION);
 * an unknown hash is never trusted.
 */

// Filled once the R8 bridge file is final (sha256sum of the exact bytes).
// The R8 suite asserts this entry matches the vendored bridge module.
export const BRIDGE_ALLOWLIST: Record<string, string> = {
  "1.0.0-r8": "388f85bc73cac87ae297fe2e5eac141684699aca6608a97c7f2b565f5a08991e",
  "1.0.0-r8.1": "0c165966ced7f6ba9480993536e0538b9627452efbabc394dc195d353aac6baf",
  "1.0.0-r8.2": "ed8172c5324d825a7787682234fed7c5ec5ec08c7b7a0693ef78f066bc712305",
  "1.0.0-r8.3": "db2c4477d8460715375fc8ca2d89301e9f8b766e3ad948faae1399d65f9e5bed",
};

/** Exact bytes of the lab-owned Docker-to-Podman compatibility launcher. */
export const PODMAN_DOCKER_COMPAT_SHA256 =
  "5b86d78ae2bf64e73751e64f5fbadfda748cf7902c064d8163beebb36be72372";

/** Returns the allowlisted bridge version for exact bytes, else null. */
export function lookupBridgeVersion(sha256Hex: string): string | null {
  const normalized = sha256Hex.toLowerCase();
  for (const [version, digest] of Object.entries(BRIDGE_ALLOWLIST)) {
    if (digest.toLowerCase() === normalized) return version;
  }
  return null;
}
