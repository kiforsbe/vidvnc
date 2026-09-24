export function effectivePermission(authorization, accessDefault) {
  if (!authorization) return 'view-only';
  return authorization.permission === 'default' ? accessDefault : authorization.permission;
}
