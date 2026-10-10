// Compares a real owner-protocol message with an example from these fixtures by shape: the
// same field names at every level and the same JSON types, not the same values. Rules:
//
// - Objects must have exactly the example's fields, except the maps in MAPS, whose keys are
//   ids and whose values are compared with the example's first value.
// - Each element of an array is compared with the example's first element; an empty example
//   array accepts any array.
// - `null` on either side matches any type, because many fields are null until something
//   happens (no certificate yet, no viewer yet).
// - `type` must be equal, so a status line can never pass as a reply.
//
// A reply that has optional fields (an error, a new session key) has one example per form
// in replies.json, and must match one of them.
const MAPS = new Set(['displaySharing', 'displayDefaults']);

const kind = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

export function shapeMismatches(example, actual, path = '$', key = '') {
  if (example === null || actual === null) return [];
  if (kind(example) !== kind(actual))
    return [`${path}: expected ${kind(example)}, got ${kind(actual)}`];
  if (Array.isArray(example)) {
    if (!example.length) return [];
    return actual.flatMap((item, index) => shapeMismatches(example[0], item, `${path}[${index}]`));
  }
  if (typeof example !== 'object') return [];
  if (MAPS.has(key)) {
    const [sample] = Object.values(example);
    if (sample === undefined) return [];
    return Object.entries(actual).flatMap(([name, value]) =>
      shapeMismatches(sample, value, `${path}.${name}`),
    );
  }
  const problems = [];
  if ('type' in example && example.type !== actual.type)
    problems.push(`${path}.type: expected ${example.type}, got ${actual.type}`);
  for (const name of Object.keys(example))
    if (!(name in actual)) problems.push(`${path}.${name}: missing`);
  for (const name of Object.keys(actual))
    if (!(name in example)) problems.push(`${path}.${name}: not in the contract`);
    else problems.push(...shapeMismatches(example[name], actual[name], `${path}.${name}`, name));
  return problems;
}

// The index of the first example `actual` matches, or throws with every example's problems.
export function matchVariant(examples, actual) {
  const failures = examples.map((example) => shapeMismatches(example, actual));
  const index = failures.findIndex((problems) => problems.length === 0);
  if (index >= 0) return index;
  throw new Error(
    `${JSON.stringify(actual)} matches no ${actual?.type} example:\n` +
      failures.map((problems, n) => `  example ${n}: ${problems.join('; ')}`).join('\n'),
  );
}
