// What a person has to do, per device, to install and later remove the host's trust anchor.
// Plain data, so the wording is reviewable in one place and testable without a DOM.
//
// Shape of an entry (see `instructionsFor`):
//   install    ordered phases; each { title, required?, steps: [{ text, command? }] }. A phase
//              marked `required` is one people skip and then keep seeing warnings.
//   warning    an emphasised sentence shown above the install phases, or null
//   check      { text, command } shown before the phases: how to check what is about to be
//              trusted (hash the file on a computer; look at the device's own certificate
//              viewer where there is one). `command` is null where there is nothing to run.
//   notes      short caveats shown under the install phases
//   uninstall  { steps: [{ text, command? }], notes? }
//
// What the certificate is called depends on who made it, so the entries are built for a
// strategy (see `identify`). Wherever a person has to pick the certificate out of a list, the
// steps say what it is called for that strategy and offer the fingerprint as the fallback.
//
// The file name is fixed by the server (Content-Disposition on /api/trust/anchor).
// The steps are written for what the operating systems present at the time of writing; menu
// names drift between versions and vendors, and the entries say so where that matters.
const FILE = 'VidVNC-trust.crt';

// How the certificate shows up in a device's lists. `windows-self-signed` makes a certificate
// with the subject CN=VidVNC. `mkcert` hands over mkcert's own certificate authority, whose
// name is not ours. Anything else (an operator's own certificate) could be called anything,
// so it is identified by fingerprint alone. No platform-specific screen is claimed to show a
// fingerprint; the text says "where your device shows one".
function identify(strategy) {
  const fallback =
    'If you cannot tell which one it is, match it by its SHA-256 fingerprint (shown above) where your device shows one.';
  if (strategy === 'windows-self-signed')
    return { find: 'the certificate named "VidVNC"', match: fallback };
  if (strategy === 'mkcert')
    return {
      find: 'the certificate issued by mkcert (usually named "mkcert <user>@<host>", but the name can differ)',
      match: fallback,
    };
  return {
    find: 'the certificate you installed (its name can differ)',
    match: 'Identify it by its SHA-256 fingerprint (shown above) where your device shows one.',
  };
}

// The file-hash check on a computer: it covers the file itself, which the page's fingerprint
// does not. Recommended as a normal step before installing, not an extra.
const CHECK_TEXT =
  "Check the file you downloaded before you install it: run this in the folder that holds it and compare the result with the fingerprint on the host's screen. Ignore case, colons and spaces. If it differs, do not install the certificate.";

const ios = (who) => ({
  id: 'ios',
  label: 'iPhone or iPad',
  warning:
    'Installing the profile is not enough on its own. Until you also turn on full trust for it in a second Settings screen (step 2 below), your device keeps showing certificate warnings for this host.',
  install: [
    {
      title: 'Step 1 of 2: install the profile',
      steps: [
        {
          text: 'Use Safari for this page. Other browsers on iPhone and iPad cannot hand the file over to Settings.',
        },
        {
          text: 'Tap the download button above, then tap Allow when Safari asks whether to allow a configuration profile to be downloaded.',
        },
        {
          text: 'Open the Settings app. Tap Profile Downloaded near the top, or go to General → VPN & Device Management.',
        },
        { text: `Open the downloaded profile: ${who.find}. ${who.match}` },
        { text: 'Tap Install, enter your passcode, then tap Install again to confirm.' },
      ],
    },
    {
      title: 'Step 2 of 2 (REQUIRED): turn on full trust',
      required: true,
      steps: [
        { text: 'Open Settings → General → About → Certificate Trust Settings.' },
        {
          text: 'Under "Enable full trust for root certificates", switch on the certificate you just installed, then tap Continue.',
        },
        {
          text: 'This second step is what makes the device trust the certificate. If you skip it, the profile stays installed but the warnings do not go away.',
        },
      ],
    },
  ],
  check: {
    text: "Check the certificate itself, not only this page. Before you tap Install, look for a way to view the certificate's details on the profile screen (some versions offer More Details). If your device shows a SHA-256 fingerprint there, compare it with the one above and with the host's screen. If it differs, do not install.",
    command: null,
  },
  notes: [
    'On older versions of iOS the first Settings screen is called Profiles or Profiles & Device Management.',
    'Certificate Trust Settings only appears after a profile containing a certificate has been installed.',
  ],
  uninstall: {
    steps: [
      { text: 'Open Settings → General → VPN & Device Management.' },
      {
        text: `Under Configuration Profile, tap the profile you installed for this host: ${who.find}. ${who.match}`,
      },
      { text: 'Tap Remove Profile and confirm with your passcode.' },
      {
        text: 'The full-trust setting in Certificate Trust Settings goes away together with the profile. There is nothing else to undo.',
      },
    ],
  },
});

const android = (who) => ({
  id: 'android',
  label: 'Android',
  warning: null,
  install: [
    {
      title: null,
      steps: [
        {
          text: `Tap the download button above and allow the download if your browser asks. The file is ${FILE}, in your Downloads.`,
        },
        {
          text: 'Open Settings → Security (on newer versions: Security & privacy → More security & privacy).',
        },
        { text: 'Tap Encryption & credentials → Install a certificate → CA certificate.' },
        {
          text: `Read the warning and confirm it, then choose ${FILE} from Downloads. Android may ask you to set a screen lock first.`,
        },
      ],
    },
  ],
  check: {
    text: "Check the certificate itself, not only this page. Android does not always show a fingerprint before you install. If your version lets you open the certificate's details (for example under User credentials once it is installed), compare its SHA-256 fingerprint with the one above and with the host's screen. If it differs, remove the certificate straight away using the steps below.",
    command: null,
  },
  notes: [
    'The wording and the position of these menus vary by manufacturer and Android version. If you cannot find them, search Settings for "certificate".',
    'Chrome uses the system store this installs into, so it applies to Chrome once installed. Android shows a standing notice that the network may be monitored while a certificate you added is installed.',
  ],
  uninstall: {
    steps: [
      {
        text: 'Open Settings → Security (or Security & privacy → More security & privacy) → Encryption & credentials.',
      },
      { text: 'Tap User credentials (on some versions: Trusted credentials, then the User tab).' },
      { text: `Tap the certificate you installed: ${who.find}. ${who.match}` },
      { text: 'Tap Remove or Uninstall and confirm.' },
    ],
  },
});

const windows = (who) => ({
  id: 'windows',
  label: 'Windows',
  warning: null,
  install: [
    {
      title: 'Option 1: the certificate wizard',
      steps: [
        { text: `Open the downloaded ${FILE} (double-click it in your Downloads folder).` },
        { text: 'Choose Install Certificate…, select Current User, then choose Next.' },
        {
          text: 'Choose "Place all certificates in the following store", choose Browse, select "Trusted Root Certification Authorities", then choose Next and Finish.',
        },
        {
          text: "Windows shows a security warning about the certificate. Choose Yes only if you have already checked the file and compared the fingerprint above with the host's screen.",
        },
      ],
    },
    {
      title: 'Option 2: one command',
      steps: [
        {
          text: 'In Command Prompt or PowerShell, in the folder that holds the downloaded file, run this. It installs for your user only and needs no administrator rights. Windows may still ask you to confirm.',
          command: `certutil -user -addstore Root ${FILE}`,
        },
      ],
    },
  ],
  check: { text: CHECK_TEXT, command: `certutil -hashfile ${FILE} SHA256` },
  notes: [
    'Edge and Chrome use the Windows certificate store. Firefox keeps its own list of authorities and ignores this installation unless it is told to use the Windows store: open about:config in Firefox and set security.enterprise_roots.enabled to true.',
  ],
  uninstall: {
    steps: [
      { text: 'Press Windows+R, type certmgr.msc, and press Enter.' },
      {
        text: `Open Trusted Root Certification Authorities → Certificates and find ${who.find}. ${who.match} Open a certificate and look at its details if you are unsure.`,
      },
      { text: 'Right-click it, choose Delete, and confirm.' },
      {
        text: "Instead of steps 2 and 3, you can remove it from a command prompt by its thumbprint (the SHA-1 value on the certificate's Details tab, which certutil -hashfile VidVNC-trust.crt SHA1 also prints):",
        command: 'certutil -user -delstore Root <thumbprint>',
      },
    ],
  },
});

const macos = (who) => ({
  id: 'macos',
  label: 'Mac',
  warning: null,
  install: [
    {
      title: 'Step 1 of 2: add the certificate to a keychain',
      steps: [
        { text: `Open the downloaded ${FILE} (double-click it). Keychain Access opens.` },
        {
          text: 'Choose the login keychain (just you) or System (everyone who uses this Mac; asks for an administrator password), then choose Add.',
        },
      ],
    },
    {
      title: 'Step 2 of 2 (REQUIRED): tell macOS to trust it',
      required: true,
      steps: [
        {
          text: `In Keychain Access, choose the same keychain and the Certificates category, then double-click the certificate you just added: ${who.find}. ${who.match}`,
        },
        { text: 'Expand Trust and set "When using this certificate" to Always Trust.' },
        { text: 'Close the window and enter your password to save the change.' },
        {
          text: 'Adding the certificate alone is not enough: until it is set to Always Trust, macOS keeps warning about this host.',
        },
      ],
    },
  ],
  check: { text: CHECK_TEXT, command: `shasum -a 256 ${FILE}` },
  notes: [
    'Safari, Chrome and Edge use the macOS keychain. Firefox keeps its own list of authorities unless it is set to use the system store: open about:config in Firefox and set security.enterprise_roots.enabled to true.',
  ],
  uninstall: {
    steps: [
      { text: 'Open Keychain Access and choose the keychain you added the certificate to.' },
      {
        text: `Choose the Certificates category and find ${who.find}. ${who.match} Open a certificate and look at its details if you are unsure.`,
      },
      {
        text: 'Right-click (or Control-click) it, choose Delete, and confirm. Enter your password if asked.',
      },
    ],
  },
});

const linux = (who) => ({
  id: 'linux',
  label: 'Linux',
  warning: null,
  install: [
    {
      title: 'Debian, Ubuntu and derivatives',
      steps: [
        {
          text: `The downloaded file is DER-encoded, and update-ca-certificates wants PEM with a .crt name. In the folder that holds ${FILE}, convert and copy it:`,
          command: `openssl x509 -inform der -in ${FILE} | sudo tee /usr/local/share/ca-certificates/${FILE} > /dev/null`,
        },
        { text: 'Then refresh the store:', command: 'sudo update-ca-certificates' },
      ],
    },
    {
      title: 'Fedora, RHEL, Arch and others that use p11-kit',
      steps: [{ text: 'In the folder that holds the file:', command: `sudo trust anchor ${FILE}` }],
    },
    {
      title: 'Browsers with their own store',
      steps: [
        {
          text: 'Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import, then choose the file and tick the option to trust it to identify websites.',
        },
        {
          text: 'Chromium and Chrome: Settings → Privacy and security → Security → Manage certificates → Authorities → Import.',
        },
      ],
    },
  ],
  check: { text: CHECK_TEXT, command: `sha256sum ${FILE}` },
  notes: [
    'Firefox and Chromium-based browsers on Linux often keep their own list of authorities and ignore the system store. Import the file into the browser as well if it still warns.',
  ],
  uninstall: {
    steps: [
      {
        text: 'Debian, Ubuntu and derivatives:',
        command:
          'sudo rm /usr/local/share/ca-certificates/VidVNC-trust.crt && sudo update-ca-certificates --fresh',
      },
      {
        text: 'Fedora, RHEL, Arch and others that use p11-kit, in the folder that holds the file:',
        command: `sudo trust anchor --remove ${FILE}`,
      },
      {
        text: `In Firefox or Chromium, open the same Authorities list you imported it into and delete ${who.find}. ${who.match}`,
      },
    ],
  },
});

const other = (who) => ({
  id: 'other',
  label: 'Another device or browser',
  warning: null,
  install: [
    {
      title: null,
      steps: [
        {
          text: `Download ${FILE} with the button above. It is a single X.509 certificate file in DER form.`,
        },
        {
          text: "Compare its fingerprint with the one above and on the host's screen. Do not install it if they differ.",
        },
        {
          text: 'Add the file to your operating system\'s or browser\'s trusted certificate authorities. In the settings, look for "certificates", "certificate authorities" or "trusted roots", and import the file there.',
        },
        {
          text: 'If your system asks what to trust it for, allow it to identify websites. Restart the browser afterwards if it still warns.',
        },
      ],
    },
  ],
  check: {
    text: `Check the certificate itself, not only this page: if your system's certificate viewer shows a SHA-256 fingerprint for the file, compare it with the one above and with the host's screen, and do not install it if they differ. On a computer you can also hash the file: certutil -hashfile ${FILE} SHA256 (Windows), shasum -a 256 ${FILE} (macOS) or sha256sum ${FILE} (Linux).`,
    command: null,
  },
  notes: [
    'On Linux: sudo update-ca-certificates after copying a PEM .crt into /usr/local/share/ca-certificates (Debian, Ubuntu), or sudo trust anchor VidVNC-trust.crt (Fedora, Arch). Firefox and Chromium may use their own certificate stores instead of the system one.',
  ],
  uninstall: {
    steps: [
      {
        text: `Open the same list of trusted certificate authorities you added it to, and remove ${who.find}. ${who.match}`,
      },
      {
        text: 'On Linux, delete the file you copied under /usr/local/share/ca-certificates and run sudo update-ca-certificates --fresh, or run sudo trust anchor --remove VidVNC-trust.crt.',
      },
      { text: 'Once it is removed, this device warns about this host again.' },
    ],
  },
});

const BUILDERS = Object.freeze([ios, android, windows, macos, linux, other]);

// Display order for the platform chooser.
export const PLATFORMS = Object.freeze(
  BUILDERS.map((build) => {
    const { id, label } = build(identify(null));
    return Object.freeze({ id, label });
  }),
);

// Instructions for one platform id, worded for the strategy that made the certificate.
// Anything unrecognised gets the generic entry rather than nothing: the detector can be wrong
// and the chooser can be misused. An unknown strategy is identified by fingerprint alone.
export function instructionsFor(id, strategy) {
  const who = identify(strategy);
  const entries = BUILDERS.map((build) => build(who));
  return entries.find((entry) => entry.id === id) ?? entries[entries.length - 1];
}

// What a reissued certificate means for a device that installed the old one, worded by the
// strategy that made it. Returns null where nothing can be claimed accurately.
export function reissueNote(strategy) {
  if (strategy === 'windows-self-signed')
    return "This host's certificate is self-signed. If the host ever creates a new one, the certificate you install now will no longer match it and this device will warn again. Remove the old certificate using the steps above, then come back to this page and install the new one.";
  if (strategy === 'mkcert')
    return "This host's certificate comes from a local certificate authority (mkcert). That authority normally stays the same when the host issues a new certificate, so you usually do not need to install anything again. If the host ever creates a new authority, remove the old one using the steps above and install the new one from this page.";
  return null;
}

// What installing the anchor means for the device, where that is more than "trust this one
// host". mkcert hands over a certificate authority, not a single host's certificate, and a
// device that trusts an authority accepts whatever it signs. The other strategies get no
// claim here: nothing is said that has not been established.
export function authorityNote(strategy) {
  if (strategy === 'mkcert')
    return "What you would be installing: mkcert's local certificate authority, not only this host's certificate. A device that trusts it accepts certificates that authority signs for any website, and whoever holds the authority's private key can create them. Removing it undoes that.";
  return null;
}
