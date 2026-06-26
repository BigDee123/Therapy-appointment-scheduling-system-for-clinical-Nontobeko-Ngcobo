const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;

  // Allow token via query string for direct-link routes (e.g. opening a printable
  // invoice in a new tab) where an Authorization header can't be attached.
  if (!token && req.query.token) token = req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = { requireAuth };
