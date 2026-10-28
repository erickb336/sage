import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** A checkout is usable as identity only when its absolute path resolves to a directory. */
export function checkoutIdentity(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function sameCheckout(first, second) {
  const identity = checkoutIdentity(first);
  return identity !== null && identity === checkoutIdentity(second);
}
