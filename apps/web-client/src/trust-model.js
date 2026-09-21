// Decisions for the enrolment page (/trust), kept free of the DOM so they can be tested.
// `trust.js` fetches /api/trust/status, hands the outcome to `describeTrust`, and renders
// whatever comes back.
//
// This page is reached over plaintext by design: a device that does not trust the host's
// certificate cannot get the certificate over the connection that certificate protects. So
// nothing here may depend on a secure context (no crypto.subtle), and nothing here may claim
// more than is known. The integrity guarantee is the user comparing the fingerprint shown
// here with the one on the host's own screen, and the page asks for that explicitly.

export const ANCHOR_FILENAME = 'VidVNC-trust.crt';

const SHA256_COLON_HEX = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}$/;
const BYTES_PER_GROUP = 4;

// `maxTouchPoints` is passed in rather than read from `navigator`, so this stays pure.
// iPadOS 13+ Safari sends a Macintosh user agent; a Mac has no touch screen, an iPad
// reports several touch points.
export function detectPlatform(device) {
  const { userAgent, maxTouchPoints } = device ?? {};
  const agent = typeof userAgent === 'string' ? userAgent : '';
  const touch = Number.isFinite(maxTouchPoints) ? maxTouchPoints : 0;
  if (/iPhone|iPad|iPod/.test(agent)) return 'ios';
  if (/Macintosh/.test(agent) && touch > 1) return 'ios';
  // Before Linux: an Android user agent also says "Linux".
  if (/Android/.test(agent)) return 'android';
  if (/Windows/.test(agent)) return 'windows';
  if (/Macintosh|Mac OS X/.test(agent)) return 'macos';
  // ChromeOS also says "X11; ... Linux-ish"; it has its own settings and gets the generic
  // instructions.
  if (/CrOS/.test(agent)) return 'other';
  if (/Linux|X11/.test(agent)) return 'linux';
  return 'other';
}

export function isSha256Fingerprint(value) {
  return typeof value === 'string' && SHA256_COLON_HEX.test(value);
}

// Splits the fingerprint into chunks that are easy to compare by eye. Every character of
// the value is kept: the separators stay attached to the group before them, so the groups
// concatenate to exactly the reported string. Returns null for anything that is not a
// SHA-256 colon-hex fingerprint.
export function groupFingerprint(fingerprint) {
  if (!isSha256Fingerprint(fingerprint)) return null;
  const bytes = fingerprint.split(':');
  const groups = [];
  for (let index = 0; index < bytes.length; index += BYTES_PER_GROUP) {
    const group = bytes.slice(index, index + BYTES_PER_GROUP).join(':');
    groups.push(index + BYTES_PER_GROUP < bytes.length ? `${group}:` : group);
  }
  return groups;
}

// `location.hostname`: a DNS name, an IPv4 address, or a bracketed IPv6 address.
const HOSTNAME = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)$/;

// The address of the same host over HTTPS: the hostname the page was opened with and the
// port the host reports, never a port taken from anywhere else. The default port is left
// out. Null when either part cannot be trusted to form an address.
export function secureAddress(parts) {
  const { hostname, httpsPort } = parts ?? {};
  if (typeof hostname !== 'string' || !HOSTNAME.test(hostname)) return null;
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) return null;
  return `https://${hostname}${httpsPort === 443 ? '' : `:${httpsPort}`}/`;
}

// Only ever a path on this same origin, so the download button cannot be pointed at
// another site by a tampered response.
function isSameOriginPath(value) {
  return typeof value === 'string' && /^\/[^/\\]/.test(value);
}

const FINGERPRINT_LABEL = 'Certificate fingerprint (SHA-256)';

function secureLink(status, hostname, intro) {
  const href = secureAddress({ hostname, httpsPort: status.httpsPort });
  return href ? { href, label: 'Open VidVNC over HTTPS', intro } : null;
}

function fingerprintView(status) {
  const groups = groupFingerprint(status.fingerprint);
  return groups ? { label: FINGERPRINT_LABEL, text: status.fingerprint, groups } : null;
}

function view(state, title, message, extra = {}) {
  return {
    state,
    title,
    message,
    fingerprint: null,
    compareTitle: null,
    compare: null,
    download: null,
    showInstructions: false,
    strategy: null,
    secure: null,
    retry: false,
    ...extra,
  };
}

const ERROR_VIEW = () =>
  view(
    'error',
    'Could not load the certificate details',
    'This page could not get the certificate details from the host. Check that you are on the same network as the computer running VidVNC, then try again.',
    { retry: true },
  );

const UNAVAILABLE_VIEW = () =>
  view(
    'unavailable',
    'No certificate to offer right now',
    'The host did not offer a certificate that could be handed over. Try again in a moment.',
    { retry: true },
  );

// `outcome` is what the fetch produced: `{ httpStatus, body }`, with a null `httpStatus`
// when the request itself failed. `context` carries the page's `hostname`. Returns a
// view-model: the state, the words for it, and only the things that state may show.
//
// Only `required` ever produces a download. Every other state is built without one, even if
// the response carried a `download` field, so a device is never handed a file the host did
// not decide to offer.
export function describeTrust(outcome, context) {
  const hostname = context?.hostname;
  if (!outcome || outcome.httpStatus == null) return ERROR_VIEW();
  // The host answered that HTTPS is unavailable.
  if (outcome.httpStatus === 503) return inactiveView();
  if (outcome.httpStatus !== 200) return ERROR_VIEW();
  const status = outcome.body;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return ERROR_VIEW();
  if (typeof status.active !== 'boolean') return ERROR_VIEW();
  if (!status.active) return inactiveView();

  const fingerprint = fingerprintView(status);
  const strategy = typeof status.strategy === 'string' ? status.strategy : null;

  switch (status.enrolmentStatus) {
    case 'required': {
      // The fingerprint is the whole integrity story and the download is the whole point;
      // without either there is nothing sound to offer.
      if (!fingerprint || !isSameOriginPath(status.download)) return UNAVAILABLE_VIEW();
      return view(
        'required',
        "Install this host's certificate",
        'This host uses a certificate your device does not trust yet. To open VidVNC over HTTPS without warnings, install that certificate on this device.',
        {
          fingerprint,
          compareTitle: 'Check the fingerprint first',
          compare:
            "Before you install anything, compare the fingerprint below with the one shown on the host computer's screen. They must match exactly, character for character. If they differ, do not install the certificate.",
          download: { href: status.download, filename: ANCHOR_FILENAME },
          showInstructions: true,
          strategy,
          secure: secureLink(
            status,
            hostname,
            'When the certificate is installed, open VidVNC here:',
          ),
        },
      );
    }
    case 'unknown':
      return view(
        'unknown',
        'Nothing to install on this device',
        'This host uses a certificate supplied by its operator and issued by another authority, so VidVNC has nothing to install. If your device does not already trust that issuer, ask your administrator for their CA certificate.',
        {
          fingerprint,
          strategy,
          secure: secureLink(status, hostname, 'Continue to VidVNC here:'),
        },
      );
    case 'not-required':
      return view(
        'not-required',
        'No enrolment is needed for this host',
        'This host uses a certificate that devices accept without installing anything, so there is nothing to install.',
        {
          fingerprint,
          strategy,
          secure: secureLink(status, hostname, 'Continue to VidVNC here:'),
        },
      );
    default:
      return UNAVAILABLE_VIEW();
  }
}

function inactiveView() {
  return view(
    'inactive',
    'HTTPS is not running on this host',
    'There is no certificate to install. If you expected HTTPS, ask whoever runs the host to check its settings.',
    { retry: true },
  );
}
