import { getProfile } from './profiles.mjs';
import { VIDEO_CODECS } from './video-codecs.mjs';
import { ENCODER_BACKEND_CHOICES, DEFAULT_ENCODER_BACKEND } from './encoder-backends.mjs';
import {
  BITRATE_MODES,
  QUALITY_LEVELS,
  DEFAULT_BITRATE_MODE,
  DEFAULT_QUALITY,
} from './rate-control.mjs';

const seeds = [
  ['iphone-720p-test', 'iPhone 720p', 'Conservative starting point for iPhone'],
  ['mobile', 'Mobile', 'Compact picture for smaller screens'],
  ['balanced', 'Balanced', 'Everyday desktop use'],
  ['desktop', 'Desktop', 'More detail for larger screens'],
  ['low-bandwidth', 'Low bandwidth', 'Lower data use'],
];

// How a profile's output size follows the shared screen. `height` and `width` fix one side
// and take the other from the screen's shape; `scale` is the screen's own size times
// `scalePercent`; `fixed` is width × height, with `aspect` saying how a screen of another
// shape goes into it: `keep` shrinks the box to the screen's shape (no bars), `fit` adds bars
// (the behaviour before sizing existed), `stretch` fills it.
export const SIZINGS = Object.freeze(['height', 'width', 'scale', 'fixed']);
export const ASPECTS = Object.freeze(['keep', 'fit', 'stretch']);
const SEED_IDS = new Set(seeds.map(([id]) => id));

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
      const { width, height, fps, bitrateKbps, bitrateMode, quality } = getProfile(id);
      return {
        id,
        name,
        description,
        enabled: true,
        width,
        height,
        fps,
        bitrateKbps,
        bitrateMode,
        quality,
        frameDelivery: 'fixed',
        sizing: 'height',
        scalePercent: 100,
        aspect: 'keep',
      };
    }),
    defaultProfileId: 'auto',
    displayDefaults: {},
    displaySharing: null,
    allowAudio: true,
    videoCodecs: [...VIDEO_CODECS],
    encoderBackend: DEFAULT_ENCODER_BACKEND,
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
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'encoderBackend'))
    value = { ...value, encoderBackend: DEFAULT_ENCODER_BACKEND };
  if (value && typeof value === 'object' && Array.isArray(value.profiles))
    value = {
      ...value,
      profiles: value.profiles.map((profile) =>
        profile && typeof profile === 'object' && !Array.isArray(profile)
          ? {
              ...profile,
              ...(Object.hasOwn(profile, 'bitrateMode')
                ? {}
                : { bitrateMode: DEFAULT_BITRATE_MODE }),
              ...(Object.hasOwn(profile, 'quality') ? {} : { quality: DEFAULT_QUALITY }),
              // Saved before sizing existed: the built-in profiles follow the screen's shape at
              // their height, the owner's own keep their exact size with bars, as before.
              ...(Object.hasOwn(profile, 'sizing')
                ? {}
                : { sizing: SEED_IDS.has(profile.id) ? 'height' : 'fixed' }),
              ...(Object.hasOwn(profile, 'scalePercent') ? {} : { scalePercent: 100 }),
              ...(Object.hasOwn(profile, 'aspect')
                ? {}
                : { aspect: SEED_IDS.has(profile.id) ? 'keep' : 'fit' }),
            }
          : profile,
      ),
    };
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
      'encoderBackend',
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
        'bitrateMode',
        'quality',
        'frameDelivery',
        'sizing',
        'scalePercent',
        'aspect',
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
    requireValue(BITRATE_MODES.includes(profile.bitrateMode), 'Bitrate mode is invalid');
    requireValue(QUALITY_LEVELS.includes(profile.quality), 'Quality is invalid');
    requireValue(SIZINGS.includes(profile.sizing), 'Sizing is invalid');
    requireValue(ASPECTS.includes(profile.aspect), 'Aspect is invalid');
    integer(profile.scalePercent, 10, 400, 'Scale percentage');
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
    ENCODER_BACKEND_CHOICES.includes(value.encoderBackend),
    'Encoder backend is invalid',
  );
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
  { profileId = 'auto', displayId, display, userAgent = '', custom, audio = true } = {},
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
    source = {
      ...custom,
      id: 'custom',
      bitrateMode: DEFAULT_BITRATE_MODE,
      quality: DEFAULT_QUALITY,
      sizing: 'fixed',
      scalePercent: 100,
      aspect: 'fit',
    };
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
  const { fps, bitrateKbps, bitrateMode, quality } = source;
  const { width, height, stretch } = outputSize(source, display);
  // `name` stays the id (the native worker matches its legacy profiles on it); `label` and
  // `description` are display-only and never reach the worker plan or the shared-encode key.
  return {
    profile: {
      name: source.id,
      label: source.name,
      description: source.description,
      width,
      height,
      fps,
      bitrateKbps,
      bitrateMode,
      quality,
      mtu: 1200,
      // How the viewer finds the screen in the frame: only `fit` adds bars.
      aspect: source.sizing === 'fixed' ? source.aspect : 'keep',
      ...(stretch ? { stretch: true } : {}),
    },
    audio: { mode: policy.allowAudio && audio ? 'on' : 'off' },
    // A host property, not a client one: it does not vary by profile or custom settings.
    encoderBackend: policy.encoderBackend,
    revision: policy.revision,
    selectedBy,
  };
}

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

// The size a profile streams `display` at (its `width` and `height` as the host reports them:
// pixels on Windows, points on macOS). Without a display it is the profile's own box. The
// result keeps the encoder's limits (64 to 4096, even), shrinking or growing both sides
// together so the shape survives.
export function outputSize(profile, display) {
  const screenWidth = display?.width,
    screenHeight = display?.height;
  const known =
    Number.isFinite(screenWidth) &&
    Number.isFinite(screenHeight) &&
    screenWidth > 0 &&
    screenHeight > 0;
  const sizing = profile.sizing ?? 'fixed';
  const aspect = profile.aspect ?? 'fit';
  if (!known || (sizing === 'fixed' && aspect !== 'keep'))
    return { width: profile.width, height: profile.height, stretch: aspect === 'stretch' };
  let width, height;
  if (sizing === 'height') {
    height = profile.height;
    width = (height * screenWidth) / screenHeight;
  } else if (sizing === 'width') {
    width = profile.width;
    height = (width * screenHeight) / screenWidth;
  } else if (sizing === 'scale') {
    width = (screenWidth * profile.scalePercent) / 100;
    height = (screenHeight * profile.scalePercent) / 100;
  } else {
    const scale = Math.min(profile.width / screenWidth, profile.height / screenHeight);
    width = screenWidth * scale;
    height = screenHeight * scale;
  }
  const shrink = Math.min(1, 4096 / width, 4096 / height);
  const grow = Math.max(1, 64 / width, 64 / height);
  const factor = shrink < 1 ? shrink : grow;
  return {
    width: Math.min(4096, even(width * factor)),
    height: Math.min(4096, even(height * factor)),
    stretch: false,
  };
}
