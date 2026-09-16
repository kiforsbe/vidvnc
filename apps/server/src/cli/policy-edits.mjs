import { validateStreamPolicy } from '../stream-policy.mjs';

export const NEW_PROFILE = Object.freeze({ width: 1920, height: 1080, fps: 30, bitrateKbps: 4000 });
export const OPTION_KINDS = Object.freeze({
  size: 'resolutions',
  framerate: 'frameRates',
  bitrate: 'bitratesKbps',
});
const RESERVED_IDS = new Set(['auto', 'custom']);
const EDITABLE = ['name', 'description', 'enabled', 'width', 'height', 'fps', 'bitrateKbps'];

// Every edit returns a validated copy with the same revision; stores own revisions.
function edit(policy, change) {
  const next = structuredClone(policy);
  change(next);
  return validateStreamPolicy(next);
}

function withDefaultHint(apply) {
  try {
    return apply();
  } catch (error) {
    if (/^(Default profile|Display default) must refer/.test(error.message))
      error.message += '; change the default first';
    throw error;
  }
}

function findProfile(policy, id) {
  const profile = policy.profiles.find((row) => row.id === id);
  if (!profile) throw new Error('Profile no longer exists');
  return profile;
}

export function seedDisplaySharing(policy, displays) {
  if (policy.displaySharing !== null) return policy;
  const primary = displays.find((display) => display.primary && display.persistent);
  return edit(policy, (next) => {
    next.displaySharing = primary ? { [primary.id]: true } : {};
  });
}

export function setDisplaySharing(policy, displays, display, shared) {
  if (!display.persistent)
    throw new Error(`Display ${display.number} has no stable identity and cannot be shared`);
  return edit(seedDisplaySharing(policy, displays), (next) => {
    next.displaySharing[display.id] = shared;
  });
}

export function setDisplayDefault(policy, displayId, profileId) {
  return edit(policy, (next) => {
    if (profileId === null) delete next.displayDefaults[displayId];
    else next.displayDefaults[displayId] = profileId;
  });
}

export function setDefaultProfile(policy, profileId) {
  return edit(policy, (next) => {
    next.defaultProfileId = profileId;
  });
}

export function setAudio(policy, allowed) {
  return edit(policy, (next) => {
    next.allowAudio = allowed;
  });
}

export function setVideoCodecs(policy, ids) {
  return edit(policy, (next) => {
    next.videoCodecs = ids;
  });
}

export function setClientMode(policy, mode) {
  return edit(policy, (next) => {
    next.clientMode = mode;
  });
}

export function profileSlug(name, taken) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'profile';
  let id = base;
  for (let suffix = 2; taken.has(id) || RESERVED_IDS.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

export function addProfile(
  policy,
  {
    name,
    description = '',
    width = NEW_PROFILE.width,
    height = NEW_PROFILE.height,
    fps = NEW_PROFILE.fps,
    bitrateKbps = NEW_PROFILE.bitrateKbps,
    enabled = true,
  },
) {
  const profile = {
    id: profileSlug(name, new Set(policy.profiles.map((row) => row.id))),
    name: name.trim(),
    description: description.trim(),
    enabled,
    width,
    height,
    fps,
    bitrateKbps,
    frameDelivery: 'fixed',
  };
  return { policy: edit(policy, (next) => next.profiles.push(profile)), profile };
}

export function editProfile(policy, id, changes) {
  return withDefaultHint(() =>
    edit(policy, (next) => {
      const profile = findProfile(next, id);
      for (const [key, value] of Object.entries(changes)) {
        if (!EDITABLE.includes(key)) throw new Error(`Unknown profile field ${key}`);
        profile[key] = typeof value === 'string' ? value.trim() : value;
      }
    }),
  );
}

export function duplicateProfile(policy, id) {
  const source = findProfile(policy, id);
  const name = `Copy of ${source.name}`.slice(0, 64).trimEnd();
  const profile = {
    ...structuredClone(source),
    id: profileSlug(name, new Set(policy.profiles.map((row) => row.id))),
    name,
  };
  return { policy: edit(policy, (next) => next.profiles.push(profile)), profile };
}

export function removeProfile(policy, id) {
  return withDefaultHint(() =>
    edit(policy, (next) => {
      findProfile(next, id);
      next.profiles = next.profiles.filter((row) => row.id !== id);
    }),
  );
}

export function setProfileEnabled(policy, id, enabled) {
  return editProfile(policy, id, { enabled });
}

function optionKey(kind) {
  if (!Object.hasOwn(OPTION_KINDS, kind)) throw new Error(`Unknown option kind ${kind}`);
  return OPTION_KINDS[kind];
}

function sameOption(kind, left, right) {
  return kind === 'size'
    ? left.width === right.width && left.height === right.height
    : left === right;
}

export function addAllowedOption(policy, kind, value) {
  const key = optionKey(kind);
  if (policy.allowedOptions[key].some((row) => sameOption(kind, row, value)))
    throw new Error('That option is already allowed');
  return edit(policy, (next) => {
    next.allowedOptions[key].push(value);
  });
}

export function removeAllowedOption(policy, kind, value) {
  const key = optionKey(kind);
  if (!policy.allowedOptions[key].some((row) => sameOption(kind, row, value)))
    throw new Error('That option is not in the allowed list');
  return edit(policy, (next) => {
    next.allowedOptions[key] = next.allowedOptions[key].filter(
      (row) => !sameOption(kind, row, value),
    );
  });
}
