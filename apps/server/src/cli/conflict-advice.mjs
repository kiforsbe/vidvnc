// Store conflicts are safe refusals; tell the user how to recover in this mode.
export function withConflictAdvice(error, advice) {
  if (error.code === 'EEXIST')
    error.message = `Settings are locked by another save (${error.path}). ${advice}`;
  else if (/changed|being saved/i.test(error.message))
    error.message = `${error.message}. ${advice}`;
  return error;
}
