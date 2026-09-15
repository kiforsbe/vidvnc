const profiles = Object.freeze({
  auto: Object.freeze({ name: 'auto' }),
  'iphone-720p-test': Object.freeze({
    name: 'iphone-720p-test',
    width: 1280,
    height: 720,
    fps: 15,
    bitrateKbps: 1000,
    mtu: 1200,
  }),
  desktop: Object.freeze({
    name: 'desktop',
    width: 2560,
    height: 1440,
    fps: 30,
    bitrateKbps: 6000,
    mtu: 1200,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 4000,
    mtu: 1200,
  }),
  mobile: Object.freeze({
    name: 'mobile',
    width: 1280,
    height: 720,
    fps: 15,
    bitrateKbps: 2000,
    mtu: 1200,
  }),
  'low-bandwidth': Object.freeze({
    name: 'low-bandwidth',
    width: 960,
    height: 540,
    fps: 15,
    bitrateKbps: 1000,
    mtu: 1200,
  }),
});
export function profileNames() {
  return Object.keys(profiles);
}
export function getProfile(name) {
  return profiles[name] ? { ...profiles[name] } : null;
}
export function chooseProfile(requested, userAgent = '') {
  const explicit = getProfile(requested);
  if (explicit && explicit.name !== 'auto') return explicit;
  return /iPhone|iPad|iPod/i.test(userAgent)
    ? getProfile('iphone-720p-test')
    : getProfile('desktop');
}
