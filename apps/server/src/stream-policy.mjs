import { getProfile } from './profiles.mjs';
import { VIDEO_CODECS } from './video-codecs.mjs';

const seeds = [
  ['iphone-720p-test', 'iPhone 720p', 'Conservative starting point for iPhone'],
  ['mobile', 'Mobile', 'Compact picture for smaller screens'],
  ['balanced', 'Balanced', 'Everyday desktop use'],
  ['desktop', 'Desktop', 'More detail for larger screens'],
  ['low-bandwidth', 'Low bandwidth', 'Lower data use'],
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value, keys, label) {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  requireValue(
    Object.keys(value).every((key) => keys.includes(key)) &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${label} has missing or unknown fields`,
  );
}
function integer(value, min, max, label) {
  requireValue(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${label} must be an integer from ${min} to ${max}`,
  );
}
function text(value, min, max, label) {
  requireValue(
    typeof value === 'string' &&
      value.trim().length >= min &&
      value.length <= max &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    `${label} is invalid`,
  );
}
function dimensions(value) {
  integer(value.width, 64, 4096, 'Width');
  integer(value.height, 64, 4096, 'Height');
  requireValue(value.width % 2 === 0 && value.height % 2 === 0, 'Output dimensions must be even');
}
function numericPlan(value) {
  dimensions(value);
  integer(value.fps, 1, 60, 'Frame rate');
  integer(value.bitrateKbps, 100, 50000, 'Video bitrate');
}
function list(value, label) {
  requireValue(
    Array.isArray(value) && value.length > 0 && value.length <= 64,
    `${label} requires 1–64 choices`,
  );
  requireValue(
    new Set(value.map((v) => JSON.stringify(v))).size === value.length,
    `${label} contains duplicates`,
  );
}

export function defaultStreamPolicy() {
  return {
    schemaVersion: 1,
    revision: 0,
    profiles: seeds.map(([id, name, description]) => {
      const { width, height, fps, bitrateKbps } = getProfile(id);
      return {
        id,
        name,
        description,
        enabled: true,
        width,
        height,
        fps,
        bitrateKbps,
        frameDelivery: 'fixed',
      };
    }),
    defaultProfileId: 'auto',
    displayDefaults: {},
    displaySharing: null,
    allowAudio: true,
    videoCodecs: [...VIDEO_CODECS],
    clientMode: 'profiles',
    allowedOptions: {
      resolutions: [
        { width: 960, height: 540 },
        { width: 1280, height: 720 },
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
      ],
      frameRates: [15, 30],
      bitratesKbps: [1000, 2000, 4000, 6000],
    },
  };
}

export function validateStreamPolicy(value) {
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'displaySharing'))
    value = { ...value, displaySharing: null };
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'videoCodecs'))
    value = { ...value, videoCodecs: [...VIDEO_CODECS] };
  object(
    value,
    [
      'schemaVersion',
      'revision',
      'profiles',
      'defaultProfileId',
      'displayDefaults',
      'displaySharing',
      'allowAudio',
      'videoCodecs',
      'clientMode',
      'allowedOptions',
    ],
    'Policy',
  );
  requireValue(value.schemaVersion === 1, 'Unsupported stream policy schema version');
  integer(value.revision, 0, Number.MAX_SAFE_INTEGER - 1, 'Revision');
  list(value.profiles, 'Profiles');
  const ids = new Set();
  for (const profile of value.profiles) {
    object(
      profile,
      [
        'id',
        'name',
        'description',
        'enabled',
        'width',
        'height',
        'fps',
        'bitrateKbps',
        'frameDelivery',
      ],
      'Profile',
    );
    requireValue(
      typeof profile.id === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,63}$/.test(profile.id) &&
        !['auto', 'custom'].includes(profile.id),
      'Invalid profile ID',
    );
    requireValue(!ids.has(profile.id), 'Duplicate profile ID');
    ids.add(profile.id);
    text(profile.name, 1, 64, 'Profile name');
    text(profile.description, 0, 240, 'Description');
    requireValue(typeof profile.enabled === 'boolean', 'Profile availability must be boolean');
    requireValue(profile.frameDelivery === 'fixed', 'Variable frame delivery is not supported yet');
    numericPlan(profile);
  }
  const enabled = new Set(value.profiles.filter((p) => p.enabled).map((p) => p.id));
  requireValue(enabled.size > 0, 'At least one profile must remain available');
  requireValue(
    value.defaultProfileId === 'auto' || enabled.has(value.defaultProfileId),
    'Default profile must refer to an available profile',
  );
  const overrides = value.displayDefaults;
  requireValue(
    overrides !== null &&
      typeof overrides === 'object' &&
      !Array.isArray(overrides) &&
      Object.keys(overrides).length <= 128,
    'Display defaults are invalid',
  );
  for (const [display, profile] of Object.entries(overrides)) {
    text(display, 1, 256, 'Display ID');
    requireValue(
      !['__proto__', 'constructor', 'prototype'].includes(display),
      'Invalid display ID',
    );
    requireValue(enabled.has(profile), 'Display default must refer to an available profile');
  }
  requireValue(typeof value.allowAudio === 'boolean', 'Audio policy must be boolean');
  requireValue(
    Array.isArray(value.videoCodecs) && value.videoCodecs.length > 0,
    'Video codecs must be a list',
  );
  requireValue(
    value.videoCodecs.every((codec) => VIDEO_CODECS.includes(codec)),
    'Unknown video codec',
  );
  requireValue(
    new Set(value.videoCodecs).size === value.videoCodecs.length,
    'Video codecs contain duplicates',
  );
  requireValue(value.videoCodecs.includes('h264'), 'H.264 must stay enabled');
  requireValue(
    value.displaySharing === null ||
      (typeof value.displaySharing === 'object' &&
        !Array.isArray(value.displaySharing) &&
        Object.keys(value.displaySharing).length <= 128 &&
        Object.entries(value.displaySharing).every(
          ([id, allowed]) => /^[a-f0-9]{64}$/.test(id) && typeof allowed === 'boolean',
        )),
    'Display sharing is invalid',
  );
  requireValue(
    ['profiles', 'options'].includes(value.clientMode),
    'Invalid client customization mode',
  );
  object(value.allowedOptions, ['resolutions', 'frameRates', 'bitratesKbps'], 'Allowed options');
  const { resolutions, frameRates, bitratesKbps } = value.allowedOptions;
  list(resolutions, 'Resolutions');
  list(frameRates, 'Frame rates');
  list(bitratesKbps, 'Bitrates');
  for (const resolution of resolutions) {
    object(resolution, ['width', 'height'], 'Resolution');
    dimensions(resolution);
  }
  for (const fps of frameRates) integer(fps, 1, 60, 'Frame rate');
  for (const bitrate of bitratesKbps) integer(bitrate, 100, 50000, 'Video bitrate');
  requireValue(Buffer.byteLength(JSON.stringify(value)) <= 65536, 'Stream policy exceeds 64 KiB');
  return structuredClone(value);
}

// Pure policy resolution only. The caller must separately validate display
// authorization and actual encoder capabilities before starting capture.
export function resolveStreamPolicy(
  value,
  { profileId = 'auto', displayId, userAgent = '', custom, audio = true } = {},
) {
  const policy = validateStreamPolicy(value);
  requireValue(
    typeof profileId === 'string' && typeof audio === 'boolean' && typeof userAgent === 'string',
    'Invalid stream request',
  );
  if (displayId !== undefined) text(displayId, 1, 256, 'Display ID');
  let source, selectedBy;
  if (custom !== undefined) {
    requireValue(profileId === 'auto', 'Cannot request both a profile and custom settings');
    requireValue(policy.clientMode === 'options', 'Client customization is not allowed');
    object(custom, ['width', 'height', 'fps', 'bitrateKbps'], 'Custom settings');
    numericPlan(custom);
    const options = policy.allowedOptions;
    requireValue(
      options.resolutions.some((r) => r.width === custom.width && r.height === custom.height) &&
        options.frameRates.includes(custom.fps) &&
        options.bitratesKbps.includes(custom.bitrateKbps),
      'Requested settings are not allowed',
    );
    source = { ...custom, id: 'custom' };
    selectedBy = 'client';
  } else {
    let id = profileId;
    selectedBy = 'client';
    if (id === 'auto') {
      if (displayId && Object.hasOwn(policy.displayDefaults, displayId)) {
        id = policy.displayDefaults[displayId];
        selectedBy = 'display';
      } else {
        id = policy.defaultProfileId;
        selectedBy = 'default';
      }
    }
    if (id === 'auto') {
      const preferred = /iPhone|iPad|iPod/i.test(userAgent) ? 'iphone-720p-test' : 'desktop';
      id =
        policy.profiles.find((p) => p.id === preferred && p.enabled)?.id ??
        policy.profiles.find((p) => p.enabled).id;
      selectedBy = 'auto';
    }
    source = policy.profiles.find((p) => p.id === id && p.enabled);
    requireValue(!!source, 'Requested profile is not allowed');
  }
  const { width, height, fps, bitrateKbps } = source;
  return {
    profile: { name: source.id, width, height, fps, bitrateKbps, mtu: 1200 },
    audio: { mode: policy.allowAudio && audio ? 'on' : 'off' },
    revision: policy.revision,
    selectedBy,
  };
}
