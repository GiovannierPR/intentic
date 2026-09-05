import { createHash } from "node:crypto";

/* Linux caps an interface name at IFNAMSIZ-1 = 15 bytes. A candidate short enough to be legal IS the name (the
 * readable, overwhelmingly common case), and a longer one falls back to `<tag>-<hash>` so two long ids sharing a
 * prefix can never collide on one interface. The two tunnel kinds live in one network namespace and must not
 * meet there: a vpn's candidate is the bare id, an exit's is the id behind an `x`. */
const INTERFACE_MAX = 15;

export const interfaceNameOf = (candidate: string, tag: string): string =>
    candidate.length <= INTERFACE_MAX
        ? candidate
        : `${tag}-${createHash("sha256")
              .update(candidate)
              .digest("hex")
              .slice(0, INTERFACE_MAX - tag.length - 1)}`;
