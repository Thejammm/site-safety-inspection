// Which tenant and project a request is acting on. One answer for every
// route that stores an inspector's work.
const DEFAULT_PROJECT = 'Default Project';

// - client_user: always their own tenant_id, ignores query.
// - consultant: must pass ?tenantId=... (or it'd be ambiguous).
function resolveTenant(req){
  if(req.user.role === 'client_user'){
    return req.user.tenantId || null;
  }
  return (req.query?.tenantId || req.body?.tenantId || '').toString() || null;
}

// Free text the client typed at login; a single default when none is given.
function resolveProject(req){
  const p = (req.query?.project ?? req.body?.project ?? '').toString().trim();
  return p || DEFAULT_PROJECT;
}

module.exports = { resolveTenant, resolveProject, DEFAULT_PROJECT };
