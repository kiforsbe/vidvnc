// What a person has to do, per device, to install and later remove the host's trust anchor.
// Plain data, so the wording is reviewable in one place and testable without a DOM.
//
// Shape of an entry (see `instructionsFor`):
//   install    ordered phases; each { title, required?, steps: [{ text, command? }] }. A phase
//              marked `required` is one people skip and then keep seeing warnings.
//   warning    an emphasised sentence shown above the install phases, or null
//   check      optional { text, command }: how to hash the downloaded file on that device
//   notes      short caveats shown under the install phases
//   uninstall  { steps: [{ text, command? }], notes? }
//
// The file name is fixed by the server (Content-Disposition on /api/trust/anchor).
// The steps are written for what the operating systems present at the time of writing; menu
// names drift between versions and vendors, and the entries say so where that matters.
const FILE = 'VidVNC-trust.crt';

const CHECK_TEXT =
  "Optional: to check the file you actually downloaded, not just this page, run this in the folder that holds it and compare the result with the fingerprint on the host's screen. Ignore case, colons and spaces.";

const ios = {
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
        {
          text: 'Tap the downloaded VidVNC profile, tap Install, enter your passcode, then tap Install again to confirm.',
        },
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
  check: null,
  notes: [
    'On older versions of iOS the first Settings screen is called Profiles or Profiles & Device Management.',
    'Certificate Trust Settings only appears after a profile containing a certificate has been installed.',
  ],
  uninstall: {
    steps: [
      { text: 'Open Settings → General → VPN & Device Management.' },
      {
        text: 'Under Configuration Profile, tap the VidVNC profile you installed for this host, then tap Remove Profile and confirm with your passcode.',
      },
      {
        text: 'The full-trust setting in Certificate Trust Settings goes away together with the profile. There is nothing else to undo.',
      },
    ],
  },
};

const android = {
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
  check: null,
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
      {
        text: 'Tap the VidVNC certificate you installed, then tap Remove or Uninstall and confirm.',
      },
    ],
  },
};

const windows = {
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
          text: "Windows shows a security warning about the certificate. Choose Yes only if you have already compared the fingerprint above with the host's screen.",
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
        text: 'Open Trusted Root Certification Authorities → Certificates and find the VidVNC certificate issued to this host. If you are unsure which one it is, open it and check its details.',
      },
      { text: 'Right-click it, choose Delete, and confirm.' },
      {
        text: "Instead of steps 2 and 3, you can remove it from a command prompt by its thumbprint (the SHA-1 value on the certificate's Details tab, which certutil -hashfile VidVNC-trust.crt SHA1 also prints):",
        command: 'certutil -user -delstore Root <thumbprint>',
      },
    ],
  },
};

const macos = {
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
          text: 'In Keychain Access, choose the same keychain and the Certificates category, then double-click the certificate you just added.',
        },
        {
          text: 'Expand Trust and set "When using this certificate" to Always Trust.',
        },
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
        text: 'Choose the Certificates category and find the VidVNC certificate for this host. Open it and compare the SHA-256 fingerprint in its details with the one above if you are unsure.',
      },
      {
        text: 'Right-click (or Control-click) it, choose Delete, and confirm. Enter your password if asked.',
      },
    ],
  },
};

const linux = {
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
        text: 'In Firefox or Chromium, open the same Authorities list you imported it into and delete the VidVNC certificate.',
      },
    ],
  },
};

const other = {
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
  check: null,
  notes: [
    'On Linux: sudo update-ca-certificates after copying a PEM .crt into /usr/local/share/ca-certificates (Debian, Ubuntu), or sudo trust anchor VidVNC-trust.crt (Fedora, Arch). Firefox and Chromium may use their own certificate stores instead of the system one.',
  ],
  uninstall: {
    steps: [
      {
        text: 'Open the same list of trusted certificate authorities you added it to, and remove the VidVNC certificate for this host. If you are unsure which entry it is, compare its fingerprint with the one above.',
      },
      {
        text: 'On Linux, delete the file you copied under /usr/local/share/ca-certificates and run sudo update-ca-certificates --fresh, or run sudo trust anchor --remove VidVNC-trust.crt.',
      },
      {
        text: 'Once it is removed, this device warns about this host again.',
      },
    ],
  },
};

const ENTRIES = Object.freeze([ios, android, windows, macos, linux, other]);

// Display order for the platform chooser.
export const PLATFORMS = Object.freeze(
  ENTRIES.map(({ id, label }) => Object.freeze({ id, label })),
);

// Instructions for one platform id. Anything unrecognised gets the generic entry rather
// than nothing: the detector can be wrong and the chooser can be misused.
export function instructionsFor(id) {
  return ENTRIES.find((entry) => entry.id === id) ?? other;
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
