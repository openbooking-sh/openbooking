/** Platform profiles for tests: a valid one, and a fetcher that serves them without a network. */
import { USP, USP_VERSION, type PlatformProfile, type ProfileFetcher } from '../src';

const entry = (version = USP_VERSION) => [{ version }];

/** A profile that can use everything this adapter serves. */
export function platformProfile(
  overrides: { version?: string; capabilities?: Record<string, Array<{ version: string }>> } = {},
): PlatformProfile {
  return {
    usp: {
      version: overrides.version ?? USP_VERSION,
      capabilities: overrides.capabilities ?? {
        [USP.catalog]: entry(),
        [USP.availability]: entry(),
        [USP.bookings]: entry(),
      },
    },
  };
}

/** Serves `profiles[uri]` (any URI when `profiles` is a single profile) and records the calls. */
export function stubProfiles(
  profiles: PlatformProfile | Record<string, PlatformProfile> = platformProfile(),
) {
  const calls: string[] = [];
  const fetcher: ProfileFetcher = async (uri) => {
    calls.push(uri);
    const found = isProfile(profiles) ? profiles : profiles[uri];
    if (!found) throw new Error(`no stub profile for ${uri}`);
    return found;
  };
  return { fetcher, calls };
}

const isProfile = (p: PlatformProfile | Record<string, PlatformProfile>): p is PlatformProfile =>
  typeof (p as PlatformProfile).usp?.version === 'string';
