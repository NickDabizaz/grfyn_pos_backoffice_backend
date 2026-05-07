require('dotenv').config();

const DEV_USERNAME = 'admin';

function getDevPassword() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `admin${yy}${mm}${dd}`;
}

function devAuth(req, res, next) {
  if (process.env.DEVELOPER_PORTAL_ENABLED === 'false') {
    return res.status(404).json({ message: 'Not Found' });
  }

  if (req.session && req.session.devAuthenticated) {
    return next();
  }

  if (req.path === '/login' || (req.path === '/' && req.method === 'POST')) {
    return next();
  }

  if (req.accepts('html')) {
    return res.redirect('/developer/login');
  }

  return res.status(401).json({ message: 'Unauthorized' });
}

devAuth.validateLogin = function (username, password) {
  if (username !== DEV_USERNAME) return false;
  const expectedPassword = getDevPassword();
  return password === expectedPassword;
};

module.exports = devAuth;
