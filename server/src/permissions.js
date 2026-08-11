// Object-level permission helpers.
//
// All Vault operations run under the shared Business Admin account, but a user
// must only be able to reach the objects THEIR own Vault profile can see. At
// login we capture that permission set (session.allowedObjects); these helpers
// enforce it. When allowedObjects is null/undefined (couldn't be read at
// login), we do not restrict — the user keeps Business Admin scope.

// Whether a session is permitted to reach a given object.
export function canAccessObject(session, objectName) {
  const allowed = session && session.allowedObjects;
  if (!allowed) return true; // no explicit restriction captured
  return allowed.includes(objectName);
}

// Filter a list of { name, ... } objects to the session's permission set.
export function filterObjects(session, objects) {
  const allowed = session && session.allowedObjects;
  if (!allowed) return objects;
  const set = new Set(allowed);
  return (objects || []).filter((o) => set.has(o.name));
}
